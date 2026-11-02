# UDP capture and offline replay

The backend already stores every accepted UDP packet separately from SQLite in
`logs/udp_packets_DD_MM_YYYY.jsonl`. These files preserve the original JSON
payload plus channel, device, source address, and receive timestamps.

`scripts/udp_capture_tool.py` also supports raw Wireshark/TShark captures. Files
created by this workflow live under `captures/`, which is ignored by Git so
large captures are not committed accidentally.

## Capture with Wireshark/TShark

List interfaces with `tshark -D`, then capture UDP traffic for 60 seconds:

```powershell
python scripts/udp_capture_tool.py capture --interface 1 --duration 60
```

Or save traffic using the Wireshark GUI as `.pcap` or `.pcapng`, then convert it
to the portable replay format:

```powershell
python scripts/udp_capture_tool.py import-pcap .\capture.pcapng
```

TShark must be selected when Wireshark is installed. Import keeps JSON payloads
readable and preserves non-JSON/binary UDP payloads using lossless Base64.

## Replay without live devices

Start the telemetry dashboard backend first. Then replay either a converted
Wireshark capture or the backend's existing daily packet log:

```powershell
python scripts/udp_capture_tool.py replay .\captures\wireshark_YYYYMMDD_HHMMSS.jsonl
python scripts/udp_capture_tool.py replay .\logs\udp_packets_26_06_2026.jsonl
```

Replay sends packets to the current multicast groups and ports in `config.ini`,
so parsing, SQLite storage, WebSocket updates, Device Fleet, alarms, graphs, and
inspectors exercise the same path as real equipment.

Useful safe checks and controls:

```powershell
python scripts/udp_capture_tool.py replay .\logs\udp_packets_26_06_2026.jsonl --dry-run --max-packets 10 --no-timing
python scripts/udp_capture_tool.py replay .\captures\sample.jsonl --channel imu --speed 10
```

Use `--interface ADDRESS` if the multicast interface stored in `config.ini` is
not available on the replay machine.
