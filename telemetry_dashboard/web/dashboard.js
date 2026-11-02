/*
 * Fleet dashboard controller.
 *
 * Bootstraps status and history through HTTP, merges coalesced WebSocket
 * updates, maintains synchronized graph timelines, and renders fleet health,
 * anomaly summaries, device cards, and live tables. Refresh guards prevent
 * overlapping API cycles from applying stale results out of order.
 */
// Track whether a full dashboard refresh is already running.
let dashboardBusy = false;
// Prevent concurrent device-status requests from racing.
let dashboardStatusRefreshInFlight = false;

// Record whether the operator is viewing filtered search results.
let searchMode = false;

// Hold the periodic dashboard-refresh timer identifier.
let refreshTimer = null;

// Record whether historical replay mode is active.
let replayMode = false;

// Record whether an active replay is temporarily paused.
let replayPaused = false;

// Store the ordered telemetry rows used for replay.
let replayRows = [];

// Track the next row to emit during replay.
let replayIndex = 0;

// Hold the scheduled replay callback identifier.
let replayTimer = null;

// Retain the bounded telemetry history used by both live charts.
let dashboardChartRows = [];
// Retain the bounded telemetry history displayed in the live table.
let liveTableRows = [];
// Generate stable ordering information for incoming live rows.
let liveRowCounter = 0;
// Prevent duplicate chart updates within one browser frame.
let dashboardLiveUpdateScheduled = false;
// Prevent duplicate fleet renders within one browser frame.
let dashboardDeviceRenderScheduled = false;
// Hold the newest summary until the scheduled render executes.
let dashboardPendingSummary = null;

// Store the heading associated with the current graph data mode.
let dashboardChartTitle = "Live Telemetry";
// Record when device status was most recently refreshed.
let lastDeviceRefresh = 0;
// Cache the last valid deduplicated fleet model.
let lastDashboardDevices = [];
// Store the most recent live heartbeat time for each device.
const dashboardLiveHeartbeat = {};
// Track the WebSocket generation used by the current live state.
let lastWsGeneration = 0;
// Store anomaly, health, loss, drift, and alert-analysis state.
const aiState = {

  deviceHealth: {},
deviceStats: {},
  lastValues: {},

  anomalyHistory: [],

  packetLoss: {},

  driftScore: {},

  alertCache: {}
};

/*
--------------------------------------------------
CURRENT DB
--------------------------------------------------
*/

/**
 * Returns the database currently selected by the operator.
 */
function currentDb() {

  const sel = $("dbSelect");

  return sel ? sel.value : "";
}

/*
--------------------------------------------------
OPEN DEVICE PAGE
--------------------------------------------------
*/

/**
 * Navigates to a device detail page while preserving the active database.
 */
function openDevice(name) {

  location.href =

    "device.html?name=" +

    encodeURIComponent(name) +

    "&db=" +

    encodeURIComponent(currentDb());
}

/*
--------------------------------------------------
SUMMARY
--------------------------------------------------
*/

/**
 * Renders database and telemetry totals in the summary-card grid.
 */
function renderSummary(s) {

  $("summary").innerHTML = [

    ["Rows", s.row_count || 0],

    ["Devices", s.device_count || 0],

    ["Processes", s.metric_count || 0],

    ["First", s.first_timestamp || "-"],

    ["Last", s.last_timestamp || "-"],

    ["DB", currentDb() || "-"]

  ].map(x => `

    <div class="card">

      <h3>${esc(x[0])}</h3>

      <div>${esc(x[1])}</div>

    </div>

  `).join("");
}

/**
 * Calculates and renders aggregate device and alarm status.
 */
function renderDeviceStatusSummary(devs, rows = []) {
  const devices =
    Array.isArray(devs)
      ? devs
      : [];

  const sourceRows =
    Array.isArray(rows)
      ? rows
      : [];

  // Filter the source collection into `onlineCount`.
  const onlineCount = devices.filter(
    d => String(d.status || "").toLowerCase() === "online"
  ).length;

  // Filter the source collection into `warningCount`.
  const warningCount = devices.filter(
    d => String(d.status || "").toLowerCase() === "warning"
  ).length;

  // Filter the source collection into `offlineCount`.
  const offlineCount = devices.filter(
    d => String(d.status || "").toLowerCase() === "offline"
  ).length;

  const anomalyCount =
    sourceRows.filter(r => r.anomaly).length;

  $("globalStatus").innerHTML = `

    <div class="globalGrid">

      <div class="globalCard online">

        <div class="globalPulse"></div>

        <h3>${onlineCount}</h3>

        <p>ONLINE</p>

      </div>

      <div class="globalCard warning">

        <h3>${warningCount}</h3>

        <p>WARNING</p>

      </div>

      <div class="globalCard offline">

        <h3>${offlineCount}</h3>

        <p>OFFLINE</p>

      </div>

      <div class="globalCard anomaly">

        <h3>${anomalyCount}</h3>

        <p>ALARMS</p>

      </div>

    </div>
  `;
}

/*
--------------------------------------------------
DEVICE NAME NORMALIZATION
--------------------------------------------------
This avoids duplicate cards like:
IMU and IMU_UNIT
LCU and LCU_UNIT
EXTERNAL_TRACK and EXTERNAL_TRACK_UNIT

Both names belong to the same real device family.
--------------------------------------------------
*/

/**
 * Normalizes device aliases into one stable family identifier.
 */
function normalizeDeviceFamilyName(name) {
  let n = String(name || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_")
    .replace(/-/g, "_");

  n = n.replace(/_+/g, "_");

  if (n === "EXTERNAL_TRACKER") {
    n = "EXTERNAL_TRACK";
  }

  if (typeof canonicalDeviceName === "function") {
    return canonicalDeviceName(n) || "UNKNOWN_DEVICE";
  }

  return n || "UNKNOWN_DEVICE";
}

/**
 * Returns the canonical name displayed on a fleet card.
 */
function deviceDisplayName(device) {
  return normalizeDeviceFamilyName(
    device.display_name ||
    device.device_family ||
    device.device_name ||
    device.device
  );
}

/**
 * Returns the canonical identifier used in a device-page URL.
 */
function deviceOpenName(device) {
  return normalizeDeviceFamilyName(
    device.device_family ||
    device.display_name ||
    device.open_name ||
    device.device_name ||
    device.device
  );
}

/**
 * Merges backend and HMI inventories into one deduplicated fleet model.
 */
function buildDashboardDevices(statusDevices, hmiDevices) {
  const allStatusDevices = [
    ...(Array.isArray(statusDevices) ? statusDevices : []),
    ...(Array.isArray(hmiDevices) ? hmiDevices : [])
  ];

  const byDeviceFamily = new Map();

  allStatusDevices.forEach(d => {
    const originalName =
      d.device_name ||
      d.device ||
      "";

    const familyName =
      normalizeDeviceFamilyName(originalName);

    if (!familyName) {
      return;
    }

    const existing =
      byDeviceFamily.get(familyName);

    const currentStatus =
      String(d.status || "").toLowerCase();

    const existingStatus =
      String(existing?.status || "").toLowerCase();

    const currentRows =
      Number(d.rows || d.packet_count || d.packets || 0);

    const existingRows =
      Number(existing?.rows || existing?.packet_count || existing?.packets || 0);

    const shouldReplace =
      !existing ||
      currentStatus === "online" ||
      (
        existingStatus !== "online" &&
        parseTs(d.last_seen || "") >
          parseTs(existing.last_seen || "")
      ) ||
      (
        currentStatus === existingStatus &&
        currentRows > existingRows
      );

    if (shouldReplace) {
      byDeviceFamily.set(familyName, {
        ...d,
        display_name: familyName,
        device_family: familyName,
        open_name: familyName,
        rows: Math.max(currentRows, existingRows)
      });
    }
  });

  return [...byDeviceFamily.values()];
}

/**
 * Coalesces fleet-matrix changes into one animation-frame render.
 */
function scheduleDeviceMatrixRender() {
  if (dashboardDeviceRenderScheduled) {
    return;
  }

  dashboardDeviceRenderScheduled = true;

  setTimeout(() => {
    dashboardDeviceRenderScheduled = false;

    renderDeviceStatusSummary(
      lastDashboardDevices,
      App.rows || dashboardChartRows || []
    );

    renderDevices(lastDashboardDevices);
  }, 250);
}

/**
 * Checks whether a device heartbeat remains within the live threshold.
 */
function dashboardDeviceHeartbeatFresh(device, maxAgeMs = 15000) {
  const name =
    normalizeDeviceFamilyName(device);
  const last =
    dashboardLiveHeartbeat[name];

  return Number.isFinite(last) &&
    Date.now() - last <= maxAgeMs;
}

/**
 * Applies incoming telemetry heartbeats to the current fleet model.
 */
function updateLiveDeviceMatrix(rows) {
  const incoming =
    Array.isArray(rows)
      ? rows
      : [];

  if (!incoming.length) {
    return;
  }

  const byDevice =
    new Map(
      lastDashboardDevices.map(d => [
        normalizeDeviceFamilyName(
          d.device_family ||
          d.display_name ||
          d.device_name ||
          d.device
        ),
        { ...d }
      ])
    );

  incoming.forEach(row => {
    const familyName =
      normalizeDeviceFamilyName(
        typeof canonicalDeviceForTelemetry === "function"
          ? canonicalDeviceForTelemetry(row)
          : row.device_name || row.device || row.subdevice_name || row.subdevice
      );

    if (!familyName || familyName === "UNKNOWN") {
      return;
    }

    const ts =
      row.server_rx_ts ||
      row.server_timestamp ||
      row.timestamp ||
      row.packet_ts ||
      new Date().toISOString();

    const existing =
      byDevice.get(familyName) || {};

    dashboardLiveHeartbeat[familyName] =
      Date.now();

    const nextRows =
      Math.max(
        Number(existing.rows || 0),
        0
      ) + 1;

    const merged = {
      ...existing,
      device: existing.device || familyName,
      device_name: existing.device_name || familyName,
      display_name: familyName,
      device_family: familyName,
      open_name: familyName,
      last_seen: ts,
      rows: nextRows,
      anomalies:
        Number(existing.anomalies || 0) +
        (row.anomaly ? 1 : 0),
      status: "online"
    };

    byDevice.set(familyName, merged);

    aiState.deviceHealth[familyName] =
      calculateDeviceHealth(
        familyName,
        App.rows && App.rows.length ? App.rows : incoming,
        "online",
        merged
      );
  });

  lastDashboardDevices =
    [...byDevice.values()].sort((a, b) =>
      deviceDisplayName(a).localeCompare(deviceDisplayName(b))
    );

  scheduleDeviceMatrixRender();
}

/**
 * Refreshes device health while preventing overlapping requests.
 */
async function refreshDashboardDeviceStatus() {
  if (dashboardStatusRefreshInFlight) {
    return;
  }

  dashboardStatusRefreshInFlight = true;

  try {
  const db = currentDb();

  const [statusDevices, hmiDevices] =
    await Promise.all([
      api(
        "/api/devices/status?db=" +
        encodeURIComponent(db)
      ),
      api(
        "/api/hmi/devices?db=" +
        encodeURIComponent(db)
      )
    ]);

  const devs =
    buildDashboardDevices(statusDevices, hmiDevices);

  // Capture the current browser time in `now`.
  const now = Date.now();

  devs.forEach(d => {
    const name =
      deviceDisplayName(d);

    if (dashboardDeviceHeartbeatFresh(name)) {
      d.status = "online";
      d.last_seen =
        d.last_seen || new Date().toISOString();
    }

    const ts = parseTs(d.last_seen || "");

    if (
      Number.isFinite(ts) &&
      now - ts > 60000 &&
      !dashboardDeviceHeartbeatFresh(name)
    ) {
      d.status = "offline";
    }

    aiState.deviceHealth[name] =
      calculateDeviceHealth(
        name,
        App.rows || dashboardChartRows || [],
        d.status,
        d
      );
  });

  lastDashboardDevices =
    devs.map(d => ({ ...d }));

  renderDeviceStatusSummary(
    devs,
    App.rows || dashboardChartRows || []
  );

  renderDevices(devs);
  } finally {
    dashboardStatusRefreshInFlight = false;
  }
}
/*
--------------------------------------------------
DEVICES
--------------------------------------------------
*/

/**
 * Builds escaped, actionable fleet cards for all known devices.
 */
function renderDevices(devs) {

  if (!Array.isArray(devs) || devs.length === 0) {
    $("devices").innerHTML = `
      <div class="card">
        <h3>No devices available</h3>
        <p class="muted">
          Device status is unavailable. Confirm the backend is running and the selected database exists.
        </p>
      </div>
    `;
    return;
  }

  $("devices").innerHTML = devs.map(d => {

    const displayName =
      deviceDisplayName(d);

    const openName =
      deviceOpenName(d);

    const health =
      aiState.deviceHealth[displayName] ??
      aiState.deviceHealth[d.device_name] ??
      aiState.deviceHealth[d.device];

    return `

      <div class="
        card
        device-card
        ${esc(String(d.status || "").toLowerCase())}
      ">

        <h3>
          ${esc(displayName)}
        </h3>

        <p>
          <span class="status">
            ${esc(d.status || "-")}
          </span>
        </p>

        <p class="muted">
          Last:
          ${esc(d.last_seen || "-")}
        </p>

        <div class="deviceMetrics">

          <span>
            Health:
            ${health == null ? "N/A" : health + "%"}
          </span>

          <span>
            Alerts:
            ${esc(d.anomalies || 0)}
          </span>

        </div>

        <button
          class="btn"
          onclick="openDevice('${esc(openName)}')"
        >
          Open Device Page
        </button>

      </div>
    `;
  }).join("");
}

/*
--------------------------------------------------
TABLE
--------------------------------------------------
*/

/**
 * Renders the bounded live telemetry table and anomaly details.
 */
function renderTable(rows) {

  if (!Array.isArray(rows) || rows.length === 0) {
    $("liveBody").innerHTML = `
      <tr>
        <td colspan="12" class="muted">
          No telemetry rows in the selected live range. Start the backend and transmitter, or choose a wider range.
        </td>
      </tr>
    `;
    return;
  }

  $("liveBody").innerHTML = rows.map(r => `

    <tr>

      <td>
        ${esc(
          r.server_rx_ts ||
          r.timestamp ||
          ""
        )}
      </td>

      <td>
        ${esc(r.device_ts || "")}
      </td>

      <td>
        ${esc(r.packet_ts || "")}
      </td>

      <td>
        ${esc(r.latency_ms ?? "")}
      </td>

      <td>
        ${esc(
          r.device_name ||
          r.device ||
          ""
        )}
      </td>

      <td>
        ${esc(
          r.subdevice_name ||
          r.subdevice ||
          ""
        )}
      </td>

      <td>
        ${esc(
          r.process_name ||
          r.process ||
          ""
        )}
      </td>

      <td>
        ${esc(
          r.subprocess_name ||
          r.subprocess ||
          ""
        )}
      </td>

      <td>
        ${esc(
          r.key ||
          r.value_key ||
          ""
        )}
      </td>

      <td>

        ${esc(

          r.value_type === "text"

            ? (r.value_text || "")

            : (

                r.value_num ??

                r.value ??

                ""

              )

        )}

      </td>

      <td>

        ${r.anomaly ? "YES" : "NO"}

      </td>

      <td>

        ${esc(r.reason || "")}

      </td>

    </tr>

  `).join("");
}

/*
--------------------------------------------------
BUILD SERIES
--------------------------------------------------
This function converts telemetry database rows into graph series.

Main fixes:
1. Works for all devices, not only IMU.
2. Includes external tracker / tracker / main display data.
3. Removes noisy fields like timestamp, status, heartbeat, IDs.
4. Limits graph lines so the chart does not become crowded.
5. Groups devices into two charts:
   - Motion / Operator Systems
   - Platform / Control Systems
--------------------------------------------------
*/

/**
 * Normalizes graph labels for reliable comparison and grouping.
 */
function normalizeGraphText(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_")
    .replace(/-/g, "_");
}

/**
 * Extracts the best available device identity from a telemetry row.
 */
function getRowDeviceName(row) {
  return normalizeDeviceFamilyName(
    row.device_name ||
    row.device ||
    row.subdevice_name ||
    row.subdevice ||
    "UNKNOWN_DEVICE"
  );
}

/**
 * Extracts the process identity from a telemetry row.
 */
function getRowProcessName(row) {
  return (
    row.process_name ||
    row.process ||
    row.subprocess_name ||
    row.subprocess ||
    ""
  );
}

/**
 * Extracts the measured field name from a telemetry row.
 */
function getRowMetricName(row) {
  return String(
    row.key ||
    row.value_key ||
    row.metric ||
    row.name ||
    ""
  ).trim();
}

/**
 * Returns a finite numeric measurement when one is available.
 */
function getRowNumericValue(row) {
  const value =
    row.value_num ??
    row.value ??
    row.numeric_value;

  const numberValue = Number(value);

  return Number.isFinite(numberValue)
    ? numberValue
    : null;
}

/**
 * Selects and normalizes the preferred timestamp for a telemetry row.
 */
function getRowTimestamp(row) {
  return (
    row.server_rx_ts ||
    row.server_timestamp ||
    row.timestamp ||
    row.packet_ts ||
    row.device_ts ||
    ""
  );
}

/**
 * Identifies counters and metadata that would obscure useful graph signals.
 */
function isNoisyGraphMetric(metricName) {
  const key = String(metricName || "")
    .toLowerCase()
    .trim();

  if (!key) {
    return true;
  }

  if (
    key === "seq" ||
    key === "id" ||
    key === "uid" ||
    key === "uuid" ||
    key === "version" ||
    key === "heartbeat" ||
    key === "online" ||
    key === "status" ||
    key === "state" ||
    key === "mode" ||
    key === "source" ||
    key === "src" ||
    key === "name" ||
    key === "device" ||
    key === "process"
  ) {
    return true;
  }

  return (
    key.includes("timestamp") ||
    key.includes("_ts") ||
    key.includes("time_utc") ||
    key.includes("date") ||
    key.includes("fault") ||
    key.includes("status") ||
    key.includes("heartbeat") ||
    key.includes("uptime") ||
    key.includes("alive") ||
    key.includes("connected") ||
    key.includes("enable") ||
    key.includes("relay") ||
    key.includes("launch") ||
    key.includes("cached") ||
    key.includes("snapshot") ||
    key.includes("recording") ||
    key.includes("counter") ||
    key.includes("count") ||
    key.includes("_id") ||
    key.endsWith("_raw") ||
    key.endsWith("_bits")
  );
}

/**
 * Determines whether a row belongs in the primary live graphs.
 */
function isImportantGraphMetric(row) {
  const metric = getRowMetricName(row).toLowerCase();

  const device = normalizeGraphText(
    getRowDeviceName(row)
  );

  const process = normalizeGraphText(
    getRowProcessName(row)
  );

  const value = getRowNumericValue(row);

  if (value === null) {
    return false;
  }

  if (isNoisyGraphMetric(metric)) {
    return false;
  }

  /*
  Remove very huge values from normal graphs.
  This avoids timestamp-like values or raw counters destroying the chart scale.
  Tracker position values can still be allowed if they are useful.
  */
  if (
    Math.abs(value) > 10000000 &&
    !device.includes("TRACK") &&
    !process.includes("TRACK")
  ) {
    return false;
  }

  /*
  Preferred field names.
  These are useful for IMU, tracker, camera, drive, control,
  operator, and platform telemetry.
  */
  const preferredKeywords = [
    "roll",
    "pitch",
    "yaw",
    "heading",
    "azimuth",
    "elevation",
    "range",
    "distance",
    "confidence",
    "quality",
    "pan",
    "tilt",
    "angle",
    "pos",
    "position",
    "vel",
    "velocity",
    "speed",
    "acc",
    "gyro",
    "mag",
    "lat",
    "lon",
    "long",
    "alt",
    "height",
    "x",
    "y",
    "z",
    "rpm",
    "current",
    "volt",
    "voltage",
    "temperature",
    "temp",
    "pressure",
    "torque"
  ];

  if (
    preferredKeywords.some(word =>
      metric === word || metric.includes(word)
    )
  ) {
    return true;
  }

  /*
  Important fix:
  Even if the key is not in the preferred list, still allow numeric
  values from tracker/external tracker/main display/drive/LCU/IMU/camera.
  This prevents external tracker data from disappearing from graphs.
  */
  if (
    device.includes("TRACK") ||
    process.includes("TRACK") ||
    device.includes("EXTERNAL") ||
    process.includes("EXTERNAL") ||
    device.includes("MAIN_DISPLAY") ||
    device.includes("MAINDISPLAY") ||
    process.includes("MAIN_DISPLAY") ||
    process.includes("MAINDISPLAY") ||
    device.includes("DRIVE") ||
    process.includes("DRIVE") ||
    device.includes("LCU") ||
    process.includes("LCU") ||
    device.includes("IMU") ||
    process.includes("IMU") ||
    device.includes("CAMERA") ||
    process.includes("CAMERA") ||
    device.includes("JOYSTICK") ||
    process.includes("JOYSTICK") ||
    device.includes("BUTTON") ||
    process.includes("BUTTON")
  ) {
    return true;
  }

  return false;
}

/**
 * Assigns a series to the motion/operator or platform/control chart.
 */
function graphGroupForSeries(label, firstPoint) {
  const text = normalizeGraphText(
    label + " " +
    (firstPoint?.device || "") + " " +
    (firstPoint?.process || "") + " " +
    (firstPoint?.key || "")
  );

  /*
  Graph A:
  Motion / Operator Systems
  This should show moving sensors and operator-related telemetry.
  */
  if (
    text.includes("IMU") ||
    text.includes("CAMERA") ||
    text.includes("JOYSTICK") ||
    text.includes("BUTTON") ||
    text.includes("OPERATOR") ||
    text.includes("MOTION")
  ) {
    return "A";
  }

  /*
  Graph B:
  Platform / Control Systems
  This should show tracker, external tracker, display, drive, LCU, WCS,
  and control/platform telemetry.
  */
  if (
    text.includes("TRACK") ||
    text.includes("EXTERNAL") ||
    text.includes("MAIN_DISPLAY") ||
    text.includes("MAINDISPLAY") ||
    text.includes("DRIVE") ||
    text.includes("LCU") ||
    text.includes("WCS") ||
    text.includes("CCE") ||
    text.includes("CONTROL") ||
    text.includes("PLATFORM")
  ) {
    return "B";
  }

  /*
  Unknown numeric telemetry should still be shown somewhere.
  Putting it in Graph B is safer because it may be platform/control data.
  */
  return "B";
}

/**
 * Groups filtered numeric rows into bounded timestamped graph series.
 */
function buildSeries(rows) {
  const map = {};
  const latest = {};
  const score = {};

  (rows || []).forEach(row => {
    if (!isImportantGraphMetric(row)) {
      return;
    }

    const value = getRowNumericValue(row);

    if (value === null) {
      return;
    }

    const metricName =
      getRowMetricName(row) || "value";

    const deviceName =
      getRowDeviceName(row);

    const processName =
      getRowProcessName(row);

    const timestamp =
      getRowTimestamp(row);

    const x =
      new Date(
        String(timestamp).replace(" ", "T")
      ).getTime();

    if (!Number.isFinite(x)) {
      return;
    }

    const label =
      deviceName + " / " + metricName;

    if (!map[label]) {
      map[label] = [];
      score[label] = 0;
    }

    map[label].push({
      x,
      y: value,
      key: metricName,
      process: processName,
      device: deviceName,
      timestamp,
      unit: row.unit || row.value_unit || "",
      status: row.status || row.state || row.health || ""
    });

    latest[label] = Math.max(
      latest[label] || 0,
      x
    );

    /*
    Score helps important tracker/external tracker/position/angle
    fields stay visible when there are too many graph lines.
    */
    const labelText =
      normalizeGraphText(label + " " + processName);

    if (labelText.includes("EXTERNAL")) {
      score[label] += 50;
    }

    if (labelText.includes("TRACK")) {
      score[label] += 45;
    }

    if (labelText.includes("MAIN_DISPLAY") || labelText.includes("MAINDISPLAY")) {
      score[label] += 35;
    }

    if (
      labelText.includes("POS") ||
      labelText.includes("PAN") ||
      labelText.includes("TILT") ||
      labelText.includes("AZIMUTH") ||
      labelText.includes("ELEVATION") ||
      labelText.includes("RANGE") ||
      labelText.includes("ROLL") ||
      labelText.includes("PITCH") ||
      labelText.includes("YAW")
    ) {
      score[label] += 25;
    }
  });

  Object.keys(map).forEach(label => {
    map[label].sort((a, b) => a.x - b.x);

    const unique = [];
    const seen = new Set();

    map[label].forEach(point => {
      const id =
        point.x + "_" +
        point.y + "_" +
        point.key;

      if (!seen.has(id)) {
        seen.add(id);
        unique.push(point);
      }
    });

    /*
    Keep latest points only.
    This keeps the graph fast and readable.
    */
    map[label] = unique.slice(-80);

    /*
    Very flat series with only one repeated value are not helpful.
    But keep them if they are tracker/external tracker because
    sometimes tracker values may update slowly.
    */
    const differentValues =
      new Set(
        map[label].map(p => String(p.y))
      ).size;

    const keepFlat =
      normalizeGraphText(label).includes("TRACK") ||
      normalizeGraphText(label).includes("EXTERNAL");

    if (
      map[label].length < 1 ||
      (differentValues <= 1 && !keepFlat)
    ) {
      delete map[label];
      delete latest[label];
      delete score[label];
    }
  });

  return Object.keys(map)
    .sort((a, b) => {
      const scoreDiff =
        (score[b] || 0) - (score[a] || 0);

      if (scoreDiff !== 0) {
        return scoreDiff;
      }

      return (latest[b] || 0) - (latest[a] || 0);
    })
    .map(label => ({
      label,
      data: map[label],
      group:
        graphGroupForSeries(
          label,
          map[label][0]
        )
    }));
}

const dashboardRangeMilliseconds = Object.freeze({
  "5s": 5 * 1000,
  "30s": 30 * 1000,
  "1m": 60 * 1000,
  "5m": 5 * 60 * 1000,
  "10m": 10 * 60 * 1000,
  "30m": 30 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000
});

const dashboardRangeLabels = Object.freeze({
  "5s": "5 seconds",
  "30s": "30 seconds",
  "1m": "1 minute",
  "5m": "5 minutes",
  "10m": "10 minutes",
  "30m": "30 minutes",
  "1h": "1 hour",
  "6h": "6 hours",
  "24h": "24 hours"
});

/**
 * Returns the rolling range selected for both dashboard charts.
 */
function selectedDashboardGraphRange() {
  return $("graphRange")?.value || $("range")?.value || "5s";
}

/**
 * Filters accumulated rows to the selected rolling window.
 */
function rowsWithinDashboardGraphRange(rows) {
  const rangeMs =
    dashboardRangeMilliseconds[selectedDashboardGraphRange()] ||
    dashboardRangeMilliseconds["5s"];
  const newestTimestamp = (rows || []).reduce((latest, row) => {
    const timestamp = new Date(
      String(getRowTimestamp(row)).replace(" ", "T")
    ).getTime();
    return Number.isFinite(timestamp) ? Math.max(latest, timestamp) : latest;
  }, 0);
  // Capture the current browser time in `rangeEnd`.
  const rangeEnd = newestTimestamp || Date.now();
  const cutoff = rangeEnd - rangeMs;

  return (rows || []).filter(row => {
    const timestamp = new Date(
      String(getRowTimestamp(row)).replace(" ", "T")
    ).getTime();
    return Number.isFinite(timestamp) &&
      timestamp >= cutoff &&
      timestamp <= rangeEnd;
  });
}

/**
 * Updates the accessible label describing the active graph range.
 */
function updateDashboardGraphRangeStatus() {
  const range = selectedDashboardGraphRange();
  const status = $("graphRangeStatus");
  if (status) {
    status.textContent =
      "Showing " + (dashboardRangeLabels[range] || range);
  }
}

/*
--------------------------------------------------
LEGEND
--------------------------------------------------
This legend is limited so the dashboard does not look messy.
--------------------------------------------------
*/

/**
 * Renders an escaped compact legend for a chart's visible series.
 */
function renderLegend(id, series) {
  const colors = [
    "#60a5fa",
    "#34d399",
    "#fbbf24",
    "#f472b6",
    "#a78bfa",
    "#fb7185",
    "#22d3ee",
    "#fb923c",
    "#e879f9",
    "#facc15"
  ];

  const el = $(id);

  if (!el) {
    return;
  }

  if (!series || series.length === 0) {
    el.innerHTML =
      '<p class="muted">No graph data available for this group.</p>';
    return;
  }

  const visibleSeries =
    series.slice(0, 18);

  const hiddenCount =
    Math.max(0, series.length - visibleSeries.length);

  el.innerHTML =
    visibleSeries.map((s, i) => `
      <span class="legendItem" title="${esc(s.label)}">
        <span
          class="legendColor"
          style="background:${colors[i % colors.length]}"
        ></span>
        ${esc(s.label)}
      </span>
    `).join("") +
    (
      hiddenCount
        ? `<span class="legendItem muted">+${hiddenCount} more</span>`
        : ""
    );
}

/*
--------------------------------------------------
MAIN CHART
--------------------------------------------------
This function sends the selected series to both dashboard graphs.
--------------------------------------------------
*/

/**
 * Builds and draws both synchronized dashboard graph groups.
 */
function renderMainChart(rows, title) {
  const allSeries =
    buildSeries(rowsWithinDashboardGraphRange(rows || []));

  const graphA =
    allSeries.filter(s => s.group === "A");

  const graphB =
    allSeries.filter(s => s.group === "B");

  /*
  Limit number of lines to keep charts readable.
  External tracker/tracker has high score inside buildSeries,
  so it should stay visible first.
  */
  const finalA =
    graphA.slice(0, 18);

  const finalB =
    graphB.slice(0, 18);

  renderLegend(
    "multiLegendA",
    finalA
  );

  renderLegend(
    "multiLegendB",
    finalB
  );

  drawLineChart(
    $("multiChartA"),
    finalA,
    "Motion / Operator Systems"
  );

  drawLineChart(
    $("multiChartB"),
    finalB,
    "Platform / Control Systems"
  );
}

/**
 * Merges live rows into bounded graph history and redraws the charts.
 */
function updateDashboardLiveChart(rows) {

  const incoming =
    flattenScadaRows(rows);

  if (!incoming.length) {
    return;
  }

  incoming.forEach(row => {

    dashboardChartRows.push({

      ...row,

      server_rx_ts:
        row.server_rx_ts ||
        row.server_timestamp ||
        row.timestamp

    });

  });

  while (
    dashboardChartRows.length > 2000
  ) {
    dashboardChartRows.shift();
  }

  scheduleDashboardLiveRefresh();
}

/**
 * Coalesces rapid live updates into one animation-frame refresh.
 */
function scheduleDashboardLiveRefresh() {
  if (dashboardLiveUpdateScheduled) {
    return;
  }

  dashboardLiveUpdateScheduled = true;

  setTimeout(() => {
    dashboardLiveUpdateScheduled = false;

    if (dashboardChartRows.length > 0) {
      renderMainChart(
        dashboardChartRows,
        dashboardChartTitle
      );
    }

    if (dashboardPendingSummary) {
      renderSummary(dashboardPendingSummary);
      dashboardPendingSummary = null;
    }

    liveTableRows = liveTableRows.slice(0, 50);
    renderTable(liveTableRows);
  }, 1000);
}
/**
 * Calculates device health from recency, anomalies, loss, and drift.
 */
function calculateDeviceHealth(
  device,
  rows,
  status = "online",
  meta = {}
) {

  const normalizedStatus =
    String(status || "").toLowerCase();

  if (normalizedStatus === "offline") {
    return 0;
  }

const relevant =
  rows.filter(r =>
    normalizeDeviceFamilyName(
      r.device ||
      r.device_name
    ) === normalizeDeviceFamilyName(device)
  );

  let score =
    normalizedStatus === "warning"
      ? 72
      : 100;

  const latestFromRows =
    relevant.length
      ? relevant.reduce((a,b)=>{

    const ta = parseTs(
      a.server_rx_ts ||
      a.timestamp ||
      ""
    );

    const tb = parseTs(
      b.server_rx_ts ||
      b.timestamp ||
      ""
    );

    return tb > ta ? b : a;

  })
      : null;

  const latestTs = parseTs(
    latestFromRows?.server_rx_ts ||
    latestFromRows?.timestamp ||
    meta.last_seen ||
    ""
  );

  const ageSec =
    Number.isFinite(latestTs)
      ? (Date.now() - latestTs) / 1000
      : 999;

if (ageSec > 15) score -= 10;
if (ageSec > 60) score -= 20;
if (ageSec > 180) score -= 35;

  const anomalies =
    Number(meta.anomalies || 0) +
    relevant.filter(r => r.anomaly).length;

  const totalRows =
    Math.max(
      Number(meta.rows || 0),
      relevant.length
    );

  const anomalyRate =
    totalRows > 0
      ? anomalies / totalRows
      : 0;

  score -= Math.min(45, anomalies * 2);
  score -= Math.min(35, anomalyRate * 100);

  if (totalRows === 0) {
    score -= 35;
  } else if (totalRows < 10) {
    score -= 12;
  }

  score =
    Math.max(
      0,
      Math.min(100, score)
    );

  return Math.round(score);
}
/**
 * Adds a normalized, deduplicated anomaly alert to the supplied collection.
 */
function pushAlert(list, alert) {

  if (!alert) {
    return;
  }

  const severity =
    alert.severity || "info";

  const text =
    alert.text || "";

  const key =
    severity + "_" + text;

  if (
    aiState.alertCache[key]
  ) {
    return;
  }

  aiState.alertCache[key] =
    Date.now();

  list.push({
    severity,
    text
  });
}
/*
--------------------------------------------------
LIVE REFRESH
--------------------------------------------------
*/

/**
 * Runs one guarded dashboard data refresh and applies only current results.
 */
async function refresh() {
  if (replayMode) {
  return;
}

  if (dashboardBusy || searchMode) {
    return;
  }

  dashboardBusy = true;

  try {

    const db =
      currentDb();

    const range =
      $("range").value;

    App.db = db;

    App.range = range;

    const [statusDevices, hmiDevices, initialRows] =
      await Promise.all([

        api(

          "/api/devices/status?db=" +

          encodeURIComponent(db)

        ),

        api(

          "/api/hmi/devices?db=" +

          encodeURIComponent(db)

        ),

        api(

          "/api/all?db=" +

          encodeURIComponent(db) +

          "&range=" +

          encodeURIComponent(range)

        )

      ]);
const devs =
  buildDashboardDevices(statusDevices, hmiDevices);
const onlineDeviceNames = new Set(
  devs
    .filter(d => String(d.status || "").toLowerCase() === "online")
    .map(d => deviceDisplayName(d))
);
let rows = Array.isArray(initialRows)
  ? initialRows
  : [];
lastDashboardDevices =
  devs.map(d => ({ ...d }));

/* An empty live/range query must stay empty. Falling back to 24 hours made
   stopped software look current even though its device status was offline. */
App.rows = rows;
liveRowCounter =
  rows.length;
dashboardChartRows =
  rows.slice(-500).map(r => ({
    ...r,
    server_rx_ts:
      r.server_rx_ts ||
      r.timestamp
  }));

    const s = {

      row_count:
        liveRowCounter,

      device_count:
        devs.length,

      metric_count:
        new Set(
          rows.map(r => r.key || r.value_key)
        ).size,

      first_timestamp:
        rows.length

          ? (

              rows[rows.length - 1]
                .server_rx_ts ||

              rows[rows.length - 1]
                .timestamp

            )

          : "-",

      last_timestamp:
        rows.length

          ? (

              rows[0]
                .server_rx_ts ||

              rows[0]
                .timestamp

            )

          : "-"

    };

    renderSummary(s);
// Capture the current browser time in `now`.
const now = Date.now();

devs.forEach(d => {

  const ts = parseTs(d.last_seen || "");

  if (
    Number.isFinite(ts) &&
now - ts > 60000  ) {

    d.status = "offline";

  }

});
   
  /*
--------------------------------------------------
GLOBAL STATUS
--------------------------------------------------
*/

renderDeviceStatusSummary(devs, rows);

Object.keys(
  aiState.alertCache
).forEach(k => {

  if (
    now -
    aiState.alertCache[k]
    > 15000
  ) {
    delete aiState.alertCache[k];
  }

});
    /*
--------------------------------------------------
AI ANOMALY DETECTION
--------------------------------------------------
*/

const aiAlerts = [];

const deviceScores = {};

for (const d of devs) {
const deviceName =
  deviceDisplayName(d);

const score =
  calculateDeviceHealth(
    deviceName,
    rows,
    d.status,
    d
  );
    aiState.deviceHealth[
  deviceName
] = score;

  deviceScores[deviceName] =
    score;

  /*
  ------------------------------------------
  CRITICAL FAILURE
  ------------------------------------------
  */

  if (score < 30) {

    pushAlert(
  aiAlerts,{

      severity: "critical",

      text:
        `${deviceName} operational failure risk detected`
    });
  }

  /*
  ------------------------------------------
  DEGRADED
  ------------------------------------------
  */

  else if (score < 60) {

    pushAlert(
  aiAlerts,{

      severity: "warning",

      text:
        `${deviceName} telemetry instability increasing`
    });
  }

  /*
  ------------------------------------------
  OFFLINE
  ------------------------------------------
  */

  if (
    String(d.status)
      .toLowerCase() === "offline"
  ) {

    pushAlert(
  aiAlerts,{

      severity: "critical",

      text:
        `${deviceName} disconnected from telemetry network`
    });
  }
  const lastSeenTs =
    parseTs(d.last_seen || "");

if (
  Number.isFinite(lastSeenTs)
) {

  const age =
    (
      Date.now() -
      lastSeenTs
    ) / 1000;

  if (age > 60) {

    pushAlert(
      aiAlerts,
      {
        severity: "critical",
        text:
          `${deviceName} telemetry timeout (${Math.round(age)} sec)`
      }
    );

  }

}
}

/*
----------------------------------------------
REAL-TIME TELEMETRY ANALYSIS
----------------------------------------------
*/

const analysisRows =
  rows.slice().sort((a, b) =>
    parseTs(
      a.server_rx_ts ||
      a.timestamp
    ) -
    parseTs(
      b.server_rx_ts ||
      b.timestamp
    )
  );

for (const r of analysisRows) {

  const device =
  r.device ||
  r.device_name ||
  "UNKNOWN";

const metric =
  String(
    r.key ||
    ""
  ).toLowerCase();

const value =
  Number(
    r.value ??
    r.value_num
  );

if (
  !Number.isFinite(value)
) {
  continue;
}

const stateKey =
  device + "_" + metric;

const rowTs =
  parseTs(
    r.server_rx_ts ||
    r.timestamp
  );

if (
  !aiState.deviceStats[stateKey]
) {

  aiState.deviceStats[stateKey] = {

    lastValue: value,

    sameCount: 0,

    lastTimestamp: 0

  };

}

const state =
  aiState.deviceStats[stateKey];

if (
  Number.isFinite(rowTs) &&
  rowTs <= state.lastTimestamp
) {
  continue;
}

const delta =
  Math.abs(
    value -
    state.lastValue
  );

const ignoredMetric =

  metric.includes("status") ||
  metric.includes("fault") ||
  metric.includes("heartbeat") ||
  metric.includes("uptime") ||
  metric.includes("last_update") ||
  metric.includes("_ms") ||
  metric.includes("recording") ||
  metric.includes("src") ||
  metric.includes("name") ||
  metric.includes("connected") ||
  metric.includes("_id") ||
  metric.includes("seq") ||
  metric.includes("version") ||
  metric.includes("enable") ||
  metric.includes("alive");

if (!ignoredMetric) {

  /*
  SENSOR STUCK
  */

  if (delta < 0.0001) {

    state.sameCount++;

    if (
      state.sameCount > 50
    ) {

      pushAlert(
        aiAlerts,
        {
          severity: "warning",

          text:
            `${device} sensor ${metric} appears frozen`
        }
      );

    }

  } else {

    state.sameCount = 0;

  }

  /*
  EXTREME SPIKE
  */

  if (
    state.lastValue !== undefined
  ) {

    const ratio =

      Math.abs(value) /
      Math.max(
        1,
        Math.abs(
          state.lastValue
        )
      );

    const absoluteDelta =
      Math.abs(value - state.lastValue);

    if (
      Math.abs(state.lastValue) > 1 &&
      ratio > 5 &&
      absoluteDelta > 25
    ) {

      pushAlert(
        aiAlerts,
        {
          severity: "critical",

          text:
            `${device} abnormal spike detected on ${metric}`
        }
      );

    }

  }

}

state.lastValue = value;
state.lastTimestamp =
  Number.isFinite(rowTs)
    ? rowTs
    : Date.now();

if (r.anomaly) {

  pushAlert(
    aiAlerts,
    {
      severity: "critical",

      text:
        `${device} anomaly flag received`
    }
  );

}
}

const topAlerts =
  aiAlerts.slice(0, 6);

$("aiAlerts").innerHTML = topAlerts.length

? topAlerts.map(a => `

    <div class="aiAlert ${a.severity}">

      <div class="aiPulse"></div>

      <div>

        <h3>
          ${a.severity.toUpperCase()}
        </h3>

        <p>
          ${esc(a.text)}
        </p>

      </div>

    </div>

  `).join("")

: `

  <div class="aiAlert healthy">

    <div class="aiPulse"></div>

    <div>

      <h3>
        SYSTEM NORMAL
      </h3>

      <p>
        No suspicious telemetry patterns detected
      </p>

    </div>

  </div>
`;
renderDevices(devs);
   liveTableRows =
  rows.slice(0,50);

renderTable(
  liveTableRows
);

renderMainChart(
  rows,
  rows.length > 0
    ? "Live Telemetry"
    : "No live telemetry in selected range"
);

  } catch (e) {

    console.error(
      "Dashboard refresh failed:",
      e
    );

  } finally {

    dashboardBusy = false;
  }
}

/*
--------------------------------------------------
SEARCH
--------------------------------------------------
*/

/**
 * Executes the operator's telemetry query and enters search mode.
 */
async function doSearch() {

  const q =
    $("search").value.trim();

  const db =
    currentDb();

  if (!q) {

    searchMode = false;

    await refresh();

    return;
  }

  searchMode = true;

  const rows = await api(

    "/api/search?db=" +

    encodeURIComponent(db) +

    "&q=" +

    encodeURIComponent(q)

  );

  renderTable(
    rows.slice(0, 50)
  );

  renderMainChart(
    rows,
    "Search: " + q
  );
}

/*
--------------------------------------------------
CLEAR SEARCH
--------------------------------------------------
*/

/**
 * Clears the query and restores the normal live dashboard.
 */
async function clearSearch() {

  $("search").value = "";

  searchMode = false;

  await refresh();
}
/**
 * Loads historical rows and initializes ordered replay playback.
 */
async function startReplay() {

  replayMode = true;

  replayPaused = false;

  replayIndex = 0;

  $("replayStatus").innerHTML =
    "REPLAY";

  const db = currentDb();

  replayRows = await api(

    "/api/replay?db=" +

    encodeURIComponent(db)
  );

  if (!replayRows.length) {

    alert("No replay data");

    replayMode = false;

    return;
  }

  runReplay();
}

/**
 * Advances replay state while respecting pause and completion conditions.
 */
function runReplay() {

  clearInterval(replayTimer);

  replayTimer = setInterval(() => {

    if (
      replayPaused ||
      !replayMode
    ) {
      return;
    }

    const speed =
      Number(
        $("replaySpeed").value
      ) || 1;

    replayIndex += speed;

    if (
      replayIndex >=
      replayRows.length
    ) {

      stopReplay();

      return;
    }

    const chunk = replayRows.slice(

      Math.max(
        0,
        replayIndex - 100
      ),

      replayIndex
    );

    renderTable(
      chunk.slice(-50)
    );

    renderMainChart(
      chunk,
      "Mission Replay"
    );

    const latest =
      replayRows[replayIndex];

    $("replayTimestamp").innerHTML =

      latest.timestamp ||

      "UNKNOWN";

    $("replaySlider").value =

      Math.floor(

        (
          replayIndex /

          replayRows.length
        ) * 100
      );

  }, 500);
}
/**
 * Stops replay timers and restores non-replay state.
 */
function stopReplay() {

  replayMode = false;

  replayPaused = false;

  clearInterval(replayTimer);

  replayTimer = null;

  $("replayStatus").innerHTML =
    "LIVE";

  $("replayTimestamp").innerHTML =
    "LIVE MODE";

  refresh();
}

/*
--------------------------------------------------
SCADA MESSAGE BATCH TO ROWS
--------------------------------------------------
common.js may send one WebSocket message or a batch of messages.

This function converts both safely into telemetry rows.
Without this, dashboard may treat raw WebSocket packets as table rows,
which can break graph/table updates.
--------------------------------------------------
*/

/**
 * Converts one or more live SCADA messages into normalized rows.
 */
function scadaMessagesToRows(data) {
  const messages =
    Array.isArray(data)
      ? data
      : [data];

  const rows = [];

  messages.forEach(msg => {
    const converted =
      liveRowsFromScadaEvent(msg);

    if (Array.isArray(converted)) {
      rows.push(...converted);
    }
  });

  return rows;
}

/*
--------------------------------------------------
INIT
--------------------------------------------------
*/

/**
 * Initializes controls, data, charts, timers, and the WebSocket subscription.
 */
async function init() {

  await loadDbSelect(
    $("dbSelect")
  );

  /*
  --------------------------------------------
  DATABASE CHANGE
  --------------------------------------------
  */

  $("dbSelect").onchange =
    async () => {

      searchMode = false;

      await refresh();
    };

  /*
  --------------------------------------------
  RANGE CHANGE
  --------------------------------------------
  */

  $("range").onchange =
    async () => {

      searchMode = false;
      if ($("graphRange")) {
        $("graphRange").value = $("range").value;
      }
      updateDashboardGraphRangeStatus();

      await refresh();
    };

  $("graphRange").onchange =
    async () => {

      searchMode = false;
      $("range").value = $("graphRange").value;
      updateDashboardGraphRangeStatus();

      await refresh();
    };

  $("graphRange").value = $("range").value;
  updateDashboardGraphRangeStatus();

  /*
  --------------------------------------------
  SEARCH
  --------------------------------------------
  */

  $("searchBtn").onclick =
    doSearch;

  $("clearBtn").onclick =
    clearSearch;

  $("search").addEventListener(

    "keydown",

    e => {

      if (e.key === "Enter") {

        doSearch();
      }
    }

  );

  /*
  --------------------------------------------
  LIVE SCADA EVENTS
  --------------------------------------------
  */

window.addEventListener("scada:connected", event => {
  const generation =
    Number(event.detail?.generation || 0);

  if (generation && generation !== lastWsGeneration) {
    lastWsGeneration = generation;
    dashboardChartRows.length = 0;
    liveTableRows.length = 0;
    App.rows = [];
    refreshDashboardDeviceStatus().catch(console.warn);
  }
});

window.addEventListener("scada:disconnected", () => {
  scheduleDeviceMatrixRender();
});

onScadaEvent(msg => {

  if (
    searchMode ||
    replayMode
  ) {
    return;
  }

const rows =
  scadaMessagesToRows(msg)
    .slice(-300);

  if (!rows.length) {
    return;
  }

  updateDashboardLiveChart(rows);

/* LIVE SUMMARY UPDATE */

rows.forEach(r => {
liveRowCounter++;
  App.rows.unshift({
    ...r,
    timestamp:
      r.server_rx_ts ||
      r.server_timestamp ||
      r.timestamp
  });

});

if (App.rows.length > 500) {
  App.rows.length = 500;
}

updateLiveDeviceMatrix(rows);

const liveSummary = {
  row_count: liveRowCounter,
  device_count:
    new Set(
      App.rows.map(
        r => normalizeDeviceFamilyName(
          r.device_name || r.device
        )
      )
    ).size,
  metric_count:
    new Set(
      App.rows.map(
        r => r.key || r.value_key
      )
    ).size,
  first_timestamp:
    App.rows.length
      ? (
          App.rows[
            App.rows.length - 1
          ].server_rx_ts ||
          App.rows[
            App.rows.length - 1
          ].timestamp
        )
      : "-",
  last_timestamp:
    App.rows.length
      ? (
          App.rows[0].server_rx_ts ||
          App.rows[0].timestamp
        )
      : "-"
};

  rows.forEach(r => {
    liveTableRows.unshift({
      server_rx_ts:
        r.server_rx_ts ||
        r.server_timestamp ||
        r.timestamp,
      device_name: r.device_name,
      subdevice_name: r.subdevice_name,
      process_name: r.process_name,
      subprocess_name: r.subprocess_name,
      key: r.key,
      value_num: r.value_num,
      value_text: r.value_text,
      value_type: r.value_type,
      anomaly: r.anomaly,
      reason: r.reason
    });
  });

  dashboardPendingSummary = liveSummary;
  if (liveTableRows.length > 50) {
    liveTableRows.length = 50;
  }

  scheduleDashboardLiveRefresh();
});

  initScadaSocket();
if ($("replayStartBtn")) {
  $("replayStartBtn").onclick =
    startReplay;
}

if ($("replayPauseBtn")) {
  $("replayPauseBtn").onclick =
    () => {
      replayPaused = true;
    };
}

if ($("replayResumeBtn")) {
  $("replayResumeBtn").onclick =
    () => {
      replayPaused = false;
    };
}

if ($("replayStopBtn")) {
  $("replayStopBtn").onclick =
    stopReplay;
}
/* FLEET STATUS MATRIX REFRESH */

setInterval(() => {

  if (
    searchMode ||
    replayMode
  ) {
    return;
  }

  /*
  Do not call full refresh() every 5 seconds while live WebSocket is active.

  Reason:
  refresh() calls /api/all again.
  With high-volume UDP data this can reload too many rows repeatedly
  and cause dashboard freeze.

  Live packets are already handled by WebSocket.
  This timer should only mark devices offline when WebSocket becomes stale.
  */
  if (
    App.wsConnected &&
    Date.now() - (App.wsLastMessageAt || 0) < 15000
  ) {
    return;
  }

  refreshDashboardDeviceStatus().catch(err => {
    console.warn(
      "Dashboard device status refresh failed",
      err
    );

    /* Keep the last valid fleet view during a transient API timeout.  Live
       WebSocket packets continue to update it, and a later poll reconciles. */
  });

}, 5000);
  /*
  --------------------------------------------
  INITIAL LOAD
  --------------------------------------------
  */

  await refresh();
}

init().catch(e => {

  alert(

    "Dashboard error: " +

    e.message

  );
}); 
