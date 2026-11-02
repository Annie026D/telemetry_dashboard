"""Read-only schema/data comparison for two telemetry daily databases."""

import argparse
import json
import sqlite3
from pathlib import Path


def inspect(path: Path, include_nonempty: bool = True) -> dict:
    db = sqlite3.connect(f"file:{path.resolve().as_posix()}?mode=ro", uri=True)
    result = {"path": str(path.resolve()), "size": path.stat().st_size, "tables": {}}
    result["indexes"] = [
        row[0]
        for row in db.execute(
            "SELECT name FROM sqlite_master WHERE type='index' ORDER BY name"
        )
    ]
    for name, sql in db.execute(
        "SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name"
    ):
        quoted = name.replace('"', '""')
        columns = [row[1] for row in db.execute(f'PRAGMA table_info("{quoted}")')]
        count = db.execute(f'SELECT COUNT(*) FROM "{quoted}"').fetchone()[0]
        nonempty = {}
        if include_nonempty and (name.startswith("telemetry_device_") or name == "telemetry"):
            measured = [column for column in columns if column not in {"id", "raw_json"}]
            if measured:
                expressions = [
                    f'COUNT("{column.replace(chr(34), chr(34) * 2)}")'
                    for column in measured
                ]
                values = db.execute(
                    f'SELECT {",".join(expressions)} FROM "{quoted}"'
                ).fetchone()
                nonempty = dict(zip(measured, values))
        result["tables"][name] = {
            "rows": count,
            "columns": columns,
            "nonempty": nonempty,
            "sql": sql,
        }
    db.close()
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("databases", nargs="+")
    parser.add_argument("--summary", action="store_true")
    parser.add_argument("--compare", action="store_true")
    args = parser.parse_args()
    reports = [inspect(Path(item), not args.summary) for item in args.databases]
    if args.compare and len(reports) == 2:
        left, right = reports
        left_tables, right_tables = left["tables"], right["tables"]
        comparison = {
            "left": left["path"],
            "right": right["path"],
            "missing_tables_in_right": sorted(set(left_tables) - set(right_tables)),
            "new_tables_in_right": sorted(set(right_tables) - set(left_tables)),
            "missing_indexes_in_right": sorted(set(left["indexes"]) - set(right["indexes"])),
            "new_indexes_in_right": sorted(set(right["indexes"]) - set(left["indexes"])),
            "table_differences": {},
        }
        for name in sorted(set(left_tables) & set(right_tables)):
            old_columns = set(left_tables[name]["columns"])
            new_columns = set(right_tables[name]["columns"])
            if old_columns != new_columns or left_tables[name]["rows"] != right_tables[name]["rows"]:
                comparison["table_differences"][name] = {
                    "missing_columns_in_right": sorted(old_columns - new_columns),
                    "new_columns_in_right": sorted(new_columns - old_columns),
                    "left_rows": left_tables[name]["rows"],
                    "right_rows": right_tables[name]["rows"],
                }
        print(json.dumps(comparison, indent=2))
        return
    if args.summary:
        reports = [
            {
                "path": report["path"],
                "size": report["size"],
                "indexes": report["indexes"],
                "tables": {
                    name: {"rows": data["rows"], "column_count": len(data["columns"])}
                    for name, data in report["tables"].items()
                },
            }
            for report in reports
        ]
    print(json.dumps(reports, indent=2))


if __name__ == "__main__":
    main()
