#!/usr/bin/env python3
"""team-po: the product owner's lane (t-team-po-cmd).

usage: team-po.py state | brief <iterationId> | mirror <promptId> | requirement-brief <iterationId> <promptId>

state              measures the module (files, tests, history) and lets the coding agent describe it read-only; cached while HEAD is unchanged
brief              renders the proposal brief for the one-shot product owner (t-team-propose) from the team goal, the office's direction,
                   the module state, open requirements, specs, verifications, bugs, ideas and the brain's plan
mirror             copies a freshly proposed question into the prompts place and the product office's inbox
requirement-brief  turns the person's answer into the requirement brief (t-team-requirement); a goal answer updates the charter and
                   re-briefs; an interview answer re-briefs with the answers
"""
import os, sys, json, re, time, collections

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

LANE = "po-cmd"
STATE_TOOLS = "Read,Grep,Glob,Bash(ls:*),Bash(find:*),Bash(wc:*),Bash(git log:*),Bash(git diff:*),Bash(cat:*),Bash(head:*)"
CODE_EXTS = (".java", ".ts", ".tsx", ".js", ".mjs", ".py", ".kt", ".go", ".sh", ".yaml", ".yml", ".xml", ".html", ".scss", ".css", ".md")


def measure(c):
    sd = service_dir(c); root = repo_root(c)
    files = walk_files(sd, exts=CODE_EXTS)
    by_ext = collections.Counter(os.path.splitext(f)[1] for f in files)
    tests = [f for f in files if "/test/" in f.replace("\\", "/") or f.endswith((".test.ts", ".spec.ts", "Test.java", "Tests.java", "IT.java"))]
    top = sorted({os.path.relpath(f, sd).split(os.sep)[0] for f in files})
    rc, o, e = run(["git", "log", "--oneline", "-8", "--", os.path.relpath(sd, root)], cwd=root, timeout=60, check=False)
    return {"files": len(files), "byExt": dict(by_ext.most_common(8)), "tests": len(tests), "topLevel": top[:30], "recentCommits": (o or "").strip().splitlines()[:8],
            "readme": os.path.exists(os.path.join(sd, "README.md")), "head": head_sha(root)}


def state(argv, force=False):
    c = cfg()
    root = repo_root(c)
    if not os.path.isdir(os.path.join(root, ".git")):
        raise RuntimeError("the team's clone is missing at %s: run provision" % root)
    git(["fetch", "-q", "origin"], root, check=False); git(["checkout", "-q", "main"], root); git(["reset", "-q", "--hard", "origin/main"], root)
    m = measure(c)
    cur = latest(P["state"], "at")
    if cur and cur.get("head") == m["head"] and not force and cur.get("analysis"):
        journal(lane(LANE), "state", "module state is current (HEAD %s unchanged)" % m["head"][:10])
        return cur
    agent = resolve_agent(c)
    agent["argv"] = [("Read,Grep,Glob,Bash(ls:*),Bash(find:*),Bash(wc:*),Bash(git log:*),Bash(cat:*),Bash(head:*)" if x == str(c.get("coderAllowedTools") or "") or "Edit" in str(x) else x) for x in agent["argv"]]
    agent["timeoutSec"] = min(agent["timeoutSec"], 900)
    prompt = ("You are the product owner's analyst for the %s service of Agentic-Nets, working READ-ONLY in %s (the service directory of the %s repository; never edit or write files).\n"
              "Describe the module for someone who must decide what it needs next. Measure, never guess: read the build file, the top-level structure, the entry points, the tests and the newest commits.\n"
              "Finish with ONE line: TEAM_RESULT: {\"summary\": <five sentences on purpose and shape>, \"structure\": [{\"path\": <dir or file>, \"purpose\": <one line>}], \"entryPoints\": [<main classes, servers, CLIs>], "
              "\"tests\": {\"command\": <how tests run>, \"count\": <number of test files>, \"gaps\": [<untested areas>]}, \"health\": [<what looks production-ready>], \"debt\": [<what looks fragile, duplicated or undocumented>], \"docs\": [<documents present>]}\n"
              "Keep every list at most 12 items; paths relative to the service directory.") % (SERVICE, service_dir(c), c.get("repo"))
    res = run_headless(prompt, service_dir(c), c, agent)
    analysis = dict(res["summary"])
    rec = {"at": now(), "service": SERVICE, "head": m["head"], "measured": m, "analysis": analysis, "coder": agent["agentId"], "model": agent["model"], "durationSec": res["durationSec"], "costUsd": res["costUsd"], "isError": res["isError"]}
    put_token(P["state"], rec, name="state-%s" % stamp())
    keep_last(P["state"], "at", 10)
    journal(lane(LANE), "state", "module state measured (%d files, %d tests) and described by %s in %d s%s" % (m["files"], m["tests"], agent["model"], res["durationSec"], " (coder error)" if res["isError"] else ""))
    return rec


def state_section(st):
    m = as_dict(st.get("measured")); a = as_dict(st.get("analysis"))
    lines = ["THE MODULE STATE (HEAD %s, measured %s):" % (str(st.get("head", ""))[:10], st.get("at", "")),
             "files %s (%s); test files %s; top level: %s" % (m.get("files"), ", ".join("%s %s" % (k, v) for k, v in as_dict(m.get("byExt")).items()), m.get("tests"), ", ".join(as_list(m.get("topLevel"))[:20]))]
    if a.get("summary"):
        lines.append("summary: %s" % str(a.get("summary"))[:1200])
    for key, title in (("structure", "structure"), ("entryPoints", "entry points"), ("health", "looks ready"), ("debt", "debt"), ("docs", "docs")):
        items = as_list(a.get(key))
        if items:
            lines.append("%s: %s" % (title, "; ".join((("%s: %s" % (x.get("path"), x.get("purpose"))) if isinstance(x, dict) else str(x)) for x in items[:12])[:900]))
    t = as_dict(a.get("tests"))
    if t:
        lines.append("tests: %s, count %s, gaps: %s" % (t.get("command"), t.get("count"), "; ".join(as_list(t.get("gaps"))[:6])))
    for cmt in as_list(m.get("recentCommits"))[:5]:
        lines.append("recent: %s" % cmt)
    return "\n".join(lines)


def brief(argv):
    it = argv[1] if len(argv) > 1 else "it-%s" % stamp()
    c = cfg()
    revision = envv("REVISION_TEXT"); direction = envv("DIRECTION"); direction_notes = envv("DIRECTION_NOTES"); roadmap_id = envv("ROADMAP_ID")
    answered = {str((t.get("data") or {}).get("promptId")) for t in query(P["responses"], "FROM $", 300)}
    decided = {str((t.get("data") or {}).get("specId")) for t in query(P["decisions"], "FROM $", 300)}
    open_ = [p for p in open_prompts(answered, decided) if p.get("kind") in (None, "", "proposal")]
    if open_ and not revision:
        journal(lane(LANE), "brief", "skipped: a proposal question is already open (%s)" % open_[0].get("promptId"))
        return {"success": True, "skipped": "open question"}
    st = state([])
    sections = ["TEAM: %s service of %s. Session %s." % (SERVICE, office_charter().get("product", "the product"), SESSION)]
    goal_ok = goal_defined(c)
    sections.append("TEAM GOAL: %s" % (c.get("goal") if goal_ok else "NOT DEFINED"))
    if c.get("description"):
        sections.append("TEAM DESCRIPTION: %s" % str(c.get("description"))[:1200])
    o = office_charter()
    sections.append("PRODUCT GOAL: %s\nPRINCIPLES: %s" % (o.get("goal", ""), "; ".join(as_list(o.get("principles"))[:8])))
    if direction:
        sections.append("DIRECTION FROM THE PRODUCT OFFICE (turn it into the next requirement): %s%s%s" % (direction, (" Notes: " + direction_notes) if direction_notes else "", (" Roadmap item " + roadmap_id) if roadmap_id else ""))
    if revision:
        sections.append("THE PERSON RESHAPED THE LAST QUESTION: %s" % revision[:1500])
    sections.append(state_section(st))
    reqs = [t.get("data") or {} for t in query(P["requirements"], "FROM $", 100)]
    if reqs:
        sections.append("REQUIREMENTS: " + "; ".join("%s %s (%s, %s)" % (r.get("requirementId"), r.get("title"), r.get("kind"), r.get("status")) for r in reqs[-15:]))
    specs = [t.get("data") or {} for t in query(P["specs"], "FROM $", 100)]
    if specs:
        sections.append("SPECS: " + "; ".join("%s %s [%s] %s" % (s.get("specId"), s.get("title"), s.get("module"), s.get("status")) for s in specs[-15:]))
    vers = [t.get("data") or {} for t in query(P["verification"], "FROM $", 50)]
    if vers:
        sections.append("LAST VERIFICATIONS: " + "; ".join("%s %s %s" % (v.get("runId"), v.get("verdict"), str(v.get("summary", ""))[:120]) for v in vers[-5:]))
    sc = latest(P["scorecard"], "at")
    if sc:
        sections.append("READINESS SCORECARD (%s): score %s; red: %s" % (sc.get("at"), sc.get("score"), "; ".join(str(x.get("name")) for x in as_list(sc.get("checks")) if not x.get("ok"))[:600] or "none"))
    bugs = [t.get("data") or {} for t in query(P["bugs"], 'FROM $ WHERE $.status == "open"', 30)]
    if bugs:
        sections.append("OPEN BUGS: " + "; ".join("%s %s" % (b.get("bugId"), str(b.get("title", ""))[:120]) for b in bugs[:10]))
    ideas = [t.get("data") or {} for t in query(P["ideas"], 'FROM $ WHERE $.status == "open"', 30)]
    oideas = [t.get("data") or {} for t in query("p-product-ideas", 'FROM $ WHERE $.status == "open"', 60)]
    oideas = [i for i in oideas if SERVICE in str(i.get("text", "")).lower() or str(i.get("service", "")) == SERVICE]
    if ideas or oideas:
        sections.append("OPEN IDEAS: " + "; ".join("%s (%s): %s" % (i.get("ideaId"), i.get("by"), str(i.get("text", ""))[:200]) for i in (ideas + oideas)[:10]))
    facts = [t.get("data") or {} for t in query(P["knowledge"], 'FROM $ WHERE $.status == "active"', 100)]
    if facts:
        sections.append("WHAT THE TEAM KNOWS: " + "; ".join("%s: %s" % (f.get("factId"), str(f.get("text", ""))[:160]) for f in facts[-10:]))
    plan = latest(P["plan"], "at")
    if plan:
        sections.append("THE PLAN: " + "; ".join("%s %s" % (i.get("order", ""), str(i.get("title", i.get("text", "")))[:120]) for i in as_list(plan.get("increments"))[:8]))
    n = count(P["prompts"]) + 1
    pid = "pr-%s-%d" % (it, n)
    sections.append("promptId: %s\niterationId: %s" % (pid, it))
    brief_text = "\n\n".join(sections)
    put_token(P["context"], {"at": now(), "purpose": "propose", "service": SERVICE, "iterationId": it, "promptId": pid, "brief": brief_text, "roadmapId": roadmap_id, "direction": direction}, name="ctx-propose-%s" % stamp())
    journal(lane(LANE), "brief", "proposal brief for %s (%d chars, goal %s, direction %s)" % (it, len(brief_text), "defined" if goal_ok else "NOT defined", "yes" if direction else "no"), iterationId=it, promptId=pid)
    return {"success": True, "iterationId": it, "promptId": pid, "chars": len(brief_text)}


def mirror(argv):
    pid = argv[1]
    src = by_id(P["prompts"], "promptId", pid)
    if not src:
        raise RuntimeError("prompt %s is not in the prompts place" % pid)
    office_inbox("question", "%s: %s" % (SERVICE, str(src.get("question", ""))[:160]), pid, "product-owner", detail="mode %s, %d option(s)" % (src.get("mode"), len(as_list(src.get("options")))))
    journal(lane(LANE), "mirror", "question %s (%s) waits for the person; office inbox updated" % (pid, src.get("mode")), promptId=pid)
    return {"success": True, "promptId": pid}


def receipt(pr, it, selected, text, notes):
    put_token(P["responses"], {"promptId": pr.get("promptId"), "iterationId": it, "intent": "answered", "selected": selected, "text": text, "notes": notes, "at": now(), "by": "person", "question": pr.get("question", "")}, name="answered-%s" % pr.get("promptId"))


def requirement_brief(argv):
    it, pid = argv[1], argv[2]
    c = cfg()
    pr = by_id(P["prompts"], "promptId", pid)
    if not pr:
        raise RuntimeError("prompt %s not found" % pid)
    selected = as_list(envv("RESPONSE_SELECTED")); text = envv("RESPONSE_TEXT"); notes = envv("RESPONSE_NOTES")
    receipt(pr, it, selected, text, notes)
    close_office_inbox(pid)
    mode = str(pr.get("mode", "choice"))
    if mode == "goal":
        goal_line = (text.strip().splitlines() or [""])[0][:300]
        nc = dict(charter()); nc.pop("name", None)
        nc.update({"goal": goal_line or nc.get("goal"), "description": text.strip()[:2000] if text.strip() else nc.get("description", ""), "status": "ready", "updatedAt": now()})
        put_token(P["charter"], nc, name="team-charter-%s" % stamp())
        put_token(P["po_cmd"], command_token("team-po", ["brief", it], stage="brief", timeout_ms=900000, iterationId=it, args_env={"REVISION_TEXT": "The team goal is now defined: %s" % goal_line}))
        journal(lane(LANE), "requirement-brief", "team goal defined by the person; re-briefing %s" % it, iterationId=it)
        return {"success": True, "goal": goal_line}
    if mode == "interview" or (not selected and text.strip()):
        answers = "; ".join(text.strip().splitlines())[:2000]
        put_token(P["po_cmd"], command_token("team-po", ["brief", it], stage="brief", timeout_ms=900000, iterationId=it, args_env={"REVISION_TEXT": "Answers to your questions: %s%s" % (answers, (" Notes: " + notes) if notes else "")}))
        journal(lane(LANE), "requirement-brief", "interview answered; re-briefing %s" % it, iterationId=it)
        return {"success": True, "rebrief": True}
    options = {str(o.get("value")): o for o in as_list(pr.get("options")) if isinstance(o, dict)}
    chosen = [options[v] for v in selected if v in options]
    if not chosen:
        raise RuntimeError("no known option selected (%s)" % selected)
    opt = chosen[0]
    rid = "req-%s-%03d" % (SERVICE, count(P["requirements"]) + 1)
    st = latest(P["state"], "at")
    sections = ["TEAM: %s service. TEAM GOAL: %s" % (SERVICE, c.get("goal", "")), "THE PERSON CHOSE: %s\n%s\nkind %s, module %s, effort %s, risk %s" % (opt.get("label"), opt.get("description", ""), opt.get("kind"), opt.get("module"), opt.get("effort"), opt.get("risk"))]
    if notes:
        sections.append("THE PERSON'S NOTES: " + notes)
    if len(chosen) > 1:
        sections.append("ALSO SELECTED (later requirements, not this one): " + "; ".join(str(o.get("label")) for o in chosen[1:]))
    sections.append("THE QUESTION WAS: %s\nRATIONALE: %s" % (pr.get("question", ""), pr.get("rationale", "")))
    if st:
        sections.append(state_section(st))
    sections.append("requirementId: %s\niterationId: %s\npromptId: %s" % (rid, it, pid))
    brief_text = "\n\n".join(sections)
    put_token(P["context"], {"at": now(), "purpose": "requirement", "service": SERVICE, "iterationId": it, "promptId": pid, "requirementId": rid, "brief": brief_text, "roadmapId": str(pr.get("roadmapId", ""))}, name="ctx-requirement-%s" % stamp())
    journal(lane(LANE), "requirement-brief", "the person chose '%s'; requirement %s goes to the writer" % (str(opt.get("label"))[:80], rid), iterationId=it, requirementId=rid)
    return {"success": True, "requirementId": rid}


def main(argv):
    cmd = argv[0] if argv else ""
    if cmd == "state":
        return state(argv, force=True)
    if cmd == "brief":
        return brief(argv)
    if cmd == "mirror":
        return mirror(argv)
    if cmd == "requirement-brief":
        return requirement_brief(argv)
    raise RuntimeError("usage: team-po.py state|brief <it>|mirror <promptId>|requirement-brief <it> <promptId>")


if __name__ == "__main__":
    sys.exit(main_guard(lane(LANE), main, sys.argv[1:]))
