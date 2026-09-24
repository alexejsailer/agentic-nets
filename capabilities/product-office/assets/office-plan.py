#!/usr/bin/env python3
"""office-plan: the product manager's brief and the allocation of an iteration to a team.

usage: office-plan.py brief <iterationId>                    render the planning brief (context purpose plan)
       office-plan.py allocate <iterationId> <promptId>      the person's answer: allocate to a team, record the roadmap item
Env for allocate: RESPONSE_SELECTED (JSON list), RESPONSE_TEXT, RESPONSE_NOTES. Env for brief: REVISION_TEXT (a reshaped question).
"""
import json
import os
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

LANE = "t-office-plan-cmd"


def lines(items, limit=12, prefix="- "):
    o = [prefix + str(it) for it in items[:limit]]
    return "\n".join(o) if o else "- (none)"


def teams():
    rows = [t.get("data") or {} for t in query(P["teams"], "FROM $", 50)]
    rows.sort(key=lambda t: str(t.get("service", "")))
    return rows


def status_by_service():
    out = {}
    for t in query(P["status"], "FROM $", 300):
        d = t.get("data") or {}
        s = str(d.get("service", ""))
        if s and str(d.get("at", "")) >= str(out.get(s, {}).get("at", "")):
            out[s] = d
    return out


def open_inbox():
    rows = [t.get("data") or {} for t in query(P["inbox"], 'FROM $ WHERE $.status == "open"', 200)]
    rows.sort(key=lambda i: str(i.get("at", "")))
    return rows


def charter_section(c):
    defined = goal_defined(c)
    txt = "## PRODUCT: %s\n" % c.get("product", "")
    txt += ("The product goal is NOT DEFINED yet (placeholder). Ask for it first.\n" if not defined else "## GOAL\n%s\n%s\n" % (c.get("goal", ""), c.get("description", "")))
    txt += "\n## PRINCIPLES\n%s\n" % lines(as_list(c.get("principles")))
    cons = as_list(c.get("constraints"))
    if cons:
        txt += "\n## CONSTRAINTS\n%s\n" % lines(cons)
    txt += "\n## SERVICES the product consists of (a team may exist for each)\n%s\n" % lines(as_list(c.get("services")) or ["(none listed in the charter yet)"])
    return txt, ("defined" if defined else "undefined")


def teams_section():
    rows = teams()
    st = status_by_service()
    if not rows:
        return "## TEAMS\n- none registered yet: a service-team pack must be installed and provisioned per service before an iteration can be allocated\n"
    txt = "## TEAMS (registered; only these can receive an iteration)\n"
    for t in rows:
        s = st.get(str(t.get("service")), {})
        txt += "- %s (session %s): status %s; %s\n" % (t.get("service"), t.get("session"), s.get("phase", "no status yet"), str(s.get("summary", ""))[:300])
    return txt


def inbox_section():
    rows = open_inbox()
    if not rows:
        return "## OPEN INBOX\n- nothing waits for the person\n"
    return "## OPEN INBOX (waiting for the person)\n" + "\n".join("- [%s/%s] %s: %s" % (i.get("service"), i.get("persona"), i.get("kind"), str(i.get("title", ""))[:160]) for i in rows[:20]) + "\n"


def roadmap_section():
    rows = [t.get("data") or {} for t in query(P["roadmap"], "FROM $", 200)]
    rows.sort(key=lambda r: str(r.get("at", "")), reverse=True)
    if not rows:
        return "## ROADMAP SO FAR\n- (empty)\n"
    return "## ROADMAP SO FAR (newest first)\n" + "\n".join("- %s [%s] %s: %s (%s)" % (r.get("itemId"), r.get("status"), r.get("service"), str(r.get("direction", ""))[:160], str(r.get("at", ""))[:10]) for r in rows[:15]) + "\n"


def brain_sections():
    facts = [t.get("data") or {} for t in query(P["knowledge"], 'FROM $ WHERE $.status == "active"', 200)]
    facts.sort(key=lambda f: str(f.get("factId", "")))
    plan = latest(P["plan"], "at")
    txt = "## WHAT THE OFFICE KNOWS\n" + ("\n".join("- [%s] %s" % (f.get("kind"), str(f.get("text", ""))[:220]) for f in facts[:25]) or "- nothing curated yet") + "\n"
    if plan:
        txt += "\n## THE PLAN (curated)\n" + "\n".join("- %s [%s] %s%s" % (i.get("id"), i.get("status"), str(i.get("title", ""))[:120], (" (" + str(i.get("service")) + ")") if i.get("service") else "") for i in [as_dict(x) if not isinstance(x, dict) else x for x in as_list(plan.get("increments"))][:15]) + "\n"
    ads = adrs("accepted")
    if ads:
        txt += "\n## ACCEPTED DECISIONS\n" + "\n".join("- %s %s: %s" % (a.get("adrId"), a.get("title"), str(a.get("decision", ""))[:160]) for a in ads[:10]) + "\n"
    return txt


def ideas_section():
    rows = [t.get("data") or {} for t in query(P["ideas"], 'FROM $ WHERE $.status == "open"', 100)]
    rows.sort(key=lambda i: str(i.get("at", "")))
    if not rows:
        return "## OPEN IDEAS\n- none\n"
    return "## OPEN IDEAS (serve them before inventing; an option that serves one carries its ideaId)\n" + "\n".join("- %s [%s]: %s" % (i.get("ideaId"), i.get("by"), str(i.get("text", ""))[:300]) for i in rows[:10]) + "\n"


def brief(iteration_id):
    c = charter()
    charter_txt, goal_status = charter_section(c)
    earlier = query(P["prompts"], 'FROM $ WHERE $.iterationId == "%s" LIMIT 50' % iteration_id, 50)
    prompt_id = "pr-%s-%d" % (iteration_id, len(earlier) + 1)
    txt = "\n".join([
        "# BRIEF FOR THE PRODUCT MANAGER: what does the product do next?",
        "iterationId: %s\npromptId to use: %s\nnow: %s\nmodel: %s" % (iteration_id, prompt_id, now(), MODEL),
        charter_txt, teams_section(), inbox_section(), roadmap_section(), brain_sections(), ideas_section(),
    ])
    revision = envv("REVISION_TEXT")
    if revision:
        txt += "\n## THE PERSON RESHAPED THE LAST QUESTION\n%s\nAsk again, taking this into account.\n" % revision[:1500]
    goal_note = envv("GOAL_NOTE")
    if goal_note:
        txt += "\n## THE PERSON JUST DEFINED THE GOAL\n%s\nDo not ask for the goal again: propose the next step as a choice.\n" % goal_note[:2000]
    put_token(P["context"], {"at": now(), "iterationId": iteration_id, "purpose": "plan", "promptId": prompt_id, "goalStatus": goal_status, "brief": txt[:20000]}, name="ctx-plan-%s-%d" % (iteration_id, len(earlier) + 1))
    journal(LANE, "brief", "planning brief for %s: goal %s, %d team(s), %d chars" % (iteration_id, goal_status, len(teams()), len(txt)), iterationId=iteration_id)
    return {"success": True, "iterationId": iteration_id, "promptId": prompt_id, "chars": len(txt)}


def allocate(iteration_id, prompt_id):
    c = charter()
    pr = one(P["prompts"], 'FROM $ WHERE $.promptId == "%s" LIMIT 1' % prompt_id)
    selected = as_list(envv("RESPONSE_SELECTED"))
    text = envv("RESPONSE_TEXT")
    notes = envv("RESPONSE_NOTES")
    put_token(P["responses"], {"at": now(), "promptId": prompt_id, "iterationId": iteration_id, "intent": "answered", "selected": selected, "text": text, "notes": notes, "by": "office"}, name="receipt-%s" % prompt_id)
    for t in query(P["inbox"], 'FROM $ WHERE $.promptId == "%s" LIMIT 5' % prompt_id, 5):
        d = t.get("data") or {}; d["status"] = "done"; d["doneAt"] = now()
        delete_token(P["inbox"], t["id"]); put_token(P["inbox"], d, name="%s-done" % d.get("itemId", prompt_id))
    if str(pr.get("mode")) == "goal":
        os.environ["GOAL_NOTE"] = "%s\n%s" % (c.get("goal", ""), text)
        journal(LANE, "allocate", "the product goal was defined in %s; asking for the first roadmap step" % prompt_id, iterationId=iteration_id)
        return brief(iteration_id)
    chosen = None
    for o in as_list(pr.get("options")):
        o = as_dict(o) if not isinstance(o, dict) else o
        if str(o.get("value")) in selected:
            chosen = o; break
    if str(pr.get("mode")) == "interview" or not chosen:
        # answers to an interview, or free text: they become the next brief's context
        os.environ["REVISION_TEXT"] = ("The person answered: %s%s" % (text[:1500], (" Notes: " + notes[:300]) if notes else "")).strip()
        journal(LANE, "allocate", "%s answered without a choice; re-briefing with the answer" % prompt_id, iterationId=iteration_id)
        return brief(iteration_id)
    service = str(chosen.get("service") or "").strip()
    kind = str(chosen.get("kind") or "allocate")
    item_id = "rm-%s" % stamp()
    team = one(P["teams"], 'FROM $ WHERE $.service == "%s" LIMIT 1' % service) if service else {}
    if kind == "install-team" or not team:
        put_token(P["roadmap"], {"itemId": item_id, "at": now(), "iterationId": iteration_id, "promptId": prompt_id, "service": service, "kind": "install-team", "direction": chosen.get("direction", chosen.get("label", "")), "status": "waiting-for-team", "by": "person"}, name=item_id)
        put_token(P["inbox"], {"itemId": "inbox-%s" % item_id, "service": service, "persona": "office", "kind": "action", "title": "Install and provision the %s team (service-team pack, session %s), then this roadmap item continues" % (service or "?", service or "?"), "status": "open", "at": now(), "roadmapId": item_id}, name="inbox-%s" % item_id)
        journal(LANE, "allocate", "%s: team %s is not registered; roadmap item %s waits for the install" % (prompt_id, service, item_id), iterationId=iteration_id)
        return {"success": True, "roadmapId": item_id, "waitingForTeam": service}
    places = as_dict(team.get("places"))
    iterate_place = str(places.get("iterate") or "")
    if not iterate_place:
        raise RuntimeError("team %s registered without an iterate place" % service)
    team_it = "it-%s-%s" % (service, stamp())
    put_token(P["roadmap"], {"itemId": item_id, "at": now(), "iterationId": iteration_id, "promptId": prompt_id, "service": service, "kind": "allocate", "direction": chosen.get("direction", chosen.get("label", "")),
                             "notes": notes, "teamIteration": team_it, "status": "allocated", "by": "person"}, name=item_id)
    put_token(iterate_place, {"at": now(), "iterationId": team_it, "reason": "office:%s" % item_id, "requestedBy": "product-office", "direction": str(chosen.get("direction") or chosen.get("label") or ""), "notes": notes, "roadmapId": item_id}, name=team_it)
    journal(LANE, "allocate", "%s -> team %s: iteration %s (%s)" % (prompt_id, service, team_it, str(chosen.get("direction") or chosen.get("label", ""))[:120]), iterationId=iteration_id, roadmapId=item_id)
    return {"success": True, "roadmapId": item_id, "service": service, "teamIteration": team_it}


def main(argv):
    if len(argv) >= 2 and argv[0] == "brief":
        return brief(argv[1] if not argv[1].startswith("${") else envv("ITERATION_ID"))
    if len(argv) >= 3 and argv[0] == "allocate":
        return allocate(argv[1], argv[2])
    raise RuntimeError("usage: office-plan.py brief <iterationId> | allocate <iterationId> <promptId>")


if __name__ == "__main__":
    sys.exit(main_guard(LANE, main, sys.argv[1:]))
