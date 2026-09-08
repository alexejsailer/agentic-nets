#!/usr/bin/env python3
"""hermann-audit: the twelve factors, each measured on the repository and scored 0 to 3.

usage:
  hermann-audit.py factor <NN> <sha> [<repoId>]   one factor -> p-hermann-factor-reports
  hermann-audit.py scorecard <sha> [<repoId>]     aggregate the twelve -> p-hermann-scorecard
  hermann-audit.py all [<repoId>]                 all twelve then the scorecard (manual use)
Each report carries evidence (paths, lines) and a fix recipe. The check that finishes the set
queues the scorecard; the scorecard is idempotent per commit, so a duplicate request is harmless.
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
    body = {"data": data}
    if name:
        body["name"] = name
    return api("POST", "/api/runtime/places/%s/tokens?modelId=%s" % (place, MODEL), body)


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
    if v is None:
        return []
    if isinstance(v, list):
        return [str(x) for x in v]
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

LANE = "t-hermann-audit"

ENV_REF = re.compile(r"\$\{[A-Z0-9_]+")


def load_digest(sha):
    d = one(P["digest"], 'FROM $ WHERE $.sha == "%s" LIMIT 1' % sha)
    if not d:
        d = latest(P["digest"], "at")
    return d


def grep(root, rel_files, pattern, flags=0):
    rx = re.compile(pattern, flags)
    hits = []
    for rel in rel_files:
        path = os.path.join(root, rel)
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                for n, line in enumerate(f, 1):
                    if rx.search(line):
                        hits.append("%s:%d: %s" % (rel, n, line.strip()[:120]))
        except OSError:
            continue
    return hits


def resources_text(dg):
    return "\n".join(dg.get("resources", {}).values())


def props_of(dg):
    """Flatten yml/properties resources into 'dotted.key: value' lines for regex checks."""
    lines = []
    for name, text in dg.get("resources", {}).items():
        if name.endswith(".properties"):
            lines.extend(text.splitlines())
        elif name.endswith((".yml", ".yaml")):
            stack = []
            for raw in text.splitlines():
                if not raw.strip() or raw.strip().startswith("#"):
                    continue
                indent = len(raw) - len(raw.lstrip(" "))
                key, _, val = raw.strip().partition(":")
                while stack and stack[-1][0] >= indent:
                    stack.pop()
                stack.append((indent, key.strip()))
                if val.strip():
                    lines.append("%s: %s" % (".".join(k for _, k in stack), val.strip()))
    return lines


def prop(dg, key):
    for line in props_of(dg):
        if line.startswith(key + ":") or line.startswith(key + "="):
            return line.split(":", 1)[1].strip() if ":" in line else line.split("=", 1)[1].strip()
    return ""


def dep_present(dg, artifact_substr, scope=None):
    for d in dg.get("pom", {}).get("dependencies", []):
        if artifact_substr in d.get("a", "") and (scope is None or d.get("scope", "compile") == scope):
            return True
    return False


# ---------------------------------------------------------------- the twelve checks
def f01(dg, root):
    ev, score = [], 0
    remotes = [r for r in dg.get("remotes", []) if "(fetch)" in r]
    if os.path.isdir(os.path.join(root, ".git")):
        score += 1; ev.append("git repository at %s" % root)
    else:
        ev.append("no .git directory")
    if len(remotes) == 1:
        score += 1; ev.append("one remote: %s" % remotes[0].split()[1])
    else:
        ev.append("%d remotes (want exactly one)" % len(remotes))
    nested = [f for f in dg.get("tree", []) if f.count("/.git/") or f.endswith("/.git")]
    if not nested and "main" in [b.strip() for b in dg.get("branches", [])]:
        score += 1; ev.append("main branch present, no nested repositories")
    else:
        ev.append("nested repositories or no main branch: %s" % (nested[:3] or "no main"))
    return score, ev, "one service, one repository, one main branch with a single remote on the git host"


def f02(dg, root):
    ev, score = [], 0
    if os.path.exists(os.path.join(root, "mvnw")) and os.path.exists(os.path.join(root, ".mvn", "wrapper", "maven-wrapper.properties")):
        score += 1; ev.append("Maven wrapper committed")
    else:
        ev.append("no Maven wrapper (mvnw + .mvn/wrapper)")
    snaps = dg.get("pom", {}).get("snapshots", [])
    if not snaps:
        score += 1; ev.append("no SNAPSHOT dependencies")
    else:
        ev.append("SNAPSHOT dependencies: %s" % ", ".join(snaps[:5]))
    rc, o, e = run(["./mvnw", "-q", "-B", "-DskipTests", "dependency:analyze", "-DignoreNonCompile=true"], cwd=root, timeout=900, check=False)
    text = o + e
    if rc == 0 and "Used undeclared dependencies" not in text:
        score += 1; ev.append("dependency:analyze clean (no used-undeclared)")
    elif rc == 0:
        ev.append("used-undeclared dependencies: " + " ".join(l.strip() for l in text.splitlines() if "[WARNING]" in l and ":" in l)[:300])
    else:
        ev.append("dependency:analyze failed: %s" % text[-200:].strip())
    return score, ev, "commit the wrapper, declare every used dependency in pom.xml, no SNAPSHOT versions on main"


def f03(dg, root):
    ev, score = [], 0
    res_files = [f for f in dg.get("resources", {}) if "/test/" not in f]
    secrets = grep(root, res_files, r"(?<![A-Za-z0-9_$])(password|passwd|secret|token|api[-_]?key)\s*[:=]\s*['\"]?(?!\$\{)[^\s'\"$]{4,}", re.I)
    if not secrets:
        score += 1; ev.append("no literal credentials in main resources")
    else:
        ev.extend(secrets[:4])
    literal_hosts = grep(root, res_files, r"(jdbc:[a-z]+://|https?://)(?!\$\{)(?!localhost)(?!127\.0\.0\.1)[a-z0-9.-]+", re.I)
    if not literal_hosts:
        score += 1; ev.append("no literal hostnames in main resources")
    else:
        ev.extend(literal_hosts[:4])
    url = prop(dg, "spring.datasource.url")
    if ENV_REF.search(url):
        score += 1; ev.append("datasource url bound to the environment: %s" % url[:80])
    else:
        ev.append("datasource url is not environment-bound: %s" % (url[:80] or "(unset)"))
    return score, ev, "bind every deploy-specific value with ${ENV_VAR:default}; credentials only from the environment"


def f04(dg, root):
    ev, score = [], 0
    backing = [l for l in props_of(dg) if re.match(r"spring\.(datasource\.url|data\.redis\.(host|url)|kafka\.bootstrap-servers|rabbitmq\.(host|addresses)|mail\.host|elasticsearch\.uris)", l)]
    unbound = [l for l in backing if not ENV_REF.search(l)]
    if backing and not unbound:
        score += 1; ev.append("all %d backing-service settings are environment-bound" % len(backing))
    else:
        ev.append("backing services not bound to the environment: %s" % (unbound[:3] or "none declared"))
    if dg.get("compose"):
        score += 1; ev.append("compose file provides the backing services locally")
    else:
        ev.append("no compose file for local backing services")
    embedded = [d["a"] for d in dg.get("pom", {}).get("dependencies", []) if d["a"] in ("h2", "hsqldb", "derby") and d.get("scope", "compile") in ("compile", "runtime")]
    if not embedded:
        score += 1; ev.append("no embedded database in the runtime scope")
    else:
        ev.append("embedded database in runtime scope: %s" % embedded)
    return score, ev, "attach every backing service by URL from the environment; run the real engine locally through compose"


def f05(dg, root):
    ev, score = [], 0
    df = dg.get("dockerfile", "")
    froms = [l for l in df.splitlines() if l.strip().upper().startswith("FROM ")]
    if len(froms) >= 2:
        score += 1; ev.append("multi-stage Dockerfile (%d stages)" % len(froms))
    else:
        ev.append("Dockerfile has %d stage(s); want a build stage and a run stage" % len(froms))
    if froms:
        final = df.split(froms[-1], 1)[1]
        if not re.search(r"\b(mvnw|mvn|gradle|gradlew|npm)\b", final):
            score += 1; ev.append("run stage has no build tooling")
        else:
            ev.append("run stage still invokes a build tool")
    sha_tag = any(re.search(r"rev-parse|GIT_SHA|COMMIT_SHA", s) for s in dg.get("scripts", {}).values())
    if sha_tag:
        score += 1; ev.append("image build tags by commit (bin/*.sh)")
    else:
        ev.append("no build script that tags the image by commit")
    return score, ev, "multi-stage Dockerfile, run stage without build tools, image tagged by the commit it was built from"


def f06(dg, root):
    ev, score = [], 0
    mains = dg.get("mainJava", [])
    session = grep(root, mains, r"HttpSession|@SessionScope|@SessionAttributes|@Scope\(\"session\"\)")
    if not session:
        score += 1; ev.append("no HTTP session state")
    else:
        ev.extend(session[:3])
    files = grep(root, mains, r"new File(Writer|OutputStream)\(|Files\.write|Files\.newBufferedWriter|createTempFile")
    if not files:
        score += 1; ev.append("no local file writes")
    else:
        ev.extend(files[:3])
    statics = grep(root, mains, r"static\s+(final\s+)?(Map|List|Set|HashMap|ArrayList|HashSet|ConcurrentHashMap)<[^>]*>\s+\w+\s*=\s*new")
    if not statics:
        score += 1; ev.append("no static mutable collections")
    else:
        ev.extend(statics[:3])
    return score, ev, "keep state in backing services; no session, no local files, no static mutable caches"


def f07(dg, root):
    ev, score = [], 0
    port = prop(dg, "server.port")
    if ENV_REF.search(port):
        score += 1; ev.append("server.port bound to the environment: %s" % port)
    else:
        ev.append("server.port not environment-bound: %s" % (port or "(default)"))
    if dg.get("pom", {}).get("packaging", "jar") == "jar":
        score += 1; ev.append("jar packaging with the embedded server")
    else:
        ev.append("packaging %s (want jar)" % dg.get("pom", {}).get("packaging"))
    if re.search(r"^EXPOSE\s+\d+", dg.get("dockerfile", ""), re.M):
        score += 1; ev.append("Dockerfile declares the port")
    else:
        ev.append("Dockerfile has no EXPOSE")
    return score, ev, "server.port from PORT, jar packaging, EXPOSE in the Dockerfile"


def f08(dg, root):
    ev, score = [], 0
    mains = dg.get("mainJava", [])
    scheduled = grep(root, mains, r"@Scheduled\b")
    if not scheduled or dep_present(dg, "shedlock") or dep_present(dg, "quartz"):
        score += 1; ev.append("no in-process scheduling, or it is cluster-safe (%d @Scheduled)" % len(scheduled))
    else:
        ev.append("@Scheduled without a cluster lock runs once per replica: " + scheduled[0])
    cache = prop(dg, "spring.cache.type")
    simple = grep(root, mains, r"ConcurrentMapCacheManager|SimpleCacheManager")
    if cache != "simple" and not simple:
        score += 1; ev.append("no in-memory cache manager")
    else:
        ev.append("in-memory cache would diverge across replicas")
    if "MaxRAMPercentage" in dg.get("dockerfile", ""):
        score += 1; ev.append("JVM sized by the container (MaxRAMPercentage)")
    else:
        ev.append("JVM memory not container-relative")
    return score, ev, "scale by adding replicas: cluster-safe scheduling, shared caches, container-relative JVM sizing"


def f09(dg, root):
    ev, score = [], 0
    if prop(dg, "server.shutdown") == "graceful":
        score += 1; ev.append("server.shutdown=graceful")
    else:
        ev.append("server.shutdown is not graceful")
    if prop(dg, "spring.lifecycle.timeout-per-shutdown-phase"):
        score += 1; ev.append("shutdown grace period configured")
    else:
        ev.append("no spring.lifecycle.timeout-per-shutdown-phase")
    if re.search(r"^(ENTRYPOINT|CMD)\s+\[", dg.get("dockerfile", ""), re.M):
        score += 1; ev.append("exec-form entrypoint: SIGTERM reaches the JVM")
    else:
        ev.append("entrypoint is not exec form (a shell would swallow SIGTERM)")
    ver = latest(P["verification"], "at", 'FROM $ WHERE $.sha == "%s"' % dg.get("sha", ""))
    if ver.get("startupSeconds"):
        ev.append("measured startup %ss" % ver["startupSeconds"])
    return score, ev, "graceful shutdown with a grace period and an exec-form entrypoint; keep startup within seconds"


def f10(dg, root):
    ev, score = [], 0
    url = prop(dg, "spring.datasource.url")
    engine = re.search(r"jdbc:([a-z]+)", url)
    compose = dg.get("compose", "")
    images = {"postgresql": "postgres", "mysql": "mysql", "mariadb": "mariadb", "sqlserver": "mssql", "oracle": "oracle"}
    if engine and images.get(engine.group(1), engine.group(1)) in compose:
        score += 1; ev.append("compose runs the same engine as the datasource (%s)" % engine.group(1))
    else:
        ev.append("compose does not provide the production engine (%s)" % (engine.group(1) if engine else "unknown"))
    tests = dg.get("testJava", [])
    tc_used = grep(root, tests, r"@ServiceConnection|Testcontainers|@Container")
    if dep_present(dg, "testcontainers") and tc_used:
        score += 1; ev.append("Testcontainers used by tests (%s)" % tc_used[0].split(":")[0])
    else:
        ev.append("tests do not use Testcontainers")
    test_embedded = [d["a"] for d in dg.get("pom", {}).get("dependencies", []) if d["a"] in ("h2", "hsqldb", "derby")]
    if not test_embedded:
        score += 1; ev.append("no embedded database in tests")
    else:
        ev.append("tests use an embedded database: %s" % test_embedded)
    return score, ev, "the same backing services in development, tests and production"


def f11(dg, root):
    ev, score = [], 0
    logback_files = dg.get("logback", [])
    file_appender = grep(root, logback_files, r"FileAppender|RollingFileAppender") if logback_files else []
    if not file_appender and not prop(dg, "logging.file.name") and not prop(dg, "logging.file.path"):
        score += 1; ev.append("no file appenders, logs go to stdout")
    else:
        ev.append("file logging configured: %s" % (file_appender[:2] or "logging.file.*"))
    if prop(dg, "logging.structured.format.console") or grep(root, logback_files, r"JsonEncoder|LogstashEncoder|JsonLayout"):
        score += 1; ev.append("structured log format on the console")
    else:
        ev.append("console logs are not structured")
    prints = grep(root, dg.get("mainJava", []), r"System\.(out|err)\.print")
    if not prints:
        score += 1; ev.append("no System.out logging")
    else:
        ev.extend(prints[:3])
    return score, ev, "stdout only, structured, through the logger"


def f12(dg, root):
    ev, score = [], 0
    if dep_present(dg, "flyway") or dep_present(dg, "liquibase"):
        score += 1; ev.append("schema migrations managed by Flyway/Liquibase")
    else:
        ev.append("no migration tool on the classpath")
    versioned = [m for m in dg.get("migrations", []) if re.search(r"/V\d+[^/]*__", m)]
    if versioned:
        score += 1; ev.append("%d versioned migration(s), latest %s" % (len(versioned), versioned[-1].rsplit("/", 1)[-1]))
    else:
        ev.append("no versioned migration files")
    runner = grep(root, dg.get("mainJava", []), r"APP_TASK|ApplicationRunner|CommandLineRunner|spring-shell")
    if runner:
        score += 1; ev.append("one-off admin runner present (%s)" % runner[0].split(":")[0])
    else:
        ev.append("no admin-task runner")
    return score, ev, "migrations as versioned files, admin tasks as one-off processes of the same image"


CHECKS = {"01": f01, "02": f02, "03": f03, "04": f04, "05": f05, "06": f06, "07": f07, "08": f08, "09": f09, "10": f10, "11": f11, "12": f12}


def write_report(num, sha, repo_id, score, ev, fix):
    key, name, tagline = [(k, n, t) for (x, k, n, t) in FACTORS if x == num][0]
    for t in query(P["reports"], 'FROM $ WHERE $.sha == "%s" AND $.factor == "%s" LIMIT 20' % (sha, num), 20):
        delete_token(P["reports"], t["id"])
    data = {"at": now(), "factor": num, "key": key, "name": name, "tagline": tagline, "score": str(score), "maxScore": "3",
            "status": "pass" if score == 3 else ("weak" if score == 2 else "fail"), "evidence": ev[:12], "fix": fix,
            "sha": sha, "sha7": sha[:7], "repoId": repo_id}
    put_token(P["reports"], data, name="report-%s-%s" % (sha[:7], num))
    return data


def factor(argv):
    if len(argv) < 3:
        raise RuntimeError("usage: factor <NN> <sha> [<repoId>]")
    num, sha = argv[1].zfill(2), argv[2]
    if num not in CHECKS:
        raise RuntimeError("unknown factor %s" % num)
    dg = load_digest(sha)
    if not dg:
        raise RuntimeError("no digest for %s; run the digest first" % sha[:7])
    root = dg["localPath"]
    repo_id = argv[3] if len(argv) > 3 and not argv[3].startswith("${") else dg.get("repoId", "")
    score, ev, fix = CHECKS[num](dg, root)
    report = write_report(num, sha, repo_id, score, ev, fix)
    done = len({(t.get("data") or {}).get("factor") for t in query(P["reports"], 'FROM $ WHERE $.sha == "%s" LIMIT 50' % sha, 50)})
    queued = False
    if done >= 12 and not query(P["audit_cmd"], 'FROM $ WHERE $.stage == "scorecard" AND $.sha == "%s" LIMIT 1' % sha, 1):
        put_token(P["audit_cmd"], command_token("hermann-audit", ["scorecard", sha, repo_id], stage="scorecard", timeout_ms=300000, sha=sha, repoId=repo_id),
                  name="scorecard-req-%s" % sha[:7])
        queued = True
    journal("t-hermann-f%s-%s" % (num, report["key"]), "factor", "factor %s %s: %s/3 (%s)%s" % (num, report["name"], score, report["status"], "; scorecard queued" if queued else ""), sha=sha, factor=num, score=str(score))
    return {"success": True, "factor": num, "score": score, "status": report["status"], "reportsDone": done, "scorecardQueued": queued}


def scorecard(argv):
    if len(argv) < 2:
        raise RuntimeError("usage: scorecard <sha> [<repoId>]")
    sha = argv[1]
    reports = [t.get("data") or {} for t in query(P["reports"], 'FROM $ WHERE $.sha == "%s" LIMIT 50' % sha, 50)]
    by_factor = {}
    for r in reports:
        by_factor[r.get("factor")] = r
    if len(by_factor) < 12:
        raise RuntimeError("only %d of 12 factor reports exist for %s" % (len(by_factor), sha[:7]))
    rows = [by_factor[n] for n, _, _, _ in FACTORS]
    total = sum(as_int(r.get("score")) for r in rows)
    percent = round(100.0 * total / 36, 1)
    grade = "A" if percent >= 90 else ("B" if percent >= 75 else ("C" if percent >= 60 else "D"))
    repo_id = rows[0].get("repoId", "") or (argv[2] if len(argv) > 2 else "")
    data = {"at": now(), "sha": sha, "sha7": sha[:7], "repoId": repo_id, "total": str(total), "max": "36", "percent": str(percent), "grade": grade,
            "failing": [r["factor"] + " " + r["name"] for r in rows if r.get("status") == "fail"],
            "weak": [r["factor"] + " " + r["name"] for r in rows if r.get("status") == "weak"],
            "passing": str(sum(1 for r in rows if r.get("status") == "pass")),
            "factors": [{"factor": r["factor"], "key": r["key"], "name": r["name"], "score": r["score"], "status": r["status"], "fix": r["fix"]} for r in rows]}
    for t in query(P["scorecard"], 'FROM $ WHERE $.sha == "%s" LIMIT 20' % sha, 20):
        delete_token(P["scorecard"], t["id"])
    put_token(P["scorecard"], data, name="scorecard-%s" % sha[:7])
    keep_last(P["scorecard"], "at", 30)
    journal("t-hermann-scorecard-cmd", "scorecard", "twelve-factor scorecard for %s@%s: %d/36 (%s%%, grade %s); failing %s; weak %s" % (
        repo_id, sha[:7], total, percent, grade, data["failing"] or "none", data["weak"] or "none"), sha=sha, grade=grade, total=str(total))
    return {"success": True, "sha": sha, "total": total, "percent": percent, "grade": grade, "failing": data["failing"], "weak": data["weak"]}


def run_all(argv):
    rp = repo(argv[1]) if len(argv) > 1 else repo()
    sha = head_sha(rp["localPath"])
    results = {}
    for num in CHECKS:
        results[num] = factor(["factor", num, sha, rp["repoId"]])["score"]
    sc = scorecard(["scorecard", sha, rp["repoId"]])
    return {"success": True, "scores": results, "scorecard": sc}


def main(argv):
    if not argv:
        raise RuntimeError("usage: hermann-audit.py factor|scorecard|all ...")
    if argv[0] == "factor":
        return factor(argv)
    if argv[0] == "scorecard":
        return scorecard(argv)
    if argv[0] == "all":
        return run_all(argv)
    raise RuntimeError("unknown command %s" % argv[0])


if __name__ == "__main__":
    sys.exit(main_guard(LANE, main, sys.argv[1:]))
