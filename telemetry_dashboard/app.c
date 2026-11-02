/**
 * @file app.c
 * @brief Cross-platform UDP telemetry ingestion, persistence, and web service.
 *
 * The application receives configured UDP unicast or multicast streams,
 * extracts JSON payloads, classifies device data, stores packet and flattened
 * field records in daily SQLite databases, and publishes live telemetry through
 * Mongoose HTTP/WebSocket connections. It also implements the REST endpoints
 * used by the Dashboard, Device, HMI, History, Topology, and Diagnostics pages.
 *
 * Platform-specific socket, thread, mutex, time, and filesystem operations are
 * normalized near the beginning of this file so the processing code remains
 * shared between Windows and POSIX builds.
 *
 * Concurrency model:
 * - One receiver thread is started for every enabled UDP channel.
 * - Receiver threads enqueue accepted JSON without performing database writes.
 * - One ingest thread owns the SQLite writer connection and batch transaction.
 * - The main Mongoose event loop services HTTP/WebSocket clients and drains
 *   queued live updates.
 *
 * Data ownership:
 * - Queue nodes and copied JSON strings are heap-owned until consumed.
 * - The ingest mutex protects ingest queue state and persistence counters.
 * - The WebSocket mutex protects the live-update queue and delivery counters.
 * - The database mutex serializes writer state and protected database changes.
 */

/* Disable HTTP directory browsing so only explicitly requested files are served. */
#define MG_ENABLE_DIRECTORY_LISTING 0

/* POSIX feature-test macros must be defined before including system headers. */
#ifndef _WIN32

/* Request default GNU/BSD declarations when the build has not enabled them. */
#ifndef _DEFAULT_SOURCE

/* Expose commonly used Linux networking and system interfaces. */
#define _DEFAULT_SOURCE

#endif

/* Request the POSIX.1-2008 thread, socket, and time interfaces. */
#define _POSIX_C_SOURCE 200809L

#endif

/* Embedded HTTP and WebSocket server interface. */
#include "mongoose.h"

/* SQLite persistence API used for packet and field storage. */
#include "sqlite3.h"

/* JSON parsing, traversal, normalization, and serialization API. */
#include "cJSON.h"

#ifdef _WIN32

/* Windows socket types, constants, and Winsock functions. */
#include <winsock2.h>

/* Windows TCP/IP address conversion and multicast declarations. */
#include <ws2tcpip.h>

/* Windows threads, mutexes, timing, and general system types. */
#include <windows.h>

/* Windows directory creation interface. */
#include <direct.h>
/* Import the declarations required by the platform or telemetry subsystem used below. */
#include <sys/stat.h>

#else

/* POSIX IP address conversion and network-byte-order helpers. */
#include <arpa/inet.h>

/* POSIX directory enumeration used by database-list endpoints. */
#include <dirent.h>

/* IPv4 socket-address and multicast membership structures. */
#include <netinet/in.h>

/* POSIX thread and mutex interfaces. */
#include <pthread.h>

/* POSIX case-insensitive string comparison functions. */
#include <strings.h>

/* POSIX socket creation, binding, options, and data transfer. */
#include <sys/socket.h>

/* POSIX filesystem metadata and directory permissions. */
#include <sys/stat.h>
/* Import the declarations required by the platform or telemetry subsystem used below. */
#include <sys/statvfs.h>

/* System data types required by POSIX APIs. */
#include <sys/types.h>

/* POSIX descriptor, sleep, and general operating-system functions. */
#include <unistd.h>

#endif

/* Formatted I/O, files, and diagnostic logging. */
#include <stdio.h>

/* POSIX error reporting through errno. */
#include <errno.h>

/* Heap allocation, conversion, and process utilities. */
#include <stdlib.h>

/* Fixed-width integers for counters and timestamps. */
#include <stdint.h>

/* Portable Boolean type and constants. */
#include <stdbool.h>

/* Byte and case-sensitive string operations. */
#include <string.h>

/* Wall-clock time, calendar conversion, and timestamps. */
#include <time.h>

/* Character validation and case conversion. */
#include <ctype.h>

/* Variable-argument support for bounded formatting. */
#include <stdarg.h>

/* Implementation-defined integer and character limits. */
#include <limits.h>

#ifdef _WIN32
#include <io.h>
#else
#include <fcntl.h>
#endif

#ifdef _WIN32

/* Map the portable socket-close operation to Winsock. */
#define CLOSESOCKET closesocket

/* Read the most recent Winsock error code. */
#define GET_SOCKET_ERROR() WSAGetLastError()

/* Map full case-insensitive string comparison to the Windows API. */
#define STRICMP _stricmp

/* Map length-limited case-insensitive comparison to the Windows API. */
#define STRNICMP _strnicmp

/* Declare Windows thread entry points with the required calling convention. */
#define THREAD_RET DWORD WINAPI
/* Standard successful return value from a Windows thread. */
#define THREAD_RETURN 0
typedef SOCKET sock_t;
typedef int platform_socklen_t;   
typedef HANDLE platform_mutex_t;
typedef DWORD (WINAPI *platform_thread_fn)(void *);
#else
/* Normalize the invalid POSIX descriptor to the socket abstraction. */
#define INVALID_SOCKET (-1)
/* Normalize the POSIX socket failure return value. */
#define SOCKET_ERROR (-1)
/* Map the portable socket-close operation to POSIX close(). */
#define CLOSESOCKET close
/* Read the most recent POSIX system/library error code. */
#define GET_SOCKET_ERROR() errno
/* Map full case-insensitive comparison to the POSIX API. */
#define STRICMP strcasecmp
/* Map length-limited case-insensitive comparison to the POSIX API. */
#define STRNICMP strncasecmp
/* Use the return type required by pthread_create(). */
#define THREAD_RET void *
/* Standard successful return value from a POSIX thread. */

#define THREAD_RETURN NULL
typedef int sock_t;
typedef socklen_t platform_socklen_t;
typedef pthread_mutex_t platform_mutex_t;
typedef void *(*platform_thread_fn)(void *);
#endif

/* Route directory creation through the cross-platform wrapper. */
#define MKDIR(p) platform_mkdir(p)
/* Maximum received JSON payload buffer, including its terminator. */
#define MAX_JSON 65536
/* Maximum number of UDP channel sections accepted from config.ini. */
#define MAX_CHANNELS 16
/* Maximum scalar fields produced while flattening one JSON packet. */
#define MAX_FLAT 4096
/* Maximum data age classified as online. */
#define DEVICE_ONLINE_SEC   15
/* Maximum data age classified as stale before becoming offline. */
#define DEVICE_WARNING_SEC  30
/* Fixed binary header length preceding supported LCU JSON payloads. */
#define LCU_HEADER_LEN 24
/* Commit after this many packet inserts to amortize SQLite overhead. */
#define WRITER_BATCH_MAX_PACKETS_DEFAULT 8192
/* Commit a partial batch after this delay to bound visibility latency. */
#define WRITER_BATCH_MAX_MS_DEFAULT 1000U
/* Internal first stage used to stringify a fully expanded macro value. */
#define STRINGIFY_VALUE_INNER(v) #v
/* Convert a macro's expanded value to a compile-time string literal. */
#define STRINGIFY_VALUE(v) STRINGIFY_VALUE_INNER(v)
/* Mongoose event manager that owns HTTP listeners and active connections. */
struct mg_mgr mgr;

/* ======================== Core data structures ======================== */

/** @brief Runtime configuration for one UDP unicast or multicast receiver. */
typedef struct {
    int enabled;
    char name[64];
    char group_ip[64];
    char iface_ip[64];
    int port;
} udp_channel_t;

/** @brief Normalized scalar field extracted from a nested JSON telemetry packet. */
typedef struct {
    char key[128];
    char col[128];
    char type[16];
    double num;
    char text[512];
} flat_t;

/** @brief Canonical packet representation used by persistence and live processing. */
typedef struct {
    char session_id[64];
    char ts[64];
    char server_rx_ts[64];
    char device_ts[64];
    char packet_ts[64];
    double latency_ms;
    char channel[64];
    char device[128];
    char subdevice[128];
    char process[128];
    char subprocess[128];
    char reason[256];
    int anomaly;
    flat_t flat[MAX_FLAT];
    int count;
} record_t;

/** @brief Cached last-known state for one device control or status field. */
typedef struct {
    char device[128];
    char key[128];
    int state;
    int toggle_count;
    char last_used[128];
} state_cache_entry_t;

#define STATE_CACHE_MAX 2048

/* ================= Runtime configuration and shared state ============== */

static char g_http_port[32] = "8080";
static char g_web_root[256] = "web";
static char g_db_dir[256] = "data";
static char g_archive_dir[256] = "data/Archive Data";
static char g_app_dir[1024] = "";
static char g_config_path[1024] = "";
static uint64_t g_db_rotate_bytes = 8ULL * 1024ULL * 1024ULL * 1024ULL;
static uint64_t g_writer_batch_max_packets = WRITER_BATCH_MAX_PACKETS_DEFAULT;
static uint64_t g_writer_batch_max_ms = WRITER_BATCH_MAX_MS_DEFAULT;
static int g_udp_receive_buffer_bytes = 64 * 1024 * 1024;
static uint64_t g_daily_db_rotations = 0U;
static char g_session_id[64] = "SESSION";
static int g_simulator_enabled = 0;
static int g_udp_packet_log_enabled = 0;
static int g_expand_all_fields = 0;
static char g_indexed_fields[2048] =
    "latitude,lat,longitude,lon,lng,altitude,alt,"
    "roll,pitch,yaw,pan,tilt,bearing,range,heading,speed,rpm,current,voltage,"
    "state,status,mode,health,alive,connected,tracking,"
    "anomaly,alarm,fault,error,temperature,pressure";

/* Receiver definitions are loaded once from config.ini before worker threads
 * start. A receiver reads its assigned entry but does not rewrite the list. */
static udp_channel_t g_channels[MAX_CHANNELS];
static int g_channel_count = 0;

/* Database state is shared only where ownership requires it. The ingest worker
 * performs normal writes; the mutex prevents startup, rotation, or shutdown
 * work from changing a handle while it is being used. */
static platform_mutex_t g_db_mutex;
static char g_initialized_schema_db[512] = "";
static FILE *g_udp_log_file = NULL;
static char g_udp_log_name[256] = "";
static int g_udp_log_since_flush = 0;
static sqlite3 *g_writer_db = NULL;
static sqlite3_stmt *g_writer_telemetry_stmt = NULL;
static sqlite3_stmt *g_writer_row_stmt = NULL;
static sqlite3_stmt *g_writer_registry_stmt = NULL;
static sqlite3_stmt *g_writer_ingest_lookup_stmt = NULL;
static char g_writer_db_name[128] = "";
static bool g_writer_transaction_open = false;
static int g_writer_batch_count = 0;
static uint64_t g_writer_batch_started_ms = 0U;
/* Ingestion stops accepting unsafe storage conditions before the filesystem is
 * completely full, leaving room for SQLite bookkeeping and operator recovery. */
#define STORAGE_MIN_FREE_BYTES (256ULL * 1024ULL * 1024ULL)
static state_cache_entry_t g_state_cache[STATE_CACHE_MAX];
static int g_state_cache_count = 0;

/** @brief Per-channel packet counters and most recent sender information. */
typedef struct {
    uint64_t received_packets;
    uint64_t accepted_packets;
    uint64_t rejected_packets;
    uint64_t last_received_ms;
    char last_udp_src[64];
    int last_udp_src_port;
} udp_stats_t;

/** @brief End-to-end packet-stage counters used to detect pipeline loss. */
typedef struct {
    uint64_t received;
    uint64_t valid_json;
    uint64_t malformed_json;
    uint64_t normalized;
    uint64_t stored;
    uint64_t rejected;
    uint64_t gui_delivered;
} pipeline_stats_t;

static pipeline_stats_t g_pipeline_stats;

/** @brief Heap-owned WebSocket message queued for main-loop delivery. */
typedef struct ws_msg {
    char *json;
    struct ws_msg *next;
} ws_msg_t;

/** @brief Heap-owned accepted packet queued for asynchronous persistence. */
typedef struct ingest_msg {
    char *json;
    size_t payload_bytes;
    char ingest_id[128];
    char channel[64];
    char source_ip[64];
    int source_port;
    uint64_t queued_ms;
    struct ingest_msg *next;
} ingest_msg_t;

static platform_mutex_t g_ws_mutex;
/* Receiver threads place complete live messages here. Only the Mongoose event
 * loop removes them and writes to browser connections, because those network
 * connections are not safe to use directly from receiver threads. */
static ws_msg_t *g_ws_head = NULL;
static ws_msg_t *g_ws_tail = NULL;
static int g_ws_queue_len = 0;
static uint64_t g_ws_delivered = 0U;
static uint64_t g_ws_dropped = 0U;
#define WS_QUEUE_MAX 32768

static platform_mutex_t g_ingest_mutex;
/* Serializes spool segment creation/replay bookkeeping across UDP and writer threads. */
static platform_mutex_t g_spool_mutex;
#define INGEST_QUEUE_LANES MAX_CHANNELS
/* Separate lanes prevent one busy UDP route from permanently starving other
 * devices. The ingest worker visits lanes fairly and stores packets in SQLite. */
static ingest_msg_t *g_ingest_heads[INGEST_QUEUE_LANES];
static ingest_msg_t *g_ingest_tails[INGEST_QUEUE_LANES];
static int g_ingest_lane_len[INGEST_QUEUE_LANES];
static unsigned int g_ingest_next_lane = 0U;
static int g_ingest_queue_len = 0;
static size_t g_ingest_queue_bytes = 0U;
static uint64_t g_ingest_backpressure_events = 0U;
static uint64_t g_ingest_dropped = 0U;
static uint64_t g_db_store_success = 0U;
static uint64_t g_db_store_pending = 0U;
static uint64_t g_db_store_failures = 0U;
static uint64_t g_db_store_retries = 0U;
static uint64_t g_emergency_log_packets = 0U;
static char g_db_last_error[256] = "";

/* Exact ingress/persistence accounting.  "Accepted" means framing accepted;
 * it does not imply queueing or durable storage. */
typedef struct {
    uint64_t received, accepted, parsed, queued, queue_overflow, parse_failed;
    uint64_t db_attempted, db_success, db_failed, retries;
    uint64_t spooled, replayed, dropped, spool_capacity_drops;
    uint64_t sequence_gaps, sequence_duplicates, sequence_out_of_order;
    uint64_t transactions_committed, max_queue_depth;
    uint64_t committed_latency_total_ms, committed_latency_max_ms;
} packet_accounting_t;
static packet_accounting_t g_packet_accounting;

static char g_spool_dir[512] = "spool";
static uint64_t g_spool_max_bytes = 50ULL * 1024ULL * 1024ULL * 1024ULL;
static uint64_t g_spool_serial = 0U;
static uint64_t g_spool_bytes = 0U;
static bool g_spool_ordering_active = false;
static uint64_t g_spool_writers = 0U;
static uint64_t g_last_capacity_warning_ms = 0U;
static uint64_t g_storage_checked_ms = 0U;
static bool g_storage_low_cached = false;
static bool g_ingest_worker_running = false;
static uint64_t g_ingest_worker_heartbeat_ms = 0U;
static bool g_writer_defer_commit = false;
static int g_last_db_rc = SQLITE_OK;
static uint64_t g_ingest_id_serial = 0U;
static volatile bool g_shutdown_requested = false;
typedef struct { char channel[64],source[64],field[32]; uint64_t last; bool seen; } sequence_state_t;
static sequence_state_t g_sequence_state[256];
static int g_sequence_state_count=0;

static void platform_mutex_lock(platform_mutex_t *m) {
#ifdef _WIN32
    WaitForSingleObject(*m, INFINITE);
#else
    pthread_mutex_lock(m);
#endif
}

static void platform_mutex_unlock(platform_mutex_t *m) {
#ifdef _WIN32
    ReleaseMutex(*m);
#else
    pthread_mutex_unlock(m);
#endif
}

static unsigned int ingest_lane_for_route(const char *channel) {
    unsigned int hash = 2166136261U;
    const unsigned char *p = (const unsigned char *)(channel ? channel : "");
    while (*p != '\0') { hash ^= (unsigned int)*p++; hash *= 16777619U; }
    return hash % INGEST_QUEUE_LANES;
}
/*
 * Wide telemetry table mode.
 *
 * One accepted UDP packet is stored as one row in telemetry.
 * Flattened JSON values become columns in the same row instead of creating
 * one telemetry_rows insert per field. This is much faster for high-rate UDP.
 */
#define TELEMETRY_DYNAMIC_COL_MAX 4096
#define TELEMETRY_INSERT_SQL_MAX 131072
#define TELEMETRY_INSERT_COLS_MAX 65536
#define TELEMETRY_INSERT_VALS_MAX 16384

static char g_known_telemetry_db[512] = "";
static char g_known_telemetry_cols[TELEMETRY_DYNAMIC_COL_MAX][128];
static int g_known_telemetry_col_count = 0;
/* Compact indexed projection used by device/history graphs. */
static int g_insert_telemetry_rows_enabled = 1;

static bool telemetry_known_column(const char *col) {
    int i;

    if ((col == NULL) || (col[0] == '\0')) {
        return false;
    }

    for (i = 0; i < g_known_telemetry_col_count; ++i) {
        if (STRICMP(g_known_telemetry_cols[i], col) == 0) {
            return true;
        }
    }

    return false;
}

static void telemetry_remember_column(const char *col) {
    if ((col == NULL) || (col[0] == '\0')) {
        return;
    }

    if (telemetry_known_column(col)) {
        return;
    }

    if (g_known_telemetry_col_count >= TELEMETRY_DYNAMIC_COL_MAX) {
        return;
    }

    snprintf(g_known_telemetry_cols[g_known_telemetry_col_count],
             sizeof(g_known_telemetry_cols[g_known_telemetry_col_count]),
             "%s",
             col);
    g_known_telemetry_col_count++;
}

static void telemetry_reset_column_cache_if_db_changed(sqlite3 *db) {
    const char *path;

    if (db == NULL) {
        return;
    }

    path = sqlite3_db_filename(db, "main");
    if (path == NULL) {
        path = "";
    }

    if (strcmp(g_known_telemetry_db, path) != 0) {
        snprintf(g_known_telemetry_db,
                 sizeof(g_known_telemetry_db),
                 "%s",
                 path);
        g_known_telemetry_col_count = 0;
    }
}

static bool telemetry_column_exists_db(sqlite3 *db,
                                       const char *table,
                                       const char *col) {
    sqlite3_stmt *st = NULL;
    bool exists = false;
    char sql[256];

    if ((db == NULL) || (table == NULL) || (col == NULL)) {
        return false;
    }

    snprintf(sql, sizeof(sql), "PRAGMA table_info(\"%s\")", table);

    if (sqlite3_prepare_v2(db, sql, -1, &st, NULL) != SQLITE_OK) {
        return false;
    }

    while (sqlite3_step(st) == SQLITE_ROW) {
        const unsigned char *name = sqlite3_column_text(st, 1);

        if ((name != NULL) && (STRICMP((const char *)name, col) == 0)) {
            exists = true;
            break;
        }
    }

    sqlite3_finalize(st);
    return exists;
}

static bool telemetry_valid_dynamic_column_name(const char *col) {
    const char *p;

    if ((col == NULL) || (col[0] == '\0')) {
        return false;
    }

    if (strlen(col) >= 120U) {
        return false;
    }

    for (p = col; *p != '\0'; ++p) {
        unsigned char ch = (unsigned char)*p;

        if (!(isalnum(ch) || (*p == '_'))) {
            return false;
        }
    }

    return true;
}

static bool telemetry_ensure_column(sqlite3 *db,
                                    const char *col,
                                    const char *type) {
    char sql[512];
    char *err = NULL;

    if ((db == NULL) || (col == NULL) || (type == NULL)) {
        return false;
    }

    if (!telemetry_valid_dynamic_column_name(col)) {
        return true;
    }

    telemetry_reset_column_cache_if_db_changed(db);

    if (telemetry_known_column(col)) {
        return true;
    }

    if (telemetry_column_exists_db(db, "telemetry", col)) {
        telemetry_remember_column(col);
        return true;
    }

    snprintf(sql,
             sizeof(sql),
             "ALTER TABLE telemetry ADD COLUMN \"%s\" %s",
             col,
             type);

    if (sqlite3_exec(db, sql, NULL, NULL, &err) != SQLITE_OK) {
        const char *msg = err != NULL ? err : "";

        /*
         * SQLite can report duplicate column if another earlier schema check
         * already added the column. Treat that as success and cache it.
         */
        if (strstr(msg, "duplicate column name") != NULL) {
            sqlite3_free(err);
            telemetry_remember_column(col);
            return true;
        }

        printf("dynamic column add failed for %s: %s\n", col, msg);
        sqlite3_free(err);
        return false;
    }

    telemetry_remember_column(col);
    return true;
}
/*
 * Ensure that a dynamically discovered JSON field exists as a physical
 * column in an arbitrary telemetry/device table.
 *
 * telemetry_ensure_column() only operates on the main telemetry table,
 * therefore device-specific tables need this separate helper.
 */
static bool safe_name(const char *s);


static bool ensure_table_column(sqlite3 *db,
                                const char *table,
                                const char *column,
                                const char *type) {
    char sql[768];
    char *err = NULL;

    if ((db == NULL) ||
        (table == NULL) ||
        (column == NULL) ||
        (type == NULL)) {
        return false;
    }

    if (!safe_name(table) ||
        !telemetry_valid_dynamic_column_name(column)) {
        return false;
    }

    if (telemetry_column_exists_db(db, table, column)) {
        return true;
    }

    snprintf(sql,
             sizeof(sql),
             "ALTER TABLE \"%s\" ADD COLUMN \"%s\" %s",
             table,
             column,
             type);

    if (sqlite3_exec(db, sql, NULL, NULL, &err) != SQLITE_OK) {
        const char *msg = err != NULL ? err : "";

        /*
         * Another schema operation may have created the column between
         * the existence check and ALTER TABLE.
         */
        if (strstr(msg, "duplicate column name") != NULL) {
            sqlite3_free(err);
            return true;
        }

        printf("dynamic column add failed: table=%s column=%s error=%s\n",
               table,
               column,
               msg);

        sqlite3_free(err);
        return false;
    }

    return true;
}



/*
 * JSON fields that collide with the structural columns of a database table
 * must not be inserted twice into the same INSERT statement.
 */
static bool is_reserved_device_table_column(const char *column) {
    static const char *reserved[] = {
        "id",
        "session_id",
        "timestamp",
        "server_rx_ts",
        "device_ts",
        "packet_ts",
        "latency_ms",
        "device_name",
        "channel_name",
        "source_ip",
        "source_port",
        "subdevice_name",
        "process_name",
        "subprocess_name",
        "anomaly",
        "reason",
        "raw_json",
        NULL
    };

    size_t i;

    if (column == NULL) {
        return true;
    }

    for (i = 0U; reserved[i] != NULL; ++i) {
        if (STRICMP(column, reserved[i]) == 0) {
            return true;
        }
    }

    return false;
}

static void today_db_name(char *out, size_t n);
static bool safe_name(const char *s);
static int platform_mkdir(const char *path);
static uint64_t platform_monotonic_ms(void);
static const char *canonical_field_name(const char *column);

typedef struct { const char *name; const char *type; unsigned int groups; } approved_column_t;
enum { SCHEMA_COMMON=1, SCHEMA_MOTION=2, SCHEMA_ORIENTATION=4,
       SCHEMA_TRACKING=8, SCHEMA_CONTROLS=16, SCHEMA_ALL=31 };
#define C SCHEMA_COMMON
#define M SCHEMA_MOTION
#define O SCHEMA_ORIENTATION
#define T SCHEMA_TRACKING
#define K SCHEMA_CONTROLS
static const approved_column_t g_approved_columns[] = {
 {"latitude","REAL",T},{"lat","REAL",T},{"longitude","REAL",T},{"lon","REAL",T},{"lng","REAL",T},
 {"altitude","REAL",T},{"alt","REAL",T},{"roll","REAL",O},{"pitch","REAL",O},{"yaw","REAL",O},
 {"heading","REAL",O},{"speed","REAL",M},{"rpm","REAL",M},{"current","REAL",M},{"voltage","REAL",M},
 {"temperature","REAL",O},{"pressure","REAL",O},{"azimuth","REAL",O},{"azimuth_deg","REAL",O},
 {"elevation","REAL",O|T|M},{"elevation_deg","REAL",O|T},{"range","REAL",M|T},{"range_m","REAL",M|T},
 {"bearing","REAL",M|T},{"bearing_deg","REAL",M|T},{"x","REAL",O|K},{"y","REAL",O|K},{"z","REAL",O|K},
 {"track_id","REAL",T},{"trackID","REAL",T},{"confidence","REAL",T},{"pan","REAL",M},{"tilt","REAL",M},
 {"raw_pan","REAL",M},{"raw_tilt","REAL",M},{"pan_angle","REAL",M},{"tilt_angle","REAL",M},
 {"pan_actual_deg","REAL",M},{"tilt_actual_deg","REAL",M},{"pos_deg","REAL",M},{"angle_feedback","REAL",M},
 {"actual_current","REAL",M},{"dcbus_volt","REAL",M},{"fault_raw","REAL",M},{"drive_connected","REAL",M},
 {"state","TEXT",C},{"status","TEXT",C},{"mode","TEXT",C},{"health","TEXT",C},{"alive","REAL",C},
 {"connected","REAL",C},{"tracking","REAL",T},{"anomaly_flag","REAL",C},{"alarm","TEXT",C},
 {"fault","TEXT",C},{"error","TEXT",C},{"button_state","REAL",K},{"toggle_count","REAL",K},
 {"axis_name","TEXT",K},{"source","TEXT",C},{"src","TEXT",C},{"target_bearing","REAL",T},
 {"target_range","REAL",T},{"target_elevation","REAL",T},{"device_epoch","REAL",C},{"t_epoch","REAL",C},
 {"t_usec","REAL",C},{"packet_counter","REAL",C},{"seq","REAL",C},{"sequence","REAL",C}
};
typedef struct { const char *device; const char *name; const char *type; } observed_column_t;
static const observed_column_t g_observed_columns[] = {
#include "observed_telemetry_columns.inc"
};
#undef C
#undef M
#undef O
#undef T
#undef K

static unsigned int device_schema_mask(const char *device) {
    if (device && (STRICMP(device,"JOYSTICK")==0 || STRICMP(device,"JOYSTICK_UNIT")==0 ||
                   STRICMP(device,"BUTTON_LED_UNIT")==0)) return SCHEMA_COMMON|SCHEMA_CONTROLS;
    if (device && STRICMP(device,"CAMERA_UNIT")==0) return SCHEMA_COMMON|SCHEMA_MOTION|SCHEMA_TRACKING;
    if (device && (STRICMP(device,"DRIVE_UNIT")==0 || STRICMP(device,"ADVANTECH_IO")==0))
        return SCHEMA_COMMON|SCHEMA_MOTION;
    if (device && STRICMP(device,"EXTERNAL_TRACK_UNIT")==0) return SCHEMA_COMMON|SCHEMA_TRACKING;
    if (device && STRICMP(device,"IMU_UNIT")==0)
        return SCHEMA_COMMON|SCHEMA_ORIENTATION|SCHEMA_TRACKING;
    return SCHEMA_ALL;
}

static void device_table_name(const char *device, char *out, size_t out_size) {
    static const char *known[]={"JOYSTICK","JOYSTICK_UNIT","BUTTON_LED_UNIT","CAMERA_UNIT","DRIVE_UNIT","EXTERNAL_TRACK_UNIT","ADVANTECH_IO","IMU_UNIT","CCE_GATEWAY","LCU_UNIT","MAIN_DISPLAY","WCS","WCS_CONSOLE","UNKNOWN_DEVICE"};
    const char *identity="UNKNOWN_DEVICE";
    const unsigned char *p;
    size_t i;
    size_t off;
    if ((out == NULL) || (out_size < 20U)) return;
    for(i=0U;i<sizeof(known)/sizeof(known[0]);++i) if(device&&STRICMP(device,known[i])==0){identity=known[i];break;}
    p=(const unsigned char *)identity;
    off = (size_t)snprintf(out, out_size, "telemetry_device_");
    while (*p && off + 1U < out_size) { out[off++] = (char)(isalnum(*p) ? tolower(*p) : '_'); ++p; }
    out[off] = '\0';
}

static bool device_approved_column(const char *device, const char *column) {
    size_t i;
    unsigned int mask = device_schema_mask(device);
    if (!telemetry_valid_dynamic_column_name(column)) return false;
    for (i=0U; i<sizeof(g_approved_columns)/sizeof(g_approved_columns[0]); ++i)
        if (strcmp(g_approved_columns[i].name,column)==0 &&
            (g_approved_columns[i].groups & mask)!=0U) return true;
    for (i=0U; i<sizeof(g_observed_columns)/sizeof(g_observed_columns[0]); ++i)
        if (STRICMP(g_observed_columns[i].device,device)==0 &&
            STRICMP(g_observed_columns[i].name,column)==0) return true;
    return false;
}

static bool base_approved_column(const char *device, const char *column) {
    size_t i;
    unsigned int mask = device_schema_mask(device);
    for (i=0U; i<sizeof(g_approved_columns)/sizeof(g_approved_columns[0]); ++i)
        if (STRICMP(g_approved_columns[i].name,column)==0)
            return (g_approved_columns[i].groups & mask)!=0U;
    return false;
}

static const char *observed_column_type(const char *device, const char *column) {
    size_t i;
    for(i=0U;i<sizeof(g_observed_columns)/sizeof(g_observed_columns[0]);++i)
        if(STRICMP(g_observed_columns[i].device,device)==0 &&
           STRICMP(g_observed_columns[i].name,column)==0) return g_observed_columns[i].type;
    return NULL;
}

static uint64_t storage_file_size(const char *path) {
#ifdef _WIN32
    struct _stat64 info;
    if ((path != NULL) && (_stat64(path, &info) == 0))
        return (uint64_t)info.st_size;
#else
    struct stat info;
    if ((path != NULL) && (stat(path, &info) == 0))
        return (uint64_t)info.st_size;
#endif
    return 0U;
}

static void storage_space_bytes(const char *path,uint64_t *free_bytes,uint64_t *total_bytes);

static uint64_t sqlite_logical_size(sqlite3 *db) {
    sqlite3_stmt *statement = NULL;
    uint64_t pages = 0U, page_size = 0U;
    if ((db != NULL) &&
        (sqlite3_prepare_v2(db, "PRAGMA page_count", -1, &statement, NULL) == SQLITE_OK) &&
        (sqlite3_step(statement) == SQLITE_ROW)) {
        pages = (uint64_t)sqlite3_column_int64(statement, 0);
    }
    sqlite3_finalize(statement);
    statement = NULL;
    if ((db != NULL) &&
        (sqlite3_prepare_v2(db, "PRAGMA page_size", -1, &statement, NULL) == SQLITE_OK) &&
        (sqlite3_step(statement) == SQLITE_ROW)) {
        page_size = (uint64_t)sqlite3_column_int64(statement, 0);
    }
    sqlite3_finalize(statement);
    return pages * page_size;
}

static bool storage_is_low_cached(void) {
    uint64_t now=platform_monotonic_ms();
    if(g_storage_checked_ms==0U||now<g_storage_checked_ms||now-g_storage_checked_ms>=1000U){
        uint64_t free_bytes=0U,total_bytes=0U;const char *test_low=getenv("TELEMETRY_TEST_DISK_LOW");
        storage_space_bytes(g_db_dir,&free_bytes,&total_bytes);if(test_low&&strcmp(test_low,"1")==0){total_bytes=1U;free_bytes=0U;}
        g_storage_low_cached=(total_bytes>0U)&&(free_bytes<STORAGE_MIN_FREE_BYTES);g_storage_checked_ms=now;
    }
    return g_storage_low_cached;
}

static void storage_space_bytes(const char *path, uint64_t *free_bytes,
                                uint64_t *total_bytes) {
    if (free_bytes != NULL) *free_bytes = 0U;
    if (total_bytes != NULL) *total_bytes = 0U;
#ifdef _WIN32
    {
        ULARGE_INTEGER available, total, unused;
        if (GetDiskFreeSpaceExA(path, &available, &total, &unused)) {
            if (free_bytes != NULL) *free_bytes = (uint64_t)available.QuadPart;
            if (total_bytes != NULL) *total_bytes = (uint64_t)total.QuadPart;
        }
    }
#else
    {
        struct statvfs info;
        if (statvfs(path, &info) == 0) {
            if (free_bytes != NULL)
                *free_bytes = (uint64_t)info.f_bavail * (uint64_t)info.f_frsize;
            if (total_bytes != NULL)
                *total_bytes = (uint64_t)info.f_blocks * (uint64_t)info.f_frsize;
        }
    }
#endif
}

/* Walk the original payload, independently of the bounded wide projection.
 * Prepared statements are reused for every leaf in this packet. */
static bool store_original_fields(sqlite3 *db, const record_t *r,
                                  const char *json, const char *source_ip,
                                  int source_port, sqlite3_int64 packet_id,
                                  const char *table) {
    sqlite3_stmt *walk = NULL, *extra = NULL, *mapping = NULL;
    bool ok = false;
    int rc = SQLITE_ERROR;
    const char *walk_sql =
        "WITH RECURSIVE fields(id,path,type,value) AS ("
        "SELECT id,'',type,value FROM json_tree(?1) WHERE parent IS NULL "
        "UNION ALL SELECT j.id,CASE WHEN f.path='' THEN CAST(j.key AS TEXT) "
        "ELSE f.path||'_'||j.key END,j.type,j.value "
        "FROM json_tree(?1) j JOIN fields f ON j.parent=f.id) "
        "SELECT f.path,f.type,f.value FROM fields f WHERE f.type NOT IN ('object','array') OR NOT EXISTS (SELECT 1 FROM json_tree(?1) j WHERE j.parent=f.id)";
    if (sqlite3_prepare_v2(db, walk_sql, -1, &walk, NULL) != SQLITE_OK ||
        sqlite3_prepare_v2(db,
          "INSERT INTO telemetry_extra_fields(packet_id,storage_table,device_name,channel_name,field_name,field_type,value_num,value_text,timestamp,source_ip,source_port,raw_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
          -1, &extra, NULL) != SQLITE_OK ||
        sqlite3_prepare_v2(db,
          "INSERT INTO telemetry_ip_field_map(source_ip,device_name,channel_name,field_name,field_type,first_seen,last_seen,sample_count,last_value_num,last_value_text,last_raw_json,source_port) VALUES(?,?,?,?,?,?,?,1,?,?,?,?) "
          "ON CONFLICT(source_ip,device_name,channel_name,field_name) DO UPDATE SET field_type=excluded.field_type,last_seen=excluded.last_seen,sample_count=sample_count+1,last_value_num=excluded.last_value_num,last_value_text=excluded.last_value_text,last_raw_json=excluded.last_raw_json,source_port=excluded.source_port",
          -1, &mapping, NULL) != SQLITE_OK) goto done;
    sqlite3_bind_text(walk, 1, json, -1, SQLITE_TRANSIENT);
    while ((rc = sqlite3_step(walk)) == SQLITE_ROW) {
        const char *path = (const char *)sqlite3_column_text(walk, 0);
        const char *type = (const char *)sqlite3_column_text(walk, 1);
        bool numeric = strcmp(type,"integer")==0 || strcmp(type,"real")==0 ||
                       strcmp(type,"true")==0 || strcmp(type,"false")==0;
        sqlite3_reset(extra); sqlite3_clear_bindings(extra);
        sqlite3_reset(mapping); sqlite3_clear_bindings(mapping);
        sqlite3_bind_int64(extra,1,packet_id);
        sqlite3_bind_text(extra,2,table,-1,SQLITE_TRANSIENT);
        sqlite3_bind_text(extra,3,r->device,-1,SQLITE_TRANSIENT);
        sqlite3_bind_text(extra,4,r->channel,-1,SQLITE_TRANSIENT);
        sqlite3_bind_text(extra,5,path,-1,SQLITE_TRANSIENT);
        sqlite3_bind_text(extra,6,numeric ? "num" : type,-1,SQLITE_TRANSIENT);
        sqlite3_bind_text(extra,9,r->ts,-1,SQLITE_TRANSIENT);
        sqlite3_bind_text(extra,10,source_ip ? source_ip : "",-1,SQLITE_TRANSIENT);
        sqlite3_bind_int(extra,11,source_port);
        sqlite3_bind_text(extra,12,json,-1,SQLITE_TRANSIENT);
        sqlite3_bind_text(mapping,1,source_ip ? source_ip : "",-1,SQLITE_TRANSIENT);
        sqlite3_bind_text(mapping,2,r->device,-1,SQLITE_TRANSIENT);
        sqlite3_bind_text(mapping,3,r->channel,-1,SQLITE_TRANSIENT);
        sqlite3_bind_text(mapping,4,path,-1,SQLITE_TRANSIENT);
        sqlite3_bind_text(mapping,5,numeric ? "num" : type,-1,SQLITE_TRANSIENT);
        sqlite3_bind_text(mapping,6,r->ts,-1,SQLITE_TRANSIENT);
        sqlite3_bind_text(mapping,7,r->ts,-1,SQLITE_TRANSIENT);
        if (numeric) {
            sqlite3_bind_value(extra,7,sqlite3_column_value(walk,2));
            sqlite3_bind_value(mapping,8,sqlite3_column_value(walk,2));
        } else {
            const char *value = strcmp(type,"null")==0 ? "null" :
                                (const char *)sqlite3_column_text(walk,2);
            sqlite3_bind_text(extra,8,value,-1,SQLITE_TRANSIENT);
            sqlite3_bind_text(mapping,9,value,-1,SQLITE_TRANSIENT);
        }
        sqlite3_bind_text(mapping,10,json,-1,SQLITE_TRANSIENT);
        sqlite3_bind_int(mapping,11,source_port);
        if (sqlite3_step(extra)!=SQLITE_DONE || sqlite3_step(mapping)!=SQLITE_DONE)
            goto done;
    }
    ok = rc == SQLITE_DONE;
done:
    sqlite3_finalize(walk); sqlite3_finalize(extra); sqlite3_finalize(mapping);
    return ok;
}

/* All schema objects are initialized before this live DML-only function runs. */
static bool store_device_packet(sqlite3 *db, const record_t *r,
                                const char *json, const char *source_ip,
                                int source_port, sqlite3_int64 *packet_id,
                                char *table, size_t table_size) {
    sqlite3_stmt *st = NULL;
    char sql[TELEMETRY_INSERT_SQL_MAX], cols[TELEMETRY_INSERT_COLS_MAX], vals[TELEMETRY_INSERT_VALS_MAX];
    int idx = 1;
    size_t i;
    device_table_name(r->device, table, table_size);
    /* Keep raw_json in the same position as its binding below. Omitting it
     * from this column list shifted every dynamic value one place to the
     * right (and silently left the final field NULL). */
    snprintf(cols,sizeof(cols),"session_id,timestamp,server_rx_ts,device_ts,packet_ts,latency_ms,device_name,channel_name,source_ip,source_port,subdevice_name,process_name,subprocess_name,anomaly,reason,raw_json");
    snprintf(vals,sizeof(vals),"?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?");
for(i=0U;i<(size_t)r->count;++i) {
    if (!device_approved_column(r->device, r->flat[i].col)) {
        continue;
    }

    if (is_reserved_device_table_column(r->flat[i].col)) {
        continue;
    }
        size_t a=strlen(cols),b=strlen(vals); snprintf(cols+a,sizeof(cols)-a,",\"%s\"",r->flat[i].col); snprintf(vals+b,sizeof(vals)-b,",?");
    }
    snprintf(sql,sizeof(sql),"INSERT INTO \"%s\"(%s) VALUES(%s)",table,cols,vals);
    if (sqlite3_prepare_v2(db, sql, -1, &st, NULL) != SQLITE_OK) return false;
    sqlite3_bind_text(st, idx++, r->session_id, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(st, idx++, r->ts, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(st, idx++, r->server_rx_ts, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(st, idx++, r->device_ts, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(st, idx++, r->packet_ts, -1, SQLITE_TRANSIENT);
    sqlite3_bind_double(st, idx++, r->latency_ms);
    sqlite3_bind_text(st, idx++, r->device, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(st, idx++, r->channel, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(st, idx++, source_ip ? source_ip : "", -1, SQLITE_TRANSIENT);
    sqlite3_bind_int(st, idx++, source_port);
    sqlite3_bind_text(st, idx++, r->subdevice, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(st, idx++, r->process, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(st, idx++, r->subprocess, -1, SQLITE_TRANSIENT);
    
sqlite3_bind_int(st, idx++, r->anomaly);
sqlite3_bind_text(st, idx++, r->reason, -1, SQLITE_TRANSIENT);

/* Preserve the original complete JSON packet in the device table. */
sqlite3_bind_text(
    st,
    idx++,
    json != NULL ? json : "{}",
    -1,
    SQLITE_TRANSIENT
);
 /* Preserve raw_json in both the normalized packet table and the device shard. */
for(i=0U;i<(size_t)r->count;++i) {
    if (!device_approved_column(r->device, r->flat[i].col)) {
        continue;
    }

    if (is_reserved_device_table_column(r->flat[i].col)) {
        continue;
    }
        if(strcmp(r->flat[i].type,"REAL")==0) sqlite3_bind_double(st,idx++,r->flat[i].num);
        else sqlite3_bind_text(st,idx++,r->flat[i].text,-1,SQLITE_TRANSIENT);
    }
    if (sqlite3_step(st) != SQLITE_DONE) { sqlite3_finalize(st); return false; }
    sqlite3_finalize(st);
    *packet_id = sqlite3_last_insert_rowid(db);
    return store_original_fields(db, r, json, source_ip, source_port,
                                 *packet_id, table);
}
/* A UDP burst may temporarily outrun SQLite, but an unbounded queue eventually
 * consumes all RAM and the operating system kills the complete HTTP server.
 * Bound both packet count and bytes. Producers pause at this boundary while
 * the kernel receive buffers absorb a short burst. */
#define INGEST_QUEUE_MAX 262144
#define INGEST_QUEUE_MAX_BYTES (512U * 1024U * 1024U)
#define API_QUERY_BUDGET_MS 2000U
static platform_mutex_t g_udp_mutex;
static udp_stats_t g_udp_stats[MAX_CHANNELS];
static uint64_t g_api_query_deadline_ms = 0U;

/* ===================== General utility functions ====================== */


/* Append formatted text without allowing the write cursor to leave the
 * destination object.  The returned cursor always names a valid byte in the
 * buffer, so callers can safely continue building a response after a
 * truncated field. */
/**
 * @brief Append formatted text to a bounded response buffer without overrunning it.
 * @param capacity Total capacity of the destination buffer.
 * @param offset Starting offset or current output position.
 * @param format printf-compatible format string.
 * @return Updated write offset, always clamped to a valid position within the destination buffer.
 */
static int append_format(char *out,
                         size_t capacity,
                         int offset,
                         const char *format,
                         ...) {
    int written;
    size_t available;
    va_list args;
    va_list measure_args;

    if ((out == NULL) || (format == NULL) || (capacity == 0U) ||
        (capacity > (size_t)INT_MAX) || (offset < 0) ||
        ((size_t)offset >= capacity)) {
        return offset;
    }

    available = capacity - (size_t)offset;
    va_start(args, format);
    va_copy(measure_args, args);
    written = vsnprintf(NULL, 0U, format, measure_args);
    va_end(measure_args);

    if (written < 0) {
        va_end(args);
        out[offset] = '\0';
        return offset;
    }

    /* Keep one byte in reserve for a closing JSON delimiter.  Reject an
     * entire field rather than emitting a syntactically invalid fragment. */
    if (((size_t)written + 1U) >= available) {
        va_end(args);
        return offset;
    }

    (void)vsnprintf(&out[offset], available, format, args);
    va_end(args);
    return offset + written;
}

/**
 * @brief Create a directory using the native Windows or POSIX API.
 * @param path Filesystem path to process.
 * @return Zero when the directory exists or is created successfully; otherwise a platform error result.
 */
static int platform_mkdir(const char *path) {
#ifdef _WIN32
    int rc = _mkdir(path);
#else
    int rc = mkdir(path, 0755);
#endif

    if (rc == 0) return 0;
    if (errno == EEXIST) return 0;
    return rc;
}

/**
 * @brief Move writable SQLite files off Windows-mounted DrvFS when running in WSL.
 *
 * SQLite WAL requires filesystem locking and shared-memory semantics that are
 * not reliably provided by WSL's /mnt/<drive> mounts. A relative `data`
 * directory inherits the current working directory, so checking only the
 * configured text misses the common case where the server is launched from
 * /mnt/c. Store databases on native ext4 instead while web assets and the
 * executable may remain on the Windows mount.
 */
static void configure_safe_wsl_database_directory(void) {
#ifndef _WIN32
    char cwd[512];
    char release[256];
    const char *home;
    FILE *release_file;
    bool is_wsl = false;
    bool is_drvfs = false;
    size_t nread;

    release_file = fopen("/proc/sys/kernel/osrelease", "r");
    if (release_file != NULL) {
        nread = fread(release, 1U, sizeof(release) - 1U, release_file);
        release[nread] = '\0';
        fclose(release_file);
        if ((strstr(release, "microsoft") != NULL) ||
            (strstr(release, "Microsoft") != NULL) ||
            (strstr(release, "WSL") != NULL)) {
            is_wsl = true;
        }
    }
    if (!is_wsl) return;

    if (strncmp(g_db_dir, "/mnt/", 5U) == 0) {
        is_drvfs = true;
    } else if ((g_db_dir[0] != '/') &&
               (getcwd(cwd, sizeof(cwd)) != NULL) &&
               (strncmp(cwd, "/mnt/", 5U) == 0)) {
        is_drvfs = true;
    }
    if (!is_drvfs) return;

    home = getenv("HOME");
    if ((home == NULL) || (home[0] != '/') ||
        (strlen(home) > (sizeof(g_db_dir) - 32U))) {
        printf("FATAL: WSL DrvFS SQLite storage is unsafe and HOME is invalid\n");
        exit(EXIT_FAILURE);
    }

    snprintf(g_db_dir, sizeof(g_db_dir), "%s/.telemetry-dashboard", home);
    if (platform_mkdir(g_db_dir) != 0) {
        printf("FATAL: cannot create native WSL storage directory %s\n",
               g_db_dir);
        exit(EXIT_FAILURE);
    }
    snprintf(g_db_dir,
             sizeof(g_db_dir),
             "%s/.telemetry-dashboard/data",
             home);
    if (platform_mkdir(g_db_dir) != 0) {
        printf("FATAL: cannot create native WSL database directory %s\n",
               g_db_dir);
        exit(EXIT_FAILURE);
    }

    printf("WSL safety: redirected SQLite from DrvFS to native storage: %s\n",
           g_db_dir);
#endif
}

/**
 * @brief Convert a timestamp to local calendar time using a thread-safe platform API.
 * @param t Source epoch timestamp.
 */
static void platform_localtime(const time_t *t, struct tm *out) {
    memset(out, 0, sizeof(*out));
#ifdef _WIN32
    localtime_s(out, t);
#else
    localtime_r(t, out);
#endif
}

/**
 * @brief Convert a timestamp to UTC calendar time using a thread-safe platform API.
 * @param t Source epoch timestamp.
 */
static void platform_gmtime(const time_t *t, struct tm *out) {
    memset(out, 0, sizeof(*out));
#ifdef _WIN32
    gmtime_s(out, t);
#else
    gmtime_r(t, out);
#endif
}

/**
 * @brief Convert a UTC calendar value to epoch time on the active platform.
 * @param tmv Calendar-time value to convert.
 * @return UTC epoch value produced by the platform conversion.
 */
static time_t platform_timegm(struct tm *tmv) {
#ifdef _WIN32
    return _mkgmtime(tmv);
#else
    return timegm(tmv);
#endif
}

/**
 * @brief Initialize a platform-neutral mutex.
 * @param m Platform mutex to initialize, destroy, acquire, or release.
 * @return Zero on successful initialization; nonzero on failure.
 */
static int platform_mutex_init(platform_mutex_t *m) {
#ifdef _WIN32
    *m = CreateMutex(NULL, FALSE, NULL);
    return (*m == NULL) ? -1 : 0;
#else
    return pthread_mutex_init(m, NULL);
#endif
}

/**
 * @brief Release resources owned by a platform-neutral mutex.
 * @param m Platform mutex to initialize, destroy, acquire, or release.
 */
static void platform_mutex_destroy(platform_mutex_t *m) {
#ifdef _WIN32
    if (*m != NULL) {
        CloseHandle(*m);
        *m = NULL;
    }
#else
    pthread_mutex_destroy(m);
#endif
}

/**
 * @brief Create and detach a platform-neutral worker thread.
 * @param fn Worker entry function.
 * @param arg Opaque argument passed to the worker.
 * @return Zero when the detached worker starts successfully; nonzero on failure.
 */
static int platform_thread_start(platform_thread_fn fn, void *arg) {
#ifdef _WIN32
    HANDLE th = CreateThread(NULL, 0, fn, arg, 0, NULL);

    if (th == NULL) {
        return -1;
    }

    CloseHandle(th);
    return 0;
#else
    pthread_t th;

    if (pthread_create(&th, NULL, fn, arg) != 0) {
        return -1;
    }

    pthread_detach(th);
    return 0;
#endif
}

/**
 * @brief Suspend the current thread for the requested number of milliseconds.
 * @param milliseconds Requested sleep duration in milliseconds.
 */
static void platform_sleep_ms(unsigned int milliseconds) {
#ifdef _WIN32
    Sleep(milliseconds);
#else
    usleep((useconds_t)milliseconds * 1000U);
#endif
}

static bool try_parse_double(const char *s, double *out);

static bool insert_record(const char *json,
                          const char *channel,
                          const char *src_ip,
                          int src_port,
                          const char *ingest_id);
static void enqueue_immediate_live_packet(const record_t *record,
                                          cJSON *root,
                                          const char *src_ip,
                                          int src_port);
static void record_db_store_failure(const char *message);
static bool commit_writer_batch_locked(bool force);
static bool parse_int_value(const char *text, int minimum, int maximum,
                            int *value);

static void lock_ingest_queue(void);

static void unlock_ingest_queue(void);

/**
 * @brief Acquire exclusive access to shared SQLite writer state.
 */
static void lock_db(void) {
#ifdef _WIN32
    WaitForSingleObject(g_db_mutex, INFINITE);
#else
    /* Acquire the protecting mutex before touching shared telemetry state so concurrent threads cannot corrupt it. */
    pthread_mutex_lock(&g_db_mutex);
#endif
}

/**
 * @brief Release exclusive access to shared SQLite writer state.
 */
static void unlock_db(void) {
#ifdef _WIN32
    ReleaseMutex(g_db_mutex);
#else
    /* Release the protecting mutex after the shared update so other telemetry threads can proceed. */
    pthread_mutex_unlock(&g_db_mutex);
#endif
}

/**
 * @brief Return monotonic milliseconds for intervals and timeout calculations.
 * @return Monotonic milliseconds suitable for elapsed-time comparisons.
 */
static uint64_t platform_monotonic_ms(void) {
#ifdef _WIN32
    return (uint64_t)GetTickCount64();
#else
    struct timespec ts;

    if (clock_gettime(CLOCK_MONOTONIC, &ts) != 0) return 0U;
    return ((uint64_t)ts.tv_sec * 1000U) +
           ((uint64_t)ts.tv_nsec / 1000000U);
#endif
}

/**
 * @brief Acquire the mutex protecting the WebSocket message queue.
 */
static void lock_ws_queue(void) {
#ifdef _WIN32
    WaitForSingleObject(g_ws_mutex, INFINITE);
#else
    /* Acquire the protecting mutex before touching shared telemetry state so concurrent threads cannot corrupt it. */
    pthread_mutex_lock(&g_ws_mutex);
#endif
}

/**
 * @brief Release the mutex protecting the WebSocket message queue.
 */
static void unlock_ws_queue(void) {
#ifdef _WIN32
    ReleaseMutex(g_ws_mutex);
#else
    /* Release the protecting mutex after the shared update so other telemetry threads can proceed. */
    pthread_mutex_unlock(&g_ws_mutex);
#endif
}

/**
 * @brief Acquire the mutex protecting per-channel UDP counters.
 */
static void lock_udp_stats(void) {
#ifdef _WIN32
    WaitForSingleObject(g_udp_mutex, INFINITE);
#else
    /* Acquire the protecting mutex before touching shared telemetry state so concurrent threads cannot corrupt it. */
    pthread_mutex_lock(&g_udp_mutex);
#endif
}

/**
 * @brief Release the mutex protecting per-channel UDP counters.
 */
static void unlock_udp_stats(void) {
#ifdef _WIN32
    ReleaseMutex(g_udp_mutex);
#else
    /* Release the protecting mutex after the shared update so other telemetry threads can proceed. */
    pthread_mutex_unlock(&g_udp_mutex);
#endif
}

/**
 * @brief Resolve a channel object to its stable statistics-array index.
 * @param ch Configured UDP channel instance.
 * @return Zero-based channel index, or `-1` when the channel is not registered.
 */
static int udp_channel_index(const udp_channel_t *ch) {
    int i;

    if (ch == NULL) return -1;

    for (i = 0; i < g_channel_count; ++i) {
        if (&g_channels[i] == ch) {
            return i;
        }
    }

    return -1;
}

/**
 * @brief Atomically update receive, accept, reject, and sender statistics for a channel.
 * @param ch Configured UDP channel instance.
 * @param received Number of received packets to add.
 * @param accepted Number of accepted packets to add.
 * @param rejected Number of rejected packets to add.
 * @param src_ip Textual source IPv4 address.
 * @param src_port Source UDP port in host byte order.
 * @param now_ms Current timestamp or monotonic time in milliseconds.
 */
static void update_udp_stats(const udp_channel_t *ch,
                             uint64_t received,
                             uint64_t accepted,
                             uint64_t rejected,
                             const char *src_ip,
                             int src_port,
                             uint64_t now_ms) {
    int idx = udp_channel_index(ch);

    if (idx < 0) return;

    lock_udp_stats();

    g_udp_stats[idx].received_packets += received;
    g_udp_stats[idx].accepted_packets += accepted;
    g_udp_stats[idx].rejected_packets += rejected;
    g_udp_stats[idx].last_received_ms = now_ms;
    if ((src_ip != NULL) && (src_ip[0] != '\0')) {
        snprintf(g_udp_stats[idx].last_udp_src,
                 sizeof(g_udp_stats[idx].last_udp_src),
                 "%s",
                 src_ip);
        g_udp_stats[idx].last_udp_src_port = src_port;
    }

    unlock_udp_stats();
}

static void update_pipeline_stats(uint64_t received, uint64_t valid_json,
                                  uint64_t malformed_json, uint64_t normalized,
                                  uint64_t stored, uint64_t rejected,
                                  uint64_t gui_delivered) {
    lock_udp_stats();
    g_pipeline_stats.received += received;
    g_pipeline_stats.valid_json += valid_json;
    g_pipeline_stats.malformed_json += malformed_json;
    g_pipeline_stats.normalized += normalized;
    g_pipeline_stats.stored += stored;
    g_pipeline_stats.rejected += rejected;
    g_pipeline_stats.gui_delivered += gui_delivered;
    unlock_udp_stats();
}

/**
 * @brief Copy UDP statistics into caller-owned storage under the statistics lock.
 * @param count Number of records, channels, or items involved in the operation.
 */
static void snapshot_udp_stats(udp_stats_t *out, int count) {
    if ((out == NULL) || (count <= 0)) return;

    lock_udp_stats();
    memcpy(out, g_udp_stats, (size_t)count * sizeof(udp_stats_t));
    unlock_udp_stats();
}

/**
 * @brief Count currently connected WebSocket clients.
 * @return Number of currently connected WebSocket clients.
 */
static int api_ws_client_count(void) {
    struct mg_connection *wc;
    int count = 0;

    for (wc = mgr.conns; wc != NULL; wc = wc->next) {
        if (wc->is_websocket) {
            count++;
        }
    }

    return count;
}

/**
 * @brief Format the current wall-clock time for database and API records.
 */
static void now_timestamp(char *out, size_t n) {
#ifdef _WIN32
    SYSTEMTIME st;

    GetSystemTime(&st);

    snprintf(out,
             n,
             "%04u-%02u-%02uT%02u:%02u:%02u.%03uZ",
             (unsigned int)st.wYear,
             (unsigned int)st.wMonth,
             (unsigned int)st.wDay,
             (unsigned int)st.wHour,
             (unsigned int)st.wMinute,
             (unsigned int)st.wSecond,
             (unsigned int)st.wMilliseconds);
#else
    struct timespec ts;
    struct tm tmv;

    clock_gettime(CLOCK_REALTIME, &ts);
    platform_gmtime(&ts.tv_sec, &tmv);

    snprintf(out,
             n,
             "%04u-%02u-%02uT%02u:%02u:%02u.%03uZ",
             (unsigned int)(tmv.tm_year + 1900),
             (unsigned int)(tmv.tm_mon + 1),
             (unsigned int)tmv.tm_mday,
             (unsigned int)tmv.tm_hour,
             (unsigned int)tmv.tm_min,
             (unsigned int)tmv.tm_sec,
             (unsigned int)(ts.tv_nsec / 1000000));
#endif
}

/**
 * @brief Construct the daily SQLite database filename for the current date.
 */
static void today_db_name(char *out, size_t n) {
    const char *test_date_file=getenv("TELEMETRY_TEST_DATE_FILE");
    if(test_date_file&&*test_date_file){
        FILE *f=fopen(test_date_file,"r"); char value[128];
        if(f){ if(fgets(value,sizeof(value),f)){size_t len=strcspn(value,"\r\n");value[len]='\0';if(safe_name(value)){snprintf(out,n,"%s",value);fclose(f);return;}} fclose(f); }
    }
    time_t t = time(NULL);
    struct tm tmv;

    platform_localtime(&t, &tmv);

    strftime(out, n, "%d.%m.%Y.db", &tmv);
}

/**
 * @brief Validate a database filename before using it in a filesystem path.
 * @param s Input string to process.
 */
static bool safe_name(const char *s) {
    const char *p;

    if ((s == NULL) || (*s == '\0')) {
        return false;
    }
    if (strstr(s, "..") != NULL) {
        return false;
    }

    for (p = s; *p != '\0'; ++p) {
        if (!(isalnum((unsigned char)*p) ||
              (*p == '.') ||
              (*p == '_') ||
              (*p == '-'))) {
            return false;
        }
    }

    return true;
}

/**
 * @brief Resolve a validated database filename within the configured database directory.
 */
static void make_db_path(const char *name, char *out, size_t n) {
    char dbn[128];

    if ((name != NULL) && (*name != '\0') && safe_name(name)) {
        snprintf(dbn, sizeof(dbn), "%s", name);
    } else if (g_writer_db_name[0] != '\0') {
        snprintf(dbn, sizeof(dbn), "%s", g_writer_db_name);
    } else {
        today_db_name(dbn, sizeof(dbn));
    }

    snprintf(out, n, "%s/%s", g_db_dir, dbn);

    /* Completed same-day shards retain their filename/API identity in Archive Data. */
    if (storage_file_size(out) == 0U) {
        char archived[1024];
        snprintf(archived, sizeof(archived), "%s/%s", g_archive_dir, dbn);
        if (storage_file_size(archived) > 0U) {
            size_t copy_len = strlen(archived);

            if (n == 0U) return;
            if (copy_len >= n) copy_len = n - 1U;
            memcpy(out, archived, copy_len);
            out[copy_len] = '\0';
        }
    }
}

static bool is_database_filename(const char *name) {
    const char *dot;
    if (name == NULL || name[0] == '\0') return false;
    dot = strrchr(name, '.');
    if (dot == NULL) return false;
    return STRICMP(dot, ".db") == 0 || STRICMP(dot, ".sqlite") == 0 ||
           STRICMP(dot, ".sqlite3") == 0;
}

/**
 * @brief Execute schema or pragma SQL and log any SQLite error.
 * @param sql SQL statement to execute.
 */
static void sql_exec(sqlite3 *db, const char *sql) {
    char *err = NULL;

    if (sqlite3_exec(db, sql, NULL, NULL, &err) != SQLITE_OK) {
        printf("SQL error: %s\n", err ? err : "unknown");
        sqlite3_free(err);
    }
}

/* API handlers execute on Mongoose's event-loop thread.  A full-table query
 * that runs indefinitely also prevents HTTP and WebSocket servicing. */
/**
 * @brief SQLite progress callback that cancels API queries exceeding their time budget.
 * @param unused Unused callback context required by the SQLite callback signature.
 * @return Nonzero when SQLite should interrupt the active API query; otherwise zero.
 */
static int api_query_timed_out(void *unused) {
    (void)unused;
    return (g_api_query_deadline_ms > 0U) &&
           (platform_monotonic_ms() >= g_api_query_deadline_ms);
}

/* ================= SQLite schema and writer lifecycle ================= */

/**
 * @brief Create required telemetry, state, event, and index objects if absent.
 */
static void init_db_schema(sqlite3 *db) {
    sql_exec(db,
    "CREATE TABLE IF NOT EXISTS telemetry("
    "id INTEGER PRIMARY KEY AUTOINCREMENT,"
    "ingest_id TEXT,"
    "session_id TEXT,"
    "timestamp TEXT,"
    "server_rx_ts TEXT,"
    "device_ts TEXT,"
    "packet_ts TEXT,"
    "latency_ms REAL,"
    "channel_name TEXT,"
    "source_ip TEXT,"
    "source_port INTEGER,"
    "device_name TEXT,"
    "subdevice_name TEXT,"
    "process_name TEXT,"
    "subprocess_name TEXT,"
    "anomaly INTEGER,"
    "reason TEXT,"
    "raw_json TEXT);"
    );
    /*
     * Permanent wide-table columns.
     * These are created once per daily DB, so common telemetry keys do not
     * require ALTER TABLE during the high-rate live run.
     */
    {
        static const struct {
            const char *name;
            const char *type;
        } cols[] = {
            {"latitude","REAL"},{"lat","REAL"},{"longitude","REAL"},
            {"lon","REAL"},{"lng","REAL"},{"altitude","REAL"},{"alt","REAL"},
            {"roll","REAL"},{"pitch","REAL"},{"yaw","REAL"},{"heading","REAL"},
            {"speed","REAL"},{"rpm","REAL"},{"current","REAL"},{"voltage","REAL"},
            {"temperature","REAL"},{"pressure","REAL"},{"azimuth","REAL"},
            {"azimuth_deg","REAL"},{"elevation","REAL"},{"elevation_deg","REAL"},
            {"range","REAL"},{"range_m","REAL"},{"bearing","REAL"},
            {"bearing_deg","REAL"},{"x","REAL"},{"y","REAL"},{"z","REAL"},
            {"track_id","REAL"},{"trackID","REAL"},{"confidence","REAL"},
            {"pan","REAL"},{"tilt","REAL"},{"raw_pan","REAL"},{"raw_tilt","REAL"},{"pan_angle","REAL"},
            {"tilt_angle","REAL"},{"pan_actual_deg","REAL"},
            {"tilt_actual_deg","REAL"},{"pos_deg","REAL"},
            {"angle_feedback","REAL"},{"actual_current","REAL"},
            {"dcbus_volt","REAL"},{"fault_raw","REAL"},
            {"drive_connected","REAL"},{"state","TEXT"},{"status","TEXT"},
            {"mode","TEXT"},{"health","TEXT"},{"alive","REAL"},
            {"connected","REAL"},{"tracking","REAL"},{"anomaly_flag","REAL"},
            {"alarm","TEXT"},{"fault","TEXT"},{"error","TEXT"},
            {"button_state","REAL"},{"toggle_count","REAL"},
            {"axis_name","TEXT"},{"source","TEXT"},{"src","TEXT"},
            {"target_bearing","REAL"},{"target_range","REAL"},
            {"target_elevation","REAL"},{"device_epoch","REAL"},
            {"t_epoch","REAL"},{"t_usec","REAL"},
            {"packet_counter","REAL"},{"seq","REAL"},{"sequence","REAL"}
        };
        size_t i;

        for (i = 0U; i < (sizeof(cols) / sizeof(cols[0])); ++i) {
            (void)telemetry_ensure_column(db, cols[i].name, cols[i].type);
        }
        (void)telemetry_ensure_column(db,"ingest_id","TEXT");
    }
sql_exec(db,
"CREATE TABLE IF NOT EXISTS telemetry_rows("
"id INTEGER PRIMARY KEY AUTOINCREMENT,"
"packet_id INTEGER,"
"session_id TEXT,"
"timestamp TEXT,"
"server_rx_ts TEXT,"
"device_ts TEXT,"
"packet_ts TEXT,"
"channel_name TEXT,"
"source_ip TEXT,"
"source_port INTEGER,"
"device_name TEXT,"
"subdevice_name TEXT,"
"process_name TEXT,"
"subprocess_name TEXT,"
"value_key TEXT,"
"value_type TEXT,"
"value_num REAL,"
"value_text TEXT,"
"anomaly INTEGER,"
"reason TEXT,"
"raw_json TEXT"
");"
);

/*
 * Existing databases created before the lossless telemetry change need
 * these columns as well.
 */
(void)telemetry_ensure_column(db, "packet_id", "INTEGER");
(void)telemetry_ensure_column(db, "server_rx_ts", "TEXT");
(void)telemetry_ensure_column(db, "device_ts", "TEXT");
(void)telemetry_ensure_column(db, "packet_ts", "TEXT");
(void)telemetry_ensure_column(db, "source_ip", "TEXT");
(void)telemetry_ensure_column(db, "source_port", "INTEGER");
(void)telemetry_ensure_column(db, "raw_json", "TEXT");
/* Migrate existing daily databases without destroying historical data. */
if (!telemetry_column_exists_db(db, "telemetry_rows", "source_ip"))
    sql_exec(db, "ALTER TABLE telemetry_rows ADD COLUMN source_ip TEXT");
if (!telemetry_column_exists_db(db, "telemetry_rows", "raw_json"))
    sql_exec(db, "ALTER TABLE telemetry_rows ADD COLUMN raw_json TEXT");
sql_exec(db,
"CREATE TABLE IF NOT EXISTS telemetry_extra_fields("
"id INTEGER PRIMARY KEY AUTOINCREMENT,"
"packet_id INTEGER NOT NULL,"
"storage_table TEXT NOT NULL,"
"device_name TEXT,"
"channel_name TEXT,"
"field_name TEXT NOT NULL,"
"field_type TEXT NOT NULL,"
"value_num REAL,"
"value_text TEXT,"
"timestamp TEXT NOT NULL,"
"source_ip TEXT,"
"source_port INTEGER,"
"raw_json TEXT"
");"
);
/*
 * Backward-compatible migration for databases created before
 * lossless telemetry storage was introduced.
 */
{
    const struct {
        const char *table;
        const char *column;
        const char *type;
    } migrate[] = {
        {"telemetry_rows", "packet_id", "INTEGER"},
        {"telemetry_rows", "server_rx_ts", "TEXT"},
        {"telemetry_rows", "device_ts", "TEXT"},
        {"telemetry_rows", "packet_ts", "TEXT"},
        {"telemetry_rows", "source_ip", "TEXT"},
        {"telemetry_rows", "source_port", "INTEGER"},
        {"telemetry_rows", "raw_json", "TEXT"},

        {"telemetry_extra_fields", "source_ip", "TEXT"},
        {"telemetry_extra_fields", "source_port", "INTEGER"},
        {"telemetry_extra_fields", "raw_json", "TEXT"}
    };

    size_t mi;

    for (mi = 0U;
         mi < sizeof(migrate) / sizeof(migrate[0]);
         ++mi) {

        (void)ensure_table_column(
            db,
            migrate[mi].table,
            migrate[mi].column,
            migrate[mi].type
        );
    }
}
/*
 * Upgrade databases created before lossless extra-field storage.
 */
(void)ensure_table_column(db,
                          "telemetry_extra_fields",
                          "source_ip",
                          "TEXT");

(void)ensure_table_column(db,
                          "telemetry_extra_fields",
                          "source_port",
                          "INTEGER");

(void)ensure_table_column(db,
                          "telemetry_extra_fields",
                          "raw_json",
                          "TEXT");
/* Migrate existing extra-field shards. */
if (!telemetry_column_exists_db(db, "telemetry_extra_fields", "source_ip"))
    sql_exec(db, "ALTER TABLE telemetry_extra_fields ADD COLUMN source_ip TEXT");
if (!telemetry_column_exists_db(db, "telemetry_extra_fields", "raw_json"))
    sql_exec(db, "ALTER TABLE telemetry_extra_fields ADD COLUMN raw_json TEXT");

/* Live SCADA state table. */
sql_exec(db,
"CREATE TABLE IF NOT EXISTS device_state("
"id INTEGER PRIMARY KEY AUTOINCREMENT,"
"device_name TEXT,"
"button_name TEXT,"
"button_state INTEGER,"
"toggle_count INTEGER DEFAULT 0,"
"last_used TEXT,"
"session_id TEXT,"
"alive INTEGER DEFAULT 1,"
"uptime_seconds INTEGER DEFAULT 0,"
"last_heartbeat TEXT,"
"raw_value TEXT,"
"created_at TEXT DEFAULT CURRENT_TIMESTAMP"
");");
sql_exec(db,
"CREATE TABLE IF NOT EXISTS device_storage_registry("
"device_name TEXT NOT NULL,channel_name TEXT NOT NULL,storage_table TEXT NOT NULL,"
"first_seen TEXT NOT NULL,last_seen TEXT NOT NULL,packet_count INTEGER NOT NULL DEFAULT 0,"
"PRIMARY KEY(device_name,channel_name));");
sql_exec(db,
"CREATE TABLE IF NOT EXISTS hmi_event_log("
"id INTEGER PRIMARY KEY AUTOINCREMENT,"
"timestamp TEXT,"
"device_name TEXT,"
"control_name TEXT,"
"previous_state INTEGER,"
"new_state INTEGER,"
"toggle_count INTEGER DEFAULT 0,"
"on_duration_ms INTEGER DEFAULT 0,"
"session_id TEXT,"
"event_type TEXT,"
"raw_value TEXT"
");");

sql_exec(db,
"CREATE INDEX IF NOT EXISTS idx_hmi_log_control "
"ON hmi_event_log(control_name);");

sql_exec(db,
"CREATE INDEX IF NOT EXISTS idx_hmi_log_time "
"ON hmi_event_log(timestamp);");

sql_exec(db,
"CREATE INDEX IF NOT EXISTS idx_device_state_device "
"ON device_state(device_name);");

    sql_exec(db,
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_telemetry_ingest_id "
    "ON telemetry(ingest_id) WHERE ingest_id IS NOT NULL;");
    sql_exec(db,
    "CREATE INDEX IF NOT EXISTS idx_telemetry_time "
    "ON telemetry(timestamp);");

sql_exec(db,
    "CREATE INDEX IF NOT EXISTS idx_telemetry_device_time ON telemetry(device_name,timestamp,id);"
    "CREATE INDEX IF NOT EXISTS idx_telemetry_device "
    "ON telemetry(device_name);");

sql_exec(db,
    "CREATE INDEX IF NOT EXISTS idx_telemetry_process "
    "ON telemetry(process_name);");
sql_exec(db,
    "CREATE INDEX IF NOT EXISTS idx_telemetry_channel_id "
    "ON telemetry(channel_name,id DESC);");
sql_exec(db,
    "CREATE INDEX IF NOT EXISTS idx_telemetry_row_lookup "
    "ON telemetry(timestamp,channel_name,device_name,id DESC);");
sql_exec(db,
"CREATE INDEX IF NOT EXISTS idx_rows_device_key_time "
"ON telemetry_rows(device_name,value_key,timestamp);");

sql_exec(db,
"CREATE INDEX IF NOT EXISTS idx_rows_timestamp "
"ON telemetry_rows(timestamp);");
sql_exec(db,
"CREATE INDEX IF NOT EXISTS idx_extra_packet "
"ON telemetry_extra_fields(packet_id);");
sql_exec(db,
"CREATE INDEX IF NOT EXISTS idx_extra_lookup "
"ON telemetry_extra_fields(device_name,field_name,timestamp);");
sql_exec(db,
"CREATE INDEX IF NOT EXISTS idx_rows_packet "
"ON telemetry_rows(packet_id);");

sql_exec(db,
"CREATE INDEX IF NOT EXISTS idx_rows_source "
"ON telemetry_rows(source_ip,source_port);");

sql_exec(db,
"CREATE INDEX IF NOT EXISTS idx_extra_source "
"ON telemetry_extra_fields(source_ip,source_port);");
sql_exec(db,
"CREATE INDEX IF NOT EXISTS idx_extra_ip_field "
"ON telemetry_extra_fields(source_ip,field_name,timestamp);");
sql_exec(db,
"CREATE INDEX IF NOT EXISTS idx_rows_ip_field "
"ON telemetry_rows(source_ip,value_key,timestamp);");
sql_exec(db,
"CREATE TABLE IF NOT EXISTS telemetry_ip_field_map("
"id INTEGER PRIMARY KEY AUTOINCREMENT,"
"source_ip TEXT NOT NULL,"
"device_name TEXT,"
"channel_name TEXT,"
"field_name TEXT NOT NULL,"
"field_type TEXT NOT NULL,"
"first_seen TEXT,"
"last_seen TEXT,"
"sample_count INTEGER NOT NULL DEFAULT 0,"
"last_value_num REAL,"
"last_value_text TEXT,"
"last_raw_json TEXT,"
"UNIQUE(source_ip,device_name,channel_name,field_name));");
sql_exec(db,
"CREATE INDEX IF NOT EXISTS idx_ip_field_map_ip "
"ON telemetry_ip_field_map(source_ip,field_name,last_seen);");
    (void)ensure_table_column(db,"telemetry_ip_field_map","source_port","INTEGER");
    {
        static const char *devices[]={"JOYSTICK_UNIT","BUTTON_LED_UNIT","CAMERA_UNIT","DRIVE_UNIT","EXTERNAL_TRACK_UNIT","ADVANTECH_IO","IMU_UNIT","CCE_GATEWAY","LCU_UNIT","MAIN_DISPLAY","WCS_CONSOLE","UNKNOWN_DEVICE"};
        size_t d,c;
        for(d=0U;d<sizeof(devices)/sizeof(devices[0]);++d){
            char table[192],ddl[TELEMETRY_INSERT_SQL_MAX]; size_t used;
            device_table_name(devices[d],table,sizeof(table));
            used=(size_t)snprintf(ddl,sizeof(ddl),"CREATE TABLE IF NOT EXISTS \"%s\"(id INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT,timestamp TEXT,server_rx_ts TEXT,device_ts TEXT,packet_ts TEXT,latency_ms REAL,device_name TEXT,channel_name TEXT,source_ip TEXT,source_port INTEGER,subdevice_name TEXT,process_name TEXT,subprocess_name TEXT,anomaly INTEGER,reason TEXT,raw_json TEXT",table);
            for(c=0U;c<sizeof(g_approved_columns)/sizeof(g_approved_columns[0]);++c){
                if(!base_approved_column(devices[d],g_approved_columns[c].name))continue;
                used+=(size_t)snprintf(ddl+used,sizeof(ddl)-used,",\"%s\" %s",g_approved_columns[c].name,g_approved_columns[c].type);
            }
            for(c=0U;c<sizeof(g_observed_columns)/sizeof(g_observed_columns[0]);++c){
                if(STRICMP(g_observed_columns[c].device,devices[d])!=0 ||
                   base_approved_column(devices[d],g_observed_columns[c].name))continue;
                used+=(size_t)snprintf(ddl+used,sizeof(ddl)-used,",\"%s\" %s",g_observed_columns[c].name,g_observed_columns[c].type);
            }
            snprintf(ddl+used,sizeof(ddl)-used,")"); sql_exec(db,ddl);
            for(c=0U;c<sizeof(g_observed_columns)/sizeof(g_observed_columns[0]);++c){
                if(STRICMP(g_observed_columns[c].device,devices[d])==0 &&
                   !base_approved_column(devices[d],g_observed_columns[c].name) &&
                   !telemetry_column_exists_db(db,table,g_observed_columns[c].name)){
                    snprintf(ddl,sizeof(ddl),"ALTER TABLE \"%s\" ADD COLUMN \"%s\" %s",
                             table,g_observed_columns[c].name,g_observed_columns[c].type);
                    sql_exec(db,ddl);
                }
            }
            snprintf(ddl,sizeof(ddl),"CREATE INDEX IF NOT EXISTS \"idx_%s_time\" ON \"%s\"(timestamp)",table,table);sql_exec(db,ddl);
            snprintf(ddl,sizeof(ddl),"CREATE INDEX IF NOT EXISTS \"idx_%s_channel_id\" ON \"%s\"(channel_name,id DESC)",table,table);sql_exec(db,ddl);
        }
    }
}

static bool verify_db_ready(sqlite3 *db) {
    static const char *required_tables[]={"telemetry","telemetry_rows","telemetry_extra_fields","telemetry_ip_field_map","device_state","device_storage_registry","hmi_event_log"};
    static const char *required_indexes[]={"idx_telemetry_time","idx_telemetry_channel_id","idx_telemetry_ingest_id","idx_rows_device_key_time","idx_extra_packet"};
    sqlite3_stmt *st=NULL;size_t i;bool ok=true;char mode[32]="";int sync=-1;
    if(db==NULL)return false;
    if (sqlite3_prepare_v2(db, "PRAGMA journal_mode", -1, &st, NULL) != SQLITE_OK ||
        sqlite3_step(st) != SQLITE_ROW) {
        ok = false;
    } else {
        const unsigned char *mode_text = sqlite3_column_text(st, 0);
        snprintf(mode, sizeof(mode), "%s",
                 mode_text != NULL ? (const char *)mode_text : "");
    }
    sqlite3_finalize(st);
    st = NULL;
    if (sqlite3_prepare_v2(db, "PRAGMA synchronous", -1, &st, NULL) != SQLITE_OK ||
        sqlite3_step(st) != SQLITE_ROW) {
        ok = false;
    } else {
        sync = sqlite3_column_int(st, 0);
    }
    sqlite3_finalize(st);
    st = NULL;
    if(STRICMP(mode,"wal")!=0 && STRICMP(mode,"delete")!=0)ok=false;
    if(sync<2)ok=false;
    for(i=0U;ok&&i<sizeof(required_tables)/sizeof(required_tables[0]);++i){if(sqlite3_prepare_v2(db,"SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",-1,&st,NULL)!=SQLITE_OK)ok=false;else{sqlite3_bind_text(st,1,required_tables[i],-1,SQLITE_STATIC);if(sqlite3_step(st)!=SQLITE_ROW)ok=false;}sqlite3_finalize(st);st=NULL;}
    for(i=0U;ok&&i<sizeof(required_indexes)/sizeof(required_indexes[0]);++i){if(sqlite3_prepare_v2(db,"SELECT 1 FROM sqlite_master WHERE type='index' AND name=?",-1,&st,NULL)!=SQLITE_OK)ok=false;else{sqlite3_bind_text(st,1,required_indexes[i],-1,SQLITE_STATIC);if(sqlite3_step(st)!=SQLITE_ROW)ok=false;}sqlite3_finalize(st);st=NULL;}
    if(ok && sqlite3_exec(db,"SAVEPOINT telemetry_verify; INSERT INTO telemetry(session_id,timestamp,raw_json) VALUES('__verify__','', '{}'); ROLLBACK TO telemetry_verify; RELEASE telemetry_verify;",NULL,NULL,NULL)!=SQLITE_OK)ok=false;
    if(!ok){g_last_db_rc=sqlite3_extended_errcode(db);fprintf(stderr,"database readiness verification failed: %s\n",sqlite3_errmsg(db));}
    return ok;
}

/**
 * @brief Open and configure a read-only or writable SQLite connection.
 * @param read_only When true, open the connection without write permission.
 * @param ensure_schema When true, create or update required schema objects.
 * @return Zero on success; `-1` when validation, path resolution, or SQLite opening fails.
 */
static int open_db_connection(const char *name,
                              sqlite3 **out,
                              bool read_only,
                              bool ensure_schema) {
    char path[512];
    int flags;

    if (out == NULL) return -1;

    *out = NULL;

    if (!read_only) {
        MKDIR(g_db_dir);
    }

    make_db_path(name, path, sizeof(path));

    flags = read_only
        ? SQLITE_OPEN_READONLY
        : (SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE);

    if (sqlite3_open_v2(path, out, flags, NULL) != SQLITE_OK) {
        printf("DB open failed: %s (%s)\n",
               path,
               (*out != NULL) ? sqlite3_errmsg(*out) : "unknown");
        if (*out != NULL) {
            sqlite3_close(*out);
            *out = NULL;
        }
        return -1;
    }

    sqlite3_busy_timeout(*out, read_only ? 2000 : 15000);

    if (read_only) {
        sql_exec(*out, "PRAGMA query_only=ON;");
    } else {
        sql_exec(*out, "PRAGMA temp_store=MEMORY;");
        sql_exec(*out, "PRAGMA cache_size=-64000;");

        if (ensure_schema && (strcmp(g_initialized_schema_db, path) != 0)) {
            /* WAL lets API readers and the ingest writer run together on a
             * native Linux filesystem.  Keep rollback journals for WSL DrvFS
             * mounts such as /mnt/c, where WAL shared-memory files can fail. */
            if (strncmp(path, "/mnt/", 5) == 0) {
                sql_exec(*out, "PRAGMA journal_mode=DELETE;");
            } else {
                sql_exec(*out, "PRAGMA journal_mode=WAL;");
            }
            sql_exec(*out, "PRAGMA synchronous=FULL;");
            sql_exec(*out, "PRAGMA wal_autocheckpoint=4000;");
            sql_exec(*out, "PRAGMA journal_size_limit=268435456;");
            init_db_schema(*out);

            if (!verify_db_ready(*out)) {
                sqlite3_close(*out); *out=NULL; return -1;
            }

            snprintf(g_initialized_schema_db,
                     sizeof(g_initialized_schema_db),
                     "%s",
                     path);
        }
    }

    return 0;
}

/**
 * @brief Open the selected database for writing and ensure its schema exists.
 * @return Zero on success; `-1` when the writable database cannot be opened.
 */
static int open_db(const char *name, sqlite3 **out) {
    return open_db_connection(name, out, false, true);
}

/**
 * @brief Open the selected database in read-only query mode.
 * @return Zero on success; `-1` when the read-only database cannot be opened.
 */
static int open_db_readonly(const char *name, sqlite3 **out) {
    return open_db_connection(name, out, true, false);
}

/**
 * @brief Move a committed writer batch from pending to successful counters.
 * @param count Number of records, channels, or items involved in the operation.
 */
static void mark_db_batch_committed_locked(uint64_t count) {
    if (count == 0U) return;

    lock_ingest_queue();
    if (g_db_store_pending >= count) {
        g_db_store_pending -= count;
    } else {
        g_db_store_pending = 0U;
    }
    g_db_store_success += count;
    g_packet_accounting.db_success += count;
    g_db_last_error[0] = '\0';
    unlock_ingest_queue();
}

/**
 * @brief Move a failed writer batch from pending to failure counters.
 * @param count Number of records, channels, or items involved in the operation.
 * @param message Diagnostic message retained for the latest failure.
 */
static void mark_db_batch_failed_locked(uint64_t count, const char *message) {
    if (count == 0U) return;

    lock_ingest_queue();
    if (g_db_store_pending >= count) {
        g_db_store_pending -= count;
    } else {
        g_db_store_pending = 0U;
    }
    g_db_store_failures += count;
    if ((message != NULL) && (message[0] != '\0')) {
        snprintf(g_db_last_error, sizeof(g_db_last_error), "%s", message);
    }
    unlock_ingest_queue();
}

/**
 * @brief Increment the count of inserted packets awaiting transaction commit.
 */
static void mark_db_packet_pending(void) {
    lock_ingest_queue();
    g_db_store_pending++;
    unlock_ingest_queue();
}

/**
 * @brief Finalize writer statements and close the writer connection with commit or rollback.
 * @param rollback When true, roll back the active batch instead of committing it.
 * @note Requires the database mutex to be held unless the function acquires it explicitly.
 */
/**
 * @brief Finalizes prepared statements, resolves the active transaction, and
 *        closes the shared SQLite writer connection.
 *
 * This function must be called while the lock protecting the global writer
 * state is held. If a transaction is active, it is either committed or rolled
 * back according to the rollback parameter. The corresponding batch counters
 * are then updated to record whether the pending database writes succeeded or
 * failed.
 *
 * Regardless of the transaction result, all writer-related global state is
 * reset before the function returns.
 *
 * @param rollback Set to true to roll back the active transaction; set to false
 *                 to commit it.
 *
 * @note The caller is responsible for holding the writer-state lock.
 * @note Any pending batch is marked as failed if COMMIT or ROLLBACK itself
 *       cannot be executed.
 */
static void close_writer_db_locked(bool rollback) {
    /* Preserve the batch size before resetting the global writer state. */
    int pending_batch_count = g_writer_batch_count;

    if (g_writer_db != NULL) {
        /*
         * Finalize prepared statements before closing the database connection.
         * sqlite3_finalize() also releases resources associated with each
         * compiled SQL statement.
         */
        if (g_writer_telemetry_stmt != NULL) {
            sqlite3_finalize(g_writer_telemetry_stmt);
            g_writer_telemetry_stmt = NULL;
        }

        if (g_writer_row_stmt != NULL) {
            sqlite3_finalize(g_writer_row_stmt);
            g_writer_row_stmt = NULL;
        }
        if(g_writer_registry_stmt!=NULL){sqlite3_finalize(g_writer_registry_stmt);g_writer_registry_stmt=NULL;}
        if(g_writer_ingest_lookup_stmt!=NULL){sqlite3_finalize(g_writer_ingest_lookup_stmt);g_writer_ingest_lookup_stmt=NULL;}

        /*
         * Resolve the active transaction before closing the connection.
         * A normal shutdown commits pending writes; an error-recovery path
         * requests a rollback.
         */
        if (g_writer_transaction_open) {
            const char *sql = rollback ? "ROLLBACK;" : "COMMIT;";

            if (sqlite3_exec(g_writer_db, sql, NULL, NULL, NULL) == SQLITE_OK) {
                if (rollback) {
                    /*
                     * Rolled-back records were not stored, so report the entire
                     * pending batch as failed.
                     */
                    mark_db_batch_failed_locked(
                        (uint64_t)pending_batch_count,
                        "writer transaction rolled back"
                    );
                } else {
                    /*
                     * A successful commit makes every record in the pending
                     * batch durable and eligible for committed-count metrics.
                     */
                    mark_db_batch_committed_locked(
                        (uint64_t)pending_batch_count
                    );
                }
            } else {
                /*
                 * Record the SQLite error before closing the connection, as
                 * sqlite3_errmsg() requires a valid database handle.
                 */
                printf(
                    "%s failed while closing writer: %s\n",
                    sql,
                    sqlite3_errmsg(g_writer_db)
                );

                /*
                 * Treat the pending batch as failed because its durable state
                 * cannot be confirmed after a transaction-resolution error.
                 */
                mark_db_batch_failed_locked(
                    (uint64_t)pending_batch_count,
                    rollback
                        ? "writer rollback failed"
                        : "writer close commit failed"
                );
            }
        }

        /* Release the SQLite writer connection after all statements finish. */
        sqlite3_close(g_writer_db);
    }

    /*
     * Restore the writer subsystem to its disconnected state. These resets are
     * performed even when no database was open or transaction resolution
     * failed, preventing stale state from affecting the next connection.
     */
    g_writer_db = NULL;
    g_writer_db_name[0] = '\0';
    g_writer_transaction_open = false;
    g_writer_batch_count = 0;
    g_writer_batch_started_ms = 0U;
}
/**
 * @brief Prepare and cache packet and flattened-field insert statements.
 * @note Requires the database mutex to be held unless the function acquires it explicitly.
 */
/**
 * @brief Prepares the reusable SQL statements used by the database-writer
 *        thread.
 *
 * The function prepares one statement for inserting complete telemetry packets
 * into the telemetry table and another for inserting flattened key/value
 * measurements into telemetry_rows. Existing prepared statements are reused,
 * preventing repeated SQL compilation for every received packet.
 *
 * This function must be called while the lock protecting the global writer
 * state is held.
 *
 * @param db Valid SQLite connection used by the persistent database writer.
 *
 * @return true when both writer statements are ready for use.
 * @return false when the database handle is NULL or SQLite cannot prepare
 *         either statement.
 *
 * @note Prepared statements are stored in global writer state and must be
 *       finalized by close_writer_db_locked().
 */
static bool __attribute__((unused)) prepare_writer_statements_locked(sqlite3 *db) {
    /*
     * Inserts one complete telemetry packet together with its transport,
     * timing, device-identification, anomaly, and original JSON information.
     *
     * Parameter positions must remain synchronized with the corresponding
     * sqlite3_bind_*() operations in the writer code.
     */
    const char *telemetry_sql =
        "INSERT INTO telemetry("
        "session_id,"
        "timestamp,"
        "server_rx_ts,"
        "device_ts,"
        "packet_ts,"
        "latency_ms,"
        "channel_name,"
        "source_ip,"
        "source_port,"
        "device_name,"
        "subdevice_name,"
        "process_name,"
        "subprocess_name,"
        "anomaly,"
        "reason,"
        "raw_json) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)";

    /*
     * Inserts one flattened telemetry measurement. Each row represents an
     * individual key/value field extracted from a complete telemetry packet.
     *
     * Numeric and textual values are stored separately so queries and graphing
     * operations can use the appropriate SQLite data representation.
     */
    const char *row_sql =
    "INSERT INTO telemetry_rows("
    "packet_id,"
    "session_id,"
    "timestamp,"
    "server_rx_ts,"
    "device_ts,"
    "packet_ts,"
    "channel_name,"
    "source_ip,"
    "source_port,"
    "device_name,"
    "subdevice_name,"
    "process_name,"
    "subprocess_name,"
    "value_key,"
    "value_type,"
    "value_num,"
    "value_text,"
    "anomaly,"
    "reason,"
    "raw_json)"
    "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)";

    /* A valid SQLite connection is required to compile SQL statements. */
    if (db == NULL) {
        return false;
    }

    /*
     * Prepare the packet-level insert only when it has not already been
     * prepared for the current writer connection.
     */
    if (g_writer_telemetry_stmt == NULL) {
        if (sqlite3_prepare_v2(
                db,
                telemetry_sql,
                -1,
                &g_writer_telemetry_stmt,
                NULL
            ) != SQLITE_OK) {
            printf(
                "telemetry prepare failed: %s\n",
                sqlite3_errmsg(db)
            );
            return false;
        }
    }

    /*
     * Prepare the flattened measurement insert only when no reusable statement
     * currently exists.
     */
    if (g_writer_row_stmt == NULL) {
        if (sqlite3_prepare_v2(
                db,
                row_sql,
                -1,
                &g_writer_row_stmt,
                NULL
            ) != SQLITE_OK) {
            printf(
                "telemetry_rows prepare failed: %s\n",
                sqlite3_errmsg(db)
            );
            return false;
        }
    }
    if(g_writer_registry_stmt==NULL&&sqlite3_prepare_v2(db,
       "INSERT INTO device_storage_registry(device_name,channel_name,storage_table,first_seen,last_seen,packet_count) VALUES(?,?,?,?,?,1) ON CONFLICT(device_name,channel_name) DO UPDATE SET last_seen=excluded.last_seen,packet_count=packet_count+1,storage_table=excluded.storage_table",
       -1,&g_writer_registry_stmt,NULL)!=SQLITE_OK)return false;
    if(g_writer_ingest_lookup_stmt==NULL&&sqlite3_prepare_v2(db,"SELECT 1 FROM telemetry WHERE ingest_id=? LIMIT 1",-1,&g_writer_ingest_lookup_stmt,NULL)!=SQLITE_OK)return false;

    /* Both prepared statements are now available to the writer. */
    return true;
}

/**
 * @brief Opens or reuses the persistent writer connection for today's database.
 *
 * The function determines the current daily database filename and compares it
 * with the database currently used by the writer. When the date has changed,
 * the old writer transaction is committed and its connection is closed before
 * the new daily database is opened.
 *
 * This function must be called while the lock protecting the global writer
 * state is held.
 *
 * @param out Receives the active SQLite writer connection. The value is set to
 *            NULL if a new database connection cannot be opened.
 *
 * @return 0 when the writer connection is available.
 * @return -1 when out is NULL or today's database cannot be opened.
 *
 * @note The returned connection is owned by the global writer subsystem. The
 *       caller must not close it directly.
 * @note Database rotation commits the active transaction by calling
 *       close_writer_db_locked(false).
 */
static int open_writer_db_locked(sqlite3 **out) {
    /* Holds the generated path or filename for the current daily database. */
    char today[128];

    /* The caller must provide storage for the resulting database handle. */
    if (out == NULL) {
        return -1;
    }

    /* Generate the database name associated with the current calendar date. */
    today_db_name(today, sizeof(today));

    /* Resume the newest live same-day shard after a restart instead of
     * recreating the archived base filename and splitting the active day. */
    if (g_writer_db == NULL) {
        char base_name[128];
        char base_path[1024];
        char candidate[128];
        char candidate_path[1024];
        size_t base_len = strlen(today) - 3U;
        unsigned int part = 2U;
        snprintf(base_name, sizeof(base_name), "%s", today);
        snprintf(base_path, sizeof(base_path), "%s/%s", g_db_dir, today);
        if (storage_file_size(base_path) == 0U) {
            for (;;) {
                snprintf(candidate, sizeof(candidate), "%.*s.part%03u.db",
                         (int)base_len, base_name, part++);
                snprintf(candidate_path, sizeof(candidate_path), "%s/%s",
                         g_db_dir, candidate);
                if (storage_file_size(candidate_path) == 0U) break;
                snprintf(today, sizeof(today), "%s", candidate);
            }
        }
    }

    /* Rotate a large same-day database into a numbered shard. Closing commits
     * and checkpoints it; rename is an atomic metadata operation on the same volume. */
    if ((g_writer_db != NULL) && (g_db_rotate_bytes > 0U)) {
        char active_path[1024];
        char wal_path[1100];
        uint64_t active_bytes;
        const char *part_marker = strstr(g_writer_db_name, ".part");
        size_t base_len = part_marker != NULL
            ? (size_t)(part_marker - g_writer_db_name)
            : strlen(today) - 3U;
        snprintf(active_path, sizeof(active_path), "%s/%s", g_db_dir, g_writer_db_name);
        snprintf(wal_path, sizeof(wal_path), "%s-wal", active_path);
        active_bytes = storage_file_size(active_path) + storage_file_size(wal_path);
        if (sqlite_logical_size(g_writer_db) > active_bytes) {
            active_bytes = sqlite_logical_size(g_writer_db);
        }
        if ((active_bytes >= g_db_rotate_bytes) &&
            (strncmp(g_writer_db_name, today, base_len) == 0)) {
            char old_name[128];
            char archive_path[1024];
            char next_name[128];
            unsigned int part = 2U;
            snprintf(old_name, sizeof(old_name), "%s", g_writer_db_name);
            do {
                char candidate_path[1024],candidate_archive[1024];
                snprintf(next_name,sizeof(next_name),"%.*s.part%03u.db",(int)base_len,old_name,part++);
                snprintf(candidate_path,sizeof(candidate_path),"%s/%s",g_db_dir,next_name);
                snprintf(candidate_archive,sizeof(candidate_archive),"%s/%s",g_archive_dir,next_name);
                if(storage_file_size(candidate_path)==0U&&storage_file_size(candidate_archive)==0U)break;
            } while(true);
            {
                sqlite3 *candidate = NULL;
                if ((open_db(next_name, &candidate) != 0) ||
                    !verify_db_ready(candidate)) {
                    if (candidate != NULL) sqlite3_close(candidate);
                    *out = NULL;
                    return -1;
                }
                sqlite3_close(candidate);
            }
            if (!commit_writer_batch_locked(true)) {
                *out = NULL;
                return -1;
            }
            { int log_frames=0,checkpointed=0;int rc=sqlite3_wal_checkpoint_v2(g_writer_db,NULL,SQLITE_CHECKPOINT_TRUNCATE,&log_frames,&checkpointed);
              if(rc!=SQLITE_OK || log_frames!=checkpointed){g_last_db_rc=rc;record_db_store_failure("database rotation WAL checkpoint failed");*out=NULL;return -1;} }
            close_writer_db_locked(false);
            MKDIR(g_archive_dir);
            snprintf(archive_path, sizeof(archive_path), "%s/%s", g_archive_dir, old_name);
            if (rename(active_path, archive_path) != 0) {
                record_db_store_failure("database rotation archive move failed");
                *out=NULL;return -1;
            }
            snprintf(today, sizeof(today), "%s", next_name);
            g_daily_db_rotations++;
        }
    }

    /*
     * Rotate the writer connection when the active database belongs to a
     * previous day. Passing false requests a final commit before closure.
     */
    if ((g_writer_db != NULL) &&
        (strncmp(g_writer_db_name, today, strlen(today) - 3U) != 0)) {
        sqlite3 *candidate=NULL;
        if ((open_db(today, &candidate) != 0) || !verify_db_ready(candidate)) {
            if (candidate != NULL) sqlite3_close(candidate);
            *out = NULL;
            return -1;
        }
        sqlite3_close(candidate);
        if(!commit_writer_batch_locked(true)){*out=NULL;return -1;}
        {int log_frames=0,checkpointed=0;int rc=sqlite3_wal_checkpoint_v2(g_writer_db,NULL,SQLITE_CHECKPOINT_TRUNCATE,&log_frames,&checkpointed);
         if(rc!=SQLITE_OK||log_frames!=checkpointed){g_last_db_rc=rc;record_db_store_failure("daily rotation WAL checkpoint failed");*out=NULL;return -1;}}
        close_writer_db_locked(false);
    }

    /*
     * Open today's database only when a reusable writer connection is not
     * already available.
     */
    if (g_writer_db == NULL) {
        /*
         * Cached device state belongs to the previous writer database and must
         * not be reused after opening or rotating the database.
         */
        g_state_cache_count = 0;

        if (open_db(today, &g_writer_db) != 0) {
            *out = NULL;
            return -1;
        }

        /*
         * Remember which daily database is associated with the persistent
         * connection so a later call can detect a date change.
         */
        snprintf(
            g_writer_db_name,
            sizeof(g_writer_db_name),
            "%s",
            today
        );

        if (!prepare_writer_statements_locked(g_writer_db)) {
            close_writer_db_locked(true);
            *out = NULL;
            return -1;
        }
    }

    /*
     * Return the shared writer connection without transferring its ownership
     * to the caller.
     */
    *out = g_writer_db;
    return 0;
}

/**
 * @brief Begin an immediate SQLite transaction for a new writer batch.
 * @return Zero when a transaction is active; `-1` if SQLite cannot begin it.
 * @note Requires the database mutex to be held unless the function acquires it explicitly.
 */
static int begin_writer_batch_locked(sqlite3 *db) {
    if (g_writer_transaction_open) return 0;

    if (sqlite3_exec(db,
                     "BEGIN IMMEDIATE TRANSACTION;",
                     NULL,
                     NULL,
                     NULL) != SQLITE_OK) {
        printf("BEGIN TRANSACTION FAILED: %s\n", sqlite3_errmsg(db));
        return -1;
    }

    g_writer_transaction_open = true;
    g_writer_batch_count = 0;
    g_writer_batch_started_ms = platform_monotonic_ms();
    return 0;
}

/**
 * @brief Commit the active batch when forced, full, or old enough.
 * @param force When true, commit an active batch without waiting for size or age limits.
 * @note Requires the database mutex to be held unless the function acquires it explicitly.
 */
static bool commit_writer_batch_locked(bool force) {
    uint64_t now_ms;
    bool old_enough;
    int pending_batch_count;

    if ((g_writer_db == NULL) || !g_writer_transaction_open) return true;

    now_ms = platform_monotonic_ms();
    old_enough =
        (g_writer_batch_started_ms == 0U) ||
        (now_ms < g_writer_batch_started_ms) ||
        ((now_ms - g_writer_batch_started_ms) >= g_writer_batch_max_ms);

    if (g_writer_defer_commit && !force) return true;

    if (!force &&
        (g_writer_batch_count < (int)g_writer_batch_max_packets) &&
        !old_enough) {
        return true;
    }

    pending_batch_count = g_writer_batch_count;

    {
        int rc = sqlite3_exec(g_writer_db, "COMMIT;", NULL, NULL, NULL);

        if (rc == SQLITE_BUSY || rc == SQLITE_LOCKED) {
            printf("COMMIT BUSY, will retry: %s\n",
                   sqlite3_errmsg(g_writer_db));
            g_last_db_rc = rc;
            return false;
        }

        if (rc != SQLITE_OK) {
            g_last_db_rc = rc;
            printf("COMMIT FAILED: %s\n", sqlite3_errmsg(g_writer_db));
            close_writer_db_locked(true);
            return false;
        }
    }

    mark_db_batch_committed_locked((uint64_t)pending_batch_count);
    lock_ingest_queue();g_packet_accounting.transactions_committed++;unlock_ingest_queue();
    g_writer_transaction_open = false;
    g_writer_batch_count = 0;
    g_writer_batch_started_ms = 0U;
    return true;
}

/**
 * @brief Request a protected writer commit check from the main event loop.
 * @param force When true, commit an active batch without waiting for size or age limits.
 */
static void flush_writer_batch(bool force) {
    lock_db();
    (void)commit_writer_batch_locked(force);
    unlock_db();
}

/**
 * @brief Convert an arbitrary JSON key into a safe normalized column/key name.
 * @param in Input text or byte sequence to process.
 */
static void clean_col(const char *in, char *out, size_t n) {
    size_t i;
    size_t j = 0;

    if (n == 0) return;

    if ((in == NULL) || (*in == '\0')) {
        snprintf(out, n, "json_value");
        return;
    }

    if (!isalpha((unsigned char)in[0]) && (in[0] != '_')) {
        out[j++] = 'j';
    }

    for (i = 0; (in[i] != '\0') && ((j + 1) < n); ++i) {
        char c = in[i];

        if (isalnum((unsigned char)c) || (c == '_')) {
            out[j++] = c;
        } else {
            out[j++] = '_';
        }
    }

    out[j] = '\0';
}

static const char *json_get_string(cJSON *root,
                                   const char *a,
                                   const char *b,
                                   const char *def) {
    cJSON *x = cJSON_GetObjectItemCaseSensitive(root, a);

    if (((x == NULL) || !cJSON_IsString(x)) && (b != NULL)) {
        x = cJSON_GetObjectItemCaseSensitive(root, b);
    }

    if ((x != NULL) && cJSON_IsString(x) && (x->valuestring != NULL)) {
        return x->valuestring;
    }

    return def;
}

/**
 * @brief Convert a JSON Boolean or numeric flag to an integer Boolean.
 * @return One for a true/nonzero JSON value; otherwise zero.
 */
static int json_get_boolint(cJSON *root, const char *key) {
    cJSON *x = cJSON_GetObjectItemCaseSensitive(root, key);

    if (x == NULL) return 0;

    if (cJSON_IsBool(x)) return cJSON_IsTrue(x) ? 1 : 0;
    if (cJSON_IsNumber(x)) return (x->valuedouble != 0.0) ? 1 : 0;

    if (cJSON_IsString(x) && (x->valuestring != NULL)) {
        if ((strcmp(x->valuestring, "1") == 0) ||
            (STRICMP(x->valuestring, "true") == 0) ||
            (STRICMP(x->valuestring, "yes") == 0)) {
            return 1;
        }
    }

    return 0;
}

static const char *json_find_string_deep(cJSON *obj,
                                         const char *a,
                                         const char *b) {
    cJSON *it = NULL;
    const char *found = NULL;

    if ((obj == NULL) || (!cJSON_IsObject(obj) && !cJSON_IsArray(obj))) return "";

    if (cJSON_IsObject(obj)) {
        it = cJSON_GetObjectItemCaseSensitive(obj, a);
        if ((it != NULL) && cJSON_IsString(it) && (it->valuestring != NULL)) {
            return it->valuestring;
        }

        if (b != NULL) {
            it = cJSON_GetObjectItemCaseSensitive(obj, b);
            if ((it != NULL) && cJSON_IsString(it) && (it->valuestring != NULL)) {
                return it->valuestring;
            }
        }
    }

    cJSON_ArrayForEach(it, obj) {
        if (cJSON_IsObject(it) || cJSON_IsArray(it)) {
            found = json_find_string_deep(it, a, b);
            if ((found != NULL) && (found[0] != '\0')) return found;
        }
    }

    return "";
}

static cJSON *json_find_item_deep(cJSON *obj, const char *key) {
    cJSON *it = NULL;
    cJSON *found = NULL;

    if ((obj == NULL) || (key == NULL) ||
        (!cJSON_IsObject(obj) && !cJSON_IsArray(obj))) return NULL;

    if (cJSON_IsObject(obj)) {
        it = cJSON_GetObjectItemCaseSensitive(obj, key);
        if (it != NULL) return it;
    }

    cJSON_ArrayForEach(it, obj) {
        if (cJSON_IsObject(it) || cJSON_IsArray(it)) {
            found = json_find_item_deep(it, key);
            if (found != NULL) return found;
        }
    }

    return NULL;
}

static void observe_packet_sequence(cJSON *root,const char *channel,const char *source) {
    static const char *fields[]={"seq","sequence","packet_counter"};
    cJSON *item=NULL;const char *field=NULL;uint64_t value;int i;
    for(i=0;i<3;++i){item=json_find_item_deep(root,fields[i]);if(cJSON_IsNumber(item)&&item->valuedouble>=0.0){field=fields[i];break;}}
    if (field == NULL) return;
    value = (uint64_t)item->valuedouble;
    for(i=0;i<g_sequence_state_count;++i)if(strcmp(g_sequence_state[i].channel,channel?channel:"")==0&&strcmp(g_sequence_state[i].source,source?source:"")==0&&strcmp(g_sequence_state[i].field,field)==0)break;
    if(i==g_sequence_state_count){if(i>=256)return;memset(&g_sequence_state[i],0,sizeof(g_sequence_state[i]));snprintf(g_sequence_state[i].channel,sizeof(g_sequence_state[i].channel),"%s",channel?channel:"");snprintf(g_sequence_state[i].source,sizeof(g_sequence_state[i].source),"%s",source?source:"");snprintf(g_sequence_state[i].field,sizeof(g_sequence_state[i].field),"%s",field);g_sequence_state_count++;}
    if(g_sequence_state[i].seen){lock_ingest_queue();if(value==g_sequence_state[i].last)g_packet_accounting.sequence_duplicates++;else if(value<g_sequence_state[i].last)g_packet_accounting.sequence_out_of_order++;else if(value>g_sequence_state[i].last+1U)g_packet_accounting.sequence_gaps+=value-g_sequence_state[i].last-1U;unlock_ingest_queue();}
    if(!g_sequence_state[i].seen||value>g_sequence_state[i].last){g_sequence_state[i].last=value;g_sequence_state[i].seen=true;}
}

/**
 * @brief Format an epoch-millisecond value as an ISO-style timestamp.
 * @param epoch_ms Epoch timestamp expressed in milliseconds.
 */
static void format_epoch_ms_iso(double epoch_ms, char *out, size_t n) {
    time_t seconds;
    struct tm tmv;
    unsigned int millis;

    if ((out == NULL) || (n == 0U) || (epoch_ms <= 0.0)) return;

    seconds = (time_t)(epoch_ms / 1000.0);
    millis = (unsigned int)((uint64_t)epoch_ms % 1000U);
    platform_gmtime(&seconds, &tmv);

    snprintf(out,
             n,
             "%04u-%02u-%02uT%02u:%02u:%02u.%03uZ",
             (unsigned int)(tmv.tm_year + 1900),
             (unsigned int)(tmv.tm_mon + 1),
             (unsigned int)tmv.tm_mday,
             (unsigned int)tmv.tm_hour,
             (unsigned int)tmv.tm_min,
             (unsigned int)tmv.tm_sec,
             millis);
}

/**
 * @brief Parse a wire-format timestamp into epoch milliseconds.
 * @param value Input value to parse or normalize.
 * @param epoch_ms Epoch timestamp expressed in milliseconds.
 */
static bool parse_wire_timestamp_ms(const char *value, double *epoch_ms) {
    struct tm tmv;
    int year, mon, day, hour, min, sec;
    double numeric;
    char separator;
    const char *fraction;
    double millis = 0.0;
    time_t parsed;

    if ((value == NULL) || (value[0] == '\0') || (epoch_ms == NULL)) {
        return false;
    }

    if (try_parse_double(value, &numeric)) {
        *epoch_ms = numeric > 100000000000.0 ? numeric : numeric * 1000.0;
        return *epoch_ms > 0.0;
    }

    if (sscanf(value,
               "%d-%d-%d%c%d:%d:%d",
               &year,
               &mon,
               &day,
               &separator,
               &hour,
               &min,
               &sec) != 7 ||
        ((separator != 'T') && (separator != ' '))) {
        return false;
    }

    memset(&tmv, 0, sizeof(tmv));
    tmv.tm_year = year - 1900;
    tmv.tm_mon = mon - 1;
    tmv.tm_mday = day;
    tmv.tm_hour = hour;
    tmv.tm_min = min;
    tmv.tm_sec = sec;
    tmv.tm_isdst = -1;

    parsed = (strchr(value, 'Z') != NULL) ? timegm(&tmv) : mktime(&tmv);
    if (parsed <= 0) return false;

    fraction = strchr(value, '.');
    if (fraction != NULL) {
        millis = strtod(fraction, NULL) * 1000.0;
    }

    *epoch_ms = ((double)parsed * 1000.0) + millis;
    return true;
}

/**
 * @brief Extract and normalize the best available device timestamp from a packet.
 * @param epoch_ms Epoch timestamp expressed in milliseconds.
 */
static bool extract_device_timestamp(cJSON *root,
                                     char *out,
                                     size_t n,
                                     double *epoch_ms) {
    static const char *string_keys[] = {
        "device_ts", "device_tc", "timestamp", "packet_ts", "packet_time", NULL
    };
    int i;
    cJSON *item;

    if ((root == NULL) || (out == NULL) || (n == 0U)) return false;
    out[0] = '\0';
    if (epoch_ms != NULL) *epoch_ms = 0.0;

    for (i = 0; string_keys[i] != NULL; ++i) {
        item = json_find_item_deep(root, string_keys[i]);
        if (cJSON_IsString(item) && (item->valuestring != NULL) &&
            (item->valuestring[0] != '\0')) {
            snprintf(out, n, "%s", item->valuestring);
            if (epoch_ms != NULL) {
                (void)parse_wire_timestamp_ms(out, epoch_ms);
            }
            return true;
        }
    }

    item = cJSON_GetObjectItemCaseSensitive(root, "t");
    if (cJSON_IsObject(item)) {
        cJSON *iso = cJSON_GetObjectItemCaseSensitive(item, "iso");
        cJSON *epoch = cJSON_GetObjectItemCaseSensitive(item, "epoch");
        cJSON *usec = cJSON_GetObjectItemCaseSensitive(item, "usec");

        if (cJSON_IsString(iso) && (iso->valuestring != NULL)) {
            snprintf(out, n, "%s", iso->valuestring);
            if (epoch_ms != NULL) {
                (void)parse_wire_timestamp_ms(out, epoch_ms);
            }
            return true;
        }
        if (cJSON_IsNumber(epoch)) {
            double value = epoch->valuedouble * 1000.0;
            if (cJSON_IsNumber(usec)) value += usec->valuedouble / 1000.0;
            format_epoch_ms_iso(value, out, n);
            if (epoch_ms != NULL) *epoch_ms = value;
            return true;
        }
    }

    item = json_find_item_deep(root, "timestamp_ms");
    if (cJSON_IsNumber(item) && (item->valuedouble > 100000000000.0)) {
        format_epoch_ms_iso(item->valuedouble, out, n);
        if (epoch_ms != NULL) *epoch_ms = item->valuedouble;
        return true;
    }

    item = cJSON_GetObjectItemCaseSensitive(root, "heartbeat");
    if (cJSON_IsNumber(item) && (item->valuedouble > 1000000000.0)) {
        double value = item->valuedouble * 1000.0;
        format_epoch_ms_iso(value, out, n);
        if (epoch_ms != NULL) *epoch_ms = value;
        return true;
    }

    return false;
}

/* ================= Device classification and normalization ============ */

static const char *device_from_channel(const char *channel) {
    if (channel == NULL) return "UNKNOWN_DEVICE";

    if (strcmp(channel, "joystick") == 0) return "JOYSTICK";
    if (strcmp(channel, "button_led") == 0) return "BUTTON_LED_UNIT";
    if (strcmp(channel, "tracker_telemetry") == 0) return "CAMERA_UNIT";
    if (strcmp(channel, "tracker_publish") == 0)return "DRIVE_UNIT";
    if (strcmp(channel, "external_track") == 0) return "EXTERNAL_TRACK_UNIT";
    if (strcmp(channel, "advantec_driver") == 0) return "ADVANTECH_IO";
    if (strcmp(channel, "imu") == 0) return "IMU_UNIT";
    if (strcmp(channel, "cce_gateway") == 0) return "CCE_GATEWAY";
    if (strcmp(channel, "lcu_transport") == 0) return "LCU_UNIT";
    if (strcmp(channel, "drive_wcs") == 0) return "DRIVE_UNIT";

    return channel;
}
static const char *normalize_device_name(const char *name) {

    if (name == NULL || name[0] == '\0') {
        return "UNKNOWN_DEVICE";
    }

    /* JOYSTICK */
    if (STRICMP(name, "JOYSTICK") == 0 ||
        STRICMP(name, "JOYSTICK_UNIT") == 0 ||
        STRICMP(name, "JOYSTICK UNIT") == 0 ||
        STRICMP(name, "joystick") == 0) {
        return "JOYSTICK_UNIT";
    }

    if (STRICMP(name, "BUTTON") == 0 ||
        STRICMP(name, "BUTTON_LED") == 0 ||
        STRICMP(name, "BUTTON_LED_UNIT") == 0 ||
        STRICMP(name, "BUTTON LED") == 0 ||
        STRICMP(name, "BUTTON LED UNIT") == 0 ||
        STRICMP(name, "button_led") == 0) {
        return "BUTTON_LED_UNIT";
    }

    /* MAIN DISPLAY */
    if (STRICMP(name, "MAIN_DISPLAY") == 0 ||
        STRICMP(name, "MAIN DISPLAY") == 0 ||
        STRICMP(name, "maindisplay") == 0 ||
        STRICMP(name, "main_display") == 0) {
        return "MAIN_DISPLAY";
    }

    /* WCS */
    if (STRICMP(name, "WCS") == 0 ||
        STRICMP(name, "wcs_control_console") == 0 ||
        STRICMP(name, "WCS CONTROL CONSOLE") == 0 ||
        STRICMP(name, "WCS_CONSOLE") == 0 ||
        STRICMP(name, "WCS CONSOLE") == 0 ||
        STRICMP(name, "WCS_CONSOLE") == 0) {
        return "WCS_CONSOLE";
    }

    /* IMU */
    if (STRICMP(name, "IMU") == 0 ||
        STRICMP(name, "imu") == 0 ||
        STRICMP(name, "IMU_UNIT") == 0) {
        return "IMU_UNIT";
    }

    /* CAMERA */
    if (STRICMP(name, "CAMERA") == 0 ||
        STRICMP(name, "CAMERA_UNIT") == 0 ||
        STRICMP(name, "tracker_telemetry") == 0) {
        return "CAMERA_UNIT";
    }

    /* LCU */
    if (STRICMP(name, "LCU") == 0 ||
        STRICMP(name, "LCU_UNIT") == 0 ||
        STRICMP(name, "LCU UNIT") == 0 ||
        STRICMP(name, "LCU TRANSPORT") == 0 ||
        STRICMP(name, "lcu_transport") == 0) {
        return "LCU_UNIT";
    }
    if (STRICMP(name, "CCE") == 0 ||
    STRICMP(name, "CCE_GATEWAY") == 0 ||
    STRICMP(name, "CCE GATEWAY") == 0 ||
    STRICMP(name, "cce_gateway") == 0) {
    return "CCE_GATEWAY";
}

    if (STRICMP(name, "TRACKER_PUBLISH") == 0 ||
        STRICMP(name, "TRACKER_PUBLISH_UNIT") == 0 ||
        STRICMP(name, "tracker_publish") == 0) {
        return "DRIVE_UNIT";
    }

    /* DRIVE and TRACKER_PUBLISH are one physical drive family. */
    if (STRICMP(name, "DRIVE") == 0 ||
        STRICMP(name, "DRIVE_UNIT") == 0 ||
        STRICMP(name, "drive") == 0 ||
        STRICMP(name, "drive_wcs") == 0) {
        return "DRIVE_UNIT";
    }

    if (STRICMP(name, "EXTERNAL_TRACK") == 0 ||
        STRICMP(name, "EXTERNAL_TRACK_UNIT") == 0 ||
        STRICMP(name, "external_track") == 0) {
        return "EXTERNAL_TRACK_UNIT";
    }

    if (STRICMP(name, "ADVANTECH") == 0 ||
        STRICMP(name, "ADVANTECH_IO") == 0 ||
        STRICMP(name, "advantec_driver") == 0) {
        return "ADVANTECH_IO";
    }

    return name;
}
static const char *hmi_channel_for_device(const char *device) {
    if (device == NULL) return "";

    if (strcmp(device, "LCU") == 0) return "lcu_transport";
    if (strcmp(device, "WCS") == 0)return "wcs_control_console";
    if (strcmp(device, "CAMERA") == 0) return "tracker_telemetry";
    if ((strcmp(device, "DRIVE") == 0) ||
        (strcmp(device, "DRIVE_UNIT") == 0)) return "tracker_publish";
    if (strcmp(device, "MAIN_DISPLAY") == 0)return "maindisplay";
    if (strcmp(device, "IMU") == 0) return "imu";
    if (strcmp(device, "BUTTON") == 0) return "button_led";
    if (strcmp(device, "CCE") == 0)return "cce_gateway";
    if (strcmp(device, "JOYSTICK") == 0) return "joystick";
    if (strcmp(device, "EXTERNAL_TRACK") == 0) return "external_track";
    if (strcmp(device, "ADVANTECH") == 0) return "advantec_driver";

    return "";
}

static const char *process_from_channel(cJSON *root, const char *channel) {
    const char *named;

    named = json_get_string(root, "process_name", "process", "");

    if ((named != NULL) && (named[0] != '\0')) return named;
    if (channel == NULL) return "";

    if (strcmp(channel, "joystick") == 0) return "joystick";
    if (strcmp(channel, "button_led") == 0) return "button_led";
    if (strcmp(channel, "tracker_telemetry") == 0) return "tracker_telemetry";
    if (strcmp(channel, "tracker_publish") == 0) return "tracker_publish";
    if (strcmp(channel, "external_track") == 0) return "external_track";
    if (strcmp(channel, "maindisplay") == 0) return "maindisplay";
    if (strcmp(channel, "imu") == 0) return "imu";
    if (strcmp(channel, "cce_gateway") == 0) return "cce_gateway";
    if (strcmp(channel, "lcu_transport") == 0) return "lcu_transport";
    if (strcmp(channel, "drive_wcs") == 0) return "tracker_publish";

    return channel;
}

/**
 * @brief Test whether a nested JSON object contains the requested key.
 * @param obj JSON object or array to inspect recursively.
 */
static bool json_has_object_deep(cJSON *obj, const char *key) {
    cJSON *it = NULL;

    if ((obj == NULL) || (key == NULL) ||
        (!cJSON_IsObject(obj) && !cJSON_IsArray(obj))) return false;

    if (cJSON_IsObject(obj)) {
        it = cJSON_GetObjectItemCaseSensitive(obj, key);
        if ((it != NULL) && cJSON_IsObject(it)) return true;
    }

    cJSON_ArrayForEach(it, obj) {
        if ((cJSON_IsObject(it) || cJSON_IsArray(it)) &&
            json_has_object_deep(it, key)) {
            return true;
        }
    }

    return false;
}

/**
 * @brief Test whether a supplied name identifies a Drive payload.
 */
static bool payload_name_is_drive(const char *name) {
    if ((name == NULL) || (name[0] == '\0')) return false;

    return (STRICMP(name, "TelemetryOnce") == 0) ||
           (STRICMP(name, "TelemetryPeriodic") == 0) ||
           (STRICMP(name, "TelemetryContinuous") == 0) ||
           (STRICMP(name, "TelemetryDioPeriodic") == 0) ||
           (STRICMP(name, "TelemetryDioContinuous") == 0) ||
           (STRICMP(name, "DriveCommandIssued") == 0) ||
           (STRICMP(name, "DriveCommandResult") == 0);
}

/**
 * @brief Detect fields that uniquely identify Main Display telemetry.
 */
static bool payload_has_main_display_signature(cJSON *root) {
    if ((root == NULL) || !cJSON_IsObject(root)) return false;

    return (cJSON_GetObjectItemCaseSensitive(root, "video_source") != NULL) ||
           (cJSON_GetObjectItemCaseSensitive(root, "recording") != NULL) ||
           (cJSON_GetObjectItemCaseSensitive(root, "fps") != NULL) ||
           (cJSON_GetObjectItemCaseSensitive(root, "tracker_enabled") != NULL) ||
           (cJSON_GetObjectItemCaseSensitive(root, "imu_enabled") != NULL);
}

/**
 * @brief Detect fields that uniquely identify Camera telemetry.
 */
static bool payload_has_camera_signature(cJSON *root) {
    if ((root == NULL) || !cJSON_IsObject(root)) return false;

    return (cJSON_GetObjectItemCaseSensitive(root, "camera_id") != NULL) ||
           (cJSON_GetObjectItemCaseSensitive(root, "track_cam_id") != NULL) ||
           (cJSON_GetObjectItemCaseSensitive(root, "tracker_ret_x") != NULL) ||
           (cJSON_GetObjectItemCaseSensitive(root, "tracker_ret_y") != NULL) ||
           (cJSON_GetObjectItemCaseSensitive(root, "tracker_bb_w") != NULL) ||
           (cJSON_GetObjectItemCaseSensitive(root, "tracker_bb_h") != NULL) ||
           (cJSON_GetObjectItemCaseSensitive(root, "pan_actual_deg") != NULL) ||
           (cJSON_GetObjectItemCaseSensitive(root, "tilt_actual_deg") != NULL) ||
           (cJSON_GetObjectItemCaseSensitive(root, "tracker_pan_err") != NULL) ||
           (cJSON_GetObjectItemCaseSensitive(root, "tracker_tilt_err") != NULL) ||
           (cJSON_GetObjectItemCaseSensitive(root, "video_source") != NULL);
}

/**
 * @brief Detect fields that uniquely identify Drive telemetry.
 */
static bool payload_has_drive_signature(cJSON *root) {
    if ((root == NULL) || !cJSON_IsObject(root)) return false;

    return (json_find_item_deep(root, "rpm") != NULL) ||
           (json_find_item_deep(root, "body_rpm") != NULL) ||
           (json_find_item_deep(root, "actual_current") != NULL) ||
           (json_find_item_deep(root, "dcbus_volt") != NULL) ||
           (json_find_item_deep(root, "drive_connected") != NULL) ||
           (json_find_item_deep(root, "body_dio_connected") != NULL) ||
           (json_find_item_deep(root, "body_fault_bits") != NULL) ||
           (json_find_item_deep(root, "fault_raw") != NULL) ||
           (json_find_item_deep(root, "torque_nm") != NULL);
}

/**
 * @brief Detect fields that uniquely identify Joystick telemetry.
 */
static bool payload_has_joystick_signature(cJSON *root) {
    if ((root == NULL) || !cJSON_IsObject(root)) return false;

    return (cJSON_GetObjectItemCaseSensitive(root, "axes") != NULL) ||
           (cJSON_GetObjectItemCaseSensitive(root, "buttons") != NULL) ||
           (cJSON_GetObjectItemCaseSensitive(root, "hats") != NULL) ||
           (cJSON_GetObjectItemCaseSensitive(root, "connected") != NULL);
}

/**
 * @brief Detect fields that uniquely identify Button/LED telemetry.
 */
static bool payload_has_button_led_signature(cJSON *root) {
    if ((root == NULL) || !cJSON_IsObject(root)) return false;

    return (cJSON_GetObjectItemCaseSensitive(root, "buttons") != NULL) ||
           (cJSON_GetObjectItemCaseSensitive(root, "switches") != NULL) ||
           (cJSON_GetObjectItemCaseSensitive(root, "knobs") != NULL) ||
           (cJSON_GetObjectItemCaseSensitive(root, "mode") != NULL) ||
           (cJSON_GetObjectItemCaseSensitive(root, "frequency_hz") != NULL);
}

/**
 * @brief Add a numeric alias when the source field exists and the alias is absent.
 * @param value Input value to parse or normalize.
 */
static void add_number_alias(cJSON *root,
                             const char *key,
                             const cJSON *value) {
    if ((root == NULL) || (key == NULL) || !cJSON_IsNumber(value) ||
        (cJSON_GetObjectItemCaseSensitive(root, key) != NULL)) {
        return;
    }

    cJSON_AddNumberToObject(root, key, value->valuedouble);
}

/**
 * @brief Expose vector components under normalized scalar aliases.
 * @param vector_key Source JSON key containing the vector representation.
 * @param x_key Normalized key used for the vector's x component.
 * @param y_key Normalized key used for the vector's y component.
 * @param z_key Normalized key used for the vector's z component.
 */
static void add_vector_aliases(cJSON *root,
                               const char *vector_key,
                               const char *x_key,
                               const char *y_key,
                               const char *z_key) {
    cJSON *vector;

    if ((root == NULL) || (vector_key == NULL)) return;

    vector = cJSON_GetObjectItemCaseSensitive(root, vector_key);
    if (!cJSON_IsArray(vector) || (cJSON_GetArraySize(vector) < 3)) return;

    add_number_alias(root, x_key, cJSON_GetArrayItem(vector, 0));
    add_number_alias(root, y_key, cJSON_GetArrayItem(vector, 1));
    add_number_alias(root, z_key, cJSON_GetArrayItem(vector, 2));
}

/**
 * @brief Normalize supported IMU packet variants to common orientation and vector keys.
 */
static void normalize_imu_payload(cJSON *root) {
    cJSON *orientation;
    cJSON *position;

    if ((root == NULL) || !cJSON_IsObject(root)) return;

    /* UMC1 NAV vectors are ordered roll, pitch, yaw. */
    add_vector_aliases(root, "euler_deg", "roll", "pitch", "yaw");
    add_vector_aliases(root, "angles_deg", "roll", "pitch", "yaw");
    add_vector_aliases(root, "ang_dps", "gyro_x", "gyro_y", "gyro_z");
    add_vector_aliases(root, "acc_mps2", "accel_x", "accel_y", "accel_z");

    orientation = cJSON_GetObjectItemCaseSensitive(root, "euler_deg");
    if (!cJSON_IsArray(orientation)) {
        orientation = cJSON_GetObjectItemCaseSensitive(root, "angles_deg");
    }
    if (cJSON_IsArray(orientation) &&
        (cJSON_GetArraySize(orientation) >= 3)) {
        add_number_alias(root,
                         "heading",
                         cJSON_GetArrayItem(orientation, 2));
    }

    position = cJSON_GetObjectItemCaseSensitive(root, "wgs84");
    if (cJSON_IsObject(position)) {
        add_number_alias(root,
                         "lat",
                         cJSON_GetObjectItemCaseSensitive(position, "lat"));
        add_number_alias(root,
                         "lon",
                         cJSON_GetObjectItemCaseSensitive(position, "lon"));
        add_number_alias(root,
                         "alt",
                         cJSON_GetObjectItemCaseSensitive(position, "alt"));
        add_number_alias(root,
                         "latitude",
                         cJSON_GetObjectItemCaseSensitive(position, "lat"));
        add_number_alias(root,
                         "longitude",
                         cJSON_GetObjectItemCaseSensitive(position, "lon"));
        add_number_alias(root,
                         "altitude",
                         cJSON_GetObjectItemCaseSensitive(position, "alt"));
    }
}

/* Only confirmed raw protocol feedback named pan/tilt uses hundredths. */
static void normalize_pan_tilt_values(cJSON *node) {
    cJSON *child;
    if (node == NULL) return;
    if (cJSON_IsObject(node)) {
        cJSON_ArrayForEach(child, node) {
            if (cJSON_IsNumber(child) && (child->string != NULL) &&
                ((STRICMP(child->string, "pan") == 0) ||
                 (STRICMP(child->string, "tilt") == 0))) {
                const char *raw_name=STRICMP(child->string,"pan")==0?"raw_pan":"raw_tilt";
                if(cJSON_GetObjectItemCaseSensitive(node,raw_name)==NULL)
                    cJSON_AddNumberToObject(node,raw_name,child->valuedouble);
                (void)cJSON_SetNumberValue(child, child->valuedouble / 100.0);
            } else if (cJSON_IsObject(child) || cJSON_IsArray(child)) {
                normalize_pan_tilt_values(child);
            }
        }
    } else if (cJSON_IsArray(node)) {
        cJSON_ArrayForEach(child, node) {
            if (cJSON_IsObject(child) || cJSON_IsArray(child))
                normalize_pan_tilt_values(child);
        }
    }
}

/**
 * @brief Detect fields that identify an IMU payload.
 */
static bool payload_has_imu_signature(cJSON *root) {
    if ((root == NULL) || !cJSON_IsObject(root)) return false;

    return (cJSON_GetObjectItemCaseSensitive(root, "yaw") != NULL) ||
           (cJSON_GetObjectItemCaseSensitive(root, "pitch") != NULL) ||
           (cJSON_GetObjectItemCaseSensitive(root, "roll") != NULL) ||
           (cJSON_GetObjectItemCaseSensitive(root, "accel_x") != NULL) ||
           (cJSON_GetObjectItemCaseSensitive(root, "gyro_x") != NULL);
}

/**
 * @brief Detect fields that identify External Tracker telemetry.
 */
static bool payload_has_external_track_signature(cJSON *root) {
    if ((root == NULL) || !cJSON_IsObject(root)) return false;

    return (cJSON_GetObjectItemCaseSensitive(root, "track_id") != NULL) ||
           (cJSON_GetObjectItemCaseSensitive(root, "azimuth_deg") != NULL) ||
           (cJSON_GetObjectItemCaseSensitive(root, "elevation_deg") != NULL) ||
           (cJSON_GetObjectItemCaseSensitive(root, "range_m") != NULL) ||
           (cJSON_GetObjectItemCaseSensitive(root, "command") != NULL);
}

/**
 * @brief Detect fields that identify Advantech I/O telemetry.
 */
static bool payload_has_advantech_signature(cJSON *root) {
    if ((root == NULL) || !cJSON_IsObject(root)) return false;

    return (cJSON_GetObjectItemCaseSensitive(root, "di_mask") != NULL) ||
           (cJSON_GetObjectItemCaseSensitive(root, "do_mask") != NULL) ||
           (cJSON_GetObjectItemCaseSensitive(root, "device_connected") != NULL) ||
           (cJSON_GetObjectItemCaseSensitive(root, "health") != NULL);
}

/**
 * @brief Detect fields that identify LCU transport telemetry.
 */
static bool payload_has_lcu_signature(cJSON *root) {
    if ((root == NULL) || !cJSON_IsObject(root)) return false;

    return (cJSON_GetObjectItemCaseSensitive(root, "drive_state") != NULL) ||
           (cJSON_GetObjectItemCaseSensitive(root, "body") != NULL) ||
           (cJSON_GetObjectItemCaseSensitive(root, "name") != NULL) ||
           (cJSON_GetObjectItemCaseSensitive(root, "src") != NULL);
}

/**
 * @brief Test whether a supplied name identifies a WCS payload.
 */
static bool payload_name_is_wcs(const char *name) {
    if ((name == NULL) || (name[0] == '\0')) return false;

    return (STRICMP(name, "WcsCommandReceived") == 0) ||
           (STRICMP(name, "WcsStatusReply") == 0) ||
           (STRICMP(name, "EnableDrive") == 0) ||
           (STRICMP(name, "DisableDrive") == 0) ||
           (STRICMP(name, "ResetDrive") == 0) ||
           (STRICMP(name, "EStop") == 0) ||
           (STRICMP(name, "Halt") == 0) ||
           (STRICMP(name, "SetAngleParams") == 0) ||
           (STRICMP(name, "SetMotionParams") == 0) ||
           (STRICMP(name, "Move") == 0) ||
           (STRICMP(name, "MovePosition") == 0) ||
           (STRICMP(name, "MoveDeg") == 0) ||
           (STRICMP(name, "MoveToPositionDeg") == 0) ||
           (STRICMP(name, "JogFwd") == 0) ||
           (STRICMP(name, "JogRev") == 0) ||
           (STRICMP(name, "Jog") == 0) ||
           (STRICMP(name, "Solenoid") == 0) ||
           (STRICMP(name, "ReleaseBrake") == 0) ||
           (STRICMP(name, "PanLock") == 0) ||
           (STRICMP(name, "PanUnlock") == 0) ||
           (STRICMP(name, "TiltLock") == 0) ||
           (STRICMP(name, "TiltUnlock") == 0) ||
           (STRICMP(name, "ReadDI") == 0) ||
           (STRICMP(name, "ReadDIAll") == 0) ||
           (STRICMP(name, "ReadDO") == 0) ||
           (STRICMP(name, "ReadDOAll") == 0) ||
           (STRICMP(name, "WriteDO") == 0) ||
           (STRICMP(name, "WriteDOAll") == 0);
}

/**
 * @brief Validate that packet content is compatible with the receiving channel.
 * @param channel Receiving or canonical telemetry channel.
 * @param device Canonical or candidate device identifier.
 * @param process Telemetry process identifier.
 * @param src Source/origin label extracted from the packet.
 */
static bool payload_matches_channel(const char *channel,
                                     const char *device,
                                     const char *process,
                                     const char *src,
                                     cJSON *root) {
    const char *name;
    const char *type;

    if ((root == NULL) || (channel == NULL) || (channel[0] == '\0')) {
        return true;
    }

    name = json_find_string_deep(root, "name", NULL);
    type = json_find_string_deep(root, "type", NULL);

    if (strcmp(channel, "maindisplay") == 0) {
        if ((device != NULL) && (device[0] != '\0') &&
            (STRICMP(device, "MAIN_DISPLAY") == 0 ||
             STRICMP(device, "MAINDISPLAY") == 0 ||
             STRICMP(device, "main_display") == 0)) {
            return true;
        }
        if ((process != NULL) && (process[0] != '\0') &&
            (STRICMP(process, "MAIN_DISPLAY") == 0 ||
             STRICMP(process, "MAINDISPLAY") == 0 ||
             STRICMP(process, "maindisplay") == 0 ||
             STRICMP(process, "main_display") == 0)) {
            return true;
        }
        if ((src != NULL) && (src[0] != '\0') &&
            (STRICMP(src, "maindisplay") == 0 ||
             STRICMP(src, "main_display") == 0)) {
            return true;
        }
        return payload_has_main_display_signature(root);
    }

    if ((strcmp(channel, "tracker_telemetry") == 0) ||
        (strcmp(channel, "tracker_telem") == 0)) {
        if ((device != NULL) && (device[0] != '\0') &&
            (STRICMP(device, "CAMERA_UNIT") == 0 ||
             STRICMP(device, "CAMERA") == 0 ||
             STRICMP(device, "tracker_telemetry") == 0)) {
            return true;
        }
        if ((process != NULL) && (process[0] != '\0') &&
            (STRICMP(process, "tracker_telemetry") == 0 ||
             STRICMP(process, "CAMERA_UNIT") == 0 ||
             STRICMP(process, "camera") == 0)) {
            return true;
        }
        if ((src != NULL) && (src[0] != '\0') &&
            (STRICMP(src, "camera") == 0 ||
             STRICMP(src, "tracker_telemetry") == 0)) {
            return true;
        }
        return payload_has_camera_signature(root);
    }

    if ((strcmp(channel, "tracker_publish") == 0) ||
        (strcmp(channel, "drive_wcs") == 0)) {
        if ((device != NULL) && (device[0] != '\0') &&
            (STRICMP(device, "TRACKER_PUBLISH_UNIT") == 0 ||
             STRICMP(device, "DRIVE") == 0 ||
             STRICMP(device, "DRIVE_UNIT") == 0 ||
             STRICMP(device, "DRIVE_WCS") == 0 ||
             STRICMP(device, "TRACKER_PUBLISH") == 0)) {
            return true;
        }
        if ((process != NULL) && (process[0] != '\0') &&
            (STRICMP(process, "tracker_publish") == 0 ||
             STRICMP(process, "TRACKER_PUBLISH_UNIT") == 0 ||
             STRICMP(process, "DRIVE_UNIT") == 0 ||
             STRICMP(process, "drive") == 0)) {
            return true;
        }
        if ((src != NULL) && (src[0] != '\0') &&
            (STRICMP(src, "drive") == 0 ||
             STRICMP(src, "tracker_publish") == 0)) {
            return true;
        }
        return payload_has_drive_signature(root);
    }

    if (strcmp(channel, "joystick") == 0) {
        return payload_has_joystick_signature(root);
    }

    if (strcmp(channel, "button_led") == 0) {
        return payload_has_button_led_signature(root);
    }

    if (strcmp(channel, "imu") == 0) {
        return payload_has_imu_signature(root);
    }

    if (strcmp(channel, "external_track") == 0) {
        return payload_has_external_track_signature(root);
    }

    if (strcmp(channel, "advantec_driver") == 0) {
        return payload_has_advantech_signature(root);
    }

    if (strcmp(channel, "lcu_transport") == 0) {
        return payload_has_lcu_signature(root);
    }

    if ((strcmp(channel, "wcs_control_console") == 0) &&
        (payload_name_is_wcs(name) ||
         ((src != NULL) && ((STRICMP(src, "wcs") == 0) ||
                           (STRICMP(src, "wcs_hmi") == 0))))) {
        return true;
    }

    if ((strcmp(channel, "drive_wcs") == 0) ||
        (strcmp(channel, "tracker_publish") == 0)) {
        if (payload_name_is_drive(name) ||
            json_has_object_deep(root, "drive_state") ||
            (type != NULL && ((STRICMP(type, "continuous") == 0) ||
                              (STRICMP(type, "once") == 0)))) {
            return true;
        }
    }

    return true;
}

static const char *strict_channel_for_record(cJSON *root,
                                             const char *channel,
                                             const char *incoming_channel) {
    const char *raw_device;
    const char *raw_process;
    const char *src;
    const char *payload_channel;
    const char *classified_channel;

    if ((root == NULL) || !cJSON_IsObject(root)) {
        return NULL;
    }

    payload_channel = json_get_string(root,
                                      "channel_name",
                                      "channel",
                                      channel != NULL ? channel : "unknown");
    classified_channel = ((incoming_channel != NULL) &&
                           (strcmp(incoming_channel, "drive_wcs") == 0))
                              ? "drive_wcs"
                              : payload_channel;

    raw_device = json_get_string(root,
                                 "device_name",
                                 "device",
                                 "");
    raw_process = json_get_string(root,
                                  "process_name",
                                  "process",
                                  "");
    src = json_find_string_deep(root, "src", "source");

    if (payload_matches_channel(classified_channel, raw_device, raw_process, src, root)) {
        if (strcmp(classified_channel, "drive_wcs") == 0) {
            return "drive_wcs";
        }
        return classified_channel;
    }

    if ((strcmp(classified_channel, "tracker_publish") == 0) ||
        (strcmp(classified_channel, "tracker_telemetry") == 0) ||
        (strcmp(classified_channel, "maindisplay") == 0)) {
        return NULL;
    }

    return payload_channel;
}

static const char *strict_device_for_channel(const char *channel,
                                             const char *device_name,
                                             const char *process_name,
                                             const char *src,
                                             cJSON *root) {
    if ((channel == NULL) || (channel[0] == '\0')) {
        return NULL;
    }

    if (strcmp(channel, "lcu_transport") == 0) {
        return (root != NULL && payload_has_drive_signature(root))
            ? "DRIVE_UNIT" : "LCU_UNIT";
    }
    if (strcmp(channel, "imu") == 0) return "IMU_UNIT";
    if (strcmp(channel, "joystick") == 0) return "JOYSTICK_UNIT";
    if (strcmp(channel, "button_led") == 0) return "BUTTON_LED_UNIT";
    if (strcmp(channel, "external_track") == 0) return "EXTERNAL_TRACK_UNIT";
    if (strcmp(channel, "advantec_driver") == 0) return "ADVANTECH_IO";
    if (strcmp(channel, "cce_gateway") == 0) return "CCE_GATEWAY";

    if (strcmp(channel, "maindisplay") == 0) {
        return "MAIN_DISPLAY";
    }

    if ((strcmp(channel, "tracker_telemetry") == 0) ||
        (strcmp(channel, "tracker_telem") == 0)) {
        return "CAMERA_UNIT";
    }

    if (strcmp(channel, "tracker_publish") == 0) {
        return "DRIVE_UNIT";
    }

    if (strcmp(channel, "drive_wcs") == 0) {
        return "DRIVE_UNIT";
    }

    if ((device_name != NULL) && (device_name[0] != '\0')) {
        return normalize_device_name(device_name);
    }

    if ((process_name != NULL) && (process_name[0] != '\0')) {
        return normalize_device_name(process_name);
    }

    if ((src != NULL) && (src[0] != '\0')) {
        return normalize_device_name(src);
    }

    if ((root != NULL) && payload_has_drive_signature(root)) {
        return "DRIVE_UNIT";
    }

    if ((root != NULL) && payload_has_camera_signature(root)) {
        return "CAMERA_UNIT";
    }

    return NULL;
}

/**
 * @brief Identify metadata keys that should not be treated as telemetry measurements.
 * @param k Candidate metadata or telemetry key.
 */
static bool is_meta_key(const char *k) {
    static const char *m[] = {
        "session_id", "session", "timestamp", "time",
        "server_rx_ts",
        "device_ts",
        "packet_ts",
        "latency_ms",
        "channel_name", "channel",
        "device_name", "device",
        "subdevice_name", "subdevice",
        "process_name", "process",
        "subprocess_name", "subprocess",
        "v", "id", "type", "name", "src", "meta",
        "anomaly", "reason",
        NULL
    };

    int i;

    for (i = 0; m[i] != NULL; ++i) {
        if (strcmp(k, m[i]) == 0) {
            return true;
        }
    }

    return false;
}
/**
 * @brief Parse an entire string as a finite floating-point number.
 * @param s Input string to process.
 */
static bool try_parse_double(const char *s, double *out) {
    char *endptr;

    if ((s == NULL) || (s[0] == '\0') || (out == NULL)) {
        return false;
    }
    if ((s[0] == '0') && ((s[1] == 'x') || (s[1] == 'X'))) return false;

    *out = strtod(s, &endptr);

    if (endptr == s) {
        return false;
    }
    if (*endptr != '\0') {
        return false;
    }

    return true;
}
/**
 * @brief Append one scalar JSON value to a record's flattened-field collection.
 * @param item JSON item to normalize or flatten.
 */
static void add_flat(record_t *r, const char *key, cJSON *item) {
    flat_t *f;
    char *serialized;

    if ((r == NULL) || (key == NULL) || (item == NULL)) return;
    if (r->count >= MAX_FLAT) return;
    if (is_meta_key(key)) return;
    f = &r->flat[r->count];
    r->count++;

    snprintf(f->key, sizeof(f->key), "%s", key);
    clean_col(key, f->col, sizeof(f->col));

    if (cJSON_IsNumber(item)) {
        snprintf(f->type, sizeof(f->type), "REAL");
        f->num = item->valuedouble;
        f->text[0] = '\0';
    } else if (cJSON_IsBool(item)) {
        snprintf(f->type, sizeof(f->type), "REAL");
        f->num = cJSON_IsTrue(item) ? 1.0 : 0.0;
        f->text[0] = '\0';
    } else if (cJSON_IsString(item)) {
    double parsed;

    const char *value = item->valuestring ? item->valuestring : "";

    if (try_parse_double(value, &parsed)) {
        /* Store string-encoded numbers using their numeric representation. */
        snprintf(f->type, sizeof(f->type), "REAL");
        f->num = parsed;
        f->text[0] = '\0';
    } else if (STRICMP(value, "true") == 0) {
        snprintf(f->type, sizeof(f->type), "REAL");
        f->num = 1.0;
        f->text[0] = '\0';
    } else if (STRICMP(value, "false") == 0) {
        snprintf(f->type, sizeof(f->type), "REAL");
        f->num = 0.0;
        f->text[0] = '\0';
    } else {
        /* Preserve non-numeric strings as text. */
        snprintf(f->type, sizeof(f->type), "TEXT");
        f->num = 0.0;
        snprintf(f->text, sizeof(f->text), "%s", value);
    }
    }else {
        serialized = cJSON_PrintUnformatted(item);
        snprintf(f->type, sizeof(f->type), "TEXT");
        f->num = 0.0;
        snprintf(f->text, sizeof(f->text), "%s",
                 serialized != NULL ? serialized : "");

        if (serialized != NULL) free(serialized);
    }
}

/**
 * @brief Check whether a flattened record already contains a key.
 */
static bool flat_key_exists(record_t *r, const char *key) {
    int i;

    if ((r == NULL) || (key == NULL)) return true;

    for (i = 0; i < r->count; ++i) {
        if (strcmp(r->flat[i].key, key) == 0) {
            return true;
        }
    }

    return false;
}

/**
 * @brief Add normalized key/value objects that are encoded as named measurements.
 */
static void add_named_value_flat(record_t *r, cJSON *root) {
    cJSON *name;
    cJSON *topic;
    cJSON *value;
    cJSON *it = NULL;

    if ((r == NULL) || (root == NULL) ||
        (!cJSON_IsObject(root) && !cJSON_IsArray(root))) return;

    name = cJSON_IsObject(root)
        ? cJSON_GetObjectItemCaseSensitive(root, "name") : NULL;
    topic = cJSON_IsObject(root)
        ? cJSON_GetObjectItemCaseSensitive(root, "topic") : NULL;
    value = cJSON_IsObject(root)
        ? cJSON_GetObjectItemCaseSensitive(root, "value") : NULL;

    if (cJSON_IsString(name) && (name->valuestring != NULL) &&
        (name->valuestring[0] != '\0') && (value != NULL)) {
        if (!flat_key_exists(r, name->valuestring)) {
            add_flat(r, name->valuestring, value);
        }
    }

    /* The 10.10.2026 capture contains telemetry_kv packets whose measurement
     * name is carried in `topic` and whose reading is carried in `value`.
     * Project the reading under that topic so indexed metric leaves (for
     * example .../GPS/LAT) flow through the same history/dashboard pipeline.
     * Keep topic and value themselves too; raw_json remains lossless. */
    if (cJSON_IsString(topic) && (topic->valuestring != NULL) &&
        (topic->valuestring[0] != '\0') && (value != NULL) &&
        !flat_key_exists(r, topic->valuestring)) {
        add_flat(r, topic->valuestring, value);
    }

    cJSON_ArrayForEach(it, root) {
        if (cJSON_IsObject(it) || cJSON_IsArray(it)) {
            add_named_value_flat(r, it);
        }
    }
}

/* ================= JSON flattening and telemetry logging =============== */

/**
 * @brief Recursively flatten nested JSON objects into scalar telemetry fields.
 * @param obj JSON object or array to inspect recursively.
 * @param prefix Flattened-key prefix accumulated during recursion.
 */
static void flatten_json(record_t *r, cJSON *obj, const char *prefix) {
    cJSON *it = NULL;
    int array_index = 0;

    cJSON_ArrayForEach(it, obj) {
        char key[128];

        if (it->string != NULL && (prefix != NULL) && (*prefix != '\0')) {
            snprintf(key, sizeof(key), "%s_%s", prefix, it->string);
        } else if (it->string != NULL) {
            snprintf(key, sizeof(key), "%s", it->string);
        } else if ((prefix != NULL) && (*prefix != '\0')) {
            snprintf(key, sizeof(key), "%s_%d", prefix, array_index++);
        } else {
            snprintf(key, sizeof(key), "item_%d", array_index++);
        }

        if (cJSON_IsObject(it) || cJSON_IsArray(it)) {
            flatten_json(r, it, key);
        } else {
            add_flat(r, key, it);
        }
    }
}

typedef struct { const char *source; const char *target; } field_alias_t;
static const field_alias_t g_field_aliases[] = {
    {"system_status","status"},{"body_status","status"},{"body_rpm","rpm"},
    {"actual_current","current"},{"dcbus_volt","voltage"},
    {"drive_connected","connected"},{"body_dio_connected","connected"},
    {"fault_raw","fault"},{"body_fault_bits","fault"},
    {"pan_angle","pan"},{"tilt_angle","tilt"},
    {"pan_actual_deg","pan"},{"tilt_actual_deg","tilt"},
    {"target_bearing","bearing"},{"target_range","range"},
    {"target_elevation","elevation"}
};

static const char *canonical_field_name(const char *column) {
    size_t i;
    for (i=0U;i<sizeof(g_field_aliases)/sizeof(g_field_aliases[0]);++i)
        if (strcmp(column,g_field_aliases[i].source)==0) return g_field_aliases[i].target;
    return column;
}

static void canonicalize_flat_fields(record_t *r) {
    int i,j,out=0,original_count;
    if(r==NULL)return;
    /* Preserve every original JSON field. Aliases are additional compatibility
     * projections; replacing the source name previously left valid columns
     * such as actual_current and drive_connected permanently empty. */
    for(i=0;i<r->count;++i){
        bool duplicate=false;
        for(j=0;j<out;++j) if(strcmp(r->flat[j].col,r->flat[i].col)==0){duplicate=true;break;}
        if(duplicate)continue;
        if(out!=i)r->flat[out]=r->flat[i];
        out++;
    }
    original_count=out;
    for(i=0;i<original_count && out<MAX_FLAT;++i){
        const char *canonical=canonical_field_name(r->flat[i].col);
        bool exists=false;
        if(strcmp(canonical,r->flat[i].col)==0)continue;
        for(j=0;j<out;++j)if(strcmp(r->flat[j].col,canonical)==0){exists=true;break;}
        if(exists)continue;
        r->flat[out]=r->flat[i];
        snprintf(r->flat[out].col,sizeof(r->flat[out].col),"%s",canonical);
        snprintf(r->flat[out].key,sizeof(r->flat[out].key),"%s",canonical);
        out++;
    }
    r->count=out;
}
/**
 * @brief Append a human-readable HMI state transition to the text audit log.
 * @param timestamp Event or packet timestamp.
 * @param device Canonical or candidate device identifier.
 * @param control Control identifier associated with an HMI transition.
 * @param previous_state Control state before the transition.
 * @param new_state Control state after the transition.
 * @param toggles Cumulative number of control state changes.
 * @param duration_ms Time spent in the preceding state, in milliseconds.
 * @param session Session identifier associated with the record.
 */
static void write_hmi_txt_log(
    const char *timestamp,
    const char *device,
    const char *control,
    int previous_state,
    int new_state,
    int toggles,
    long duration_ms,
    const char *session
) {

    FILE *f;

    char filename[256];

    time_t t = time(NULL);

    struct tm tmv;

    platform_localtime(&t, &tmv);

    strftime(
        filename,
        sizeof(filename),
        "logs/hmi_events_%d_%m_%Y.txt",
        &tmv
    );

    MKDIR("logs");

    f = fopen(filename, "a");

    if (!f) {
        return;
    }

    fprintf(
        f,

        "[%s]\n"
        "DEVICE=%s\n"
        "CONTROL=%s\n"
        "PREVIOUS=%d\n"
        "NEW=%d\n"
        "TOGGLES=%d\n"
        "DURATION_MS=%ld\n"
        "SESSION=%s\n"
        "--------------------------\n",

        timestamp,
        device,
        control,
        previous_state,
        new_state,
        toggles,
        duration_ms,
        session
    );

    fclose(f);
}

/**
 * @brief Append an accepted raw UDP packet and metadata to the packet log.
 * @param src_ip Textual source IPv4 address.
 * @param src_port Source UDP port in host byte order.
 */
static void write_udp_packet_log(const record_t *r,
                                 const char *json,
                                 const char *src_ip,
                                 int src_port) {
    char filename[256];
    time_t t = time(NULL);
    struct tm tmv;

    if ((r == NULL) || (json == NULL)) return;

    platform_localtime(&t, &tmv);

    strftime(filename,
             sizeof(filename),
             "logs/udp_packets_%d_%m_%Y.jsonl",
             &tmv);

    MKDIR("logs");

    if ((g_udp_log_file == NULL) || (strcmp(g_udp_log_name, filename) != 0)) {
        if (g_udp_log_file != NULL) {
            fclose(g_udp_log_file);
            g_udp_log_file = NULL;
        }

        g_udp_log_file = fopen(filename, "a");
        if (g_udp_log_file == NULL) {
            g_udp_log_name[0] = '\0';
            return;
        }

        snprintf(g_udp_log_name, sizeof(g_udp_log_name), "%s", filename);
        g_udp_log_since_flush = 0;
    }

    fprintf(g_udp_log_file,
            "{\"timestamp\":\"%s\","
            "\"server_rx_ts\":\"%s\","
            "\"device_ts\":\"%s\","
            "\"packet_ts\":\"%s\","
            "\"channel\":\"%s\","
            "\"device\":\"%s\","
            "\"process\":\"%s\","
            "\"source_ip\":\"%s\","
            "\"source_port\":%d,"
            "\"payload\":%s}\n",
            r->ts,
            r->server_rx_ts,
            r->device_ts,
            r->packet_ts,
            r->channel,
            r->device,
            r->process,
            src_ip ? src_ip : "",
            src_port,
            json);

    g_udp_log_since_flush++;

    if (g_udp_log_since_flush >= 250) {
        fflush(g_udp_log_file);
        g_udp_log_since_flush = 0;
    }
}

static time_t parse_db_timestamp(const char *ts);

/**
 * @brief Determine whether a flattened field participates in live control-state tracking.
 * @param f Flattened telemetry field under evaluation.
 */
static bool should_track_state_field(const record_t *r, const flat_t *f) {
    size_t key_len;

    if ((r == NULL) || (f == NULL)) return false;
    if (strcmp(f->type, "REAL") != 0) return false;

    if ((strcmp(r->channel, "button_led") != 0) &&
        (strcmp(r->channel, "joystick") != 0) &&
        (strcmp(r->channel, "advantec_driver") != 0)) {
        return false;
    }

    if ((strcmp(f->key, "seq") == 0) ||
        (strcmp(f->key, "id") == 0) ||
        (strcmp(f->key, "value") == 0) ||
        (strcmp(f->key, "timestamp") == 0) ||
        (strcmp(f->key, "packet_ts") == 0) ||
        (strcmp(f->key, "device_tc") == 0) ||
        (strcmp(f->key, "heartbeat") == 0)) {
        return false;
    }

    key_len = strlen(f->key);
    if ((key_len >= 3U) && (strcmp(f->key + key_len - 3U, "_id") == 0)) {
        return false;
    }

    return true;
}

static state_cache_entry_t *find_state_cache(const char *device,
                                             const char *key) {
    int i;

    if ((device == NULL) || (key == NULL)) return NULL;

    for (i = 0; i < g_state_cache_count; ++i) {
        if ((strcmp(g_state_cache[i].device, device) == 0) &&
            (strcmp(g_state_cache[i].key, key) == 0)) {
            return &g_state_cache[i];
        }
    }

    return NULL;
}

static state_cache_entry_t *add_state_cache(const char *device,
                                            const char *key) {
    state_cache_entry_t *entry;

    if ((device == NULL) || (key == NULL) ||
        (g_state_cache_count >= STATE_CACHE_MAX)) {
        return NULL;
    }

    entry = &g_state_cache[g_state_cache_count++];
    memset(entry, 0, sizeof(*entry));
    snprintf(entry->device, sizeof(entry->device), "%s", device);
    snprintf(entry->key, sizeof(entry->key), "%s", key);
    return entry;
}

/**
 * @brief Persist latest control state and generate HMI transition events.
 */
static void update_device_state(sqlite3 *db, record_t *r, cJSON *root) {

    sqlite3_stmt *st = NULL;

    int i;

    (void) root;

    if ((db == NULL) || (r == NULL)) {
        return;
    }

    for (i = 0; i < r->count; i++) {

        flat_t *f = &r->flat[i];

        int new_state = 0;

        int previous_state = 0;

        int toggle_count = 0;
        int has_previous = 0;
        state_cache_entry_t *cached = NULL;

        long duration_ms = 0;

        char last_used[128] = "";

        if (!should_track_state_field(r, f)) {
            continue;
        }

        new_state = (f->num > 0.5) ? 1 : 0;

        cached = find_state_cache(r->device, f->key);

        if (cached != NULL) {
            has_previous = 1;
            previous_state = cached->state;
            toggle_count = cached->toggle_count;
            snprintf(last_used, sizeof(last_used), "%s", cached->last_used);
        } else {
            if (sqlite3_prepare_v2(

                db,

                "SELECT "
                "button_state,"
                "toggle_count,"
                "last_used "

                "FROM device_state "

                "WHERE device_name=? "
                "AND button_name=? "

                "ORDER BY id DESC "
                "LIMIT 1",

                -1,
                &st,
                NULL
            ) != SQLITE_OK) {
                st = NULL;
                continue;
            }

            sqlite3_bind_text(st, 1, r->device, -1, SQLITE_TRANSIENT);
            sqlite3_bind_text(st, 2, f->key, -1, SQLITE_TRANSIENT);

            if (sqlite3_step(st) == SQLITE_ROW) {
                has_previous = 1;

                previous_state =
                    sqlite3_column_int(st, 0);

                toggle_count =
                    sqlite3_column_int(st, 1);

                snprintf(
                    last_used,
                    sizeof(last_used),
                    "%s",
                    sqlite3_column_text(st, 2)
                        ? (const char*)sqlite3_column_text(st, 2)
                        : ""
                );
            }

            sqlite3_finalize(st);
            st = NULL;

            cached = add_state_cache(r->device, f->key);
            if (cached != NULL) {
                cached->state = previous_state;
                cached->toggle_count = toggle_count;
                snprintf(cached->last_used,
                         sizeof(cached->last_used),
                         "%s",
                         last_used);
            }
        }

        /*
        ------------------------------------
        IGNORE DUPLICATES
        ------------------------------------
        */

        if (has_previous && previous_state == new_state) {
            continue;
        }

        if (has_previous) {
            toggle_count++;
        }

        /*
        ------------------------------------
        DURATION CALCULATION
        ------------------------------------
        */

        if (
            previous_state == 1 &&
            new_state == 0 &&
            last_used[0] != '\0'
        ) {

            time_t prev =
                parse_db_timestamp(last_used);

            duration_ms =
                (long)(difftime(time(NULL), prev) * 1000.0);
        }

        /*
        ------------------------------------
        INSERT DEVICE STATE
        ------------------------------------
        */

        if (sqlite3_prepare_v2(

            db,

            "INSERT INTO device_state("
            "device_name,"
            "button_name,"
            "button_state,"
            "toggle_count,"
            "last_used,"
            "session_id,"
            "alive,"
            "uptime_seconds,"
            "last_heartbeat,"
            "raw_value"
            ") VALUES(?,?,?,?,?,?,?,?,?,?)",

            -1,
            &st,
            NULL
        ) != SQLITE_OK) {
            st = NULL;
            continue;
        }

        sqlite3_bind_text(st, 1, r->device, -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(st, 2, f->key, -1, SQLITE_TRANSIENT);
        sqlite3_bind_int(st, 3, new_state);
        sqlite3_bind_int(st, 4, toggle_count);
        sqlite3_bind_text(st, 5, r->ts, -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(st, 6, r->session_id, -1, SQLITE_TRANSIENT);
        sqlite3_bind_int(st, 7, 1);
        sqlite3_bind_int(st, 8, (int)(duration_ms / 1000));
        sqlite3_bind_text(st, 9, r->ts, -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(st, 10, "", -1, SQLITE_TRANSIENT);

        /* Execute or advance the prepared SQLite statement so the requested telemetry row is written or read. */
        sqlite3_step(st);

        sqlite3_finalize(st);

        if (cached != NULL) {
            cached->state = new_state;
            cached->toggle_count = toggle_count;
            snprintf(cached->last_used,
                     sizeof(cached->last_used),
                     "%s",
                     r->ts);
        }

        /*
        ------------------------------------
        INSERT EVENT LOG
        ------------------------------------
        */

        if (sqlite3_prepare_v2(

            db,

            "INSERT INTO hmi_event_log("
            "timestamp,"
            "device_name,"
            "control_name,"
            "previous_state,"
            "new_state,"
            "toggle_count,"
            "on_duration_ms,"
            "session_id,"
            "event_type,"
            "raw_value"
            ") VALUES(?,?,?,?,?,?,?,?,?,?)",

            -1,
            &st,
            NULL
        ) != SQLITE_OK) {
            st = NULL;
            continue;
        }

        sqlite3_bind_text(st, 1, r->ts, -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(st, 2, r->device, -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(st, 3, f->key, -1, SQLITE_TRANSIENT);
        sqlite3_bind_int(st, 4, previous_state);
        sqlite3_bind_int(st, 5, new_state);
        sqlite3_bind_int(st, 6, toggle_count);
        sqlite3_bind_int64(st, 7, duration_ms);
        sqlite3_bind_text(st, 8, r->session_id, -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(st, 9, "STATE_CHANGE", -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(st, 10, "", -1, SQLITE_TRANSIENT);

        /* Execute or advance the prepared SQLite statement so the requested telemetry row is written or read. */
        sqlite3_step(st);

        sqlite3_finalize(st);

        /*
        ------------------------------------
        TXT LOG
        ------------------------------------
        */

        write_hmi_txt_log(

            r->ts,
            r->device,
            f->key,
            previous_state,
            new_state,
            toggle_count,
            duration_ms,
            r->session_id
        );
    }

}

static char *dup_string(const char *s) {
    size_t len;
    char *copy;

    if (s == NULL) return NULL;

    len = strlen(s);
    copy = (char *)malloc(len + 1U);

    if (copy == NULL) return NULL;

    memcpy(copy, s, len + 1U);
    return copy;
}

/* Spool wire format (little-endian host representation, local recovery only):
 * file header "TSP1"; then repeated records containing four uint32 lengths
 * (channel, source IP, JSON, source port), followed by those byte strings and
 * a CRC-32 over the four integers and payload bytes.  A complete batch is
 * written to a new .tmp file, flushed to stable storage, then atomically
 * renamed to .ready.  Replay is filename order; corrupt records are quarantined. */
static uint32_t spool_crc32_update(uint32_t crc, const void *data, size_t size) {
    const unsigned char *p = (const unsigned char *)data;
    size_t i; int bit;
    crc = ~crc;
    for (i = 0U; i < size; ++i) {
        crc ^= p[i];
        for (bit = 0; bit < 8; ++bit)
            crc = (crc >> 1) ^ (0xEDB88320U & (uint32_t)-(int)(crc & 1U));
    }
    return ~crc;
}

static bool spool_sync_file(FILE *file) {
    if ((file == NULL) || (fflush(file) != 0)) return false;
#ifdef _WIN32
    return FlushFileBuffers((HANDLE)_get_osfhandle(_fileno(file))) != 0;
#else
    return fsync(fileno(file)) == 0;
#endif
}

static uint64_t spool_usage_bytes(void) {
    uint64_t total = 0U;
#ifdef _WIN32
    WIN32_FIND_DATAA fd; HANDLE h; char pattern[640];
    snprintf(pattern, sizeof(pattern), "%s\\*.ready", g_spool_dir);
    h = FindFirstFileA(pattern, &fd);
    if (h != INVALID_HANDLE_VALUE) {
        do { ULARGE_INTEGER n; n.HighPart=fd.nFileSizeHigh; n.LowPart=fd.nFileSizeLow; total += n.QuadPart; }
        while (FindNextFileA(h, &fd));
        FindClose(h);
    }
#else
    DIR *dir = opendir(g_spool_dir); struct dirent *entry;
    if (dir != NULL) { while ((entry = readdir(dir)) != NULL) {
        char path[768]; size_t n=strlen(entry->d_name);
        if (n < 6U || strcmp(entry->d_name+n-6U, ".ready") != 0) continue;
        snprintf(path,sizeof(path),"%s/%s",g_spool_dir,entry->d_name); total += storage_file_size(path);
    } closedir(dir); }
#endif
    return total;
}

static bool spool_batch(ingest_msg_t *head, uint64_t count) {
    ingest_msg_t *msg; FILE *file = NULL; char tmp[768], ready[768];
    uint64_t estimate = 4U; uint64_t now = platform_monotonic_ms();
    for (msg=head; msg!=NULL; msg=msg->next) estimate += 28U + msg->payload_bytes + strlen(msg->channel) + strlen(msg->source_ip) + strlen(msg->ingest_id);
    platform_mutex_lock(&g_spool_mutex);
    g_spool_bytes = spool_usage_bytes();
    if ((estimate > g_spool_max_bytes) || (g_spool_bytes > g_spool_max_bytes-estimate)) {
        lock_ingest_queue(); g_packet_accounting.spool_capacity_drops += count; unlock_ingest_queue();
        if ((now < g_last_capacity_warning_ms) || (now-g_last_capacity_warning_ms >= 10000U)) {
            fprintf(stderr,"CRITICAL: telemetry spool capacity exhausted; explicitly dropping %llu packets\n",(unsigned long long)count);
            g_last_capacity_warning_ms=now;
        }
        platform_mutex_unlock(&g_spool_mutex);
        return false;
    }
    MKDIR(g_spool_dir);
    do {
        snprintf(tmp,sizeof(tmp),"%s/spool_%020llu_%010llu.tmp",g_spool_dir,(unsigned long long)time(NULL),(unsigned long long)++g_spool_serial);
        snprintf(ready,sizeof(ready),"%.*s.ready",(int)(strlen(tmp)-4U),tmp);
    } while (storage_file_size(tmp) > 0U || storage_file_size(ready) > 0U);
    file=fopen(tmp,"wb"); if(file==NULL) { platform_mutex_unlock(&g_spool_mutex); return false; }
    if(fwrite("TSP2",1U,4U,file)!=4U){fclose(file);remove(tmp);platform_mutex_unlock(&g_spool_mutex);return false;}
    for(msg=head;msg!=NULL;msg=msg->next){
        uint32_t lens[5]={(uint32_t)strlen(msg->ingest_id),(uint32_t)strlen(msg->channel),(uint32_t)strlen(msg->source_ip),(uint32_t)strlen(msg->json),(uint32_t)msg->source_port};
        uint32_t crc=0U; crc=spool_crc32_update(crc,lens,sizeof(lens)); crc=spool_crc32_update(crc,msg->ingest_id,lens[0]); crc=spool_crc32_update(crc,msg->channel,lens[1]); crc=spool_crc32_update(crc,msg->source_ip,lens[2]); crc=spool_crc32_update(crc,msg->json,lens[3]);
        if(fwrite(lens,sizeof(lens),1U,file)!=1U || fwrite(msg->ingest_id,1U,lens[0],file)!=lens[0] || fwrite(msg->channel,1U,lens[1],file)!=lens[1] || fwrite(msg->source_ip,1U,lens[2],file)!=lens[2] || fwrite(msg->json,1U,lens[3],file)!=lens[3] || fwrite(&crc,sizeof(crc),1U,file)!=1U){fclose(file);remove(tmp);platform_mutex_unlock(&g_spool_mutex);return false;}
    }
    if(!spool_sync_file(file)){fclose(file);remove(tmp);platform_mutex_unlock(&g_spool_mutex);return false;}
    if(fclose(file)!=0){remove(tmp);platform_mutex_unlock(&g_spool_mutex);return false;}
    if(rename(tmp,ready)!=0){remove(tmp);platform_mutex_unlock(&g_spool_mutex);return false;}
#ifndef _WIN32
    {int directory_fd=open(g_spool_dir,O_RDONLY|O_DIRECTORY);if(directory_fd<0||fsync(directory_fd)!=0){
        if(directory_fd>=0)close(directory_fd);
        lock_ingest_queue();snprintf(g_db_last_error,sizeof(g_db_last_error),"spool segment synced but directory sync failed; persistence durability is uncertain");unlock_ingest_queue();
        fprintf(stderr,"CRITICAL: spool segment content synced but directory sync failed; retained segment for replay\n");
    }else close(directory_fd);}
#endif
    lock_ingest_queue(); g_packet_accounting.spooled += count; unlock_ingest_queue(); g_spool_bytes += estimate;
    platform_mutex_unlock(&g_spool_mutex);
    return true;
}

static ingest_msg_t *load_spool_file(const char *path, uint64_t *count_out) {
    FILE *file; char magic[4]; ingest_msg_t *head=NULL,*tail=NULL;uint64_t ordinal=0U;
    if (count_out != NULL) *count_out = 0U;
    file = fopen(path, "rb");
    if (file == NULL) return NULL;
    if(fread(magic,1U,4U,file)!=4U || (memcmp(magic,"TSP1",4U)!=0&&memcmp(magic,"TSP2",4U)!=0)){fclose(file);return NULL;}
    for(;;){
        uint32_t lens[5]={0U,0U,0U,0U,0U},stored_crc,crc=0U; ingest_msg_t *msg;bool v2=memcmp(magic,"TSP2",4U)==0;size_t header_bytes=v2?sizeof(lens):sizeof(uint32_t)*4U;
        size_t got=fread(lens,1U,header_bytes,file);
        if(got==0U && feof(file))break;
        if(got!=header_bytes){goto corrupt;}
        if(!v2){lens[4]=lens[3];lens[3]=lens[2];lens[2]=lens[1];lens[1]=lens[0];lens[0]=0U;}
        if(lens[0]>=128U || lens[1]>=64U || lens[2]>=64U || lens[3]>=MAX_JSON){goto corrupt;}
        msg=(ingest_msg_t*)calloc(1U,sizeof(*msg)); if(msg==NULL)goto corrupt;
        msg->json=(char*)malloc((size_t)lens[3]+1U); if(msg->json==NULL){free(msg);goto corrupt;}
        if((v2&&fread(msg->ingest_id,1U,lens[0],file)!=lens[0]) || fread(msg->channel,1U,lens[1],file)!=lens[1] || fread(msg->source_ip,1U,lens[2],file)!=lens[2] || fread(msg->json,1U,lens[3],file)!=lens[3] || fread(&stored_crc,sizeof(stored_crc),1U,file)!=1U){free(msg->json);free(msg);goto corrupt;}
        msg->ingest_id[lens[0]]='\0';msg->channel[lens[1]]='\0';msg->source_ip[lens[2]]='\0';msg->json[lens[3]]='\0';msg->source_port=(int)lens[4];msg->payload_bytes=(size_t)lens[3]+1U;
        if(!v2)snprintf(msg->ingest_id,sizeof(msg->ingest_id),"legacy-%08x-%020llu",spool_crc32_update(0U,path,strlen(path)),(unsigned long long)ordinal);
        if(v2){crc=spool_crc32_update(crc,lens,sizeof(lens));crc=spool_crc32_update(crc,msg->ingest_id,lens[0]);crc=spool_crc32_update(crc,msg->channel,lens[1]);crc=spool_crc32_update(crc,msg->source_ip,lens[2]);crc=spool_crc32_update(crc,msg->json,lens[3]);}
        else {uint32_t old_lens[4]={lens[1],lens[2],lens[3],lens[4]};crc=spool_crc32_update(crc,old_lens,sizeof(old_lens));crc=spool_crc32_update(crc,msg->channel,lens[1]);crc=spool_crc32_update(crc,msg->source_ip,lens[2]);crc=spool_crc32_update(crc,msg->json,lens[3]);}
        if(crc!=stored_crc){free(msg->json);free(msg);goto corrupt;}
        if(tail!=NULL)tail->next=msg;else head=msg;tail=msg;if(count_out!=NULL)(*count_out)++;ordinal++;
    }
    fclose(file);return head;
corrupt:
    fclose(file);while(head!=NULL){ingest_msg_t*n=head->next;free(head->json);free(head);head=n;}return NULL;
}

/* Recover a fully written segment left between file sync and atomic rename. */
static void recover_spool_tmp_files(void) {
#ifdef _WIN32
    WIN32_FIND_DATAA fd; HANDLE handle; char pattern[640];
    snprintf(pattern, sizeof(pattern), "%s\\*.tmp", g_spool_dir);
    handle = FindFirstFileA(pattern, &fd);
    if (handle == INVALID_HANDLE_VALUE) return;
    do {
        char path[768], destination[800]; uint64_t count = 0U; ingest_msg_t *head, *msg;
        snprintf(path, sizeof(path), "%s/%s", g_spool_dir, fd.cFileName);
        head = load_spool_file(path, &count);
        snprintf(destination, sizeof(destination), "%.*s.%s", (int)(strlen(path)-4U), path, head != NULL ? "ready" : "corrupt");
        if (head != NULL) {
            if (rename(path, destination) != 0) fprintf(stderr, "CRITICAL: recovered spool segment could not be renamed: %s\n", path);
            else fprintf(stderr, "Recovered durable telemetry spool segment: %s (%llu packets)\n", destination, (unsigned long long)count);
            while (head != NULL) { msg=head->next; free(head->json); free(head); head=msg; }
        } else {
            (void)rename(path, destination);
            fprintf(stderr, "CRITICAL: incomplete telemetry spool segment quarantined: %s\n", destination);
        }
    } while (FindNextFileA(handle, &fd));
    FindClose(handle);
#else
    DIR *dir = opendir(g_spool_dir); struct dirent *entry;
    if (dir == NULL) return;
    while ((entry = readdir(dir)) != NULL) {
        size_t name_len = strlen(entry->d_name); char path[768], destination[800];
        uint64_t count = 0U; ingest_msg_t *head, *msg;
        if (name_len < 4U || strcmp(entry->d_name + name_len - 4U, ".tmp") != 0) continue;
        snprintf(path, sizeof(path), "%s/%s", g_spool_dir, entry->d_name);
        head = load_spool_file(path, &count);
        snprintf(destination, sizeof(destination), "%.*s.%s", (int)(strlen(path)-4U), path, head != NULL ? "ready" : "corrupt");
        if (head != NULL) {
            if (rename(path, destination) != 0) fprintf(stderr, "CRITICAL: recovered spool segment could not be renamed: %s\n", path);
            else fprintf(stderr, "Recovered durable telemetry spool segment: %s (%llu packets)\n", destination, (unsigned long long)count);
            while (head != NULL) { msg=head->next; free(head->json); free(head); head=msg; }
        } else {
            (void)rename(path, destination);
            fprintf(stderr, "CRITICAL: incomplete telemetry spool segment quarantined: %s\n", destination);
        }
    }
    closedir(dir);
#endif
}

static bool oldest_spool_path(char *out,size_t out_size) {
    out[0]='\0';
#ifdef _WIN32
    WIN32_FIND_DATAA fd;HANDLE h;char pattern[640];snprintf(pattern,sizeof(pattern),"%s\\*.ready",g_spool_dir);h=FindFirstFileA(pattern,&fd);
    if(h!=INVALID_HANDLE_VALUE){do{if(out[0]=='\0'||strcmp(fd.cFileName,strrchr(out,'/')?strrchr(out,'/')+1:out)<0)snprintf(out,out_size,"%s/%s",g_spool_dir,fd.cFileName);}while(FindNextFileA(h,&fd));FindClose(h);}
#else
    DIR*dir=opendir(g_spool_dir);struct dirent*e;if(dir!=NULL){while((e=readdir(dir))!=NULL){size_t n=strlen(e->d_name);if(n>=6U&&strcmp(e->d_name+n-6U,".ready")==0&&(out[0]=='\0'||strcmp(e->d_name,strrchr(out,'/')+1)<0))snprintf(out,out_size,"%s/%s",g_spool_dir,e->d_name);}closedir(dir);}
#endif
    return out[0]!='\0';
}

/**
 * @brief Acquire the mutex protecting the ingest queue and persistence counters.
 */
static void lock_ingest_queue(void) {
#ifdef _WIN32
    WaitForSingleObject(g_ingest_mutex, INFINITE);
#else
    /* Acquire the protecting mutex before touching shared telemetry state so concurrent threads cannot corrupt it. */
    pthread_mutex_lock(&g_ingest_mutex);
#endif
}

/**
 * @brief Release the ingest queue mutex.
 */
static void unlock_ingest_queue(void) {
#ifdef _WIN32
    ReleaseMutex(g_ingest_mutex);
#else
    /* Release the protecting mutex after the shared update so other telemetry threads can proceed. */
    pthread_mutex_unlock(&g_ingest_mutex);
#endif
}

/**
 * @brief Increment the persistence-failure counter and retain its latest message.
 * @param message Diagnostic message retained for the latest failure.
 */
static void record_db_store_failure(const char *message) {
    lock_ingest_queue();
    g_db_store_failures++;
    if ((message != NULL) && (message[0] != '\0')) {
        snprintf(g_db_last_error, sizeof(g_db_last_error), "%s", message);
    }
    unlock_ingest_queue();
}

/**
 * @brief Increment the database retry counter.
 */
static void record_db_store_retry(void) {
    lock_ingest_queue();
    g_db_store_retries++;
    unlock_ingest_queue();
}

static void write_emergency_packet(const ingest_msg_t *msg) {
    FILE *file;
    char ts[64];
    bool durable;
    if ((msg == NULL) || (msg->json == NULL)) return;
    MKDIR("logs");
    file = fopen("logs/emergency_telemetry.jsonl", "a");
    if (file == NULL) return;
    now_timestamp(ts, sizeof(ts));
    durable = fprintf(file,
            "{\"timestamp\":\"%s\",\"channel\":\"%s\","
            "\"source_ip\":\"%s\",\"source_port\":%d,\"payload\":%s}\n",
            ts, msg->channel, msg->source_ip, msg->source_port, msg->json) >= 0;
    if (durable) durable = spool_sync_file(file);
    if (fclose(file) != 0) durable = false;
    if (!durable) {
        fprintf(stderr,"CRITICAL: emergency telemetry append was not confirmed durable\n");
        return;
    }
    lock_ingest_queue();
    g_emergency_log_packets++;
    unlock_ingest_queue();
}

/* ================= Asynchronous ingest and live queues ================= */

/**
 * @brief Copy an accepted packet into the bounded asynchronous persistence queue.
 * @param channel Receiving or canonical telemetry channel.
 * @param src_ip Textual source IPv4 address.
 * @param src_port Source UDP port in host byte order.
 */
static bool enqueue_ingest_record(const char *json,
                                  const char *channel,
                                  const char *src_ip,
                                  int src_port) {
    ingest_msg_t *msg;
    size_t payload_bytes;
    unsigned int lane;

    if ((json == NULL) || (channel == NULL)) return false;

    payload_bytes = strlen(json) + 1U;
    msg = (ingest_msg_t *)calloc(1U, sizeof(*msg));
    if (msg == NULL) {
        lock_ingest_queue();
        g_ingest_dropped++;
        g_packet_accounting.dropped++;
        snprintf(g_db_last_error,
                 sizeof(g_db_last_error),
                 "ingest queue allocation failed");
        unlock_ingest_queue();
        return false;
    }

    msg->json = dup_string(json);
    if (msg->json == NULL) {
        lock_ingest_queue();
        g_ingest_dropped++;
        g_packet_accounting.dropped++;
        snprintf(g_db_last_error,
                 sizeof(g_db_last_error),
                 "ingest queue payload allocation failed");
        unlock_ingest_queue();
        free(msg);
        return false;
    }

    snprintf(msg->channel, sizeof(msg->channel), "%s", channel);
    snprintf(msg->source_ip,
             sizeof(msg->source_ip),
             "%s",
             src_ip != NULL ? src_ip : "");
    msg->source_port = src_port;
    msg->queued_ms = platform_monotonic_ms();
    msg->payload_bytes = payload_bytes;
    lane = ingest_lane_for_route(channel);

    {
        bool has_capacity, queue_has_capacity;
        bool spool_reservation = false;

        lock_ingest_queue();
        snprintf(msg->ingest_id,sizeof(msg->ingest_id),"%s-%020llu",g_session_id,(unsigned long long)++g_ingest_id_serial);
        queue_has_capacity =
            (g_ingest_queue_len < INGEST_QUEUE_MAX) &&
            (payload_bytes <= INGEST_QUEUE_MAX_BYTES) &&
            (g_ingest_queue_bytes <=
             (INGEST_QUEUE_MAX_BYTES - payload_bytes));
        has_capacity = !g_spool_ordering_active && queue_has_capacity;

        if (!has_capacity) {
            g_ingest_backpressure_events++;
            if (!queue_has_capacity) g_packet_accounting.queue_overflow++;
            g_spool_ordering_active = true;
            g_spool_writers++;
            spool_reservation = true;
            unlock_ingest_queue();
            /* Queue saturation is backpressure: preserve this already accepted
             * packet on the durable spool instead of discarding it. */
            if (spool_batch(msg, 1U)) {
                lock_ingest_queue();
                g_packet_accounting.queued++;
                if (spool_reservation && g_spool_writers > 0U) g_spool_writers--;
                unlock_ingest_queue();
                free(msg->json);
                free(msg);
                return true;
            }
            lock_ingest_queue();
            g_ingest_dropped++;
            g_packet_accounting.dropped++;
            if (spool_reservation && g_spool_writers > 0U) g_spool_writers--;
            snprintf(g_db_last_error, sizeof(g_db_last_error),
                     "database queue full and durable spool unavailable; packet was not retained");
            unlock_ingest_queue();
            write_emergency_packet(msg);
            free(msg->json);
            free(msg);
            return false;
        }
    }

    if (g_ingest_tails[lane] != NULL) {
        g_ingest_tails[lane]->next = msg;
    } else {
        g_ingest_heads[lane] = msg;
    }
    g_ingest_tails[lane] = msg;
    g_ingest_lane_len[lane]++;
    g_ingest_queue_len++;
    g_ingest_queue_bytes += payload_bytes;
    g_packet_accounting.queued++;
    if((uint64_t)g_ingest_queue_len>g_packet_accounting.max_queue_depth)g_packet_accounting.max_queue_depth=(uint64_t)g_ingest_queue_len;

    unlock_ingest_queue();
    return true;
}

static ingest_msg_t *pop_ingest_record(void) {
    ingest_msg_t *msg;
    unsigned int checked;
    unsigned int lane = 0U;

    lock_ingest_queue();
    msg = NULL;
    for (checked = 0U; checked < INGEST_QUEUE_LANES; ++checked) {
        lane = (g_ingest_next_lane + checked) % INGEST_QUEUE_LANES;
        if (g_ingest_heads[lane] != NULL) {
            msg = g_ingest_heads[lane];
            g_ingest_next_lane = (lane + 1U) % INGEST_QUEUE_LANES;
            break;
        }
    }
    if (msg != NULL) {
        g_ingest_heads[lane] = msg->next;
        if (g_ingest_tails[lane] == msg) g_ingest_tails[lane] = NULL;
        if (g_ingest_lane_len[lane] > 0) g_ingest_lane_len[lane]--;
        msg->next = NULL;
        g_ingest_queue_len--;
        if (g_ingest_queue_bytes >= msg->payload_bytes) {
            g_ingest_queue_bytes -= msg->payload_bytes;
        } else {
            g_ingest_queue_bytes = 0U;
        }
        if ((g_ingest_queue_len < (INGEST_QUEUE_MAX / 2)) &&
            (strncmp(g_db_last_error,
                     "database writer behind;",
                     strlen("database writer behind;")) == 0)) {
            g_db_last_error[0] = '\0';
        }
    }
    unlock_ingest_queue();

    return msg;
}

/**
 * @brief Atomically copy queue, backpressure, persistence, and error diagnostics.
 * @param queue_len Optional output for the current queue length.
 * @param queue_bytes Optional output for queued payload bytes.
 * @param backpressure_events Optional output for cumulative backpressure events.
 * @param dropped Optional output for cumulative dropped packets.
 * @param stored Optional output for successfully committed packets.
 * @param pending Optional output for packets awaiting commit.
 * @param db_failures Optional output for persistence failures.
 * @param db_retries Optional output for persistence retry attempts.
 * @param last_error Optional destination for the latest persistence error.
 * @param last_error_len Capacity of the latest-error destination.
 */
static void ingest_queue_snapshot(int *queue_len,
                                  size_t *queue_bytes,
                                  uint64_t *backpressure_events,
                                  uint64_t *dropped,
                                  uint64_t *stored,
                                  uint64_t *pending,
                                  uint64_t *db_failures,
                                  uint64_t *db_retries,
                                  char *last_error,
                                  size_t last_error_len) {
    lock_ingest_queue();
    if (queue_len != NULL) *queue_len = g_ingest_queue_len;
    if (queue_bytes != NULL) *queue_bytes = g_ingest_queue_bytes;
    if (backpressure_events != NULL) {
        *backpressure_events = g_ingest_backpressure_events;
    }
    if (dropped != NULL) *dropped = g_ingest_dropped;
    if (stored != NULL) *stored = g_db_store_success;
    if (pending != NULL) *pending = g_db_store_pending;
    if (db_failures != NULL) *db_failures = g_db_store_failures;
    if (db_retries != NULL) *db_retries = g_db_store_retries;
    if ((last_error != NULL) && (last_error_len > 0U)) {
        snprintf(last_error, last_error_len, "%s", g_db_last_error);
    }
    unlock_ingest_queue();
}

/**
 * @brief Queue a heap-owned live update and discard oldest GUI data at the configured limit.
 */
static void enqueue_live_update(const char *json) {
    ws_msg_t *msg;

    if (json == NULL) return;

    msg = (ws_msg_t *)calloc(1U, sizeof(*msg));
    if (msg == NULL) return;

    msg->json = dup_string(json);
    if (msg->json == NULL) {
        free(msg);
        return;
    }

    lock_ws_queue();

    while (g_ws_queue_len >= WS_QUEUE_MAX && g_ws_head != NULL) {
        ws_msg_t *old = g_ws_head;
        g_ws_head = old->next;
        if (g_ws_tail == old) g_ws_tail = NULL;
        free(old->json);
        free(old);
        g_ws_queue_len--;
        g_ws_dropped++;
    }

    if (g_ws_tail != NULL) {
        g_ws_tail->next = msg;
    } else {
        g_ws_head = msg;
    }

    g_ws_tail = msg;
    g_ws_queue_len++;

    unlock_ws_queue();
}

static ws_msg_t *pop_live_update(void) {
    ws_msg_t *msg;

    lock_ws_queue();

    msg = g_ws_head;

    if (msg != NULL) {
        g_ws_head = msg->next;
        if (g_ws_tail == msg) g_ws_tail = NULL;
        msg->next = NULL;
        g_ws_queue_len--;
    }

    unlock_ws_queue();

    return msg;
}

/**
 * @brief Send one live telemetry message to every connected WebSocket client.
 * @param manager Active Mongoose event manager.
 */
static void broadcast_live_update(struct mg_mgr *manager,
                                  const char *json) {

    struct mg_connection *wc;

    if ((manager == NULL) || (json == NULL)) return;

    for (wc = manager->conns; wc != NULL; wc = wc->next) {

        if (wc->is_websocket) {

            if (mg_ws_send(
                wc,
                json,
                strlen(json),
                WEBSOCKET_OP_TEXT
            ) > 0U) {
                g_ws_delivered++;
                update_pipeline_stats(0U, 0U, 0U, 0U, 0U, 0U, 1U);
            }
        }
    }
}

/**
 * @brief Deliver a bounded number of queued live messages during one event-loop iteration.
 * @param manager Active Mongoose event manager.
 */
static void drain_live_updates(struct mg_mgr *manager) {
    int sent = 0;

    while (sent < 512) {
        ws_msg_t *msg = pop_live_update();

        if (msg == NULL) break;

        broadcast_live_update(manager, msg->json);

        free(msg->json);
        free(msg);
        sent++;
    }
}

/**
 * @brief Parse, classify, normalize, and batch one accepted packet into SQLite.
 * @param channel Receiving or canonical telemetry channel.
 * @param src_ip Textual source IPv4 address.
 * @param src_port Source UDP port in host byte order.
 * @note Requires the database mutex to be held unless the function acquires it explicitly.
 */
static bool insert_record(const char *json,
                          const char *channel,
                          const char *src_ip,
                          int src_port,
                          const char *ingest_id) {

    sqlite3 *db = NULL;
    sqlite3_stmt *st = NULL;
    cJSON *root = NULL;
    static record_t r; /* Single-writer reusable workspace; avoids ~400 KiB stack use. */
    int i;
    int idx;
    sqlite3_int64 device_packet_id = 0;
    char device_table[1024];
    double device_epoch_ms = 0.0;
    static char cols[TELEMETRY_INSERT_COLS_MAX];
    static char vals[TELEMETRY_INSERT_VALS_MAX];
    static char sql[TELEMETRY_INSERT_SQL_MAX];
    const char *forced_failure = getenv("TELEMETRY_FORCE_DB_FAILURE");

    lock_ingest_queue(); g_packet_accounting.db_attempted++; unlock_ingest_queue();
    g_last_db_rc = SQLITE_OK;
    if (json == NULL) {
        record_db_store_failure("empty json passed to insert_record");
        return false;
    }

    root = cJSON_Parse(json);

    if ((root == NULL) || (!cJSON_IsObject(root))) {
        if (root != NULL) {
            cJSON_Delete(root);
        }

        record_db_store_failure("accepted packet could not be parsed as JSON");
        lock_ingest_queue(); g_packet_accounting.parse_failed++; g_packet_accounting.dropped++; unlock_ingest_queue();
        g_last_db_rc = SQLITE_MISMATCH;
        return false;
    }

    lock_ingest_queue();
    g_packet_accounting.parsed++;
    unlock_ingest_queue();

    normalize_pan_tilt_values(root);

    if ((channel != NULL) && (strcmp(channel, "imu") == 0)) {
        normalize_imu_payload(root);
    }

    memset(&r, 0, sizeof(r));
    r.latency_ms = 0.0;

    now_timestamp(r.ts, sizeof(r.ts));

    snprintf(r.server_rx_ts,
             sizeof(r.server_rx_ts),
             "%s",
             r.ts);

    (void)extract_device_timestamp(root,
                                   r.device_ts,
                                   sizeof(r.device_ts),
                                   &device_epoch_ms);

    snprintf(r.packet_ts,
             sizeof(r.packet_ts),
             "%s",
             json_get_string(root,
                             "packet_ts",
                             NULL,
                             json_find_string_deep(root,
                                                   "packet_ts",
                                                   "packet_time")));

    if ((r.packet_ts[0] == '\0') && (r.device_ts[0] != '\0')) {
        snprintf(r.packet_ts, sizeof(r.packet_ts), "%s", r.device_ts);
    }

    {
        cJSON *lat =
            cJSON_GetObjectItemCaseSensitive(root,
                                             "latency_ms");

        if (cJSON_IsNumber(lat)) {
            r.latency_ms = lat->valuedouble;
        }
    }

    if (device_epoch_ms > 0.0) {
        r.latency_ms = ((double)time(NULL) * 1000.0) - device_epoch_ms;
    }

    snprintf(r.session_id,
             sizeof(r.session_id),
             "%s",
             json_get_string(root,
                             "session_id",
                             "id",
                             json_get_string(root,
                                              "session",
                                              NULL,
                                              g_session_id)));

          {
        const char *payload_channel = json_get_string(root, "channel_name", "channel", "");
        if (payload_channel[0] == '\0')
            payload_channel = json_find_string_deep(root, "channel_name", "channel");
        if (payload_channel[0] == '\0')
            payload_channel = channel ? channel : "unknown";
        const char *classification_channel =
            ((channel != NULL) && (strcmp(channel, "drive_wcs") == 0))
                ? "drive_wcs"
                : payload_channel;                                
        const char *    strict_channel =
            strict_channel_for_record(root,
                                      classification_channel,
                                      channel);

        if (strict_channel == NULL) {
            strict_channel =
                (classification_channel != NULL &&
                 classification_channel[0] != '\0')
                    ? classification_channel
                    : "unknown";
        }

        snprintf(r.channel,
                 sizeof(r.channel),
                 "%s",
                 strict_channel);
    }

    {
        const char *raw_device = json_get_string(root, "device_name", "device", "");
        const char *raw_process = json_get_string(root, "process_name", "process", "");
        if (raw_device[0] == '\0')
            raw_device = json_find_string_deep(root, "device_name", "device");
        if (raw_device[0] == '\0') raw_device = device_from_channel(r.channel);
        if (raw_process[0] == '\0')
            raw_process = json_find_string_deep(root, "process_name", "process");
        const char *src =
            json_find_string_deep(root, "src", "source");
        const char *strict_device =
            strict_device_for_channel(r.channel,
                                      raw_device,
                                      raw_process,
                                      src,
                                      root);

        snprintf(r.device,
                 sizeof(r.device),
                 "%s",
                 strict_device != NULL
                     ? strict_device
                     : normalize_device_name(raw_device));
    }

    snprintf(r.subdevice,
             sizeof(r.subdevice),
             "%s",
             json_get_string(root,
                             "subdevice_name",
                             "subdevice",
                             json_get_string(root,
                                             "type",
                                             NULL,
                                             "")));

    snprintf(r.process,
             sizeof(r.process),
             "%s",
             process_from_channel(root, r.channel));

    snprintf(r.subprocess,
             sizeof(r.subprocess),
             "%s",
             json_get_string(root,
                             "subprocess_name",
                             "subprocess",
                             ""));

    snprintf(r.reason,
             sizeof(r.reason),
             "%s",
             json_get_string(root,
                             "reason",
                             NULL,
                             ""));

    r.anomaly = json_get_boolint(root, "anomaly");

    flatten_json(&r, root, "");
    add_named_value_flat(&r, root);
    canonicalize_flat_fields(&r);

    lock_db();

    if(storage_is_low_cached()){unlock_db();cJSON_Delete(root);record_db_store_failure("insufficient free space for daily database");g_last_db_rc=SQLITE_FULL;return false;}

    if (open_writer_db_locked(&db) != 0) {
        unlock_db();
        cJSON_Delete(root);
        record_db_store_failure("open writer database failed");
        return false;
    }

    if (begin_writer_batch_locked(db) != 0) {
        close_writer_db_locked(true);
        unlock_db();
        cJSON_Delete(root);
        record_db_store_failure("begin writer transaction failed");
        return false;
    }

    if(ingest_id!=NULL&&ingest_id[0]!='\0'){
        sqlite3_stmt *duplicate=g_writer_ingest_lookup_stmt;int duplicate_rc;
        sqlite3_reset(duplicate);sqlite3_clear_bindings(duplicate);sqlite3_bind_text(duplicate,1,ingest_id,-1,SQLITE_TRANSIENT);duplicate_rc=sqlite3_step(duplicate);sqlite3_reset(duplicate);sqlite3_clear_bindings(duplicate);
        if(duplicate_rc==SQLITE_ROW){unlock_db();cJSON_Delete(root);return true;}
        if(duplicate_rc!=SQLITE_DONE){close_writer_db_locked(true);unlock_db();cJSON_Delete(root);record_db_store_failure("ingest id lookup step failed");return false;}
    }

    update_device_state(db, &r, root);

    if (!store_device_packet(db, &r, json, src_ip, src_port,
                             &device_packet_id, device_table,
                             sizeof(device_table))) {
        close_writer_db_locked(true);
        unlock_db();
        cJSON_Delete(root);
        record_db_store_failure("device shard packet insert failed");
        return false;
    }
    {
        sqlite3_stmt *registry=g_writer_registry_stmt;
        sqlite3_reset(registry);sqlite3_clear_bindings(registry);
        sqlite3_bind_text(registry,1,r.device,-1,SQLITE_TRANSIENT);sqlite3_bind_text(registry,2,r.channel,-1,SQLITE_TRANSIENT);sqlite3_bind_text(registry,3,device_table,-1,SQLITE_TRANSIENT);sqlite3_bind_text(registry,4,r.ts,-1,SQLITE_TRANSIENT);sqlite3_bind_text(registry,5,r.ts,-1,SQLITE_TRANSIENT);
        if (sqlite3_step(registry) != SQLITE_DONE) {
            sqlite3_reset(registry);sqlite3_clear_bindings(registry);
            close_writer_db_locked(true);
            unlock_db();
            cJSON_Delete(root);
            record_db_store_failure("device registry update failed");
            return false;
        }
        sqlite3_reset(registry);sqlite3_clear_bindings(registry);
    }
    if ((forced_failure != NULL) && (strcmp(forced_failure, "1") == 0)) {
        close_writer_db_locked(true); unlock_db(); cJSON_Delete(root);
        record_db_store_failure("forced packet transaction rollback"); return false;
    }

    /*
     * Build the wide telemetry INSERT dynamically.
     *
     * The base metadata columns are always present.
     * Every safe, dynamically discovered JSON field is appended as
     * a real telemetry column with its own bound parameter.
     *
     * raw_json remains the authoritative complete-packet copy.
     */
    snprintf(cols,
             sizeof(cols),
             "ingest_id,"
             "session_id,"
             "timestamp,"
             "server_rx_ts,"
             "device_ts,"
             "packet_ts,"
             "latency_ms,"
             "channel_name,"
             "source_ip,"
             "source_port,"
             "device_name,"
             "subdevice_name,"
             "process_name,"
             "subprocess_name,"
             "anomaly,"
             "reason,"
             "raw_json");

    snprintf(vals,
             sizeof(vals),
             "?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?");
    for (i = 0; i < r.count; ++i) {
        const char *column = r.flat[i].col;

        if (!telemetry_valid_dynamic_column_name(column)) {
            continue;
        }

        if (is_reserved_device_table_column(column)) {
            continue;
        }

        if (!telemetry_known_column(column)) {
            continue;
        }

        /*
         * Append the discovered physical column and one matching
         * parameter placeholder.
         *
         * Column names have already passed the strict identifier
         * validation above, so quoting them here is safe.
         */
        if (strlen(cols) + strlen(column) + 8 >= sizeof(cols)) {
            printf("wide telemetry column buffer exhausted at %s\n",
                   column);
            break;
        }

        if (strlen(vals) + 2 >= sizeof(vals)) {
            printf("wide telemetry value buffer exhausted at %s\n",
                   column);
            break;
        }

        strcat(cols, ",\"");
        strcat(cols, column);
        strcat(cols, "\"");

        strcat(vals, ",?");
    }
    snprintf(sql,
             sizeof(sql),
             "INSERT INTO telemetry(%s) VALUES(%s)",
             cols,
             vals);

    if (sqlite3_prepare_v2(db,
                           sql,
                           -1,
                           &st,
                           NULL) != SQLITE_OK) {
        printf("wide telemetry prepare failed: %s\n",
               sqlite3_errmsg(db));

        close_writer_db_locked(true);
        unlock_db();
        cJSON_Delete(root);
        record_db_store_failure("wide telemetry insert prepare failed");
        return false;
    }

    idx = 1;

    sqlite3_bind_text(st, idx++, ingest_id != NULL ? ingest_id : "", -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(st, idx++, r.session_id, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(st, idx++, r.ts, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(st, idx++, r.server_rx_ts, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(st, idx++, r.device_ts, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(st, idx++, r.packet_ts, -1, SQLITE_TRANSIENT);
    sqlite3_bind_double(st, idx++, r.latency_ms);
    sqlite3_bind_text(st, idx++, r.channel, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(st, idx++, src_ip ? src_ip : "", -1, SQLITE_TRANSIENT);
    sqlite3_bind_int(st, idx++, src_port);
    sqlite3_bind_text(st, idx++, r.device, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(st, idx++, r.subdevice, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(st, idx++, r.process, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(st, idx++, r.subprocess, -1, SQLITE_TRANSIENT);
    sqlite3_bind_int(st, idx++, r.anomaly);
    sqlite3_bind_text(st, idx++, r.reason, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(st, idx++, json, -1, SQLITE_TRANSIENT);

    /*
     * Bind the same dynamic fields that were appended to cols/vals above.
     *
     * The order must exactly match the order used while constructing
     * the INSERT statement.
     */
    for (i = 0; i < r.count; ++i) {
        const char *column = r.flat[i].col;

        if (!telemetry_valid_dynamic_column_name(column)) {
            continue;
        }

        if (is_reserved_device_table_column(column)) {
            continue;
        }

        if (!telemetry_known_column(column)) {
            continue;
        }

        if (strcmp(r.flat[i].type, "REAL") == 0) {
            sqlite3_bind_double(st,
                                idx++,
                                r.flat[i].num);
        } else {
            sqlite3_bind_text(st,
                              idx++,
                              r.flat[i].text,
                              -1,
                              SQLITE_TRANSIENT);
        }
    }

    if (sqlite3_step(st) != SQLITE_DONE) {
        printf("wide telemetry insert failed: %s\n",
               sqlite3_errmsg(db));

        sqlite3_finalize(st);
        close_writer_db_locked(true);
        unlock_db();
        cJSON_Delete(root);
        record_db_store_failure("wide telemetry insert failed");
        return false;
    }

    sqlite3_finalize(st);
    st = NULL;

 /*
 * LOSSLESS FLATTENED STORAGE
 *
 * Database retention is independent from graph/index selection.
 * Every flattened scalar JSON field is stored in telemetry_rows.
 *
 * field_is_indexed() must never decide whether data is retained.
 * Indexing is only a GUI/query concern.
 */
if (g_insert_telemetry_rows_enabled != 0) {
    for (i = 0; i < r.count; ++i) {
        int ridx = 1;

        sqlite3_reset(g_writer_row_stmt);
        sqlite3_clear_bindings(g_writer_row_stmt);

        /*
         * telemetry_rows column order:
         *
         * 1  packet_id
         * 2  session_id
         * 3  timestamp
         * 4  server_rx_ts
         * 5  device_ts
         * 6  packet_ts
         * 7  channel_name
         * 8  source_ip
         * 9  source_port
         * 10 device_name
         * 11 subdevice_name
         * 12 process_name
         * 13 subprocess_name
         * 14 value_key
         * 15 value_type
         * 16 value_num
         * 17 value_text
         * 18 anomaly
         * 19 reason
         * 20 raw_json
         */

        sqlite3_bind_int64(
            g_writer_row_stmt,
            ridx++,
            device_packet_id
        );

        sqlite3_bind_text(
            g_writer_row_stmt,
            ridx++,
            r.session_id,
            -1,
            SQLITE_TRANSIENT
        );

        sqlite3_bind_text(
            g_writer_row_stmt,
            ridx++,
            r.ts,
            -1,
            SQLITE_TRANSIENT
        );

        sqlite3_bind_text(
            g_writer_row_stmt,
            ridx++,
            r.server_rx_ts,
            -1,
            SQLITE_TRANSIENT
        );

        sqlite3_bind_text(
            g_writer_row_stmt,
            ridx++,
            r.device_ts,
            -1,
            SQLITE_TRANSIENT
        );

        sqlite3_bind_text(
            g_writer_row_stmt,
            ridx++,
            r.packet_ts,
            -1,
            SQLITE_TRANSIENT
        );

        sqlite3_bind_text(
            g_writer_row_stmt,
            ridx++,
            r.channel,
            -1,
            SQLITE_TRANSIENT
        );

        sqlite3_bind_text(
            g_writer_row_stmt,
            ridx++,
            src_ip ? src_ip : "",
            -1,
            SQLITE_TRANSIENT
        );

        sqlite3_bind_int(
            g_writer_row_stmt,
            ridx++,
            src_port
        );

        sqlite3_bind_text(
            g_writer_row_stmt,
            ridx++,
            r.device,
            -1,
            SQLITE_TRANSIENT
        );

        sqlite3_bind_text(
            g_writer_row_stmt,
            ridx++,
            r.subdevice,
            -1,
            SQLITE_TRANSIENT
        );

        sqlite3_bind_text(
            g_writer_row_stmt,
            ridx++,
            r.process,
            -1,
            SQLITE_TRANSIENT
        );

        sqlite3_bind_text(
            g_writer_row_stmt,
            ridx++,
            r.subprocess,
            -1,
            SQLITE_TRANSIENT
        );

        sqlite3_bind_text(
            g_writer_row_stmt,
            ridx++,
            r.flat[i].col,
            -1,
            SQLITE_TRANSIENT
        );

        sqlite3_bind_text(
            g_writer_row_stmt,
            ridx++,
            strcmp(r.flat[i].type, "REAL") == 0
                ? "num"
                : "text",
            -1,
            SQLITE_TRANSIENT
        );

        if (strcmp(r.flat[i].type, "REAL") == 0) {
            sqlite3_bind_double(
                g_writer_row_stmt,
                ridx++,
                r.flat[i].num
            );

            sqlite3_bind_null(
                g_writer_row_stmt,
                ridx++
            );
        } else {
            sqlite3_bind_null(
                g_writer_row_stmt,
                ridx++
            );

            sqlite3_bind_text(
                g_writer_row_stmt,
                ridx++,
                r.flat[i].text,
                -1,
                SQLITE_TRANSIENT
            );
        }

        sqlite3_bind_int(
            g_writer_row_stmt,
            ridx++,
            r.anomaly
        );

        sqlite3_bind_text(
            g_writer_row_stmt,
            ridx++,
            r.reason,
            -1,
            SQLITE_TRANSIENT
        );

        sqlite3_bind_text(
            g_writer_row_stmt,
            ridx++,
            json != NULL ? json : "{}",
            -1,
            SQLITE_TRANSIENT
        );

        if (sqlite3_step(g_writer_row_stmt) != SQLITE_DONE) {
            printf(
                "telemetry_rows insert failed: %s\n",
                sqlite3_errmsg(db)
            );

            sqlite3_reset(g_writer_row_stmt);
            sqlite3_clear_bindings(g_writer_row_stmt);

            close_writer_db_locked(true);
            unlock_db();
            cJSON_Delete(root);

            record_db_store_failure(
                "telemetry_rows insert failed"
            );

            return false;
        }
    }

    sqlite3_reset(g_writer_row_stmt);
    sqlite3_clear_bindings(g_writer_row_stmt);
}

g_writer_batch_count++;
mark_db_packet_pending();

if (!commit_writer_batch_locked(false)) {
    unlock_db();
    cJSON_Delete(root);
    record_db_store_failure("writer commit failed");
    return false;
}

    if (g_udp_packet_log_enabled != 0) write_udp_packet_log(&r, json, src_ip, src_port);

    unlock_db();

    update_pipeline_stats(0U, 0U, 0U, 1U, 1U, 0U, 0U);
  cJSON_Delete(root);
return true;
}

/**
 * @brief Wrap a raw accepted packet with live metadata and queue it for WebSocket delivery.
 * @param channel Receiving or canonical telemetry channel.
 * @param src_ip Textual source IPv4 address.
 * @param src_port Source UDP port in host byte order.
 */
static void enqueue_immediate_live_packet(const record_t *record,
                                          cJSON *root,
                                          const char *src_ip,
                                          int src_port) {
    char *ws_json;
    char *payload_json;
    size_t ws_cap;

    if ((record == NULL) || (root == NULL)) return;
    payload_json = cJSON_PrintUnformatted(root);
    if (payload_json == NULL) {
        return;
    }

    ws_cap = strlen(payload_json) + 2048U;
    ws_json = (char *)malloc(ws_cap);
    if (ws_json != NULL) {
        snprintf(ws_json,
                 ws_cap,
                 "{"
                 "\"type\":\"telemetry\","
                 "\"device\":\"%s\","
                 "\"channel\":\"%s\","
                 "\"process\":\"%s\","
                 "\"timestamp\":\"%s\","
                 "\"server_rx_ts\":\"%s\","
                 "\"device_ts\":\"%s\","
                 "\"packet_ts\":\"%s\","
                 "\"latency_ms\":%.3f,"
                 "\"source_ip\":\"%s\","
                 "\"source_port\":%d,"
                 "\"payload\":%s"
                 "}",
                 record->device,
                 record->channel,
                 record->process,
                 record->packet_ts[0] != '\0' ? record->packet_ts : record->ts,
                 record->server_rx_ts,
                 record->device_ts,
                 record->packet_ts,
                 record->latency_ms,
                 src_ip != NULL ? src_ip : "",
                 src_port,
                 payload_json);
        enqueue_live_update(ws_json);
        free(ws_json);
    }

    cJSON_free(payload_json);
}

/* Publish accepted UDP independently of SQLite.
 * The persistence worker still performs authoritative normalization,
 * but storage faults cannot hide live data.
 *
 * IMPORTANT:
 * record_t contains MAX_FLAT flattened fields and is several MB in size.
 * It must NEVER live on a UDP worker thread's stack.
 */
static void enqueue_raw_live_packet(const char *json,
                                    const char *channel,
                                    const char *src_ip,
                                    int src_port) {
    cJSON *root = NULL;
    const char *raw_device;
    const char *raw_process;
    record_t *record = NULL;

    if ((json == NULL) || (channel == NULL)) {
        return;
    }

    root = cJSON_Parse(json);

    if ((root == NULL) || !cJSON_IsObject(root)) {
        if (root != NULL) {
            cJSON_Delete(root);
        }
        return;
    }

    /*
     * record_t is intentionally allocated on the heap.
     * A stack allocation here caused the Windows UDP worker to crash
     * inside ___chkstk_ms when the first telemetry packet arrived.
     */
    record = (record_t *)calloc(1U, sizeof(*record));

    if (record == NULL) {
        cJSON_Delete(root);
        return;
    }

    raw_device = json_get_string(root, "device_name", "device", "");

    if (raw_device[0] == '\0') {
        raw_device = device_from_channel(channel);
    }

    raw_process = json_get_string(root, "process_name", "process", "");

    snprintf(record->device,
             sizeof(record->device),
             "%s",
             normalize_device_name(raw_device));

    snprintf(record->channel,
             sizeof(record->channel),
             "%s",
             channel);

    snprintf(record->process,
             sizeof(record->process),
             "%s",
             raw_process);

    now_timestamp(record->ts, sizeof(record->ts));

    snprintf(record->server_rx_ts,
             sizeof(record->server_rx_ts),
             "%s",
             record->ts);

    enqueue_immediate_live_packet(record,
                                  root,
                                  src_ip,
                                  src_port);

    free(record);
    cJSON_Delete(root);
}

/**
 * @brief Continuously persist queued packets with exponential retry after database failures.
 * @param arg Opaque argument passed to the worker.
 * @return Platform-specific successful thread return value when the worker exits.
 * @note Long-running worker entry point; ownership of its argument and queue data is documented in the implementation.
 */
static THREAD_RET ingest_thread(void *arg) {
    (void)arg;
    lock_ingest_queue();g_ingest_worker_running=true;g_ingest_worker_heartbeat_ms=platform_monotonic_ms();unlock_ingest_queue();

    for (;;) {
        lock_ingest_queue();g_ingest_worker_heartbeat_ms=platform_monotonic_ms();unlock_ingest_queue();
        ingest_msg_t *head = pop_ingest_record();
        ingest_msg_t *tail = head;
        ingest_msg_t *msg;
        uint64_t count = head != NULL ? 1U : 0U;
        unsigned int attempt;
        bool committed = false;
        char replay_path[768]="";

        if (head == NULL) {
            if(oldest_spool_path(replay_path,sizeof(replay_path))) {
                head=load_spool_file(replay_path,&count); tail=head;
                while(tail!=NULL && tail->next!=NULL)tail=tail->next;
                if(head==NULL){
                    char corrupt[800];snprintf(corrupt,sizeof(corrupt),"%s.corrupt",replay_path);(void)rename(replay_path,corrupt);
                    fprintf(stderr,"CRITICAL: corrupt telemetry spool quarantined: %s\n",replay_path);
                    platform_sleep_ms(1000U);continue;
                }
            } else {
            platform_mutex_lock(&g_spool_mutex);
            if (!oldest_spool_path(replay_path, sizeof(replay_path))) {
                lock_ingest_queue();
                if (g_spool_writers == 0U) g_spool_ordering_active = false;
                unlock_ingest_queue();
            }
            platform_mutex_unlock(&g_spool_mutex);
            /* The ingest thread exclusively owns writer commits.  Never make
             * Mongoose's HTTP/WebSocket event loop wait for the DB mutex. */
            flush_writer_batch(false);
            platform_sleep_ms(1U);
            continue;
            }
        }
        while (replay_path[0]=='\0' && count < 1024U && (msg=pop_ingest_record()) != NULL) {
            tail->next=msg; tail=msg; count++;
        }

        /* The linked list remains writer-owned until the whole transaction is
         * committed, durably spooled, or explicitly accounted as dropped. */
        { ingest_msg_t *previous=NULL;msg=head;
          while(msg!=NULL){ingest_msg_t *next=msg->next;cJSON *sequence_root=cJSON_Parse(msg->json);
            if(sequence_root==NULL||!cJSON_IsObject(sequence_root)){
              if (sequence_root != NULL) cJSON_Delete(sequence_root);
              if (previous != NULL) previous->next = next;
              else head = next;
              if (tail == msg) tail = previous;
              count--;
              lock_ingest_queue();g_packet_accounting.parse_failed++;g_packet_accounting.dropped++;unlock_ingest_queue();free(msg->json);free(msg);
            }else{if(replay_path[0]=='\0')observe_packet_sequence(sequence_root,msg->channel,msg->source_ip);cJSON_Delete(sequence_root);previous=msg;}msg=next;
          }
        }
        if(head==NULL){if(replay_path[0]!='\0'){char corrupt[800];snprintf(corrupt,sizeof(corrupt),"%s.corrupt",replay_path);(void)rename(replay_path,corrupt);}continue;}
        for (attempt=0U; attempt<6U && !committed; ++attempt) {
            bool inserted=true;
            g_writer_defer_commit=true;
            for(msg=head;msg!=NULL;msg=msg->next) {
                if(!insert_record(msg->json,msg->channel,msg->source_ip,msg->source_port,msg->ingest_id)){inserted=false;break;}
            }
            g_writer_defer_commit=false;
            if(inserted){ lock_db(); committed=commit_writer_batch_locked(true); unlock_db(); }
            if(!committed){
                lock_db(); close_writer_db_locked(true); unlock_db();
                if(g_last_db_rc==SQLITE_MISMATCH) break;
                record_db_store_retry();
                lock_ingest_queue(); g_packet_accounting.retries++; unlock_ingest_queue();
                platform_sleep_ms(10U << attempt);
            }
        }
        if(!committed){
            lock_ingest_queue(); g_packet_accounting.db_failed += count; unlock_ingest_queue();
            if(replay_path[0]!='\0') {
                /* Keep the already durable segment for a later recovery pass. */
                platform_sleep_ms(1000U);
            } else if(!spool_batch(head,count)) {
                for (msg = head; msg != NULL; msg = msg->next) {
                    write_emergency_packet(msg);
                }
                lock_ingest_queue(); g_packet_accounting.dropped += count; unlock_ingest_queue();
                fprintf(stderr,"CRITICAL: database batch could not be committed or durably spooled; dropped=%llu rc=%d\n",(unsigned long long)count,g_last_db_rc);
            }
        } else {
            if(replay_path[0]=='\0'){uint64_t now=platform_monotonic_ms();for(msg=head;msg!=NULL;msg=msg->next){uint64_t latency=(now>=msg->queued_ms)?now-msg->queued_ms:0U;lock_ingest_queue();g_packet_accounting.committed_latency_total_ms+=latency;if(latency>g_packet_accounting.committed_latency_max_ms)g_packet_accounting.committed_latency_max_ms=latency;unlock_ingest_queue();}}
            if(replay_path[0]!='\0') {
                platform_mutex_lock(&g_spool_mutex);
                if(remove(replay_path)==0){g_spool_bytes=spool_usage_bytes();lock_ingest_queue();g_packet_accounting.replayed+=count;if(strncmp(g_db_last_error,"spool segment synced but directory sync failed",strlen("spool segment synced but directory sync failed"))==0)g_db_last_error[0]='\0';unlock_ingest_queue();}
                else fprintf(stderr,"WARNING: committed spool could not be removed and may replay again: %s\n",replay_path);
                if (!oldest_spool_path(replay_path, sizeof(replay_path))) {
                    lock_ingest_queue();
                    if (g_spool_writers == 0U) g_spool_ordering_active = false;
                    unlock_ingest_queue();
                }
                platform_mutex_unlock(&g_spool_mutex);
            }
        }
        while(head!=NULL){msg=head->next;free(head->json);free(head);head=msg;}
    }

    lock_ingest_queue();g_ingest_worker_running=false;unlock_ingest_queue();
    return THREAD_RETURN;
}

/**
 * @brief Escape arbitrary bytes for safe inclusion in a JSON string.
 * @param in Input text or byte sequence to process.
 */
static void esc_json(const unsigned char *in, char *out, size_t n) {
    size_t i;
    size_t j = 0;

    if (n == 0) return;

    if (in == NULL) {
        out[0] = '\0';
        return;
    }

    for (i = 0; (in[i] != '\0') && ((j + 2) < n); ++i) {
        unsigned char ch = in[i];

        if ((ch == '"') || (ch == '\\')) {
            out[j++] = '\\';
            out[j++] = (char)ch;
        } else if (ch >= 32) {
            out[j++] = (char)ch;
        }
    }

    out[j] = '\0';
}

/**
 * @brief Read and copy a named HTTP query variable into a bounded buffer.
 * @return Number of copied query-variable bytes, or a negative result when the variable is absent/invalid.
 */
static int get_var(struct mg_http_message *hm, const char *name, char *out, size_t n) {
    int r = mg_http_get_var(&hm->query, name, out, n);

    if ((r < 0) && (n > 0)) {
        out[0] = '\0';
    }

    return r;
}

/**
 * @brief Convert a supported GUI time-range token to seconds.
 * @return Requested range in seconds; zero represents an unbounded/all-data range.
 */
static int range_seconds(const char *r) {
    /* Keep the HMI's database bootstrap aligned with DEVICE_ONLINE_SEC.
     * Historical ranges remain available through the normal range values. */
    if (strcmp(r, "live") == 0) return DEVICE_ONLINE_SEC;
    if (strcmp(r, "5s") == 0) return 5;
    if (strcmp(r, "30s") == 0) return 30;
    if (strcmp(r, "1m") == 0) return 60;
    if (strcmp(r, "5m") == 0) return 300;
    if (strcmp(r, "10m") == 0) return 600;
    if (strcmp(r, "30m") == 0) return 1800;
    if (strcmp(r, "1h") == 0) return 3600;
    if (strcmp(r, "6h") == 0) return 21600;
    if (strcmp(r, "24h") == 0) return 86400;

    return 300;
}
/**
 * @brief Parse a stored database timestamp for range filtering.
 * @param ts Timestamp text to parse or store.
 * @return Parsed epoch time, or zero when the timestamp is absent or invalid.
 */
static time_t parse_db_timestamp(const char *ts) {

    struct tm tmv;
    int year, mon, day;
    int hour, min, sec;
    char separator;
    bool utc;

    memset(&tmv, 0, sizeof(tmv));

    if (ts == NULL || ts[0] == '\0') {
        return 0;
    }

    /* Milliseconds are intentionally ignored for range calculations. */
    if (sscanf(ts,
               "%d-%d-%d%c%d:%d:%d",
               &year,
               &mon,
               &day,
               &separator,
               &hour,
               &min,
               &sec) != 7 ||
        ((separator != 'T') && (separator != ' '))) {
        return 0;
    }

    tmv.tm_year = year - 1900;
    tmv.tm_mon  = mon - 1;
    tmv.tm_mday = day;
    tmv.tm_hour = hour;
    tmv.tm_min  = min;
    tmv.tm_sec  = sec;
    tmv.tm_isdst = -1;

    utc = (strchr(ts, 'Z') != NULL) ||
          (strchr(ts, 'T') != NULL);

    return utc ? platform_timegm(&tmv) : mktime(&tmv);
}

/**
 * @brief Send a successful JSON HTTP response.
 * @param s Input string to process.
 */
static void reply_json(struct mg_connection *c, const char *s) {
    mg_http_reply(c,
                  200,
                  "Content-Type: application/json\r\n"
                  "Access-Control-Allow-Origin: *\r\n"
                  "Cache-Control: no-store\r\n",
                  "%s",
                  s);
}

static sqlite3 *open_for_api(struct mg_http_message *hm) {
    char dbn[128];
    sqlite3 *db = NULL;

    get_var(hm, "db", dbn, sizeof(dbn));

    if (open_db_readonly(dbn, &db) != 0) {
        return NULL;
    }

    g_api_query_deadline_ms =
        platform_monotonic_ms() + API_QUERY_BUDGET_MS;
    sqlite3_progress_handler(db, 10000, api_query_timed_out, NULL);

    return db;
}

static const char *canonical_api_device_name(const char *name) {
    if ((name == NULL) || (name[0] == '\0')) return "";

    if (STRICMP(name, "CAMERA") == 0) return "CAMERA_UNIT";
    if (STRICMP(name, "BUTTON") == 0) return "BUTTON_LED_UNIT";
    if (STRICMP(name, "BUTTON_LED") == 0) return "BUTTON_LED_UNIT";
    if (STRICMP(name, "JOYSTICK") == 0) return "JOYSTICK_UNIT";
    if (STRICMP(name, "IMU") == 0) return "IMU_UNIT";
    if (STRICMP(name, "DRIVE") == 0) return "DRIVE_UNIT";
    if (STRICMP(name, "DRIVE_UNIT") == 0) return "DRIVE_UNIT";
    if (STRICMP(name, "TRACKER_PUBLISH") == 0) return "DRIVE_UNIT";
    if (STRICMP(name, "TRACKER_PUBLISH_UNIT") == 0) return "DRIVE_UNIT";
    if (STRICMP(name, "EXTERNAL_TRACK") == 0) return "EXTERNAL_TRACK_UNIT";
    if (STRICMP(name, "LCU") == 0) return "LCU_UNIT";
    if (STRICMP(name, "CCE") == 0) return "CCE_GATEWAY";
    if (STRICMP(name, "WCS") == 0) return "WCS_CONSOLE";
    if (STRICMP(name, "WCS_CONTROL_CONSOLE") == 0) return "WCS_CONSOLE";
    if (STRICMP(name, "ADVANTECH") == 0) return "ADVANTECH_IO";
    if (STRICMP(name, "ADVANTEC_DRIVER") == 0) return "ADVANTECH_IO";

    return name;
}

/* ======================= HTTP API implementations ====================== */

static void append_db_candidate(char *json, size_t capacity, int *offset,
                                int *first, char names[][128], size_t *count,
                                const char *name) {
    size_t i;
    if (!is_database_filename(name) || !safe_name(name)) return;
    for (i = 0U; i < *count; ++i) if (strcmp(names[i], name) == 0) return;
    if (*count >= 256U) return;
    snprintf(names[*count], 128U, "%s", name);
    (*count)++;
    if (!*first) *offset = append_format(json, capacity, *offset, ",");
    *first = 0;
    *offset = append_format(json, capacity, *offset, "\"%s\"", name);
}

/** @brief Return existing SQLite database files without inventing a selection. */
static void api_db_list(struct mg_connection *c) {
    char json[65536];
    char names[256][128];
    size_t name_count = 0U;
    int off = 0;
    int first = 1;
#ifdef _WIN32
    WIN32_FIND_DATAA fd;
    HANDLE h;
    char pattern[512];
#else
    DIR *dir;
    struct dirent *ent;
#endif

    off = append_format(json, sizeof(json), off, "[");

#ifdef _WIN32
    snprintf(pattern, sizeof(pattern), "%s\\*.*", g_db_dir);

    h = FindFirstFileA(pattern, &fd);

    if (h != INVALID_HANDLE_VALUE) {
        do {
            if (!(fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY))
                append_db_candidate(json, sizeof(json), &off, &first, names, &name_count, fd.cFileName);
        } while (FindNextFileA(h, &fd));

        FindClose(h);
    }
    snprintf(pattern, sizeof(pattern), "%s\\*.*", g_archive_dir);
    h = FindFirstFileA(pattern, &fd);
    if (h != INVALID_HANDLE_VALUE) {
        do {
            if (!(fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY))
                append_db_candidate(json, sizeof(json), &off, &first, names, &name_count, fd.cFileName);
        } while (FindNextFileA(h, &fd));
        FindClose(h);
    }
#else
    dir = opendir(g_db_dir);

    if (dir != NULL) {
        while ((ent = readdir(dir)) != NULL) {
            const char *name = ent->d_name;
            size_t len = strlen(name);

            if (len > 3U) append_db_candidate(json, sizeof(json), &off, &first, names, &name_count, name);
        }

        closedir(dir);
    }
    dir = opendir(g_archive_dir);
    if (dir != NULL) {
        while ((ent = readdir(dir)) != NULL) {
            const char *name = ent->d_name;
            size_t len = strlen(name);
            if (len > 3U) append_db_candidate(json, sizeof(json), &off, &first, names, &name_count, name);
        }
        closedir(dir);
    }
#endif

    off = append_format(json, sizeof(json), off, "]");
    reply_json(c, json);
}

static bool database_table_exists(sqlite3 *db, const char *table) {
    sqlite3_stmt *st = NULL;
    bool found = false;
    if (db == NULL || table == NULL) return false;
    if (sqlite3_prepare_v2(db,
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1",
            -1, &st, NULL) == SQLITE_OK) {
        sqlite3_bind_text(st, 1, table, -1, SQLITE_TRANSIENT);
        found = sqlite3_step(st) == SQLITE_ROW;
    }
    sqlite3_finalize(st);
    return found;
}

/** @brief Describe the selected database using tables and records actually present. */
static void api_db_info(struct mg_connection *c, struct mg_http_message *hm) {
    char name[128] = "", path[1024] = "", name_json[256], path_json[2048];
    char message[256] = "", message_json[512];
    char first_json[512], last_json[512];
    const char *table = NULL;
    bool connected = false, recognized = false, schema_valid = false;
    sqlite3 *db;
    sqlite3_stmt *st = NULL;
    sqlite3_int64 records = 0;
    char first_time[256] = "", last_time[256] = "";
    char devices[8192] = "";
    size_t used = 0U;
    int first = 1;
    char json[12288];

    get_var(hm, "db", name, sizeof(name));
    if (name[0] == '\0' || !safe_name(name) || !is_database_filename(name)) {
        snprintf(message, sizeof(message), "Select an existing SQLite database file.");
        goto reply;
    }
    make_db_path(name, path, sizeof(path));
    db = NULL;
    if (open_db_readonly(name, &db) != 0 || db == NULL) {
        snprintf(message, sizeof(message), "Selected database is missing, unreadable, or not a valid SQLite file.");
        goto reply;
    }
    connected = true;
    if (database_table_exists(db, "telemetry")) table = "telemetry";
    else if (database_table_exists(db, "telemetry_rows")) table = "telemetry_rows";
    else {
        snprintf(message, sizeof(message), "Database opened, but it contains no recognized telemetry tables.");
        sqlite3_close(db);
        goto reply;
    }
    recognized = true;
    {
        char sql[256];
        snprintf(sql, sizeof(sql), "SELECT COUNT(*),IFNULL(MIN(timestamp),''),IFNULL(MAX(timestamp),'') FROM \"%s\"", table);
        if (sqlite3_prepare_v2(db, sql, -1, &st, NULL) != SQLITE_OK || sqlite3_step(st) != SQLITE_ROW) {
            sqlite3_finalize(st); st = NULL;
            snprintf(message, sizeof(message), "Recognized telemetry table has an incompatible schema.");
            sqlite3_close(db);
            goto reply;
        }
        records = sqlite3_column_int64(st, 0);
        snprintf(first_time, sizeof(first_time), "%s", sqlite3_column_text(st, 1) ? (const char *)sqlite3_column_text(st, 1) : "");
        snprintf(last_time, sizeof(last_time), "%s", sqlite3_column_text(st, 2) ? (const char *)sqlite3_column_text(st, 2) : "");
        sqlite3_finalize(st); st = NULL;
        schema_valid = true;
    }
    {
        char sql[256];
        snprintf(sql, sizeof(sql), "SELECT DISTINCT device_name FROM \"%s\" WHERE device_name IS NOT NULL AND device_name<>'' ORDER BY device_name", table);
        if (sqlite3_prepare_v2(db, sql, -1, &st, NULL) == SQLITE_OK) {
            while (sqlite3_step(st) == SQLITE_ROW && used < sizeof(devices) - 320U) {
                char dev[256], escaped[512];
                const unsigned char *raw = sqlite3_column_text(st, 0);
                esc_json(raw, escaped, sizeof(escaped));
                snprintf(dev, sizeof(dev), "%s", raw ? (const char *)raw : "");
                if (dev[0] == '\0') continue;
                if (!first) used += (size_t)snprintf(devices + used, sizeof(devices) - used, ",");
                first = 0;
                used += (size_t)snprintf(devices + used, sizeof(devices) - used, "\"%s\"", escaped);
            }
        }
        sqlite3_finalize(st); st = NULL;
    }
    sqlite3_close(db);
    if (records == 0) snprintf(message, sizeof(message), "Database is readable but contains no telemetry records.");
    else if (first) snprintf(message, sizeof(message), "Telemetry records exist, but no device names are recorded.");

reply:
    esc_json((const unsigned char *)name, name_json, sizeof(name_json));
    esc_json((const unsigned char *)path, path_json, sizeof(path_json));
    esc_json((const unsigned char *)message, message_json, sizeof(message_json));
    esc_json((const unsigned char *)first_time, first_json, sizeof(first_json));
    esc_json((const unsigned char *)last_time, last_json, sizeof(last_json));
    snprintf(json, sizeof(json),
        "{\"ok\":%s,\"connected\":%s,\"recognized\":%s,\"has_data\":%s,\"database\":\"%s\",\"path\":\"%s\",\"table\":\"%s\",\"records\":%lld,\"first_timestamp\":\"%s\",\"last_timestamp\":\"%s\",\"devices\":[%s],\"message\":\"%s\"}",
        schema_valid ? "true" : "false", connected ? "true" : "false",
        recognized ? "true" : "false", records > 0 ? "true" : "false",
        name_json, path_json, table ? table : "", (long long)records,
        first_json, last_json, devices, message_json);
    reply_json(c, json);
}

/**
 * @brief Execute a bounded telemetry-row query and serialize its records as JSON.
 * @param sql SQL statement to execute.
 * @param p1 First optional fallback parameter name.
 * @param p2 Second optional fallback parameter name.
 * @param p3 Third optional fallback parameter name.
 */
static void rows_query(struct mg_connection *c,
                       sqlite3 *db,
                       const char *sql,
                       const char *p1,
                       const char *p2,
                       const char *p3) {
    sqlite3_stmt *st = NULL;
    char *json;
    int off = 0;
    int first = 1;

    size_t json_cap = 4 * 1024 * 1024;

    json = (char *)malloc(json_cap);

    if (json == NULL) {
        mg_http_reply(c, 500, "", "memory error");
        return;
    }

    off = append_format(json, json_cap, off, "[");

    if (sqlite3_prepare_v2(db, sql, -1, &st, NULL) != SQLITE_OK) {
        printf("SQL ERROR: %s\nQUERY: %s\n", sqlite3_errmsg(db), sql);
        reply_json(c, "[]");
        free(json);
        return;
    }

    if (p1 != NULL) sqlite3_bind_text(st, 1, p1, -1, SQLITE_TRANSIENT);
if (p2 != NULL) sqlite3_bind_text(st, 2, p2, -1, SQLITE_TRANSIENT);
if (p3 != NULL) sqlite3_bind_text(st, 3, p3, -1, SQLITE_TRANSIENT);

    while ((sqlite3_step(st) == SQLITE_ROW) && (off < ((int)json_cap - 4096))) {
        char ts[256], chan[128], dev[256], sub[256], proc[256], subp[256];
        char key[256], typ[64], txt[512], reason[512];
        char server_rx_ts[256] = "";
        char device_ts[256] = "";
        char packet_ts[256] = "";
        char source_ip[128] = "";
        int source_port = 0;
        double latency_ms = 0.0;

        esc_json(sqlite3_column_text(st, 0), ts, sizeof(ts));
        esc_json(sqlite3_column_text(st, 1), chan, sizeof(chan));
        esc_json(sqlite3_column_text(st, 2), dev, sizeof(dev));
        esc_json(sqlite3_column_text(st, 3), sub, sizeof(sub));
        esc_json(sqlite3_column_text(st, 4), proc, sizeof(proc));
        esc_json(sqlite3_column_text(st, 5), subp, sizeof(subp));
        esc_json(sqlite3_column_text(st, 6), key, sizeof(key));
        esc_json(sqlite3_column_text(st, 7), typ, sizeof(typ));
        esc_json(sqlite3_column_text(st, 9), txt, sizeof(txt));
        esc_json(sqlite3_column_text(st, 11), reason, sizeof(reason));
        if (sqlite3_column_count(st) > 12) {
            esc_json(sqlite3_column_text(st, 12),
                     server_rx_ts,
                     sizeof(server_rx_ts));
        }
        if (sqlite3_column_count(st) > 13) {
            esc_json(sqlite3_column_text(st, 13),
                     device_ts,
                     sizeof(device_ts));
        }
        if (sqlite3_column_count(st) > 14) {
            esc_json(sqlite3_column_text(st, 14),
                     packet_ts,
                     sizeof(packet_ts));
        }
        if (sqlite3_column_count(st) > 15) {
            latency_ms = sqlite3_column_double(st, 15);
        }
        if (sqlite3_column_count(st) > 16) {
    esc_json(sqlite3_column_text(st, 16),
             source_ip,
             sizeof(source_ip));
}

if (sqlite3_column_count(st) > 17) {
    source_port = sqlite3_column_int(st, 17);
}
        if (!first) off = append_format(json, json_cap, off, ",");
        first = 0;

        off = append_format(json, json_cap, off,
            "{\"timestamp\":\"%s\","
            "\"channel\":\"%s\","
            "\"device\":\"%s\","
            "\"subdevice\":\"%s\","
            "\"process\":\"%s\","
            "\"subprocess\":\"%s\","
            "\"server_rx_ts\":\"%s\","
            "\"device_ts\":\"%s\","
            "\"packet_ts\":\"%s\","
            "\"latency_ms\":%.3f,"
            "\"key\":\"%s\","
            "\"value_type\":\"%s\","
            "\"value\":%.6f,"
          "\"value_text\":\"%s\","
"\"anomaly\":%d,"
"\"reason\":\"%s\","
"\"source_ip\":\"%s\","
"\"source_port\":%d}",
            ts,
            chan,
            dev,
            sub,
            proc,
            subp,
            server_rx_ts,
            device_ts,
            packet_ts,
            latency_ms,
            key,
            typ,
            sqlite3_column_double(st, 8),
            txt,
            sqlite3_column_int(st, 10),
reason,
source_ip,
source_port);
    }

    sqlite3_finalize(st);

    off = append_format(json, json_cap, off, "]");
    reply_json(c, json);
    free(json);
    return;
}

/**
 * @brief Return aggregate packet, device, anomaly, and time-range database statistics.
 */
static void api_summary(struct mg_connection *c, struct mg_http_message *hm) {
    sqlite3 *db = open_for_api(hm);
    sqlite3_stmt *st = NULL;
    char json[2048];
    int rows = 0;
    int devs = 0;
    int metrics = 0;
    char first_str[128] = "";
    char last_str[128] = "";

    if (db == NULL) {
        reply_json(c, "{}");
        return;
    }

    if (sqlite3_prepare_v2(db,
        "SELECT IFNULL(MAX(id),0),"
        "(SELECT timestamp FROM telemetry ORDER BY id ASC LIMIT 1),"
        "(SELECT timestamp FROM telemetry ORDER BY id DESC LIMIT 1) "
        "FROM telemetry",
        -1, &st, NULL) == SQLITE_OK) {
        if (sqlite3_step(st) == SQLITE_ROW) {
            const unsigned char *first_ts = sqlite3_column_text(st, 1);
            const unsigned char *last = sqlite3_column_text(st, 2);

            rows = sqlite3_column_int(st, 0);
            if (first_ts != NULL) snprintf(first_str, sizeof(first_str), "%s", (const char *)first_ts);
            if (last != NULL) snprintf(last_str, sizeof(last_str), "%s", (const char *)last);
        }
    }
    sqlite3_finalize(st);
    st = NULL;

    if (sqlite3_prepare_v2(db,
        "SELECT COUNT(*) FROM (SELECT device_name FROM ("
        "SELECT device_name FROM telemetry ORDER BY id DESC LIMIT 10000"
        ") GROUP BY device_name LIMIT 300)",
        -1, &st, NULL) == SQLITE_OK) {
        if (sqlite3_step(st) == SQLITE_ROW) devs = sqlite3_column_int(st, 0);
    }
    sqlite3_finalize(st);
    st = NULL;

    if (sqlite3_prepare_v2(db,
        "SELECT COUNT(*) FROM (SELECT process_name FROM ("
        "SELECT process_name,value_type FROM telemetry_rows ORDER BY id DESC LIMIT 10000"
        ") WHERE value_type='num' GROUP BY process_name LIMIT 300)",
        -1, &st, NULL) == SQLITE_OK) {
        if (sqlite3_step(st) == SQLITE_ROW) metrics = sqlite3_column_int(st, 0);
    }
    sqlite3_finalize(st);

    sqlite3_close(db);

    snprintf(json, sizeof(json),
        "{\"row_count\":%d,\"device_count\":%d,\"metric_count\":%d,"
        "\"first_timestamp\":\"%s\",\"last_timestamp\":\"%s\"}",
        rows, devs, metrics, first_str, last_str);

    reply_json(c, json);
}

/**
 * @brief Return recent telemetry rows across devices for the selected database and range.
 */
/* Keyset pagination over the existing latest-field registry. No history scan
 * or raw payload duplication is needed to restore every source's live state. */
static void api_fields(struct mg_connection *c, struct mg_http_message *hm) {
    sqlite3 *db = open_for_api(hm);
    sqlite3_stmt *st = NULL;
    char after_text[32], device[128], search[256], ip[64];
    sqlite3_int64 after = 0, next = 0;
    cJSON *result = cJSON_CreateObject(), *rows = cJSON_CreateArray();
    char *body;
    int rc = SQLITE_DONE, count = 0;
    get_var(hm,"after",after_text,sizeof(after_text));
    get_var(hm,"device",device,sizeof(device));
    get_var(hm,"search",search,sizeof(search));
    get_var(hm,"source_ip",ip,sizeof(ip));
    if (after_text[0]) after = (sqlite3_int64)strtoll(after_text,NULL,10);
    if (after < 0) after = 0;
    cJSON_AddItemToObject(result,"rows",rows);
    if (db != NULL && sqlite3_prepare_v2(db,
        "SELECT id,source_ip,device_name,channel_name,field_name,field_type,"
        "last_value_num,last_value_text,last_seen,source_port FROM telemetry_ip_field_map "
        "WHERE id>?1 AND (?2='' OR device_name=?2) AND (?3='' OR instr(lower(field_name),lower(?3))>0) AND (?4='' OR source_ip=?4) ORDER BY id LIMIT 200",
        -1,&st,NULL)==SQLITE_OK) {
        sqlite3_bind_int64(st,1,after);
        sqlite3_bind_text(st,2,device,-1,SQLITE_TRANSIENT);
        sqlite3_bind_text(st,3,search,-1,SQLITE_TRANSIENT);
        sqlite3_bind_text(st,4,ip,-1,SQLITE_TRANSIENT);
        while ((rc=sqlite3_step(st))==SQLITE_ROW) {
            cJSON *row=cJSON_CreateObject();
            const char *type=(const char *)sqlite3_column_text(st,5);
            next=sqlite3_column_int64(st,0);
            cJSON_AddStringToObject(row,"source_ip",(const char *)sqlite3_column_text(st,1));
            cJSON_AddStringToObject(row,"device_name",(const char *)sqlite3_column_text(st,2));
            cJSON_AddStringToObject(row,"channel_name",(const char *)sqlite3_column_text(st,3));
            cJSON_AddStringToObject(row,"key",(const char *)sqlite3_column_text(st,4));
            cJSON_AddStringToObject(row,"value_type",sqlite3_column_type(st,6)!=SQLITE_NULL ? "num" : type);
            if (sqlite3_column_type(st,6)!=SQLITE_NULL)
                cJSON_AddNumberToObject(row,"value_num",sqlite3_column_double(st,6));
            else cJSON_AddStringToObject(row,"value_text",(const char *)sqlite3_column_text(st,7));
            cJSON_AddNumberToObject(row,"source_port",sqlite3_column_int(st,9));
            cJSON_AddStringToObject(row,"timestamp",(const char *)sqlite3_column_text(st,8));
            cJSON_AddItemToArray(rows,row); ++count;
        }
    } else rc=SQLITE_ERROR;
    sqlite3_finalize(st);
    if (db!=NULL) sqlite3_close(db);
    if (rc!=SQLITE_DONE) {
        cJSON_Delete(result);
        mg_http_reply(c,503,"Content-Type: application/json\r\n",
                      "{\"error\":\"Field snapshot unavailable; retry\"}");
        return;
    }
    cJSON_AddNumberToObject(result,"next",count==200 ? (double)next : 0);
    body=cJSON_PrintUnformatted(result);
    if (body!=NULL) { reply_json(c,body); free(body); }
    cJSON_Delete(result);
}

static void api_all(struct mg_connection *c, struct mg_http_message *hm) {
    sqlite3 *db = open_for_api(hm);
    char range[32];
    char dev[128];
    char sql[8192];

    if (db == NULL) {
        reply_json(c, "[]");
        return;
    }

    get_var(hm, "range", range, sizeof(range));
    get_var(hm, "device", dev, sizeof(dev));

    if ((strcmp(range, "all") == 0) && (dev[0] != '\0')) {
        snprintf(sql,
                 sizeof(sql),
            "SELECT tr.timestamp,tr.channel_name,tr.device_name,tr.subdevice_name,tr.process_name,"
           "tr.subprocess_name,tr.value_key,tr.value_type,tr.value_num,tr.value_text,tr.anomaly,tr.reason,"
"tr.timestamp,'','',0,tr.source_ip,tr.source_port "
            "FROM telemetry_rows tr "
            "WHERE 1=1 "
            "%s "
            "ORDER BY tr.id DESC "
            "LIMIT 5000",
            "AND (tr.device_name=? OR (?='DRIVE_UNIT' AND tr.device_name IN ('TRACKER_PUBLISH_UNIT','TRACKER_PUBLISH','DRIVE','DRIVE_WCS','LCU_UNIT')))");
    } else if (strcmp(range, "all") == 0) {
        snprintf(sql,
                 sizeof(sql),
          "SELECT timestamp,channel_name,device_name,subdevice_name,process_name,"
"subprocess_name,value_key,value_type,value_num,value_text,anomaly,reason,"
"server_rx_ts,device_ts,packet_ts,latency_ms,source_ip,source_port "
            "FROM ("
            "SELECT id,timestamp,channel_name,device_name,subdevice_name,process_name,"
"subprocess_name,value_key,value_type,value_num,value_text,anomaly,reason,"
            "(SELECT x.server_rx_ts FROM telemetry x WHERE x.timestamp=tr.timestamp AND x.channel_name=tr.channel_name AND x.device_name=tr.device_name ORDER BY x.id DESC LIMIT 1) AS server_rx_ts,"
            "(SELECT x.device_ts FROM telemetry x WHERE x.timestamp=tr.timestamp AND x.channel_name=tr.channel_name AND x.device_name=tr.device_name ORDER BY x.id DESC LIMIT 1) AS device_ts,"
            "(SELECT x.packet_ts FROM telemetry x WHERE x.timestamp=tr.timestamp AND x.channel_name=tr.channel_name AND x.device_name=tr.device_name ORDER BY x.id DESC LIMIT 1) AS packet_ts,"
            "(SELECT x.latency_ms FROM telemetry x WHERE x.timestamp=tr.timestamp AND x.channel_name=tr.channel_name AND x.device_name=tr.device_name ORDER BY x.id DESC LIMIT 1) AS latency_ms,"
           "tr.source_ip,tr.source_port," "ROW_NUMBER() OVER (PARTITION BY device_name ORDER BY id DESC) AS device_rank "
            "FROM telemetry_rows tr"
            ") fair_rows "
            "WHERE device_rank<=1000 "
            "ORDER BY id DESC "
            "LIMIT 20000");
    } else if (dev[0] != '\0') {
        snprintf(sql,
                 sizeof(sql),
            "SELECT tr.timestamp,tr.channel_name,tr.device_name,tr.subdevice_name,tr.process_name,"
            "tr.subprocess_name,tr.value_key,tr.value_type,tr.value_num,tr.value_text,tr.anomaly,tr.reason,"
"tr.timestamp,'','',0,tr.source_ip,tr.source_port "
            "FROM telemetry_rows tr "
            "WHERE 1=1 "
            "%s "
            "AND tr.timestamp >= strftime('%%Y-%%m-%%dT%%H:%%M:%%fZ','now','-%d seconds') "
            "ORDER BY tr.id DESC "
            "LIMIT 1000",
            "AND (tr.device_name=? OR (?='DRIVE_UNIT' AND tr.device_name IN ('TRACKER_PUBLISH_UNIT','TRACKER_PUBLISH','DRIVE','DRIVE_WCS','LCU_UNIT')))",
            range_seconds((range[0] != '\0') ? range : "5m"));
    } else {
        snprintf(sql,
                 sizeof(sql),
           "SELECT timestamp,channel_name,device_name,subdevice_name,process_name,"
"subprocess_name,value_key,value_type,value_num,value_text,anomaly,reason,"
"server_rx_ts,device_ts,packet_ts,latency_ms,source_ip,source_port "
            "FROM ("
            "SELECT id,timestamp,channel_name,device_name,subdevice_name,process_name,"
"subprocess_name,value_key,value_type,value_num,value_text,anomaly,reason,"
            "(SELECT x.server_rx_ts FROM telemetry x WHERE x.timestamp=tr.timestamp AND x.channel_name=tr.channel_name AND x.device_name=tr.device_name ORDER BY x.id DESC LIMIT 1) AS server_rx_ts,"
            "(SELECT x.device_ts FROM telemetry x WHERE x.timestamp=tr.timestamp AND x.channel_name=tr.channel_name AND x.device_name=tr.device_name ORDER BY x.id DESC LIMIT 1) AS device_ts,"
            "(SELECT x.packet_ts FROM telemetry x WHERE x.timestamp=tr.timestamp AND x.channel_name=tr.channel_name AND x.device_name=tr.device_name ORDER BY x.id DESC LIMIT 1) AS packet_ts,"
            "(SELECT x.latency_ms FROM telemetry x WHERE x.timestamp=tr.timestamp AND x.channel_name=tr.channel_name AND x.device_name=tr.device_name ORDER BY x.id DESC LIMIT 1) AS latency_ms,"
             "tr.source_ip,tr.source_port,"  "ROW_NUMBER() OVER (PARTITION BY device_name ORDER BY id DESC) AS device_rank "
            "FROM telemetry_rows tr "
            "WHERE tr.timestamp >= strftime('%%Y-%%m-%%dT%%H:%%M:%%fZ','now','-%d seconds')"
            ") fair_rows "
            "WHERE device_rank<=1000 "
            "ORDER BY id DESC "
            "LIMIT 20000",
            range_seconds((range[0] != '\0') ? range : "5m"));
    }

    rows_query(c, db, sql, dev[0] ? dev : NULL, dev[0] ? dev : NULL, NULL);
    sqlite3_close(db);

}

/**
 * @brief Return device-level availability and latest-activity information.
 */
static void api_devices(struct mg_connection *c, struct mg_http_message *hm) {
    sqlite3 *db = open_for_api(hm);
    sqlite3_stmt *st = NULL;
    char json[16384];
    int off = 0;
    int first = 1;
    time_t now = time(NULL);

    if (db == NULL) {
        reply_json(c, "[]");
        return;
    }

    off = append_format(json, sizeof(json), off, "[");

    if (sqlite3_prepare_v2(db,
        "WITH recent AS ("
        "SELECT id,CASE WHEN UPPER(device_name) IN ("
        "'DRIVE','DRIVE_UNIT','DRIVE_WCS','TRACKER_PUBLISH','TRACKER_PUBLISH_UNIT'"
        ") THEN 'DRIVE_UNIT' WHEN UPPER(device_name) IN ('WCS','WCS_CONSOLE') "
        "THEN 'WCS_CONSOLE' ELSE device_name END AS device_name,"
        "channel_name,source_ip,"
        "COALESCE(NULLIF(server_rx_ts,''),timestamp) AS last_seen,anomaly FROM telemetry "
        "WHERE device_name IS NOT NULL AND device_name<>'' "
        "ORDER BY id DESC LIMIT 50000), "
        "stats AS ("
        "SELECT device_name,MAX(id) AS max_id,COUNT(*) AS rows,"
        "IFNULL(SUM(anomaly),0) AS anomalies FROM recent "
        "GROUP BY device_name) "
        "SELECT r.device_name,r.last_seen,r.source_ip,r.channel_name,s.rows,s.anomalies "
        "FROM stats s JOIN recent r ON r.id=s.max_id "
        "ORDER BY r.device_name",
        -1,
        &st,
        NULL) == SQLITE_OK) {

        while ((sqlite3_step(st) == SQLITE_ROW) &&
               (off < ((int)sizeof(json) - 512))) {
            char dev[256];
            char ts[256];
            char source_ip[256];
            char channel_name[256];
            const char *status = "offline";
            time_t last_time;
            double age_sec;

            esc_json(sqlite3_column_text(st, 0), dev, sizeof(dev));
            esc_json(sqlite3_column_text(st, 1), ts, sizeof(ts));
            esc_json(sqlite3_column_text(st, 2), source_ip, sizeof(source_ip));
            esc_json(sqlite3_column_text(st, 3), channel_name, sizeof(channel_name));

            last_time = parse_db_timestamp(ts);

            if (last_time > 0) {
                age_sec = difftime(now, last_time);

                /* A future server receive time indicates clock skew or bad
                 * timestamp data; it must not make a device look healthy. */
                if (age_sec >= 0.0 && age_sec <= DEVICE_ONLINE_SEC) {
                    status = "online";
                } else if (age_sec >= 0.0 && age_sec <= DEVICE_WARNING_SEC) {
                    status = "warning";
                } else if (age_sec < 0.0) {
                    status = "warning";
                } else {
                    status = "offline";
                }
            }

            if (!first) off = append_format(json, sizeof(json), off, ",");
            first = 0;

            off = append_format(json, sizeof(json), off,
                "{\"device\":\"%s\","
                "\"last_seen\":\"%s\","
                "\"source_ip\":\"%s\","
                "\"channel\":\"%s\","
                "\"anomalies\":%d,"
                "\"rows\":%d,"
                "\"status\":\"%s\","
                "\"reason\":\"%s\"}",
                dev,
                ts,
                source_ip,
                channel_name,
                sqlite3_column_int(st, 5),
                sqlite3_column_int(st, 4),
                status,
                status);
        }
    } else {
        printf("api_devices SQL error: %s\n", sqlite3_errmsg(db));
    }

    sqlite3_finalize(st);
    sqlite3_close(db);

    snprintf(json + off,
         sizeof(json) - (size_t)off,"]");
    reply_json(c, json);
}

/**
 * Return every device that has packet records in the selected historical
 * database. This endpoint deliberately has no live-status semantics so an old
 * database remains independently searchable.
 */
static void api_history_devices(struct mg_connection *c,
                                struct mg_http_message *hm) {
    sqlite3 *db = open_for_api(hm);
    sqlite3_stmt *st = NULL;
    char json[32768];
    char sql[1024];
    const char *table = NULL;
    int off = 0;
    int first = 1;

    if (db == NULL) {
        reply_json(c, "[]");
        return;
    }

    table = database_table_exists(db, "telemetry") ? "telemetry" :
            (database_table_exists(db, "telemetry_rows") ? "telemetry_rows" : NULL);
    off = append_format(json, sizeof(json), off, "[");
    if (table != NULL) {
        snprintf(sql, sizeof(sql),
            "SELECT DISTINCT CASE WHEN UPPER(device_name) IN "
            "('DRIVE','DRIVE_UNIT','DRIVE_WCS','TRACKER_PUBLISH',"
            "'TRACKER_PUBLISH_UNIT') THEN 'DRIVE_UNIT' "
            "WHEN UPPER(device_name) IN ('WCS','WCS_CONSOLE') THEN 'WCS_CONSOLE' "
            "ELSE device_name END AS page_device FROM \"%s\" "
            "WHERE device_name IS NOT NULL AND device_name<>'' ORDER BY page_device",
            table);
    }
    if (table != NULL && sqlite3_prepare_v2(db, sql, -1, &st, NULL) == SQLITE_OK) {
        while ((sqlite3_step(st) == SQLITE_ROW) &&
               (off < (int)sizeof(json) - 1024)) {
            char device[256];
            esc_json(sqlite3_column_text(st, 0), device, sizeof(device));
            if (!first) off = append_format(json, sizeof(json), off, ",");
            first = 0;
            off = append_format(
                json,
                sizeof(json),
                off,
                "{\"device\":\"%s\",\"status\":\"recorded\"}",
                device);
        }
    }
    if (table == NULL) printf("api_history_devices: selected database has no telemetry table\n");
    else if (first) printf("api_history_devices SQL error: %s\n", sqlite3_errmsg(db));

    sqlite3_finalize(st);
    sqlite3_close(db);
    append_format(json, sizeof(json), off, "]");
    reply_json(c, json);
}

/**
 * Return evenly distributed raw packets from the selected device/date. Target
 * IDs are resolved with bounded primary-key seeks, avoiding a window sort over
 * millions of expanded telemetry fields in older daily databases.
 */
static void api_history_packets(struct mg_connection *c,
                                struct mg_http_message *hm) {
    sqlite3 *db = open_for_api(hm);
    sqlite3_stmt *st = NULL;
    char device[128], range[32];
    char source_table[256] = "telemetry";
    char *predicate = NULL;
    char sql[8192];
    char *json = NULL;
    const size_t json_cap = 16U * 1024U * 1024U;
    int off = 0;
    int first = 1;
    int seconds;

    get_var(hm, "device", device, sizeof(device));
    get_var(hm, "range", range, sizeof(range));
    if (db == NULL || device[0] == '\0') {
        if (db != NULL) sqlite3_close(db);
        reply_json(c, "[]");
        return;
    }

    seconds = strcmp(range, "all") == 0
        ? 0
        : range_seconds(range[0] ? range : "5m");
    {
        const char *canonical = canonical_api_device_name(device);
        char *quoted = sqlite3_mprintf("%Q", device);
        (void)canonical;
        predicate = sqlite3_mprintf(
                "(device_name=%s OR (%s='DRIVE_UNIT' AND device_name IN "
                "('TRACKER_PUBLISH_UNIT','TRACKER_PUBLISH','DRIVE',"
                "'DRIVE_WCS','LCU_UNIT')))",
                quoted,
                quoted);
        sqlite3_free(quoted);
    }

    snprintf(
        sql,
        sizeof(sql),
        "WITH bounds AS (SELECT MIN(id) lo,MAX(id) hi,MAX(timestamp) newest "
        "FROM %s WHERE %s), targets(n,target_id) AS ("
        "SELECT 0,lo FROM bounds UNION ALL SELECT n+1,"
        "lo+((hi-lo)*(n+1)/299) FROM targets,bounds WHERE n<299),"
        "sample_ids AS (SELECT DISTINCT (SELECT t.id FROM %s t "
        "WHERE %s AND t.id>=target_id %s ORDER BY t.id LIMIT 1) id "
        "FROM targets,bounds) "
        "SELECT t.timestamp,t.server_rx_ts,t.device_ts,t.packet_ts,"
        "t.latency_ms,t.channel_name,t.device_name,t.subdevice_name,"
        "t.process_name,t.subprocess_name,t.anomaly,t.reason,t.raw_json "
        "FROM %s t JOIN sample_ids s ON s.id=t.id "
        "WHERE s.id IS NOT NULL ORDER BY t.id",
        source_table,
        predicate,
        source_table,
        predicate,
        seconds > 0
            ? "AND t.timestamp>=strftime('%Y-%m-%dT%H:%M:%fZ',"
              "julianday(newest)-1.0/288.0) "
            : "",
        source_table);
    /* Replace the fixed five-minute divisor with the validated requested
     * duration without exposing request text to SQL. */
    if (seconds > 0) {
        char timed_sql[8192];
        snprintf(
            timed_sql,
            sizeof(timed_sql),
            "WITH latest AS (SELECT MAX(timestamp) newest FROM %s "
            "WHERE %s), bounds AS (SELECT MIN(id) lo,MAX(id) hi "
            "FROM %s,latest WHERE %s AND "
            "timestamp>=strftime('%%Y-%%m-%%dT%%H:%%M:%%fZ',"
            "julianday(newest)-%d/86400.0)), targets(n,target_id) AS ("
            "SELECT 0,lo FROM bounds UNION ALL SELECT n+1,"
            "lo+((hi-lo)*(n+1)/299) FROM targets,bounds WHERE n<299),"
            "sample_ids AS (SELECT DISTINCT (SELECT t.id FROM %s t "
            "WHERE %s AND t.id>=target_id AND t.id<=hi "
            "ORDER BY t.id LIMIT 1) id "
            "FROM targets,bounds) SELECT t.timestamp,t.server_rx_ts,"
            "t.device_ts,t.packet_ts,t.latency_ms,t.channel_name,"
            "t.device_name,t.subdevice_name,t.process_name,t.subprocess_name,"
            "t.anomaly,t.reason,t.raw_json FROM %s t "
            "JOIN sample_ids s ON s.id=t.id WHERE s.id IS NOT NULL "
            "ORDER BY t.id",
            source_table,
            predicate,
            source_table,
            predicate,
            seconds,
            source_table,
            predicate,
            source_table);
        snprintf(sql, sizeof(sql), "%s", timed_sql);
    }
    sqlite3_free(predicate);

    json = (char *)malloc(json_cap);
    if (json == NULL) {
        sqlite3_close(db);
        mg_http_reply(c, 500, "", "memory error");
        return;
    }
    off = append_format(json, json_cap, off, "[");
    if (sqlite3_prepare_v2(db, sql, -1, &st, NULL) == SQLITE_OK) {
        while ((sqlite3_step(st) == SQLITE_ROW) &&
               off < (int)json_cap - 65536) {
            char ts[256], server_ts[256], device_ts[256], packet_ts[256];
            char channel[128], dev[256], sub[256], process[256], subp[256];
            char reason[512];
            const unsigned char *raw = sqlite3_column_text(st, 12);
            if (raw == NULL) continue;
            esc_json(sqlite3_column_text(st, 0), ts, sizeof(ts));
            esc_json(sqlite3_column_text(st, 1), server_ts, sizeof(server_ts));
            esc_json(sqlite3_column_text(st, 2), device_ts, sizeof(device_ts));
            esc_json(sqlite3_column_text(st, 3), packet_ts, sizeof(packet_ts));
            esc_json(sqlite3_column_text(st, 5), channel, sizeof(channel));
            esc_json(sqlite3_column_text(st, 6), dev, sizeof(dev));
            esc_json(sqlite3_column_text(st, 7), sub, sizeof(sub));
            esc_json(sqlite3_column_text(st, 8), process, sizeof(process));
            esc_json(sqlite3_column_text(st, 9), subp, sizeof(subp));
            esc_json(sqlite3_column_text(st, 11), reason, sizeof(reason));
            if (!first) off = append_format(json, json_cap, off, ",");
            first = 0;
            off = append_format(
                json,
                json_cap,
                off,
                "{\"timestamp\":\"%s\",\"server_rx_ts\":\"%s\","
                "\"device_ts\":\"%s\",\"packet_ts\":\"%s\","
                "\"latency_ms\":%.3f,\"channel\":\"%s\",\"device\":\"%s\","
                "\"subdevice\":\"%s\",\"process\":\"%s\","
                "\"subprocess\":\"%s\",\"anomaly\":%d,\"reason\":\"%s\","
                "\"payload\":%s}",
                ts, server_ts, device_ts, packet_ts,
                sqlite3_column_double(st, 4), channel, dev, sub, process, subp,
                sqlite3_column_int(st, 10), reason, (const char *)raw);
        }
    } else {
        printf("api_history_packets SQL error: %s\n", sqlite3_errmsg(db));
    }
    sqlite3_finalize(st);
    sqlite3_close(db);
    append_format(json, json_cap, off, "]");
    reply_json(c, json);
    free(json);
}

/**
 * Return a chart-friendly, metric-balanced sample for one device and range.
 * The window ends at that device's newest record in the selected database,
 * rather than at the host clock, so archived daily databases remain usable.
 */
static void api_page_telemetry(struct mg_connection *c,
                               struct mg_http_message *hm) {
    sqlite3 *db = open_for_api(hm);
    char device[128];
    char range[32];
    char sql[8192];
    int seconds;
    const char *device_filter =
        "(device_name=? OR (?='DRIVE_UNIT' AND device_name IN "
        "('TRACKER_PUBLISH_UNIT','TRACKER_PUBLISH','DRIVE',"
        "'DRIVE_WCS','LCU_UNIT')))";

    get_var(hm, "device", device, sizeof(device));
    get_var(hm, "range", range, sizeof(range));
    if (db == NULL || device[0] == '\0') {
        if (db != NULL) sqlite3_close(db);
        reply_json(c, "[]");
        return;
    }

    seconds = (strcmp(range, "all") == 0)
        ? 0
        : range_seconds(range[0] ? range : "5m");

    if (seconds > 0) {
        /* Use a safely quoted value in the anchor subquery because rows_query
         * intentionally exposes only three bind parameters. */
        {
            char *quoted = sqlite3_mprintf("%Q", device);
            char anchor[1024];
            snprintf(
                anchor,
                sizeof(anchor),
                "(device_name=%s OR (%s='DRIVE_UNIT' AND device_name IN "
                "('TRACKER_PUBLISH_UNIT','TRACKER_PUBLISH','DRIVE',"
                "'DRIVE_WCS','LCU_UNIT')))",
                quoted,
                quoted);
            sqlite3_free(quoted);
            snprintf(
                sql,
                sizeof(sql),
                "WITH bounded AS (SELECT id,timestamp,channel_name,device_name,"
                "subdevice_name,process_name,subprocess_name,value_key,"
                "value_type,value_num,value_text,anomaly,reason "
                "FROM telemetry_rows WHERE %s AND timestamp >= ("
                "SELECT strftime('%%Y-%%m-%%dT%%H:%%M:%%fZ',"
                "julianday(MAX(timestamp))-%d/86400.0) FROM telemetry_rows "
                "WHERE %s)), ranked AS (SELECT *,"
                "ROW_NUMBER() OVER (PARTITION BY value_key ORDER BY id) rn,"
                "COUNT(*) OVER (PARTITION BY value_key) cnt FROM bounded) "
                "SELECT timestamp,channel_name,device_name,subdevice_name,"
                "process_name,subprocess_name,value_key,value_type,value_num,"
                "value_text,anomaly,reason,timestamp,'','',0 FROM ranked "
                "WHERE cnt<=300 OR rn=1 OR rn=cnt OR "
                "((rn-1) %% MAX(1,(cnt+299)/300))=0 "
                "ORDER BY id DESC LIMIT 20000",
                device_filter,
                seconds,
                anchor);
        }
    } else {
        snprintf(
            sql,
            sizeof(sql),
            "WITH bounded AS (SELECT id,timestamp,channel_name,device_name,"
            "subdevice_name,process_name,subprocess_name,value_key,"
            "value_type,value_num,value_text,anomaly,reason "
            "FROM telemetry_rows WHERE %s), ranked AS (SELECT *,"
            "ROW_NUMBER() OVER (PARTITION BY value_key ORDER BY id) rn,"
            "COUNT(*) OVER (PARTITION BY value_key) cnt FROM bounded) "
            "SELECT timestamp,channel_name,device_name,subdevice_name,"
            "process_name,subprocess_name,value_key,value_type,value_num,"
            "value_text,anomaly,reason,timestamp,'','',0 FROM ranked "
            "WHERE cnt<=300 OR rn=1 OR rn=cnt OR "
            "((rn-1) %% MAX(1,(cnt+299)/300))=0 "
            "ORDER BY id DESC LIMIT 20000",
            device_filter);
    }

    rows_query(c, db, sql, device, device, NULL);
    sqlite3_close(db);
}

/**
 * @brief Return latest persisted state for controls belonging to a selected device.
 */
static void api_device_state(struct mg_connection *c,
                             struct mg_http_message *hm) {

    sqlite3 *db = open_for_api(hm);

    sqlite3_stmt *st = NULL;

    char dev[128];
    const char *canonical_dev;

    char json[65536];

    int off = 0;

    int first = 1;

    get_var(hm, "device", dev, sizeof(dev));
    canonical_dev = canonical_api_device_name(dev);

    if (db == NULL) {
        reply_json(c, "[]");
        return;
    }

    off = append_format(json, sizeof(json), off, "[");

    if (sqlite3_prepare_v2(
            db,

            "SELECT "
            "button_name,"
            "button_state,"
            "last_used,"
            "session_id,"
            "alive,"
            "last_heartbeat,"
            "toggle_count,"
            "uptime_seconds,"
            "("
              "SELECT MAX(e.timestamp) FROM hmi_event_log e "
              "WHERE e.device_name=device_state.device_name "
              "AND e.control_name=device_state.button_name "
              "AND e.new_state=1"
            "),"
            "("
              "SELECT MAX(e.timestamp) FROM hmi_event_log e "
              "WHERE e.device_name=device_state.device_name "
              "AND e.control_name=device_state.button_name "
              "AND e.new_state=0"
            "),"
            "("
              "SELECT IFNULL(SUM(e.on_duration_ms),0) FROM hmi_event_log e "
              "WHERE e.device_name=device_state.device_name "
              "AND e.control_name=device_state.button_name"
            ") "

            "FROM device_state "

            "WHERE device_name=? "

            "AND id IN ("

                "SELECT MAX(id) "
                "FROM device_state "
                "WHERE device_name=? "
                "GROUP BY button_name"

            ") "

            "ORDER BY button_name",

            -1,
            &st,
            NULL

        ) == SQLITE_OK) {

        sqlite3_bind_text(st, 1, canonical_dev, -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(st, 2, canonical_dev, -1, SQLITE_TRANSIENT);

        while (sqlite3_step(st) == SQLITE_ROW) {

            char btn[256];
            char ts[256];
            char sess[256];
            char heartbeat[256];
            char last_on[256];
            char last_off[256];

            esc_json(sqlite3_column_text(st, 0), btn, sizeof(btn));
            esc_json(sqlite3_column_text(st, 2), ts, sizeof(ts));
            esc_json(sqlite3_column_text(st, 3), sess, sizeof(sess));
            esc_json(sqlite3_column_text(st, 5), heartbeat, sizeof(heartbeat));
            esc_json(sqlite3_column_text(st, 8), last_on, sizeof(last_on));
            esc_json(sqlite3_column_text(st, 9), last_off, sizeof(last_off));

            if (!first) {
                off = append_format(json, sizeof(json), off, ",");
            }

            first = 0;

            off = append_format(
                json, sizeof(json), off,

                "{"
                "\"button\":\"%s\","
                "\"state\":%d,"
                "\"last_used\":\"%s\","
                "\"session\":\"%s\","
                "\"alive\":%d,"
                "\"heartbeat\":\"%s\","
                "\"toggle_count\":%d,"
                "\"uptime_seconds\":%d,"
                "\"last_on\":\"%s\","
                "\"last_off\":\"%s\","
                "\"total_on_ms\":%lld"
                "}",

                btn,
                sqlite3_column_int(st, 1),
                ts,
                sess,
                sqlite3_column_int(st, 4),
                heartbeat,
                sqlite3_column_int(st, 6),
                sqlite3_column_int(st, 7),
                last_on,
                last_off,
                sqlite3_column_int64(st, 10)
            );
        }
    }

    sqlite3_finalize(st);

    sqlite3_close(db);

    off = append_format(json, sizeof(json), off, "]");

    reply_json(c, json);
}

/**
 * @brief Return devices and signal availability required to initialize the HMI.
 */
static void api_hmi_devices(struct mg_connection *c,
                            struct mg_http_message *hm) {
    static const char *devices[] = {
    "LCU",
    "WCS",
    "CAMERA",
    "DRIVE_UNIT",
    "MAIN_DISPLAY",
    "IMU",
    "BUTTON",
    "JOYSTICK",
    "CCE",
    "EXTERNAL_TRACK",
    "ADVANTECH"
};
    sqlite3 *db = open_for_api(hm);
    char json[16384];
    int off = 0;
    int i;
    time_t now = time(NULL);

    off = append_format(json, sizeof(json), off, "[");

    for (i = 0; i < (int)(sizeof(devices) / sizeof(devices[0])); ++i) {
        const char *device = devices[i];
        const char *channel = hmi_channel_for_device(device);
        const char *group_ip = "";
        const char *iface_ip = "";
        const char *status = "offline";
        char last_seen_raw[128] = "";
        char last_seen[256] = "";
        int port = 0;
        int enabled = 0;
        int active = 0;
        int j;

        for (j = 0; j < g_channel_count; ++j) {
            if (strcmp(g_channels[j].name, channel) == 0) {
                group_ip = g_channels[j].group_ip;
                iface_ip = g_channels[j].iface_ip;
                port = g_channels[j].port;
                enabled = g_channels[j].enabled;
                break;
            }
        }

        if (db != NULL) {
            sqlite3_stmt *st = NULL;

            if (sqlite3_prepare_v2(
                    db,
                    "SELECT COALESCE(NULLIF(server_rx_ts,''),timestamp) FROM telemetry "
                    "WHERE ((?='DRIVE_UNIT' AND channel_name IN ('tracker_publish','drive_wcs')) "
                    "OR channel_name=?) "
                    "ORDER BY id DESC LIMIT 1",
                    -1,
                    &st,
                    NULL) == SQLITE_OK) {

                sqlite3_bind_text(st, 1, device, -1, SQLITE_TRANSIENT);
                sqlite3_bind_text(st, 2, channel, -1, SQLITE_TRANSIENT);

                if (sqlite3_step(st) == SQLITE_ROW) {
                    const unsigned char *ts = sqlite3_column_text(st, 0);

                    if (ts != NULL) {
                        snprintf(last_seen_raw,
                                 sizeof(last_seen_raw),
                                 "%s",
                                 (const char *)ts);
                    }
                }
            }

            sqlite3_finalize(st);
        }

        if (last_seen_raw[0] != '\0') {
            time_t last_time = parse_db_timestamp(last_seen_raw);

            esc_json((const unsigned char *)last_seen_raw,
                     last_seen,
                     sizeof(last_seen));

            if (last_time > 0) {
                double age_sec = difftime(now, last_time);

                /* Treat future timestamps as a warning for clock skew. */
                if (age_sec >= 0.0 && age_sec <= DEVICE_ONLINE_SEC) {
                    status = "online";
                    active = 1;
                } else if (age_sec >= 0.0 && age_sec <= DEVICE_WARNING_SEC) {
                    status = "warning";
                } else if (age_sec < 0.0) {
                    status = "warning";
                }
            }
        }

        if (i > 0) off = append_format(json, sizeof(json), off, ",");

            off = append_format(
                json, sizeof(json), off,
            "{"
            "\"device\":\"%s\","
            "\"channel\":\"%s\","
            "\"group_ip\":\"%s\","
            "\"port\":%d,"
            "\"iface_ip\":\"%s\","
            "\"enabled\":%d,"
            "\"active\":%d,"
            "\"status\":\"%s\","
            "\"last_seen\":\"%s\""
            "}",
            device,
            channel,
            group_ip,
            port,
            iface_ip,
            enabled,
            active,
            status,
            last_seen);
    }

    if (db != NULL) {
        sqlite3_close(db);
    }

    snprintf(json + off, sizeof(json) - (size_t)off, "]");
    reply_json(c, json);
}

/**
 * @brief Return the latest HMI values for a selected device.
 */
static void api_hmi_latest(struct mg_connection *c,
                           struct mg_http_message *hm) {
    sqlite3 *db = open_for_api(hm);
    sqlite3_stmt *st = NULL;
    char channel[128];
    char ts[256] = "";
    char chan[256] = "";
    const unsigned char *raw = NULL;
    char json[65536];

    get_var(hm, "channel", channel, sizeof(channel));

    if ((db == NULL) || (channel[0] == '\0')) {
        reply_json(c, "{\"timestamp\":\"\",\"channel\":\"\",\"payload\":null}");
        if (db != NULL) sqlite3_close(db);
        return;
    }

    if (sqlite3_prepare_v2(
            db,
            "SELECT timestamp,channel_name,raw_json "
            "FROM telemetry "
            "WHERE channel_name=? "
            "ORDER BY id DESC "
            "LIMIT 1",
            -1,
            &st,
            NULL) == SQLITE_OK) {

        sqlite3_bind_text(st, 1, channel, -1, SQLITE_TRANSIENT);

        if (sqlite3_step(st) == SQLITE_ROW) {
            esc_json(sqlite3_column_text(st, 0), ts, sizeof(ts));
            esc_json(sqlite3_column_text(st, 1), chan, sizeof(chan));
            raw = sqlite3_column_text(st, 2);
        }
    }

    if (raw != NULL) {
        snprintf(json,
                 sizeof(json),
                 "{\"timestamp\":\"%s\",\"channel\":\"%s\",\"payload\":%s}",
                 ts,
                 chan,
                 (const char *)raw);
    } else {
        snprintf(json,
                 sizeof(json),
                 "{\"timestamp\":\"\",\"channel\":\"%s\",\"payload\":null}",
                 channel);
    }

    sqlite3_finalize(st);
    sqlite3_close(db);
    reply_json(c, json);
}

/* One read-only request returns a small, range-bounded raw-packet snapshot for
 * the wallboard. Each channel lookup uses idx_telemetry_channel_id, avoiding
 * 11 independent browser connections and expanded-row sorts. */
static void api_wallboard_snapshot(struct mg_connection *c,
                                   struct mg_http_message *hm) {
    static const char *devices[] = {
        "LCU", "WCS", "CAMERA", "DRIVE_UNIT", "MAIN_DISPLAY", "IMU",
        "BUTTON", "JOYSTICK", "CCE", "EXTERNAL_TRACK", "ADVANTECH"
    };
    const size_t json_capacity = 8U * 1024U * 1024U;
    char db_name[128] = "", range[32] = "5m", range_json[128];
    char *json = NULL;
    sqlite3 *db = NULL;
    sqlite3_stmt *st = NULL;
    int seconds, off = 0, i;
    time_t now = time(NULL);
    bool first_device = true;

    get_var(hm, "db", db_name, sizeof(db_name));
    get_var(hm, "range", range, sizeof(range));
    seconds = range_seconds(range);
    if (seconds < 0) seconds = 300;
    if (seconds > 86400) seconds = 86400;
    if (db_name[0] == '\0' || !safe_name(db_name) || !is_database_filename(db_name) ||
        open_db_readonly(db_name, &db) != 0 || db == NULL) {
        reply_json(c, "{\"ok\":false,\"message\":\"Selected database could not be opened.\",\"devices\":[]}");
        return;
    }
    if (!database_table_exists(db, "telemetry")) {
        sqlite3_close(db);
        reply_json(c, "{\"ok\":false,\"message\":\"Selected database has no raw telemetry packet table.\",\"devices\":[]}");
        return;
    }
    json = (char *)malloc(json_capacity);
    if (json == NULL) { sqlite3_close(db); mg_http_reply(c, 500, "", "memory error"); return; }
    esc_json((const unsigned char *)range, range_json, sizeof(range_json));
    off = append_format(json, json_capacity, off,
        "{\"ok\":true,\"database\":\"%s\",\"range\":\"%s\",\"devices\":[",
        db_name, range_json);
    for (i = 0; i < (int)(sizeof(devices) / sizeof(devices[0])) && off < (int)json_capacity - 65536; ++i) {
        const char *canonical = canonical_api_device_name(devices[i]);
        const char *channel = hmi_channel_for_device(devices[i]);
        const char *alternate_channel = strcmp(canonical, "DRIVE_UNIT") == 0 ? "lcu_transport" : channel;
        char channel_json[256], device_json[256], last_seen[256] = "", last_seen_json[512];
        char actual_channel[128] = "";
        char status[16] = "offline";
        int packets = 0;
        double age = 0.0;
        bool first_packet = true;

        esc_json((const unsigned char *)canonical, device_json, sizeof(device_json));
        sqlite3_finalize(st); st = NULL;
        if (sqlite3_prepare_v2(db,
            "SELECT COALESCE(NULLIF(server_rx_ts,''),timestamp),channel_name FROM telemetry "
            "WHERE channel_name IN (?1,?2) AND device_name=?3 ORDER BY id DESC LIMIT 1", -1, &st, NULL) != SQLITE_OK) continue;
        sqlite3_bind_text(st, 1, channel, -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(st, 2, alternate_channel, -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(st, 3, canonical, -1, SQLITE_TRANSIENT);
        if (sqlite3_step(st) == SQLITE_ROW) {
            const unsigned char *rx = sqlite3_column_text(st, 0);
            const unsigned char *found_channel = sqlite3_column_text(st, 1);
            if (rx != NULL) snprintf(last_seen, sizeof(last_seen), "%s", (const char *)rx);
            if (found_channel != NULL) snprintf(actual_channel, sizeof(actual_channel), "%s", (const char *)found_channel);
            if (last_seen[0] != '\0') {
                time_t received = parse_db_timestamp(last_seen);
                if (received > 0) {
                    age = difftime(now, received);
                    if (age < 0.0) snprintf(status, sizeof(status), "warning");
                    else if (age <= DEVICE_ONLINE_SEC) snprintf(status, sizeof(status), "online");
                    else if (age <= DEVICE_WARNING_SEC) snprintf(status, sizeof(status), "warning");
                }
            }
        }
        sqlite3_finalize(st); st = NULL;
        esc_json((const unsigned char *)(actual_channel[0] != '\0' ? actual_channel : channel), channel_json, sizeof(channel_json));
        esc_json((const unsigned char *)last_seen, last_seen_json, sizeof(last_seen_json));
        if (!first_device) off = append_format(json, json_capacity, off, ",");
        first_device = false;
        off = append_format(json, json_capacity, off,
            "{\"device\":\"%s\",\"channel\":\"%s\",\"status\":\"%s\",\"last_seen\":\"%s\",\"packets\":[",
            device_json, channel_json, status, last_seen_json);

        /* Bind a separate latest-timestamp seek to bound the requested window. */
        sqlite3_finalize(st); st = NULL;
        if (sqlite3_prepare_v2(db,
            "WITH bounds AS (SELECT id,timestamp FROM telemetry WHERE channel_name IN (?1,?2) AND device_name=?3 ORDER BY id DESC LIMIT 1) "
            "SELECT t.id,t.timestamp,t.server_rx_ts,t.device_ts,t.packet_ts,t.latency_ms,"
            "t.channel_name,t.device_name,t.subdevice_name,t.process_name,t.subprocess_name,"
            "t.anomaly,t.reason,t.raw_json FROM telemetry t,bounds b WHERE t.channel_name IN (?1,?2) AND t.device_name=?3 "
            "AND (?4=0 OR t.timestamp>=strftime('%Y-%m-%dT%H:%M:%fZ',julianday(b.timestamp)-?4/86400.0)) "
            "ORDER BY t.id DESC LIMIT 32", -1, &st, NULL) != SQLITE_OK) {
            off = append_format(json, json_capacity, off, "]}");
            continue;
        }
        sqlite3_bind_text(st, 1, channel, -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(st, 2, alternate_channel, -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(st, 3, canonical, -1, SQLITE_TRANSIENT);
        sqlite3_bind_int(st, 4, seconds);
        while (sqlite3_step(st) == SQLITE_ROW && off < (int)json_capacity - 65536) {
            char ts[256], server_ts[256], device_ts[256], packet_ts[256];
            char chan[256], dev[256], sub[256], process[256], subprocess[256], reason[512];
            const unsigned char *raw = sqlite3_column_text(st, 13);
            if (raw == NULL) continue;
            esc_json(sqlite3_column_text(st, 1), ts, sizeof(ts));
            esc_json(sqlite3_column_text(st, 2), server_ts, sizeof(server_ts));
            esc_json(sqlite3_column_text(st, 3), device_ts, sizeof(device_ts));
            esc_json(sqlite3_column_text(st, 4), packet_ts, sizeof(packet_ts));
            esc_json(sqlite3_column_text(st, 6), chan, sizeof(chan));
            esc_json(sqlite3_column_text(st, 7), dev, sizeof(dev));
            esc_json(sqlite3_column_text(st, 8), sub, sizeof(sub));
            esc_json(sqlite3_column_text(st, 9), process, sizeof(process));
            esc_json(sqlite3_column_text(st, 10), subprocess, sizeof(subprocess));
            esc_json(sqlite3_column_text(st, 12), reason, sizeof(reason));
            if (!first_packet) off = append_format(json, json_capacity, off, ",");
            first_packet = false; packets++;
            off = append_format(json, json_capacity, off,
                "{\"timestamp\":\"%s\",\"server_rx_ts\":\"%s\",\"device_ts\":\"%s\",\"packet_ts\":\"%s\","
                "\"latency_ms\":%.3f,\"channel\":\"%s\",\"device\":\"%s\",\"subdevice\":\"%s\","
                "\"process\":\"%s\",\"subprocess\":\"%s\",\"anomaly\":%d,\"reason\":\"%s\",\"payload\":%s}",
                ts, server_ts, device_ts, packet_ts, sqlite3_column_double(st, 5),
                chan, dev, sub, process, subprocess, sqlite3_column_int(st, 11), reason, (const char *)raw);
        }
        sqlite3_finalize(st); st = NULL;
        off = append_format(json, json_capacity, off, "]}");
        (void)packets;
    }
    sqlite3_finalize(st);
    sqlite3_close(db);
    off = append_format(json, json_capacity, off, "]}");
    reply_json(c, json);
    free(json);
}

/**
 * @brief Return the latest telemetry values for a selected device or process.
 */
static void api_latest(struct mg_connection *c, struct mg_http_message *hm) {
    char name[128];
    sqlite3 *db = open_for_api(hm);

    get_var(hm, "name", name, sizeof(name));

    if (db == NULL) {
        reply_json(c, "[]");
        return;
    }

   rows_query(c,
           db,
    "SELECT tr.timestamp,tr.channel_name,tr.device_name,tr.subdevice_name,tr.process_name,"
    "tr.subprocess_name,tr.value_key,tr.value_type,tr.value_num,tr.value_text,tr.anomaly,tr.reason,"
"tr.timestamp,'','',0,tr.source_ip,tr.source_port "
    "FROM telemetry_rows tr "
    "WHERE (tr.device_name=? OR (?='DRIVE_UNIT' AND tr.device_name IN ('TRACKER_PUBLISH_UNIT','TRACKER_PUBLISH','DRIVE','DRIVE_WCS','LCU_UNIT'))) "
    "ORDER BY tr.id DESC "
    "LIMIT 300",
    name,
    name,
    NULL);

    sqlite3_close(db);
}

/**
 * @brief Return packet and anomaly counts for a selected device.
 */
static void api_device_count(struct mg_connection *c, struct mg_http_message *hm) {
    char name[128];
    sqlite3 *db = open_for_api(hm);
    sqlite3_stmt *st = NULL;
    char json[512];
    int rows = 0;
    int anomalies = 0;
    char last_seen[128] = "";

    get_var(hm, "name", name, sizeof(name));

    if (name[0] == '\0') {
        get_var(hm, "device", name, sizeof(name));
    }

    if (db == NULL) {
        reply_json(c, "{\"rows\":0,\"anomalies\":0,\"last_seen\":\"\"}");
        return;
    }

    if (sqlite3_prepare_v2(
            db,
            "SELECT COUNT(*),IFNULL(SUM(anomaly),0),IFNULL(MAX(timestamp),'') "
            "FROM telemetry_rows WHERE (device_name=? OR "
            "(?='DRIVE_UNIT' AND device_name IN "
            "('TRACKER_PUBLISH_UNIT','TRACKER_PUBLISH','DRIVE','DRIVE_WCS','LCU_UNIT')))",
            -1,
            &st,
            NULL) == SQLITE_OK) {

        sqlite3_bind_text(st, 1, name, -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(st, 2, name, -1, SQLITE_TRANSIENT);

        if (sqlite3_step(st) == SQLITE_ROW) {
            const unsigned char *ts = sqlite3_column_text(st, 2);

            rows = sqlite3_column_int(st, 0);
            anomalies = sqlite3_column_int(st, 1);

            if (ts != NULL) {
                esc_json(ts, last_seen, sizeof(last_seen));
            }
        }
    }

    sqlite3_finalize(st);
    sqlite3_close(db);

    snprintf(json,
             sizeof(json),
             "{\"rows\":%d,\"anomalies\":%d,\"last_seen\":\"%s\"}",
             rows,
             anomalies,
             last_seen);

    reply_json(c, json);
}

/**
 * @brief Search stored telemetry using validated filters and a bounded result set.
 */
static void api_search(struct mg_connection *c, struct mg_http_message *hm) {
    char q[128];
    char like[160];
    sqlite3 *db = open_for_api(hm);

    get_var(hm, "q", q, sizeof(q));
    snprintf(like, sizeof(like), "%%%s%%", q);

    if (db == NULL) {
        reply_json(c, "[]");
        return;
    }

    rows_query(c,
               db,
        "SELECT tr.timestamp,tr.channel_name,tr.device_name,tr.subdevice_name,tr.process_name,"
        "tr.subprocess_name,tr.value_key,tr.value_type,tr.value_num,tr.value_text,tr.anomaly,tr.reason,"
        "(SELECT x.server_rx_ts FROM telemetry x WHERE x.timestamp=tr.timestamp AND x.channel_name=tr.channel_name AND x.device_name=tr.device_name ORDER BY x.id DESC LIMIT 1),"
        "(SELECT x.device_ts FROM telemetry x WHERE x.timestamp=tr.timestamp AND x.channel_name=tr.channel_name AND x.device_name=tr.device_name ORDER BY x.id DESC LIMIT 1),"
        "(SELECT x.packet_ts FROM telemetry x WHERE x.timestamp=tr.timestamp AND x.channel_name=tr.channel_name AND x.device_name=tr.device_name ORDER BY x.id DESC LIMIT 1),"
        "(SELECT x.latency_ms FROM telemetry x WHERE x.timestamp=tr.timestamp AND x.channel_name=tr.channel_name AND x.device_name=tr.device_name ORDER BY x.id DESC LIMIT 1) "
        "FROM telemetry_rows tr "
        "WHERE tr.device_name LIKE ? OR tr.process_name LIKE ? "
        "ORDER BY tr.id DESC "
        "LIMIT 300",
        like,
        like,
        NULL);

    sqlite3_close(db);
}

/**
 * @brief Return historical telemetry for a device and time range.
 */
static void api_history(struct mg_connection *c, struct mg_http_message *hm) {

    char dev[128];
    char key[MAX_JSON];
    char range[32];
    char limit_text[32];
    char sql[2048];
    int result_limit = 2000;

    sqlite3 *db = open_for_api(hm);

    get_var(hm, "device", dev, sizeof(dev));
    get_var(hm, "key", key, sizeof(key));
    get_var(hm, "range", range, sizeof(range));
    get_var(hm, "limit", limit_text, sizeof(limit_text));
    if ((limit_text[0] != '\0') &&
        !parse_int_value(limit_text, 100, 5000, &result_limit)) {
        result_limit = 2000;
    }

    if (db == NULL) {
        reply_json(c, "[]");
        return;
    }

    /* Every original numeric leaf is graphable, including fields beyond the
     * bounded wide projection. Optional source/channel filters keep senders
     * independent. LIMIT and the existing query budget bound each request. */
    if (key[0] != '\0') {
        char ip[64], channel[128];
        char *query;
        sqlite3_stmt *probe = NULL;
        bool found = false;
        get_var(hm,"source_ip",ip,sizeof(ip));
        get_var(hm,"channel",channel,sizeof(channel));
        if (sqlite3_prepare_v2(db,
            "SELECT 1 FROM telemetry_extra_fields WHERE device_name=?1 AND field_name=?2 AND field_type='num' LIMIT 1",
            -1,&probe,NULL)==SQLITE_OK) {
            sqlite3_bind_text(probe,1,canonical_api_device_name(dev),-1,SQLITE_TRANSIENT);
            sqlite3_bind_text(probe,2,key,-1,SQLITE_TRANSIENT);
            found=sqlite3_step(probe)==SQLITE_ROW;
        }
        sqlite3_finalize(probe);
        if (found) {
            int seconds = (strcmp(range,"all")==0 || !range[0]) ? 0 : range_seconds(range);
            query=sqlite3_mprintf(
                "SELECT timestamp,channel_name,device_name,'','','',field_name,field_type,value_num,value_text,0,'',timestamp,'','',0,source_ip,source_port "
                "FROM telemetry_extra_fields WHERE device_name=?1 AND field_name=?2 AND field_type='num' "
                "AND (%Q='' OR source_ip=%Q) AND (%Q='' OR channel_name=%Q) "
                "AND (%d=0 OR timestamp>=strftime('%%Y-%%m-%%dT%%H:%%M:%%fZ',"
                "(SELECT MAX(timestamp) FROM telemetry_extra_fields WHERE device_name=?1 AND field_name=?2), '-%d seconds')) "
                "ORDER BY id DESC LIMIT %d",ip,ip,channel,channel,seconds,seconds,result_limit);
            if(query!=NULL) {
                rows_query(c,db,query,canonical_api_device_name(dev),key,NULL);
                sqlite3_free(query); sqlite3_close(db); return;
            }
        }
    }

    /* Captured, reviewed device fields live in the wide per-device table.
     * Older databases retain the same values in telemetry_extra_fields, so
     * queries transparently fall back without rewriting historical files. */
    {
        const char *canonical_device = canonical_api_device_name(dev);
        const char *observed_type = observed_column_type(canonical_device, key);
        if ((observed_type != NULL) && (STRICMP(observed_type, "REAL") == 0)) {
            char table[192];
            device_table_name(canonical_device, table, sizeof(table));
            if (telemetry_column_exists_db(db, table, key)) {
                if ((strcmp(range, "all") == 0) || (range[0] == '\0')) {
                    snprintf(sql,sizeof(sql),
                        "SELECT timestamp,channel_name,device_name,subdevice_name,process_name,subprocess_name,"
                        "'%s','num',\"%s\",'',anomaly,reason,server_rx_ts,device_ts,packet_ts,latency_ms "
                        "FROM \"%s\" WHERE \"%s\" IS NOT NULL ORDER BY id DESC LIMIT %d",
                        key,key,table,key,result_limit);
                } else {
                    snprintf(sql,sizeof(sql),
                        "SELECT timestamp,channel_name,device_name,subdevice_name,process_name,subprocess_name,"
                        "'%s','num',\"%s\",'',anomaly,reason,server_rx_ts,device_ts,packet_ts,latency_ms "
                        "FROM \"%s\" WHERE \"%s\" IS NOT NULL AND timestamp>=strftime(" 
                        "'%%Y-%%m-%%dT%%H:%%M:%%fZ',(SELECT MAX(timestamp) FROM \"%s\" WHERE \"%s\" IS NOT NULL),'-%d seconds') "
                        "ORDER BY id DESC LIMIT %d",key,key,table,key,table,key,range_seconds(range),result_limit);
                }
                rows_query(c,db,sql,NULL,NULL,NULL);sqlite3_close(db);return;
            }
            if ((strcmp(range, "all") == 0) || (range[0] == '\0')) {
                snprintf(sql,sizeof(sql),
                    "SELECT timestamp,channel_name,device_name,'','','',field_name,field_type,value_num,value_text,0,'',timestamp,'','',0 "
                    "FROM telemetry_extra_fields WHERE (device_name=?1 OR (?1='WCS_CONSOLE' AND UPPER(device_name)='WCS')) AND field_name=?2 AND field_type='num' ORDER BY id DESC LIMIT %d",result_limit);
            } else {
                snprintf(sql,sizeof(sql),
                    "SELECT timestamp,channel_name,device_name,'','','',field_name,field_type,value_num,value_text,0,'',timestamp,'','',0 "
                    "FROM telemetry_extra_fields WHERE (device_name=?1 OR (?1='WCS_CONSOLE' AND UPPER(device_name)='WCS')) AND field_name=?2 AND field_type='num' AND timestamp>=strftime(" 
                    "'%%Y-%%m-%%dT%%H:%%M:%%fZ',(SELECT MAX(timestamp) FROM telemetry_extra_fields WHERE (device_name=?1 OR (?1='WCS_CONSOLE' AND UPPER(device_name)='WCS')) AND field_name=?2),'-%d seconds') "
                    "ORDER BY id DESC LIMIT %d",range_seconds(range),result_limit);
            }
            rows_query(c,db,sql,canonical_device,key,NULL);sqlite3_close(db);return;
        }
    }

    /*
      If "all" selected -> no time filter
      otherwise apply range filter
    */

    if (strcmp(range, "all") == 0 || range[0] == '\0') {

        snprintf(
            sql,
            sizeof(sql),

            "SELECT "
            "timestamp,"
            "channel_name,"
            "device_name,"
            "subdevice_name,"
            "process_name,"
            "subprocess_name,"
            "value_key,"
            "value_type,"
            "value_num,"
            "value_text,"
            "anomaly,"
            "reason "

            "FROM telemetry_rows "

            "WHERE (device_name=?1 OR (?1='WCS_CONSOLE' AND UPPER(device_name)='WCS')) "
            "AND value_key=?2 "
            "AND value_type='num' "

            "ORDER BY timestamp DESC "
            "LIMIT %d",
            result_limit
        );

    } else {

        snprintf(
            sql,
            sizeof(sql),

            "SELECT "
            "timestamp,"
            "channel_name,"
            "device_name,"
            "subdevice_name,"
            "process_name,"
            "subprocess_name,"
            "value_key,"
            "value_type,"
            "value_num,"
            "value_text,"
            "anomaly,"
            "reason "

            "FROM telemetry_rows "

            "WHERE (device_name=?1 OR (?1='WCS_CONSOLE' AND UPPER(device_name)='WCS')) "
            "AND value_key=?2 "
            "AND value_type='num' "

            "AND timestamp >= strftime('%%Y-%%m-%%dT%%H:%%M:%%fZ',"
            "(SELECT MAX(timestamp) FROM telemetry_rows WHERE (device_name=?1 OR (?1='WCS_CONSOLE' AND UPPER(device_name)='WCS')) AND value_key=?2),"
            "'-%d seconds') "

            "ORDER BY timestamp DESC "
            "LIMIT %d",

            range_seconds(range),
            result_limit
        );
    }

    rows_query(c, db, sql, dev, key, NULL);

    sqlite3_close(db);
}

/**
 * @brief Return persisted HMI state-transition audit records.
 */
static void api_hmi_logs(
    struct mg_connection *c,
    struct mg_http_message *hm
) {

    sqlite3 *db = open_for_api(hm);

    sqlite3_stmt *st = NULL;

    char control[128];
    char device[128];
    const char *canonical_device;

    char json[65536];

    int off = 0;

    int first = 1;

    get_var(hm, "control", control, sizeof(control));
    get_var(hm, "device", device, sizeof(device));
    canonical_device = canonical_api_device_name(device);

    if (db == NULL) {
        reply_json(c, "[]");
        return;
    }

    off = append_format(json, sizeof(json), off, "[");

    if (sqlite3_prepare_v2(

        db,

        "SELECT "
        "timestamp,"
        "device_name,"
        "control_name,"
        "previous_state,"
        "new_state,"
        "toggle_count,"
        "on_duration_ms,"
        "session_id "

        "FROM hmi_event_log "

        "WHERE (?='' OR control_name=?) "
        "AND (?='' OR device_name=?) "

        "ORDER BY id DESC "
        "LIMIT 200",

        -1,
        &st,
        NULL

    ) == SQLITE_OK) {

        sqlite3_bind_text(st, 1, control, -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(st, 2, control, -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(st, 3, canonical_device, -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(st, 4, canonical_device, -1, SQLITE_TRANSIENT);

        while (sqlite3_step(st) == SQLITE_ROW) {

            if (!first) {
                off = append_format(json, sizeof(json), off, ",");
            }

            first = 0;

            off = append_format(

                json, sizeof(json), off,

                "{"
                "\"timestamp\":\"%s\","
                "\"device\":\"%s\","
                "\"control\":\"%s\","
                "\"previous\":%d,"
                "\"new\":%d,"
                "\"toggles\":%d,"
                "\"duration\":%lld,"
                "\"session\":\"%s\""
                "}",

                sqlite3_column_text(st, 0),
                sqlite3_column_text(st, 1),
                sqlite3_column_text(st, 2),
                sqlite3_column_int(st, 3),
                sqlite3_column_int(st, 4),
                sqlite3_column_int(st, 5),
                sqlite3_column_int64(st, 6),
                sqlite3_column_text(st, 7)
            );
        }
    }

    sqlite3_finalize(st);

    sqlite3_close(db);

    off = append_format(json, sizeof(json), off, "]");

    reply_json(c, json);
}

/**
 * @brief Return numeric time-series samples for requested devices and fields.
 */
static void api_metrics(struct mg_connection *c, struct mg_http_message *hm) {
    char name[128];
    sqlite3 *db = open_for_api(hm);
    sqlite3_stmt *st = NULL;
    char json[65536];
    int off = 0;
    int first = 1;

    get_var(hm, "name", name, sizeof(name));

    if (name[0] == '\0') {
        get_var(hm, "device", name, sizeof(name));
    }

    if (db == NULL) {
        reply_json(c, "[]");
        return;
    }

    off = append_format(json, sizeof(json), off, "[");

    if (sqlite3_prepare_v2(db,
       "SELECT value_key,COUNT(*),MIN(value_num),MAX(value_num) "
       "FROM telemetry_rows "
      "WHERE (device_name=? OR (?='DRIVE_UNIT' AND device_name IN "
      "('TRACKER_PUBLISH_UNIT','TRACKER_PUBLISH','DRIVE','DRIVE_WCS','LCU_UNIT'))) "
      "AND value_type='num' "
      "GROUP BY value_key "
      "ORDER BY value_key",
        -1,
        &st,
        NULL) == SQLITE_OK) {

        sqlite3_bind_text(st, 1, name, -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(st, 2, name, -1, SQLITE_TRANSIENT);

        while ((sqlite3_step(st) == SQLITE_ROW) && (off < ((int)sizeof(json) - 512))) {
            char metric[256];

            esc_json(sqlite3_column_text(st, 0), metric, sizeof(metric));

            if (!first) off = append_format(json, sizeof(json), off, ",");
            first = 0;

            off = append_format(json, sizeof(json), off,
                "{\"metric\":\"%s\","
                "\"count\":%d,"
                "\"min\":%.3f,"
                "\"max\":%.3f}",
                metric,
                sqlite3_column_int(st, 1),
                sqlite3_column_double(st, 2),
                sqlite3_column_double(st, 3));
        }
    } else {
        printf("api_metrics SQL error: %s\n", sqlite3_errmsg(db));
    }

    {
        const char *canonical=canonical_api_device_name(name);
        size_t i;
        for(i=0U;i<sizeof(g_observed_columns)/sizeof(g_observed_columns[0]);++i){
            char metric[256];
            if(STRICMP(g_observed_columns[i].device,canonical)!=0 ||
               STRICMP(g_observed_columns[i].type,"REAL")!=0)continue;
            esc_json((const unsigned char *)g_observed_columns[i].name,metric,sizeof(metric));
            if(!first) off=append_format(json,sizeof(json),off,",");
            first=0;
            off=append_format(json,sizeof(json),off,
                "{\"metric\":\"%s\",\"count\":0,\"min\":0,\"max\":0}",metric);
        }
    }

    sqlite3_finalize(st);
    sqlite3_close(db);

    snprintf(json + off,
         sizeof(json) - (size_t)off,"]");
    reply_json(c, json);
}

/**
 * @brief Accept an HTTP-supplied telemetry packet for local testing.
 */
static void api_simulate(
    struct mg_connection *c,
    struct mg_http_message *hm) {

    char body[65536];

    if (!g_simulator_enabled) {
        mg_http_reply(
            c,
            403,
            "Content-Type: application/json\r\n",
            "{\"ok\":false,\"error\":\"simulator disabled\"}"
        );
        return;
    }

    if ((hm == NULL) || (hm->body.len == 0)) {
        mg_http_reply(
            c,
            400,
            "Content-Type: application/json\r\n",
            "{\"ok\":false,\"error\":\"empty payload\"}"
        );
        return;
    }

    snprintf(body,
             sizeof(body),
             "%.*s",
             (int) hm->body.len,
             hm->body.buf);

    enqueue_ingest_record(body, "simulator", "127.0.0.1", 0);

    mg_http_reply(
        c,
        200,
        "Content-Type: application/json\r\n",
        "{\"ok\":true}"
    );
}
/**
 * @brief Return deterministic health findings derived from current telemetry statistics.
 */
static void api_ai_health(
    struct mg_connection *c,
    struct mg_http_message *hm
) {

    sqlite3 *db = open_for_api(hm);

    sqlite3_stmt *st = NULL;

    char json[32768];

    int off = 0;

    int first = 1;

    if (db == NULL) {

        reply_json(c, "[]");

        return;
    }

    off = append_format(json, sizeof(json), off, "[");

    if (sqlite3_prepare_v2(

        db,

        "SELECT "
        "device_name,"
        "COUNT(*),"
        "IFNULL(SUM(anomaly),0),"
        "AVG(latency_ms),"
        "MAX(timestamp) "

        "FROM telemetry "

        "GROUP BY device_name",

        -1,
        &st,
        NULL

    ) == SQLITE_OK) {

        while (sqlite3_step(st) == SQLITE_ROW) {

            const char *risk = "LOW";

            int rows =
                sqlite3_column_int(st, 1);

            int anomalies =
                sqlite3_column_int(st, 2);

            double latency =
                sqlite3_column_double(st, 3);

            const char *last_seen =
                (const char *)sqlite3_column_text(st, 4);

            time_t last_time =
                parse_db_timestamp(last_seen);

            double age_sec =
                (last_time > 0)
                    ? difftime(time(NULL), last_time)
                    : 999999.0;

            double score = 100.0;

            double anomaly_rate =
                rows > 0
                    ? ((double)anomalies / (double)rows)
                    : 1.0;

            if (age_sec > DEVICE_ONLINE_SEC) {
                score -= 15.0;
            }

            if (age_sec > DEVICE_WARNING_SEC) {
                score -= 45.0;
            }

            score -= anomalies * 2.0;

            score -= anomaly_rate * 40.0;

            score -= latency * 0.1;

            if (rows < 10) {
                score -= 10.0;
            }

            if (score < 0) {
                score = 0;
            }

            if (score < 40) {
                risk = "HIGH";
            }
            else if (score < 70) {
                risk = "MEDIUM";
            }

            if (!first) {
                off = append_format(json, sizeof(json), off, ",");
            }

            first = 0;

            off = append_format(

                json, sizeof(json), off,

                "{"

                "\"device\":\"%s\","
                "\"rows\":%d,"
                "\"anomalies\":%d,"
                "\"latency\":%.2f,"
                "\"health\":%.2f,"
                "\"risk\":\"%s\""

                "}",

                sqlite3_column_text(st, 0),

                rows,

                anomalies,

                latency,

                score,

                risk
            );
        }
    }

    sqlite3_finalize(st);

    sqlite3_close(db);

    off = append_format(json, sizeof(json), off, "]");

    reply_json(c, json);
}
/*
 * Packet Verify helpers.
 *
 * These helpers create one clean device-wise verification result per physical
 * device. They avoid the old problem where UDP/parser counters were shown from
 * live channel statistics but database rows were missing because the page was
 * checking only the channel object, not the SQLite telemetry table.
 */

typedef struct {
    const char *name;
    const char *channels[6];
    const char *aliases[8];
} diagnostic_device_def_t;

static const diagnostic_device_def_t g_diagnostic_devices[] = {
    {
        "LCU_UNIT",
        {"lcu_transport", NULL},
        {"LCU_UNIT", "LCU", "lcu_transport", NULL}
    },
    {
        "JOYSTICK_UNIT",
        {"joystick", NULL},
        {"JOYSTICK_UNIT", "JOYSTICK", "joystick", NULL}
    },
    {
        "BUTTON_LED_UNIT",
        {"button_led", NULL},
        {"BUTTON_LED_UNIT", "BUTTON_LED", "BUTTON", "button_led", NULL}
    },
    {
        "CAMERA_UNIT",
        {"tracker_telemetry", "tracker_telem", NULL},
        {"CAMERA_UNIT", "CAMERA", "tracker_telemetry", "tracker_telem", NULL}
    },
    {
        "EXTERNAL_TRACK_UNIT",
        {"external_track", NULL},
        {"EXTERNAL_TRACK_UNIT", "EXTERNAL_TRACK", "external_track", NULL}
    },
    {
        "DRIVE_UNIT",
        {"drive_wcs", "tracker_publish", "lcu_transport", NULL},
        {"DRIVE_UNIT", "DRIVE", "drive_wcs", "TRACKER_PUBLISH_UNIT", "tracker_publish", NULL}
    },
    {
        "IMU_UNIT",
        {"imu", NULL},
        {"IMU_UNIT", "IMU", "imu", NULL}
    },
    {
        "MAIN_DISPLAY",
        {"maindisplay", "main_display", NULL},
        {"MAIN_DISPLAY", "MAINDISPLAY", "main_display", "maindisplay", NULL}
    },
    {
        "WCS_CONSOLE",
        {"wcs_control_console", NULL},
        {"WCS_CONSOLE", "WCS_CONTROL_CONSOLE", "WCS", "wcs_control_console", NULL}
    },
    {
        "CCE_GATEWAY",
        {"cce_gateway", NULL},
        {"CCE_GATEWAY", "CCE", "cce_gateway", NULL}
    },
    {
        "ADVANTECH_IO",
        {"advantec_driver", NULL},
        {"ADVANTECH_IO", "ADVANTECH", "ADVANTEC_DRIVER", "advantec_driver", NULL}
    }
};

static int diagnostic_channel_matches(const diagnostic_device_def_t *def,
                                      const char *channel_name) {
    int i;

    if ((def == NULL) || (channel_name == NULL)) {
        return 0;
    }

    for (i = 0; def->channels[i] != NULL; ++i) {
        if (STRICMP(def->channels[i], channel_name) == 0) {
            return 1;
        }
    }

    return 0;
}

static void diagnostic_udp_totals_for_device(const diagnostic_device_def_t *def,
                                             const udp_stats_t *snapshot,
                                             int snapshot_count,
                                             uint64_t *received,
                                             uint64_t *accepted,
                                             uint64_t *rejected,
                                             char *last_src,
                                             size_t last_src_size,
                                             int *last_src_port,
                                             char *endpoints,
                                             size_t endpoints_size) {
    int i;
    int first_endpoint = 1;

    if (received != NULL) *received = 0U;
    if (accepted != NULL) *accepted = 0U;
    if (rejected != NULL) *rejected = 0U;
    if ((last_src != NULL) && (last_src_size > 0U)) last_src[0] = '\0';
    if (last_src_port != NULL) *last_src_port = 0;
    if ((endpoints != NULL) && (endpoints_size > 0U)) endpoints[0] = '\0';

    if ((def == NULL) || (snapshot == NULL)) {
        return;
    }

    for (i = 0; i < snapshot_count; ++i) {
        if (!diagnostic_channel_matches(def, g_channels[i].name)) {
            continue;
        }

        if (received != NULL) {
            *received += snapshot[i].received_packets;
        }
        if (accepted != NULL) {
            *accepted += snapshot[i].accepted_packets;
        }
        if (rejected != NULL) {
            *rejected += snapshot[i].rejected_packets;
        }

        if ((snapshot[i].last_udp_src[0] != '\0') &&
            (last_src != NULL) &&
            (last_src_size > 0U)) {
            snprintf(last_src, last_src_size, "%s", snapshot[i].last_udp_src);
            if (last_src_port != NULL) {
                *last_src_port = snapshot[i].last_udp_src_port;
            }
        }

        if ((endpoints != NULL) && (endpoints_size > 0U)) {
            size_t used = strlen(endpoints);

            if (!first_endpoint && ((used + 2U) < endpoints_size)) {
                strncat(endpoints, ", ", endpoints_size - used - 1U);
                used = strlen(endpoints);
            }

            if ((used + 32U) < endpoints_size) {
                char ep[96];

                snprintf(ep,
                         sizeof(ep),
                         "%s:%d",
                         g_channels[i].group_ip,
                         g_channels[i].port);

                strncat(endpoints, ep, endpoints_size - strlen(endpoints) - 1U);
                first_endpoint = 0;
            }
        }
    }
}

static void diagnostic_db_totals_for_device(sqlite3 *db,
                                            const diagnostic_device_def_t *def,
                                            sqlite3_int64 *db_rows,
                                            char *latest_ts,
                                            size_t latest_ts_size) {
    sqlite3_stmt *st = NULL;
    char table[192],sql[512];

    if (db_rows != NULL) {
        *db_rows = 0;
    }

    if ((latest_ts != NULL) && (latest_ts_size > 0U)) {
        latest_ts[0] = '\0';
    }

    if ((db == NULL) || (def == NULL)) {
        return;
    }

    device_table_name(def->name,table,sizeof(table));
    snprintf(sql,sizeof(sql),"SELECT COUNT(*),IFNULL(MAX(timestamp),'') FROM \"%s\"",table);
    if(sqlite3_prepare_v2(db,sql,-1,&st,NULL)==SQLITE_OK && sqlite3_step(st)==SQLITE_ROW){
        if(db_rows)*db_rows=sqlite3_column_int64(st,0);
        if(latest_ts&&latest_ts_size>0U){const unsigned char *txt=sqlite3_column_text(st,1);snprintf(latest_ts,latest_ts_size,"%s",txt?(const char*)txt:"");}
    }
    sqlite3_finalize(st);
}

static void diagnostic_value_keys_for_device(sqlite3 *db,
                                             const diagnostic_device_def_t *def,
                                             char *out,
                                             size_t out_size) {
    sqlite3_stmt *st = NULL;
    int first = 1;
    char table[192],sql[TELEMETRY_INSERT_SQL_MAX];
    size_t used=0U,i; int selected=0;

    if ((out != NULL) && (out_size > 0U)) {
        out[0] = '\0';
    }

    if ((db == NULL) || (def == NULL) || (out == NULL) || (out_size == 0U)) {
        return;
    }

    device_table_name(def->name,table,sizeof(table));
    used=(size_t)snprintf(sql,sizeof(sql),"SELECT ");
    for(i=0U;i<sizeof(g_approved_columns)/sizeof(g_approved_columns[0]);++i){
        if(!device_approved_column(def->name,g_approved_columns[i].name))continue;
        used+=(size_t)snprintf(sql+used,sizeof(sql)-used,"%sMAX(\"%s\" IS NOT NULL)",selected?",":"",g_approved_columns[i].name);selected++;
    }
    snprintf(sql+used,sizeof(sql)-used," FROM \"%s\"",table);
    if(selected>0 && sqlite3_prepare_v2(db,sql,-1,&st,NULL)==SQLITE_OK && sqlite3_step(st)==SQLITE_ROW){
        int col=0;
        for(i=0U;i<sizeof(g_approved_columns)/sizeof(g_approved_columns[0]);++i){
            if(!device_approved_column(def->name,g_approved_columns[i].name))continue;
            if(sqlite3_column_int(st,col++)!=0 && strlen(out)+strlen(g_approved_columns[i].name)+4U<out_size){
                if(!first)strncat(out,",",out_size-strlen(out)-1U);
                strncat(out,"\"",out_size-strlen(out)-1U);strncat(out,g_approved_columns[i].name,out_size-strlen(out)-1U);strncat(out,"\"",out_size-strlen(out)-1U);first=0;
            }
        }
    }

    sqlite3_finalize(st);
}
/**
 * @brief Return packet-pipeline, queue, database, WebSocket, and field diagnostics.
 */
static void api_diagnostic(
    struct mg_connection *c,
    struct mg_http_message *hm
) {
    char selected_db[128];
    char selected_db_json[256];
    char resolved_db_path[512];
    char resolved_db_path_json[1024];
    char db_dir_json[512];
    sqlite3 *db = open_for_api(hm);
    sqlite3_stmt *st = NULL;
    char json[131072];
    int off = 0;
    sqlite3_int64 rows = 0;
    sqlite3_int64 field_rows = 0;
    int devs = 0;
    int metrics = 0;
    int field_count = 0;
    char first_ts[128] = "";
    char last_ts[128] = "";
    int ws_clients = 0;
    int ws_queue_len = 0;
    uint64_t ws_delivered = 0U;
    uint64_t ws_dropped = 0U;
    int ingest_queue_len = 0;
    size_t ingest_queue_bytes = 0U;
    uint64_t ingest_backpressure_events = 0U;
    uint64_t ingest_dropped = 0U;
    uint64_t db_writer_committed = 0U;
    uint64_t db_pending = 0U;
    uint64_t db_failures = 0U;
    uint64_t db_retries = 0U;
    uint64_t disk_free_bytes = 0U;
    uint64_t disk_total_bytes = 0U;
    uint64_t active_daily_db_bytes = 0U;
    uint64_t active_daily_wal_bytes = 0U;
    char db_last_error[256] = "";
    char db_last_error_json[512] = "";
    char indexed_fields_json[4096] = "";
    udp_stats_t snapshot[MAX_CHANNELS];
    pipeline_stats_t pipeline_snapshot;
    int snapshot_count = g_channel_count;
    int first_field = 1;

    get_var(hm, "db", selected_db, sizeof(selected_db));
    if ((selected_db[0] == '\0') || !safe_name(selected_db)) {
        today_db_name(selected_db, sizeof(selected_db));
    }
    make_db_path(selected_db, resolved_db_path, sizeof(resolved_db_path));
    storage_space_bytes(g_db_dir, &disk_free_bytes, &disk_total_bytes);
    active_daily_db_bytes=storage_file_size(resolved_db_path);
    { char wal_path[1100]; snprintf(wal_path,sizeof(wal_path),"%s-wal",resolved_db_path); active_daily_wal_bytes=storage_file_size(wal_path); }
    esc_json((const unsigned char *)selected_db,
             selected_db_json,
             sizeof(selected_db_json));
    esc_json((const unsigned char *)resolved_db_path,
             resolved_db_path_json,
             sizeof(resolved_db_path_json));
    esc_json((const unsigned char *)g_db_dir,
             db_dir_json,
             sizeof(db_dir_json));

    if (snapshot_count > MAX_CHANNELS) {
        snapshot_count = MAX_CHANNELS;
    }

    snapshot_udp_stats(snapshot, snapshot_count);
    lock_udp_stats();
    pipeline_snapshot = g_pipeline_stats;
    unlock_udp_stats();
    ingest_queue_snapshot(&ingest_queue_len,
                          &ingest_queue_bytes,
                          &ingest_backpressure_events,
                          &ingest_dropped,
                          &db_writer_committed,
                          &db_pending,
                          &db_failures,
                          &db_retries,
                          db_last_error,
                          sizeof(db_last_error));
    lock_ws_queue();
    ws_queue_len = g_ws_queue_len;
    ws_delivered = g_ws_delivered;
    ws_dropped = g_ws_dropped;
    unlock_ws_queue();
    ws_clients = api_ws_client_count();

    if (db != NULL) {
        if (sqlite3_prepare_v2(db,
            "SELECT IFNULL(MAX(id),0) FROM telemetry",
            -1,
            &st,
            NULL) == SQLITE_OK) {
            if (sqlite3_step(st) == SQLITE_ROW) {
                rows = sqlite3_column_int64(st, 0);
            }
        }
        sqlite3_finalize(st);
        st = NULL;

        if (sqlite3_prepare_v2(db,
            "SELECT COUNT(*) FROM (SELECT device_name FROM ("
            "SELECT device_name FROM telemetry ORDER BY id DESC LIMIT 10000"
            ") GROUP BY device_name LIMIT 300)",
            -1,
            &st,
            NULL) == SQLITE_OK) {
            if (sqlite3_step(st) == SQLITE_ROW) {
                devs = sqlite3_column_int(st, 0);
            }
        }
        sqlite3_finalize(st);
        st = NULL;

        if (sqlite3_prepare_v2(db,
            "SELECT "
            "(SELECT timestamp FROM telemetry ORDER BY id ASC LIMIT 1),"
            "(SELECT timestamp FROM telemetry ORDER BY id DESC LIMIT 1)",
            -1, &st, NULL) == SQLITE_OK) {
            if (sqlite3_step(st) == SQLITE_ROW) {
                esc_json(sqlite3_column_text(st, 0), first_ts, sizeof(first_ts));
                esc_json(sqlite3_column_text(st, 1), last_ts, sizeof(last_ts));
            }
        }
        sqlite3_finalize(st);
        st = NULL;

        if (sqlite3_prepare_v2(db,
            "SELECT IFNULL(MAX(id),0) FROM telemetry_rows",
            -1,
            &st,
            NULL) == SQLITE_OK) {
            if (sqlite3_step(st) == SQLITE_ROW) {
                field_rows = sqlite3_column_int64(st, 0);
            }
        }
        sqlite3_finalize(st);
        st = NULL;

        if (sqlite3_prepare_v2(db,
            "SELECT COUNT(*) FROM (SELECT process_name FROM ("
            "SELECT process_name,value_type FROM telemetry_rows ORDER BY id DESC LIMIT 10000"
            ") WHERE value_type='num' GROUP BY process_name LIMIT 300)",
            -1,
            &st,
            NULL) == SQLITE_OK) {
            if (sqlite3_step(st) == SQLITE_ROW) {
                metrics = sqlite3_column_int(st, 0);
            }
        }
        sqlite3_finalize(st);
        st = NULL;

        if (sqlite3_prepare_v2(db,
            "SELECT COUNT(*) FROM (SELECT value_key FROM ("
            "SELECT value_key,value_type FROM telemetry_rows ORDER BY id DESC LIMIT 10000"
            ") WHERE value_type='num' GROUP BY value_key LIMIT 500)",
            -1,
            &st,
            NULL) == SQLITE_OK) {
            if (sqlite3_step(st) == SQLITE_ROW) {
                field_count = sqlite3_column_int(st, 0);
            }
        }
        sqlite3_finalize(st);
        st = NULL;
    }

    esc_json((const unsigned char *)db_last_error,
             db_last_error_json,
             sizeof(db_last_error_json));
    esc_json((const unsigned char *)g_indexed_fields,
             indexed_fields_json,
             sizeof(indexed_fields_json));

    off = append_format(json, sizeof(json), off, "{");
    off = append_format(json, sizeof(json), off,
        "\"db_name\":\"%s\",\"db_dir\":\"%s\",\"db_path\":\"%s\","
        "\"rows\":%lld,\"packet_rows\":%lld,\"field_rows\":%lld,"
        "\"devices\":%d,\"metrics\":%d,\"field_count\":%d,"
        "\"storage_mode\":\"%s\",\"indexed_fields\":\"%s\","
        "\"first_timestamp\":\"%s\",\"last_timestamp\":\"%s\",",
        selected_db_json,
        db_dir_json,
        resolved_db_path_json,
        (long long)rows,
        (long long)rows,
        (long long)field_rows,
        devs,
        metrics,
        field_count,
        g_expand_all_fields != 0 ? "expanded" : "compact",
        indexed_fields_json,
        first_ts,
        last_ts);
    off = append_format(json, sizeof(json), off,
        "\"ws_clients\":%d,\"ws_queue_len\":%d,"
        "\"ws_delivered\":%llu,\"ws_dropped\":%llu,"
        "\"ingest_queue_len\":%d,\"ingest_dropped\":%llu,"
        "\"ingest_queue_bytes\":%llu,\"ingest_backpressure_events\":%llu,"
        "\"db_stored\":%lld,\"db_writer_committed\":%llu,"
        "\"db_pending\":%llu,\"db_failures\":%llu,"
        "\"db_retries\":%llu,\"db_last_error\":\"%s\","
        "\"daily_db_rotations\":%llu,\"daily_writer_failures\":%llu,"
        "\"emergency_log_packets\":%llu,\"disk_free_bytes\":%llu,"
        "\"disk_total_bytes\":%llu,\"active_daily_db_bytes\":%llu,"
        "\"active_daily_wal_bytes\":%llu,",
        ws_clients,
        ws_queue_len,
        (unsigned long long)ws_delivered,
        (unsigned long long)ws_dropped,
        ingest_queue_len,
        (unsigned long long)ingest_dropped,
        (unsigned long long)ingest_queue_bytes,
        (unsigned long long)ingest_backpressure_events,
        (long long)rows,
        (unsigned long long)db_writer_committed,
        (unsigned long long)db_pending,
        (unsigned long long)db_failures,
        (unsigned long long)db_retries,
        db_last_error_json,
        (unsigned long long)g_daily_db_rotations,
        (unsigned long long)db_failures,
        (unsigned long long)g_emergency_log_packets,
        (unsigned long long)disk_free_bytes,
        (unsigned long long)disk_total_bytes,
        (unsigned long long)active_daily_db_bytes,
        (unsigned long long)active_daily_wal_bytes);

    off = append_format(json, sizeof(json), off,
        "\"pipeline_counters\":{\"received\":%llu,\"valid_json\":%llu,"
        "\"malformed_json\":%llu,\"normalized\":%llu,\"stored\":%llu,"
        "\"rejected\":%llu,\"gui_delivered\":%llu},",
        (unsigned long long)pipeline_snapshot.received,
        (unsigned long long)pipeline_snapshot.valid_json,
        (unsigned long long)pipeline_snapshot.malformed_json,
        (unsigned long long)pipeline_snapshot.normalized,
        (unsigned long long)db_writer_committed,
        (unsigned long long)pipeline_snapshot.rejected,
        (unsigned long long)pipeline_snapshot.gui_delivered);

off = append_format(json, sizeof(json), off, "\"udp_channels\":[");
for (int i = 0; i < snapshot_count; ++i) {
    if (i > 0) {
        off = append_format(json, sizeof(json), off, ",");
    }

    off = append_format(json, sizeof(json), off,
        "{\"name\":\"%s\",\"group_ip\":\"%s\",\"port\":%d,"
        "\"received\":%llu,\"accepted\":%llu,\"rejected\":%llu,"
        "\"last_src\":\"%s\",\"last_src_port\":%d,\"last_received_ms\":%llu}",
        g_channels[i].name,
        g_channels[i].group_ip,
        g_channels[i].port,
        (unsigned long long)snapshot[i].received_packets,
        (unsigned long long)snapshot[i].accepted_packets,
        (unsigned long long)snapshot[i].rejected_packets,
        snapshot[i].last_udp_src,
        snapshot[i].last_udp_src_port,
        (unsigned long long)snapshot[i].last_received_ms);
}
off = append_format(json, sizeof(json), off, "]");

/*
 * Device-wise verification data for packet_verify.html.
 * This is separate from udp_channels because udp_channels are transport-level,
 * while the page needs physical-device-level PASS/FAIL confirmation.
 */
off = append_format(json, sizeof(json), off, ",\"device_traces\":[");

{
    size_t device_count =
        sizeof(g_diagnostic_devices) / sizeof(g_diagnostic_devices[0]);

    for (size_t i = 0U; i < device_count; ++i) {
        uint64_t rx = 0U;
        uint64_t ok = 0U;
        uint64_t bad = 0U;
        sqlite3_int64 device_db_rows = 0;
        char latest_db_ts[128];
        char latest_db_ts_json[256];
        char last_src[64];
        int last_src_port = 0;
        char endpoints[512];
        char endpoints_json[1024];
        char value_keys_json[2048];
        int gui_visible;
        int graph_visible;

        latest_db_ts[0] = '\0';
        latest_db_ts_json[0] = '\0';
        last_src[0] = '\0';
        endpoints[0] = '\0';
        endpoints_json[0] = '\0';
        value_keys_json[0] = '\0';

        diagnostic_udp_totals_for_device(&g_diagnostic_devices[i],
                                         snapshot,
                                         snapshot_count,
                                         &rx,
                                         &ok,
                                         &bad,
                                         last_src,
                                         sizeof(last_src),
                                         &last_src_port,
                                         endpoints,
                                         sizeof(endpoints));

        diagnostic_db_totals_for_device(db,
                                        &g_diagnostic_devices[i],
                                        &device_db_rows,
                                        latest_db_ts,
                                        sizeof(latest_db_ts));

        diagnostic_value_keys_for_device(db,
                                         &g_diagnostic_devices[i],
                                         value_keys_json,
                                         sizeof(value_keys_json));

        esc_json((const unsigned char *)latest_db_ts,
                 latest_db_ts_json,
                 sizeof(latest_db_ts_json));

        esc_json((const unsigned char *)endpoints,
                 endpoints_json,
                 sizeof(endpoints_json));

        /*
         * GUI/graph visibility here means the live GUI path is active and this
         * device has accepted packets. It avoids false GUI FAIL when the browser
         * is receiving live packets but the old per-device GUI flag is absent.
         */
        gui_visible = (device_db_rows > 0) && (value_keys_json[0] != '\0');
        graph_visible = (device_db_rows > 0) && (value_keys_json[0] != '\0');

        if (i > 0U) {
            off = append_format(json, sizeof(json), off, ",");
        }

        off = append_format(json, sizeof(json), off,
            "{"
            "\"name\":\"%s\","
            "\"device\":\"%s\","
            "\"group_ip\":\"%s\","
            "\"port\":0,"
            "\"udp_received\":%llu,"
            "\"parser_accepted\":%llu,"
            "\"parser_rejected\":%llu,"
            "\"db_rows\":%lld,"
            "\"database_rows\":%lld,"
            "\"latest_db_timestamp\":\"%s\","
            "\"last_db_ts\":\"%s\","
            "\"last_src\":\"%s\","
            "\"last_src_port\":%d,"
            "\"channels\":\"%s\","
            "\"value_keys\":[%s],"
            "\"gui_visible\":%s,"
            "\"graph_visible\":%s"
            "}",
            g_diagnostic_devices[i].name,
            g_diagnostic_devices[i].name,
            endpoints_json,
            (unsigned long long)rx,
            (unsigned long long)ok,
            (unsigned long long)bad,
            (long long)device_db_rows,
            (long long)device_db_rows,
            latest_db_ts_json,
            latest_db_ts_json,
            last_src,
            last_src_port,
            endpoints_json,
            value_keys_json,
            gui_visible ? "true" : "false",
            graph_visible ? "true" : "false");
    }
}

off = append_format(json, sizeof(json), off, "]");

    if (db != NULL) {
        if (sqlite3_prepare_v2(db,
            "SELECT value_key,COUNT(*) FROM ("
            "SELECT value_key,value_type FROM telemetry_rows ORDER BY id DESC LIMIT 10000"
            ") WHERE value_type='num' GROUP BY value_key ORDER BY COUNT(*) DESC LIMIT 25",
            -1,
            &st,
            NULL) == SQLITE_OK) {
            off = append_format(json, sizeof(json), off, ",\"field_samples\":[");
            while (sqlite3_step(st) == SQLITE_ROW) {
                char key[256];
                esc_json(sqlite3_column_text(st, 0), key, sizeof(key));
                if (!first_field) {
                    off = append_format(json, sizeof(json), off, ",");
                }
                first_field = 0;
                off = append_format(json, sizeof(json), off, "\"%s\"", key);
            }
            off = append_format(json, sizeof(json), off, "]");
        }
        sqlite3_finalize(st);
        sqlite3_close(db);
    }

    off = append_format(json, sizeof(json), off, "}");
    reply_json(c, json);
}
/**
 * @brief Replay stored packets through the live WebSocket path without reinserting them.
 */
static void api_replay(
    struct mg_connection *c,
    struct mg_http_message *hm
) {

    sqlite3 *db = open_for_api(hm);

    sqlite3_stmt *st = NULL;

    char *json;
    const size_t json_capacity = 1024U * 1024U;

    int off = 0;

    int first = 1;

    json = (char *)malloc(json_capacity);
    if (json == NULL) {
        if (db != NULL) sqlite3_close(db);
        mg_http_reply(c, 500, "", "memory error");
        return;
    }

    if (db == NULL) {

        reply_json(c, "[]");
        free(json);

        return;
    }

    off = append_format(json, json_capacity, off, "[");

    if (sqlite3_prepare_v2(

        db,

        "SELECT "
        "timestamp,"
        "device_name,"
        "process_name,"
        "value_key,"
        "value_num,"
        "anomaly "

        "FROM telemetry_rows "

        "WHERE value_type='num' "

        "ORDER BY id ASC "
        "LIMIT 50000",

        -1,
        &st,
        NULL

    ) == SQLITE_OK) {

        while (sqlite3_step(st) == SQLITE_ROW) {

            if (!first) {
                off = append_format(json, json_capacity, off, ",");
            }

            first = 0;

            off = append_format(

                json, json_capacity, off,

                "{"

                "\"timestamp\":\"%s\","
                "\"device\":\"%s\","
                "\"process\":\"%s\","
                "\"key\":\"%s\","
                "\"value\":%.3f,"
                "\"anomaly\":%d"

                "}",

                sqlite3_column_text(st, 0),

                sqlite3_column_text(st, 1),

                sqlite3_column_text(st, 2),

                sqlite3_column_text(st, 3),

                sqlite3_column_double(st, 4),

                sqlite3_column_int(st, 5)
            );
        }
    }

    sqlite3_finalize(st);

    sqlite3_close(db);

    off = append_format(json, json_capacity, off, "]");

    reply_json(c, json);
    free(json);
}
/**
 * @brief Dispatch Mongoose HTTP and WebSocket events to the appropriate application endpoint.
 * @param ev Mongoose event identifier.
 * @param ev_data Event-specific data supplied by Mongoose.
 */
static void api_storage_status(struct mg_connection *c) {
    int queue_len = 0;
    size_t queue_bytes = 0U;
    uint64_t dropped = 0U, stored = 0U, pending = 0U;
    uint64_t failures = 0U, retries = 0U, backpressure = 0U;
    char error[256], escaped[512], json[1536];
    packet_accounting_t a;
    bool worker_running;uint64_t worker_heartbeat,worker_age,oldest_queued_ms=0U,oldest_queue_age=0U;
    ingest_queue_snapshot(&queue_len, &queue_bytes, &backpressure, &dropped,
                          &stored, &pending, &failures, &retries,
                          error, sizeof(error));
    lock_ingest_queue(); a=g_packet_accounting;worker_running=g_ingest_worker_running;worker_heartbeat=g_ingest_worker_heartbeat_ms;
    {unsigned int lane;for(lane=0U;lane<INGEST_QUEUE_LANES;lane++){ingest_msg_t *queued=g_ingest_heads[lane];if(queued!=NULL&&(oldest_queued_ms==0U||queued->queued_ms<oldest_queued_ms))oldest_queued_ms=queued->queued_ms;}}
    unlock_ingest_queue();
    {uint64_t now=platform_monotonic_ms();worker_age=(worker_heartbeat==0U||now<worker_heartbeat)?UINT64_MAX:now-worker_heartbeat;}
    {uint64_t now=platform_monotonic_ms();oldest_queue_age=(oldest_queued_ms==0U||now<oldest_queued_ms)?0U:now-oldest_queued_ms;}
    platform_mutex_lock(&g_spool_mutex);
    g_spool_bytes=spool_usage_bytes();
    platform_mutex_unlock(&g_spool_mutex);
    esc_json((const unsigned char *)error, escaped, sizeof(escaped));
    snprintf(json, sizeof(json),
             "{\"ok\":%s,\"message\":\"%s\",\"queue_len\":%d,"
             "\"queue_bytes\":%llu,\"stored\":%llu,\"pending\":%llu,"
             "\"failures\":%llu,\"retries\":%llu,\"dropped\":%llu,"
             "\"backpressure_events\":%llu,\"rotations\":%llu,"
             "\"packets_received\":%llu,\"packets_accepted\":%llu,\"packets_queued\":%llu,"
             "\"received\":%llu,\"parsed\":%llu,\"rejected\":%llu,\"queued\":%llu,"
             "\"failed\":%llu,"
             "\"packets_queue_overflow\":%llu,\"packets_parse_failed\":%llu,"
             "\"packets_db_attempted\":%llu,\"packets_db_success\":%llu,\"packets_db_failed\":%llu,"
             "\"packets_retry\":%llu,\"packets_spooled\":%llu,\"packets_replayed\":%llu,"
             "\"packets_dropped\":%llu,\"spool_capacity_drops\":%llu,"
             "\"sequence_gaps\":%llu,\"sequence_duplicates\":%llu,\"sequence_out_of_order\":%llu,"
             "\"ingest_worker_running\":%s,\"ingest_worker_heartbeat_age_ms\":%llu,"
             "\"transactions_committed\":%llu,\"maximum_queue_depth\":%llu,\"oldest_memory_queue_age_ms\":%llu,"
             "\"average_commit_latency_ms\":%.3f,\"maximum_commit_latency_ms\":%llu,"
             "\"spool_bytes\":%llu,\"spool_max_bytes\":%llu}",
             error[0] == '\0' ? "true" : "false", escaped, queue_len,
             (unsigned long long)queue_bytes, (unsigned long long)stored,
             (unsigned long long)pending, (unsigned long long)failures,
             (unsigned long long)retries, (unsigned long long)dropped,
             (unsigned long long)backpressure,
             (unsigned long long)g_daily_db_rotations,
             (unsigned long long)a.received,(unsigned long long)a.accepted,(unsigned long long)a.queued,
             (unsigned long long)a.received,(unsigned long long)a.parsed,
             (unsigned long long)a.parse_failed,(unsigned long long)a.queued,
             (unsigned long long)a.db_failed,
             (unsigned long long)a.queue_overflow,(unsigned long long)a.parse_failed,
             (unsigned long long)a.db_attempted,(unsigned long long)a.db_success,(unsigned long long)a.db_failed,
             (unsigned long long)a.retries,(unsigned long long)a.spooled,(unsigned long long)a.replayed,
             (unsigned long long)a.dropped,(unsigned long long)a.spool_capacity_drops,
             (unsigned long long)a.sequence_gaps,(unsigned long long)a.sequence_duplicates,(unsigned long long)a.sequence_out_of_order,
             worker_running?"true":"false",(unsigned long long)worker_age,
             (unsigned long long)a.transactions_committed,(unsigned long long)a.max_queue_depth,
             (unsigned long long)oldest_queue_age,
             a.db_success?((double)a.committed_latency_total_ms/(double)a.db_success):0.0,(unsigned long long)a.committed_latency_max_ms,
             (unsigned long long)g_spool_bytes,(unsigned long long)g_spool_max_bytes);
    reply_json(c, json);
}

static void http_handler(struct mg_connection *c, int ev, void *ev_data) {
    struct mg_http_message *hm;
    struct mg_http_serve_opts opts;

    if (ev == MG_EV_WS_OPEN) {
        printf("WebSocket client connected\n");
        return;
    }

    if (ev == MG_EV_CLOSE) {
        if (c->is_websocket) {
            printf("WebSocket client disconnected\n");
        }
        return;
    }

    if (ev == MG_EV_WS_MSG) {
        return;
    }

    if (ev != MG_EV_HTTP_MSG) {
        return;
    }

    hm = (struct mg_http_message *)ev_data;

    if (mg_match(hm->uri, mg_str("/ws"), NULL)) {
        mg_ws_upgrade(c, hm, NULL);
        return;
    }

    if (mg_match(hm->uri, mg_str("/api/db/list"), NULL)) {
        api_db_list(c);
        return;
    }

    if (mg_match(hm->uri, mg_str("/api/db/info"), NULL)) {
        api_db_info(c, hm);
        return;
    }

    if (mg_match(hm->uri, mg_str("/api/wallboard/snapshot"), NULL)) {
        api_wallboard_snapshot(c, hm);
        return;
    }

    if (mg_match(hm->uri, mg_str("/api/storage/status"), NULL)) {
        api_storage_status(c);
        return;
    }
    if(mg_match(hm->uri,mg_str("/api/test/shutdown"),NULL)){
        const char *allowed=getenv("TELEMETRY_TEST_ALLOW_SHUTDOWN");
        if(allowed!=NULL&&strcmp(allowed,"1")==0){g_shutdown_requested=true;reply_json(c,"{\"ok\":true}");}
        else mg_http_reply(c,404,"","not found");
        return;
    }

    if (mg_match(hm->uri, mg_str("/api/db/summary"), NULL)) {
        api_summary(c, hm);
        return;
    }

    if (mg_match(hm->uri, mg_str("/api/simulate"), NULL)) {
        api_simulate(c, hm);
        return;
    }

    if (mg_match(hm->uri, mg_str("/api/replay"), NULL)) {
        api_replay(c, hm);
        return;
    }

    if (mg_match(hm->uri, mg_str("/api/ai/health"), NULL)) {
        api_ai_health(c, hm);
        return;
    }

    if (mg_match(hm->uri, mg_str("/api/diagnostic"), NULL)) {
        api_diagnostic(c, hm);
        return;
    }

    if (mg_match(hm->uri, mg_str("/api/hmi/latest"), NULL)) {
        api_hmi_latest(c, hm);
        return;
    }

    if (mg_match(hm->uri, mg_str("/api/hmi/devices"), NULL)) {
        api_hmi_devices(c, hm);
        return;
    }

    if (mg_match(hm->uri, mg_str("/api/history/devices"), NULL)) {
        api_history_devices(c, hm);
        return;
    }

    if (mg_match(hm->uri, mg_str("/api/history/packets"), NULL)) {
        api_history_packets(c, hm);
        return;
    }

    if (mg_match(hm->uri, mg_str("/api/page/telemetry"), NULL)) {
        api_page_telemetry(c, hm);
        return;
    }

    if (mg_match(hm->uri, mg_str("/api/fields"), NULL)) {
        api_fields(c, hm);
        return;
    }

    if (mg_match(hm->uri, mg_str("/api/all"), NULL)) {
        api_all(c, hm);
        return;
    }

    if (mg_match(hm->uri, mg_str("/api/devices/status"), NULL) ||
        mg_match(hm->uri, mg_str("/api/devices"), NULL) ||
        mg_match(hm->uri, mg_str("/api/topology"), NULL)) {
        api_devices(c, hm);
        return;
    }

    if (mg_match(hm->uri, mg_str("/api/device/latest10"), NULL)) {
        api_latest(c, hm);
        return;
    }

    if (mg_match(hm->uri, mg_str("/api/device/count"), NULL)) {
        api_device_count(c, hm);
        return;
    }

    if (mg_match(hm->uri, mg_str("/api/device/metrics"), NULL) ||
        mg_match(hm->uri, mg_str("/api/db/metrics"), NULL)) {
        api_metrics(c, hm);
        return;
    }

    if (mg_match(hm->uri, mg_str("/api/device/state"), NULL)) {
        api_device_state(c, hm);
        return;
    }

    if (mg_match(hm->uri, mg_str("/api/history"), NULL)) {
        api_history(c, hm);
        return;
    }

    if (mg_match(hm->uri, mg_str("/api/hmi/logs"), NULL)) {
        api_hmi_logs(c, hm);
        return;
    }

    if (mg_match(hm->uri, mg_str("/api/search"), NULL)) {
        api_search(c, hm);
        return;
    }

    memset(&opts, 0, sizeof(opts));
    opts.root_dir = g_web_root;
    opts.extra_headers = "Cache-Control: no-store\r\n";

    if (mg_match(hm->uri, mg_str("/"), NULL)) {
        mg_http_reply(c, 302, "Location: /dashboard.html\r\n", "");
        return;
    }

    mg_http_serve_dir(c, hm, &opts);
}

/**
 * @brief Remove trailing whitespace from a mutable configuration string.
 * @param s Input string to process.
 */
static void trim_right(char *s) {
    size_t n;

    if (s == NULL) return;

    n = strlen(s);

    while ((n > 0) && isspace((unsigned char)s[n - 1])) {
        s[n - 1] = '\0';
        n--;
    }
}

/**
 * @brief Parse and range-check an integer configuration value.
 * @param text Text representation to parse.
 * @param minimum Minimum accepted numeric value.
 * @param maximum Maximum accepted numeric value.
 * @param value Input value to parse or normalize.
 */
static bool parse_int_value(const char *text,
                            int minimum,
                            int maximum,
                            int *value) {
    char *end = NULL;
    long parsed;

    if ((text == NULL) || (value == NULL) || (minimum > maximum)) {
        return false;
    }

    errno = 0;
    parsed = strtol(text, &end, 10);
    if ((errno == ERANGE) || (end == text) || (end == NULL) ||
        (*end != '\0') || (parsed < (long)minimum) ||
        (parsed > (long)maximum)) {
        return false;
    }

    *value = (int)parsed;
    return true;
}

/**
 * @brief Convert a configuration section name to its zero-based channel index.
 * @param sec Requested history range in seconds.
 * @return Zero-based channel index, or `-1` when the section name is invalid.
 */
static int parse_channel_section(const char *sec) {
    if (strncmp(sec, "udp_channel_", 12) == 0) {
        int n;

        if (parse_int_value(sec + 12, 1, MAX_CHANNELS, &n)) {
            return n - 1;
        }
    }

    return -1;
}

/**
 * @brief Install a safe fallback channel when configuration defines none.
 */
static void add_default_channels_if_empty(void) {
    if (g_channel_count > 0) return;

    g_channel_count = 1;

    g_channels[0].enabled = 1;
    snprintf(g_channels[0].name, sizeof(g_channels[0].name), "camera");
    snprintf(g_channels[0].group_ip, sizeof(g_channels[0].group_ip), "239.255.2.4");
    snprintf(g_channels[0].iface_ip, sizeof(g_channels[0].iface_ip), "0.0.0.0");
    g_channels[0].port = 50104;
}

/* ======================= Configuration loading ========================= */

/** Resolve the executable directory so configured relative paths do not depend on CWD. */
static void resolve_application_directory(void) {
    char executable[1024] = "";
    char *separator = NULL;
#ifdef _WIN32
    DWORD length = GetModuleFileNameA(NULL, executable, (DWORD)sizeof(executable));
    if (length == 0U || length >= sizeof(executable)) executable[0] = '\0';
    separator = strrchr(executable, '\\');
    if (separator == NULL) separator = strrchr(executable, '/');
#else
    ssize_t length = readlink("/proc/self/exe", executable, sizeof(executable) - 1U);
    if (length < 0 || (size_t)length >= sizeof(executable)) executable[0] = '\0';
    else executable[length] = '\0';
    separator = strrchr(executable, '/');
#endif
    if (separator != NULL) {
        *separator = '\0';
        snprintf(g_app_dir, sizeof(g_app_dir), "%s", executable);
    }
    if (g_app_dir[0] == '\0') {
#ifdef _WIN32
        if (_getcwd(g_app_dir, sizeof(g_app_dir)) == NULL) snprintf(g_app_dir, sizeof(g_app_dir), ".");
#else
        if (getcwd(g_app_dir, sizeof(g_app_dir)) == NULL) snprintf(g_app_dir, sizeof(g_app_dir), ".");
#endif
    }
}

static bool path_is_absolute(const char *path) {
    if (path == NULL || path[0] == '\0') return false;
#ifdef _WIN32
    return path[0] == '/' || path[0] == '\\' ||
           (isalpha((unsigned char)path[0]) && path[1] == ':');
#else
    return path[0] == '/';
#endif
}

static void resolve_relative_path(char *path, size_t capacity) {
    char resolved[1024];
    size_t app_len, path_len, resolved_len, copy_len;
    if (path == NULL || capacity == 0U || path[0] == '\0' || path_is_absolute(path)) return;
    app_len = strlen(g_app_dir);
    path_len = strlen(path);
    if (app_len + 1U >= sizeof(resolved)) {
        path[0] = '\0';
        return;
    }
    memcpy(resolved, g_app_dir, app_len);
    resolved[app_len] = '/';
    copy_len = sizeof(resolved) - app_len - 2U;
    if (path_len > copy_len) path_len = copy_len;
    memcpy(resolved + app_len + 1U, path, path_len);
    resolved_len = app_len + 1U + path_len;
    resolved[resolved_len] = '\0';
    copy_len = resolved_len < capacity - 1U ? resolved_len : capacity - 1U;
    memcpy(path, resolved, copy_len);
    path[copy_len] = '\0';
}

/**
 * @brief Load server, database, simulator, indexing, and UDP channel settings from config.ini.
 */
static void load_config(void) {
    FILE *f;
    char line[512];
    char config_candidate[1024];
    char sec[64] = "";
    int active_channel = -1;

    snprintf(config_candidate, sizeof(config_candidate), "config.ini");
    resolve_relative_path(config_candidate, sizeof(config_candidate));
    f = fopen(config_candidate, "r");
    if (f != NULL) snprintf(g_config_path, sizeof(g_config_path), "%s", config_candidate);
    else {
        f = fopen("config.ini", "r");
        if (f != NULL) {
            snprintf(g_config_path, sizeof(g_config_path), "config.ini (working directory fallback)");
#ifdef _WIN32
            if (_getcwd(g_app_dir, sizeof(g_app_dir)) == NULL) { /* Retain executable directory fallback. */ }
#else
            if (getcwd(g_app_dir, sizeof(g_app_dir)) == NULL) { /* Retain executable directory fallback. */ }
#endif
        }
    }

    if (f == NULL) {
        printf("config.ini not found. Using default channel.\n");
        add_default_channels_if_empty();
        return;
    }

    while (fgets(line, sizeof(line), f) != NULL) {
        char *p = line;
        char *eq;
        char key[128];
        char val[256];
        size_t key_len;
        size_t val_len;

        while (isspace((unsigned char)*p)) p++;

        if ((*p == '\0') || (*p == '#') || (*p == ';')) continue;

        if (*p == '[') {
            if (sscanf(p, "[%63[^]]]", sec) == 1) {
                active_channel = parse_channel_section(sec);

                if (active_channel >= 0) {
                    if (active_channel >= g_channel_count) {
                        g_channel_count = active_channel + 1;
                    }

                    memset(&g_channels[active_channel], 0, sizeof(g_channels[active_channel]));
                    g_channels[active_channel].enabled = 1;
                    snprintf(g_channels[active_channel].name,
                             sizeof(g_channels[active_channel].name),
                             "channel_%d",
                             active_channel + 1);
                    snprintf(g_channels[active_channel].iface_ip,
                             sizeof(g_channels[active_channel].iface_ip),
                             "0.0.0.0");
                }
            }

            continue;
        }

        eq = strchr(p, '=');

        if (eq == NULL) continue;

        *eq = '\0';

        key_len = strlen(p);
        val_len = strlen(eq + 1);

        if ((key_len >= sizeof(key)) || (val_len >= sizeof(val))) {
            printf("Ignoring overlong config entry\n");
            continue;
        }

        memcpy(key, p, key_len + 1U);
        memcpy(val, eq + 1, val_len + 1U);

        trim_right(key);
        trim_right(val);

        while (isspace((unsigned char)val[0])) {
            memmove(val, val + 1, strlen(val));
        }

        if (strcmp(sec, "server") == 0) {
            if (strcmp(key, "http_port") == 0) {
                snprintf(g_http_port, sizeof(g_http_port), "%s", val);
            } else if (strcmp(key, "web_root") == 0) {
                snprintf(g_web_root, sizeof(g_web_root), "%s", val);
            }
        } else if (strcmp(sec, "database") == 0) {
            if (strcmp(key, "dir") == 0) {
                snprintf(g_db_dir, sizeof(g_db_dir), "%s", val);
            } else if (strcmp(key, "rotate_mb") == 0) {
                char *end = NULL;
                unsigned long long mb = strtoull(val, &end, 10);
                if ((end != val) && (*end == '\0')) {
                    g_db_rotate_bytes = (uint64_t)mb * 1024ULL * 1024ULL;
                }
            } else if (strcmp(key, "expand_all_fields") == 0) {
                if (!parse_int_value(val, 0, 1, &g_expand_all_fields)) {
                    g_expand_all_fields = 0;
                }
            } else if (strcmp(key, "indexed_fields") == 0) {
                snprintf(g_indexed_fields,
                         sizeof(g_indexed_fields),
                         "%s",
                         val);
            } else if (strcmp(key, "writer_batch_packets") == 0) {
                char *end = NULL;
                unsigned long long packets = strtoull(val, &end, 10);
                if ((end != val) && (*end == '\0') &&
                    (packets >= 1U) && (packets <= 1000000U)) {
                    g_writer_batch_max_packets = (uint64_t)packets;
                }
            } else if (strcmp(key, "writer_batch_ms") == 0) {
                char *end = NULL;
                unsigned long long milliseconds = strtoull(val, &end, 10);
                if ((end != val) && (*end == '\0') &&
                    (milliseconds >= 1U) && (milliseconds <= 60000U)) {
                    g_writer_batch_max_ms = (uint64_t)milliseconds;
                }
            } else if (strcmp(key, "udp_receive_buffer_mb") == 0) {
                char *end = NULL;
                unsigned long long megabytes = strtoull(val, &end, 10);
                if ((end != val) && (*end == '\0') &&
                    (megabytes >= 1U) && (megabytes <= 1024U)) {
                    g_udp_receive_buffer_bytes = (int)(megabytes * 1024ULL * 1024ULL);
                }
            }
        } else if (strcmp(sec, "logging") == 0) {
            if (strcmp(key, "udp_packet_log") == 0) {
                if (!parse_int_value(val, 0, 1, &g_udp_packet_log_enabled)) {
                    g_udp_packet_log_enabled = 0;
                }
            }
        } else if (strcmp(sec, "spool") == 0) {
            if (strcmp(key, "dir") == 0) {
                snprintf(g_spool_dir,sizeof(g_spool_dir),"%s",val);
            } else if (strcmp(key,"max_gb") == 0) {
                char *end=NULL;unsigned long long gb=strtoull(val,&end,10);
                if(end!=val&&*end=='\0'&&gb>0U&&gb<=1024U)g_spool_max_bytes=(uint64_t)gb*1024ULL*1024ULL*1024ULL;
            }
        } else if (strcmp(sec, "simulator") == 0) {
            if (strcmp(key, "enabled") == 0) {
                if (!parse_int_value(val, 0, 1, &g_simulator_enabled)) {
                    g_simulator_enabled = 0;
                }
            }
        } else if (active_channel >= 0) {
            udp_channel_t *ch = &g_channels[active_channel];

            if (strcmp(key, "enabled") == 0) {
                if (!parse_int_value(val, 0, 1, &ch->enabled)) {
                    ch->enabled = 0;
                }
            } else if (strcmp(key, "name") == 0) {
                snprintf(ch->name, sizeof(ch->name), "%s", val);
            } else if (strcmp(key, "group_ip") == 0) {
                snprintf(ch->group_ip, sizeof(ch->group_ip), "%s", val);
            } else if (strcmp(key, "iface_ip") == 0) {
                snprintf(ch->iface_ip, sizeof(ch->iface_ip), "%s", val);
            } else if (strcmp(key, "port") == 0) {
                if (!parse_int_value(val, 0, 65535, &ch->port)) {
                    ch->port = 0;
                }
            }
        }
    }

    fclose(f);
    resolve_relative_path(g_web_root, sizeof(g_web_root));
    resolve_relative_path(g_db_dir, sizeof(g_db_dir));
    resolve_relative_path(g_spool_dir, sizeof(g_spool_dir));
    {
        static const char archive_suffix[] = "/Archive Data";
        size_t dir_len = strlen(g_db_dir);
        size_t suffix_len = sizeof(archive_suffix) - 1U;

        if (dir_len > (sizeof(g_archive_dir) - 1U)) {
            dir_len = sizeof(g_archive_dir) - 1U;
        }
        memcpy(g_archive_dir, g_db_dir, dir_len);
        if (suffix_len > ((sizeof(g_archive_dir) - 1U) - dir_len)) {
            suffix_len = (sizeof(g_archive_dir) - 1U) - dir_len;
        }
        memcpy(g_archive_dir + dir_len, archive_suffix, suffix_len);
        g_archive_dir[dir_len + suffix_len] = '\0';
    }
    add_default_channels_if_empty();
}

/**
 * @brief Determine whether an IPv4 address belongs to the multicast range.
 * @param ip Textual IPv4 address.
 */
static bool is_multicast_ip(const char *ip) {
    unsigned int a, b, c, d;

    if (sscanf(ip, "%u.%u.%u.%u", &a, &b, &c, &d) != 4) {
        return false;
    }

    return ((a >= 224U) && (a <= 239U));
}

/**
 * @brief Decode an unsigned 32-bit integer from network byte order.
 * @param p Pointer to network-order packet bytes.
 * @return Decoded unsigned 32-bit value in host byte order.
 */
static uint32_t read_be32(const unsigned char *p) {
    return ((uint32_t)p[0] << 24) |
           ((uint32_t)p[1] << 16) |
           ((uint32_t)p[2] << 8) |
           (uint32_t)p[3];
}

/**
 * @brief Decode an unsigned 16-bit integer from network byte order.
 * @param p Pointer to network-order packet bytes.
 * @return Decoded unsigned 16-bit value in host byte order.
 */
static uint16_t read_be16(const unsigned char *p) {
    return (uint16_t)(((uint16_t)p[0] << 8) | (uint16_t)p[1]);
}

/* ======================== UDP receive pipeline ========================= */

/**
 * @brief Locate and validate a JSON object in raw or header-prefixed UDP data.
 * @param buf Mutable UDP receive buffer.
 * @param json_out Output pointer set to the JSON object inside the receive buffer.
 */
static bool decode_udp_payload(char *buf, int n, char **json_out) {
    unsigned char *u = (unsigned char *)buf;
    uint32_t payload_len;

    if ((buf == NULL) || (json_out == NULL) || (n <= 0)) {
        return false;
    }

    if ((n >= LCU_HEADER_LEN) && (memcmp(buf, "LCU1", 4) == 0)) {

        payload_len = read_be32(u + 20);

        if ((payload_len == 0) ||
            (payload_len > (uint32_t)(n - LCU_HEADER_LEN)) ||
            (payload_len >= (uint32_t)(MAX_JSON - LCU_HEADER_LEN))) {
            return false;
        }

        buf[(size_t)LCU_HEADER_LEN + (size_t)payload_len] = '\0';

        *json_out = buf + LCU_HEADER_LEN;
        goto validate_json;
    }

    /* IMU multicast transport (UMC1):
     * magic[4], version[1], flags[1], header_len[2], topic_len[2],
     * payload_len[4], unix_ms[8], seq[4], topic bytes, JSON payload. */
    if ((n >= 26) && (memcmp(buf, "UMC1", 4) == 0)) {
        uint16_t header_len = read_be16(u + 6);
        uint16_t topic_len = read_be16(u + 8);

        payload_len = read_be32(u + 10);

        if ((u[4] != 1U) ||
            (topic_len == 0U) ||
            (header_len != (uint16_t)(26U + topic_len)) ||
            (header_len > (uint16_t)n) ||
            (payload_len == 0U) ||
            (payload_len > (uint32_t)n - (uint32_t)header_len) ||
            ((uint32_t)header_len + payload_len >= (uint32_t)MAX_JSON)) {
            return false;
        }

        buf[(size_t)header_len + (size_t)payload_len] = '\0';
        *json_out = buf + header_len;
        goto validate_json;
    }

    if (n >= MAX_JSON) {
        return false;
    }

    buf[n] = '\0';

    {
        char *candidate = buf;

        while ((*candidate != '\0') &&
               isspace((unsigned char)*candidate)) {
            candidate++;
        }

        if (*candidate != '{') {
            candidate = strchr(candidate, '{');
        }

        if (candidate == NULL) return false;

        /* Accept raw JSON and unknown header+JSON transports.  This allows
         * additional device publishers to prepend their own binary header
         * without silently losing an otherwise valid JSON payload. */
        *json_out = candidate;
    }

    return true;

validate_json:
    /* Full JSON parsing is deliberately deferred to the database worker so
     * receiver threads return to recvfrom() as quickly as possible. */
    return true;
}

static void log_malformed_udp_packet(const udp_channel_t *ch, const char *src_ip,
                                     int src_port, const char *buf, int bytes) {
    int shown = bytes;
    if (shown > 512) shown = 512;
    fprintf(stderr,
            "Malformed JSON packet channel=%s source=%s:%d bytes=%d context=%.*s%s\n",
            ch != NULL ? ch->name : "", src_ip != NULL ? src_ip : "", src_port,
            bytes, shown, buf != NULL ? buf : "", bytes > shown ? "...[truncated]" : "");
}

/**
 * @brief Receive, validate, count, and enqueue packets for one configured UDP channel.
 * @param arg Opaque argument passed to the worker.
 * @return Platform-specific successful thread return value when the worker exits.
 * @note Long-running worker entry point; ownership of its argument and queue data is documented in the implementation.
 */
static THREAD_RET udp_thread(void *arg) {
    udp_channel_t *ch = (udp_channel_t *)arg;
    char buf[MAX_JSON];
    sock_t s;
    int yes = 1;
    int receive_buffer_bytes = g_udp_receive_buffer_bytes;
    uint64_t received_packets = 0U;
    uint64_t accepted_packets = 0U;
    uint64_t rejected_packets = 0U;
    uint64_t last_report_ms = platform_monotonic_ms();
    struct sockaddr_in addr;

    if (ch == NULL) return THREAD_RETURN;

    s = socket(AF_INET, SOCK_DGRAM, 0);

    if (s == INVALID_SOCKET) {
        printf("socket failed: %d\n", GET_SOCKET_ERROR());
        return THREAD_RETURN;
    }

    if(setsockopt(s,SOL_SOCKET,SO_REUSEADDR,(char*)&yes,sizeof(yes))==SOCKET_ERROR)
        fprintf(stderr,"SO_REUSEADDR failed channel=%s err=%d\n",ch->name,GET_SOCKET_ERROR());
    if(setsockopt(s,
                     SOL_SOCKET,
                     SO_RCVBUF,
                     (char *)&receive_buffer_bytes,
                     sizeof(receive_buffer_bytes))==SOCKET_ERROR)
        fprintf(stderr,"SO_RCVBUF request failed channel=%s requested=%d err=%d\n",ch->name,receive_buffer_bytes,GET_SOCKET_ERROR());
    { int actual=0;platform_socklen_t option_len=(platform_socklen_t)sizeof(actual);
      if(getsockopt(s,SOL_SOCKET,SO_RCVBUF,(char*)&actual,&option_len)==0)
        printf("UDP channel=%s receive_buffer_requested=%d actual=%d\n",ch->name,receive_buffer_bytes,actual); }

#ifdef IP_MULTICAST_ALL
    {
        int multicast_all = 0;
        (void)setsockopt(s,
                         IPPROTO_IP,
                         IP_MULTICAST_ALL,
                         (char *)&multicast_all,
                         sizeof(multicast_all));
    }
#endif

    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_ANY);
    addr.sin_port = htons((uint16_t)ch->port);

    if (bind(s, (struct sockaddr *)&addr, sizeof(addr)) == SOCKET_ERROR) {
        printf("bind failed port=%d err=%d\n", ch->port, GET_SOCKET_ERROR());
        CLOSESOCKET(s);
        return THREAD_RETURN;
    }

    if (is_multicast_ip(ch->group_ip)) {
        struct ip_mreq mreq;

        memset(&mreq, 0, sizeof(mreq));

        mreq.imr_multiaddr.s_addr = inet_addr(ch->group_ip);

        if (strcmp(ch->iface_ip, "0.0.0.0") == 0) {
            mreq.imr_interface.s_addr = htonl(INADDR_ANY);
        } else {
            mreq.imr_interface.s_addr = inet_addr(ch->iface_ip);
        }

        if (setsockopt(s,
                       IPPROTO_IP,
                       IP_ADD_MEMBERSHIP,
                       (char *)&mreq,
                       sizeof(mreq)) == SOCKET_ERROR) {
            printf("IP_ADD_MEMBERSHIP failed group=%s iface=%s err=%d\n",
                   ch->group_ip, ch->iface_ip, GET_SOCKET_ERROR());
            CLOSESOCKET(s); return THREAD_RETURN;
        } else {
            printf("Joined multicast group=%s iface=%s\n",
                   ch->group_ip, ch->iface_ip);
        }
    } else {
        printf("Unicast UDP mode on port=%d\n", ch->port);
    }

    printf("UDP channel '%s' listening group=%s port=%d iface=%s\n",
           ch->name, ch->group_ip, ch->port, ch->iface_ip);

    for (;;) {
        struct sockaddr_in src;
        platform_socklen_t slen = (platform_socklen_t)sizeof(src);
        int n;

        n = (int)recvfrom(s,
                          buf,
                          sizeof(buf) - 1,
                          0,
                          (struct sockaddr *)&src,
                          &slen);

        if (n > 0) {
            char src_ip[64];
            char *json_payload = NULL;
            uint64_t now_ms;
            uint64_t wall_ms;

            received_packets++;
            lock_ingest_queue(); g_packet_accounting.received++; unlock_ingest_queue();
            update_pipeline_stats(1U, 0U, 0U, 0U, 0U, 0U, 0U);
            snprintf(src_ip, sizeof(src_ip), "%s", inet_ntoa(src.sin_addr));
            now_ms = platform_monotonic_ms();
            wall_ms = (uint64_t)time(NULL) * 1000U;

            if (!decode_udp_payload(buf, n, &json_payload)) {
                rejected_packets++;
                lock_ingest_queue(); g_packet_accounting.parse_failed++; unlock_ingest_queue();
                log_malformed_udp_packet(ch, src_ip, ntohs(src.sin_port), buf, n);
                update_pipeline_stats(0U, 0U, 1U, 0U, 0U, 1U, 0U);
                update_udp_stats(ch, 1U, 0U, 1U, src_ip, ntohs(src.sin_port), wall_ms);
                continue;
            }

            update_pipeline_stats(0U, 1U, 0U, 0U, 0U, 0U, 0U);
            lock_ingest_queue(); g_packet_accounting.accepted++; unlock_ingest_queue();

            enqueue_raw_live_packet(json_payload,
                                    ch->name,
                                    src_ip,
                                    ntohs(src.sin_port));

            /* Storage remains asynchronous and independent of live delivery. */
            if (!enqueue_ingest_record(json_payload,
                                  ch->name,
                                  src_ip,
                                  ntohs(src.sin_port))) {
                /* Explicitly accounted by enqueue_ingest_record(). */
            }
            accepted_packets++;
            update_udp_stats(ch, 1U, 1U, 0U, src_ip, ntohs(src.sin_port), wall_ms);

            if ((now_ms < last_report_ms) ||
                ((now_ms - last_report_ms) >= 5000U)) {
                int queue_len = 0;
                uint64_t dropped = 0U;
                uint64_t stored = 0U;
                uint64_t pending = 0U;
                uint64_t db_failures = 0U;
                uint64_t db_retries = 0U;

                ingest_queue_snapshot(&queue_len,
                                      NULL,
                                      NULL,
                                      &dropped,
                                      &stored,
                                      &pending,
                                      &db_failures,
                                      &db_retries,
                                      NULL,
                                      0U);
                printf("UDP stats channel=%s received=%llu accepted=%llu rejected=%llu ingest_queue=%d dropped=%llu db_writer_committed=%llu db_pending=%llu db_failures=%llu db_retries=%llu\n",
                       ch->name,
                       (unsigned long long)received_packets,
                       (unsigned long long)accepted_packets,
                       (unsigned long long)rejected_packets,
                       queue_len,
                       (unsigned long long)dropped,
                       (unsigned long long)stored,
                       (unsigned long long)pending,
                       (unsigned long long)db_failures,
                       (unsigned long long)db_retries);
                last_report_ms = now_ms;
            }
        } else if(n==SOCKET_ERROR) {
            int err=GET_SOCKET_ERROR();
#ifdef _WIN32
            if(err==WSAEINTR)continue;
#else
            if(err==EINTR)continue;
#endif
            fprintf(stderr,"recvfrom failed channel=%s err=%d; receiver stopped\n",ch->name,err);
            CLOSESOCKET(s);return THREAD_RETURN;
        }
    }

    return THREAD_RETURN;

}

/* ======================= Application entry point ======================= */

/**
 * @brief Initialize platform services, workers, UDP channels, persistence, and the web event loop.
 * @return Process exit status: zero on normal startup/shutdown; nonzero on initialization failure.
 */
int main(void) {
#ifdef _WIN32
    WSADATA w;
#endif
    char url[128];
    sqlite3 *db = NULL;
    int i;

    /* Preserve the last useful diagnostic line even when output is redirected
     * to a launcher log and the process is terminated unexpectedly. */
    (void)setvbuf(stdout, NULL, _IOLBF, 0U);
    (void)setvbuf(stderr, NULL, _IOLBF, 0U);

#ifdef _WIN32
    if (WSAStartup(MAKEWORD(2, 2), &w) != 0) {
        printf("WSAStartup failed\n");
        return 1;
    }
#endif

    if (platform_mutex_init(&g_db_mutex) != 0) {
        printf("DB mutex initialization failed\n");
#ifdef _WIN32
        WSACleanup();
#endif
        return 1;
    }

    if (platform_mutex_init(&g_ws_mutex) != 0) {
        printf("WebSocket queue mutex initialization failed\n");
        platform_mutex_destroy(&g_db_mutex);
#ifdef _WIN32
        WSACleanup();
#endif
        return 1;
    }

    if (platform_mutex_init(&g_udp_mutex) != 0) {
        printf("UDP stats mutex initialization failed\n");
        platform_mutex_destroy(&g_ws_mutex);
        platform_mutex_destroy(&g_db_mutex);
#ifdef _WIN32
        WSACleanup();
#endif
        return 1;
    }

    if (platform_mutex_init(&g_ingest_mutex) != 0) {
        printf("Ingest queue mutex initialization failed\n");
        platform_mutex_destroy(&g_udp_mutex);
        platform_mutex_destroy(&g_ws_mutex);
        platform_mutex_destroy(&g_db_mutex);
#ifdef _WIN32
        WSACleanup();
#endif
        return 1;
    }
    if (platform_mutex_init(&g_spool_mutex) != 0) {
        printf("Failed to initialize telemetry spool mutex\n");
        platform_mutex_destroy(&g_ingest_mutex);
        platform_mutex_destroy(&g_ws_mutex);
        platform_mutex_destroy(&g_db_mutex);
#ifdef _WIN32
        WSACleanup();
#endif
        return 1;
    }

    snprintf(g_session_id, sizeof(g_session_id), "S%lld", (long long)time(NULL));

    resolve_application_directory();
    printf("Application directory: %s\n", g_app_dir);
    load_config();
    configure_safe_wsl_database_directory();
    recover_spool_tmp_files();

    printf("Loaded channels: %d\n", g_channel_count);
    for (i = 0; i < g_channel_count; ++i) {
        printf("CH%d enabled=%d name=%s group=%s port=%d iface=%s\n",
               i + 1,
               g_channels[i].enabled,
               g_channels[i].name,
               g_channels[i].group_ip,
               g_channels[i].port,
               g_channels[i].iface_ip);
    }

    MKDIR(g_db_dir);
    MKDIR(g_archive_dir);

    if (open_db(NULL, &db) == 0) {
        sqlite3_close(db);
    }

    mg_log_set(MG_LL_ERROR);

    if (platform_thread_start(ingest_thread, NULL) != 0) {
        printf("Failed to start database ingest thread\n");
        platform_mutex_destroy(&g_spool_mutex);
        platform_mutex_destroy(&g_ingest_mutex);
        platform_mutex_destroy(&g_ws_mutex);
        platform_mutex_destroy(&g_db_mutex);
#ifdef _WIN32
        WSACleanup();
#endif
        return 1;
    }

    for (i = 0; i < g_channel_count; ++i) {
        if ((g_channels[i].enabled != 0) &&
            (g_channels[i].group_ip[0] != '\0') &&
            (g_channels[i].port > 0)) {
            if (platform_thread_start(udp_thread, &g_channels[i]) != 0) {
                printf("Failed to start UDP thread for channel %s\n",
                       g_channels[i].name);
            }
        }
    }

    mg_mgr_init(&mgr);

    snprintf(url, sizeof(url), "http://0.0.0.0:%s", g_http_port);

    if (mg_http_listen(&mgr, url, http_handler, NULL) == NULL) {
        printf("HTTP listen failed on %s\n", url);
        mg_mgr_free(&mgr);
        platform_mutex_destroy(&g_ingest_mutex);
        platform_mutex_destroy(&g_ws_mutex);
        platform_mutex_destroy(&g_db_mutex);
#ifdef _WIN32
        WSACleanup();
#endif
        return 1;
    }

    printf("Server started\n");
    printf("Open: http://127.0.0.1:%s/dashboard.html\n", g_http_port);
    printf("Web root: %s\n", g_web_root);
    printf("DB dir: %s\n", g_db_dir);

while (!g_shutdown_requested) {
    mg_mgr_poll(&mgr, 10);
    drain_live_updates(&mgr);
}

mg_mgr_free(&mgr);

    lock_db();close_writer_db_locked(false);unlock_db();

    platform_mutex_destroy(&g_udp_mutex);

platform_mutex_destroy(&g_ingest_mutex);

platform_mutex_destroy(&g_db_mutex);

#ifdef _WIN32
WSACleanup();
#endif        
return 0;
}
