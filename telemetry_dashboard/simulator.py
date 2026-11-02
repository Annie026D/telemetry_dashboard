"""Generate representative device telemetry for development and soak testing.

The simulator reads project channel configuration, encodes device-specific
JSON/binary payloads, and transmits UDP independently of backend availability.
Command-line options control destination, pacing, and device selection.
"""

import argparse
import configparser
import json
import math
import random
import socket
import struct
import time

LCU_MAGIC = b"LCU1"
LCU_VERSION = 1

BUTTON_IDS = [
    ("DRIVES_RESET", 1),
    ("OPTICS_RESET", 2),
    ("LRF_RESET", 3),
    ("CCE_RESET", 4),
    ("PARK", 5),
    ("ABORT", 6),
    ("COMBAT", 7),
    ("BCU", 8),
    ("PREPAR", 9),
    ("UNCAG", 10),
    ("DAY", 11),
    ("LOW_LIGHT", 12),
    ("THERMAL", 13),
    ("DROP", 14),
    ("FIRE", 15),
    ("LRF", 75),
    ("GButton1", 82),
    ("GButton2", 83),
    ("GButton3", 84),
    ("GButton4", 85),
    ("GButton5", 86),
    ("GButton6", 87),
]

SWITCH_IDS = [
    ("MAIN_POWER_ON", 16),
    ("DRIVES_ON", 17),
    ("OPTICS_ON", 18),
    ("LRF_ON", 19),
    ("CCE_ON", 20),
    ("LOCK", 21),
    ("STRELETS_CH1_ON", 22),
    ("STRELETS_CH2_ON", 23),
    ("SINGLE", 24),
    ("CTRL_SRC_WCS", 25),
    ("HEAT_FILTER_ON", 26),
    ("LAUNCH_KEY_EN", 27),
    ("TARGET_SPEED_FAST", 28),
    ("CHASE_HEAD", 29),
    ("CHASE_TAIL", 77),
    ("TARGET_SPEED_SLOW", 78),
    ("CTRL_SRC_CCE", 79),
    ("SALVO", 80),
    ("UNLOCK", 94),
]

KNOB_IDS = [
    ("MODE", 52),
    ("FREQUENCY", 53),
]

LED_IDS = [
    ("DRIVES_RESET_LED", 60),
    ("OPTICS_RESET_LED", 61),
    ("LRF_RESET_LED", 62),
    ("CCE_RESET_LED", 63),
    ("PARK_LED", 64),
    ("ABORT_LED", 65),
    ("COMBAT_LED", 66),
    ("BCU_LED", 67),
    ("PREPAR_LED", 68),
    ("UNCAG_LED", 69),
    ("DAY_LED", 70),
    ("LOW_LIGHT_LED", 71),
    ("THERMAL_LED", 72),
    ("DROP_LED", 73),
    ("FIRE_LED", 74),
    ("LRF_LED", 76),
    ("SW_LRF_Status_LED", 81),
    ("GBUTTON1_LED", 88),
    ("GBUTTON2_LED", 89),
    ("GBUTTON3_LED", 90),
    ("GBUTTON4_LED", 91),
    ("GBUTTON5_LED", 92),
    ("GBUTTON6_LED", 93),
    ("SW_UnLOCK_Status_LED", 95),
    ("SW_STRELETS_CH1_Status_LED", 96),
    ("SW_STRELETS_CH2_Status_LED", 97),
    ("SW_CCE_Status_LED", 98),
    ("SW_Optics_Status_LED", 99),
    ("SW_Drives_Status_LED", 100),
]

JOYSTICK_BUTTONS = [
    "button_1",
    "button_2",
    "button_3",
    "button_4",
    "button_5",
    "trigger_up",
    "trigger_down",
    "button_6",
    "reserved_2",
    "reserved_3",
    "reserved_4",
]

# Read enabled UDP channel sections from config.ini and return their multicast address, port, and interface settings.
def load_channels(path):
    cfg = configparser.ConfigParser()
    cfg.read(path)

    channels = []

    for section in cfg.sections():
        if not section.startswith("udp_channel_"):
            continue

        if cfg.getint(section, "enabled", fallback=1) == 0:
            continue

        channels.append({
            "name": cfg.get(section, "name", fallback=section).strip(),
            "group_ip": cfg.get(section, "group_ip", fallback="239.255.0.1").strip(),
            "port": cfg.getint(section, "port", fallback=50100),
            "iface_ip": cfg.get(section, "iface_ip", fallback="0.0.0.0").strip(),
        })

    return channels

# Create a UDP sender configured for the channel's unicast or multicast destination; the caller owns and later closes the socket.
def make_socket(channel, ttl):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, ttl)
    sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_LOOP, 1)

    iface_ip = channel["iface_ip"]
    if iface_ip and iface_ip not in ("0.0.0.0", "127.0.0.1"):
        try:
            sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_IF, socket.inet_aton(iface_ip))
        except OSError as exc:
            print(f"warning: cannot use iface {iface_ip} for {channel['name']}: {exc}")
            print(f"warning: sending {channel['name']} using default multicast interface")
    elif iface_ip == "127.0.0.1":
        print(f"warning: {channel['name']} uses loopback iface 127.0.0.1; sending on the default multicast interface")

    return sock

# Return the current Unix time in milliseconds for simulated packet timestamps.
def now_ms():
    return int(time.time() * 1000)

# Convert the simulator tick into a smooth repeating joystick-axis value between -1 and 1.
def axis_for_tick(tick):
    return 1 if tick % 2 == 0 else 2

# Build one LCU snapshot containing control states, drive feedback, tracker data, and a heartbeat for the requested tick.
def lcu_payload(tick):
    axis = axis_for_tick(tick)
    wave = math.sin(tick / 20.0)
    mode = tick % 6

    if mode == 0:
        return 1, {
            "v": 1,
            "id": "heartbeat",
            "type": "Event",
            "name": "Heartbeat",
            "src": "LCU",
            "body": {"status": "alive"},
            "meta": {},
        }

    if mode == 1:
        return 2, {
            "v": 1,
            "type": "Event",
            "name": "AppHealth",
            "src": "lcu",
            "body": {"uptime_ms": tick * 10},
            "meta": {},
        }

    if mode == 2:
        return 3, {
            "type": "continuous",
            "axis": axis,
            "angle_feedback": round(120 + wave * 30, 3),
            "angle_feedback_register": "ABS_POSITION",
            "io_status": random.randint(0, 65535),
            "src": "middleware",
            "name": "ContinuousDriveTelemetry",
        }

    if mode == 3:
        return 4, {
            "v": 1,
            "id": "periodic",
            "type": "Event",
            "name": "TelemetryPeriodic",
            "src": "middleware",
            "body": {
                "axis": axis,
                "drive_connected": True,
                "snapshot_cached": True,
                "fault_raw": 0,
                "fault_bits": {
                    "short_circuit": False,
                    "system_ok": True,
                    "rated_current": False,
                    "over_temp": False,
                    "over_volt": False,
                    "under_volt": False,
                    "motion_error": False,
                    "drive_disable": False,
                    "eeprom_error": False,
                    "commutation_err": False,
                    "lock_rotor": False,
                    "emergency_err": False,
                    "command_error": False,
                    "motion_complete": False,
                },
            },
            "meta": {},
        }

    if mode == 4:
        return 5, {
            "v": 1,
            "id": "dio_continuous",
            "type": "Event",
            "name": "TelemetryDioContinuous",
            "src": "middleware",
            "body": {
                "dio_connected": True,
                "di_bits": random.randint(0, 255),
                "do_bits": random.randint(0, 255),
            },
            "meta": {},
        }

    return 6, {
        "v": 1,
        "id": str(tick),
        "type": "Reply",
        "name": "MoveToPositionDeg",
        "src": "lcu",
        "body": {
            "result": {
                "ok": True,
                "code": "OK",
                "message": "Motion command accepted",
            },
            "drive_state": {
                "tilt": {
                    "has_motion_params": True,
                    "velocity": 0,
                    "accel": 0,
                    "decel": 0,
                    "target_deg": 0,
                    "target_pos": 0,
                    "last_update_ms": 0,
                },
                "pan": {
                    "has_motion_params": True,
                    "velocity": 5,
                    "accel": 2,
                    "decel": 2,
                    "target_deg": round(10 + wave * 5, 3),
                    "target_pos": 0,
                    "last_update_ms": now_ms(),
                },
            },
        },
        "meta": {},
    }

# Build a changing APEM joystick packet with axes, thumbwheels, buttons, hat position, sequence, and heartbeat.
def joystick_payload(tick):
    hat_cycle = [
        (0, 0),
        (0, 1),
        (1, 0),
        (0, -1),
        (-1, 0),
        (1, 1),
        (-1, -1),
    ]
    hat_x, hat_y = hat_cycle[(tick // 12) % len(hat_cycle)]

    return {
        "type": "joystick",
        "channel": "joystick",
        "seq": tick,
        "source": "apem_joystick_sim",
        "axes": {
            "x": round(math.sin(tick / 5.0), 3),
            "y": round(math.cos(tick / 5.0), 3),
        },
        "thumbwheels": {
            "thumb_a": round((math.sin(tick / 18.0) + 1.0) / 2.0, 3),
            "thumb_b": round((math.cos(tick / 22.0) + 1.0) / 2.0, 3),
            "thumb_c": round((math.sin(tick / 28.0 + 1.4) + 1.0) / 2.0, 3),
        },
        "buttons": {
            name: 1 if ((tick // 10) + idx) % 3 == 0 else 0
            for idx, name in enumerate(JOYSTICK_BUTTONS)
        },
        "hats": {"hat_0": {"x": hat_x, "y": hat_y}},
        "connected": True,
        "heartbeat": time.time(),
    }

# Convert named control IDs into simulated on/off records whose state changes at the requested tick period.
def control_snapshot(items, tick, period=8):
    return {
        name: {
            "id": control_id,
            "value": 1 if ((tick // period) + idx) % 2 == 0 else 0,
        }
        for idx, (name, control_id) in enumerate(items)
    }

# Produce the two simulated button-panel knob states used in button/LED telemetry.
def knob_snapshot(tick):
    return {
        "MODE": {
            "id": 52,
            "value": 1 if (tick // 20) % 2 == 0 else 0,
        },
        "FREQUENCY": {
            "id": 53,
            "value": 1 if (tick // 30) % 2 == 0 else 0,
        },
    }

# Assemble button, switch, LED, knob, mode, and frequency states into one button-panel telemetry packet.
def button_led_payload(tick):
    return {
        "type": "button_led_snapshot",
        "channel": "button_led",
        "seq": tick,
        "direction": "rx",
        "source": "uart_button_sim",
        "heartbeat": time.time(),
        "mode": "AUTO" if (tick // 20) % 2 == 0 else "MANUAL",
        "frequency_hz": 25 if (tick // 30) % 2 == 0 else 50,
        "buttons": {
            **control_snapshot(BUTTON_IDS, tick, 7),
            **control_snapshot(LED_IDS, tick, 9),
        },
        "switches": control_snapshot(SWITCH_IDS, tick, 13),
        "knobs": knob_snapshot(tick),
    }

# Build camera/tracker and pan/tilt feedback for the current waveform, optionally identifying a specific source device.
def tracker_payload(tick, source=None):
    wave = math.sin(tick / 20.0)

    payload = {
        "type": "tracker_telemetry",
        "channel": "tracker_telem",
        "seq": tick,

        # Camera
        "camera_id": 1,
        "version": 1,

        # WCS
        "pan_actual_deg": round(wave * 45.0, 2),
        "tilt_actual_deg": round(wave * 10.0, 2),

        "pan_fault": 0,
        "tilt_fault": 0,

        "pan_limit_min": 0,
        "pan_limit_max": 0,

        "tilt_limit_min": 0,
        "tilt_limit_max": 0,

        "drive_connected": True,

        # Tracker
        "tracker_enable_mode": 1,
        "tracker_ret_x": round(100 + wave * 30, 2),
        "tracker_ret_y": round(200 + wave * 20, 2),

        "tracker_bb_w": 50,
        "tracker_bb_h": 40,

        "tracker_pan_err": round(wave * 2, 3),
        "tracker_tilt_err": round(wave * 1.5, 3),

        "track_cam_id": 1,
        "track_mode": 1,
        "track_type": 1,

        # LRF
        "lrf_range": round(1000 + wave * 100, 2),

        # GPS
        "lat": round(18.5204 + wave * 0.001, 6),
        "lon": round(73.8567 + wave * 0.001, 6),
        "alt_m": round(560 + wave * 2, 2),

        # Health
        "sys_temp": round(42 + wave * 2, 2),

        # Power
        "pwr_day_on": 1,
        "pwr_thermal_on": 1,
        "pwr_plcb_on": 1,
        "pwr_lrf_on": 1,
        "pwr_overall": 1,

        # Main Display
        "video_source": "THERMAL",
        "fps": 30,
        "tracking": "LOCKED",
        "latency_ms": round(25 + wave * 5, 2),
        "tracker_enabled": True,
        "imu_enabled": True
    }

    if source:
        payload["source"] = source

    return payload

# Create a moving external-target report with geographic position, bearing, range, confidence, and track identity.
def external_track_payload(tick):
    wave = math.sin(tick / 18.0)
    return {
        "type": "external_track",
        "cam_id": 1,
        "track_id": 1000 + (tick // 120),
        "azimuth_deg": round((90 + tick * 0.8) % 360, 2),
        "elevation_deg": round(12 + wave * 6, 2),
        "range_m": round(1800 + wave * 250, 1),
        "x": 100 + (tick % 50),
        "y": 200 + (tick % 40),
        "command": "drop" if tick % 5 == 0 else "start",
    }

# Create an IMU attitude sample whose roll, pitch, yaw, and sensor readings vary with the simulator tick.
def imu_payload(tick):

    wave = math.sin(tick / 25.0)

    return {

        "yaw": round(90 + wave * 15, 3),
        "pitch": round(wave * 5, 3),
        "roll": round(math.cos(tick / 25.0) * 4, 3),

        "lat": round(18.52 + wave * 0.001, 6),
        "lon": round(73.85 + wave * 0.001, 6),
        "alt": round(560 + wave * 2, 3),

        "accel_x": round(math.sin(tick/10)*1.5,3),
        "accel_y": round(math.cos(tick/10)*1.5,3),
        "accel_z": 9.81,

        "gyro_x": round(math.sin(tick/8)*5,3),
        "gyro_y": round(math.cos(tick/8)*5,3),
        "gyro_z": round(math.sin(tick/6)*3,3)
    }

# Select the packet builder that matches a configured channel name; return no packet for unsupported channels.
def payload_for_channel(name, tick):
    if name == "lcu_transport":
        return lcu_payload(tick)
    if name == "joystick":
        return None, joystick_payload(tick)
    if name == "button_led":
        return None, button_led_payload(tick)
    if name == "tracker_telemetry":
        return None, tracker_payload(tick)
    if name == "maindisplay":
        return None, {
        "video_source": "THERMAL",
        "fps": 30,
        "tracker_enabled": True,
        "imu_enabled": True,
        "recording": False
    }
    if name == "external_track":
        return None, external_track_payload(tick)
    if name == "tracker_publish":
        return None, drive_payload(tick)
    if name == "drive_wcs":
        return None, drive_payload(tick)
    if name == "imu":
        return None, imu_payload(tick)
    if name == "wcs_control_console":
        return None, wcs_payload(tick)
    if name == "advantec_driver":
        return None, advantech_payload(tick)
    if name == "cce_gateway":
        return None, cce_payload(tick)

    return None, {"type": name, "seq": tick, "value": tick}

# Create a CCE gateway packet containing connection state, commands, interlocks, and heartbeat data.
def cce_payload(tick):

    return {

        "device": "CCE_GATEWAY",

        "heartbeat": "ONLINE",

        "launch_enable": tick % 2,

        "salvo_launch": 1 if tick % 10 == 0 else 0,

        "tail_chase_mode": 1,

        "heat_flare_on": 0,

        "fast_lock_on": 1,

        "uncaging_enable": 1,

        "relay_active": tick % 8 == 0
    }

# Serialize a channel payload to its actual UDP wire format, including the binary LCU header where required.
def encode_packet(channel, tick, seq):
    topic_id, payload = payload_for_channel(channel["name"], tick)
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")

    if channel["name"] != "lcu_transport":
        return body, payload

    header = struct.pack(
        "!4sHHIQI",
        LCU_MAGIC,
        LCU_VERSION,
        topic_id or 0,
        seq,
        now_ms(),
        len(body),
    )

    return header + body, payload

# Derive a short human-readable packet label from its device, type, or channel fields for simulator logging.
def label_payload(payload):
    device = payload.get("device") or payload.get("src") or payload.get("source") or payload.get("channel") or payload.get("type", "-")
    process = payload.get("name") or payload.get("command") or payload.get("type", "-")
    return device, process
# Create a WCS operator-command packet with changing mode, target, authorization, and heartbeat values.
def wcs_payload(tick):

    wave = math.sin(tick / 20.0)

    return {

        "device": "WCS_CONSOLE",

        "pan_actual_deg": round(wave * 45, 2),
        "tilt_actual_deg": round(wave * 10, 2),

        "tracker_pan_error": round(wave * 2, 2),
        "tracker_tilt_error": round(wave * 1.5, 2),

        "drive_connected": True
    }

# Create drive-unit motion feedback, command positions, limits, faults, and temperatures for the current tick.
def drive_payload(tick):

    wave = math.sin(tick / 20.0)

    return {

        "device":"TRACKER_PUBLISH_UNIT",

        "pan_deg":
            round(wave * 45,2),

        "tilt_deg":
            round(wave * 10,2),

        "rpm":
            round(1200 + wave * 300,2),

        "current":
            round(12 + wave * 2,2),

        "voltage": round(48 + wave, 2),
        "torque_nm": round(8 + wave * 1.5, 2),
        "motor_temperature_c": round(46 + wave * 3, 2),
        "drive_connected": True,

        "fault_status":0,

        "io_status":
            random.randint(0,255)
    }

# Create an Advantech I/O snapshot containing digital inputs, outputs, analog channels, and module health.
def advantech_payload(tick):
    di_mask = (tick // 5) & 0xFF
    do_mask = ((tick // 9) ^ 0x55) & 0xFF

    return {
        "device": "ADVANTECH_IO",
        "device_connected": True,
        "di_mask": di_mask,
        "do_mask": do_mask,
        "di": {f"DI{index}": (di_mask >> index) & 1 for index in range(8)},
        "do": {f"DO{index}": (do_mask >> index) & 1 for index in range(8)},
        "health": {
            "queue_depth": tick % 4,
            "rx_errors": 0,
            "uptime_ms": tick * 100,
        },
    }
# Parse simulator options, open one sender per selected channel, transmit paced packets, and close every socket on exit.
def main():
    parser = argparse.ArgumentParser(description="Send multicast packets in the project wire formats.")
    parser.add_argument("--config", default="config.ini", help="Path to config.ini")
    parser.add_argument("--interval", type=float, default=0.01, help="Seconds between send cycles")
    parser.add_argument("--count", type=int, default=0, help="Send cycles; 0 means forever")
    parser.add_argument("--ttl", type=int, default=1, help="Multicast TTL")
    parser.add_argument(
        "--channel",
        action="append",
        default=[],
        help="Send only this configured channel (repeat for multiple channels)",
    )
    args = parser.parse_args()

    channels = load_channels(args.config)
    if args.channel:
        requested = set(args.channel)
        channels = [channel for channel in channels if channel["name"] in requested]
        missing = requested.difference(channel["name"] for channel in channels)
        if missing:
            parser.error("unknown or disabled channel(s): " + ", ".join(sorted(missing)))
    sockets = [(channel, make_socket(channel, args.ttl)) for channel in channels]

    print("Python multicast simulator started")
    for channel, _ in sockets:
        packet_type = "LCU1 header + JSON" if channel["name"] == "lcu_transport" else "raw JSON"
        print(f"  {channel['name']} -> {channel['group_ip']}:{channel['port']} ({packet_type})")

    tick = 0
    seq = 1

    try:
        while args.count <= 0 or tick < args.count:
            for channel, sock in sockets:
                data, payload = encode_packet(channel, tick, seq)
                sock.sendto(data, (channel["group_ip"], channel["port"]))
                device, process = label_payload(payload)
                print(f"sent {channel['name']}: {device} {process}")
                seq += 1

            tick += 1
            time.sleep(args.interval)
    except KeyboardInterrupt:
        print("\nSimulator stopped")
    finally:
        for _, sock in sockets:
            sock.close()

if __name__ == "__main__":
    main()
