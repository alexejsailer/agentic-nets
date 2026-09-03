#!/usr/bin/env python3
"""scout-usage — put the cost where the decisions are made.

Reads master's measured per-transition usage for the last 24 hours and files ONE compact token
per day into p-scout-usage: total tokens and fires, plus the per-lane breakdown (tokens, fires,
average iterations and duration, tier/group attribution) as a JSON string. The dashboard's cost
card reads that place, so the burn is visible next to the buttons that cause it, without an
MCP session. Deterministic, no model. Keeps the newest KEEP_DAYS tokens; re-running on the same
day replaces that day's token.

Env: MASTER_URL, MODEL_ID, SINCE (default 24h), KEEP_DAYS (default 30), DRY_RUN=1 prints only.
"""
import json, os
import urllib.request, urllib.parse
from datetime import datetime, timezone

MASTER = os.environ.get("MASTER_URL", "http://127.0.0.1:8082").rstrip("/")
MODEL = os.environ.get("MODEL_ID", "research-scout")
PLACE = "p-scout-usage"
LANES_MAX = 12


def env_str(key, default=""):
    v = (os.environ.get(key) or "").strip()
    return default if v.lower() in ("", "null", "none", "undefined") else v


SINCE = env_str("SINCE", "24h")
KEEP_DAYS = int(env_str("KEEP_DAYS", "30") or 30)
DRY = env_str("DRY_RUN") not in ("", "0", "false")


def api(method, path, body=None, timeout=30):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(MASTER + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read().decode("utf-8", "replace")
    return json.loads(raw) if raw.strip() else {}


def main():
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    day = ts[:10]
    out = {"kind": "usage-rollup", "ts": ts, "day": day, "since": SINCE, "filed": 0}
    q = urllib.parse.urlencode({"modelId": MODEL, "since": SINCE, "sort": "tokens", "limit": 50})
    try:
        report = api("GET", "/api/usage/transitions?" + q)
    except Exception as e:
        out["error"] = "usage endpoint: " + str(e)[:160]
        print(json.dumps(out)); return

    rows = report.get("transitions") or []
    lanes = []
    for r in rows[:LANES_MAX]:
        lanes.append({
            "transitionId": r.get("transitionId"), "kind": r.get("transitionKind"),
            "tier": r.get("tier"), "group": r.get("group"),
            "fires": int(r.get("fires") or 0),
            "tokens": int(r.get("totalTokens") or 0),
            "promptTokens": int(r.get("totalPromptTokens") or 0),
            "avgIterations": round(float(r.get("avgIterations") or 0), 2),
            "avgDurationMs": int(r.get("avgDurationMs") or 0),
        })
    total_tokens = sum(int(r.get("totalTokens") or 0) for r in rows)
    total_fires = sum(int(r.get("fires") or 0) for r in rows)
    model_lanes = [l for l in lanes if l["kind"] in ("agent", "llm")]
    token = {
        "kind": "usage-day", "day": day, "ts": ts, "since": SINCE,
        "totalTokens": str(total_tokens), "fires": str(total_fires),
        "lanesReported": str(len(rows)),
        "modelTokens": str(sum(l["tokens"] for l in model_lanes)),
        "modelFires": str(sum(l["fires"] for l in model_lanes)),
        "topLane": (lanes[0]["transitionId"] if lanes else ""),
        "topLaneTokens": str(lanes[0]["tokens"] if lanes else 0),
        "lanes": json.dumps(lanes),
    }
    out.update(totalTokens=total_tokens, fires=total_fires, lanes=len(lanes),
               topLane=token["topLane"])
    if DRY:
        out["dryRun"] = True
        print(json.dumps(out)); return

    # One token per day: replace today's, then trim the series.
    try:
        res = api("POST", "/api/runtime/places/%s/tokens/query?modelId=%s" % (PLACE, MODEL),
                  {"arcql": "FROM $ LIMIT 500", "limit": 500})
        existing = [t for t in (res.get("tokens") or []) if (t.get("data") or {}).get("kind") == "usage-day"]
        for t in existing:
            if (t.get("data") or {}).get("day") == day:
                api("DELETE", "/api/runtime/places/%s/tokens/%s?modelId=%s" % (PLACE, t["id"], MODEL))
        api("POST", "/api/runtime/places/%s/tokens?modelId=%s" % (PLACE, MODEL),
            {"name": "usage-" + day, "data": token})
        out["filed"] = 1
        older = sorted((t for t in existing if (t.get("data") or {}).get("day") != day),
                       key=lambda t: str((t.get("data") or {}).get("day") or ""))
        for t in older[:-max(0, KEEP_DAYS - 1)] if len(older) >= KEEP_DAYS else []:
            api("DELETE", "/api/runtime/places/%s/tokens/%s?modelId=%s" % (PLACE, t["id"], MODEL))
            out["trimmed"] = out.get("trimmed", 0) + 1
    except Exception as e:
        out["error"] = str(e)[:200]
    print(json.dumps(out))


if __name__ == "__main__":
    main()
