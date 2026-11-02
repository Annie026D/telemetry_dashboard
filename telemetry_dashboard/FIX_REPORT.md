# Telemetry server stability fix

## Exact causes found

1. `INGEST_QUEUE_MAX` existed but was intentionally ignored. When SQLite fell
   behind, every UDP thread continued allocating a queue node and a complete
   JSON copy. The queue could therefore consume all RAM and the operating
   system could terminate `dashboard_server`, which produces the browser's
   `Unable to connect to 127.0.0.1:8090` page.
2. The only database writer retried a failed record forever at a fixed 10 ms
   interval. A permanent error such as an invalid database path, disk-full, or
   I/O failure blocked all later records while the unlimited queue kept growing.
3. `config.ini` used `/home/anamikapc/Telemetry_dashboard_data`. That path is
   not valid for a native Windows build and is not portable to another Linux
   username. Failure to open it triggered cause 2.
4. Every HTTP API query runs on Mongoose's single event-loop thread. Several
   history/metrics queries can scan a large `telemetry_rows` table. An
   indefinitely running query therefore stops HTTP and WebSocket servicing even
   while UDP receiver threads remain alive.
5. The replay endpoint allocated 1 MiB on the native thread stack. That is
   unnecessarily risky on Windows builds with a smaller default stack.
6. Redirected stdout was buffered, so the supplied server error logs were empty
   and did not preserve the last failure message.
7. Each packet becomes one `telemetry` row plus up to 512 `telemetry_rows`.
   Packet count is therefore much smaller than the actual write workload.

## Corrections made

- Bounded the in-memory ingest backlog to 16,384 packets and 128 MiB.
- Applied bounded backpressure instead of allowing process memory to grow
  without limit.
- Added queue-byte and backpressure counters to `/api/diagnostic`.
- Added exponential database retry delay capped at two seconds.
- Changed the portable database directory to `data`.
- Added a two-second execution budget to read-only API queries so a pathological
  query cannot monopolize the HTTP event loop indefinitely.
- Configured WAL checkpointing and a 256 MiB retained journal limit.
- Moved the replay response buffer from stack to heap.
- Made server logs line-buffered so the last diagnostics are preserved.
- Corrected Mongoose's `alloca` header selection for both Windows and Linux.
- Added `scripts/load_backend.py` for repeatable ingestion verification.

## Verified results

- Strict Linux compilation: passed.
- GCC static analyzer and backend policy checks: passed.
- UDP -> SQLite -> APIs -> dashboard/HMI smoke test: passed.
- 20,000 paced packets with eight fields each: 20,000 received, 20,000
  committed, 160,000 field rows, zero ingest drops, zero database failures,
  server remained alive.
- 5,000 packets with 108 stored fields each: 5,000 received, 5,000 committed,
  540,000 field rows, zero ingest drops, zero database failures, server remained
  alive.

An intentionally unpaced local blast sent 20,000 UDP datagrams in 0.089 seconds
and the operating-system UDP receive buffer delivered only 16,713. Every one of
those 16,713 received datagrams was committed. This demonstrates an important
transport limit: an application cannot guarantee receipt of every UDP datagram
when senders exceed the kernel/socket capacity. Guaranteed delivery ultimately
requires sender-side pacing or an acknowledged protocol/spool.

## Run on Ubuntu/WSL

Keep the active project and `data` directory in the Linux filesystem, not
`/mnt/c`:

```bash
cd ~/Telemetry_dashboard
./build.sh clean
./dashboard_server 2>&1 | tee logs/server.log
```

Test locally:

```bash
python3 scripts/smoke_backend.py
python3 scripts/load_backend.py --packets 20000 --interval-us 100
```

## Run on Windows

```powershell
cd "C:\Users\User\Desktop\Telemetry_dashboard"
$env:Path = "C:\msys64\ucrt64\bin;$env:Path"
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\build.ps1 -Clean
.\dashboard_server.exe
```

The server must be started from the project directory so it can find
`config.ini`, `web`, and the relative `data` directory.

## Diagnostics that must remain zero

Open:

```text
http://127.0.0.1:8090/api/diagnostic
```

Watch these fields:

- `ingest_dropped`
- `db_failures`
- `db_pending` after traffic stops
- `db_last_error`

`ingest_queue_len` may rise during a burst, but it must return toward zero.
Repeated `ingest_backpressure_events` means the incoming sustained rate is
higher than the current SQLite row-expansion writer can maintain.
