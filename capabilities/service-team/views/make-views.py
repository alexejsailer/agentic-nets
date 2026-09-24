#!/usr/bin/env python3
"""Designtime VIEW nets for a service team.

The runtime places and transitions of a model are global; a net is a per-session drawing of some
of them. The seven canonical nets (nets/*.pnml.json) are what the pack installs and what the
inscriptions belong to; the hub prefixes every id with the service at install (p-<service>-team-*).
The views built here are drawings of the SAME element ids: one drawing of the whole team
(<service>-team-full) and one drawing per persona, laid out left to right so each fits an editor
without maximizing. They carry no inscriptions and change nothing at runtime; deleting a view
deletes a drawing, never a place or a transition.

Usage: make-views.py [--model agenticnets-product] [--service node] [--write-only]
Env:   MASTER_URL (default http://127.0.0.1:8082), AGENTICOS_SERVICE_TOKEN (X-Service-Auth)
Writes views/<view>.pnml.json next to this file and creates the nets through the designtime API.
"""
import argparse, glob, json, math, os, sys, urllib.request, urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
NETS = os.path.join(HERE, "..", "nets")
MASTER = os.environ.get("MASTER_URL", "http://127.0.0.1:8082").rstrip("/")
TOKEN = os.environ.get("AGENTICOS_SERVICE_TOKEN", "").strip()

SERVICE = "node"
P = lambda s: "p-%s-team-%s" % (SERVICE, s)
T = lambda s: "t-%s-team-%s" % (SERVICE, s)

PLACE_LABELS = {
    "charter": "team charter", "coders": "coder overrides", "setup-cmd": "setup commands", "setup-log": "setup log", "infra": "health, pause records",
    "repo": "clone record", "status": "status rows", "journal": "journal", "errors": "errors", "llm-errors": "contract misses",
    "iterate": "iteration triggers", "po-cmd": "product owner commands", "po-log": "product owner log", "context": "briefs", "state": "the measured module",
    "prompts": "questions for the person", "prompt-new": "new questions (copy)", "responses": "the person's answers", "requirements": "requirements",
    "requirement-drafts": "drafts for the architect", "ideas": "ideas", "arch-cmd": "architect commands", "arch-log": "architect log", "specs": "specs",
    "spec-drafts": "drafts for approval", "spec-catalog": "the spec catalog root", "adr": "decision records", "arch": "architecture notes", "briefs": "context packs",
    "acceptance": "acceptance criteria", "acceptance-new": "new acceptance (copy)", "decisions": "the person's decisions", "refused": "refused by the gate",
    "qa-cmd": "QA commands", "qa-log": "QA log", "verification": "verifications", "scorecard": "readiness scorecards", "bugs": "bugs", "runs": "coder runs",
    "dev-cmd": "developer commands", "dev-log": "developer log", "reviews": "reviews", "review-new": "new reviews (copy)", "brain-cmd": "brain commands",
    "brain-log": "brain log", "signals": "signals per merge", "curation": "curation", "curations": "curation archive", "knowledge": "knowledge facts", "plan": "the plan",
}
OFFICE_LABELS = {"p-product-inbox": "office inbox", "p-product-status": "office status rows", "p-product-setup-cmd": "office setup commands", "p-product-specs": "product-level specs"}
TRANSITION_LABELS = {
    "infra-tick": "health tick, hourly", "setup-cmd": "setup process", "iterate-prep": "trigger to brief", "po-cmd": "product owner process", "propose": "propose, one shot",
    "prompt-prep": "question to the office", "answer-prep": "answer to brief", "revise-prep": "reshape to brief", "requirement": "write the requirement, one shot",
    "design-prep": "requirement to design brief", "arch-cmd": "architect process", "design": "write the spec, one shot", "spec-gate-prep": "spec to approval",
    "pack-prep": "acceptance to context pack", "acceptance-prep": "approval to acceptance brief", "qa-cmd": "QA process", "acceptance": "write the acceptance, one shot",
    "audit-cron": "readiness audit, weekly", "approve-prep": "approval to coder", "dev-cmd": "developer process", "review": "review the diff, one shot",
    "merge-ask-prep": "verdict to merge question", "merge-prep": "merge decision to merge", "changes-prep": "changes back to coder",
    "brain-observe-cmd": "observe the merge", "curate": "curate, one shot", "curate-cmd": "curate, headless agent", "apply-prep": "curation to apply",
    "answer-knowledge-prep": "answer to brain", "brain-apply-cmd": "apply the curation", "spec-index": "indexes (link)",
}
VIEWS = [
    ("%s-team-full", "Designtime view of the %s team: every lane of the seven nets in one drawing", None),
    ("%s-team-view-setup", "Designtime view: setup, the health tick, provision, pause and resume", ["infra-tick", "setup-cmd"]),
    ("%s-team-view-product-owner", "Designtime view: the product owner, from the allocated iteration to the requirement", ["iterate-prep", "po-cmd", "propose", "prompt-prep", "answer-prep", "revise-prep", "requirement"]),
    ("%s-team-view-architect", "Designtime view: the architect, from the requirement to the spec, its approval and the context pack", ["design-prep", "arch-cmd", "design", "spec-gate-prep", "pack-prep"]),
    ("%s-team-view-qa", "Designtime view: QA, acceptance criteria after the approval, verification of a run, the weekly audit", ["acceptance-prep", "qa-cmd", "acceptance", "audit-cron"]),
    ("%s-team-view-developer", "Designtime view: the developer, from the approved pack to the coder, the review and the person's merge", ["approve-prep", "dev-cmd", "review", "merge-ask-prep", "merge-prep", "changes-prep"]),
    ("%s-team-view-brain", "Designtime view: the brain, observe a merge, curate, apply, answer", ["brain-observe-cmd", "curate", "curate-cmd", "apply-prep", "brain-apply-cmd", "answer-knowledge-prep"]),
]
DX, DY, MAXROWS = 175, 100, 6


def installed(i):
    """The hub prefixes the pack's ids with the service at install: p-team-x becomes p-<service>-team-x."""
    return i.replace("p-team-", "p-%s-team-" % SERVICE, 1).replace("t-team-", "t-%s-team-" % SERVICE, 1)


def load_canonical():
    places, transitions, arcs = {}, {}, {}
    for f in sorted(glob.glob(os.path.join(NETS, "*.pnml.json"))):
        n = json.load(open(f))["net"]
        for pid, p in n["places"].items(): places[installed(pid)] = p["label"]
        for tid, t in n["transitions"].items(): transitions[installed(tid)] = t["label"]
        for a in n["arcs"].values():
            arcs[(installed(a["source"]), installed(a["target"]))] = True
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
        bare = pid[len(P("")):] if pid.startswith(P("")) else pid
        net["places"][pid] = {"id": pid, "label": OFFICE_LABELS.get(pid, PLACE_LABELS.get(bare, places[pid])), "tokens": 0, "x": pos[pid][0], "y": pos[pid][1]}
    for tid in sorted(tset):
        net["transitions"][tid] = {"id": tid, "label": TRANSITION_LABELS.get(tid[len(T("")):], transitions[tid]), "x": pos[tid][0], "y": pos[tid][1]}
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
    global SERVICE
    ap = argparse.ArgumentParser(); ap.add_argument("--model", default="agenticnets-product"); ap.add_argument("--service", default="node"); ap.add_argument("--write-only", action="store_true")
    a = ap.parse_args(); SERVICE = a.service; a.session = a.service
    places, transitions, arcs = load_canonical()
    print("canonical: %d places, %d transitions, %d arcs" % (len(places), len(transitions), len(arcs)))
    ok = True
    for vid, desc, tids in VIEWS:
        vid, desc = vid % SERVICE, desc % SERVICE if "%s" in desc else desc
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
