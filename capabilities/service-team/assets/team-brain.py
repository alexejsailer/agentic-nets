#!/usr/bin/env python3
"""team-brain: the service team's brain (t-team-brain-observe-cmd, t-team-curate-cmd, t-team-brain-apply-cmd).

usage: team-brain.py observe <runId> | curate <signalId> | apply <curationId>

observe  after a merge: the requirement, the spec, what QA measured, what the reviewer said and what the coder reported become one signal
         and the curation brief for the one-shot curator (t-team-curate)
curate   turns the curator's answer into the curation record (facts with source and confidence, plan, decisions, questions, ideas)
apply    applies the curation: knowledge, plan, decision proposals, questions for the person, ideas; reports the release to the product
         office and starts the next iteration when nothing waits for the person
"""
import os, sys, json, re, time

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
          "brain-cmd", "brain-log", "signals", "curation", "curations", "knowledge", "plan", "ideas", "status"]
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


def repo_root(c=None):
    """The team's own clone of the workspace repository that holds the service (never the person's working tree)."""
    c = c or cfg()
    return os.path.join(team_home(c), str(c.get("repo") or "core"))


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


LANE = lane("brain-observe-cmd")
KINDS = ("platform", "convention", "decision", "gap", "risk", "question", "answer")
MAX_ACTIVE = 80


def active_facts():
    facts = [t.get("data") or {} for t in query(P["knowledge"], 'FROM $ WHERE $.status == "active"', 300)]
    facts.sort(key=lambda f: str(f.get("factId", "")))
    return facts


def knowledge_text(limit=60):
    rows = active_facts()
    if not rows:
        return "- (no facts yet)"
    return "\n".join("- [%s|%s|%s] %s (source %s)" % (f.get("factId"), f.get("kind"), f.get("confidence", "?"), str(f.get("text", ""))[:260], f.get("source", "?")) for f in rows[:limit])


def plan_text():
    p = latest(P["plan"], "at")
    if not p:
        return "- (no plan yet)"
    lines = []
    for inc in as_list(p.get("increments")):
        inc = as_dict(inc) if not isinstance(inc, dict) else inc
        dep = (", after " + ", ".join(as_list(inc.get("dependsOn")))) if as_list(inc.get("dependsOn")) else ""
        lines.append("- %s [%s|%s] %s%s%s" % (inc.get("id", "?"), inc.get("kind", "?"), inc.get("status", "?"), str(inc.get("title", ""))[:120], dep, (" (spec %s)" % inc.get("specId")) if inc.get("specId") else ""))
    return "\n".join(lines) or "- (empty plan)"


def signal_for(run_id):
    if run_id in ("latest", "") or run_id.startswith("${"):
        runs = [t.get("data") or {} for t in query(P["runs"], 'FROM $ WHERE $.status == "merged"', 100)]
        runs.sort(key=lambda r: str(r.get("mergedAt") or r.get("at", "")), reverse=True)
        if not runs:
            raise RuntimeError("no merged run to observe")
        r = runs[0]
    else:
        r = one(P["runs"], 'FROM $ WHERE $.runId == "%s" LIMIT 1' % run_id)
        if not r:
            raise RuntimeError("run %s not found" % run_id)
    s = one(P["specs"], 'FROM $ WHERE $.specId == "%s" LIMIT 1' % r.get("specId", ""))
    req = one(P["requirements"], 'FROM $ WHERE $.requirementId == "%s" LIMIT 1' % (s.get("requirementId") or r.get("requirementId") or ""))
    ver = latest(P["verification"], "at", 'FROM $ WHERE $.runId == "%s"' % r["runId"])
    rev = latest(P["reviews"], "at", 'FROM $ WHERE $.runId == "%s"' % r["runId"])
    acc = one(P["acceptance"], 'FROM $ WHERE $.specId == "%s" LIMIT 1' % r.get("specId", ""))
    return {
        "signalId": "sig-%s" % r["runId"], "runId": r["runId"], "specId": r.get("specId", ""), "requirementId": s.get("requirementId", ""), "title": s.get("title", r.get("title", "")), "kind": req.get("kind", ""), "at": now(),
        "branch": r.get("branch", ""), "mergeSha": r.get("mergeSha", ""), "status": r.get("status"), "service": SERVICE,
        "coderSummary": str(as_dict(r.get("summary")).get("summary", r.get("summary", "")))[:1500], "coderNotes": str(as_dict(r.get("summary")).get("notes", ""))[:2500], "coderAgent": r.get("coder", ""), "coderModel": r.get("model", ""),
        "filesChanged": as_list(r.get("filesChanged"))[:40], "diffStat": r.get("diffStat", ""), "durationSec": r.get("durationSec", ""), "costUsd": r.get("costUsd", ""),
        "verification": {"verdict": ver.get("verdict"), "summary": str(ver.get("summary", ""))[:600], "suites": as_dict(ver.get("suites")), "criteria": as_list(ver.get("criteria"))[:12], "outOfScope": as_list(as_dict(ver.get("diff")).get("outOfScope"))[:10]},
        "review": {"verdict": rev.get("verdict"), "summary": str(rev.get("summary", ""))[:600], "points": as_list(rev.get("points"))[:8]},
        "requirement": {"story": str(req.get("story", ""))[:400], "done": as_list(req.get("done"))[:8]},
        "specSummary": str(s.get("summary", ""))[:600], "specModule": s.get("module", ""), "specVerify": str(s.get("verify", ""))[:300], "specFiles": as_list(s.get("files"))[:20], "specRisks": as_list(s.get("risks"))[:6],
        "acceptance": [{"id": a.get("id"), "then": str(a.get("then", ""))[:160]} for a in [x if isinstance(x, dict) else as_dict(x) for x in as_list(acc.get("criteria"))][:8]],
    }


def curation_brief(sig, m):
    c = cfg(); o = office_charter()
    ma = as_dict(m.get("analysis")); mm = as_dict(m.get("measured"))
    lines = [
        "# BRIEF FOR THE %s TEAM'S BRAIN: curate what the team knows after %s" % (SERVICE.upper(), sig.get("specId")),
        "signalId: %s\nrunId: %s\ncurationId to use: cur-%s\nnow: %s" % (sig["signalId"], sig["runId"], sig["runId"], now()),
        "## TEAM GOAL\n%s\n%s\n\n## PRODUCT GOAL AND PRINCIPLES\n%s\n%s" % (c.get("goal", ""), str(c.get("description", ""))[:1200], o.get("goal", ""), "\n".join("- " + p for p in as_list(o.get("principles")))),
        "## WHAT WAS MERGED: %s (%s, kind %s) on branch %s, merge %s\nrequirement story: %s\ndone conditions: %s\nspec summary: %s\nmodule: %s\nfiles per spec: %s\nfiles changed: %s\ndiff: %s\nrisks: %s\nverify condition: %s" % (
            sig.get("specId"), sig.get("title"), sig.get("kind"), sig.get("branch"), str(sig.get("mergeSha", ""))[:10], as_dict(sig.get("requirement")).get("story"), "; ".join(as_list(as_dict(sig.get("requirement")).get("done"))),
            sig.get("specSummary"), sig.get("specModule"), ", ".join(sig.get("specFiles", [])), ", ".join(sig.get("filesChanged", [])[:25]), sig.get("diffStat"), "; ".join(sig.get("specRisks", [])), sig.get("specVerify")),
        "## WHAT THE CODER REPORTED (%s / %s, %s s, cost %s)\nsummary: %s\nnotes: %s" % (sig.get("coderAgent"), sig.get("coderModel"), sig.get("durationSec"), sig.get("costUsd"), sig.get("coderSummary"), sig.get("coderNotes")),
        "## WHAT QA MEASURED\n%s\n\n## WHAT THE REVIEWER SAID\n%s\n\n## ACCEPTANCE CRITERIA\n%s" % (json.dumps(sig.get("verification")), json.dumps(sig.get("review")), json.dumps(sig.get("acceptance"))),
        "## THE MODULE STATE (measured)\n%s\nfiles %s, tests %s; debt: %s" % (str(ma.get("summary", ""))[:800], mm.get("files"), mm.get("tests"), "; ".join(as_list(ma.get("debt"))[:6])),
        "## CURRENT KNOWLEDGE (active facts; retire what is now wrong or subsumed, never retire an answer)\n" + knowledge_text(),
        "## CURRENT PLAN\n" + plan_text(),
        "## DECISIONS ON RECORD\n" + ("\n".join("- %s [%s] %s: %s" % (a.get("adrId"), a.get("status"), a.get("title"), str(a.get("decision", ""))[:160]) for a in adrs()) or "- none"),
    ]
    return "\n\n".join(lines)[:16000]


def observe(argv):
    c = charter()
    sig = signal_for(argv[1] if len(argv) > 1 else "latest")
    sig["startIteration"] = "true" if (envv("START_ITERATION") == "true" or (len(argv) > 2 and argv[2] == "next")) else "false"
    m = latest(P["state"], "at")
    for t in query(P["signals"], 'FROM $ WHERE $.signalId == "%s" LIMIT 5' % sig["signalId"], 5):
        delete_token(P["signals"], t["id"])
    put_token(P["signals"], sig, name=sig["signalId"])
    keep_last(P["signals"], "at", 20)
    brief = curation_brief(sig, m)
    brain_agent = str(c.get("brainAgent") or "llm")
    if brain_agent == "llm":
        put_token(P["context"], {"at": now(), "purpose": "curate", "signalId": sig["signalId"], "runId": sig["runId"], "curationId": "cur-%s" % sig["runId"], "brief": brief}, name="ctx-curate-%s" % sig["runId"])
        route = "one-shot lane"
    else:
        put_token(P["brain_cmd"], command_token("team-brain", ["curate", sig["signalId"]], stage="curate", timeout_ms=1800000, signalId=sig["signalId"], runId=sig["runId"]), name="curate-%s" % sig["runId"])
        route = "headless %s" % brain_agent
    journal(LANE, "observe", "signals of %s (%s) collected; curation routed to the %s" % (sig["specId"], sig["runId"], route), runId=sig["runId"])
    return {"success": True, "signalId": sig["signalId"], "route": route, "briefChars": len(brief)}


CONTRACT = ('Reply with exactly this shape and nothing else: {"curationId": "<from the brief>", "runId": "<from the brief>", '
            '"addFacts": [{"kind": "platform|convention|decision|gap|risk|question", "scope": "project|platform", "text": "<one specific, checkable sentence>", '
            '"source": "<runId, specId, lane id or file>", "confidence": "high|medium|low"}], "retireFacts": ["<factId>"], '
            '"plan": {"increments": [{"id": "inc-1", "title": "<one line>", "kind": "<spec kind>", "status": "planned|in-progress|released|dropped", "dependsOn": ["inc-0"], "specId": "<specId or empty>"}]}, '
            '"proposedDecisions": [{"title": "<short>", "context": "<why it came up>", "decision": "<what was decided>", "consequences": "<what it constrains>"}], '
            '"questions": [{"question": "<what only the person can answer>", "why": "<what depends on it>"}], '
            '"ideas": [{"text": "<a net, a lane, a tool net or a script this model could gain to serve the goal, one sentence with the evidence>"}], "summary": "<three sentences>"}')

RULES = ("Rules: facts must be specific and sourced from the brief (a lane id, a place id, a measured number, a file); prefer few good facts over many; "
         "mark as platform what is true for the runtime and reusable elsewhere, as project what is about this model; propose a decision for every choice the coder "
         "made that constrains future changes; keep the plan as the remaining increments toward the goal in dependency order, marking what is released; "
         "ask a question only when the next increment genuinely depends on the answer.")


def curate_headless(argv):
    if len(argv) < 2:
        raise RuntimeError("usage: curate <signalId>")
    c = charter()
    rp = repo()
    sig = one(P["signals"], 'FROM $ WHERE $.signalId == "%s" LIMIT 1' % argv[1])
    if not sig:
        raise RuntimeError("signal %s not found" % argv[1])
    m = latest(P["state"], "at")
    prompt = "\n\n".join([
        "You are the team's brain, curating what the model knows after one released change. You may read the pack repository in the current directory to verify anything in the brief. Do not change any file.",
        curation_brief(sig, m), RULES, CONTRACT])
    agent = resolve_agent(c, "brainAgent", "brainModel")
    res = run_headless(prompt, str(rp.get("localPath") or team_home(c)), c, agent)
    blob = (res["summary"].get("summary", "") if isinstance(res.get("summary"), dict) else "") or res.get("raw", "") or res.get("stderr", "")
    m_json = None
    for cand in re.findall(r"\{[\s\S]*\}", blob):
        try:
            m_json = json.loads(cand)
        except ValueError:
            continue
    if not isinstance(m_json, dict) or "addFacts" not in m_json:
        raise RuntimeError("the headless curator did not answer the contract: %s" % blob[-400:])
    m_json.setdefault("curationId", "cur-%s" % sig["runId"]); m_json.setdefault("runId", sig["runId"])
    m_json["brainAgent"] = agent["agentId"]; m_json["brainModel"] = agent["model"]
    put_token(P["curations"], dict(m_json), name="curation-%s" % sig["runId"])
    put_token(P["curation"], m_json, name="curation-%s" % sig["runId"])
    journal("t-team-curate-cmd", "curate", "headless curation by %s/%s for %s: %d facts, %d retired, %d decisions, %d questions (%ss)" % (
        agent["agentId"], agent["model"], sig["runId"], len(as_list(m_json.get("addFacts"))), len(as_list(m_json.get("retireFacts"))), len(as_list(m_json.get("proposedDecisions"))), len(as_list(m_json.get("questions"))), res["durationSec"]), runId=sig["runId"])
    return {"success": True, "curationId": m_json["curationId"], "facts": len(as_list(m_json.get("addFacts"))), "durationSec": res["durationSec"]}


def next_id(prefix, place, key):
    ids = [str((t.get("data") or {}).get(key, "")) for t in query(place, "FROM $", 500)]
    nums = [int(x.split("-")[-1]) for x in ids if x.startswith(prefix) and x.split("-")[-1].isdigit()]
    return "%s%03d" % (prefix, (max(nums) + 1) if nums else 1)


def norm(text):
    return re.sub(r"[^a-z0-9]+", " ", str(text).lower()).strip()


def apply(argv):
    curation_id = argv[1] if len(argv) > 1 and not argv[1].startswith("${") else envv("CURATION_ID", "cur-unknown")
    cur = one(P["curations"], 'FROM $ WHERE $.curationId == "%s" LIMIT 1' % curation_id)
    if not cur:
        raise RuntimeError("curation %s not found in the archive" % curation_id)
    run_id = str(cur.get("runId") or envv("RUN_ID"))
    add = [f if isinstance(f, dict) else as_dict(f) for f in as_list(cur.get("addFacts"))]
    retire = as_list(cur.get("retireFacts"))
    plan = cur.get("plan") if isinstance(cur.get("plan"), dict) else as_dict(cur.get("plan"))
    decisions = [d if isinstance(d, dict) else as_dict(d) for d in as_list(cur.get("proposedDecisions"))]
    questions = [q if isinstance(q, dict) else as_dict(q) for q in as_list(cur.get("questions"))]
    idea_rows = [i if isinstance(i, dict) else as_dict(i) for i in as_list(cur.get("ideas"))]
    summary = str(cur.get("summary", ""))
    existing_norm = {norm(f.get("text")): f for f in active_facts()}
    added, skipped, retired, skipped_why = [], 0, 0, []
    for fid in retire:
        for t in query(P["knowledge"], 'FROM $ WHERE $.factId == "%s" AND $.status == "active" LIMIT 1' % fid, 1):
            d = t.get("data") or {}
            if d.get("kind") == "answer":
                continue
            d["status"] = "retired"; d["retiredAt"] = now(); d["retiredBy"] = curation_id
            delete_token(P["knowledge"], t["id"]); put_token(P["knowledge"], d, name="%s-retired" % fid); retired += 1
    KIND_ALIASES = {"project": "convention", "platform-fact": "platform", "architecture": "decision", "design": "decision", "config": "convention", "configuration": "convention", "pattern": "convention",
                    "stack": "platform", "tooling": "platform", "library": "platform", "todo": "gap", "missing": "gap", "debt": "gap", "issue": "risk", "warning": "risk", "open": "question", "unknown": "question", "fact": "convention", "knowledge": "convention"}
    for f in add:
        text = str(f.get("text", "")).strip()
        kind = KIND_ALIASES.get(str(f.get("kind", "gap")).strip().lower(), str(f.get("kind", "gap")).strip().lower())
        if not text:
            skipped += 1; skipped_why.append("empty"); continue
        if kind not in KINDS:
            kind = "convention"
        if norm(text) in existing_norm:
            skipped += 1; skipped_why.append("duplicate"); continue
        fid = next_id("k-", P["knowledge"], "factId")
        data = {"factId": fid, "kind": kind, "scope": "platform" if str(f.get("scope", "")).lower() == "platform" else "project", "text": text[:600], "source": str(f.get("source", run_id or curation_id))[:120],
                "confidence": str(f.get("confidence", "medium")).lower(), "status": "active", "at": now(), "curationId": curation_id}
        put_token(P["knowledge"], data, name=fid); existing_norm[norm(text)] = data; added.append(fid)
    active = active_facts()
    if len(active) > MAX_ACTIVE:
        victims = sorted([f for f in active if f.get("kind") != "answer"], key=lambda f: ({"low": 0, "medium": 1, "high": 2}.get(f.get("confidence"), 1), str(f.get("at", ""))))[: len(active) - MAX_ACTIVE]
        for v in victims:
            for t in query(P["knowledge"], 'FROM $ WHERE $.factId == "%s" AND $.status == "active" LIMIT 1' % v["factId"], 1):
                d = t.get("data") or {}; d["status"] = "retired"; d["retiredAt"] = now(); d["retiredBy"] = "budget"
                delete_token(P["knowledge"], t["id"]); put_token(P["knowledge"], d, name="%s-retired" % v["factId"]); retired += 1
    incs = [i if isinstance(i, dict) else as_dict(i) for i in as_list((plan or {}).get("increments"))]
    if incs:
        for t in query(P["plan"], "FROM $", 50):
            delete_token(P["plan"], t["id"])
        put_token(P["plan"], {"at": now(), "curationId": curation_id, "runId": run_id, "increments": incs[:30], "summary": summary[:600]}, name="plan-%s" % curation_id)
    known = {norm(a.get("title")) for a in adrs()}
    proposed = 0
    for d in decisions:
        title = str(d.get("title", "")).strip()
        if not title or norm(title) in known:
            continue
        adr_id = next_id("adr-", P["adr"], "adrId")
        put_token(P["adr"], {"adrId": adr_id, "title": title[:160], "context": str(d.get("context", ""))[:800], "decision": str(d.get("decision", ""))[:800], "consequences": str(d.get("consequences", ""))[:600],
                             "status": "proposed", "updatedAt": now(), "source": curation_id, "proposedBy": "team"}, name=adr_id)
        known.add(norm(title)); proposed += 1
    asked = 0
    already = {norm(p.get("question", "")) for p in [t.get("data") or {} for t in query(P["prompts"], 'FROM $ WHERE $.kind == "brain"', 200)]}
    for n, qn in enumerate(questions[:3], 1):
        question = str(qn.get("question", "")).strip()
        if not question or norm(question) in already:
            continue
        pid = "pr-brain-%s-%d" % (curation_id, n)
        put_token(P["prompts"], {"promptId": pid, "iterationId": "brain-%s" % curation_id, "kind": "brain", "mode": "interview", "question": question, "context": str(qn.get("why", ""))[:400],
                                 "options": [{"value": "q1", "label": question, "description": str(qn.get("why", ""))[:300]}], "allowFreeText": True, "rationale": "asked by the brain after %s" % run_id, "at": now()}, name=pid)
        office_inbox("question", "%s: %s" % (SERVICE, str(qn.get("question", ""))[:160]), pid, "brain", detail="the team's brain asks after " + curation_id)
        asked += 1
    ideas_added = 0
    known_ideas = {norm(i.get("text", "")) for i in [t.get("data") or {} for t in query(P["ideas"], "FROM $", 300)]}
    for i in idea_rows[:5]:
        text = str(i.get("text", "")).strip()
        if not text or norm(text) in known_ideas:
            continue
        iid = next_id("idea-", P["ideas"], "ideaId")
        put_token(P["ideas"], {"ideaId": iid, "text": text[:600], "by": "brain", "status": "open", "at": now(), "source": curation_id}, name=iid)
        known_ideas.add(norm(text)); ideas_added += 1
    started = ""
    sig = one(P["signals"], 'FROM $ WHERE $.runId == "%s" LIMIT 1' % run_id) if run_id else {}
    if str(sig.get("startIteration", "")).lower() == "true" and not sig.get("iterationStarted"):
        started = "it-%s" % stamp()
        put_token(P["iterate"], {"at": now(), "iterationId": started, "reason": "released", "specId": sig.get("specId", ""), "requestedBy": "team"}, name=started)
        for t in query(P["signals"], 'FROM $ WHERE $.runId == "%s" LIMIT 5' % run_id, 5):
            d = t.get("data") or {}; d["iterationStarted"] = started
            delete_token(P["signals"], t["id"]); put_token(P["signals"], d, name="%s-done" % d.get("signalId", run_id))
    journal("t-team-brain-apply-cmd", "apply", "curation %s applied: +%d facts (%d skipped: %s), %d retired, plan %s, %d decisions proposed, %d questions, %d ideas%s; %s" % (
        curation_id, len(added), skipped, ",".join(sorted(set(skipped_why))) or "-", retired, "replaced" if incs else "unchanged", proposed, asked, ideas_added, ("; next iteration %s started" % started) if started else "", summary[:160]), runId=run_id, curationId=curation_id)
    return {"success": True, "added": added, "skipped": skipped, "retired": retired, "planIncrements": len(incs), "proposedDecisions": proposed, "questions": asked, "nextIteration": started}


def answer(argv):
    prompt_id = argv[1] if len(argv) > 1 and not argv[1].startswith("${") else envv("PROMPT_ID")
    text = envv("ANSWER_TEXT")
    pr = one(P["prompts"], 'FROM $ WHERE $.promptId == "%s" LIMIT 1' % prompt_id)
    if not text:
        raise RuntimeError("empty answer for %s" % prompt_id)
    fid = next_id("k-", P["knowledge"], "factId")
    put_token(P["knowledge"], {"factId": fid, "kind": "answer", "scope": "project", "text": ("Q: %s A: %s" % (str(pr.get("question", ""))[:200], text))[:600], "source": prompt_id, "confidence": "high", "status": "active", "at": now(), "curationId": ""}, name=fid)
    journal("t-team-brain-apply-cmd", "answer", "the person answered %s; recorded as %s" % (prompt_id, fid), promptId=prompt_id)
    return {"success": True, "factId": fid}


def main(argv):
    if not argv:
        raise RuntimeError("usage: team-brain.py observe|curate|apply|answer ...")
    if argv[0] == "observe":
        return observe(argv)
    if argv[0] == "curate":
        return curate_headless(argv)
    if argv[0] == "apply":
        return apply(argv)
    if argv[0] == "answer":
        return answer(argv)
    raise RuntimeError("unknown command %s" % argv[0])


if __name__ == "__main__":
    sys.exit(main_guard(LANE, main, sys.argv[1:]))
