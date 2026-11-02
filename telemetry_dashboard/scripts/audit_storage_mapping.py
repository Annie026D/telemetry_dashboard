"""Read-only bounded audit of raw JSON-to-column and extra-field storage."""
from __future__ import annotations
import argparse, collections, json, pathlib, sqlite3

ROOT = pathlib.Path(__file__).resolve().parents[1]

def flatten(value, prefix=""):
    out = {}
    if isinstance(value, dict):
        for key, child in value.items():
            name = f"{prefix}_{key}" if prefix else str(key)
            out.update(flatten(child, name))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            out.update(flatten(child, f"{prefix}_{index}"))
    elif prefix:
        out[prefix.lower().replace(".", "_").replace("-", "_")] = value
    return out

def columns(db, table):
    return {row[1] for row in db.execute(f'PRAGMA table_info("{table}")')}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("db", nargs="?", type=pathlib.Path)
    parser.add_argument("--samples", type=int, default=100)
    args = parser.parse_args()
    path = args.db or max((ROOT / "data").glob("*.db"), key=lambda p: p.stat().st_mtime)
    db = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True, timeout=3)
    db.execute("PRAGMA query_only=ON")
    tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    print(json.dumps({"database": str(path), "bytes": path.stat().st_size,
                      "tables": sorted(t for t in tables if t.startswith("telemetry"))}, indent=2))
    devices = db.execute("SELECT device_name,storage_table,packet_count FROM device_storage_registry ORDER BY packet_count DESC").fetchall() if "device_storage_registry" in tables else []
    for device, table, packet_count in devices:
        if table not in tables: continue
        table_cols = columns(db, table)
        rows = db.execute(f'SELECT id,raw_json,* FROM "{table}" WHERE device_name=? ORDER BY id DESC LIMIT ?',
                          (device, args.samples)).fetchall()
        description = [item[0] for item in db.execute(f'SELECT id,raw_json,* FROM "{table}" LIMIT 0').description]
        missing, mismatched, populated = collections.Counter(), collections.Counter(), collections.Counter()
        for row in rows:
            stored = dict(zip(description, row))
            try: raw = flatten(json.loads(stored.get("raw_json") or "{}"))
            except json.JSONDecodeError: continue
            for key, value in raw.items():
                if key in table_cols:
                    if stored.get(key) is None: missing[key] += 1
                    elif str(stored.get(key)) != str(value) and not (
                        isinstance(value, (int, float)) and float(stored.get(key)) == float(value)):
                        mismatched[key] += 1
                    else: populated[key] += 1
        extras = []
        if "telemetry_extra_fields" in tables:
            extras = db.execute("SELECT field_name,COUNT(*) FROM telemetry_extra_fields WHERE device_name=? GROUP BY field_name ORDER BY COUNT(*) DESC LIMIT 50", (device,)).fetchall()
        print(json.dumps({"device": device, "table": table, "packets": packet_count,
                          "sampled": len(rows), "raw_known_but_null": missing,
                          "raw_stored_mismatch": mismatched, "known_populated": populated,
                          "extra_fields": extras}, default=dict, indent=2))
    if "telemetry" in tables:
        aliases = db.execute("SELECT device_name,COUNT(*) FROM telemetry WHERE UPPER(device_name) IN ('WCS','WCS_CONSOLE') GROUP BY device_name").fetchall()
        print(json.dumps({"wcs_alias_rows": aliases}, indent=2))
    return 0

if __name__ == "__main__": raise SystemExit(main())
