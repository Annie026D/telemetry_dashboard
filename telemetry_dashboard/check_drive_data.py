"""Inspect a selected SQLite shard for drive telemetry during development.

This small diagnostic is read-only; it reports a missing database rather than
creating one and relies only on Python's standard sqlite3 module.
"""

import sqlite3
import os

db = 'data/27.06.2026.db'

if not os.path.exists(db):
    print(f"Database not found: {db}")
else:
    conn = sqlite3.connect(db)
    cur = conn.cursor()
    
    # Check for tracker_publish channel data
    cur.execute("SELECT COUNT(*) FROM telemetry_rows WHERE channel_name = 'tracker_publish' OR process_name = 'tracker_publish'")
    count = cur.fetchone()[0]
    print(f"Total tracker_publish packets in database: {count}")
    
    # Get the latest tracker_publish data
    cur.execute("SELECT timestamp, device_name, channel_name, process_name, value_key, value_num FROM telemetry_rows WHERE channel_name = 'tracker_publish' OR process_name = 'tracker_publish' ORDER BY id DESC LIMIT 30")
    rows = cur.fetchall()
    print("\nLatest 30 tracker_publish rows:")
    for r in rows:
        print(r)
    
    # Check when the earliest tracker_publish packet was created
    cur.execute("SELECT timestamp, COUNT(*) as count FROM telemetry_rows WHERE channel_name = 'tracker_publish' OR process_name = 'tracker_publish' GROUP BY timestamp ORDER BY timestamp DESC LIMIT 10")
    print("\n\nLatest tracker_publish timestamps:")
    grouped = cur.fetchall()
    for t, c in grouped:
        print(f"  {t}: {c} rows")
    
    conn.close()
