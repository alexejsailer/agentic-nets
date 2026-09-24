#!/usr/bin/env python3
"""team-arch: the architect's lane (t-team-arch-cmd).

usage: team-arch.py design-brief <requirementId> | catalog | spec-gate <specId> | pack <specId>

design-brief  renders the design brief for the one-shot spec writer (t-team-design): the requirement, the module state, the spec
              catalog, related specs, accepted decisions, architecture notes and the product-level specs
catalog       mirrors the service's code structure into the spec catalog net: one place per module, link transitions from the
              catalog root (relation contains) and an index token per module; re-run whenever HEAD moved
spec-gate     asks the person to approve a spec draft (a question in the prompts place and the office inbox) and lists the spec
              in the product-level catalog
pack          assembles the context pack for the coder from the approved spec, the requirement, the acceptance criteria and the
              accepted decisions, then runs the policy gate: autonomy and budget decide whether the person approves the pack
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

LANE = "arch-cmd"
CODE_EXTS = (".java", ".ts", ".tsx", ".js", ".mjs", ".py", ".kt", ".go", ".sh", ".html", ".scss")
MAX_MODULES = 40


def slug(path):
    """A short, unique place id fragment for a module path: the last two segments plus a hash of the
    whole path (long Java package paths share their first 48 characters, so a prefix would collide)."""
    import hashlib
    segs = [x for x in re.split(r"[/\\]+", path.lower()) if x]
    tail = re.sub(r"[^a-z0-9]+", "-", "-".join(segs[-2:])).strip("-")[:36] or "root"
    return "%s-%s" % (tail, hashlib.sha1(path.encode("utf-8")).hexdigest()[:6])


def tail(path, n=2):
    """The last segments of a module path: what a drawing can label without overlapping its neighbours."""
    segs = [x for x in re.split(r"[/\\]+", str(path)) if x]
    return "/".join(segs[-n:]) if segs else "root"


def spec_place(module_path):
    return "p-%s-spec-%s" % (NAMESPACE or "team", slug(module_path))


def modules_of(sd):
    """Modules mirror the code: for Java the packages one level below the base package; for TypeScript the directories under src;
    otherwise the top-level directories that hold code. Every module knows its files."""
    files = [os.path.relpath(f, sd) for f in walk_files(sd, exts=CODE_EXTS)]
    mods = {}
    java = [f for f in files if f.endswith(".java") and f.startswith("src/main/java/")]
    if java:
        parts = [f[len("src/main/java/"):].split("/") for f in java]
        depth = 0
        while depth < 8 and len({tuple(p[:depth + 1]) for p in parts if len(p) > depth + 1}) == 1:
            depth += 1
        for f, p in zip(java, parts):
            key = "/".join(p[:depth + 1]) if len(p) > depth + 1 else "/".join(p[:depth]) or "root"
            mods.setdefault("src/main/java/" + key, []).append(f)
        for f in files:
            if not f.startswith("src/main/java/"):
                top = f.split("/")[0] if "/" in f else "root"
                if top in ("src", "target", "node_modules"):
                    top = "/".join(f.split("/")[:3]) if f.startswith("src/") else top
                mods.setdefault(top, []).append(f)
    else:
        for f in files:
            segs = f.split("/")
            key = "/".join(segs[:2]) if segs[0] == "src" and len(segs) > 2 else (segs[0] if len(segs) > 1 else "root")
            mods.setdefault(key, []).append(f)
    rows = sorted(mods.items(), key=lambda kv: -len(kv[1]))
    if len(rows) > MAX_MODULES:
        rest = [f for _, fs in rows[MAX_MODULES - 1:] for f in fs]
        rows = rows[:MAX_MODULES - 1] + [("other", rest)]
    return [{"path": k, "files": len(v), "placeId": spec_place(k), "sample": sorted(v)[:6]} for k, v in sorted(rows)]


def catalog_net_id():
    return "net-%s-team-specs" % NAMESPACE if NAMESPACE else "net-team-specs"


def catalog(argv):
    c = cfg(); sd = service_dir(c); root = repo_root(c)
    if not os.path.isdir(sd):
        raise RuntimeError("service directory missing: %s (run provision)" % sd)
    head = head_sha(root)
    cur = latest(P["spec_catalog"], "at")
    if cur and cur.get("head") == head and as_list(cur.get("modules")) and not (argv[1:] and argv[1] == "force"):
        journal(lane(LANE), "catalog", "catalog is current (HEAD %s)" % head[:10])
        return cur
    mods = modules_of(sd)
    known = {m.get("placeId") for m in as_list(cur.get("modules"))} if cur and not (argv[1:] and argv[1] == "force") else set()   # force redraws everything
    created, linked, failed = 0, 0, []
    net_id = catalog_net_id()
    for i, m in enumerate(mods):
        if m["placeId"] in known:
            continue
        try:
            mcp("add_place", {"netId": net_id, "sessionId": SESSION, "placeId": m["placeId"], "label": "spec: %s" % tail(m["path"]), "x": 120 + (i % 5) * 300, "y": 260 + (i // 5) * 230})
            created += 1
        except Exception as e:  # noqa: BLE001
            if "exists" not in str(e).lower():
                failed.append("%s: %s" % (m["placeId"], str(e)[:100])); continue
        tid = "t-%s-spec-has-%s" % (NAMESPACE or "team", slug(m["path"]))
        tx, ty = 60 + (i % 5) * 300, 160 + (i // 5) * 230
        try:
            mcp("add_transition", {"netId": net_id, "sessionId": SESSION, "transitionId": tid, "kind": "link", "inputPlace": P["spec_catalog"], "outputPlace": m["placeId"], "label": "contains " + tail(m["path"]), "relation": "contains", "start": False, "x": tx, "y": ty})
            linked += 1
        except Exception as e:  # noqa: BLE001
            if "exists" in str(e).lower():
                # the link is registered already (ids are model-global); make sure this session's drawing shows it
                try:
                    api("POST", "/api/designtime/nets/%s/transitions" % net_id, {"modelId": MODEL, "sessionId": SESSION, "transitionId": tid, "label": "contains " + tail(m["path"]), "x": tx, "y": ty})
                    api("POST", "/api/designtime/nets/%s/arcs" % net_id, {"modelId": MODEL, "sessionId": SESSION, "arcId": "a-%s-in" % tid, "sourceId": P["spec_catalog"], "targetId": tid})
                    api("POST", "/api/designtime/nets/%s/arcs" % net_id, {"modelId": MODEL, "sessionId": SESSION, "arcId": "a-%s-out" % tid, "sourceId": tid, "targetId": m["placeId"]})
                    linked += 1
                except RuntimeError as e2:
                    if "exists" not in str(e2).lower() and "409" not in str(e2):
                        failed.append("draw link %s: %s" % (tid, str(e2)[:100]))
            else:
                failed.append("link %s: %s" % (m["placeId"], str(e)[:100]))
    specs = [t.get("data") or {} for t in query(P["specs"], "FROM $", 300)]
    for m in mods:
        m["specs"] = [s.get("specId") for s in specs if str(s.get("module", "")).rstrip("/") == m["path"]]
        try:
            replace_token(m["placeId"], "module", m["path"], {"module": m["path"], "files": m["files"], "sample": m["sample"], "specs": m["specs"], "service": SERVICE, "head": head, "at": now()}, name="index-%s" % slug(m["path"]))
        except RuntimeError as e:
            failed.append("index %s: %s" % (m["path"], str(e)[:80]))
    rec = {"at": now(), "service": SERVICE, "head": head, "netId": net_id, "root": P["spec_catalog"], "modules": mods, "created": created, "linked": linked, "failed": failed[:10]}
    put_token(P["spec_catalog"], rec, name="catalog-%s" % stamp())
    keep_last(P["spec_catalog"], "at", 5)
    journal(lane(LANE), "catalog", "spec catalog mirrors %d module(s) of %s (HEAD %s): %d place(s) created, %d link(s), %d failure(s)" % (len(mods), SERVICE, head[:10], created, linked, len(failed)))
    return rec


def catalog_text(cat):
    return "\n".join("- %s (%d files%s)%s" % (m.get("path"), as_int(m.get("files")), (", specs " + ", ".join(as_list(m.get("specs")))) if as_list(m.get("specs")) else "", (": e.g. " + ", ".join(as_list(m.get("sample"))[:3])) if as_list(m.get("sample")) else "") for m in as_list(cat.get("modules"))[:MAX_MODULES])


def design_brief(argv):
    rid = argv[1]
    c = cfg()
    req = by_id(P["requirements"], "requirementId", rid)
    if not req:
        raise RuntimeError("requirement %s not found" % rid)
    cat = catalog([])
    specs = [t.get("data") or {} for t in query(P["specs"], "FROM $", 300)]
    related = [s for s in specs if s.get("module") == req.get("module") or str(req.get("module", "")).startswith(str(s.get("module", "?")))][:8]
    st = latest(P["state"], "at"); ma = as_dict(st.get("analysis"))
    notes = [t.get("data") or {} for t in query(P["arch"], 'FROM $ WHERE $.status == "active"', 40)]
    ospecs = [t.get("data") or {} for t in query(OFFICE["specs"], 'FROM $ WHERE $.level == "product"', 40)]
    spec_id = "spec-%s-%s" % (SERVICE, next_id("s", P["specs"], "seq")[1:]) if False else "spec-%s-%03d" % (SERVICE, count(P["specs"]) + 1)
    sections = ["SERVICE: %s (%s/%s). TEAM GOAL: %s" % (SERVICE, c.get("repo"), c.get("repoDir"), c.get("goal", "")),
                "THE REQUIREMENT %s: %s\nstory: %s\nsummary: %s\nkind %s, module %s, priority %s\nscope: %s\nout of scope: %s\ndone when: %s\nrisks: %s" % (
                    rid, req.get("title"), req.get("story"), req.get("summary"), req.get("kind"), req.get("module"), req.get("priority"), "; ".join(as_list(req.get("scope"))), "; ".join(as_list(req.get("outOfScope"))), "; ".join(as_list(req.get("done"))), "; ".join(as_list(req.get("risks")))),
                "THE SPEC CATALOG (modules mirror the code; put the spec in the closest module or name a new path under it):\n" + catalog_text(cat),
                "THE MODULE STATE: %s\nentry points: %s\ndebt: %s\ntests: %s" % (str(ma.get("summary", ""))[:900], "; ".join(as_list(ma.get("entryPoints"))[:8]), "; ".join(as_list(ma.get("debt"))[:6]), json.dumps(as_dict(ma.get("tests")))[:400])]
    if related:
        sections.append("RELATED SPECS: " + "; ".join("%s [%s] %s: %s" % (s.get("specId"), s.get("status"), s.get("title"), str(s.get("summary", ""))[:200]) for s in related))
    accepted = adrs("accepted")
    if accepted:
        sections.append("ACCEPTED DECISIONS: " + "; ".join("%s %s: %s" % (a.get("adrId"), a.get("title"), str(a.get("decision", ""))[:200]) for a in accepted[:10]))
    if notes:
        sections.append("ARCHITECTURE NOTES: " + "; ".join("%s: %s" % (n.get("title"), str(n.get("text", ""))[:200]) for n in notes[:8]))
    if ospecs:
        sections.append("PRODUCT-LEVEL SPECS: " + "; ".join("%s %s" % (s.get("specId"), s.get("title")) for s in ospecs[:10]))
    o = office_charter()
    sections.append("PRINCIPLES: " + "; ".join(as_list(o.get("principles"))[:8]))
    sections.append("CONSTRAINTS: scope paths %s; test command %s; build command %s; branches only, nothing is pushed; the person merges" % (", ".join(as_list(c.get("scopePaths"))) or "the service directory", c.get("testCommand"), c.get("buildCommand")))
    sections.append("specId: %s\nrequirementId: %s\niterationId: %s" % (spec_id, rid, req.get("iterationId", "")))
    brief = "\n\n".join(sections)
    put_token(P["context"], {"at": now(), "purpose": "design", "service": SERVICE, "specId": spec_id, "requirementId": rid, "iterationId": req.get("iterationId", ""), "brief": brief}, name="ctx-design-%s" % stamp())
    set_status(P["requirements"], "requirementId", rid, "designing", specId=spec_id)
    journal(lane(LANE), "design-brief", "design brief for %s (%s) as %s (%d chars)" % (rid, str(req.get("title"))[:80], spec_id, len(brief)), requirementId=rid, specId=spec_id)
    return {"success": True, "specId": spec_id}


def spec_gate(argv):
    sid = argv[1]
    spec = by_id(P["specs"], "specId", sid)
    if not spec:
        raise RuntimeError("spec %s not found" % sid)
    for t in query(P["spec_drafts"], 'FROM $ WHERE $.specId == "%s" LIMIT 5' % sid, 5):
        delete_token(P["spec_drafts"], t["id"])
    pid = "pr-spec-%s" % sid
    if by_id(P["prompts"], "promptId", pid):
        journal(lane(LANE), "spec-gate", "approval for %s is already open" % sid)
        return {"success": True, "skipped": "open"}
    adr = as_dict(spec.get("adr"))
    if adr and adr.get("title"):
        adr_id = next_id("adr-", P["adr"], "adrId")
        put_token(P["adr"], {"adrId": adr_id, "specId": sid, "title": str(adr.get("title"))[:160], "context": str(adr.get("context", ""))[:800], "decision": str(adr.get("decision", ""))[:800], "consequences": str(adr.get("consequences", ""))[:800], "status": "proposed", "at": now(), "by": "architect"}, name=adr_id)
    summary = "%s\n\nmodule: %s\ndesign: %s\ninterfaces: %s\nfiles: %s\nverify: %s\nrisks: %s" % (spec.get("summary"), spec.get("module"), "; ".join(as_list(spec.get("design"))[:10]), "; ".join(as_list(spec.get("interfaces"))[:8]), ", ".join(as_list(spec.get("files"))[:15]), spec.get("verify"), "; ".join(as_list(spec.get("risks"))[:5]))
    put_token(P["prompts"], {"promptId": pid, "iterationId": spec.get("iterationId", ""), "kind": "spec-approval", "persona": "architect", "service": SERVICE, "specId": sid, "requirementId": spec.get("requirementId"), "mode": "choice",
                             "question": "Approve the spec %s (%s) so QA can write the acceptance criteria?" % (sid, spec.get("title")), "summary": summary[:4000],
                             "options": [{"value": "approved", "label": "Approve the spec", "recommended": True}, {"value": "changes", "label": "Send it back with notes", "recommended": False}, {"value": "rejected", "label": "Reject the spec", "recommended": False}],
                             "rationale": "Every change has a spec before it is implemented; the spec is yours to approve.", "at": now()}, name=pid)
    office_inbox("approval", "%s: approve spec %s (%s)" % (SERVICE, sid, str(spec.get("title"))[:100]), pid, "architect", detail=str(spec.get("summary", ""))[:600])
    put_token(OFFICE["specs"], {"specId": sid, "service": SERVICE, "session": SESSION, "level": "service", "module": spec.get("module"), "title": spec.get("title"), "status": "draft", "requirementId": spec.get("requirementId"), "place": P["specs"], "at": now()}, name="spec-%s" % sid)
    push_status("spec", "spec %s (%s) waits for the person's approval" % (sid, spec.get("title")), specId=sid)
    journal(lane(LANE), "spec-gate", "spec %s (%s, module %s) waits for the person's approval%s" % (sid, str(spec.get("title"))[:80], spec.get("module"), "; decision record proposed" if adr.get("title") else ""), specId=sid, promptId=pid)
    return {"success": True, "promptId": pid}


def spent_today():
    day = now()[:10]
    total = 0.0
    for t in query(P["runs"], "FROM $", 300):
        d = t.get("data") or {}
        if str(d.get("at", ""))[:10] == day:
            total += as_float(d.get("costUsd"), 0.0)
    for t in query(P["state"], "FROM $", 20):
        d = t.get("data") or {}
        if str(d.get("at", ""))[:10] == day:
            total += as_float(d.get("costUsd"), 0.0)
    return round(total, 2)


def pack(argv):
    sid = argv[1]
    c = cfg()
    spec = by_id(P["specs"], "specId", sid)
    if not spec:
        raise RuntimeError("spec %s not found" % sid)
    if str(spec.get("status")) not in ("approved", "implemented", "verified"):
        raise RuntimeError("spec %s is %s; only an approved spec gets a context pack" % (sid, spec.get("status")))
    acc = by_id(P["acceptance"], "specId", sid)
    if not acc:
        raise RuntimeError("no acceptance criteria for %s; QA writes them before the pack" % sid)
    req = by_id(P["requirements"], "requirementId", str(spec.get("requirementId", "")))
    pack_id = "pack-%s-%s" % (sid, stamp())
    branch = "%s/%s" % (SERVICE, sid)
    accepted = adrs("accepted")
    p = {"packId": pack_id, "specId": sid, "requirementId": spec.get("requirementId"), "iterationId": spec.get("iterationId", ""), "service": SERVICE, "branch": branch, "repo": c.get("repo"), "repoDir": c.get("repoDir"), "serviceDir": service_dir(c),
         "title": spec.get("title"), "requirement": {"title": req.get("title"), "story": req.get("story"), "summary": req.get("summary"), "scope": as_list(req.get("scope")), "outOfScope": as_list(req.get("outOfScope")), "done": as_list(req.get("done"))},
         "spec": {k: spec.get(k) for k in ("summary", "module", "design", "interfaces", "data", "files", "constraints", "verify", "risks")},
         "acceptance": {"criteria": as_list(acc.get("criteria")), "tests": as_list(acc.get("tests")), "suites": as_list(acc.get("suites"))},
         "decisions": [{"adrId": a.get("adrId"), "title": a.get("title"), "decision": a.get("decision")} for a in accepted[:10]],
         "constraints": ["only files under %s%s" % (c.get("repoDir"), (" and " + ", ".join(as_list(c.get("scopePaths")))) if as_list(c.get("scopePaths")) else ""), "commit on branch %s; never push; never merge" % branch, "run %s before finishing" % c.get("testCommand"), "no new dependencies without a note", "keep the change inside the spec's files; note any deviation"],
         "commands": {"test": c.get("testCommand"), "build": c.get("buildCommand")}, "coder": c.get("coderAgent") or "claude-code", "model": c.get("coderModel", ""), "at": now(), "status": "assembled"}
    put_token(P["briefs"], p, name=pack_id)
    # the policy gate
    level = autonomy(c)
    kind = str(req.get("kind", "feature"))
    budget = as_float(c.get("dailyBudgetUsd"), 20.0); spent = spent_today()
    if spent >= budget:
        put_token(P["refused"], {"at": now(), "packId": pack_id, "specId": sid, "reason": "daily budget spent (%.2f of %.2f USD)" % (spent, budget)}, name="refused-%s" % pack_id)
        office_inbox("budget", "%s: budget spent, %s waits" % (SERVICE, sid), pack_id, "architect", detail="%.2f of %.2f USD spent today; the pack waits for tomorrow or a higher budget" % (spent, budget))
        journal(lane(LANE), "pack", "pack %s assembled but refused by the gate: budget %.2f/%.2f" % (pack_id, spent, budget), specId=sid)
        return {"success": True, "refused": "budget"}
    if kind in AUTONOMY_ALONE.get(level, []):
        put_token(P["decisions"], {"kind": "pack-approval", "verdict": "approved", "specId": sid, "packId": pack_id, "by": "gate", "notes": "autonomy level %d allows %s changes without approval" % (level, kind), "at": now()}, name="dec-pack-%s" % pack_id)
        journal(lane(LANE), "pack", "pack %s approved by the gate (autonomy %d, kind %s); the coder starts" % (pack_id, level, kind), specId=sid)
        return {"success": True, "approved": "gate"}
    pid = "pr-pack-%s" % sid
    for t in query(P["prompts"], 'FROM $ WHERE $.promptId == "%s" LIMIT 5' % pid, 5):
        delete_token(P["prompts"], t["id"])
    put_token(P["prompts"], {"promptId": pid, "iterationId": spec.get("iterationId", ""), "kind": "pack-approval", "persona": "architect", "service": SERVICE, "specId": sid, "packId": pack_id, "mode": "choice",
                             "question": "Start the coder on %s (%s) with this context pack on branch %s?" % (sid, spec.get("title"), branch),
                             "summary": ("files: %s\nacceptance: %d criteria, %d tests\ncoder: %s %s\nbudget today: %.2f of %.2f USD" % (", ".join(as_list(spec.get("files"))[:15]), len(as_list(acc.get("criteria"))), len(as_list(acc.get("tests"))), p["coder"], p["model"], spent, budget))[:3000],
                             "options": [{"value": "approved", "label": "Start the coder", "recommended": True}, {"value": "rejected", "label": "Do not implement now", "recommended": False}],
                             "rationale": "The coder gets only this pack: requirement, spec, acceptance criteria, decisions and constraints.", "at": now()}, name=pid)
    office_inbox("approval", "%s: start the coder on %s (%s)" % (SERVICE, sid, str(spec.get("title"))[:100]), pid, "architect", detail="branch %s; %d files in the spec" % (branch, len(as_list(spec.get("files")))))
    journal(lane(LANE), "pack", "context pack %s assembled (%d criteria); waits for the person's approval" % (pack_id, len(as_list(acc.get("criteria")))), specId=sid, promptId=pid)
    return {"success": True, "promptId": pid, "packId": pack_id}


def main(argv):
    cmd = argv[0] if argv else ""
    if cmd == "design-brief":
        return design_brief(argv)
    if cmd == "catalog":
        return catalog(argv)
    if cmd == "spec-gate":
        return spec_gate(argv)
    if cmd == "pack":
        return pack(argv)
    raise RuntimeError("usage: team-arch.py design-brief <requirementId>|catalog [force]|spec-gate <specId>|pack <specId>")


if __name__ == "__main__":
    sys.exit(main_guard(lane(LANE), main, sys.argv[1:]))
