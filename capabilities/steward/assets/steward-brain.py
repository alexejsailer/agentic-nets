#!/usr/bin/env python3
"""steward-brain: the curated, bounded model of what the Steward knows about the model it lives in.

usage: steward-brain.py observe <runId|latest> [next]   collect the signals of a released run, brief the curator
       steward-brain.py curate <signalId>               curate headless (the configured agent, read-only in the pack repo)
       steward-brain.py apply <curationId>              apply a curation: facts, plan, decisions, questions, next iteration
       steward-brain.py answer <promptId>               record the person's answer to a brain question as a fact
"""
import json
import os
import re
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


def loop_busy():
    """True while an iteration is in flight: a trigger, a brief, an unanswered question, a draft at the gate
    or a run. Whoever wants to start the next iteration asks this first, so one refusal or rollback never
    stacks a second question on the person."""
    if count(P["iterate"]) > 0 or count(P["context"]) > 0 or count(P["spec_drafts"]) > 0:
        return True
    answered = {str((t.get("data") or {}).get("promptId")) for t in query(P["responses"], "FROM $", 300)}
    answered |= {str((t.get("data") or {}).get("promptId")) for t in query(P["specs"], "FROM $", 300)}
    decided = {str((t.get("data") or {}).get("specId")) for t in query(P["decisions"], "FROM $", 300)}
    for t in query(P["prompts"], "FROM $", 200):
        d = t.get("data") or {}
        if d.get("kind") == "approval" and d.get("specId") and d.get("specId") not in decided:
            return True
        if d.get("kind") != "approval" and d.get("promptId") and d.get("promptId") not in answered:
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

LANE = "t-steward-brain-observe-cmd"
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
        runs = [t.get("data") or {} for t in query(P["runs"], 'FROM $ WHERE $.status == "released"', 100)]
        runs.sort(key=lambda r: str(r.get("releasedAt") or r.get("at", "")), reverse=True)
        if not runs:
            raise RuntimeError("no released run to observe")
        r = runs[0]
    else:
        r = one(P["runs"], 'FROM $ WHERE $.runId == "%s" LIMIT 1' % run_id)
        if not r:
            raise RuntimeError("run %s not found" % run_id)
    s = one(P["specs"], 'FROM $ WHERE $.specId == "%s" LIMIT 1' % r.get("specId", ""))
    ver = latest(P["verification"], "at", 'FROM $ WHERE $.runId == "%s"' % r["runId"])
    hs = query(P["health"], "FROM $", 60)
    hs.sort(key=lambda t: str((t.get("data") or {}).get("at", "")), reverse=True)
    healths = [t.get("data") or {} for t in hs]
    after = healths[0] if healths else {}
    before = next((h for h in healths if str(h.get("at", "")) < str(r.get("startedAt", ""))), {})
    return {
        "signalId": "sig-%s" % r["runId"], "runId": r["runId"], "specId": r.get("specId", ""), "title": r.get("title", ""), "kind": r.get("kind", ""), "at": now(),
        "packVersion": r.get("packVersion", ""), "previousVersion": r.get("previousVersion", ""), "status": r.get("status"),
        "coderSummary": str(r.get("coderSummary", ""))[:1500], "coderNotes": str(r.get("coderNotes", ""))[:2500], "coderAgent": r.get("coderAgent", ""), "coderModel": r.get("coderModel", ""),
        "coderTouched": as_list(r.get("coderTouched"))[:30], "filesChanged": as_list(r.get("filesChanged"))[:40], "diffStat": r.get("diffStat", ""),
        "verification": {"status": ver.get("status"), "checks": as_list(ver.get("checks"))[:12]},
        "healthBefore": {k: before.get(k) for k in ("at", "summary", "costUsd24h", "llmErrors", "fireErrors", "contractMisses", "running", "stopped") if k in before},
        "healthAfter": {k: after.get(k) for k in ("at", "summary", "costUsd24h", "llmErrors", "fireErrors", "contractMisses", "running", "stopped") if k in after},
        "specSummary": str(s.get("summary", ""))[:600], "specWhy": str(s.get("why", ""))[:600], "specVerify": str(s.get("verify", ""))[:300], "specNets": as_list(s.get("nets")), "specTouches": as_list(s.get("touches"))[:20],
    }


def curation_brief(sig, m):
    c = charter()
    lines = [
        "# BRIEF FOR THE STEWARD'S BRAIN: curate what the model knows after %s" % sig.get("specId"),
        "signalId: %s\nrunId: %s\ncurationId to use: cur-%s\nnow: %s" % (sig["signalId"], sig["runId"], sig["runId"], now()),
        "## GOAL\n%s\n%s\n\n## PRINCIPLES\n%s\n\n## CONSTRAINTS\n%s" % (c.get("goal", ""), str(c.get("description", ""))[:1200], "\n".join("- " + p for p in as_list(c.get("principles"))), "\n".join("- " + x for x in as_list(c.get("constraints"))) or "- none"),
        "## WHAT WAS RELEASED: %s (%s, kind %s) as pack %s (before: %s)\nspec summary: %s\nwhy: %s\nnets: %s\ntouches: %s\nfiles: %s\ndiff: %s\nverify condition: %s" % (
            sig.get("specId"), sig.get("title"), sig.get("kind"), sig.get("packVersion"), sig.get("previousVersion"), sig.get("specSummary"), sig.get("specWhy"), ", ".join(sig.get("specNets", [])),
            ", ".join(sig.get("specTouches", [])), ", ".join(sig.get("filesChanged", [])[:25]), sig.get("diffStat"), sig.get("specVerify")),
        "## WHAT THE CODER REPORTED (%s / %s)\nsummary: %s\nnotes: %s\ntouched: %s" % (sig.get("coderAgent"), sig.get("coderModel"), sig.get("coderSummary"), sig.get("coderNotes"), ", ".join(sig.get("coderTouched", []))),
        "## WHAT WAS MEASURED\nverification: %s\nhealth before: %s\nhealth after: %s" % (json.dumps(sig.get("verification")), json.dumps(sig.get("healthBefore")), json.dumps(sig.get("healthAfter"))),
        "## THE MODEL MAP (measured)\n%s\nnets: %s" % (m.get("summary", ""), "; ".join("%s/%s %sp %st" % (n.get("session"), n.get("netId"), n.get("places"), n.get("transitions")) for n in [as_dict(x) if not isinstance(x, dict) else x for x in as_list(m.get("nets"))][:30])),
        "## CURRENT KNOWLEDGE (active facts; retire what is now wrong or subsumed, never retire an answer)\n" + knowledge_text(),
        "## CURRENT PLAN\n" + plan_text(),
        "## DECISIONS ON RECORD\n" + ("\n".join("- %s [%s] %s: %s" % (a.get("adrId"), a.get("status"), a.get("title"), str(a.get("decision", ""))[:160]) for a in adrs()) or "- none"),
    ]
    return "\n\n".join(lines)[:16000]


def observe(argv):
    c = charter()
    sig = signal_for(argv[1] if len(argv) > 1 else "latest")
    sig["startIteration"] = "true" if (envv("START_ITERATION") == "true" or (len(argv) > 2 and argv[2] == "next")) else "false"
    m = latest(P["map"], "at")
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
        put_token(P["brain_cmd"], command_token("steward-brain", ["curate", sig["signalId"]], stage="curate", timeout_ms=1800000, signalId=sig["signalId"], runId=sig["runId"]), name="curate-%s" % sig["runId"])
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
    m = latest(P["map"], "at")
    prompt = "\n\n".join([
        "You are the Steward's brain, curating what the model knows after one released change. You may read the pack repository in the current directory to verify anything in the brief. Do not change any file.",
        curation_brief(sig, m), RULES, CONTRACT])
    agent = resolve_agent(c, "brainAgent", "brainModel")
    res = run_headless(prompt, str(rp.get("localPath") or steward_home(c)), c, agent)
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
    journal("t-steward-curate-cmd", "curate", "headless curation by %s/%s for %s: %d facts, %d retired, %d decisions, %d questions (%ss)" % (
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
                             "status": "proposed", "updatedAt": now(), "source": curation_id, "proposedBy": "steward"}, name=adr_id)
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
        put_token(P["iterate"], {"at": now(), "iterationId": started, "reason": "released", "specId": sig.get("specId", ""), "requestedBy": "steward"}, name=started)
        for t in query(P["signals"], 'FROM $ WHERE $.runId == "%s" LIMIT 5' % run_id, 5):
            d = t.get("data") or {}; d["iterationStarted"] = started
            delete_token(P["signals"], t["id"]); put_token(P["signals"], d, name="%s-done" % d.get("signalId", run_id))
    journal("t-steward-brain-apply-cmd", "apply", "curation %s applied: +%d facts (%d skipped: %s), %d retired, plan %s, %d decisions proposed, %d questions, %d ideas%s; %s" % (
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
    journal("t-steward-brain-apply-cmd", "answer", "the person answered %s; recorded as %s" % (prompt_id, fid), promptId=prompt_id)
    return {"success": True, "factId": fid}


def main(argv):
    if not argv:
        raise RuntimeError("usage: steward-brain.py observe|curate|apply|answer ...")
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
