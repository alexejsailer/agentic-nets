#!/usr/bin/env python3
"""A deterministic stand-in for the headless coder, used by verify/e2e.py.

It reads the coder brief from stdin like a real agent, applies ONE canned change that the e2e spec
asks for (an echo map lane in steward-observe, or a docs-only change), builds the pack the way the
conventions demand, and prints the STEWARD_RESULT line. No model call, no cost, same pipeline.
"""
import json
import os
import re
import subprocess
import sys

ROOT = os.getcwd()  # the apply lane runs the coder in the repository root
PACK = os.path.join(ROOT, "capabilities", "steward")


def run(cmd):
    p = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=600)
    return p.returncode, (p.stdout or "") + (p.stderr or "")


def add_echo_lane():
    p = os.path.join(PACK, "nets", "steward-observe.net.json")
    d = json.load(open(p, encoding="utf-8"))
    if any(t["id"] == "t-steward-e2e-echo" for t in d["transitions"]):
        return ["nets/steward-observe.net.json (unchanged, lane present)"]
    d["places"]["p-steward-e2e-echo"] = "E2E echo of the newest health (a lane the e2e coder added)"
    d["transitions"].append({
        "id": "t-steward-e2e-echo", "kind": "map", "label": "E2E echo lane",
        "description": "Added by the e2e fake coder: copies the newest health summary once a day; the rollback must remove it.",
        "schedule": {"type": "cron", "cron": "0 30 6 * * *", "timezone": "Europe/Berlin"},
        "reads": {"health": {"place": "p-steward-health", "arcql": "FROM $ ORDER BY $.at DESC LIMIT 1", "consume": False}},
        "writes": {"echo": {"place": "p-steward-e2e-echo", "retain": 5}},
        "template": {"kind": "echo", "at": "${now()}", "observationId": "${health.data.observationId}", "summary": "${health.data.summary}"},
    })
    with open(p, "w", encoding="utf-8") as f:
        json.dump(d, f, indent=2, ensure_ascii=False); f.write("\n")
    return ["nets/steward-observe.net.json"]


def docs_only(title):
    p = os.path.join(PACK, "docs", "E2E.md")
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "a", encoding="utf-8") as f:
        f.write("- %s\n" % title)
    return ["docs/E2E.md"]


def main():
    brief = sys.stdin.read()
    m = re.search(r"^# (spec-[\w-]+): (.*)$", brief, re.M)
    spec_id, title = (m.group(1), m.group(2)) if m else ("?", "")
    if "echo lane" in title.lower():
        files = add_echo_lane(); touched = ["t-steward-e2e-echo", "p-steward-e2e-echo"]
    else:
        files = docs_only(title); touched = []
    rc, out = run(["node", "capabilities/tools/pack.mjs", "build", "--dir", "capabilities/steward"])
    if rc != 0:
        print("build failed:\n" + out[-800:])
        print('STEWARD_RESULT: {"summary": "build failed", "filesChanged": %s, "touched": [], "notes": "fake coder: build failed"}' % json.dumps(files))
        return 1
    print("fake coder applied %s: %s" % (spec_id, title))
    print("STEWARD_RESULT: " + json.dumps({"summary": "Fake coder applied %s (%s) deterministically." % (spec_id, title), "filesChanged": files, "touched": touched,
                                            "notes": "deterministic e2e change; no model call"}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
