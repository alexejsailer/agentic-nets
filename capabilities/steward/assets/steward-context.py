#!/usr/bin/env python3
"""steward-context: renders the brief a judgement lane reads. A script assembles it from tokens; the
lane only judges.

usage: steward-context.py context propose <iterationId>
       steward-context.py context spec <iterationId> <promptId>   (RESPONSE_SELECTED/TEXT/NOTES in env)
"""
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

LANE = "t-steward-context-cmd"

GRAMMAR = """## THE CLOSED GRAMMAR OF CHANGE SPECS (kind)
- tune: schedule, retain, capacity, optional, ttl, tier or model group of an existing lane
- view: add or regenerate designtime views (drawings over the same ids; nothing at runtime changes)
- crystallise: replace an agent or llm lane by a map or command lane with the same reads and writes; keep the old lane stopped for one iteration
- add-lane: a new lane inside an existing net, with reads, writes, complete emit rules and, for an agent lane, an answer contract
- remove-lane: stop and remove a lane no signal has used for two iterations
- add-net: a new net with its places, lanes, scripts and seeds
- add-script: a new executor script, or a change to one
- tool-net: a reusable tool net: a script or command tool registered in the tool catalog plus the small net that exposes it (scaffold, register, promote), usable by other nets and agents in this model
- app: stores, actions or surface of the Steward's own application, outside the configuration tab
- charter: never; the charter is the person's
"""


def candidates_section():
    """Measured crystallisation and tuning candidates from the last observation."""
    h = latest(P["health"], "at")
    obs = h.get("observationId", "")
    rows = [t.get("data") or {} for t in query(P["candidates"], 'FROM $ WHERE $.observationId == "%s"' % obs, 20)] if obs else []
    if not rows:
        return "## CRYSTALLISATION CANDIDATES (measured)\n- none: no AI lane fired often enough with one-iteration, same-shape outputs\n"
    txt = "## CRYSTALLISATION CANDIDATES (measured; a crystallise or tune option is expected for each)\n"
    for c in rows:
        txt += "- %s (%s): %s. %s\n" % (c.get("lane"), c.get("suggestion"), c.get("reason"), ("output place %s" % c.get("outputPlace")) if c.get("outputPlace") else "")
    return txt


def ideas_section(for_spec=False):
    """Open ideas from the person (kind person) and the brain (kind brain): every proposal must offer at
    least one option that serves an open idea, carrying its ideaId; a spec that serves one carries it too."""
    rows = [t.get("data") or {} for t in query(P["ideas"], 'FROM $ WHERE $.status == "open"', 100)]
    rows.sort(key=lambda i: str(i.get("at", "")))
    if not rows:
        return "## OPEN IDEAS\n- (none; the person can add one in the application, the brain after a release)\n"
    txt = "## OPEN IDEAS (from the person or the brain; serve them before inventing something else)\n"
    for i in rows[:15]:
        txt += "- %s [%s, %s]: %s\n" % (i.get("ideaId"), i.get("by", "?"), str(i.get("at", ""))[:10], str(i.get("text", ""))[:400])
    if for_spec:
        txt += "If the chosen option carries an ideaId, put the same ideaId in the spec.\n"
    else:
        txt += "At least one option must serve an open idea and carry its ideaId; say in the option what the idea asked for.\n"
    return txt


def lines(items, limit=12, prefix="- "):
    o = [prefix + str(it) for it in items[:limit]]
    return "\n".join(o) if o else "- (none)"


def charter_section(c):
    defined = goal_defined(c)
    txt = "## GOAL\n"
    if not defined:
        txt += "The goal is NOT DEFINED yet (placeholder). Nothing can be specified before the person defines what this model should become.\n"
    else:
        txt += "%s\n%s\n" % (c.get("goal", ""), c.get("description", ""))
    txt += "\n## PRINCIPLES\n%s\n" % lines(as_list(c.get("principles")))
    cons = as_list(c.get("constraints"))
    if cons:
        txt += "\n## CONSTRAINTS\n%s\n" % lines(cons)
    txt += "\n## CHARTER\nscope (nets the Steward may touch): %s\nautonomy level: %s (1 observe only, 2 propose only, 3 apply with approval, 4 tune and view alone, 5 also crystallise alone)\ndaily budget: %s USD\ncoder: %s / %s\n" % (
        ", ".join(scope_nets(c)), autonomy(c), c.get("dailyBudgetUsd", "?"), c.get("coderAgent", "claude-code"), c.get("coderModel", ""))
    txt += "\n## THE PROTECTED SET (never in a spec's touches, reads or writes)\nplaces: %s\nlanes: %s\n" % (", ".join(PROTECTED_PLACES), ", ".join(PROTECTED_LANES))
    return txt, ("defined" if defined else "undefined")


def health_section():
    hs = query(P["health"], "FROM $", 60)
    hs.sort(key=lambda t: str((t.get("data") or {}).get("at", "")), reverse=True)
    if not hs:
        return "## HEALTH\nNot measured yet.\n"
    h = hs[0].get("data") or {}
    txt = "## HEALTH (last observation %s, %s)\n%s\ncost last 24h: %s USD\n" % (h.get("at"), h.get("reason"), h.get("summary"), h.get("costUsd24h"))
    tr = as_dict(h.get("trend")) if not isinstance(h.get("trend"), dict) else h.get("trend")
    if tr:
        txt += "trend since the previous observation: %s\n" % ", ".join("%s %+d" % (k, as_int(v)) if isinstance(v, (int, str)) and str(v).lstrip("-").isdigit() else "%s %s" % (k, v) for k, v in tr.items())
    for key, label in (("topErrors", "lanes with contract or fire errors"), ("topCost", "most expensive lanes"), ("stranded", "places with tokens no running lane consumes"), ("overdue", "overdue schedules"), ("recentErrors", "recent errors")):
        items = as_list(h.get(key))
        if items:
            txt += "%s:\n%s\n" % (label, lines([json.dumps(i) if isinstance(i, dict) else str(i) for i in items], 8))
    return txt


def lanes_section(limit=40):
    ls = query(P["lanes"], "FROM $", 400)
    if not ls:
        return "## LANES\nNot measured yet.\n"
    ls.sort(key=lambda t: str((t.get("data") or {}).get("at", "")), reverse=True)
    obs = (ls[0].get("data") or {}).get("observationId")
    rows = [t.get("data") or {} for t in ls if (t.get("data") or {}).get("observationId") == obs]
    rows.sort(key=lambda r: (str(r.get("netId", "")), str(r.get("transitionId", ""))))
    txt = "## LANES (observation %s, %d lanes)\n" % (obs, len(rows))
    for r in rows[:limit]:
        txt += "- %s [%s, %s]%s reads %s -> writes %s; fires %s, llm calls %s (errors %s), cost %s USD, tokens at inputs %s%s\n" % (
            r.get("transitionId"), r.get("kind"), r.get("status"), (" sched " + str(r.get("schedule"))[:40]) if r.get("schedule") else "",
            str(r.get("inputs", ""))[:120], str(r.get("outputs", ""))[:120], r.get("fires", 0), r.get("llmCalls", 0), r.get("llmErrors", 0), r.get("costUsd", 0), r.get("tokensAtInputs", 0),
            " OVERDUE" if str(r.get("overdue")) == "true" else "")
    if len(rows) > limit:
        txt += "- ... %d more\n" % (len(rows) - limit)
    return txt


def map_section():
    m = latest(P["map"], "at")
    if not m:
        return "## THE MODEL MAP\nNot measured yet.\n"
    txt = "## THE MODEL MAP (measured)\n%s\nnets:\n" % m.get("summary", "")
    for n in as_list(m.get("nets"))[:30]:
        n = as_dict(n) if not isinstance(n, dict) else n
        txt += "- %s / %s: %s places, %s lanes, %s arcs\n" % (n.get("session"), n.get("netId"), n.get("places"), n.get("transitions"), n.get("arcs"))
    return txt


def brain_sections(for_spec=False):
    facts = [t.get("data") or {} for t in query(P["knowledge"], 'FROM $ WHERE $.status == "active"', 300)]
    facts.sort(key=lambda f: str(f.get("factId", "")))
    txt = "## WHAT THE BRAIN KNOWS (curated facts)\n" + (lines(["[%s|%s] %s" % (f.get("kind"), f.get("confidence", "?"), str(f.get("text", ""))[:220]) for f in facts[:36]], 36) if facts else "- (no curated facts yet)")
    p = latest(P["plan"], "at")
    if p and not for_spec:
        incs = []
        for inc in as_list(p.get("increments")):
            inc = as_dict(inc) if not isinstance(inc, dict) else inc
            incs.append("%s [%s|%s] %s%s" % (inc.get("id", "?"), inc.get("kind", "?"), inc.get("status", "?"), str(inc.get("title", ""))[:110], (" (after %s)" % ", ".join(as_list(inc.get("dependsOn")))) if as_list(inc.get("dependsOn")) else ""))
        txt += "\n\n## THE PLAN (curated after the last release; prefer its next planned increments, deviate only with a reason)\n" + lines(incs, 20)
    ads = adrs()
    if ads:
        txt += "\n\n## DECISIONS ON RECORD\n" + lines(["%s [%s] %s: %s" % (a.get("adrId"), a.get("status"), a.get("title"), str(a.get("decision", ""))[:160]) for a in ads], 15)
    return txt + "\n"


def history_section():
    specs = [t.get("data") or {} for t in query(P["specs"], "FROM $", 200)]
    specs.sort(key=lambda s: str(s.get("specId", "")))
    runs = [t.get("data") or {} for t in query(P["runs"], "FROM $", 200)]
    runs.sort(key=lambda r: str(r.get("at", "")), reverse=True)
    prompts = [t.get("data") or {} for t in query(P["prompts"], "FROM $", 100)]
    prompts.sort(key=lambda p: str(p.get("at", "")))
    refused = [t.get("data") or {} for t in query(P["refused"], "FROM $", 50)]
    txt = "## SPECS SO FAR (released ones are DONE: never propose them again; refused and rejected ones need a different shape)\n" + lines([
        "%s [%s|%s] %s" % (s.get("specId", "?"), s.get("kind", "?"), s.get("status", "?"), str(s.get("title", ""))[:100]) for s in specs], 25)
    txt += "\n\n## RECENT RUNS\n" + lines(["%s spec %s: %s, pack %s (%s)" % (r.get("runId", "?"), r.get("specId", "?"), r.get("status", "?"), r.get("packVersion", "?"), str(r.get("coderSummary", ""))[:120]) for r in runs], 5)
    if refused:
        txt += "\n\n## REFUSED BY THE GATE (do not propose the same again)\n" + lines(["%s: %s" % (r.get("specId"), str(r.get("reason", ""))[:160]) for r in refused[-5:]], 5)
    txt += "\n\n## EARLIER QUESTIONS (do not repeat verbatim)\n" + lines([str(p.get("question", ""))[:120] for p in prompts[-4:]], 4)
    jr = [t.get("data") or {} for t in query(P["journal"], "FROM $", 400)]
    jr.sort(key=lambda j: str(j.get("at", "")), reverse=True)
    txt += "\n\n## JOURNAL (newest first)\n" + lines(["%s %s: %s" % (str(j.get("at", ""))[11:16], j.get("stage", ""), str(j.get("summary", ""))[:140]) for j in jr], 8)
    return txt + "\n"


def pack_section():
    """The pack's own files, so a spec can name what the coder edits."""
    c = charter()
    pack, root = pack_dir(c)
    if not os.path.isdir(pack):
        return "## THE PACK REPOSITORY\nNot cloned yet (the setup provisions it); specs may still name files by their conventional paths: nets/<net>.net.json, assets/<script>.py, seeds/<place>.json, app/agenticos.app.json, app/ui/main.mjs.\n"
    files = []
    for f in sorted(walk_files(pack)):
        rel = os.path.relpath(f, pack)
        if rel.startswith("dist/") or rel.endswith(".pnml.json") or rel.endswith(".inscriptions.json"):
            continue
        files.append("%s (%d bytes)" % (rel, os.path.getsize(f)))
    return "## THE PACK REPOSITORY (%s, pack dir %s)\nCompact sources compile with `node capabilities/tools/pack.mjs build --dir capabilities/steward`; scripts inline the shared library with `python3 capabilities/tools/inline-shared.py capabilities/steward stewardlib`.\nfiles:\n%s\n" % (root, os.path.relpath(pack, root), lines(files, 60))


def propose(iteration_id, goal_note=""):
    c = charter()
    charter_txt, goal_status = charter_section(c)
    earlier = query(P["prompts"], 'FROM $ WHERE $.iterationId == "%s" LIMIT 50' % iteration_id, 50)
    prompt_id = "pr-%s-%d" % (iteration_id, len(earlier) + 1)
    brief = "\n".join([
        "# BRIEF FOR THE STEWARD: what should the next increment be?",
        "iterationId: %s\npromptId to use: %s\nnow: %s\nmodel: %s" % (iteration_id, prompt_id, now(), MODEL),
        charter_txt, health_section(), lanes_section(), map_section(), candidates_section(), brain_sections(), ideas_section(), history_section(), GRAMMAR,
    ])
    revision = envv("REVISION_TEXT")
    if revision:
        brief += "\n## THE PERSON RESHAPED THE LAST QUESTION\n%s\nAsk again, taking this into account.\n" % revision[:1500]
    if goal_note:
        brief += "\n## THE PERSON JUST DEFINED THE GOAL\n%s\nDo not ask for the goal again: propose the first increment toward it as a choice (mode choice) with two to four options inside the grammar.\n" % goal_note[:2000]
    data = {"at": now(), "iterationId": iteration_id, "purpose": "propose", "promptId": prompt_id, "goalStatus": goal_status, "brief": brief[:20000]}
    put_token(P["context"], data, name="ctx-propose-%s" % iteration_id)
    journal(LANE, "context", "proposal brief for %s: goal %s, %d chars" % (iteration_id, goal_status, len(brief)), iterationId=iteration_id)
    return {"success": True, "iterationId": iteration_id, "goalStatus": goal_status, "chars": len(brief)}


def spec(iteration_id, prompt_id):
    c = charter()
    charter_txt, goal_status = charter_section(c)
    if goal_status == "undefined":
        raise RuntimeError("the goal is still a placeholder; define it before specifying a change")
    pr = one(P["prompts"], 'FROM $ WHERE $.promptId == "%s" LIMIT 1' % prompt_id)
    selected = as_list(envv("RESPONSE_SELECTED"))
    text = envv("RESPONSE_TEXT")
    notes = envv("RESPONSE_NOTES")
    if str(pr.get("mode")) == "goal":
        # the goal is now in the charter (the application saved it); the first increment is the person's choice, not a spec
        put_token(P["responses"], {"at": now(), "promptId": prompt_id, "iterationId": iteration_id, "intent": "answered", "selected": selected, "text": text, "notes": notes, "specId": "", "by": "steward"}, name="receipt-%s" % prompt_id)
        journal(LANE, "context", "the goal was defined in %s; asking for the first increment" % prompt_id, iterationId=iteration_id)
        return propose(iteration_id, goal_note="%s\n%s" % (c.get("goal", ""), text))
    chosen = []
    for o in as_list(pr.get("options")) if pr else []:
        o = as_dict(o) if not isinstance(o, dict) else o
        if str(o.get("value")) in selected:
            chosen.append("%s: %s [kind %s, nets %s%s] (%s)" % (o.get("value"), o.get("label"), o.get("kind", "?"), ", ".join(as_list(o.get("nets"))), (", serves idea " + str(o.get("ideaId"))) if o.get("ideaId") else "", str(o.get("description", ""))[:400]))
    all_specs = query(P["specs"], "FROM $", 300)
    spec_id = "spec-%03d" % (len(all_specs) + 1)
    choice = "## THE DECISION THIS SPEC IMPLEMENTS\nThe Steward asked (%s, mode %s): %s\n" % (prompt_id, pr.get("mode", "?"), pr.get("question", "?"))
    choice += "The person chose:\n%s\n" % (lines(chosen) if chosen else "- (no option selected)")
    if text:
        choice += "The person wrote: %s\n" % text[:2000]
    if notes:
        choice += "Notes: %s\n" % notes[:1000]
    brief = "\n".join([
        "# BRIEF FOR THE STEWARD: write the change spec",
        "iterationId: %s\npromptId: %s\nspecId to use: %s\nnow: %s\nmodel: %s" % (iteration_id, prompt_id, spec_id, now(), MODEL),
        choice, charter_txt, GRAMMAR, ideas_section(for_spec=True), health_section(), lanes_section(), map_section(), pack_section(), brain_sections(for_spec=True), history_section(),
    ])
    data = {"at": now(), "iterationId": iteration_id, "purpose": "spec", "promptId": prompt_id, "specId": spec_id, "goalStatus": goal_status, "selected": selected, "responseText": text, "brief": brief[:22000]}
    put_token(P["context"], data, name="ctx-spec-%s" % spec_id)
    put_token(P["responses"], {"at": now(), "promptId": prompt_id, "iterationId": iteration_id, "intent": "answered", "selected": selected, "text": text, "notes": notes, "specId": spec_id, "by": "steward"}, name="receipt-%s" % prompt_id)
    journal(LANE, "context", "spec brief %s for %s from %s (%s)" % (spec_id, iteration_id, prompt_id, ", ".join(selected) or "free text"), iterationId=iteration_id)
    return {"success": True, "specId": spec_id, "chosen": selected, "chars": len(brief)}


def main(argv):
    if len(argv) < 3 or argv[0] != "context":
        raise RuntimeError("usage: steward-context.py context propose|spec <iterationId> [<promptId>]")
    mode, iteration_id = argv[1], argv[2]
    if iteration_id.startswith("${") or not iteration_id:
        iteration_id = "it-%s" % stamp()
    if mode == "propose":
        return propose(iteration_id)
    if mode == "spec":
        prompt_id = argv[3] if len(argv) > 3 and not argv[3].startswith("${") else envv("PROMPT_ID")
        return spec(iteration_id, prompt_id)
    raise RuntimeError("unknown mode %s" % mode)


if __name__ == "__main__":
    sys.exit(main_guard(LANE, main, sys.argv[1:]))
