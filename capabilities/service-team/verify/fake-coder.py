#!/usr/bin/env python3
"""A deterministic stand-in for the headless coder, used by verify/e2e.py.

It reads the context pack from stdin like a real agent, applies ONE canned, harmless change to the
service directory it was started in (a Markdown note under docs/ naming the spec, plus a unit test
file when the pack names one), commits on the current branch the way the rules demand, and prints
the TEAM_RESULT line. No model call, no cost, same pipeline.
"""
import json
import os
import re
import subprocess
import sys

ROOT = os.getcwd()  # the developer lane runs the coder in the service directory


def run(cmd):
    p = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=600)
    return p.returncode, (p.stdout or "") + (p.stderr or "")


def main():
    prompt = sys.stdin.read()
    if "READ-ONLY" in prompt:
        # the product owner's analyst: describe, never write
        files = sorted(os.path.relpath(os.path.join(d, f), ROOT) for d, _, fs in os.walk(ROOT) for f in fs if ".git" not in d)[:12]
        print("TEAM_RESULT: " + json.dumps({"summary": "A small service with %d files, measured by the e2e fake analyst. It builds with the charter's build command and tests with its test command." % len(files),
                                            "structure": [{"path": f, "purpose": "measured file"} for f in files[:6]], "entryPoints": files[:1], "tests": {"command": "see charter", "count": len([f for f in files if "test" in f.lower()]), "gaps": ["everything, this is a fixture"]},
                                            "health": ["README present" if any(f.endswith("README.md") for f in files) else "no README"], "debt": ["fixture code"], "docs": [f for f in files if f.endswith(".md")]}))
        return 0
    m = re.search(r"THE SPEC (spec-[\w-]+): ([^\n]*)", prompt)
    spec_id = m.group(1) if m else "spec-unknown"
    title = (m.group(2) if m else "e2e change").strip()
    branch = run(["git", "rev-parse", "--abbrev-ref", "HEAD"])[1].strip()
    os.makedirs(os.path.join(ROOT, "docs"), exist_ok=True)
    note = os.path.join(ROOT, "docs", "%s.md" % spec_id)
    with open(note, "w", encoding="utf-8") as f:
        f.write("# %s\n\n%s\n\nWritten by the e2e fake coder on branch %s; the pack asked for this spec.\n" % (spec_id, title, branch))
    files = [os.path.relpath(note, ROOT)]
    run(["git", "add", "-A", "docs"])
    rc, out = run(["git", "commit", "-q", "-m", "%s: %s" % (spec_id, title)])
    result = {"summary": "Added docs/%s.md describing the change (%s). No source files changed; the note records the spec on the branch." % (spec_id, title),
              "filesChanged": files, "tests": "no test command run by the fake coder", "deviations": ["docs only: the fake coder never edits source"], "notes": "commit rc %d" % rc}
    print("TEAM_RESULT: " + json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
