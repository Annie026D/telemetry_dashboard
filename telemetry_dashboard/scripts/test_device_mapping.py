"""Verify LCU/DRIVE classification, aliases, extras, raw JSON and diagnostics."""
import json,os,pathlib,shutil,socket,sqlite3,subprocess,tempfile,time,urllib.request
from contextlib import closing
ROOT=pathlib.Path(__file__).resolve().parents[1]; EXE=pathlib.Path(os.environ.get("TELEMETRY_TEST_EXE",ROOT/("dashboard_server.exe" if os.name=="nt" else "dashboard_server"))).resolve()
HTTP=18095; LCU_PORT=50995; DRIVE_PORT=50996
# Read and decode one response from the local backend endpoint used by the device-mapping assertions.
def api(path):
 with urllib.request.urlopen(f"http://127.0.0.1:{HTTP}{path}",timeout=3) as r:return json.loads(r.read())
# Send one JSON telemetry object to the test UDP port so the backend can classify and persist it.
def send(port,obj):
 with socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as s:s.sendto(json.dumps(obj,separators=(",",":")).encode(),("127.0.0.1",port))
def main():
 with tempfile.TemporaryDirectory(prefix="device-map-",ignore_cleanup_errors=True) as name:
  w=pathlib.Path(name);data=w/"data";shutil.copy2(EXE,w/EXE.name);shutil.copytree(ROOT/"web",w/"web")
  (w/"config.ini").write_text(f"[server]\nhttp_port={HTTP}\nweb_root=web\n[database]\ndir={data.as_posix()}\n[udp_channel_1]\nenabled=1\nname=lcu_transport\ngroup_ip=127.0.0.1\nport={LCU_PORT}\niface_ip=0.0.0.0\n[udp_channel_2]\nenabled=1\nname=drive_wcs\ngroup_ip=127.0.0.1\nport={DRIVE_PORT}\niface_ip=0.0.0.0\n")
  p=subprocess.Popen([str(w/EXE.name)],cwd=w,stdout=subprocess.DEVNULL,stderr=subprocess.STDOUT)
  try:
   end=time.monotonic()+10
   while time.monotonic()<end:
    try:api("/api/diagnostic");break
    except OSError:time.sleep(.1)
   lcu={"device":"UNKNOWN_DEVICE","body":{"status":"READY"},"system":{"status":"OK"},"vendor_lcu":{"deep":[1,{"code":9}]}}
   drive={"device":"UNKNOWN_DEVICE","body":{"rpm":1500,"dio_connected":True,"fault_bits":3},"actual_current":8.5,"dcbus_volt":48.2,"pan_actual_deg":12.5,"tilt_actual_deg":-3.25,"target_bearing":44,"target_range":700,"target_elevation":6,"vendor_drive":"x"}
   send(LCU_PORT,lcu);send(DRIVE_PORT,drive)
   end=time.monotonic()+12;diag={}
   while time.monotonic()<end:
    diag=api("/api/diagnostic")
    traces={x["name"]:x for x in diag["device_traces"]}
    if traces["LCU_UNIT"]["db_rows"]==1 and traces["DRIVE_UNIT"]["db_rows"]==1:break
    time.sleep(.1)
   else:raise AssertionError("device tables did not receive both packets")
   dbfile=list(data.glob("*.db"));assert len(dbfile)==1
   with closing(sqlite3.connect(dbfile[0])) as db:
    assert db.execute("select count(*) from telemetry_device_unknown_device").fetchone()[0]==0
    status,raw=db.execute("select status,raw_json from telemetry_device_lcu_unit").fetchone();assert status in ("READY","OK");assert json.loads(raw)==lcu
    row=db.execute("select rpm,current,voltage,connected,fault,pan,tilt,bearing,range,elevation,raw_json from telemetry_device_drive_unit").fetchone()
    assert row[:4]==(1500,8.5,48.2,1) and float(row[4])==3.0 and row[5:10]==(12.5,-3.25,44,700,6),row
    assert json.loads(row[10])==drive
    extras={x[0] for x in db.execute("select field_name from telemetry_extra_fields")}
    assert "vendor_lcu_deep_0" in extras and "vendor_lcu_deep_1_code" in extras and "vendor_drive" in extras,extras
    for mapped in ("body_status","system_status","body_rpm","body_dio_connected","body_fault_bits","actual_current","dcbus_volt","pan_actual_deg","tilt_actual_deg","target_bearing","target_range","target_elevation"):
     assert mapped not in extras,mapped
   traces={x["name"]:x for x in diag["device_traces"]}
   assert traces["LCU_UNIT"]["database_rows"]==1 and "status" in traces["LCU_UNIT"]["value_keys"]
   assert traces["DRIVE_UNIT"]["database_rows"]==1 and {"rpm","current","voltage","pan","tilt"}.issubset(traces["DRIVE_UNIT"]["value_keys"])
   assert traces["LCU_UNIT"]["gui_visible"] and traces["DRIVE_UNIT"]["graph_visible"]
   print("Device mapping test passed: LCU/DRIVE tables, aliases, extras and verification API.")
  finally:p.terminate();p.wait(timeout=5)
 return 0
if __name__=="__main__":raise SystemExit(main())
