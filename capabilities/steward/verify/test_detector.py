#!/usr/bin/env python3
"""Unit checks for the crystallisation detector's scoring (no runtime needed): python3 verify/test_detector.py"""
import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("steward_observe", os.path.join(HERE, "..", "assets", "steward-observe.py"))
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

failed = 0


def check(name, ok, detail=""):
    global failed
    failed += 0 if ok else 1
    print("%s %s %s" % ("PASS" if ok else "FAIL", name, detail))


same = [{"data": {"label": "spam", "score": "0.9", "text": "a different free text every single time, number %d" % i}} for i in range(10)]
check("same shape scores 1.0", mod.shape_repetition(same) == 1.0, str(mod.shape_repetition(same)))
mixed = [{"data": {"label": "spam" if i % 2 else "ham", "score": "0.9"}} for i in range(10)]
check("two labels score 0.5", abs(mod.shape_repetition(mixed) - 0.5) < 1e-9, str(mod.shape_repetition(mixed)))
varied = [{"data": {"label": "l%d" % i, "extra%d" % i: "x"}} for i in range(10)]
check("varied shapes score low", mod.shape_repetition(varied) <= 0.1, str(mod.shape_repetition(varied)))
check("empty is 0", mod.shape_repetition([]) == 0.0)
check("private fields ignored", mod.shape_repetition([{"data": {"a": "1", "_emittedAt": str(i)}} for i in range(4)]) == 1.0)


class FakeUsage:
    """candidates() asks the MCP per lane; stub it with a table."""
    def __init__(self, table):
        self.table = table

    def __call__(self, tool, args=None, **kw):
        assert tool == "usage_report"
        return {"aggregate": self.table.get(args["transitionId"], {"fires": 0})}


mod.mcp = FakeUsage({"t-a": {"fires": 20, "totalTokens": 20000, "avgIterations": 1, "errorRate": 0},
                     "t-b": {"fires": 20, "totalTokens": 80000, "avgIterations": 3.2, "errorRate": 0},
                     "t-c": {"fires": 3, "totalTokens": 300, "avgIterations": 1, "errorRate": 0}})
mod.query = lambda place, arcql="FROM $", limit=200, model=None: same if place == "p-a" else varied
rows = [{"transitionId": "t-a", "kind": "agent", "outputs": ["p-a"]}, {"transitionId": "t-b", "kind": "llm", "outputs": ["p-b"]},
        {"transitionId": "t-c", "kind": "agent", "outputs": ["p-c"]}, {"transitionId": "t-d", "kind": "map", "outputs": ["p-d"]}]
found = mod.candidates(rows, hours=168, min_fires=10)
by = {c["lane"]: c for c in found}
check("t-a is a crystallise candidate", by.get("t-a", {}).get("suggestion") == "crystallise", str(by.get("t-a")))
check("t-b is a tune candidate (4x the median tokens per fire)", by.get("t-b", {}).get("suggestion") == "tune", str(by.get("t-b")))
check("t-c fired too rarely", "t-c" not in by)
check("map lanes are never candidates", "t-d" not in by)
print("%d failed" % failed)
sys.exit(1 if failed else 0)
