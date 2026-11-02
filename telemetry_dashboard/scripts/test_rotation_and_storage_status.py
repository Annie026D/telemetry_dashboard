"""Isolated regression test for same-day rotation and lightweight storage health."""
import json, os, pathlib, shutil, socket, subprocess, tempfile, time, urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
EXE = ROOT / ("dashboard_server.exe" if os.name == "nt" else "dashboard_server")
HTTP, UDP = 18108, 51108

def api(path):
    with urllib.request.urlopen(f"http://127.0.0.1:{HTTP}{path}", timeout=4) as response:
        return json.loads(response.read())

def main():
    if not EXE.exists():
        raise FileNotFoundError("Build the dashboard server first")
    with tempfile.TemporaryDirectory(prefix="telemetry-rotation-", dir=ROOT,
                                     ignore_cleanup_errors=True) as name:
        work = pathlib.Path(name)
        shutil.copy2(EXE, work / EXE.name)
        shutil.copytree(ROOT / "web", work / "web")
        (work / "config.ini").write_text(
            f"[server]\nhttp_port={HTTP}\nweb_root=web\n[database]\ndir=data\n"
            f"rotate_mb=1\n[udp_channel_1]\nenabled=1\nname=imu\n"
            f"group_ip=127.0.0.1\nport={UDP}\niface_ip=0.0.0.0\n",
            encoding="ascii",
        )
        process = subprocess.Popen([str(work / EXE.name)], cwd=work,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
        try:
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                try:
                    if api("/api/storage/status")["ok"]: break
                except OSError: time.sleep(.1)
            else: raise AssertionError("backend not ready")
            payload = json.dumps({"device":"IMU_UNIT","roll":1.25,"pad":"x" * 20000}).encode()
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
                for _ in range(160):
                    sock.sendto(payload, ("127.0.0.1", UDP))
                    time.sleep(.003)
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                status = api("/api/storage/status")
                if status["stored"] >= 160 and status["rotations"] > 0: break
                time.sleep(.1)
            else: raise AssertionError(f"rotation/storage did not settle: {status}")
            archived = list((work / "data" / "Archive Data").glob("*.db"))
            assert archived, "completed shard was not archived"
            listed = api("/api/db/list")
            assert archived[0].name in listed, "archived shard is not queryable"
            print("Rotation and storage-status regression test passed.")
        finally:
            process.terminate(); process.wait(timeout=5)
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
