"""End-to-end proof that pan/tilt are scaled while raw_json stays original."""
import json
import os
import pathlib
import shutil
import socket
import sqlite3
import subprocess
import tempfile
import time
import urllib.request
from contextlib import closing

ROOT = pathlib.Path(__file__).resolve().parents[1]
HTTP_PORT = 18092
UDP_PORT = 50992

# Fetch persisted pan/tilt rows from the test backend so scaled values can be compared with the original JSON.
def get_rows() -> list[dict]:
    with urllib.request.urlopen(
        f"http://127.0.0.1:{HTTP_PORT}/api/all?range=all", timeout=3
    ) as response:
        return json.loads(response.read())

def main() -> int:
    executable = ROOT / ("dashboard_server.exe" if os.name == "nt" else "dashboard_server")
    with tempfile.TemporaryDirectory() as name:
        work = pathlib.Path(name)
        data = work / "data"
        shutil.copy2(executable, work / executable.name)
        shutil.copytree(ROOT / "web", work / "web")
        (work / "config.ini").write_text(
            f"[server]\nhttp_port={HTTP_PORT}\nweb_root=web\n"
            f"[database]\ndir={data.as_posix()}\nindexed_fields=pan,tilt\n"
            f"[udp_channel_1]\nenabled=1\nname=scaling_test\ngroup_ip=127.0.0.1\n"
            f"port={UDP_PORT}\niface_ip=0.0.0.0\n",
            encoding="ascii",
        )
        environment=dict(os.environ);environment["TELEMETRY_TEST_ALLOW_SHUTDOWN"]="1"
        process = subprocess.Popen([str(work / executable.name)], cwd=work,env=environment,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
        try:
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                try:
                    get_rows()
                    break
                except OSError:
                    time.sleep(0.1)
            packet = {"device": "DRIVE_UNIT", "pan": 1234, "tilt": -567,
                      "pan_actual_deg": 12.34, "tilt_actual_deg": -5.67,
                      "pos_deg": 42.5, "new_vendor_value": 77,
                      "nested": {"pan": 250}}
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as udp:
                udp.sendto(json.dumps(packet).encode(), ("127.0.0.1", UDP_PORT))
            rows: list[dict] = []
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline:
                rows = [r for r in get_rows() if r.get("device") == "DRIVE_UNIT"]
                if rows:
                    break
                time.sleep(0.1)
            values = {r.get("key"): float(r.get("value")) for r in rows}
            assert values["pan"] == 12.34
            assert values["tilt"] == -5.67
            deadline = time.monotonic() + 3
            daily_files: list[pathlib.Path] = []
            while time.monotonic() < deadline:
                daily_files = list(data.glob("*.db"))
                if daily_files:
                    break 
                time.sleep(0.1)
            assert len(daily_files) == 1, f"expected one daily DB, got {daily_files}"
            assert not (data / "devices").exists(), "legacy devices directory was created"
            assert not list(data.rglob("*part*.db")), "legacy rotated DB was created"
            with closing(sqlite3.connect(daily_files[0])) as db:
                device_tables = {row[0] for row in db.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' "
                    "AND name LIKE 'telemetry_device_%'"
                )}
                assert {"telemetry_device_lcu_unit", "telemetry_device_imu_unit",
                        "telemetry_device_drive_unit"}.issubset(device_tables)
                table = db.execute(
                    "SELECT storage_table FROM device_storage_registry "
                    "WHERE device_name='DRIVE_UNIT' ORDER BY last_seen DESC LIMIT 1"
                ).fetchone()[0]
                assert table.replace("_", "").isalnum(), table
                pan, tilt, raw_pan, raw_tilt, pan_deg, tilt_deg, pos_deg = db.execute(
                    f'SELECT pan,tilt,raw_pan,raw_tilt,pan_actual_deg,tilt_actual_deg,pos_deg FROM "{table}" '
                    "ORDER BY rowid DESC LIMIT 1"
                ).fetchone()
                raw = db.execute("SELECT raw_json FROM telemetry WHERE device_name='DRIVE_UNIT' ORDER BY id DESC LIMIT 1").fetchone()[0]
            assert pan == 12.34 and tilt == -5.67
            assert raw_pan == 1234 and raw_tilt == -567
            # Approved projection columns remain populated; only raw_json moved
            # to the authoritative telemetry table.
            assert pan_deg == 12.34 and tilt_deg == -5.67 and pos_deg == 42.5
            raw_packet = json.loads(raw)
            assert raw_packet["pan"] == 1234 and raw_packet["tilt"] == -567
            with closing(sqlite3.connect(daily_files[0])) as db:
                extra = db.execute(
                    "SELECT storage_table,field_type,value_num,value_text "
                    "FROM telemetry_extra_fields WHERE field_name='new_vendor_value'"
                ).fetchone()
                assert extra == (table, "num", 77.0, None), extra
            print("Pan/tilt scaling test passed.")
            return 0
        finally:
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{HTTP_PORT}/api/test/shutdown",timeout=2).read()
            except OSError: pass
            try: process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill();process.wait(timeout=5)

if __name__ == "__main__":
    raise SystemExit(main())
