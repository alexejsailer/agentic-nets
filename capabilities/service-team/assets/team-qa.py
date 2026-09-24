#!/usr/bin/env python3
"""team-qa: the QA's lane (t-team-qa-cmd).

usage: team-qa.py acceptance-brief <specId> | verify <runId> | audit [scheduled]

acceptance-brief  after the person approved a spec: marks it approved, closes the office inbox item and renders the acceptance brief
                  for the one-shot acceptance writer (t-team-acceptance)
verify            checks out the run's branch in the team's clone, runs the build and the test suites, compares the diff with the
                  spec's files and scope, maps the acceptance criteria to the evidence and writes the verification with evidence;
                  a pass sends the review brief to the developer, a failure opens a bug and tells the person
audit             measures production readiness of the service on main (tests, build, health endpoint, structured logs, metrics,
                  configuration, docs) into a scorecard; red checks become bugs and an office inbox item
"""
import os, sys, json, re, time, shlex

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
import hashlib
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
          "brain-cmd", "brain-log", "signals", "curation", "curations", "knowledge", "plan", "backlog", "ideas", "status"]
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


def workspace_mode(c=None):
    """Where the team works. "workspace" (default): directly in the person's own repository, so the
    branches appear where they already work. "clone": an isolated clone under the team's home."""
    return str((c or cfg()).get("repoMode") or "workspace").strip().lower() != "clone"


def repo_root(c=None):
    """The repository the team works in: the person's own checkout, or the team's clone of it."""
    c = c or cfg()
    if workspace_mode(c):
        return workspace_repo(c)
    return os.path.join(team_home(c), str(c.get("repo") or "core"))


def tree_state(root):
    """What the checkout is doing right now: the branch it is on and whether anything is uncommitted."""
    return {"branch": git(["rev-parse", "--abbrev-ref", "HEAD"], root, check=False).strip(),
            "dirty": bool(git(["status", "--porcelain"], root, check=False).strip())}


def sync_main(root, c=None):
    """Put the checkout on a current main before branching.

    In a clone the origin IS the person's repository, so a hard reset only re-syncs the copy. In the
    person's own repository a hard reset to origin/main would destroy every unpushed commit, so this
    never resets there: it refuses instead and says what is in the way. Refusing costs an iteration;
    resetting would cost the work."""
    c = c or cfg()
    if not workspace_mode(c):
        git(["fetch", "-q", "origin"], root, check=False)
        git(["checkout", "-q", "main"], root)
        git(["reset", "-q", "--hard", "origin/main"], root)
        return {"mode": "clone", "head": head_sha(root)}
    st = tree_state(root)
    if st["dirty"]:
        raise RuntimeError("your repository %s has uncommitted changes; the team works in it directly, so commit "
                           "or stash them first (nothing was touched)" % root)
    if st["branch"] != "main":
        raise RuntimeError("your repository %s is on branch %s, not main; switch to main first "
                           "(nothing was touched)" % (root, st["branch"]))
    return {"mode": "workspace", "head": head_sha(root)}


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


def plan_key(title):
    """A stable key for a plan increment. The brain rewrites the whole plan after every merge and
    renumbers the increments, so inc-1 means something different each time; the person's verdict has to
    key off the wording instead."""
    t = re.sub(r"[^a-z0-9]+", " ", str(title or "").lower()).strip()
    return hashlib.sha1(t.encode("utf-8")).hexdigest()[:12] if t else ""


def backlog_verdicts():
    """What the person already decided about plan increments: key -> the newest verdict token."""
    out = {}
    for t in query(P["backlog"], "FROM $", 300):
        d = t.get("data") or {}
        k = str(d.get("key") or "")
        if k and str(d.get("at", "")) >= str(out.get(k, {}).get("at", "")):
            out[k] = d
    return out


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

LANE = "qa-cmd"


def acceptance_brief(argv):
    sid = argv[1]
    c = cfg()
    spec = by_id(P["specs"], "specId", sid)
    if not spec:
        raise RuntimeError("spec %s not found" % sid)
    notes = envv("DECISION_NOTES")
    set_status(P["specs"], "specId", sid, "approved", approvedAt=now(), approvalNotes=notes)
    replace_token(OFFICE["specs"], "specId", sid, {"status": "approved", "at": now()}, name="spec-%s" % sid)
    for t in query(P["prompts"], 'FROM $ WHERE $.promptId == "pr-spec-%s" LIMIT 5' % sid, 5):
        delete_token(P["prompts"], t["id"])
    close_office_inbox("pr-spec-%s" % sid)
    for t in query(P["adr"], 'FROM $ WHERE $.specId == "%s" AND $.status == "proposed" LIMIT 5' % sid, 5):
        d = t.get("data") or {}; d.update({"status": "accepted", "acceptedAt": now(), "acceptedBy": "person (with the spec)"})
        delete_token(P["adr"], t["id"]); put_token(P["adr"], d, name=str(d.get("adrId")))
    req = by_id(P["requirements"], "requirementId", str(spec.get("requirementId", "")))
    st = latest(P["state"], "at"); tests = as_dict(as_dict(st.get("analysis")).get("tests"))
    acc_id = "acc-%s" % sid
    sections = ["SERVICE: %s (%s/%s)" % (SERVICE, c.get("repo"), c.get("repoDir")),
                "THE SPEC %s: %s\nsummary: %s\nmodule: %s\ndesign: %s\ninterfaces: %s\ndata: %s\nfiles: %s\nverify: %s\nrisks: %s" % (
                    sid, spec.get("title"), spec.get("summary"), spec.get("module"), "; ".join(as_list(spec.get("design"))), "; ".join(as_list(spec.get("interfaces"))), "; ".join(as_list(spec.get("data"))), ", ".join(as_list(spec.get("files"))), spec.get("verify"), "; ".join(as_list(spec.get("risks")))),
                "THE REQUIREMENT %s: %s\nstory: %s\ndone when: %s\nout of scope: %s" % (req.get("requirementId"), req.get("title"), req.get("story"), "; ".join(as_list(req.get("done"))), "; ".join(as_list(req.get("outOfScope")))),
                "HOW TESTS RUN HERE: test command `%s` in the service directory; build command `%s`; the analyst measured: %s" % (c.get("testCommand"), c.get("buildCommand"), json.dumps(tests)[:500]),
                "READINESS CHECKS OF THIS TEAM: " + "; ".join(as_list(c.get("readinessChecks")))]
    if notes:
        sections.append("THE PERSON'S NOTES ON THE SPEC: " + notes)
    sections.append("acceptanceId: %s\nspecId: %s\nrequirementId: %s" % (acc_id, sid, spec.get("requirementId")))
    brief = "\n\n".join(sections)
    put_token(P["context"], {"at": now(), "purpose": "acceptance", "service": SERVICE, "specId": sid, "acceptanceId": acc_id, "requirementId": spec.get("requirementId"), "brief": brief}, name="ctx-acceptance-%s" % stamp())
    push_status("spec", "spec %s approved; QA writes the acceptance criteria" % sid, specId=sid)
    journal(lane(LANE), "acceptance-brief", "spec %s approved by the person; acceptance brief rendered (%d chars)" % (sid, len(brief)), specId=sid)
    return {"success": True, "acceptanceId": acc_id}


def parse_tests(output):
    """Counts from Maven surefire or vitest/jest summaries, when present."""
    m = re.findall(r"Tests run: (\d+), Failures: (\d+), Errors: (\d+), Skipped: (\d+)", output)
    if m:
        run_, fail, err, skip = [sum(int(x[i]) for x in m) for i in range(4)]
        # surefire prints per-class lines and a total; the total is the largest run count
        run_ = max(int(x[0]) for x in m); fail = max(int(x[1]) for x in m); err = max(int(x[2]) for x in m); skip = max(int(x[3]) for x in m)
        return {"framework": "surefire", "run": run_, "failed": fail + err, "skipped": skip}
    m = re.search(r"Tests?\s+(\d+) passed(?:.*?(\d+) failed)?", output)
    if m:
        return {"framework": "vitest", "run": int(m.group(1)) + int(m.group(2) or 0), "failed": int(m.group(2) or 0), "skipped": 0}
    m = re.search(r"Tests:\s+(?:(\d+) failed, )?(\d+) passed, (\d+) total", output)
    if m:
        return {"framework": "jest", "run": int(m.group(3)), "failed": int(m.group(1) or 0), "skipped": 0}
    return {"framework": "unknown", "run": None, "failed": None, "skipped": None}


def run_suite(cmd, cwd, timeout):
    started = time.time()
    rc, o, e = run(["bash", "-lc", cmd], cwd=cwd, timeout=timeout, check=False, env=dict(os.environ, CI="true"))
    text = (o or "") + "\n" + (e or "")
    return {"command": cmd, "rc": rc, "ok": rc == 0, "durationSec": round(time.time() - started), "tail": text[-2500:], "tests": parse_tests(text)}


def out_of_scope(files, c, spec):
    allowed = [str(c.get("repoDir") or "").strip("/")] + [str(x).strip("/") for x in as_list(c.get("scopePaths"))]
    outside = [f for f in files if not any(f.startswith(a + "/") or f == a for a in allowed if a)]
    spec_files = {str(x).strip("/") for x in as_list(spec.get("files"))}
    rd = str(c.get("repoDir") or "").strip("/")
    unplanned = [f for f in files if f not in outside and (f[len(rd) + 1:] if rd and f.startswith(rd + "/") else f) not in spec_files]
    return outside, unplanned


def verify(argv):
    run_id = argv[1]
    c = cfg()
    r = by_id(P["runs"], "runId", run_id)
    if not r:
        raise RuntimeError("run %s not found" % run_id)
    spec = by_id(P["specs"], "specId", str(r.get("specId", "")))
    acc = by_id(P["acceptance"], "specId", str(r.get("specId", "")))
    root = repo_root(c); sd = service_dir(c); branch = str(r.get("branch", ""))
    # the person may be working in this checkout: remember where it was and put it back afterwards
    was = tree_state(root)
    if was["dirty"] and workspace_mode(c):
        raise RuntimeError("your repository %s has uncommitted changes; verification would have to move the "
                           "checkout, so it stopped instead (commit or stash, then verify again)" % root)
    git(["checkout", "-q", branch], root)
    head = head_sha(root)
    files = [f for f in git(["diff", "--name-only", "main...%s" % branch], root).splitlines() if f.strip()]
    outside, unplanned = out_of_scope(files, c, spec)
    build = run_suite(str(c.get("buildCommand") or "true"), sd, 1200)
    suites = run_suite(str(c.get("testCommand") or "true"), sd, 1800)
    changed_tests = [f for f in files if "/test/" in f or f.endswith((".test.ts", ".spec.ts", "Test.java", "Tests.java", "IT.java"))]
    criteria = []
    for a in [x if isinstance(x, dict) else as_dict(x) for x in as_list(acc.get("criteria"))]:
        check = str(a.get("check", ""))
        names = re.findall(r"[A-Za-z0-9_]+(?:Test|Tests|IT|\.test|\.spec)", check)
        covered = any(any(n.split(".")[0] in f for f in changed_tests) for n in names) if names else False
        status = "covered" if covered else ("suites-pass" if suites["ok"] else "unverified")
        criteria.append({"id": a.get("id"), "then": str(a.get("then", ""))[:200], "check": check[:200], "status": status})
    # A narrowed test command (a -Dtest filter, a single suite) can pass while running nothing that
    # touches this change. Measure that instead of trusting a green suite: if the acceptance criteria
    # name tests, at least one of them has to be reachable by the command that just ran.
    named = []
    for a_ in [x if isinstance(x, dict) else as_dict(x) for x in as_list(acc.get("criteria"))]:
        named += re.findall(r"[A-Za-z0-9_]+(?:Test|Tests|IT)\b", str(a_.get("check", "")))
    named += [os.path.basename(str(t)).split(".")[0] for t in as_list(acc.get("tests")) if "test" in str(t).lower()]
    named = sorted({n for n in named if n})
    cmd_txt = str(c.get("testCommand") or "")
    filt = re.search(r"-Dtest=['\"]?([^'\" ]+)", cmd_txt)
    inconclusive = ""
    if named and filt:
        pats = [p_.strip() for p_ in filt.group(1).split(",") if p_.strip()]
        import fnmatch
        if not any(fnmatch.fnmatch(n, p_) for n in named for p_ in pats):
            inconclusive = ("the test command filters on %s, which matches none of this spec's tests (%s), so a green "
                            "suite proves nothing about this change" % (filt.group(1), ", ".join(named[:4])))

    verdict = "pass" if build["ok"] and suites["ok"] and not outside and not inconclusive else "fail"
    reasons = []
    if inconclusive:
        reasons.append(inconclusive)
    if not build["ok"]:
        reasons.append("build failed (rc %s)" % build["rc"])
    if not suites["ok"]:
        reasons.append("tests failed (%s)" % json.dumps(suites["tests"]))
    if outside:
        reasons.append("files outside the service scope: %s" % ", ".join(outside[:8]))
    ver = {"verificationId": "ver-%s" % run_id, "runId": run_id, "specId": r.get("specId"), "branch": branch, "head": head, "verdict": verdict, "at": now(),
           "summary": ("verified: build ok, %s tests, %d file(s) changed%s" % (json.dumps(suites["tests"]), len(files), ("; unplanned: " + ", ".join(unplanned[:6])) if unplanned else "")) if verdict == "pass" else "; ".join(reasons),
           "build": {k: build[k] for k in ("command", "rc", "ok", "durationSec")}, "suites": {k: suites[k] for k in ("command", "rc", "ok", "durationSec", "tests")}, "evidence": [build["tail"][-1200:], suites["tail"][-1500:]],
           "diff": {"files": files[:60], "outOfScope": outside[:20], "unplanned": unplanned[:20], "changedTests": changed_tests[:20]},
           "criteria": criteria, "namedTests": named, "inconclusive": inconclusive}
    for t in query(P["verification"], 'FROM $ WHERE $.verificationId == "%s" LIMIT 10' % ver["verificationId"], 10):
        delete_token(P["verification"], t["id"])   # a re-verification replaces the earlier record of the same run
    put_token(P["verification"], ver, name=ver["verificationId"])
    git(["checkout", "-q", was["branch"] or "main"], root, check=False)
    if verdict == "pass":
        set_status(P["runs"], "runId", run_id, "verified", verifiedAt=now(), failure="", failedAt="")
        set_status(P["specs"], "specId", str(r.get("specId", "")), "verified")
        put_token(P["dev_cmd"], command_token("team-dev", ["review-brief", run_id], stage="review-brief", timeout_ms=600000, runId=run_id, specId=r.get("specId")))
        push_status("verification", "run %s verified: %s" % (run_id, ver["summary"]), runId=run_id, specId=r.get("specId"), ok=True)
    else:
        set_status(P["runs"], "runId", run_id, "failed", failedAt=now(), failure=ver["summary"])
        bug_id = "bug-%s-%s" % (SERVICE, count(P["bugs"]) + 1)
        put_token(P["bugs"], {"bugId": bug_id, "runId": run_id, "specId": r.get("specId"), "title": "verification failed for %s: %s" % (run_id, ver["summary"][:160]), "evidence": ver["evidence"][-1][-800:], "status": "open", "at": now(), "by": "qa"}, name=bug_id)
        office_inbox("failure", "%s: verification of %s failed" % (SERVICE, run_id), run_id, "qa", detail=ver["summary"][:600])
        push_status("verification", "run %s failed verification: %s" % (run_id, ver["summary"]), runId=run_id, specId=r.get("specId"), ok=False)
    journal(lane(LANE), "verify", "run %s %s: %s" % (run_id, verdict, ver["summary"][:200]), runId=run_id, specId=r.get("specId"))
    return {"success": True, "verdict": verdict, "summary": ver["summary"]}


def exists_any(sd, patterns):
    hits = []
    for f in walk_files(sd, exts=None):
        rel = os.path.relpath(f, sd)
        if any(re.search(p, rel) for p in patterns):
            hits.append(rel)
            if len(hits) > 3:
                break
    return hits


def grep_any(sd, needles, exts):
    hits = []
    for f in walk_files(sd, exts=exts):
        try:
            txt = open(f, "r", encoding="utf-8", errors="replace").read()
        except OSError:
            continue
        if any(n in txt for n in needles):
            hits.append(os.path.relpath(f, sd))
            if len(hits) > 3:
                break
    return hits


def audit(argv):
    c = cfg(); root = repo_root(c); sd = service_dir(c)
    sync_main(root, c)
    checks = []
    def add(name, ok, evidence):
        checks.append({"name": name, "ok": bool(ok), "evidence": str(evidence)[:300]})
    tests = walk_files(sd, exts=(".java", ".ts", ".py"))
    tests = [f for f in tests if "/test/" in f or f.endswith((".test.ts", ".spec.ts", "Test.java", "Tests.java", "IT.java"))]
    add("tests present", len(tests) > 0, "%d test files" % len(tests))
    suites = run_suite(str(c.get("testCommand") or "true"), sd, 1800)
    # A readiness scorecard that says "test suite green" after a -Dtest filter ran a handful of classes
    # is worse than no check: it reads as coverage the team does not have. Say what actually ran.
    cmd_txt = str(c.get("testCommand") or "")
    narrowed = re.search(r"-Dtest=['\"]?([^'\" ]+)", cmd_txt)
    ran = as_int(as_dict(suites.get("tests")).get("run"), 0)
    if narrowed:
        add("test suite green", False, "the test command is narrowed to %s, so this is not a suite result (%s); widen it or record why it is narrowed"
            % (narrowed.group(1), ("%d test(s) ran" % ran) if ran else "no count reported"))
    else:
        add("test suite green", suites["ok"], json.dumps(suites["tests"]))
    build = run_suite(str(c.get("buildCommand") or "true"), sd, 1200)
    add("build ok", build["ok"], "rc %s in %s s" % (build["rc"], build["durationSec"]))
    add("health endpoint", bool(grep_any(sd, ["/health", "actuator", "HealthIndicator", "healthz"], (".java", ".ts", ".yml", ".yaml", ".properties"))), ", ".join(grep_any(sd, ["/health", "actuator", "HealthIndicator", "healthz"], (".java", ".ts", ".yml", ".yaml", ".properties"))))
    add("structured logs", bool(exists_any(sd, [r"logback.*\.xml$"]) or grep_any(sd, ["pino", "winston", "console.error(\"[", "LEVEL"], (".ts",))), ", ".join(exists_any(sd, [r"logback.*\.xml$"])))
    add("metrics", bool(grep_any(sd, ["micrometer", "prometheus", "opentelemetry", "otel"], (".xml", ".ts", ".java", ".json"))), ", ".join(grep_any(sd, ["micrometer", "prometheus", "opentelemetry", "otel"], (".xml", ".ts", ".java", ".json"))))
    add("config via env", bool(grep_any(sd, ["${", "process.env"], (".yml", ".yaml", ".properties", ".ts"))), ", ".join(grep_any(sd, ["${", "process.env"], (".yml", ".yaml", ".properties", ".ts"))))
    add("docs", os.path.exists(os.path.join(sd, "README.md")), "README.md" if os.path.exists(os.path.join(sd, "README.md")) else "no README")
    score = round(100.0 * sum(1 for x in checks if x["ok"]) / max(1, len(checks)))
    red = [x for x in checks if not x["ok"]]
    sc = {"at": now(), "service": SERVICE, "head": head_sha(root), "score": score, "checks": checks, "tests": suites["tests"], "reason": argv[1] if len(argv) > 1 else "manual", "evidence": suites["tail"][-1200:]}
    put_token(P["scorecard"], sc, name="scorecard-%s" % stamp())
    keep_last(P["scorecard"], "at", 30)
    for x in red:
        if not one(P["bugs"], 'FROM $ WHERE $.status == "open" AND $.check == "%s" LIMIT 1' % x["name"]):
            bug_id = "bug-%s-%s" % (SERVICE, count(P["bugs"]) + 1)
            put_token(P["bugs"], {"bugId": bug_id, "check": x["name"], "title": "readiness: %s is red (%s)" % (x["name"], x["evidence"][:120]), "status": "open", "at": now(), "by": "qa"}, name=bug_id)
    if red:
        office_inbox("audit", "%s: readiness %d%%, red: %s" % (SERVICE, score, ", ".join(x["name"] for x in red)), "audit-%s" % SERVICE, "qa", detail="; ".join("%s: %s" % (x["name"], x["evidence"]) for x in red)[:800])
    else:
        close_office_inbox("audit-%s" % SERVICE)
    push_status("audit", "readiness %d%% (%d of %d checks green)" % (score, len(checks) - len(red), len(checks)), score=score, ok=not red)
    journal(lane(LANE), "audit", "readiness audit: %d%%; red: %s" % (score, ", ".join(x["name"] for x in red) or "none"))
    return {"success": True, "score": score, "red": [x["name"] for x in red]}


def main(argv):
    cmd = argv[0] if argv else ""
    if cmd == "acceptance-brief":
        return acceptance_brief(argv)
    if cmd == "verify":
        return verify(argv)
    if cmd == "audit":
        return audit(argv)
    raise RuntimeError("usage: team-qa.py acceptance-brief <specId>|verify <runId>|audit")


if __name__ == "__main__":
    sys.exit(main_guard(lane(LANE), main, sys.argv[1:]))
