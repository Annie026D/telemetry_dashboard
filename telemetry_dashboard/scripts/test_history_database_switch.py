"""Verify explicit history DB selection returns distinct daily-shard data."""
from __future__ import annotations

import json
import os
import pathlib
import shutil
import sqlite3
import subprocess
import tempfile
import time
import urllib.request
from contextlib import closing

ROOT = pathlib.Path(__file__).resolve().parents[1]
EXE = pathlib.Path(os.environ.get(
    "TELEMETRY_TEST_EXE", ROOT / ("dashboard_server.exe" if os.name == "nt" else "dashboard_server")
)).resolve()
HTTP = 18097


def api(path: str):
    with urllib.request.urlopen(f"http://127.0.0.1:{HTTP}{path}", timeout=5) as response:
        return json.loads(response.read())


def create_daily_db(path: pathlib.Path, timestamp: str, value: float) -> None:
    packet = {
        "device": "IMU_UNIT",
        "process": "imu",
        "nested": {"roll": value},
        "timestamp": timestamp,
    }
    with closing(sqlite3.connect(path)) as db, db:
        db.executescript("""
          CREATE TABLE telemetry(
            id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT,
            server_rx_ts TEXT, device_ts TEXT, packet_ts TEXT,
            latency_ms REAL, channel_name TEXT, device_name TEXT,
            subdevice_name TEXT, process_name TEXT, subprocess_name TEXT,
            anomaly INTEGER, reason TEXT, raw_json TEXT);
          CREATE INDEX idx_telemetry_device ON telemetry(device_name);
          CREATE TABLE telemetry_rows(
            id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT,
            channel_name TEXT, device_name TEXT, subdevice_name TEXT,
            process_name TEXT, subprocess_name TEXT, value_key TEXT,
            value_type TEXT, value_num REAL, value_text TEXT,
            anomaly INTEGER, reason TEXT);
        """)
        db.execute(
            "INSERT INTO telemetry(timestamp,server_rx_ts,device_ts,packet_ts,"
            "latency_ms,channel_name,device_name,subdevice_name,process_name,"
            "subprocess_name,anomaly,reason,raw_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (timestamp, timestamp, timestamp, timestamp, 0, "imu", "IMU_UNIT", "",
             "imu", "", 0, "", json.dumps(packet, separators=(",", ":"))),
        )
        db.execute(
            "INSERT INTO telemetry_rows(timestamp,channel_name,device_name,"
            "subdevice_name,process_name,subprocess_name,value_key,value_type,"
            "value_num,value_text,anomaly,reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
            (timestamp, "imu", "IMU_UNIT", "", "imu", "", "nested_roll",
             "num", value, "", 0, ""),
        )


def main() -> int:
    with tempfile.TemporaryDirectory(
        prefix="history-db-switch-", ignore_cleanup_errors=True
    ) as name:
        work = pathlib.Path(name)
        data = work / "data"
        data.mkdir()
        shutil.copy2(EXE, work / EXE.name)
        shutil.copytree(ROOT / "web", work / "web")
        (work / "config.ini").write_text(
            f"[server]\nhttp_port={HTTP}\nweb_root=web\n[database]\ndir={data.as_posix()}\n",
            encoding="ascii",
        )
        fixtures = {
            "15.08.2026.db": ("2026-08-15T10:00:00.000Z", 15.25),
            "16.08.2026.db": ("2026-08-16T11:00:00.000Z", 16.5),
        }
        for db_name, fixture in fixtures.items():
            create_daily_db(data / db_name, *fixture)

        date_file = work / "date.txt"
        # Keep the synthetic legacy fixtures read-only. Point the live writer
        # at a separate day so startup schema migration cannot change the data
        # whose historical compatibility this test is intended to measure.
        date_file.write_text("17.08.2026.db", encoding="ascii")
        environment = dict(os.environ)
        environment["TELEMETRY_TEST_DATE_FILE"] = str(date_file)
        environment["TELEMETRY_TEST_ALLOW_SHUTDOWN"] = "1"
        process = subprocess.Popen(
            [str(work / EXE.name)], cwd=work,
            env=environment,
            stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT,
        )
        try:
            deadline = time.monotonic() + 12
            while time.monotonic() < deadline:
                try:
                    api("/api/db/list")
                    break
                except OSError:
                    time.sleep(.1)
            else:
                raise AssertionError("history test backend did not start")

            assert set(fixtures).issubset(set(api("/api/db/list")))
            for db_name, (timestamp, value) in fixtures.items():
                devices = api(f"/api/history/devices?db={db_name}")
                assert devices == [{"device": "IMU_UNIT", "status": "recorded"}], devices
                packets = api(
                    f"/api/history/packets?db={db_name}&device=IMU_UNIT&range=all"
                )
                assert len(packets) == 1
                assert packets[0]["timestamp"] == timestamp
                assert packets[0]["payload"]["nested"]["roll"] == value
                rows = api(
                    f"/api/page/telemetry?db={db_name}&device=IMU_UNIT&range=all"
                )
                assert len(rows) == 1
                assert rows[0]["key"] == "nested_roll"
                assert rows[0]["value"] == value
                bounded = api(
                    f"/api/history?db={db_name}&device=IMU_UNIT&key=nested_roll"
                    "&range=1h&limit=100"
                )
                assert len(bounded) == 1
                assert bounded[0]["value"] == value

            edge = pathlib.Path(
                r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
            )
            if os.name == "nt" and edge.exists():
                for index, (db_name, (_, value)) in enumerate(fixtures.items()):
                    browser = subprocess.run(
                        [str(edge), "--headless", "--disable-gpu", "--no-first-run",
                         f"--user-data-dir={work / f'edge-profile-{index}'}",
                         "--virtual-time-budget=8000", "--dump-dom",
                         f"http://127.0.0.1:{HTTP}/history.html?db={db_name}"],
                        capture_output=True, text=True, timeout=30, check=True,
                    )
                    dom = browser.stdout
                    assert f'<option value="{db_name}"' in dom
                    assert 'id="metricSelect"' in dom and 'value="nested_roll"' in dom
                    assert "nested_roll" in dom and str(value) in dom
                    assert "<canvas" in dom
                direct = subprocess.run(
                    [str(edge), "--headless", "--disable-gpu", "--no-first-run",
                     f"--user-data-dir={work / 'edge-device-profile'}",
                     "--virtual-time-budget=8000", "--dump-dom",
                     f"http://127.0.0.1:{HTTP}/device.html?name=IMU_UNIT&db=15.08.2026.db"],
                    capture_output=True, text=True, timeout=30, check=True,
                )
                assert 'id="deviceTitle"' in direct.stdout
                assert "IMU_UNIT" in direct.stdout
                assert 'id="missionApp"' not in direct.stdout
            print("History DB switch test passed: distinct shards, table rows, and graph canvas.")
        finally:
            try: api("/api/test/shutdown")
            except OSError: pass
            try: process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill(); process.wait(timeout=5)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
