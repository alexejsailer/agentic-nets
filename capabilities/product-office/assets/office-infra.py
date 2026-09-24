#!/usr/bin/env python3
"""office-infra: the product office's setup process.

usage: office-infra.py health | provision | register-team | pause | resume
health         measures the executor host (coding agents, node, git, the MCP endpoint, disk) into p-product-infra
provision      stores the MCP token for the office's command lanes (charter.tokenLanes) and runs health
register-team  (env TEAM_JSON) records a service team in p-product-teams; a team calls it when provisioned
pause/resume   stop or start every office lane except this one
"""
import json
import os
import shutil
import subprocess
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

LANE = "t-office-setup-cmd"
KEEP_RUNNING = ("t-office-setup-cmd", "t-office-infra-tick")


def version_of(cmd):
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
        return (p.stdout or p.stderr).strip().splitlines()[0][:60] if (p.stdout or p.stderr).strip() else ""
    except Exception:  # noqa: BLE001
        return ""


def disk_free_gb(path):
    try:
        return "%.1f" % (shutil.disk_usage(path).free / 1e9)
    except Exception:  # noqa: BLE001
        return "?"


def health(argv):
    c = charter()
    tools = {}
    for name, cmd in (("claude", ["claude", "--version"]), ("codex", ["codex", "--version"]), ("node", ["node", "--version"]), ("git", ["git", "--version"]), ("python3", ["python3", "--version"]), ("mvn", ["mvn", "--version"])):
        tools[name] = version_of(cmd) if which(name) else ""
    ok_mcp, ready = mcp_ok()
    root = os.path.expanduser(str(c.get("repoRoot") or ""))
    repos = {r: os.path.isdir(os.path.join(root, r, ".git")) for r in ("core", "agentic-nets", "ci")} if root else {}
    teams = [t.get("data") or {} for t in query(P["teams"], "FROM $", 50)]
    problems = []
    if not tools.get("claude") and not tools.get("codex"):
        problems.append("no headless coding agent binary on the executor host (claude or codex)")
    if not ok_mcp:
        problems.append("the MCP endpoint %s is not ready: %s" % (mcp_url(c), str(ready.get("error") or ready.get("warnings") or ready)[:200]))
    if not root or not any(repos.values()):
        problems.append("repoRoot %s holds no workspace repositories (core, agentic-nets, ci)" % (root or "(unset)"))
    home = office_home(c)
    data = {"at": now(), "kind": "health", "ok": "true" if not problems else "false", "tools": tools,
            "mcp": {"url": mcp_url(c), "ready": ok_mcp, "executors": (ready.get("executors") or {}).get("state", "") if isinstance(ready, dict) else "", "llm": ((ready.get("llm") or {}).get("status", "") if isinstance(ready, dict) else "")},
            "repoRoot": root, "repos": repos, "home": home, "diskFreeGb": disk_free_gb(home), "teams": [t.get("service") for t in teams], "problems": problems,
            "mcpTokenSource": "env" if os.environ.get("OFFICE_MCP_TOKEN", "").strip() and not os.environ.get("OFFICE_MCP_TOKEN", "").startswith("${") else ("file" if mcp_token() else "none")}
    put_token(P["infra"], data, name="infra-%s" % data["at"])
    keep_last(P["infra"], "at", 20, 'FROM $ WHERE $.kind == "health"')
    journal(LANE, "health", "host measured: claude %s, node %s, mcp %s, repos %s, %d team(s), %d problem(s)" % (
        "ok" if tools.get("claude") else "missing", "ok" if tools.get("node") else "missing", "ready" if ok_mcp else "not ready",
        ", ".join(k for k, v in repos.items() if v) or "none", len(teams), len(problems)))
    return {"success": not problems, "problems": problems, "tools": tools, "teams": len(teams)}


def provision(argv):
    c = charter()
    token = mcp_token()
    if not token:
        raise RuntimeError("no MCP token: set OFFICE_MCP_TOKEN or provide ~/.agenticos/desktop/mcp-token on the executor host")
    stored = []
    for tid in as_list(c.get("tokenLanes")):
        r = api("POST", "/api/transitions/%s/credentials?modelId=%s" % (tid, MODEL), {"OFFICE_MCP_TOKEN": token})
        if r is not None:
            stored.append(tid)
    journal(LANE, "provision", "MCP token stored for %d lane(s); mcp %s" % (len(stored), "ready" if mcp_ok()[0] else "not ready"))
    h = health(argv)
    return {"success": True, "tokenLanes": stored, "health": h}


def register_team(argv):
    raw = envv("TEAM_JSON")
    if not raw:
        raise RuntimeError("register-team needs TEAM_JSON in the environment")
    team = json.loads(raw)
    service = str(team.get("service") or "").strip()
    if not service:
        raise RuntimeError("TEAM_JSON has no service")
    team.update({"registeredAt": now(), "status": team.get("status") or "registered"})
    for t in query(P["teams"], 'FROM $ WHERE $.service == "%s" LIMIT 5' % service, 5):
        delete_token(P["teams"], t["id"])
    put_token(P["teams"], team, name="team-%s" % service)
    put_token(P["inbox"], {"itemId": "inbox-team-%s-%s" % (service, stamp()), "service": service, "persona": "office", "kind": "info", "title": "Team %s registered (%s); set its charter in the team app and start its first iteration" % (service, team.get("session")),
                           "route": team.get("appRoute", ""), "status": "open", "at": now()}, name="inbox-team-%s" % service)
    journal(LANE, "register-team", "team %s registered (session %s, %d places)" % (service, team.get("session"), len(as_dict(team.get("places")))))
    return {"success": True, "service": service}


def office_lanes():
    listed = mcp("list_transitions", {})
    rows = as_list(listed.get("transitions")) if isinstance(listed, dict) else as_list(listed)
    return [(str(t.get("transitionId") or t.get("id") or ""), str(t.get("status", ""))) for t in [as_dict(x) if not isinstance(x, dict) else x for x in rows] if str(t.get("transitionId") or t.get("id") or "").startswith("t-office-")]


def pause(argv):
    stopped = []
    for tid, status in office_lanes():
        if tid in KEEP_RUNNING or status != "RUNNING":
            continue
        try:
            mcp("stop_transition", {"transitionId": tid}); stopped.append(tid)
        except Exception as e:  # noqa: BLE001
            stopped.append("%s (failed: %s)" % (tid, str(e)[:60]))
    put_token(P["infra"], {"at": now(), "kind": "pause", "state": "paused", "lanes": stopped, "by": "person"}, name="pause-%s" % stamp())
    journal(LANE, "pause", "paused by the person: %d office lane(s) stopped; the setup lane stays up for resume" % len(stopped))
    return {"success": True, "stopped": stopped}


def resume(argv):
    rec = latest(P["infra"], "at", 'FROM $ WHERE $.kind == "pause"')
    lanes = as_list(rec.get("lanes")) if str(rec.get("state")) == "paused" else []
    if not lanes:
        lanes = [tid for tid, status in office_lanes() if tid not in KEEP_RUNNING and status != "RUNNING"]
    started = []
    for tid in lanes:
        try:
            mcp("start_transition", {"transitionId": tid}); started.append(tid)
        except Exception as e:  # noqa: BLE001
            started.append("%s (failed: %s)" % (tid, str(e)[:60]))
    put_token(P["infra"], {"at": now(), "kind": "pause", "state": "running", "lanes": started, "by": "person"}, name="resume-%s" % stamp())
    journal(LANE, "resume", "resumed by the person: %d office lane(s) started" % len(started))
    return {"success": True, "started": started}


def main(argv):
    cmd = argv[0] if argv else "health"
    if cmd == "health":
        return health(argv)
    if cmd == "provision":
        return provision(argv)
    if cmd == "register-team":
        return register_team(argv)
    if cmd == "pause":
        return pause(argv)
    if cmd == "resume":
        return resume(argv)
    raise RuntimeError("usage: office-infra.py health|provision|register-team|pause|resume")


if __name__ == "__main__":
    sys.exit(main_guard(LANE, main, sys.argv[1:]))
