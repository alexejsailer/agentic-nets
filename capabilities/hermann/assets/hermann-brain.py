#!/usr/bin/env python3
"""hermann-brain: the curated model of the project, kept by lanes, read by every brief.

usage:
  hermann-brain.py observe <runId|latest>   signals of a merged run + a fresh component map -> a curation
                                            request: a brief for the one-shot lane (config.brainAgent=llm)
                                            or a command for a headless agent in curate mode
  hermann-brain.py map                      rebuild the component map from the checkout (deterministic)
  hermann-brain.py curate <signalId>        headless curation: the configured agent reads the brief (and
                                            may read the repository) and answers the curation contract
  hermann-brain.py apply <curationId>       apply a curation: knowledge facts added and retired, the plan
                                            replaced, decisions proposed, questions filed (from env)
  hermann-brain.py answer <promptId>        a person's answer to a brain question becomes a fact
Reality is measured; the brain is curated from it and bounded: every fact has a kind, a scope, a
source and a confidence, at most MAX_ACTIVE facts stay active, and the curator retires to add.
"""
import json
import os
import re
import sys

# >>> shared: hermannlib (generated, do not edit here)
"""Shared library for the Hermann scripts. Inlined into every hermann-*.py by
tools/inline-shared.py (the executor runs each script as ONE file). Edit here, then re-inline.

Everything a lane measures is written back to the model through master (X-Service-Auth when the
internal service token is set). Secrets never enter a token: the git host token is injected into
the lanes' environment from the vault as GITEA_TOKEN.
"""
import datetime
import json
import os
import shutil
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

MASTER = os.environ.get("MASTER_URL", "http://127.0.0.1:8082").rstrip("/")
MODEL = os.environ.get("MODEL_ID", "hermann")
SERVICE_TOKEN = os.environ.get("AGENTICOS_SERVICE_TOKEN", "").strip()
HERMANN_HOME = os.path.expanduser(os.environ.get("HERMANN_HOME", "~/hermann"))

P = {
    "config": "p-hermann-config",
    "infra": "p-hermann-infra",
    "repo": "p-hermann-repo",
    "journal": "p-hermann-journal",
    "errors": "p-hermann-errors",
    "audit_req": "p-hermann-audit-request",
    "audit_cmd": "p-hermann-audit-cmd",
    "factor_cmd": "p-hermann-factor-cmd",
    "digest": "p-hermann-repo-digest",
    "reports": "p-hermann-factor-reports",
    "scorecard": "p-hermann-scorecard",
    "cards": "p-hermann-cards",
    "coders": "p-hermann-coders",
    "goal": "p-hermann-goal",
    "adr": "p-hermann-adr",
    "prompts": "p-hermann-prompts",
    "responses": "p-hermann-responses",
    "specs": "p-hermann-specs",
    "work": "p-hermann-work-queue",
    "runs": "p-hermann-runs",
    "verification": "p-hermann-verification",
    "reviews": "p-hermann-reviews",
    "decisions": "p-hermann-decisions",
    "risks": "p-hermann-risks",
    "upgrades": "p-hermann-upgrades",
    "context": "p-hermann-context",
    "iterate": "p-hermann-iterate",
    "context_cmd": "p-hermann-context-cmd",
    "code_cmd": "p-hermann-code-cmd",
    "verify_cmd": "p-hermann-verify-cmd",
    "review_cmd": "p-hermann-review-cmd",
    "release_cmd": "p-hermann-release-cmd",
    "llm_errors": "p-hermann-llm-errors",
    "brain_cmd": "p-hermann-brain-cmd",
    "signals": "p-hermann-signals",
    "curation": "p-hermann-curation",
    "knowledge": "p-hermann-knowledge",
    "map": "p-hermann-map",
    "plan": "p-hermann-plan",
    "curations": "p-hermann-curations",
}


def envv(name, default=""):
    """An environment value set by a map-lane template; an unresolved `${...}` placeholder counts as unset."""
    v = os.environ.get(name, "")
    if v is None or v.strip().startswith("${"):
        return default
    return v.strip() or default

FACTORS = [
    ("01", "codebase", "Codebase", "One codebase tracked in revision control, many deploys"),
    ("02", "dependencies", "Dependencies", "Explicitly declare and isolate dependencies"),
    ("03", "config", "Config", "Store config in the environment"),
    ("04", "backing-services", "Backing services", "Treat backing services as attached resources"),
    ("05", "build-release-run", "Build, release, run", "Strictly separate build and run stages"),
    ("06", "processes", "Processes", "Execute the app as one or more stateless processes"),
    ("07", "port-binding", "Port binding", "Export services via port binding"),
    ("08", "concurrency", "Concurrency", "Scale out via the process model"),
    ("09", "disposability", "Disposability", "Maximize robustness with fast startup and graceful shutdown"),
    ("10", "dev-prod-parity", "Dev/prod parity", "Keep development, staging, and production as similar as possible"),
    ("11", "logs", "Logs", "Treat logs as event streams"),
    ("12", "admin-processes", "Admin processes", "Run admin/management tasks as one-off processes"),
]


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


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
            body["name"] = "%s-%s" % (name, now().replace(":", "").replace("-", ""))
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


def query(place, arcql="FROM $", limit=200):
    r = api("POST", "/api/runtime/places/%s/tokens/query?modelId=%s" % (place, MODEL), {"arcql": arcql, "limit": limit})
    tokens = r.get("tokens", []) if isinstance(r, dict) else []
    for t in tokens:
        if isinstance(t.get("data"), dict):
            t["data"] = decode(t["data"])
    return tokens


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
    """A list value as a list. Elements that are objects or lists stay structured (a spec's
    config entries are objects); only scalars are normalised to strings."""
    if v is None:
        return []
    if isinstance(v, list):
        return [x if isinstance(x, (dict, list)) else str(x) for x in v]
    s = str(v).strip()
    if not s:
        return []
    if s.startswith("["):
        try:
            return [str(x) for x in json.loads(s)]
        except ValueError:
            pass
    return [x.strip() for x in s.split(",") if x.strip()]


def as_int(v, default=0):
    try:
        return int(str(v).strip())
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


def config():
    """The newest config token wins (the application appends a new one on every save)."""
    return latest(P["config"], "updatedAt", 'FROM $ WHERE $.configId == "hermann"') or latest(P["config"], "updatedAt")


def adrs(status=None):
    """Architecture decision records, one per adrId (the newest token for each id wins)."""
    by_id = {}
    for t in query(P["adr"], "FROM $", 300):
        d = t.get("data") or {}
        key = d.get("adrId") or t.get("id")
        if key not in by_id or str(d.get("updatedAt", "")) >= str(by_id[key].get("updatedAt", "")):
            by_id[key] = d
    rows = sorted(by_id.values(), key=lambda a: str(a.get("adrId", "")))
    return [a for a in rows if status is None or a.get("status") == status]


def repo(name=None):
    if name:
        return one(P["repo"], 'FROM $ WHERE $.repoId == "%s" LIMIT 1' % name)
    return latest(P["repo"], "updatedAt")


def infra():
    return latest(P["infra"], "at")


def hermann_home(cfg=None):
    home = os.path.expanduser(str((cfg or {}).get("hermannHome") or HERMANN_HOME))
    os.makedirs(home, exist_ok=True)
    return home


def gitea_url(cfg=None):
    inf = infra()
    if inf.get("giteaUrl"):
        return str(inf["giteaUrl"]).rstrip("/")
    cfg = cfg or config()
    return "http://127.0.0.1:%s" % cfg.get("giteaPort", "3300")


def gitea(method, path, body=None, token=None, timeout=30, base=None):
    """Gitea REST call. Returns (status, json|text). The token comes from the lane's environment."""
    token = token or os.environ.get("GITEA_TOKEN", "").strip()
    url = (base or gitea_url()) + "/api/v1" + path
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Accept", "application/json")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    if token and token != "-":  # "-" = deliberately anonymous (Gitea rejects any invalid token, even on public routes)
        req.add_header("Authorization", "token " + token)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8", "replace")
            try:
                return r.status, (json.loads(raw) if raw.strip() else {})
            except ValueError:
                return r.status, raw
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, raw
    except Exception as e:  # noqa: BLE001  (connection refused/reset while the host starts, timeouts)
        return 0, "%s: %s" % (type(e).__name__, e)


def git(args, cwd, timeout=300, check=True):
    """git with the vault-injected token supplied through a credential helper: the secret is read
    from the environment by the helper, never placed in argv, the remote URL, or .git/config."""
    helper = "!f() { echo username=${GITEA_USER:-hermann}; echo password=$GITEA_TOKEN; }; f"
    cmd = ["git", "-c", "credential.helper=" + helper, "-c", "user.name=Hermann", "-c", "user.email=hermann@localhost"] + list(args)
    return run(cmd, cwd=cwd, timeout=timeout, check=check)


def ensure_repo(name, cfg=None):
    """The repository on the git host: existing one returned, otherwise created. (body, created)."""
    cfg = cfg or config()
    user = cfg.get("giteaUser", "hermann")
    st, body = gitea("GET", "/repos/%s/%s" % (user, name))
    if st == 200:
        return body, False
    st, body = gitea("POST", "/user/repos", {
        "name": name, "description": str(cfg.get("description") or "Built by Hermann, the twelve-factor Spring Boot developer")[:255],
        "private": False, "default_branch": "main", "auto_init": False, "trust_model": "default",
    })
    if st not in (200, 201):
        raise RuntimeError("repo creation failed (%s): %s" % (st, str(body)[:300]))
    return body, True


def record_repo(name, body, cfg, status, **extra):
    """Replace the p-hermann-repo record for `name` (one token per repository)."""
    home = hermann_home(cfg)
    old = query(P["repo"], 'FROM $ WHERE $.repoId == "%s" LIMIT 10' % name, 10)
    previous = (old[0].get("data") or {}) if old else {}
    data = dict(previous)
    data.update({
        "repoId": name, "name": name, "owner": (body.get("owner") or {}).get("login", cfg.get("giteaUser", "hermann")),
        "htmlUrl": body.get("html_url", ""), "cloneUrl": body.get("clone_url", ""), "sshUrl": body.get("ssh_url", ""),
        "localPath": os.path.join(home, name), "defaultBranch": body.get("default_branch", "main") or "main",
        "status": status, "updatedAt": now(),
    })
    data.setdefault("createdAt", data["updatedAt"])
    data.update(extra)
    for t in old:
        delete_token(P["repo"], t["id"])
    put_token(P["repo"], data, name="repo-%s" % name)
    return data


def protect_main(name, cfg=None):
    """No direct pushes to main; changes arrive through pull requests. (status, body)."""
    cfg = cfg or config()
    owner = cfg.get("giteaUser", "hermann")
    return gitea("POST", "/repos/%s/%s/branch_protections" % (owner, name), {
        "branch_name": "main", "rule_name": "main", "enable_push": False, "enable_push_whitelist": False,
        "required_approvals": 0, "block_on_rejected_reviews": True, "enable_status_check": False,
        "block_on_outdated_branch": False, "dismiss_stale_approvals": False,
    })


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


def walk_files(root, exts=None, skip=("target", ".git", "node_modules", ".mvn", ".idea")):
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
        "kind": "command", "id": "%s-%s" % (tool_id, now().replace(":", "").replace("-", "")),
        "executor": "script", "command": "invoke", "expect": "text",
        "args": {"toolId": tool_id, "argv": [str(a) for a in argv], "env": {"MODEL_ID": MODEL}, "timeoutMs": timeout_ms},
        "filedAt": now(),
    }
    if stage:
        tok["stage"] = stage
    tok.update(extra)
    return tok


import re as _re
import time as _time
DEFAULT_TOOLS = "Read,Grep,Glob,Edit,Write,MultiEdit,Bash(./mvnw:*),Bash(git status:*),Bash(git diff:*),Bash(git log:*),Bash(ls:*),Bash(cat:*),Bash(find:*),Bash(mkdir:*)"


BUILTIN_CLAUDE = {
    "agentId": "claude-code", "title": "Claude Code (headless)", "binary": "claude",
    "command": ["claude", "-p", "--model", "${model}", "--allowedTools", "${allowedTools}", "--max-turns", "${maxTurns}", "--no-session-persistence", "--output-format", "json"],
    "promptVia": "stdin", "resultFormat": "claude-json", "defaultModel": "claude-opus-5", "allowedTools": DEFAULT_TOOLS, "maxTurns": "80", "timeoutMin": "45",
}


def resolve_agent(cfg, agent_key="coderAgent", model_key="coderModel"):
    """A headless agent: a definition token from p-hermann-coders chosen by config[agent_key], with
    config overrides for model, tools, turns and timeout. Falls back to the built-in Claude Code."""
    defs = {}
    for t in query(P["coders"], "FROM $", 20):
        d = t.get("data") or {}
        if d.get("agentId"):
            defs[d["agentId"]] = d
    agent_id = str(cfg.get(agent_key) or "claude-code")
    a = defs.get(agent_id) or (BUILTIN_CLAUDE if agent_id == "claude-code" else None)
    if not a:
        raise RuntimeError("coding agent '%s' is not defined in p-hermann-coders (known: %s)" % (agent_id, ", ".join(sorted(defs)) or "none"))
    model = str(cfg.get(model_key) or a.get("defaultModel") or "")
    tools = str(cfg.get("coderAllowedTools") or a.get("allowedTools") or DEFAULT_TOOLS)
    turns = str(cfg.get("coderMaxTurns") or a.get("maxTurns") or "80")
    timeout_min = as_int(cfg.get("coderTimeoutMin") or cfg.get("implementTimeoutMin") or a.get("timeoutMin"), 45)
    argv = [str(x).replace("${model}", model).replace("${allowedTools}", tools).replace("${maxTurns}", turns) for x in as_list(a.get("command"))]
    if not argv:
        raise RuntimeError("coding agent '%s' has no command" % agent_id)
    if not which(argv[0]):
        raise RuntimeError("coding agent binary '%s' is not on the executor host" % argv[0])
    return {"agentId": a.get("agentId"), "title": a.get("title", a.get("agentId")), "argv": argv, "model": model, "resultFormat": a.get("resultFormat", "text"),
            "promptVia": a.get("promptVia", "stdin"), "timeoutSec": timeout_min * 60}


def run_headless(prompt, root, cfg, agent):
    env = {k: v for k, v in os.environ.items() if k not in ("CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT")}
    env["GITEA_TOKEN"] = ""  # the coder never sees the git host token
    argv = list(agent["argv"])
    stdin_text = prompt
    if agent["promptVia"] == "argv":
        argv.append(prompt); stdin_text = None
    started = _time.time()
    rc, o, e = run(argv, cwd=root, timeout=agent["timeoutSec"], env=env, check=False, input_text=stdin_text)
    duration = round(_time.time() - started)
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
    summary = {"summary": "", "filesChanged": [], "testsAdded": [], "notes": ""}
    m = _re.search(r"HERMANN_RESULT:\s*(\{.*\})", result_text, re.S)
    if m:
        try:
            summary.update(json.loads(m.group(1)))
        except ValueError:
            summary["notes"] = "result line was not valid JSON"
    if not summary.get("summary"):
        summary["summary"] = result_text[-800:].strip()
    return {"rc": rc, "isError": is_error, "durationSec": duration, "costUsd": cost, "turns": turns, "summary": summary, "stderr": (e or "")[-1500:]}


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
# <<< shared: hermannlib

LANE = "t-hermann-observe-cmd"
MAX_ACTIVE = 80
KINDS = ("platform", "convention", "decision", "gap", "risk", "question", "answer")
MAPPING = re.compile(r'@(Get|Post|Put|Patch|Delete|Request)Mapping\s*(?:\(\s*(?:value\s*=|path\s*=)?\s*"([^"]*)")?')


# ---------------------------------------------------------------- the component map (deterministic)
def component_map(rp, sha=None):
    """Measured at the given commit (default: the head of main as recorded on the repository) in a
    throwaway worktree, so a coder working on a branch in the checkout never leaks into the map."""
    import shutil as _sh
    checkout = rp["localPath"]
    sha = sha or rp.get("headSha") or head_sha(checkout)
    work = os.path.join(hermann_home(), ".map", sha[:12])
    run(["git", "worktree", "prune"], cwd=checkout, check=False)
    if os.path.exists(work):
        run(["git", "worktree", "remove", "--force", work], cwd=checkout, check=False); _sh.rmtree(work, ignore_errors=True)
    git(["fetch", "-q", "--prune", "origin"], cwd=checkout, check=False)
    rc, o, e = run(["git", "worktree", "add", "--detach", work, sha], cwd=checkout, check=False)
    if rc != 0:
        raise RuntimeError("cannot create a worktree at %s: %s" % (sha[:7], (e or o)[-300:]))
    try:
        return _component_map_at(rp, work, sha)
    finally:
        run(["git", "worktree", "remove", "--force", work], cwd=checkout, check=False); _sh.rmtree(work, ignore_errors=True)


def _component_map_at(rp, root, sha):
    comps, endpoints, tables, tests = [], [], [], []
    for f in walk_files(os.path.join(root, "src", "main", "java"), (".java",)):
        src = read_text(f, 60000)
        cls = re.search(r"\b(?:class|record|interface|enum)\s+(\w+)", src)
        pkg = re.search(r"^package\s+([\w.]+);", src, re.M)
        if not cls:
            continue
        kind = "class"
        for ann, k in (("@RestController", "controller"), ("@Service", "service"), ("@Repository", "repository"), ("@Entity", "entity"),
                       ("@Configuration", "configuration"), ("@ConfigurationProperties", "properties"), ("@Component", "component"),
                       ("@Scheduled", "scheduler")):
            if ann in src:
                kind = k
                break
        base = re.search(r'@RequestMapping\s*\(\s*(?:value\s*=|path\s*=)?\s*"([^"]*)"', src)
        base = base.group(1) if base else ""
        eps = []
        for m in MAPPING.finditer(src):
            verb = m.group(1).upper() if m.group(1) != "Request" else "ANY"
            path = (base + (m.group(2) or "")) or base or "/"
            if verb == "ANY" and not m.group(2):
                continue
            eps.append("%s %s" % (verb, path))
        table = re.search(r'@Table\s*\(\s*name\s*=\s*"([^"]+)"', src)
        entry = {"className": cls.group(1), "package": (pkg.group(1) if pkg else ""), "kind": kind, "file": os.path.relpath(f, root)}
        if eps:
            entry["endpoints"] = sorted(set(eps)); endpoints.extend(eps)
        if table or kind == "entity":
            entry["table"] = table.group(1) if table else cls.group(1).lower(); tables.append(entry["table"])
        comps.append(entry)
    for f in walk_files(os.path.join(root, "src", "test", "java"), (".java",)):
        src = read_text(f, 60000)
        cls = re.search(r"\bclass\s+(\w+)", src)
        if cls:
            tests.append({"className": cls.group(1), "methods": len(re.findall(r"@Test\b", src)), "file": os.path.relpath(f, root)})
    migrations = sorted(os.path.basename(m) for m in walk_files(os.path.join(root, "src", "main", "resources", "db"), (".sql",)))
    env_vars = sorted(set(re.findall(r"\$\{([A-Z][A-Z0-9_]+)", read_text(os.path.join(root, "src", "main", "resources", "application.yml"), 20000))))
    data = {"at": now(), "sha": sha, "sha7": sha[:7], "repoId": rp["repoId"], "components": comps[:120], "endpoints": sorted(set(endpoints)),
            "tables": sorted(set(tables)), "migrations": migrations, "tests": tests[:80], "envVars": env_vars,
            "summary": "%d classes (%d controllers, %d services, %d entities), %d endpoints, %d tables, %d migrations, %d test classes with %d tests, %d env vars" % (
                len(comps), sum(1 for c in comps if c["kind"] == "controller"), sum(1 for c in comps if c["kind"] == "service"),
                sum(1 for c in comps if c["kind"] == "entity"), len(set(endpoints)), len(set(tables)), len(migrations), len(tests), sum(t["methods"] for t in tests), len(env_vars))}
    for t in query(P["map"], 'FROM $ WHERE $.sha == "%s" LIMIT 5' % sha, 5):
        delete_token(P["map"], t["id"])
    put_token(P["map"], data, name="map-%s" % sha[:7])
    keep_last(P["map"], "at", 5)
    return data


def map_text(m, limit=2400):
    if not m:
        return "(no component map yet)"
    lines = ["summary: " + str(m.get("summary", ""))]
    for c in as_list(m.get("components"))[:40]:
        c = as_dict(c) if not isinstance(c, dict) else c
        extra = (" endpoints: " + ", ".join(as_list(c.get("endpoints")))) if c.get("endpoints") else ((" table: " + str(c.get("table"))) if c.get("table") else "")
        lines.append("- %s (%s)%s" % (c.get("className"), c.get("kind"), extra))
    lines.append("migrations: " + ", ".join(as_list(m.get("migrations"))))
    lines.append("tests: " + ", ".join("%s(%s)" % ((t.get("className") if isinstance(t, dict) else t), (t.get("methods") if isinstance(t, dict) else "?")) for t in as_list(m.get("tests"))[:30]))
    lines.append("env vars: " + ", ".join(as_list(m.get("envVars"))))
    return "\n".join(lines)[:limit]


# ---------------------------------------------------------------- knowledge, plan
def active_facts():
    facts = [t.get("data") or {} for t in query(P["knowledge"], 'FROM $ WHERE $.status == "active"', 300)]
    facts.sort(key=lambda f: str(f.get("factId", "")))
    return facts


def knowledge_text(kinds=None, limit=40, scope=None):
    rows = [f for f in active_facts() if (kinds is None or f.get("kind") in kinds) and (scope is None or f.get("scope") == scope)]
    if not rows:
        return "- (no facts yet)"
    return "\n".join("- [%s|%s|%s] %s (source %s)" % (f.get("factId"), f.get("kind"), f.get("confidence", "?"), str(f.get("text", ""))[:260], f.get("source", "?")) for f in rows[:limit])


def plan_text():
    p = latest(P["plan"], "at")
    if not p:
        return "- (no plan yet)"
    out_lines = []
    for inc in as_list(p.get("increments")):
        inc = as_dict(inc) if not isinstance(inc, dict) else inc
        dep = (", after " + ", ".join(as_list(inc.get("dependsOn")))) if as_list(inc.get("dependsOn")) else ""
        out_lines.append("- %s [%s] %s%s%s" % (inc.get("id", "?"), inc.get("status", "?"), str(inc.get("title", ""))[:120], dep, (" (spec %s)" % inc.get("specId")) if inc.get("specId") else ""))
    return "\n".join(out_lines) or "- (empty plan)"


# ---------------------------------------------------------------- observe -> curation request
def signal_for(run_id):
    if run_id in ("latest", "") or run_id.startswith("${"):
        runs = [t.get("data") or {} for t in query(P["runs"], 'FROM $ WHERE $.status == "merged"', 100)]
        runs.sort(key=lambda r: str(r.get("mergedAt") or r.get("at", "")), reverse=True)
        if not runs:
            raise RuntimeError("no merged run to observe")
        r = runs[0]
    else:
        r = one(P["runs"], 'FROM $ WHERE $.runId == "%s" LIMIT 1' % run_id)
        if not r:
            raise RuntimeError("run %s not found" % run_id)
    s = one(P["specs"], 'FROM $ WHERE $.specId == "%s" LIMIT 1' % r.get("specId", ""))
    rv = latest(P["reviews"], "at", 'FROM $ WHERE $.runId == "%s"' % r["runId"])
    ver = latest(P["verification"], "at", 'FROM $ WHERE $.runId == "%s"' % r["runId"])
    sc = latest(P["scorecard"], "at")
    return {
        "signalId": "sig-%s" % r["runId"], "runId": r["runId"], "specId": r.get("specId", ""), "title": r.get("title", ""), "at": now(),
        "repoId": r.get("repoId", ""), "sha": r.get("mergedSha") or r.get("headSha", ""), "status": r.get("status"),
        "coderSummary": str(r.get("coderSummary", ""))[:1500], "coderNotes": str(r.get("coderNotes", ""))[:2500],
        "coderAgent": r.get("coderAgent", ""), "coderModel": r.get("coderModel", ""),
        "reviewSummary": str(rv.get("summary", ""))[:800], "reviewPoints": as_list(rv.get("points"))[:10],
        "verification": {"status": ver.get("status"), "testsRun": ver.get("testsRun"), "startupSeconds": ver.get("startupSeconds"), "shutdownSeconds": ver.get("shutdownSeconds"), "evidence": as_list(ver.get("evidence"))[:8]},
        "diffStat": r.get("diffStat", ""), "filesChanged": as_list(r.get("filesChanged"))[:40],
        "scorecard": {"total": sc.get("total"), "grade": sc.get("grade"), "weak": as_list(sc.get("weak")), "failing": as_list(sc.get("failing"))},
        "specSummary": str(s.get("summary", ""))[:600], "specApi": as_list(s.get("api"))[:12], "specData": as_list(s.get("data"))[:8],
        "specConfig": [(c if isinstance(c, dict) else as_dict(c)) for c in as_list(s.get("config"))][:12], "specRisks": as_list(s.get("risks"))[:8],
        "specOutOfScope": as_list(s.get("outOfScope"))[:10],
    }


def curation_brief(sig, m):
    g = latest(P["goal"], "updatedAt") or one(P["goal"])
    lines = [
        "# BRIEF FOR HERMANN'S BRAIN: curate what the project knows after %s" % sig.get("specId"),
        "signalId: %s\nrunId: %s\ncurationId to use: cur-%s\nnow: %s" % (sig["signalId"], sig["runId"], sig["runId"], now()),
        "## GOAL\n%s\n%s\n\n## PRINCIPLES\n%s\n\n## CONSTRAINTS\n%s" % (g.get("title", ""), str(g.get("description", ""))[:1200], "\n".join("- " + p for p in as_list(g.get("principles"))), "\n".join("- " + c for c in as_list(g.get("constraints"))) or "- none"),
        "## WHAT WAS MERGED: %s (%s)\nspec summary: %s\nAPI: %s\ndata: %s\nconfig: %s\nout of scope: %s\ndiff: %s\nfiles: %s" % (
            sig.get("specId"), sig.get("title"), sig.get("specSummary"), "; ".join(str(x)[:100] for x in sig.get("specApi", [])), "; ".join(str(x)[:120] for x in sig.get("specData", [])),
            "; ".join("%s=%s" % (c.get("name"), c.get("default")) for c in sig.get("specConfig", []) if isinstance(c, dict)), "; ".join(str(x)[:80] for x in sig.get("specOutOfScope", [])),
            sig.get("diffStat"), ", ".join(sig.get("filesChanged", [])[:25])),
        "## WHAT THE CODER REPORTED (%s / %s)\nsummary: %s\nnotes: %s" % (sig.get("coderAgent"), sig.get("coderModel"), sig.get("coderSummary"), sig.get("coderNotes")),
        "## WHAT THE REVIEW SAID\n%s\npoints: %s" % (sig.get("reviewSummary"), "; ".join(json.dumps(p) if isinstance(p, dict) else str(p) for p in sig.get("reviewPoints", [])) or "none"),
        "## WHAT WAS MEASURED\nverification: %s\nscorecard: %s/36 grade %s, weak %s, failing %s" % (json.dumps(sig.get("verification")), sig["scorecard"].get("total"), sig["scorecard"].get("grade"), sig["scorecard"].get("weak"), sig["scorecard"].get("failing")),
        "## THE COMPONENT MAP (measured from the checkout)\n" + map_text(m),
        "## CURRENT KNOWLEDGE (active facts; retire what is now wrong or subsumed, never retire an answer)\n" + knowledge_text(limit=80),
        "## CURRENT PLAN\n" + plan_text(),
        "## DECISIONS ON RECORD\n" + ("\n".join("- %s [%s] %s: %s" % (a.get("adrId"), a.get("status"), a.get("title"), str(a.get("decision", ""))[:160]) for a in adrs()) or "- none"),
    ]
    return "\n\n".join(lines)[:16000]


def observe(argv):
    cfg = config()
    rp = repo()
    if not rp or rp.get("status") != "bootstrapped":
        raise RuntimeError("no current repository")
    sig = signal_for(argv[1] if len(argv) > 1 else "latest")
    sig["startIteration"] = "true" if (envv("START_ITERATION") == "true" or (len(argv) > 2 and argv[2] == "next")) else "false"
    m = component_map(rp, sig.get("sha") or None)
    for t in query(P["signals"], 'FROM $ WHERE $.signalId == "%s" LIMIT 5' % sig["signalId"], 5):
        delete_token(P["signals"], t["id"])
    put_token(P["signals"], sig, name=sig["signalId"])
    keep_last(P["signals"], "at", 20)
    brief = curation_brief(sig, m)
    brain_agent = str(cfg.get("brainAgent") or "llm")
    if brain_agent == "llm":
        put_token(P["context"], {"at": now(), "purpose": "curate", "signalId": sig["signalId"], "runId": sig["runId"], "curationId": "cur-%s" % sig["runId"], "brief": brief}, name="ctx-curate-%s" % sig["runId"])
        route = "one-shot lane"
    else:
        put_token(P["brain_cmd"], command_token("hermann-brain", ["curate", sig["signalId"]], stage="curate", timeout_ms=1800000, signalId=sig["signalId"], runId=sig["runId"]), name="curate-%s" % sig["runId"])
        route = "headless %s" % brain_agent
    journal(LANE, "observe", "signals of %s (%s) collected, map %s; curation routed to the %s" % (sig["specId"], sig["runId"], m["summary"][:80], route), runId=sig["runId"])
    return {"success": True, "signalId": sig["signalId"], "route": route, "map": m["summary"], "briefChars": len(brief)}


# ---------------------------------------------------------------- headless curation
CONTRACT = ('Reply with exactly this shape and nothing else: {"curationId": "<from the brief>", "runId": "<from the brief>", '
            '"addFacts": [{"kind": "platform|convention|decision|gap|risk|question", "scope": "project|platform", "text": "<one specific, checkable sentence>", '
            '"source": "<runId, specId or file>", "confidence": "high|medium|low"}], "retireFacts": ["<factId>"], '
            '"plan": {"increments": [{"id": "inc-1", "title": "<one line>", "status": "planned|in-progress|merged|dropped", "dependsOn": ["inc-0"], "specId": "<specId or empty>"}]}, '
            '"proposedDecisions": [{"title": "<short>", "context": "<why it came up>", "decision": "<what was decided>", "consequences": "<what it constrains>"}], '
            '"questions": [{"question": "<what only the person can answer>", "why": "<what depends on it>"}], "summary": "<three sentences>"}')

RULES = ("Rules: facts must be specific and sourced from the brief (a class, a config key, a package, a measured number); prefer few good facts over many; "
         "mark as platform what is true for the stack and reusable elsewhere, as project what is about this codebase; propose a decision for every choice the coder "
         "made that constrains future work; keep the plan as the remaining increments toward the goal in dependency order, marking what is merged; "
         "ask a question only when the next increment genuinely depends on the answer.")


def curate_headless(argv):
    if len(argv) < 2:
        raise RuntimeError("usage: curate <signalId>")
    cfg = config()
    rp = repo()
    sig = one(P["signals"], 'FROM $ WHERE $.signalId == "%s" LIMIT 1' % argv[1])
    if not sig:
        raise RuntimeError("signal %s not found" % argv[1])
    m = latest(P["map"], "at")
    prompt = "\n\n".join([
        "You are Hermann's brain, curating what the project knows after one merged iteration. You may read the repository in the current directory to verify anything in the brief. Do not change any file.",
        curation_brief(sig, m), RULES, CONTRACT])
    agent = resolve_agent(cfg, "brainAgent", "brainModel")
    res = run_headless(prompt, rp["localPath"], cfg, agent)
    text = res["summary"].get("summary", "") if isinstance(res.get("summary"), dict) else ""
    raw = res.get("stderr", "")
    # the reply is the answer: find the last JSON object in what came back
    blob = text or raw
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
    journal("t-hermann-curate-cmd", "curate", "headless curation by %s/%s for %s: %d facts, %d retired, %d decisions, %d questions (%ss)" % (
        agent["agentId"], agent["model"], sig["runId"], len(as_list(m_json.get("addFacts"))), len(as_list(m_json.get("retireFacts"))),
        len(as_list(m_json.get("proposedDecisions"))), len(as_list(m_json.get("questions"))), res["durationSec"]), runId=sig["runId"])
    return {"success": True, "curationId": m_json["curationId"], "facts": len(as_list(m_json.get("addFacts"))), "durationSec": res["durationSec"]}


# ---------------------------------------------------------------- apply a curation (from env, deterministic)
def env_json(name, default):
    v = envv(name)
    if not v:
        return default
    try:
        return json.loads(v)
    except ValueError:
        return default


def next_id(prefix, place, key):
    ids = [str((t.get("data") or {}).get(key, "")) for t in query(place, "FROM $", 500)]
    nums = [int(x.split("-")[-1]) for x in ids if x.startswith(prefix) and x.split("-")[-1].isdigit()]
    return "%s%03d" % (prefix, (max(nums) + 1) if nums else 1)


def norm(text):
    return re.sub(r"[^a-z0-9]+", " ", str(text).lower()).strip()


def apply(argv):
    curation_id = argv[1] if len(argv) > 1 and not argv[1].startswith("${") else envv("CURATION_ID", "cur-unknown")
    # the curation itself is read from the archive (arrays do not survive a map lane's environment)
    cur = one(P["curations"], 'FROM $ WHERE $.curationId == "%s" LIMIT 1' % curation_id)
    if not cur:
        raise RuntimeError("curation %s not found in the archive" % curation_id)
    run_id = str(cur.get("runId") or envv("RUN_ID"))
    add = [f if isinstance(f, dict) else as_dict(f) for f in as_list(cur.get("addFacts"))]
    retire = as_list(cur.get("retireFacts"))
    plan = cur.get("plan") if isinstance(cur.get("plan"), dict) else as_dict(cur.get("plan"))
    decisions = [d if isinstance(d, dict) else as_dict(d) for d in as_list(cur.get("proposedDecisions"))]
    questions = [q if isinstance(q, dict) else as_dict(q) for q in as_list(cur.get("questions"))]
    summary = str(cur.get("summary", ""))
    existing = active_facts()
    existing_norm = {norm(f.get("text")): f for f in existing}
    added, skipped, retired = [], 0, 0
    # retire first (never a person's answer)
    for fid in retire:
        for t in query(P["knowledge"], 'FROM $ WHERE $.factId == "%s" AND $.status == "active" LIMIT 1' % fid, 1):
            d = t.get("data") or {}
            if d.get("kind") == "answer":
                continue
            d["status"] = "retired"; d["retiredAt"] = now(); d["retiredBy"] = curation_id
            delete_token(P["knowledge"], t["id"]); put_token(P["knowledge"], d, name="%s-retired" % fid); retired += 1
    KIND_ALIASES = {"project": "convention", "platform-fact": "platform", "architecture": "decision", "design": "decision", "config": "convention", "configuration": "convention", "pattern": "convention",
                    "stack": "platform", "tooling": "platform", "library": "platform", "todo": "gap", "missing": "gap", "debt": "gap", "issue": "risk",
                    "warning": "risk", "open": "question", "unknown": "question", "fact": "convention", "knowledge": "convention"}
    skipped_why = []
    for f in add:
        text = str(f.get("text", "")).strip()
        kind = str(f.get("kind", "gap")).strip().lower()
        kind = KIND_ALIASES.get(kind, kind)
        if not text:
            skipped += 1; skipped_why.append("empty"); continue
        if kind not in KINDS:
            kind = "convention"
        if norm(text) in existing_norm:
            skipped += 1; skipped_why.append("duplicate"); continue
        fid = next_id("k-", P["knowledge"], "factId")
        data = {"factId": fid, "kind": kind, "scope": "platform" if str(f.get("scope", "")).lower() == "platform" else "project", "text": text[:600],
                "source": str(f.get("source", run_id or curation_id))[:120], "confidence": str(f.get("confidence", "medium")).lower(), "status": "active",
                "at": now(), "curationId": curation_id}
        put_token(P["knowledge"], data, name=fid); existing_norm[norm(text)] = data; added.append(fid)
    # bound the active set: retire the oldest low/medium facts beyond MAX_ACTIVE
    active = active_facts()
    if len(active) > MAX_ACTIVE:
        victims = sorted([f for f in active if f.get("kind") != "answer"], key=lambda f: ({"low": 0, "medium": 1, "high": 2}.get(f.get("confidence"), 1), str(f.get("at", ""))))[: len(active) - MAX_ACTIVE]
        for v in victims:
            for t in query(P["knowledge"], 'FROM $ WHERE $.factId == "%s" AND $.status == "active" LIMIT 1' % v["factId"], 1):
                d = t.get("data") or {}; d["status"] = "retired"; d["retiredAt"] = now(); d["retiredBy"] = "budget"
                delete_token(P["knowledge"], t["id"]); put_token(P["knowledge"], d, name="%s-retired" % v["factId"]); retired += 1
    # the plan
    incs = [i if isinstance(i, dict) else as_dict(i) for i in as_list((plan or {}).get("increments"))]
    if incs:
        for t in query(P["plan"], "FROM $", 50):
            delete_token(P["plan"], t["id"])
        put_token(P["plan"], {"at": now(), "curationId": curation_id, "runId": run_id, "increments": incs[:30], "summary": summary[:600]}, name="plan-%s" % curation_id)
    # decisions -> proposed ADRs (deduped by title)
    known = {norm(a.get("title")) for a in adrs()}
    proposed = 0
    for d in decisions:
        title = str(d.get("title", "")).strip()
        if not title or norm(title) in known:
            continue
        adr_id = next_id("adr-", P["adr"], "adrId")
        put_token(P["adr"], {"adrId": adr_id, "title": title[:160], "context": str(d.get("context", ""))[:800], "decision": str(d.get("decision", ""))[:800],
                             "consequences": str(d.get("consequences", ""))[:600], "status": "proposed", "updatedAt": now(), "source": curation_id, "proposedBy": "hermann"}, name=adr_id)
        known.add(norm(title)); proposed += 1
    # questions -> interview prompts of kind brain
    asked = 0
    already = {norm(p.get("question", "")) for p in [t.get("data") or {} for t in query(P["prompts"], 'FROM $ WHERE $.kind == "brain"', 200)]}
    for n, qn in enumerate(questions[:3], 1):
        question = str(qn.get("question", "")).strip()
        if not question or norm(question) in already:
            continue
        pid = "pr-brain-%s-%d" % (curation_id, n)
        put_token(P["prompts"], {"promptId": pid, "iterationId": "brain-%s" % curation_id, "kind": "brain", "mode": "interview", "question": question,
                                 "context": str(qn.get("why", ""))[:400], "options": [{"value": "q1", "label": question, "description": str(qn.get("why", ""))[:300]}],
                                 "allowFreeText": True, "rationale": "asked by the brain after %s" % run_id, "at": now()}, name=pid)
        asked += 1
    started = ""
    sig = one(P["signals"], 'FROM $ WHERE $.runId == "%s" LIMIT 1' % run_id) if run_id else {}
    if str(sig.get("startIteration", "")).lower() == "true" and not sig.get("iterationStarted"):
        started = "it-%s" % now().replace(":", "").replace("-", "")
        put_token(P["iterate"], {"at": now(), "iterationId": started, "reason": "merged", "specId": sig.get("specId", ""), "requestedBy": "hermann"}, name=started)
        for t in query(P["signals"], 'FROM $ WHERE $.runId == "%s" LIMIT 5' % run_id, 5):
            d = t.get("data") or {}; d["iterationStarted"] = started
            delete_token(P["signals"], t["id"]); put_token(P["signals"], d, name="%s-done" % d.get("signalId", run_id))
    journal("t-hermann-apply-cmd", "apply", "curation %s applied: +%d facts (%d skipped: %s), %d retired, plan %s, %d decisions proposed, %d questions%s; %s" % (
        curation_id, len(added), skipped, ",".join(sorted(set(skipped_why))) or "-", retired, "replaced" if incs else "unchanged", proposed, asked, ("; next iteration %s started" % started) if started else "", summary[:160]), runId=run_id, curationId=curation_id)
    return {"success": True, "added": added, "skipped": skipped, "retired": retired, "planIncrements": len(incs), "proposedDecisions": proposed, "questions": asked, "nextIteration": started}


def answer(argv):
    prompt_id = argv[1] if len(argv) > 1 and not argv[1].startswith("${") else envv("PROMPT_ID")
    text = envv("ANSWER_TEXT")
    pr = one(P["prompts"], 'FROM $ WHERE $.promptId == "%s" LIMIT 1' % prompt_id)
    if not text:
        raise RuntimeError("empty answer for %s" % prompt_id)
    fid = next_id("k-", P["knowledge"], "factId")
    put_token(P["knowledge"], {"factId": fid, "kind": "answer", "scope": "project", "text": ("Q: %s A: %s" % (str(pr.get("question", ""))[:200], text))[:600],
                               "source": prompt_id, "confidence": "high", "status": "active", "at": now(), "curationId": ""}, name=fid)
    journal("t-hermann-apply-cmd", "answer", "the person answered %s; recorded as %s" % (prompt_id, fid), promptId=prompt_id)
    return {"success": True, "factId": fid}


def main(argv):
    if not argv:
        raise RuntimeError("usage: hermann-brain.py observe|map|curate|apply|answer ...")
    if argv[0] == "observe":
        return observe(argv)
    if argv[0] == "map":
        return {"success": True, "map": component_map(repo())["summary"]}
    if argv[0] == "curate":
        return curate_headless(argv)
    if argv[0] == "apply":
        return apply(argv)
    if argv[0] == "answer":
        return answer(argv)
    raise RuntimeError("unknown command %s" % argv[0])


if __name__ == "__main__":
    sys.exit(main_guard(LANE, main, sys.argv[1:]))
