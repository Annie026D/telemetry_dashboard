/*
 * Live topology controller.
 *
 * Combines configured topology with device and link health, preserves the last
 * live state between refreshes, and batches DOM rendering to avoid redrawing
 * the graph for every high-rate WebSocket packet.
 */
let topologyBusy = false;

/* The two maps retain the latest device and link observations received from
 * the server. They affect display status only and are never sent to hardware. */
const liveTopologyState = {};
const liveLinkState = {};

/* Rendering is scheduled in batches so a burst of WebSocket messages produces
 * one coherent screen update instead of a redraw for every UDP packet. */
let topologyRenderTimer = null;
let lastTopologyDevices = [];

/* These thresholds convert packet age into the same plain-language states used
 * by the topology cards: recent, stale, or offline. */
const LIVE_SEC = 5;
const STALE_SEC = 15;
const TRAFFIC_WINDOW_MS = 10000;

/*
--------------------------------------------------
SCADA ARCHITECTURE LINKS
This reviewed list describes the fixed connections shown to the operator.
It does not open sockets or route packets. Runtime status, traffic, anomalies,
and last-seen times are layered onto these definitions from WebSocket data.
--------------------------------------------------
*/

const links = [
  {
    from: "JOYSTICK_UNIT",
    to: "DRIVE_UNIT",
    process: "CONTROL_INPUT",
    channel: "joystick",
    protocol: "UDP",
    rate: "25Hz"
  },

{
  from: "CAMERA_UNIT",
  to: "DRIVE_UNIT",
  process: "VIDEO_TELEMETRY",
  channel: "tracker_telemetry",
  protocol: "RTSP",
  rate: "30FPS"
},

  {
    from: "EXTERNAL_TRACK_UNIT",
    to: "DRIVE_UNIT",
    process: "TARGET_TRACK",
    channel: "external_track",
    protocol: "MULTICAST",
    rate: "20Hz"
  },

  {
    from: "DRIVE_UNIT",
    to: "LCU_UNIT",
    process: "TRACK_COMMAND",
    channel: "tracker_publish",
    protocol: "MULTICAST",
    rate: "50Hz"
  },

  {
    from: "IMU_UNIT",
    to: "LCU_UNIT",
    process: "ORIENTATION_DATA",
    channel: "imu",
    protocol: "UDP",
    rate: "100Hz"
  },

  {
    from: "BUTTON_LED_UNIT",
    to: "LCU_UNIT",
    process: "BUTTON_CONTROL",
    channel: "button_led",
    protocol: "UDP",
    rate: "10Hz"
  },

  {
    from: "WCS_CONSOLE",
    to: "LCU_UNIT",
    process: "OPERATOR_COMMAND",
    channel: "wcs",
    protocol: "UDP",
    rate: "20Hz"
  },

  {
    from: "CCE_GATEWAY",
    to: "LCU_UNIT",
    process: "CONTROL_DATA",
    channel: "cce",
    protocol: "UDP",
    rate: "20Hz"
  },

  {
    from: "LCU_UNIT",
    to: "MAIN_DISPLAY",
    process: "DISPLAY_DATA",
    channel: "lcu",
    protocol: "UDP",
    rate: "10Hz"
  },

  {
    from: "ADVANTECH_IO",
    to: "LCU_UNIT",
    process: "IO_STATUS",
    channel: "advantec_driver",
    protocol: "UDP",
    rate: "LIVE"
  }
];

/*
--------------------------------------------------
CENTER-FOCUSED DEVICE POSITIONS
x/y are percentages inside topologyCanvas.
--------------------------------------------------
*/
const deviceLayout = {
  JOYSTICK_UNIT: {
    x: 23,
    y: 17
  },

  CAMERA_UNIT: {
    x: 23,
    y: 46
  },

  EXTERNAL_TRACK_UNIT: {
    x: 23,
    y: 75
  },

  DRIVE_UNIT: {
    x: 43,
    y: 24
  },

  IMU_UNIT: {
    x: 43,
    y: 61
  },

  LCU_UNIT: {
    x: 62,
    y: 42
  },

  BUTTON_LED_UNIT: {
    x: 78,
    y: 20
  },

  MAIN_DISPLAY: {
    x: 78,
    y: 42
  },

  WCS_CONSOLE: {
    x: 78,
    y: 64
  },

  CCE_GATEWAY: {
    x: 78,
    y: 84
  },

  ADVANTECH_IO: {
    x: 62,
    y: 78
  }
};

function topologyDevicePosition(device, index, canvasWidth) {
  if (canvasWidth >= 850) {
    return deviceLayout[device] || { x: 50, y: 50 };
  }

  const column = index % 2;
  const row = Math.floor(index / 2);

  return {
    x: column === 0 ? 27 : 73,
    y: 10 + row * 20
  };
}

/*
--------------------------------------------------
NORMALIZATION HELPERS
--------------------------------------------------
*/

function normText(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_");
}

function topologyDeviceName(name) {
  const raw = normText(name);

  if (typeof canonicalDeviceName === "function") {
    const canonical = canonicalDeviceName(raw);
    if (canonical) return canonical;
  }

  const map = {
    BUTTON: "BUTTON_LED_UNIT",
    BUTTON_LED: "BUTTON_LED_UNIT",
    BUTTON_LED_UNIT: "BUTTON_LED_UNIT",

    JOYSTICK: "JOYSTICK_UNIT",
    JOYSTICK_UNIT: "JOYSTICK_UNIT",

    IMU: "IMU_UNIT",
    IMU_UNIT: "IMU_UNIT",

    CAMERA: "CAMERA_UNIT",
    CAMERA_UNIT: "CAMERA_UNIT",

    DRIVE: "DRIVE_UNIT",
    DRIVE_UNIT: "DRIVE_UNIT",
    DRIVE_WCS: "DRIVE_UNIT",
    TRACKER: "DRIVE_UNIT",
    TRACKER_PUBLISH: "DRIVE_UNIT",
    TRACKER_PUBLISH_UNIT: "DRIVE_UNIT",

    LCU: "LCU_UNIT",
    LCU_UNIT: "LCU_UNIT",

    CCE: "CCE_GATEWAY",
    CCE_GATEWAY: "CCE_GATEWAY",

    WCS: "WCS_CONSOLE",
    WCS_CONSOLE: "WCS_CONSOLE",

    MAIN_DISPLAY_UNIT: "MAIN_DISPLAY",
    MAIN_DISPLAY: "MAIN_DISPLAY",

    EXTERNAL_TRACK: "EXTERNAL_TRACK_UNIT",
    EXTERNAL_TRACK_UNIT: "EXTERNAL_TRACK_UNIT"
  };

  return map[raw] || raw || "UNKNOWN_DEVICE";
}

function knownTopologyDevices() {
  return [
    ...new Set(
      links.flatMap(link => [
        link.from,
        link.to
      ])
    )
  ];
}

function safeId(text) {
  return String(text || "")
    .replace(/[^a-zA-Z0-9_]/g, "_");
}

function linkKey(link) {
  return `${link.from}__${link.to}__${link.process}`;
}

function isAnomaly(row) {
  const v = row.anomaly;

  return (
    v === true ||
    v === 1 ||
    v === "1" ||
    String(v).toLowerCase() === "true"
  );
}

/*
--------------------------------------------------
DEVICE STATE
--------------------------------------------------
*/

function ensureLiveTopologyDevice(device) {
  const name = topologyDeviceName(device);

  if (!liveTopologyState[name]) {
    liveTopologyState[name] = {
      device: name,
      status: "offline",
      rows: 0,
      anomalies: 0,
      traffic: "0 pkt/s",
      latency_ms: 0,
      last_seen: "-",
      lastSeenMs: 0,
      firstSeenMs: 0,
      recentPackets: []
    };
  }

  return liveTopologyState[name];
}

function liveTopologyDevices() {
  knownTopologyDevices()
    .forEach(ensureLiveTopologyDevice);

  const now = Date.now();

  Object.values(liveTopologyState)
    .forEach(d => {
      const age =
        d.lastSeenMs
          ? (now - d.lastSeenMs) / 1000
          : Infinity;

      if (age <= LIVE_SEC) {
        d.status = "online";
      } else if (age <= STALE_SEC) {
        d.status = "warning";
      } else {
        d.status = "offline";
      }

      d.recentPackets =
        (d.recentPackets || [])
          .filter(t => now - t < TRAFFIC_WINDOW_MS);

      d.traffic =
        `${Math.round(d.recentPackets.length / 10)} pkt/s`;
    });

  const order = knownTopologyDevices();

  return Object.values(liveTopologyState)
    .filter(d => order.includes(d.device))
    .sort((a, b) =>
      order.indexOf(a.device) -
      order.indexOf(b.device)
    );
}

/*
--------------------------------------------------
LINK STATE
--------------------------------------------------
*/

function ensureLiveLink(link) {
  const key = linkKey(link);

  if (!liveLinkState[key]) {
    liveLinkState[key] = {
      ...link,
      key,
      status: "offline",
      packets: 0,
      anomalies: 0,
      traffic: "0 pkt/s",
      last_seen: "-",
      lastSeenMs: 0,
      recentPackets: []
    };
  }

  return liveLinkState[key];
}

function liveTopologyLinks() {
  links.forEach(ensureLiveLink);

  const now = Date.now();

  Object.values(liveLinkState)
    .forEach(link => {
      const age =
        link.lastSeenMs
          ? (now - link.lastSeenMs) / 1000
          : Infinity;

      if (age <= LIVE_SEC) {
        link.status = "online";
      } else if (age <= STALE_SEC) {
        link.status = "warning";
      } else {
        link.status = "offline";
      }

      link.recentPackets =
        (link.recentPackets || [])
          .filter(t => now - t < TRAFFIC_WINDOW_MS);

      link.traffic =
        `${Math.round(link.recentPackets.length / 10)} pkt/s`;
    });

  return links.map(link =>
    liveLinkState[linkKey(link)]
  );
}

function matchingLinksForRow(row) {
  const src =
    topologyDeviceName(
      row.device_name ||
      row.device
    );

  const process =
    normText(
      row.process_name ||
      row.process ||
      row.subprocess_name ||
      row.subprocess ||
      row.value_key ||
      row.key
    );

  const channel =
    normText(
      row.channel_name ||
      row.channel
    );

  const candidates =
    links.filter(link => link.from === src);

  const exact =
    candidates.filter(link => {
      const linkProcess = normText(link.process);
      const linkChannel = normText(link.channel);

      const processMatch =
        process &&
        linkProcess &&
        (
          process === linkProcess ||
          process.includes(linkProcess) ||
          linkProcess.includes(process)
        );

      const channelMatch =
        channel &&
        linkChannel &&
        (
          channel === linkChannel ||
          channel.includes(linkChannel) ||
          linkChannel.includes(channel)
        );

      return processMatch || channelMatch;
    });

  if (exact.length) {
    return exact;
  }

  /*
    Fallback only when the device has exactly one outgoing link.
    This avoids wrongly increasing traffic on unrelated links.
  */
  if (candidates.length === 1) {
    return candidates;
  }

  return [];
}

/*
--------------------------------------------------
LIVE WEBSOCKET UPDATE
--------------------------------------------------
*/

function updateTopologyLiveRow(row) {
  const device =
    topologyDeviceName(
      typeof canonicalDeviceForTelemetry === "function"
        ? canonicalDeviceForTelemetry(row)
        : row.device_name || row.device
    );

  const d =
    ensureLiveTopologyDevice(device);

  const now = Date.now();

  const ts =
    row.server_rx_ts ||
    row.server_timestamp ||
    row.timestamp ||
    new Date(now).toISOString();

  d.rows += 1;
  d.anomalies += isAnomaly(row) ? 1 : 0;
  d.last_seen = ts;
  d.lastSeenMs = now;
  d.firstSeenMs = d.firstSeenMs || now;

  d.latency_ms =
    Number(row.latency_ms ?? d.latency_ms ?? 0) || 0;

  d.recentPackets.push(now);
  d.status = "online";

  const matchedLinks =
    matchingLinksForRow(row);

  matchedLinks.forEach(link => {
    const liveLink =
      ensureLiveLink(link);

    liveLink.packets += 1;
    liveLink.anomalies += isAnomaly(row) ? 1 : 0;
    liveLink.last_seen = ts;
    liveLink.lastSeenMs = now;
    liveLink.recentPackets.push(now);
    liveLink.status = "online";
  });

  scheduleTopologyRender();
}

/*
--------------------------------------------------
STATUS HELPERS
--------------------------------------------------
*/

function statusText(status) {
  switch ((status || "").toLowerCase()) {
    case "online":
      return "WORKING";

    case "warning":
      return "STALE";

    default:
      return "NO LIVE";
  }
}

function statusClass(status) {
  status = String(status || "")
    .toLowerCase();

  if (status === "online") {
    return "online";
  }

  if (status === "warning") {
    return "warning";
  }

  return "offline";
}

/*
--------------------------------------------------
RENDER DEVICE NODES
--------------------------------------------------
*/

function renderTopology(devices) {
  const box = $("topologyDevices");

  if (!box) {
    return;
  }

  const canvas = box.closest(".topologyCanvas");
  const canvasWidth = box.clientWidth || canvas?.clientWidth || 0;

  canvas?.classList.toggle(
    "topologyCanvasCompact",
    canvasWidth < 850
  );

  const iconMap = {
    JOYSTICK_UNIT: "images/joystick.png",
    IMU_UNIT: "images/imu.png",
    CAMERA_UNIT: "images/camera.png",
    DRIVE_UNIT: "images/tracker.png",
    LCU_UNIT: "images/lcu.png",
    WCS_CONSOLE: "images/wcs.png",
    MAIN_DISPLAY: "images/display.png",
    CCE_GATEWAY: "images/gateway.png",
    EXTERNAL_TRACK_UNIT: "images/tracker.png",
    BUTTON_LED_UNIT: "images/joystick.png",
    ADVANTECH_IO: "images/gateway.png"
  };

  box.innerHTML =
    devices.map((d, index) => {
      const status =
        statusClass(d.status);

      const icon =
        iconMap[d.device] ||
        "images/gateway.png";

      const pos =
        topologyDevicePosition(
          d.device,
          index,
          canvasWidth
        );

      return `
        <div
          class="topology-node ${status}"
          id="node_${safeId(d.device)}"
          style="
            left:${pos.x}%;
            top:${pos.y}%;
            transform:translate(-50%, -50%);
          ">

          <img
            class="deviceSticker"
            src="${icon}"
            alt="${esc(d.device)}">

          <div class="deviceName">
            ${esc(d.device)}
          </div>

          <div class="deviceState ${status}">
            ${statusText(d.status)}
          </div>

          <div class="deviceMeta compact">
            <div>
              Traffic: ${esc(d.traffic || "0 pkt/s")}
            </div>

            <div>
              Rows: ${d.rows || 0}
            </div>

            <div>
              Anomalies: ${d.anomalies || 0}
            </div>
          </div>
        </div>
      `;
    }).join("");

  renderTopologyDeviceTable(devices);
  renderTopologyLinkTable();
}

/*
--------------------------------------------------
DRAW CENTER-FOCUSED LINKS
--------------------------------------------------
*/

function drawTopologyLinks(devices) {
  const svg = $("topologySvg");

  if (!svg) {
    return;
  }

  svg.innerHTML = "";

  const liveLinks =
    liveTopologyLinks();

  const liveMap = {};

  liveLinks.forEach(link => {
    liveMap[link.key] = link;
  });

  for (const link of links) {
    const srcEl =
      $("node_" + safeId(link.from));

    const dstEl =
      $("node_" + safeId(link.to));

    if (!srcEl || !dstEl) {
      continue;
    }

    const a =
      srcEl.getBoundingClientRect();

    const b =
      dstEl.getBoundingClientRect();

    const s =
      svg.getBoundingClientRect();

    const x1 =
      a.left + a.width / 2 - s.left;

    const y1 =
      a.top + a.height / 2 - s.top;

    const x2 =
      b.left + b.width / 2 - s.left;

    const y2 =
      b.top + b.height / 2 - s.top;

    const live =
      liveMap[linkKey(link)];

    const status =
      statusClass(live?.status || "offline");

    let cls = "link-offline";

    if (status === "online") {
      cls = "link-online";
    } else if (status === "warning") {
      cls = "link-warning";
    }

    const path =
      document.createElementNS(
        "http://www.w3.org/2000/svg",
        "path"
      );

    const dx =
      Math.abs(x2 - x1) * 0.35;

    const curve =
      `M ${x1} ${y1}
       C ${x1 + dx} ${y1},
         ${x2 - dx} ${y2},
         ${x2} ${y2}`;

    const pathId =
      "path_" +
      safeId(
        link.from +
        "_" +
        link.to +
        "_" +
        link.process
      );

    path.setAttribute("id", pathId);
    path.setAttribute("d", curve);
    path.setAttribute("class", cls);

    svg.appendChild(path);

    const label =
      document.createElementNS(
        "http://www.w3.org/2000/svg",
        "text"
      );

    label.setAttribute(
      "x",
      (x1 + x2) / 2
    );

    label.setAttribute(
      "y",
      (y1 + y2) / 2 - 10
    );

    label.setAttribute(
      "class",
      "topologyLabel"
    );

    label.textContent =
      `${link.process} • ${live?.traffic || "0 pkt/s"}`;

    svg.appendChild(label);

    if (status !== "offline") {
      const dot =
        document.createElementNS(
          "http://www.w3.org/2000/svg",
          "circle"
        );

      dot.setAttribute("r", "5");
      dot.setAttribute("class", "flowDot");

      const animateMotion =
        document.createElementNS(
          "http://www.w3.org/2000/svg",
          "animateMotion"
        );

      animateMotion.setAttribute(
        "dur",
        status === "online" ? "2s" : "4s"
      );

      animateMotion.setAttribute(
        "repeatCount",
        "indefinite"
      );

      const motionPath =
        document.createElementNS(
          "http://www.w3.org/2000/svg",
          "mpath"
        );

      motionPath.setAttributeNS(
        "http://www.w3.org/1999/xlink",
        "href",
        "#" + pathId
      );

      animateMotion.appendChild(
        motionPath
      );

      dot.appendChild(
        animateMotion
      );

      svg.appendChild(dot);
    }
  }
}

/*
--------------------------------------------------
TABLES
--------------------------------------------------
*/

function renderTopologyDeviceTable(devices) {
  const tbody =
    $("topologyDeviceTable");

  if (!tbody) {
    return;
  }

  tbody.innerHTML =
    devices.map(d => {
      const status =
        statusClass(d.status);

      return `
        <tr>
          <td>${esc(d.device)}</td>

          <td>
            <span class="deviceState ${status}">
              ${statusText(d.status)}
            </span>
          </td>

          <td>${d.rows || 0}</td>
          <td>${d.anomalies || 0}</td>
          <td>${esc(d.traffic || "0 pkt/s")}</td>
          <td>${esc(d.last_seen || "-")}</td>
          <td>${d.latency_ms || 0} ms</td>
        </tr>
      `;
    }).join("");
}

function renderTopologyLinkTable() {
  const tbody =
    $("topologyLinkTable");

  if (!tbody) {
    return;
  }

  const liveLinks =
    liveTopologyLinks();

  tbody.innerHTML =
    liveLinks.map(link => {
      const status =
        statusClass(link.status);

      return `
        <tr>
          <td>
            <span class="deviceState ${status}">
              ${statusText(link.status)}
            </span>
          </td>

          <td>${esc(link.from)}</td>
          <td>${esc(link.to)}</td>
          <td>${esc(link.process)}</td>
          <td>${esc(link.protocol || "UDP")}</td>
          <td>${esc(link.rate || "-")}</td>
          <td>${esc(link.traffic || "0 pkt/s")}</td>
          <td>${link.anomalies || 0}</td>
          <td>${esc(link.last_seen || "-")}</td>
        </tr>
      `;
    }).join("");
}

/*
--------------------------------------------------
TOP STATS
--------------------------------------------------
*/

function renderTopologyStats(devices) {
  const el =
    $("topologyStats");

  if (!el) {
    return;
  }

  const liveLinks =
    liveTopologyLinks();

  const online =
    devices.filter(d =>
      statusClass(d.status) === "online"
    ).length;

  const warning =
    devices.filter(d =>
      statusClass(d.status) === "warning"
    ).length;

  const offline =
    devices.filter(d =>
      statusClass(d.status) === "offline"
    ).length;

  const totalRows =
    devices.reduce(
      (sum, d) => sum + (d.rows || 0),
      0
    );

  const totalAnomalies =
    devices.reduce(
      (sum, d) => sum + (d.anomalies || 0),
      0
    );

  const liveTraffic =
    liveLinks.reduce(
      (sum, link) =>
        sum +
        Math.round(
          (link.recentPackets?.length || 0) / 10
        ),
      0
    );

  el.innerHTML = `
    <div class="topologyStatsGrid">

      <div class="topologyStat online">
        <h3>${online}</h3>
        <p>LIVE</p>
      </div>

      <div class="topologyStat warning">
        <h3>${warning}</h3>
        <p>STALE</p>
      </div>

      <div class="topologyStat offline">
        <h3>${offline}</h3>
        <p>NO LIVE</p>
      </div>

      <div class="topologyStat links">
        <h3>${liveLinks.length}</h3>
        <p>LINKS</p>
      </div>

      <div class="topologyStat">
        <h3>${liveTraffic}</h3>
        <p>pkt/s</p>
      </div>

      <div class="topologyStat">
        <h3>${totalRows}</h3>
        <p>ROWS</p>
      </div>

      <div class="topologyStat">
        <h3>${totalAnomalies}</h3>
        <p>ANOMALIES</p>
      </div>

    </div>
  `;
}

/*
--------------------------------------------------
RENDER LOOP
--------------------------------------------------
*/

function scheduleTopologyRender() {
  if (topologyRenderTimer) {
    return;
  }

  topologyRenderTimer =
    setTimeout(() => {
      topologyRenderTimer = null;

      const devices =
        liveTopologyDevices();

      lastTopologyDevices =
        devices;

      renderTopology(devices);
      renderTopologyStats(devices);

      setTimeout(() => {
        drawTopologyLinks(devices);
      }, 60);

    }, 150);
}

async function refreshTopology() {
  if (topologyBusy) {
    return;
  }

  topologyBusy = true;

  try {
    const devices =
      liveTopologyDevices();

    lastTopologyDevices =
      devices;

    renderTopology(devices);
    renderTopologyStats(devices);

    setTimeout(() => {
      drawTopologyLinks(devices);
    }, 100);

  } catch (e) {
    console.error(
      "Topology refresh failed:",
      e
    );
  } finally {
    topologyBusy = false;
  }
}

/*
--------------------------------------------------
INIT
--------------------------------------------------
*/

async function init() {
  await refreshTopology();

  initScadaSocket();

  onScadaEvent(msg => {
    liveRowsFromScadaEvent(msg)
      .forEach(updateTopologyLiveRow);
  });

  setInterval(() => {
    const devices =
      liveTopologyDevices();

    lastTopologyDevices =
      devices;

    renderTopology(devices);
    renderTopologyStats(devices);

    setTimeout(() => {
      drawTopologyLinks(devices);
    }, 80);

  }, 1000);

  window.addEventListener(
    "resize",
    () => {
      scheduleTopologyRender();
    }
  );
}

init().catch(e => {
  console.error(e);

  document.body.innerHTML = `
    <pre style="
      color:white;
      background:#111827;
      padding:20px;
      overflow:auto;
    ">
Topology Error

${esc(e.stack || e.message)}
    </pre>
  `;
});
