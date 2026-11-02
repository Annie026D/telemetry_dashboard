#!/usr/bin/env python3
"""
One-time migration for old SCADA daily SQLite databases.

It:
  1. adds raw_json/source_ip columns to telemetry_rows and telemetry_extra_fields;
  2. backfills every scalar key from telemetry.raw_json into telemetry_rows;
  3. backfills every scalar key into telemetry_extra_fields with the complete packet;
  4. records source-IP/key discovery in telemetry_ip_field_map.

Run from the telemetry dashboard directory:
    python scripts/migrate_raw_json_storage.py
"""
import json, sqlite3, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"

def flatten(obj, prefix=""):
    out = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            name = f"{prefix}_{k}" if prefix else str(k)
            out.extend(flatten(v, name))
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            out.extend(flatten(v, f"{prefix}_{i}" if prefix else str(i)))
    elif isinstance(obj, bool):
        out.append((prefix, "num", 1.0 if obj else 0.0, None))
    elif isinstance(obj, (int, float)):
        out.append((prefix, "num", float(obj), None))
    elif obj is None:
        out.append((prefix, "text", None, ""))
    else:
        out.append((prefix, "text", None, str(obj)))
    return out

def add_column(con, table, column, typ):
    cols = {r[1].lower() for r in con.execute(f'PRAGMA table_info("{table}")')}
    if column.lower() not in cols:
        con.execute(f'ALTER TABLE "{table}" ADD COLUMN "{column}" {typ}')

def migrate(db):
    con = sqlite3.connect(db)
    con.execute("PRAGMA journal_mode=WAL")
    con.executescript("""
    CREATE TABLE IF NOT EXISTS telemetry_rows(
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, timestamp TEXT,
      channel_name TEXT, source_ip TEXT, device_name TEXT, subdevice_name TEXT,
      process_name TEXT, subprocess_name TEXT, value_key TEXT, value_type TEXT,
      value_num REAL, value_text TEXT, anomaly INTEGER, reason TEXT, raw_json TEXT
    );
    CREATE TABLE IF NOT EXISTS telemetry_extra_fields(
      id INTEGER PRIMARY KEY AUTOINCREMENT, packet_id INTEGER NOT NULL,
      storage_table TEXT NOT NULL, device_name TEXT, channel_name TEXT,
      source_ip TEXT, field_name TEXT NOT NULL, field_type TEXT NOT NULL,
      value_num REAL, value_text TEXT, timestamp TEXT NOT NULL, raw_json TEXT
    );
    CREATE TABLE IF NOT EXISTS telemetry_ip_field_map(
      id INTEGER PRIMARY KEY AUTOINCREMENT, source_ip TEXT NOT NULL,
      device_name TEXT, channel_name TEXT, field_name TEXT NOT NULL,
      field_type TEXT NOT NULL, first_seen TEXT, last_seen TEXT,
      sample_count INTEGER NOT NULL DEFAULT 0, last_value_num REAL,
      last_value_text TEXT, last_raw_json TEXT,
      UNIQUE(source_ip,device_name,channel_name,field_name)
    );
    """)
    for table, col, typ in [
        ("telemetry_rows","source_ip","TEXT"),
        ("telemetry_rows","raw_json","TEXT"),
        ("telemetry_extra_fields","source_ip","TEXT"),
        ("telemetry_extra_fields","raw_json","TEXT"),
    ]:
        add_column(con, table, col, typ)

    packets = con.execute("""
      SELECT id,COALESCE(session_id,''),COALESCE(timestamp,''),
             COALESCE(server_rx_ts,timestamp),COALESCE(channel_name,''),
             COALESCE(device_name,''),COALESCE(subdevice_name,''),
             COALESCE(process_name,''),COALESCE(subprocess_name,''),
             COALESCE(source_ip,''),COALESCE(anomaly,0),COALESCE(reason,''),
             raw_json
      FROM telemetry WHERE raw_json IS NOT NULL AND raw_json <> ''
      ORDER BY id
    """).fetchall()

    inserted = 0
    for (pid,session_id,ts,server_ts,channel,device,sub,proc,subproc,
         source_ip,anomaly,reason,raw) in packets:
        try:
            obj = json.loads(raw)
        except Exception:
            continue
        fields = flatten(obj)
        for key, typ, num, text in fields:
            # Keep one copy per packet/key in telemetry_rows.
            exists = con.execute("""
              SELECT 1 FROM telemetry_rows
              WHERE session_id=? AND timestamp=? AND channel_name=? AND
                    device_name=? AND value_key=? AND raw_json=?
              LIMIT 1
            """,(session_id,ts,channel,device,key,raw)).fetchone()
            if exists:
                continue
            con.execute("""
              INSERT INTO telemetry_rows(
                session_id,timestamp,channel_name,source_ip,device_name,
                subdevice_name,process_name,subprocess_name,value_key,value_type,
                value_num,value_text,anomaly,reason,raw_json)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """,(session_id,ts,channel,source_ip,device,sub,proc,subproc,key,
                 typ,num,text,anomaly,reason,raw))
            con.execute("""
              INSERT INTO telemetry_extra_fields(
                packet_id,storage_table,device_name,channel_name,source_ip,
                field_name,field_type,value_num,value_text,timestamp,raw_json)
              VALUES(?,?,?,?,?,?,?,?,?,?,?)
            """,(pid,"telemetry",device,channel,source_ip,key,typ,num,text,ts,raw))
            con.execute("""
              INSERT INTO telemetry_ip_field_map(
                source_ip,device_name,channel_name,field_name,field_type,
                first_seen,last_seen,sample_count,last_value_num,last_value_text,last_raw_json)
              VALUES(?,?,?,?,?,?,?,1,?,?,?)
              ON CONFLICT(source_ip,device_name,channel_name,field_name)
              DO UPDATE SET last_seen=excluded.last_seen,
                sample_count=telemetry_ip_field_map.sample_count+1,
                field_type=excluded.field_type,last_value_num=excluded.last_value_num,
                last_value_text=excluded.last_value_text,last_raw_json=excluded.last_raw_json
            """,(source_ip,device,channel,key,typ,ts,ts,num,text,raw))
            inserted += 1
    con.commit()
    con.close()
    return inserted

def main():
    dbs = sorted(DATA.rglob("*.db"))
    if not dbs:
        print(f"No .db files found below {DATA}")
        return 0
    total = 0
    for db in dbs:
        n = migrate(db)
        total += n
        print(f"{db}: backfilled {n} field rows")
    print(f"TOTAL: {total}")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
