/*
 * Single-device dashboard controller.
 *
 * Resolves the requested device and database from the URL, loads its bounded
 * history and metrics, and merges matching live packets. All user-provided URL
 * values are treated as display/filter data and encoded before API use.
 */
// Parse query parameters from the current device-page URL.
const params = new URLSearchParams(window.location.search);

// Store the decoded device identifier selected by the URL.
const DEVICE = decodeURIComponent(
  params.get("name") || ""
);
const QUERY_DEVICE =
  canonicalDeviceName(DEVICE) === "DRIVE_UNIT"
    ? "LCU_UNIT"
    : DEVICE;

// Store the optional database requested by the URL.
const DB_FROM_URL =
  params.get("db") || "";
const RANGE_FROM_URL =
  params.get("range") || "";

// Index active chart instances by normalized metric key.
const liveCharts = {};
// Retain bounded live point history for every metric chart.
const liveChartRows = {};
// Record when matching live telemetry was last received.
let deviceLastLiveAt = 0;
let deviceLoadGeneration = 0;
// Identify the newest database that is allowed to receive WebSocket updates.
let deviceLiveDb = "";
// Hold the timer used to coalesce chart rendering.
let deviceChartRenderTimer = null;
// Hold the timer used to coalesce non-chart page rendering.
let deviceChromeRenderTimer = null;
let deviceHoveredChart = "";
// Deduplicate raw-packet polling used with metadata-only legacy backends.
let lastRecoveredRawPacket = "";

function updateDevicePageNavigation() {
  const db = $("dbSelect")?.value || "";
  [
    ["dashboardLink", "critical-dashboard.html"]
  ].forEach(([id, page]) => {
    const link = $(id);
    if (!link) return;
    const url = new URL(page, location.href);
    if (db) url.searchParams.set("db", db);
    link.href = url.href;
  });
}
// Hold the timer used to coalesce digital-twin rendering.
let digitalTwinRenderTimer = null;
// Track metric charts requiring refresh in the next batch.
const pendingDeviceChartKeys = new Set();

/* LIVE TABLE DATA */
// Retain the bounded rows displayed in the latest-device table.
let latestRows = [];
// Store the selected device's database row total.
let deviceTotalRows = 0;
// Store the selected device's database anomaly total.
let deviceTotalAnomalies = 0;
// Index the most recent digital state for each live key.
const digitalTwinState = {};

/**
 * Checks whether a telemetry row belongs to the URL-selected device.
 */
function isSelectedDeviceRow(row) {
  return sameDeviceName(
    row?.device_name || row?.device,
    DEVICE
  );
}

function deviceRowsFromAnyLiveMessage(message) {
  let data = message;

  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      return [];
    }
  }

  if (!data || typeof data !== "object") return [];

  const payload =
    parseLivePayload(data.payload) ||
    parseLivePayload(data.raw_json) ||
    (data.body && typeof data.body === "object" ? data.body : null);

  if (!payload || typeof payload !== "object") return [];

  const fields = [];
  flattenLivePayload(payload, "", fields);
  const timestamp =
    data.server_rx_ts ||
    data.timestamp ||
    new Date().toISOString();
  const device =
    canonicalDeviceName(
      data.device ||
      data.device_name ||
      payload.device ||
      payload.device_name ||
      DEVICE
    );

  return fields.map(field => ({
    timestamp,
    server_rx_ts: timestamp,
    device_ts: data.device_ts || payload.device_ts || "",
    packet_ts: data.packet_ts || payload.packet_ts || "",
    channel: data.channel || payload.channel || "",
    device,
    device_name: device,
    process: data.process || payload.process || "",
    process_name: data.process || payload.process || "",
    ...field
  }));
}

/**
 * Converts an arbitrary metric name into a safe bounded DOM identifier.
 */
function metricDomId(key) {
  return "metric_" + String(key || "")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 80);
}

function deviceMetricLabel(key) {
  return String(key || "value")
    .replace(/[._-]+/g, " ")
    .replace(/\b\w/g, letter => letter.toUpperCase());
}

function deviceMetricValue(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value ?? "--");
  if (Math.abs(number) >= 1000) return number.toFixed(1);
  if (Math.abs(number) >= 10) return number.toFixed(2);
  return number.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * Normalizes numeric and textual live values into an active/inactive state.
 */
function liveStateFromValue(row) {
  const value =
    row.value_type === "text"
      ? row.value_text
      : (row.value_num ?? row.value ?? row.value_text);

  if (typeof value === "number") {
    return value > 0.5 ? 1 : 0;
  }

  const text =
    String(value ?? "")
      .trim()
      .toLowerCase();

  if (["1", "on", "true", "active", "enabled", "online", "alive"].includes(text)) {
    return 1;
  }

  if (["0", "off", "false", "inactive", "disabled", "offline"].includes(text)) {
    return 0;
  }

  return text ? 1 : 0;
}

/**
 * Renders the latest digital state cards for the selected device.
 */
function renderDigitalTwin() {
  const el = $("digitalTwin");

  if (!el) {
    return;
  }

  const rows =
    Object.values(digitalTwinState)
      .sort((a, b) =>
        String(a.button || "").localeCompare(String(b.button || ""))
      );

  if (!rows.length) {
    el.innerHTML = `
      <div class="twinCard off">
        <div class="twinHeader">
          <div class="twinDot"></div>
          <h3>No live state yet</h3>
        </div>
        <div class="twinState">WAITING</div>
      </div>
    `;
    return;
  }

  el.innerHTML = rows.map(btn => `
    <div class="twinCard ${btn.state ? "on" : "off"}">
      <div class="twinHeader">
        <div class="twinDot"></div>
        <h3>${esc(btn.button)}</h3>
      </div>
      <div class="twinState">
        ${btn.state ? "ACTIVE" : "INACTIVE"}
      </div>
      <div class="twinMeta">
        <div>
          <span>Last Used</span>
          <strong>${esc(btn.last_used || "-")}</strong>
        </div>
        <div>
          <span>Session</span>
          <strong>${esc(btn.session || "-")}</strong>
        </div>
        <div>
          <span>Heartbeat</span>
          <strong>${esc(btn.heartbeat || "-")}</strong>
        </div>
      </div>
    </div>
  `).join("");
}

/**
 * Replaces digital-twin state with a normalized API snapshot.
 */
function setDigitalTwinFromApi(rows) {
  Object.keys(digitalTwinState)
    .forEach(key => delete digitalTwinState[key]);

  (Array.isArray(rows) ? rows : []).forEach(btn => {
    const name = btn.button || btn.button_name || "";

    if (!name) {
      return;
    }

    digitalTwinState[name] = {
      button: name,
      state: btn.state ?? btn.button_state ?? 0,
      last_used: btn.last_used || "",
      session: btn.session || btn.session_id || "",
      heartbeat: btn.heartbeat || btn.last_heartbeat || ""
    };
  });

  renderDigitalTwin();
}

/**
 * Applies one live telemetry row to the digital-twin state.
 */
function updateDigitalTwinFromLiveRow(row) {
  const key =
    String(row.key || row.value_key || "")
      .trim();

  if (!key) {
    return;
  }

  const timestamp =
    row.server_rx_ts ||
    row.server_timestamp ||
    row.timestamp ||
    new Date().toISOString();

  const existing =
    digitalTwinState[key] || {
      button: key,
      state: 0,
      last_used: "",
      session: "",
      heartbeat: ""
    };

  const nextState =
    liveStateFromValue(row);

  digitalTwinState[key] = {
    ...existing,
    state: nextState,
    last_used:
      existing.state !== nextState
        ? timestamp
        : (existing.last_used || timestamp),
    session:
      row.session_id ||
      row.session ||
      existing.session ||
      App.db ||
      "",
    heartbeat: timestamp
  };

  if (!digitalTwinRenderTimer) {
    digitalTwinRenderTimer = setTimeout(() => {
      digitalTwinRenderTimer = null;
      renderDigitalTwin();
    }, 100);
  }
}

/**
 * Loads accurate total-row and anomaly counts for the selected device.
 */
async function loadDeviceTotals(db, latest) {
  try {
    const stats = await api(
      "/api/device/count?db=" +
      encodeURIComponent(db) +
      "&name=" +
      encodeURIComponent(QUERY_DEVICE)
    );

    deviceTotalRows =
      Number(stats.rows || 0);
    deviceTotalAnomalies =
      Number(stats.anomalies || 0);
  } catch {
    deviceTotalRows =
      Math.max(
        deviceTotalRows,
        Array.isArray(latest) ? latest.length : 0
      );
    deviceTotalAnomalies =
      Math.max(
        deviceTotalAnomalies,
        (Array.isArray(latest) ? latest : [])
          .filter(x => x.anomaly).length
      );
  }
}

/**
 * Renders the device's aggregate totals and active selection summary.
 */
function renderDeviceSummaryCards(db, range) {
  $("deviceSummary").innerHTML = `

    <div class="card">

      <h3>Device</h3>

      <p>${esc(DEVICE)}</p>

    </div>

    <div class="card">

      <h3>Total Rows</h3>

      <p>${deviceTotalRows}</p>

    </div>

    <div class="card">

      <h3>Anomalies</h3>

      <p>${deviceTotalAnomalies}</p>

    </div>

    <div class="card">

      <h3>Database</h3>

      <p>${esc(db)}</p>

    </div>

    <div class="card">

      <h3>Range</h3>

      <p>${esc(range)}</p>

    </div>

  `;
}

/**
 * Renders the selected device's online, warning, or offline health state.
 */
function renderDeviceHealthState(status, lastSeenText) {
  $("deviceHealthBar").innerHTML = `

    <div class="healthBar ${status}">

      <div class="healthLeft">

        <div class="healthPulse"></div>

        <div>

          <h2>${status.toUpperCase()}</h2>

          <p>Last Seen: ${esc(lastSeenText || "No live telemetry")}</p>

        </div>

      </div>

      <div class="healthRight">

        <div class="healthMetric">
          <span>Device</span>
          <strong>${esc(DEVICE)}</strong>
        </div>

        <div class="healthMetric">
          <span>Telemetry Rows</span>
          <strong>${deviceTotalRows}</strong>
        </div>

        <div class="healthMetric">
          <span>Anomalies</span>
          <strong>${deviceTotalAnomalies}</strong>
        </div>

      </div>

    </div>
  `;
}

/**
 * Returns the currently selected device-chart window in milliseconds.
 */
function deviceWindowMs() {

  return rangeToMs(
    $("range") ? $("range").value : App.range
  );
}

/**
 * Converts a numeric telemetry row into a timestamped chart point.
 */
function livePointFromRow(row) {

  const value = Number(
    row.value_num ??
    row.value ??
    row.value_text
  );

  if (!Number.isFinite(value)) {
    return null;
  }

  return {
    x: parseTs(
      row.timestamp ||
      row.server_rx_ts ||
      row.packet_ts
    ),
    y: value,
    timestamp: row.timestamp || row.server_rx_ts || row.packet_ts || "",
    device: row.device_name || row.device || DEVICE,
    key: row.key || row.value_key || "value",
    unit: row.unit || row.value_unit || "",
    status: row.status || row.state || row.health || ""
  };
}

/**
 * Creates the HTML container and canvas for one device metric.
 */
function renderDeviceMetricChart(key, points) {
  const values =
    (Array.isArray(points) ? points : [])
      .filter(point =>
        Number.isFinite(Number(point.x)) &&
        Number.isFinite(Number(point.y))
      )
      .map(point => ({ ...point, x: Number(point.x), y: Number(point.y) }))
      .sort((a, b) => a.x - b.x)
      .filter((point, index, arr) =>
        index === 0 || point.x >= arr[index - 1].x
      )
      .slice(-300);

  if (!values.length) return;

  const emptyCard =
    $("processCharts")?.querySelector("[data-no-device-data]");
  if (emptyCard) emptyCard.remove();

  const chartId = "chart_" + metricDomId(key);
  // Resolve the required DOM resource and store it in `card`.
  let card = document.getElementById(chartId);

  if (!card) {
    card = document.createElement("div");
    card.className = "card deviceSvgChartCard";
    card.id = chartId;
    $("processCharts").appendChild(card);
  }

  const width = 640;
  const height = 210;
  const padX = 58;
  const padTop = 18;
  const padBottom = 38;
  // Transform the source collection into `numeric`.
  const numeric = values.map(point => Number(point.y));
  const min = Math.min(...numeric);
  const max = Math.max(...numeric);
  const spread = max - min || Math.max(1, Math.abs(max) * .1);
  // Transform the source collection into `path`.
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
    return `<path class="deviceSvgGrid" d="M${x.toFixed(1)} ${padTop}V${plotBottom}"/>
      <text x="${x.toFixed(1)}" y="${height - 9}" text-anchor="${index === 0 ? "start" : index === 4 ? "end" : "middle"}">${esc(chartTimeLabel(when, timeSpan))}</text>`;
  }).join("");
  const latestX = padX +
    (Number(values[values.length - 1].x) - firstMs) *
    (width - padX - 12) / timeSpan;
  const latestY = plotBottom -
    (latest - min) * (plotBottom - padTop) / spread;
  card.innerHTML = `
    <div class="deviceSvgChartHeader">
      <h3>${esc(deviceMetricLabel(key))}</h3>
      <strong>${esc(deviceMetricValue(latest))}</strong>
    </div>
    <svg class="deviceSvgChart" data-metric-key="${esc(key)}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(deviceMetricLabel(key))} telemetry graph" tabindex="0">
      <path class="deviceSvgGrid" d="M${padX} ${padTop}H${width-12} M${padX} ${(padTop+plotBottom)/2}H${width-12} M${padX} ${plotBottom}H${width-12}"/>
      ${xTicks}
      <path class="deviceSvgLine" d="${path}"/>
      <circle class="deviceSvgPoint" cx="${latestX.toFixed(1)}" cy="${latestY.toFixed(1)}" r="4"/>
      <text x="5" y="${padTop+4}">${esc(deviceMetricValue(max))}</text>
      <text x="5" y="${plotBottom+4}">${esc(deviceMetricValue(min))}</text>
    </svg>
  `;
  installDeviceChartTooltip();

  let tooltip = card.querySelector(".device-chart-tooltip");
  if (!tooltip) {
    tooltip = document.createElement("div");
    tooltip.className = "device-chart-tooltip";
    tooltip.setAttribute("role", "status");
    tooltip.hidden = true;
    card.appendChild(tooltip);
  }

  liveCharts[key] = {
    destroy() {},
    update() {}
  };
}
function renderCompleteTelemetryPayload(rows) {
  const viewer = $("rawJsonViewer");
  const fieldTable = $("allTelemetryFields");

  if (!viewer || !fieldTable) {
    return;
  }

  if (!Array.isArray(rows) || !rows.length) {
    viewer.textContent = "No telemetry received.";
    fieldTable.innerHTML = `
      <tr>
        <td colspan="7">No telemetry received.</td>
      </tr>
    `;
    return;
  }

  /*
   * Prefer the newest packet containing raw_json.
   */
  const newest = rows.find(row =>
    row &&
    row.raw_json &&
    String(row.raw_json).trim()
  );

  if (newest) {
    try {
      const parsed =
        typeof newest.raw_json === "string"
          ? JSON.parse(newest.raw_json)
          : newest.raw_json;

      viewer.textContent =
        JSON.stringify(parsed, null, 2);
    } catch {
      viewer.textContent =
        String(newest.raw_json);
    }
  } else {
    viewer.textContent =
      "Raw JSON is not available for this sample.";
  }

  const sorted = [...rows]
    .filter(row =>
      row &&
      (row.key || row.value_key)
    )
    .sort((a, b) =>
      String(
        a.key ||
        a.value_key ||
        ""
      ).localeCompare(
        String(
          b.key ||
          b.value_key ||
          ""
        )
      )
    );

  fieldTable.innerHTML = sorted
    .map(row => {
      const key =
        row.key ||
        row.value_key ||
        "";

      const type =
        row.value_type ||
        (
          row.value_num != null
            ? "num"
            : "text"
        );

      const value =
        row.value_num != null &&
        type !== "text"
          ? row.value_num
          : (
              row.value_text ??
              row.value ??
              ""
            );

      return `
        <tr>
          <td>${esc(
            row.server_rx_ts ||
            row.timestamp ||
            row.packet_ts ||
            ""
          )}</td>

          <td>${esc(
            row.source_ip ||
            ""
          )}</td>

          <td>${esc(
            row.source_port ??
            ""
          )}</td>

          <td>${esc(
            row.device_name ||
            row.device ||
            ""
          )}</td>

          <td>
            <strong>${esc(key)}</strong>
          </td>

          <td>${esc(type)}</td>

          <td>
            <code>${esc(
              String(value)
            )}</code>
          </td>
        </tr>
      `;
    })
    .join("");

  const copyButton =
    $("copyRawJsonBtn");

  if (copyButton &&
      !copyButton.dataset.bound) {

    copyButton.dataset.bound = "1";

    copyButton.addEventListener(
      "click",
      async () => {
        try {
          await navigator.clipboard.writeText(
            viewer.textContent || ""
          );

          copyButton.textContent =
            "Copied";

          setTimeout(() => {
            copyButton.textContent =
              "Copy JSON";
          }, 1200);

        } catch {
          copyButton.textContent =
            "Copy Failed";
        }
      }
    );
  }
}
/**
 * Creates or updates the chart associated with a device metric.
 */
function ensureDeviceChart(key, points) {

  renderDeviceMetricChart(key, points);
  return;

  if (liveCharts[key]) {
    liveCharts[key].data.datasets[0].data = points;
    liveCharts[key].update("none");
    return;
  }

  const chartId = "chart_" + metricDomId(key);
  // Resolve the required DOM resource and store it in `card`.
  let card = document.getElementById(chartId);

  if (!card) {

    card = document.createElement("div");
    card.className = "card";
    card.id = chartId;
    card.innerHTML = `
      <h3>${esc(key)}</h3>
      <div class="chartBox small">
        <canvas id="canvas_${metricDomId(key)}"></canvas>
      </div>
    `;

    $("processCharts").appendChild(card);
  }

  const ctx = card.querySelector("canvas");

  liveCharts[key] = new Chart(ctx, {
    type: "line",
    data: {
      datasets: [{
        label: key,
        data: points,
        borderWidth: 2,
        tension: 0.3,
        pointRadius: 2,
        fill: false,
        spanGaps: true
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: {
        intersect: false,
        mode: "nearest"
      },
      plugins: {
        legend: {
          labels: {
            color: "white"
          }
        }
      },
      scales: {
        x: {
          /* A numeric millisecond axis works with Chart.js and the offline
             fallback without requiring the optional date adapter CDN. */
          type: "linear",
          ticks: {
            color: "white"
          },
          grid: {
            color: "#374151"
          }
        },
        y: {
          ticks: {
            color: "white"
          },
          grid: {
            color: "#374151"
          }
        }
      }
    }
  });
  registerActiveChart(liveCharts[key], deviceWindowMs);
}

function installDeviceChartTooltip() {
  const charts = $("processCharts");
  if (!charts || charts.dataset.tooltipBound === "true") return;
  charts.dataset.tooltipBound = "true";
  const show = event => {
    const svg = event.target.closest?.("svg.deviceSvgChart");
    if (!svg) return;
    const card = svg.closest(".deviceSvgChartCard");
    const key = svg.dataset.metricKey;
    const points = (liveChartRows[key] || []).filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));
    if (!points.length) return;
    const rect = svg.getBoundingClientRect();
    const viewX = ((event.clientX - rect.left) / Math.max(1, rect.width)) * 640;
    const ratio = Math.max(0, Math.min(1, (viewX - 58) / (640 - 70)));
    const targetTime = points[0].x + ratio * Math.max(1, points[points.length - 1].x - points[0].x);
    let index = 0;
    for (let i = 1; i < points.length; i++) if (Math.abs(points[i].x-targetTime) < Math.abs(points[index].x-targetTime)) index = i;
    const point = points[index], previous = points[index-1], latest = points[points.length-1];
    const unit = telemetryUnitForKey(key, point.unit);
    const localStamp = text => {
      const value = parseTs(text);
      return Number.isFinite(value) ? new Date(value).toLocaleString([], { year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", second:"2-digit", fractionalSecondDigits:3, timeZoneName:"short" }) : text;
    };
    const lines = [
      `<strong>${esc(DEVICE || point.device || "Device")} · ${esc(key)}</strong>`,
      `Selected: <b>${esc(point.y)}${unit ? ` ${esc(unit)}` : ""}</b>`,
      `At: ${esc(localStamp(point.timestamp || point.x))}`,
      `Latest: ${esc(latest.y)}${unit ? ` ${esc(unit)}` : ""} · ${esc(localStamp(latest.timestamp || latest.x))}`
    ];
    if (previous) lines.push(`Previous: ${esc(previous.y)}${unit ? ` ${esc(unit)}` : ""} · ${esc(localStamp(previous.timestamp || previous.x))}`);
    else lines.push("Previous: no earlier sample in this window");
    const tooltip = card.querySelector(".device-chart-tooltip");
    tooltip.innerHTML = lines.join("<br>");
    tooltip.hidden = false;
    tooltip.style.left = `${Math.max(8, Math.min(window.innerWidth-tooltip.offsetWidth-8,event.clientX+14))}px`;
    tooltip.style.top = `${Math.max(8, Math.min(window.innerHeight-tooltip.offsetHeight-8,event.clientY+14))}px`;
  };
  charts.addEventListener("pointermove", show);
  charts.addEventListener("pointermove", event => {
    const svg=event.target.closest?.("svg.deviceSvgChart");
    deviceHoveredChart=svg?.dataset.metricKey || "";
  });
  charts.addEventListener("pointerdown", event => { if (event.pointerType === "touch") show(event); });
  charts.addEventListener("pointerout", event => {
    const svg = event.target.closest?.("svg.deviceSvgChart");
    if (!svg || svg.contains(event.relatedTarget)) return;
    const tooltip = svg.closest(".deviceSvgChartCard")?.querySelector(".device-chart-tooltip");
    if (tooltip) tooltip.hidden = true;
    if (deviceHoveredChart === svg.dataset.metricKey) {
      deviceHoveredChart = "";
      const key = svg.dataset.metricKey;
      if (pendingDeviceChartKeys.has(key)) {
        renderDeviceMetricChart(key, liveChartRows[key] || []);
        pendingDeviceChartKeys.delete(key);
      }
    }
  });
  charts.addEventListener("focusin", event => {
    const svg = event.target.closest?.("svg.deviceSvgChart");
    if (svg) { const r=svg.getBoundingClientRect(); show({target:svg,clientX:r.left+r.width/2,clientY:r.top+30}); }
  });
}
/**
 * Merges one matching live row into bounded table and chart state.
 */
function appendLiveDeviceRow(row) {

  if (!row) {
    return;
  }

  const key = String(
    row.key ||
    row.value_key ||
    ""
  ).trim();

  if (!key) {
    return;
  }

  const point = livePointFromRow(row);

  if (!point) {
    return;
  }

  if (!liveChartRows[key]) {
    liveChartRows[key] = [];
  }

  liveChartRows[key].push(point);
  liveChartRows[key].sort((a, b) => Number(a.x) - Number(b.x));

  trimPointSeries(
    liveChartRows[key],
    deviceWindowMs(),
    300
  );

  pendingDeviceChartKeys.add(key);
  if (!deviceChartRenderTimer) {
    deviceChartRenderTimer = setTimeout(() => {
      deviceChartRenderTimer = null;
      [...pendingDeviceChartKeys].forEach(metricKey => {
        if (metricKey === deviceHoveredChart) return;
        renderDeviceMetricChart(
          metricKey,
          liveChartRows[metricKey] || []
        );
        pendingDeviceChartKeys.delete(metricKey);
      });
    }, 500);
  }
}

/**
 * Coalesces rapid summary and table changes into one browser-frame render.
 */
function scheduleDeviceLiveChrome() {
  if (deviceChromeRenderTimer) return;

  deviceChromeRenderTimer = setTimeout(() => {
    deviceChromeRenderTimer = null;
    renderDeviceSummaryCards(
      $("dbSelect")?.value || App.db,
      $("range")?.value || App.range
    );
    $("deviceTable").innerHTML =
      rowTableDevice(latestRows);
    const now = new Date();
    renderDeviceHealthState("online", now.toLocaleString());
    $("alarmPanel").innerHTML = `
      <div class="alarmCard healthy">
        <div class="alarmIcon">&#10003;</div>
        <div><h3>SYSTEM HEALTHY</h3><p>Live telemetry is being received</p></div>
      </div>
    `;
  }, 1000);
}

/**
 * Renders normalized device rows into the latest-data table.
 */
function rowTableDevice(rows) {

  return rows.map(r => `

    <tr>

      <td>${esc(r.server_rx_ts || r.timestamp || "")}</td>

      <td>${esc(r.device_ts || "")}</td>

      <td>${esc(r.packet_ts || "")}</td>

      <td>${esc(r.latency_ms ?? "")}</td>

      <td>${esc(r.channel_name || r.channel || "")}</td>

      <td>${esc(r.device_name || r.device || "")}</td>

      <td>${esc(r.subdevice_name || r.subdevice || "")}</td>

      <td>${esc(r.process_name || r.process || "")}</td>

      <td>${esc(r.subprocess_name || r.subprocess || "")}</td>

      <td>${esc(r.key || r.value_key || "")}</td>

      <td>
        ${esc(
          r.value_type === "text"
            ? (r.value_text || "")
            : (r.value_num ?? r.value ?? "")
        )}
      </td>

      <td>
        ${r.anomaly ? "YES" : "NO"}
      </td>

      <td>${esc(r.reason || "")}</td>

    </tr>

  `).join("");
}

/**
 * Loads and renders the selected device's API-backed page state.
 */
async function loadDevicePage() {
  const generation = ++deviceLoadGeneration;

  const db =
    $("dbSelect").value || App.db;

  const range =
    $("range").value;

  $("deviceTitle").textContent =
    "Device: " + DEVICE;

  /*
    latest rows
  */

  let graphHistory;
  try {
    const packets = await api(
      "/api/history/packets?db=" + encodeURIComponent(db) +
      "&device=" + encodeURIComponent(QUERY_DEVICE) +
      "&range=" + encodeURIComponent(range),
      30000
    );
    graphHistory = telemetryRowsFromPackets(packets, DEVICE);
    if (Array.isArray(packets)) {
  const rawPacketRows = packets
    .flatMap(packet => {
      const raw =
        packet?.payload ||
        packet?.raw_json ||
        null;

      if (!raw) {
        return [];
      }

      return [{
        timestamp:
          packet.server_rx_ts ||
          packet.timestamp ||
          packet.packet_ts ||
          "",

        server_rx_ts:
          packet.server_rx_ts ||
          packet.timestamp ||
          "",

        packet_ts:
          packet.packet_ts ||
          "",

        source_ip:
          packet.source_ip ||
          "",

        source_port:
          packet.source_port ||
          "",

        device_name:
          packet.device_name ||
          packet.device ||
          DEVICE,

        raw_json:
          typeof raw === "string"
            ? raw
            : JSON.stringify(raw)
      }];
    });

  renderCompleteTelemetryPayload(
    rawPacketRows
  );
}
  } catch {
    try {
      graphHistory = await api(
        "/api/page/telemetry?db=" + encodeURIComponent(db) +
        "&device=" + encodeURIComponent(QUERY_DEVICE) +
        "&range=" + encodeURIComponent(range),
        30000
      );
    } catch {
      /* Keep the fallback bounded. The browser must never pull an entire shard
         merely because the preferred history endpoint is unavailable. */
      graphHistory = [];
    }
  }
  if (generation !== deviceLoadGeneration) return;
  let latest = Array.isArray(graphHistory)
    ? graphHistory.slice(0, 300)
    : [];

  latest = Array.isArray(latest) ? latest : [];
  graphHistory = Array.isArray(graphHistory) ? graphHistory : [];

  const hasExpandedValues = rows =>
    rows.some(row =>
      String(row.key || row.value_key || "").trim() &&
      (row.value != null || row.value_num != null || row.value_text != null)
    );

  if (!hasExpandedValues(graphHistory)) {
    try {
      const indexed = await api(
        "/api/page/telemetry?db=" + encodeURIComponent(db) +
        "&device=" + encodeURIComponent(QUERY_DEVICE) +
        "&range=" + encodeURIComponent(range),
        30000
      );
      if (generation !== deviceLoadGeneration && generation !== 0) return;
      if (Array.isArray(indexed) && indexed.length) graphHistory = indexed;
    } catch {
      /* Keep the bounded raw-packet fallback below for packet-only shards. */
    }
  }

  if (!hasExpandedValues(latest) || !hasExpandedValues(graphHistory)) {
    const rawRows = await latestRawRowsForDevice(db, DEVICE);
    if (rawRows.length) {
      if (!hasExpandedValues(latest)) latest = rawRows.slice().reverse();
      if (!hasExpandedValues(graphHistory)) graphHistory = rawRows;
    }
  }

  // APIs may return packet samples oldest-first and expanded rows newest-first.
  // Keep one chronological source for charts and derive the table from its tail.
  graphHistory = graphHistory
    .filter(row => Number.isFinite(parseTs(
      row.server_rx_ts || row.timestamp || row.packet_ts
    )))
    .sort((a, b) =>
      parseTs(a.server_rx_ts || a.timestamp || a.packet_ts) -
      parseTs(b.server_rx_ts || b.timestamp || b.packet_ts)
    );

  const windowMs = rangeToMs(range);
  if (windowMs && graphHistory.length) {
    const newest = Math.max(...graphHistory.map(row =>
      parseTs(row.server_rx_ts || row.timestamp || row.packet_ts)
    ));
    graphHistory = graphHistory.filter(row =>
      parseTs(row.server_rx_ts || row.timestamp || row.packet_ts) >=
      newest - windowMs
    );
    latest = graphHistory.slice(-300).reverse();
  }

  /* A compact database or a just-started writer can temporarily return no
     latest-row snapshot. The bounded device history contains the same row
     shape and is a safe bootstrap source for cards, tables, and charts. */
  if (!latest.length && graphHistory.length) {
    latest = graphHistory.slice(-300).reverse();
  }
  if (!windowMs && graphHistory.length) {
    latest = graphHistory.slice(-300).reverse();
  }
  renderCompleteTelemetryPayload(
  latest
);
  await loadDeviceTotals(db, latest);
/*
  DEVICE HEALTH
*/

let deviceStatus = "offline";

let lastSeen = null;

if (latest.length > 0) {

  lastSeen = new Date(

    String(
      latest[0].server_rx_ts ||
      latest[0].timestamp ||
      ""
    ).replace(" ", "T")

  );

  const diff =
    (Date.now() - lastSeen.getTime()) / 1000;

  if (diff >= 0 && diff <= 15) {

    deviceStatus = "online";

  } else if ((diff > 15 && diff <= 30) || diff < 0) {

    deviceStatus = "warning";

  }
}

renderDeviceHealthState(
  deviceStatus,
  lastSeen ? lastSeen.toLocaleString() : "No telemetry"
);
/*
  ALARM PANEL
*/

const alarms = [];

if (deviceStatus === "offline") {

  alarms.push({
    level: "critical",
    text: "Device communication lost"
  });
}

if (latest.some(x => x.anomaly)) {

  alarms.push({
    level: "warning",
    text: "Anomalies detected in telemetry"
  });
}

$("alarmPanel").innerHTML = alarms.length

? alarms.map(a => `

    <div class="alarmCard ${a.level}">

      <div class="alarmIcon">
        âš 
      </div>

      <div>

        <h3>${a.level.toUpperCase()}</h3>

        <p>${esc(a.text)}</p>

      </div>

    </div>

  `).join("")

: `

  <div class="alarmCard healthy">

    <div class="alarmIcon">
      âœ“
    </div>

    <div>

      <h3>SYSTEM HEALTHY</h3>

      <p>
        No active alarms detected
      </p>

    </div>

  </div>
`;
  /*
    summary cards
  */

  renderDeviceSummaryCards(db, range);
  /*
  DIGITAL TWIN STATE
*/

const twinState = await api(

  "/api/device/state?db=" +

  encodeURIComponent(db) +

  "&device=" +

  encodeURIComponent(QUERY_DEVICE)

);

setDigitalTwinFromApi(twinState);

if (!Object.keys(digitalTwinState).length) {
  latest.slice().reverse().forEach(updateDigitalTwinFromLiveRow);
}

/*
  PROCESS FLOW VISUALIZATION
*/

const processNames = [

  ...new Set(

    latest

      .map(x => x.process || x.process_name)

      .filter(Boolean)

  )

];

$("processFlow").innerHTML = processNames.map((p, idx) => `

  <div class="processNode active">

    <div class="processPulse"></div>

    <div class="processContent">

      <h3>${esc(p)}</h3>

      <p>
        Live Telemetry Active
      </p>

    </div>

  </div>

  ${idx < processNames.length - 1
    ? '<div class="processArrow">â†’</div>'
    : ''
  }

`).join("");
  /*
    latest table
  */

  $("deviceTable").innerHTML =
    rowTableDevice(latest);
    latestRows = [...latest];

  /*
    no data
  */

  if (!latest || latest.length === 0) {

    $("processCharts").innerHTML = `

      <div class="card" data-no-device-data>

        <h3>No Data Available</h3>

      </div>

    `;

    return;
  }

  /*
    unique keys
  */

  const keys = [

    ...new Set(

      graphHistory

        .map(r => r.key || r.value_key)

        .filter(Boolean)

    )

  ].sort((left, right) =>
    deviceMetricPriority(left) - deviceMetricPriority(right) ||
    String(left).localeCompare(String(right))
  );

  /*
    clear removed charts
  */

  const activeIds = new Set();
  const emptyCard =
    $("processCharts").querySelector("[data-no-device-data]");
  if (emptyCard) emptyCard.remove();

  for (const key of keys) {

    activeIds.add("chart_" + metricDomId(key));

    const rows = graphHistory
  .filter(row =>
    String(row.key || row.value_key || "") === String(key) &&
    (!row.value_type ||
      ["num", "number", "numeric", "integer", "float", "real"]
        .includes(String(row.value_type).toLowerCase()))
  )
  .slice()
  .sort((a, b) =>
    parseTs(
      a.server_rx_ts ||
      a.timestamp ||
      a.packet_ts
    ) -
    parseTs(
      b.server_rx_ts ||
      b.timestamp ||
      b.packet_ts
    )
  );

    const points = rows

      .map(r => ({

        x: parseTs(
          r.server_rx_ts ||
          r.timestamp ||
          r.packet_ts ||
          ""
        ),

        y: Number(

          r.value_num ??

          r.value ??

          0
        ),
        timestamp: r.server_rx_ts || r.timestamp || r.packet_ts || "",
        device: r.device_name || r.device || DEVICE,
        key: r.key || r.value_key || key,
        unit: r.unit || r.value_unit || "",
        status: r.status || r.state || r.health || ""
      }))

      .filter(p =>

        Number.isFinite(p.x) &&
        Number.isFinite(p.y)

      );

    if (points.length === 0) {
      continue;
    }

    const chartId =
      "chart_" + metricDomId(key);

    renderDeviceMetricChart(key, points);
    liveChartRows[key] = points.slice();
    continue;

    let card =
      document.getElementById(chartId);

    /*
      create chart
    */

    if (!card) {

      card = document.createElement("div");

      card.className = "card";

      card.id = chartId;

      card.innerHTML = `

        <h3>${esc(key)}</h3>

        <div class="chartBox small">

          <canvas id="canvas_${metricDomId(key)}"></canvas>

        </div>

      `;

      $("processCharts").appendChild(card);

      const ctx =
        card.querySelector("canvas");

      liveCharts[key] = new Chart(ctx, {

        type: "line",

        data: {

          datasets: [{

            label: key,

            data: points,

            borderWidth: 2,

            tension: 0.3,

            pointRadius: 2,

            fill: false

          }]

        },

        options: {

          responsive: true,

          maintainAspectRatio: false,

          animation: false,

          parsing: false,

          normalized: true,

          interaction: {

            intersect: false,

            mode: "nearest"

          },

          plugins: {

            legend: {

              labels: {
                color: "white"
              }

            }

          },

          scales: {

            x: {

              type: "linear",

              ticks: {
                color: "white"
              },

              grid: {
                color: "#374151"
              }

            },

            y: {

              ticks: {
                color: "white"
              },

              grid: {
                color: "#374151"
              }

            }

          }

        }

      });

      liveChartRows[key] = points.slice();

    } else {

      /*
        update chart
      */

      liveCharts[key]
        .data
        .datasets[0]
        .data = points;

      liveCharts[key].update("none");

      liveChartRows[key] = points.slice();
    }
  }

  /*
    remove old charts
  */

  Object.keys(liveCharts).forEach(key => {

    const id = "chart_" + metricDomId(key);

    if (!activeIds.has(id)) {

      liveCharts[key].destroy();

      delete liveCharts[key];

      const el =
        document.getElementById(id);

      if (el) {
        el.remove();
      }
    }
  });
}

/**
 * Initializes URL state, controls, page data, and the live WebSocket listener.
 */
async function initDevice() {

  if (!DEVICE) {

    document.body.innerHTML = `

      <h2 style="
        color:white;
        padding:20px;
      ">
        No device selected
      </h2>

    `;

    return;
  }

  await loadDbSelect(
    $("dbSelect")
  );
  /* Keep the newest listed shard as the only database eligible for live WS
     merging, even when this page is opened on an older historical database. */
  deviceLiveDb = $("dbSelect").value;

  if (DB_FROM_URL) {
    const exists = Array.from($("dbSelect").options)
      .some(option => option.value === DB_FROM_URL);
    if (exists) {
      $("dbSelect").value = DB_FROM_URL;
      App.db = DB_FROM_URL;
    }
  }

  updateDevicePageNavigation();

  if (RANGE_FROM_URL) {
    const rangeExists = Array.from($("range").options)
      .some(option => option.value === RANGE_FROM_URL);
    if (rangeExists) {
      $("range").value = RANGE_FROM_URL;
      App.range = RANGE_FROM_URL;
    }
  }

  $("range").onchange =
    loadDevicePage;

  $("dbSelect").onchange = () => {
    App.db = $("dbSelect").value;
    updateDevicePageNavigation();
    loadDevicePage();
  };

  $("refreshBtn").onclick =
    loadDevicePage;

  /*
    initial load
  */

  await loadDevicePage();
  initScadaSocket();

function applyIncomingDeviceRows(rows) {
  (Array.isArray(rows) ? rows : []).forEach(row => {
    const key = String(row.key || row.value_key || "").trim();
    if (!key || !isSelectedDeviceRow(row)) return;

    deviceLastLiveAt = Date.now();
    appendLiveDeviceRow(row);
    updateDigitalTwinFromLiveRow(row);
    latestRows.unshift(row);
    deviceTotalRows++;
    if (row.anomaly) deviceTotalAnomalies++;
    if (latestRows.length > 300) latestRows.length = 300;
    scheduleDeviceLiveChrome();
  });
}

onScadaEvent(msg => {

  // Historical database selections are immutable and must not receive live
  // packets belonging to the newest database.
  if ($("dbSelect").value !== deviceLiveDb) return;

  let rows = liveRowsFromScadaEvent(msg);

  if (!rows.some(row =>
    String(row.key || row.value_key || "").trim() !== "" &&
    Number.isFinite(Number(row.value_num ?? row.value))
  )) {
    const recoveredRows =
      deviceRowsFromAnyLiveMessage(msg);
    if (recoveredRows.length) rows = recoveredRows;
  }

  applyIncomingDeviceRows(rows);
});

  /* Older executables broadcast packet metadata without expanded fields.
     Polling the compact latest-packet API keeps live graphs and tables moving
     until the upgraded backend is deployed. */
  setInterval(async () => {
    if ($("dbSelect").value !== deviceLiveDb) return;
    const recovered = await latestRawRowsForDevice(
      $("dbSelect").value,
      DEVICE
    );
    if (!recovered.length) return;
    const signature =
      String(recovered[0].timestamp || "") + "|" +
      String(recovered[0].channel || "");
    if (signature === lastRecoveredRawPacket) return;
    lastRecoveredRawPacket = signature;
    applyIncomingDeviceRows(recovered);
  }, 750);

  setInterval(() => {
    if (
      deviceLastLiveAt &&
      Date.now() - deviceLastLiveAt > 15000
    ) {
      renderDeviceHealthState(
        "offline",
        "NO LIVE TELEMETRY"
      );
      return;
    }

    if (
      !deviceLastLiveAt &&
      (!App.wsConnected || Date.now() - (App.wsLastMessageAt || 0) > 15000)
    ) {
      renderDeviceHealthState(
        "offline",
        "NO LIVE TELEMETRY"
      );
      return;
    }
  }, 5000);

}

initDevice().catch(err => {

  document.body.innerHTML = `

    <pre style="
      color:white;
      background:#111827;
      padding:20px;
    ">

Device page error:

${esc(err.message)}

    </pre>

  `;
});
