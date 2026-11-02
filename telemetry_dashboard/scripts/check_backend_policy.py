"""Fast, compiler-independent checks for the safety-critical application unit."""

from __future__ import annotations

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
APPLICATION = ROOT / "app.c"
HMI = ROOT / "web" / "hmi.js"

FORBIDDEN_CALLS = (
    "atoi",
    "atol",
    "atof",
    "gets",
    "sprintf",
    "strcat",
    "strcpy",
    "vsprintf",
)

REQUIRED_ROUTES = (
    "/api/all",
    "/api/db/list",
    "/api/db/metrics",
    "/api/db/summary",
    "/api/device/count",
    "/api/device/latest10",
    "/api/device/state",
    "/api/devices",
    "/api/history",
    "/api/hmi/devices",
    "/api/hmi/latest",
    "/api/hmi/logs",
    "/api/search",
    "/api/simulate",
    "/api/topology",
    "/ws",
)

def main() -> int:
    source = APPLICATION.read_text(encoding="utf-8")
    hmi_source = HMI.read_text(encoding="utf-8")
    failures: list[str] = []

    for name in FORBIDDEN_CALLS:
        if re.search(rf"\b{re.escape(name)}\s*\(", source):
            failures.append(f"forbidden unbounded/unchecked call: {name}()")

    for route in REQUIRED_ROUTES:
        if f'"{route}"' not in source:
            failures.append(f"missing HTTP/WebSocket contract: {route}")

    if "static int append_format(" not in source:
        failures.append("bounded response formatter is missing")

    for marker in (
        'api("/api/devices?db="',
        "genericDeviceOverviewHtml",
        "updateDevicePanelSignals",
    ):
        if marker not in hmi_source:
            failures.append(f"dynamic HMI contract is missing: {marker}")

    if failures:
        for failure in failures:
            print(f"ERROR: {failure}", file=sys.stderr)
        return 1

    print("Backend policy checks passed.")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
