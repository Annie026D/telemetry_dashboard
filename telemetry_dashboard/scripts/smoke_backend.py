"""Isolated end-to-end smoke test for the Windows/Linux SCADA backend."""

from __future__ import annotations

import json
import os
import pathlib
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
PORT = 18090
UDP_PORT = 55123

# Send an HTTP request to the isolated backend and return both status code and raw body for assertions.
def request(path: str, data: bytes | None = None) -> tuple[int, bytes]:
    req = urllib.request.Request(
        f"http://127.0.0.1:{PORT}{path}",
        data=data,
        headers={"Content-Type": "application/json"} if data else {},
    )
    with urllib.request.urlopen(req, timeout=3.0) as response:
        return response.status, response.read()

# Poll the backend until it accepts HTTP requests, failing early if the child process exits or startup times out.
def wait_until_ready(process: subprocess.Popen[bytes]) -> None:
    deadline = time.monotonic() + 15.0
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"server exited early with {process.returncode}")
        try:
            if request("/api/db/list")[0] == 200:
                return
        except OSError:
            time.sleep(0.1)
    raise TimeoutError("server did not become ready")

def main() -> int:
    executable = pathlib.Path(os.environ.get(
        "TELEMETRY_TEST_EXE", ROOT / ("dashboard_server.exe" if os.name == "nt" else "dashboard_server")
    )).resolve()
    if not executable.exists():
        raise FileNotFoundError(f"build the server first: {executable}")

    with tempfile.TemporaryDirectory(prefix="scada-smoke-") as tmp_name:
        tmp = pathlib.Path(tmp_name)
        shutil.copy2(executable, tmp / executable.name)
        shutil.copytree(ROOT / "web", tmp / "web")
        (tmp / "config.ini").write_text(
            f"""[server]
http_port={PORT}
web_root=web

[database]
dir=data
expand_all_fields=1

[udp_channel_1]
enabled=1
name=joystick
group_ip=127.0.0.1
port={UDP_PORT}
iface_ip=0.0.0.0
""",
            encoding="ascii",
        )

        creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        process = subprocess.Popen(
            [str(tmp / executable.name)],
            cwd=tmp,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            creationflags=creationflags,
        )

        try:
            wait_until_ready(process)
            packet = {
                "device": "DYNAMIC_SMOKE_DEVICE",
                "process": "smoke_test",
                "axis_x": 0.25,
                "trigger": True,
                "new_text_state": "CALIBRATING",
                "nested": {"quality": 98},
            }
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as udp:
                udp.sendto(json.dumps(packet).encode("utf-8"), ("127.0.0.1", UDP_PORT))

            deadline = time.monotonic() + 8.0
            rows: list[object] = []
            while time.monotonic() < deadline:
                _, body = request("/api/all?range=all")
                rows = json.loads(body)
                if rows:
                    break
                time.sleep(0.1)
            if not rows:
                raise AssertionError("UDP packet was not persisted and returned")

            expected_device = "JOYSTICK_UNIT"
            dynamic_rows = [row for row in rows if row.get("device") == expected_device]
            dynamic_keys = {row.get("key") for row in dynamic_rows}
            if not {"axis_x", "new_text_state", "nested_quality"}.issubset(dynamic_keys):
                raise AssertionError("dynamic numeric, text, or nested fields are missing")

            _, device_body = request("/api/devices")
            discovered_devices = json.loads(device_body)
            if not any(
                row.get("device") == expected_device
                for row in discovered_devices
            ):
                raise AssertionError("dynamic device discovery failed")

            _, history_devices_body = request("/api/history/devices")
            history_devices = json.loads(history_devices_body)
            if not any(
                row.get("device") == expected_device
                for row in history_devices
            ):
                raise AssertionError("historical database device discovery failed")

            _, page_rows_body = request(
                "/api/page/telemetry"
                f"?device={expected_device}&range=5m"
            )
            page_rows = json.loads(page_rows_body)
            page_keys = {row.get("key") for row in page_rows}
            if not {"axis_x", "new_text_state", "nested_quality"}.issubset(page_keys):
                raise AssertionError("page telemetry range response is incomplete")

            _, packet_history_body = request(
                "/api/history/packets"
                f"?device={expected_device}&range=all"
            )
            packet_history = json.loads(packet_history_body)
            if not packet_history or not isinstance(
                packet_history[0].get("payload"), dict
            ):
                raise AssertionError("sampled raw packet history is unavailable")

            json_paths = (
                "/api/db/list",
                "/api/db/summary",
                "/api/all?range=all",
                "/api/hmi/devices",
                "/api/history/devices",
                "/api/history/packets?device=DYNAMIC_SMOKE_DEVICE&range=all",
                "/api/page/telemetry?device=DYNAMIC_SMOKE_DEVICE&range=5m",
                "/api/topology",
                "/api/history?range=all",
                "/api/db/metrics",
                "/api/fields",
            )
            page_paths = (
                "/dashboard.html",
                "/critical-dashboard.html",
                "/drive-control.html",
                "/diagnostic.html",
                "/history.html",
                "/topology.html",
                "/hmi.html",
                "/device.html",
            )

            for path in json_paths:
                status, body = request(path)
                if status != 200:
                    raise AssertionError(f"{path}: HTTP {status}")
                json.loads(body)

            for path in page_paths:
                status, body = request(path)
                if (status != 200) or (len(body) < 100):
                    raise AssertionError(f"{path}: invalid static response")

            if not list((tmp / "data").glob("*.db")):
                raise AssertionError("SQLite database was not created")

            print("Smoke test passed: UDP -> SQLite -> APIs -> dashboard/HMI pages.")
        finally:
            process.terminate()
            try:
                process.wait(timeout=5.0)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5.0)

    return 0

if __name__ == "__main__":
    raise SystemExit(main())
