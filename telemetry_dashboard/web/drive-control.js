/*
 * ================================================================
 * DRIVE & PHYSICAL CONTROL PANEL
 * ================================================================
 *
 * IMPORTANT:
 *
 * 1. Every telemetry field is tracked independently.
 * 2. Identity = SOURCE IP + DEVICE + CHANNEL + FIELD.
 * 3. Physical buttons are momentary indications.
 * 4. Physical switches are ON/OFF indications.
 * 5. Knobs show their actual telemetry value.
 * 6. No commands are sent from this page.
 * 7. When the source device stops sending telemetry, its controls
 *    automatically return to their safe visual state.
 *
 * ================================================================
 */

const driveState = Object.create(null);
const latest = Object.create(null);
const history = Object.create(null);

/*
 * A control/telemetry value is considered LIVE only while
 * fresh packets are actually arriving.
 *
 * This prevents old database values from appearing as if
 * the simulator is still running.
 */
const LIVE_TIMEOUT_MS = 5000;
/*
 * Device/control telemetry timeout.
 *
 * We use the packet receive time, not the browser page load time.
 */
const DRIVE_TELEMETRY_TIMEOUT_MS = 5000;

/*
 * Last packet received from each source/device.
 *
 * This is important for momentary controls. If a device sends
 * several fields in separate packets, the control state remains
 * valid while the device is still actively transmitting.
 */
const deviceLastRx = {};


/* ================================================================
   ACTUAL PHYSICAL CONTROLS
   ================================================================ */

const BUTTON_IDS = [
  "DRIVES_RESET",
  "OPTICS_RESET",
  "LRF_RESET",
  "CCE_RESET",
  "PARK",
  "ABORT",
  "COMBAT",
  "BCU",
  "PREPAR",
  "UNCAG",
  "DAY",
  "LOW_LIGHT",
  "THERMAL",
  "DROP",
  "FIRE",
  "LRF",
  "GButton1",
  "GButton2",
  "GButton3",
  "GButton4",
  "GButton5",
  "GButton6"
];

const SWITCH_IDS = [
  "MAIN_POWER_ON",
  "DRIVES_ON",
  "OPTICS_ON",
  "LRF_ON",
  "CCE_ON",
  "LOCK",
  "STRELETS_CH1_ON",
  "STRELETS_CH2_ON",
  "SINGLE",
  "CTRL_SRC_WCS",
  "HEAT_FILTER_ON",
  "LAUNCH_KEY_EN",
  "TARGET_SPEED_FAST",
  "CHASE_HEAD",
  "CHASE_TAIL",
  "TARGET_SPEED_SLOW",
  "CTRL_SRC_CCE",
  "SALVO",
  "UNLOCK"
];

const KNOB_IDS = [
  "MODE",
  "FREQUENCY"
];


/* ================================================================
   BASIC HELPERS
   ================================================================ */

function db() {
  return App.db || "";
}


function key(r) {
  return String(
    r?.key ??
    r?.value_key ??
    r?.field_name ??
    ""
  ).trim();
}


function rawDevice(r) {
  return String(
    r?.device ??
    r?.device_name ??
    ""
  ).trim();
}


function device(r) {
  try {
    return canonicalDeviceName(rawDevice(r));
  } catch (_) {
    return rawDevice(r);
  }
}


function channel(r) {
  return String(
    r?.channel ??
    r?.channel_name ??
    ""
  ).trim();
}


function sourceIp(r) {
  return String(
    r?.source_ip ??
    r?.src_ip ??
    r?.ip ??
    ""
  ).trim();
}


function sourcePort(r) {
  return r?.source_port ??
    r?.src_port ??
    "";
}


function value(r) {

  if (r?.value_type === "text") {
    return r.value_text ?? "";
  }

  if (
    r?.value_type === "REAL" ||
    r?.value_type === "real"
  ) {
    return r.value_num ??
      r.value ??
      "";
  }

  return (
    r?.value ??
    r?.value_num ??
    r?.value_text ??
    ""
  );
}


function valueType(r) {

  if (r?.value_type) {
    return String(r.value_type);
  }

  const v = value(r);

  if (typeof v === "number") {
    return "REAL";
  }

  if (typeof v === "boolean") {
    return "BOOLEAN";
  }

  return "TEXT";
}


function timestamp(r) {
  return String(
    r?.timestamp ??
    r?.server_rx_ts ??
    r?.ts ??
    r?.time ??
    new Date().toISOString()
  );
}


function parseNumber(v) {

  if (
    typeof v === "number" &&
    Number.isFinite(v)
  ) {
    return v;
  }

  if (typeof v !== "string") {
    return null;
  }

  const s = v.trim();

  if (!s) {
    return null;
  }

  const n = Number(s);

  return Number.isFinite(n)
    ? n
    : null;
}


function escapeHtml(v) {

  if (typeof esc === "function") {
    return esc(String(v ?? ""));
  }

  return String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}


function formatValue(v) {

  if (
    v === null ||
    v === undefined ||
    v === ""
  ) {
    return "--";
  }

  if (typeof v === "number") {

    return Number.isInteger(v)
      ? String(v)
      : String(v);
  }

  return String(v);
}


function formatTime(v) {

  if (!v) {
    return "--";
  }

  const d = new Date(v);

  if (Number.isNaN(d.getTime())) {
    return String(v);
  }

  return d.toLocaleTimeString();
}


/* ================================================================
   DEVICE / FIELD IDENTITY
   ================================================================ */

function makeId(r) {

  return [
    sourceIp(r),
    device(r),
    channel(r),
    key(r)
  ].join("::");
}


function deviceIdentity(r) {

  return [
    sourceIp(r),
    device(r)
  ].join("::");
}


/* ================================================================
   FRESHNESS
   ================================================================ */

function getReceiveTime(r) {

  if (
    r &&
    Number.isFinite(Number(r._receivedAtMs))
  ) {
    return Number(r._receivedAtMs);
  }

  const ts = Date.parse(timestamp(r));

  if (Number.isFinite(ts)) {
    return ts;
  }

  return 0;
}


/*
 * A control is active only when the source device is still alive.
 */
function controlActive(r) {

  if (!r || !isFresh(r)) {
    return false;
  }

  const v = value(r);

  const s =
    String(v)
      .trim()
      .toLowerCase();

  return [
    "1",
    "true",
    "on",
    "active",
    "enabled",
    "online",
    "alive",
    "pressed",
    "set",
    "high"
  ].includes(s)
  ||
  (
    typeof v === "number" &&
    Number.isFinite(v) &&
    v > 0.5
  )
  ||
  (
    typeof v === "string" &&
    Number.isFinite(Number(v)) &&
    Number(v) > 0.5
  );
}


/* ================================================================
   DRIVE IDENTIFICATION
   ================================================================ */

function isDriveRow(r) {

  const d =
    device(r)
      .trim()
      .toUpperCase();

  const ch =
    channel(r)
      .trim()
      .toUpperCase();

  const k =
    key(r)
      .trim()
      .toUpperCase();

  /*
   * ------------------------------------------------------------
   * PRIMARY DRIVE SOURCES
   * ------------------------------------------------------------
   *
   * If the backend identifies the source as DRIVE,
   * keep EVERY field.
   */
  if (
    d === "DRIVE_UNIT" ||
    d === "DRIVE" ||
    d.includes("DRIVE_UNIT") ||
    d.includes("DRIVE")
  ) {
    return true;
  }

  /*
   * ------------------------------------------------------------
   * DRIVE TRANSPORT CHANNELS
   * ------------------------------------------------------------
   */
  if (
    ch === "DRIVE_WCS" ||
    ch === "TRACKER_PUBLISH" ||
    ch.includes("DRIVE") ||
    ch.includes("MOTOR")
  ) {
    return true;
  }

  /*
   * ------------------------------------------------------------
   * LCU DRIVE TELEMETRY
   * ------------------------------------------------------------
   *
   * Some simulator packets are published through LCU.
   */
  if (
    (
      d === "LCU_UNIT" ||
      d.includes("LCU")
    ) &&
    (
      ch === "LCU_TRANSPORT" ||
      ch.includes("DRIVE") ||
      ch.includes("MOTOR") ||
      ch.includes("TRACKER")
    )
  ) {
    return true;
  }

  return false;
}

function isControlId(k) {

  const normalized =
    String(k)
      .trim()
      .toUpperCase();

  return (
    BUTTON_IDS.some(
      x => x.toUpperCase() === normalized
    )
    ||
    SWITCH_IDS.some(
      x => x.toUpperCase() === normalized
    )
    ||
    KNOB_IDS.some(
      x => x.toUpperCase() === normalized
    )
  );
}


/* ================================================================
   EXACT CONTROL LOOKUP
   ================================================================ */
function isFresh(row) {

  if (!row) {
    return false;
  }

  /*
   * LIVE PACKETS:
   *
   * Always use browser receive time first.
   * This prevents an old simulator/device timestamp
   * from making a live packet look stale.
   */
  if (
    Number.isFinite(
      Number(row._lastSeen)
    )
  ) {

    return (
      Date.now() -
      Number(row._lastSeen)
    ) <= LIVE_TIMEOUT_MS;
  }

  /*
   * Device-level heartbeat fallback.
   */
  const id =
    deviceIdentity(row);

  const lastDevicePacket =
    Number(
      deviceLastRx[id] || 0
    );

  if (lastDevicePacket > 0) {

    return (
      Date.now() -
      lastDevicePacket
    ) <= DRIVE_TELEMETRY_TIMEOUT_MS;
  }

  return false;
}


function findControlRow(id) {

  const target =
    String(id)
      .trim()
      .toUpperCase();

  const candidates =
    Object.values(latest)
      .filter(r => {

        const k =
          key(r)
            .trim()
            .toUpperCase();

        return (
          k === target ||
          k.endsWith("_" + target) ||
          k.endsWith("." + target) ||
          k.endsWith("-" + target) ||
          k.includes("_" + target + "_")
        );
      });

  if (!candidates.length) {
    return null;
  }

  /*
   * Prefer an exact field name.
   */
  const exact =
    candidates.find(r =>
      key(r)
        .trim()
        .toUpperCase() === target
    );

  if (exact) {
    return exact;
  }

  /*
   * Prefer a currently-live row.
   */
  const live =
    candidates.find(r =>
      isFresh(r)
    );

  return live ||
    candidates[0] ||
    null;
}

/* ================================================================
   LIVE PAYLOAD
   ================================================================ */

function rowsFromMessage(msg) {

  if (!msg) {
    return [];
  }

  const rows =
    liveRowsFromScadaEvent(msg);

  const now =
    Date.now();

  return rows.map(row => {

    const normalizedDevice =
      canonicalDeviceName(
        row.device ||
        row.device_name ||
        canonicalDeviceFromChannel(
          row.channel ||
          row.channel_name ||
          msg.channel ||
          msg.channel_name ||
          ""
        )
      );

    const normalizedIp =
      row.source_ip ||
      msg.source_ip ||
      "";

    const normalizedChannel =
      row.channel ||
      row.channel_name ||
      msg.channel ||
      msg.channel_name ||
      "";

    return {
      ...row,

      device:
        normalizedDevice,

      source_ip:
        normalizedIp,

      source_port:
        row.source_port ||
        msg.source_port ||
        0,

      channel:
        normalizedChannel,

      timestamp:
        row.timestamp ||
        row.server_rx_ts ||
        msg.timestamp ||
        msg.server_rx_ts ||
        new Date().toISOString(),

      /*
       * Browser receive timestamp.
       */
      _receivedAtMs:
        now
    };
  });
}


/* ================================================================
   UPDATE LIVE STATE
   ================================================================ */

function updateRows(rows, live = true) {

  if (!Array.isArray(rows)) {
    return;
  }

  const receivedAt = Date.now();

  rows.forEach(r => {

    const k = key(r);

    if (!k) {
      return;
    }

    const d = device(r);
    const ip = String(
      r.source_ip ??
      r.src_ip ??
      ""
    ).trim();

    const ch = String(
      r.channel ??
      r.channel_name ??
      ""
    ).trim();

    /*
     * Exact telemetry identity:
     *
     * SOURCE IP
     *     +
     * DEVICE
     *     +
     * CHANNEL
     *     +
     * FIELD
     */
    const id =
      ip +
      "::" +
      d +
      "::" +
      ch +
      "::" +
      k;

    const previous =
      latest[id];

    const changed =
      previous !== undefined &&
      String(value(previous)) !==
      String(value(r));

    /*
     * IMPORTANT:
     *
     * _lastSeen is the browser receive time.
     * Never use the simulator/device timestamp to
     * decide whether the live connection is alive.
     */
    const normalized = {
      ...r,

      device: d,

      source_ip: ip,

      source_port:
        r.source_port ??
        r.src_port ??
        0,

      channel: ch,

      _lastSeen: live ? receivedAt : getReceiveTime(r),

      _liveTimestamp:
        r.server_rx_ts ||
        r.server_timestamp ||
        r.timestamp ||
        new Date(receivedAt).toISOString()
    };

    if (previous && Date.parse(timestamp(previous)) > Date.parse(timestamp(r))) return;
    latest[id] = normalized;

    /*
     * THIS WAS MISSING.
     *
     * Every live packet refreshes the source/device
     * heartbeat.
     */
    const deviceId =
      ip +
      "::" +
      d;

    deviceLastRx[deviceId] =
      Math.max(deviceLastRx[deviceId] || 0, live ? receivedAt : getReceiveTime(r));

    driveState[id] = {
      changed,
      at: receivedAt
    };

    /*
     * Keep numeric history for every numeric DRIVE field.
     */
    updateHistory(
      id,
      normalized
    );
  });

  scheduleDriveRender();
}


/* ================================================================
   DRIVE SUMMARY
   ================================================================ */

let driveTablePage = 0;
let driveGraphPage = 0;
let driveRenderScheduled = false;
const historyOrder = new Map();
function updateHistory(id, row) {
  if (!isDriveRow(row)) return;
  const number = parseNumber(value(row));
  if (number === null) return;
  if (!history[id]) history[id] = [];
  const points = history[id];
  const time = Date.parse(timestamp(row)) || Date.now();
  if (!points.length || points[points.length - 1].time !== time) points.push({ time, value: number });
  if (points.length > 240) points.splice(0, points.length - 240);
  historyOrder.delete(id);
  historyOrder.set(id, true);
  while (historyOrder.size > 256) {
    const oldest = historyOrder.keys().next().value;
    historyOrder.delete(oldest);
    delete history[oldest];
  }
}
function scheduleDriveRender() {
  if (driveRenderScheduled) return;
  driveRenderScheduled = true;
  requestAnimationFrame(() => { driveRenderScheduled = false; render(); });
}

function renderSummary(driveRows) {

  const numeric =
    driveRows.filter(
      r => parseNumber(value(r)) !== null
    );

  const sourceIps =
    [
      ...new Set(
        driveRows
          .map(sourceIp)
          .filter(Boolean)
      )
    ];

  const channels =
    [
      ...new Set(
        driveRows
          .map(channel)
          .filter(Boolean)
      )
    ];

  const freshRows =
    driveRows.filter(isFresh);

  $("summary").innerHTML = [

    {
      label: "TOTAL FIELDS",
      value: driveRows.length,
      sub: "ALL RECEIVED"
    },

    {
      label: "NUMERIC",
      value: numeric.length,
      sub: "PLOT CAPABLE"
    },

    {
      label: "SOURCE IP",
      value: sourceIps.length,
      sub:
        sourceIps.join(", ") || "--"
    },

    {
      label: "CHANNELS",
      value: channels.length,
      sub:
        channels.join(", ") || "--"
    }

  ].map(x => `
    <div class="metric">

      <span>${escapeHtml(x.label)}</span>

      <strong>${escapeHtml(x.value)}</strong>

      <small>${escapeHtml(x.sub)}</small>

    </div>
  `).join("");

  $("driveFieldCount").textContent =
    String(driveRows.length);

  $("telemetryCount").textContent =
    `${driveRows.length} FIELDS`;

  $("driveSource").textContent =
    sourceIps.length
      ? `SOURCE: ${sourceIps.join(" · ")}`
      : "SOURCE: --";

  if (freshRows.length) {

    $("driveConnection").textContent =
      "ONLINE";

    $("driveConnection")
      .classList.add("online");

  } else {

    $("driveConnection").textContent =
      "OFFLINE";

    $("driveConnection")
      .classList.remove("online");
  }

  const latestTime =
    driveRows
      .map(timestamp)
      .sort()
      .at(-1);

  $("driveLastRx").textContent =
    latestTime
      ? formatTime(latestTime)
      : "--";
}


/* ================================================================
   COMPLETE DRIVE TABLE
   ================================================================ */

function renderDriveTable(driveRows) {

  const search =
    String(
      $("driveSearch")?.value || ""
    )
      .trim()
      .toLowerCase();

  const filtered =
    search
      ? driveRows.filter(r => {

          const text = [
            key(r),
            value(r),
            device(r),
            sourceIp(r),
            channel(r)
          ]
            .join(" ")
            .toLowerCase();

          return text.includes(search);
        })
      : driveRows;

  if (!filtered.length) {

    $("allDriveFields").innerHTML = `
      <tr>
        <td colspan="6"
            class="empty-cell">

          ${
            driveRows.length
              ? "No fields match the filter."
              : "Waiting for DRIVE telemetry..."
          }

        </td>
      </tr>
    `;

    return;
  }

  const pageCount = Math.max(1, Math.ceil(filtered.length / 100));
  driveTablePage = Math.max(0, Math.min(driveTablePage, pageCount - 1));
  $("driveTablePage").textContent = `${driveTablePage + 1}/${pageCount}`;
  $("driveTablePrevious").disabled = driveTablePage === 0;
  $("driveTableNext").disabled = driveTablePage + 1 >= pageCount;
  $("allDriveFields").innerHTML =
    filtered
      .sort((a, b) =>
        key(a).localeCompare(
          key(b)
        )
      )
      .slice(driveTablePage * 100, (driveTablePage + 1) * 100)
      .map(r => {

        const id =
          makeId(r);

        const st =
          driveState[id] || {};

        const fresh =
          isFresh(r);

        return `
          <tr class="
            ${
              st.changed &&
              Date.now() - st.at < 1500
                ? "row-changed"
                : ""
            }
          ">

            <td class="field-name">
              ${escapeHtml(key(r))}
            </td>

            <td class="field-value">
              ${escapeHtml(
                formatValue(value(r))
              )}
            </td>

            <td>
              ${escapeHtml(
                valueType(r)
              )}
            </td>

            <td>
              ${escapeHtml(
                sourceIp(r) || "--"
              )}

              ${
                sourcePort(r)
                  ? ":" +
                    escapeHtml(
                      sourcePort(r)
                    )
                  : ""
              }
            </td>

            <td>
              ${escapeHtml(
                channel(r) || "--"
              )}
            </td>

            <td>
              ${escapeHtml(
                formatTime(timestamp(r))
              )}

              ${
                fresh
                  ? ""
                  : " · STALE"
              }
            </td>

          </tr>
        `;
      })
      .join("");
}


/* ================================================================
   LIVE GRAPH ENGINE
   ================================================================ */

function drawGraph(
  canvas,
  points,
  label
) {

  if (!canvas) {
    return;
  }

  const ctx =
    canvas.getContext("2d");

  const width =
    canvas.width =
      canvas.clientWidth *
      devicePixelRatio;

  const height =
    canvas.height =
      canvas.clientHeight *
      devicePixelRatio;

  ctx.clearRect(
    0,
    0,
    width,
    height
  );

  if (
    !points ||
    points.length < 2
  ) {

    ctx.font =
      `${12 * devicePixelRatio}px Arial`;

    ctx.fillText(
      "Waiting for trend data...",
      16 * devicePixelRatio,
      30 * devicePixelRatio
    );

    return;
  }

  const values =
    points.map(p => p.value);

  let min =
    Math.min(...values);

  let max =
    Math.max(...values);

  if (min === max) {

    const pad =
      Math.abs(min) * 0.05 || 1;

    min -= pad;
    max += pad;
  }

  const padX =
    12 * devicePixelRatio;

  const padY =
    12 * devicePixelRatio;

  const plotW =
    width - padX * 2;

  const plotH =
    height - padY * 2;

  ctx.lineWidth =
    1 * devicePixelRatio;

  ctx.strokeStyle =
    "rgba(120,160,190,.16)";

  for (let i = 0; i < 4; i++) {

    const y =
      padY +
      plotH * (i / 3);

    ctx.beginPath();

    ctx.moveTo(
      padX,
      y
    );

    ctx.lineTo(
      width - padX,
      y
    );

    ctx.stroke();
  }

  ctx.strokeStyle =
    "#22d3ee";

  ctx.lineWidth =
    2 * devicePixelRatio;

  ctx.beginPath();

  points.forEach((p, i) => {

    const x =
      padX +
      (
        i /
        Math.max(
          points.length - 1,
          1
        )
      ) *
      plotW;

    const y =
      padY +
      (
        1 -
        (
          (p.value - min) /
          (max - min)
        )
      ) *
      plotH;

    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });

  ctx.stroke();

  const latestPoint =
    points[points.length - 1];

  ctx.fillStyle =
    "#e5f7ff";

  ctx.font =
    `700 ${13 * devicePixelRatio}px Arial`;

  ctx.fillText(
    formatValue(
      latestPoint.value
    ),
    padX,
    padY +
      14 *
      devicePixelRatio
  );

  ctx.fillStyle =
    "#7f9ab0";

  ctx.font =
    `${10 * devicePixelRatio}px Arial`;

  ctx.fillText(
    `MIN ${formatValue(min)}`,
    padX,
    height -
      4 *
      devicePixelRatio
  );

  ctx.textAlign =
    "right";

  ctx.fillText(
    `MAX ${formatValue(max)}`,
    width - padX,
    height -
      4 *
      devicePixelRatio
  );

  ctx.textAlign =
    "left";
}


function renderGraphs(driveRows) {

  const numericRows =
    driveRows
      .filter(
        r =>
          parseNumber(value(r)) !== null
      )
      .sort((a, b) =>
        key(a).localeCompare(
          key(b)
        )
      );

  if (!numericRows.length) {

    $("driveGraphs").innerHTML = `
      <div class="empty-panel">
        No numeric DRIVE telemetry received yet.
      </div>
    `;

    return;
  }

  const pages = Math.max(1, Math.ceil(numericRows.length / 12));
  driveGraphPage = Math.max(0, Math.min(driveGraphPage, pages - 1));
  $("driveGraphPage").textContent = `${driveGraphPage + 1}/${pages}`;
  $("driveGraphPrevious").disabled = driveGraphPage === 0;
  $("driveGraphNext").disabled = driveGraphPage + 1 >= pages;
  $("driveGraphs").innerHTML =
    numericRows.slice(driveGraphPage * 12, (driveGraphPage + 1) * 12)
      .map(r => {

        const id =
          makeId(r);

        return `
          <article
            class="graph-card"
            data-graph-id="${escapeHtml(id)}"
          >

            <div class="graph-header">

              <div>

                <span>LIVE TREND</span>

                <h3>
                  ${escapeHtml(key(r))}
                </h3>

              </div>

              <strong>
                ${escapeHtml(
                  formatValue(
                    value(r)
                  )
                )}
              </strong>

            </div>

            <canvas
              class="drive-chart">
            </canvas>

            <div class="graph-footer">

              <span>
                ${escapeHtml(
                  sourceIp(r) || "--"
                )}
              </span>

              <span>
                ${escapeHtml(
                  channel(r) || "--"
                )}
              </span>

            </div>

          </article>
        `;
      })
      .join("");

  document
    .querySelectorAll(".graph-card")
    .forEach(card => {

      const id =
        card.dataset.graphId;

      const canvas =
        card.querySelector("canvas");

      drawGraph(
        canvas,
        history[id] || [],
        id
      );
    });
}


/* ================================================================
   PHYSICAL BUTTON PANEL
   ================================================================ */

function renderButtons() {

  $("buttonPanel").innerHTML =
    BUTTON_IDS
      .map((id, index) => {

        const r =
          findControlRow(id);

        const fresh =
          r &&
          isFresh(r);

        const on =
          fresh &&
          controlActive(r);

        let state =
          "NO TELEMETRY";

        if (r && fresh) {

          state =
            on
              ? "PRESSED"
              : "IDLE";

        } else if (r) {

          state =
            "OFFLINE";
        }

        return `
          <article
            class="
              physical-button
              ${on ? "control-active" : ""}
              ${r ? "control-seen" : "control-unseen"}
              ${!fresh && r ? "control-stale" : ""}
            "
            data-control-id="${escapeHtml(id)}"
          >

            <div
              class="
                button-lamp
                ${on ? "lit" : ""}
              "
            >
              <i></i>
            </div>

            <div class="control-name">
              ${escapeHtml(id)}
            </div>

            <div class="control-channel">
              CH ${index + 1}
            </div>

            <div class="control-state">
              ${escapeHtml(state)}
            </div>

          </article>
        `;
      })
      .join("");
}


/* ================================================================
   PHYSICAL SWITCH PANEL
   ================================================================ */

function renderSwitches() {

  $("switchPanel").innerHTML =
    SWITCH_IDS
      .map((id, index) => {

        const r =
          findControlRow(id);

        const fresh =
          r &&
          isFresh(r);

        const on =
          fresh &&
          controlActive(r);

        let state =
          "NO TELEMETRY";

        if (r && fresh) {

          state =
            on
              ? "ON"
              : "OFF";

        } else if (r) {

          state =
            "OFFLINE";
        }

        return `
          <article
            class="
              physical-switch
              ${on ? "control-active" : ""}
              ${r ? "control-seen" : "control-unseen"}
              ${!fresh && r ? "control-stale" : ""}
            "
            data-control-id="${escapeHtml(id)}"
          >

            <div class="switch-body">

              <div
                class="
                  switch-lever
                  ${on ? "switch-on" : ""}
                "
              >
                <span></span>
              </div>

            </div>

            <div class="switch-info">

              <div class="control-name">
                ${escapeHtml(id)}
              </div>

              <div class="control-channel">
                CH ${index + 16}
              </div>

              <div class="control-state">
                ${escapeHtml(state)}
              </div>

            </div>

          </article>
        `;
      })
      .join("");
}


/* ================================================================
   PHYSICAL KNOBS
   ================================================================ */

function renderKnobs() {

  $("knobPanel").innerHTML =
    KNOB_IDS
      .map((id, index) => {

        const r =
          findControlRow(id);

        const fresh =
          r &&
          isFresh(r);

        const raw =
          fresh
            ? parseNumber(
                value(r)
              )
            : null;

        const angle =
          raw === null
            ? -45
            : Math.max(
                -135,
                Math.min(
                  135,
                  (
                    (raw % 100) /
                    100
                  ) *
                  270 -
                  135
                )
              );

        const display =
          !r
            ? "--"
            : !fresh
              ? "OFFLINE"
              : formatValue(
                  value(r)
                );

        return `
          <article
            class="
              physical-knob
              ${r ? "control-seen" : "control-unseen"}
              ${!fresh && r ? "control-stale" : ""}
            "
            data-control-id="${escapeHtml(id)}"
          >

            <div class="knob-face">

              <div
                class="knob-pointer"
                style="
                  transform:
                    rotate(${angle}deg)
                "
              ></div>

            </div>

            <div class="knob-info">

              <div class="control-name">
                ${escapeHtml(id)}
              </div>

              <div class="control-channel">
                CH ${index + 52}
              </div>

              <strong>
                ${escapeHtml(display)}
              </strong>

            </div>

          </article>
        `;
      })
      .join("");
}


/* ================================================================
   CONTROL TELEMETRY TABLE
   ================================================================ */

function renderControlTelemetry() {

 const rows =
    Object.values(latest)
      .filter(r =>
        isControlId(key(r))
      )
      .sort((a, b) =>
        key(a).localeCompare(key(b))
      );
  if (!rows.length) {

    $("controlTelemetry").innerHTML = `
      <tr>
        <td
          colspan="6"
          class="empty-cell"
        >
          No control telemetry received yet.
          Physical controls remain visible.
        </td>
      </tr>
    `;

    return;
  }

  $("controlTelemetry").innerHTML =
    rows.map(r => {

      const fresh =
        isFresh(r);

      let display =
        formatValue(value(r));

      if (!fresh) {
        display = "OFFLINE";
      }

      return `
        <tr>

          <td class="field-name">
            ${escapeHtml(key(r))}
          </td>

          <td>
            ${escapeHtml(key(r))}
          </td>

          <td class="field-value">
            ${escapeHtml(display)}
          </td>

          <td>
            ${escapeHtml(
              device(r) || "--"
            )}
          </td>

          <td>
            ${escapeHtml(
              sourceIp(r) || "--"
            )}
          </td>

          <td>
            ${escapeHtml(
              formatTime(timestamp(r))
            )}
          </td>

        </tr>
      `;
    })
    .join("");
}


/* ================================================================
   COMPLETE RENDER
   ================================================================ */
function render() {

  const freshRows =
    Object.values(latest);

  const driveRows =
    freshRows
      .filter(isDriveRow);

  renderSummary(driveRows);

  renderDriveTable(driveRows);

  renderGraphs(driveRows);

  renderButtons();

  renderSwitches();

  renderKnobs();

  renderControlTelemetry();
}


/* ================================================================
   WEBSOCKET
   ================================================================ */

onScadaEvent(batch => updateRows(liveRowsFromScadaEvent(batch)));

window.addEventListener(
  "scada:connected",
  render
);


/* ================================================================
   INITIAL LOAD
   ================================================================ */

document.addEventListener(
  "DOMContentLoaded",
  async () => {

    await loadDbSelect(
      $("dbSelect")
    );

    App.db =
      $("dbSelect").value || "";

    initScadaSocket();

    /*
     * Database snapshot is useful for immediately populating
     * the page, but its timestamps determine whether it is still
     * considered LIVE.
     */
    try {
      await forEachTelemetryFieldPage(db(), "", rows => updateRows(rows, false));
    } catch (error) {
      $("telemetryCount").textContent = "Snapshot unavailable: " + error.message;
    }
    $("driveTablePrevious").onclick = () => { driveTablePage--; render(); };
    $("driveTableNext").onclick = () => { driveTablePage++; render(); };
    $("driveGraphPrevious").onclick = () => { driveGraphPage--; render(); };
    $("driveGraphNext").onclick = () => { driveGraphPage++; render(); };

    $("driveSearch")
      ?.addEventListener(
        "input",
        render
      );

    /*
     * This is what makes an old ON state disappear
     * after the simulator/device stops.
     */
    setInterval(
      render,
      1000
    );
  }
);