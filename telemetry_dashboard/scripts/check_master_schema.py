"""Verify that the checked-in master schema and the C bootstrap schema agree."""
from __future__ import annotations

import json
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parents[1]

def main() -> int:
    schema = json.loads((ROOT / "telemetry_schema.json").read_text(encoding="utf-8"))
    source = (ROOT / "app.c").read_text(encoding="utf-8")
    approved = schema["approved_columns"]
    errors: list[str] = []
    if schema.get("schema_version") != 1:
        errors.append("schema_version must be 1")
    for name, sql_type in approved.items():
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
            errors.append(f"unsafe SQL identifier: {name!r}")
        if sql_type not in {"REAL", "TEXT", "INTEGER"}:
            errors.append(f"unsupported SQL type for {name}: {sql_type}")
        marker = rf'\{{"{re.escape(name)}","{sql_type}"(?:,|\}})'
        if not re.search(marker, source):
            errors.append(f"approved column missing from database bootstrap: {name}")
    live_start = source.index("static bool insert_record(const char *json,", source.index("static bool insert_record(const char *json,") + 1)
    live_end = source.index("static void enqueue_immediate_live_packet", live_start)
    insert = source[live_start:live_end]
    if re.search(r'"ALTER\s+TABLE', insert, re.IGNORECASE):
        errors.append("ALTER TABLE is present in the live packet-processing path")
    if re.search(r'"CREATE\s+TABLE', insert, re.IGNORECASE):
        errors.append("CREATE TABLE is present in the live packet-processing path")
    if "sqlite3_open" in insert:
        errors.append("packet processing opens an additional SQLite connection")
    if "g_common_raw_sample_counter" in source:
        errors.append("raw_json sampling is forbidden; every packet must retain its original JSON")
    for forbidden in ("device_"+"writer_t", "device_writer_"+"for_route", "DEVICE_DB_"+"ROTATE_BYTES"):
        if forbidden in source:
            errors.append(f"separate device database architecture remains: {forbidden}")
    store = source[source.index("static bool store_device_packet("):source.index("#define INGEST_QUEUE_MAX")]
    if 'INSERT INTO \\"%s\\"' not in store:
        errors.append("device packets are not inserted into a safe device-specific daily table")
    if "storage_table,device_name,channel_name" not in store:
        errors.append("extra fields are not linked to their device table and packet")
    if ("begin_writer_batch_locked(db)" not in insert or
            "close_writer_db_locked(true)" not in insert):
        errors.append("packet-related inserts do not share a rollback-capable writer transaction")
    if ("g_approved_columns" not in source or
            "CREATE TABLE IF NOT EXISTS \\\"%s\\\"" not in source):
        errors.append("device tables are not bootstrapped from reviewed per-device schemas")
    if "INSERT INTO telemetry_extra_fields" not in store:
        errors.append("unknown JSON fields are not linked to the authoritative packet")
    if "sqlite3_bind_text(st, idx++, json" in store:
        errors.append("device shards still duplicate authoritative raw_json")
    if "sqlite3_bind_text(st, idx++, json" not in insert:
        errors.append("authoritative telemetry rows do not retain raw_json")
    for device in schema.get("supported_devices", []):
        if f'"{device}"' not in source:
            errors.append(f"approved device table is missing from daily bootstrap: {device}")
        if device not in schema.get("device_schemas", {}):
            errors.append(f"master schema has no per-device column policy for: {device}")
    if "telemetry_known_column(" in store:
        errors.append("device persistence incorrectly uses the common telemetry column cache")
    if errors:
        print("\n".join(f"ERROR: {error}" for error in errors))
        return 1
    print(f"Master schema checks passed ({len(approved)} approved columns).")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
