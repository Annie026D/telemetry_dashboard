"""Send one marked UDP packet and verify its complete daily-DB lifecycle."""

import json
import socket
import sqlite3
import time
import uuid
from pathlib import Path
from contextlib import closing


DB = Path("data") / time.strftime("%d.%m.%Y.db")
PORT = 50103
GROUP = "239.255.2.3"


def main() -> None:
    marker = f"lifecycle-{uuid.uuid4()}"
    packet = {
        "device": "BUTTON_LED_UNIT",
        "seq": time.time_ns() % 1_000_000_000,
        "source": "codex_lifecycle_validation",
        "buttons": {"FIRE": {"id": 901, "value": 1}},
        "lifecycle_unknown_marker": marker,
    }
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as udp:
        udp.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 1)
        udp.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_LOOP, 1)
        udp.sendto(json.dumps(packet, separators=(",", ":")).encode(), (GROUP, PORT))

    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        with closing(sqlite3.connect(f"file:{DB.resolve().as_posix()}?mode=ro", uri=True)) as db:
            row = db.execute(
                "SELECT id,seq,source,buttons_FIRE_id,buttons_FIRE_value,raw_json "
                "FROM telemetry_device_button_led_unit "
                "WHERE raw_json LIKE ? ORDER BY id DESC LIMIT 1",
                (f"%{marker}%",),
            ).fetchone()
            if row:
                packet_id = row[0]
                extra = db.execute(
                    "SELECT value_text FROM telemetry_extra_fields "
                    "WHERE packet_id=? AND storage_table=? AND field_name=?",
                    (packet_id, "telemetry_device_button_led_unit", "lifecycle_unknown_marker"),
                ).fetchone()
                wide = db.execute(
                    "SELECT seq,source,raw_json FROM telemetry WHERE raw_json LIKE ? "
                    "ORDER BY id DESC LIMIT 1",
                    (f"%{marker}%",),
                ).fetchone()
                registry = db.execute(
                    "SELECT storage_table,packet_count FROM device_storage_registry "
                    "WHERE device_name='BUTTON_LED_UNIT' AND channel_name='button_led'"
                ).fetchone()
                hmi = db.execute(
                    "SELECT control_name,new_state FROM hmi_event_log "
                    "WHERE device_name='BUTTON_LED_UNIT' ORDER BY id DESC LIMIT 1"
                ).fetchone()
                assert row[1:5] == (packet["seq"], packet["source"], 901, 1), row
                assert json.loads(row[5]) == packet
                assert extra == (marker,), extra
                assert wide and json.loads(wide[2]) == packet
                assert registry and registry[0] == "telemetry_device_button_led_unit"
                assert hmi, "HMI event was not generated"
                print(json.dumps({
                    "database": str(DB.resolve()), "device_table_row": packet_id,
                    "parsed": True, "raw_json": True, "extra_field": True,
                    "registry": registry[0], "hmi_event": hmi[0],
                }))
                return
        time.sleep(0.1)
    raise AssertionError("marked UDP packet was not committed to the intended daily database")


if __name__ == "__main__":
    main()
