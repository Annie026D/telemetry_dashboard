"""Verify that an accepted packet reaches durable recovery on DB failure."""
import json
import os
import pathlib
import shutil
import socket
import sqlite3
import subprocess
import tempfile
import time
from contextlib import closing

ROOT = pathlib.Path(__file__).resolve().parents[1]
PORT = 50991

def main() -> int:
    executable = ROOT / ("dashboard_server.exe" if os.name == "nt" else "dashboard_server")
    with tempfile.TemporaryDirectory() as name:
        work = pathlib.Path(name)
        data = work / "data"
        shutil.copy2(executable, work / executable.name)
        shutil.copytree(ROOT / "web", work / "web")
        (work / "config.ini").write_text(
            f"[server]\nhttp_port=18091\nweb_root=web\n[database]\ndir={data.as_posix()}\n"
            f"[udp_channel_1]\nenabled=1\nname=failure_test\ngroup_ip=127.0.0.1\nport={PORT}\niface_ip=0.0.0.0\n",
            encoding="ascii",
        )
        env = dict(os.environ)
        env["TELEMETRY_FORCE_DB_FAILURE"] = "1"
        process = subprocess.Popen([str(work / executable.name)], cwd=work, env=env,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
        try:
            time.sleep(0.8)
            payload = {"device": "FAILURE_TEST", "roll": 12.5, "new_field": "proof"}
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as udp:
                udp.sendto(json.dumps(payload).encode(), ("127.0.0.1", PORT))
            spool = work / "spool"
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                ready = list(spool.glob("*.ready")) if spool.exists() else []
                if ready and any(b'FAILURE_TEST' in path.read_bytes()
                                 for path in ready):
                    daily = list(data.glob("*.db"))
                    assert len(daily) == 1, daily
                    with closing(sqlite3.connect(daily[0])) as db:
                        assert db.execute("SELECT COUNT(*) FROM telemetry").fetchone()[0] == 0
                        assert db.execute("SELECT COUNT(*) FROM telemetry_device_unknown_device").fetchone()[0] == 0
                        assert db.execute("SELECT COUNT(*) FROM telemetry_extra_fields").fetchone()[0] == 0
                        assert db.execute("SELECT COUNT(*) FROM device_storage_registry").fetchone()[0] == 0
                    process.terminate()
                    process.wait(timeout=5)
                    process = subprocess.Popen(
                        [str(work / executable.name)], cwd=work,
                        stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT,
                    )
                    deadline = time.monotonic() + 10
                    while time.monotonic() < deadline:
                        if process.poll() is not None:
                            raise AssertionError("recovery server exited")
                        if not list(spool.glob("*.ready")):
                            with closing(sqlite3.connect(daily[0])) as db:
                                committed = db.execute(
                                    "SELECT COUNT(*) FROM telemetry"
                                ).fetchone()[0]
                            if committed == 1:
                                print("Durable spool fallback and restart recovery test passed.")
                                return 0
                        time.sleep(0.1)
                    raise AssertionError("spooled packet was not recovered after restart")
                time.sleep(0.1)
            raise AssertionError("forced DB failure did not produce emergency telemetry")
        finally:
            process.terminate()
            process.wait(timeout=5)

if __name__ == "__main__":
    raise SystemExit(main())
