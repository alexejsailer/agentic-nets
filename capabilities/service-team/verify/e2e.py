#!/usr/bin/env python3
"""End-to-end proof of a service team under the product office, against a live runtime, on its own model.

usage: e2e.py [--model product-e2e] [--home ~/product-e2e] [--service node] [--keep] [--skip-llm]

What it proves, in order (every case measures; nothing is inferred from the pipeline's green):
  install     both packs install: the office once (session product), the team once per service with every
              id namespaced (p-<service>-team-*, t-<service>-team-*, net-<service>-team-*), app stores bound
  provision   the team stores the MCP token for its command lanes, clones the workspace repository into
              <home>/teams/<service>/<repo> and registers itself in the office (p-product-teams)
  allocate    an iteration allocated by the office reaches the team: the product owner measures the module
              (the fake analyst), renders the brief, and the one-shot proposes; the question is mirrored
              into the office inbox
  requirement the person's answer becomes a requirement under the contract and a draft for the architect
  spec        the architect builds the spec catalog (places + link transitions mirroring the code) and
              writes the spec; the person is asked to approve it (team prompt + office inbox)
  acceptance  the approval marks the spec approved, closes the inbox item, QA writes the acceptance
              criteria; the architect assembles the context pack and asks for approval (autonomy 3)
  implement   the approval starts the coder (the fake coder) on branch <service>/<specId> in the team's
              clone; the run is built and handed to QA
  verify      QA runs build and tests on the branch, compares the diff with the spec, writes the
              verification with evidence and hands the run to the reviewer
  review      the reviewer's verdict becomes the merge question for the person (team prompt + office inbox)
  merge       the person's decision runs the merge command: the clone's main has the merge commit, the
              workspace repository has the branch and (clean tree) the merge; the run and the spec are
              merged; the office got a release status row; the brain observes
  guard       a run without an approved spec is refused (spec before code)

Needs: the Desktop runtime on 127.0.0.1 (master 8082, MCP 8091), the service token and the MCP token
under ~/.agenticos/desktop, node, git and python3 on the executor host. The fake coder
(verify/fake-coder.py) replaces the headless model; the one-shot lanes (propose, requirement, design,
acceptance, review) call the model unless --skip-llm, which injects their answers.
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
PACK = os.path.dirname(HERE)
CAPS = os.path.dirname(PACK)
MASTER = os.environ.get("MASTER_URL", "http://127.0.0.1:8082").rstrip("/")
MCP_URL = os.environ.get("TEAM_MCP_URL", "http://127.0.0.1:8091/mcp")
SERVICE_TOKEN = open(os.path.expanduser("~/.agenticos/desktop/internal-secret")).read().strip()
MCP_TOKEN = open(os.path.expanduser("~/.agenticos/desktop/mcp-token")).read().strip()
RESULTS = []


def now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def stamp():
    return time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())


def api(method, path, body=None, timeout=300):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(MASTER + path, data=data, method=method, headers={"X-Service-Auth": "Bearer " + SERVICE_TOKEN, "Content-Type": "application/json", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            t = r.read().decode(); return r.status, (json.loads(t) if t.strip() else {})
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:800]


def mcp(name, args):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": args}}).encode()
    req = urllib.request.Request(MCP_URL, data=body, method="POST", headers={"Authorization": "Bearer " + MCP_TOKEN, "Content-Type": "application/json", "Accept": "application/json, text/event-stream"})
    with urllib.request.urlopen(req, timeout=300) as r:
        text = r.read().decode()
    msg = json.loads(text) if text.lstrip().startswith("{") else json.loads([l[5:] for l in text.split("\n") if l.startswith("data:")][-1])
    if msg.get("error"):
        raise RuntimeError("mcp %s: %s" % (name, msg["error"]))
    res = msg.get("result", {})
    inner = res.get("structuredContent")
    if inner is None:
        t = next((c.get("text") for c in res.get("content", []) if c.get("type") == "text"), "")
        try:
            inner = json.loads(t)
        except Exception:  # noqa: BLE001
            inner = {"_text": t}
    if res.get("isError"):
        raise RuntimeError("mcp %s failed: %s" % (name, json.dumps(inner)[:300]))
    return inner


class Model:
    def __init__(self, model):
        self.model = model

    def decode(self, d):
        out = {}
        for k, v in (d or {}).items():
            if isinstance(v, str) and v[:1] in "[{":
                try:
                    out[k] = json.loads(v); continue
                except ValueError:
                    pass
            out[k] = v
        return out

    def query(self, place, arcql="FROM $", limit=200):
        st, r = api("POST", "/api/runtime/places/%s/tokens/query?modelId=%s" % (place, self.model), {"arcql": arcql, "limit": limit})
        if st != 200:
            raise RuntimeError("query %s -> %s %s" % (place, st, r))
        items = r.get("content") or r.get("items") or r.get("tokens") or []
        return [{"id": t.get("id") or t.get("tokenId"), "name": t.get("name"), "data": self.decode(t.get("data") or t.get("properties") or {})} for t in items]

    def count(self, place):
        return len(self.query(place, "FROM $", 500))

    def put(self, place, data, name=None):
        body = {"data": data}
        if name:
            body["name"] = name
        st, r = api("POST", "/api/runtime/places/%s/tokens?modelId=%s" % (place, self.model), body)
        if st not in (200, 201):
            raise RuntimeError("put %s -> %s %s" % (place, st, r))
        return r

    def delete(self, place, token_id):
        return api("DELETE", "/api/runtime/places/%s/tokens/%s?modelId=%s" % (place, token_id, self.model))

    def clear(self, place):
        for t in self.query(place, "FROM $", 500):
            self.delete(place, t["id"])

    def cmd(self, place, tool, argv, timeout_ms=900000, **extra):
        tok = {"kind": "command", "id": "%s-%s" % (tool, stamp()), "executor": "script", "command": "invoke", "expect": "text",
               "args": {"toolId": tool, "argv": argv, "env": {"MODEL_ID": self.model}, "timeoutMs": timeout_ms}, "filedAt": now(), "stage": argv[0] if argv else ""}
        tok.update(extra)
        return self.put(place, tok, "%s-%s-%s" % (tool, "-".join(argv)[:24], stamp()))

    def lanes(self, prefix):
        rows = mcp("list_transitions", {"model": self.model}).get("transitions") or []
        return {str(r.get("transitionId")): str(r.get("status")) for r in rows if str(r.get("transitionId", "")).startswith(prefix)}

    def journal(self, place, n=5):
        rows = self.query(place, "FROM $", 400)
        rows.sort(key=lambda t: str(t["data"].get("at", "")), reverse=True)
        return [(t["data"].get("at"), t["data"].get("stage"), str(t["data"].get("summary"))[:160]) for t in rows[:n]]

    def wait(self, pred, timeout=600, every=4, what="condition", journal=None):
        t0 = time.time()
        while time.time() - t0 < timeout:
            v = pred()
            if v:
                return v, round(time.time() - t0, 1)
            time.sleep(every)
        raise TimeoutError("%s did not happen within %ss; journal: %s" % (what, timeout, self.journal(journal, 4) if journal else "-"))

    def newest(self, place, field="at", arcql="FROM $"):
        rows = self.query(place, arcql, 300)
        rows.sort(key=lambda t: str(t["data"].get(field, "")), reverse=True)
        return rows[0]["data"] if rows else {}

    def find(self, place, field, value):
        rows = [t["data"] for t in self.query(place, "FROM $", 400) if str(t["data"].get(field)) == str(value)]
        rows.sort(key=lambda d: str(d.get("updatedAt") or d.get("at", "")), reverse=True)
        return rows[0] if rows else {}


def check(name, ok, detail):
    RESULTS.append((name, bool(ok), detail))
    print("%s %-11s %s" % ("PASS" if ok else "FAIL", name, detail), flush=True)
    return bool(ok)


class Stages:
    def __init__(self):
        self.failed, self.passed = set(), set()

    def ready(self, name, needs):
        missing = [n for n in needs if n not in self.passed]
        if missing:
            print("SKIP %-11s needs %s" % (name, ", ".join(missing)), flush=True)
            RESULTS.append((name, False, "skipped: needs %s" % ", ".join(missing)))
            return False
        return True

    def fail(self, name, e):
        self.failed.add(name)
        check(name + "*", False, ("timeout: " if isinstance(e, TimeoutError) else type(e).__name__ + ": ") + str(e)[:600])

    def done(self, name):
        self.passed.add(name)


def sh(cmd, cwd, timeout=300):
    p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout)
    return p.returncode, (p.stdout or "") + (p.stderr or "")


def prepare_workspace(home, service):
    """A tiny workspace repository (core/<service dir>) the team clones and merges into."""
    ws = os.path.join(home, "workspace")
    if os.path.isdir(ws):
        shutil.rmtree(ws)
    repo = os.path.join(ws, "core"); sd = os.path.join(repo, "agentic-net-%s" % service)
    os.makedirs(os.path.join(sd, "src", "main", "java", "com", "example", service, "api"), exist_ok=True)
    os.makedirs(os.path.join(sd, "src", "main", "java", "com", "example", service, "store"), exist_ok=True)
    os.makedirs(os.path.join(sd, "src", "test", "java", "com", "example", service), exist_ok=True)
    open(os.path.join(sd, "README.md"), "w").write("# %s fixture\n\nA tiny service for the e2e proof.\n" % service)
    open(os.path.join(sd, "src", "main", "java", "com", "example", service, "api", "HealthController.java"), "w").write("package com.example.%s.api;\npublic class HealthController { public String health() { return \"UP\"; } }\n" % service)
    open(os.path.join(sd, "src", "main", "java", "com", "example", service, "store", "TokenStore.java"), "w").write("package com.example.%s.store;\npublic class TokenStore { }\n" % service)
    open(os.path.join(sd, "src", "test", "java", "com", "example", service, "HealthControllerTest.java"), "w").write("package com.example.%s;\npublic class HealthControllerTest { }\n" % service)
    open(os.path.join(repo, "README.md"), "w").write("# core fixture\n")
    for cmd in (["git", "init", "-q", "-b", "main"], ["git", "add", "-A"], ["git", "-c", "user.name=e2e", "-c", "user.email=e2e@localhost", "commit", "-q", "-m", "fixture"]):
        rc, out = sh(cmd, repo)
        if rc != 0:
            raise RuntimeError("fixture: %s failed: %s" % (" ".join(cmd[:2]), out[-300:]))
    return ws


def package(pack_dir):
    for cmd in (["node", os.path.join(CAPS, "tools", "pack.mjs"), "build", "--dir", pack_dir], ["node", os.path.join(CAPS, "tools", "pack.mjs"), "package", "--dir", pack_dir]):
        rc, out = sh(cmd, CAPS, 600)
        if rc != 0:
            raise RuntimeError("package %s failed: %s" % (pack_dir, out[-400:]))
    cap = open(os.path.join(CAPS, pack_dir, "capability.yaml")).read()
    version = re.search(r"^version:\s*(\S+)", cap, re.M).group(1).strip("\"'")
    return os.path.join(CAPS, pack_dir, "dist", "%s-%s.capability.json" % (pack_dir, version)), version


def install(model, name, version, session, artifact):
    art = json.load(open(artifact))
    st, r = api("PUT", "/api/hub/capabilities/%s/versions/%s" % (name, version), art)
    if st not in (200, 201):
        raise RuntimeError("publish %s -> %s %s" % (name, st, str(r)[:200]))
    api("DELETE", "/api/applications/%s/%s" % (model, session))
    st, r = api("POST", "/api/hub/install", {"source": "local", "name": name, "version": version, "targetModelId": model, "targetSessionId": session, "allowDowngrade": True})
    if st not in (200, 201):
        raise RuntimeError("install %s -> %s %s" % (name, st, str(r)[:300]))
    return r


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="product-e2e")
    ap.add_argument("--home", default="~/product-e2e")
    ap.add_argument("--service", default="node")
    ap.add_argument("--keep", action="store_true")
    ap.add_argument("--skip-llm", action="store_true")
    ap.add_argument("--repo-mode", default="workspace", choices=["workspace", "clone"],
                    help="workspace: the team branches in the fixture repository itself (the default the packs ship with); "
                         "clone: an isolated clone under the team home")
    a = ap.parse_args()
    home = os.path.expanduser(a.home); svc = a.service
    P = lambda x: "p-%s-team-%s" % (svc, x)  # noqa: E731
    T = lambda x: "t-%s-team-%s" % (svc, x)  # noqa: E731
    m = Model(a.model)
    st = Stages()
    t_start = time.time()
    fake = os.path.join(HERE, "fake-coder.py")
    coder = {"agentId": "fake-coder", "title": "E2E fake coder", "binary": "python3", "command": ["python3", fake], "promptVia": "stdin", "resultFormat": "text", "defaultModel": "none", "allowedTools": "", "maxTurns": "1", "timeoutMin": "5"}

    # ---- install --------------------------------------------------------------------------------
    try:
        models = [str(x.get("modelId") or x.get("id") or x.get("name")) for x in (mcp("list_models", {}).get("models") or [])]
        if a.model not in models:
            mcp("create_model", {"modelId": a.model, "name": a.model})
        ws = prepare_workspace(home, svc)
        office_art, office_v = package("product-office")
        team_art, team_v = package("service-team")
        r1 = install(a.model, "product-office", office_v, "product", office_art)
        r2 = install(a.model, "service-team", team_v, svc, team_art)
        time.sleep(3)
        lanes = m.lanes(T(""))
        office_lanes = m.lanes("t-office-")
        stores = ((r2.get("application") or {}).get("stores") or {})
        ok = len(lanes) >= 30 and len(office_lanes) >= 12
        check("install", ok, "office %s lanes, team %s lanes (%d starting), team app stores %d" % (len(office_lanes), len(lanes), sum(1 for v in lanes.values() if v == "STARTING"), len(stores)))
        if not ok:
            raise RuntimeError("install incomplete: %s" % sorted(lanes)[:5])
        # the charters and the coder definitions: what the person would type in the apps
        m.clear("p-product-charter"); m.clear(P("charter")); m.clear("p-product-coders"); m.clear(P("coders"))
        m.put("p-product-charter", {"charterId": "office", "product": "E2E product", "goal": "Prove the team loop", "description": "A fixture product.", "principles": ["Every change has a spec before it is implemented", "Branches only; the person merges"], "constraints": [], "services": [svc],
                                    "repoRoot": ws, "home": os.path.join(home, "teams"), "mcpUrl": MCP_URL, "coderAgent": "fake-coder", "coderModel": "none", "coderMaxTurns": "1", "coderTimeoutMin": "5", "brainAgent": "llm", "autonomyLevel": "3", "dailyBudgetUsd": "20", "digestCron": "0 0 6 * * *", "status": "ready", "updatedAt": now(),
                                    "tokenLanes": ["t-office-setup-cmd", "t-office-plan-cmd", "t-office-digest-cmd", "t-office-brain-observe-cmd", "t-office-curate-cmd", "t-office-brain-apply-cmd"]}, "office-charter")
        m.put("p-product-coders", coder, "fake-coder")
        m.put(P("charter"), {"charterId": "team", "service": svc, "goal": "Keep the fixture service healthy", "description": "fixture", "repo": "core", "repoDir": "agentic-net-%s" % svc, "repoMode": a.repo_mode, "scopePaths": [], "testCommand": "true", "buildCommand": "true", "readinessChecks": ["tests", "docs"], "auditCron": "0 0 7 * * 1",
                             "coderAgent": "fake-coder", "coderModel": "none", "coderMaxTurns": "1", "coderTimeoutMin": "5", "brainAgent": "llm", "autonomyLevel": "3", "dailyBudgetUsd": "20", "status": "ready", "updatedAt": now(),
                             "tokenLanes": [T("setup-cmd"), T("po-cmd"), T("arch-cmd"), T("qa-cmd"), T("dev-cmd"), T("brain-observe-cmd"), T("curate-cmd"), T("brain-apply-cmd")]}, "team-charter")
        for place in (P("iterate"), P("prompts"), P("prompt-new"), P("responses"), P("requirements"), P("requirement-drafts"), P("specs"), P("spec-drafts"), P("acceptance"), P("acceptance-new"), P("briefs"), P("decisions"), P("runs"), P("reviews"), P("review-new"), P("verification"), P("spec-catalog"), P("state"), P("context"), P("po-cmd"), P("arch-cmd"), P("qa-cmd"), P("dev-cmd"), P("errors"), P("llm-errors"), P("journal"), "p-product-inbox", "p-product-status", "p-product-teams", "p-product-errors"):
            m.clear(place)
        st.done("install")
    except Exception as e:  # noqa: BLE001
        st.fail("install", e)

    # ---- provision ------------------------------------------------------------------------------
    if st.ready("provision", ["install"]):
        try:
            m.cmd("p-product-setup-cmd", "office-infra", ["provision"], 300000)
            m.cmd(P("setup-cmd"), "team-infra", ["provision", P("charter")], 600000)
            reg, secs = m.wait(lambda: m.find("p-product-teams", "service", svc), 240, what="team registration", journal=P("journal"))
            work = os.path.join(home, "workspace", "core") if a.repo_mode == "workspace" else os.path.join(home, "teams", svc, "core")
            st_c, creds = api("GET", "/api/transitions/%s/credentials?modelId=%s" % (T("po-cmd"), a.model))
            ok = os.path.isdir(os.path.join(work, ".git")) and st_c == 200 and reg.get("session") == svc
            check("provision", ok, "registered in %ss (session %s), %s repo %s, po-cmd credentials %s" % (secs, reg.get("session"), a.repo_mode, "present" if os.path.isdir(work) else "MISSING", st_c))
            if not ok:
                raise RuntimeError("provision incomplete")
            st.done("provision")
        except Exception as e:  # noqa: BLE001
            st.fail("provision", e)

    # ---- allocate: an iteration from the office reaches the product owner ------------------------
    it = "it-%s-%s" % (svc, stamp())
    prompt = {}
    if st.ready("allocate", ["provision"]):
        try:
            m.put(P("iterate"), {"at": now(), "iterationId": it, "reason": "allocated", "requestedBy": "office", "roadmapId": "rm-e2e", "direction": "Add a version line to the service README so operators know which fixture they run.", "notes": "e2e"}, it)
            ctx, secs = m.wait(lambda: m.count(P("context")) > 0 or m.count(P("prompts")) > 0, 400, what="proposal brief", journal=P("journal"))
            if a.skip_llm:
                for t in m.query(P("context")):
                    m.delete(P("context"), t["id"])
                    pid = t["data"].get("promptId") or "pr-%s-1" % it
                    prompt = {"promptId": pid, "iterationId": it, "mode": "choice", "kind": "proposal", "question": "Which requirement first?", "rationale": "e2e", "at": now(),
                              "options": [{"value": "opt-1", "label": "Add a version line to the README", "description": "docs", "kind": "docs", "module": "root", "effort": "S", "risk": "low", "evidence": [], "recommended": True}]}
                    m.put(P("prompts"), prompt, pid); m.put(P("prompt-new"), prompt, pid + "-new")
            pr, secs2 = m.wait(lambda: m.newest(P("prompts"), "at") or None, 400, what="proposal prompt", journal=P("journal"))
            prompt = pr
            inbox, secs3 = m.wait(lambda: m.find("p-product-inbox", "ref", pr.get("promptId")) or None, 120, what="office inbox mirror")
            state = m.newest(P("state"), "at")
            ok = pr.get("mode") in ("choice", "interview", "goal") and bool(inbox) and bool(state)
            check("allocate", ok, "state measured (%s files), %s question %s in %ss, mirrored to the office in %ss" % ((state.get("measured") or {}).get("files"), pr.get("mode"), pr.get("promptId"), secs + secs2, secs3))
            if not ok:
                raise RuntimeError("no usable proposal")
            st.done("allocate")
        except Exception as e:  # noqa: BLE001
            st.fail("allocate", e)

    # ---- requirement ----------------------------------------------------------------------------
    req = {}
    if st.ready("requirement", ["allocate"]):
        try:
            opts = prompt.get("options") or []
            opts = json.loads(opts) if isinstance(opts, str) else opts
            value = str((opts[0] if opts else {}).get("value", "opt-1"))
            m.put(P("responses"), {"promptId": prompt["promptId"], "iterationId": it, "intent": "answer", "selected": value, "text": "", "notes": "keep it tiny", "at": now(), "by": "e2e"}, "resp-" + prompt["promptId"])
            if a.skip_llm:
                ctx, _ = m.wait(lambda: next((t for t in m.query(P("context")) if t["data"].get("purpose") == "requirement"), None), 200, what="requirement brief", journal=P("journal"))
                m.delete(P("context"), ctx["id"]); rid = ctx["data"].get("requirementId")
                req = {"requirementId": rid, "iterationId": it, "promptId": prompt["promptId"], "kind": "docs", "title": "Version line in README", "story": "As an operator I want a version line so that I know the fixture.", "summary": "Add one line.", "module": "root", "scope": ["README.md"], "outOfScope": ["code"], "done": ["README.md has a Version line"], "risks": [], "priority": "low", "status": "draft"}
                m.put(P("requirements"), req, rid); m.put(P("requirement-drafts"), req, rid + "-draft")
            req, secs = m.wait(lambda: m.newest(P("requirements"), "at") or None, 400, what="requirement", journal=P("journal"))
            inbox_closed = not m.find("p-product-inbox", "ref", prompt["promptId"])
            ok = bool(req.get("requirementId")) and req.get("status") in ("draft", "designing") and inbox_closed
            check("requirement", ok, "%s '%s' (%s) in %ss; office inbox item closed %s" % (req.get("requirementId"), str(req.get("title"))[:60], req.get("kind"), secs, inbox_closed))
            if not ok:
                raise RuntimeError("no requirement")
            st.done("requirement")
        except Exception as e:  # noqa: BLE001
            st.fail("requirement", e)

    # ---- spec (catalog + design + the person's approval question) --------------------------------
    spec = {}
    if st.ready("spec", ["requirement"]):
        try:
            if a.skip_llm:
                ctx, _ = m.wait(lambda: next((t for t in m.query(P("context")) if t["data"].get("purpose") == "design"), None), 300, what="design brief", journal=P("journal"))
                m.delete(P("context"), ctx["id"]); sid = ctx["data"].get("specId")
                spec = {"specId": sid, "requirementId": req["requirementId"], "iterationId": it, "title": "Version line in README", "module": "root", "summary": "Add a Version line to README.md.", "design": ["append a Version line"], "interfaces": [], "data": [], "files": ["README.md"], "constraints": ["docs only"], "verify": "README contains Version", "risks": [], "adr": None, "status": "draft"}
                m.put(P("specs"), spec, sid); m.put(P("spec-drafts"), spec, sid + "-draft")
            spec, secs = m.wait(lambda: m.newest(P("specs"), "at") or None, 400, what="spec", journal=P("journal"))
            sid = spec["specId"]
            ask, secs2 = m.wait(lambda: m.find(P("prompts"), "promptId", "pr-spec-" + sid) or None, 200, what="spec approval question", journal=P("journal"))
            cat = m.newest(P("spec-catalog"), "at")
            mods = cat.get("modules") or []
            mods = json.loads(mods) if isinstance(mods, str) else mods
            lanes = m.lanes("t-%s-spec-" % svc)
            st_d, drawing = api("GET", "/api/designtime/nets/net-%s-team-specs?modelId=%s&sessionId=%s" % (svc, a.model, svc))
            drawn = int((drawing.get("placeCount") if isinstance(drawing, dict) else 0) or 0)
            inbox = m.find("p-product-inbox", "ref", "pr-spec-" + sid)
            office_spec = m.find("p-product-specs", "specId", sid)
            ok = bool(mods) and len(lanes) >= len(mods) - 1 and drawn >= len(mods) + 2 and bool(inbox) and spec.get("module") and bool(office_spec)
            check("spec", ok, "%s in module %s (%d catalog modules, %d link lanes, %d places drawn in session %s) in %ss; approval asked in %ss, office inbox %s, product-level row %s" % (sid, spec.get("module"), len(mods), len(lanes), drawn, svc, secs, secs2, bool(inbox), bool(office_spec)))
            if not ok:
                raise RuntimeError("spec stage incomplete")
            st.done("spec")
        except Exception as e:  # noqa: BLE001
            st.fail("spec", e)

    # ---- acceptance + context pack --------------------------------------------------------------
    if st.ready("acceptance", ["spec"]):
        try:
            sid = spec["specId"]
            m.put(P("decisions"), {"kind": "spec-approval", "verdict": "approved", "specId": sid, "requirementId": spec.get("requirementId"), "promptId": "pr-spec-" + sid, "notes": "", "by": "e2e", "at": now()}, "dec-spec-" + sid)
            if a.skip_llm:
                ctx, _ = m.wait(lambda: next((t for t in m.query(P("context")) if t["data"].get("purpose") == "acceptance"), None), 300, what="acceptance brief", journal=P("journal"))
                m.delete(P("context"), ctx["id"])
                acc = {"acceptanceId": "acc-" + sid, "specId": sid, "requirementId": spec.get("requirementId"), "criteria": [{"id": "ac-1", "given": "the branch", "when": "README is read", "then": "a Version line exists", "check": "grep Version README.md"}], "tests": [], "suites": ["true"], "readiness": ["docs"], "status": "ready"}
                m.put(P("acceptance"), acc, "acc-" + sid); m.put(P("acceptance-new"), acc, "acc-" + sid + "-new")
            acc, secs = m.wait(lambda: m.find(P("acceptance"), "specId", sid) or None, 400, what="acceptance criteria", journal=P("journal"))
            ask, secs2 = m.wait(lambda: m.find(P("prompts"), "promptId", "pr-pack-" + sid) or None, 300, what="pack approval question", journal=P("journal"))
            pack = m.newest(P("briefs"), "at")
            approved_spec = m.find(P("specs"), "specId", sid).get("status")
            spec_ask_gone = not m.find(P("prompts"), "promptId", "pr-spec-" + sid) and not m.find("p-product-inbox", "ref", "pr-spec-" + sid)
            ok = bool(acc.get("criteria")) and pack.get("specId") == sid and approved_spec in ("approved",) and spec_ask_gone
            check("acceptance", ok, "spec %s, %d criteria in %ss, pack %s asks approval in %ss, spec question cleared %s" % (approved_spec, len(acc.get("criteria") or []), secs, pack.get("packId"), secs2, spec_ask_gone))
            if not ok:
                raise RuntimeError("acceptance stage incomplete")
            st.done("acceptance")
        except Exception as e:  # noqa: BLE001
            st.fail("acceptance", e)

    # ---- implement (the fake coder on a branch) --------------------------------------------------
    run = {}
    if st.ready("implement", ["acceptance"]):
        try:
            sid = spec["specId"]; pack = m.newest(P("briefs"), "at")
            m.put(P("decisions"), {"kind": "pack-approval", "verdict": "approved", "specId": sid, "packId": pack.get("packId"), "promptId": "pr-pack-" + sid, "notes": "", "by": "e2e", "at": now()}, "dec-pack-" + sid)
            run, secs = m.wait(lambda: (lambda r: r if r.get("status") in ("built", "failed", "verified", "reviewed") else None)(m.find(P("runs"), "specId", sid)), 500, what="coder run", journal=P("journal"))
            clone = os.path.join(home, "workspace", "core") if a.repo_mode == "workspace" else os.path.join(home, "teams", svc, "core")
            rc, out = sh(["git", "log", "--oneline", "-1", run.get("branch", "")], clone)
            ok = run.get("status") in ("built", "verified", "reviewed") and rc == 0 and bool(run.get("filesChanged"))
            check("implement", ok, "run %s %s on %s in %ss: %s file(s), head '%s'" % (run.get("runId"), run.get("status"), run.get("branch"), secs, len(run.get("filesChanged") or []), out.strip()[:60]))
            if not ok:
                raise RuntimeError("run not built: %s" % str(run.get("failure") or run.get("summary"))[:200])
            st.done("implement")
        except Exception as e:  # noqa: BLE001
            st.fail("implement", e)

    # ---- verify ----------------------------------------------------------------------------------
    if st.ready("verify", ["implement"]):
        try:
            ver, secs = m.wait(lambda: m.find(P("verification"), "runId", run["runId"]) or None, 500, what="verification", journal=P("journal"))
            ok = ver.get("verdict") == "pass" and (ver.get("suites") or {}).get("ok") in (True, "true") and m.find(P("runs"), "runId", run["runId"]).get("status") in ("verified", "reviewed", "merged")
            check("verify", ok, "%s in %ss: %s; evidence %d entries" % (ver.get("verdict"), secs, str(ver.get("summary"))[:100], len(ver.get("evidence") or [])))
            if not ok:
                raise RuntimeError("verification failed: %s" % ver.get("summary"))
            st.done("verify")
        except Exception as e:  # noqa: BLE001
            st.fail("verify", e)

    # ---- review + the merge question ------------------------------------------------------------
    if st.ready("review", ["verify"]):
        try:
            if a.skip_llm:
                ctx, _ = m.wait(lambda: next((t for t in m.query(P("context")) if t["data"].get("purpose") == "review"), None), 300, what="review brief", journal=P("journal"))
                m.delete(P("context"), ctx["id"])
                rev = {"reviewId": "rev-" + run["runId"], "runId": run["runId"], "specId": spec["specId"], "verdict": "approve", "summary": "docs only, matches the spec.", "points": [], "acceptanceMissing": [], "specDeviations": []}
                m.put(P("reviews"), rev, "rev-" + run["runId"]); m.put(P("review-new"), rev, "rev-" + run["runId"] + "-new")
            rev, secs = m.wait(lambda: m.find(P("reviews"), "runId", run["runId"]) or None, 500, what="review", journal=P("journal"))
            ask, secs2 = m.wait(lambda: m.find(P("prompts"), "promptId", "pr-merge-" + run["runId"]) or None, 200, what="merge question", journal=P("journal"))
            inbox = m.find("p-product-inbox", "ref", "pr-merge-" + run["runId"])
            ok = rev.get("verdict") in ("approve", "changes") and bool(ask) and bool(inbox)
            check("review", ok, "verdict %s in %ss; merge question in %ss, office inbox %s" % (rev.get("verdict"), secs, secs2, bool(inbox)))
            if not ok:
                raise RuntimeError("review stage incomplete")
            st.done("review")
        except Exception as e:  # noqa: BLE001
            st.fail("review", e)

    # ---- merge (the person's click runs the merge command) --------------------------------------
    if st.ready("merge", ["review"]):
        try:
            m.put(P("decisions"), {"kind": "merge", "verdict": "merge", "runId": run["runId"], "specId": spec["specId"], "promptId": "pr-merge-" + run["runId"], "notes": "", "by": "e2e", "at": now()}, "dec-merge-" + run["runId"])
            merged, secs = m.wait(lambda: (lambda r: r if r.get("status") in ("merged", "merge-failed") else None)(m.find(P("runs"), "runId", run["runId"])), 300, what="merge", journal=P("journal"))
            ws = os.path.join(home, "workspace", "core")
            clone = ws if a.repo_mode == "workspace" else os.path.join(home, "teams", svc, "core")
            rc1, o1 = sh(["git", "log", "--oneline", "-1", "main"], clone)
            rc2, o2 = sh(["git", "branch", "--list", run.get("branch", "")], ws)
            rc3, o3 = sh(["git", "log", "--oneline", "-1", "main"], ws)
            release = m.find("p-product-status", "runId", run["runId"])
            spec_status = m.find(P("specs"), "specId", spec["specId"]).get("status")
            observe = m.count(P("brain-cmd")) + m.count(P("signals")) + m.count(P("context"))
            ok = merged.get("status") == "merged" and "Merge" in o1 and bool(o2.strip()) and release.get("kind") == "release" and spec_status == "merged"
            check("merge", ok, "run %s in %ss; clone main '%s'; workspace branch %s, workspace main '%s'; office release row %s; spec %s; brain observing %s" % (merged.get("status"), secs, o1.strip()[:50], "present" if o2.strip() else "MISSING", o3.strip()[:40], bool(release), spec_status, observe > 0))
            if not ok:
                raise RuntimeError("merge incomplete: %s" % merged.get("mergeError", ""))
            st.done("merge")
        except Exception as e:  # noqa: BLE001
            st.fail("merge", e)

    # ---- guard: no run without an approved spec --------------------------------------------------
    if st.ready("guard", ["provision"]):
        try:
            sid = "spec-%s-999" % svc
            m.put(P("specs"), {"specId": sid, "requirementId": "req-none", "title": "unapproved", "module": "root", "summary": "never approved", "design": [], "interfaces": [], "files": [], "verify": "", "status": "draft", "at": now()}, sid)
            before = m.count(P("runs"))
            m.cmd(P("dev-cmd"), "team-dev", ["implement", sid, P("charter")], 120000)
            err, secs = m.wait(lambda: next((t["data"] for t in m.query(P("errors")) if sid in str(t["data"].get("message", ""))), None), 200, what="refusal", journal=P("journal"))
            ok = m.count(P("runs")) == before and "approved" in str(err.get("message", ""))
            check("guard", ok, "refused in %ss: %s" % (secs, str(err.get("message"))[:120]))
            st.done("guard")
        except Exception as e:  # noqa: BLE001
            st.fail("guard", e)

    # ---- key parity: the app writes the verdict, the brain reads it ------------------------------
    try:
        import subprocess as _sp
        title = "Align build tooling: add Maven wrapper or update CLAUDE.md"
        py = _sp.run(["python3", "-c", "import sys;sys.path.insert(0,%r);import teamlib as T;print(T.plan_key(%r))"
                      % (os.path.join(PACK, "assets"), title)], capture_output=True, text=True, timeout=60).stdout.strip()
        js = _sp.run(["node", "-e", r"const s=require('fs').readFileSync(%r,'utf8');const m=s.match(/const planKey = (\(title\) => [^;]+);/);"
                      "const planKey=eval(m[1]);process.stdout.write(planKey(%r))"
                      % (os.path.join(PACK, "app", "ui", "main.mjs"), title)], capture_output=True, text=True, timeout=60).stdout.strip()
        check("key-parity", bool(py) and py == js, "plan_key(python)=%r planKey(app)=%r" % (py[:48], js[:48]))
    except Exception as e:  # noqa: BLE001
        check("key-parity", False, "could not compare: %s" % str(e)[:160])

    # ---- summary ---------------------------------------------------------------------------------
    passed = sum(1 for _, ok, _ in RESULTS if ok)
    print("\n%d/%d checks passed in %ds (model %s, home %s)" % (passed, len(RESULTS), time.time() - t_start, a.model, home))
    if not a.keep and passed == len(RESULTS):
        try:
            mcp("pause_model", {"model": a.model})
        except Exception:  # noqa: BLE001
            pass
    return 0 if passed == len(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
