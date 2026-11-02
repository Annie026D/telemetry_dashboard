"""End-to-end resilience checks for the single daily SQLite writer."""
import json, os, pathlib, shutil, socket, sqlite3, subprocess, tempfile, time, urllib.request
from contextlib import closing

ROOT=pathlib.Path(__file__).resolve().parents[1]; HTTP=18094; UDP=50994
EXE=ROOT/("dashboard_server.exe" if os.name=="nt" else "dashboard_server")

# Read a JSON response from the resilience-test backend API.
def api(path):
    with urllib.request.urlopen(f"http://127.0.0.1:{HTTP}{path}",timeout=3) as r:return json.loads(r.read())
# Wait for the test backend to begin serving requests, or fail if its process exits or the deadline expires.
def wait_ready(p):
    end=time.monotonic()+12
    while time.monotonic()<end:
        if p.poll() is not None: raise AssertionError("server exited")
        try: api("/api/diagnostic"); return
        except OSError: time.sleep(.1)
    raise AssertionError("server not ready")
# Send one encoded IMU fixture to the backend's isolated UDP receiver.
def send(value):
    with socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as s:s.sendto(value,("127.0.0.1",UDP))
# Encode an IMU packet with a sequence-specific unknown field for writer and schema-resilience checks.
def packet(seq): return json.dumps({"device":"IMU_UNIT","sequence":seq,"roll":1.5,"vendor_unknown":seq}).encode()
# Poll persisted telemetry until the expected row count is visible or the resilience deadline expires.
def wait_rows(count):
    end=time.monotonic()+20
    while time.monotonic()<end:
        d=api("/api/diagnostic")
        if int(d["rows"])>=count and int(d["ingest_queue_len"])==0:return d
        time.sleep(.1)
    raise AssertionError(f"did not persist {count} rows")

def main():
  with tempfile.TemporaryDirectory(prefix="writer-resilience-", ignore_cleanup_errors=True) as name:
    w=pathlib.Path(name); data=w/"data"; date_file=w/"date.txt"; date_file.write_text("day-one.db")
    shutil.copy2(EXE,w/EXE.name); shutil.copytree(ROOT/"web",w/"web")
    (w/"config.ini").write_text(f"[server]\nhttp_port={HTTP}\nweb_root=web\n[database]\ndir={data.as_posix()}\n[udp_channel_1]\nenabled=1\nname=imu\ngroup_ip=127.0.0.1\nport={UDP}\niface_ip=0.0.0.0\n")
    env=dict(os.environ); env["TELEMETRY_TEST_DATE_FILE"]=str(date_file)
    def start(extra=None):
      e=dict(env); e.update(extra or {}); p=subprocess.Popen([str(w/EXE.name)],cwd=w,env=e,stdout=subprocess.DEVNULL,stderr=subprocess.STDOUT);wait_ready(p);return p
    p=start()
    try:
      send(b"{malformed"); time.sleep(.2); assert p.poll() is None
      send(packet(1)); wait_rows(1); db1=data/"day-one.db"; assert db1.exists()
      lock=sqlite3.connect(db1,timeout=.1); lock.execute("BEGIN EXCLUSIVE")
      send(packet(2)); time.sleep(.5); assert p.poll() is None; lock.rollback(); lock.close(); wait_rows(2)
      date_file.write_text("day-two.db"); send(packet(3))
      end=time.monotonic()+20
      while time.monotonic()<end:
        if (data/"day-two.db").exists():
          with closing(sqlite3.connect(data/"day-two.db")) as d, d:
            if d.execute("SELECT COUNT(*) FROM telemetry").fetchone()[0]==1:break
        time.sleep(.1)
      else: raise AssertionError("daily rotation failed")
      assert len(list(data.glob("*.db")))==2
    finally: p.terminate();p.wait(timeout=5)
    p=start()
    try: send(packet(4)); wait_rows(2); assert p.poll() is None
    finally: p.terminate();p.wait(timeout=5)
    p=start({"TELEMETRY_TEST_DISK_LOW":"1"})
    try:
      send(packet(5)); end=time.monotonic()+5; ready=[]
      while time.monotonic()<end:
        ready=list((w/"spool").glob("*.ready")) if (w/"spool").exists() else []
        if ready and any(b'"sequence": 5' in path.read_bytes() for path in ready): break
        time.sleep(.1)
      assert p.poll() is None
      assert ready and any(b'"sequence": 5' in path.read_bytes() for path in ready)
    finally: p.terminate();p.wait(timeout=5)
    print("Writer resilience test passed: malformed, busy, restart, disk-low spool, daily rotation.")
  return 0
if __name__=="__main__": raise SystemExit(main())
