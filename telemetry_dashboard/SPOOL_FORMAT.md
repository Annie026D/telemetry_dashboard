# Telemetry recovery spool

The recovery spool is a bounded, append-only fallback for batches that cannot
be committed to SQLite after the configured retry policy. It is not a second
database.

## Record format

New segments begin with `TSP2`. Each record contains five native little-endian
32-bit unsigned integers: ingest-ID length, channel length, source-IP length,
JSON length, and source port. The stable ingest ID, channel, source IP, and JSON
bytes follow without terminators, followed by a CRC-32 covering the five
integers and all four strings. Legacy `TSP1` segments remain readable and get a
deterministic ID derived from filename and record position.

This first format is local to the producing host. Cross-endian transfer is not
supported. Lengths are validated against the application's fixed limits before
allocation during replay.

## Append and durability semantics

One failed database batch is written sequentially to a newly created `.tmp`
segment. The process flushes the C stream and calls `FlushFileBuffers` on
Windows or `fsync` on POSIX. Only after that succeeds is the file atomically
renamed to `.ready`. Incomplete `.tmp` files are never replayed. On POSIX, the
spool directory is also fsynced after the rename; Windows relies on the flushed
file handle plus same-directory rename semantics.

## Recovery and ordering

At startup and whenever the in-memory queue is empty, the writer selects the
lexicographically oldest `.ready` segment. It validates every record and CRC,
replays the complete segment as one SQLite transaction, and removes the segment
only after COMMIT succeeds. `telemetry.ingest_id` has a unique partial index;
replaying a committed segment skips each existing packet before any projection
writes. A segment that cannot be decoded is renamed with a `.corrupt` suffix
and requires operator inspection.

## Capacity behavior

`[spool] max_gb` defaults to 50 GB. Before creating a segment, the writer totals
all `.ready` segments and refuses an append that would exceed the limit. It
increments `spool_capacity_drops` and `packets_dropped` and emits a rate-limited
critical diagnostic. Memory queue limits remain unchanged.

The default `spool` directory is on the application's current volume. It helps
with transient SQLite failures but does not protect against complete disk
failure or exhaustion of that physical volume. Production deployments should
configure the directory on a dedicated reserved volume.
