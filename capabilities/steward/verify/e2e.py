#!/usr/bin/env python3
"""End-to-end proof of the Steward against a live runtime, on its own model.

usage: e2e.py [--model steward-e2e] [--home ~/steward-e2e] [--repo <path or url>] [--artifact <capability.json>]
              [--keep] [--skip-llm]

What it proves, in order (every case measures; nothing is inferred from the pipeline's green):
  install     the pack installs: lanes, scripts, seeds, app stores; how many lanes the installer left
              in STARTING (0 after the 2026-09-09 hub fix)
  provision   the MCP token is stored for the command lanes and the pack repository is cloned
  observe     a manual observation writes health, lanes, map and budget and starts an iteration
  goal        the Steward asks for the goal first (one-shot lane), then proposes a choice after it
  refusal     a spec touching a protected lane is refused, and no second iteration is stacked
  loop        an injected add-lane spec passes the gate (asks), is approved, the fake coder applies it,
              verify publishes and installs the new version, release merges and tags, the brain curates
              and starts the next iteration; the added lane exists and runs
  rollback    the person rolls the release back: the previous version is installed, the added lane is
              removed, lanes are running
  ideas       an idea from the person reaches the next proposal brief
  pause       pause stops every lane but the setup lane; resume starts them again

Needs: the Desktop runtime on 127.0.0.1 (master 8082, MCP 8091), the service token and the MCP token
under ~/.agenticos/desktop, node + python3 on the executor host. The fake coder (verify/fake-coder.py)
replaces the headless model; the propose and curate lanes still call the model (cheap one-shots)
unless --skip-llm, which injects their answers too.
"""
import argparse
import json
import os
import subprocess
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
PACK = os.path.dirname(HERE)
MASTER = os.environ.get("MASTER_URL", "http://127.0.0.1:8082").rstrip("/")
MCP_URL = os.environ.get("STEWARD_MCP_URL", "http://127.0.0.1:8091/mcp")
SERVICE_TOKEN = open(os.path.expanduser("~/.agenticos/desktop/internal-secret")).read().strip()
MCP_TOKEN = open(os.path.expanduser("~/.agenticos/desktop/mcp-token")).read().strip()
PROTECTED_LANE = "t-steward-gate-cmd"
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
        st, r = api("POST", "/api/runtime/places/%s/tokens/query?modelId=%s" % (place, self.model), {"arcql": "FROM $", "limit": 1})
        return int(((r.get("page") or {}).get("totalElements") or 0)) if isinstance(r, dict) else 0

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

    def cmd(self, place, tool, argv, timeout_ms=900000, **extra):
        tok = {"kind": "command", "id": "%s-%s" % (tool, stamp()), "executor": "script", "command": "invoke", "expect": "text",
               "args": {"toolId": tool, "argv": argv, "env": {"MODEL_ID": self.model}, "timeoutMs": timeout_ms}, "filedAt": now(), "stage": argv[0] if argv else ""}
        tok.update(extra)
        return self.put(place, tok, "%s-%s-%s" % (tool, "-".join(argv)[:24], stamp()))

    def lanes(self):
        rows = mcp("list_transitions", {"model": self.model}).get("transitions") or []
        return {str(r.get("transitionId")): str(r.get("status")) for r in rows if str(r.get("transitionId", "")).startswith("t-steward-")}

    def journal(self, n=5):
        rows = self.query("p-steward-journal", "FROM $", 400)
        rows.sort(key=lambda t: str(t["data"].get("at", "")), reverse=True)
        return [(t["data"].get("at"), t["data"].get("lane"), t["data"].get("stage"), str(t["data"].get("summary"))[:200]) for t in rows[:n]]

    def wait(self, pred, timeout=600, every=4, what="condition"):
        t0 = time.time()
        while time.time() - t0 < timeout:
            v = pred()
            if v:
                return v, round(time.time() - t0, 1)
            time.sleep(every)
        raise TimeoutError("%s did not happen within %ss; journal: %s" % (what, timeout, self.journal(4)))

    def newest(self, place, field="at", arcql="FROM $"):
        rows = self.query(place, arcql, 300)
        rows.sort(key=lambda t: str(t["data"].get(field, "")), reverse=True)
        return rows[0]["data"] if rows else {}


def check(name, ok, detail):
    RESULTS.append((name, bool(ok), detail))
    print("%s %-10s %s" % ("PASS" if ok else "FAIL", name, detail), flush=True)
    return bool(ok)


class Stages:
    """Stages with dependencies: a timeout or an error inside a stage is a failed check, and every
    stage that needs it is skipped with a line saying why, so one broken hop never hides the rest."""
    def __init__(self):
        self.failed, self.passed = set(), set()

    def ready(self, name, needs):
        missing = [n for n in needs if n not in self.passed]
        if missing:
            print("SKIP %-10s needs %s" % (name, ", ".join(missing)), flush=True)
            RESULTS.append((name, False, "skipped: needs %s" % ", ".join(missing)))
            return False
        return True

    def fail(self, name, e):
        self.failed.add(name)
        detail = ("timeout: " if isinstance(e, TimeoutError) else type(e).__name__ + ": ") + str(e)[:500]
        check(name + "*", False, detail)

    def done(self, name):
        self.passed.add(name)


def artifact_lanes(path):
    art = json.load(open(path))
    ids = set()
    for net in art.get("nets") or []:
        ins = net.get("inscriptions") or {}
        if isinstance(ins, dict):  # the artifact keys inscriptions by transition id
            ids |= {str(k) for k, v in ins.items() if not (isinstance(v, dict) and v.get("kind") == "link")}
        else:
            for i in ins:
                if isinstance(i, dict) and (i.get("id") or i.get("transitionId")):
                    ids.add(str(i.get("id") or i.get("transitionId")))
    return ids, art["manifest"]["version"]


def prepare_repo(home, version="9.0.0"):
    """The e2e's own git repository and artifact: a copy of capabilities/ (the pack and the tools) with
    the pack version set to a line the live Steward never uses, committed, built and packaged. The
    proof model clones it, the fake coder bumps 9.0.0 to 9.0.1, the rollback goes back to 9.0.0."""
    import shutil
    src_root = os.path.abspath(os.path.join(PACK, "..", ".."))
    repo = os.path.join(os.path.expanduser(home), "source-repo")
    if os.path.isdir(repo):
        shutil.rmtree(repo)
    os.makedirs(os.path.join(repo, "capabilities"), exist_ok=True)
    for d in ("tools", "steward"):
        shutil.copytree(os.path.join(src_root, "capabilities", d), os.path.join(repo, "capabilities", d), ignore=shutil.ignore_patterns("dist", "__pycache__", "node_modules", ".git"))
    pack = os.path.join(repo, "capabilities", "steward")
    cap = os.path.join(pack, "capability.yaml")
    text = open(cap, encoding="utf-8").read()
    import re
    text = re.sub(r"^version:\s*\S+\s*$", "version: %s" % version, text, count=1, flags=re.M)
    open(cap, "w", encoding="utf-8").write(text)
    app = os.path.join(pack, "app", "agenticos.app.json")
    manifest = json.load(open(app, encoding="utf-8")); manifest["version"] = version
    json.dump(manifest, open(app, "w", encoding="utf-8"), indent=2); open(app, "a").write("\n")
    for cmd in (["node", "capabilities/tools/pack.mjs", "build", "--dir", "capabilities/steward"], ["node", "capabilities/tools/pack.mjs", "package", "--dir", "capabilities/steward"],
                ["git", "init", "-q", "-b", "main"], ["git", "add", "-A"], ["git", "-c", "user.name=e2e", "-c", "user.email=e2e@localhost", "commit", "-q", "-m", "e2e source %s" % version]):
        p = subprocess.run(cmd, cwd=repo, capture_output=True, text=True, timeout=600)
        if p.returncode != 0:
            raise RuntimeError("prepare_repo: %s failed: %s" % (" ".join(cmd[:3]), (p.stdout + p.stderr)[-500:]))
    return repo, os.path.join(pack, "dist", "steward-%s.capability.json" % version)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="steward-e2e")
    ap.add_argument("--home", default="~/steward-e2e")
    ap.add_argument("--repo", default="", help="git repository the proof model clones (default: a fresh copy under --home at version 9.0.0)")
    ap.add_argument("--artifact", default="", help="artifact to install (default: packaged from that copy)")
    ap.add_argument("--keep", action="store_true", help="do not pause the model at the end")
    ap.add_argument("--skip-llm", action="store_true", help="inject the propose and curate answers instead of calling the model")
    a = ap.parse_args()
    t_start = time.time()
    stages = Stages()
    m = Model(a.model)
    if not a.repo or not a.artifact:
        repo_path, art_path = prepare_repo(a.home)
        a.repo = a.repo or repo_path
        a.artifact = a.artifact or art_path
        print("   source repository %s, artifact %s" % (a.repo, os.path.basename(a.artifact)))
    artifact = a.artifact if os.path.isabs(a.artifact) else os.path.join(PACK, "dist", a.artifact)
    expected_lanes, version = artifact_lanes(artifact)
    print("== Steward e2e on model %s with %s (%d lanes)" % (a.model, os.path.basename(artifact), len(expected_lanes)))

    # ---- install --------------------------------------------------------------------------------
    if stages.ready("install", []):
        try:
            models = mcp("list_models", {})
            known = {str(x.get("modelId") or x.get("id")) for x in (models.get("models") or [])}
            if a.model not in known:
                r = mcp("create_model", {"modelId": a.model, "name": "Steward e2e", "description": "end-to-end proof model for the Steward pack"})
                print("   created model:", json.dumps(r)[:120])
            if a.model == "steward":
                raise SystemExit("refusing to run the e2e against the live Steward model; pass --model steward-e2e or another proof model")
            cleared, reset_errors = 0, []
            for place in ("p-steward-prompts", "p-steward-responses", "p-steward-context", "p-steward-context-cmd", "p-steward-iterate", "p-steward-specs", "p-steward-spec-drafts", "p-steward-gate-cmd",
                          "p-steward-decisions", "p-steward-refused", "p-steward-apply-cmd", "p-steward-runs", "p-steward-verify-cmd", "p-steward-verification", "p-steward-release-cmd", "p-steward-brain-cmd",
                          "p-steward-signals", "p-steward-curation", "p-steward-curations", "p-steward-knowledge", "p-steward-plan", "p-steward-adr", "p-steward-ideas", "p-steward-candidates",
                          "p-steward-health", "p-steward-lanes", "p-steward-map", "p-steward-budget", "p-steward-journal", "p-steward-errors", "p-steward-llm-errors", "p-steward-infra", "p-steward-repo",
                          "p-steward-setup-cmd", "p-steward-observe-cmd", "p-steward-charter", "p-steward-coders", "p-steward-digest", "p-steward-e2e-echo"):
                for attempt in range(3):
                    try:
                        r = mcp("clear_place", {"model": a.model, "place": place, "force": True})
                        cleared += int(r.get("deleted") or r.get("deletedCount") or r.get("count") or 0)
                        break
                    except Exception as e:  # noqa: BLE001
                        if attempt == 2:
                            reset_errors.append("%s: %s" % (place, str(e)[:120]))
                        time.sleep(5)
            leftovers = {pl: len(m.query(pl, "FROM $", 5)) for pl in ("p-steward-prompts", "p-steward-charter", "p-steward-repo", "p-steward-health", "p-steward-runs")}
            leftovers = {k: v for k, v in leftovers.items() if v}
            print("   reset: %d tokens cleared from the proof model%s" % (cleared, ("; ERRORS: " + "; ".join(reset_errors[:3])) if reset_errors else ""))
            if leftovers:
                raise SystemExit("   reset FAILED, the proof model still holds tokens: %s (the runtime may still be starting; retry)" % leftovers)
            art = json.load(open(artifact))
            st, r = api("PUT", "/api/hub/capabilities/steward/versions/%s" % version, art)
            check("publish", st == 200, "PUT %s -> %s" % (version, st))
            st, r = api("POST", "/api/hub/install", {"source": "local", "name": "steward", "version": version, "targetModelId": a.model, "allowDowngrade": True})
            cap = (r.get("capability") or {}) if isinstance(r, dict) else {}
            check("install", st == 201 and cap.get("started") == len(expected_lanes), "HTTP %s, %s lanes started, %s scripts, upgrade %s, removedLanes %s" % (st, cap.get("started"), len(cap.get("scripts") or []), (r.get("upgrade") or {}).get("kind") if isinstance(r, dict) else "?", cap.get("removedLanes")))
            # command lanes stay in STARTING until the executor's next poll acknowledges them; master-side
            # lanes must be RUNNING at once (the 2026-09-09 hub fix). Wait for the poll, measure the time.
            t0 = time.time(); lanes = m.lanes()
            while time.time() - t0 < 45 and any(s == "STARTING" for s in lanes.values()):
                time.sleep(3); lanes = m.lanes()
            starting = sorted(t for t, s in lanes.items() if s == "STARTING")
            check("lanes", set(lanes) >= expected_lanes and not starting, "%d lanes, %d RUNNING after %ss, %d still STARTING%s" % (len(lanes), sum(1 for s in lanes.values() if s == "RUNNING"), round(time.time() - t0, 1), len(starting), (" (" + ", ".join(starting[:5]) + ")") if starting else ""))
            check("seeds", m.count("p-steward-charter") >= 1 and m.count("p-steward-coders") >= 3, "charter %d, coders %d" % (m.count("p-steward-charter"), m.count("p-steward-coders")))
            for tid, s in lanes.items():
                if s == "STARTING":
                    mcp("stop_transition", {"model": a.model, "transitionId": tid}); mcp("start_transition", {"model": a.model, "transitionId": tid})
        except Exception as e:  # noqa: BLE001
            stages.fail("install", e)
        else:
            stages.done("install")

    # ---- charter for the e2e: fake coder, local repo, own home -------------------------------------
    if stages.ready("charter", ['install']):
        try:
            fake = {"agentId": "fake-coder", "title": "Fake coder (e2e)", "binary": "python3", "command": ["python3", os.path.join(HERE, "fake-coder.py")], "promptVia": "stdin", "resultFormat": "text",
                    "defaultModel": "none", "allowedTools": "", "maxTurns": "1", "timeoutMin": "10", "description": "deterministic stand-in for verify/e2e.py"}
            if not m.query("p-steward-coders", 'FROM $ WHERE $.agentId == "fake-coder" LIMIT 1'):
                m.put("p-steward-coders", fake, "coder-fake")
            c = m.newest("p-steward-charter", "updatedAt")
            c.pop("name", None)
            c.update({"charterId": "steward", "goal": "REPLACE ME", "description": "", "repoUrl": a.repo, "repoBranch": "main", "home": a.home, "coderAgent": "fake-coder", "coderModel": "none",
                      "coderMaxTurns": "1", "coderTimeoutMin": "10", "brainAgent": "llm", "autonomyLevel": "3", "dailyBudgetUsd": "10", "status": "ready", "updatedAt": now()})
            m.put("p-steward-charter", c, "charter-e2e-%s" % stamp())
        except Exception as e:  # noqa: BLE001
            stages.fail("charter", e)
        else:
            stages.done("charter")

    # ---- provision -------------------------------------------------------------------------------
    if stages.ready("provision", ['charter']):
        try:
            m.cmd("p-steward-setup-cmd", "steward-infra", ["provision"], 600000)
            repo, dt = m.wait(lambda: m.newest("p-steward-repo", "updatedAt") if m.count("p-steward-repo") else None, 300, 3, "provision")
            check("provision", os.path.isdir(os.path.join(os.path.expanduser(a.home), "agentic-nets", ".git")), "cloned %s @ %s in %ss" % (repo.get("localPath"), str(repo.get("headSha", ""))[:7], dt))
            h = m.newest("p-steward-infra", "at", 'FROM $ WHERE $.kind == "health"')
            check("health", str(h.get("ok")) == "true", "problems: %s; mcp token from %s" % (h.get("problems"), h.get("mcpTokenSource")))
        except Exception as e:  # noqa: BLE001
            stages.fail("provision", e)
        else:
            stages.done("provision")

    # ---- observe -> goal question ------------------------------------------------------------------
    if stages.ready("observe", ['provision']):
        try:
            m.cmd("p-steward-observe-cmd", "steward-observe", ["observe", "e2e"], 600000)
            hlth, dt = m.wait(lambda: m.newest("p-steward-health", "at") if m.count("p-steward-health") else None, 300, 3, "observation")
            check("observe", int(hlth.get("lanes", 0)) >= len(expected_lanes) and m.count("p-steward-map") >= 1 and m.count("p-steward-budget") >= 1, "%s in %ss" % (hlth.get("summary"), dt))
            if a.skip_llm:
                ctx, dt = m.wait(lambda: m.newest("p-steward-context", "at") if m.count("p-steward-context") else None, 120, 3, "proposal brief")
                for t in m.query("p-steward-context"):
                    m.delete("p-steward-context", t["id"])
                m.put("p-steward-prompts", {"promptId": ctx.get("promptId"), "iterationId": ctx.get("iterationId"), "mode": "goal", "question": "What should this model become?", "options": [], "rationale": "injected", "at": now()}, "injected-goal")
                    # the first command of a freshly registered lane has been measured at ~4 min on 2.59.0 (later ones fire in seconds); wait long enough to MEASURE it
            goal_prompt, dt = m.wait(lambda: m.newest("p-steward-prompts", "at", 'FROM $ WHERE $.mode == "goal"') or None, 480, 3, "goal prompt")
            check("goal-ask", bool(goal_prompt.get("promptId")), "the Steward asked for the goal %ss after the observation (brief %d chars)" % (dt, len(str(m.newest("p-steward-context", "at").get("brief", ""))) if m.count("p-steward-context") else 0))
        except Exception as e:  # noqa: BLE001
            stages.fail("observe", e)
        else:
            stages.done("observe")

    # ---- answer the goal -> a choice ---------------------------------------------------------------
    if stages.ready("goal", ['observe']):
        try:
            c = m.newest("p-steward-charter", "updatedAt"); c.pop("name", None)
            c.update({"goal": "E2E: keep this model observable and grow one verified lane at a time", "description": "An end-to-end proof model; every change is a verified pack version.", "updatedAt": now()})
            m.put("p-steward-charter", c, "charter-e2e-goal-%s" % stamp())
            m.put("p-steward-responses", {"promptId": goal_prompt["promptId"], "iterationId": goal_prompt["iterationId"], "intent": "answer", "selected": [], "text": c["goal"] + "\n" + c["description"], "notes": "", "at": now(), "by": "e2e"}, "resp-goal")
            if a.skip_llm:
                ctx, dt = m.wait(lambda: (m.newest("p-steward-context", "at") if m.count("p-steward-context") else None), 120, 3, "second brief")
                for t in m.query("p-steward-context"):
                    m.delete("p-steward-context", t["id"])
                m.put("p-steward-prompts", {"promptId": ctx.get("promptId"), "iterationId": ctx.get("iterationId"), "mode": "choice", "question": "Which increment?", "options": [{"value": "opt-1", "label": "E2E: add an echo lane", "kind": "add-lane", "nets": ["steward-observe"], "recommended": True}], "rationale": "injected", "at": now()}, "injected-choice")
            choice, dt = m.wait(lambda: m.newest("p-steward-prompts", "at", 'FROM $ WHERE $.mode == "choice"') or None, 300, 3, "choice prompt")
            opts = choice.get("options") if isinstance(choice.get("options"), list) else []
            check("goal-propose", len(opts) >= 1 and all(o.get("kind") for o in opts), "%d options with kinds %s in %ss" % (len(opts), [o.get("kind") for o in opts], dt))
            it_open = choice.get("iterationId")
        except Exception as e:  # noqa: BLE001
            stages.fail("goal", e)
        else:
            stages.done("goal")

    # ---- refusal: a protected lane, and no stacked iteration -------------------------------------------
    if stages.ready("refusal", ['observe']):
        try:
            n_iter_before = m.count("p-steward-iterate") + m.count("p-steward-context")
            bad = {"specId": "spec-e2e-protected", "iterationId": "it-e2e-bad", "promptId": "pr-e2e-bad", "kind": "tune", "title": "E2E: retune the gate", "summary": "must be refused", "why": "e2e", "nets": ["steward-loop"], "touches": [PROTECTED_LANE], "changes": ["x"], "files": ["nets/steward-loop.net.json"], "verify": "none", "status": "draft", "at": now()}
            m.put("p-steward-specs", bad, "spec-e2e-protected"); m.put("p-steward-spec-drafts", bad, "draft-e2e-protected")
            ref, dt = m.wait(lambda: m.newest("p-steward-refused", "at", 'FROM $ WHERE $.specId == "spec-e2e-protected"') or None, 120, 3, "refusal")
            time.sleep(6)
            stacked = m.count("p-steward-iterate") + m.count("p-steward-context") - n_iter_before
            check("refusal", PROTECTED_LANE in str(ref.get("reason")) and stacked <= 0, "%s in %ss; iterations stacked: %d (a question is open, so none may start)" % (ref.get("reason"), dt, max(stacked, 0)))
        except Exception as e:  # noqa: BLE001
            stages.fail("refusal", e)
        else:
            stages.done("refusal")

    # ---- the loop with the fake coder ----------------------------------------------------------------
    if stages.ready("loop", ['goal']):
        try:
            spec = {"specId": "spec-e2e-echo", "iterationId": it_open, "promptId": choice["promptId"], "kind": "add-lane", "title": "E2E: add an echo lane", "summary": "A map lane that echoes the newest health once a day.", "why": "e2e proof of apply, verify, release and rollback",
                    "nets": ["steward-observe"], "touches": ["t-steward-e2e-echo", "p-steward-e2e-echo"], "reads": ["p-steward-health"], "writes": ["p-steward-e2e-echo"], "changes": ["add the lane"], "files": ["nets/steward-observe.net.json"], "verify": "the lane exists and runs", "status": "draft", "at": now()}
            m.put("p-steward-responses", {"promptId": choice["promptId"], "iterationId": it_open, "intent": "answered", "selected": [opts[0].get("value")], "text": "", "notes": "", "specId": "spec-e2e-echo", "by": "e2e"}, "receipt-e2e")
            m.put("p-steward-specs", spec, "spec-e2e-echo"); m.put("p-steward-spec-drafts", spec, "draft-e2e-echo")
            appr, dt = m.wait(lambda: m.newest("p-steward-prompts", "at", 'FROM $ WHERE $.kind == "approval" AND $.specId == "spec-e2e-echo"') or None, 120, 3, "approval prompt")
            check("gate-ask", appr.get("promptId") == "pr-approval-spec-e2e-echo", "gate asked in %ss: %s" % (dt, str(appr.get("context"))[:80]))
            prev_version = version
            m.put("p-steward-decisions", {"kind": "spec-approval", "verdict": "approved", "specId": "spec-e2e-echo", "notes": "e2e", "by": "e2e", "at": now()}, "approve-e2e")
            run, dt = m.wait(lambda: (m.newest("p-steward-runs", "at", 'FROM $ WHERE $.specId == "spec-e2e-echo"') or None) if m.count("p-steward-runs") else None, 120, 3, "run record")
            run, dt2 = m.wait(lambda: (lambda r: r if r.get("status") in ("built", "failed", "verifying", "verified", "released", "rolled-back", "releasing") else None)(m.newest("p-steward-runs", "at", 'FROM $ WHERE $.specId == "spec-e2e-echo"')), 900, 5, "coder run")
            check("apply", str(run.get("buildOk")) == "true", "fake coder %s, build %s, %s -> %s in %ss" % (run.get("coderAgent"), run.get("buildSteps"), run.get("previousVersion"), run.get("packVersion"), dt2))
            ver, dt3 = m.wait(lambda: m.newest("p-steward-verification", "at", 'FROM $ WHERE $.runId == "%s"' % run["runId"]) or None, 900, 5, "verification")
            check("verify", ver.get("status") == "pass", "%s in %ss: %s" % (ver.get("status"), dt3, "; ".join(ver.get("checks") or [])[:300]))
            run, dt4 = m.wait(lambda: (lambda r: r if r.get("status") in ("released", "rolled-back", "failed") else None)(m.newest("p-steward-runs", "at", 'FROM $ WHERE $.specId == "spec-e2e-echo"')), 600, 5, "release")
            lanes = m.lanes()
            check("release", run.get("status") == "released" and lanes.get("t-steward-e2e-echo") == "RUNNING", "%s as %s (%s) in %ss; echo lane %s; %d lanes" % (run.get("status"), run.get("packVersion"), run.get("tag"), dt4, lanes.get("t-steward-e2e-echo"), len(lanes)))
            if a.skip_llm:
                sig, dt = m.wait(lambda: m.newest("p-steward-signals", "at") or None, 120, 3, "signals")
                for t in m.query("p-steward-context"):
                    m.delete("p-steward-context", t["id"])
                cur = {"curationId": "cur-%s" % run["runId"], "runId": run["runId"], "addFacts": [{"kind": "convention", "scope": "project", "text": "E2E: the echo lane was added by the fake coder.", "source": run["runId"], "confidence": "high"}], "retireFacts": [], "plan": {"increments": [{"id": "inc-1", "title": "next", "kind": "tune", "status": "planned", "dependsOn": [], "specId": ""}]}, "proposedDecisions": [], "questions": [], "ideas": [{"text": "E2E: a tool net that reports lane health as markdown"}], "summary": "injected curation"}
                m.put("p-steward-curations", cur, "curation-injected"); m.put("p-steward-curation", cur, "curation-injected-live")
            facts, dt5 = m.wait(lambda: m.count("p-steward-knowledge") or None, 600, 5, "curation")
            nxt, dt6 = m.wait(lambda: (m.count("p-steward-iterate") + m.count("p-steward-context") + len([p for p in m.query("p-steward-prompts") if p["data"].get("at", "") > run.get("releasedAt", "")])) or None, 300, 5, "next iteration")
            check("brain", facts >= 1 and m.count("p-steward-plan") >= 1, "%d facts, plan %d, ideas from the brain %d, next iteration started %ss after the release" % (facts, m.count("p-steward-plan"), m.count("p-steward-ideas"), dt6))
        except Exception as e:  # noqa: BLE001
            stages.fail("loop", e)
        else:
            stages.done("loop")

    # ---- rollback -----------------------------------------------------------------------------------
    if stages.ready("rollback", ['loop']):
        try:
            m.put("p-steward-decisions", {"kind": "rollback", "verdict": "rollback", "runId": run["runId"], "notes": "e2e rollback", "by": "e2e", "at": now()}, "rollback-e2e")
            rb, dt = m.wait(lambda: (lambda r: r if r.get("status") == "rolled-back" else None)(m.newest("p-steward-runs", "at", 'FROM $ WHERE $.runId == "%s"' % run["runId"])), 600, 5, "rollback")
            time.sleep(4)
            lanes = m.lanes(); repo = m.newest("p-steward-repo", "updatedAt")
            check("rollback", rb.get("rolledBackTo") == prev_version and "t-steward-e2e-echo" not in lanes and repo.get("installedVersion") == prev_version and all(s == "RUNNING" for s in lanes.values()),
                  "to %s in %ss; echo lane %s; removed %s; %d lanes all running: %s; installed %s" % (rb.get("rolledBackTo"), dt, "gone" if "t-steward-e2e-echo" not in lanes else "STILL THERE", rb.get("lanesRemoved"), len(lanes), all(s == "RUNNING" for s in lanes.values()), repo.get("installedVersion")))
        except Exception as e:  # noqa: BLE001
            stages.fail("rollback", e)
        else:
            stages.done("rollback")

    # ---- ideas reach the next brief ------------------------------------------------------------------
    if stages.ready("ideas", ['provision']):
        try:
            m.put("p-steward-ideas", {"ideaId": "idea-e2e", "text": "E2E: a lane that counts tokens per place every hour", "by": "person", "status": "open", "at": now()}, "idea-e2e")
            for t in m.query("p-steward-prompts"):
                if t["data"].get("kind") != "approval":
                    m.delete("p-steward-prompts", t["id"])
            for t in m.query("p-steward-iterate") + []:
                m.delete("p-steward-iterate", t["id"])
            m.put("p-steward-iterate", {"at": now(), "iterationId": "it-e2e-ideas", "reason": "e2e", "requestedBy": "e2e"}, "it-e2e-ideas")
            ctx, dt = m.wait(lambda: (lambda c: c if c.get("iterationId") == "it-e2e-ideas" else None)(m.newest("p-steward-context", "at")) if m.count("p-steward-context") else None, 120, 3, "ideas brief")
            check("ideas", "idea-e2e" in str(ctx.get("brief", "")), "the brief carries the idea (%d chars) in %ss" % (len(str(ctx.get("brief", ""))), dt))
        except Exception as e:  # noqa: BLE001
            stages.fail("ideas", e)
        else:
            stages.done("ideas")

    # ---- pause / resume ------------------------------------------------------------------------------
    if stages.ready("pause", ['provision']):
        try:
            m.cmd("p-steward-setup-cmd", "steward-infra", ["pause"], 300000)
            rec, dt = m.wait(lambda: (lambda r: r if r.get("state") == "paused" else None)(m.newest("p-steward-infra", "at", 'FROM $ WHERE $.kind == "pause"')), 180, 3, "pause")
            lanes = m.lanes()
            stopped = sum(1 for t, s in lanes.items() if s != "RUNNING")
            check("pause", lanes.get("t-steward-setup-cmd") == "RUNNING" and stopped >= len(lanes) - 2, "%d of %d lanes stopped in %ss, setup lane %s" % (stopped, len(lanes), dt, lanes.get("t-steward-setup-cmd")))
            if not a.keep:
                m.cmd("p-steward-setup-cmd", "steward-infra", ["resume"], 300000)
                rec, dt = m.wait(lambda: (lambda r: r if r.get("state") == "running" else None)(m.newest("p-steward-infra", "at", 'FROM $ WHERE $.kind == "pause"')), 180, 3, "resume")
                time.sleep(3)
                lanes = m.lanes()
                check("resume", all(s == "RUNNING" for s in lanes.values()), "%d lanes running in %ss" % (sum(1 for s in lanes.values() if s == "RUNNING"), dt))
                m.cmd("p-steward-setup-cmd", "steward-infra", ["pause"], 300000)  # leave the proof model quiet
        except Exception as e:  # noqa: BLE001
            stages.fail("pause", e)
        else:
            stages.done("pause")

    failed = [r for r in RESULTS if not r[1]]
    print("== %d checks, %d failed, %ss" % (len(RESULTS), len(failed), round(time.time() - t_start)))
    for name, ok, detail in failed:
        print("   FAILED", name, detail)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
