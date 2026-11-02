/*
 * Historical telemetry and replay controller.
 *
 * Queries bounded server ranges, converts field rows into packet-oriented
 * views, and advances deterministic replay state without modifying persisted
 * data. The busy guard prevents concurrent searches from interleaving output.
 */
// Prevent overlapping historical searches from interleaving their output.
let historyBusy = false;
let historyLoadGeneration = 0;
let historyDeviceLoadGeneration = 0;
// Store the ordered normalized rows available for replay.
let replayRows = [];
let replayIndex = 0;
// Track the number of packets represented by the current result.
let historyPacketCount = 0;

// Hold the scheduled callback responsible for replay advancement.
let replayTimer = null;

// Record whether historical replay is currently running.
let replayPlaying = false;
// Store ordered process states used by the cyclograph visualization.
let cyclographStates = [];

// Track the current visual sweep angle used during replay.
let radarAngle = 0;
// Identify the database currently eligible for live-message merging.
let activeLiveDb = "";

// Track the state currently displayed by the cyclograph.
let activeStateIndex = 0;
// Retain a bounded list of recent replay state changes.
let recentTransitions = [];
// Index active chart data and canvases by device and metric.
const historyChartState = {};
let historyLiveRenderTimer = null;
const pendingHistoryLiveRows = [];

/**
 * Clears data and renderer state that belongs to the previously selected DB.
 */
function clearHistorySelectionState(message = "No history loaded") {
  stopReplay();
  replayRows = [];
  historyPacketCount = 0;
  replayIndex = 0;
  cyclographStates = [];
  activeStateIndex = 0;
  recentTransitions = [];
  pendingHistoryLiveRows.splice(0);

  if (historyLiveRenderTimer) {
    clearTimeout(historyLiveRenderTimer);
    historyLiveRenderTimer = null;
  }

  Object.values(historyChartState).forEach(state => {
    const chart = state?.canvas?.chartInstance;
    if (chart && !chart.destroyed && typeof chart.destroy === "function") {
      chart.destroy();
    }
  });
  Object.keys(historyChartState).forEach(key => delete historyChartState[key]);

  $("historyCharts").innerHTML =
    `<div class="card"><h3>${esc(message)}</h3></div>`;
  $("historyBody").innerHTML = buildHistoryTable([]);
  setText("historyPacketCount", "0 records");
  updateReplayUI();
}

function historyMetricKey(row) {
  return String(row?.key || row?.value_key || row?.field_name || "").trim();
}

function updateHistoryMetricOptions(rows) {
  const select = $("metricSelect");
  if (!select) return "";
  const previous = select.value;
  const metrics = [...new Set((Array.isArray(rows) ? rows : [])
    .map(historyMetricKey).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
  select.innerHTML = '<option value="">All fields</option>' + metrics
    .map(metric => `<option value="${esc(metric)}">${esc(metric)}</option>`)
    .join("");
  select.value = metrics.includes(previous) ? previous : "";
  select.disabled = metrics.length === 0;
  return select.value;
}

function filterHistoryMetric(rows, metric) {
  return metric
    ? rows.filter(row => historyMetricKey(row) === metric)
    : rows;
}

function scheduleHistoryLiveRender(rows) {
  // Append newly received live telemetry rows to the pending History-page queue.
  // Invalid non-array input is treated as empty so it cannot break rendering.
  pendingHistoryLiveRows.push(...(Array.isArray(rows) ? rows : []));
  // Keep the existing 250 ms batch timer when one is already scheduled; this
  // prevents a high-rate WebSocket stream from redrawing the page per packet.
  if (historyLiveRenderTimer) return;

  historyLiveRenderTimer = setTimeout(() => {
    historyLiveRenderTimer = null;
    // Read the device currently selected by the operator on the History page;
    // use an empty value if the dropdown is unavailable or has no selection.
    const selectedDevice = $("deviceSelect")?.value || "";
    // Remove all queued rows, retain only records for the selected device, and
    // convert them to the stable shape used by replay tables and charts.
    const incoming = pendingHistoryLiveRows
      .splice(0)
      .filter(row =>
        sameDeviceName(row.device || row.device_name, selectedDevice)
      )
      .filter(row => !$("metricSelect")?.value ||
        historyMetricKey(row) === $("metricSelect").value)
      .map(normalizeReplayRow);

    // Avoid rebuilding charts and the table when this batch contained no rows
    // for the device the operator is viewing.
    if (!incoming.length) return;

    replayRows = filterRowsBySelectedRange(
      replayRows.concat(incoming)
        .sort((a, b) => parseTs(a.timestamp) - parseTs(b.timestamp))
        .slice(-5000)
    );
    $("historyBody").innerHTML =
      buildHistoryTable(replayRows.slice().reverse().slice(0, 100));
    renderHistoryChartsFromRows(selectedDevice, replayRows);
    buildCyclograph(replayRows);
  }, 250);
}

/**
 * Loads devices available in the selected historical database.
 */
async function loadDevicesForHistory() {
  const db = $("dbSelect").value;
  const generation = ++historyDeviceLoadGeneration;

  if (!db) return;
  $("deviceSelect").disabled = true;
  $("deviceSelect").innerHTML =
    '<option value="">Loading recorded devices...</option>';

  try {
  let devs;
  let usedArchivedDeviceApi = false;
  try {
    devs = await api(
      "/api/history/devices?db=" + encodeURIComponent(db),
      30000
    );
    usedArchivedDeviceApi = true;
  } catch {
    devs = await api(
      "/api/devices/status?db=" + encodeURIComponent(db),
      30000
    );
  }

  devs = Array.isArray(devs) ? devs : [];
  if (
    generation !== historyDeviceLoadGeneration ||
    db !== $("dbSelect").value
  ) return;

  /* Only an old backend needs field-row discovery. The archived-device API
     already reads the complete selected database and must not be followed by
     a multi-gigabyte compatibility query. */
  if (!usedArchivedDeviceApi) {
    try {
      const storedRows = await api(
        "/api/all?db=" + encodeURIComponent(db) + "&range=all",
        30000
      );
      const existing = new Map(
        devs.map(item => [
          canonicalDeviceName(item.device || item.device_name || ""),
          item
        ])
      );
      (Array.isArray(storedRows) ? storedRows : []).forEach(row => {
        const device = canonicalDeviceName(
          row.device || row.device_name || ""
        );
        if (device && !existing.has(device)) {
          existing.set(device, { device, status: "recorded" });
        }
      });
      devs = [...existing.values()].filter(item =>
        canonicalDeviceName(item.device || item.device_name || "")
      );
    } catch (error) {
      console.warn("Stored device discovery failed", error);
    }
  }

  if (!devs.length) {
    const rows = await api(
      "/api/all?db=" +
      encodeURIComponent(db) +
      "&range=all",
      30000
    );
    const names = [
      ...new Set(
        (Array.isArray(rows) ? rows : [])
          .map(row =>
            canonicalDeviceName(row.device || row.device_name || "")
          )
          .filter(Boolean)
      )
    ];
    devs = names.map(device => ({
      device,
      status: "history"
    }));
  }

    if (
      generation !== historyDeviceLoadGeneration ||
      db !== $("dbSelect").value
    ) return;
    $("deviceSelect").innerHTML = devs.map(d => `
  <option value="${esc(d.device)}">
    ${esc(d.device)} (${esc(d.status || "offline")})
  </option>
`).join("");

if (devs.length > 0) {
  $("deviceSelect").value = devs[0].device;
}
  $("deviceSelect").disabled = false;

  } catch (e) {
    console.error("Device load failed", e);
    if (generation === historyDeviceLoadGeneration) {
      $("deviceSelect").innerHTML =
        '<option value="">No recorded devices found</option>';
      $("deviceSelect").disabled = false;
    }
  }
}

/**
 * Normalizes historical rows and calculates numeric values and timestamps.
 */
function normalizeHistoryRows(rows) {

  return rows.map(r => {

    const raw =
      r.value_num ??
      r.value;

    const num = parseFloat(raw);
const ts =
  r.timestamp ||
  r.server_rx_ts ||
  r.packet_ts ||
  "";

    return {
      ...r,
      device_name:
        canonicalDeviceName(r.device_name || r.device || ""),
      device:
        canonicalDeviceName(r.device || r.device_name || ""),

      numericValue:
        Number.isFinite(num)
          ? num
          : null,

timeMs: parseHistoryTime(ts)    };
  });
}

/**
 * Selects the best available timestamp from a telemetry row.
 */
function rowTimestamp(row) {
  return row.timestamp || row.server_rx_ts || row.packet_ts || "";
}

/**
 * Converts a stored row into the consistent replay and table representation.
 */
function normalizeReplayRow(row) {
  return {
    timestamp: rowTimestamp(row),
    channel: row.channel || row.channel_name || "",
    device: canonicalDeviceName(row.device || row.device_name || ""),
    subdevice: row.subdevice || row.subdevice_name || "",
    process: row.process || row.process_name || "",
    subprocess: row.subprocess || row.subprocess_name || "",
    key: row.key || row.value_key || "",
    value: String(row.value_type || "").toLowerCase() === "text"
      ? (row.value_text ?? row.value ?? "")
      : (row.value_num ?? row.value ?? row.value_text ?? ""),
    value_type: row.value_type || (
      Number.isFinite(Number(row.value ?? row.value_num)) ? "num" : "text"
    ),
    value_text: row.value_text || "",
    anomaly: row.anomaly ? 1 : 0,
    reason: row.reason || ""
  };
}

/**
 * Creates and attaches a canvas card for one historical metric.
 */
function createChartCard(device, metric) {
  // Resolve the required DOM resource and store it in `box`.
  const box = document.createElement("div");

  box.className = "card";

  box.innerHTML = `
    <div class="chartHeader">
      <h3>${esc(device)} / ${esc(metric)}</h3>
    </div>

    <div class="chartBox small">
      <canvas></canvas>
    </div>
  `;

  $("historyCharts").appendChild(box);

  return box.querySelector("canvas");
}

function historyMetricLabel(value) {
  return String(value || "value")
    .replace(/[._-]+/g, " ")
    .replace(/\b\w/g, letter => letter.toUpperCase());
}

function historyMetricValue(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value ?? "--");
  if (Math.abs(number) >= 1000) return number.toFixed(1);
  if (Math.abs(number) >= 10) return number.toFixed(2);
  return number.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

function renderHistorySvgChart(device, metric, points) {
  const values = points
    .filter(point =>
      Number.isFinite(Number(point.x)) &&
      Number.isFinite(Number(point.y))
    )
    .slice(-500);

  if (values.length < 1) return;

  const width = 640;
  const height = 210;
  const padX = 58;
  const padTop = 18;
  const padBottom = 38;
  const numeric = values.map(point => Number(point.y));
  const min = Math.min(...numeric);
  const max = Math.max(...numeric);
  const spread = max - min || Math.max(1, Math.abs(max) * .1);
  const firstMs = Math.min(...values.map(point => Number(point.x)));
  const lastMs = Math.max(...values.map(point => Number(point.x)));
  const timeSpan = Math.max(1, lastMs - firstMs);
  const plotBottom = height - padBottom;
  const path = values.map((point, index) => {
    const x = padX +
      (Number(point.x) - firstMs) * (width - padX - 12) / timeSpan;
    const y = plotBottom -
      (Number(point.y) - min) * (plotBottom - padTop) / spread;
    return `${index ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const latest = numeric[numeric.length - 1];
  const xTicks = Array.from({ length: 5 }, (_, index) => {
    const ratio = index / 4;
    const x = padX + ratio * (width - padX - 12);
    const when = new Date(firstMs + ratio * timeSpan);
    const label = chartTimeLabel(when, timeSpan);
    return `<path class="deviceSvgGrid" d="M${x.toFixed(1)} ${padTop}V${plotBottom}"/>
      <text x="${x.toFixed(1)}" y="${height-9}" text-anchor="${index === 0 ? "start" : index === 4 ? "end" : "middle"}">${esc(label)}</text>`;
  }).join("");
  const latestX = padX +
    (Number(values[values.length - 1].x) - firstMs) *
    (width - padX - 12) / timeSpan;
  const latestY = plotBottom -
    (latest - min) * (plotBottom - padTop) / spread;
  const hoverPoints = values.map(point => {
    const pointX = padX +
      (Number(point.x) - firstMs) * (width - padX - 12) / timeSpan;
    const pointY = plotBottom -
      (Number(point.y) - min) * (plotBottom - padTop) / spread;
    const timestamp = new Date(Number(point.x)).toLocaleString();
    return `<circle class="deviceSvgHoverPoint" cx="${pointX.toFixed(1)}" cy="${pointY.toFixed(1)}" r="7" tabindex="0">
      <title>${esc(telemetryTooltipText({
        device: point.device || device,
        field: point.key || metric,
        value: point.y,
        unit: point.unit,
        status: point.status,
        timestamp: point.timestamp || point.x
      }))}</title>
    </circle>`;
  }).join("");
  const box = document.createElement("div");
  box.className = "card deviceSvgChartCard";
  box.innerHTML = `
    <div class="deviceSvgChartHeader">
      <h3>${esc(device)} / ${esc(historyMetricLabel(metric))}</h3>
      <strong>${esc(historyMetricValue(latest))}</strong>
    </div>
    <svg class="deviceSvgChart" viewBox="0 0 ${width} ${height}">
      <path class="deviceSvgGrid" d="M${padX} ${padTop}H${width-12} M${padX} ${(padTop+plotBottom)/2}H${width-12} M${padX} ${plotBottom}H${width-12}"/>
      ${xTicks}
      <path class="deviceSvgLine" d="${path}"/>
      ${hoverPoints}
      <circle class="deviceSvgPoint" cx="${latestX.toFixed(1)}" cy="${latestY.toFixed(1)}" r="4"/>
      <text x="5" y="${padTop+4}">${esc(historyMetricValue(max))}</text>
      <text x="5" y="${plotBottom+4}">${esc(historyMetricValue(min))}</text>
    </svg>
  `;
  $("historyCharts").appendChild(box);
  historyChartState[`${device}::${metric}`] = {
    device,
    metricName: metric,
    points
  };
}

function renderHistoryChartsFromRows(device, rows) {
  const grouped = new Map();

  rows.forEach(row => {
    const key = String(row.key || row.value_key || "").trim();
    const value = Number(row.value ?? row.value_num);
    const time = parseHistoryTime(rowTimestamp(row));
    const type = String(row.value_type || "").toLowerCase();
    if (
      !key ||
      type === "text" ||
      !Number.isFinite(value) ||
      !Number.isFinite(time)
    ) return;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push({
      x: time,
      y: value,
      timestamp: rowTimestamp(row),
      device: row.device_name || row.device || device,
      key,
      unit: row.unit || row.value_unit || "",
      status: row.status || row.state || row.health || ""
    });
  });

  $("historyCharts").innerHTML = "";
  Object.keys(historyChartState).forEach(key => delete historyChartState[key]);

  [...grouped.entries()]
    .sort((a, b) =>
      deviceMetricPriority(a[0]) - deviceMetricPriority(b[0]) ||
      b[1].length - a[1].length
    )
    .forEach(([metric, points]) => {
      points.sort((a, b) => a.x - b.x);
      const sampledPoints = points.length > 1000
        ? points.filter((_, index) =>
            index % Math.ceil(points.length / 1000) === 0
          )
        : points;
      const canvas = createChartCard(device, historyMetricLabel(metric));
      drawLineChart(canvas, [{
        label: metric,
        telemetryKey: metric,
        telemetryDevice: device,
        data: sampledPoints
      }], historyMetricLabel(metric));
      historyChartState[`${device}::${metric}`] = {
        device,
        metricName: metric,
        points,
        canvas
      };
    });

  if (!$("historyCharts").children.length) {
    $("historyCharts").innerHTML =
      '<div class="card"><h3>No numeric history available</h3></div>';
  }
}

/**
 * Queries, filters, samples, and draws one historical metric chart.
 */
async function loadMetricChart(db, device, metricName) {
let rows = await api(
  "/api/history?db=" + encodeURIComponent(db) +
  "&device=" + encodeURIComponent(device) +
  "&key=" + encodeURIComponent(metricName) +
  "&range=all"
);

rows = filterRowsBySelectedRange(rows);

  const parsed = normalizeHistoryRows(rows);

  const points = parsed
    .filter(r =>
      Number.isFinite(r.numericValue) &&
      Number.isFinite(r.timeMs)
    )
    .map(r => ({
      x: r.timeMs,
      y: r.numericValue,
      timestamp: r.timestamp || r.server_rx_ts || r.packet_ts || r.timeMs,
      device: r.device_name || r.device || device,
      key: r.key || r.value_key || metricName,
      unit: r.unit || r.value_unit || "",
      status: r.status || r.state || r.health || ""
    }));

  if (!points.length) {
    return;
  }

  const sampledPoints =
    points.length > 500
      ? points.filter((_, i) =>
          i % Math.ceil(points.length / 500) === 0
        )
      : points;

  const canvas = createChartCard(device, metricName);

  drawLineChart(
    canvas,
    [{
      label: metricName,
      telemetryKey: metricName,
      telemetryDevice: device,
      data: sampledPoints
    }],
    metricName
  );

  historyChartState[`${device}::${metricName}`] = {
    device,
    metricName,
    points,
    canvas
  };
}

/**
 * Merges matching live telemetry into active historical charts.
 */
function updateHistoryLiveCharts(rows) {

  const incoming = flattenScadaRows(rows);

  if (!incoming.length) {
    return;
  }

  const selectedDevice = $("deviceSelect").value;

  incoming.forEach(row => {

    const device = row.device_name || row.device;

    if (device !== selectedDevice) {
      return;
    }

    const metricName = String(
      row.key ||
      row.value_key ||
      ""
    ).trim();

    const state = historyChartState[`${device}::${metricName}`];

    if (!state) {
      return;
    }

    const value = Number(
      row.value_num ??
      row.value ??
      row.value_text
    );

    if (!Number.isFinite(value)) {
      return;
    }

    state.points.push({
      x: parseTs(
        row.timestamp ||
        row.server_rx_ts ||
        row.packet_ts
      ),
      y: value,
      timestamp: row.timestamp || row.server_rx_ts || row.packet_ts || "",
      device,
      key: metricName,
      unit: row.unit || row.value_unit || "",
      status: row.status || row.state || row.health || ""
    });
trimPointSeries(
  state.points,
  rangeToMs($("range") ? $("range").value : App.range),
  1000
);

   if (state.canvas && state.canvas.chartInstance) {

  state.canvas.chartInstance.data.datasets[0].data =
    state.points;

  state.lastUpdate =
    state.lastUpdate || 0;

  if (Date.now() - state.lastUpdate > 500) {

    state.canvas.chartInstance.update("none");

    state.lastUpdate =
      Date.now();
  }
}
  });
}

/**
 * Renders normalized historical records into the table body.
 */
function buildHistoryTable(rows) {

  if (!rows || !rows.length) {
    return `
      <tr>
        <td colspan="9" class="muted">
          No history available
        </td>
      </tr>
    `;
  }

  return rows.map(r => `
    <tr class="${r.anomaly ? 'anomalyRow' : ''}">
      <td>${esc(r.timestamp || "-")}</td>
      <td>${esc(r.channel || "-")}</td>
      <td>${esc(r.device || "-")}</td>
      <td>${esc(r.subdevice || "-")}</td>
      <td>${esc(r.process || "-")}</td>
      <td>${esc(r.key || r.value_key || "-")}</td>

      <td>
        ${
          r.value_type === "text"
            ? esc(r.value_text || "")
            : esc(String(r.value ?? r.value_num ?? "-"))
        }
      </td>

      <td>
        ${
          r.anomaly
? '<span class="badge bad">⚠ ANOMALY</span>'
: '<span class="badge good">NORMAL</span>'
        }
      </td>

      <td>${esc(r.reason || "-")}</td>
    </tr>
  `).join("");
}

/*
--------------------------------------------------
REPLAY ENGINE
--------------------------------------------------
*/

/**
 * Updates replay controls, indicators, and current playback state.
 */
function updateReplayUI() {

  const slider = $("timelineSlider");
  const info = $("timelineInfo");

  if (!slider || !info) {
    return;
  }

  if (!replayRows.length) {

    info.innerHTML =
      "No replay data";

    return;
  }

  const row =
    replayRows[replayIndex];

  if (!row) {
    return;
  }

  slider.max =
    replayRows.length - 1;

  slider.value =
    replayIndex;

  info.innerHTML = `

    <div class="timelineMeta">

      <strong>
        ${esc(row.device || "-")}
      </strong>

      <span>
        ${esc(row.process || "-")}
      </span>

      <span>
        ${esc(row.timestamp || "-")}
      </span>

      <span>
        ${
          row.anomaly
            ? "⚠ Anomaly"
            : "✓ Normal"
        }
      </span>

    </div>
  `;

  $("historyBody").innerHTML =
    buildHistoryTable([
      row
    ]);

    activeStateIndex =
  replayIndex;

  if (replayIndex > 0) {

  recentTransitions.push({

    from:
      replayRows[
        replayIndex - 1
      ],

    to: row,

    ts: Date.now()
  });

  recentTransitions =
    recentTransitions.slice(-6);
}

renderCyclograph();
}

/**
 * Starts or resumes deterministic playback of historical telemetry.
 */
function startReplay() {

  if (!$("speedSelect")) {
    return;
  }

  if (
    replayPlaying ||
    !replayRows.length
  ) {

    return;
  }

  replayPlaying = true;
  setText("historyLiveMode", "REPLAY");

  const speed = Number(
    $("speedSelect").value || 1000
  );

  replayTimer = setInterval(() => {

    replayIndex++;

    if (
      replayIndex >= replayRows.length
    ) {

      replayIndex =
        replayRows.length - 1;

      stopReplay();

      return;
    }

    updateReplayUI();

  }, speed);
}

/**
 * Stops replay scheduling while retaining loaded replay state.
 */
function stopReplay() {

  replayPlaying = false;
  setText("historyLiveMode", "PAUSED");

  clearInterval(replayTimer);

  replayTimer = null;
}

/**
 * Returns replay state and controls to their initial positions.
 */
function resetReplay() {

  stopReplay();

  replayIndex = 0;
  setText("historyLiveMode", "READY");

  updateReplayUI();
}
/*
--------------------------------------------------
CYCLOGRAPH
--------------------------------------------------
*/

/**
 * Builds ordered process-state transitions for replay visualization.
 */
function buildCyclograph(rows) {

const states = [];

const uniqueDevices =
  new Set();

  for (const r of rows) {

    const processName =

  r.subprocess ||

  r.process ||

  r.key ||

  "UNKNOWN";

const deviceName =

  (
    r.process ||

    r.subprocess ||

    r.key ||

    "UNKNOWN_PROCESS"
  )
  .toString()
  .toUpperCase();

if (
  !uniqueDevices.has(
    deviceName
  )
) {

  uniqueDevices.add(
    deviceName
  );

  states.push({

    name: deviceName,

    anomaly:
      !!r.anomaly,

    timestamp:
      r.timestamp,

    device:
      r.device,

    process:
      r.process,

    subprocess:
      r.subprocess,

    session_id:
      r.session_id
  });
}
  }

  cyclographStates = states;

  renderCyclograph();
}

/**
 * Renders the current cyclograph state and recent transitions.
 */
function renderCyclograph() {

  const svg =
    $("cyclographSvg");

  if (!svg) return;

  svg.innerHTML = "";

  if (!cyclographStates.length) {

    svg.innerHTML = `
      <text
        x="50%"
        y="50%"
        fill="#9ca3af"
        text-anchor="middle">

        No telemetry states

      </text>
    `;

    return;
  }

  const width = 1200;
  const height = 760;

  svg.setAttribute(
    "viewBox",
    `0 0 ${width} ${height}`
  );

  const cx = width / 2;
  const cy = height / 2;

  /*
  ----------------------------------------
  RADAR RINGS
  ----------------------------------------
  */

  [120,220,320].forEach(r => {

    const ring =
      document.createElementNS(
        "http://www.w3.org/2000/svg",
        "circle"
      );

    ring.setAttribute("cx", cx);
    ring.setAttribute("cy", cy);
    ring.setAttribute("r", r);

    ring.setAttribute(
      "class",
      "cycloRadarRing"
    );

    svg.appendChild(ring);
  });

  /*
  ----------------------------------------
  CENTER HUB
  ----------------------------------------
  */

  const core =
    document.createElementNS(
      "http://www.w3.org/2000/svg",
      "circle"
    );

  core.setAttribute("cx", cx);
  core.setAttribute("cy", cy);
  core.setAttribute("r", 90);

  core.setAttribute(
    "class",
    "cycloHub radarPulse"
  );

  svg.appendChild(core);

  /*
  ----------------------------------------
  TOOLTIP
  ----------------------------------------
  */

  let tooltip =
    $("cycloTooltip");

  if (!tooltip) {

    tooltip =
      document.createElement("div");

    tooltip.id =
      "cycloTooltip";

    tooltip.className =
      "cycloTooltip";

    document.body.appendChild(
      tooltip
    );
  }

  /*
  ----------------------------------------
  NODE LAYOUT
  ----------------------------------------
  */

  const total =
    cyclographStates.length;

  const angleStep =
    (Math.PI * 2) / total;

  cyclographStates.forEach(
    (s, i) => {

      const angle =
        i * angleStep -
        Math.PI / 2;

      const radius = 320;

      const x =
        cx +
        Math.cos(angle) *
        radius;

      const y =
        cy +
        Math.sin(angle) *
        radius;

      const active =
        i === activeStateIndex;

      /*
      ACTIVE LINE
      */

      if (active) {

        const line =
          document.createElementNS(
            "http://www.w3.org/2000/svg",
            "line"
          );

        line.setAttribute("x1", cx);
        line.setAttribute("y1", cy);

        line.setAttribute("x2", x);
        line.setAttribute("y2", y);

        line.setAttribute(
          "class",
          "cycloTrail"
        );

        svg.appendChild(line);
      }

      /*
      NODE
      */

      const node =
        document.createElementNS(
          "http://www.w3.org/2000/svg",
          "circle"
        );

      node.setAttribute("cx", x);
      node.setAttribute("cy", y);

      node.setAttribute(
        "r",
        active ? 22 : 14
      );

      node.setAttribute(
        "class",
        s.anomaly
          ? "cycloNode anomaly"
          : "cycloNode"
      );

      svg.appendChild(node);

      /*
      LABEL
      */

      const label =
        document.createElementNS(
          "http://www.w3.org/2000/svg",
          "text"
        );

      label.setAttribute("x", x);
      label.setAttribute("y", y - 26);

      label.setAttribute(
        "text-anchor",
        "middle"
      );

      label.setAttribute(
        "class",
        "cycloMiniLabel"
      );

      label.textContent =
        s.name.slice(0,12);

      svg.appendChild(label);

      /*
      TOOLTIP EVENTS
      */

      node.addEventListener(
        "mouseenter",
        e => {

          tooltip.style.opacity =
            "1";

          tooltip.style.left =
            e.pageX + 20 + "px";

          tooltip.style.top =
            e.pageY + 20 + "px";

          tooltip.innerHTML = `

            <h3>
              ${esc(s.name)}
            </h3>

            <p>
              ${
                s.anomaly
                  ? "⚠ Anomaly"
                  : "✓ Operational"
              }
            </p>

            <p>
              ${esc(
                s.timestamp || "-"
              )}
            </p>
          `;
        }
      );

      node.addEventListener(
        "mouseleave",
        () => {

          tooltip.style.opacity =
            "0";
        }
      );
    }
  );
}

/**
 * Executes the guarded historical query and renders all returned views.
 */
async function loadHistory() {
  const generation = ++historyLoadGeneration;
  historyBusy = true;

  try {
    const db = $("dbSelect").value;
    const device = $("deviceSelect").value;

    if (!db || !device) {
      console.warn("History load skipped", { db, device });
      clearHistorySelectionState(
        db ? "No recorded device selected" : "No historical database selected"
      );
      return;
    }

    console.info("History query started", {
      database: db,
      device,
      range: $("range").value
    });

    $("historyCharts").innerHTML = `
      <div class="loading">Loading charts...</div>
    `;

    let historyRaw;
    try {
      const packets = await api(
        "/api/history/packets?db=" + encodeURIComponent(db) +
        "&range=" + encodeURIComponent($("range").value) +
        "&device=" + encodeURIComponent(device),
        30000
      );
      historyRaw = telemetryRowsFromPackets(packets, device);
    } catch {
      try {
        historyRaw = await api(
          "/api/page/telemetry?db=" + encodeURIComponent(db) +
          "&range=" + encodeURIComponent($("range").value) +
          "&device=" + encodeURIComponent(device),
          30000
        );
      } catch {
        historyRaw = await api(
          "/api/all?db=" + encodeURIComponent(db) +
          "&range=all&device=" + encodeURIComponent(device),
          30000
        );
      }
    }
    if (generation !== historyLoadGeneration) return;

    if (!Array.isArray(historyRaw) || !historyRaw.length) {
      historyRaw = await api(
        "/api/device/latest10?db=" +
        encodeURIComponent(db) +
        "&name=" +
        encodeURIComponent(device)
      );
    }
    if (generation !== historyLoadGeneration) return;

    const allRows = Array.isArray(historyRaw)
      ? [...historyRaw]
      : Array.isArray(historyRaw?.rows)
        ? [...historyRaw.rows]
        : [];

if (!allRows.some(row =>
  String(row.key || row.value_key || "").trim() &&
  (row.value != null || row.value_num != null || row.value_text != null)
)) {
  allRows.push(...await latestRawRowsForDevice(db, device));
}

// Filter the source collection into `deviceRows`.
    const deviceRows = allRows.filter(r =>
  sameDeviceName(r.device || r.device_name, device)
);

    const selectedMetric = updateHistoryMetricOptions(deviceRows);

const filteredHistory =
      filterRowsBySelectedRange(filterHistoryMetric(deviceRows, selectedMetric));

replayRows = filteredHistory
  .map(normalizeReplayRow)
  .sort((a, b) => parseTs(a.timestamp) - parseTs(b.timestamp));

    const tableRows = replayRows
      .slice()
      .reverse()
      .slice(0, 100);

    $("historyBody").innerHTML = buildHistoryTable(tableRows);

    renderHistoryChartsFromRows(device, replayRows);
    const graphCount = Object.keys(historyChartState).length;
    historyPacketCount = replayRows.length;
    setText("historyPacketCount", historyPacketCount + " records");
    setText(
      "historyLiveMode",
      db === activeLiveDb ? "LIVE + HISTORY" : "HISTORY"
    );

    replayIndex = 0;
    buildCyclograph(replayRows);

    console.info("History render complete", {
      database: db,
      queryResultCount: allRows.length,
      normalizedRowCount: replayRows.length,
      tableRowCount: tableRows.length,
      graphCount,
      tableRendered: true,
      graphsRendered: graphCount > 0
    });

    if (!replayRows.length) {
      setText("historyLiveMode", "NO HISTORY — " + db);
      console.warn("History query returned no displayable rows", {
        database: db,
        device,
        sourceRowCount: allRows.length
      });
    }

  } catch (e) {
    if (generation !== historyLoadGeneration) return;
    const failedDb = $("dbSelect")?.value || "";
    console.error("History load/render failed", {
      database: failedDb,
      error: e
    });
    $("historyCharts").innerHTML =
      `<div class="card"><h3>Unable to load ${esc(failedDb || "selected history")}</h3></div>`;
    $("historyBody").innerHTML = `
      <tr><td colspan="9" class="muted">
        Unable to load ${esc(failedDb || "the selected database")}: ${esc(e.message || e)}
      </td></tr>`;
    setText("historyPacketCount", "0 records");
  } finally {
    if (generation === historyLoadGeneration) historyBusy = false;
  }
}

/**
 * Returns the selected historical window in milliseconds.
 */
function selectedRangeMs() {
  return rangeToMs($("range").value);
}

/**
 * Filters rows to the selected rolling historical window.
 */
function filterRowsBySelectedRange(rows) {
  const ms = selectedRangeMs();

  if (!Array.isArray(rows)) {
    return [];
  }

  if (!ms) {
    return rows;
  }

  const parsed = rows
    .map(r => ({
      row: r,
      t: parseHistoryTime(rowTimestamp(r))
    }))
    .filter(x => Number.isFinite(x.t));

  if (!parsed.length) {
    return [];
  }

  const latestTime =
    Math.max(...parsed.map(x => x.t));

  const startTime =
    latestTime - ms;

  return parsed
    .filter(x => x.t >= startTime)
    .map(x => x.row);
}
/**
 * Converts a supported historical timestamp into epoch milliseconds.
 */
function parseHistoryTime(v) {
  if (!v) return NaN;

  return parseTs(v);
}
/**
 * Converts live SCADA messages into normalized historical row shapes.
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

/**
 * Expands sampled compact database packets into the field-row shape shared by
 * history tables and charts.
 */
/**
 * Initializes database/device selectors, events, data, replay, and live updates.
 */
async function init() {

  await loadDbSelect($("dbSelect"));
  activeLiveDb = $("dbSelect").value;
  const requestedDb = new URLSearchParams(window.location.search).get("db");
  if (requestedDb && Array.from($("dbSelect").options)
      .some(option => option.value === requestedDb)) {
    $("dbSelect").value = requestedDb;
    App.db = requestedDb;
  }

  await loadDevicesForHistory();

  await loadHistory();

$("dbSelect").onchange = async () => {
  historyLoadGeneration++;
  App.db = $("dbSelect").value;
  clearHistorySelectionState("Loading recorded devices...");
  console.info("History database changed", { database: App.db });
  await loadDevicesForHistory();

  await loadHistory();
};

$("deviceSelect").onchange =
  loadHistory;

$("range").onchange =
  loadHistory;

$("metricSelect").onchange =
  loadHistory;

const playBtn = $("replayPlayBtn");
const pauseBtn = $("replayPauseBtn");
const resetBtn = $("replayResetBtn");
const slider = $("timelineSlider");

if (playBtn) {
  playBtn.onclick = startReplay;
}

if (pauseBtn) {
  pauseBtn.onclick = stopReplay;
}

if (resetBtn) {
  resetBtn.onclick = resetReplay;
}

if (slider) {
  slider.oninput = () => {
    stopReplay();
    replayIndex = Number(slider.value) || 0;
    updateReplayUI();
  };
}

  initScadaSocket();

onScadaEvent(msg => {

const rows =
  scadaMessagesToRows(msg);

  /* An archived database/date is immutable. Do not inject current devices,
     selector options, counts, table rows, or charts into that view. */
  if ($("dbSelect").value !== activeLiveDb) return;

  const selector = $("deviceSelect");
  if (selector) {
    rows.forEach(row => {
      const device =
        canonicalDeviceName(row.device || row.device_name || "");
      if (!device) return;

      const exists =
        Array.from(selector.options)
          .some(option => sameDeviceName(option.value, device));
      if (!exists) {
        const option = document.createElement("option");
        option.value = device;
        option.textContent = `${device} (live)`;
        selector.appendChild(option);
      }
    });

    if (!selector.value && selector.options.length) {
      selector.value = selector.options[0].value;
    }
  }

  historyPacketCount += rows.length;
  const packetEl = $("historyPacketCount");
  if (packetEl) packetEl.textContent = historyPacketCount + " rows";
  updateHistoryLiveCharts(rows);
  updateLatestPanels(rows);
  scheduleHistoryLiveRender(rows);

});

  setInterval(() => {
    if (replayTimer) {
      return;
    }

    /* Do not poll cached DB history as live data. Manual refresh/range changes
       load history; websocket packets update live charts. */
  }, 5000);
  
}

/**
 * Updates the latest-value panels from incoming normalized rows.
 */
function updateLatestPanels(rows) {

  if (!rows || !rows.length) {
    return;
  }

  const selectedDevice =
    $("deviceSelect").value;

  rows.forEach(r => {

    const device =
      canonicalDeviceName(r.device_name || r.device);

    if (!sameDeviceName(device, selectedDevice)) {
      return;
    }

    const item = {

      timestamp:
        r.timestamp,

      device,

      process:
        r.process_name ||
        r.process,

      key:
        r.key ||
        r.value_key,

      value:
        r.value_num ??
        r.value_text,

      anomaly:
        r.anomaly,

      reason:
        r.reason || ""
    };

replayRows.unshift(item);  
});

  replayRows =
    replayRows.slice(0,100);

  const latestPanel =
    $("latest25Panel");

  if (latestPanel) {

    latestPanel.innerHTML =
      replayRows.map(r => `
        <div class="latestRow">
          <span>${esc(r.timestamp)}</span>
          <span>${esc(r.key)}</span>
          <span>${esc(r.value)}</span>
        </div>
      `).join("");
  }

  $("historyBody").innerHTML =
    buildHistoryTable(replayRows);
}

init().catch(e => {
  console.error(e);
  alert("History init error: " + e.message);
 });
  
