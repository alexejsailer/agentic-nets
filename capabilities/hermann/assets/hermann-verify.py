#!/usr/bin/env python3
"""hermann-verify: prove a pull request the twelve-factor way, in a clean worktree.

usage: hermann-verify.py verify <runId>
Fresh worktree at the PR head; `./mvnw verify` (tests with Testcontainers); image build tagged by
commit; the image started against a real Postgres on a private network with the configuration
from the environment; startup measured until /actuator/health answers; liveness and readiness
probed; SIGTERM sent and the graceful shutdown timed; stdout checked for structured log lines.
Writes p-hermann-verification and, on pass, queues the diff digest for the review.
"""
import glob
import json
import os
import re
import shutil
import sys
import time
import urllib.request

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

LANE = "t-hermann-verify-cmd"


def surefire_counts(root):
    tests = fails = errors = 0
    for f in glob.glob(os.path.join(root, "target", "surefire-reports", "*.txt")):
        m = re.search(r"Tests run: (\d+), Failures: (\d+), Errors: (\d+)", read_text(f, 20000))
        if m:
            tests += int(m.group(1)); fails += int(m.group(2)); errors += int(m.group(3))
    return tests, fails + errors


def http_status(url, timeout=3):
    try:
        with urllib.request.urlopen(urllib.request.Request(url), timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")[:300]
    except Exception as e:  # noqa: BLE001
        code = getattr(e, "code", 0)
        return code, str(e)[:120]


def verify(run_id):
    cfg = config()
    rp = repo()
    r = one(P["runs"], 'FROM $ WHERE $.runId == "%s" LIMIT 1' % run_id)
    if not r:
        raise RuntimeError("run %s not found" % run_id)
    root = rp["localPath"]
    sha = r.get("headSha", "")
    branch = r.get("branch", "")
    evidence = []
    ok = True
    work = os.path.join(hermann_home(cfg), ".verify", run_id)
    if os.path.exists(work):
        run(["git", "worktree", "remove", "--force", work], cwd=root, check=False)
        shutil.rmtree(work, ignore_errors=True)
    git(["fetch", "-q", "origin", branch], cwd=root)
    run(["git", "worktree", "prune"], cwd=root, check=False)
    run(["git", "worktree", "add", "--detach", work, sha], cwd=root, check=True)
    evidence.append("worktree at %s" % sha[:7])
    journal(LANE, "verify", "verifying %s (%s@%s): tests, image, container, probes, shutdown" % (run_id, branch, sha[:7]), runId=run_id)
    rc, o, e = run(["./mvnw", "-q", "-B", "verify"], cwd=work, timeout=1500, check=False)
    tests, failed = surefire_counts(work)
    if rc == 0 and failed == 0:
        evidence.append("./mvnw verify green: %d tests" % tests)
    else:
        ok = False
        evidence.append("./mvnw verify RED: %d tests, %d failed; %s" % (tests, failed, (e or o)[-400:].strip()))
    image = "%s:%s" % (rp["repoId"], sha[:12])
    image_built = False
    startup = shutdown = ""
    health_ok = live_ok = ready_ok = logs_structured = graceful_seen = False
    if ok:
        rc, o, e = run(["docker", "build", "-q", "-t", image, "."], cwd=work, timeout=1500, check=False)
        image_built = rc == 0
        evidence.append("image %s %s" % (image, "built" if image_built else "FAILED: " + (e or o)[-400:].strip()))
        ok = ok and image_built
    net = "hermann-verify-%s" % run_id[-12:]
    pg = "%s-pg" % net
    app = "%s-app" % net
    if ok:
        run(["docker", "network", "create", net], check=False)
        run(["docker", "run", "-d", "--rm", "--name", pg, "--network", net, "-e", "POSTGRES_DB=verify", "-e", "POSTGRES_USER=verify", "-e", "POSTGRES_PASSWORD=verify", "postgres:17"], check=True, timeout=300)
        for _ in range(60):
            rc, _, _ = run(["docker", "exec", pg, "pg_isready", "-U", "verify"], check=False)
            if rc == 0:
                break
            time.sleep(1)
        rc, cid, e = run(["docker", "run", "-d", "--name", app, "--network", net, "-p", "127.0.0.1::8080",
                          "-e", "DATABASE_URL=jdbc:postgresql://%s:5432/verify" % pg, "-e", "DATABASE_USERNAME=verify", "-e", "DATABASE_PASSWORD=verify",
                          "-e", "PORT=8080", "-e", "DOCKER_COMPOSE_ENABLED=false", "-e", "SHUTDOWN_GRACE=20s", image], check=False, timeout=120)
        if rc != 0:
            ok = False
            evidence.append("container did not start: %s" % (e or cid)[-300:])
        else:
            rc, port_out, _ = run(["docker", "port", app, "8080"], check=False)
            port = port_out.strip().rsplit(":", 1)[-1] if port_out.strip() else ""
            base = "http://127.0.0.1:%s" % port
            t0 = time.time()
            status = 0
            while time.time() - t0 < 150:
                status, _ = http_status(base + "/actuator/health")
                if status == 200:
                    break
                time.sleep(0.5)
            startup = str(round(time.time() - t0, 1))
            health_ok = status == 200
            evidence.append("health %s after %ss" % ("UP" if health_ok else "not reached (%s)" % status, startup))
            live_ok = http_status(base + "/actuator/health/liveness")[0] == 200
            ready_ok = http_status(base + "/actuator/health/readiness")[0] == 200
            evidence.append("liveness %s, readiness %s" % ("200" if live_ok else "not 200", "200" if ready_ok else "not 200"))
            t1 = time.time()
            run(["docker", "stop", "-t", "40", app], check=False, timeout=120)
            shutdown = str(round(time.time() - t1, 1))
            rc, logs, logs_err = run(["docker", "logs", app], check=False)
            log_text = (logs or "") + (logs_err or "")
            first = [l for l in log_text.splitlines() if l.strip()][:5]
            logs_structured = bool(first) and all(l.lstrip().startswith("{") for l in first)
            graceful_seen = "graceful" in log_text.lower()
            rc, inspect, _ = run(["docker", "inspect", "-f", "{{.State.ExitCode}}", app], check=False)
            evidence.append("SIGTERM: stopped in %ss, exit code %s, graceful shutdown %s in the log" % (shutdown, inspect.strip(), "seen" if graceful_seen else "NOT seen"))
            evidence.append("stdout %s" % ("is structured JSON" if logs_structured else "is NOT structured JSON: %s" % (first[0][:80] if first else "empty")))
            ok = ok and health_ok and live_ok and ready_ok and logs_structured
        run(["docker", "rm", "-f", app], check=False)
        run(["docker", "rm", "-f", pg], check=False)
        run(["docker", "network", "rm", net], check=False)
    run(["git", "worktree", "remove", "--force", work], cwd=root, check=False)
    shutil.rmtree(work, ignore_errors=True)
    data = {"at": now(), "runId": run_id, "specId": r.get("specId", ""), "sha": sha, "sha7": sha[:7], "branch": branch, "status": "pass" if ok else "fail",
            "testsRun": str(tests), "testsFailed": str(failed), "imageTag": image if image_built else "", "imageBuilt": str(image_built).lower(),
            "startupSeconds": startup, "shutdownSeconds": shutdown, "healthOk": str(health_ok).lower(), "livenessOk": str(live_ok).lower(),
            "readinessOk": str(ready_ok).lower(), "logsStructured": str(logs_structured).lower(), "gracefulSeen": str(graceful_seen).lower(), "evidence": evidence}
    for t in query(P["verification"], 'FROM $ WHERE $.runId == "%s" LIMIT 5' % run_id, 5):
        delete_token(P["verification"], t["id"])
    put_token(P["verification"], data, name="verify-%s" % run_id)
    if ok:
        put_token(P["review_cmd"], command_token("hermann-diff", ["diff", run_id], stage="diff", timeout_ms=300000, runId=run_id, specId=r.get("specId", "")), name="diff-%s" % run_id)
    journal(LANE, "verify", "%s %s: %d tests, image %s, startup %ss, shutdown %ss, logs %s" % (
        run_id, "PASS" if ok else "FAIL", tests, "built" if image_built else "not built", startup or "-", shutdown or "-", "structured" if logs_structured else "unstructured"),
        runId=run_id, status=data["status"])
    return {"success": ok, "runId": run_id, "tests": tests, "failed": failed, "startupSeconds": startup, "shutdownSeconds": shutdown, "evidence": evidence}


def main(argv):
    if len(argv) < 2 or argv[0] != "verify":
        raise RuntimeError("usage: hermann-verify.py verify <runId>")
    return verify(argv[1])


if __name__ == "__main__":
    sys.exit(main_guard(LANE, main, sys.argv[1:]))
