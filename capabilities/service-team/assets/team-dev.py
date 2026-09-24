#!/usr/bin/env python3
"""team-dev: the developer's lane (t-team-dev-cmd).

usage: team-dev.py implement <specId> | review-brief <runId> | merge-ask <runId> | merge <runId>

implement     the coding agent implements the approved context pack on branch <service>/<specId> of the repository the team
              works in (the person's own checkout by default, never a push); the run is handed to QA for verification
review-brief  renders the review brief (diff, spec, acceptance, verification) for the one-shot reviewer (t-team-review)
merge-ask     after the review: asks the person to merge (a question in the prompts place and the office inbox)
merge         on the person's decision: merges the branch into main with no fast-forward, in the repository the team works in.
              In repoMode clone it also carries the branch back into the person's repository. Nothing is ever pushed; the
              release is reported to the product office and the run handed to the brain
"""
import os, sys, json, re, time, datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
# >>> shared: teamlib (generated, do not edit here)
"""Shared library for the Service team scripts. Inlined into every service-team-*.py by
tools/inline-shared.py (the executor runs each script as ONE file). Edit here, then re-inline.

The Service team is a persona whose job is the model it lives in. Every lane measures through master
(X-Service-Auth when the internal service token is set) and, for what only the runtime's own MCP
knows (lane status, usage, schedules, lints, dry runs, installs), through the MCP server the
charter names. Secrets never enter a token: the MCP token reaches the lanes from the vault as
STEWARD_MCP_TOKEN; on a Desktop it is also readable from the app's own token file.
"""
import datetime
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

MASTER = os.environ.get("MASTER_URL", "http://127.0.0.1:8082").rstrip("/")
MODEL = os.environ.get("MODEL_ID", "agenticnets-product")
SERVICE_TOKEN = os.environ.get("AGENTICOS_SERVICE_TOKEN", "").strip()
TEAM_HOME = os.path.expanduser(os.environ.get("TEAM_HOME", "~/service-team"))
PACK_NAME = "service-team"

# ---------------------------------------------------------------- the team's places, namespaced per install
# The pack's sources name places p-team-<x>; the hub installs the pack once per service session with
# instancePolicy multiple, which rewrites every id to p-<service>-team-<x>. A command template carries one
# real place id as TEAM_ANCHOR (rewritten with the rest), so every script derives its namespace from it.
def _anchor_from_argv():
    """An app command action cannot set environment literals, so it passes the anchor as an argv element
    (the charter place id, rewritten with the install namespace); it is removed from argv here."""
    for i, a in enumerate(list(sys.argv[1:]), 1):
        if re.match(r"^p-(?:.+-)?team-charter$", a):
            del sys.argv[i]
            return a
    return ""


def _valid_anchor(v):
    return bool(re.match(r"^p-(?:.+-)?team-charter$", str(v or "").strip()))


# argv first: a literal in a template's environment is scrubbed at publish (env literals count as
# secrets), so only an argv element survives the pack; the environment form is accepted when valid.
_ANCHOR = _anchor_from_argv() or (os.environ.get("TEAM_ANCHOR", "").strip() if _valid_anchor(os.environ.get("TEAM_ANCHOR")) else "") or "p-team-charter"
_M = re.match(r"^p-(?:(?P<ns>.+?)-)?team-charter$", _ANCHOR)
NAMESPACE = (_M.group("ns") if _M and _M.group("ns") else "")
SERVICE = os.environ.get("TEAM_SERVICE", "").strip() or NAMESPACE or "team"
PREFIX = "p-%s-team-" % NAMESPACE if NAMESPACE else "p-team-"
TPREFIX = "t-%s-team-" % NAMESPACE if NAMESPACE else "t-team-"
SESSION = NAMESPACE or "team"
_NAMES = ["charter", "coders", "setup-cmd", "setup-log", "infra", "repo", "journal", "errors", "llm-errors",
          "iterate", "po-cmd", "po-log", "context", "state", "prompts", "prompt-new", "responses", "review-new", "acceptance-new", "requirements", "requirement-drafts",
          "arch-cmd", "arch-log", "specs", "spec-drafts", "spec-catalog", "adr", "arch", "briefs",
          "qa-cmd", "qa-log", "acceptance", "verification", "scorecard", "bugs",
          "dev-cmd", "dev-log", "decisions", "refused", "runs", "reviews",
          "brain-cmd", "brain-log", "signals", "curation", "curations", "knowledge", "plan", "backlog", "ideas", "status"]
P = {n.replace("-", "_"): PREFIX + n for n in _NAMES}
# the product office's places are model-global and never namespaced
OFFICE = {"charter": "p-product-charter", "coders": "p-product-coders", "teams": "p-product-teams", "inbox": "p-product-inbox", "status": "p-product-status",
          "setup_cmd": "p-product-setup-cmd", "specs": "p-product-specs", "knowledge": "p-product-knowledge", "adr": "p-product-adr"}
PROTECTED_PLACES = [P["charter"], P["coders"], P["prompts"], P["responses"], P["decisions"], P["refused"]]
PROTECTED_LANES = [TPREFIX + x for x in ("infra-tick", "setup-cmd", "iterate-prep", "po-cmd", "propose", "answer-prep", "revise-prep", "requirement", "design-prep", "arch-cmd", "design",
                                        "acceptance-prep", "qa-cmd", "acceptance", "pack-prep", "approve-prep", "dev-cmd", "verify-prep", "review-prep", "review", "merge-prep", "changes-prep",
                                        "brain-observe-cmd", "curate", "curate-cmd", "apply-prep", "brain-apply-cmd", "answer-knowledge-prep")]
SPEC_STATUSES = ["draft", "approved", "implemented", "verified", "released", "rejected", "superseded"]
AUTONOMY_ALONE = {1: [], 2: [], 3: [], 4: ["docs", "tests"], 5: ["docs", "tests", "refactor"]}
REQUIRED_APP_STORES = ["charter", "prompts", "responses", "requirements", "specs", "acceptance", "runs", "decisions", "journal"]
REQUIRED_APP_ACTIONS = ["set-charter", "respond", "approve-spec", "reject-spec", "approve-pack", "reject-pack", "merge", "request-changes", "pause", "resume"]


def envv(name, default=""):
    """An environment value set by a map-lane template; an unresolved `${...}` placeholder counts as unset."""
    v = os.environ.get(name, "")
    if v is None or v.strip().startswith("${"):
        return default
    return v.strip() or default


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def stamp():
    return now().replace(":", "").replace("-", "")


def log(msg):
    print(str(msg), file=sys.stderr, flush=True)


def out(obj):
    print(json.dumps(obj, sort_keys=True), flush=True)


def api(method, path, body=None, timeout=30):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(MASTER + path, data=data, method=method)
    req.add_header("Accept", "application/json")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    if SERVICE_TOKEN:
        req.add_header("X-Service-Auth", "Bearer " + SERVICE_TOKEN)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8", "replace")
            return json.loads(raw) if raw.strip() else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:300]
        raise RuntimeError("%s %s -> HTTP %s: %s" % (method, path, e.code, detail))


def put_token(place, data, name=None):
    """Append a token. A token NAME must be unique within its place (the node answers 500 to a
    duplicate), so a named write that is refused is retried once with a timestamp suffix."""
    body = {"data": data}
    if name:
        body["name"] = name
    try:
        return api("POST", "/api/runtime/places/%s/tokens?modelId=%s" % (place, MODEL), body)
    except RuntimeError as e:
        if name and "HTTP 500" in str(e):
            body["name"] = "%s-%s" % (name, stamp())
            return api("POST", "/api/runtime/places/%s/tokens?modelId=%s" % (place, MODEL), body)
        raise


def decode(data):
    """Nested structures round-trip through the platform as JSON text: a list or object written into a
    token comes back as a string. Decode every value that looks like one, recursively."""
    if isinstance(data, dict):
        return {k: decode(v) for k, v in data.items()}
    if isinstance(data, list):
        return [decode(v) for v in data]
    if isinstance(data, str):
        s = data.strip()
        if (s.startswith("{") and s.endswith("}")) or (s.startswith("[") and s.endswith("]")):
            try:
                return decode(json.loads(s))
            except ValueError:
                return data
    return data


def query(place, arcql="FROM $", limit=200, model=None):
    r = api("POST", "/api/runtime/places/%s/tokens/query?modelId=%s" % (place, model or MODEL), {"arcql": arcql, "limit": limit})
    tokens = r.get("tokens", []) if isinstance(r, dict) else []
    for t in tokens:
        if isinstance(t.get("data"), dict):
            t["data"] = decode(t["data"])
    return tokens


def count(place, model=None):
    r = api("POST", "/api/runtime/places/%s/tokens/query?modelId=%s" % (place, model or MODEL), {"arcql": "FROM $", "limit": 1})
    return int(((r or {}).get("page") or {}).get("totalElements", 0))


def delete_token(place, token_id):
    api("DELETE", "/api/runtime/places/%s/tokens/%s?modelId=%s" % (place, token_id, MODEL))


def one(place, arcql="FROM $ LIMIT 1"):
    t = query(place, arcql, 1)
    return (t[0].get("data") or {}) if t else {}


def latest(place, field="at", arcql="FROM $"):
    tokens = query(place, arcql, 500)
    tokens.sort(key=lambda t: str((t.get("data") or {}).get(field, "")), reverse=True)
    return (tokens[0].get("data") or {}) if tokens else {}


def keep_last(place, field="at", n=20, arcql="FROM $"):
    """Bound a measurement place: keep the newest n tokens by `field`, delete the rest."""
    tokens = query(place, arcql, 1000)
    tokens.sort(key=lambda t: str((t.get("data") or {}).get(field, "")), reverse=True)
    for t in tokens[n:]:
        try:
            delete_token(place, t["id"])
        except Exception as e:  # noqa: BLE001
            log("keep_last: %s" % e)


def replace_token(place, key, value, patch, name=None):
    """Replace the token whose data[key] == value (or create it), keeping the old fields."""
    old = query(place, 'FROM $ WHERE $.%s == "%s" LIMIT 5' % (key, value), 5)
    data = dict((old[0].get("data") or {})) if old else {}
    data.update(patch)
    for t in old:
        delete_token(place, t["id"])
    put_token(place, data, name=name or "%s-%s" % (key, value))
    return data


def journal(lane, stage, summary, **extra):
    data = {"at": now(), "lane": lane, "stage": stage, "summary": str(summary)[:600]}
    data.update({k: v for k, v in extra.items() if v is not None})
    try:
        put_token(P["journal"], data)
    except Exception as e:  # noqa: BLE001
        log("journal failed: %s" % e)


def error(lane, stage, message, **extra):
    log("ERROR %s/%s: %s" % (lane, stage, message))
    data = {"at": now(), "lane": lane, "stage": stage, "message": str(message)[:1500]}
    data.update({k: v for k, v in extra.items() if v is not None})
    try:
        put_token(P["errors"], data)
    except Exception as e:  # noqa: BLE001
        log("error token failed: %s" % e)


def run(cmd, cwd=None, timeout=600, env=None, check=False, input_text=None):
    e = dict(os.environ)
    e.update(env or {})
    shell = isinstance(cmd, str)
    p = subprocess.run(cmd, cwd=cwd, shell=shell, capture_output=True, text=True, timeout=timeout, env=e, input=input_text)
    if check and p.returncode != 0:
        raise RuntimeError("command failed (%s): %s\n%s" % (p.returncode, cmd if shell else " ".join(cmd), (p.stderr or p.stdout)[-1500:]))
    return p.returncode, p.stdout, p.stderr


def which(name):
    return shutil.which(name) or ""


def as_list(v):
    """A list value as a list. Elements that are objects or lists stay structured; scalars become strings."""
    if v is None:
        return []
    if isinstance(v, list):
        return [x if isinstance(x, (dict, list)) else str(x) for x in v]
    s = str(v).strip()
    if not s:
        return []
    if s.startswith("["):
        try:
            return [x if isinstance(x, (dict, list)) else str(x) for x in json.loads(s)]
        except ValueError:
            pass
    return [x.strip() for x in s.split(",") if x.strip()]


def as_int(v, default=0):
    try:
        return int(str(v).strip())
    except (TypeError, ValueError):
        return default


def as_float(v, default=0.0):
    try:
        return float(str(v).strip())
    except (TypeError, ValueError):
        return default


def as_dict(v):
    if isinstance(v, dict):
        return v
    if isinstance(v, str) and v.strip().startswith("{"):
        try:
            return json.loads(v)
        except ValueError:
            return {}
    return {}


def charter():
    """The newest charter token wins (the application appends a new one on every save)."""
    return latest(P["charter"], "updatedAt", 'FROM $ WHERE $.charterId == "team"') or latest(P["charter"], "updatedAt")


def goal_defined(c=None):
    c = c or charter()
    title = str(c.get("goal", "") or c.get("title", ""))
    return bool(title.strip()) and "REPLACE" not in title.upper()


def autonomy(c=None):
    return max(1, min(5, as_int((c or charter()).get("autonomyLevel"), 3)))


def scope_nets(c=None):
    """Nets the Service team may touch: the charter's list, or the pack's own nets when the list is empty."""
    c = c or charter()
    nets = as_list(c.get("scope"))
    return nets or ["own"]


def adrs(status=None):
    by_id = {}
    for t in query(P["adr"], "FROM $", 300):
        d = t.get("data") or {}
        key = d.get("adrId") or t.get("id")
        if key not in by_id or str(d.get("updatedAt", "")) >= str(by_id[key].get("updatedAt", "")):
            by_id[key] = d
    rows = sorted(by_id.values(), key=lambda a: str(a.get("adrId", "")))
    return [a for a in rows if status is None or a.get("status") == status]


def open_prompts(answered, decided):
    """The questions still waiting for the person: an approval whose spec has no decision, and for
    every other iteration only its NEWEST question (a reshaped question supersedes the older one,
    whose answer was consumed by the reshape) when nobody answered it."""
    newest_per_iteration = {}
    out = []
    for t in query(P["prompts"], "FROM $", 300):
        d = t.get("data") or {}
        if d.get("kind") == "approval":
            if d.get("specId") and d.get("specId") not in decided:
                out.append(d)
            continue
        key = str(d.get("iterationId") or d.get("promptId"))
        if key not in newest_per_iteration or str(d.get("at", "")) > str(newest_per_iteration[key].get("at", "")):
            newest_per_iteration[key] = d
    for d in newest_per_iteration.values():
        if d.get("promptId") and d.get("promptId") not in answered:
            out.append(d)
    return out


def loop_busy():
    """True while an iteration is in flight: a trigger, a brief, an unanswered question, a draft at the gate
    or a run. Whoever wants to start the next iteration asks this first, so one refusal or rollback never
    stacks a second question on the person."""
    if count(P["iterate"]) > 0 or count(P["context"]) > 0 or count(P["spec_drafts"]) > 0:
        return True
    answered = {str((t.get("data") or {}).get("promptId")) for t in query(P["responses"], "FROM $", 300)}
    answered |= {str((t.get("data") or {}).get("promptId")) for t in query(P["specs"], "FROM $", 300)}
    decided = {str((t.get("data") or {}).get("specId")) for t in query(P["decisions"], "FROM $", 300)}
    decided |= {str((t.get("data") or {}).get("specId")) for t in query(P["runs"], "FROM $", 300)}  # an approval is consumed into a run
    decided |= {str((t.get("data") or {}).get("specId")) for t in query(P["specs"], "FROM $", 300) if (t.get("data") or {}).get("status") not in ("draft", "needs-approval")}
    for d in open_prompts(answered, decided):
        return True
    return any((t.get("data") or {}).get("status") in ("coding", "building", "verifying", "releasing") for t in query(P["runs"], "FROM $", 100))


def start_iteration(reason, requested_by):
    """Start the next iteration unless one is in flight; returns the iteration id or ''."""
    if loop_busy():
        return ""
    it = "it-%s" % stamp()
    put_token(P["iterate"], {"at": now(), "iterationId": it, "reason": reason, "requestedBy": requested_by}, name=it)
    return it


def pack_lane_ids():
    """The pack's lanes as the runtime knows them: (transitionId, status) for every t-team-* lane."""
    listed = mcp("list_transitions", {})
    rows = as_list(listed.get("transitions")) if isinstance(listed, dict) else as_list(listed)
    out = []
    for t in rows:
        t = as_dict(t) if not isinstance(t, dict) else t
        tid = str(t.get("transitionId") or t.get("id") or "")
        if tid.startswith(TPREFIX):
            out.append((tid, str(t.get("status", ""))))
    return out


def rearm_starting():
    """A lane the installer just (re)started can sit in STARTING until it is stopped and started once
    more (measured 2026-09-09 on 2.59.0: 13 of 23 lanes after a hub install, 12 of 24 after a
    downgrade). Re-arm them; returns the lane ids."""
    rearmed = []
    for tid, status in pack_lane_ids():
        if status == "STARTING":
            try:
                mcp("stop_transition", {"transitionId": tid}); mcp("start_transition", {"transitionId": tid}); rearmed.append(tid)
            except Exception as e:  # noqa: BLE001
                rearmed.append("%s (failed: %s)" % (tid, str(e)[:60]))
    return rearmed


def remove_lanes(lane_ids):
    """Stop and deregister lanes (a rollback removes what the rolled-back version added: the hub keeps
    them on a downgrade, measured 2026-09-09)."""
    removed = []
    for tid in lane_ids:
        try:
            mcp("stop_transition", {"transitionId": tid})
        except Exception:  # noqa: BLE001
            pass
        try:
            mcp("delete_transition", {"transitionId": tid}); removed.append(tid)
        except Exception as e:  # noqa: BLE001
            removed.append("%s (failed: %s)" % (tid, str(e)[:60]))
    return removed


def runtime_installed_version():
    """The pack version the runtime reports for this model's application (empty when unknown)."""
    try:
        apps = mcp("application_list", {})
        for a in as_list(apps.get("applications") if isinstance(apps, dict) else apps):
            a = as_dict(a) if not isinstance(a, dict) else a
            if str(a.get("name")) == PACK_NAME and (a.get("version") or a.get("packVersion")):
                return str(a.get("version") or a.get("packVersion"))
    except Exception:  # noqa: BLE001
        pass
    return ""


def installed_version():
    """The installed pack version: the repo record (written by release, rollback and provision),
    else what the runtime reports."""
    v = str((repo() or {}).get("installedVersion") or "")
    return v or runtime_installed_version()


def repo():
    return latest(P["repo"], "updatedAt")


def team_home(c=None):
    """The team's working directory on the executor host: <office home>/<service> (the office charter's home, default ~/product)."""
    c = c or cfg()
    base = str(c.get("home") or office_charter().get("home") or "~/product")
    return os.path.join(os.path.expanduser(base), SERVICE)


def pack_dir(c=None):
    """The pack's compact sources inside the repository checkout: <repo>/<packDir>."""
    c = c or charter()
    rp = repo()
    root = str(rp.get("localPath") or os.path.join(team_home(c), "agentic-nets"))
    return os.path.join(root, str(c.get("packDir") or "capabilities/team")), root


def git(args, cwd, timeout=300, check=True):
    """Run git and return its stdout; with check (the default) a failure raises with the tail of stderr."""
    cmd = ["git", "-c", "user.name=Service team", "-c", "user.email=team@localhost"] + list(args)
    rc, o, e = run(cmd, cwd=cwd, timeout=timeout, check=check)
    return o or ""


def head_sha(path):
    rc, o, _ = run(["git", "rev-parse", "HEAD"], cwd=path, check=False)
    return o.strip() if rc == 0 else ""


def read_text(path, limit=6000):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            s = f.read(limit + 1)
        return s[:limit]
    except OSError:
        return ""


def read_json(path, default=None):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def walk_files(root, exts=None, skip=("node_modules", ".git", "dist", "target", ".idea")):
    found = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in skip]
        for fn in filenames:
            if exts is None or any(fn.endswith(x) for x in exts):
                found.append(os.path.join(dirpath, fn))
    return found


def command_token(tool_id, argv, stage=None, timeout_ms=600000, **extra):
    """A script-by-reference command token in the shape the executor runs."""
    tok = {
        "kind": "command", "id": "%s-%s" % (tool_id, stamp()),
        "executor": "script", "command": "invoke", "expect": "text",
        "args": {"toolId": tool_id, "argv": [str(a) for a in argv] + [_ANCHOR], "env": {"MODEL_ID": MODEL}, "timeoutMs": timeout_ms},
        "filedAt": now(),
    }
    if stage:
        tok["stage"] = stage
    args_env = extra.pop("args_env", None)
    if args_env:
        tok["args"]["env"].update({k: str(v) for k, v in args_env.items()})
    tok.update(extra)
    return tok


# ---------------------------------------------------------------- the runtime's own MCP
def mcp_url(c=None):
    return str((c or charter()).get("mcpUrl") or os.environ.get("STEWARD_MCP_URL") or "http://127.0.0.1:8091/mcp").rstrip("/")


def mcp_token():
    """From the vault-injected environment first; on a Desktop the app's own token file is the fallback."""
    t = os.environ.get("TEAM_MCP_TOKEN", "").strip()
    if t and not t.startswith("${"):
        return t
    for cand in ("~/.agenticos/desktop/mcp-token",):
        p = os.path.expanduser(cand)
        if os.path.exists(p):
            return read_text(p, 400).strip()
    return ""


_rpc = [0]


def mcp(tool, args=None, timeout=300, c=None):
    """Call one tool of the Agentic-Nets MCP server (streamable HTTP, bearer auth). Returns the
    structured result; raises on a JSON-RPC or tool error."""
    tok = mcp_token()
    if not tok:
        raise RuntimeError("no MCP token: provision the Service team (setup) or set TEAM_MCP_TOKEN")
    args = dict(args or {})
    args.setdefault("model", MODEL)
    _rpc[0] += 1
    body = json.dumps({"jsonrpc": "2.0", "id": _rpc[0], "method": "tools/call", "params": {"name": tool, "arguments": args}}).encode("utf-8")
    req = urllib.request.Request(mcp_url(c), data=body, method="POST")
    req.add_header("Authorization", "Bearer " + tok)
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "application/json, text/event-stream")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            text = r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        raise RuntimeError("mcp %s -> HTTP %s: %s" % (tool, e.code, e.read().decode("utf-8", "replace")[:300]))
    if text.lstrip().startswith("{"):
        msg = json.loads(text)
    else:
        datas = [l[5:] for l in text.split("\n") if l.startswith("data:")]
        msg = json.loads(datas[-1]) if datas else {}
    if msg.get("error"):
        raise RuntimeError("mcp %s: %s" % (tool, json.dumps(msg["error"])[:400]))
    res = msg.get("result") or {}
    inner = res.get("structuredContent")
    if inner is None:
        t = next((cc.get("text") for cc in res.get("content", []) if cc.get("type") == "text"), "")
        try:
            inner = json.loads(t)
        except ValueError:
            inner = {"_text": t}
    if res.get("isError"):
        raise RuntimeError("mcp %s tool error: %s" % (tool, json.dumps(inner)[:500]))
    return inner


def mcp_ok():
    try:
        r = mcp("readiness", {})
        return bool(r.get("ready")), r
    except Exception as e:  # noqa: BLE001
        return False, {"error": str(e)[:300]}


# ---------------------------------------------------------------- headless agents
DEFAULT_TOOLS = ("Read,Grep,Glob,Edit,Write,MultiEdit,"
                 "Bash(node capabilities/tools/pack.mjs build:*),Bash(python3 capabilities/tools/inline-shared.py:*),Bash(python3 -m py_compile:*),"
                 "Bash(node --check:*),Bash(git status:*),Bash(git diff:*),Bash(git log:*),Bash(ls:*),Bash(cat:*),Bash(find:*),Bash(mkdir:*)")

BUILTIN_CLAUDE = {
    "agentId": "claude-code", "title": "Claude Code (headless)", "binary": "claude",
    "command": ["claude", "-p", "--model", "${model}", "--allowedTools", "${allowedTools}", "--max-turns", "${maxTurns}", "--no-session-persistence", "--output-format", "json"],
    "promptVia": "stdin", "resultFormat": "claude-json", "defaultModel": "claude-opus-5", "allowedTools": DEFAULT_TOOLS, "maxTurns": "80", "timeoutMin": "45",
}


def resolve_agent(cfg, agent_key="coderAgent", model_key="coderModel", places=None):
    """A headless agent: a definition token from p-team-coders chosen by cfg[agent_key], with
    charter overrides for model, tools, turns and timeout. Falls back to the built-in Claude Code."""
    defs = {}
    for place in reversed(places or [P["coders"], OFFICE["coders"]]):   # the team's own definitions win over the office's
        for t in query(place, "FROM $", 20):
            d = t.get("data") or {}
            if d.get("agentId"):
                defs[d["agentId"]] = d
    agent_id = str(cfg.get(agent_key) or "claude-code")
    a = defs.get(agent_id) or (BUILTIN_CLAUDE if agent_id == "claude-code" else None)
    if not a:
        raise RuntimeError("agent '%s' is neither defined for the team nor in the product office (known: %s)" % (agent_id, ", ".join(sorted(defs)) or "none"))
    model = str(cfg.get(model_key) or a.get("defaultModel") or "")
    tools = str(cfg.get("coderAllowedTools") or a.get("allowedTools") or DEFAULT_TOOLS)
    turns = str(cfg.get("coderMaxTurns") or a.get("maxTurns") or "80")
    timeout_min = as_int(cfg.get("coderTimeoutMin") or a.get("timeoutMin"), 45)
    argv = [str(x).replace("${model}", model).replace("${allowedTools}", tools).replace("${maxTurns}", turns) for x in as_list(a.get("command"))]
    if not argv:
        raise RuntimeError("agent '%s' has no command" % agent_id)
    if not which(argv[0]):
        raise RuntimeError("agent binary '%s' is not on the executor host" % argv[0])
    return {"agentId": a.get("agentId"), "title": a.get("title", a.get("agentId")), "argv": argv, "model": model, "resultFormat": a.get("resultFormat", "text"),
            "promptVia": a.get("promptVia", "stdin"), "timeoutSec": timeout_min * 60}


def run_headless(prompt, root, cfg, agent, result_key="TEAM_RESULT"):
    env = {k: v for k, v in os.environ.items() if k not in ("CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT")}
    env["TEAM_MCP_TOKEN"] = ""  # the coder never sees the runtime's token; it gets its own MCP client if configured
    argv = list(agent["argv"])
    stdin_text = prompt
    if agent["promptVia"] == "argv":
        argv.append(prompt); stdin_text = None
    started = time.time()
    rc, o, e = run(argv, cwd=root, timeout=agent["timeoutSec"], env=env, check=False, input_text=stdin_text)
    duration = round(time.time() - started)
    result_text, cost, turns, is_error = "", "", "", rc != 0
    if agent["resultFormat"] == "claude-json":
        try:
            j = json.loads(o.strip().splitlines()[-1]) if o.strip() else {}
            result_text = str(j.get("result", ""))
            cost = str(j.get("total_cost_usd", ""))
            turns = str(j.get("num_turns", ""))
            is_error = bool(j.get("is_error", False)) or rc != 0
        except (ValueError, IndexError):
            result_text = (o or e)[-3000:]
    else:
        result_text = (o or "")[-6000:] or (e or "")[-3000:]
    summary = {"summary": "", "filesChanged": [], "notes": ""}
    m = re.search(result_key + r":\s*(\{.*\})", result_text, re.S)
    if m:
        try:
            summary.update(json.loads(m.group(1)))
        except ValueError:
            summary["notes"] = "result line was not valid JSON"
    if not summary.get("summary"):
        summary["summary"] = result_text[-800:].strip()
    return {"rc": rc, "isError": is_error, "durationSec": duration, "costUsd": cost, "turns": turns, "summary": summary, "stderr": (e or "")[-1500:], "raw": result_text[-4000:]}


# ---------------------------------------------------------------- the team in the product
# the module's own wrapper when it has one, the host's mvn otherwise (node and master have no wrapper)
MVN = "$( [ -x ./mvnw ] && echo ./mvnw || echo mvn )"
SERVICE_DEFAULTS = {
    "node": ("core", "agentic-net-node", MVN + " -o -q test", MVN + " -o -q -DskipTests compile"),
    "master": ("core", "agentic-net-master", MVN + " -o -q test", MVN + " -o -q -DskipTests compile"),
    "gui": ("core", "agentic-net-gui", "npx ng test --watch=false", "npx ng build --configuration production"),
    "gateway": ("agentic-nets", "agentic-net-gateway", MVN + " -o -q test", MVN + " -o -q -DskipTests compile"),
    "executor": ("agentic-nets", "agentic-net-executor", MVN + " -o -q test", MVN + " -o -q -DskipTests compile"),
    "vault": ("agentic-nets", "agentic-net-vault", MVN + " -o -q test", MVN + " -o -q -DskipTests compile"),
    "blobstore": ("agentic-nets", "sa-blobstore", MVN + " -o -q test", MVN + " -o -q -DskipTests compile"),
    "cli": ("agentic-nets", "agentic-net-cli", "npm test", "npx tsup"),
    "mcp": ("agentic-nets", "agentic-net-mcp", "npm test", "npx tsup"),
    "chat": ("agentic-nets", "agentic-net-chat", "npm test", "npx tsup"),
    "deployment": ("agentic-nets", "deployment", "bash -n scripts/build-and-push.sh", "docker compose -f docker-compose.hub-only.yml config -q"),
}


def office_charter():
    return latest(OFFICE["charter"], "updatedAt", 'FROM $ WHERE $.charterId == "office"') or latest(OFFICE["charter"], "updatedAt")


def cfg():
    """The team charter with the office charter filling every empty coder, brain, autonomy and budget field."""
    c = dict(charter()); o = office_charter()
    for k in ("coderAgent", "coderModel", "coderMaxTurns", "coderTimeoutMin", "coderAllowedTools", "brainAgent", "brainModel", "autonomyLevel", "dailyBudgetUsd", "mcpUrl", "home"):
        if not str(c.get(k) or "").strip() and str(o.get(k) or "").strip():
            c[k] = o[k]
    c.setdefault("repoRoot", o.get("repoRoot", ""))
    if not str(c.get("repoRoot") or "").strip():
        c["repoRoot"] = o.get("repoRoot", "")
    return c


def app_route():
    return "#/applications/%s?model=%s" % (SESSION, MODEL)


def workspace_mode(c=None):
    """Where the team works. "workspace" (default): directly in the person's own repository, so the
    branches appear where they already work. "clone": an isolated clone under the team's home."""
    return str((c or cfg()).get("repoMode") or "workspace").strip().lower() != "clone"


def repo_root(c=None):
    """The repository the team works in: the person's own checkout, or the team's clone of it."""
    c = c or cfg()
    if workspace_mode(c):
        return workspace_repo(c)
    return os.path.join(team_home(c), str(c.get("repo") or "core"))


def tree_state(root):
    """What the checkout is doing right now: the branch it is on and whether anything is uncommitted."""
    return {"branch": git(["rev-parse", "--abbrev-ref", "HEAD"], root, check=False).strip(),
            "dirty": bool(git(["status", "--porcelain"], root, check=False).strip())}


def sync_main(root, c=None):
    """Put the checkout on a current main before branching.

    In a clone the origin IS the person's repository, so a hard reset only re-syncs the copy. In the
    person's own repository a hard reset to origin/main would destroy every unpushed commit, so this
    never resets there: it refuses instead and says what is in the way. Refusing costs an iteration;
    resetting would cost the work."""
    c = c or cfg()
    if not workspace_mode(c):
        git(["fetch", "-q", "origin"], root, check=False)
        git(["checkout", "-q", "main"], root)
        git(["reset", "-q", "--hard", "origin/main"], root)
        return {"mode": "clone", "head": head_sha(root)}
    st = tree_state(root)
    if st["dirty"]:
        raise RuntimeError("your repository %s has uncommitted changes; the team works in it directly, so commit "
                           "or stash them first (nothing was touched)" % root)
    if st["branch"] != "main":
        raise RuntimeError("your repository %s is on branch %s, not main; switch to main first "
                           "(nothing was touched)" % (root, st["branch"]))
    return {"mode": "workspace", "head": head_sha(root)}


def service_dir(c=None):
    c = c or cfg()
    return os.path.join(repo_root(c), str(c.get("repoDir") or ""))


def workspace_repo(c=None):
    c = c or cfg()
    return os.path.join(os.path.expanduser(str(c.get("repoRoot") or "")), str(c.get("repo") or "core"))


def office_inbox(kind, title, ref, persona, detail="", route=None):
    """Mirror something that waits for the person into the product office's inbox (one open item per ref)."""
    close_office_inbox(ref)
    item = {"itemId": "inbox-%s-%s" % (SERVICE, stamp()), "service": SERVICE, "persona": persona, "kind": kind, "title": title[:200], "detail": str(detail)[:1200],
            "ref": ref, "route": route or app_route(), "status": "open", "at": now()}
    put_token(OFFICE["inbox"], item, name=item["itemId"])
    return item


def close_office_inbox(ref):
    n = 0
    for t in query(OFFICE["inbox"], 'FROM $ WHERE $.ref == "%s" AND $.service == "%s"' % (ref, SERVICE), 20):
        delete_token(OFFICE["inbox"], t["id"]); n += 1
    return n


def push_status(kind, summary, **fields):
    """A status row for this team, kept in the team and pushed to the product office."""
    row = {"service": SERVICE, "session": SESSION, "kind": kind, "summary": str(summary)[:600], "at": now(), "route": app_route()}
    row.update(fields)
    put_token(P["status"], row, name="status-%s-%s" % (kind, stamp()))
    keep_last(P["status"], "at", 60)
    put_token(OFFICE["status"], dict(row), name="status-%s-%s-%s" % (SERVICE, kind, stamp()))
    return row


def plan_key(title):
    """A stable key for a plan increment. The brain rewrites the whole plan after every merge and
    renumbers the increments, so inc-1 means something different each time; the person's verdict has to
    key off the wording instead."""
    t = re.sub(r"[^a-z0-9]+", " ", str(title or "").lower()).strip()
    return hashlib.sha1(t.encode("utf-8")).hexdigest()[:12] if t else ""


def backlog_verdicts():
    """What the person already decided about plan increments: key -> the newest verdict token."""
    out = {}
    for t in query(P["backlog"], "FROM $", 300):
        d = t.get("data") or {}
        k = str(d.get("key") or "")
        if k and str(d.get("at", "")) >= str(out.get(k, {}).get("at", "")):
            out[k] = d
    return out


def by_id(place, field, value):
    return one(place, 'FROM $ WHERE $.%s == "%s" LIMIT 1' % (field, value))


def set_status(place, field, value, status, **more):
    """Replace a record's status (and more fields) in place, keeping its token name."""
    patch = {"status": status, "updatedAt": now()}
    patch.update(more)
    return replace_token(place, field, value, patch)


def next_id(prefix, place, field):
    n = 0
    for t in query(place, "FROM $", 500):
        v = str((t.get("data") or {}).get(field, ""))
        if v.startswith(prefix):
            try:
                n = max(n, int(v[len(prefix):].split("-")[0]))
            except ValueError:
                pass
    return "%s%03d" % (prefix, n + 1)


def team_lanes():
    listed = mcp("list_transitions", {})
    rows = as_list(listed.get("transitions")) if isinstance(listed, dict) else as_list(listed)
    lanes = []
    for t in rows:
        t = t if isinstance(t, dict) else as_dict(t)
        tid = str(t.get("transitionId") or t.get("id") or "")
        if tid.startswith(TPREFIX):
            lanes.append((tid, str(t.get("status", ""))))
    return lanes


def lane(bare):
    return TPREFIX + bare


def lane_id(value):
    """A lane id from the charter: already namespaced (seed tokens are rewritten at install) or the pack's t-team-<x> form."""
    v = str(value or "").strip()
    if v.startswith(TPREFIX):
        return v
    return lane(v.replace("t-team-", "", 1))


def main_guard(lane, fn, argv):
    """Run a script entry point; on failure write an error token and exit non-zero."""
    try:
        result = fn(argv)
        if result is not None:
            out(result)
        return 0
    except Exception as e:  # noqa: BLE001
        error(lane, argv[0] if argv else "main", "%s: %s" % (type(e).__name__, e), argv=argv)
        out({"success": False, "error": str(e)[:800]})
        return 1
# <<< shared: teamlib

LANE = "dev-cmd"


def render_pack(p, notes="", previous=None):
    lines = ["You are the DEVELOPER of the %s service of Agentic-Nets. Implement exactly the spec below on the current branch %s in %s (the service directory of the %s repository)." % (SERVICE, p.get("branch"), p.get("serviceDir"), p.get("repo")),
             "RULES: work only under the service directory%s; commit your work on this branch with the message '%s: %s'; NEVER push, NEVER merge, NEVER switch branches; run `%s` before you finish and fix what you broke; add or extend the tests the acceptance criteria name; note every deviation from the spec." % (
                 (" and " + ", ".join(as_list(as_dict(p.get("constraints")).get("scopePaths")))) if False else "", p.get("specId"), p.get("title"), as_dict(p.get("commands")).get("test")),
             "## THE REQUIREMENT\n%s" % json.dumps(as_dict(p.get("requirement")), indent=1)[:4000],
             "## THE SPEC %s: %s\n%s" % (p.get("specId"), p.get("title"), json.dumps(as_dict(p.get("spec")), indent=1)[:9000]),
             "## ACCEPTANCE CRITERIA (QA verifies these on the real suites)\n%s" % json.dumps(as_dict(p.get("acceptance")), indent=1)[:6000],
             "## DECISIONS YOU MUST RESPECT\n%s" % ("\n".join("- %s %s: %s" % (d.get("adrId"), d.get("title"), d.get("decision")) for d in [x if isinstance(x, dict) else as_dict(x) for x in as_list(p.get("decisions"))]) or "- none"),
             "## CONSTRAINTS\n%s" % "\n".join("- " + str(x) for x in as_list(p.get("constraints")))]
    if notes:
        lines.append("## THE PERSON'S NOTES\n%s" % notes)
    if previous:
        lines.append("## THE PREVIOUS RUN %s WAS SENT BACK\nreviewer: %s\nverification: %s\nChange what was asked; keep what was right." % (previous.get("runId"), previous.get("reviewSummary", ""), previous.get("verificationSummary", "")))
    lines.append("When done, print ONE final line: TEAM_RESULT: {\"summary\": <three sentences>, \"filesChanged\": [<files>], \"tests\": <what you ran and the result>, \"deviations\": [<where you departed from the spec and why>], \"notes\": <anything the reviewer must know>}")
    return "\n\n".join(lines)


def implement(argv):
    sid = argv[1]
    c = cfg()
    spec = by_id(P["specs"], "specId", sid)
    if not spec:
        raise RuntimeError("spec %s not found" % sid)
    if str(spec.get("status")) not in ("approved", "implemented", "verified"):
        raise RuntimeError("spec %s is %s; no run without an approved spec" % (sid, spec.get("status")))
    packs = [t.get("data") or {} for t in query(P["briefs"], 'FROM $ WHERE $.specId == "%s"' % sid, 20)]
    packs.sort(key=lambda p: str(p.get("at", "")))
    if not packs:
        raise RuntimeError("no context pack for %s; the architect assembles it after the acceptance criteria" % sid)
    p = packs[-1]
    notes = envv("DECISION_NOTES"); prev_id = envv("PREVIOUS_RUN")
    # one coder per spec at a time: a re-dispatched command (a runtime restart replays in-flight tokens)
    # must not start a second coder in the same working tree
    for t in query(P["runs"], 'FROM $ WHERE $.specId == "%s" AND $.status == "coding"' % sid, 10):
        d = t.get("data") or {}
        started = str(d.get("startedAt") or d.get("at") or "")
        age = (datetime.datetime.now(datetime.timezone.utc) - datetime.datetime.fromisoformat(started.replace("Z", "+00:00"))).total_seconds() if started else 0
        if age < as_int(c.get("coderTimeoutMin"), 60) * 60 + 300:
            journal(lane(LANE), "implement", "refused: run %s is still coding %s (%d s); no second coder in the same tree" % (d.get("runId"), sid, age), specId=sid)
            return {"success": True, "skipped": "coding", "runId": d.get("runId")}
    previous = None
    if prev_id:
        pr = by_id(P["runs"], "runId", prev_id)
        rev = latest(P["reviews"], "at", 'FROM $ WHERE $.runId == "%s"' % prev_id); ver = latest(P["verification"], "at", 'FROM $ WHERE $.runId == "%s"' % prev_id)
        previous = {"runId": prev_id, "reviewSummary": "%s: %s; points: %s" % (rev.get("verdict"), rev.get("summary"), "; ".join("%s %s: %s" % (x.get("severity"), x.get("file"), x.get("comment")) for x in [y if isinstance(y, dict) else as_dict(y) for y in as_list(rev.get("points"))][:8])), "verificationSummary": "%s: %s" % (ver.get("verdict"), ver.get("summary"))}
        for t in query(P["prompts"], 'FROM $ WHERE $.promptId == "pr-merge-%s" LIMIT 5' % prev_id, 5):
            delete_token(P["prompts"], t["id"])
        close_office_inbox("pr-merge-%s" % prev_id)
        set_status(P["runs"], "runId", prev_id, "superseded")
    close_office_inbox("pr-pack-%s" % sid)
    for t in query(P["prompts"], 'FROM $ WHERE $.promptId == "pr-pack-%s" LIMIT 5' % sid, 5):
        delete_token(P["prompts"], t["id"])
    root = repo_root(c); sd = service_dir(c); branch = str(p.get("branch"))
    was = tree_state(root)
    sync_main(root, c)   # refuses rather than resetting when the team works in the person's own repository
    base = head_sha(root)
    existing = git(["branch", "--list", branch], root).strip()
    if existing and prev_id:
        git(["checkout", "-q", branch], root)
    else:
        if existing:
            git(["branch", "-D", branch], root)
        git(["checkout", "-q", "-b", branch], root)
    agent = resolve_agent(c)
    run_id = "run-%s-%s" % (sid, stamp())
    put_token(P["runs"], {"runId": run_id, "specId": sid, "requirementId": p.get("requirementId"), "iterationId": p.get("iterationId", ""), "packId": p.get("packId"), "branch": branch, "baseSha": base, "coder": agent["agentId"], "model": agent["model"], "status": "coding", "at": now(), "startedAt": now(), "title": p.get("title"), "previousRun": prev_id}, name=run_id)
    push_status("run", "coder %s started on %s (%s)" % (agent["model"], sid, p.get("title")), runId=run_id, specId=sid)
    journal(lane(LANE), "implement", "run %s: %s (%s) codes %s on %s" % (run_id, agent["agentId"], agent["model"], sid, branch), runId=run_id, specId=sid)
    res = run_headless(render_pack(p, notes, previous), sd, c, agent)
    status_txt = git(["status", "--porcelain"], root)
    if status_txt.strip():
        git(["add", "-A", "--", os.path.relpath(sd, root)], root, check=False)
        git(["commit", "-q", "-m", "%s: %s (uncommitted changes left by the coder)" % (sid, p.get("title"))], root, check=False)
    head = head_sha(root)
    files = [f for f in git(["diff", "--name-only", "main...%s" % branch], root).splitlines() if f.strip()]
    diffstat = git(["diff", "--shortstat", "main...%s" % branch], root).strip()
    git(["checkout", "-q", was["branch"] or "main"], root, check=False)
    built = (not res["isError"]) and head != base and bool(files)
    patch = {"status": "built" if built else "failed", "headSha": head, "filesChanged": files[:80], "diffStat": diffstat, "durationSec": res["durationSec"], "costUsd": res["costUsd"], "turns": res["turns"], "summary": res["summary"], "stderr": res["stderr"][-600:], "finishedAt": now()}
    set_status(P["runs"], "runId", run_id, patch["status"], **{k: v for k, v in patch.items() if k != "status"})
    if built:
        set_status(P["specs"], "specId", sid, "implemented", runId=run_id)
        put_token(P["qa_cmd"], command_token("team-qa", ["verify", run_id], stage="verify", timeout_ms=2400000, runId=run_id, specId=sid))
        push_status("run", "run %s built %s: %d file(s), %s s, cost %s; QA verifies" % (run_id, sid, len(files), res["durationSec"], res["costUsd"] or "n/a"), runId=run_id, specId=sid, ok=True)
        journal(lane(LANE), "implement", "run %s built: %d file(s) on %s in %d s (cost %s); handed to QA" % (run_id, len(files), branch, res["durationSec"], res["costUsd"] or "n/a"), runId=run_id, specId=sid)
    else:
        office_inbox("failure", "%s: coder run %s failed" % (SERVICE, run_id), run_id, "developer", detail=("%s; %s" % (res["summary"].get("summary", ""), res["stderr"][-300:]))[:800])
        push_status("run", "run %s failed (%s)" % (run_id, "coder error" if res["isError"] else "no commits"), runId=run_id, specId=sid, ok=False)
        journal(lane(LANE), "implement", "run %s failed: %s" % (run_id, "coder error" if res["isError"] else "the coder committed nothing"), runId=run_id, specId=sid)
    return {"success": built, "runId": run_id, "files": len(files)}


def review_brief(argv):
    run_id = argv[1]
    c = cfg()
    r = by_id(P["runs"], "runId", run_id)
    if not r:
        raise RuntimeError("run %s not found" % run_id)
    spec = by_id(P["specs"], "specId", str(r.get("specId", ""))); acc = by_id(P["acceptance"], "specId", str(r.get("specId", "")))
    ver = latest(P["verification"], "at", 'FROM $ WHERE $.runId == "%s"' % run_id)
    root = repo_root(c)
    diff = git(["diff", "main...%s" % r.get("branch")], root)
    if len(diff) > 60000:
        diff = diff[:60000] + "\n... (diff truncated at 60000 chars; %d chars total)" % len(diff)
    stat = git(["diff", "--stat", "main...%s" % r.get("branch")], root)
    review_id = "rev-%s" % run_id
    sections = ["SERVICE: %s. RUN %s on branch %s by %s (%s)." % (SERVICE, run_id, r.get("branch"), r.get("coder"), r.get("model")),
                "THE SPEC %s: %s\n%s" % (spec.get("specId"), spec.get("title"), json.dumps({k: spec.get(k) for k in ("summary", "module", "design", "interfaces", "files", "constraints")}, indent=1)[:6000]),
                "ACCEPTANCE CRITERIA:\n%s" % json.dumps(as_list(acc.get("criteria")), indent=1)[:4000],
                "WHAT QA MEASURED: %s\n%s" % (ver.get("verdict"), json.dumps({k: ver.get(k) for k in ("summary", "suites", "diff", "criteria")}, indent=1)[:3000]),
                "WHAT THE CODER REPORTED: %s" % json.dumps(as_dict(r.get("summary")), indent=1)[:2500],
                "DIFF STAT:\n%s" % stat[-3000:], "THE DIFF:\n%s" % diff,
                "reviewId: %s\nrunId: %s\nspecId: %s" % (review_id, run_id, spec.get("specId"))]
    brief = "\n\n".join(sections)
    put_token(P["context"], {"at": now(), "purpose": "review", "service": SERVICE, "runId": run_id, "specId": spec.get("specId"), "reviewId": review_id, "brief": brief}, name="ctx-review-%s" % stamp())
    journal(lane(LANE), "review-brief", "review brief for %s (%d chars of diff)" % (run_id, len(diff)), runId=run_id)
    return {"success": True, "reviewId": review_id}


def merge_ask(argv):
    run_id = argv[1]
    r = by_id(P["runs"], "runId", run_id)
    rev = latest(P["reviews"], "at", 'FROM $ WHERE $.runId == "%s"' % run_id)
    ver = latest(P["verification"], "at", 'FROM $ WHERE $.runId == "%s"' % run_id)
    pid = "pr-merge-%s" % run_id
    if by_id(P["prompts"], "promptId", pid) or str(r.get("status")) in ("merged", "superseded"):
        return {"success": True, "skipped": "asked"}
    spec = by_id(P["specs"], "specId", str(r.get("specId", "")))
    points = "\n".join("- %s %s: %s" % (x.get("severity"), x.get("file"), x.get("comment")) for x in [y if isinstance(y, dict) else as_dict(y) for y in as_list(rev.get("points"))][:10])
    summary = "verification: %s (%s)\nreview: %s: %s\n%s\nmissing acceptance: %s\nspec deviations: %s\nfiles: %s\ndiff: %s" % (ver.get("verdict"), ver.get("summary"), rev.get("verdict"), rev.get("summary"), points, "; ".join(as_list(rev.get("acceptanceMissing"))) or "none", "; ".join(as_list(rev.get("specDeviations"))) or "none", ", ".join(as_list(r.get("filesChanged"))[:20]), r.get("diffStat"))
    put_token(P["prompts"], {"promptId": pid, "iterationId": r.get("iterationId", ""), "kind": "merge", "persona": "developer", "service": SERVICE, "runId": run_id, "specId": r.get("specId"), "mode": "choice",
                             "question": "Merge %s (%s, run %s)? The reviewer says %s." % (r.get("specId"), spec.get("title"), run_id, rev.get("verdict")), "summary": summary[:4000],
                             "options": [{"value": "merge", "label": "Merge the branch", "recommended": rev.get("verdict") == "approve"}, {"value": "changes", "label": "Request changes (send the coder back with notes)", "recommended": rev.get("verdict") == "changes"}, {"value": "reject", "label": "Drop this run", "recommended": False}],
                             "rationale": "The person merges; the merge itself runs as a command transition.", "at": now()}, name=pid)
    set_status(P["runs"], "runId", run_id, "reviewed", reviewVerdict=rev.get("verdict"))
    office_inbox("merge", "%s: merge %s? reviewer says %s" % (SERVICE, r.get("specId"), rev.get("verdict")), pid, "developer", detail=summary[:600])
    push_status("review", "run %s reviewed: %s; waits for the person's merge" % (run_id, rev.get("verdict")), runId=run_id, specId=r.get("specId"))
    journal(lane(LANE), "merge-ask", "run %s reviewed (%s); the merge waits for the person" % (run_id, rev.get("verdict")), runId=run_id, promptId=pid)
    return {"success": True, "promptId": pid}


def merge(argv):
    run_id = argv[1]
    c = cfg()
    r = by_id(P["runs"], "runId", run_id)
    if not r:
        raise RuntimeError("run %s not found" % run_id)
    spec = by_id(P["specs"], "specId", str(r.get("specId", "")))
    root = repo_root(c); branch = str(r.get("branch")); notes = envv("DECISION_NOTES")
    for t in query(P["prompts"], 'FROM $ WHERE $.promptId == "pr-merge-%s" LIMIT 5' % run_id, 5):
        delete_token(P["prompts"], t["id"])
    close_office_inbox("pr-merge-%s" % run_id)
    sync_main(root, c)
    msg = "Merge %s: %s (%s)" % (branch, spec.get("title"), spec.get("specId"))
    rc, o, e = run(["git", "merge", "--no-ff", "-m", msg, branch], cwd=root, timeout=300, check=False)
    if rc != 0:
        run(["git", "merge", "--abort"], cwd=root, timeout=60, check=False)
        set_status(P["runs"], "runId", run_id, "merge-failed", mergeError=(e or o)[-600:])
        office_inbox("failure", "%s: merge of %s failed" % (SERVICE, branch), run_id, "developer", detail=(e or o)[-600:])
        journal(lane(LANE), "merge", "merge of %s failed: %s" % (branch, (e or o)[-200:]), runId=run_id)
        return {"success": False, "error": (e or o)[-300:]}
    merge_sha = head_sha(root)
    if workspace_mode(c):
        # the team works in the person's own repository, so the merge already landed where they look;
        # nothing is pushed, the branch stays for review, and the person pushes when they want to
        ws_note = "merged into %s on main (%s); the branch %s is kept, nothing pushed" % (root, merge_sha[:10], branch)
    else:
        # an isolated clone: carry the branch back into the person's repository, and merge its main
        # only when that tree is clean and on main
        ws = workspace_repo(c); ws_note = ""
        try:
            git(["fetch", "-q", root, "%s:%s" % (branch, branch)], ws, check=False)
            st = tree_state(ws)
            if st["branch"] == "main" and not st["dirty"]:
                rc2, o2, e2 = run(["git", "merge", "--no-ff", "-m", msg, branch], cwd=ws, timeout=300, check=False)
                ws_note = ("merged into the workspace main (%s)" % head_sha(ws)[:10]) if rc2 == 0 else "workspace merge failed: %s" % (e2 or o2)[-200:]
                if rc2 != 0:
                    run(["git", "merge", "--abort"], cwd=ws, timeout=60, check=False)
            else:
                ws_note = "branch %s fetched into the workspace repository; main NOT merged there (%s)" % (branch, "working tree dirty" if st["dirty"] else "on branch " + st["branch"])
        except Exception as ex:  # noqa: BLE001
            ws_note = "workspace repository untouched: %s" % str(ex)[:160]
    set_status(P["runs"], "runId", run_id, "merged", mergeSha=merge_sha, mergedAt=now(), mergeNotes=notes, workspace=ws_note)
    set_status(P["specs"], "specId", str(r.get("specId", "")), "merged", mergeSha=merge_sha)
    replace_token(OFFICE["specs"], "specId", str(r.get("specId", "")), {"status": "merged", "at": now()}, name="spec-%s" % r.get("specId"))
    if spec.get("requirementId"):
        set_status(P["requirements"], "requirementId", str(spec.get("requirementId")), "done", runId=run_id)
    push_status("release", "%s merged: %s (%s) on %s; %s" % (SERVICE, spec.get("specId"), spec.get("title"), merge_sha[:10], ws_note), runId=run_id, specId=r.get("specId"), title=spec.get("title"), mergeSha=merge_sha, ok=True)
    put_token(P["brain_cmd"], command_token("team-brain", ["observe", run_id], stage="observe", timeout_ms=900000, runId=run_id, specId=r.get("specId")))
    journal(lane(LANE), "merge", "the person merged %s (%s): %s; %s; the brain observes" % (branch, spec.get("specId"), merge_sha[:10], ws_note), runId=run_id, specId=r.get("specId"))
    return {"success": True, "mergeSha": merge_sha, "workspace": ws_note}


def main(argv):
    cmd = argv[0] if argv else ""
    if cmd == "implement":
        return implement(argv)
    if cmd == "review-brief":
        return review_brief(argv)
    if cmd == "merge-ask":
        return merge_ask(argv)
    if cmd == "merge":
        return merge(argv)
    raise RuntimeError("usage: team-dev.py implement <specId>|review-brief <runId>|merge-ask <runId>|merge <runId>")


if __name__ == "__main__":
    sys.exit(main_guard(lane(LANE), main, sys.argv[1:]))
