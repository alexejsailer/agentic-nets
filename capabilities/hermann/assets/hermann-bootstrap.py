#!/usr/bin/env python3
"""hermann-bootstrap: a new Spring Boot service, twelve-factor from the first commit.

usage: hermann-bootstrap.py bootstrap [--force]
Reads p-hermann-config (groupId, artifactId, packageName, javaVersion, bootVersion, dependencies),
downloads the Spring Initializr project, adds what Initializr does not ship (env-bound config,
structured stdout logging, graceful shutdown, health probes, multi-stage Dockerfile, Flyway
baseline, an admin-task runner, a health smoke test, a SHA-tagged image build script), proves it
compiles, commits, pushes to the git host, protects main and requests the first audit.
"""
import io
import json
import os
import re
import shutil
import stat
import sys
import urllib.parse
import urllib.request
import zipfile

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

LANE = "t-hermann-setup-cmd"
INITIALIZR = "https://start.spring.io/starter.zip"
RELEASES = "https://api.spring.io/projects/spring-boot/releases"

APPLICATION_YML = """# Factor III: every deploy-specific value comes from the environment (defaults are for a laptop).
spring:
  application:
    name: __NAME__
  datasource:
    url: ${DATABASE_URL:jdbc:postgresql://localhost:5432/__NAME__}
    username: ${DATABASE_USERNAME:__NAME__}
    password: ${DATABASE_PASSWORD:__NAME__}
  jpa:
    open-in-view: false
    hibernate:
      ddl-auto: validate
  flyway:
    enabled: true
  lifecycle:
    timeout-per-shutdown-phase: ${SHUTDOWN_GRACE:20s}
  docker:
    compose:
      enabled: ${DOCKER_COMPOSE_ENABLED:true}
      lifecycle-management: start-only

# Factor VII: the service binds its own port.
server:
  port: ${PORT:8080}
  # Factor IX: graceful shutdown on SIGTERM.
  shutdown: graceful

management:
  endpoints:
    web:
      exposure:
        include: health,info
  endpoint:
    health:
      probes:
        enabled: true
      show-details: ${HEALTH_DETAILS:never}

# Factor XI: logs are an event stream on stdout, structured.
logging:
  structured:
    format:
      console: ${LOG_FORMAT:ecs}
  level:
    root: ${LOG_LEVEL:INFO}
"""

DOCKERFILE = """# syntax=docker/dockerfile:1
# Factor V: the build stage produces an immutable artifact; the run stage only runs it.
FROM eclipse-temurin:__JAVA__-jdk AS build
WORKDIR /workspace
COPY .mvn/ .mvn/
COPY mvnw pom.xml ./
RUN --mount=type=cache,target=/root/.m2 ./mvnw -q -B dependency:go-offline || true
COPY src ./src
RUN --mount=type=cache,target=/root/.m2 ./mvnw -q -B -DskipTests package \\
    && cp target/*.jar /workspace/app.jar \\
    && java -Djarmode=tools -jar /workspace/app.jar extract --destination /workspace/extracted

FROM eclipse-temurin:__JAVA__-jre
RUN useradd --system --uid 10001 --create-home app
WORKDIR /app
COPY --from=build /workspace/extracted/lib/ ./lib/
COPY --from=build /workspace/extracted/app.jar ./app.jar
USER app
EXPOSE 8080
# Factor VIII: memory follows the container, so replicas are interchangeable. Exec form: SIGTERM reaches the JVM.
ENTRYPOINT ["java", "-XX:MaxRAMPercentage=75.0", "-XX:+ExitOnOutOfMemoryError", "-jar", "app.jar"]
"""

DOCKERIGNORE = """target/
.git/
.idea/
*.iml
.mvn/wrapper/*.jar
"""

COMPOSE = """# Factor IV and X: the same backing service locally as in production, attached by URL.
services:
  postgres:
    image: 'postgres:17'
    environment:
      - 'POSTGRES_DB=__NAME__'
      - 'POSTGRES_PASSWORD=__NAME__'
      - 'POSTGRES_USER=__NAME__'
    ports:
      - '5432'
"""

BASELINE_SQL = """-- Factor XII: schema changes are versioned migrations run by the release itself (Flyway on startup,
-- or APP_TASK=migrate as a one-off process).
CREATE TABLE IF NOT EXISTS app_metadata (
    key        VARCHAR(64) PRIMARY KEY,
    value      TEXT        NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO app_metadata (key, value) VALUES ('bootstrapped_by', 'hermann')
ON CONFLICT (key) DO NOTHING;
"""

ADMIN_TASKS = """package __PKG__;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.SpringApplication;
import org.springframework.context.ApplicationContext;
import org.springframework.stereotype.Component;

/**
 * Factor XII: one-off admin tasks run as processes of the same release, against the same config.
 * Start the same image with APP_TASK=migrate (Flyway has migrated on startup, the process exits)
 * or APP_TASK=hello; without APP_TASK the service runs normally.
 */
@Component
public class AdminTasks implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(AdminTasks.class);
    private final ApplicationContext context;

    public AdminTasks(ApplicationContext context) {
        this.context = context;
    }

    @Override
    public void run(ApplicationArguments args) {
        String task = System.getenv("APP_TASK");
        if (task == null || task.isBlank()) {
            return;
        }
        log.info("admin task '{}' starting", task);
        int exit = switch (task) {
            case "migrate" -> 0;
            case "hello" -> {
                log.info("hello from {}", context.getId());
                yield 0;
            }
            default -> {
                log.error("unknown admin task '{}'", task);
                yield 2;
            }
        };
        log.info("admin task '{}' finished with exit {}", task, exit);
        System.exit(SpringApplication.exit(context, () -> exit));
    }
}
"""

HEALTH_TEST = """package __PKG__;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.core.env.Environment;
__IMPORT_TC__
import static org.assertj.core.api.Assertions.assertThat;

/** Factor VII and IX: the service binds its own port and answers the liveness probe. */
__ANNOTATE_TC__
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class ActuatorHealthTest {

    @Autowired
    Environment environment;

    @Test
    void healthIsUp() throws Exception {
        String port = environment.getProperty("local.server.port");
        assertThat(port).isNotBlank();
        HttpRequest request = HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/actuator/health")).GET().build();
        HttpResponse<String> response = HttpClient.newHttpClient().send(request, HttpResponse.BodyHandlers.ofString());
        assertThat(response.statusCode()).isEqualTo(200);
        assertThat(response.body()).contains("\\"status\\":\\"UP\\"");
    }
}
"""

BUILD_IMAGE = """#!/usr/bin/env bash
# Factor V: one build per commit, tagged by the commit it was built from. A release is this image
# plus the environment it runs with; nothing is built at run time.
set -euo pipefail
cd "$(dirname "$0")/.."
SHA=$(git rev-parse --short=12 HEAD)
IMAGE="${IMAGE:-__NAME__}"
docker build -t "$IMAGE:$SHA" .
echo "$IMAGE:$SHA"
"""

README = """# __NAME__

Built by Hermann, a twelve-factor Spring Boot developer. Boot __BOOT__, Java __JAVA__.

| Factor | Where it lives |
|---|---|
| I Codebase | this repository, `main` protected, features on branches, merges through pull requests |
| II Dependencies | `pom.xml` and the Maven wrapper; nothing assumed from the host |
| III Config | `src/main/resources/application.yml` binds every deploy value to an environment variable |
| IV Backing services | `DATABASE_URL`, `DATABASE_USERNAME`, `DATABASE_PASSWORD`; `compose.yaml` runs the same engine locally |
| V Build, release, run | `Dockerfile` (multi-stage), `bin/build-image.sh` tags the image by commit |
| VI Processes | stateless; no session state, no local files |
| VII Port binding | `PORT` (default 8080), embedded server |
| VIII Concurrency | run more containers; the JVM sizes itself to the container |
| IX Disposability | graceful shutdown (`SHUTDOWN_GRACE`), exec-form entrypoint |
| X Dev/prod parity | Postgres in `compose.yaml` and in Testcontainers |
| XI Logs | structured JSON on stdout (`LOG_FORMAT`, `LOG_LEVEL`) |
| XII Admin processes | Flyway migrations in `db/migration`, `APP_TASK=<task>` runs a one-off process of the same image |

Run locally: `./mvnw spring-boot:run` (starts Postgres through Docker Compose).
Test: `./mvnw verify` (Testcontainers needs Docker).
Build an image: `bin/build-image.sh`. Run it: `docker run -e DATABASE_URL=... -p 8080:8080 __NAME__:<sha>`.

Architecture decisions live in `docs/adr/`; each merged feature keeps its spec in `docs/specs/`.
"""

ADR_README = """# Architecture decision records

One file per accepted decision, numbered, never edited after acceptance (superseded instead).
Hermann writes them from the decisions taken in the application; the record here is the copy the
code carries with it.
"""


def current_boot_version():
    with urllib.request.urlopen(RELEASES, timeout=30) as r:
        body = json.loads(r.read().decode("utf-8"))
    releases = body.get("_embedded", {}).get("releases", [])
    for rel in releases:
        if rel.get("current"):
            return str(rel["version"])
    ga = [r["version"] for r in releases if r.get("status") == "GENERAL_AVAILABILITY"]
    if not ga:
        raise RuntimeError("no GA Spring Boot release listed by api.spring.io")
    return str(sorted(ga)[-1])


def download_project(cfg, name, package, boot, java, deps, description):
    form = {
        "type": "maven-project", "language": "java", "bootVersion": boot, "baseDir": name,
        "groupId": cfg.get("groupId", "dev.hermann"), "artifactId": name, "name": name,
        "description": description, "packageName": package, "packaging": "jar", "javaVersion": java,
        "dependencies": ",".join(deps),
    }
    req = urllib.request.Request(INITIALIZR, data=urllib.parse.urlencode(form).encode("utf-8"), method="POST")
    req.add_header("Accept", "application/zip")
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def write(path, text, executable=False):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    if executable:
        os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def scaffold(root, name, package, boot, java):
    pkg_dir = os.path.join(root, "src", "main", "java", *package.split("."))
    test_dir = os.path.join(root, "src", "test", "java", *package.split("."))
    res = os.path.join(root, "src", "main", "resources")
    props = os.path.join(res, "application.properties")
    if os.path.exists(props):
        os.remove(props)
    write(os.path.join(res, "application.yml"), APPLICATION_YML.replace("__NAME__", name))
    write(os.path.join(res, "db", "migration", "V1__baseline.sql"), BASELINE_SQL)
    write(os.path.join(root, "Dockerfile"), DOCKERFILE.replace("__JAVA__", java))
    write(os.path.join(root, ".dockerignore"), DOCKERIGNORE)
    if not os.path.exists(os.path.join(root, "compose.yaml")):
        write(os.path.join(root, "compose.yaml"), COMPOSE.replace("__NAME__", name))
    write(os.path.join(pkg_dir, "AdminTasks.java"), ADMIN_TASKS.replace("__PKG__", package))
    has_tc = os.path.exists(os.path.join(test_dir, "TestcontainersConfiguration.java"))
    test = HEALTH_TEST.replace("__PKG__", package)
    test = test.replace("__IMPORT_TC__\n", "import org.springframework.context.annotation.Import;\n" if has_tc else "")
    test = test.replace("__ANNOTATE_TC__\n", "@Import(TestcontainersConfiguration.class)\n" if has_tc else "")
    write(os.path.join(test_dir, "ActuatorHealthTest.java"), test)
    write(os.path.join(root, "bin", "build-image.sh"), BUILD_IMAGE.replace("__NAME__", name), executable=True)
    write(os.path.join(root, "README.md"), README.replace("__NAME__", name).replace("__BOOT__", boot).replace("__JAVA__", java))
    write(os.path.join(root, "docs", "adr", "README.md"), ADR_README)
    write(os.path.join(root, "docs", "specs", ".gitkeep"), "")
    mvnw = os.path.join(root, "mvnw")
    if os.path.exists(mvnw):
        os.chmod(mvnw, os.stat(mvnw).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return has_tc


def bootstrap(argv):
    force = "--force" in argv
    cfg = config()
    name = str(cfg.get("artifactId", "")).strip()
    if not name or "REPLACE" in name.upper() or not re.match(r"^[a-z][a-z0-9-]{1,40}$", name):
        raise RuntimeError("set artifactId in the config first (lowercase letters, digits, dashes)")
    group = str(cfg.get("groupId", "dev.hermann")).strip()
    package = str(cfg.get("packageName") or (group + "." + re.sub(r"[^a-z0-9]", "", name))).strip()
    java = str(cfg.get("javaVersion", "21")).strip()
    boot = str(cfg.get("bootVersion", "current")).strip()
    if boot in ("", "current"):
        boot = current_boot_version()
    deps = as_list(cfg.get("dependencies")) or ["web", "actuator", "validation", "data-jpa", "postgresql", "flyway", "testcontainers", "docker-compose"]
    description = str(cfg.get("description") or "A twelve-factor Spring Boot service built by Hermann")
    home = hermann_home(cfg)
    root = os.path.join(home, name)
    if os.path.exists(root) and os.listdir(root):
        if not force:
            raise RuntimeError("%s already exists and is not empty; pass --force to replace it" % root)
        shutil.rmtree(root)
    journal(LANE, "bootstrap", "downloading Spring Boot %s / Java %s project '%s' with %s" % (boot, java, name, ",".join(deps)))
    blob = download_project(cfg, name, package, boot, java, deps, description)
    with zipfile.ZipFile(io.BytesIO(blob)) as z:
        z.extractall(home)
    if not os.path.exists(os.path.join(root, "pom.xml")):
        raise RuntimeError("Initializr archive did not contain %s/pom.xml" % name)
    has_tc = scaffold(root, name, package, boot, java)
    journal(LANE, "bootstrap", "scaffold written; compiling with the Maven wrapper (first run downloads dependencies)")
    rc, o, e = run(["./mvnw", "-q", "-B", "-DskipTests", "package"], cwd=root, timeout=1500, check=False)
    if rc != 0:
        raise RuntimeError("the generated project does not build:\n" + (e or o)[-2500:])
    jar = [f for f in os.listdir(os.path.join(root, "target")) if f.endswith(".jar") and not f.endswith("-sources.jar")]
    body, created = ensure_repo(name, cfg)
    for t in query(P["repo"], 'FROM $ WHERE $.status == "bootstrapped" LIMIT 20', 20):
        d = t.get("data") or {}
        if d.get("repoId") and d.get("repoId") != name:
            d["status"] = "archived"; d["archivedAt"] = now(); d["updatedAt"] = d.get("updatedAt", "")
            delete_token(P["repo"], t["id"])
            put_token(P["repo"], d, name="repo-%s" % d["repoId"])
            journal(LANE, "bootstrap", "repository %s archived; Hermann now works on %s" % (d["repoId"], name))
    git(["init", "-b", "main"], cwd=root)
    git(["add", "-A"], cwd=root)
    git(["commit", "-q", "-m", "Bootstrap %s: Spring Boot %s on Java %s, twelve-factor from the first commit" % (name, boot, java)], cwd=root)
    clone_url = body.get("clone_url") or "%s/%s/%s.git" % (gitea_url(cfg), cfg.get("giteaUser", "hermann"), name)
    git(["remote", "add", "origin", clone_url], cwd=root)
    git(["push", "-u", "origin", "main"], cwd=root, timeout=600)
    sha = head_sha(root)
    st, _ = protect_main(name, cfg)
    data = record_repo(name, body, cfg, "bootstrapped", headSha=sha, bootVersion=boot, javaVersion=java, packageName=package,
                       groupId=group, dependencies=deps, bootstrappedAt=now(), jar=(jar[0] if jar else ""), protectedMain=str(st in (200, 201, 409)).lower())
    put_token(P["audit_req"], {"at": now(), "reason": "bootstrap", "repoId": name, "sha": sha}, name="audit-req-%s" % sha[:7])
    journal(LANE, "bootstrap", "%s bootstrapped: Boot %s, Java %s, pushed %s to %s, main protected (%s), first audit requested" % (
        name, boot, java, sha[:7], data["htmlUrl"], st))
    return {"success": True, "repo": data["htmlUrl"], "sha": sha, "bootVersion": boot, "javaVersion": java, "path": root,
            "testcontainers": has_tc, "repoCreated": created}


def main(argv):
    if not argv or argv[0] != "bootstrap":
        raise RuntimeError("usage: hermann-bootstrap.py bootstrap [--force]")
    return bootstrap(argv)


if __name__ == "__main__":
    sys.exit(main_guard(LANE, main, sys.argv[1:]))
