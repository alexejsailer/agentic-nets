#!/usr/bin/env python3
"""steward-observe: the model the Steward lives in, measured. No model call.

usage: steward-observe.py observe [scheduled|manual|release|smoke]
Reads through the runtime's own MCP (net_stats, list_transitions, scheduler_status, usage_report)
and through master (tokens per place, the session nets), then writes:
  p-steward-lanes    one row per lane for this observation (kind, status, schedule, fires, errors, cost)
  p-steward-map      the model map: sessions, nets, places, lanes, kinds
  p-steward-budget   the day's spend against the charter's budget
  p-steward-health   the summary with the trend against the previous observation
and starts an iteration when nothing is waiting for the person (unless reason is smoke).
"""
import datetime
import json
import os
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
SPEC_KINDS = ["tune", "view", "crystallise", "add-lane", "remove-lane", "add-net", "add-script", "app"]
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

LANE = "t-steward-observe-cmd"


def sessions_and_nets():
    """The designtime picture: every session of the model and its nets with counts."""
    sess = []
    try:
        for s in api("GET", "/api/pnml/%s/sessions" % MODEL) or []:
            name = s.get("name") if isinstance(s, dict) else str(s)
            if name:
                sess.append(name)
    except Exception as e:  # noqa: BLE001
        log("sessions: %s" % e)
    nets = []
    for name in sess:
        try:
            d = api("GET", "/api/designtime/nets?modelId=%s&sessionId=%s" % (MODEL, name))
            for n in (d or {}).get("nets", []):
                nets.append({"session": name, "netId": n.get("netId"), "places": n.get("placeCount", 0), "transitions": n.get("transitionCount", 0), "arcs": n.get("arcCount", 0)})
        except Exception as e:  # noqa: BLE001
            log("nets of %s: %s" % (name, e))
    return sess, nets


def lane_rows(stats, listed, sched, usage):
    by_status = {}
    for t in as_list(stats.get("running")):
        by_status[str(t)] = "RUNNING"
    for nr in as_list(stats.get("notRunning")):
        nr = as_dict(nr) if not isinstance(nr, dict) else nr
        if nr.get("transitionId"):
            by_status[nr["transitionId"]] = nr.get("status", "STOPPED")
    llm = {}
    for row in as_list((stats.get("llm") or {}).get("byTransition")):
        row = as_dict(row) if not isinstance(row, dict) else row
        if row.get("transitionId"):
            llm[row["transitionId"]] = row
    sched_by = {}
    for row in as_list(sched.get("lanes") or sched.get("scheduled") or sched.get("transitions")):
        row = as_dict(row) if not isinstance(row, dict) else row
        if row.get("transitionId"):
            sched_by[row["transitionId"]] = row
    burn = {}
    for row in as_list(usage.get("byTransition") or usage.get("ranked") or usage.get("transitions")):
        row = as_dict(row) if not isinstance(row, dict) else row
        if row.get("transitionId"):
            burn[row["transitionId"]] = row
    rows = []
    items = as_list(listed.get("transitions") or listed.get("items") or (listed if isinstance(listed, list) else []))
    for t in items:
        t = as_dict(t) if not isinstance(t, dict) else t
        tid = t.get("transitionId") or t.get("id")
        if not tid:
            continue
        sc = sched_by.get(tid, {})
        u = burn.get(tid, {})
        l = llm.get(tid, {})
        rows.append({
            "transitionId": tid, "kind": t.get("kind", ""), "status": t.get("status") or by_status.get(tid, ""), "netId": t.get("netId", ""),
            "schedule": json.dumps(t.get("schedule")) if t.get("schedule") else "", "inputs": as_list(t.get("inputs") or t.get("inputPlaces")), "outputs": as_list(t.get("outputs") or t.get("outputPlaces")),
            "lastFiredAt": sc.get("lastFiredAt", ""), "nextFireAt": sc.get("nextFireAt", ""), "overdue": str(sc.get("overdue", "")).lower(),
            "llmCalls": as_int(l.get("calls"), 0), "llmErrors": as_int(l.get("errors"), 0), "tokensIn": as_int(u.get("inputTokens") or u.get("tokensIn"), 0), "tokensOut": as_int(u.get("outputTokens") or u.get("tokensOut"), 0),
            "costUsd": as_float(u.get("costUsd") or u.get("cost"), 0.0), "fires": as_int(u.get("fires") or u.get("calls"), 0),
        })
    return rows


def place_counts(rows, limit=120):
    places = []
    for r in rows:
        for p in r["inputs"] + r["outputs"]:
            if p and p not in places:
                places.append(p)
    counts = {}
    for p in places[:limit]:
        try:
            counts[p] = count(p)
        except Exception:  # noqa: BLE001
            counts[p] = -1
    return counts


def stranded(rows, counts):
    """Input places with tokens whose only readers are running, unscheduled lanes that have not
    fired for an hour: candidates for a stranded head-of-line token or a filter that never matches."""
    cutoff = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=1)).isoformat()
    readers = {}
    for r in rows:
        for p in r["inputs"]:
            readers.setdefault(p, []).append(r)
    found = []
    config_places = {P["charter"], P["coders"]}
    for p, rs in readers.items():
        n = counts.get(p, 0)
        if n <= 0 or p in config_places:
            continue
        idle = [r for r in rs if r["status"] == "RUNNING" and not r["schedule"] and (not r["lastFiredAt"] or r["lastFiredAt"] < cutoff)]
        if idle and len(idle) == len([r for r in rs if r["status"] == "RUNNING"]):
            oldest = aged_token(p, cutoff)
            if oldest is not None:
                found.append({"place": p, "tokens": n, "lanes": [r["transitionId"] for r in idle][:4], "oldest": oldest})
    return found[:12]


def aged_token(place, cutoff):
    """The timestamp of a token older than the cutoff (or '' for one without a timestamp), else None:
    a token that arrived a moment ago is work in flight, not a stranded one."""
    for t in query(place, "FROM $", 5):
        d = t.get("data") or {}
        ts = str(d.get("at") or d.get("filedAt") or d.get("_emittedAt") or d.get("updatedAt") or "")
        if not ts or ts < cutoff:
            return ts
    return None


def contract_misses(counts):
    total = 0
    for p, n in counts.items():
        if "llm-errors" in p or "contract" in p:
            total += max(n, 0)
    return total


def previous_health():
    hs = query(P["health"], "FROM $", 50)
    hs.sort(key=lambda t: str((t.get("data") or {}).get("at", "")), reverse=True)
    return (hs[0].get("data") or {}) if hs else {}


def waiting_for_person():
    """True when a question, an approval or a draft is open, or a run is in flight."""
    answered = {str((t.get("data") or {}).get("promptId")) for t in query(P["responses"], "FROM $", 300)}
    answered |= {str((t.get("data") or {}).get("promptId")) for t in query(P["specs"], "FROM $", 300)}
    decided = {str((t.get("data") or {}).get("specId")) for t in query(P["decisions"], "FROM $", 300)}
    for t in query(P["prompts"], "FROM $", 200):
        d = t.get("data") or {}
        if d.get("kind") == "approval":
            if d.get("specId") and d.get("specId") not in decided:
                return "an approval waits"
        elif d.get("promptId") and d.get("promptId") not in answered:
            return "a question waits"
    for t in query(P["specs"], 'FROM $ WHERE $.status == "draft"', 50):
        d = t.get("data") or {}
        if d.get("specId") not in decided:
            return "a draft waits for the gate or the person"
    for t in query(P["runs"], "FROM $", 100):
        st = (t.get("data") or {}).get("status", "")
        if st in ("coding", "building", "verifying", "releasing"):
            return "a run is in flight"
    for t in query(P["context"], "FROM $", 20):
        return "a brief is being judged"
    return ""


def observe(argv):
    reason = argv[1] if len(argv) > 1 and not argv[1].startswith("${") else "manual"
    c = charter()
    at = now()
    stats = mcp("net_stats", {"window": 500})
    listed = mcp("list_transitions", {})
    try:
        sched = mcp("scheduler_status", {})
    except Exception as e:  # noqa: BLE001
        sched = {"error": str(e)[:200]}
    try:
        usage = mcp("usage_report", {"hours": 24})
    except Exception as e:  # noqa: BLE001
        usage = {"error": str(e)[:200]}
    rows = lane_rows(stats, listed, sched, usage)
    counts = place_counts(rows)
    strand = stranded(rows, counts)
    sess, nets = sessions_and_nets()
    tr = stats.get("transitions") or {}
    by = tr.get("byStatus") or {}
    errors_recent = [as_dict(e) if not isinstance(e, dict) else e for e in as_list(stats.get("recentErrors"))][:8]
    cost = round(sum(r["costUsd"] for r in rows), 4)
    if not cost and isinstance(usage, dict):
        cost = as_float(usage.get("totalCostUsd") or (usage.get("totals") or {}).get("costUsd"), 0.0)
    top_cost = sorted([r for r in rows if r["costUsd"] > 0], key=lambda r: -r["costUsd"])[:5]
    top_err = sorted([r for r in rows if r["llmErrors"] > 0], key=lambda r: -r["llmErrors"])[:5]
    overdue = [r["transitionId"] for r in rows if r["overdue"] == "true"]
    misses = contract_misses(counts)
    prev = previous_health()
    obs_id = "obs-%s" % stamp()
    # lanes: one row each, bounded
    for r in rows:
        row = dict(r); row.update({"observationId": obs_id, "at": at, "tokensAtInputs": sum(max(counts.get(p, 0), 0) for p in r["inputs"])})
        row["inputs"] = ",".join(r["inputs"]); row["outputs"] = ",".join(r["outputs"])
        put_token(P["lanes"], row, name="%s-%s" % (obs_id, r["transitionId"]))
    keep_last(P["lanes"], "at", 400)
    # the map
    kinds = {}
    for r in rows:
        kinds[r["kind"]] = kinds.get(r["kind"], 0) + 1
    m = {"at": at, "observationId": obs_id, "sessions": sess, "nets": nets, "places": len(counts), "transitions": len(rows), "kinds": kinds,
         "placeCounts": {k: v for k, v in sorted(counts.items(), key=lambda kv: -kv[1])[:60]},
         "summary": "%d session(s), %d net(s), %d lanes (%s), %d places measured, %d tokens in them" % (
             len(sess), len(nets), len(rows), ", ".join("%d %s" % (v, k) for k, v in sorted(kinds.items())), len(counts), sum(max(v, 0) for v in counts.values()))}
    put_token(P["map"], m, name="map-%s" % obs_id)
    keep_last(P["map"], "at", 10)
    # the budget
    day = at[:10]
    b = latest(P["budget"], "day", 'FROM $ WHERE $.day == "%s"' % day)
    limit = as_float(c.get("dailyBudgetUsd"), 10.0)
    spent = round(max(as_float(b.get("spentUsd"), 0.0), cost), 4)
    bud = {"day": day, "at": at, "limitUsd": limit, "spentUsd": spent, "remainingUsd": round(max(limit - spent, 0.0), 4), "exhausted": "true" if spent >= limit else "false"}
    replace_token(P["budget"], "day", day, bud, name="budget-%s" % day)
    # health
    h = {
        "at": at, "observationId": obs_id, "reason": reason, "sessions": len(sess), "nets": len(nets), "lanes": len(rows),
        "running": as_int(by.get("RUNNING"), len([r for r in rows if r["status"] == "RUNNING"])), "stopped": as_int(by.get("STOPPED"), 0), "errorState": as_int(by.get("ERROR"), 0),
        "scheduled": len(as_list(stats.get("scheduled"))), "overdue": overdue[:10], "llmCalls": as_int((stats.get("llm") or {}).get("calls"), 0), "llmErrors": as_int((stats.get("llm") or {}).get("errors"), 0),
        "fires": as_int((stats.get("activity") or {}).get("fires"), 0), "fireErrors": as_int((stats.get("activity") or {}).get("fireErrors"), 0),
        "contractMisses": misses, "stranded": strand, "costUsd24h": cost, "executor": str((stats.get("executorCoverage") or {}).get("state", "")),
        "paused": str(stats.get("paused", "")).lower(), "topCost": [{"lane": r["transitionId"], "usd": r["costUsd"]} for r in top_cost], "topErrors": [{"lane": r["transitionId"], "errors": r["llmErrors"]} for r in top_err],
        "recentErrors": [str(e.get("summary", ""))[:160] for e in errors_recent], "places": len(counts), "tokens": sum(max(v, 0) for v in counts.values()),
        "trend": {"llmErrors": as_int((stats.get("llm") or {}).get("errors"), 0) - as_int(prev.get("llmErrors"), 0), "fireErrors": as_int((stats.get("activity") or {}).get("fireErrors"), 0) - as_int(prev.get("fireErrors"), 0),
                  "stranded": len(strand) - len(as_list(prev.get("stranded"))), "running": as_int(by.get("RUNNING"), 0) - as_int(prev.get("running"), 0), "costUsd24h": round(cost - as_float(prev.get("costUsd24h"), 0.0), 4)},
        "summary": "%d lanes: %d running, %d stopped, %d in error; %d fire errors, %d contract misses, %d stranded place(s), %d overdue schedule(s); executor %s" % (
            len(rows), as_int(by.get("RUNNING"), 0), as_int(by.get("STOPPED"), 0), as_int(by.get("ERROR"), 0), as_int((stats.get("activity") or {}).get("fireErrors"), 0), misses, len(strand), len(overdue), str((stats.get("executorCoverage") or {}).get("state", ""))),
    }
    put_token(P["health"], h, name="health-%s" % obs_id)
    keep_last(P["health"], "at", 60)
    started = ""
    if reason != "smoke":
        why = waiting_for_person()
        if not why:
            started = "it-%s" % stamp()
            put_token(P["iterate"], {"at": at, "iterationId": started, "reason": "observe-%s" % reason, "requestedBy": "steward"}, name=started)
    journal(LANE, "observe", "%s (%s): %s; cost 24h %.2f USD of %.2f%s" % (obs_id, reason, h["summary"], cost, limit, ("; iteration %s started" % started) if started else ("; nothing started: %s" % why if reason != "smoke" else "")), observationId=obs_id)
    return {"success": True, "observationId": obs_id, "summary": h["summary"], "costUsd24h": cost, "started": started, "lanes": len(rows), "places": len(counts)}


def main(argv):
    if not argv or argv[0] != "observe":
        raise RuntimeError("usage: steward-observe.py observe [reason]")
    return observe(argv)


if __name__ == "__main__":
    sys.exit(main_guard(LANE, main, sys.argv[1:]))
