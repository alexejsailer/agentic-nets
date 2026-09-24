#!/usr/bin/env python3
"""steward-apply: an approved change spec, applied by the configured headless coder inside the pack
repository on a branch. The coder edits sources only; the pipeline inlines, builds, packages, bumps
the version, commits and queues verification. The coder never sees the runtime's MCP token.

usage: steward-apply.py apply <specId>
"""
import glob
import json
import os
import re
import shutil
import sys

# >>> shared: stewardlib (generated, do not edit here)
"""Shared library for the Steward scripts. Inlined into every steward-*.py by
tools/inline-shared.py (the executor runs each script as ONE file). Edit here, then re-inline.

The Steward is a persona whose job is the model it lives in. Every lane measures through master
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
MODEL = os.environ.get("MODEL_ID", "steward")
SERVICE_TOKEN = os.environ.get("AGENTICOS_SERVICE_TOKEN", "").strip()
STEWARD_HOME = os.path.expanduser(os.environ.get("STEWARD_HOME", "~/steward"))
PACK_NAME = "steward"

P = {
    "charter": "p-steward-charter",
    "coders": "p-steward-coders",
    "infra": "p-steward-infra",
    "setup_cmd": "p-steward-setup-cmd",
    "setup_log": "p-steward-setup-log",
    "repo": "p-steward-repo",
    "journal": "p-steward-journal",
    "errors": "p-steward-errors",
    "llm_errors": "p-steward-llm-errors",
    "observe_cmd": "p-steward-observe-cmd",
    "observe_log": "p-steward-observe-log",
    "health": "p-steward-health",
    "lanes": "p-steward-lanes",
    "map": "p-steward-map",
    "budget": "p-steward-budget",
    "iterate": "p-steward-iterate",
    "context_cmd": "p-steward-context-cmd",
    "loop_log": "p-steward-loop-log",
    "context": "p-steward-context",
    "prompts": "p-steward-prompts",
    "responses": "p-steward-responses",
    "specs": "p-steward-specs",
    "spec_drafts": "p-steward-spec-drafts",
    "gate_cmd": "p-steward-gate-cmd",
    "refused": "p-steward-refused",
    "decisions": "p-steward-decisions",
    "apply_cmd": "p-steward-apply-cmd",
    "runs": "p-steward-runs",
    "verify_cmd": "p-steward-verify-cmd",
    "verification": "p-steward-verification",
    "release_cmd": "p-steward-release-cmd",
    "build_log": "p-steward-build-log",
    "brain_cmd": "p-steward-brain-cmd",
    "brain_log": "p-steward-brain-log",
    "signals": "p-steward-signals",
    "curation": "p-steward-curation",
    "curations": "p-steward-curations",
    "knowledge": "p-steward-knowledge",
    "plan": "p-steward-plan",
    "adr": "p-steward-adr",
    "ideas": "p-steward-ideas",
    "candidates": "p-steward-candidates",
}

# The governor: the Steward improves every net except the ones that govern it. Any spec that
# reads, writes, removes or re-inscribes one of these is refused by the gate and, if it reaches
# the coder anyway, by verify.
PROTECTED_PLACES = [P["charter"], P["coders"], P["prompts"], P["responses"], P["decisions"], P["refused"], P["budget"]]
PROTECTED_LANES = ["t-steward-observe-cron", "t-steward-observe-cmd", "t-steward-iterate-prep", "t-steward-context-cmd", "t-steward-propose",
                   "t-steward-answer-prep", "t-steward-revise-prep", "t-steward-spec", "t-steward-gate-prep", "t-steward-gate-cmd",
                   "t-steward-approve-prep", "t-steward-apply-cmd", "t-steward-verify-cmd", "t-steward-release-cmd", "t-steward-rollback-prep",
                   "t-steward-infra-tick", "t-steward-setup-cmd"]
# The closed grammar of change specs; anything else is refused. `charter` is never a spec kind.
SPEC_KINDS = ["tune", "view", "crystallise", "add-lane", "remove-lane", "add-net", "add-script", "tool-net", "app"]
# Which kinds an autonomy level applies WITHOUT a person's approval (levels 1 and 2 apply nothing).
AUTONOMY_ALONE = {1: [], 2: [], 3: [], 4: ["tune", "view"], 5: ["tune", "view", "crystallise"]}
# The application manifest must keep these, whatever the coder does to the rest of it.
REQUIRED_APP_STORES = ["charter", "coders", "prompts", "responses", "specs", "decisions", "runs", "health", "journal"]
REQUIRED_APP_ACTIONS = ["set-charter", "respond", "approve-spec", "reject-spec", "rollback", "pause", "resume"]


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
    return latest(P["charter"], "updatedAt", 'FROM $ WHERE $.charterId == "steward"') or latest(P["charter"], "updatedAt")


def goal_defined(c=None):
    c = c or charter()
    title = str(c.get("goal", "") or c.get("title", ""))
    return bool(title.strip()) and "REPLACE" not in title.upper()


def autonomy(c=None):
    return max(1, min(5, as_int((c or charter()).get("autonomyLevel"), 3)))


def scope_nets(c=None):
    """Nets the Steward may touch: the charter's list, or the pack's own nets when the list is empty."""
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
    """The pack's lanes as the runtime knows them: (transitionId, status) for every t-steward-* lane."""
    listed = mcp("list_transitions", {})
    rows = as_list(listed.get("transitions")) if isinstance(listed, dict) else as_list(listed)
    out = []
    for t in rows:
        t = as_dict(t) if not isinstance(t, dict) else t
        tid = str(t.get("transitionId") or t.get("id") or "")
        if tid.startswith("t-steward-"):
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


def steward_home(c=None):
    home = os.path.expanduser(str((c or {}).get("home") or STEWARD_HOME))
    os.makedirs(home, exist_ok=True)
    return home


def pack_dir(c=None):
    """The pack's compact sources inside the repository checkout: <repo>/<packDir>."""
    c = c or charter()
    rp = repo()
    root = str(rp.get("localPath") or os.path.join(steward_home(c), "agentic-nets"))
    return os.path.join(root, str(c.get("packDir") or "capabilities/steward")), root


def git(args, cwd, timeout=300, check=True):
    cmd = ["git", "-c", "user.name=Steward", "-c", "user.email=steward@localhost"] + list(args)
    return run(cmd, cwd=cwd, timeout=timeout, check=check)


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
        "args": {"toolId": tool_id, "argv": [str(a) for a in argv], "env": {"MODEL_ID": MODEL}, "timeoutMs": timeout_ms},
        "filedAt": now(),
    }
    if stage:
        tok["stage"] = stage
    tok.update(extra)
    return tok


# ---------------------------------------------------------------- the runtime's own MCP
def mcp_url(c=None):
    return str((c or charter()).get("mcpUrl") or os.environ.get("STEWARD_MCP_URL") or "http://127.0.0.1:8091/mcp").rstrip("/")


def mcp_token():
    """From the vault-injected environment first; on a Desktop the app's own token file is the fallback."""
    t = os.environ.get("STEWARD_MCP_TOKEN", "").strip()
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
        raise RuntimeError("no MCP token: provision the Steward (setup) or set STEWARD_MCP_TOKEN")
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


def resolve_agent(cfg, agent_key="coderAgent", model_key="coderModel"):
    """A headless agent: a definition token from p-steward-coders chosen by cfg[agent_key], with
    charter overrides for model, tools, turns and timeout. Falls back to the built-in Claude Code."""
    defs = {}
    for t in query(P["coders"], "FROM $", 20):
        d = t.get("data") or {}
        if d.get("agentId"):
            defs[d["agentId"]] = d
    agent_id = str(cfg.get(agent_key) or "claude-code")
    a = defs.get(agent_id) or (BUILTIN_CLAUDE if agent_id == "claude-code" else None)
    if not a:
        raise RuntimeError("agent '%s' is not defined in p-steward-coders (known: %s)" % (agent_id, ", ".join(sorted(defs)) or "none"))
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


def run_headless(prompt, root, cfg, agent, result_key="STEWARD_RESULT"):
    env = {k: v for k, v in os.environ.items() if k not in ("CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT")}
    env["STEWARD_MCP_TOKEN"] = ""  # the coder never sees the runtime's token; it gets its own MCP client if configured
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
# <<< shared: stewardlib

LANE = "t-steward-apply-cmd"

CONVENTIONS = """## PACK CONVENTIONS (the coder must keep them or the build fails)
- Compact net sources live in nets/<net>.net.json: {"net", "model", "session", "description", "places": {id: label}, "transitions": [...]}.
  A transition: {"id", "kind": "map|http|agent|command", "label", "reads": {alias: {"place", "arcql", "consume"?, "optional"?, "ttl"?}}, "writes": {alias: place | {"place", "retain"}},
  and per kind: map -> "template" (a token; ${alias.data.field} and ${now()} interpolate), agent -> "agent" {"role", "tier", "maxIterations", "oneShot", "autoEmit", "allowedTools", "answerSchema", "nl"},
  command -> "command" {"timeoutMs"} and a template that is a command token {"kind":"command","executor":"script","command":"invoke","args":{"toolId","argv","env":{"MODEL_ID":"steward"},"timeoutMs"}},
  "emit": [{"from": "@response|@result", "to": alias, "when": "<field == 'x'>"}], optional "schedule": {"type":"cron","cron":"<6 fields>","timezone":"Europe/Berlin"}.
- Emit rules must form a complete partition: a rule without `when` fires on EVERY fire (fan-out); an else is the complement (`a != 'x' AND a != 'y'`); an unmatched token strands head-of-line.
- A one-shot agent lane needs "oneShot": true, "autoEmit": true and an answerSchema whose required fields can never be empty; its reply IS the answer; misses must route to an errors place.
- Arrays do not survive a map template into args.env: pass ids, let the script read the token.
- Scripts live in assets/<name>.py, python3, one file each; the shared library is inlined between the markers
  `# >>> shared: stewardlib (generated, do not edit here)` and `# <<< shared: stewardlib`: never edit between the markers, edit assets/stewardlib.py instead.
  Register a new script in assets/index.json and capability.yaml; invoke it from a command lane by toolId.
- Seeds live in seeds/<place>.json (a list of tokens); the charter seed is protected.
- The application is app/agenticos.app.json (stores over places, actions that write tokens, permissions) and app/ui/main.mjs (one vanilla web component, no imports).
- Build: `node capabilities/tools/pack.mjs build --dir capabilities/steward` compiles nets to .pnml.json and .inscriptions.json; run it until it succeeds. `python3 -m py_compile assets/<script>.py` for every script you touched.
- Do NOT bump versions, do NOT commit, do NOT touch the protected set, do NOT run the installer; the pipeline does all of that after you."""


def spec_by_id(spec_id):
    s = one(P["specs"], 'FROM $ WHERE $.specId == "%s" LIMIT 1' % spec_id)
    if not s:
        raise RuntimeError("spec %s not found" % spec_id)
    return s


def render_spec(s):
    def block(title, items):
        items = as_list(items)
        return "\n### %s\n%s\n" % (title, "\n".join("- " + (json.dumps(i) if isinstance(i, (dict, list)) else str(i)) for i in items) if items else "- none")
    txt = "# %s: %s\n\nkind: %s\n\n%s\n\n## Why\n%s\n" % (s.get("specId"), s.get("title"), s.get("kind"), s.get("summary", ""), s.get("why", ""))
    txt += block("Nets touched", s.get("nets"))
    txt += block("Lanes and places touched", s.get("touches"))
    txt += block("A new lane reads", s.get("reads"))
    txt += block("A new lane writes", s.get("writes"))
    txt += block("Changes, in order", s.get("changes"))
    txt += block("Files expected to change", s.get("files"))
    txt += "\n### Verify after install\n%s\n\n### Rollback\n%s\n\n### Blast radius\n%s\n" % (s.get("verify", ""), s.get("rollback", "previous pack version"), s.get("blastRadius", ""))
    return txt


def curated_knowledge(limit=30):
    facts = [t.get("data") or {} for t in query(P["knowledge"], 'FROM $ WHERE $.status == "active"', 300)]
    order = {"decision": 0, "answer": 1, "convention": 2, "platform": 3, "gap": 4, "risk": 5, "question": 6}
    facts.sort(key=lambda f: (order.get(f.get("kind"), 9), str(f.get("factId", ""))))
    rows = [f for f in facts if f.get("kind") != "question"][:limit]
    return "\n".join("- [%s] %s" % (f.get("kind"), str(f.get("text", ""))[:260]) for f in rows) or "- nothing curated yet"


def earlier_notes():
    runs = [t.get("data") or {} for t in query(P["runs"], 'FROM $ WHERE $.status == "released" LIMIT 100', 100)]
    runs = [r for r in runs if str(r.get("coderNotes", "")).strip()]
    runs.sort(key=lambda r: str(r.get("releasedAt") or r.get("at", "")), reverse=True)
    return "\n".join("- after %s (%s): %s" % (r.get("specId"), str(r.get("title", ""))[:60], str(r.get("coderNotes", ""))[:900]) for r in runs[:5]) or "- nothing recorded yet"


def pack_tree(pack):
    files = []
    for f in sorted(walk_files(pack)):
        rel = os.path.relpath(f, pack)
        if rel.startswith("dist/") or rel.endswith(".pnml.json") or rel.endswith(".inscriptions.json"):
            continue
        files.append("- %s (%d bytes)" % (rel, os.path.getsize(f)))
    return "\n".join(files)


def build_prompt(s, c, pack_rel, pack, extra):
    parts = [
        "You are the Steward's coder, inside the repository of the capability pack that IS the Steward (and whatever it has grown into). The working directory is the repository root; the pack lives in %s. Implement the spec below, nothing else." % pack_rel,
        "## Goal of the model\n%s\n%s" % (c.get("goal", ""), c.get("description", "")),
        "## Principles\n" + "\n".join("- " + p for p in as_list(c.get("principles"))),
        "## The spec\n" + render_spec(s),
        CONVENTIONS,
        "## The protected set (a change that touches these fails verification and is rolled back)\nplaces: %s\nlanes: %s\nfiles: seeds/p-steward-charter.json, and the stores %s and actions %s of the app manifest" % (
            ", ".join(PROTECTED_PLACES), ", ".join(PROTECTED_LANES), ", ".join(REQUIRED_APP_STORES), ", ".join(REQUIRED_APP_ACTIONS)),
        "## What earlier runs learned (read before you start)\n" + earlier_notes(),
        "## What the brain knows (decisions are binding, answers come from the person)\n" + curated_knowledge(),
        "## The pack's files\n" + pack_tree(pack),
        "## Rules\n"
        "- Work only inside %s (and capabilities/tools is read-only reference). Keep the change minimal and complete.\n"
        "- After editing scripts: `python3 capabilities/tools/inline-shared.py capabilities/steward stewardlib` then `python3 -m py_compile` on each edited script.\n"
        "- After editing nets: `node capabilities/tools/pack.mjs build --dir capabilities/steward` must succeed.\n"
        "- After editing the app: `node --check app/ui/main.mjs` must succeed; the manifest must keep the required stores and actions.\n"
        "- Do NOT commit, do NOT bump the version, do NOT install anything.\n"
        "- Finish with ONE line exactly in this form, then stop:\n"
        "STEWARD_RESULT: {\"summary\": \"<what you changed in two sentences>\", \"filesChanged\": [\"path\", ...], \"touched\": [\"<lane or place ids>\"], \"notes\": \"<anything the verifier or the next run must know, or empty>\"}" % pack_rel,
    ]
    parts.extend(extra)
    return "\n\n".join(parts)


def version_tuple(v):
    parts = [int(x) for x in re.findall(r"\d+", str(v or ""))[:3]]
    return tuple(parts + [0] * (3 - len(parts)))


def pack_version(pack):
    m = re.search(r"^version:\s*\"?(\d+\.\d+\.\d+)\"?\s*$", read_text(os.path.join(pack, "capability.yaml"), 20000), re.M)
    return m.group(1) if m else ""


def bump_version(pack):
    cap = os.path.join(pack, "capability.yaml")
    text = read_text(cap, 20000)
    m = re.search(r"^version:\s*\"?(\d+)\.(\d+)\.(\d+)\"?\s*$", text, re.M)
    if not m:
        raise RuntimeError("capability.yaml has no semantic version")
    old = "%s.%s.%s" % m.groups()
    # bump from the higher of the clone's and the installed version, so the new version is always above what runs
    base_v = max(version_tuple(old), version_tuple(installed_version()))
    new = "%d.%d.%d" % (base_v[0], base_v[1], base_v[2] + 1)
    text = text[:m.start()] + "version: %s" % new + text[m.end():]
    with open(cap, "w", encoding="utf-8") as f:
        f.write(text)
    app = os.path.join(pack, "app", "agenticos.app.json")
    manifest = read_json(app)
    if isinstance(manifest, dict):
        manifest["version"] = new
        with open(app, "w", encoding="utf-8") as f:
            json.dump(manifest, f, indent=2)
            f.write("\n")
    return old, new


def record_run(data):
    for t in query(P["runs"], 'FROM $ WHERE $.runId == "%s" LIMIT 5' % data["runId"], 5):
        delete_token(P["runs"], t["id"])
    put_token(P["runs"], data, name="run-%s" % data["runId"])


def apply(spec_id):
    c = charter()
    s = spec_by_id(spec_id)
    rp = repo()
    if not rp or not rp.get("localPath") or not os.path.isdir(os.path.join(str(rp.get("localPath")), ".git")):
        raise RuntimeError("the pack repository is not cloned: run provision in the configuration tab first")
    root = str(rp["localPath"])
    pack_rel = str(c.get("packDir") or "capabilities/steward")
    pack = os.path.join(root, pack_rel)
    rc, status, _ = run(["git", "status", "--porcelain"], cwd=root, check=False)
    if status.strip():
        raise RuntimeError("the pack repository has uncommitted changes; refusing to start a run on a dirty tree")
    base = str(rp.get("branch") or c.get("repoBranch") or "main")
    git(["checkout", "-q", base], cwd=root)
    # the clone must carry the INSTALLED version: a run built from an older checkout publishes a
    # lower version and the hub refuses it as a downgrade (measured 2026-09-09: spec-004 built
    # 0.2.1 from a clone at 0.2.0 while 0.3.0 was installed). Pull, then compare; refuse if behind.
    installed = installed_version()
    clone_version = pack_version(pack)
    if installed and version_tuple(clone_version) < version_tuple(installed):
        git(["pull", "-q", "--ff-only"], cwd=root, check=False)
        clone_version = pack_version(pack)
    if installed and version_tuple(clone_version) < version_tuple(installed):
        raise RuntimeError("the clone is at pack %s but %s is installed: re-provision (pull the repository) before applying %s" % (clone_version, installed, spec_id))
    branch = "steward/%s" % spec_id
    git(["checkout", "-q", "-B", branch, base], cwd=root)
    spec_path = os.path.join(pack, "docs", "specs", "%s.md" % spec_id)
    os.makedirs(os.path.dirname(spec_path), exist_ok=True)
    with open(spec_path, "w", encoding="utf-8") as f:
        f.write(render_spec(s))
    extra = []
    notes = envv("DECISION_NOTES")
    if notes:
        extra.append("## Notes from the person who approved this\n" + notes[:2000])
    prompt = build_prompt(s, c, pack_rel, pack, extra)
    agent = resolve_agent(c)
    run_id = "run-%s-%s" % (spec_id, stamp()[:15])
    started = now()
    old_version = str(rp.get("packVersion") or "")
    journal(LANE, "apply", "%s (%s) starts on %s (%s, kind %s, branch %s)" % (agent["title"], agent["model"], spec_id, str(s.get("title", ""))[:80], s.get("kind"), branch), specId=spec_id, runId=run_id)
    try:
        lanes_before = sorted(tid for tid, _ in pack_lane_ids())
    except Exception:  # noqa: BLE001
        lanes_before = []
    record_run({"at": now(), "startedAt": started, "runId": run_id, "specId": spec_id, "iterationId": s.get("iterationId", ""), "kind": s.get("kind", ""), "title": s.get("title", ""),
                "branch": branch, "status": "coding", "coderAgent": agent["agentId"], "coderModel": agent["model"], "previousVersion": old_version, "lanesBefore": lanes_before})
    replace_token(P["specs"], "specId", spec_id, {"status": "coding", "runId": run_id}, name="spec-%s" % spec_id)
    coder = run_headless(prompt, root, c, agent)
    # the pipeline's own steps: inline, build, compile, package, bump
    steps, ok = [], True
    rc, o, e = run(["python3", "capabilities/tools/inline-shared.py", pack_rel, "stewardlib"], cwd=root, check=False, timeout=120)
    steps.append("inline: %s" % ("ok" if rc == 0 else (e or o)[-300:])); ok = ok and rc == 0
    for f in glob.glob(os.path.join(pack, "assets", "*.py")):
        rc, o, e = run(["python3", "-m", "py_compile", f], cwd=root, check=False, timeout=120)
        if rc != 0:
            steps.append("compile %s: %s" % (os.path.basename(f), (e or o)[-300:])); ok = False
    rc, o, e = run(["node", "capabilities/tools/pack.mjs", "build", "--dir", pack_rel], cwd=root, check=False, timeout=300)
    steps.append("build: %s" % ("ok" if rc == 0 else (e or o)[-600:])); ok = ok and rc == 0
    ui = os.path.join(pack, "app", "ui", "main.mjs")
    if os.path.exists(ui):
        rc, o, e = run(["node", "--check", ui], cwd=root, check=False, timeout=60)
        steps.append("app syntax: %s" % ("ok" if rc == 0 else (e or o)[-300:])); ok = ok and rc == 0
    new_version, artifact = old_version, ""
    if ok:
        old_v, new_version = bump_version(pack)
        rc, o, e = run(["node", "capabilities/tools/pack.mjs", "package", "--dir", pack_rel], cwd=root, check=False, timeout=300)
        steps.append("package: %s" % ("ok" if rc == 0 else (e or o)[-600:])); ok = ok and rc == 0
        artifact = os.path.join(pack, "dist", "%s-%s.capability.json" % (PACK_NAME, new_version))
        if ok and not os.path.exists(artifact):
            steps.append("package: artifact %s missing" % artifact); ok = False
    shutil.rmtree(os.path.join(pack, "assets", "__pycache__"), ignore_errors=True)
    rc2, status_out, _ = run(["git", "status", "--porcelain"], cwd=root, check=False)
    changed = [l[3:] for l in status_out.splitlines() if l.strip() and not l[3:].startswith(pack_rel + "/dist/")]
    git(["add", "-A", "--", pack_rel], cwd=root, check=False)
    rc3, _, _ = git(["commit", "-q", "-m", "steward(%s): %s\n\n%s" % (spec_id, str(s.get("title", ""))[:72], str(coder["summary"].get("summary", ""))[:800])], cwd=root, check=False)
    sha = head_sha(root)
    rc4, stat, _ = run(["git", "diff", "--shortstat", "%s...HEAD" % base], cwd=root, check=False)
    data = {
        "at": now(), "startedAt": started, "runId": run_id, "specId": spec_id, "iterationId": s.get("iterationId", ""), "kind": s.get("kind", ""), "title": s.get("title", ""),
        "branch": branch, "base": base, "headSha": sha, "filesChanged": changed[:60], "diffStat": stat.strip(), "previousVersion": old_version, "packVersion": new_version, "artifact": artifact,
        "buildOk": str(ok).lower(), "buildSteps": steps, "coderSummary": str(coder["summary"].get("summary", ""))[:1200], "coderNotes": str(coder["summary"].get("notes", ""))[:800],
        "coderTouched": as_list(coder["summary"].get("touched"))[:40], "coderTurns": coder["turns"], "coderCostUsd": coder["costUsd"], "coderAgent": agent["agentId"], "coderModel": agent["model"],
        "coderDurationSec": str(coder["durationSec"]), "coderError": str(coder["isError"]).lower(), "status": "built" if ok else "failed", "lanesBefore": lanes_before,
    }
    record_run(data)
    replace_token(P["specs"], "specId", spec_id, {"status": "built" if ok else "failed", "runId": run_id, "packVersion": new_version}, name="spec-%s" % spec_id)
    if ok:
        put_token(P["verify_cmd"], command_token("steward-verify", ["verify", run_id], stage="verify", timeout_ms=1800000, runId=run_id, specId=spec_id), name="verify-%s" % run_id)
    else:
        git(["checkout", "-q", base], cwd=root, check=False)
        start_iteration("failed-%s" % run_id, "steward-apply")
    journal(LANE, "apply", "%s: %d files, %s -> %s, build %s (%s), %s/%s %ss/%s turns%s" % (
        spec_id, len(changed), old_version, new_version, "ok" if ok else "FAILED", "; ".join(x for x in steps if not x.endswith(": ok"))[:300] or "all steps ok", agent["agentId"], agent["model"], coder["durationSec"], coder["turns"] or "?",
        "" if ok else "; next iteration started"), runId=run_id, specId=spec_id, status=data["status"])
    return {"success": ok, "runId": run_id, "branch": branch, "version": new_version, "files": len(changed), "coderSec": coder["durationSec"], "steps": steps}


def main(argv):
    if len(argv) >= 2 and argv[0] == "apply":
        return apply(argv[1] if not argv[1].startswith("${") else envv("SPEC_ID"))
    raise RuntimeError("usage: steward-apply.py apply <specId>")


if __name__ == "__main__":
    sys.exit(main_guard(LANE, main, sys.argv[1:]))
