#!/usr/bin/env python3
"""Report how often motion auto-off switches lights off on someone still there.

A "false off" is an "Automatic Mode: Lights Off" (input_text.<room>_last_action)
followed by motion in that room (binary_sensor.<room>_motion) within 3 minutes.

Baseline, 10-17 Nov 2026 (before raising timeouts on 17 Nov):
  utility_room 191 offs / 48 false (25%)  timeout 3 -> 6 min
  hall         105 / 25 (23%)             timeout 2 -> 4 min
  kitchen       90 / 23 (25%)             timeout 6 -> 10 min
  landing       24 /  6 (25%)             timeout 2 -> 3 min
  shower_room   51 /  6 (11%)

Usage: python3 tools/light_false_offs.py [days]   (default 7; uses ha-api)
"""
import json
import subprocess
import sys
from datetime import datetime, timedelta, timezone

days = int(sys.argv[1]) if len(sys.argv) > 1 else 7
end = datetime.now(timezone.utc)
start = end - timedelta(days=days)
fmt = "%Y-%m-%dT%H:%M:%SZ"
raw = subprocess.run(
    ["ha-api", "get", f"logbook/{start.strftime(fmt)}?end_time={end.strftime(fmt)}"],
    capture_output=True, text=True, check=True,
).stdout
log = json.loads(raw)
for e in log:
    e["t"] = datetime.fromisoformat(e["when"])

rooms = sorted({
    e["entity_id"][len("input_text."):-len("_last_action")]
    for e in log if e.get("entity_id", "").endswith("_last_action")
})

def timeout(room):
    out = subprocess.run(["ha-api", "state", f"input_number.{room}_motion_timeout"],
                         capture_output=True, text=True).stdout
    return out.rsplit(":", 1)[-1].strip() if ":" in out else "?"

print(f"False offs over the last {days} days (motion back within 3 min)\n")
print(f"{'room':16}{'timeout':>8}{'auto-offs':>11}{'false':>7}{'%':>5}")
for room in rooms:
    offs = [e["t"] for e in log if e.get("entity_id") == f"input_text.{room}_last_action"
            and e.get("state") == "Automatic Mode: Lights Off"]
    if not offs:
        continue
    motion = [e["t"] for e in log if e.get("entity_id") == f"binary_sensor.{room}_motion"
              and e.get("state") == "on"]
    false = sum(1 for t in offs if any(t < m < t + timedelta(minutes=3) for m in motion))
    print(f"{room:16}{timeout(room):>8}{len(offs):>11}{false:>7}{100 * false // len(offs):>5}")
