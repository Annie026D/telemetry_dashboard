"""Store one captured packet per device and compare every scalar to its column."""
import glob,json,os,pathlib,socket,sqlite3,subprocess,tempfile,time,urllib.request,re
from contextlib import closing
ROOT=pathlib.Path(__file__).resolve().parents[1];EXE=pathlib.Path(os.environ.get("TELEMETRY_TEST_EXE",ROOT/("dashboard_server.exe" if os.name=="nt" else "dashboard_server"))).resolve();HTTP=18119
CHANNELS={"LCU_UNIT":"lcu_transport","JOYSTICK_UNIT":"joystick","BUTTON_LED_UNIT":"button_led","CAMERA_UNIT":"tracker_telemetry","EXTERNAL_TRACK_UNIT":"external_track","DRIVE_UNIT":"tracker_publish","IMU_UNIT":"imu","MAIN_DISPLAY":"maindisplay","WCS_CONSOLE":"wcs_control_console","CCE_GATEWAY":"cce_gateway","ADVANTECH_IO":"advantec_driver"}
TABLES={d:"telemetry_device_"+d.lower() for d in CHANNELS}
RESERVED={"id","v","type","name","src","channel","device","time","session","meta","session_id","timestamp","server_rx_ts","device_ts","packet_ts","latency_ms","device_name","channel_name","source_ip","source_port","subdevice_name","process_name","subprocess_name","anomaly","reason","raw_json"}
def flat(x,p="",out=None):
 out={} if out is None else out
 if isinstance(x,dict):
  for k,v in x.items():flat(v,f"{p}_{k}" if p else k,out)
 elif isinstance(x,list):
  for i,v in enumerate(x):flat(v,f"{p}_{i}",out)
 elif p:out[re.sub(r"[^A-Za-z0-9_]","_",p)[:119]]=x
 return out
def api(path):
 with urllib.request.urlopen(f"http://127.0.0.1:{HTTP}{path}",timeout=4) as r:return json.loads(r.read())
def samples():
 found={}
 for name in glob.glob(str(ROOT/"logs"/"udp_packets_*.jsonl")):
  for line in open(name,encoding="utf8",errors="ignore"):
   try:p=json.loads(line)
   except:continue
   d=p.get("device");
   if d in CHANNELS and d not in found:found[d]=p["payload"]
   if len(found)==len(CHANNELS):return found
 return found
def main():
 packets=samples()
 configured=set(re.findall(r"(?m)^name=([^\r\n]+)", (ROOT/"config.ini").read_text(encoding="utf8",errors="ignore")))
 coverage={d:("channel configuration missing" if channel not in configured else "channel not observed") for d,channel in CHANNELS.items() if d not in packets}
 if coverage:print(json.dumps({"observed_devices":sorted(packets),"coverage_gaps":coverage},indent=2))
 if not packets:print("Observed-packet storage test skipped: no captured UDP packet samples.");return 0
 with tempfile.TemporaryDirectory(prefix="json-storage-",ignore_cleanup_errors=True) as name:
  work=pathlib.Path(name);data=work/"data";lines=[f"[server]\nhttp_port={HTTP}\nweb_root={(ROOT/'web').as_posix()}\n[database]\ndir={data.as_posix()}\n"]
  ports={}
  for i,(device,channel) in enumerate(CHANNELS.items(),1):
   port=51200+i;ports[device]=port;lines.append(f"[udp_channel_{i}]\nenabled=1\nname={channel}\ngroup_ip=127.0.0.1\nport={port}\niface_ip=0.0.0.0\n")
  (work/"config.ini").write_text("\n".join(lines),encoding="ascii")
  p=subprocess.Popen([str(EXE)],cwd=work,stdout=subprocess.DEVNULL,stderr=subprocess.STDOUT)
  try:
   end=time.monotonic()+15
   while time.monotonic()<end:
    try:api("/api/storage/status");break
    except:time.sleep(.1)
   with socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as s:
    for d,payload in packets.items():s.sendto(json.dumps(payload,separators=(",",":")).encode(),("127.0.0.1",ports[d]));time.sleep(.05)
   end=time.monotonic()+20
   while time.monotonic()<end:
    status=api("/api/storage/status")
    if status["stored"]>=len(packets) and status["queue_len"]==0:break
    time.sleep(.1)
   else:raise AssertionError(status)
  finally:p.terminate();p.wait(timeout=5)
  with closing(sqlite3.connect(next(data.glob("*.db")))) as db:
   fail=[]
   for device,payload in packets.items():
    table=TABLES[device];cur=db.execute(f'SELECT * FROM "{table}" ORDER BY id DESC LIMIT 1');stored=dict(zip([x[0] for x in cur.description],cur.fetchone()))
    assert stored.get("raw_json"), f"{device}: device shard did not retain raw_json"
    assert json.loads(stored["raw_json"]) == payload, f"{device}: device shard raw_json changed"
    folded={key.lower():key for key in stored}
    for key,value in flat(payload).items():
     if key.lower() in RESERVED:continue
     actual=folded.get(key.lower())
     if actual is None:fail.append((device,key,"missing column"))
     elif stored[actual] is None:fail.append((device,key,"null"))
     elif isinstance(value,(int,float,bool)) and float(stored[actual])!=float(value):fail.append((device,key,f"{stored[actual]} != {value}"))
     elif isinstance(value,str) and str(stored[actual])!=value:fail.append((device,key,f"{stored[actual]} != {value}"))
   assert not fail,fail[:30]
   known_extras=db.execute("SELECT device_name,field_name,COUNT(*) FROM telemetry_extra_fields GROUP BY device_name,field_name").fetchall()
   assert not known_extras, f"reviewed fields incorrectly routed to fallback: {known_extras[:30]}"
  print(f"JSON storage validation passed: {len(packets)} devices, all representative scalar fields matched.")
 return 0
if __name__=="__main__":raise SystemExit(main())
