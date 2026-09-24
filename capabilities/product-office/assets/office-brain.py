#!/usr/bin/env python3
"""office-brain: the curated, bounded model of what the product office knows about the model it lives in.

usage: office-brain.py observe <runId|latest> [next]   collect the signals of a released run, brief the curator
       office-brain.py curate <signalId>               curate headless (the configured agent, read-only in the pack repo)
       office-brain.py apply <curationId>              apply a curation: facts, plan, decisions, questions, next iteration
       office-brain.py answer <promptId>               record the person's answer to a brain question as a fact
"""
import json
import os
import re
import sys

# >>> shared: officelib (generated, do not edit here)
"""Shared library for the Product office scripts. Inlined into every product-office-*.py by
tools/inline-shared.py (the executor runs each script as ONE file). Edit here, then re-inline.

The Product office is a persona whose job is the model it lives in. Every lane measures through master
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
OFFICE_HOME = os.path.expanduser(os.environ.get("OFFICE_HOME", "~/product-office"))
PACK_NAME = "product-office"

P = {
    "charter": "p-product-charter", "coders": "p-product-coders", "teams": "p-product-teams", "inbox": "p-product-inbox", "status": "p-product-status",
    "prompts": "p-product-prompts", "responses": "p-product-responses", "iterate": "p-product-iterate", "roadmap": "p-product-roadmap", "decisions": "p-product-decisions",
    "setup_cmd": "p-product-setup-cmd", "setup_log": "p-product-setup-log", "infra": "p-product-infra",
    "plan_cmd": "p-product-plan-cmd", "plan_log": "p-product-plan-log", "context": "p-product-context",
    "digest_cmd": "p-product-digest-cmd", "digest": "p-product-digest",
    "journal": "p-product-journal", "errors": "p-product-errors", "llm_errors": "p-product-llm-errors",
    "brain_cmd": "p-product-brain-cmd", "brain_log": "p-product-brain-log", "signals": "p-product-signals", "curation": "p-product-curation", "curations": "p-product-curations",
    "knowledge": "p-product-knowledge", "plan": "p-product-plan", "adr": "p-product-adr", "specs": "p-product-specs", "ideas": "p-product-ideas",
}
# the protected set of the product office: what governs it is never changed by a team or a spec
PROTECTED_PLACES = [P["charter"], P["coders"], P["prompts"], P["responses"], P["decisions"], P["teams"]]
PROTECTED_LANES = ["t-office-infra-tick", "t-office-setup-cmd", "t-office-iterate-prep", "t-office-plan-cmd", "t-office-plan", "t-office-answer-prep", "t-office-revise-prep",
                   "t-office-digest-cron", "t-office-digest-cmd", "t-office-brain-observe-cmd", "t-office-curate", "t-office-curate-cmd", "t-office-apply-prep", "t-office-brain-apply-cmd", "t-office-answer-knowledge-prep"]
REQUIRED_APP_STORES = ["charter", "coders", "teams", "inbox", "status", "prompts", "responses", "roadmap", "journal"]
REQUIRED_APP_ACTIONS = ["set-charter", "respond", "start-iteration", "check-infra", "provision", "add-idea"]


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
    return latest(P["charter"], "updatedAt", 'FROM $ WHERE $.charterId == "office"') or latest(P["charter"], "updatedAt")


def goal_defined(c=None):
    c = c or charter()
    title = str(c.get("goal", "") or c.get("title", ""))
    return bool(title.strip()) and "REPLACE" not in title.upper()


def autonomy(c=None):
    return max(1, min(5, as_int((c or charter()).get("autonomyLevel"), 3)))


def scope_nets(c=None):
    """Nets the Product office may touch: the charter's list, or the pack's own nets when the list is empty."""
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
    """True while a planning iteration is in flight: a trigger, a brief, or an unanswered question."""
    if count(P["iterate"]) > 0 or count(P["context"]) > 0:
        return True
    answered = {str((t.get("data") or {}).get("promptId")) for t in query(P["responses"], "FROM $", 300)}
    return bool(open_prompts(answered, set()))


def start_iteration(reason, requested_by):
    """Start the next iteration unless one is in flight; returns the iteration id or ''."""
    if loop_busy():
        return ""
    it = "it-%s" % stamp()
    put_token(P["iterate"], {"at": now(), "iterationId": it, "reason": reason, "requestedBy": requested_by}, name=it)
    return it


def pack_lane_ids():
    """The pack's lanes as the runtime knows them: (transitionId, status) for every t-office-* lane."""
    listed = mcp("list_transitions", {})
    rows = as_list(listed.get("transitions")) if isinstance(listed, dict) else as_list(listed)
    out = []
    for t in rows:
        t = as_dict(t) if not isinstance(t, dict) else t
        tid = str(t.get("transitionId") or t.get("id") or "")
        if tid.startswith("t-office-"):
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


def office_home(c=None):
    home = os.path.expanduser(str((c or {}).get("home") or OFFICE_HOME))
    os.makedirs(home, exist_ok=True)
    return home


def pack_dir(c=None):
    """The pack's compact sources inside the repository checkout: <repo>/<packDir>."""
    c = c or charter()
    rp = repo()
    root = str(rp.get("localPath") or os.path.join(office_home(c), "agentic-nets"))
    return os.path.join(root, str(c.get("packDir") or "capabilities/office")), root


def git(args, cwd, timeout=300, check=True):
    cmd = ["git", "-c", "user.name=Product office", "-c", "user.email=office@localhost"] + list(args)
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
    t = os.environ.get("OFFICE_MCP_TOKEN", "").strip()
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
        raise RuntimeError("no MCP token: provision the Product office (setup) or set OFFICE_MCP_TOKEN")
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
    """A headless agent: a definition token from p-product-coders chosen by cfg[agent_key], with
    charter overrides for model, tools, turns and timeout. Falls back to the built-in Claude Code."""
    defs = {}
    for t in query(P["coders"], "FROM $", 20):
        d = t.get("data") or {}
        if d.get("agentId"):
            defs[d["agentId"]] = d
    agent_id = str(cfg.get(agent_key) or "claude-code")
    a = defs.get(agent_id) or (BUILTIN_CLAUDE if agent_id == "claude-code" else None)
    if not a:
        raise RuntimeError("agent '%s' is not defined in p-product-coders (known: %s)" % (agent_id, ", ".join(sorted(defs)) or "none"))
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


def run_headless(prompt, root, cfg, agent, result_key="OFFICE_RESULT"):
    env = {k: v for k, v in os.environ.items() if k not in ("CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT")}
    env["OFFICE_MCP_TOKEN"] = ""  # the coder never sees the runtime's token; it gets its own MCP client if configured
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
# <<< shared: officelib

LANE = "t-office-brain-observe-cmd"
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
    """A release a team pushed into the office's status place (kind release), by its runId or the newest."""
    rows = [t.get("data") or {} for t in query(P["status"], 'FROM $ WHERE $.kind == "release"', 200)]
    rows.sort(key=lambda r: str(r.get("at", "")), reverse=True)
    if run_id in ("latest", "") or run_id.startswith("${"):
        if not rows:
            raise RuntimeError("no team has reported a release yet")
        r = rows[0]
    else:
        r = next((x for x in rows if str(x.get("runId")) == run_id), None)
        if not r:
            raise RuntimeError("release %s not found in the status place" % run_id)
    return {
        "signalId": "sig-%s" % r.get("runId", stamp()), "runId": r.get("runId", ""), "service": r.get("service", ""), "specId": r.get("specId", ""), "requirementId": r.get("requirementId", ""),
        "title": r.get("title", ""), "at": now(), "releasedAt": r.get("at", ""), "branch": r.get("branch", ""), "mergedSha": r.get("mergedSha", ""),
        "coderSummary": str(r.get("coderSummary", ""))[:1500], "coderNotes": str(r.get("coderNotes", ""))[:1500], "coderAgent": r.get("coderAgent", ""), "coderModel": r.get("coderModel", ""),
        "verification": r.get("verification", {}), "review": r.get("review", {}), "audit": r.get("audit", ""), "summary": str(r.get("summary", ""))[:600],
    }


def curation_brief(sig, m):
    c = charter()
    teams = [t.get("data") or {} for t in query(P["teams"], "FROM $", 50)]
    lines = [
        "# BRIEF FOR THE PRODUCT OFFICE'S BRAIN: curate what the product knows after a team's release",
        "signalId: %s\nrunId: %s\ncurationId to use: cur-%s\nnow: %s" % (sig["signalId"], sig["runId"], sig["runId"], now()),
        "## PRODUCT GOAL\n%s\n%s\n\n## PRINCIPLES\n%s" % (c.get("goal", ""), str(c.get("description", ""))[:1200], "\n".join("- " + p for p in as_list(c.get("principles")))),
        "## TEAMS\n%s" % ("\n".join("- %s (session %s)" % (t.get("service"), t.get("session")) for t in teams) or "- none"),
        "## WHAT TEAM %s RELEASED: %s (%s, requirement %s)\nbranch %s merged as %s at %s\nsummary: %s\ncoder (%s / %s): %s\nnotes: %s\nverification: %s\nreview: %s\naudit: %s" % (
            sig.get("service"), sig.get("title"), sig.get("specId"), sig.get("requirementId"), sig.get("branch"), str(sig.get("mergedSha", ""))[:7], sig.get("releasedAt"), sig.get("summary"),
            sig.get("coderAgent"), sig.get("coderModel"), sig.get("coderSummary"), sig.get("coderNotes"), json.dumps(sig.get("verification"))[:600], json.dumps(sig.get("review"))[:400], sig.get("audit")),
        "## CURRENT KNOWLEDGE (active facts; retire what is now wrong or subsumed, never retire an answer)\n" + knowledge_text(),
        "## CURRENT PLAN (across teams; every increment names its service)\n" + plan_text(),
        "## DECISIONS ON RECORD\n" + ("\n".join("- %s [%s] %s: %s" % (a.get("adrId"), a.get("status"), a.get("title"), str(a.get("decision", ""))[:160]) for a in adrs()) or "- none"),
    ]
    return "\n\n".join(lines)[:16000]


def observe(argv):
    c = charter()
    sig = signal_for(argv[1] if len(argv) > 1 else "latest")
    sig["startIteration"] = "true" if (envv("START_ITERATION") == "true" or (len(argv) > 2 and argv[2] == "next")) else "false"
    m = {}
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
        put_token(P["brain_cmd"], command_token("office-brain", ["curate", sig["signalId"]], stage="curate", timeout_ms=1800000, signalId=sig["signalId"], runId=sig["runId"]), name="curate-%s" % sig["runId"])
        route = "headless %s" % brain_agent
    journal(LANE, "observe", "signals of %s (%s) collected; curation routed to the %s" % (sig["specId"], sig["runId"], route), runId=sig["runId"])
    return {"success": True, "signalId": sig["signalId"], "route": route, "briefChars": len(brief)}


CONTRACT = ('Reply with exactly this shape and nothing else: {"curationId": "<from the brief>", "runId": "<from the brief>", '
            '"addFacts": [{"kind": "platform|convention|decision|gap|risk|question", "scope": "project|platform", "text": "<one specific, checkable sentence>", '
            '"source": "<runId, specId, lane id or file>", "confidence": "high|medium|low"}], "retireFacts": ["<factId>"], '
            '"plan": {"increments": [{"id": "inc-1", "title": "<one line>", "service": "<team service>", "status": "planned|in-progress|released|dropped", "dependsOn": ["inc-0"], "specId": "<specId or empty>"}]}, '
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
    m = {}
    prompt = "\n\n".join([
        "You are the product office's brain, curating what the model knows after one released change. You may read the pack repository in the current directory to verify anything in the brief. Do not change any file.",
        curation_brief(sig, m), RULES, CONTRACT])
    agent = resolve_agent(c, "brainAgent", "brainModel")
    res = run_headless(prompt, str(rp.get("localPath") or office_home(c)), c, agent)
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
    journal("t-office-curate-cmd", "curate", "headless curation by %s/%s for %s: %d facts, %d retired, %d decisions, %d questions (%ss)" % (
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
                             "status": "proposed", "updatedAt": now(), "source": curation_id, "proposedBy": "office"}, name=adr_id)
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
        put_token(P["iterate"], {"at": now(), "iterationId": started, "reason": "released", "specId": sig.get("specId", ""), "requestedBy": "office"}, name=started)
        for t in query(P["signals"], 'FROM $ WHERE $.runId == "%s" LIMIT 5' % run_id, 5):
            d = t.get("data") or {}; d["iterationStarted"] = started
            delete_token(P["signals"], t["id"]); put_token(P["signals"], d, name="%s-done" % d.get("signalId", run_id))
    journal("t-office-brain-apply-cmd", "apply", "curation %s applied: +%d facts (%d skipped: %s), %d retired, plan %s, %d decisions proposed, %d questions, %d ideas%s; %s" % (
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
    journal("t-office-brain-apply-cmd", "answer", "the person answered %s; recorded as %s" % (prompt_id, fid), promptId=prompt_id)
    return {"success": True, "factId": fid}


def main(argv):
    if not argv:
        raise RuntimeError("usage: office-brain.py observe|curate|apply|answer ...")
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
