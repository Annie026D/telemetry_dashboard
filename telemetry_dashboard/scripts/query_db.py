"""Print a concise read-only sample from a development SQLite shard."""

import sqlite3, os

db='data/31.05.2026.db'
if not os.path.exists(db):
    print('DB_MISSING')
else:
    conn=sqlite3.connect(db)
    cur=conn.cursor()
    cur.execute("SELECT timestamp,device_name,value_key,value_num,value_text FROM telemetry_rows ORDER BY id DESC LIMIT 10")
    rows=cur.fetchall()
    for r in rows:
        print(r)
    conn.close()
