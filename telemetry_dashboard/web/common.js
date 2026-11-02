/*
 * Shared browser runtime.
 *
 * Provides API access, database/range selection, telemetry normalization,
 * device-name canonicalization, chart helpers, and the reconnecting WebSocket
 * client used by every page. Page modules register listeners rather than
 * creating competing sockets.
 */

// Create the shared mutable state used by every dashboard page.
const App = {
  db: "",
  range: "5m"
};

// Track the single shared WebSocket connection, its health, reconnect delay,
// and page callbacks so dashboard views do not open competing live streams.
App.ws = null;
App.wsConnected = false;
App.wsLastMessageAt = 0;
App.wsListeners = [];
App.wsConnectionGeneration = 0;
App.wsBackoffMs = 1000;

// Define a concise helper for retrieving an element by its DOM id.
const $ = id => document.getElementById(id);

/**
 * Escapes untrusted values before inserting them into generated HTML.
 */
function esc(x) {
  return String(x ?? "").replace(/[&<>"']/g, m => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[m]));
}

/**
 * Requests a JSON API endpoint with timeout and response validation.
 */
async function api(url, timeoutMs = 8000) {
  // Give this request its own cancellation signal and abort it at the caller's
  // deadline so a stalled backend cannot leave the page waiting indefinitely.
  const controller =
    new AbortController();
  const timer =
    setTimeout(() => controller.abort(), timeoutMs);

  let r;
  let text;

  try {
    // Bypass the browser cache because telemetry API responses must represent
    // the backend's current database and device state.
    r = await fetch(url, {
      cache: "no-store",
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }

  if (!r.ok) {
    // Preserve the backend's response text in the error so the page can show
    // the real API failure instead of treating an HTTP error as valid data.
    throw new Error(await r.text());
  }

  text = await r.text();

  try {
    return JSON.parse(text);
  } catch (err) {
    // Identify malformed backend output while limiting the included response
    // preview so an unexpectedly large body does not flood the error message.
    throw new Error(
      "Invalid JSON from " +
      url +
      ": " +
      text.slice(0, 220)
    );
  }
}

/**
 * Converts a date-based database filename into a sortable timestamp.
 */
function dbNameTime(name) {
  // Accept the daily DD.MM.YYYY.db and DD-MM-YYYY.db naming forms; filenames
  // outside that convention receive timestamp zero and sort behind dated DBs.
  const m = String(name || "").match(/^(\d{2})[.-](\d{2})[.-](\d{4})(?:\.part\d+)?\.db$/);

  if (!m) {
    return 0;
  }

  return new Date(
    Number(m[3]),
    Number(m[2]) - 1,
    Number(m[1])
  ).getTime();
}

/**
 * Loads, sorts, and applies the available database selections.
 */
async function loadDbSelect(sel) {
  if (!sel) {
    App.db = "";
    return;
  }

  const response = await api("/api/db/list");
  const list = (Array.isArray(response) ? response : []).filter(name =>
    typeof name === "string" && /\.(?:db|sqlite|sqlite3)$/i.test(name)
  ).sort((a, b) => {
    const byDate = dbNameTime(b) - dbNameTime(a);

    if (byDate !== 0) {
      return byDate;
    }

    return String(b).localeCompare(String(a));
  });

  sel.innerHTML = list.length ? list.map(x => `
    <option value="${esc(x)}">
      ${esc(x)}
    </option>
  `).join("") : `<option value="" selected>No database files available</option>`;
  sel.disabled = list.length === 0;

  sel.value = list[0] || "";
  App.db = sel.value;
}

/**
 * Normalizes supported telemetry timestamp formats to epoch milliseconds.
 */
function parseTs(ts) {
  if (!ts) {
    return Date.now();
  }

  if (typeof ts === "number") {
    return ts > 1000000000000 ? ts : ts * 1000;
  }

  // Standardize whitespace between the date and time before testing whether
  // the backend supplied an explicit UTC or numeric timezone offset.
  const raw = String(ts).trim();
  const normalized = raw.replace(" ", "T");

  /* Explicit offsets are authoritative.  Older Linux/WSL databases contain
     timezone-less UTC timestamps, while native Windows databases contain
     timezone-less local timestamps.  Choose the interpretation nearest to
     the browser clock so both existing database formats remain readable. */
  if (/[zZ]$|[+-]\d\d:\d\d$/.test(normalized)) {
    return Date.parse(normalized);
  }

  const localTime = Date.parse(normalized);
  const utcTime = Date.parse(normalized + "Z");

  if (!Number.isFinite(localTime)) return utcTime;
  if (!Number.isFinite(utcTime)) return localTime;

  return Math.abs(Date.now() - utcTime) < Math.abs(Date.now() - localTime)
    ? utcTime
    : localTime;
}

/**
 * Converts a user-facing range token into milliseconds.
 */
function rangeToMs(range) {
  const value = String(range || "").trim().toLowerCase();

  if (value === "all") {
    return 0;
  }

  const match = value.match(/^(\d+)(s|m|h)$/);

  if (!match) {
    return 5 * 60 * 1000;
  }

  const amount = Number(match[1]);
  const unit = match[2];

  if (!Number.isFinite(amount) || amount <= 0) {
    return 5 * 60 * 1000;
  }

  if (unit === "s") {
    return amount * 1000;
  }

  if (unit === "m") {
    return amount * 60 * 1000;
  }

  return amount * 60 * 60 * 1000;
}

/**
 * Formats an axis tick with calendar context when a chart spans a day or more.
 */
function chartTimeLabel(timestamp, spanMs) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "";
  if (spanMs >= 24 * 60 * 60 * 1000) {
    return date.toLocaleString([], {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    });
  }
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

/**
 * Scores operator-relevant telemetry above protocol timing internals.
 */
function deviceMetricPriority(key) {
  const normalized = String(key || "").toLowerCase();
  const preferred = [
    "latitude", "longitude", "altitude", "heading",
    "roll", "pitch", "yaw", "speed", "rpm",
    "temperature", "pressure", "voltage", "current"
  ];
  const preferredIndex = preferred.findIndex(name =>
    normalized === name || normalized.endsWith("_" + name)
  );
  if (preferredIndex >= 0) return preferredIndex;
  if (
    /(^|_)(t_epoch|t_usec|epoch|usec|timestamp|packet_ts|device_ts)$/.test(
      normalized
    )
  ) return 1000;
  return 100;
}

/**
 * Maps alternate device identifiers to one canonical dashboard name.
 */
function canonicalDeviceName(device) {
  const d = String(device || "").trim().toUpperCase();

  const aliases = {
    BUTTON: "BUTTON_LED_UNIT",
    BUTTON_LED: "BUTTON_LED_UNIT",
    BUTTON_LED_UNIT: "BUTTON_LED_UNIT",
    JOYSTICK: "JOYSTICK_UNIT",
    JOYSTICK_UNIT: "JOYSTICK_UNIT",
    IMU: "IMU_UNIT",
    IMU_UNIT: "IMU_UNIT",
    CAMERA: "CAMERA_UNIT",
    CAMERA_UNIT: "CAMERA_UNIT",
    TRACKER_TELEMETRY: "CAMERA_UNIT",
    TRACKER_TELEM: "CAMERA_UNIT",
    DRIVE: "DRIVE_UNIT",
    DRIVE_UNIT: "DRIVE_UNIT",
    DRIVE_WCS: "DRIVE_UNIT",
    TRACKER_PUBLISH: "DRIVE_UNIT",
    TRACKER_PUBLISH_UNIT: "DRIVE_UNIT",
    LCU: "LCU_UNIT",
    LCU_UNIT: "LCU_UNIT",
    CCE: "CCE_GATEWAY",
    CCE_GATEWAY: "CCE_GATEWAY",
    WCS: "WCS_CONSOLE",
    WCS_CONSOLE: "WCS_CONSOLE",
    WCS_CONTROL_CONSOLE: "WCS_CONSOLE",
    MAIN_DISPLAY: "MAIN_DISPLAY",
    MAINDISPLAY: "MAIN_DISPLAY",
    MAIN: "MAIN_DISPLAY",
    ADVANTECH: "ADVANTECH_IO",
    ADVANTECH_IO: "ADVANTECH_IO",
    ADVANTEC_DRIVER: "ADVANTECH_IO",
    EXTERNAL_TRACK: "EXTERNAL_TRACK_UNIT",
    EXTERNAL_TRACK_UNIT: "EXTERNAL_TRACK_UNIT",
    LCU_TRANSPORT: "LCU_UNIT"
  };

  return aliases[d] || d;
}

/**
 * Infers a canonical device from its transport channel.
 */
function canonicalDeviceFromChannel(channel) {
  const c = String(channel || "").trim().toLowerCase();

  const map = {
    button_led: "BUTTON_LED_UNIT",
    joystick: "JOYSTICK_UNIT",
    imu: "IMU_UNIT",
    camera: "CAMERA_UNIT",
    tracker_telemetry: "CAMERA_UNIT",
    tracker_telem: "CAMERA_UNIT",
    tracker_publish: "DRIVE_UNIT",
    drive_wcs: "DRIVE_UNIT",
    lcu_transport: "LCU_UNIT",
    cce_gateway: "CCE_GATEWAY",
    wcs_control_console: "WCS_CONSOLE",
    maindisplay: "MAIN_DISPLAY",
    main_display: "MAIN_DISPLAY",
    advantec_driver: "ADVANTECH_IO",
    external_track: "EXTERNAL_TRACK_UNIT"
  };

  return map[c] || "";
}

/**
 * Returns the transport channels that can carry telemetry for a device.
 * Multiple candidates are retained for combined drive/LCU views so a page can
 * recover the newest raw packet regardless of which producer is active.
 */
function channelsForDevice(device) {
  const map = {
    BUTTON_LED_UNIT: ["button_led"],
    JOYSTICK_UNIT: ["joystick"],
    IMU_UNIT: ["imu"],
    CAMERA_UNIT: ["camera", "tracker_telemetry", "tracker_telem"],
    DRIVE_UNIT: ["lcu_transport", "drive_wcs", "tracker_publish"],
    LCU_UNIT: ["lcu_transport", "drive_wcs", "tracker_publish"],
    CCE_GATEWAY: ["cce_gateway"],
    WCS_CONSOLE: ["wcs_control_console"],
    MAIN_DISPLAY: ["maindisplay", "main_display"],
    ADVANTECH_IO: ["advantec_driver"],
    EXTERNAL_TRACK_UNIT: ["external_track"]
  };
  return map[canonicalDeviceName(device)] || [];
}

/**
 * Expands the newest compact raw packet into normal key/value telemetry rows.
 * This keeps charts usable with databases/backends whose expanded row response
 * is temporarily empty while preserving the packet's real receive timestamp.
 */
async function latestRawRowsForDevice(db, device) {
  const candidates = await Promise.all(
    channelsForDevice(device).map(async channel => {
      try {
        const packet = await api(
          "/api/hmi/latest?db=" + encodeURIComponent(db) +
          "&channel=" + encodeURIComponent(channel)
        );
        const payload = parseLivePayload(packet?.payload);
        if (!payload || typeof payload !== "object") return [];

        const fields = [];
        flattenLivePayload(payload, "", fields);
        /* Do not invent a packet timestamp when the stored packet has none. */
        const timestamp = packet.timestamp || "";
        return fields.map(field => ({
          timestamp,
          server_rx_ts: timestamp,
          device_ts: payload.device_ts || "",
          packet_ts: payload.packet_ts || "",
          channel: packet.channel || channel,
          device: canonicalDeviceName(device),
          device_name: canonicalDeviceName(device),
          process: payload.process || payload.process_name || "",
          process_name: payload.process || payload.process_name || "",
          ...field
        }));
      } catch {
        return [];
      }
    })
  );

  return candidates
    .flat()
    .sort((a, b) => parseTs(a.timestamp) - parseTs(b.timestamp));
}

/**
 * Expands compact archived packets into field rows shared by both data pages.
 */
function telemetryRowsFromPackets(packets, selectedDevice) {
  const rows = [];
  (Array.isArray(packets) ? packets : []).forEach(packet => {
    const payload = parseLivePayload(packet?.payload);
    if (!payload || typeof payload !== "object") return;
    const fields = [];
    flattenLivePayload(payload, "", fields);
    fields.forEach(field => rows.push({
      timestamp: packet.timestamp || packet.server_rx_ts || "",
      server_rx_ts: packet.server_rx_ts || packet.timestamp || "",
      device_ts: packet.device_ts || payload.device_ts || "",
      packet_ts: packet.packet_ts || payload.packet_ts || "",
      latency_ms: packet.latency_ms ?? "",
      channel: packet.channel || payload.channel || "",
      device: canonicalDeviceName(
        packet.device || payload.device || selectedDevice
      ),
      device_name: canonicalDeviceName(
        packet.device || payload.device || selectedDevice
      ),
      subdevice: packet.subdevice || payload.subdevice || "",
      process: packet.process || payload.process || "",
      subprocess: packet.subprocess || payload.subprocess || "",
      anomaly: packet.anomaly ? 1 : 0,
      reason: packet.reason || "",
      ...field
    }));
  });
  return rows;
}

/**
 * Compares two device identifiers after canonicalization.
 */
function sameDeviceName(a, b) {
  const left = canonicalDeviceName(a);
  const right = canonicalDeviceName(b);
  if (left === right) return true;

  /* The drive visualization combines drive-control and LCU transport packets.
     Keep their public labels separate while treating them as one data family
     in device/history filters. */
  return (
    (left === "DRIVE_UNIT" && right === "LCU_UNIT") ||
    (left === "LCU_UNIT" && right === "DRIVE_UNIT")
  );
}

/**
 * Determines the most reliable canonical device for a telemetry record.
 */
function canonicalDeviceForTelemetry(record) {
  const row = record || {};
  const channel = row.channel || row.channel_name || row.udp_channel || "";
  const explicit = row.device_name || row.device || row.subdevice_name || row.subdevice || "";
  const key = String(row.key || row.value_key || "").toLowerCase();
  const driveKeys = [
    "rpm", "pos_deg", "angle_feedback", "angle_feedback_raw",
    "angle_feedback_from_can", "actual_current", "dcbus_volt",
    "drive_connected", "fault_raw"
  ];
  const payloadHasDriveFields = driveKeys.some(name =>
    key === name || Object.prototype.hasOwnProperty.call(row, name)
  );

  // Live LCU packets contain the physical Drive feedback block. Only promote
  // rows carrying that explicit signature; ordinary LCU telemetry stays LCU.
  if (
    payloadHasDriveFields &&
    ["lcu_transport", "lcu"].includes(String(channel).toLowerCase())
  ) {
    return "DRIVE_UNIT";
  }

  return canonicalDeviceFromChannel(channel) ||
    canonicalDeviceName(explicit) ||
    canonicalDeviceName(row.process_name || row.process || "");
}

/**
 * Creates shared Chart.js tooltip formatting callbacks.
 */
function telemetryUnitForKey(key, explicitUnit) {
  if (explicitUnit) return String(explicitUnit);
  const normalized = String(key || "").toLowerCase();
  if (/(roll|pitch|yaw|pan|tilt|bearing|heading|azimuth|elevation|angle)/.test(normalized)) return "°";
  if (/rpm/.test(normalized)) return "rpm";
  if (/(current|amp)/.test(normalized)) return "A";
  if (/(voltage|volt|dcbus)/.test(normalized)) return "V";
  if (/(temperature|temp)/.test(normalized)) return "°C";
  if (/(latency|duration)/.test(normalized)) return "ms";
  if (/(range|distance)/.test(normalized)) return "m";
  return "";
}

function telemetryTooltipLines(details) {
  const timestamp = details?.timestamp || "--";
  const parsed = parseTs(timestamp);
  const sourceTime = Number.isFinite(parsed)
    ? new Date(parsed).toLocaleString()
    : String(timestamp);
  const field = String(details?.field || "Value");
  const unit = telemetryUnitForKey(field, details?.unit);
  const value = details?.value ?? "--";
  const lines = [
    `Device: ${details?.device || "--"}`,
    `Field: ${field}`,
    `Value: ${value}${unit ? ` ${unit}` : ""}`
  ];
  if (details?.status !== undefined && details.status !== null && details.status !== "") {
    lines.push(`Unit/Status: ${details.status}`);
  } else if (unit) {
    lines.push(`Unit/Status: ${unit}`);
  }
  lines.push(`Source timestamp: ${sourceTime}`);
  return lines;
}

function telemetryTooltipText(details) {
  return telemetryTooltipLines(details).join("\n");
}

function telemetryTooltipCallbacks() {
  return {
    title(items) {
      const item = items && items[0];
      const raw = item?.raw;
      const timestamp =
        (raw && typeof raw === "object" && (raw.timestamp || raw.x)) ||
        item?.dataset?.telemetryTimestamps?.[item.dataIndex] ||
        item?.label || "--";
      const parsed = parseTs(timestamp);
      return `Timestamp: ${
        Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : timestamp
      }`;
    },
    label(context) {
      const raw = context.raw && typeof context.raw === "object" ? context.raw : {};
      const key = raw.key || context.dataset?.telemetryKey || context.dataset?.label || "Value";
      const value = context.parsed?.y ?? context.raw?.y ?? context.raw;
      const timestamp = raw.timestamp || raw.x ||
        context.dataset?.telemetryTimestamps?.[context.dataIndex] || context.label;
      return telemetryTooltipLines({
        device: raw.device || context.dataset?.telemetryDevice,
        field: key,
        value,
        unit: raw.unit || context.dataset?.telemetryUnit,
        status: raw.status || context.dataset?.telemetryStatus,
        timestamp
      });
    }
  };
}

/**
 * Extracts a uniform telemetry-row array from supported API envelopes.
 */
function flattenScadaRows(data) {
  if (!data) {
    return [];
  }

  if (Array.isArray(data)) {
    return data.filter(Boolean);
  }

  if (typeof data === "string") {
    try {
      const parsed = JSON.parse(data);
      return flattenScadaRows(parsed);
    } catch {
      return [];
    }
  }

  if (typeof data === "object") {
    return [data];
  }

  return [];
}

/**
 * Detects envelope metadata that is not a measured telemetry value.
 */
function isTelemetryMetaKey(key) {
  return [
    "session_id",
    "session",
    "timestamp",
    "time",
    "device",
    "device_name",
    "channel",
    "channel_name",
    "process",
    "process_name",
    "subprocess",
    "subprocess_name",
    "key",
    "value_key",
    "value_type",
    "value_num",
    "value_text",
    "anomaly",
    "reason",
    "server_rx_ts",
    "device_ts",
    "packet_ts",
    "payload",
    "type"
  ].includes(String(key || "").toLowerCase());
}

/**
 * Safely parses an encoded live payload while accepting decoded values.
 */
function parseLivePayload(payload) {
  if (!payload) {
    return null;
  }

  if (typeof payload === "string") {
    try {
      return JSON.parse(payload);
    } catch {
      return null;
    }
  }

  if (typeof payload === "object") {
    return payload;
  }

  return null;
}

/**
 * Normalizes alternate live envelope shapes into the shared representation.
 */
function normalizeScadaPayloadEnvelope(payload) {
  const parsed = parseLivePayload(payload);

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return parsed;
  }

  if (
    parsed.body &&
    typeof parsed.body === "object" &&
    !Array.isArray(parsed.body)
  ) {
    return {
      ...parsed,
      ...parsed.body
    };
  }

  return parsed;
}

/**
 * Converts a scalar payload member into a displayable telemetry value.
 */
function scalarToLiveValue(value) {
  if (typeof value === "number") {
    return {
      value_type: "num",
      value_num: value,
      value_text: ""
    };
  }

  if (typeof value === "boolean") {
    return {
      value_type: "num",
      value_num: value ? 1 : 0,
      value_text: ""
    };
  }

  if (value == null) {
    return { value_type: "null", value_num: null, value_text: "null" };
  }

  const text = String(value);
  const num = Number(text);

  if (text.trim() !== "" && Number.isFinite(num)) {
    return {
      value_type: "num",
      value_num: num,
      value_text: ""
    };
  }

  if (text.toLowerCase() === "true") {
    return {
      value_type: "num",
      value_num: 1,
      value_text: ""
    };
  }

  if (text.toLowerCase() === "false") {
    return {
      value_type: "num",
      value_num: 0,
      value_text: ""
    };
  }

  return {
    value_type: "text",
    value_num: 0,
    value_text: text
  };
}

/**
 * Recursively converts nested payload members into flat telemetry fields.
 */
function flattenLivePayload(payload, prefix, out) {
  const source = normalizeScadaPayloadEnvelope(payload);

  if (source == null) {
    return out;
  }

  /*
   * Arrays
   */
  if (Array.isArray(source)) {
    source.forEach((item, index) => {
      const itemKey = prefix
        ? `${prefix}_${index}`
        : String(index);

      if (item && typeof item === "object") {
        flattenLivePayload(item, itemKey, out);
      } else {
        const scalar = scalarToLiveValue(item);

        if (scalar) {
          out.push({
            key: itemKey,
            ...scalar
          });
        }
      }
    });

    return out;
  }

  /*
   * Special packet form:
   *
   * {
   *   topic: "...",
   *   value: 123
   * }
   */
  const topicValuePacket =
    typeof source.topic === "string" &&
    source.topic.trim() !== "" &&
    Object.prototype.hasOwnProperty.call(source, "value") &&
    (source.value == null ||
      typeof source.value !== "object");

  if (topicValuePacket) {
    const metricKey = source.topic
      .trim()
      .replace(/[^a-zA-Z0-9_]/g, "_");

    const scalar = scalarToLiveValue(source.value);

    if (metricKey && scalar) {
      out.push({
        key: metricKey,
        ...scalar
      });
    }
  }

  /*
   * Normal object traversal.
   */
  Object.entries(source).forEach(([key, value]) => {

    if (!prefix && isTelemetryMetaKey(key)) {
      return;
    }

    if (
      topicValuePacket &&
      (key === "topic" || key === "value")
    ) {
      return;
    }

    const nextKey =
      prefix
        ? `${prefix}_${key}`
        : key;

    /*
     * ============================================================
     * PHYSICAL CONTROL OBJECT
     * ============================================================
     *
     * Simulator sends:
     *
     * "DRIVES_RESET": {
     *     "id": 1,
     *     "value": 1
     * }
     *
     * We must expose:
     *
     *     DRIVES_RESET = 1
     *
     * while ALSO retaining:
     *
     *     buttons_DRIVES_RESET_id
     *     buttons_DRIVES_RESET_value
     *
     * so NO telemetry information is lost.
     */
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.prototype.hasOwnProperty.call(value, "value")
    ) {
      const controlValue =
        scalarToLiveValue(value.value);

      if (controlValue) {
        /*
         * The important normalized control field.
         *
         * Example:
         * buttons_DRIVES_RESET -> 1
         *
         * The UI's suffix matching will identify
         * DRIVES_RESET correctly.
         */
        out.push({
          key: nextKey,
          ...controlValue
        });
      }

      /*
       * Preserve every nested property as well.
       *
       * Example:
       * buttons_DRIVES_RESET_id
       * buttons_DRIVES_RESET_value
       */
      Object.entries(value).forEach(
        ([childKey, childValue]) => {

          const childPath =
            `${nextKey}_${childKey}`;

          if (
            childValue &&
            typeof childValue === "object"
          ) {
            flattenLivePayload(
              childValue,
              childPath,
              out
            );
            return;
          }

          const scalar =
            scalarToLiveValue(childValue);

          if (scalar) {
            out.push({
              key: childPath,
              ...scalar
            });
          }
        }
      );

      return;
    }

    /*
     * Normal nested object.
     */
    if (
      value &&
      typeof value === "object"
    ) {
      flattenLivePayload(
        value,
        nextKey,
        out
      );
      return;
    }

    /*
     * Normal scalar field.
     */
    const scalar =
      scalarToLiveValue(value);

    if (scalar) {
      out.push({
        key: nextKey,
        ...scalar
      });
    }
  });

  return out;
}

/**
 * Transforms a normalized WebSocket event into dashboard-ready rows.
 */
function liveRowsFromScadaEvent(data) {
  if (!data) {
    return [];
  }

  if (Array.isArray(data)) {
    return data.flatMap(item => liveRowsFromScadaEvent(item));
  }

  if (typeof data === "string") {
    try {
      return liveRowsFromScadaEvent(JSON.parse(data));
    } catch {
      return [];
    }
  }

  if (typeof data !== "object") {
    return [];
  }

  if (data.payload != null) {
    const payloadObject =
      parseLivePayload(data.payload) || {};
    const receivedAt = new Date().toISOString();
    const baseTimestamp = data.timestamp || receivedAt;
    const channel = data.channel || data.channel_name ||
      payloadObject.channel || payloadObject.channel_name || "";
    const device =
      canonicalDeviceName(
        data.device ||
        data.device_name ||
        payloadObject.device ||
        payloadObject.device_name ||
        canonicalDeviceFromChannel(channel) ||
        ""
      );
    const process = data.process || data.process_name ||
      payloadObject.process || payloadObject.process_name || "";
    const subprocess = data.subprocess || data.subprocess_name ||
      payloadObject.subprocess || payloadObject.subprocess_name || "";
    const anomaly = data.anomaly ? 1 : 0;
    const rows = [];

    flattenLivePayload(payloadObject, "", rows);

    if (!rows.length && payloadObject && typeof payloadObject === "object") {
      const scalar =
        payloadObject.value_num != null
          ? scalarToLiveValue(payloadObject.value_num)
          : payloadObject.value_text != null
            ? scalarToLiveValue(payloadObject.value_text)
            : payloadObject.value != null
              ? scalarToLiveValue(payloadObject.value)
              : null;

      const fallbackKey =
        payloadObject.value_key ||
        payloadObject.metric ||
        payloadObject.key ||
        payloadObject.name ||
        "value";

      if (scalar) {
        rows.push({
          key: fallbackKey,
          ...scalar
        });
      }
    }

    return rows.map(row => ({
      source_ip: data.source_ip || data.src_ip || "",
      source_port: data.source_port ?? data.src_port ?? 0,
      timestamp: baseTimestamp,
      server_rx_ts: data.server_rx_ts || data.server_timestamp || baseTimestamp,
      device_ts: data.device_ts || payloadObject.device_ts || "",
      packet_ts: data.packet_ts || payloadObject.packet_ts || "",
      server_timestamp: baseTimestamp,
      channel_name: channel,
      device_name: device,
      subdevice_name: data.subdevice || data.subdevice_name || "",
      process_name: process,
      subprocess_name: subprocess,
      key: row.key,
      value_type: row.value_type,
      value_num: row.value_num,
      value_text: row.value_text,
      value: row.value_type === "num" ? row.value_num : row.value_text,
      anomaly,
      reason: data.reason || ""
    }));
  }

  if (
    data.key != null ||
    data.value_type != null ||
    data.value_num != null ||
    data.value_text != null
  ) {
    return [data];
  }

  return [];
}

/**
 * Restricts a chart series by time window and maximum point count.
 */
function trimPointSeries(points, windowMs, maxPoints = 300) {
  if (!Array.isArray(points)) {
    return points;
  }

  if (windowMs > 0) {
    // Capture the current browser time in `cutoff`.
    const cutoff = Date.now() - windowMs;

    while (points.length && Number(points[0].x) < cutoff) {
      points.shift();
    }
  }

  if (Number.isFinite(maxPoints) && maxPoints > 0) {
    while (points.length > maxPoints) {
      points.shift();
    }
  }

  return points;
}

/**
 * Returns a stable visual colour configuration for a series.
 */
function chartColors(i) {
  const colors = [
    "#60a5fa",
    "#34d399",
    "#fbbf24",
    "#f472b6",
    "#a78bfa",
    "#fb7185",
    "#22d3ee",
    "#f97316",
    "#84cc16",
    "#e879f9"
  ];

  return colors[i % colors.length];
}

/**
 * Calculates safe finite y-axis boundaries for telemetry series.
 */
function seriesBounds(series) {
  let min = Infinity;
  let max = -Infinity;

  series.forEach(s => {
    (s.data || []).forEach(p => {
      const y = Number(p && p.y);

      if (!Number.isFinite(y)) {
        return;
      }

      min = Math.min(min, y);
      max = Math.max(max, y);
    });
  });

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return null;
  }

  if (min === max) {
    const pad = Math.max(Math.abs(min) * 0.1, 1);
    return { min: min - pad, max: max + pad };
  }

  const span = max - min;
  const pad = Math.max(span * 0.1, 1);

  return {
    min: min - pad,
    max: max + pad
  };
}

/**
 * Converts normalized series into Chart.js dataset configurations.
 */
function buildLineChartDatasets(series) {
  return (series || []).map((s, i) => {
    const label = String(s.label || "").toLowerCase();
    const highRange =
      label.includes("rpm") ||
      label.includes("current") ||
      label.includes("voltage") ||
      label.includes("temperature");

    return {
      label: s.label,
      telemetryKey: s.telemetryKey || s.label,
      telemetryDevice: s.telemetryDevice || s.data?.[0]?.device || "",
      telemetryUnit: s.telemetryUnit || s.data?.[0]?.unit || "",
      telemetryStatus: s.telemetryStatus || s.data?.[0]?.status || "",
      data: Array.isArray(s.data)
        ? s.data.slice().sort((a, b) => a.x - b.x)
        : [],
      borderColor: chartColors(i),
      backgroundColor: chartColors(i),
      borderWidth: 2,
      tension: 0.15,
      pointRadius: 0,
      pointHoverRadius: 3,
      fill: false,
      spanGaps: true,
      yAxisID: "y",
      hidden: Boolean(highRange && !s.data?.length)
    };
  });
}

/**
 * Refreshes an existing chart without recreating its canvas.
 */
function updateExistingLineChart(chart, datasets, title) {
  if (!chart || chart.destroyed) {
    return null;
  }

  const previousDatasets = Array.isArray(chart.data.datasets) ? chart.data.datasets : [];

  // Transform the source collection into `nextDatasets`.
  const nextDatasets = datasets.map((dataset, index) => {
    const previous = previousDatasets.find(ds => String(ds.label || "") === String(dataset.label || ""));

    return {
      ...(previous || {}),
      ...dataset,
      data: Array.isArray(dataset.data) ? dataset.data : [],
      borderColor: dataset.borderColor || previous?.borderColor || chartColors(index),
      backgroundColor: dataset.backgroundColor || previous?.backgroundColor || chartColors(index)
    };
  });

  chart.data.datasets = nextDatasets;
  chart.options.plugins.title.text = title || "";
  chart.options.responsive = true;
  chart.options.maintainAspectRatio = false;
  chart.options.animation = false;
  chart.options.normalized = true;
  chart.options.interaction = {
    intersect: false,
    mode: "index"
  };
  chart.options.plugins.legend.display = false;
  chart.options.plugins.legend.position = "bottom";
  chart.options.plugins.legend.labels = {
    color: "white",
    boxWidth: 15
  };
  chart.options.plugins.tooltip.enabled = true;
  chart.options.plugins.tooltip.mode = "index";
  chart.options.plugins.tooltip.intersect = false;
  chart.options.plugins.tooltip.callbacks = telemetryTooltipCallbacks();
  chart.options.scales.x.type = "time";
  chart.options.scales.x.ticks.color = "white";
  chart.options.scales.x.grid.color = "#374151";
  chart.options.scales.y.position = "left";
  chart.options.scales.y.ticks.color = "#60a5fa";
  chart.options.scales.y.grid.color = "#374151";
  chart.options.scales.y1.position = "right";
  chart.options.scales.y1.ticks.color = "#f59e0b";
  chart.options.scales.y1.grid.drawOnChartArea = false;
  chart.update("none");

  return chart;
}

/**
 * Creates or updates a responsive telemetry line chart.
 */
function drawLineChart(canvas, series, title) {

  if (!canvas) {
    return;
  }

  const datasets = buildLineChartDatasets(series);

  if (canvas.chartInstance && !canvas.chartInstance.destroyed) {
    return updateExistingLineChart(canvas.chartInstance, datasets, title);
  }

  canvas.style.background = "#020617";
  canvas.style.display = "block";

  canvas.chartInstance = new Chart(
    canvas,
    {

      type: "line",

      data: {
        datasets
      },

      options: {

        responsive: true,

        maintainAspectRatio: false,

        animation: false,

        normalized: true,

        interaction: {

          intersect: false,

          mode: "index"

        },

        plugins: {

          title: {

            display: true,

            text: title || "",

            color: "white"

          },  

          legend: {

            display: false,

            position: "bottom",

            labels: {

              color: "white",

              boxWidth: 15

            }

          },

          tooltip: {

            enabled: true,

            mode: "index",

            intersect: false,

            callbacks: telemetryTooltipCallbacks()

          }

        },

        scales: {

          x: {

            type: "time",

            ticks: {

              color: "white"

            },

            grid: {

              color: "#374151"

            }

          },

          y: {

            position: "left",

            ticks: {

              color: "#60a5fa"

            },

            grid: {

              color: "#374151"

            }

          },

          y1: {

            position: "right",

            ticks: {

              color: "#f59e0b"

            },

            grid: {

              drawOnChartArea: false

            }

          }

        }

      }

    }
  );

  registerActiveChart(
    canvas.chartInstance,
    getWindowMsFromPage
  );

  return canvas.chartInstance;
}

/**
 * Groups numeric telemetry rows into bounded timestamped series.
 */
function buildSeries(rows, maxSeries = 200) {
  const grouped = {};

  rows.forEach(r => {
    if (!r) {
      return;
    }

    if (String(r.value_type) !== "num") {
      return;
    }

    const val = Number(
      r.value_num ??
      r.value ??
      r.numeric_value
    );

    if (!Number.isFinite(val)) {
      return;
    }

    const label =
      `${canonicalDeviceName(r.device || r.device_name || "-")}` +
      ` | ${r.process || r.process_name || "-"}` +
      ` | ${r.key || "-"}`;

    if (!grouped[label]) {
      grouped[label] = [];
    }

    grouped[label].push({
      x: parseTs(
        r.server_rx_ts ||
        r.server_timestamp ||
        r.timestamp ||
        r.packet_ts ||
        r.device_ts
      ),
      y: val
    });
  });

  Object.keys(grouped).forEach(k => {
    grouped[k].sort((a, b) => a.x - b.x);
  });

  return Object.keys(grouped)
    .slice(0, 20)
    .map(k => ({
      label: k,
      data: grouped[k]
    }));
}

/**
 * Renders an escaped compact legend for visible chart series.
 */
function renderLegend(id, series) {
  const el = $(id);

  if (!el) {
    return;
  }

  el.innerHTML = series.map((s, i) => `
    <span class="legendItem">
      <span
        class="legendColor"
        style="background:${chartColors(i)}">
      </span>

      ${esc(s.label)}
    </span>
  `).join("");
}

/**
 * Safely updates an element's text content when it exists.
 */
function setText(id, value) {
  const el = $(id);

  if (!el) {
    return;
  }

  el.textContent = value;
}

/**
 * Safely updates an element's generated HTML when it exists.
 */
function setHtml(id, value) {
  const el = $(id);

  if (!el) {
    return;
  }

  el.innerHTML = value;
}

/*
--------------------------------------------------
SCADA WEBSOCKET MANAGER
--------------------------------------------------
*/

/**
 * Creates and maintains the shared reconnecting SCADA WebSocket.
 */
function initScadaSocket() {
  if (
    App.ws &&
    (
      App.ws.readyState === WebSocket.OPEN ||
      App.ws.readyState === WebSocket.CONNECTING
    )
  ) {
    return App.ws;
  }

  const proto =
    location.protocol === "https:"
      ? "wss"
      : "ws";

  const ws = new WebSocket(
    proto +
    "://" +
    location.host +
    "/ws"
  );

  ws.onopen = () => {
    console.log("[SCADA] Live stream connected");
    App.wsConnected = true;
    App.wsBackoffMs = 1000;
    App.wsConnectionGeneration++;
    window.dispatchEvent(
      new CustomEvent("scada:connected", {
        detail: {
          generation: App.wsConnectionGeneration
        }
      })
    );
  };

  ws.onclose = () => {
    console.warn("[SCADA] Live stream disconnected");
    App.wsConnected = false;
    App.ws = null;
    window.dispatchEvent(
      new CustomEvent("scada:disconnected", {
        detail: {
          generation: App.wsConnectionGeneration
        }
      })
    );

    setTimeout(() => {
      initScadaSocket();
    }, App.wsBackoffMs);

    App.wsBackoffMs =
      Math.min(10000, App.wsBackoffMs * 1.6);
  };

  ws.onerror = err => {
    console.error("[SCADA] WebSocket error", err);
  };

/*
--------------------------------------------------
BUFFERED SCADA WEBSOCKET MESSAGE HANDLER
--------------------------------------------------
Why:
UDP packets may arrive very fast. If every WebSocket message directly
updates dashboard/HMI/history, the browser can freeze.

Fix:
Collect messages in memory and flush them every 250 ms.
This keeps the UI smooth while still receiving live data.
--------------------------------------------------
*/

App.wsBuffer = App.wsBuffer || [];
App.wsFlushTimer = App.wsFlushTimer || null;
App.wsBufferMax = 4000;
App.wsFlushMs = 100;

/**
 * Builds the stable identity used to coalesce repeated updates.
 */
function scadaCoalesceKey(msg) {
  if (!msg || typeof msg !== "object") {
    return "";
  }

  const payload =
    msg.payload && typeof msg.payload === "object"
      ? msg.payload
      : msg;

  return [
    msg.source_ip || msg.src_ip || "",
    msg.type || "row",
    msg.channel || msg.channel_name || payload.channel || payload.channel_name || "",
    msg.device || msg.device_name || payload.device || payload.device_name || "",
    msg.process || msg.process_name || payload.process || payload.process_name || "",
    msg.key || msg.value_key || payload.key || payload.value_key ||
      payload.name || payload.topic || ""
  ].map(v => String(v || "").toUpperCase()).join("|");
}

/**
 * Reduces buffered messages to their newest compatible values.
 */
function coalesceScadaBatch(batch) {
  const latestByKey = new Map();
  const passthrough = [];

  batch.forEach(item => {
    const key = scadaCoalesceKey(item);

    const payload =
      item?.payload && typeof item.payload === "object"
        ? item.payload
        : item;
    const hasMetricIdentity = Boolean(
      item?.key || item?.value_key || payload?.key || payload?.value_key ||
      payload?.name || payload?.topic
    );

    /* Without a field/topic identity, keep the packet separate. Merging whole
       payloads by device previously combined unrelated values and timestamps. */
    if (!hasMetricIdentity || !key || key === "ROW||||") {
      passthrough.push(item);
      return;
    }

    /* For one explicitly identified metric, the newest complete message wins. */
    latestByKey.set(key, item);
  });

  return [
    ...passthrough,
    ...latestByKey.values()
  ].slice(-App.wsBufferMax);
}

/**
 * Dispatches the current buffered live-message batch to listeners.
 */
function flushScadaWsBuffer() {
  const batch =
    coalesceScadaBatch(
      App.wsBuffer.splice(0, App.wsBuffer.length)
    );

  if (!batch.length) {
    return;
  }

  App.wsListeners.forEach(fn => {
    try {
      fn(batch);
    } catch (err) {
      console.error("WS listener failed:", err);
    }
  });
}

ws.onmessage = ev => {
  try {
    const msg = JSON.parse(ev.data);

    App.wsLastMessageAt = Date.now();

    App.wsBuffer.push(msg);

    /*
    Prevent unlimited browser memory growth.
    If packets are coming faster than browser can render,
    keep latest messages for live display.
    Backend/database still stores all packets.
    */
    while (App.wsBuffer.length > App.wsBufferMax) {
      App.wsBuffer.shift();
    }

    if (!App.wsFlushTimer) {
      App.wsFlushTimer = setTimeout(() => {
        App.wsFlushTimer = null;
        flushScadaWsBuffer();
      }, App.wsFlushMs);
    }

  } catch (err) {
    console.error("WS parse failed:", err);
  }
};

  App.ws = ws;
  return ws;
}

/**
 * Registers a shared SCADA event listener and returns an unsubscribe function.
 */
function onScadaEvent(handler) {
  if (typeof handler !== "function") {
    return;
  }

  App.wsListeners.push(handler);
}

/* Lightweight storage health is intentionally independent of historical DB
   queries. A storage failure is visible on every page while live WS continues. */
async function refreshStorageHealth() {
  let banner = document.getElementById("storageHealthBanner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "storageHealthBanner";
    banner.setAttribute("role", "status");
    banner.className = "storageHealthBanner";
    document.body.appendChild(banner);
  }
  try {
    const health = await api("/api/storage/status", 3000);
    if (health.ok) {
      banner.className = "storageHealthBanner healthy";
      banner.textContent = `Database storage operational · queue ${health.queue_len || 0}`;
    } else {
      banner.className = "storageHealthBanner failed";
      banner.textContent = `DATABASE STORAGE ERROR: ${health.message || "writes stopped"}. Live monitoring remains active.`;
    }
  } catch {
    banner.className = "storageHealthBanner unavailable";
    banner.textContent = "Storage status unavailable; checking connection…";
  }
}

window.addEventListener("DOMContentLoaded", () => {
  refreshStorageHealth();
  setInterval(refreshStorageHealth, 5000);
});

/*
--------------------------------------------------
REAL-TIME SLIDING SCALE REGISTRY & TICK LOOP
--------------------------------------------------
*/

App.activeCharts = [];

/**
 * Registers a chart for shared rolling-window maintenance.
 */
function registerActiveChart(chart, getWindowMs) {
  if (!chart) return;
  const exists = App.activeCharts.some(entry => entry.chart === chart || (entry.chart.canvas && entry.chart.canvas === chart.canvas));
  if (!exists) {
    App.activeCharts.push({ chart, getWindowMs });
  }
}

/**
 * Reads the active page range and returns its duration.
 */
function getWindowMsFromPage() {

  const sel =
    document.getElementById("range");

  return rangeToMs(
    sel ? sel.value : App.range
  );

}

/*
--------------------------------------------------
DISPLAY UTC DATABASE TIME AS LOCAL BROWSER TIME
--------------------------------------------------
Backend stores UTC ISO timestamps.
Frontend displays them in local readable time.
--------------------------------------------------
*/

/**
 * Formats a telemetry timestamp in the browser's local timezone.
 */
function formatLocalTime(ts) {
  const t = parseTs(ts);

  if (!Number.isFinite(t)) {
    return ts || "-";
  }

  return new Date(t).toLocaleString();
}

/*
setInterval(() => {

  if (
    !location.pathname.includes("dashboard")
  ) {
    return;
  }

  App.activeCharts = App.activeCharts.filter(entry => {

    const {
      chart,
      getWindowMs
    } = entry;

    if (
      !chart ||
      chart.destroyed ||
      !chart.canvas ||
      !document.body.contains(chart.canvas)
    ) {
      return false;
    }

    let newestPoint = 0;

    (chart.data.datasets || []).forEach(ds => {

      (ds.data || []).forEach(pt => {

        if (pt && pt.x) {

          newestPoint =
            Math.max(
              newestPoint,
              pt.x
            );

        }

      });

    });

const now =
  newestPoint ||
  Date.now();

try {

      const windowMs = getWindowMs();
      if (
  chart.data.datasets.every(
    d => (d.data || []).length < 5
  )
) {
  return true;
}
      if (windowMs > 0) {
        chart.options.scales.x.min = now - windowMs;
        chart.options.scales.x.max = now;

        // Autoscale Y axis for visible points only
        let visibleMin = Infinity;
        let visibleMax = -Infinity;

        (chart.data.datasets || []).forEach(dataset => {
          (dataset.data || []).forEach(pt => {
            if (pt) {
              const xVal = pt.x !== undefined ? pt.x : (pt.t !== undefined ? pt.t : null);
              if (xVal !== null && xVal >= now - windowMs && xVal <= now) {
                const yVal = Number(pt.y);
                if (Number.isFinite(yVal)) {
                  visibleMin = Math.min(visibleMin, yVal);
                  visibleMax = Math.max(visibleMax, yVal);
                }
              }
            }
          });
        });

        if (visibleMin !== Infinity && visibleMax !== -Infinity) {
          const span = visibleMax - visibleMin;
          const pad = span === 0 ? Math.max(Math.abs(visibleMin) * 0.1, 1) : span * 0.1;
         chart.options.scales.y.min = visibleMin - pad;
 chart.options.scales.y.max = visibleMax + pad;
        }

        chart.update("none");
      }
    } catch (e) {
      console.error("[Sliding scale] Chart update error:", e);
    }
    return true;
  });
}, 1000);
*/

// Consume bounded pages of latest fields, independently of packet history size.
async function forEachTelemetryFieldPage(database, device, consume) {
  let after = 0;
  do {
    const page = await api("/api/fields?db=" + encodeURIComponent(database) +
      "&device=" + encodeURIComponent(device) + "&after=" + after);
    consume(page.rows || []);
    const next = Number(page.next) || 0;
    if (next && next <= after) throw new Error("Invalid field pagination cursor");
    after = next;
    if (after) await new Promise(resolve => setTimeout(resolve, 0));
  } while (after);
}

// A shared, paginated view of the authoritative registry on the existing pages.
// At most one 200-field page is retained, regardless of database/session size.
document.addEventListener("DOMContentLoaded", () => {
  const host = document.querySelector("main");
  // Preserve the original HMI and Main Dashboard without an injected field panel.
  if (!host || document.getElementById("missionApp") ||
      document.getElementById("hmiDeviceSelect") ||
      document.getElementById("multiChartA")) return;
  const section = document.createElement("section");
  section.className = "panel-section telemetry-inspector";
  section.style.cssText = "padding:16px;min-width:0;overflow:auto;border:1px solid #284055;margin:12px 0";
  section.innerHTML = `<h2>Complete telemetry fields</h2>
    <p>Source IP → Device → Channel → Field. Last received values remain available when a source is offline.</p>
    <form class="controls"><label>Device <input name="device" aria-label="Inspect device"></label>
      <label>Source IP <input name="ip" aria-label="Inspect source IP"></label>
      <label>Field <input name="search" aria-label="Search field names"></label>
      <button type="submit">Load fields</button></form>
    <div><button type="button" data-action="previous">Previous</button>
      <span role="status"></span> <button type="button" data-action="next">Next</button></div>
    <div style="overflow:auto;max-height:500px"><table><thead><tr><th>Source IP:port</th><th>Device</th><th>Channel</th><th>Field</th><th>Type</th><th>Last value</th><th>Received</th></tr></thead><tbody></tbody></table></div>`;
  host.appendChild(section);
  const form = section.querySelector("form");
  const deviceInput = form.elements.namedItem("device");
  deviceInput.value = new URLSearchParams(location.search).get("name") || "";
  const status = section.querySelector('[role="status"]');
  const previous = section.querySelector('[data-action="previous"]');
  const nextButton = section.querySelector('[data-action="next"]');
  const tbody = section.querySelector("tbody");
  let cursor = 0, next = 0, generation = 0, rows = [], back = [];
  const identity = row => JSON.stringify([row.source_ip, row.device_name, row.channel_name, row.key]);
  function draw() {
    tbody.innerHTML = rows.map(row => `<tr><td>${esc(row.source_ip)}:${esc(row.source_port ?? "")}</td>
      <td><a href="device.html?name=${encodeURIComponent(row.device_name)}&db=${encodeURIComponent(App.db)}">${esc(row.device_name)}</a></td>
      <td>${esc(row.channel_name)}</td><td>${esc(row.key)}</td><td>${esc(row.value_type)}</td>
      <td style="white-space:pre-wrap;overflow-wrap:anywhere;max-width:480px">${esc(row.value_type === "num" ? row.value_num : row.value_text)}</td><td>${esc(row.timestamp)}</td></tr>`).join("");
  }
  async function load() {
    const request = ++generation;
    status.textContent = "Loading...";
    try {
      const database = document.getElementById("dbSelect")?.value || App.db;
      const query = new URLSearchParams({ db: database, after: cursor,
        device: deviceInput.value.trim(), source_ip: form.elements.namedItem("ip").value.trim(),
        search: form.elements.namedItem("search").value.trim() });
      const page = await api("/api/fields?" + query);
      if (generation !== request) return;
      rows = page.rows || [];
      next = page.next || 0;
      draw();
      status.textContent = `${rows.length} fields · page ${back.length + 1}`;
      previous.disabled = !back.length;
      nextButton.disabled = !next;
    } catch (error) { status.textContent = error.message; }
  }
  form.onsubmit = event => { event.preventDefault(); cursor = 0; back = []; load(); };
  previous.onclick = () => { cursor = back.pop() || 0; load(); };
  nextButton.onclick = () => { if (next) { back.push(cursor); cursor = next; load(); } };
  document.getElementById("dbSelect")?.addEventListener("change", () => { cursor = 0; back = []; load(); });
  onScadaEvent(batch => {
    const updates = new Map(liveRowsFromScadaEvent(batch).map(row => [identity(row), row]));
    let changed = false;
    rows = rows.map(row => {
      const update = updates.get(identity(row));
      if (update) { changed = true; return { ...row, ...update }; }
      return row;
    });
    if (changed) draw();
  });
  // Initial loading follows the page's database initialization. Refreshes also
  // discover newly introduced fields without retaining packet history.
  setTimeout(load, 1500);
  setInterval(() => { if (!document.hidden) load(); }, 15000);
});
