"""Finite high-rate UDP -> SQLite stability test for the telemetry backend."""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request
import ctypes

ROOT = pathlib.Path(__file__).resolve().parents[1]
PORT = 18091
UDP_PORT = 55124

def process_usage(process: subprocess.Popen[bytes]) -> tuple[int, float]:
    """Return resident bytes and cumulative CPU seconds without dependencies."""
    if os.name == "nt":
        class PMC(ctypes.Structure):
            _fields_=[("cb",ctypes.c_ulong),("PageFaultCount",ctypes.c_ulong),("PeakWorkingSetSize",ctypes.c_size_t),("WorkingSetSize",ctypes.c_size_t),("QuotaPeakPagedPoolUsage",ctypes.c_size_t),("QuotaPagedPoolUsage",ctypes.c_size_t),("QuotaPeakNonPagedPoolUsage",ctypes.c_size_t),("QuotaNonPagedPoolUsage",ctypes.c_size_t),("PagefileUsage",ctypes.c_size_t),("PeakPagefileUsage",ctypes.c_size_t)]
        class FT(ctypes.Structure): _fields_=[("lo",ctypes.c_ulong),("hi",ctypes.c_ulong)]
        handle=ctypes.windll.kernel32.OpenProcess(0x0400|0x0010,False,process.pid);pmc=PMC();pmc.cb=ctypes.sizeof(pmc);ctypes.windll.psapi.GetProcessMemoryInfo(handle,ctypes.byref(pmc),pmc.cb);a,b,c,d=FT(),FT(),FT(),FT();ctypes.windll.kernel32.GetProcessTimes(handle,ctypes.byref(a),ctypes.byref(b),ctypes.byref(c),ctypes.byref(d));ctypes.windll.kernel32.CloseHandle(handle)
        ticks=lambda x:(x.hi<<32)|x.lo
        return int(pmc.WorkingSetSize),(ticks(c)+ticks(d))/10_000_000.0
    stat=pathlib.Path(f"/proc/{process.pid}/status").read_text();rss=int(next(x.split()[1] for x in stat.splitlines() if x.startswith("VmRSS:")))*1024
    fields=pathlib.Path(f"/proc/{process.pid}/stat").read_text().split();return rss,(int(fields[13])+int(fields[14]))/os.sysconf("SC_CLK_TCK")

# Request a JSON document from the isolated backend API and decode it; network or JSON errors fail the load test.
def request_json(path: str) -> dict[str, object]:
    with urllib.request.urlopen(
        f"http://127.0.0.1:{PORT}{path}", timeout=5.0
    ) as response:
        return json.loads(response.read())

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--packets", type=int, default=20000)
    parser.add_argument("--interval-us", type=int, default=0)
    parser.add_argument("--extra-fields", type=int, default=0)
    args = parser.parse_args()
    executable = ROOT / ("dashboard_server.exe" if os.name == "nt" else "dashboard_server")

    if not executable.exists():
        raise FileNotFoundError(f"Build the server first: {executable}")

    with tempfile.TemporaryDirectory(prefix="scada-load-") as tmp_name:
        tmp = pathlib.Path(tmp_name)
        shutil.copy2(executable, tmp / executable.name)
        shutil.copytree(ROOT / "web", tmp / "web")
        (tmp / "config.ini").write_text(
            f"""[server]
http_port={PORT}
web_root=web

[database]
dir=data

[udp_channel_1]
enabled=1
name=imu
group_ip=127.0.0.1
port={UDP_PORT}
iface_ip=0.0.0.0
""",
            encoding="ascii",
        )

        log = (tmp / "load-test-server.log").open("wb")
        process = subprocess.Popen(
            [str(tmp / executable.name)], cwd=tmp, stdout=log, stderr=subprocess.STDOUT
        )
        try:
            deadline = time.monotonic() + 15.0
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise RuntimeError(f"server exited early: {process.returncode}")
                try:
                    request_json("/api/diagnostic")
                    break
                except OSError:
                    time.sleep(0.1)
            else:
                raise TimeoutError("server did not become ready")

            started = time.monotonic()
            max_ram=0;max_queue=0;max_wal=0;max_spool=0
            payload_bytes_sent=0;json_fields_sent=0
            _,cpu_started=process_usage(process)
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as udp:
                for sequence in range(args.packets):
                    packet = {
                            "device_name": "IMU_UNIT",
                            "process_name": "load_test",
                            "sequence": sequence,
                            "timestamp_ms": int(time.time() * 1000),
                            "roll": sequence % 360,
                            "pitch": sequence % 180,
                            "yaw": sequence % 360,
                            "accel_x": 0.1,
                            "accel_y": 0.2,
                            "accel_z": 9.8,
                        }
                    packet.update(
                        {f"extra_{index}": sequence + index
                         for index in range(args.extra_fields)}
                    )
                    payload = json.dumps(
                        packet,
                        separators=(",", ":"),
                    ).encode()
                    payload_bytes_sent += len(payload)
                    json_fields_sent += len(packet)
                    udp.sendto(payload, ("127.0.0.1", UDP_PORT))
                    if args.interval_us > 0:
                        time.sleep(args.interval_us / 1_000_000.0)

            send_seconds = time.monotonic() - started
            deadline = time.monotonic() + 60.0
            diagnostic: dict[str, object] = {}
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise RuntimeError(f"server died under load: {process.returncode}")
                diagnostic = request_json("/api/diagnostic")
                storage = request_json("/api/storage/status")
                ram,_=process_usage(process);max_ram=max(max_ram,ram);max_queue=max(max_queue,int(storage.get("queue_len",0)))
                max_wal=max(max_wal,max((p.stat().st_size for p in tmp.rglob("*-wal")),default=0));max_spool=max(max_spool,int(storage.get("spool_bytes",0)))
                received = int(diagnostic["udp_channels"][0]["received"])
                committed = int(diagnostic["db_writer_committed"])
                pending = int(diagnostic["db_pending"])
                queued = int(diagnostic["ingest_queue_len"])
                if received > 0 and committed >= received and pending == 0 and queued == 0:
                    break
                time.sleep(0.1)

            graph_started = time.monotonic()
            elapsed=time.monotonic()-started;_,cpu_finished=process_usage(process)
            db_file_bytes=sum(p.stat().st_size for p in tmp.rglob("*.db"))
            wal_bytes_final=sum(p.stat().st_size for p in tmp.rglob("*-wal"))
            sqlite_bytes=db_file_bytes+wal_bytes_final
            graph_rows = request_json(
                "/api/all?range=5m&device=IMU_UNIT"
            )
            graph_seconds = time.monotonic() - graph_started
            if not isinstance(graph_rows, list) or not graph_rows:
                raise AssertionError("device graph query returned no history rows")
            if graph_seconds >= 5.0:
                raise AssertionError(
                    f"device graph query took {graph_seconds:.3f}s"
                )
            latest_started = time.monotonic()
            latest_rows = request_json(
                "/api/device/latest10?name=IMU_UNIT"
            )
            latest_seconds = time.monotonic() - latest_started
            if not isinstance(latest_rows, list) or not latest_rows:
                raise AssertionError("standalone device page returned no latest rows")
            if latest_seconds >= 5.0:
                raise AssertionError(
                    f"device latest query took {latest_seconds:.3f}s"
                )

            print(
                json.dumps(
                    {
                        "requested_packets": args.packets,
                        "send_seconds": round(send_seconds, 3),
                        "measured_packet_rate_per_second": round(args.packets/max(send_seconds,0.001), 2),
                        "raw_json_payload_bytes": payload_bytes_sent,
                        "average_payload_bytes_per_packet": round(payload_bytes_sent/max(args.packets,1), 2),
                        "average_json_fields_per_packet": round(json_fields_sent/max(args.packets,1), 2),
                        "graph_query_seconds": round(graph_seconds, 3),
                        "graph_rows": len(graph_rows),
                        "latest_query_seconds": round(latest_seconds, 3),
                        "latest_rows": len(latest_rows),
                        "server_alive": process.poll() is None,
                        "maximum_ram_bytes":max_ram,"maximum_queue_depth":max_queue,
                        "maximum_wal_bytes":max_wal,"final_wal_bytes":wal_bytes_final,
                        "maximum_spool_bytes":max_spool,
                        "cpu_seconds":round(cpu_finished-cpu_started,3),"database_file_bytes":db_file_bytes,
                        "sqlite_file_and_wal_bytes":sqlite_bytes,
                        "database_to_raw_expansion_ratio":round(sqlite_bytes/max(payload_bytes_sent,1),2),
                        "database_write_bytes_per_second":round(sqlite_bytes/max(elapsed,0.001),1),
                        "storage_accounting":storage,
                        "diagnostic": diagnostic,
                    },
                    indent=2,
                )
            )
            received = int(diagnostic.get("udp_channels", [{}])[0].get("received", 0))
            committed = int(diagnostic.get("db_writer_committed", 0))
            if process.poll() is not None:
                raise AssertionError("server did not remain alive")
            if received != args.packets:
                raise AssertionError(
                    f"receiver accepted {received}/{args.packets} paced packets"
                )
            if committed != received:
                raise AssertionError(
                    f"database committed {committed}/{received} received packets"
                )
            if int(diagnostic.get("ingest_dropped", 0)) != 0:
                raise AssertionError("ingest queue dropped accepted packets")
            if int(diagnostic.get("db_failures", 0)) != 0:
                raise AssertionError("database writer reported failures")
            return 0
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5.0)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5.0)
            log.close()

if __name__ == "__main__":
    raise SystemExit(main())
