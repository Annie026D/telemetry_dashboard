#!/usr/bin/env python3
"""Capture, import, and replay SCADA UDP traffic without mixing it into live data."""

from __future__ import annotations

import argparse
import base64
import configparser
import datetime as dt
import json
import pathlib
import shutil
import socket
import subprocess
import sys
import time
from dataclasses import dataclass
from typing import Iterator

@dataclass(frozen=True)
class Channel:
    name: str
    group_ip: str
    port: int
    iface_ip: str

# Load enabled UDP destinations from config.ini and index them by channel name for capture import and replay.
def load_channels(config_path: pathlib.Path) -> dict[str, Channel]:
    parser = configparser.ConfigParser()
    if not parser.read(config_path, encoding="utf-8"):
        raise SystemExit(f"Unable to read config: {config_path}")

    channels: dict[str, Channel] = {}
    for section in parser.sections():
        if not section.lower().startswith("udp_channel_"):
            continue
        name = parser.get(section, "name", fallback="").strip()
        group_ip = parser.get(section, "group_ip", fallback="").strip()
        iface_ip = parser.get(section, "iface_ip", fallback="0.0.0.0").strip()
        port = parser.getint(section, "port", fallback=0)
        if name and group_ip and port:
            channels[name] = Channel(name, group_ip, port, iface_ip)

    if not channels:
        raise SystemExit(f"No UDP channels found in {config_path}")
    return channels

# Locate tshark on PATH and return its executable path; capture mode cannot run when it is absent.
def tshark_path() -> str:
    executable = shutil.which("tshark")
    if not executable and sys.platform == "win32":
        candidates = (
            pathlib.Path(r"C:\Program Files\Wireshark\tshark.exe"),
            pathlib.Path(r"C:\Program Files (x86)\Wireshark\tshark.exe"),
        )
        executable = next((str(path) for path in candidates if path.is_file()), None)
    if not executable:
        raise SystemExit(
            "tshark was not found. Install Wireshark with TShark enabled, then "
            "open a new terminal."
        )
    return executable

# Create a timestamped filename in the logs directory for a new packet capture or decoded record file.
def default_capture_path(suffix: str) -> pathlib.Path:
    stamp = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
    return pathlib.Path("captures") / f"wireshark_{stamp}.{suffix}"

# Launch tshark with the configured UDP filter and write captured traffic to the requested pcapng file.
def run_capture(args: argparse.Namespace) -> int:
    output = args.output or default_capture_path("pcapng")
    output.parent.mkdir(parents=True, exist_ok=True)
    command = [
        tshark_path(), "-i", args.interface, "-f", args.capture_filter,
        "-w", str(output), "-a", f"duration:{args.duration}"
    ]
    print(f"Capturing UDP traffic to {output}")
    return subprocess.call(command)

# Match a captured packet's destination address and port to its configured telemetry channel.
def channel_for_packet(
    channels: dict[str, Channel], dst_ip: str, dst_port: int
) -> str:
    exact = [
        channel.name for channel in channels.values()
        if channel.group_ip == dst_ip and channel.port == dst_port
    ]
    if len(exact) == 1:
        return exact[0]

    same_port = [
        channel.name for channel in channels.values()
        if channel.port == dst_port
    ]
    return same_port[0] if len(same_port) == 1 else ""

# Decode a hexadecimal UDP payload and return JSON text plus base64/hex forms suitable for a JSONL capture record.
def encoded_payload(payload_hex: str) -> dict[str, object]:
    raw = bytes.fromhex(payload_hex.replace(":", ""))
    try:
        text = raw.decode("utf-8")
        try:
            return {"payload_encoding": "json", "payload": json.loads(text)}
        except json.JSONDecodeError:
            return {"payload_encoding": "utf8", "payload_text": text}
    except UnicodeDecodeError:
        return {
            "payload_encoding": "base64",
            "payload_b64": base64.b64encode(raw).decode("ascii"),
        }

# Convert tshark packet output into replayable JSONL records, retaining timestamps, endpoints, channel names, and payload bytes.
def run_import(args: argparse.Namespace) -> int:
    source = args.input.resolve()
    if not source.is_file():
        raise SystemExit(f"Capture file not found: {source}")

    output = args.output or default_capture_path("jsonl")
    output.parent.mkdir(parents=True, exist_ok=True)
    channels = load_channels(args.config)
    command = [
        tshark_path(), "-r", str(source), "-Y", "udp", "-T", "fields",
        "-E", "separator=/t", "-E", "occurrence=f",
        "-e", "frame.time_epoch", "-e", "ip.src", "-e", "udp.srcport",
        "-e", "ip.dst", "-e", "udp.dstport", "-e", "udp.payload",
    ]

    imported = 0
    skipped = 0
    with output.open("w", encoding="utf-8", newline="\n") as target:
        process = subprocess.Popen(
            command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", errors="replace"
        )
        assert process.stdout is not None
        for line in process.stdout:
            fields = line.rstrip("\r\n").split("\t")
            if len(fields) < 6 or not fields[5]:
                skipped += 1
                continue
            try:
                dst_port = int(fields[4])
                record: dict[str, object] = {
                    "capture_version": 1,
                    "captured_at": float(fields[0]),
                    "source_ip": fields[1],
                    "source_port": int(fields[2] or 0),
                    "destination_ip": fields[3],
                    "destination_port": dst_port,
                    "channel": channel_for_packet(channels, fields[3], dst_port),
                }
                record.update(encoded_payload(fields[5]))
            except (ValueError, TypeError) as exc:
                skipped += 1
                print(f"Skipping malformed packet: {exc}", file=sys.stderr)
                continue
            target.write(json.dumps(record, separators=(",", ":")) + "\n")
            imported += 1

        stderr = process.stderr.read() if process.stderr else ""
        return_code = process.wait()
        if return_code:
            raise SystemExit(stderr.strip() or f"tshark exited with {return_code}")

    print(f"Imported {imported} UDP packets to {output} ({skipped} skipped)")
    return 0

# Recover the original UDP bytes from a JSONL record's base64, hex, or JSON payload representation.
def packet_bytes(record: dict[str, object]) -> bytes:
    encoding = str(record.get("payload_encoding", ""))
    if encoding == "base64":
        return base64.b64decode(str(record.get("payload_b64", "")), validate=True)
    if encoding == "hex":
        return bytes.fromhex(str(record.get("payload_hex", "")).replace(":", ""))
    if encoding == "utf8":
        return str(record.get("payload_text", "")).encode("utf-8")

    payload = record.get("payload")
    if isinstance(payload, str):
        return payload.encode("utf-8")
    if payload is not None:
        return json.dumps(payload, separators=(",", ":")).encode("utf-8")
    raise ValueError("record has no supported payload")

# Read a capture record's timestamp as a floating-point Unix time, returning no value when it is missing or invalid.
def packet_time(record: dict[str, object]) -> float | None:
    value = record.get("captured_at")
    if value is not None:
        try:
            return float(value)
        except (TypeError, ValueError):
            pass
    timestamp = str(record.get("server_rx_ts") or record.get("timestamp") or "")
    if timestamp:
        try:
            return dt.datetime.fromisoformat(timestamp.replace("Z", "+00:00")).timestamp()
        except ValueError:
            return None
    return None

# Yield valid JSONL capture objects with their source line numbers so malformed records can be reported precisely.
def iter_records(path: pathlib.Path) -> Iterator[tuple[int, dict[str, object]]]:
    with path.open("r", encoding="utf-8-sig") as source:
        for line_number, line in enumerate(source, 1):
            if not line.strip():
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError as exc:
                print(f"Skipping line {line_number}: {exc}", file=sys.stderr)
                continue
            if isinstance(record, dict):
                yield line_number, record

# Choose the replay destination from command-line overrides or the record's configured channel and endpoint metadata.
def destination_for(
    record: dict[str, object], channels: dict[str, Channel]
) -> Channel | None:
    channel_name = str(record.get("channel", "")).strip()
    if channel_name in channels:
        return channels[channel_name]

    dst_ip = str(record.get("destination_ip", "")).strip()
    try:
        dst_port = int(record.get("destination_port", 0))
    except (TypeError, ValueError):
        dst_port = 0
    mapped = channel_for_packet(channels, dst_ip, dst_port)
    return channels.get(mapped)

# Replay captured UDP records in timestamp order, optionally preserving timing and filtering by channel.
def run_replay(args: argparse.Namespace) -> int:
    source = args.input.resolve()
    if not source.is_file():
        raise SystemExit(f"Capture file not found: {source}")
    if args.speed <= 0:
        raise SystemExit("--speed must be greater than zero")

    channels = load_channels(args.config)
    selected = set(args.channel or [])
    unknown = selected.difference(channels)
    if unknown:
        raise SystemExit("Unknown channel(s): " + ", ".join(sorted(unknown)))

    sent = skipped = 0
    previous_time: float | None = None
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 1)
    sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_LOOP, 1)

    try:
        for line_number, record in iter_records(source):
            destination = destination_for(record, channels)
            if destination is None or (selected and destination.name not in selected):
                skipped += 1
                continue
            try:
                payload = packet_bytes(record)
            except (ValueError, TypeError) as exc:
                print(f"Skipping line {line_number}: {exc}", file=sys.stderr)
                skipped += 1
                continue

            current_time = packet_time(record)
            if not args.no_timing and current_time is not None and previous_time is not None:
                delay = min(max(current_time - previous_time, 0.0), args.max_gap) / args.speed
                if delay:
                    time.sleep(delay)
            if current_time is not None:
                previous_time = current_time

            if args.dry_run:
                print(
                    f"{destination.name}: {len(payload)} bytes -> "
                    f"{destination.group_ip}:{destination.port}"
                )
            else:
                iface = args.interface or destination.iface_ip
                if iface and iface != "0.0.0.0":
                    try:
                        sock.setsockopt(
                            socket.IPPROTO_IP, socket.IP_MULTICAST_IF,
                            socket.inet_aton(iface)
                        )
                    except OSError as exc:
                        raise SystemExit(f"Unable to use interface {iface}: {exc}") from exc
                sock.sendto(payload, (destination.group_ip, destination.port))
            sent += 1
            if args.max_packets and sent >= args.max_packets:
                break
    finally:
        sock.close()

    action = "Checked" if args.dry_run else "Replayed"
    print(f"{action} {sent} packets from {source} ({skipped} skipped)")
    return 0

# Define capture, import, and replay command-line options and return the configured argument parser.
def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    capture = subparsers.add_parser("capture", help="store a timed Wireshark capture")
    capture.add_argument("--interface", required=True, help="TShark interface name or number")
    capture.add_argument("--duration", type=int, default=60, help="capture duration in seconds")
    capture.add_argument("--capture-filter", default="udp", help="libpcap capture filter")
    capture.add_argument("--output", type=pathlib.Path)
    capture.set_defaults(func=run_capture)

    importer = subparsers.add_parser("import-pcap", help="convert pcap/pcapng to replay JSONL")
    importer.add_argument("input", type=pathlib.Path)
    importer.add_argument("--config", type=pathlib.Path, default=pathlib.Path("config.ini"))
    importer.add_argument("--output", type=pathlib.Path)
    importer.set_defaults(func=run_import)

    replay = subparsers.add_parser("replay", help="send a JSONL capture through configured UDP channels")
    replay.add_argument("input", type=pathlib.Path)
    replay.add_argument("--config", type=pathlib.Path, default=pathlib.Path("config.ini"))
    replay.add_argument("--channel", action="append", help="replay only this channel; repeat as needed")
    replay.add_argument("--interface", help="override config.ini multicast interface")
    replay.add_argument("--speed", type=float, default=1.0)
    replay.add_argument("--max-gap", type=float, default=1.0, help="maximum preserved inter-packet gap")
    replay.add_argument("--max-packets", type=int, default=0)
    replay.add_argument("--no-timing", action="store_true")
    replay.add_argument("--dry-run", action="store_true")
    replay.set_defaults(func=run_replay)
    return parser

def main() -> int:
    args = build_parser().parse_args()
    return int(args.func(args))

if __name__ == "__main__":
    raise SystemExit(main())
