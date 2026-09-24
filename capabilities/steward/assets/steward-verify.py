#!/usr/bin/env python3
"""steward-verify: proves a built pack version before it is released, and rolls back when it fails.

usage: steward-verify.py verify <runId>
Checks, in order: the protected lanes' inscriptions are unchanged against the base branch and the
protected places still exist; the application manifest keeps the required stores and actions; the
artifact parses and carries the run's version. Then it publishes the artifact to the runtime's
hub, installs it into the model, lints every touched lane through the MCP and takes a smoke
observation (every pack lane deployed, no new fire errors). Pass queues the release; fail installs
the previous version again and records the rollback.
"""
import json
import os
import sys
import time

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

LANE = "t-steward-verify-cmd"


def run_by_id(run_id):
    r = one(P["runs"], 'FROM $ WHERE $.runId == "%s" LIMIT 1' % run_id)
    if not r:
        raise RuntimeError("run %s not found" % run_id)
    return r


def inscriptions_of(text):
    """Every transition inscription in a compiled .inscriptions.json, keyed by transition id."""
    try:
        d = json.loads(text) if text.strip() else {}
    except ValueError:
        return {}
    out = {}
    items = d.get("inscriptions") if isinstance(d, dict) and isinstance(d.get("inscriptions"), (list, dict)) else d
    if isinstance(items, dict):
        for k, v in items.items():
            if isinstance(v, dict):
                out[str(v.get("id") or k)] = v
    elif isinstance(items, list):
        for v in items:
            if isinstance(v, dict) and (v.get("id") or v.get("transitionId")):
                out[str(v.get("id") or v.get("transitionId"))] = v
    return out


def stable(v):
    return json.dumps(v, sort_keys=True, separators=(",", ":"))


def protected_unchanged(root, pack_rel, base):
    """Compare the compiled inscriptions of the protected lanes and the presence of the protected
    places between the base branch and the working tree."""
    problems = []
    pack = os.path.join(root, pack_rel)
    base_ins, head_ins, head_places = {}, {}, set()
    for f in sorted(walk_files(os.path.join(pack, "nets"), (".inscriptions.json",))):
        rel = os.path.relpath(f, root)
        head_ins.update(inscriptions_of(read_text(f, 2000000)))
        rc, o, _ = run(["git", "show", "%s:%s" % (base, rel)], cwd=root, check=False)
        if rc == 0:
            base_ins.update(inscriptions_of(o))
    for f in sorted(walk_files(os.path.join(pack, "nets"), (".pnml.json",))):
        net = (read_json(f) or {}).get("net") or {}
        head_places |= set((net.get("places") or {}).keys())
    for tid in PROTECTED_LANES:
        if tid in base_ins and tid not in head_ins:
            problems.append("protected lane %s was removed" % tid)
        elif tid in base_ins and stable(base_ins[tid]) != stable(head_ins.get(tid)):
            problems.append("protected lane %s was re-inscribed" % tid)
    for pid in PROTECTED_PLACES:
        if pid not in head_places:
            problems.append("protected place %s no longer exists in any net" % pid)
    seed = os.path.join(pack, "seeds", "p-steward-charter.json")
    rc, o, _ = run(["git", "diff", "--quiet", base, "--", os.path.relpath(seed, root)], cwd=root, check=False)
    if rc != 0:
        problems.append("the charter seed was changed")
    return problems


def manifest_invariants(pack):
    m = read_json(os.path.join(pack, "app", "agenticos.app.json")) or {}
    app = m.get("application") or {}
    roles = {s.get("role") for s in as_list(app.get("stores")) if isinstance(s, dict)}
    actions = {a.get("name") for a in as_list(app.get("actions")) if isinstance(a, dict)}
    problems = []
    for r in REQUIRED_APP_STORES:
        if r not in roles:
            problems.append("app store '%s' is missing" % r)
    for a in REQUIRED_APP_ACTIONS:
        if a not in actions:
            problems.append("app action '%s' is missing" % a)
    return problems, m.get("version", "")


def publish(artifact_path):
    art = read_json(artifact_path)
    if not isinstance(art, dict):
        raise RuntimeError("artifact %s does not parse" % artifact_path)
    name = (art.get("manifest") or {}).get("name") or PACK_NAME
    version = (art.get("manifest") or {}).get("version") or ""
    r = api("PUT", "/api/hub/capabilities/%s/versions/%s" % (name, version), art, timeout=120)
    return name, version, r


def install(name, version, allow_downgrade=False):
    body = {"source": "local", "name": name, "version": version, "targetModelId": MODEL}
    if allow_downgrade:
        body["allowDowngrade"] = True  # the hub refuses to install an older version unless asked explicitly
    return api("POST", "/api/hub/install", body, timeout=300)


def pack_lanes(artifact_path):
    art = read_json(artifact_path) or {}
    ids = set()
    for key in ("inscriptions", "transitions"):
        v = art.get(key)
        if isinstance(v, dict):
            ids |= {str(k) for k in v.keys()}
        elif isinstance(v, list):
            ids |= {str(x.get("id") or x.get("transitionId")) for x in v if isinstance(x, dict) and (x.get("id") or x.get("transitionId"))}
    for net in as_list(art.get("nets")):
        net = as_dict(net) if not isinstance(net, dict) else net
        ins_map = net.get("inscriptions")
        if isinstance(ins_map, dict):  # the artifact keys inscriptions by transition id
            ids |= {str(k) for k, v in ins_map.items() if not (isinstance(v, dict) and v.get("kind") == "link")}
            continue
        for ins in as_list(ins_map):
            ins = as_dict(ins) if not isinstance(ins, dict) else ins
            if ins.get("id") or ins.get("transitionId"):
                ids.add(str(ins.get("id") or ins.get("transitionId")))
        for tid in ((net.get("pnml") or {}).get("net") or {}).get("transitions", {}) if isinstance(net.get("pnml"), dict) else []:
            ids.add(str(tid))
    return ids


def smoke(touched, expected_lanes):
    checks, ok = [], True
    time.sleep(12)
    rearmed = rearm_starting()
    if rearmed:
        checks.append("re-armed %d lane(s) left in STARTING by the installer" % len(rearmed))
        time.sleep(3)
    stats = mcp("net_stats", {"window": 200})
    running = set(str(x) for x in as_list((stats.get("transitions") or {}).get("running")))
    not_running = {str((as_dict(x) if not isinstance(x, dict) else x).get("transitionId")): (as_dict(x) if not isinstance(x, dict) else x).get("status") for x in as_list((stats.get("transitions") or {}).get("notRunning"))}
    missing = sorted(t for t in expected_lanes if t not in running and not_running.get(t) not in ("DEPLOYED", "RUNNING"))
    errored = sorted(t for t, st in not_running.items() if st == "ERROR")
    if missing:
        ok = False; checks.append("lanes not running after install: %s" % ", ".join(missing[:10]))
    else:
        checks.append("all %d pack lanes running or deployed" % len(expected_lanes))
    if errored:
        ok = False; checks.append("lanes in ERROR: %s" % ", ".join(errored[:10]))
    for tid in sorted({str(t) for t in touched if str(t).startswith("t-")})[:8]:
        try:
            v = mcp("verify_inscription", {"transitionId": tid})
            errs = [e for e in as_list(v.get("errors") or v.get("problems")) if isinstance(e, (str, dict))]
            warns = as_list(v.get("warnings"))
            if errs:
                ok = False; checks.append("lint %s: %s" % (tid, json.dumps(errs)[:200]))
            else:
                checks.append("lint %s: ok%s" % (tid, (" (%d warning(s))" % len(warns)) if warns else ""))
        except Exception as e:  # noqa: BLE001
            checks.append("lint %s: not checked (%s)" % (tid, str(e)[:120]))
    return ok, checks


def verify(run_id):
    c = charter()
    r = run_by_id(run_id)
    rp = repo()
    root = str(rp.get("localPath"))
    pack_rel = str(c.get("packDir") or "capabilities/steward")
    pack = os.path.join(root, pack_rel)
    base = str(r.get("base") or rp.get("branch") or "main")
    git(["checkout", "-q", r.get("branch", "")], cwd=root, check=False)
    replace_token(P["runs"], "runId", run_id, {"status": "verifying"}, name="run-%s" % run_id)
    checks, ok = [], True
    probs = protected_unchanged(root, pack_rel, base)
    checks += (["protected set: " + p for p in probs] or ["protected set unchanged"]); ok = ok and not probs
    mprobs, mversion = manifest_invariants(pack)
    checks += (["manifest: " + p for p in mprobs] or ["manifest keeps the configuration tab and the pause action"]); ok = ok and not mprobs
    artifact = str(r.get("artifact") or "")
    art = read_json(artifact) if artifact else None
    if not isinstance(art, dict):
        ok = False; checks.append("artifact missing or unreadable: %s" % artifact)
    else:
        av = (art.get("manifest") or {}).get("version", "")
        if av != r.get("packVersion"):
            ok = False; checks.append("artifact version %s differs from the run's %s" % (av, r.get("packVersion")))
        else:
            checks.append("artifact %s@%s parses" % ((art.get("manifest") or {}).get("name"), av))
    installed, published = "", ""
    if ok:
        try:
            name, version, pr = publish(artifact)
            published = version; checks.append("published %s@%s to the hub" % (name, version))
            ir = install(name, version)
            installed = version; checks.append("installed %s@%s into %s (%s)" % (name, version, MODEL, str((ir or {}).get("upgrade") or (ir or {}).get("kind") or "ok")[:80]))
        except Exception as e:  # noqa: BLE001
            ok = False; checks.append("publish/install failed: %s" % str(e)[:300])
    if ok:
        spec = one(P["specs"], 'FROM $ WHERE $.specId == "%s" LIMIT 1' % r.get("specId", ""))
        lanes = pack_lanes(artifact) or set(PROTECTED_LANES)
        sok, schecks = smoke(as_list(spec.get("touches")) + as_list(r.get("coderTouched")), lanes)
        ok = ok and sok; checks += schecks
    status = "pass" if ok else "fail"
    ver = {"at": now(), "runId": run_id, "specId": r.get("specId", ""), "packVersion": r.get("packVersion", ""), "status": status, "checks": checks, "installed": installed}
    put_token(P["verification"], ver, name="verification-%s" % run_id)
    if ok:
        replace_token(P["runs"], "runId", run_id, {"status": "verified", "verifiedAt": now()}, name="run-%s" % run_id)
        put_token(P["release_cmd"], command_token("steward-release", ["release", run_id], stage="release", timeout_ms=900000, runId=run_id, specId=r.get("specId", "")), name="release-%s" % run_id)
        journal(LANE, "verify", "%s PASS: %s" % (run_id, "; ".join(checks)[:400]), runId=run_id, specId=r.get("specId", ""))
        return {"success": True, "runId": run_id, "checks": checks}
    # roll back: the previous version is the rollback
    rolled = ""
    if installed and r.get("previousVersion"):
        try:
            install(PACK_NAME, str(r["previousVersion"]), allow_downgrade=True); rolled = str(r["previousVersion"]); checks.append("rolled back to %s" % rolled)
            before = set(as_list(r.get("lanesBefore")))
            extra = [tid for tid, _ in pack_lane_ids() if before and tid not in before]
            if extra:
                checks.append("removed the lanes the failed version added: %s" % ", ".join(remove_lanes(extra)))
            rearmed = rearm_starting()
            if rearmed:
                checks.append("re-armed %d lane(s) after the rollback" % len(rearmed))
        except Exception as e:  # noqa: BLE001
            checks.append("ROLLBACK FAILED: %s" % str(e)[:300])
    git(["checkout", "-q", base], cwd=root, check=False)
    replace_token(P["runs"], "runId", run_id, {"status": "rolled-back" if (rolled or not installed) else "failed", "verifiedAt": now(), "rolledBackTo": rolled}, name="run-%s" % run_id)
    replace_token(P["specs"], "specId", r.get("specId", ""), {"status": "rolled-back"}, name="spec-%s" % r.get("specId", ""))
    replace_token(P["verification"], "runId", run_id, {"checks": checks, "rolledBackTo": rolled}, name="verification-%s" % run_id)
    it = start_iteration("rolled-back-%s" % run_id, "steward-verify")
    journal(LANE, "verify", "%s FAIL: %s; %s" % (run_id, "; ".join(checks)[:400], ("next iteration %s started" % it) if it else "an iteration is already in flight"), runId=run_id, specId=r.get("specId", ""))
    return {"success": False, "runId": run_id, "checks": checks, "rolledBackTo": rolled}


def main(argv):
    if len(argv) >= 2 and argv[0] == "verify":
        return verify(argv[1] if not argv[1].startswith("${") else envv("RUN_ID"))
    raise RuntimeError("usage: steward-verify.py verify <runId>")


if __name__ == "__main__":
    sys.exit(main_guard(LANE, main, sys.argv[1:]))
