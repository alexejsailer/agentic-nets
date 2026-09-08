#!/usr/bin/env python3
"""Designtime VIEW nets for Hermann.

The runtime places and transitions of a model are global; a net is a per-session drawing of some
of them. The five canonical nets (nets/*.pnml.json) are what the pack installs and what the
inscriptions belong to. The views built here are drawings of the SAME element ids: one drawing of
the whole persona (hermann-full) and one small drawing per stage, laid out left to right so each
fits an editor without maximizing. They carry no inscriptions and change nothing at runtime; they
exist so a person can read the persona one stage at a time. Deleting a view never touches the
runtime (designtime shapes only).

Usage: make-views.py [--model hermann] [--session agent-hermann] [--write-only]
Env:   MASTER_URL (default http://127.0.0.1:8082), AGENTICOS_SERVICE_TOKEN (X-Service-Auth)
Writes views/<view>.pnml.json next to this file and creates the nets through the designtime API.
"""
import argparse, glob, json, math, os, sys, urllib.request, urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
NETS = os.path.join(HERE, "..", "nets")
MASTER = os.environ.get("MASTER_URL", "http://127.0.0.1:8082").rstrip("/")
TOKEN = os.environ.get("AGENTICOS_SERVICE_TOKEN", "").strip()

P = lambda s: "p-hermann-" + s
T = lambda s: "t-hermann-" + s

PLACE_LABELS = {
    "config": "config", "goal": "goal and principles", "cards": "twelve factor cards", "setup-cmd": "setup commands",
    "setup-log": "setup log", "infra": "infra health", "repo": "repository record", "journal": "journal", "errors": "errors",
    "audit-request": "audit requests", "audit-cmd": "audit commands", "audit-log": "audit log", "repo-digest": "repo digest",
    "factor-cmd": "factor commands", "factor-reports": "factor reports", "scorecard": "scorecard", "iterate": "iteration triggers",
    "adr": "decision records", "responses": "the person's answers", "context-cmd": "brief commands", "spec-log": "brief log",
    "context": "briefs", "prompts": "questions for the person", "llm-errors": "contract misses", "specs": "specs",
    "decisions": "the person's decisions", "code-cmd": "coder commands", "coders": "coder definitions", "build-log": "build log",
    "runs": "runs", "verify-cmd": "verify commands", "verification": "verification results", "review-cmd": "review commands",
    "reviews": "review verdicts", "release-cmd": "release commands", "brain-cmd": "brain commands", "brain-log": "brain log",
    "signals": "signals per run", "map": "component map", "curation": "curation", "curations": "curation archive",
    "knowledge": "knowledge facts", "plan": "the plan",
}
TRANSITION_LABELS = {
    "infra-tick": "health tick, hourly", "setup-cmd": "setup process", "audit-cron": "weekly audit", "audit-prep": "request to digest",
    "digest-cmd": "repository digest", "f01-codebase": "I codebase", "f02-dependencies": "II dependencies", "f03-config": "III config",
    "f04-backing-services": "IV backing services", "f05-build-release-run": "V build release run", "f06-processes": "VI processes",
    "f07-port-binding": "VII port binding", "f08-concurrency": "VIII concurrency", "f09-disposability": "IX disposability",
    "f10-dev-prod-parity": "X dev prod parity", "f11-logs": "XI logs", "f12-admin-processes": "XII admin processes",
    "scorecard-cmd": "scorecard", "iterate-prep": "trigger to brief", "revise-prep": "reshape to brief", "answer-prep": "answer to brief",
    "context-cmd": "render the brief", "propose": "propose, agent", "spec": "write the spec, agent", "approve-prep": "approval to coder",
    "changes-prep": "changes to coder", "merge-prep": "merge to release", "code-cmd": "coder, headless", "verify-cmd": "verify",
    "diff-cmd": "review brief from diff", "review": "review, agent", "merge-cmd": "merge, tag, next", "observe-cmd": "observe",
    "curate": "curate, one shot", "curate-cmd": "curate, headless agent", "apply-prep": "curation to apply", "apply-cmd": "apply",
    "answer-knowledge-prep": "answer to brain",
}
FACTORS = ["f01-codebase", "f02-dependencies", "f03-config", "f04-backing-services", "f05-build-release-run", "f06-processes",
           "f07-port-binding", "f08-concurrency", "f09-disposability", "f10-dev-prod-parity", "f11-logs", "f12-admin-processes"]
VIEWS = [
    ("hermann-full", "Designtime view of Hermann: every lane of the five nets in one drawing", None),
    ("hermann-view-setup", "Designtime view: stage 0, provision the git host and bootstrap the service", ["infra-tick", "setup-cmd"]),
    ("hermann-view-propose", "Designtime view: stage 1, propose the next iteration as a choice, an interview or a goal request", ["iterate-prep", "revise-prep", "context-cmd", "propose"]),
    ("hermann-view-spec", "Designtime view: stage 2, the person answers, the spec is written, the person approves", ["answer-prep", "context-cmd", "spec", "approve-prep"]),
    ("hermann-view-code", "Designtime view: stage 3, the coder implements the spec, verify and review", ["code-cmd", "verify-cmd", "diff-cmd", "review"]),
    ("hermann-view-release", "Designtime view: stage 4, merge and tag, or send the coder back", ["changes-prep", "merge-prep", "merge-cmd"]),
    ("hermann-view-audit", "Designtime view: the twelve factor audit, digest, twelve lanes, scorecard", ["audit-cron", "audit-prep", "digest-cmd"] + FACTORS + ["scorecard-cmd"]),
    ("hermann-view-brain", "Designtime view: the brain, observe, curate, apply, answer", ["observe-cmd", "curate", "curate-cmd", "apply-prep", "apply-cmd", "answer-knowledge-prep"]),
]
DX, DY, MAXROWS = 175, 100, 6


def load_canonical():
    places, transitions, arcs = {}, {}, {}
    for f in sorted(glob.glob(os.path.join(NETS, "*.pnml.json"))):
        n = json.load(open(f))["net"]
        for pid, p in n["places"].items(): places[pid] = p["label"]
        for tid, t in n["transitions"].items(): transitions[tid] = t["label"]
        for a in n["arcs"].values():
            arcs[(a["source"], a["target"])] = True
    return places, transitions, list(arcs.keys())


def layered_layout(nodes, arcs):
    """Left to right layering (longest path on the graph without its DFS back edges), one barycenter
    pass per layer, layers wider than MAXROWS split into sub columns. Returns {id: (x, y)}."""
    order = list(nodes)
    succ = {n: [] for n in order}; pred = {n: [] for n in order}
    for s, t in arcs:
        if s in succ and t in pred: succ[s].append(t); pred[t].append(s)
    state = {}; back = set()
    def dfs(u):
        state[u] = 1
        for v in succ[u]:
            if state.get(v) == 1: back.add((u, v))
            elif v not in state: dfs(v)
        state[u] = 2
    sources = [n for n in order if not pred[n]] or order[:1]
    for s in sources + order:
        if s not in state: dfs(s)
    layer = {n: 0 for n in order}
    for _ in range(len(order) + 1):
        changed = False
        for s, t in arcs:
            if (s, t) in back or s not in layer or t not in layer: continue
            if layer[t] < layer[s] + 1: layer[t] = layer[s] + 1; changed = True
        if not changed: break
    by_layer = {}
    for n in order: by_layer.setdefault(layer[n], []).append(n)
    rows = {}
    for L in sorted(by_layer):
        members = by_layer[L]
        def key(n):
            ps = [rows[p] for p in pred[n] if p in rows]
            return (sum(ps) / len(ps)) if ps else order.index(n) / max(1, len(order)) * MAXROWS
        members.sort(key=key)
        for i, n in enumerate(members): rows[n] = i
        by_layer[L] = members
    pos = {}; x = 110.0; total_rows = max(min(len(m), MAXROWS) for m in by_layer.values())
    mid = 90.0 + (total_rows - 1) * DY / 2
    for L in sorted(by_layer):
        members = by_layer[L]
        cols = max(1, math.ceil(len(members) / MAXROWS))
        per = math.ceil(len(members) / cols)
        for i, n in enumerate(members):
            c, r = divmod(i, per)
            count = min(per, len(members) - c * per)
            y = mid + (r - (count - 1) / 2) * DY
            pos[n] = (x + c * DX, y)
        x += cols * DX
    return pos


def build_view(vid, desc, tids, places, transitions, arcs):
    tset = set(T(t) for t in tids) if tids else set(transitions)
    pset = set()
    for s, t in arcs:
        if s in tset and t in places: pset.add(t)
        if t in tset and s in places: pset.add(s)
    nodes = [n for n in list(places) if n in pset] + [n for n in list(transitions) if n in tset]
    varcs = [(s, t) for s, t in arcs if (s in tset or s in pset) and (t in tset or t in pset) and (s in tset) != (t in tset)]
    pos = layered_layout(nodes, varcs)
    net = {"id": vid, "description": desc, "places": {}, "transitions": {}, "arcs": {}}
    for pid in sorted(pset):
        net["places"][pid] = {"id": pid, "label": PLACE_LABELS.get(pid[len("p-hermann-"):], places[pid]), "tokens": 0, "x": pos[pid][0], "y": pos[pid][1]}
    for tid in sorted(tset):
        net["transitions"][tid] = {"id": tid, "label": TRANSITION_LABELS.get(tid[len("t-hermann-"):], transitions[tid]), "x": pos[tid][0], "y": pos[tid][1]}
    for i, (s, t) in enumerate(varcs, 1):
        aid = "a-%s-%02d" % (vid, i); net["arcs"][aid] = {"id": aid, "source": s, "target": t, "weight": 1}
    return net


def api(method, path, body=None):
    req = urllib.request.Request(MASTER + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json", "X-Service-Auth": "Bearer " + TOKEN})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read().decode(); return r.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:200]


def push(net, model, session):
    vid = net["id"]; q = "?modelId=%s&sessionId=%s" % (model, session)
    st, _ = api("GET", "/api/designtime/nets/%s%s" % (vid, q))
    if st == 200:
        st, b = api("DELETE", "/api/designtime/nets/%s%s" % (vid, q)); print("  delete old drawing:", st)
    st, b = api("POST", "/api/designtime/nets", {"modelId": model, "sessionId": session, "netId": vid, "name": vid, "description": net["description"]})
    if st not in (200, 201): print("  create net FAILED", st, b); return False
    bad = 0
    for p in net["places"].values():
        st, b = api("POST", "/api/designtime/nets/%s/places" % vid, {"modelId": model, "sessionId": session, "placeId": p["id"], "label": p["label"], "x": p["x"], "y": p["y"], "tokens": 0})
        if st not in (200, 201): bad += 1; print("  place", p["id"], st, b)
    for t in net["transitions"].values():
        st, b = api("POST", "/api/designtime/nets/%s/transitions" % vid, {"modelId": model, "sessionId": session, "transitionId": t["id"], "label": t["label"], "x": t["x"], "y": t["y"]})
        if st not in (200, 201): bad += 1; print("  transition", t["id"], st, b)
    for a in net["arcs"].values():
        st, b = api("POST", "/api/designtime/nets/%s/arcs" % vid, {"modelId": model, "sessionId": session, "arcId": a["id"], "sourceId": a["source"], "targetId": a["target"]})
        if st not in (200, 201): bad += 1; print("  arc", a["id"], st, b)
    st, d = api("GET", "/api/designtime/nets/%s%s" % (vid, q))
    print("  stored: HTTP %s places %s transitions %s arcs %s, failures %d" % (st, d.get("placeCount") if isinstance(d, dict) else "?", d.get("transitionCount") if isinstance(d, dict) else "?", d.get("arcCount") if isinstance(d, dict) else "?", bad))
    return bad == 0


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--model", default="hermann"); ap.add_argument("--session", default="agent-hermann"); ap.add_argument("--write-only", action="store_true")
    a = ap.parse_args()
    places, transitions, arcs = load_canonical()
    print("canonical: %d places, %d transitions, %d arcs" % (len(places), len(transitions), len(arcs)))
    ok = True
    for vid, desc, tids in VIEWS:
        net = build_view(vid, desc, tids, places, transitions, arcs)
        xs = [n["x"] for n in list(net["places"].values()) + list(net["transitions"].values())]
        ys = [n["y"] for n in list(net["places"].values()) + list(net["transitions"].values())]
        print("%s: %d places, %d transitions, %d arcs, canvas %dx%d" % (vid, len(net["places"]), len(net["transitions"]), len(net["arcs"]), max(xs) + 60, max(ys) + 60))
        json.dump({"net": net}, open(os.path.join(HERE, vid + ".pnml.json"), "w"), indent=2)
        if not a.write_only:
            if not TOKEN: sys.exit("AGENTICOS_SERVICE_TOKEN is not set")
            ok = push(net, a.model, a.session) and ok
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
