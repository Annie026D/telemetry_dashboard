# Telemetry Dashboard Code Guide

## System purpose

This project receives telemetry datagrams from several UDP unicast or multicast
channels, validates and normalizes their payloads, publishes low-latency live
updates to browser clients, and persists an authoritative packet record in
SQLite. The browser application provides fleet status, device-specific HMI
instruments, history, diagnostics, and topology views.

## Runtime data flow

1. One receiver thread owns each configured UDP socket.
2. A receiver validates the datagram framing and JSON object before accepting
   it. Accepted packets are copied into the ingest queue and independently
   transformed into a live WebSocket message.
3. The ingest thread is the only owner of the SQLite writer connection,
   prepared insert statements, and write transaction lifecycle.
4. Every accepted packet is stored once in `telemetry.raw_json`. Compact mode
   expands only configured history fields into `telemetry_rows`; this prevents
   arbitrary packet keys from multiplying storage without bound.
5. Mongoose's event-loop thread owns HTTP connections and WebSocket sockets.
   It never performs writer commits. Read-only SQLite connections have a query
   execution budget so a large history request cannot monopolize the event
   loop indefinitely.
6. Browser pages bootstrap from HTTP APIs and then merge WebSocket messages
   into their in-memory live state.

## Concurrency and ownership

- `g_ingest_mutex` protects ingest queue links, queue sizes, and writer
  diagnostic counters. Callers must not perform database or network I/O while
  holding it.
- `g_db_mutex` protects writer connection state and prepared statements. The
  ingest thread is the normal owner; schema initialization also uses it during
  startup.
- `g_ws_mutex` protects the cross-thread live-update queue. Only the Mongoose
  event loop may call `mg_ws_send`.
- `g_udp_mutex` protects per-channel counters read by the diagnostic API.
- Heap-owned queue messages transfer ownership from producer to consumer. The
  consumer frees both the JSON payload and queue node.

## Persistence model

SQLite files are sharded by date. The `telemetry` table is the authoritative,
lossless representation of packets received by the process. `telemetry_rows`
is a derived index for configured numeric and textual fields. `device_state`
and `hmi_event_log` support operator-control state and transitions.

Write transactions are batched by packet count and elapsed time. WAL is used
on native filesystems to allow concurrent readers. When the backend runs from
a WSL DrvFS path such as `/mnt/c`, configured relative or DrvFS database paths
are automatically redirected to `~/.telemetry-dashboard/data` on native ext4.
SQLite databases must not be written through DrvFS because its locking,
shared-memory, and write throughput are unsuitable for sustained WAL ingest.

## Schema governance

`telemetry_schema.json` is the reviewed, version-controlled master contract. It
contains the approved union of simulator and historical-database fields, their
SQLite affinities, explicit per-device column groups, supported routes/devices,
and the single pan/tilt scaling rule. Device-table insertion checks the relevant
per-device policy rather than the common `telemetry` column cache. A
daily database and every configured device table inside that database are fully bootstrapped before
the ingest and UDP threads start. The live packet path performs DML only;
unapproved fields are walked directly from the parsed JSON tree (not from the
bounded history projection) and written to `telemetry_extra_fields` with their
packet, device table, device, channel, complete path, JSON type, untruncated
value, timestamp, and a copy of the complete `raw_json`. Promotion means
reviewing a field, adding it to the master file and bootstrap list, and deploying
that version for subsequent daily databases—never changing the active schema.

`raw_json` is retained for every packet, without sampling or normalization.
Top-level `pan` and `tilt` are divided by 100 in the parsed working copy exactly
once and are accompanied by `raw_pan` and `raw_tilt` in device and daily tables.
The WebSocket path independently parses the untouched datagram and applies the
same one-time normalization; database latency cannot block GUI delivery.

There are no per-device database files or connections. The dedicated device
row, shared telemetry row, state/registry changes, indexed projections, and all
unknown-field rows use the daily writer connection and one transaction. A queue
item is acknowledged only after that transaction commits; any failure rolls the
whole packet back for retry.
`synchronous=NORMAL` balances durability and sustained throughput.

The in-process ingest queue absorbs bursts of up to 262,144 packets or 512 MiB.
Writer transactions commit up to 8,192 packets at once or after one second,
whichever occurs first. Receiver sockets request a 64 MiB kernel buffer (the
effective value remains subject to the operating system maximum).

## Network guarantees

The backend preserves every packet it accepts into its process queue, subject
to memory allocation and storage availability. UDP itself has no
acknowledgement or retransmission, so senders must use sequence numbers plus an
acknowledged spool/replay protocol if end-to-end zero loss is mandatory.

## Backend configuration

### `[server]`

- `http_port`: TCP port used by the Mongoose HTTP/WebSocket listener.
- `web_root`: directory served for static browser assets.

### `[database]`

- `dir`: directory containing date-sharded SQLite files.
- `expand_all_fields`: compatibility switch. `1` expands every flattened JSON
  field; `0` uses compact selective indexing.
- `indexed_fields`: comma-separated leaf or full flattened names retained in
  `telemetry_rows`. Raw JSON remains complete regardless of this list.

### `[udp_channel_N]`

- `enabled`: enables socket creation for the channel.
- `name`: logical channel used for classification and diagnostics.
- `group_ip`: multicast group or unicast mode address.
- `port`: UDP listening port.
- `iface_ip`: local interface used for multicast membership; `0.0.0.0` lets
  the operating system select an interface.

### `[simulator]` and `[logging]`

The simulator section controls the HTTP simulation endpoint. Packet logging is
off by default because synchronous text output materially reduces ingest
capacity.

## Browser architecture

- `common.js` owns shared API helpers, canonical device naming, WebSocket
  reconnection, telemetry normalization, and chart utilities.
- `dashboard.js` combines status APIs, recent field rows, and WebSocket updates
  into summary cards and two synchronized timeline graphs.
- `hmi.js` owns device classification, live state, specialized instrument
  renderers, playback, alarm state, offline GPS plotting, and tactical target
  bearing visualization.
- `history.js` queries bounded historical ranges and controls replay.
- `topology.js` derives device/link status and schedules topology rendering.
- `device.js` renders a URL-selected device and its metrics.
- `chart-fallback.js` provides a minimal canvas chart when the external Chart.js
  dependency is unavailable.
- `style.css` is shared across pages. Later subsystem sections intentionally
  override earlier generic components through normal CSS cascade order.

## Build and verification

- `Makefile` is the strict Unix/WSL build entry point.
- `build.sh` performs compiler discovery and a portable Unix build.
- `build.ps1` selects GCC, Clang, or MSVC on Windows.
- `scripts/check_backend_policy.py` enforces source-level safety invariants.
- `scripts/smoke_backend.py` verifies UDP to SQLite to API/page behavior in an
  isolated temporary deployment.
- `scripts/load_backend.py` sends a finite paced workload and fails on receive,
  commit, drop, database-failure, or liveness mismatches.
- `scripts/udp_capture_tool.py` captures and replays UDP traffic without mixing
  test artifacts into normal operation.

## Platform behavior

Windows uses Winsock sockets, Windows mutex handles, `_mkdir`, and native
thread handles. Unix-like systems use POSIX sockets, pthread mutexes/threads,
and `mkdir`. Platform adapter macros and functions in `app.c` keep the ingest,
database, and HTTP logic platform-neutral.

## Third-party boundary

`mongoose.*`, `sqlite3.*`, and `cJSON.*` are externally maintained sources.
They are intentionally excluded from project commentary. Their public APIs are
described at first-party call sites where ownership or error behavior matters.
# Scalability and storage resilience

The UDP receive path publishes accepted JSON to the bounded WebSocket queue
before asynchronous persistence. SQLite failures, retries, and queue saturation
therefore do not stop live operator visibility. `/api/storage/status` is a
constant-time in-memory health endpoint used by the status banner on every page.

`[database] rotate_mb` (8192 MB by default) limits each active SQLite shard.
When the combined logical database/WAL size reaches the limit, the writer
commits and closes the shard, moves it to `Archive Data`, and immediately opens
`DD.MM.YYYY.partNNN.db`. Archived names remain available from `/api/db/list`
and can be queried by all existing history APIs. On restart, the writer resumes
the newest live shard for the current day.

## JSON-to-column validation (September 2026)

The storage schema was audited against 614,832 captured packets spanning all
11 canonical devices. Observed payload shapes range from 19 scalar fields for
ADVANTECH_IO to 168 for LCU_UNIT; CAMERA_UNIT has 96 reviewed fields. The
generated, checked-in `observed_telemetry_columns.inc` contains 701
device/field/type mappings (501 unique field names), with its evidence catalog
in `observed_telemetry_schema.json`.

The audit identified that compatibility aliasing replaced original field names:
for example `actual_current` became `current`, `dcbus_volt` became `voltage`,
and `drive_connected` became `connected`. Original values are now retained in
their own columns and aliases are added as derived projections. Reviewed nested
CAMERA, DRIVE, IMU, WCS, control, and tracking fields are created in their
device tables before live DML begins. Only genuinely unreviewed fields use
`telemetry_extra_fields`; older databases remain queryable through an automatic
extra-field fallback.

`WCS`, `WCS_CONTROL_CONSOLE`, and `WCS_CONSOLE` normalize to `WCS_CONSOLE` for
new storage and APIs. Historical discovery/status/history SQL maps old `WCS`
rows to that same identity, so no destructive historical rewrite is required.

The read-only audit can be repeated with `scripts/audit_storage_mapping.py`.
`scripts/generate_observed_schema.py` rebuilds the evidence catalog from packet
captures, and `scripts/test_observed_json_storage.py` sends one real captured
packet per device and compares every non-metadata scalar with its stored column.
