/**
 * @file hmi.js
 * @brief Device HMI controller, live telemetry state manager, renderer library,
 *        device inspector, history playback controller, and diagnostics UI.
 *
 * This module receives normalized telemetry rows from the backend, resolves each
 * row to a canonical physical device, maintains per-device live state, updates
 * device-specific HMI renderers, records control transitions, renders historical
 * playback, and synchronizes dashboard, inspector, graph, alarm, and status views.
 *
 * Renderers consume normalized payload objects and timestamps. DOM output is
 * derived from the current canonical state so reconnects, database changes, and
 * repeated packets do not depend on stale element state.
 *
 * @note The module depends on shared browser helpers such as `api`, `App`, `$`,
 *       `setHtml`, `parseTs`, and optionally `canonicalDeviceName`.
 * @warning Keep LIVE_STALE_MS aligned with the backend device-online timeout.
 */
/** @brief Registry of live UI components keyed by component identifier. */
const liveComponents = {};
/** @brief Latest backend status record for each canonical device. */
const deviceStatuses = {};
/* Diagnostic logging is deliberately disabled in normal operation because
 * browser-console output can become expensive on high-rate telemetry streams. */
const DEBUG = false;
/* The following values describe the operator's current graph and playback
 * session. They live only in this browser tab and never change a device. */
let trendChart = null;
let playbackData = [];
let playbackIndex = 0;
let playbackTimer = null;
let hmiFallbackTimer = null;
let playbackMode = false;
/* Camera rendering is rate-limited by time and content key so repeated packets
 * do not force unnecessary redraws of an unchanged instrument. */
let lastCameraRenderAt = 0;
let lastCameraRenderKey = "";
/** @brief Canonical latest live payload state for each device. */
const liveDeviceState = {};
/** @brief Last live packet arrival time, in milliseconds, for each device. */
const deviceHeartbeat = {};
/** @brief Short per-device list of recently changed signals shown in status panels. */
const deviceRecentSignals = {};
/* Must match the backend's DEVICE_ONLINE_SEC so an offline device cannot
   remain selectable or keep cached values after backend status expires. */
/** @brief Maximum device-heartbeat age before live state is considered stale. */
const LIVE_STALE_MS = 15000;
/** @brief Maximum accepted age of a packet considered suitable for immediate live display. */
const LIVE_PACKET_MAX_AGE_MS = 1000;
/** @brief Visual latch duration for momentary button, LED, and joystick activity. */
const CONTROL_LATCH_MS = 5000;

/* Device inspector working state.
 *
 * These collections hold browser-side summaries used to draw tabs, alarms,
 * audit history, and charts. Backend packets remain the source of truth; this
 * cache may be discarded and rebuilt after a reconnect or database change. */

const deviceMetrics = {};
const deviceEvents = {};
const deviceAuditHistory = {};
const devicePacketHistory = {};
const deviceUsageStats = {};
const controlMeta = {};
const activeAlarms = [];
/* Popup state prevents one unchanged control value from repeatedly disturbing
 * the operator while newer packets continue to arrive. */
const immediatePopupState = {};
/* Disclosure and scroll positions are remembered across safe DOM rebuilds so
 * live updates do not collapse a panel that the operator is reading. */
const panelDisclosureState = {};
const panelScrollState = {};
let inspectorTab = "overview";
let selectedProcess = "";
/* These timers coalesce repeated selector and inspector requests so a burst of
 * packets produces one DOM update instead of rebuilding the same view many times. */
let selectorRefreshTimer = null;
let selectedInspectorRenderTimer = null;
let hmiLiveFlushScheduled = false;
let inspectorChart = null;
const inspectorCharts = [];
/* The load token lets a newer history request supersede an older response;
 * this prevents a slow query from drawing data for the wrong selection. */
let inspectorGraphLoadToken = 0;
let inspectorGraphLoading = false;
/* High-rate WebSocket rows are grouped by device and flushed together. This
 * bounds browser work without changing which packet values are retained. */
const hmiLiveByDevice = new Map();
const hmiLiveRows = [];
let hmiUiRefreshScheduled = false;
let trendChartUpdateScheduled = false;
/* Chart.js redraws are limited to roughly eight frames per second; telemetry
 * values are still retained between redraws, so throttling changes presentation only. */
const TREND_CHART_UPDATE_MS = 120;
/* Session and timestamp markers detect backend restarts or an older packet
 * stream, allowing stale browser caches to be cleared before new data is merged. */
let lastLiveSessionId = "";
let lastLiveTimestampMs = 0;
let hmiWsGeneration = 0;
let hmiStatusRefreshInFlight = null;

/**

 * @brief Schedule a single animation-frame refresh of HMI KPI and alarm widgets.

 */

function scheduleHmiUiRefresh() {
  // Reuse an already queued animation-frame update because later packets have
  // already changed the shared state that the pending callback will read.
  if (hmiUiRefreshScheduled) {
    return;
  }

  // Mark the refresh as pending before requesting a frame so another packet
  // cannot queue a duplicate KPI and alarm redraw in the same browser frame.
  hmiUiRefreshScheduled = true;

  // Wait for the browser's next paint opportunity, then rebuild both summary
  // widgets from the latest accumulated device and alarm state.
  requestAnimationFrame(() => {
    hmiUiRefreshScheduled = false;
    updateKpis();
    renderAlarmCenter();
  });
}

/**

 * @brief Throttle trend-chart redraws to avoid excessive Chart.js updates.

 */

function scheduleTrendChartUpdate() {
  // Do nothing until a chart exists, and keep a previously scheduled redraw
  // when high-rate telemetry calls this function again before its timer fires.
  if (!trendChart || trendChartUpdateScheduled) {
    return;
  }

  // Latch the scheduled state for the duration of the throttle window.
  trendChartUpdateScheduled = true;

  // Redraw once after the throttle interval using Chart.js's non-animated mode;
  // this displays all values accumulated during the interval without animation lag.
  setTimeout(() => {
    trendChartUpdateScheduled = false;

    if (trendChart) {
      trendChart.update("none");
    }
  }, TREND_CHART_UPDATE_MS);
}

const persistedHmiLoads = new Set();
/* Keep the first GPS fix as a local plotting origin and retain only a bounded
 * trail so IMU movement can be drawn without unbounded browser memory growth. */
const imuGpsTrailState = {
  reference: null,
  points: [],
  maxPoints: 180
};

/**

 * @brief Convert a device alias into the canonical device identifier used by the inspector.


 */

function canonicalInspectorDevice(device) {
  // Convert incoming aliases to the uppercase underscore form used as keys in
  // HMI caches, renderer tables, status responses, and inspector selections.
  const d = String(device || "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");

  // Prefer the shared application canonicalizer so HMI and other pages resolve
  // any aliases maintained centrally in common.js in exactly the same way.
  if (typeof canonicalDeviceName === "function") {
    const shared =
      canonicalDeviceName(d);

    // Use the shared result only when it made a meaningful alias conversion.
    if (shared && shared !== d) {
      return shared;
    }
  }

  // Cover HMI-specific historical channel names and operator-friendly aliases
  // that may not appear in the shared device-name mapping.
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
    LCU: "LCU_UNIT",
    LCU_UNIT: "LCU_UNIT",
    LCU_TRANSPORT: "LCU_UNIT",
    CCE: "CCE_GATEWAY",
    WCS: "WCS_CONSOLE",
    WCS_CONTROL_CONSOLE: "WCS_CONSOLE",
    MAIN_DISPLAY: "MAIN_DISPLAY",
    MAINDISPLAY: "MAIN_DISPLAY",
    MAIN: "MAIN_DISPLAY",
    ADVANTECH: "ADVANTECH_IO",
    ADVANTEC_DRIVER: "ADVANTECH_IO",
    EXTERNAL_TRACK: "EXTERNAL_TRACK_UNIT",
    TRACKER_PUBLISH: "DRIVE_UNIT",
    TRACKER_PUBLISH_UNIT: "DRIVE_UNIT",
    DRIVE: "DRIVE_UNIT",
    DRIVE_WCS: "DRIVE_UNIT",
    DRIVE_UNIT: "DRIVE_UNIT"
  };

  // Return the mapped physical device, or preserve an unknown normalized name
  // so new devices remain visible instead of being silently discarded.
  return aliases[d] || d;
}

/**

 * @brief Determine whether two device identifiers refer to the same canonical device.

 * @param a First value or device identifier.

 * @param b Second value or device identifier.

 */

function sameInspectorDevice(a, b) {
  // Compare canonical names so aliases such as DRIVE_WCS and DRIVE_UNIT select
  // the same cached state, renderer, and inspector panel.
  return canonicalInspectorDevice(a) === canonicalInspectorDevice(b);
}

/**

 * @brief Check whether the supplied device is the currently selected inspector device.


 */

function isSelectedDevice(device) {
  // Resolve both values before comparing because the selection and packet may
  // use different aliases for the same physical unit.
  return sameInspectorDevice(selectedDevice, device);
}

/**

 * @brief Return the selected-device detail container when the requested device is selected.


 */

function selectedDetailFor(device) {
  // Prevent a renderer for another device from overwriting the detail panel
  // while the operator has a different device selected.
  if (!isSelectedDevice(device)) {
    return null;
  }

  // Return the live detail mount only after confirming it belongs to this device.
  return document.getElementById("selectedDeviceDetail");
}

/**

 * @brief Build a stable key for persisted panel disclosure and scroll state.

 * @param title Panel or section title.

 */

function panelStateKey(title) {
  // Include device and active inspector tab because panels with the same title
  // can have independent open and scroll states in different views.
  return [
    canonicalInspectorDevice(selectedDevice),
    inspectorTab,
    title || "panel"
  ].join("::");
}

/**

 * @brief Capture open/closed and scroll state for dynamic telemetry panels.

 * @param root Root DOM node to search; defaults to the document.

 */

function rememberPanelDisclosureState(root = document) {
  // Inspect every dynamically rebuilt telemetry section below the supplied root
  // before its markup is replaced by a live render.
  root
    .querySelectorAll(".dynamicTelemetrySection")
    .forEach(panel => {
      // Use the renderer-provided title as the persistence identity, falling
      // back to the standard all-fields panel name when no title was recorded.
      const title =
        panel.dataset.panelTitle ||
        "All Telemetry Fields";

      // Remember whether the operator left this disclosure panel open or closed.
      panelDisclosureState[panelStateKey(title)] =
        panel.open;

      // Locate the independently scrollable field grid inside the disclosure panel.
      const grid =
        panel.querySelector(".dynamicTelemetryGrid");

      // Preserve its vertical reading position when the panel contains a grid.
      if (grid) {
        panelScrollState[panelStateKey(title)] =
          grid.scrollTop;
      }
    });
}

/**

 * @brief Restore previously captured disclosure and scroll state.

 * @param root Root DOM node to search; defaults to the document.

 */

function restorePanelDisclosureState(root = document) {
  // Visit the newly rendered telemetry sections and reapply the operator's
  // state captured immediately before the DOM replacement.
  root
    .querySelectorAll(".dynamicTelemetrySection")
    .forEach(panel => {
      const title =
        panel.dataset.panelTitle ||
        "All Telemetry Fields";

      // Recreate the same stable device/tab/title key used during capture.
      const key =
        panelStateKey(title);

      // Panels default to open; only an explicitly remembered false value closes one.
      if (panelDisclosureState[key] !== false) {
        panel.open = true;
      } else {
        panel.open = false;
      }

      // Restore the field grid's scroll offset after its new DOM node exists.
      const grid =
        panel.querySelector(".dynamicTelemetryGrid");

      if (grid && panelScrollState[key] !== undefined) {
        grid.scrollTop =
          panelScrollState[key];
      }

      // Bind one toggle listener per rendered node so later manual open/close
      // actions update the saved state used by subsequent live redraws.
      if (!panel.dataset.stateBound) {
        panel.dataset.stateBound = "1";
        panel.addEventListener("toggle", () => {
          panelDisclosureState[key] =
            panel.open;
        });
      }
    });
}

/**

 * @brief Execute a renderer while preserving dynamic panel state across DOM replacement.

 * @param renderFn Rendering callback to execute.

 */

function withPreservedPanelState(renderFn) {
  // Capture disclosure and scroll positions from the currently mounted detail view.
  const detail =
    document.getElementById("selectedDeviceDetail");

  if (detail) {
    rememberPanelDisclosureState(detail);
  }

  // Execute the renderer even when no previous detail node exists; initial
  // selection still needs to create the inspector content.
  renderFn();

  // Find the replacement detail node produced by the renderer and restore the
  // captured operator state onto its newly created panels.
  const nextDetail =
    document.getElementById("selectedDeviceDetail");

  if (nextDetail) {
    restorePanelDisclosureState(nextDetail);
  }
}

/**

 * @brief Throttle rerendering of the currently selected device inspector.


 */

function scheduleSelectedInspectorRender(device) {
  // Ignore packets for devices other than the one the operator is inspecting.
  if (!isSelectedDevice(device)) {
    return;
  }

  // Keep the pending render because it will read the newest shared device state.
  if (selectedInspectorRenderTimer) {
    return;
  }

  // Graphs are more expensive than overview fields, so give graph packets a
  // longer batching window while keeping overview feedback responsive.
  const delay =
    inspectorTab === "graph" ? 250 : 80;

  // Schedule one selected-device update after the appropriate batching delay.
  selectedInspectorRenderTimer =
    setTimeout(() => {
      selectedInspectorRenderTimer = null;

      // Reconfirm the selection because the operator may change devices while
      // this delayed callback is waiting.
      if (isSelectedDevice(device)) {
        // Patch stable overview fields in place when possible, preserving the
        // surrounding DOM; fall back to a full state-preserving render otherwise.
        if (
          inspectorTab === "overview" &&
          document.getElementById("selectedDeviceDetail")
        ) {
          // A successful in-place update completes this refresh without rebuilding panels.
          if (updateStableTelemetryFields(device)) {
            return;
          }
          withPreservedPanelState(renderSelectedDeviceDetail);
        // Graph tabs update their datasets directly; other tabs rebuild their
        // device-inspector content from the latest cached state.
        } else if (inspectorTab === "graph") {
          updateInspectorGraphsFromLive(device);
        } else {
          renderDeviceInspector();
        }
      }
    }, delay);
}

/*
--------------------------------------------------
FORCE SELECTED DEVICE VISUAL UPDATE
--------------------------------------------------
This is used when live telemetry arrives for the selected device.
It keeps SVG/visual panels moving without waiting for DB polling.
--------------------------------------------------
*/

/**

 * @brief Immediately schedule visual and graph updates for selected live telemetry.


 */

function forceSelectedVisualRefresh(device) {
  // Reject updates when nothing is selected or when this packet belongs to a
  // different physical device than the current inspector selection.
  if (
    !selectedDevice ||
    !sameInspectorDevice(
      selectedDevice,
      device
    )
  ) {
    return;
  }

  // Queue the normal selected-device renderer so SVG instruments and text
  // fields consume the newly merged live payload.
  scheduleSelectedInspectorRender(
    selectedDevice
  );

  // Push graph datasets immediately when the graph tab is visible; the graph
  // updater applies its own throttling and point-window limits.
  if (inspectorTab === "graph") {
    updateInspectorGraphsFromLive(
      selectedDevice
    );
  }
}
/** @brief Maps canonical device identifiers and aliases to specialized renderer functions. */
const DEVICE_RENDERERS = {

  BUTTON:
    renderButtonLedPanel,

  BUTTON_LED_UNIT:
    renderButtonLedPanel,

  JOYSTICK:
    renderJoystickPanel,

  JOYSTICK_UNIT:
    renderJoystickPanel,
  
  ADVANTECH_IO:
  renderAdvantechIoPanel,

  IMU_UNIT:
    renderImuPanel,

  IMU:
    renderImuPanel,

  EXTERNAL_TRACK_UNIT:
    renderExternalTrackPanel,
  TRACKER_PUBLISH_UNIT:
  renderDriveSystemPanel,

DRIVE_UNIT:
  renderDriveSystemPanel,

  MAIN_DISPLAY:
    renderMainDisplayPanel,

  WCS_CONSOLE:
    renderWcsConsolePanel,

  CAMERA_UNIT:
    renderCameraPanel,

  CAMERA:
    renderCameraPanel,

  CCE_GATEWAY:
    renderCceGatewayPanel,

  LCU_UNIT:
    renderLcuPanel
};
let selectedDevice = null;
let totalPackets = 0;
const deviceDisplayNames = {

  IMU_UNIT: "IMU",
  CAMERA: "CAMERA",
  CAMERA_UNIT: "CAMERA",
  EXTERNAL_TRACK_UNIT:
    "EXTERNAL TRACK",
  TRACKER_PUBLISH_UNIT:
    "DRIVE",
  DRIVE_UNIT:
    "DRIVE",
  ADVANTECH_IO:
  "ADVANTECH I/O",

  CCE_GATEWAY:
    "CCE",

  WCS_CONSOLE:
    "WCS",

  MAIN_DISPLAY:
    "MAIN DISPLAY",

  LCU_UNIT:
    "LCU",
  
  BUTTON_LED_UNIT:
    "BUTTON",

  JOYSTICK_UNIT:
    "JOYSTICK"
};
const telemetryTrendData = {

  labels: [],
  timestamps: [],

  imu: {
    roll: [],
    pitch: [],
    yaw: []
  },

  drive: {
    pan: [],
    tilt: [],
    rpm: [],
    current: [],

    /*
    Kept only to prevent old playback/reset code from crashing.
    This is NOT shown in Mission Telemetry Analytics.
    */
    voltage: []
  },

  /*
  Kept only for old helper functions.
  These are hidden and not shown in Mission Telemetry Analytics.
  */
  generic: {
    a: [],
    b: [],
    c: [],
    keys: ["", "", ""],
    labels: ["Telemetry A", "Telemetry B", "Telemetry C"]
  }
};

/** @brief Maps backend UDP channel names to canonical HMI device identifiers. */
const channelDeviceMap = {

  lcu_transport:
    "LCU_UNIT",

  external_track:
    "EXTERNAL_TRACK_UNIT",
  advantec_driver:
  "ADVANTECH_IO",

  tracker_telemetry:
  "CAMERA_UNIT",

  tracker_publish:
    "DRIVE_UNIT",

  imu:
    "IMU_UNIT",

  button_led:
    "BUTTON_LED_UNIT",

  joystick:
    "JOYSTICK_UNIT",

  maindisplay:
    "MAIN_DISPLAY",

  wcs_control_console:
    "WCS_CONSOLE",

  cce_gateway:
    "CCE_GATEWAY"
};
/** @brief Static Button/LED channel definitions and numerical identifiers. */
const buttonLedConfig = {
  buttons: [
    ["DRIVES_RESET", 1],
    ["OPTICS_RESET", 2],
    ["LRF_RESET", 3],
    ["CCE_RESET", 4],
    ["PARK", 5],
    ["ABORT", 6],
    ["COMBAT", 7],
    ["BCU", 8],
    ["PREPAR", 9],
    ["UNCAG", 10],
    ["DAY", 11],
    ["LOW_LIGHT", 12],
    ["THERMAL", 13],
    ["DROP", 14],
    ["FIRE", 15],
    ["LRF", 75],
    ["GButton1", 82],
    ["GButton2", 83],
    ["GButton3", 84],
    ["GButton4", 85],
    ["GButton5", 86],
    ["GButton6", 87]
  ],
  switches: [
    ["MAIN_POWER_ON", 16],
    ["DRIVES_ON", 17],
    ["OPTICS_ON", 18],
    ["LRF_ON", 19],
    ["CCE_ON", 20],
    ["LOCK", 21],
    ["STRELETS_CH1_ON", 22],
    ["STRELETS_CH2_ON", 23],
    ["SINGLE", 24],
    ["CTRL_SRC_WCS", 25],
    ["HEAT_FILTER_ON", 26],
    ["LAUNCH_KEY_EN", 27],
    ["TARGET_SPEED_FAST", 28],
    ["CHASE_HEAD", 29],
    ["CHASE_TAIL", 77],
    ["TARGET_SPEED_SLOW", 78],
    ["CTRL_SRC_CCE", 79],
    ["SALVO", 80],
    ["UNLOCK", 94]
  ],
  knobs: [
    ["MODE", 52],
    ["FREQUENCY", 53]
  ],
  leds: [
    ["DRIVES_RESET_LED", 60],
    ["OPTICS_RESET_LED", 61],
    ["LRF_RESET_LED", 62],
    ["CCE_RESET_LED", 63],
    ["PARK_LED", 64],
    ["ABORT_LED", 65],
    ["COMBAT_LED", 66],
    ["BCU_LED", 67],
    ["PREPAR_LED", 68],
    ["UNCAG_LED", 69],
    ["DAY_LED", 70],
    ["LOW_LIGHT_LED", 71],
    ["THERMAL_LED", 72],
    ["DROP_LED", 73],
    ["FIRE_LED", 74],
    ["LRF_LED", 76],
    ["SW_LRF_Status_LED", 81],
    ["GBUTTON1_LED", 88],
    ["GBUTTON2_LED", 89],
    ["GBUTTON3_LED", 90],
    ["GBUTTON4_LED", 91],
    ["GBUTTON5_LED", 92],
    ["GBUTTON6_LED", 93],
    ["SW_UnLOCK_Status_LED", 95],
    ["SW_STRELETS_CH1_Status_LED", 96],
    ["SW_STRELETS_CH2_Status_LED", 97],
    ["SW_CCE_Status_LED", 98],
    ["SW_Optics_Status_LED", 99],
    ["SW_Drives_Status_LED", 100]
  ]
};
/** @brief Supported joystick axes, thumbwheels, buttons, and hats. */
const joystickConfig = {
  axes: ["x", "y"],
  thumbwheels: ["thumb_a", "thumb_b", "thumb_c"],
  buttons: [
    "button_1",
    "button_2",
    "button_3",
    "button_4",
    "button_5",
    "trigger_up",
    "trigger_down",
    "button_6",
    "reserved_2",
    "reserved_3",
    "reserved_4"
  ],
  hats: ["hat_0"]
};
/*
==================================================
MAIN DISPLAY CONFIG
==================================================
*/

/** @brief Main-display visualization, video-source, tracker, and missile indicator settings. */
const maindisplayConfig = {
  window: {
    frame_width: 1680,
    frame_height: 1050,
    fov_horizontal: 83.1,
    fov_vertical: 53.0,
    linux_opencv_ui_backend: "auto",
    show_tracker_telemetry: true,
    show_imu_gps: false,

    graticule_modes: [
      "Horizontal",
      "Vertical",
      "Both",
      "Crosshair",
      "CircleCrosshair",
      "Blank"
    ],

    default_graticule_mode: "Both"
  },

  tracker: {
    invert_pan_axis: false,
    invert_tilt_axis: false
  },

  video: {
    retry_interval_sec: 15.0,
    open_timeout_sec: 20.0,
    frame_timeout_sec: 2.0,
    v4l2_width: 2048,
    v4l2_height: 1080,

    default_source: "SDI",
    default_source_index: 0,

    source_labels: [
      "SDI",
      "RTSP:LOW_LIGHT",
      "RTSP:DAY",
      "RTSP:THERMAL"
    ],

    source_paths: [
      "/dev/video0",
      "rtsp://169.254.214.173:554/day1",
      "rtsp://169.254.214.173:554/day2",
      "rtsp://169.254.214.173:554/thermal"
    ]
  },

  missile: {
    initial_states: [0, 1, 2, 5],
    led_total: 30,
    led_update_interval: 1.0,
    led_enabled: true
  }
};

/*
==================================================
WCS CONTROL CONSOLE CONFIG
==================================================
*/

/** @brief WCS console transport, UI, command, drive, joystick, and tracker settings. */
const wcsControlConsoleConfig = {

  app: {
    simulated_telemetry: false,
    log_dir: "logs"
  },

  ui: {
    font_point_size: 10,
    theme: "day"
  },

  transport: {
    group_addr: "239.255.0.1",
    port: 50100,
    iface: "169.254.214.172",
    loopback: true,
    staleness_ms: 5000,
    recvbuf_bytes: 262144,
    drop_stale: 0,
    drop_out_of_order: 1
  },

  command_tcp: {
    enabled: true,
    lcu_ip: "169.254.214.171",
    lcu_port: 6001,
    bind_ip: "169.254.214.172",
    connect_timeout_ms: 1500,
    reconnect_delay_ms: 500
  },

  drive_pan: {
    min_deg: -45.0,
    max_deg: 45.0,
    step_deg: 5.0,
    velocity: 5.0
  },

  drive_tilt: {
    min_deg: -10.0,
    max_deg: 10.0,
    step_deg: 1.0,
    velocity: 5.0
  },

  joystick: {
    enabled: true,
    poll_hz: 25,
    joystick_type: "MULTICAST_UDP",
    control_mode: "POSITION"
  },

  tracker_control: {
    update_period_ms: 50,
    max_speed_pct: 40.0,
    max_accel_pct: 40.0,
    tracker_pan_invert: false,
    tracker_tilt_invert: true
  }
};
/** @brief Mutable canonical control state for Button/LED and joystick devices. */
const controlState = {
  button_led: {
    buttons: {},
    switches: {},
    knobs: {},
    leds: {},
    timestamp: ""
  },
  joystick: {
    axes: {},
    thumbwheels: {},
    buttons: {},
    hats: {},
    connected: false,
    timestamp: ""
  }
};
const buttonLedPulseUntil = {};
let buttonLedPulseTimer = null;
const joystickPulseUntil = {};
let joystickPulseTimer = null;
const lcuStableState = {
  axes: {},
  common: {},
  timestamp: ""
};

/**

 * @brief Convert arbitrary text into a DOM-safe identifier fragment.

 */

function safeId(v) {
  // Convert labels such as device and signal names into characters that are
  // safe to reuse in generated HTML id attributes and CSS selectors.
  return String(v)
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9_]/g, "");
}

/**

 * @brief Escape a value for safe insertion into HTML markup.

 */

function esc(v) {
  // Encode every HTML-significant character before telemetry or configuration
  // text is inserted into a template, preventing it from becoming page markup.
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**

 * @brief Normalize arbitrary device status text to online, warning, or offline.

 * @param status Raw or normalized device status.

 */

function normalizeStatus(status) {
  // Reduce backend and cached status text to the three states supported by HMI styling.
  status =
    String(status || "offline")
      .toLowerCase();

  // Preserve the two recognized non-offline states; missing or unfamiliar
  // values deliberately fall through to the safe offline state.
  if (status === "online") {
    return "online";
  }

  if (status === "warning") {
    return "warning";
  }

  return "offline";
}

/**

 * @brief Convert normalized status into the power label shown by the UI.

 * @param status Raw or normalized device status.

 */

function powerText(status) {
  // The compact power indicator is on only for a fully online device; warning
  // and offline states both display off to avoid overstating availability.
  return normalizeStatus(status) === "online"
    ? "ON"
    : "OFF";
}

/**

 * @brief Create a human-readable display label from a device or field identifier.

 */

function displayName(name) {
  // Use curated operator-facing device names when one is configured.
  if (
    deviceDisplayNames[name]
  ) {

    return deviceDisplayNames[name];
  }

  // For unknown fields and new devices, expand underscores and camel-case into
  // an uppercase label instead of exposing an unreadable raw identifier.
  return String(name || "")
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toUpperCase();
}

/**

 * @brief Interpret boolean, numeric, and textual values as an active control state.

 */

function isControlOn(value) {
  // Preserve native boolean values and treat any nonzero numeric reading as active.
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return value !== 0;
  }

  // Accept the textual active forms emitted by supported devices and imported captures.
  return ["1", "ON", "TRUE", "ACTIVE", "YES"]
    .includes(
      String(value ?? "")
        .toUpperCase()
    );
}

/**

 * @brief Extract the effective value from a control entry object or primitive.

 * @param entry Source entry containing a primitive or structured value.

 */

function readControlValue(entry) {
  // Structured controls may publish either `value` or `state`; prefer `value`
  // and use zero when neither field exists so an incomplete packet appears inactive.
  if (
    entry &&
    typeof entry === "object" &&
    !Array.isArray(entry)
  ) {
    return entry.value ?? entry.state ?? 0;
  }

  // Primitive entries already represent the effective state; nullish entries
  // again default to zero for predictable rendering.
  return entry ?? 0;
}

/**

 * @brief Determine whether a Button/LED reading is active enough to display in the compact panel.

 */

function shouldSurfaceButtonLedValue(value) {
  // Only active button, switch, or LED values need prominent tiles in the
  // compact panel; inactive entries remain available in the all-fields view.
  return isControlOn(value);
}

/**

 * @brief Filter configured Button/LED controls to the values that should currently be visible.

 * @param items Configured item definitions.

 * @param values Current value map.


 */

function activeButtonLedItems(items, values, kind) {
  // Knobs are meaningful even at zero, so retain every configured knob for
  // which the packet supplied a non-null value.
  if (kind === "knob") {
    return items.filter(([name]) =>
      Object.prototype.hasOwnProperty.call(values, name) &&
      values[name] !== undefined &&
      values[name] !== null
    );
  }

  // For momentary or binary controls, retain configured entries whose displayed
  // value is active, including values temporarily held by the pulse latch.
  return items.filter(([name]) =>
    shouldSurfaceButtonLedValue(
      buttonLedDisplayValue(
        name,
        values[name] ?? 0,
        kind
      )
    )
  );
}

/**

 * @brief Schedule expiry and redraw of momentary Button/LED activity latches.

 */

function scheduleButtonLedPulseRefresh() {
  // One expiry timer is sufficient for all latched controls because the callback
  // reevaluates every stored expiry time before deciding whether another is needed.
  if (buttonLedPulseTimer) {
    return;
  }

  // Wait for the latch interval, redraw the physical button/LED panel, and also
  // refresh its inspector if the operator is currently viewing that device.
  buttonLedPulseTimer =
    setTimeout(() => {
      buttonLedPulseTimer = null;
      renderButtonLedPanel(null);

      if (isSelectedDevice("BUTTON_LED_UNIT")) {
        scheduleSelectedInspectorRender("BUTTON_LED_UNIT");
      }

      // Continue scheduling while any pulse expiry remains in the future; this
      // handles controls activated at different times without one timer per control.
      if (
        Object.values(buttonLedPulseUntil)
          .some(until => Date.now() < until)
      ) {
        scheduleButtonLedPulseRefresh();
      }
    }, CONTROL_LATCH_MS);
}

/**

 * @brief Latch a named active Button/LED control long enough for the operator to see it.

 */

function noteButtonLedPulse(name, value) {
  // Ignore unnamed or inactive readings because only an observed activation
  // should create or extend a visible momentary pulse.
  if (!name || !isControlOn(value)) {
    return;
  }

  // Hold this control's active display for five seconds so a short hardware
  // pulse remains visible long enough for the operator to notice.
  buttonLedPulseUntil[String(name).toUpperCase()] =
    Date.now() + CONTROL_LATCH_MS;
  scheduleButtonLedPulseRefresh();
}

/**

 * @brief Return a Button/LED value adjusted for its momentary visual latch.


 */

function buttonLedDisplayValue(name, value, kind) {
  // Momentary buttons, switches, and LEDs display active until their latch
  // expires; knobs bypass the latch because their numeric position is continuous.
  if (
    kind !== "knob" &&
    Date.now() <
      (buttonLedPulseUntil[String(name || "").toUpperCase()] || 0)
  ) {
    return 1;
  }

  // Outside the latch interval, show the current telemetry value unchanged.
  return value;
}

/**

 * @brief Schedule expiry and inspector redraw for latched joystick activity.

 */

function scheduleJoystickPulseRefresh() {
  // Share one timer across all joystick buttons and hats to avoid creating a
  // timer for every momentary input in a high-rate joystick stream.
  if (joystickPulseTimer) {
    return;
  }

  // When the latch expires, redraw the joystick inspector if it is selected,
  // then reschedule only if another input has a later expiry.
  joystickPulseTimer =
    setTimeout(() => {
      joystickPulseTimer = null;

      if (isSelectedDevice("JOYSTICK_UNIT")) {
        scheduleSelectedInspectorRender("JOYSTICK_UNIT");
      }

      if (
        Object.values(joystickPulseUntil)
          .some(until => Date.now() < until)
      ) {
        scheduleJoystickPulseRefresh();
      }
    }, CONTROL_LATCH_MS);
}

/**

 * @brief Latch a named active joystick input for momentary visual feedback.

 */

function noteJoystickPulse(name, value) {
  // Record only named active joystick inputs; neutral axes and released buttons
  // must not create a false activity latch.
  if (!name || !isControlOn(value)) {
    return;
  }

  // Extend this input's visible activity marker through the common latch period.
  joystickPulseUntil[String(name).toUpperCase()] =
    Date.now() + CONTROL_LATCH_MS;
  scheduleJoystickPulseRefresh();
}

/**

 * @brief Return a joystick input value adjusted for its activity latch.

 */

function joystickDisplayValue(name, value) {
  // Keep a momentary joystick button or hat direction visibly active until its
  // recorded expiry, even if the next packet already reports release.
  if (
    Date.now() <
    (joystickPulseUntil[String(name || "").toUpperCase()] || 0)
  ) {
    return 1;
  }

  return value;
}

/**

 * @brief Format a control value for compact display.

 */

function formatControlValue(value) {
  // Display integers without decimal noise and round analog readings to two
  // decimal places so compact control tiles remain readable.
  if (typeof value === "number") {
    if (Number.isInteger(value)) {
      return String(value);
    }

    return value.toFixed(2);
  }

  // Render booleans in the same 1/0 notation used by hardware control packets.
  if (typeof value === "boolean") {
    return value ? "1" : "0";
  }

  // Preserve other device text while showing a placeholder for missing values.
  return String(value ?? "--");
}

/**

 * @brief Convert a Button/LED knob reading or detent into its rendered dial angle.

 */

function buttonLedKnobAngle(name, value) {
  // Reject nonnumeric knob data rather than producing an invalid CSS rotation.
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return 0;
  }

  // MODE and FREQUENCY use discrete hardware detents in their physical order;
  // other numeric controls fall back to a continuous percentage scale.
  const positions =
    String(name || "").toUpperCase() === "MODE"
      ? [2, 0, 1]
      : String(name || "").toUpperCase() === "FREQUENCY"
        ? [1, 4, 10, 20, 100, 200]
        : null;

  // Convert the matching detent index into the knob's -110° to +110° sweep.
  if (positions) {
    const index = positions.findIndex(item => item === numericValue);

    if (index >= 0) {
      return positions.length === 1
        ? 0
        : -110 + (index / (positions.length - 1)) * 220;
    }
  }

  // Map a generic 0–100 value onto a wider -135° to +135° dial sweep.
  return -135 + Math.max(0, Math.min(100, numericValue)) * 2.7;
}

/**

 * @brief Convert supported control encodings into the operator-facing ON or OFF label.

 */

function controlStateText(value) {
  // Present all supported boolean, numeric, and textual active forms as one
  // consistent ON/OFF label for the operator.
  return isControlOn(value)
    ? "ON"
    : "OFF";
}

/**

 * @brief Determine whether analog control kind.


 */

function isAnalogControlKind(kind) {
  // Knobs and axes represent positions rather than binary active/inactive states.
  return kind === "knob" ||
    kind === "axis";
}

/**

 * @brief Choose the CSS classes that represent an analog or binary control tile's state.


 */

function controlTileClass(kind, active) {
  // Analog controls receive a stable analog class because their numeric value,
  // not an on/off color, communicates their state.
  if (isAnalogControlKind(kind)) {
    return [
      kind,
      "analog"
    ].join(" ");
  }

  // Binary controls add the active or inactive class that drives status coloring.
  return [
    kind,
    active ? "active" : "inactive"
  ].join(" ");
}

/**

 * @brief Build the unique device, group, and control key used by audit metadata.


 * @param group Logical control or telemetry group.

 */

function controlKey(device, group, name) {
  // Combine physical device, control group, and control name so identically
  // named inputs on different panels cannot share audit or duration metadata.
  return [
    device,
    group,
    name
  ].map(v => String(v ?? ""))
    .join("::");
}

/**

 * @brief Normalize analog or binary readings for stable control-change comparison.


 */

function controlStateKey(value, kind) {
  // Round analog positions before comparison so insignificant floating-point
  // jitter does not count as a new operator-visible state change.
  if (isAnalogControlKind(kind)) {
    const n = Number(value);

    return Number.isFinite(n)
      ? n.toFixed(2)
      : String(value ?? "--");
  }

  // Collapse binary encodings to ON/OFF for stable change detection and audit text.
  return isControlOn(value)
    ? "ON"
    : "OFF";
}

/**

 * @brief Format a millisecond duration as a human-readable elapsed time.

 * @param ms Duration in milliseconds.

 */

function formatDuration(ms) {
  // Convert the supplied milliseconds to a nonnegative whole-second duration.
  const total =
    Math.max(
      0,
      Math.floor(Number(ms || 0) / 1000)
    );

  // Split total seconds into hours, minutes, and remaining seconds for concise display.
  const h =
    Math.floor(total / 3600);

  const m =
    Math.floor((total % 3600) / 60);

  const s =
    total % 60;

  // Omit unused larger units so short dwell times do not show redundant zeros.
  if (h) {
    return `${h}h ${m}m`;
  }

  if (m) {
    return `${m}m ${s}s`;
  }

  return `${s}s`;
}

/**

 * @brief Classify a control as nominal, delayed, or stale from its last telemetry time.

 * @param meta Additional status or channel metadata.

 */

function controlHealth(meta) {
  // Measure how long it has been since telemetry last mentioned this control.
  const age =
    Date.now() - (meta.lastSeen || 0);

  // Classify fresh, delayed, and stale control data using thresholds suitable
  // for operator feedback rather than the longer whole-device offline timeout.
  if (age < 2500) {
    return "NOMINAL";
  }

  if (age < 10000) {
    return "DELAYED";
  }

  return "STALE";
}

/**

 * @brief Update control meta.


 * @param group Logical control or telemetry group.



 */

function updateControlMeta(
  device,
  group,
  name,
  value,
  kind,
  timestamp
) {
  // Resolve the unique metadata entry for this physical control and normalize
  // its new value into the comparison form appropriate for analog or binary data.
  const key =
    controlKey(device, group, name);

  const now =
    Date.now();

  const stateKey =
    controlStateKey(value, kind);

  // Binary active time is accumulated separately; analog controls never start
  // an active-duration interval because every numeric position is valid.
  const active =
    isAnalogControlKind(kind)
      ? false
      : isControlOn(value);

  // Initialize lifetime counters and bounded audit history the first time this
  // control appears in live or persisted telemetry.
  if (!controlMeta[key]) {
    controlMeta[key] = {
      device,
      group,
      name,
      kind,
      firstSeen: now,
      lastSeen: now,
      lastChanged: now,
      lastValue: value,
      stateKey,
      toggleCount: 0,
      activeSince: active ? now : null,
      totalActiveMs: 0,
      operatorTouches: 0,
      lastOperatorAt: null,
      history: []
    };
  }

  const meta =
    controlMeta[key];

  // When the normalized state changes, close the preceding active interval,
  // update change counters, and begin a new interval when the control is active.
  if (meta.stateKey !== stateKey) {

    if (meta.activeSince) {
      meta.totalActiveMs +=
        now - meta.activeSince;
    }

    meta.toggleCount++;
    meta.lastChanged = now;
    meta.activeSince = active ? now : null;
    meta.stateKey = stateKey;

    // Prepend the transition so diagnostics show newest activity first, using
    // the packet timestamp when available and browser time as a fallback.
    meta.history.unshift({
      time:
        timestamp ||
        new Date(now).toLocaleTimeString(),
      value: stateKey,
      source: "TELEMETRY"
    });

    // Bound each control's local audit trail to the 50 most recent transitions.
    if (meta.history.length > 50) {
      meta.history.length = 50;
    }
  }

  // Refresh current-value fields on every packet, even when the normalized
  // state did not change, so health age and analog readings remain accurate.
  meta.lastSeen = now;
  meta.lastValue = value;
  meta.kind = kind;

  return meta;
}

/**

 * @brief Calculate how long the control has remained in its current state.

 * @param meta Additional status or channel metadata.

 */

function controlStateDuration(meta) {
  // Measure the dwell time of the current state from its last transition, or
  // from first observation when the control has never changed.
  return Date.now() -
    (meta.lastChanged || meta.firstSeen || Date.now());
}

/**

 * @brief Record operator interaction.


 * @param group Logical control or telemetry group.

 */

function recordOperatorInteraction(
  device,
  group,
  name
) {
  // Locate the same metadata entry used by telemetry transitions so inspection
  // activity and device activity appear together in diagnostics.
  const key =
    controlKey(device, group, name);

  const now =
    Date.now();

  // Create a metadata shell when an operator inspects a control before any
  // telemetry packet has established its current state.
  if (!controlMeta[key]) {
    controlMeta[key] = {
      device,
      group,
      name,
      kind: "operator",
      firstSeen: now,
      lastSeen: now,
      lastChanged: now,
      lastValue: "--",
      stateKey: "--",
      toggleCount: 0,
      activeSince: null,
      totalActiveMs: 0,
      operatorTouches: 0,
      lastOperatorAt: null,
      history: []
    };
  }

  const meta =
    controlMeta[key];

  // Count the inspection and record its time without pretending the operator
  // changed the physical device state.
  meta.operatorTouches++;
  meta.lastOperatorAt = now;

  // Add an operator-sourced audit entry and retain the same 50-entry bound used
  // for telemetry transitions.
  meta.history.unshift({
    time:
      new Date(now).toLocaleTimeString(),
    value: "INSPECTED",
    source: "OPERATOR"
  });

  if (meta.history.length > 50) {
    meta.history.length = 50;
  }

  // Move the inspector to this device's diagnostics tab so the interaction
  // reveals the detailed history the operator requested.
  selectedDevice = device;
  inspectorTab = "diagnostics";
  renderDeviceInspector();
}

/**

 * @brief Build the control tile's value, dwell, activity-count, and freshness details.

 * @param meta Additional status or channel metadata.

 */

function controlTelemetryHtml(meta) {
  // Derive freshness once so both analog and binary markup use identical health text and class names.
  const health =
    controlHealth(meta);

  // Analog tiles report their numeric position, change count, age, and health;
  // the frequency selector adds its engineering unit.
  if (isAnalogControlKind(meta.kind)) {
    const unit =
      String(meta.name || "").toUpperCase() === "FREQUENCY"
        ? " Hz"
        : "";
    const currentValue =
      `${formatControlValue(meta.lastValue)}${unit}`;

    return `
      <div class="controlTelemetry analogTelemetry">
        <span>Current Value <strong>${esc(currentValue)}</strong></span>
        <span>Changes ${esc(meta.toggleCount)}</span>
        <span>Updated ${esc(formatDuration(controlStateDuration(meta)))}</span>
        <span class="controlHealth ${health.toLowerCase()}">${esc(health)}</span>
      </div>
    `;
  }

  // Binary tiles emphasize current ON/OFF state, dwell time, transition count,
  // operator inspections, and the age-based health classification.
  return `
    <div class="controlTelemetry">
      <span>State ${esc(meta.stateKey)}</span>
      <span>Dwell ${esc(formatDuration(controlStateDuration(meta)))}</span>
      <span>Changes ${esc(meta.toggleCount)}</span>
      <span>Ops ${esc(meta.operatorTouches)}</span>
      <span class="controlHealth ${health.toLowerCase()}">${esc(health)}</span>
    </div>
  `;
}

/**

 * @brief Validate that a telemetry row contains fields characteristic of its declared channel.


 * @param channel Normalized channel name.

 * @param process Normalized process name.

 * @param explicitDeviceName Explicit device identifier extracted from the row.

 */

function rowMatchesChannelSignature(row, channel, process, explicitDeviceName) {
  // Inspect top-level payload keys because legacy rows may omit an explicit
  // device name while still containing fields unique to one channel type.
  const payloadKeys = Object.keys(row || {});

  // Each branch accepts either a matching configured channel/process, an
  // explicit physical-device hint, or a characteristic set of telemetry keys.
  if (channel === "maindisplay" || process === "maindisplay" || process === "main_display") {
    return (
      explicitDeviceName.includes("DISPLAY") ||
      payloadKeys.includes("video_source") ||
      payloadKeys.includes("recording") ||
      payloadKeys.includes("fps") ||
      payloadKeys.includes("tracker_enabled") ||
      payloadKeys.includes("imu_enabled")
    );
  }

  if (channel === "joystick" || process === "joystick") {
    return (
      explicitDeviceName.includes("JOYSTICK") ||
      payloadKeys.includes("axes") ||
      payloadKeys.includes("buttons") ||
      payloadKeys.includes("hats") ||
      payloadKeys.includes("connected")
    );
  }

  if (channel === "button_led" || process === "button_led") {
    return (
      explicitDeviceName.includes("BUTTON") ||
      payloadKeys.includes("buttons") ||
      payloadKeys.includes("switches") ||
      payloadKeys.includes("knobs") ||
      payloadKeys.includes("mode") ||
      payloadKeys.includes("frequency_hz")
    );
  }

  if (channel === "imu" || process === "imu") {
    return (
      explicitDeviceName.includes("IMU") ||
      payloadKeys.includes("yaw") ||
      payloadKeys.includes("pitch") ||
      payloadKeys.includes("roll") ||
      payloadKeys.includes("accel_x") ||
      payloadKeys.includes("gyro_x")
    );
  }

  if (channel === "external_track" || process === "external_track") {
    return (
      explicitDeviceName.includes("EXTERNAL") ||
      payloadKeys.includes("track_id") ||
      payloadKeys.includes("azimuth_deg") ||
      payloadKeys.includes("elevation_deg") ||
      payloadKeys.includes("range_m") ||
      payloadKeys.includes("command")
    );
  }

  if (channel === "advantec_driver" || process === "advantec_driver") {
    return (
      explicitDeviceName.includes("ADVANTECH") ||
      payloadKeys.includes("di_mask") ||
      payloadKeys.includes("do_mask") ||
      payloadKeys.includes("device_connected") ||
      payloadKeys.includes("health")
    );
  }

  if (channel === "lcu_transport" || process === "lcu_transport") {
    return (
      explicitDeviceName.includes("LCU") ||
      payloadKeys.includes("drive_state") ||
      payloadKeys.includes("body") ||
      payloadKeys.includes("name") ||
      payloadKeys.includes("src")
    );
  }

  if (channel === "wcs_control_console" || process === "wcs_control_console") {
    return (
      explicitDeviceName.includes("WCS") ||
      payloadKeys.includes("pan_actual_deg") ||
      payloadKeys.includes("tilt_actual_deg") ||
      payloadKeys.includes("tracker_pan_error") ||
      payloadKeys.includes("tracker_tilt_error") ||
      payloadKeys.includes("drive_connected")
    );
  }

  if (
    channel === "tracker_telemetry" ||
    channel === "tracker_telem" ||
    process === "tracker_telemetry" ||
    process === "camera"
  ) {
    return (
      explicitDeviceName.includes("CAMERA") ||
      payloadKeys.includes("camera_id") ||
      payloadKeys.includes("track_cam_id") ||
      payloadKeys.includes("tracker_ret_x") ||
      payloadKeys.includes("tracker_ret_y") ||
      payloadKeys.includes("tracker_bb_w") ||
      payloadKeys.includes("tracker_bb_h") ||
      payloadKeys.includes("pan") ||
      payloadKeys.includes("tilt") ||
      payloadKeys.includes("pan_deg") ||
      payloadKeys.includes("tilt_deg") ||
      payloadKeys.includes("pan_angle") ||
      payloadKeys.includes("tilt_angle") ||
      payloadKeys.includes("video_source")
    );
  }

  if (
    channel === "tracker_publish" ||
    process === "tracker_publish" ||
    process === "drive"
  ) {
    return (
      explicitDeviceName.includes("TRACKER") ||
      explicitDeviceName.includes("DRIVE") ||
      payloadKeys.includes("rpm") ||
      payloadKeys.includes("current") ||
      payloadKeys.includes("voltage") ||
      payloadKeys.includes("torque_nm") ||
      payloadKeys.includes("motor_temperature_c") ||
      payloadKeys.includes("fault_status") ||
      payloadKeys.includes("drive_connected") ||
      payloadKeys.includes("io_status")
    );
  }

  return true;
}

/**
 * Determines the physical device represented by a telemetry row.
 *
 * Identification is performed in the following order:
 * 1. Use an explicit device name when it maps to a recognised alias.
 * 2. Validate that the payload matches the declared channel signature.
 * 3. Map known channels and process names to canonical device names.
 * 4. Inspect payload fields when channel metadata is missing or ambiguous.
 * 5. Return the original identity or UNKNOWN_DEVICE when no reliable match exists.
 *
 * This function prevents telemetry from one channel being displayed under an
 * unrelated device merely because the packet contains a generic field name.
 *
 * @param {Object} row - Normalised telemetry row received from live data or history.

/**

 * @brief Classify a telemetry row into its canonical physical device.

 */

function physicalDeviceForRow(row) {
  // Normalize channel and process metadata independently because live packets,
  // database rows, and imported captures do not always populate the same field.
  const channel =
    String(
      row?.channel ||
      row?.channel_name ||
      ""
    ).trim().toLowerCase();

  const process =
    String(
      row?.process_name ||
      row?.process ||
      ""
    ).trim().toLowerCase();

  // Preserve the packet's explicit device text for signature checks, then try
  // the authoritative alias map before inferring identity from payload fields.
  const explicitDeviceSource =
    String(
      row?.device_name ||
      row?.device ||
      row?.subdevice_name ||
      row?.subdevice ||
      ""
    ).trim();

  const explicitDeviceName =
    explicitDeviceSource.toUpperCase();

  const explicitAlias =
    statusDeviceName(explicitDeviceSource);

  // An explicit recognized device is stronger evidence than channel heuristics.
  if (explicitAlias !== "UNKNOWN_DEVICE") {
    return explicitAlias;
  }

  // Reject a declared channel whose payload lacks that channel's characteristic
  // fields; this prevents generic keys from assigning data to the wrong panel.
  if (!rowMatchesChannelSignature(row, channel, process, explicitDeviceName)) {
    return "UNKNOWN_DEVICE";
  }

  // Resolve unambiguous display, camera, and drive transport names before using
  // the broader configured channel map.
  if (channel === "maindisplay" || process === "maindisplay" || process === "main_display") {
    return "MAIN_DISPLAY";
  }

  if (
    channel === "tracker_telemetry" ||
    channel === "tracker_telem" ||
    process === "tracker_telemetry" ||
    process === "camera"
  ) {
    return "CAMERA_UNIT";
  }

  if (
    channel === "tracker_publish" ||
    process === "tracker_publish" ||
    process === "drive"
  ) {
    return "DRIVE_UNIT";
  }

  if (channelDeviceMap[channel]) {
    return canonicalInspectorDevice(channelDeviceMap[channel]);
  }

  // Inspect the packet keys when metadata is absent or ambiguous. Camera fields
  // describe imagery/tracker geometry, while drive fields describe motor power,
  // motion, connectivity, and faults.
  const payloadKeys =
    Object.keys(row || {});

  const isCameraTelemetry =
    row?.camera_id !== undefined ||
    row?.track_cam_id !== undefined ||
    row?.tracker_ret_x !== undefined ||
    row?.tracker_ret_y !== undefined ||
    row?.tracker_bb_w !== undefined ||
    row?.tracker_bb_h !== undefined ||
    row?.tracking !== undefined ||
    row?.tracker_enabled !== undefined ||
    row?.video_source !== undefined ||
    row?.fps !== undefined ||
    row?.pan !== undefined ||
    row?.tilt !== undefined ||
    row?.pan_deg !== undefined ||
    row?.tilt_deg !== undefined ||
    row?.pan_angle !== undefined ||
    row?.tilt_angle !== undefined ||
    row?.day_ret_x !== undefined ||
    row?.day_ret_y !== undefined ||
    row?.thermal_ret_x !== undefined ||
    row?.thermal_ret_y !== undefined ||
    row?.low_light_ret_x !== undefined ||
    row?.low_light_ret_y !== undefined ||
    row?.tracker_pixel_dx !== undefined ||
    row?.tracker_pixel_dy !== undefined ||
    payloadKeys.includes("camera_id") ||
    payloadKeys.includes("track_cam_id") ||
    payloadKeys.includes("tracker_ret_x") ||
    payloadKeys.includes("tracker_ret_y") ||
    payloadKeys.includes("video_source") ||
    payloadKeys.includes("pan") ||
    payloadKeys.includes("tilt") ||
    payloadKeys.includes("pan_deg") ||
    payloadKeys.includes("tilt_deg") ||
    payloadKeys.includes("pan_angle") ||
    payloadKeys.includes("tilt_angle") ||
    payloadKeys.includes("day_ret_x") ||
    payloadKeys.includes("day_ret_y") ||
    payloadKeys.includes("thermal_ret_x") ||
    payloadKeys.includes("thermal_ret_y");

  const isDriveTelemetry =
    row?.rpm !== undefined ||
    row?.motor_rpm !== undefined ||
    row?.speed_rpm !== undefined ||
    row?.actual_rpm !== undefined ||
    row?.current !== undefined ||
    row?.current_a !== undefined ||
    row?.motor_current !== undefined ||
    row?.motor_current_a !== undefined ||
    row?.voltage !== undefined ||
    row?.voltage_v !== undefined ||
    row?.dcbus_voltage !== undefined ||
    row?.bus_voltage !== undefined ||
    row?.fault_status !== undefined ||
    row?.fault !== undefined ||
    row?.drive_fault !== undefined ||
    row?.drive_connected !== undefined ||
    payloadKeys.includes("rpm") ||
    payloadKeys.includes("motor_rpm") ||
    payloadKeys.includes("fault_status") ||
    payloadKeys.includes("drive_connected");

  // Assign a device only when one signature wins; mixed packets continue to
  // later identity checks rather than being guessed from overlapping fields.
  if (isCameraTelemetry && !isDriveTelemetry) {
    return "CAMERA_UNIT";
  }

  if (isDriveTelemetry && !isCameraTelemetry) {
    return "DRIVE_UNIT";
  }

  // Use explicit device-name fragments next because they remain useful even
  // when the full text was not a known alias.
  if (explicitDeviceName.includes("CAMERA")) {
    return "CAMERA_UNIT";
  }

  if (explicitDeviceName.includes("TRACKER_PUBLISH") || explicitDeviceName.includes("DRIVE")) {
    return "DRIVE_UNIT";
  }

  if (explicitDeviceName.includes("DISPLAY")) {
    return "MAIN_DISPLAY";
  }

  // Try canonical aliases derived from channel and process metadata before
  // falling back to free-form row identity.
  const channelAlias =
    statusDeviceName(channel);

  if (channelAlias !== "UNKNOWN_DEVICE") {
    return channelAlias;
  }

  const processAlias =
    statusDeviceName(process);

  if (processAlias !== "UNKNOWN_DEVICE") {
    return processAlias;
  }

  // Resolve common physical-device fragments in legacy names that predate the
  // current canonical alias table.
  let device =
    String(
      row?.device_name ||
      row?.device ||
      ""
    ).trim().toUpperCase();
  const statusAlias =
    statusDeviceName(device);

  if (statusAlias !== "UNKNOWN_DEVICE") {
    return statusAlias;
  }

  if (device.includes("CAMERA"))
    return "CAMERA_UNIT";
  if (device.includes("IMU"))
    return "IMU_UNIT";

  if (device.includes("JOYSTICK"))
    return "JOYSTICK_UNIT";
  // Advantech packets can be identified reliably from service/type metadata or
  // their digital input/output masks even without a device name.
  if (
    device.includes("BUTTON") ||
    device.includes("BUTTON_LED")
  ) {
    return "BUTTON_LED_UNIT";
  }
  if (
    device.includes("TRACKER") &&
    !device.includes("EXTERNAL")
  )
    return "DRIVE_UNIT";

  if (device.includes("EXTERNAL"))
    return "EXTERNAL_TRACK_UNIT";

  if (device.includes("LCU"))
    return "LCU_UNIT";

  if (device.includes("CCE"))
    return "CCE_GATEWAY";

  if (device.includes("DISPLAY"))
    return "MAIN_DISPLAY";

  if (device.includes("WCS"))
    return "WCS_CONSOLE";

  if (
    row?.service === "advantec_driver" ||
    row?.type === "io_status" ||
    row?.di_mask !== undefined ||
    row?.do_mask !== undefined
  ) {
    return "ADVANTECH_IO";
  }

  // Preserve the best remaining explicit identity so a new or unknown device
  // is visible to diagnostics instead of disappearing from the HMI.
  const fallbackIdentity =
    device ||
    String(
      row?.subdevice_name ||
      row?.subdevice ||
      channel ||
      process ||
      "UNKNOWN_DEVICE"
    ).trim().toUpperCase();

  return fallbackIdentity || "UNKNOWN_DEVICE";
}

/**

 * @brief Resolve the specialized renderer associated with a device.


 */

function getDeviceRenderer(device) {
  // Normalize aliases, but also check the original key so explicitly registered
  // legacy renderer names continue to work.
  const canonical =
    canonicalInspectorDevice(device);

  return (
    DEVICE_RENDERERS[device] ||
    DEVICE_RENDERERS[canonical]
  );
}

/**

 * @brief Reset device cached state.


 */

function resetDeviceCachedState(device) {
  // Reset only the device-specific cache named by the caller; state for other
  // online devices must survive one unit going offline.
  const canonical = canonicalInspectorDevice(device);

  // Clear all Button/LED control groups and pulse latches so an offline panel
  // cannot retain illuminated controls from its last packet.
  if (canonical === "BUTTON_LED_UNIT") {
    controlState.button_led.buttons = {};
    controlState.button_led.switches = {};
    controlState.button_led.knobs = {};
    controlState.button_led.leds = {};
    controlState.button_led.timestamp = "";
    Object.keys(buttonLedPulseUntil)
      .forEach(key => delete buttonLedPulseUntil[key]);
  }

  // Clear joystick positions, buttons, connectivity, and activity latches when
  // its heartbeat expires.
  if (canonical === "JOYSTICK_UNIT") {
    controlState.joystick.axes = {};
    controlState.joystick.thumbwheels = {};
    controlState.joystick.buttons = {};
    controlState.joystick.hats = {};
    controlState.joystick.connected = false;
    controlState.joystick.timestamp = "";
    Object.keys(joystickPulseUntil)
      .forEach(key => delete joystickPulseUntil[key]);
  }

  // Remove retained LCU axes and common fields so a reconnect starts from the
  // next complete transport state rather than mixing old and new values.
  if (canonical === "LCU_UNIT") {
    Object.keys(lcuStableState.axes)
      .forEach(key => delete lcuStableState.axes[key]);
    Object.keys(lcuStableState.common)
      .forEach(key => delete lcuStableState.common[key]);
    lcuStableState.timestamp = "";
  }
}

/**

 * @brief Remove cached live state and reset the visual representation of a device.



 */

function clearDeviceLiveView(device, timestamp = "") {
  // A missing identity cannot be removed safely because it would not select a
  // bounded cache or DOM panel.
  if (!device) {
    return;
  }

  // Remove live payload and signal summaries, then clear the specialized cache
  // used by Button/LED, joystick, or LCU renderers.
  delete liveDeviceState[device];
  delete deviceRecentSignals[device];
  resetDeviceCachedState(device);

  // Delete both supplied and canonical history keys because earlier packets may
  // have been stored under either alias.
  const canonical = canonicalInspectorDevice(device);
  delete devicePacketHistory[device];
  delete devicePacketHistory[canonical];
  delete deviceAuditHistory[device];
  delete deviceAuditHistory[canonical];
  // Remove per-control audit metadata belonging to this physical unit while
  // leaving controls from all other devices intact.
  Object.keys(controlMeta).forEach(key => {
    if (canonicalInspectorDevice(controlMeta[key]?.device) === canonical) {
      delete controlMeta[key];
    }
  });

  // Replace the device card's recent-signal list with a waiting message.
  const signalsEl =
    document.getElementById(
      "signals_" + safeId(device)
    );

  if (signalsEl) {
    signalsEl.innerHTML =
      '<div class="deviceSignalEmpty">Waiting for data</div>';
  }

  // Ask the specialized renderer to clear its instrument by passing a null
  // payload; renderers use the supplied timestamp for their offline display.
  const renderer =
    getDeviceRenderer(device);

  if (typeof renderer === "function") {
    renderer(null, timestamp);
  }

  // Rebuild the detail view when the cleared device is currently selected so
  // stale readings disappear from the inspector immediately.
  if (isSelectedDevice(device)) {
    renderSelectedDeviceDetail();
  }
}

/**

 * @brief Create or return the summary panel for a device.


 */

function ensureDevicePanel(device) {
  // Device cards are mounted in the shared HMI canvas; without that container
  // the caller cannot create or update a panel.
  const canvas =
    $("hmiCanvas");

  if (!canvas) return null;

  // Reuse the existing card when live/status updates have already created it.
  const deviceId =
    "device_" +
    safeId(device);

  let panel =
    $(deviceId);

  if (panel) {
    return panel;
  }

  // Create a new offline card and bind selection to the whole panel so clicking
  // any part opens this device in the inspector.
  panel =
    document.createElement("div");

  panel.id =
    deviceId;

  panel.className =
    "devicePanel offline";

  panel.onclick = () => {

    selectDevice(device);

  };

  // Populate stable status, health, count, rate, endpoint, and recent-signal
  // mount points. Later updates change these nodes without recreating the card.
  panel.innerHTML = `

<div class="deviceTitle">

  <div class="deviceLive"></div>

<h2>${esc(displayName(device))}</h2>
  <div class="devicePowerBadge off">
    OFF
  </div>

</div>

<div class="deviceHealthBar">

  <div
    id="health_${safeId(device)}"
    class="healthFill">
  </div>

</div>

<div class="deviceStats">

  <div>
    Packets:
    <span id="packets_${safeId(device)}">
      0
    </span>
  </div>

  <div>
    Rate:
    <span id="rate_${safeId(device)}">
      0/s
    </span>
  </div>

</div>

<div class="deviceLastSeen">

  Last Activity:
  <span id="lastseen_${safeId(device)}">
    --
  </span>

</div>

<div class="deviceMulticast">

  Status:
  <span id="status_${safeId(device)}">
    ONLINE
  </span>

</div>

<div class="deviceMiniStatus">
  LIVE TELEMETRY
</div>

<div
  id="signals_${safeId(device)}"
  class="deviceLiveSignals"
  aria-live="polite">
  <div class="deviceSignalEmpty">Waiting for data</div>
</div>

`;

  // Attach the complete card to the HMI canvas and return it to the status updater.
  canvas.appendChild(panel);

  return panel;
}

/**

 * @brief Update the recent-signal preview displayed on a device card.



 */

function updateDevicePanelSignals(device, row) {
  // Ignore incomplete calls because a recent-signal entry requires both a
  // destination device card and one telemetry row.
  if (!device || !row) {
    return;
  }

  // Accept either live-row key spelling, but reject blank keys that cannot form
  // a meaningful operator label.
  const key =
    row.key ??
    row.value_key;

  if (key === undefined || key === null || String(key).trim() === "") {
    return;
  }

  // Replace an older entry for the same signal, prepend the newest value, and
  // retain only four rows so the compact device card does not grow indefinitely.
  const value = rowValue(row);
  const signals = deviceRecentSignals[device] || [];
  const next = signals.filter(signal => signal.key !== String(key));

  next.unshift({
    key: String(key),
    value: value ?? "--",
    timestamp: row.timestamp || row.server_timestamp || ""
  });

  deviceRecentSignals[device] = next.slice(0, 4);

  // Locate this device card's signal mount; status may arrive before the card is available.
  const container =
    document.getElementById(
      "signals_" + safeId(device)
    );

  if (!container) {
    return;
  }

  // Render the retained newest-first signal list, escaping both field labels,
  // values, and timestamp tooltips because all originate in telemetry.
  container.innerHTML = deviceRecentSignals[device]
    .map(signal => `
      <div class="deviceSignalRow" title="${esc(signal.timestamp)}">
        <span>${esc(displayName(signal.key))}</span>
        <strong>${esc(String(signal.value))}</strong>
      </div>
    `)
    .join("");
}

/**

 * @brief Return the selected detail container only when it belongs to the requested device.


 */

function getDeviceDetail(device) {
  // Delegate selection validation to selectedDetailFor so a device renderer
  // cannot accidentally target another unit's inspector DOM.
  return selectedDetailFor(device);
}
/**
 * @brief Apply online, warning, or offline status and associated metrics to a device panel.
 * @param status Raw or normalized device status.
 * @param lastSeen Last-activity timestamp shown for the device.
 * @param meta Additional status or channel metadata.
 */
function setDeviceStatus(device, status, lastSeen, meta = {}) {
  // Status records without an identity cannot be associated with a bounded HMI panel.
  if (!device) return;

  const normalized =
    normalizeStatus(status);

  // When both the backend status and browser heartbeat say offline, clear all
  // device-specific live values before showing the offline card.
  if (
    normalized === "offline" &&
    !hasDeviceHeartbeatWithinMs(device)
  ) {
    clearDeviceLiveView(device, lastSeen || "");
  }

  // Ensure the card exists, then collect the individual nodes updated by this
  // status record and the latest packet metrics.
  const panel =
    ensureDevicePanel(device);

  if (!panel) return;

  const badge =
    panel.querySelector(
      ".devicePowerBadge"
    );

  const lastSeenEl =
    panel.querySelector(
      ".deviceLastSeen span"
    );

  const groupEl =
    panel.querySelector(
      ".deviceMulticast span"
    );
  const packetEl =
    document.getElementById(
      "packets_" + safeId(device)
    );
  const rateEl =
    document.getElementById(
      "rate_" + safeId(device)
    );
  const metrics =
    deviceMetrics[device] || {};

  // Replace the mutually exclusive panel state class so CSS shows the correct health color.
  panel.classList.remove(
    "online",
    "warning",
    "offline"
  );

  panel.classList.add(normalized);

  // Update the compact ON/OFF badge from normalized availability.
  if (badge) {

    badge.classList.remove(
      "on",
      "off"
    );

    badge.classList.add(
      normalized === "online"
        ? "on"
        : "off"
    );

    badge.textContent =
      powerText(normalized);
  }

  // Show last activity and multicast endpoint when supplied, preserving an
  // existing endpoint when this status source has no network metadata.
  if (lastSeenEl) {
    lastSeenEl.textContent =
      lastSeen || "--";
  }

  if (groupEl) {
    if (meta.group_ip) {
      groupEl.textContent =
        `${meta.group_ip}:${meta.port || "-"}`;
    } else if (!groupEl.textContent.trim()) {
      groupEl.textContent = "--";
    }
  }

  // Prefer live browser counts and rates, falling back to backend row totals for
  // a device that has not yet received a WebSocket packet in this session.
  if (packetEl) {
    packetEl.textContent =
      metrics.packetCount || meta.rows || 0;
  }

  if (rateEl) {
    rateEl.textContent =
      (metrics.packetRate || metrics.rate || 0) + "/s";
  }
}

/**

 * @brief Render status summary.

 */

function renderStatusSummary(devices) {
  // The HMI header is optional on embedded views, so leave without rendering when absent.
  const el =
    $("hmiStatus");

  if (!el) return;

  // Seed a canonical-device map from backend status records so aliases are not double-counted.
  const known =
    new Map();

  (devices || []).forEach(d => {

    const panelDevice =
      statusDeviceName(d.device);

    known.set(panelDevice, {
      status: d.status
    });
  });

  // Merge devices observed only in live browser state, using fresh packet
  // metrics ahead of older backend status values.
  [
    ...Object.keys(deviceMetrics),
    ...Object.keys(liveDeviceState),
    ...Object.keys(deviceHeartbeat)
  ].forEach(device => {
    const canonical =
      statusDeviceName(device);

    known.set(canonical, {
      status:
        (deviceMetrics[canonical]?.online || deviceMetrics[device]?.online)
          ? "online"
          : deviceStatuses[canonical]?.status ||
            deviceStatuses[device]?.status ||
            "offline"
    });
  });

  // Count fully online devices; warning and offline devices belong in the OFF
  // total used by the conservative power summary.
  const online =
    [...known.values()].filter(d =>
      normalizeStatus(d.status) === "online"
    ).length;

  const off =
    known.size - online;

  // Replace the header summary with the current online/offline device totals.
  el.innerHTML = `
    <div class="hmiPowerSummary">
      <span class="summaryOn">${online} ON</span>
      <span class="summaryOff">${off} OFF</span>
    </div>
  `;
}

/**

 * @brief Resolve status API and channel aliases to one canonical physical-device name.


 */

function statusDeviceName(device) {
  // Normalize spelling and separators before consulting shared and local aliases.
  const normalized =
    String(device || "")
      .trim()
      .toUpperCase()
      .replace(/[\s-]+/g, "_");

  // Prefer the shared canonical mapping so every page agrees on device identity.
  if (typeof canonicalDeviceName === "function") {
    const canonical =
      canonicalDeviceName(normalized);

    if (canonical) {
      return canonical;
    }
  }

  // Cover HMI channel names and historical aliases that may arrive in status APIs.
  const map = {
    BUTTON: "BUTTON_LED_UNIT",
    BUTTON_LED: "BUTTON_LED_UNIT",
    BUTTON_LED_UNIT: "BUTTON_LED_UNIT",
    DRIVE: "DRIVE_UNIT",
    DRIVE_WCS: "DRIVE_UNIT",
    DRIVE_UNIT: "DRIVE_UNIT",
    TRACKER_PUBLISH: "DRIVE_UNIT",
    TRACKER_PUBLISH_UNIT: "DRIVE_UNIT",
    LCU: "LCU_UNIT",
    LCU_UNIT: "LCU_UNIT",
    LCU_TRANSPORT: "LCU_UNIT",
    WCS: "WCS_CONSOLE",
    WCS_CONTROL_CONSOLE: "WCS_CONSOLE",
    WCS_CONSOLE: "WCS_CONSOLE",
    CCE: "CCE_GATEWAY",
    CCE_GATEWAY: "CCE_GATEWAY",
    IMU: "IMU_UNIT",
    IMU_UNIT: "IMU_UNIT",
    JOYSTICK: "JOYSTICK_UNIT",
    JOYSTICK_UNIT: "JOYSTICK_UNIT",
    MAIN_DISPLAY: "MAIN_DISPLAY",
    MAINDISPLAY: "MAIN_DISPLAY",
    MAIN: "MAIN_DISPLAY",
    CAMERA: "CAMERA_UNIT",
    CAMERA_UNIT: "CAMERA_UNIT",
    TRACKER_TELEMETRY: "CAMERA_UNIT",
    EXTERNAL_TRACK: "EXTERNAL_TRACK_UNIT",
    ADVANTECH: "ADVANTECH_IO",
    ADVANTEC_DRIVER: "ADVANTECH_IO",
    ADVANTECH_IO: "ADVANTECH_IO"
  };

  // Preserve an unknown normalized identity for diagnostics, using an explicit
  // placeholder only when the source contained no usable name.
  return map[normalized] || normalized || "UNKNOWN_DEVICE";
}

/**

 * @brief Refresh device status data while coalescing concurrent requests.

 * @async

 */

async function refreshDeviceStatuses() {
  // Share an active refresh promise so fallback timers and manual callers do not
  // issue duplicate device-status API requests.
  if (hmiStatusRefreshInFlight) {
    return hmiStatusRefreshInFlight;
  }

  hmiStatusRefreshInFlight = refreshDeviceStatusesOnce();

  // Clear the shared promise on success or failure so a later refresh can retry.
  try {
    return await hmiStatusRefreshInFlight;
  } finally {
    hmiStatusRefreshInFlight = null;
  }
}

/**

 * @brief Load, merge, and render device status information from backend APIs.

 * @async

 */

async function refreshDeviceStatusesOnce() {
  // Read the operator's selected daily database, falling back to shared page state.
  const db =
    $("dbSelect")?.value || App.db;

  if (!db) return;

  // Request both HMI-specific and general device summaries concurrently; either
  // endpoint may provide fields missing from the other.
  const encodedDb = encodeURIComponent(db);
  const results = await Promise.allSettled([
    api("/api/hmi/devices?db=" + encodedDb),
    api("/api/devices?db=" + encodedDb)
  ]);
  const byDevice = new Map();

  // Merge fulfilled array responses by canonical device, allowing later fields
  // to augment the record already collected from the other endpoint.
  results.forEach(result => {
    if (result.status !== "fulfilled" || !Array.isArray(result.value)) {
      return;
    }

    result.value.forEach(entry => {
      if (!entry?.device) {
        return;
      }

      const device = statusDeviceName(entry.device);
      byDevice.set(device, {
        ...(byDevice.get(device) || {}),
        ...entry,
        device
      });
    });
  });

  // If both sources yielded no devices and at least one failed, preserve current
  // live panels because this may be a transient API interruption.
  const devices = [...byDevice.values()];

  if (!devices.length && results.some(result => result.status === "rejected")) {
    console.warn(
      "HMI device status refresh failed:",
      results.map(result => result.reason)
    );
    /* A short API stall must not erase valid live telemetry.  The WebSocket
       and the next successful refresh will update the existing panels. */
    return;
  }

  // A successful empty result represents a genuinely empty selected database,
  // so replace the canvas with an explanatory offline message.
  if (!devices.length) {
    setHtml(
      "hmiCanvas",
      '<div class="devicePanel offline"><div class="deviceTitle"><h2>No devices found</h2><div class="devicePowerBadge off">OFF</div></div><div class="deviceSignalEmpty">The selected database has no HMI device status rows yet.</div></div>'
    );
  }

  // For each backend device, initialize or reconcile live metrics, usage timing,
  // panel status, and persisted HMI state without allowing older row counts to
  // reduce counters already observed in this browser session.
  (Array.isArray(devices) ? devices : []).forEach(d => {

const panelDevice = d.device;

deviceStatuses[panelDevice] = d;

if (!deviceMetrics[panelDevice]) {
  deviceMetrics[panelDevice] = {
    packets: 0,
    lastPacket: parseTs(d.last_seen),
    lastRateCalc: Date.now(),
    rate: 0,
    packetCount: Number(d.rows || 0),
    packetRate: 0,
    online: normalizeStatus(d.status) === "online",
    lastSeen: d.last_seen || "-",
    anomalies: Number(d.anomalies || 0),
    health: normalizeStatus(d.status) === "online" ? 100 : 0
  };
} else {
  const liveFresh =
    Number.isFinite(deviceHeartbeat[panelDevice]) &&
    Date.now() - deviceHeartbeat[panelDevice] <= LIVE_STALE_MS;

  deviceMetrics[panelDevice].online =
    liveFresh ||
    normalizeStatus(d.status) === "online";
  deviceMetrics[panelDevice].lastSeen =
    liveFresh
      ? deviceMetrics[panelDevice].lastSeen
      : d.last_seen || deviceMetrics[panelDevice].lastSeen;
  deviceMetrics[panelDevice].packetCount =
    Math.max(
      Number(deviceMetrics[panelDevice].packetCount || 0),
      Number(d.rows || 0)
    );
}

if (!deviceUsageStats[panelDevice]) {
  deviceUsageStats[panelDevice] = {
    toggleCount: 0,
    lastState: null,
    lastOnTime: null,
    lastOffTime: null,
    totalOnMs: 0,
    stateStartTime: Date.now()
  };
}

if (normalizeStatus(d.status) === "online") {
  deviceUsageStats[panelDevice].lastOnTime =
    d.last_seen || deviceUsageStats[panelDevice].lastOnTime;
} else if (d.last_seen) {
  deviceUsageStats[panelDevice].lastOffTime =
    d.last_seen;
}

{
  const liveFresh =
    Number.isFinite(deviceHeartbeat[panelDevice]) &&
    Date.now() - deviceHeartbeat[panelDevice] <= LIVE_STALE_MS;

  setDeviceStatus(
    panelDevice,
    liveFresh ? "online" : d.status,
    liveFresh
      ? deviceMetrics[panelDevice]?.lastSeen || d.last_seen
      : d.last_seen,
    d
  );
}

if (
  normalizeStatus(d.status) === "online" ||
  hasDeviceHeartbeatWithinMs(panelDevice)
) {
  loadPersistedHmiDeviceData(panelDevice)
    .catch(console.warn);
}
  });

  // Recompute header totals and selector options after all device records have been merged.
  renderStatusSummary(devices);
  scheduleLiveSelectorRefresh();
}

/**

 * @brief Merge control section.

 * @param target Target object or collection.

 * @param source Source object or collection.

 */

function mergeControlSection(target, source) {
  // Ignore absent or primitive sections; only named control maps can be merged safely.
  if (!source || typeof source !== "object") {
    return;
  }

  // Copy each effective primitive value into retained state, unwrapping device
  // objects that expose their reading through `value` or `state`.
  Object.entries(source).forEach(([name, entry]) => {
    target[name] = readControlValue(entry);
  });
}

/**

 * @brief Merge button led control section.

 * @param target Target object or collection.

 * @param source Source object or collection.

 * @param items Configured item definitions.


 */

function mergeButtonLedControlSection(target, source, items, kind) {
  // A missing control map carries no update and must not erase retained hardware state.
  if (!source || typeof source !== "object") {
    return;
  }

  // Resolve packet spelling to the configured physical control name, store its
  // value, latch momentary activity, and mirror switches to their status LEDs.
  Object.entries(source).forEach(([name, entry]) => {
    const resolvedName =
      resolveConfiguredName(items, name);
    const value =
      readControlValue(entry);

    target[resolvedName] =
      value;
    noteButtonLedPulse(
      resolvedName,
      value
    );

    if (kind === "switch") {
      mirrorSwitchStateToLed(
        resolvedName,
        value
      );
    }
  });
}

/**

 * @brief Create a membership set from configured control name and ID pairs.

 * @param items Configured item definitions.

 */

function configNames(items) {
  // Build a membership set from the first element of each configured [name, id]
  // pair for fast button/LED classification while merging packets.
  return new Set(
    items.map(item => item[0])
  );
}

/**

 * @brief Resolve configured name.

 * @param items Configured item definitions.

 */

function resolveConfiguredName(items, name) {
  // Match device-provided control names case-insensitively while returning the
  // exact configured spelling used as the canonical state key.
  const wanted =
    String(name || "").toUpperCase();
  const hit =
    items.find(item =>
      String(item[0]).toUpperCase() === wanted
    );

  // Preserve an unrecognized name so unknown telemetry remains observable.
  return hit ? hit[0] : name;
}

/**

 * @brief Resolve the configured LED output associated with a button name.

 */

function buttonLedOutputName(buttonName) {
  // Derive the expected LED output name, accounting for the GButton convention
  // that uses an uppercase base before the _LED suffix.
  const raw =
    String(buttonName || "");
  const direct =
    raw.toUpperCase().startsWith("GBUTTON")
      ? raw.toUpperCase() + "_LED"
      : raw + "_LED";
  const resolved =
    resolveConfiguredName(buttonLedConfig.leds, direct);
  const ledNames =
    configNames(buttonLedConfig.leds);

  // Return the configured LED spelling only when that output actually exists;
  // an empty result tells callers not to mirror this button automatically.
  return ledNames.has(resolved)
    ? resolved
    : "";
}

/**

 * @brief Resolve the configured status LED associated with a supported switch.

 */

function switchLedOutputName(switchName) {
  // Map only switches with a dedicated physical status LED; other switches do
  // not have a safe output to synthesize.
  const map = {
    LRF_ON: "SW_LRF_Status_LED",
    OPTICS_ON: "SW_Optics_Status_LED",
    DRIVES_ON: "SW_Drives_Status_LED",
    CCE_ON: "SW_CCE_Status_LED",
    UNLOCK: "SW_UnLOCK_Status_LED",
    STRELETS_CH1_ON: "SW_STRELETS_CH1_Status_LED",
    STRELETS_CH2_ON: "SW_STRELETS_CH2_Status_LED"
  };
  const direct =
    map[String(switchName || "").toUpperCase()];

  // Validate the mapped name against configured LEDs before returning it.
  if (!direct) {
    return "";
  }

  const resolved =
    resolveConfiguredName(buttonLedConfig.leds, direct);
  const ledNames =
    configNames(buttonLedConfig.leds);

  return ledNames.has(resolved)
    ? resolved
    : "";
}

/**

 * @brief Copy a button state to its corresponding retained LED output and pulse latch.

 */

function mirrorButtonStateToLed(buttonName, value) {
  // Prefer a configured button-to-LED relationship, then retain a conventional
  // suffix name so unknown but well-formed button telemetry can still be shown.
  const ledName =
    buttonLedOutputName(buttonName) ||
    (buttonName ? String(buttonName) + "_LED" : "");

  if (!ledName) {
    return;
  }

  // Store and pulse the mirrored output so the LED panel reflects the button event.
  controlState.button_led.leds[ledName] =
    value;
  noteButtonLedPulse(ledName, value);
}

/**

 * @brief Copy a switch state to its configured retained status LED and pulse latch.

 */

function mirrorSwitchStateToLed(switchName, value) {
  // Only switches listed by switchLedOutputName have a corresponding status LED.
  const ledName =
    switchLedOutputName(switchName);

  if (!ledName) {
    return;
  }

  // Apply the switch state to that configured LED and latch short activations.
  controlState.button_led.leds[ledName] =
    value;
  noteButtonLedPulse(ledName, value);
}

/**

 * @brief Merge button led buttons.

 * @param source Source object or collection.

 */

function mergeButtonLedButtons(source) {
  // Do not disturb retained button/LED state when this packet omitted the section.
  if (!source || typeof source !== "object") {
    return;
  }

  const buttonNames =
    configNames(buttonLedConfig.buttons);

  const ledNames =
    configNames(buttonLedConfig.leds);

  // Classify every incoming name against configured LEDs and buttons because
  // some device firmware publishes both categories in one `buttons` object.
  Object.entries(source).forEach(([name, entry]) => {
    const value =
      readControlValue(entry);
    const ledName =
      resolveConfiguredName(buttonLedConfig.leds, name);
    const buttonName =
      resolveConfiguredName(buttonLedConfig.buttons, name);

    // Direct LED entries update only LED state and pulse visualization.
    if (ledNames.has(ledName)) {
      controlState.button_led.leds[ledName] =
        value;
      noteButtonLedPulse(
        ledName,
        value
      );
      return;
    }

    // Button entries update the button, record its pulse, and reflect it onto a
    // corresponding LED output when the hardware configuration defines one.
    if (buttonNames.has(buttonName)) {
      controlState.button_led.buttons[buttonName] =
        value;
      noteButtonLedPulse(
        buttonName,
        value
      );
      mirrorButtonStateToLed(
        buttonName,
        value
      );
      return;
    }

    controlState.button_led.buttons[name] =
      value;
    // Preserve an unconfigured button under its transmitted name so newly added
    // hardware controls remain visible instead of being discarded.
    noteButtonLedPulse(
      name,
      value
    );
  });
}

/**

 * @brief Apply button led persisted state.

 */

function applyButtonLedPersistedState(name, value) {
  // Persisted rows without a field name cannot be assigned to a physical control.
  if (!name) {
    return;
  }

  // Resolve the row against each configured control category before updating
  // retained state, because history stores controls as individual field rows.
  const ledNames =
    configNames(buttonLedConfig.leds);
  const switchNames =
    configNames(buttonLedConfig.switches);
  const knobNames =
    configNames(buttonLedConfig.knobs);
  const buttonNames =
    configNames(buttonLedConfig.buttons);
  const ledName =
    resolveConfiguredName(buttonLedConfig.leds, name);
  const switchName =
    resolveConfiguredName(buttonLedConfig.switches, name);
  const knobName =
    resolveConfiguredName(buttonLedConfig.knobs, name);
  const buttonName =
    resolveConfiguredName(buttonLedConfig.buttons, name);

  // Apply the value to exactly one matching category and reproduce the same
  // pulse/mirroring behavior used for live Button/LED packets.
  if (ledNames.has(ledName)) {
    controlState.button_led.leds[ledName] = value;
    noteButtonLedPulse(ledName, value);
  } else if (switchNames.has(switchName)) {
    controlState.button_led.switches[switchName] = value;
    noteButtonLedPulse(switchName, value);
    mirrorSwitchStateToLed(switchName, value);
  } else if (knobNames.has(knobName)) {
    controlState.button_led.knobs[knobName] = value;
  } else if (buttonNames.has(buttonName)) {
    controlState.button_led.buttons[buttonName] = value;
    noteButtonLedPulse(buttonName, value);
    mirrorButtonStateToLed(
      buttonName,
      value
    );
  }
}

/**

 * @brief Merge and render Button/LED unit telemetry and active controls.



 */

function renderButtonLedPanel(payload, timestamp) {
  // Work against retained state because device packets may contain only the
  // controls that changed rather than a complete panel snapshot.
  const state =
    controlState.button_led;

  if (payload) {

    // Merge structured button, switch, knob, and LED sections independently so
    // omitted sections retain their most recently observed hardware values.
    mergeButtonLedButtons(
      payload.buttons
    );

    mergeButtonLedControlSection(
      state.switches,
      payload.switches,
      buttonLedConfig.switches,
      "switch"
    );

    mergeButtonLedControlSection(
      state.knobs,
      payload.knobs,
      buttonLedConfig.knobs,
      "knob"
    );

    mergeButtonLedControlSection(
      state.leds,
      payload.leds,
      buttonLedConfig.leds,
      "led"
    );

    // Search both nested and flattened field forms for MODE and FREQUENCY;
    // database rows and live packets use different representations.
    const liveMode = payloadValue(
      payload,
      [
        "knobs.MODE.value",
        "knobs.MODE.state",
        "knobs.MODE",
        "knobs.mode.value",
        "knobs_MODE_value",
        "MODE",
        "mode",
        "mode_value",
        "control_mode",
        "operating_mode",
        "knob_mode"
      ],
      null
    );
    const liveFrequency = payloadValue(
      payload,
      [
        "knobs.FREQUENCY.value",
        "knobs.FREQUENCY.state",
        "knobs.FREQUENCY",
        "knobs.frequency.value",
        "knobs_FREQUENCY_value",
        "FREQUENCY",
        "frequency",
        "frequency_value",
        "freq",
        "frequency_hz",
        "rate_hz"
      ],
      null
    );

    const resolvedMode =
      liveMode === null ? null : readControlValue(liveMode);
    const resolvedFrequency =
      liveFrequency === null ? null : readControlValue(liveFrequency);

    // Store only real readings, leaving the last valid knob position in place
    // when a partial packet does not contain either value.
    if (
      resolvedMode !== null &&
      resolvedMode !== "--"
    ) {
      state.knobs.MODE = resolvedMode;
    }
    if (
      resolvedFrequency !== null &&
      resolvedFrequency !== "--"
    ) {
      state.knobs.FREQUENCY = resolvedFrequency;
    }

 // Single-field history rows identify one control by name/value instead of the
 // structured live-packet sections, so classify that field against configuration.
 if (payload.name && payload.value !== undefined) {

  const switchNames =
    configNames(buttonLedConfig.switches);

  const knobNames =
    configNames(buttonLedConfig.knobs);
  const ledNames =
    configNames(buttonLedConfig.leds);

  const value = payload.value;
  const switchName =
    resolveConfiguredName(buttonLedConfig.switches, payload.name);
  const knobName =
    resolveConfiguredName(buttonLedConfig.knobs, payload.name);
  const ledName =
    resolveConfiguredName(buttonLedConfig.leds, payload.name);

  if (ledNames.has(ledName)) {

    state.leds[ledName] = value;
    noteButtonLedPulse(ledName, value);

  }
  else if (switchNames.has(switchName)) {

    state.switches[switchName] = value;
    noteButtonLedPulse(switchName, value);
    mirrorSwitchStateToLed(
      switchName,
      value
    );

  }
  else if (knobNames.has(knobName)) {

    state.knobs[knobName] = value;

  }
  else {

    mergeButtonLedButtons({
      [payload.name]: value
    });

  }
}
  }

  // Retain the newest supplied packet time, but do not erase it during a pulse-only redraw.
  state.timestamp =
    timestamp || state.timestamp;

  // Render only when the Button/LED unit owns the selected detail container.
  const el =
   getDeviceDetail("BUTTON_LED_UNIT");

  if (!el) return;

  // Build one section from configured [name, id] pairs. Each tile derives its
  // displayed/latching state, audit metadata, industrial control graphic, and
  // click-through diagnostics action from the current retained control value.
  const sectionHtml = (title, items, values, kind) => `
    <div class="controlSection buttonLedSection ${kind}Section">
      <div class="buttonLedSectionHeader">
        <h3>${esc(title)}</h3>
        <span>${items.length} CHANNELS</span>
      </div>
      <div class="controlGrid ${kind === "knob" ? "knobGrid" : ""}">
        ${items.map(([name, id]) => {
          const rawValue =
            values[name] ?? 0;
          const value =
            buttonLedDisplayValue(
              name,
              rawValue,
              kind
            );
          const active =
            isControlOn(value);
          const stateText =
            controlStateText(value);
          const meta =
            updateControlMeta(
              "BUTTON_LED_UNIT",
              title,
              name,
              value,
              kind || "pushButton",
              state.timestamp
            );
          const knobAngle =
            buttonLedKnobAngle(name, value);
          const controlBody =
            kind === "led"
              ? `<div class="pilotLightAssembly" aria-label="${esc(stateText)}">
                   <div class="pilotLightBezel"><div class="ledLamp"><span></span></div></div>
                   <div class="industrialStatePlate">${esc(stateText)}</div>
                 </div>`
              : kind === "knob"
                ? `<div class="industrialKnobAssembly" style="--knob-angle:${knobAngle}deg">
                     <div class="rotaryScale" aria-hidden="true">
                       <i></i><i></i><i></i><i></i><i></i><i></i><i></i>
                     </div>
                     <div class="rotaryKnob"><span class="knobPointer"></span><span class="knobHub"></span></div>
                     <div class="knobValuePlate"><strong>${esc(formatControlValue(value))}</strong><small>LIVE VALUE</small></div>
                   </div>`
                : kind === "switch"
                  ? `<div class="switchStateBanner" role="status" aria-label="Switch ${esc(stateText)}">
                       <span class="switchStateLamp" aria-hidden="true"></span>
                       <span><strong>${esc(stateText)}</strong><small>${active ? "ENERGIZED" : "DE-ENERGIZED"}</small></span>
                     </div>
                     <div class="industrialSwitchAssembly" aria-label="${esc(stateText)}">
                       <span class="switchLegend switchOnLegend">ON</span>
                       <div class="toggleBezel"><div class="toggleLever"><span></span></div></div>
                       <span class="switchLegend switchOffLegend">OFF</span>
                     </div>`
                  : `<div class="industrialPushButton">
                       <div class="pushButtonBezel"><div class="pushButtonFace"><span>${esc(stateText)}</span></div></div>
                     </div>`;

          return `
            <div
              class="controlTile ${controlTileClass(kind || "pushButton", active)}"
              onclick='recordOperatorInteraction("BUTTON_LED_UNIT", ${JSON.stringify(title)}, ${JSON.stringify(name)})'>
              <div class="controlName">${esc(displayName(name))}</div>
              <div class="controlMeta">ID ${esc(id)}</div>
              ${controlBody}
              ${controlTelemetryHtml(meta)}
            </div>
          `;
        }).join("")}
      </div>
    </div>
  `;

  // Discover controls sent by firmware but absent from local configuration,
  // then reduce every category to values that should currently be surfaced.
  const configuredButtons =
    configNames(buttonLedConfig.buttons);
  const configuredLeds =
    configNames(buttonLedConfig.leds);
  const dynamicButtonItems =
    Object.keys(state.buttons)
      .filter(name => !configuredButtons.has(name))
      .sort()
      .map(name => [name, "LIVE"]);
  const dynamicLedItems =
    Object.keys(state.leds)
      .filter(name => !configuredLeds.has(name))
      .sort()
      .map(name => [name, "LIVE"]);
  const activeDynamicButtonItems =
    activeButtonLedItems(dynamicButtonItems, state.buttons, "pushButton");
  const activeButtonItems =
    activeButtonLedItems(buttonLedConfig.buttons, state.buttons, "pushButton");
  const activeSwitchItems =
    activeButtonLedItems(buttonLedConfig.switches, state.switches, "switch");
  const activeKnobItems =
    activeButtonLedItems(buttonLedConfig.knobs, state.knobs, "knob");
  const activeLedItems =
    activeButtonLedItems(buttonLedConfig.leds, state.leds, "led");
  const activeDynamicLedItems =
    activeButtonLedItems(dynamicLedItems, state.leds, "led");

  // Replace the selected-device detail with active controls grouped by physical
  // category; show an explicit empty state when no control is currently active.
  el.innerHTML = `
    <div class="buttonLedIndustrialPanel">
    <div class="detailHeader">
      <h3>Button LED Panel</h3>
      <span class="buttonLedLiveStamp"><i></i>${esc(state.timestamp || "--")}</span>
    </div>
    ${activeDynamicButtonItems.length
      ? sectionHtml("Live Commands ON", activeDynamicButtonItems, state.buttons, "pushButton")
      : ""}
    ${activeButtonItems.length
      ? sectionHtml("Buttons ON", activeButtonItems, state.buttons, "pushButton")
      : ""}
    ${activeSwitchItems.length
      ? sectionHtml("Switches ON", activeSwitchItems, state.switches, "switch")
      : ""}
    ${activeKnobItems.length
      ? sectionHtml("Knobs Active", activeKnobItems, state.knobs, "knob")
      : ""}
    ${activeLedItems.length
      ? sectionHtml("LED Outputs ON", activeLedItems, state.leds, "led")
      : ""}
    ${activeDynamicLedItems.length
      ? sectionHtml("Live Command LEDs ON", activeDynamicLedItems, state.leds, "led")
      : ""}
    ${!(
      activeDynamicButtonItems.length ||
      activeButtonItems.length ||
      activeSwitchItems.length ||
      activeKnobItems.length ||
      activeLedItems.length ||
      activeDynamicLedItems.length
    )
      ? '<div class="buttonLedEmptyOn">No active Button LED values are ON</div>'
      : ""}
    </div>
  `;
}

/**

 * @brief Merge and render joystick axes, buttons, hats, and connection state.



 */

function renderJoystickPanel(payload, timestamp) {
  // Retain joystick state across partial packets so axes, buttons, and hats can
  // be published independently without blanking the other instrument sections.
  const state =
    controlState.joystick;

  if (payload) {
    // Read the first finite numeric value from the supported nested/flattened
    // field aliases used by live packets and persisted history.
    const readNumber = (...keys) => {
      for (const key of keys) {
        if (payload[key] !== undefined && payload[key] !== "") {
          const value = Number(payload[key]);

          if (Number.isFinite(value)) {
            return value;
          }
        }
      }

      return null;
    };

    // Merge structured axes first, then overlay individually flattened axis fields.
    state.axes = {
      ...state.axes,
      ...(payload.axes || {})
    };

    joystickConfig.axes.forEach(name => {
      const value = readNumber(
        name,
        `axis_${name}`,
        `axes_${name}`,
        `joystick_${name}`
      );

      if (value !== null) {
        state.axes[name] = value;
      }
    });

    // Repeat the same merge for thumbwheels, which share axis-style rendering.
    state.thumbwheels = {
      ...state.thumbwheels,
      ...(payload.thumbwheels || {})
    };

    joystickConfig.thumbwheels.forEach(name => {
      const value = readNumber(
        name,
        `thumbwheel_${name}`,
        `thumbwheels_${name}`
      );

      if (value !== null) {
        state.thumbwheels[name] = value;
      }
    });

    // Merge structured buttons and latch each observed activation so short
    // presses remain visible between high-rate packets and slower DOM redraws.
    state.buttons = {
      ...state.buttons,
      ...(payload.buttons || {})
    };

    Object.entries(payload.buttons || {})
      .forEach(([name, entry]) =>
        noteJoystickPulse(name, readControlValue(entry))
      );

    // Overlay configured flattened button fields and latch their active values.
    joystickConfig.buttons.forEach(name => {
      const value = readNumber(
        name,
        `button_${name}`,
        `buttons_${name}`
      );

      if (value !== null) {
        state.buttons[name] = value;
        noteJoystickPulse(name, value);
      }
    });

    // Merge structured hats, then reconstruct x/y pairs from flattened fields
    // without replacing the coordinate omitted by a partial packet.
    state.hats = {
      ...state.hats,
      ...(payload.hats || {})
    };

    joystickConfig.hats.forEach(name => {
      const x = readNumber(
        `${name}_x`,
        `hat_${name}_x`,
        `hats_${name}_x`
      );

      const y = readNumber(
        `${name}_y`,
        `hat_${name}_y`,
        `hats_${name}_y`
      );

      if (x !== null || y !== null) {
        state.hats[name] = {
          ...(state.hats[name] || {}),
          x: x ?? state.hats[name]?.x ?? 0,
          y: y ?? state.hats[name]?.y ?? 0
        };
      }
    });

    // Treat an explicit connection field as authoritative; packets lacking one
    // imply connectivity because receiving the packet itself proves the link.
    state.connected =
      Boolean(
        payload.connected ??
        payload.joystick_connected ??
        payload.enabled ??
        true
      );
  }

  // Keep the last real packet timestamp during redraws triggered only by pulse expiry.
  state.timestamp =
    timestamp || state.timestamp;

  const el =
   getDeviceDetail("JOYSTICK_UNIT");

  if (!el) return;

  // Axis markup calculates a centered percentage bar and updates per-axis audit
  // metadata before producing the clickable diagnostics row.
  const axisHtml = name => {
    const value =
      Number(
        state.axes[name] ??
        state.thumbwheels[name] ??
        0
      );
    const group =
      state.axes[name] !== undefined
        ? "Axes"
        : "Thumbwheels";
    const meta =
      updateControlMeta(
        "JOYSTICK_UNIT",
        group,
        name,
        value,
        "axis",
        state.timestamp
      );
    const pct =
      Math.max(
        -100,
        Math.min(100, value * 100)
      );

    return `
      <div
        class="axisRow"
        onclick='recordOperatorInteraction("JOYSTICK_UNIT", ${JSON.stringify(group)}, ${JSON.stringify(name)})'>
        <span>${esc(displayName(name))}</span>
        <div class="axisTrack">
          <div
            class="axisFill ${pct < 0 ? "negative" : "positive"}"
            style="left:${pct < 0 ? 50 + pct : 50}%;width:${Math.abs(pct)}%">
          </div>
          <div class="axisCenter"></div>
        </div>
        <strong>${esc(value.toFixed(2))}</strong>
        ${controlTelemetryHtml(meta)}
      </div>
    `;
  };

  // Build configured button tiles using pulse-adjusted values so brief presses
  // remain highlighted and are counted by control diagnostics.
  const buttonHtml =
    joystickConfig.buttons.map(name => {
      const value =
        state.buttons[name] ?? 0;
      const displayValue =
        joystickDisplayValue(name, value);
      const active =
        isControlOn(displayValue);
      const meta =
        updateControlMeta(
          "JOYSTICK_UNIT",
          "Buttons",
          name,
          displayValue,
          "pushButton",
          state.timestamp
        );

      return `
        <div
          class="controlTile compact ${active ? "active" : "inactive"}"
          onclick='recordOperatorInteraction("JOYSTICK_UNIT", "Buttons", ${JSON.stringify(name)})'>
          <div class="controlName">${esc(displayName(name))}</div>
          <div class="controlValue">${esc(formatControlValue(displayValue))}</div>
          ${controlTelemetryHtml(meta)}
        </div>
      `;
    }).join("");

  // Build each hat tile from its retained x/y direction and record the pair as
  // one analog diagnostic state.
  const hatsHtml =
    joystickConfig.hats.map(name => {
      const hat =
        state.hats[name] || { x: 0, y: 0 };
      const meta =
        updateControlMeta(
          "JOYSTICK_UNIT",
          "Hat",
          name,
          `${hat.x ?? 0},${hat.y ?? 0}`,
          "axis",
          state.timestamp
        );

      return `
        <div
          class="hatTile"
          onclick='recordOperatorInteraction("JOYSTICK_UNIT", "Hat", ${JSON.stringify(name)})'>
          <div class="controlName">${esc(displayName(name))}</div>
          <div class="hatValue">X ${esc(hat.x ?? 0)} / Y ${esc(hat.y ?? 0)}</div>
          ${controlTelemetryHtml(meta)}
        </div>
      `;
    }).join("");

  // Rebuild the selected joystick detail with connection state, physical SVG,
  // axes, buttons, and hats from the merged snapshot.
  el.innerHTML = `
    <div class="detailHeader">
      <h3>Joystick Panel</h3>
      <span>${esc(state.timestamp || "--")}</span>
    </div>
    <div class="joystickConnected ${state.connected ? "active" : "inactive"}">
      ${state.connected ? "CONNECTED" : "DISCONNECTED"}
    </div>
   <div class="joystickSvgWrapper">

  <svg
    id="joystickSvg"
    viewBox="0 0 300 300"
    class="joystickSvg">

    <ellipse
      cx="150"
      cy="240"
      rx="90"
      ry="28"
      fill="#08111f"
      stroke="#00ffb4"
      stroke-width="2"/>

    <line
      id="joyStickShaft"
      x1="150"
      y1="220"
      x2="150"
      y2="110"
      stroke="#00ffb4"
      stroke-width="12"
      stroke-linecap="round"/>

    <circle
      id="joyStickKnob"
      cx="150"
      cy="110"
      r="28"
      fill="#00ffb4"/>

  </svg>

</div>
    <div class="controlSection">
      <h3>Axes</h3>
      ${joystickConfig.axes.map(axisHtml).join("")}
      ${joystickConfig.thumbwheels.map(axisHtml).join("")}
    </div>
    <div class="controlSection">
      <h3>Buttons</h3>
      <div class="controlGrid">
        ${buttonHtml}
      </div>
    </div>
    <div class="controlSection">
      <h3>Hat</h3>
      <div class="controlGrid knobGrid">
        ${hatsHtml}
      </div>
    </div>
  `;
// Move the SVG handle after its newly generated elements have entered the DOM.
renderJoystickSvg(

  Number(
    state.axes.x || 0
  ),

  Number(
    state.axes.y || 0
  )

);
}
/**
 * @brief Render joystick svg.
 */
function renderJoystickSvg(x, y) {
  // Locate both movable SVG elements; an absent detail panel means there is
  // nothing to animate for the current selection.
  const knob =
    document.getElementById(
      "joyStickKnob"
    );

  const shaft =
    document.getElementById(
      "joyStickShaft"
    );

  if (
    !knob ||
    !shaft
  ) {
    return;
  }

  // Scale normalized joystick axes into the 70-pixel movement radius around
  // the SVG center, then move both the knob and shaft endpoint together.
  const maxTilt = 70;

  const knobX =
    150 + x * maxTilt;

  const knobY =
    150 + y * maxTilt;

  knob.setAttribute(
    "cx",
    knobX
  );

  knob.setAttribute(
    "cy",
    knobY
  );

  shaft.setAttribute(
    "x2",
    knobX
  );

  shaft.setAttribute(
    "y2",
    knobY
  );
}

/**

 * @brief Render Main Display feed source, frame rate, tracker, IMU-link, and recording state.



 */

function renderMainDisplayPanel(
  payload,
  timestamp
) {
  // Render only into the detail view currently assigned to the Main Display.
  const el =
    getDeviceDetail(
      "MAIN_DISPLAY"
    );

  if (!el) return;

  // A null payload explicitly clears prior feed values and shows the unit offline.
  if (!payload) {

    el.innerHTML = `

      <div class="detailHeader">

        <h3>Main Display</h3>

        <span>OFFLINE</span>

      </div>
    `;

    return;
  }

  // Convert feed source, frame rate, tracker link, IMU link, and recording flag
  // into the compact values displayed by the Main Display instrument grid.
  const source =
    payload.video_source || "--";

  const fps =
    Number(payload.fps || 0);

  const tracker =
    payload.tracker_enabled
      ? "ON"
      : "OFF";

  const imu =
    payload.imu_enabled
      ? "ON"
      : "OFF";

  const recording =
    payload.recording
      ? "ON"
      : "OFF";

  // Replace the detail panel with the current feed status and packet timestamp.
  el.innerHTML = `

    <div class="detailHeader">

      <h3>Main Display Feed</h3>

      <span>
        ${esc(timestamp || "--")}
      </span>

    </div>

    <div class="imuGrid">

      <div class="imuInstrument">
        <div class="imuLabel">VIDEO SOURCE</div>
        <div class="imuValue">
          ${esc(source)}
        </div>
      </div>

      <div class="imuInstrument">
        <div class="imuLabel">FPS</div>
        <div class="imuValue">
          ${fps.toFixed(0)}
        </div>
      </div>

      <div class="imuInstrument">
        <div class="imuLabel">TRACKER</div>
        <div class="imuValue">
          ${tracker}
        </div>
      </div>

      <div class="imuInstrument">
        <div class="imuLabel">IMU LINK</div>
        <div class="imuValue">
          ${imu}
        </div>
      </div>

      <div class="imuInstrument">
        <div class="imuLabel">RECORDING</div>
        <div class="imuValue">
          ${recording}
        </div>
      </div>

    </div>
  `;
}
/**
 * @brief Render WCS pan/tilt position, tracker errors, drive link, and raw telemetry.
 */
function renderWcsConsolePanel(payload, timestamp) {
  // Do not write WCS markup into another selected device's detail container.
  const el =
    getDeviceDetail("WCS_CONSOLE");

  if (!el) return;

  // Clear previously rendered motion data when status handling marks WCS offline.
  if (!payload) {

    el.innerHTML = `
      <div class="detailHeader">
        <h3>WCS Console</h3>
        <span>OFFLINE</span>
      </div>

      <div class="imuGrid">

        <div class="imuInstrument">
          <div class="imuLabel">STATUS</div>
          <div class="imuValue">NO DATA</div>
        </div>

      </div>
    `;

    return;
  }

  // Resolve pan, tilt, tracker error, and drive connectivity from the alternative
  // names used by WCS live packets, drive-state objects, and flattened history.
  const pan =
    telemetryNumber(payload, ["pan_actual_deg", "pan_deg", "pan_angle", "pan", "drive_state.pan.target_deg"]);

  const tilt =
    telemetryNumber(payload, ["tilt_actual_deg", "tilt_deg", "tilt_angle", "tilt", "drive_state.tilt.target_deg"]);

  const measuredTilt =
    ptzTiltMeasurementDegrees(tilt);

  const panErr =
    telemetryNumber(payload, ["tracker_pan_error", "tracker_pan_err", "pan_error"]);

  const tiltErr =
    telemetryNumber(payload, ["tracker_tilt_error", "tracker_tilt_err", "tilt_error"]);

  const connected =
    isControlOn(payloadValue(payload, ["drive_connected", "connected"], 0));

  // Render the mechanical pan/tilt visualization, numeric error readouts, drive
  // link state, and a complete escaped field list for troubleshooting.
  el.innerHTML = `

    <div class="detailHeader">

      <h3>WCS Console</h3>

      <span>
        ${esc(timestamp || "--")}
      </span>

    </div>

    ${panTiltVisualizationHtml(pan, tilt, "WCS PAN / TILT", { tiltScale: "-90-180" })}

    <div class="imuGrid">

      <div class="imuInstrument">
        <div class="imuLabel">PAN POSITION</div>
        <div class="imuValue">
          ${pan.toFixed(1)}°
        </div>
      </div>

      <div class="imuInstrument">
        <div class="imuLabel">TILT POSITION (-90 TO 180)</div>
        <div class="imuValue">
          ${measuredTilt.toFixed(1)}°
        </div>
      </div>

      <div class="imuInstrument">
        <div class="imuLabel">PAN ERROR</div>
        <div class="imuValue">
          ${panErr.toFixed(2)}
        </div>
      </div>

      <div class="imuInstrument">
        <div class="imuLabel">TILT ERROR</div>
        <div class="imuValue">
          ${tiltErr.toFixed(2)}
        </div>
      </div>

      <div class="imuInstrument">
        <div class="imuLabel">DRIVE LINK</div>
        <div class="imuValue">
          ${connected ? "ONLINE" : "OFFLINE"}
        </div>
      </div>

    </div>

    ${allTelemetryFieldsHtml(payload)}
  `;
}

/**

 * @brief Render IMU attitude, artificial horizon, GPS navigation, and sensor readings.



 */

function renderImuPanel(payload, timestamp) {
  // Render IMU instruments only while its detail panel is selected.
  const el =
    getDeviceDetail("IMU_UNIT");

  if (!el) return;

  // Replace stale attitude/navigation data with an explicit offline header.
  if (!payload) {

    el.innerHTML = `

      <div class="detailHeader">
        <h3>IMU Telemetry</h3>
        <span>OFFLINE</span>
      </div>
    `;

    return;
  }

  /*
  LIVE DATA
  */
// Resolve attitude and GPS values across current, legacy, nested, and flattened
// packet field names so live and database-backed IMU views behave identically.
const roll =
  telemetryNumber(payload, ["roll", "roll_deg", "imu_roll", "imu_roll_deg", "euler_deg.0", "angles_deg.0"]);

const pitch =
  telemetryNumber(payload, ["pitch", "pitch_deg", "imu_pitch", "imu_pitch_deg", "euler_deg.1", "angles_deg.1"]);

const yaw =
  telemetryNumber(payload, ["yaw", "yaw_deg", "imu_yaw", "imu_yaw_deg", "heading", "heading_deg", "euler_deg.2", "angles_deg.2"], NaN);
const lat =
  telemetryNumber(payload, ["lat", "latitude", "latitude_deg", "gps_lat", "gps_latitude", "gps.latitude", "gps.latitude_deg", "wgs84.lat"]);

const lon =
  telemetryNumber(payload, ["lon", "lng", "longitude", "longitude_deg", "gps_lon", "gps_longitude", "gps.longitude", "gps.longitude_deg", "wgs84.lon"]);

const alt =
  telemetryNumber(payload, ["alt", "alt_m", "altitude", "altitude_m", "gps_altitude", "gps.altitude", "gps.altitude_m", "wgs84.alt"]);

  // Recreate the IMU detail with a canvas mount, GPS/navigation visuals, and
  // key-value signal cards before drawing into the new canvas element.
  el.innerHTML = `
    <div class="detailHeader">

      <h3>IMU Telemetry</h3>

      <span>
        ${esc(timestamp || "--")}
      </span>

    </div>

    <div class="imuDisplayCluster">
    <div class="imuHorizonWrapper">

      <canvas
        id="imuHorizonCanvas"
        width="1000"
        height="420">
      </canvas>

    </div>

    ${imuNavigationVisualsHtml(yaw, lat, lon, alt)}
    </div>

    ${imuKeyValueSignalsHtml(payload)}
  `;

  // Paint the artificial horizon only after the replacement canvas is in the DOM.
  renderArtificialHorizon(
    roll,
    pitch,
    yaw
  );
}

/**

 * @brief Render artificial horizon.

 */

function renderArtificialHorizon(
  roll,
  pitch,
  yaw = 0
) 
{
  // Locate the IMU canvas created by renderImuPanel; no drawing is possible when
  // the operator has switched away from the IMU detail view.
  const canvas =
    $("imuHorizonCanvas");

  if (!canvas) {
    return;
  }

  // Derive the drawing context, canvas dimensions, and center used by every
  // sky, ground, ladder, roll-scale, and aircraft-symbol operation below.
  const ctx =
    canvas.getContext("2d");

  const w =
    canvas.width;

  const h =
    canvas.height;

  const cx =
    w / 2;

  const cy =
    h / 2;

  // Clear the previous attitude frame before painting the new roll/pitch/yaw sample.
  ctx.clearRect(0,0,w,h);

  // Limit pitch translation to the visible canvas and convert roll degrees to
  // radians because the Canvas rotation API expects radians.
  const clamp = (value, min, max) =>
    Math.max(
      min,
      Math.min(max, value)
    );

  const pitchOffset =
    clamp(pitch * 4, -h * 0.48, h * 0.48);

  const rollRad =
    roll * Math.PI / 180;

  /*
  ----------------------------------------
  SKY
  ----------------------------------------
  */

  // Save the unrotated canvas, rotate the world around its center by aircraft
  // roll, and translate the horizon vertically according to pitch.
  ctx.save();

  ctx.translate(cx, cy);

  ctx.rotate(
    rollRad
  );

  ctx.translate(
    0,
    pitchOffset
  );

  // Fill the upper half with a vertical sky gradient extending beyond the
  // viewport so rotation never exposes an unpainted corner.
  const skyGradient =
    ctx.createLinearGradient(0, -h * 1.3, 0, 0);
  skyGradient.addColorStop(0, "#071a33");
  skyGradient.addColorStop(0.55, "#0b4f78");
  skyGradient.addColorStop(1, "#1677a6");
  ctx.fillStyle = skyGradient;

  ctx.fillRect(
    -w,
    -h*2,
    w*2,
    h*2
  );

  /*
  ----------------------------------------
  GROUND
  ----------------------------------------
  */

  // Fill the lower half with a dark ground gradient using the same oversized
  // rotated coordinate space as the sky.
  const groundGradient =
    ctx.createLinearGradient(0, 0, 0, h * 1.35);
  groundGradient.addColorStop(0, "#5b4633");
  groundGradient.addColorStop(0.55, "#34291f");
  groundGradient.addColorStop(1, "#151a20");
  ctx.fillStyle = groundGradient;

  ctx.fillRect(
    -w,
    0,
    w*2,
    h*2
  );

  /*
  ----------------------------------------
  HORIZON LINE
  ----------------------------------------
  */

  // Draw the white zero-pitch boundary separating sky from ground.
  ctx.strokeStyle =
    "#ffffff";

  ctx.lineWidth = 3;

  ctx.beginPath();

  ctx.moveTo(-w,0);

  ctx.lineTo(w,0);

  ctx.stroke();

  /*
  ----------------------------------------
  PITCH LADDER
  ----------------------------------------
  */

  // Draw labeled pitch bars every ten degrees, using longer bars at twenty-degree intervals.
  ctx.lineWidth = 1.5;
  ctx.font = "12px Arial";

  for (let deg = -30; deg <= 30; deg += 10) {
    if (deg === 0) {
      continue;
    }

    const y =
      -deg * 4;

    const half =
      Math.abs(deg) % 20 === 0
        ? 54
        : 34;

    ctx.strokeStyle =
      "rgba(255,255,255,.72)";

    ctx.fillStyle =
      "rgba(255,255,255,.82)";

    ctx.beginPath();
    ctx.moveTo(-half, y);
    ctx.lineTo(-12, y);
    ctx.moveTo(12, y);
    ctx.lineTo(half, y);
    ctx.stroke();

    ctx.fillText(
      String(Math.abs(deg)),
      -half - 22,
      y + 4
    );

    ctx.fillText(
      String(Math.abs(deg)),
      half + 8,
      y + 4
    );
  }

  // Restore screen coordinates before drawing the fixed roll scale and aircraft symbol.
  ctx.restore();

  /*
  ----------------------------------------
  ROLL SCALE
  ----------------------------------------
  */

  // Draw the roll arc and tick marks in fixed screen coordinates so only the
  // horizon moves beneath the aircraft reference symbol.
  ctx.save();

  ctx.translate(cx, cy);

  ctx.strokeStyle =
    "rgba(125,211,252,.7)";

  ctx.lineWidth =
    2;

  ctx.beginPath();
  ctx.arc(0, 0, 86, Math.PI * 1.12, Math.PI * 1.88);
  ctx.stroke();

  [-45, -30, -15, 0, 15, 30, 45].forEach(deg => {
    const a =
      (-90 + deg) * Math.PI / 180;

    const inner =
      deg === 0 ? 66 : 74;

    const outer =
      86;

    ctx.beginPath();
    ctx.moveTo(
      Math.cos(a) * inner,
      Math.sin(a) * inner
    );
    ctx.lineTo(
      Math.cos(a) * outer,
      Math.sin(a) * outer
    );
    ctx.stroke();
  });

  const rollPointer =
    (-90 + roll) * Math.PI / 180;

  ctx.fillStyle =
    "#facc15";

  ctx.beginPath();
  ctx.moveTo(
    Math.cos(rollPointer) * 96,
    Math.sin(rollPointer) * 96
  );
  ctx.lineTo(
    Math.cos(rollPointer + .08) * 78,
    Math.sin(rollPointer + .08) * 78
  );
  ctx.lineTo(
    Math.cos(rollPointer - .08) * 78,
    Math.sin(rollPointer - .08) * 78
  );
  ctx.closePath();
  ctx.fill();

  ctx.restore();

  /*
  ----------------------------------------
  FIXED IMU ORIENTATION RETICLE
  ----------------------------------------
  */

  ctx.strokeStyle = "#00ffb4";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(cx - 40, cy);
  ctx.lineTo(cx + 40, cy);
  ctx.moveTo(cx, cy - 20);
  ctx.lineTo(cx, cy + 20);
  ctx.stroke();

  ctx.lineWidth = 2;
  ctx.strokeStyle = "#38bdf8";
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + 78, cy);
  ctx.stroke();

  ctx.fillStyle = "#38bdf8";
  ctx.font = "bold 12px Arial";
  ctx.fillText("X", cx + 86, cy + 4);

  ctx.strokeStyle = "#22c55e";
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx, cy - 58);
  ctx.stroke();

  ctx.fillStyle = "#22c55e";
  ctx.fillText("Y", cx - 4, cy - 66);

  /*
  ----------------------------------------
  READOUTS AND HEADING
  ----------------------------------------
  */

  const normalizedYaw =
    ((yaw % 360) + 360) % 360;

  ctx.fillStyle =
    "rgba(2,6,23,.72)";

  ctx.fillRect(14, 14, 190, 82);
  ctx.fillRect(w - 204, 14, 190, 82);

  ctx.strokeStyle =
    "rgba(56,189,248,.28)";

  ctx.strokeRect(14, 14, 190, 82);
  ctx.strokeRect(w - 204, 14, 190, 82);

  ctx.fillStyle =
    "#7dd3fc";

  ctx.font =
    "bold 13px Arial";

  ctx.fillText(
    "LIVE IMU",
    28,
    36
  );

  ctx.fillStyle =
    "#e2e8f0";

  ctx.font =
    "12px Arial";

  ctx.fillText(
    `ROLL  ${roll.toFixed(2)} deg`,
    28,
    56
  );

  ctx.fillText(
    `PITCH ${pitch.toFixed(2)} deg`,
    28,
    76
  );

  ctx.fillStyle =
    "#facc15";

  ctx.font =
    "bold 13px Arial";

  ctx.fillText(
    `HEADING ${normalizedYaw.toFixed(1)} deg`,
    w - 184,
    36
  );

  ctx.fillStyle =
    "#e2e8f0";

  ctx.font =
    "12px Arial";

  const headingLabels = ["N", "E", "S", "W"];

  headingLabels.forEach((label, i) => {
    const labelYaw =
      i * 90;

    let diff =
      ((labelYaw - normalizedYaw + 540) % 360) - 180;

    const x =
      w - 109 + diff * 1.2;

    if (x > w - 196 && x < w - 22) {
      ctx.fillText(label, x, 70);
    }
  });

  ctx.strokeStyle =
    "#facc15";

  ctx.beginPath();
  ctx.moveTo(w - 109, 48);
  ctx.lineTo(w - 109, 78);
  ctx.stroke();
}

/**

 * @brief Read the first available value from alternative nested telemetry field paths.


 */

function payloadValue(payload, keys, fallback = "--") {
  // Walk each dotted candidate path in priority order and return the first
  // defined, non-null value; use the caller's fallback when none exist.
  for (const key of keys) {
    const sources = [payload, payload?.body, payload?.data];

    for (const source of sources) {
      const value = String(key).split(".").reduce(
        (current, part) => current?.[part],
        source
      );

      if (value !== undefined && value !== null && value !== "") {
        return value;
      }
    }
  }

  return fallback;
}

/**

 * @brief Resolve alternative telemetry fields to a finite numeric value or fallback.


 */

function telemetryNumber(payload, keys, fallback = 0) {
  // Expand each candidate into dotted and underscore forms, read the first
  // available value, and accept it only when conversion produces a finite number.
  const normalizedKeys =
    keys.map(key =>
      String(key || "")
        .replace(/\./g, "_")
        .toLowerCase()
    );

  if (payload && typeof payload === "object") {
    const rowKey =
      String(payload.key || payload.value_key || "")
        .replace(/\./g, "_")
        .toLowerCase();

    if (rowKey && normalizedKeys.includes(rowKey)) {
      const rowValue =
        payload.value_num ??
        payload.value ??
        payload.value_text;
      const rowNumber = Number(rowValue);

      if (Number.isFinite(rowNumber)) {
        return rowNumber;
      }
    }

    for (const key of normalizedKeys) {
      if (payload[key] !== undefined) {
        const directNumber = Number(payload[key]);

        if (Number.isFinite(directNumber)) {
          return directNumber;
        }
      }
    }
  }

  const value = Number(payloadValue(payload, keys, fallback));
  return Number.isFinite(value) ? value : fallback;
}

/**

 * @brief Select useful finite numeric fields from a flattened payload for generic charts.


 * @param limit Maximum number of items to retain or return.

 */

function numericTelemetryFields(payload, limit = 3) {
  // Flatten nested telemetry, discard routing/identity/time metadata and
  // nonnumeric values, then return at most `limit` distinct numeric signals for
  // generic charts when no device-specific metric set is available.
  const fields = [];
  const seen = new Set();

  if (!payload || typeof payload !== "object") {
    return fields;
  }

  const addField = (key, value) => {
    const name =
      String(key || "")
        .replace(/\./g, "_");
    const num = Number(value);

    if (
      !name ||
      seen.has(name) ||
      !Number.isFinite(num) ||
      [
        "timestamp",
        "server_rx_ts",
        "device_ts",
        "packet_ts",
        "latency_ms",
        "source_port",
        "anomaly",
        "value_num",
        "value_text",
        "value_type",
        "value",
        "key",
        "value_key",
        "device",
        "device_name",
        "channel",
        "channel_name",
        "process",
        "process_name",
        "subprocess",
        "subprocess_name"
      ].includes(name.toLowerCase())
    ) {
      return;
    }

    seen.add(name);
    fields.push({ key: name, value: num });
  };

  if (payload.key || payload.value_key) {
    addField(
      payload.key || payload.value_key,
      payload.value_num ?? payload.value ?? payload.value_text
    );
  }

  flattenTelemetryFields(payload)
    .forEach(([key, value]) => {
      if (fields.length < limit) {
        addField(key, value);
      }
    });

  return fields.slice(0, limit);
}

/**

 * @brief Append aligned null values for generic trend slots not supplied by this packet.

 */

function pushNullGenericTrendValues() {
  // Append one null to every generic slot so all chart datasets stay aligned
  // when a packet contains no usable generic numeric telemetry.
  telemetryTrendData.generic.a.push(null);
  telemetryTrendData.generic.b.push(null);
  telemetryTrendData.generic.c.push(null);
}

/**

 * @brief Reset generic trend slots.

 */

function resetGenericTrendSlots() {
  // Forget dynamic generic-field assignments and restore placeholder labels so
  // a new database or live session can select its own three numeric signals.
  telemetryTrendData.generic.keys =
    ["", "", ""];
  telemetryTrendData.generic.labels =
    ["Telemetry A", "Telemetry B", "Telemetry C"];
}

/**

 * @brief Assign generic numeric fields to stable trend slots and append their values.



 */

function pushGenericTrendValues(row, device) {
  /*
  Generic telemetry is disabled for Mission Telemetry Analytics.

  We keep this function only so old code does not crash.
  The graph should show only:
  IMU Roll, IMU Pitch, IMU Yaw,   
  Drive Pan, Drive Tilt, Motor RPM, Motor Current.
  */

  telemetryTrendData.generic.a.push(null);
  telemetryTrendData.generic.b.push(null);
  telemetryTrendData.generic.c.push(null);
}

/**

 * @brief Flatten nested telemetry objects and arrays into path/value pairs for display and lookup.

 */

function flattenTelemetryFields(value, prefix = "", output = []) {
  // Recursively visit plain objects and arrays, emitting scalar leaves with
  // dotted paths while returning the caller-owned output list unchanged for
  // null or primitive roots.
  if (!value || typeof value !== "object") return output;

  Object.entries(value).forEach(([key, entry]) => {
    const field = prefix ? `${prefix}.${key}` : key;

    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      flattenTelemetryFields(entry, field, output);
    } else {
      output.push([field, Array.isArray(entry) ? entry.join(", ") : entry]);
    }
  });

  return output;
}

/**

 * @brief Build the pan/tilt instrument markup from normalized mechanical angles.

 * @param title Panel or section title.

 * @param options Optional behavior settings.

 */

function panTiltVisualizationHtml(pan, tilt, title = "PAN / TILT", options = {}) {
  // Normalize pan into a full compass rotation and tilt into the requested
  // mechanical scale, then encode both angles as CSS variables used by the
  // instrument's rotating azimuth arm and elevation indicator.
  const safePan = Math.max(-180, Math.min(180, Number(pan) || 0));
  const usesPtzScale = options.tiltScale === "-90-180";
  const displayTilt = usesPtzScale
    ? ptzTiltMeasurementDegrees(tilt)
    : Math.max(-90, Math.min(90, Number(tilt) || 0));
  const visualTilt = usesPtzScale
    ? ptzPhysicalTiltDegrees(displayTilt)
    : displayTilt;
  const tiltY = 80 - (visualTilt / 90) * 52;

  return `
    <div class="panTiltVisualizer" role="img" aria-label="${esc(title)} pan ${safePan.toFixed(1)} degrees tilt ${displayTilt.toFixed(1)} degrees">
      <div class="visualTitle">${esc(title)}</div>
      <div class="panTiltStages">
        <div class="panDial">
          <span class="dialCardinal north">N</span><span class="dialCardinal east">E</span>
          <span class="dialCardinal south">S</span><span class="dialCardinal west">W</span>
          <div class="panNeedle" style="transform:rotate(${safePan}deg)"></div>
          <div class="dialHub"></div>
        </div>
        <div class="tiltScale">
          <span class="tiltLabel top">${usesPtzScale ? "180°" : "+90°"}</span><span class="tiltLabel middle">${usesPtzScale ? "45°" : "0°"}</span><span class="tiltLabel bottom">-90°</span>
          <div class="tiltTrack"></div><div class="tiltMarker" style="top:${tiltY}px"></div>
        </div>
      </div>
      <div class="visualReadout"><span>PAN ${safePan.toFixed(1)}°</span><span>TILT ${displayTilt.toFixed(1)}°</span></div>
    </div>
  `;
}

/**

 * @brief Convert PTZ tilt telemetry to the measurement scale shown to the operator.

 */

function ptzTiltMeasurementDegrees(tilt) {
  // Clamp the reported camera measurement to the -90° through 180° scale shown
  // in the operator readout.
  return Math.max(-90, Math.min(180, Number(tilt) || 0));
}

/**

 * @brief Convert the displayed PTZ tilt value to the camera model's physical rotation.

 */

function ptzPhysicalTiltDegrees(tilt) {
  // Convert the measurement scale into the camera model's signed physical
  // rotation, wrapping values above 90° through the rear half of its travel.
  const measuredTilt = ptzTiltMeasurementDegrees(tilt);
  return ((measuredTilt + 90) / 270) * 180 - 90;
}

/**

 * @brief Build the animated PTZ camera model from current pan and tilt readings.

 * @param title Panel or section title.

 */

function realisticPtzCameraHtml(pan, tilt, title = "PTZ CAMERA") {
  // Clamp pan, convert tilt to physical rotation, and encode both angles in the
  // returned camera model while retaining the measurement value in its readout.
  const safePan = Math.max(-180, Math.min(180, Number(pan) || 0));
  const safeTilt = ptzPhysicalTiltDegrees(tilt);
  const measuredTilt = ptzTiltMeasurementDegrees(tilt);
  const tiltOffset = -(safeTilt / 90) * 22;

  return `
    <div class="ptzCameraVisualizer" role="img" aria-label="${esc(title)} pan ${safePan.toFixed(1)} degrees tilt ${measuredTilt.toFixed(1)} degrees">
      <div class="ptzVisualHeader"><span>${esc(title)}</span><b><i></i> LIVE POSITION</b></div>
      <div class="ptzScene">
        <div class="ptzFloor"></div>
        <div class="ptzRig" style="transform:rotateY(${safePan}deg)">
          <div class="ptzBaseFoot"></div><div class="ptzBase"></div><div class="ptzNeck"></div>
          <div class="ptzYoke"><span class="ptzArm left"></span><span class="ptzArm right"></span></div>
          <div class="ptzTiltHead" style="transform:translateY(${tiltOffset}px) rotateX(${-safeTilt}deg)">
            <div class="ptzCameraBody"><div class="ptzSunShield"></div><div class="ptzLens"><span></span></div><div class="ptzStatusLed"></div></div>
          </div>
        </div>
        <div class="ptzAimLine" style="transform:translateX(-50%) rotate(${-safeTilt * 0.35}deg)"></div>
      </div>
      <div class="ptzTelemetryReadout">
        <div><span>PAN</span><strong>${safePan.toFixed(1)}&deg;</strong></div>
        <div><span>TILT -90 TO 180</span><strong>${measuredTilt.toFixed(1)}&deg;</strong></div>
      </div>
    </div>
  `;
}

/**

 * @brief Record imu gps fix.

 */

function recordImuGpsFix(lat, lon) {
  // Reject missing and zero-coordinate fixes, set the first valid fix as the
  // local reference, suppress insignificant duplicates, and bound the retained trail.
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return null;

  const point = {
    lat: Math.max(-90, Math.min(90, lat)),
    lon: ((lon + 180) % 360 + 360) % 360 - 180
  };
  const last = imuGpsTrailState.points[imuGpsTrailState.points.length - 1];

  if (!imuGpsTrailState.reference) imuGpsTrailState.reference = { ...point };
  if (!last || Math.abs(last.lat - point.lat) > 1e-9 || Math.abs(last.lon - point.lon) > 1e-9) {
    imuGpsTrailState.points.push(point);
    if (imuGpsTrailState.points.length > imuGpsTrailState.maxPoints) {
      imuGpsTrailState.points.splice(0, imuGpsTrailState.points.length - imuGpsTrailState.maxPoints);
    }
  }
  return point;
}

/**

 * @brief Convert a GPS fix to local east/north metre offsets from the trail origin.

 */

function gpsLocalOffsetMetres(point, reference) {
  // Use an equirectangular approximation around the reference latitude to
  // convert longitude/latitude differences into east and north metre offsets.
  const latitudeRadians = ((point.lat + reference.lat) / 2) * Math.PI / 180;
  let longitudeDelta = point.lon - reference.lon;
  if (longitudeDelta > 180) longitudeDelta -= 360;
  if (longitudeDelta < -180) longitudeDelta += 360;
  return {
    east: longitudeDelta * 111320 * Math.cos(latitudeRadians),
    north: (point.lat - reference.lat) * 110540
  };
}

/**

 * @brief Round a GPS plot extent to a readable engineering scale.

 */

function gpsNiceScale(metres) {
  // Round the requested map extent upward to a 1, 2, 5, or 10 multiple of its
  // power of ten so scope and scale-bar labels are easy to interpret.
  const safe = Math.max(5, metres);
  const exponent = 10 ** Math.floor(Math.log10(safe));
  const fraction = safe / exponent;
  return (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * exponent;
}

/**

 * @brief Build the local IMU GPS trail and heading plot from retained fixes.

 */

function gpsPositionPlotHtml(lat, lon, yaw) {
  // Add a valid GPS fix to the bounded IMU trail, convert every retained fix to
  // local metre offsets from the first fix, choose a readable scale, and return
  // an SVG plot with the newest point oriented by yaw.
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) {
    return `<div class="gpsNoFix">WAITING FOR A VALID GPS FIX</div>`;
  }

  const current = recordImuGpsFix(lat, lon);
  const reference = imuGpsTrailState.reference;
  const offsets = imuGpsTrailState.points.map(point => gpsLocalOffsetMetres(point, reference));
  const currentOffset = gpsLocalOffsetMetres(current, reference);
  const requiredExtent = Math.max(5, ...offsets.flatMap(point => [Math.abs(point.east), Math.abs(point.north)]));
  const scaleMetres = gpsNiceScale(requiredExtent * 1.15);
  const centreX = 160;
  const centreY = 99;
  const pixelsPerMetre = 68 / scaleMetres;
  const plotPoint = point => ({ x: centreX + point.east * pixelsPerMetre, y: centreY - point.north * pixelsPerMetre });
  const trail = offsets.map(plotPoint);
  const plottedCurrent = plotPoint(currentOffset);
  const trailPath = trail.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
  const distance = Math.hypot(currentOffset.east, currentOffset.north);
  const bearing = distance < .05 ? 0 : (Math.atan2(currentOffset.east, currentOffset.north) * 180 / Math.PI + 360) % 360;
  const hasYaw = Number.isFinite(Number(yaw));
  const heading = hasYaw ? ((Number(yaw) % 360) + 360) % 360 : 0;
  const scaleLabel = scaleMetres >= 1000
    ? `${(scaleMetres / 1000).toFixed(scaleMetres < 10000 ? 1 : 0)} km`
    : `${scaleMetres.toFixed(scaleMetres < 10 ? 1 : 0)} m`;

  return `
    <div class="gpsLocalPlot">
      <svg viewBox="0 0 320 205" role="img" aria-label="Offline local GPS trail, current position ${distance.toFixed(1)} metres from reference">
        <defs>
          <pattern id="gpsLocalGrid" width="34" height="34" patternUnits="userSpaceOnUse"><path d="M 34 0 L 0 0 0 34" class="gpsGridLine"/></pattern>
          <clipPath id="gpsPlotClip"><rect x="24" y="20" width="272" height="158" rx="7"/></clipPath>
        </defs>
        <rect x="24" y="20" width="272" height="158" rx="7" class="gpsPlotBackground"/>
        <rect x="24" y="20" width="272" height="158" rx="7" fill="url(#gpsLocalGrid)"/>
        <g clip-path="url(#gpsPlotClip)">
            <line x1="24" y1="99" x2="296" y2="99" class="gpsCardinalAxis"/>
            <line x1="160" y1="20" x2="160" y2="178" class="gpsCardinalAxis"/>
            ${trailPath ? `<path d="${trailPath}" class="gpsTrailShadow"/><path d="${trailPath}" class="gpsTrail"/>` : ""}
            <circle cx="160" cy="99" r="4" class="gpsReferencePoint"/>
            <circle cx="${plottedCurrent.x.toFixed(1)}" cy="${plottedCurrent.y.toFixed(1)}" r="10" class="gpsCurrentHalo"/>
            <circle cx="${plottedCurrent.x.toFixed(1)}" cy="${plottedCurrent.y.toFixed(1)}" r="4" class="gpsCurrentPoint"/>
            ${hasYaw ? `<g class="gpsHeadingArrow" transform="translate(${plottedCurrent.x.toFixed(1)} ${plottedCurrent.y.toFixed(1)}) rotate(${heading.toFixed(1)})"><line x1="0" y1="-5" x2="0" y2="-23"/><path d="M-5,-17 L0,-27 L5,-17 Z"/></g>` : ""}
        </g>
        <text x="160" y="13" class="gpsCardinalLabel">N</text><text x="307" y="102" class="gpsCardinalLabel">E</text>
        <text x="31" y="193" class="gpsScaleLabel">&plusmn;${esc(scaleLabel)} LOCAL SCALE</text>
        <line x1="222" y1="190" x2="290" y2="190" class="gpsScaleBar"/><text x="256" y="202" text-anchor="middle" class="gpsScaleLabel">${esc(scaleLabel)}</text>
      </svg>
    </div>
    <div class="gpsPositionStatus"><strong>${distance.toFixed(1)} m</strong> FROM SESSION REFERENCE${distance >= .05 ? ` AT ${bearing.toFixed(0).padStart(3, "0")}&deg;` : ""}</div>
    <div class="gpsTrailLegend"><span><i class="reference"></i>REFERENCE</span><span><i class="trail"></i>LIVE TRAIL</span>${hasYaw ? `<span><i class="heading"></i>YAW ${heading.toFixed(1)}&deg;</span>` : ""}</div>
  `;
}

/**

 * @brief Build IMU heading, geographic position, altitude, and GPS-trail visuals.

 */

function imuNavigationVisualsHtml(yaw, lat, lon, alt) {
  // Format heading/cardinal direction and GPS position/altitude, combining the
  // numeric navigation cards with the local GPS trail generated from valid fixes.
  const headingValue = Number(yaw);
  const heading = Number.isFinite(headingValue) ? ((headingValue % 360) + 360) % 360 : 0;
  const safeLat = Number.isFinite(Number(lat)) ? Number(lat) : 0;
  const safeLon = Number.isFinite(Number(lon)) ? Number(lon) : 0;
  const safeAlt = Number.isFinite(Number(alt)) ? Number(alt) : 0;
  const altitudePercent = Math.max(4, Math.min(96, 50 + Math.sign(safeAlt) * Math.log10(Math.abs(safeAlt) + 1) * 14));

  return `
    <div class="navigationVisualGrid">
      <div class="headingCompass" role="img" aria-label="Heading ${heading.toFixed(1)} degrees">
        <div class="visualTitle">YAW / HEADING</div>
        <div class="compassRose" style="--heading:${heading}deg;transform:rotate(${-heading}deg)">
          <span class="compassN">N</span><span class="compassE">E</span><span class="compassS">S</span><span class="compassW">W</span>
        </div>
        <div class="headingPointer"></div><strong>${heading.toFixed(1)}°</strong>
      </div>
      <div class="positionDisplay gpsPositionDisplay" role="group" aria-label="Position ${safeLat.toFixed(6)}, ${safeLon.toFixed(6)}">
        <div class="gpsHeader"><div class="visualTitle">GPS POSITION</div><span class="gpsFix"><i></i> FIX</span></div>
        ${gpsPositionPlotHtml(safeLat, safeLon, yaw)}
        <div class="coordinateReadout">
          <div class="coordinateLine"><span>LAT</span><strong>${Math.abs(safeLat).toFixed(6)}&deg; ${safeLat < 0 ? "S" : "N"}</strong></div>
          <div class="coordinateLine"><span>LON</span><strong>${Math.abs(safeLon).toFixed(6)}&deg; ${safeLon < 0 ? "W" : "E"}</strong></div>
        </div>
      </div>
      <div class="altitudeDisplay" role="img" aria-label="Altitude ${safeAlt.toFixed(1)} metres">
        <div class="visualTitle">ALTITUDE</div>
        <div class="altitudeTape"><span class="altMax">HIGH</span><span class="altMin">0</span><div class="altitudeFill" style="height:${altitudePercent}%"></div><div class="altitudeMarker" style="bottom:${altitudePercent}%"></div></div>
        <strong>${safeAlt.toFixed(1)} m</strong>
        <small>ABOVE DATUM</small>
      </div>
    </div>
  `;
}

/**

 * @brief Translate a numeric bearing into its nearest compass direction label.

 */

function bearingCardinalDirection(value) {
  // Normalize the bearing to 0–359° and choose the nearest of eight cardinal
  // and intercardinal compass labels.
  const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return directions[Math.round((((Number(value) % 360) + 360) % 360) / 45) % 8];
}

/**

 * @brief Enter or exit fullscreen for the tactical visualization containing the clicked control.

 */

function toggleTacticalFullscreen(button) {
  // Find the tactical panel containing the clicked control and either request
  // fullscreen for that panel or leave the document's current fullscreen mode.
  const panel = button?.closest(".gpsMissionPanel, .tacticalBearingPanel");
  if (!panel) return;

  if (document.fullscreenElement) {
    document.exitFullscreen?.();
  } else {
    panel.requestFullscreen?.();
  }
}

/**

 * @brief Build the optional legacy target-scope SVG from azimuth, elevation, and range.

 */

function unusedTacticalTrackVisualizationHtml(
  azimuth,
  elevation,
  range,
  uncertainty,
  detected
) {
  // Convert target azimuth, elevation, and range into bounded tactical-scope
  // coordinates and return the optional legacy SVG visualization. The function
  // remains available for layouts that still request this richer scope.
  const az = ((Number(azimuth) % 360) + 360) % 360;
  const el = Math.max(-90, Math.min(90, Number(elevation) || 0));
  const uncertaintyValue = Number.isFinite(Number(uncertainty))
    ? Math.max(0, Number(uncertainty))
    : null;
  const detectionText = String(detected ?? "DETECTED").trim().toUpperCase();
  const detectionActive =
    !["0", "FALSE", "NO", "LOST", "OFFLINE", "NOT_DETECTED"].includes(detectionText);
  const now = Date.now();
  const last = targetBearingHistory.points[targetBearingHistory.points.length - 1];
  if (!last || Math.abs(last.bearing - az) > .01 || now - last.time > 1000) {
    targetBearingHistory.points.push({ bearing: az, time: now });
    if (targetBearingHistory.points.length > targetBearingHistory.maxPoints) {
      targetBearingHistory.points.splice(
        0,
        targetBearingHistory.points.length - targetBearingHistory.maxPoints
      );
    }
  }
  const history = targetBearingHistory.points;
  const historyPath = history.map((point, index) => {
    const x = history.length <= 1 ? 0 : index * 320 / (history.length - 1);
    const y = 88 - point.bearing / 360 * 78;
    return `${index ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");

  return `
    <div class="trackScope tacticalBearingPanel" role="group" aria-label="Target bearing ${az.toFixed(1)} degrees ${bearingCardinalDirection(az)}">
      <div class="tacticalBearingHeader">
        <div><div class="visualTitle">TACTICAL TARGET BEARING</div><small>LIVE DIRECTIONAL SOLUTION</small></div>
        <span class="bearingDetection ${detectionActive ? "active" : "lost"}"><i></i>${detectionActive ? "TARGET DETECTED" : "TARGET LOST"}</span>
        <button class="tacticalFullscreenButton" type="button" onclick="toggleTacticalFullscreen(this)" aria-label="Open target bearing full screen">⛶ FULL SCREEN</button>
      </div>
      <div class="tacticalBearingLayout">
        <div class="tacticalCompass">
          <div class="bearingTicks"></div>
          <span class="bearingNorth">N</span><span class="bearingEast">E</span><span class="bearingSouth">S</span><span class="bearingWest">W</span>
          <div class="bearingUncertaintyCone" style="--bearing:${az}deg;--uncertainty:${Math.min(60, uncertaintyValue ?? 4)}deg;--uncertainty-span:${Math.min(120, (uncertaintyValue ?? 4) * 2)}deg"></div>
          <div class="bearingArrow" style="transform:translateX(-50%) rotate(${az}deg)"><i></i></div>
          <div class="bearingCenter"><strong>${az.toFixed(1)}°</strong><span>${bearingCardinalDirection(az)}</span></div>
        </div>
        <div class="bearingDataCards">
          <div><span>BEARING</span><strong>${az.toFixed(1)}°</strong></div>
          <div><span>DIRECTION</span><strong>${bearingCardinalDirection(az)}</strong></div>
          <div><span>UNCERTAINTY</span><strong>${uncertaintyValue === null ? "--" : `±${uncertaintyValue.toFixed(1)}°`}</strong></div>
          <div><span>ELEVATION</span><strong>${el.toFixed(1)}°</strong></div>
          <div><span>RANGE</span><strong>${esc(range)}${Number.isFinite(Number(range)) ? " m" : ""}</strong></div>
        </div>
      </div>
      <div class="bearingHistory">
        <div><span>BEARING HISTORY</span><small>0° — 360°</small></div>
        <svg viewBox="0 0 320 96" preserveAspectRatio="none" role="img" aria-label="Recent bearing history">
          <path d="M0 10H320 M0 49H320 M0 88H320" class="bearingHistoryGrid"/>
          ${historyPath ? `<path d="${historyPath}" class="bearingHistoryLine"/>` : ""}
        </svg>
      </div>
    </div>
  `;
}

/* Restored compact target scope. This declaration intentionally supersedes
 * the experimental tactical renderer above while preserving live aliases. */
/**
 * @brief Build the compact external-target scope from bearing, elevation, and range.
 */
function externalTrackVisualizationHtml(azimuth, elevation, range) {
  // Normalize target bearing, clamp elevation and range for display, and map
  // them into the compact scope's direction line, elevation marker, and labels.
  const az = ((Number(azimuth) % 360) + 360) % 360;
  const el = Math.max(-90, Math.min(90, Number(elevation) || 0));
  const angle = (az - 90) * Math.PI / 180;
  const x = 50 + Math.cos(angle) * 36;
  const y = 50 + Math.sin(angle) * 36;

  return `
    <div class="trackScope" role="img" aria-label="Target azimuth ${az.toFixed(1)} elevation ${el.toFixed(1)} range ${esc(range)}">
      <div class="visualTitle">TARGET BEARING</div>
      <div class="scopeFace">
        <span class="scopeNorth">N</span><span class="scopeEast">E</span><span class="scopeSouth">S</span><span class="scopeWest">W</span>
        <div class="scopeSweep" style="transform:rotate(${az}deg)"></div>
        <div class="scopeTarget" style="left:${x}%;top:${y}%"></div>
      </div>
    </div>
  `;
}

/**

 * @brief Build an escaped disclosure grid containing every flattened telemetry field.


 * @param title Panel or section title.

 */

function allTelemetryFieldsHtml(payload, title = "All Telemetry Fields") {
  // Return no disclosure for an invalid payload; otherwise flatten, sort, escape,
  // and render every field so unknown telemetry remains available to diagnostics.
  if (!payload || typeof payload !== "object") {
    return "";
  }

  const fields =
    flattenTelemetryFields(payload)
      .filter(([key, value]) =>
        value !== undefined &&
        value !== null &&
        !["raw_json"].includes(String(key).toLowerCase())
      )
      .sort((a, b) => a[0].localeCompare(b[0]));

  if (!fields.length) {
    return "";
  }

  return `
    <details class="controlSection dynamicTelemetrySection" data-panel-title="${esc(title)}" open>
      <summary>${esc(title)} (${fields.length})</summary>
      <div class="dynamicTelemetryGrid">
        ${fields.map(([key, value]) => `
          <div class="imuInstrument stableTelemetryField" data-telemetry-key="${esc(key)}">
            <div class="imuLabel">${esc(displayName(key))}</div>
            <div class="imuValue" data-telemetry-value>${esc(String(value))}</div>
          </div>
        `).join("")}
      </div>
    </details>
  `;
}

/**

 * @brief Build a fallback device overview from its most informative scalar telemetry fields.



 */

function genericDeviceOverviewHtml(device, payload) {
  // Select the most informative scalar fields from an otherwise unsupported
  // device payload and return escaped metric cards, followed by the complete
  // dynamic-field disclosure for diagnostics.
  const fields = flattenTelemetryFields(payload || {})
    .filter(([key, value]) =>
      value !== undefined &&
      value !== null &&
      String(key).toLowerCase() !== "raw_json"
    )
    .sort((a, b) => a[0].localeCompare(b[0]));

  return `
    <section class="genericDevicePanel">
      <div class="detailHeader">
        <h3>${esc(displayName(device))}</h3>
        <span>${fields.length} LIVE FIELDS</span>
      </div>

      ${fields.length ? `
        <div class="dynamicTelemetryGrid genericTelemetryGrid">
          ${fields.map(([key, value]) => `
            <div class="imuInstrument stableTelemetryField" data-telemetry-key="${esc(key)}">
              <div class="imuLabel">${esc(displayName(key))}</div>
              <div class="imuValue" data-telemetry-value>${esc(String(value))}</div>
            </div>
          `).join("")}
        </div>
      ` : `
        <div class="deviceInspectorEmpty compact">
          <h2>Waiting for telemetry</h2>
        </div>
      `}
    </section>
  `;
}

/**

 * @brief Update stable telemetry fields.


 */

function updateStableTelemetryFields(device) {
  // Patch values and status classes in an existing selected-device overview
  // without replacing its DOM, returning false when the expected stable mounts
  // are absent so the caller can perform a full preserved-state render.
  if (!isSelectedDevice(device) || inspectorTab !== "overview") {
    return false;
  }

  const detail =
    document.getElementById("selectedDeviceDetail");

  if (!detail) {
    return false;
  }

  const canonical =
    canonicalInspectorDevice(device);
  const payload =
    liveDeviceState[canonical] ||
    liveDeviceState[device] ||
    {};
  const fields =
    flattenTelemetryFields(payload)
      .filter(([key, value]) =>
        value !== undefined &&
        value !== null &&
        String(key).toLowerCase() !== "raw_json"
      )
      .sort((a, b) => a[0].localeCompare(b[0]));

  if (!fields.length) {
    return false;
  }

  let updated = false;
  const known =
    new Set();

  fields.forEach(([key, value]) => {
    known.add(String(key));
    const field =
      Array.from(detail.querySelectorAll("[data-telemetry-key]"))
        .find(node => node.dataset.telemetryKey === String(key));
    const text =
      value === undefined || value === null
        ? ""
        : String(value);

    if (field) {
      const valueNode =
        field.querySelector("[data-telemetry-value]");

      if (valueNode && valueNode.textContent !== text) {
        valueNode.textContent = text;
        field.classList.add("telemetryValueUpdated");
        setTimeout(() => {
          field.classList.remove("telemetryValueUpdated");
        }, 280);
      }
      updated = true;
      return;
    }

    const grid =
      detail.querySelector(".dynamicTelemetryGrid") ||
      detail.querySelector(".genericTelemetryGrid");

    if (!grid) {
      return;
    }

    const card =
      document.createElement("div");

    card.className =
      "imuInstrument stableTelemetryField telemetryValueUpdated";
    card.dataset.telemetryKey =
      String(key);
    card.innerHTML =
      `<div class="imuLabel">${esc(displayName(key))}</div>` +
      `<div class="imuValue" data-telemetry-value>${esc(text)}</div>`;
    grid.appendChild(card);
    updated = true;
  });

  return updated;
}

/**

 * @brief Build labeled IMU sensor cards from supported attitude, motion, GPS, and health aliases.


 */

function imuKeyValueSignalsHtml(payload) {
  // Resolve attitude, acceleration, gyroscope, GPS, temperature, pressure, and
  // status aliases into labeled IMU cards while omitting values not present in
  // the current retained payload.
  const representedFields = new Set([
    "roll", "roll_deg", "imu_roll", "imu_roll_deg",
    "pitch", "pitch_deg", "imu_pitch", "imu_pitch_deg",
    "yaw", "yaw_deg", "imu_yaw", "imu_yaw_deg", "heading", "heading_deg",
    "lat", "latitude", "latitude_deg", "gps_lat", "gps_latitude",
    "lon", "lng", "longitude", "longitude_deg", "gps_lon", "gps_longitude",
    "alt", "alt_m", "altitude", "altitude_m", "gps_altitude",
    "euler_deg", "angles_deg"
  ]);
  const transportFields = new Set([
    "timestamp", "device", "channel", "type", "raw_json", "seq",
    "source", "direction", "service"
  ]);

  const fields = flattenTelemetryFields(payload)
    .filter(([key, value]) => {
      const leaf = String(key).split(".").pop().toLowerCase();
      return value !== undefined && value !== null &&
        !representedFields.has(leaf) && !transportFields.has(leaf);
    })
    .sort((a, b) => a[0].localeCompare(b[0]));

  if (!fields.length) return "";

  const formatValue = value => {
    if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
    if (typeof value === "number" && Number.isFinite(value)) {
      return Number.isInteger(value)
        ? String(value)
        : value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
    }
    return String(value);
  };
  const unitFor = key => {
    const normalized = String(key).toLowerCase();
    if (normalized.includes("accel")) return "m/s²";
    if (normalized.includes("gyro")) return "°/s";
    if (normalized.includes("temperature") || normalized.includes("temp")) return "°C";
    return "";
  };

  return `
    <section class="imuSignalSection" aria-label="Additional live IMU signals">
      <div class="imuSignalHeader">
        <h4>Additional IMU Signals</h4>
        <span>${fields.length} LIVE VALUES</span>
      </div>
      <div class="imuSignalKeyValueGrid">
        ${fields.map(([key, value]) => `
          <div class="imuSignalPair">
            <span class="imuSignalKey">${esc(displayName(String(key).replace(/\./g, " / ")))}</span>
            <span class="imuSignalValue">${esc(formatValue(value))}${unitFor(key) ? ` <small>${esc(unitFor(key))}</small>` : ""}</span>
          </div>
        `).join("")}
      </div>
    </section>
  `;
}

/**

 * @brief Merge lcu telemetry into drive.



 */

function mergeLcuTelemetryIntoDrive(payload, timestamp) {
  // Extract nested LCU drive-state axes and common drive fields, merge them into
  // the Drive Unit's retained payload, refresh drive liveness/metrics, and render
  // the drive view so LCU transport remains the source of drive feedback.
  if (!payload || typeof payload !== "object") return;

  const axisName = String(
    payloadValue(payload, ["axis_name", "axis"], "")
  ).trim().toUpperCase();
  const angle = telemetryNumber(
    payload,
    ["pos_deg", "position_deg", "angle_deg", "angle_feedback", "angle"],
    NaN
  );
  const update = {};

  if (Number.isFinite(angle)) {
    if (axisName === "PAN" || axisName === "2") {
      update.pan_deg = angle;
      update.pan_actual_deg = angle;
    } else if (axisName === "TILT" || axisName === "1") {
      update.tilt_deg = angle;
      update.tilt_actual_deg = angle;
    }
  }

  [
    ["rpm", ["rpm", "actual_rpm", "motor_rpm", "speed_rpm"]],
    ["actual_current", ["actual_current", "current", "current_a", "motor_current"]],
    ["dcbus_volt", ["dcbus_volt", "dcbus_voltage", "bus_voltage", "voltage"]],
    ["fault_raw", ["fault_raw", "fault_status", "fault", "drive_fault"]],
    ["drive_connected", ["drive_connected", "connected"]]
  ].forEach(([target, keys]) => {
    const value = payloadValue(payload, keys, null);
    if (value !== null && value !== "") update[target] = value;
  });

  if (payload.fault_bits && typeof payload.fault_bits === "object") {
    update.fault_bits = mergeRetainedTelemetry(
      liveDeviceState.DRIVE_UNIT?.fault_bits || {},
      payload.fault_bits
    );
  }

  update.lcu_axis_name = axisName;
  update.lcu_timestamp = timestamp || "";

  liveDeviceState.DRIVE_UNIT = mergeRetainedTelemetry(
    liveDeviceState.DRIVE_UNIT || {},
    update
  );
  deviceHeartbeat.DRIVE_UNIT = Date.now();

  if (!deviceMetrics.DRIVE_UNIT) {
    deviceMetrics.DRIVE_UNIT = {
      packets: 0,
      lastPacket: Date.now(),
      lastRateCalc: Date.now(),
      rate: 0,
      packetCount: 0,
      packetRate: 0,
      online: true,
      lastSeen: timestamp || "-",
      anomalies: 0,
      health: 100
    };
  }

  const metrics = deviceMetrics.DRIVE_UNIT;
  metrics.packetCount++;
  metrics.lastPacket = Date.now();
  metrics.lastSeen = timestamp || metrics.lastSeen;
  metrics.online = true;

  ensureDevicePanel("DRIVE_UNIT");
  setDeviceStatus("DRIVE_UNIT", "online", timestamp || "");
  pushTrendPacket(liveDeviceState.DRIVE_UNIT, "DRIVE_UNIT");
  scheduleSelectedInspectorRender("DRIVE_UNIT");

}

/**

 * @brief Render drive motion, motor electrical, temperature, connectivity, limit, and fault telemetry.



 */

function renderDriveSystemPanel(
  payload,
  timestamp
) {
  // Resolve drive pan/tilt command and feedback, RPM, current, voltage, torque,
  // temperatures, connectivity, limits, and faults from retained aliases, then
  // render mechanical instruments, electrical cards, and all raw telemetry.

  const el =
    getDeviceDetail("DRIVE_UNIT");

  if (!el) {
    return;
  }

  if (!payload) {

    el.innerHTML = `
      <div class="detailHeader">
        <h3>Drive Control System</h3>
        <span>OFFLINE</span>
      </div>
    `;

    return;
  }

  const pan =
    telemetryNumber(payload, ["pan_actual_deg", "pan_angle", "pan_deg", "pan", "drive_state.pan.target_deg"]);

  const tilt =
    telemetryNumber(payload, ["tilt_actual_deg", "tilt_angle", "tilt_deg", "tilt", "drive_state.tilt.target_deg"]);

  const rpm =
    telemetryNumber(payload, ["rpm", "motor_rpm", "speed_rpm", "actual_rpm", "velocity"]);

  const current =
    telemetryNumber(payload, ["current", "current_a", "motor_current", "motor_current_a", "actual_current"]);

  const voltage =
    telemetryNumber(payload, ["voltage", "voltage_v", "dcbus_volt", "dcbus_voltage", "bus_voltage"]);

  let fault = payloadValue(
    payload,
    ["fault_status", "fault", "drive_fault", "fault_raw"],
    "NONE"
  );
  if (
    (fault === "NONE" || fault === "" || fault === undefined) &&
    payload.fault_bits &&
    typeof payload.fault_bits === "object"
  ) {
    const activeFaults = Object.entries(payload.fault_bits)
      .filter(([, value]) => isControlOn(value))
      .map(([key]) => displayName(key));
    fault = activeFaults.length ? activeFaults.join(", ") : "NONE";
  }
  const hasFault = !["", "0", "NONE", "FALSE", "OK", "NOMINAL"]
    .includes(String(fault).toUpperCase());
  const driveConnected = isControlOn(
    payloadValue(payload, ["drive_connected", "connected"], 1)
  );

  let motionState = "STANDBY";

  if (Math.abs(rpm) > 100) {
    motionState = "TRACKING";
  }

  if (Math.abs(rpm) > 1000) {
    motionState = "HIGH SPEED";
  }

  if (hasFault) {
    motionState = "FAULT";
  }

  if (!driveConnected) {
    motionState = "DISCONNECTED";
  }

  const bannerClass =
    motionState
      .toLowerCase()
      .replace(/\s+/g, "-");

  el.innerHTML = `

    <div class="detailHeader">

      <h3>
        Drive Control System
      </h3>

      <span>
        ${esc(timestamp || "--")}
      </span>

    </div>

    ${panTiltVisualizationHtml(pan, tilt, "DRIVE ORIENTATION")}

    <div class="imuGrid">

      <div class="imuInstrument">
        <div class="imuLabel">
          PAN ANGLE
        </div>
        <div class="imuValue">
          ${esc(pan.toFixed(1))}°
        </div>
      </div>

      <div class="imuInstrument">
        <div class="imuLabel">
          TILT ANGLE
        </div>
        <div class="imuValue">
          ${esc(tilt.toFixed(1))}°
        </div>
      </div>

      <div class="imuInstrument">
        <div class="imuLabel">
          MOTOR RPM
        </div>
        <div class="imuValue">
          ${esc(rpm.toFixed(0))}
        </div>
      </div>

      <div class="imuInstrument">
        <div class="imuLabel">
          CURRENT
        </div>
        <div class="imuValue">
          ${esc(current.toFixed(2))}A
        </div>
      </div>

      <div class="imuInstrument">
        <div class="imuLabel">
          BUS VOLTAGE
        </div>
        <div class="imuValue">
          ${esc(voltage.toFixed(1))}V
        </div>
      </div>

      <div class="imuInstrument">
        <div class="imuLabel">
          FAULT STATUS
        </div>
        <div class="imuValue small">
          ${esc(fault)}
        </div>
      </div>

    </div>

    <div class="missionBanner ${bannerClass}">
      DRIVE STATE : ${motionState}
    </div>

    ${allTelemetryFieldsHtml(payload, "All Live Drive Readings")}

  `;
}
/**
 * @brief Render CCE transport health, commands, interlocks, counters, and timing telemetry.
 */
function renderCceGatewayPanel(
  payload,
  timestamp
) {
  // Read CCE connection, command, interlock, mode, counter, timing, and transport
  // fields from nested or flattened payload forms and render gateway health plus
  // operator-command diagnostics in the selected CCE detail panel.

  const el =
    getDeviceDetail(
      "CCE_GATEWAY"
    );
if (!el) {
  return;
}

if (!payload) {

  el.innerHTML = `

    <div class="detailHeader">

      <h3>
        CCE / FCS Gateway
      </h3>

      <span>OFFLINE</span>

    </div>

    <div class="cceGrid">

      <div class="cceCard">
        <div class="cceLabel">
          HEARTBEAT
        </div>
        <div class="cceStatus">
          --
        </div>
      </div>

      <div class="cceCard">
        <div class="cceLabel">
          LAUNCH ENABLE
        </div>
        <div class="cceStatus">
          --
        </div>
      </div>

      <div class="cceCard">
        <div class="cceLabel">
          SALVO MODE
        </div>
        <div class="cceStatus">
          --
        </div>
      </div>

    </div>
  `;

  return;
}

  const heartbeat =
    payload.heartbeat ??
    "ONLINE";

  const launchEnable =
    payload.launch_enable ?? 0;

  const salvo =
    payload.salvo_launch ?? 0;

  const uncaging =
    payload.uncaging_enable ?? 0;

  const fastLock =
    payload.fast_lock_on ?? 0;

  const heatFlare =
    payload.heat_flare_on ?? 0;

  const tailChase =
    payload.tail_chase_mode ?? 0;

  const relay =
    payload.relay_active ?? 0;

  const requestedMode =
    payload.fcs_requested_mode ??
    payload.requested_mode ??
    payload.mode ??
    "--";

  const confirmedMode =
    payload.fcs_confirmed_mode ??
    payload.confirmed_mode ??
    payload.fcs_state ??
    "--";

  const lastAck =
    payload.fcs_last_ack ??
    payload.last_ack ??
    "--";

  const modeMessage =
    payload.fcs_last_interlock_reject ??
    payload.message ??
    payload.decoded ??
    "--";

  el.innerHTML = `

    <div class="detailHeader">

      <h3>
        CCE / FCS Gateway
      </h3>

      <span>
        ${esc(timestamp || "--")}
      </span>

    </div>

    <div class="cceGrid">

      <div class="cceCard">

        <div class="cceLabel">
          HEARTBEAT
        </div>

        <div class="cceStatus ok">
          ${esc(String(heartbeat))}
        </div>

      </div>

      <div class="cceCard">

        <div class="cceLabel">
          LAUNCH ENABLE
        </div>

        <div class="
          cceStatus
          ${launchEnable ? "danger" : ""}
        ">
          ${launchEnable ? "ARMED" : "SAFE"}
        </div>

      </div>

      <div class="cceCard">

        <div class="cceLabel">
          SALVO MODE
        </div>

        <div class="
          cceStatus
          ${salvo ? "warn" : ""}
        ">
          ${salvo ? "ACTIVE" : "OFF"}
        </div>

      </div>

      <div class="cceCard">

        <div class="cceLabel">
          UNCAGING
        </div>

        <div class="
          cceStatus
          ${uncaging ? "warn" : ""}
        ">
          ${uncaging ? "ENABLED" : "DISABLED"}
        </div>

      </div>

      <div class="cceCard">

        <div class="cceLabel">
          FAST LOCK
        </div>

        <div class="
          cceStatus
          ${fastLock ? "ok" : ""}
        ">
          ${fastLock ? "LOCKED" : "IDLE"}
        </div>

      </div>

      <div class="cceCard">

        <div class="cceLabel">
          HEAT FLARE
        </div>

        <div class="
          cceStatus
          ${heatFlare ? "warn" : ""}
        ">
          ${heatFlare ? "ON" : "OFF"}
        </div>

      </div>

      <div class="cceCard">

        <div class="cceLabel">
          TAIL CHASE
        </div>

        <div class="
          cceStatus
          ${tailChase ? "ok" : ""}
        ">
          ${tailChase ? "ACTIVE" : "OFF"}
        </div>

      </div>

      <div class="cceCard">

        <div class="cceLabel">
          RELAY
        </div>

        <div class="
          cceStatus
          ${relay ? "danger" : ""}
        ">
          ${relay ? "ACTIVE" : "IDLE"}
        </div>

      </div>

      <div class="cceCard">
        <div class="cceLabel">REQUESTED MODE</div>
        <div class="cceStatus ok">${esc(String(requestedMode))}</div>
      </div>

      <div class="cceCard">
        <div class="cceLabel">CONFIRMED MODE</div>
        <div class="cceStatus ok">${esc(String(confirmedMode))}</div>
      </div>

      <div class="cceCard">
        <div class="cceLabel">LAST ACK</div>
        <div class="cceStatus">${esc(String(lastAck))}</div>
      </div>

      <div class="cceCard">
        <div class="cceLabel">MODE / INTERLOCK MESSAGE</div>
        <div class="cceStatus">${esc(String(modeMessage))}</div>
      </div>

    </div>

    ${allTelemetryFieldsHtml(payload)}
  `;
}

/**

 * @brief Merge and render retained LCU axes, common state, transport, and drive feedback.



 */

function renderLcuPanel(
  payload,
  timestamp
) {
  // Merge partial LCU body/axis values into stable retained state, resolve drive
  // feedback and transport metadata, and render the LCU instrument without
  // allowing omitted fields in one packet to erase earlier valid readings.

  const el =
    getDeviceDetail(
      "LCU_UNIT"
    );

  if (!el) {
    return;
  }

  if (!payload) {

    el.innerHTML = `
      <div class="detailHeader">
        <h3>LCU Transport</h3>
        <span>OFFLINE</span>
      </div>
    `;

    return;
  }

  const src =
    payload.src ?? "--";

  const name =
    payload.name ?? "--";
  const axisId =
    payloadValue(payload, ["axis"], "");

  if (axisId !== "") {
    const axisKey =
      String(axisId);

    lcuStableState.axes[axisKey] = {
      ...(lcuStableState.axes[axisKey] || {}),
      angle:
        payloadValue(
          payload,
          ["angle_feedback", "angle", "position", "target_angle", "command_angle"],
          lcuStableState.axes[axisKey]?.angle ?? "--"
        ),
      rpm:
        payloadValue(
          payload,
          ["rpm", "actual_rpm", "motor_rpm", "speed_rpm"],
          lcuStableState.axes[axisKey]?.rpm ?? "--"
        ),
      current:
        payloadValue(
          payload,
          ["actual_current", "current", "current_a", "motor_current", "motor_current_a"],
          lcuStableState.axes[axisKey]?.current ?? "--"
        ),
      fault:
        payloadValue(
          payload,
          ["fault_status", "fault", "fault_code", "error", "fault_raw"],
          lcuStableState.axes[axisKey]?.fault ?? "--"
        ),
      system:
        payloadValue(
          payload,
          ["system_status", "system_state", "state", "status"],
          lcuStableState.axes[axisKey]?.system ?? "--"
        ),
      timestamp:
        timestamp || lcuStableState.axes[axisKey]?.timestamp || ""
    };
  }

  [
    ["io", ["io_status", "status", "dio_connected", "body_dio_connected"]],
    ["di", ["di_bits", "body_di_bits"]],
    ["do", ["do_bits", "body_do_bits"]],
    ["panLock", ["lock_status.pan.state", "body_lock_status_pan_state"]],
    ["tiltLock", ["lock_status.tilt.state", "body_lock_status_tilt_state"]]
  ].forEach(([key, keys]) => {
    const value =
      payloadValue(payload, keys, "");

    if (value !== "") {
      lcuStableState.common[key] = value;
    }
  });

  lcuStableState.timestamp =
    timestamp || lcuStableState.timestamp;

  const axisLabel = axis => {
    if (String(axis) === "1") return "TILT";
    if (String(axis) === "2") return "PAN";
    return `AXIS ${axis}`;
  };

  const axisCards =
    Object.keys(lcuStableState.axes)
      .sort()
      .map(axis => {
        const a =
          lcuStableState.axes[axis];

        return `
          <div class="imuInstrument">
            <div class="imuLabel">${esc(axisLabel(axis))}</div>
            <div class="imuValue">${esc(a.angle)}</div>
          </div>
          <div class="imuInstrument">
            <div class="imuLabel">${esc(axisLabel(axis))} RPM</div>
            <div class="imuValue">${esc(a.rpm)}</div>
          </div>
          <div class="imuInstrument">
            <div class="imuLabel">${esc(axisLabel(axis))} CURRENT</div>
            <div class="imuValue">${esc(a.current)}</div>
          </div>
          <div class="imuInstrument">
            <div class="imuLabel">${esc(axisLabel(axis))} FAULT</div>
            <div class="imuValue">${esc(a.fault)}</div>
          </div>
        `;
      })
      .join("");

  const common =
    lcuStableState.common;

  el.innerHTML = `

    <div class="detailHeader">

      <h3>LCU Transport</h3>

      <span>
        ${esc(lcuStableState.timestamp || "--")}
      </span>

    </div>

    <div class="imuGrid">

      <div class="imuInstrument">
        <div class="imuLabel">SOURCE</div>
        <div class="imuValue">${esc(src)}</div>
      </div>

      <div class="imuInstrument">
        <div class="imuLabel">MESSAGE</div>
        <div class="imuValue">${esc(name)}</div>
      </div>

      ${axisCards || `
        <div class="imuInstrument">
          <div class="imuLabel">AXIS</div>
          <div class="imuValue">--</div>
        </div>
      `}

      <div class="imuInstrument">
        <div class="imuLabel">IO STATUS</div>
        <div class="imuValue">${esc(common.io ?? "--")}</div>
      </div>
     <div class="imuInstrument">
  <div class="imuLabel">DI BITS</div>
  <div class="imuValue">
    ${esc(String(common.di ?? "--"))}
  </div>
</div>

<div class="imuInstrument">
  <div class="imuLabel">DO BITS</div>
  <div class="imuValue">
    ${esc(String(common.do ?? "--"))}
  </div>
</div>

<div class="imuInstrument">
  <div class="imuLabel">PAN LOCK</div>
  <div class="imuValue">
    ${esc(String(common.panLock ?? "--"))}
  </div>
</div>

<div class="imuInstrument">
  <div class="imuLabel">TILT LOCK</div>
  <div class="imuValue">
    ${esc(String(common.tiltLock ?? "--"))}
  </div>
</div>
    </div>

    ${allTelemetryFieldsHtml(payload)}
  `;
}

/**

 * @brief Render external target identity, geometry, confidence, position, and raw telemetry.



 */

function renderExternalTrackPanel(
  payload,
  timestamp
) {
  // Resolve target identity, command, azimuth, elevation, range, confidence, and
  // geographic fields, then render the compact target scope and full telemetry
  // disclosure for the selected external-track unit.

  const el =
    getDeviceDetail(
      "EXTERNAL_TRACK_UNIT"
    );

  if (!el) return;

  if (!payload) {

    el.innerHTML = `
      <div class="detailHeader">
        <h3>External Track</h3>
        <span>OFFLINE</span>
      </div>
    `;

    return;
  }

  const trackId = payloadValue(payload, ["track_id", "trackId", "id", "target_id"]);
  const azimuth = payloadValue(payload, ["azimuth", "azimuth_deg", "az", "bearing"]);
  const elevation = payloadValue(payload, ["elevation", "elevation_deg", "el", "target_elevation", "altitude"]);
  const range = payloadValue(payload, ["range", "range_m", "lrf_range", "distance", "distance_m"]);

  el.innerHTML = `

    <div class="detailHeader">

      <h3>External Track</h3>

      <span>
        ${esc(timestamp || "--")}
      </span>

    </div>

    ${externalTrackVisualizationHtml(azimuth, elevation, range)}

    <div class="imuGrid">

      <div class="imuInstrument">
        <div class="imuLabel">TRACK ID</div>
        <div class="imuValue">
          ${esc(trackId)}
        </div>
      </div>

      <div class="imuInstrument">
        <div class="imuLabel">AZIMUTH</div>
        <div class="imuValue">
          ${esc(azimuth)}${Number.isFinite(Number(azimuth)) ? "°" : ""}
        </div>
      </div>

      <div class="imuInstrument">
        <div class="imuLabel">ELEVATION</div>
        <div class="imuValue">
          ${esc(elevation)}${Number.isFinite(Number(elevation)) ? "°" : ""}
        </div>
      </div>

      <div class="imuInstrument">
        <div class="imuLabel">RANGE</div>
        <div class="imuValue">
          ${esc(range)}${Number.isFinite(Number(range)) ? " m" : ""}
        </div>
      </div>

    </div>

    ${allTelemetryFieldsHtml(payload)}
  `;
}

/**

 * @brief Decode and render Advantech digital I/O channels, masks, connectivity, and health.



 */

function renderAdvantechIoPanel(
  payload,
  timestamp
) {
  // Decode digital input/output objects or synthesize eight channels from their
  // bit masks, extract module health, and render rack lamps plus clickable input
  // and output tiles with transition metadata.

  const el =
    getDeviceDetail(
      "ADVANTECH_IO"
    );

  if (!el) return;

  if (!payload) {

    el.innerHTML = `
      <div class="detailHeader">
        <h3>ADVANTECH I/O</h3>
        <span>OFFLINE</span>
      </div>
    `;

    return;
  }

  const channelBank = (source, mask, prefix) => {
    if (source && typeof source === "object" && Object.keys(source).length) {
      return source;
    }

    const numericMask = Number(mask);
    if (!Number.isFinite(numericMask)) return {};

    return Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [
        `${prefix}${index}`,
        (numericMask >> index) & 1
      ])
    );
  };

  const diMask = payloadValue(payload, ["di_mask", "di_bits", "digital_input_mask"], 0);
  const doMask = payloadValue(payload, ["do_mask", "do_bits", "digital_output_mask"], 0);
  const di = channelBank(payload.di || payload.digital_inputs || payload.body?.di || payload.body?.digital_inputs, diMask, "DI");
  const dout = channelBank(payload.do || payload.digital_outputs || payload.body?.do || payload.body?.digital_outputs, doMask, "DO");

  const health =
    payload.health || payload.body?.health || {};

  el.innerHTML = `

    <div class="detailHeader">

      <h3>
        ADVANTECH I/O
      </h3>

      <span>
        ${esc(timestamp || "--")}
      </span>

    </div>

    <div class="imuGrid">

      <div class="imuInstrument">
        <div class="imuLabel">CONNECTED</div>
        <div class="imuValue">
          ${isControlOn(payloadValue(payload, ["device_connected", "connected", "dio_connected"], 0)) ? "ONLINE" : "OFFLINE"}
        </div>
      </div>

      <div class="imuInstrument">
        <div class="imuLabel">DI MASK</div>
        <div class="imuValue">
          ${esc(diMask)}
        </div>
      </div>

      <div class="imuInstrument">
        <div class="imuLabel">DO MASK</div>
        <div class="imuValue">
          ${esc(doMask)}
        </div>
      </div>

      <div class="imuInstrument">
        <div class="imuLabel">QUEUE</div>
        <div class="imuValue">
          ${health.queue_depth ?? 0}
        </div>
      </div>

      <div class="imuInstrument">
        <div class="imuLabel">RX ERRORS</div>
        <div class="imuValue">
          ${health.rx_errors ?? 0}
        </div>
      </div>

      <div class="imuInstrument">
        <div class="imuLabel">UPTIME</div>
        <div class="imuValue">
          ${Math.floor((health.uptime_ms || 0)/1000)}s
        </div>
      </div>

    </div>

    <div class="ioRackVisualization" aria-label="Advantech digital I/O channel states">
      <div class="visualTitle">I/O RACK</div>
      <div class="ioRackRow"><span>INPUT</span>${Object.entries(di).map(([key, value]) => `<div class="ioChannel ${isControlOn(readControlValue(value)) ? "on" : "off"}"><i></i><b>${esc(key)}</b></div>`).join("")}</div>
      <div class="ioRackRow"><span>OUTPUT</span>${Object.entries(dout).map(([key, value]) => `<div class="ioChannel output ${isControlOn(readControlValue(value)) ? "on" : "off"}"><i></i><b>${esc(key)}</b></div>`).join("")}</div>
    </div>

    <div class="controlSection">

      <h3>Digital Inputs</h3>

      <div class="controlGrid">

        ${Object.entries(di).map(([k,v]) => {
          const meta =
            updateControlMeta(
              "ADVANTECH_IO",
              "Digital Inputs",
              k,
              readControlValue(v),
              "switch",
              timestamp
            );

          return `
          <div
            class="controlTile ${isControlOn(readControlValue(v)) ? "active" : "inactive"}"
            onclick='recordOperatorInteraction("ADVANTECH_IO", "Digital Inputs", ${JSON.stringify(k)})'>
            <div class="controlName">${esc(k)}</div>
            <div class="controlValue">${esc(readControlValue(v))}</div>
            ${controlTelemetryHtml(meta)}
          </div>
        `;
        }).join("")}

      </div>

    </div>

    <div class="controlSection">

      <h3>Digital Outputs</h3>

      <div class="controlGrid">

        ${Object.entries(dout).map(([k,v]) => {
          const meta =
            updateControlMeta(
              "ADVANTECH_IO",
              "Digital Outputs",
              k,
              readControlValue(v),
              "switch",
              timestamp
            );

          return `
          <div
            class="controlTile ${isControlOn(readControlValue(v)) ? "active" : "inactive"}"
            onclick='recordOperatorInteraction("ADVANTECH_IO", "Digital Outputs", ${JSON.stringify(k)})'>
            <div class="controlName">${esc(k)}</div>
            <div class="controlValue">${esc(readControlValue(v))}</div>
            ${controlTelemetryHtml(meta)}
          </div>
        `;
        }).join("")}

      </div>

    </div>
    ${allTelemetryFieldsHtml(payload)}
  `;
}

/**

 * @brief Build camera/PTZ, tracking, return-box, range, video, and drive-link overview markup.



 */

function cameraOverviewHtml(payload, timestamp) {
  // Convert camera/tracker identity, video, tracking, return-box, pan/tilt, error,
  // range, and drive-link fields into PTZ visualization and status cards; a null
  // payload produces an explicit offline overview.
  if (!payload) {
    return `
      <div class="detailHeader">
        <h3>Camera / Tracker Overview</h3>
        <span>OFFLINE</span>
      </div>
    `;
  }

  const renderKey =
    JSON.stringify([
      payload.camera_id,
      payload.video_source,
      payload.fps,
      payload.tracking,
      payload.track_mode,
      payload.track_type,
      payload.tracker_ret_x,
      payload.tracker_ret_y,
      payload.tracker_bb_w,
      payload.tracker_bb_h,
      payload.pan_actual_deg,
      payload.tilt_actual_deg,
      payload.tracker_pan_err,
      payload.tracker_tilt_err,
      payload.lrf_range,
      payload.drive_connected
    ]);

  const card = (label, value, stateClass = "") => `
    <div class="imuInstrument cameraMetric ${stateClass}">
      <div class="imuLabel">${esc(label)}</div>
      <div class="imuValue">${esc(value ?? "--")}</div>
    </div>
  `;

  const tracking =
    isControlOn(payload.tracking ?? payload.tracker_enabled ?? 0);

  const driveConnected =
    isControlOn(payload.drive_connected ?? payload.connected ?? 0);

  const cameraPan = telemetryNumber(payload, ["pan_actual_deg", "pan_deg", "pan"]);
  const cameraTilt = telemetryNumber(payload, ["tilt_actual_deg", "tilt_deg", "tilt"]);

  return `
    <div class="detailHeader">
      <h3>Camera / Tracker Overview</h3>
      <span>${esc(timestamp || "--")}</span>
    </div>

    ${realisticPtzCameraHtml(cameraPan, cameraTilt, "CAMERA PTZ")}

    <div class="cameraOverviewGrid">
      ${card("Camera ID", payload.camera_id ?? payload.track_cam_id ?? "--")}
      ${card("Video Source", payload.video_source ?? payload.source ?? "--")}
      ${card("FPS", payload.fps ?? "--")}
      ${card("Tracking", tracking ? "ACTIVE" : "STANDBY", tracking ? "ok" : "warn")}
      ${card("Drive Link", driveConnected ? "ONLINE" : "OFFLINE", driveConnected ? "ok" : "bad")}
      ${card("Mode", payload.track_mode ?? "--")}
      ${card("Type", payload.track_type ?? "--")}
      ${card("Return X", payload.tracker_ret_x ?? payload.ret_x ?? "--")}
      ${card("Return Y", payload.tracker_ret_y ?? payload.ret_y ?? "--")}
      ${card("Box W", payload.tracker_bb_w ?? payload.bb_w ?? "--")}
      ${card("Box H", payload.tracker_bb_h ?? payload.bb_h ?? "--")}
      ${card("Pan", payload.pan_actual_deg ?? payload.pan_deg ?? "--")}
      ${card("Tilt (-90° to 180°)", ptzTiltMeasurementDegrees(cameraTilt).toFixed(1))}
      ${card("Pan Error", payload.tracker_pan_err ?? payload.tracker_pan_error ?? "--")}
      ${card("Tilt Error", payload.tracker_tilt_err ?? payload.tracker_tilt_error ?? "--")}
      ${card("LRF Range", payload.lrf_range ?? payload.range ?? "--")}
    </div>

    ${allTelemetryFieldsHtml(payload)}
  `;
}

/**

 * @brief Rate-limit and render the selected Camera/Tracker overview while preserving panel state.



 */

function renderCameraPanel(
  payload,
  timestamp
) {
  // Rate-limit camera DOM replacement by both elapsed time and a key of fields
  // visible in the overview, while preserving disclosure state across permitted
  // redraws and still allowing a null payload to clear the panel.

  const el =
    selectedDetailFor("CAMERA") ||
    selectedDetailFor("CAMERA_UNIT");

  if (!el) return;

  if (payload) {
    const renderKey =
      JSON.stringify([
        payload.camera_id,
        payload.video_source,
        payload.fps,
        payload.tracking,
        payload.track_mode,
        payload.track_type,
        payload.tracker_ret_x,
        payload.tracker_ret_y,
        payload.tracker_bb_w,
        payload.tracker_bb_h,
        payload.pan_actual_deg,
        payload.tilt_actual_deg,
        payload.tracker_pan_err,
        payload.tracker_tilt_err,
        payload.lrf_range,
        payload.drive_connected
      ]);

    const now = Date.now();

    if (
      el.innerHTML.trim() !== "" &&
      now - lastCameraRenderAt < 500
    ) {
      return;
    }

    if (
      renderKey === lastCameraRenderKey &&
      now - lastCameraRenderAt < 900
    ) {
      return;
    }

    lastCameraRenderKey = renderKey;
    lastCameraRenderAt = now;
  }

  rememberPanelDisclosureState(el);

  el.innerHTML =
    cameraOverviewHtml(
      payload,
      timestamp
    );

  restorePanelDisclosureState(el);

}

/**

 * @brief Apply latest payload.




 * @param options Optional behavior settings.

 */

function applyLatestPayload(
  device,
  payload,
  timestamp,
  renderer,
  options = {}
) {
  // Distinguish a real object/primitive payload from null, an empty object, or
  // an empty collection returned by a latest-channel API with no data.
  const hasPayload =
    payload != null &&
    typeof payload === "object" &&
    !Array.isArray(payload)
      ? Object.keys(payload).length > 0
      : Boolean(payload);

  // A payload is safe to display only when it came directly from the live path,
  // has a recent WebSocket heartbeat, or the caller explicitly permits a fresh
  // database timestamp as evidence that the device is still current.
  const hasFreshHeartbeat =
    Number.isFinite(deviceHeartbeat[device]) &&
    Date.now() - deviceHeartbeat[device] <= LIVE_STALE_MS;
  const hasFreshTimestamp =
    Boolean(timestamp) &&
    Number.isFinite(parseTs(timestamp)) &&
    Date.now() - parseTs(timestamp) <= LIVE_STALE_MS;
  const canRenderPayload =
    options.live === true ||
    hasFreshHeartbeat ||
    (options.allowFreshTimestamp === true && hasFreshTimestamp);

  // Clear the device view when data is absent or too old; this prevents latest
  // database rows from making an offline unit appear live indefinitely.
  if (!hasPayload || !canRenderPayload) {
    delete liveDeviceState[device];
    delete deviceRecentSignals[device];

    // Reset the recent-signal mount and ask the specialized renderer to show its offline state.
    const signalsEl =
      document.getElementById(
        "signals_" + safeId(device)
      );

    if (signalsEl) {
      signalsEl.innerHTML =
        '<div class="deviceSignalEmpty">Waiting for data</div>';
    }

    if (typeof renderer === "function") {
      renderer(null, timestamp || "");
    }

    // Ensure metrics exist even for a device first discovered through an empty
    // latest response, then force its health and availability to offline.
    if (!deviceMetrics[device]) {
      deviceMetrics[device] = {
        packets: 0,
        lastPacket: Date.now(),
        lastRateCalc: Date.now(),
        rate: 0,
        packetCount: 0,
        packetRate: 0,
        online: false,
        lastSeen: "-",
        health: 0
      };
    }

    deviceMetrics[device].online = false;
    deviceMetrics[device].health = 0;

    // Synchronize the device card, selected inspector, KPI totals, and header summary with the cleared state.
    setDeviceStatus(
      device,
      "offline",
      timestamp || "--"
    );

    if (isSelectedDevice(device)) {
      scheduleSelectedInspectorRender(device);
    }

    updateKpis();
    renderStatusSummary(
      Object.values(deviceStatuses)
    );
    return;
  }

  // Recursively merge partial payloads into retained state so nested sections
  // omitted by this packet keep their last valid values.
  liveDeviceState[device] = mergeRetainedTelemetry(
    liveDeviceState[device] || {},
    payload
  );

  // Create baseline live metrics when this is the first usable payload observed for the device.
  if (!deviceMetrics[device]) {
    deviceMetrics[device] = {
      packets: 0,
      lastPacket: Date.now(),
      lastRateCalc: Date.now(),
      rate: 0,
      packetCount: 0,
      packetRate: 0,
      online: true,
      lastSeen: "-",
      health: 100
    };
  }

  // Only the direct WebSocket/live path advances heartbeat time and marks the
  // device online; database fallback reads must not manufacture liveness.
  if (options.live === true) {
    deviceHeartbeat[device] =
      Date.now();

    deviceMetrics[device].online = true;
    deviceMetrics[device].lastPacket = Date.now();

    setDeviceStatus(
      device,
      "online",
      timestamp || new Date().toLocaleTimeString()
    );
  }

  // Render the merged complete device state, then update the selected inspector
  // and aggregate summaries that depend on device availability.
  if (typeof renderer === "function") {
    renderer(liveDeviceState[device], timestamp || "");
  }

  if (isSelectedDevice(device)) {
    scheduleSelectedInspectorRender(device);
  }

  updateKpis();
  renderStatusSummary(
    Object.values(deviceStatuses)
  );
}

/**

 * @brief Decide whether HTTP latest-channel data should substitute for a silent WebSocket trend stream.

 */

function shouldUseLatestForTrend() {
  // Permit database-latest samples to feed trends only while WebSocket delivery
  // is disconnected or has been silent for more than five seconds.
  return (
    !App.wsConnected ||
    Date.now() -
      (App.wsLastMessageAt || 0) >
      5000
  );
}

/**

 * @brief Request one channel's newest payload from the selected daily database with an empty failure fallback.

 * @param channel Normalized channel name.

 * @async

 */

async function fetchLatestChannel(db, channel) {
  // Request the newest payload for one channel in the operator-selected daily database.
  try {
    return await api(
      "/api/hmi/latest?db=" +
      encodeURIComponent(db) +
      "&channel=" +
      encodeURIComponent(channel)
    );
    // Convert one failed channel request into an empty result so the remaining
    // control panels can still refresh independently.
  } catch (err) {
    console.warn(
      "HMI latest channel failed:",
      channel,
      err
    );

    return {
      payload: null,
      timestamp: ""
    };
  }
}

/**

 * @brief Determine whether device heartbeat within ms.


 */

function hasDeviceHeartbeatWithinMs(device, maxAgeMs = LIVE_STALE_MS) {
  // A device never observed in this browser session has no live heartbeat evidence.
  if (!Number.isFinite(deviceHeartbeat[device])) {
    return false;
  }
  // Reject both future timestamps and heartbeats older than the caller's freshness window.
  const age = Date.now() - deviceHeartbeat[device];
  return age >= 0 && age <= maxAgeMs;
}

/**

 * @brief Refresh control panels.

 * @async

 */

async function refreshControlPanels() {
  // Use the current database selector and stop until initialization has chosen a shard.
  const db =
    $("dbSelect")?.value || App.db;

  if (!db) return;
  
  // Record WebSocket health before awaiting HTTP requests so the same consistent
  // fallback decision applies to every channel in this refresh cycle.
  const wsConnected = App.wsConnected;
  const hasRecentWsMessage = Date.now() - (App.wsLastMessageAt || 0) <= 5000;

  // Fetch latest snapshots for every HMI channel concurrently to minimize how
  // long the fallback refresh delays any one device panel.
  const [
    buttonData,
    joystickData,
    advantechData,
    mainDisplayData,
    wcsConsoleData,
    imuData,
    lcuData,
    cceData,
    cameraData,
    driveData,
    externalTrackData
  ] = await Promise.all([
    fetchLatestChannel(db, "button_led"),
    fetchLatestChannel(db, "joystick"),
    fetchLatestChannel(db, "advantec_driver"),
    fetchLatestChannel(db, "maindisplay"),
    fetchLatestChannel(db, "wcs_control_console"),
    fetchLatestChannel(db, "imu"),
    fetchLatestChannel(db, "lcu_transport"),
    fetchLatestChannel(db, "cce_gateway"),
    fetchLatestChannel(db, "tracker_telemetry"),
    fetchLatestChannel(db, "tracker_publish"),
    fetchLatestChannel(db, "external_track")
  ]);

  // Button, joystick, Advantech, display, and WCS latest rows are passed through
  // the common freshness gate and their specialized renderers.
  applyLatestPayload(
    "BUTTON_LED_UNIT",
    buttonData.payload,
    buttonData.timestamp,
    renderButtonLedPanel,
    { allowFreshTimestamp: false }
  );

  applyLatestPayload(
    "JOYSTICK_UNIT",
    joystickData.payload,
    joystickData.timestamp,
    renderJoystickPanel,
    { allowFreshTimestamp: false }
  );

applyLatestPayload(
  "ADVANTECH_IO",
  advantechData.payload,
  advantechData.timestamp,
  renderAdvantechIoPanel,
  { allowFreshTimestamp: false }
);

  applyLatestPayload(
    "MAIN_DISPLAY",
    mainDisplayData.payload,
    mainDisplayData.timestamp,
    renderMainDisplayPanel,
    { allowFreshTimestamp: false }
  );

  applyLatestPayload(
    "WCS_CONSOLE",
    wcsConsoleData.payload,
    wcsConsoleData.timestamp,
    renderWcsConsolePanel,
    { allowFreshTimestamp: false }
  );

  // For high-rate IMU, LCU, CCE, camera, and drive channels, prefer recent live
  // heartbeats while connected; explicitly clear a unit whose live heartbeat expired.
  if (hasDeviceHeartbeatWithinMs("IMU_UNIT") || !wsConnected) {
    applyLatestPayload(
      "IMU_UNIT",
      imuData.payload,
      imuData.timestamp,
      renderImuPanel,
      { allowFreshTimestamp: false }
    );
  } else if (wsConnected && !hasDeviceHeartbeatWithinMs("IMU_UNIT")) {
    clearDeviceLiveView("IMU_UNIT", "");
  }

  if (hasDeviceHeartbeatWithinMs("LCU_UNIT") || !wsConnected) {
    applyLatestPayload(
      "LCU_UNIT",
      lcuData.payload,
      lcuData.timestamp,
      renderLcuPanel,
      { allowFreshTimestamp: false }
    );
  } else if (wsConnected && !hasDeviceHeartbeatWithinMs("LCU_UNIT")) {
    clearDeviceLiveView("LCU_UNIT", "");
  }

  if (hasDeviceHeartbeatWithinMs("CCE_GATEWAY") || !wsConnected) {
    applyLatestPayload(
      "CCE_GATEWAY",
      cceData.payload,
      cceData.timestamp,
      renderCceGatewayPanel,
      { allowFreshTimestamp: false }
    );
  } else if (wsConnected && !hasDeviceHeartbeatWithinMs("CCE_GATEWAY")) {
    clearDeviceLiveView("CCE_GATEWAY", "");
  }

  if (hasDeviceHeartbeatWithinMs("CAMERA_UNIT") || !wsConnected) {
    applyLatestPayload(
      "CAMERA_UNIT",
      cameraData.payload,
      cameraData.timestamp,
      renderCameraPanel,
      { allowFreshTimestamp: false }
    );
  } else if (wsConnected && !hasDeviceHeartbeatWithinMs("CAMERA_UNIT")) {
    clearDeviceLiveView("CAMERA_UNIT", "");
  }

  if (hasDeviceHeartbeatWithinMs("DRIVE_UNIT") || !wsConnected) {
    applyLatestPayload(
      "DRIVE_UNIT",
      driveData.payload,
      driveData.timestamp,
      renderDriveSystemPanel,
      { allowFreshTimestamp: false }
    );
  } else if (wsConnected && !hasDeviceHeartbeatWithinMs("DRIVE_UNIT")) {
    clearDeviceLiveView("DRIVE_UNIT", "");
  }

  // External-track data uses the same latest-payload gate but does not maintain
  // an additional WebSocket-only heartbeat branch here.
  applyLatestPayload(
    "EXTERNAL_TRACK_UNIT",
    externalTrackData.payload,
    externalTrackData.timestamp,
    renderExternalTrackPanel,
    { allowFreshTimestamp: false }
  );

  // Feed HTTP latest samples into trends only when live WebSocket samples are
  // unavailable, preventing duplicate points during normal operation.
  if (shouldUseLatestForTrend()) {
    if (imuData.payload) {
      pushTrendPacket(
        imuData.payload,
        "IMU_UNIT"
      );
    }

    if (driveData.payload) {
      pushTrendPacket(
        driveData.payload,
        "DRIVE_UNIT"
      );
    }
  }
}
/*
==================================================
TACTICAL CYCLOGRAPH
==================================================
*/

/**

 * @brief Initialize analytics.

 */

function initAnalytics() {
// Locate the mission trend canvas and leave analytics disabled on HMI layouts that omit it.
const trendCtx =
$("trendChart");

if (!trendCtx) {
return;
}

// Create one Chart.js line chart whose seven datasets share the retained arrays
// populated by live packets and historical replay. Separate axes keep angles,
// RPM, and current readable despite their different numeric ranges.
trendChart =
new Chart(trendCtx, {
  type: "line",

  data: {

    labels:
      telemetryTrendData.labels,

    datasets: [

      {
        label: "IMU Roll (°)",
        telemetryDevice: "IMU_UNIT",
        telemetryKey: "roll",
        telemetryUnit: "°",
        telemetryTimestamps: telemetryTrendData.timestamps,
        data: telemetryTrendData.imu.roll,
        borderColor: "#00ffb4",
        borderWidth: 2,
        tension: 0.42,
        pointRadius: 0,
        spanGaps: true,
        yAxisID: "imuAxis"
      },

      {
        label: "IMU Pitch (°)",
        telemetryDevice: "IMU_UNIT",
        telemetryKey: "pitch",
        telemetryUnit: "°",
        telemetryTimestamps: telemetryTrendData.timestamps,
        data: telemetryTrendData.imu.pitch,
        borderColor: "#00d0ff",
        borderWidth: 2,
        tension: 0.42,
        pointRadius: 0,
        spanGaps: true,
        yAxisID: "imuAxis"
      },

      {
        label: "IMU Yaw (°)",
        telemetryDevice: "IMU_UNIT",
        telemetryKey: "yaw",
        telemetryUnit: "°",
        telemetryTimestamps: telemetryTrendData.timestamps,
        data: telemetryTrendData.imu.yaw,
        borderColor: "#ffcc00",
        borderWidth: 2,
        tension: 0.42,
        pointRadius: 0,
        spanGaps: true,
        yAxisID: "imuAxis"
      },

      {
        label: "Drive Pan (°)",
        telemetryDevice: "DRIVE_UNIT",
        telemetryKey: "pan",
        telemetryUnit: "°",
        telemetryTimestamps: telemetryTrendData.timestamps,
        data: telemetryTrendData.drive.pan,
        borderColor: "#ff6600",
        borderWidth: 2,
        tension: 0.42,
        pointRadius: 0,
        spanGaps: true,
        yAxisID: "driveAxis"
      },

      {
        label: "Drive Tilt (°)",
        telemetryDevice: "DRIVE_UNIT",
        telemetryKey: "tilt",
        telemetryUnit: "°",
        telemetryTimestamps: telemetryTrendData.timestamps,
        data: telemetryTrendData.drive.tilt,
        borderColor: "#ff3355",
        borderWidth: 2,
        tension: 0.42,
        pointRadius: 0,
        spanGaps: true,
        yAxisID: "driveAxis"
      },
{
  label: "Motor RPM",
  telemetryDevice: "DRIVE_UNIT",
  telemetryKey: "rpm",
  telemetryUnit: "rpm",
  telemetryTimestamps: telemetryTrendData.timestamps,
  data: telemetryTrendData.drive.rpm,
  borderColor: "#aa66ff",
  borderWidth: 2,
  tension: 0.42,
  pointRadius: 0,
  spanGaps: true,
  yAxisID: "rpmAxis"
},

{
  label: "Motor Current (A)",
  telemetryDevice: "DRIVE_UNIT",
  telemetryKey: "current",
  telemetryUnit: "A",
  telemetryTimestamps: telemetryTrendData.timestamps,
  data: telemetryTrendData.drive.current,
  borderColor: "#ffffff",
  borderWidth: 2,
  tension: 0.42,
  pointRadius: 0,
  spanGaps: true,
  yAxisID: "driveAxis"
},

{
  label: telemetryTrendData.generic.labels[0],
  data: telemetryTrendData.generic.a,
  borderColor: "#38bdf8",
  backgroundColor: "#38bdf8",
  borderWidth: 3,
  tension: 0.42,
  pointRadius: 0,
  pointHoverRadius: 0,
  spanGaps: true,
  yAxisID: "driveAxis",
  hidden: true
},

{
  label: telemetryTrendData.generic.labels[1],
  data: telemetryTrendData.generic.b,
  borderColor: "#f97316",
  backgroundColor: "#f97316",
  borderWidth: 3,
  tension: 0.42,
  pointRadius: 0,
  pointHoverRadius: 0,
  spanGaps: true,
  yAxisID: "driveAxis",
  hidden: true
},

{
  label: telemetryTrendData.generic.labels[2],
  data: telemetryTrendData.generic.c,
  borderColor: "#a3e635",
  backgroundColor: "#a3e635",
  borderWidth: 3,
  tension: 0.42,
  pointRadius: 0,
  pointHoverRadius: 0,
  spanGaps: true,
  yAxisID: "driveAxis",
  hidden: true
}
    ]
  },

  options: {

    responsive: true,

    maintainAspectRatio: false,

    animation: false,

    interaction: {
      mode: "index",
      intersect: false
    },

    plugins: {

      legend: {
        position: "bottom",
        labels: {
  color: "#ffffff",
  boxWidth: 22,
  padding: 14,
  usePointStyle: false,

  /*
  Show only required Mission Telemetry Analytics readings.
  Hide old generic/internal datasets from legend.
  */
  filter: function(item) {
    return item.datasetIndex <= 6;
  }
}
      },

      tooltip: {
        enabled: true,
        mode: "index",
        intersect: false,
        callbacks: typeof telemetryTooltipCallbacks === "function"
          ? telemetryTooltipCallbacks()
          : undefined
      }
    },

    scales: {

      x: {
        ticks: {
          color: "#cbd5e1",
          maxRotation: 0,
          autoSkip: true,
          maxTicksLimit: 8
        },

        grid: {
          color: "rgba(255,255,255,0.08)"
        }
      },

      imuAxis: {

        type: "linear",

        position: "left",

        ticks: {
          color: "#00ffb4",
          maxTicksLimit: 7
        },

        title: {
          display: true,
          text: "IMU ANGLES",
          color: "#00ffb4"
        },

        grid: {
          color: "rgba(255,255,255,0.05)"
        }
      },

driveAxis: {

  type: "linear",

  position: "right",

  ticks: {
    color: "#ff6600",
    maxTicksLimit: 7
  },

  title: {
    display: true,
    text: "DRIVE ANGLES",    
    color: "#ff6600"
  },

  grid: {
    drawOnChartArea: false
  }
},

rpmAxis: {

  type: "linear",

  position: "right",

  ticks: {
    color: "#aa66ff",
    maxTicksLimit: 6
  },

  title: {
    display: true,
    text: "RPM",
    color: "#aa66ff"
  },

  grid: {
    drawOnChartArea: false
  }
}
    }
  }
});
}

/**

 * @brief Extract approved mission metrics and append one aligned, bounded trend-chart point.



 */

function pushTrendPacket(row, device) {
  // Trend processing requires both an initialized chart and a telemetry packet.
  if (!trendChart || !row) {
    return;
  }

  // Canonicalize aliases before deciding which mission metrics this packet may supply.
  device =
    canonicalInspectorDevice(device);

  /*
  --------------------------------------------------
  MISSION TELEMETRY ANALYTICS ONLY
  --------------------------------------------------
  This chart must show only:
  1. IMU Roll
  2. IMU Pitch
  3. IMU Yaw
  4. Drive Pan
  5. Drive Tilt
  6. Motor RPM
  7. Motor Current

  Do not show:
  - Bus voltage
  - Button seq
  - Button latency
  - Generic telemetry A/B/C
  - LCU values
  --------------------------------------------------
  */

  // Resolve the first finite value across each metric's live and historical aliases.
  const readNum = keys => {
    const value =
      telemetryNumber(row, keys, NaN);

    return Number.isFinite(value)
      ? value
      : null;
  };

  // Prefer device/packet capture time over server receipt time so the x-axis
  // represents when the measurement was produced whenever that information exists.
  const rawTrendTimestamp =
    row.packet_ts ||
    row.device_ts ||
    row.server_rx_ts ||
    row.server_timestamp ||
    row.timestamp ||
    "";

  const trendTimestampMs =
    rawTrendTimestamp
      ? parseTs(rawTrendTimestamp)
      : NaN;

  // Format a 24-hour label from the packet time, falling back to browser time
  // only when the source timestamp cannot be parsed.
  const label =
    Number.isFinite(trendTimestampMs)
      ? new Date(trendTimestampMs).toLocaleTimeString(
          [],
          {
            hour12: false,
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit"
          }
        )
      : new Date().toLocaleTimeString(
          [],
          {
            hour12: false,
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit"
          }
        );

  // Start an aligned point with nulls; only the metrics owned by this physical
  // device are filled, allowing all datasets to share one timestamp index.
  const point = {
    imuRoll: null,
    imuPitch: null,
    imuYaw: null,
    drivePan: null,
    driveTilt: null,
    driveRpm: null,
    driveCurrent: null
  };

  // Extract attitude only from IMU packets and motion/electrical values only
  // from drive packets so unrelated generic fields cannot contaminate the graph.
  if (device === "IMU_UNIT") {
    point.imuRoll =
      readNum([
        "roll",
        "imu_roll",
        "roll_deg",
        "imu_roll_deg",
        "euler_deg.0",
        "angles_deg.0"
      ]);

    point.imuPitch =
      readNum([
        "pitch",
        "imu_pitch",
        "pitch_deg",
        "imu_pitch_deg",
        "euler_deg.1",
        "angles_deg.1"
      ]);

    point.imuYaw =
      readNum([
        "yaw",
        "imu_yaw",
        "yaw_deg",
        "heading",
        "heading_deg",
        "imu_yaw_deg",
        "euler_deg.2",
        "angles_deg.2"
      ]);
  }

  if (
    device === "DRIVE_UNIT" ||
    device === "TRACKER_PUBLISH_UNIT"
  ) {
    point.drivePan =
      readNum([
        "pan",
        "pan_deg",
        "pan_actual",
        "pan_actual_deg",
        "azimuth_deg",
        "angle_feedback"
      ]);

    point.driveTilt =
      readNum([
        "tilt",
        "tilt_deg",
        "tilt_actual",
        "tilt_actual_deg",
        "elevation_deg"
      ]);

    point.driveRpm =
      readNum([
        "rpm",
        "motor_rpm",
        "speed_rpm",
        "actual_rpm"
      ]);

    point.driveCurrent =
      readNum([
        "current",
        "current_a",
        "motor_current",
        "motor_current_a",
        "actual_current"
      ]);
  }

  // Skip packets that supplied none of the seven approved mission metrics.
  const hasAnyValue = [
    point.imuRoll,
    point.imuPitch,
    point.imuYaw,
    point.drivePan,
    point.driveTilt,
    point.driveRpm,
    point.driveCurrent
  ].some(Number.isFinite);

  /*
  Do not add empty timestamps.
  This prevents blank graph points from button/LCU/generic packets.
  */
  if (!hasAnyValue) {
    return;
  }

  // Keep a sliding window of 500 aligned points by removing the oldest label,
  // timestamp, and value from every dataset together.
  if (telemetryTrendData.labels.length >= 500) {
    telemetryTrendData.labels.shift();
    telemetryTrendData.timestamps.shift();

    telemetryTrendData.imu.roll.shift();
    telemetryTrendData.imu.pitch.shift();
    telemetryTrendData.imu.yaw.shift();

    telemetryTrendData.drive.pan.shift();
    telemetryTrendData.drive.tilt.shift();
    telemetryTrendData.drive.rpm.shift();
    telemetryTrendData.drive.current.shift();
  }

  // Append the new timestamp and its aligned IMU/drive values, retaining nulls
  // for metrics not supplied by this device packet.
  telemetryTrendData.labels.push(label);
  telemetryTrendData.timestamps.push(rawTrendTimestamp || new Date().toISOString());

  telemetryTrendData.imu.roll.push(point.imuRoll);
  telemetryTrendData.imu.pitch.push(point.imuPitch);
  telemetryTrendData.imu.yaw.push(point.imuYaw);

  telemetryTrendData.drive.pan.push(point.drivePan);
  telemetryTrendData.drive.tilt.push(point.driveTilt);
  telemetryTrendData.drive.rpm.push(point.driveRpm);
  telemetryTrendData.drive.current.push(point.driveCurrent);

  // Extend the playback slider to the newest retained point.
  const slider =
    document.getElementById("timelineSlider");

  if (slider) {
    slider.max =
      telemetryTrendData.labels.length - 1;
  }

  /* Playback displays a historical prefix, but live packets continue to be
     retained above so returning to LIVE never loses the incoming stream. */
  if (playbackMode) {
    return;
  }

  // Outside playback mode, reconnect each Chart.js dataset to its live backing
  // array and schedule a throttled redraw once at least two points exist.
  trendChart.data.labels =
    telemetryTrendData.labels;

  if (trendChart.data.datasets[0]) {
    trendChart.data.datasets[0].data =
      telemetryTrendData.imu.roll;
  }

  if (trendChart.data.datasets[1]) {
    trendChart.data.datasets[1].data =
      telemetryTrendData.imu.pitch;
  }

  if (trendChart.data.datasets[2]) {
    trendChart.data.datasets[2].data =
      telemetryTrendData.imu.yaw;
  }

  if (trendChart.data.datasets[3]) {
    trendChart.data.datasets[3].data =
      telemetryTrendData.drive.pan;
  }

  if (trendChart.data.datasets[4]) {
    trendChart.data.datasets[4].data =
      telemetryTrendData.drive.tilt;
  }

  if (trendChart.data.datasets[5]) {
    trendChart.data.datasets[5].data =
      telemetryTrendData.drive.rpm;
  }

  if (trendChart.data.datasets[6]) {
    trendChart.data.datasets[6].data =
      telemetryTrendData.drive.current;
  }

  if (telemetryTrendData.labels.length >= 2) {
    scheduleTrendChartUpdate();
  }
}

/*
==================================================
LIVE FEED
==================================================
*/

/**

 * @brief Read a telemetry row's effective text, general, or numeric value using backend column precedence.


 */

function rowValue(row) {
  // Return no value for an absent row rather than inventing a telemetry reading.
  if (!row) {
    return undefined;
  }

  // Respect explicit text typing before testing general and numeric storage
  // fields, matching the backend telemetry_rows representation.
  if (
    row.value_type === "text" &&
    row.value_text !== undefined
  ) {
    return row.value_text;
  }

  // Fall back through the general, numeric, then text columns used by different API responses.
  if (row.value !== undefined) {
    return row.value;
  }

  if (row.value_num !== undefined) {
    return row.value_num;
  }

  if (row.value_text !== undefined) {
    return row.value_text;
  }

  return undefined;
}

/**

 * @brief Merge telemetry row into device state.



 */

function mergeTelemetryRowIntoDeviceState(
  device,
  row
) {
  // Create retained state on first observation of this physical device.
  if (!liveDeviceState[device]) {
    liveDeviceState[device] = {};
  }

  const state =
    liveDeviceState[device];

  // Copy telemetry fields while excluding routing and timestamp metadata that
  // identifies the row rather than describing device state.
  Object.keys(row).forEach(k => {

    if (
      k === "timestamp" ||
      k === "server_timestamp" ||
      k === "device" ||
      k === "device_name" ||
      k === "channel" ||
      k === "channel_name" ||
      k === "process" ||
      k === "process_name" ||
      k === "subdevice" ||
      k === "subdevice_name" ||
      k === "subprocess" ||
      k === "subprocess_name"
    ) {
      return;
    }

    state[k] = row[k];
  });

  // Flatten a telemetry_rows key/value record into the same state object shape
  // used by complete live packet payloads.
  if (row.key !== undefined) {
    state[row.key] =
      rowValue(row);
  }

  return state;
}

/**

 * @brief Normalize live packet payload.


 */

function normalizeLivePacketPayload(payload) {
  // Decode JSON text when needed and start with only a plain-object payload.
  const source =
    parseLivePayload(payload) || {};
  const normalized = {
    ...(source && typeof source === "object" && !Array.isArray(source)
      ? source
      : {})
  };

  // Promote fields from an LCU/body wrapper and also add underscore-flattened
  // aliases so renderers can consume nested and database-style packets uniformly.
  if (
    normalized.body &&
    typeof normalized.body === "object" &&
    !Array.isArray(normalized.body)
  ) {
    Object.assign(normalized, normalized.body);

    flattenTelemetryFields(normalized.body, "body")
      .forEach(([key, value]) => {
        const flatKey =
          String(key).replace(/\./g, "_");

        if (normalized[flatKey] === undefined) {
          normalized[flatKey] = value;
        }
      });
  }

  // Convert a single name/value event into a directly addressable state field.
  if (
    normalized.name !== undefined &&
    normalized.value !== undefined
  ) {
    normalized[normalized.name] =
      normalized.value;
  }

  return normalized;
}

/**

 * @brief Merge retained telemetry.

 * @param target Target object or collection.

 */

function mergeRetainedTelemetry(target, update) {
  // Reuse a valid retained object; otherwise begin with an empty state container.
  const output =
    target && typeof target === "object" && !Array.isArray(target)
      ? target
      : {};

  // Ignore invalid updates without erasing the target's previously known fields.
  if (!update || typeof update !== "object" || Array.isArray(update)) {
    return output;
  }

  // Merge nested objects recursively while replacing scalar and array values;
  // undefined means “not supplied” and therefore leaves retained state unchanged.
  Object.entries(update).forEach(([key, value]) => {
    if (value === undefined) {
      return;
    }

    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      output[key] = mergeRetainedTelemetry(
        output[key] && typeof output[key] === "object" && !Array.isArray(output[key])
          ? output[key]
          : {},
        value
      );
      return;
    }

    output[key] = value;
  });

  return output;
}

/**

 * @brief Detect backend restarts or backward packet time and reset cross-session graph state.



 */

function detectLiveSessionBoundary(data, row) {
  // Read the backend session marker and best available packet/server timestamp
  // from the WebSocket envelope and its normalized row.
  const sessionId =
    data?.session_id ||
    data?.session ||
    row?.session_id ||
    "";
  const ts =
    row?.server_timestamp ||
    row?.timestamp ||
    data?.server_rx_ts ||
    data?.timestamp ||
    "";
  const tsMs =
    ts ? parseTs(ts) : NaN;
  // Detect either an explicit backend session change or a timestamp jump more
  // than two seconds backward, both of which indicate a new live sequence.
  const sessionChanged =
    sessionId &&
    lastLiveSessionId &&
    sessionId !== lastLiveSessionId;
  const timeWentBack =
    Number.isFinite(tsMs) &&
    Number.isFinite(lastLiveTimestampMs) &&
    lastLiveTimestampMs > 0 &&
    tsMs + 2000 < lastLiveTimestampMs;

  // Clear graph and replay caches before mixing values from different backend sessions.
  if (sessionChanged || timeWentBack) {
    resetLiveGraphState();
  }

  // Retain the newest markers for comparison with the following live event.
  if (sessionId) {
    lastLiveSessionId = sessionId;
  }

  if (Number.isFinite(tsMs)) {
    lastLiveTimestampMs = tsMs;
  }
}

/**

 * @brief Convert a packet WebSocket envelope into normalized row metadata for downstream processing.



 */

function packetRowForEvent(data, payload) {
  // Convert a packet-level WebSocket event into the row-shaped metadata used by
  // history, anomaly, device-identification, and trend processing. Device times
  // take precedence over server times; envelope routing fields precede payload fallbacks.
  return {
    session_id:
      data.session_id ||
      data.session ||
      payload.session_id ||
      payload.session ||
      "",
    timestamp:
      data.device_ts ||
      data.packet_ts ||
      payload.device_ts ||
      payload.device_tc ||
      payload.packet_ts ||
      data.timestamp ||
      data.server_rx_ts ||
      new Date().toISOString(),
    server_timestamp:
      data.server_rx_ts ||
      data.timestamp ||
      "",
    device_ts:
      data.device_ts ||
      payload.device_ts ||
      payload.device_tc ||
      "",
    packet_ts:
      data.packet_ts ||
      payload.packet_ts ||
      "",
    latency_ms:
      data.latency_ms ??
      payload.latency_ms ??
      "",
    channel_name:
      data.channel ||
      data.channel_name ||
      payload.channel ||
      payload.channel_name ||
      "",
    device_name:
      data.device ||
      data.device_name ||
      payload.device ||
      payload.device_name ||
      "",
    process_name:
      data.process ||
      data.process_name ||
      payload.process ||
      payload.process_name ||
      "",
    subprocess_name:
      data.subprocess ||
      data.subprocess_name ||
      payload.subprocess ||
      payload.subprocess_name ||
      "",
    key:
      payload.name ||
      payload.id ||
      "packet",
    value:
      payload.value !== undefined
        ? payload.value
        : data.packet_ts || data.timestamp || "",
    anomaly:
      data.anomaly ? 1 : 0
  };
}

/**

 * @brief Ensure alert container.

 */

function ensureAlertContainer() {
  // Reuse the existing popup stack, or create one lazily on the document body
  // the first time a control transition needs immediate operator feedback.
  let el =
    document.getElementById("hmiAlertStack");

  if (!el) {
    el =
      document.createElement("div");
    el.id =
      "hmiAlertStack";
    el.className =
      "hmiAlertStack";
    document.body.appendChild(el);
  }

  return el;
}

/**

 * @brief Show a bounded, automatically fading popup for an immediate control-state change.


 */

function showStatePopup(device, key, value) {
  // Create an escaped two-line popup naming the physical device and changed control.
  const stack =
    ensureAlertContainer();
  const row =
    document.createElement("div");

  row.className =
    "hmiStatePopup";
  row.innerHTML =
    `<strong>${esc(displayName(device))}</strong>` +
    `<span>${esc(displayName(key))} = ${esc(formatControlValue(value))}</span>`;

  // Place the newest transition first, fade it after 3.5 seconds, and remove it
  // after the CSS transition completes.
  stack.prepend(row);

  setTimeout(() => {
    row.classList.add("hide");
    setTimeout(() => row.remove(), 350);
  }, 3500);

  // Keep at most five simultaneous popups so rapid control activity cannot cover the HMI.
  while (stack.children.length > 5) {
    stack.removeChild(stack.lastChild);
  }
}

/**

 * @brief Compare incoming binary controls with popup state and raise new operator notifications.




 */

function notifyImmediateControlPopups(device, payload, timestamp) {
  // Collect single-field and grouped binary control readings into one normalized list.
  const entries = [];

  if (!payload || typeof payload !== "object") {
    return;
  }

  if (
    payload.name !== undefined &&
    payload.value !== undefined
  ) {
    entries.push([
      normalizeHistoryTelemetryKey(payload.name),
      payload.value
    ]);
  }

  ["buttons", "switches", "leds"].forEach(group => {
    const block = payload[group];

    if (!block || typeof block !== "object") {
      return;
    }

    Object.entries(block).forEach(([key, entry]) => {
      entries.push([
        normalizeHistoryTelemetryKey(key),
        readControlValue(entry)
      ]);
    });
  });

  // Compare each control's normalized state with the last popup state. Initial
  // inactive readings establish a baseline silently; subsequent changes create
  // a popup and bounded alarm-center entry.
  entries.forEach(([key, value]) => {
    const state =
      controlStateKey(
        value,
        String(key).toLowerCase().includes("led")
          ? "led"
          : "switch"
      );
    const popupKey =
      [
        canonicalInspectorDevice(device),
        key
      ].join("::");

    if (immediatePopupState[popupKey] === state) {
      return;
    }

    if (
      immediatePopupState[popupKey] === undefined &&
      !isControlOn(value)
    ) {
      immediatePopupState[popupKey] = state;
      return;
    }

    immediatePopupState[popupKey] = state;
    showStatePopup(device, key, value);
    activeAlarms.unshift({
      device,
      message:
        `${displayName(key)} changed to ${formatControlValue(value)}`,
      time:
        timestamp ||
        new Date().toLocaleTimeString()
    });

    if (activeAlarms.length > 10) {
      activeAlarms.length = 10;
    }
  });

  // Batch the alarm/KPI redraw after all transitions in this packet are recorded.
  scheduleHmiUiRefresh();
}

/**

 * @brief Record live state changes.




 */

function recordLiveStateChanges(device, payload, timestamp) {
  // Extract single-field controls and all supported grouped control sections for change tracking.
  const entries = [];

  if (
    payload.name !== undefined &&
    payload.value !== undefined
  ) {
    entries.push([
      normalizeHistoryTelemetryKey(payload.name),
      payload.value
    ]);
  }

  ["buttons", "switches", "leds", "knobs"].forEach(group => {
    const block = payload[group];

    if (!block || typeof block !== "object") {
      return;
    }

    Object.entries(block).forEach(([key, entry]) => {
      entries.push([
        normalizeHistoryTelemetryKey(key),
        readControlValue(entry)
      ]);
    });
  });

  // Update each control's metadata and packet history, then create usage, audit,
  // popup, and alarm records only when a previously known state actually changed.
  entries.forEach(([key, value]) => {
    const canonical =
      canonicalInspectorDevice(device);
    const metaKey =
      controlKey(device, "Live", key);
    const previousState =
      controlMeta[metaKey]?.stateKey;
    const nextState =
      controlStateKey(
        value,
        String(key).toLowerCase().includes("led")
          ? "led"
          : "switch"
      );
    updateControlMeta(
      device,
      "Live",
      key,
      value,
      String(key).toLowerCase().includes("led")
        ? "led"
        : "switch",
      timestamp
    );

    if (
      canonical !== "BUTTON_LED_UNIT" ||
      shouldSurfaceButtonLedValue(value)
    ) {
      appendDevicePacketHistory(
        canonical,
        key,
        nextState,
        timestamp
      );
    }

    if (
      previousState !== undefined &&
      previousState !== nextState
    ) {
      if (!deviceAuditHistory[canonical]) {
        deviceAuditHistory[canonical] = [];
      }

      if (!deviceUsageStats[canonical]) {
        deviceUsageStats[canonical] = {
          toggleCount: 0,
          lastState: null,
          lastOnTime: null,
          lastOffTime: null,
          totalOnMs: 0,
          stateStartTime: Date.now()
        };
      }

      const usage =
        deviceUsageStats[canonical];
      const now =
        Date.now();

      usage.toggleCount++;

      if (nextState === "ON") {
        usage.lastOnTime =
          timestamp || new Date(now).toLocaleTimeString();
        usage.stateStartTime =
          now;
      } else {
        usage.lastOffTime =
          timestamp || new Date(now).toLocaleTimeString();

        if (previousState === "ON" && usage.stateStartTime) {
          usage.totalOnMs +=
            now - usage.stateStartTime;
        }
      }

      deviceAuditHistory[canonical].unshift({
        time:
          timestamp ||
          new Date(now).toLocaleTimeString(),
        key,
        value: nextState
      });

      if (deviceAuditHistory[canonical].length > 500) {
        deviceAuditHistory[canonical].length = 500;
      }

      {
        const popupKey =
          [
            canonical,
            key
          ].join("::");

        if (immediatePopupState[popupKey] !== nextState) {
          immediatePopupState[popupKey] = nextState;
          showStatePopup(device, key, value);
          activeAlarms.unshift({
            device,
            message:
              `${displayName(key)} changed to ${formatControlValue(value)}`,
            time:
              new Date().toLocaleTimeString()
          });

          if (activeAlarms.length > 10) {
            activeAlarms.length = 10;
          }
        }
      }
    }
  });
}

/**

 * @brief Merge persisted device state.


 * @param rows Telemetry rows to process.

 */

function mergePersistedDeviceState(device, rows) {
  // Canonicalize the requested device and share its audit/usage objects with the
  // supplied alias so live and historical records accumulate in one timeline.
  const canonical =
    canonicalInspectorDevice(device);

  if (!deviceAuditHistory[canonical]) {
    deviceAuditHistory[canonical] = [];
  }

  deviceAuditHistory[device] =
    deviceAuditHistory[canonical];

  if (!deviceUsageStats[canonical]) {
    deviceUsageStats[canonical] = {
      toggleCount: 0,
      lastState: null,
      lastOnTime: null,
      lastOffTime: null,
      totalOnMs: 0,
      stateStartTime: Date.now()
    };
  }

  deviceUsageStats[device] =
    deviceUsageStats[canonical];

  const usage =
    deviceUsageStats[canonical];
  // Treat persisted control state as current only when its heartbeat or last-use
  // time is within the same 15-second availability window used by live devices.
  const isFreshStateRow = row => {
    const heartbeatTs =
      parseTs(row.heartbeat || row.last_used || row.timestamp || "");

    return Number.isFinite(heartbeatTs) &&
      Math.abs(Date.now() - heartbeatTs) <= 15000;
  };

  // Convert each stored state/log row into usage totals, current control metadata,
  // Button/LED retained state, and an audit entry. Identifier and heartbeat rows
  // are metadata and therefore excluded from the operator control history.
  (Array.isArray(rows) ? rows : []).forEach(row => {
    const button =
      row.button || row.control || "";

    if (
      String(button).endsWith("_id") ||
      String(button).endsWith(".id") ||
      String(button) === "heartbeat"
    ) {
      return;
    }

    const state =
      Number(row.state ?? row.new ?? 0);
    const stateText =
      state ? "ON" : "OFF";
    const lastUsed =
      row.last_used ||
      row.timestamp ||
      row.heartbeat ||
      "";
    const lastOn =
      row.last_on || "";
    const lastOff =
      row.last_off || "";
    const fresh =
      isFreshStateRow(row);

    usage.toggleCount +=
      Number(row.toggle_count || row.toggles || 0);
    usage.totalOnMs +=
      Number(row.total_on_ms || row.duration || 0);

    if (fresh && lastOn && (!usage.lastOnTime || lastOn > usage.lastOnTime)) {
      usage.lastOnTime = lastOn;
    }

    if (fresh && lastOff && (!usage.lastOffTime || lastOff > usage.lastOffTime)) {
      usage.lastOffTime = lastOff;
    }

    if (button) {
      if (fresh && canonical === "BUTTON_LED_UNIT") {
        applyButtonLedPersistedState(button, state);
      }

      const key =
        controlKey(canonical, "Persisted", button);

      if (fresh) {
        controlMeta[key] = {
          ...(controlMeta[key] || {}),
          device: canonical,
          group: "Persisted",
          name: button,
          kind: String(button).toLowerCase().includes("led")
            ? "led"
            : "switch",
          firstSeen: parseTs(lastUsed),
          lastSeen: parseTs(row.heartbeat || lastUsed),
          lastChanged: parseTs(lastUsed),
          lastValue: state,
          stateKey: stateText,
          toggleCount: Number(row.toggle_count || row.toggles || 0),
          activeSince: state ? parseTs(lastUsed) : null,
          totalActiveMs: Number(row.total_on_ms || row.duration || 0),
          operatorTouches: 0,
          lastOperatorAt: null,
          history: []
        };
      }

      deviceAuditHistory[canonical].push({
        time: lastUsed || "--",
        key: button,
        value: stateText
      });
    }
  });

  // Present persisted audit events newest-first and bound the retained browser history.
  deviceAuditHistory[canonical].sort((a, b) =>
    parseTs(b.time) - parseTs(a.time)
  );

  if (deviceAuditHistory[canonical].length > 500) {
    deviceAuditHistory[canonical].length = 500;
  }
}

/**

 * @brief Load persisted hmi device data.


 * @param force When true, bypass cached or throttled loading behavior.

 * @async

 */

async function loadPersistedHmiDeviceData(device, force = false) {
  // Build a database/device cache key so routine status refreshes load each
  // device's persisted state only once unless the caller explicitly forces it.
  const db =
    $("dbSelect")?.value || App.db;
  const canonical =
    canonicalInspectorDevice(device);
  const loadKey =
    db + "::" + canonical;

  if (!db || !canonical) return;
  if (!force && persistedHmiLoads.has(loadKey)) return;

  persistedHmiLoads.add(loadKey);

  // Fetch current state aggregates, HMI transition logs, and five minutes of
  // telemetry concurrently, then merge them into packet and audit histories.
  try {
    const [states, logs, recentRows] =
      await Promise.all([
        api(
          "/api/device/state?db=" +
          encodeURIComponent(db) +
          "&device=" +
          encodeURIComponent(canonical)
        ),
        api(
          "/api/hmi/logs?db=" +
          encodeURIComponent(db) +
          "&device=" +
          encodeURIComponent(canonical)
        ),
        api(
          "/api/all?db=" +
          encodeURIComponent(db) +
          "&range=5m&device=" +
          encodeURIComponent(canonical)
        )
      ]);

    mergeRecentTelemetryHistory(canonical, recentRows);
    mergePersistedDeviceState(canonical, states);
    mergePersistedDeviceState(
      canonical,
      (Array.isArray(logs) ? logs : []).map(row => ({
        button: row.control,
        state: row.new,
        timestamp: row.timestamp,
        toggle_count: row.toggles,
        duration: row.duration
      }))
    );

    // Rerender immediately when the loaded device is the one the operator is inspecting.
    if (sameInspectorDevice(selectedDevice, canonical)) {
      renderDeviceInspector();
    }
    // Remove the cache marker after failure so a later refresh can retry the APIs.
  } catch (err) {
    persistedHmiLoads.delete(loadKey);
    console.warn(
      "HMI persisted history load failed:",
      canonical,
      err
    );
  }
}

/**

 * @brief Load persisted hmi devices.

 */

function loadPersistedHmiDevices() {
  // Load history only for devices currently considered online, avoiding needless
  // API work for every configured but inactive unit.
  Object.keys(deviceMetrics)
    .filter(device => deviceMetrics[device]?.online)
    .forEach(device =>
      loadPersistedHmiDeviceData(device)
    );
}

/**

 * @brief Decide whether a telemetry row contains an operator-relevant history field.


 */

function shouldShowTelemetryHistoryRow(row) {
  // Resolve either backend key column spelling and delegate the metadata filter
  // to the same key policy used for live packet expansion.
  const key =
    String(row?.key || row?.value_key || "");

  return shouldShowTelemetryHistoryKey(key);
}

/**

 * @brief Exclude routing, identity, timestamp, and heartbeat metadata from device history.

 */

function shouldShowTelemetryHistoryKey(key) {
  // Keep track_id because it is operational data, but remove database identifiers,
  // routing metadata, timestamps, heartbeats, and generic envelope fields that
  // would crowd the device telemetry history without describing device behavior.
  const lowerKey =
    String(key || "").toLowerCase();

  if (!key) return false;
  if (lowerKey === "track_id") return true;
  if (lowerKey.endsWith("_id") || lowerKey.endsWith(".id")) return false;
  if (
    [
      "seq",
      "id",
      "source",
      "direction",
      "value",
      "heartbeat"
    ].includes(lowerKey)
  ) return false;
  if (
    [
      "type",
      "channel",
      "device",
      "name",
      "timestamp",
      "packet_ts",
      "device_ts",
      "server_rx_ts",
      "process",
      "process_name",
      "subdevice",
      "subprocess"
    ].includes(lowerKey)
  ) return false;

  return true;
}

/**

 * @brief Expand a live packet into filtered, normalized entries in per-device history.


 */

function appendLiveTelemetryHistory(data) {
  // Normalize the packet, derive its row metadata and physical device, and choose
  // the best event timestamp before expanding fields into history entries.
  const payload =
    normalizeLivePacketPayload(data?.payload);
  const row =
    packetRowForEvent(data, payload);
  const device =
    physicalDeviceForRow(row);
  const timestamp =
    row.timestamp ||
    data?.timestamp ||
    new Date().toLocaleTimeString();
  const entries = [];

  if (!payload || typeof payload !== "object") {
    return;
  }

  // Collect single name/value events, grouped controls, and top-level scalar
  // payload fields; nested objects are handled through their explicit groups.
  if (
    payload.name !== undefined &&
    payload.value !== undefined
  ) {
    entries.push([payload.name, payload.value]);
  }

  ["buttons", "switches", "leds", "knobs"].forEach(group => {
    const block = payload[group];

    if (!block || typeof block !== "object") {
      return;
    }

    Object.entries(block).forEach(([key, entry]) => {
      entries.push([key, readControlValue(entry)]);
    });
  });

  Object.entries(payload).forEach(([key, value]) => {
    if (
      value &&
      typeof value === "object"
    ) {
      return;
    }

    entries.push([key, value]);
  });

  // Normalize each field name, apply metadata and Button/LED visibility filters,
  // then append it to the bounded per-device history used by the inspector.
  entries.forEach(([key, value]) => {
    const historyKey =
      normalizeHistoryTelemetryKey(key);
    const canonical =
      canonicalInspectorDevice(device);

    if (!shouldShowTelemetryHistoryKey(historyKey)) {
      return;
    }

    if (
      canonical === "BUTTON_LED_UNIT" &&
      !shouldSurfaceButtonLedHistoryValue(
        historyKey,
        value
      )
    ) {
      return;
    }

    appendDevicePacketHistory(
      device,
      historyKey,
      value,
      timestamp
    );
  });

  scheduleSelectedInspectorRender(device);
}

/**

 * @brief Normalize history telemetry key.

 */

function normalizeHistoryTelemetryKey(key) {
  // Remove control-group prefixes and trailing value wrappers so live nested
  // controls and flattened database columns share the same visible field name.
  return String(key || "")
    .replace(/^(buttons|switches|leds|knobs)[_.]/i, "")
    .replace(/_value$/i, "");
}

/**

 * @brief Recognize MODE and FREQUENCY fields as Button/LED knob telemetry.

 */

function buttonLedKnobName(key) {
  // Only MODE and FREQUENCY are physical knob positions; return their canonical
  // uppercase name and reject every other Button/LED history field.
  const normalized =
    normalizeHistoryTelemetryKey(key).toUpperCase();

  if (normalized === "MODE") return "MODE";
  if (normalized === "FREQUENCY") return "FREQUENCY";
  return "";
}

/**

 * @brief Apply button led knob telemetry.

 */

function applyButtonLedKnobTelemetry(key, value) {
  // Resolve and validate a persisted knob field before changing retained panel state.
  const knobName =
    buttonLedKnobName(key);

  if (!knobName) return false;

  const resolved =
    readControlValue(value);

  if (
    resolved === undefined ||
    resolved === null ||
    resolved === "" ||
    resolved === "--"
  ) {
    return false;
  }

  // Preserve numeric positions as numbers for angle calculation, while retaining
  // a nonnumeric device label if firmware publishes one.
  const numericValue =
    Number(resolved);

  controlState.button_led.knobs[knobName] =
    Number.isFinite(numericValue)
      ? numericValue
      : resolved;

  return true;
}

/**

 * @brief Keep knob positions and active binary values in Button/LED history.

 */

function shouldSurfaceButtonLedHistoryValue(key, value) {
  // Always retain the two knob positions, but include binary Button/LED history
  // only while its value is active to keep the inspector focused on asserted signals.
  return Boolean(buttonLedKnobName(key)) ||
    shouldSurfaceButtonLedValue(value);
}

/**

 * @brief Add one deduplicated field reading to a bounded canonical-device history.



 */

function appendDevicePacketHistory(device, key, value, timestamp) {
  // Normalize both identity and field name; incomplete records cannot form a
  // useful per-device history entry.
  const canonical =
    canonicalInspectorDevice(device);
  const historyKey =
    normalizeHistoryTelemetryKey(key);

  if (!canonical || !historyKey) return;

  // Keep Button/LED knob state synchronized when those fields arrive through history.
  if (canonical === "BUTTON_LED_UNIT") {
    applyButtonLedKnobTelemetry(historyKey, value);
  }

  if (!devicePacketHistory[canonical]) {
    devicePacketHistory[canonical] = [];
  }

  // Construct a newest-first entry and suppress an exact repeat of the current
  // head row, which can arrive from both packet and flattened-field paths.
  const row = {
    time:
      timestamp ||
      new Date().toLocaleTimeString(),
    key:
      historyKey,
    value:
      value ?? ""
  };
  const duplicate =
    devicePacketHistory[canonical][0] &&
    devicePacketHistory[canonical][0].time === row.time &&
    devicePacketHistory[canonical][0].key === row.key &&
    devicePacketHistory[canonical][0].value === row.value;

  if (!duplicate) {
    devicePacketHistory[canonical].unshift(row);
  }

  // Limit each device to 300 recent fields and expose the canonical list through
  // the original alias for callers that have not yet normalized identity.
  if (devicePacketHistory[canonical].length > 300) {
    devicePacketHistory[canonical].length = 300;
  }

  devicePacketHistory[device] =
    devicePacketHistory[canonical];
}

/**

 * @brief Merge recent telemetry history.


 * @param rows Telemetry rows to process.

 */

function mergeRecentTelemetryHistory(device, rows) {
  // Combine recently queried rows with live packet history, normalize field
  // names and timestamps, filter metadata/inactive Button-LED values, remove
  // duplicates, sort newest-first, and retain the newest 300 entries.
  const canonical =
    canonicalInspectorDevice(device);
  const existing =
    devicePacketHistory[canonical] ||
    devicePacketHistory[device] ||
    [];
  const sourceRows =
    Array.isArray(rows) ? rows : [];

  if (canonical === "BUTTON_LED_UNIT") {
    const appliedKnobs = new Set();

    sourceRows
      .slice()
      .sort((a, b) =>
        parseTs(b.timestamp || b.server_timestamp || "") -
        parseTs(a.timestamp || a.server_timestamp || "")
      )
      .forEach(row => {
        const key =
          row.key || row.value_key || "";
        const knobName =
          buttonLedKnobName(key);

        if (!knobName || appliedKnobs.has(knobName)) return;

        if (applyButtonLedKnobTelemetry(key, rowValue(row))) {
          appliedKnobs.add(knobName);
        }
      });
  }

  const recent =
    sourceRows
      .filter(shouldShowTelemetryHistoryRow)
      .filter(row =>
        canonical !== "BUTTON_LED_UNIT" ||
        shouldSurfaceButtonLedHistoryValue(
          row.key || row.value_key || "",
          rowValue(row)
        )
      )
      .map(row => ({
        time:
          row.timestamp ||
          row.server_timestamp ||
          "",
        key:
          normalizeHistoryTelemetryKey(
            row.key ||
            row.value_key ||
            "packet"
          ),
        value:
          rowValue(row) ?? ""
      }))
      .filter(row => row.time && row.key)
      .sort((a, b) =>
        parseTs(b.time) - parseTs(a.time)
      )
      .slice(0, 300);

  const merged = [];
  const seen = new Set();

  existing.concat(recent).forEach(row => {
    const key =
      [row.time, row.key, row.value].join("::");

    if (seen.has(key)) return;

    seen.add(key);
    merged.push(row);
  });

  merged.sort((a, b) =>
    parseTs(b.time) - parseTs(a.time)
  );

  devicePacketHistory[canonical] = merged.slice(0, 300);
  devicePacketHistory[device] =
    devicePacketHistory[canonical];
}

/**

 * @brief Return the operator-facing process label for the current inspector filter.

 */

function selectedProcessLabel() {
  // Show the active process filter, or an inclusive label when the operator has
  // not restricted the inspector to one process.
  return selectedProcess || "All processes";
}

/**

 * @brief Build the selected process graph container and loading metadata.


 */

function processGraphHtml(device) {
  // Build the graph-tab mount and metadata text for the selected physical device
  // and process; loadInspectorGraph later replaces the loading area with charts.
  return `
    <div class="inspectorGraphPanel">
      <div class="graphHeader">
        <div>
          <h3>${esc(displayName(device))} Multivariate Graphs</h3>
          <span>${esc(selectedProcessLabel())}</span>
        </div>
        <button type="button" onclick="loadInspectorGraph(true)">Refresh</button>
      </div>
      <div id="inspectorGraphGrid" class="inspectorGraphGrid"></div>
      <div id="inspectorGraphMeta" class="inspectorGraphMeta">Loading visualization...</div>
    </div>
  `;
}

/**

 * @brief Destroy every inspector Chart.js instance before its canvas is replaced.

 */

function destroyInspectorChart() {
  // Destroy the legacy single chart and every per-metric inspector chart before
  // their canvases are removed, then empty the shared chart registry.
  if (inspectorChart) {
    inspectorChart.destroy();
    inspectorChart = null;
  }

  while (inspectorCharts.length) {
    const chart =
      inspectorCharts.pop();

    if (chart && typeof chart.destroy === "function") {
      chart.destroy();
    }
  }
}

/**

 * @brief Update inspector graphs from live.


 */

function updateInspectorGraphsFromLive(device) {
  // For the selected graph tab, flatten retained live state, locate each chart's
  // configured metric, append its newest finite value and timestamp, cap the
  // line window, update the latest-value label, and redraw without animation.
  if (
    inspectorTab !== "graph" ||
    !isSelectedDevice(device) ||
    !inspectorCharts.length
  ) {
    return;
  }

  const canonical = canonicalInspectorDevice(device);
  const state =
    liveDeviceState[canonical] ||
    liveDeviceState[device];

  if (!state) return;

  const values = new Map();
  flattenTelemetryFields(state).forEach(([key, value]) => {
    values.set(String(key), value);
    values.set(String(key).replace(/\./g, "_"), value);
  });

  const label = new Date().toLocaleTimeString();

  inspectorCharts.forEach(chart => {
    const key = chart.$telemetryKey;
    const value = Number(values.get(key));

    if (!key || !Number.isFinite(value)) return;

    const labels = chart.data.labels || (chart.data.labels = []);
    const points = chart.data.datasets?.[0]?.data;

    if (!points) return;

    labels.push(label);
    points.push(value);

    if (labels.length > 240) labels.shift();
    if (points.length > 240) points.shift();

    const latest = chart.canvas
      ?.closest(".inspectorGraphTile")
      ?.querySelector(".inspectorGraphTileHeader span");

    if (latest) latest.textContent = formatControlValue(value);
    chart.update("none");
  });
}

/**

 * @brief Convert retained live payload fields into row-shaped graph samples.


 */

function graphRowsFromLiveState(device) {
  // Flatten the selected device's retained payload into synthetic timestamped
  // numeric rows so graphing still works when compact database history omits fields.
  const canonical = canonicalInspectorDevice(device);
  const state =
    liveDeviceState[canonical] ||
    liveDeviceState[device];

  if (!state) return [];

  const now = new Date().toISOString();
  const previous = new Date(Date.now() - 250).toISOString();
  const rows = [];

  flattenTelemetryFields(state).forEach(([key, rawValue]) => {
    const value = Number(rawValue);

    if (!Number.isFinite(value) || !shouldShowTelemetryHistoryKey(key)) {
      return;
    }

    rows.push(
      { key, value, value_type: "num", timestamp: previous },
      { key, value, value_type: "num", timestamp: now }
    );
  });

  return rows;
}

/**

 * @brief Rank numeric telemetry series and choose the most useful inspector graphs.

 * @param rows Telemetry rows to process.

 */

function pickGraphMetrics(rows) {
  // Group numeric history rows by telemetry key, prioritize operational fields
  // such as attitude, drive position, RPM, current, GPS, and frequency, score
  // changing series above constants, and return the twelve best graph candidates.
  const byKey = new Map();
  const priorityFor = key => {
    const normalized = String(key).toLowerCase();
    const important = [
      "roll", "pitch", "yaw", "heading",
      "pan", "tilt", "pos_deg", "angle_feedback", "angle", "position",
      "rpm", "speed", "current", "voltage", "torque",
      "actual_current", "dcbus_volt", "drive_connected", "fault_raw",
      "temperature", "temp", "range", "lat", "lon", "alt",
      "accel", "gyro", "frequency"
    ];

    return important.some(name => normalized.includes(name)) ? 50000 : 0;
  };

  rows.forEach(row => {
    if (row.value_type && !["num", "number", "numeric", "integer", "float", "real"].includes(String(row.value_type).toLowerCase())) {
      return;
    }

    const value =
      Number(row.value ?? row.value_num);

    if (!Number.isFinite(value)) {
      return;
    }

    const key =
      row.key || row.value_key || "value";

    if (!shouldShowTelemetryHistoryKey(key)) {
      return;
    }

    if (!byKey.has(key)) {
      byKey.set(key, []);
    }

    byKey.get(key).push({
      x: row.timestamp || row.server_timestamp || "",
      y: value
    });
  });

  return [...byKey.entries()]
    .map(([key, points]) => {
      const trimmed =
        points.slice(-240);
      const values =
        trimmed.map(point => point.y);
      const min =
        Math.min(...values);
      const max =
        Math.max(...values);

      return {
        key,
        points: trimmed,
        min,
        max,
        latest:
          values.length
            ? values[values.length - 1]
            : 0,
        changed:
          max !== min,
        score:
          (max !== min ? 100000 : 0) +
          priorityFor(key) +
          trimmed.length
      };
    })
    .filter(metric => metric.points.length >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);
}

/**

 * @brief Load inspector graph.

 * @param force When true, bypass cached or throttled loading behavior.

 * @async

 */

async function loadInspectorGraph(force = false) {
  // Capture the current graph mount, selected database, canonical device, and
  // optional process filter before starting asynchronous history work.
  const grid =
    document.getElementById("inspectorGraphGrid");
  const meta =
    document.getElementById("inspectorGraphMeta");
  const db =
    $("dbSelect")?.value || App.db;
  const device =
    canonicalInspectorDevice(selectedDevice);
  const historyDevice =
    device === "DRIVE_UNIT" ? "LCU_UNIT" : device;
  const process =
    selectedProcess;
  if (!grid || !db || !device) {
    return;
  }

  // Only one graph load may mutate the shared Chart.js instances at a time;
  // incrementing the token lets a later selection invalidate an older response.
  if (inspectorGraphLoading) {
    return;
  }

  inspectorGraphLoading = true;
  const token = ++inspectorGraphLoadToken;

  if (meta) {
    meta.textContent =
      force && inspectorCharts.length
        ? "Refreshing live visualization..."
        : "Loading visualization...";
  }

  if (!force || !inspectorCharts.length) {
    grid.innerHTML =
      '<div class="inspectorGraphLoading">Loading graphs...</div>';
  }

  // Request five minutes of persisted rows with a five-second deadline, falling
  // back to numeric fields synthesized from retained live device state.
  try {
    let rows;

    try {
      rows = await Promise.race([
        api(
          "/api/all?db=" +
          encodeURIComponent(db) +
          "&range=5m&device=" +
          encodeURIComponent(historyDevice)
        ),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Graph history request timed out")), 5000)
        )
      ]);
    } catch (historyError) {
      rows = graphRowsFromLiveState(device);
      if (!rows.length) throw historyError;
    }

    // Discard a response that completed after the operator initiated a newer graph load.
    if (token !== inspectorGraphLoadToken) {
      return;
    }

    // Keep rows belonging to the selected physical device and process, reverse
    // them into chronological order, and choose the most useful numeric metrics.
    let filtered =
      (Array.isArray(rows) ? rows : [])
        .filter(row =>
          sameInspectorDevice(
            typeof canonicalDeviceForTelemetry === "function"
              ? canonicalDeviceForTelemetry(row)
              : physicalDeviceForRow(row),
            device
          ) && (
            device === "DRIVE_UNIT" ||
            !process ||
            row.process === process ||
            row.process_name === process
          )
        )
        .slice()
        .reverse();
    let metrics =
      pickGraphMetrics(filtered);

    /* Compact database mode may intentionally omit a device's non-history
       fields. The live state still contains the complete raw packet, so use it
       immediately instead of presenting an empty graph after a successful
       but empty history response. */
    if (!metrics.length) {
      const liveRows =
        graphRowsFromLiveState(device);

      if (liveRows.length) {
        filtered = liveRows;
        metrics = pickGraphMetrics(liveRows);
      }
    }

    // Destroy old chart objects before replacing their canvases so Chart.js does
    // not retain observers or contexts for detached DOM nodes.
    destroyInspectorChart();

    if (!metrics.length || typeof Chart === "undefined") {
      grid.innerHTML =
        '<div class="inspectorGraphEmpty">No numeric graph signals available.</div>';

      if (meta) {
        meta.textContent =
          filtered.length
            ? "No numeric process fields available for graphing."
            : "No history rows found for this device/process.";
      }
      return;
    }

    // Build one graph tile per selected metric, including latest value and min/max context.
    grid.innerHTML =
      metrics.map((metric, index) => `
        <div class="inspectorGraphTile">
          <div class="inspectorGraphTileHeader">
            <strong>${esc(displayName(metric.key))}</strong>
            <span>${esc(formatControlValue(metric.latest))}</span>
            <div class="graphLiveReadout">
              ${esc(displayName(metric.key))} | Time: ${esc(metric.points[metric.points.length - 1]?.x || "--")} | Value: ${esc(formatControlValue(metric.latest))}
            </div>
          </div>
          <div class="inspectorGraphScale">
            <span>min ${esc(formatControlValue(metric.min))}</span>
            <span>max ${esc(formatControlValue(metric.max))}</span>
          </div>
          <div class="inspectorGraphCanvasWrap">
            <canvas id="inspectorProcessChart_${index}"></canvas>
          </div>
        </div>
      `).join("");

    // Create an independent nonanimated Chart.js line chart for each metric and
    // retain it for live updates and later destruction.
    metrics.forEach((metric, index) => {
      const canvas =
        document.getElementById(`inspectorProcessChart_${index}`);

      if (!canvas) {
        return;
      }

      const chart = new Chart(canvas, {
        type: "line",
        data: {
          labels:
            metric.points.map(point => point.x),
          datasets: [{
            label: displayName(metric.key),
            telemetryKey: displayName(metric.key),
            data:
              metric.points.map(point => point.y),
            borderColor:
              [
                "#38bdf8",
                "#22c55e",
                "#facc15",
                "#fb7185",
                "#a78bfa",
                "#f97316"
              ][index % 6],
            backgroundColor:
              "rgba(56,189,248,.08)",
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.22,
            fill: false
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          plugins: {
            legend: {
              display: false,
              position: "bottom",
              labels: {
                color: "#e5eefc"
              }
            },
            tooltip: {
              enabled: true,
              mode: "nearest",
              intersect: false,
              callbacks: typeof telemetryTooltipCallbacks === "function"
                ? telemetryTooltipCallbacks()
                : undefined
            }
          },
          scales: {
            x: {
              type: "category",
              ticks: {
                color: "#9fb0c8",
                maxTicksLimit: 4,
                maxRotation: 0,
                autoSkip: true
              },
              grid: {
                color: "rgba(255,255,255,0.08)"
              }
            },
            y: {
              beginAtZero:
                metric.min >= 0 &&
                metric.max <= 1,
              ticks: {
                color: "#9fb0c8",
                maxTicksLimit: 5
              },
              grid: {
                color: "rgba(255,255,255,0.08)"
              }
            }
          }
        }
      });

      chart.$telemetryKey = metric.key;
      inspectorCharts.push(chart);
    });

    // Report the amount of source data and the number of graphs actually produced.
    if (meta) {
      meta.textContent =
        `${displayName(device)}: ${filtered.length} rows, ${metrics.length} individual graphs`;
    }
    // Replace loading content with a controlled failure message while retaining
    // the error in the console for technical diagnosis.
  } catch (err) {
    if (grid) {
      grid.innerHTML =
        '<div class="inspectorGraphEmpty">Visualization load failed.</div>';
    }

    if (meta) {
      meta.textContent = "Visualization load failed.";
    }
    console.warn("Inspector graph load failed:", err);
    // Release the load latch even when APIs, fallback generation, or chart creation fail.
  } finally {
    inspectorGraphLoading = false;
  }
}

/**

 * @brief Handle live telemetry packet.


 */

function handleLiveTelemetryPacket(data) {
  // Normalize the WebSocket payload, construct standard packet metadata, and
  // identify the physical device before changing any HMI state.
  const payload =
    normalizeLivePacketPayload(data.payload);
  const row =
    packetRowForEvent(data, payload);
  const device =
    physicalDeviceForRow(row);

  // Reset cross-session graph state when the backend session or packet clock moved backward.
  detectLiveSessionBoundary(data, row);

  // Unknown packets remain available to backend diagnostics but cannot safely
  // update a specific HMI device panel.
  if (!device || device === "UNKNOWN_DEVICE") {
    return;
  }

  // Measure packet age from the device/packet clock when present; server-only
  // packets still update liveness but cannot be classified as delayed here.
  const now =
    Date.now();
  const deviceClock =
    row.device_ts || row.packet_ts || "";
  const deviceClockMs =
    deviceClock ? parseTs(deviceClock) : NaN;
  const devicePacketAgeMs =
    Number.isFinite(deviceClockMs)
      ? now - deviceClockMs
      : NaN;

  // Advance the global received count and mirror it into the header counter when mounted.
  totalPackets++;

  const packetCounter =
    document.getElementById("packetCount");

  if (packetCounter) {
    packetCounter.textContent =
      totalPackets;
  }

  // Initialize per-device packet, rate, anomaly, and health counters on first live contact.
  if (!deviceMetrics[device]) {
    deviceMetrics[device] = {
      packets: 0,
      lastPacket: now,
      lastRateCalc: now,
      rate: 0,
      packetCount: 0,
      packetRate: 0,
      online: true,
      lastSeen: "-",
      anomalies: 0,
      health: 100
    };
  }

  // Count packets arriving more than one second after their device timestamp for diagnostics.
  if (
    Number.isFinite(devicePacketAgeMs) &&
    devicePacketAgeMs > LIVE_PACKET_MAX_AGE_MS
  ) {
    deviceMetrics[device].delayedPackets =
      Number(deviceMetrics[device].delayedPackets || 0) + 1;
  }

  // Update packet totals and recompute the per-second arrival rate once per elapsed second.
  const m =
    deviceMetrics[device];

  m.packets++;
  m.packetCount++;
  m.lastPacket =
    now;
  m.lastSeen =
    new Date().toLocaleTimeString();
  m.online =
    true;

  // Publish a current online status record used by cards, selector lists, and the summary header.
  deviceStatuses[device] = {
    ...(deviceStatuses[device] || {}),
    device,
    status: "online",
    last_seen: m.lastSeen,
    rows: m.packetCount,
    anomalies: m.anomalies || 0
  };

  if (row.anomaly) {
    m.anomalies =
      (m.anomalies || 0) + 1;
  }

  if (now - m.lastRateCalc > 1000) {
    m.rate =
      m.packets;
    m.packetRate =
      m.packets;
    m.packets =
      0;
    m.lastRateCalc =
      now;
  }

  // Merge the partial device payload and attach envelope timing/process metadata
  // required by inspectors and chart tooltips.
  liveDeviceState[device] = mergeRetainedTelemetry(
    liveDeviceState[device] || {},
    payload
  );
  Object.assign(liveDeviceState[device], {
    packet_ts:
      row.packet_ts,
    device_ts:
      row.device_ts,
    server_rx_ts:
      row.server_timestamp,
    timestamp:
      row.timestamp,
    process_name:
      row.process_name,
    process:
      row.process_name,
    latency_ms:
      row.latency_ms
  });

  // LCU transport packets also carry drive state, so project those values into
  // the Drive Unit cache and renderer without changing their source identity.
  if (device === "LCU_UNIT") {
    mergeLcuTelemetryIntoDrive(payload, row.timestamp);
  }

  // Record browser receipt as live evidence, ensure the card exists, and update
  // its recent field preview and online status.
  deviceHeartbeat[device] =
    now;

  ensureDevicePanel(device);
  updateDevicePanelSignals(device, row);
  setDeviceStatus(
    device,
    "online",
    row.timestamp
  );

  // Track discrete state changes only for devices whose packets represent
  // operator controls or digital I/O.
  if (
    device === "BUTTON_LED_UNIT" ||
    device === "JOYSTICK_UNIT" ||
    device === "ADVANTECH_IO"
  ) {
    recordLiveStateChanges(
      device,
      payload,
      row.timestamp
    );
  }

  // Add graph points for IMU/drive and any other device payload that contains at
  // least one numeric telemetry field supported by generic visualization.
  if (
    device === "IMU_UNIT" ||
    device === "TRACKER_PUBLISH_UNIT" ||
    device === "DRIVE_UNIT" ||
    numericTelemetryFields(liveDeviceState[device], 1).length > 0
  ) {
    pushTrendPacket(
      liveDeviceState[device],
      device
    );
  }

  // Recalculate health and batch all aggregate/selector/inspector DOM updates.
  m.health =
    calculateDeviceHealth(device);

  scheduleHmiUiRefresh();
  scheduleLiveSelectorRefresh();
  scheduleSelectedInspectorRender(device);
}

/*
==================================================
TELEMETRY PARSER
==================================================
*/
/**
 * @brief Handle telemetry.
 */
function handleTelemetry(row) {
  // Historical or flattened telemetry processing requires a valid row and a
  // resolvable physical device identity.
  if (!row) {
    return;
  }

  const device =
    physicalDeviceForRow(row);

  if (!device || device === "UNKNOWN_DEVICE") {
    return;
  }

  // Count the row globally and expose the running total when the header counter exists.
  totalPackets++;

const packetCounter =
document.getElementById(
  "packetCount"
);

if (packetCounter) {

  packetCounter.textContent =
    totalPackets;
}

  // Move any early camera fields provisionally stored under UNKNOWN_DEVICE once
  // later metadata proves that the current stream belongs to the camera.
    if (
  device === "CAMERA_UNIT" &&
  liveDeviceState["UNKNOWN_DEVICE"]
) {

  Object.assign(
    liveDeviceState["CAMERA_UNIT"] ||= {},
    liveDeviceState["UNKNOWN_DEVICE"]
  );

  delete liveDeviceState["UNKNOWN_DEVICE"];
}

  // Initialize or update the device's packet totals, arrival rate, anomaly count,
  // heartbeat, online state, and computed health from this telemetry row.
if (!deviceMetrics[device]) {

  deviceMetrics[device] = {

    packets: 0,
    lastPacket: 0,
    lastRateCalc: Date.now(),
    rate: 0,

    packetCount: 0,
    packetRate: 0,

    online: true,

    lastSeen: "-",

    anomalies: 0,

    health: 0
  };
}

const m =
  deviceMetrics[device];

m.packets++;

m.packetCount++;

m.lastPacket =
  Date.now();

m.lastSeen =
  new Date()
    .toLocaleTimeString();

m.online = true;
if (row.anomaly) {
  m.anomalies =
    (m.anomalies || 0) + 1;
}
scheduleHmiUiRefresh();
m.health =
  calculateDeviceHealth(
    device
  );

if (
  Date.now() -
  m.lastRateCalc >
  1000
) {

 m.rate =
  m.packets;

m.packetRate =
  m.packets;

  m.packets = 0;

  m.lastRateCalc =
    Date.now();
}
  deviceHeartbeat[device] =
  Date.now();
const health =
  calculateDeviceHealth(
    device
  );

// Update the device card health bar, packet count, and current per-second rate.
ensureDevicePanel(device);

const h =
document.getElementById(
  "health_" +
  safeId(device)
);

if (h) {

  h.style.width =
    health + "%";
}

const p =
document.getElementById(
  "packets_" +
  safeId(device)
);

if (p) {

  p.textContent =
    m.packetCount;
}

const r =
document.getElementById(
  "rate_" +
  safeId(device)
);

if (r) {

  r.textContent =
    m.rate + "/s";
}

// Merge flattened key/value data into retained payload state and refresh the card preview.
const payload =
  mergeTelemetryRowIntoDeviceState(
    device,
    row
  );

updateDevicePanelSignals(device, row);
/*
-----------------------------------
AUTO CAMERA DETECTION
-----------------------------------
*/

  // Record the readable field change, detect fault/error/fail text for alarms,
  // and retain at most 25 recent event strings per device.
if (row.key !== undefined) {

  const value =
    rowValue(row);

  pushDeviceEvent(
    device,
    row.key + " = " + value
  );

  const valueText =
    String(value || "")
      .toUpperCase();

  if (
    valueText.includes("FAULT") ||
    valueText.includes("ERROR") ||
    valueText.includes("FAIL")
  ) {

    activeAlarms.unshift({

      device,

      message:
        row.key + " : " + value,

      time:
        new Date().toLocaleTimeString()

    });

    if (activeAlarms.length > 10) {
      activeAlarms.length = 10;
    }
  }

  if (!deviceEvents[device]) {
    deviceEvents[device] = [];
  }

  deviceEvents[device].unshift(
    row.key + " = " + value
  );
}

if (
  deviceEvents[device] &&
  deviceEvents[device].length > 25
) {

  deviceEvents[device].length = 25;
}

// Maintain per-device on/off usage timing and a bounded 500-entry audit history.
if (!deviceAuditHistory[device]) {

    deviceAuditHistory[device] = [];
}

if (!deviceUsageStats[device]) {

    deviceUsageStats[device] = {

        toggleCount: 0,
        lastState: null,
        lastOnTime: null,
        lastOffTime: null,
        totalOnMs: 0,
        stateStartTime: Date.now()
    };
}

const usage =
    deviceUsageStats[device];

const currentValue =
    String(rowValue(row) ?? "")
        .toUpperCase();

const isOn =
    [
        "ON",
        "1",
        "TRUE",
        "ACTIVE",
        "ENABLED"
    ].includes(currentValue);

const stateChanged =
    usage.lastState !== null &&
    usage.lastState !== isOn;

if (stateChanged) {

    usage.toggleCount++;

    const now =
        Date.now();

    if (usage.lastState === true) {

        usage.totalOnMs +=
            now - usage.stateStartTime;

        usage.lastOffTime =
            new Date()
                .toLocaleTimeString();
    }

    if (isOn) {

        usage.lastOnTime =
            new Date()
                .toLocaleTimeString();
    }
    deviceAuditHistory[device].unshift({

    time:
        new Date()
            .toLocaleTimeString(),

    key:
        row.key || "STATE",

    value:
        isOn ? "ON" : "OFF"
});

    usage.stateStartTime =
        now;

}
deviceAuditHistory[device].unshift({

    time:
        new Date()
            .toLocaleTimeString(),

    key:
        row.key || "",

    value:
        rowValue(row) || ""
});

usage.lastState = isOn;

if (deviceAuditHistory[device].length > 500) {

    deviceAuditHistory[device].length = 500;
}

if (DEBUG) {
  console.log(
    "DEVICE:",
    device,
    payload
  );
}

  /*
  ----------------------------------------
  GLOBAL ANALYTICS
  ----------------------------------------
  */

  // Feed approved numeric device values into analytics, then batch KPI and
  // selected-inspector rendering after all state for this row is updated.
 if (
  device === "IMU_UNIT" ||
  device === "TRACKER_PUBLISH_UNIT" ||
  device === "DRIVE_UNIT" ||
  numericTelemetryFields(payload, 1).length > 0
) {

  pushTrendPacket(
    payload,
    device
  );

  if (DEBUG) {

    console.log(
      "TREND:",
      device,
      payload
    );

  }
}
if (DEBUG) {

  console.log(
    "TREND:",
    device,
    row
  );

  console.log(
    "TREND DATA",
    device,
    payload
  );

  console.log(
    "TREND DEVICE:",
    device
  );
}
scheduleHmiUiRefresh();
scheduleSelectedInspectorRender(device);
  }

/**

 * @brief Expire stale device heartbeats and remove long-disconnected browser state.

 */

function monitorDeviceHealth() {
  // Examine every device observed by the WebSocket heartbeat tracker.
  Object.keys(deviceHeartbeat)
    .forEach(device => {

      const age =
        Date.now() -
        deviceHeartbeat[device];

      // After 15 seconds without a packet, mark the unit offline and clear its
      // live view once; setDeviceStatus performs the device-specific cache reset.
      if (age > LIVE_STALE_MS) {
        const wasOnline =
          deviceMetrics[device]?.online !== false ||
          Boolean(liveDeviceState[device]);

        if (wasOnline) {
          if (deviceMetrics[device]) {
            deviceMetrics[device].online = false;
          }

          setDeviceStatus(
            device,
            "offline",
            "STALE"
          );
        }
      }

      // Remove devices silent for thirty minutes from browser memory; backend
      // status polling can recreate them if they become active again.
      if (age > 1800000) {

        delete liveDeviceState[device];
        delete deviceHeartbeat[device];
      }

    });
}

/**

 * @brief Handle scada message.


 */

function handleScadaMessage(data) {
  // Optional diagnostics expose raw messages only when the explicit DEBUG flag is enabled.
  if (DEBUG) {
    console.log("HMI CALLBACK FIRED", data);
    console.log("RAW SCADA MESSAGE", data);
  }

  /*
  --------------------------------------------------
  CASE 1: One live telemetry packet from WebSocket
  --------------------------------------------------
  */
  // Telemetry envelopes are normalized, classified, merged into live state, and
  // forwarded to the packet handler before device-specific side effects run.
  if (data?.type === "telemetry" && data.payload != null) {
    const payload =
      normalizeLivePacketPayload(data.payload);

    const row =
      packetRowForEvent(data, payload);

    const device =
      canonicalInspectorDevice(
        physicalDeviceForRow(row)
      );

    handleLiveTelemetryPacket(data);

    /*
    Keep IMU GPS trail moving from live data.
    */
    // IMU packets extend the local GPS trail using the latest retained latitude
    // and longitude aliases after this packet has been merged.
    if (device === "IMU_UNIT") {
      const imuState =
        liveDeviceState.IMU_UNIT;

      const liveLat =
        telemetryNumber(
          imuState,
          [
            "lat",
            "latitude",
            "latitude_deg",
            "gps_lat",
            "gps_latitude",
            "gps.latitude",
            "gps.latitude_deg"
          ],
          NaN
        );

      const liveLon =
        telemetryNumber(
          imuState,
          [
            "lon",
            "lng",
            "longitude",
            "longitude_deg",
            "gps_lon",
            "gps_longitude",
            "gps.longitude",
            "gps.longitude_deg"
          ],
          NaN
        );

      recordImuGpsFix(
        liveLat,
        liveLon
      );
    }

    /*
    Important:
    If this device is currently opened in Device Inspector,
    force its SVG/visual panel to update from live data.
    This keeps joystick, IMU horizon, LCU, and external tracker moving.
    */
    if (
      selectedDevice &&
      sameInspectorDevice(
        selectedDevice,
        device
      )
    ) {
      scheduleSelectedInspectorRender(
        selectedDevice
      );
    }

    scheduleHmiUiRefresh();
    return;
  }

  /*
  --------------------------------------------------
  CASE 2: Already flattened live rows
  --------------------------------------------------
  */
  const rows =
    liveRowsFromScadaEvent(data);

  if (!rows.length) {
    return;
  }

  let selectedNeedsRender = false;
  let imuTouched = false;

  rows.forEach(row => {
    const device =
      canonicalInspectorDevice(
        physicalDeviceForRow(row)
      );

    handleTelemetry(row);

    setDeviceStatus(
      device,
      "online",
      row.timestamp ||
      row.server_rx_ts ||
      row.server_timestamp
    );

    if (
      selectedDevice &&
      sameInspectorDevice(
        selectedDevice,
        device
      )
    ) {
      selectedNeedsRender = true;
    }

    if (device === "IMU_UNIT") {
      imuTouched = true;
    }
  });

  if (imuTouched) {
    const imuState =
      liveDeviceState.IMU_UNIT;

    const liveLat =
      telemetryNumber(
        imuState,
        [
          "lat",
          "latitude",
          "latitude_deg",
          "gps_lat",
          "gps_latitude",
          "gps.latitude",
          "gps.latitude_deg"
        ],
        NaN
      );

    const liveLon =
      telemetryNumber(
        imuState,
        [
          "lon",
          "lng",
          "longitude",
          "longitude_deg",
          "gps_lon",
          "gps_longitude",
          "gps.longitude",
          "gps.longitude_deg"
        ],
        NaN
      );

    recordImuGpsFix(
      liveLat,
      liveLon
    );
  }

  if (selectedNeedsRender) {
    scheduleSelectedInspectorRender(
      selectedDevice
    );
  }

  scheduleHmiUiRefresh();
}

/**

 * @brief Schedule hmi live flush.

 */

function scheduleHmiLiveFlush() {
  // Keep one animation-frame flush pending; newly queued packets will be read by
  // that callback from the shared per-device and flattened-row buffers.
  if (hmiLiveFlushScheduled) {
    return;
  }

  hmiLiveFlushScheduled = true;

  // Snapshot the latest merged packet for every device and take at most 250
  // flattened rows so one browser frame has bounded processing work.
  requestAnimationFrame(() => {
    const packets =
      Array.from(
        hmiLiveByDevice.values()
      );

    const rows =
      hmiLiveRows.splice(
        0,
        250
      );

    hmiLiveByDevice.clear();
    hmiLiveFlushScheduled = false;

    let selectedTouched = false;

    // Process full packets first, tracking whether the selected device was
    // touched so its inspector can be rendered once after the batch.
    packets.forEach(packet => {
      handleScadaMessage(packet);

      if (
        selectedDevice &&
        packet?.payload != null
      ) {
        const payload =
          normalizeLivePacketPayload(
            packet.payload
          );

        const row =
          packetRowForEvent(
            packet,
            payload
          );

        const device =
          physicalDeviceForRow(row);

        if (
          sameInspectorDevice(
            selectedDevice,
            device
          )
        ) {
          selectedTouched = true;
        }
      }
    });

    // Process the bounded row batch and detect selected-device membership across
    // all rows expanded from each SCADA event.
    rows.forEach(rowOrPacket => {
      handleScadaMessage(rowOrPacket);

      const rowsFromEvent =
        liveRowsFromScadaEvent(rowOrPacket);

      if (
        selectedDevice &&
        rowsFromEvent.some(r =>
          sameInspectorDevice(
            selectedDevice,
            physicalDeviceForRow(r)
          )
        )
      ) {
        selectedTouched = true;
      }
    });

    // Batch selected detail and KPI redraws, then request another frame if
    // packets arrived while this flush was running or rows remain beyond the cap.
    if (selectedTouched) {
      scheduleSelectedInspectorRender(
        selectedDevice
      );
    }

    scheduleHmiUiRefresh();

    if (
      hmiLiveByDevice.size ||
      hmiLiveRows.length
    ) {
      scheduleHmiLiveFlush();
    }
  });
}

/**

 * @brief Coalesce packet and row WebSocket events for bounded animation-frame processing.


 */

function enqueueHmiScadaEvent(data) {
  /*
  common.js may send a single WebSocket message or a batch array.
  Handle both safely.
  */
  if (Array.isArray(data)) {
    // Preserve message order while routing each element of a WebSocket batch
    // through the same packet/row handling used for single events.
    data.forEach(item =>
      enqueueHmiScadaEvent(item)
    );
    return;
  }

  /*
  --------------------------------------------------
  Full telemetry packet
  --------------------------------------------------
  */
  if (data?.type === "telemetry" && data.payload != null) {
    // Normalize and classify the full packet immediately so control popups,
    // Button/LED latches, and packet history are not delayed until the next frame.
    const payload =
      normalizeLivePacketPayload(
        data.payload
      );

    const row =
      packetRowForEvent(
        data,
        payload
      );

    const device =
      physicalDeviceForRow(row);

    notifyImmediateControlPopups(
      device,
      payload,
      row.timestamp
    );

    if (
      canonicalInspectorDevice(device) ===
      "BUTTON_LED_UNIT"
    ) {
      renderButtonLedPanel(
        payload,
        row.timestamp
      );
    }

    appendLiveTelemetryHistory(data);

    // Keep only the newest pending packet per physical device, recursively
    // merging partial payload fields so no update is lost before the frame flush.
    const canonicalDevice =
      canonicalInspectorDevice(device);

    const pending =
      hmiLiveByDevice.get(
        canonicalDevice
      );

    if (pending) {
      const pendingPayload =
        normalizeLivePacketPayload(
          pending.payload
        );

      hmiLiveByDevice.set(
        canonicalDevice,
        {
          ...pending,
          ...data,
          payload:
            mergeRetainedTelemetry(
              pendingPayload,
              payload
            )
        }
      );
    } else {
      hmiLiveByDevice.set(
        canonicalDevice,
        {
          ...data,
          payload:
            mergeRetainedTelemetry(
              {},
              payload
            )
        }
      );
    }

    // Queue a frame to apply the coalesced device packets to cards, metrics, and inspectors.
    scheduleHmiLiveFlush();
    return;
  }

  /*
  --------------------------------------------------
  Flattened row or row batch
  --------------------------------------------------
  */
  // Flattened rows are retained in arrival order, with a hard 1000-row cap to
  // protect browser memory if rendering temporarily falls behind the stream.
  hmiLiveRows.push(data);

  if (hmiLiveRows.length > 1000) {
    hmiLiveRows.splice(
      0,
      hmiLiveRows.length - 1000
    );
  }

  scheduleHmiLiveFlush();
}

/**

 * @brief Calculate device health from packet age, current rate, and anomaly count.


 */

function calculateDeviceHealth(device) {
  // Health begins from the device's current packet metrics; an unknown device
  // or a heartbeat older than the offline threshold receives zero immediately.
  const m =
    deviceMetrics[device];

  if (!m) {
    return 0;
  }

  const age =
    Date.now() -
    m.lastPacket;

  if (age > LIVE_STALE_MS) {
    return 0;
  }

  // Deduct health progressively for delayed arrival, a stopped packet rate, and
  // accumulated anomalies, then clamp the operator-facing score at zero.
  let score = 100;

  if (age > LIVE_STALE_MS * 0.4) {
    score -= 20;
  }

  if (age > LIVE_STALE_MS * 0.8) {
    score -= 40;
  }

  if ((m.packetRate || m.rate || 0) <= 0 && age > 1000) {
    score -= 20;
  }

  score -= Math.min(35, (m.anomalies || 0) * 3);

  return Math.max(0, score);
}
/**
 * @brief Prepend a timestamped device-card event and retain only the newest three.
 */
function pushDeviceEvent(
  device,
  text
)
{
  // Target the compact event list belonging to this device card; cards without
  // an event mount do not need a separate event DOM tree.
  const id =
    "events_" +
    safeId(device);

  const el =
    document.getElementById(id);

  if (!el) {
    return;
  }

  // Prepend a browser-time-stamped event and retain only the three newest rows
  // so the card remains compact during high-rate changes.
  const row =
    document.createElement("div");

  row.className =
    "eventRow";

  row.textContent =
    new Date()
      .toLocaleTimeString()
    + "  "
    + text;

  el.prepend(row);

  while (
    el.children.length > 3
  ) {
    el.removeChild(
      el.lastChild
    );
  }
}
/**
 * @brief Render device inspector.
 */
function renderDeviceInspector() {
    // The inspector panel is optional; when present, show a selection prompt
    // until the operator chooses a physical device.
    const panel =
        document.getElementById("hmiDeviceInfo");

    if (!panel) return;

    if (!selectedDevice) {

        panel.innerHTML = `
        <div class="deviceInspectorEmpty">
            <h2>Select Device</h2>
        </div>
        `;

        return;
    }

    // Resolve metrics, payload, event, audit, history, and usage data through
    // both the selection alias and canonical device key before rendering tabs.
    const canonicalSelectedDevice =
        canonicalInspectorDevice(selectedDevice);

    const m =
        deviceMetrics[selectedDevice] ||
        deviceMetrics[canonicalSelectedDevice] ||
        {};

    const payload =
        liveDeviceState[selectedDevice] ||
        liveDeviceState[canonicalSelectedDevice] ||
        {};

    const audits =
        deviceAuditHistory[selectedDevice] ||
        deviceAuditHistory[canonicalSelectedDevice] ||
        [];
    const packetHistory =
        devicePacketHistory[selectedDevice] ||
        devicePacketHistory[canonicalSelectedDevice] ||
        [];
    const visibleHistory =
        packetHistory.length ? packetHistory : audits;
    const historyLabel =
        packetHistory.length
          ? "recent telemetry rows"
          : "recorded state changes";

    let tabContent = "";

    if (inspectorTab === "overview") {

        tabContent = `
          <div id="selectedDeviceDetail" class="selectedDeviceDetail">
            ${buildInspectorWidget(
                canonicalSelectedDevice,
                payload
            )}
          </div>
        `;
    }

    else if (inspectorTab === "graph") {

        tabContent =
          processGraphHtml(canonicalSelectedDevice);
    }

    else if (inspectorTab === "history") {

        tabContent = `

        <div class="inspectorHistoryPanel">

          <div class="historySummaryLine">
            <strong>${esc(visibleHistory.length)}</strong>
            <span>${esc(historyLabel)} for ${esc(displayName(canonicalSelectedDevice))}</span>
          </div>

          ${visibleHistory.length ? `
            <table class="inspectorHistoryTable">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Signal</th>
                  <th>Value</th>
                </tr>
              </thead>
              <tbody>
                ${visibleHistory.slice(0, 120).map(a => `
                  <tr>
                    <td>${esc(a.time || "--")}</td>
                    <td>${esc(displayName(a.key || "--"))}</td>
                    <td>${esc(a.value ?? "--")}</td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          ` : `
            <div class="deviceInspectorEmpty compact">
              <h2>No history recorded for this device</h2>
            </div>
          `}

        </div>
        `;
    }
else if (inspectorTab === "diagnostics") {

    const usage =
        deviceUsageStats[selectedDevice] ||
        deviceUsageStats[canonicalSelectedDevice] ||
        {};
    const controls =
        Object.values(controlMeta)
            .filter(c =>
                sameInspectorDevice(c.device, selectedDevice)
            )
            .sort((a, b) =>
                (b.lastChanged || 0) -
                (a.lastChanged || 0)
            );

    tabContent = `

    <div class="diagnosticGrid">

        <div class="metricCard">
            <span>Health</span>
            <h2>${m.health || 0}%</h2>
        </div>

        <div class="metricCard">
            <span>Packets</span>
            <h2>${m.packetCount || 0}</h2>
        </div>

        <div class="metricCard">
            <span>Rate</span>
            <h2>${m.packetRate || 0}/s</h2>
        </div>

        <div class="metricCard">
            <span>Toggles</span>
            <h2>${usage.toggleCount || 0}</h2>
        </div>

        <div class="metricCard">
            <span>Last ON</span>
            <h2>${usage.lastOnTime || "--"}</h2>
        </div>

        <div class="metricCard">
            <span>Last OFF</span>
            <h2>${usage.lastOffTime || "--"}</h2>
        </div>

        <div class="metricCard">
            <span>Runtime</span>
            <h2>
                ${Math.floor(
                    (usage.totalOnMs || 0) / 1000
                )}s
            </h2>
        </div>

    </div>

    <div class="controlIntelligencePanel">

      <h3>Control Intelligence</h3>

      ${controls.length ? controls.slice(0, 80).map(c => `

        <div class="controlIntelRow">
          <div>
            <strong>${esc(displayName(c.name))}</strong>
            <span>${esc(c.group)}</span>
          </div>
          <div>${esc(c.stateKey)}</div>
          <div>${esc(formatDuration(controlStateDuration(c)))}</div>
          <div>${esc(c.toggleCount)} changes</div>
          <div>${esc(c.operatorTouches)} ops</div>
          <div class="controlHealth ${controlHealth(c).toLowerCase()}">
            ${esc(controlHealth(c))}
          </div>
        </div>

      `).join("") : `
        <div class="deviceInspectorEmpty">
          <h2>No control telemetry yet</h2>
        </div>
      `}

    </div>
    `;
}

    panel.innerHTML = `

    <div class="inspectorHeader">

        <div class="inspectorDeviceName">
            ${esc(displayName(canonicalSelectedDevice))}
        </div>

        <div class="
            inspectorStatus
            ${m.online ? "online" : "offline"}
        ">
            ${m.online ? "ONLINE" : "OFFLINE"}
        </div>

    </div>

    <div class="inspectorTabs">

        <button class="${inspectorTab === "overview" ? "active" : ""}" onclick="inspectorTab='overview';renderDeviceInspector()">
            Overview
        </button>

        <button class="${inspectorTab === "diagnostics" ? "active" : ""}" onclick="inspectorTab='diagnostics';renderDeviceInspector()">
            Diagnostics
        </button>

        <button class="${inspectorTab === "graph" ? "active" : ""}" onclick="inspectorTab='graph';renderDeviceInspector()">
            Graph
        </button>

        <button class="${inspectorTab === "history" ? "active" : ""}" onclick="inspectorTab='history';renderDeviceInspector()">
            History
        </button>

    </div>

    ${tabContent}
    `;

    if (inspectorTab === "overview") {
      withPreservedPanelState(renderSelectedDeviceDetail);
    } else if (inspectorTab === "graph") {
      loadInspectorGraph();
    }
}

/**

 * @brief Render selected device detail.

 */

function renderSelectedDeviceDetail() {
  // Stop when no device is selected; otherwise choose its specialized renderer
  // and pass the retained payload with the best available packet timestamp.
  if (!selectedDevice) {
    return;
  }

  const detail =
    document.getElementById(
      "selectedDeviceDetail"
    );

  if (!detail) {
    return;
  }

  const canonicalSelectedDevice =
    canonicalInspectorDevice(selectedDevice);

  const payload =
    liveDeviceState[selectedDevice] ||
    liveDeviceState[canonicalSelectedDevice] ||
    {};

  const metrics =
    deviceMetrics[selectedDevice] ||
    deviceMetrics[canonicalSelectedDevice] ||
    {};

  const renderer =
    DEVICE_RENDERERS[selectedDevice] ||
    DEVICE_RENDERERS[canonicalSelectedDevice];

  if (!renderer) {
    detail.innerHTML =
      buildInspectorWidget(
        selectedDevice,
        payload
      );
    return;
  }

  renderer(
    payload || null,
    metrics.lastSeen || ""
  );
}
/**
 * @brief Select device.
 * @param deviceName Device identifier.
 * @async
 */
async function selectDevice(deviceName)
{
    // Canonicalize the clicked device, reset to its overview, synchronize the
    // selector, load persisted state, and render both detail and graph content.
    selectedDevice = canonicalInspectorDevice(deviceName);
    inspectorTab = "overview";

    const picker =
      document.getElementById("hmiDeviceSelect");

    if (picker && picker.value !== selectedDevice) {
      picker.value = selectedDevice;
    }

    document
      .querySelectorAll(".devicePanel")
      .forEach(p =>
        p.classList.remove("selected"));

    const panel =
      document.getElementById(
        "device_" + safeId(selectedDevice)
      );

    if(panel)
        panel.classList.add("selected");

    renderDeviceInspector();

    await loadPersistedHmiDeviceData(selectedDevice, true)
      .catch(console.warn);

    renderDeviceInspector();
}

/**

 * @brief Refresh live selectors.

 */

function refreshLiveSelectors() {
  // Rebuild process/device selector options from currently online metrics and
  // retained live state, preserve valid selections, and clear the inspector when
  // its previously selected device is no longer available.
  const deviceSelect =
    document.getElementById("hmiDeviceSelect");
  const processSelect =
    document.getElementById("hmiProcessSelect");

  if (deviceSelect) {
    const devices =
      Object.keys(deviceMetrics)
        .filter(device =>
          deviceMetrics[device]?.online ||
          hasDeviceHeartbeatWithinMs(device)
        )
        .sort();
    const current =
      deviceSelect.value || selectedDevice || "";

    deviceSelect.innerHTML =
      `<option value="">Select device</option>` +
      devices.map(device =>
        `<option value="${esc(device)}">${esc(displayName(device))}</option>`
      ).join("");

    if (current && devices.includes(current)) {
      deviceSelect.value =
        current;
    }
  }

  if (processSelect) {
    const processes =
      [...new Set(
        Object.values(liveDeviceState)
          .map(state => state?.process_name || state?.process || state?.name || "")
          .filter(Boolean)
      )].sort();
    const current =
      processSelect.value || selectedProcess || "";

    processSelect.innerHTML =
      `<option value="">All processes</option>` +
      processes.map(process =>
        `<option value="${esc(process)}">${esc(process)}</option>`
      ).join("");

    if (current && processes.includes(current)) {
      processSelect.value =
        current;
    }
  }
}

/**

 * @brief Coalesce device/process selector rebuilding into one short delayed refresh.

 */

function scheduleLiveSelectorRefresh() {
  // Keep one short selector timer pending so packet and status bursts cause one
  // device/process dropdown rebuild using the final accumulated state.
  if (selectorRefreshTimer) {
    return;
  }

  selectorRefreshTimer =
    setTimeout(() => {
      selectorRefreshTimer = null;
      refreshLiveSelectors();
    }, 250);
}

/**

 * @brief Initialize live selectors.

 */

function initLiveSelectors() {
  // Bind device, process, and tab controls so operator choices update inspector
  // state and trigger graph loading only when the graph tab needs it.
  const deviceSelect =
    document.getElementById("hmiDeviceSelect");
  const processSelect =
    document.getElementById("hmiProcessSelect");

  if (deviceSelect) {
    deviceSelect.onchange = () => {
      if (deviceSelect.value) {
        selectDevice(deviceSelect.value)
          .catch(console.warn);
      }
    };
  }

  if (processSelect) {
    processSelect.onchange = () => {
      selectedProcess =
        processSelect.value;

      if (selectedProcess) {
        const match =
          Object.entries(liveDeviceState)
            .find(([, state]) =>
              (state?.process_name || state?.process || state?.name || "") === selectedProcess
            );

        if (match) {
          selectDevice(match[0])
            .catch(console.warn);
        }
      }

      inspectorTab = "overview";
      renderDeviceInspector();
    };
  }
}
/**
 * @brief Build inspector widget.
 */
function buildInspectorWidget(device,payload) {
  // Return the device-specific compact overview for IMU and Drive units using
  // their primary operational readings; unsupported devices fall back to the
  // generic escaped overview rather than showing an empty inspector.

    switch(device) {

        case "CAMERA":
        case "CAMERA_UNIT":

            return cameraOverviewHtml(
              payload,
              deviceMetrics[device]?.lastSeen || ""
            );

        case "IMU_UNIT":

            return `

            <div class="inspectorTelemetryGrid">

                <div class="telemetryCard">

                    <span>ROLL</span>

                    <h2>
                        ${(payload.roll || 0).toFixed ?
                        Number(payload.roll || 0).toFixed(2)
                        : payload.roll || 0}
                        °
                    </h2>

                </div>

                <div class="telemetryCard">

                    <span>PITCH</span>

                    <h2>
                        ${(payload.pitch || 0).toFixed ?
                        Number(payload.pitch || 0).toFixed(2)
                        : payload.pitch || 0}
                        °
                    </h2>

                </div>

                <div class="telemetryCard">

                    <span>YAW</span>

                    <h2>
                        ${(payload.yaw || 0).toFixed ?
                        Number(payload.yaw || 0).toFixed(2)
                        : payload.yaw || 0}
                        °
                    </h2>

                </div>

            </div>
            `;

        case "TRACKER_PUBLISH_UNIT":
        case "DRIVE_UNIT":

            return `

            <div class="inspectorTelemetryGrid">

                <div class="telemetryCard">

                    <span>PAN</span>

                    <h2>
                        ${payload.pan_deg || 0}
                    </h2>

                </div>

                <div class="telemetryCard">

                    <span>TILT</span>

                    <h2>
                        ${payload.tilt_deg || 0}
                    </h2>

                </div>

                <div class="telemetryCard">

                    <span>RPM</span>

                    <h2>
                        ${payload.rpm || 0}
                    </h2>

                </div>

                <div class="telemetryCard">

                    <span>CURRENT</span>

                    <h2>
                        ${payload.current || 0}
                    </h2>

                </div>

            </div>
            `;

        default:
            return genericDeviceOverviewHtml(
              device,
              payload
            );
    }
}
/**
 * @brief Update total, online, and unavailable device counts from current metrics.
 */
function updateKpis() {
  // Count all devices with metrics and the subset whose current browser state is online.
  const devices =
    Object.keys(deviceMetrics);

  const online =
    devices.filter(
      d => deviceMetrics[d]?.online
    ).length;

  const totalEl =
    document.getElementById(
      "totalDevices"
    );

  const onlineEl =
    document.getElementById(
      "onlineDevices"
    );

  const warningEl =
    document.getElementById(
      "warningDevices"
    );

  // Update whichever KPI mounts exist on the current HMI layout; the warning
  // tile represents every known device not currently online.
  if (totalEl) {
    totalEl.textContent =
      devices.length;
  }

  if (onlineEl) {
    onlineEl.textContent =
      online;
  }

  if (warningEl) {
    warningEl.textContent =
      devices.length - online;
  }
}

/**

 * @brief Render alarm center.

 */

function renderAlarmCenter() {
    // Render at most ten newest alarms, escaping device, message, and timestamp
    // because all may contain telemetry-derived text.
    const el =
        document.getElementById(
            "alarmCenter"
        );

    if (!el) return;

    el.innerHTML =
        activeAlarms
            .slice(0,10)
            .map(a => `

            <div class="alarmRow">

                <strong>${esc(a.device)}</strong>

                <span>${esc(a.message)}</span>

                <small>${esc(a.time)}</small>

            </div>

            `)
            .join("");
}

/**

 * @brief Update trend playback.

 * @param index Array or playback index.

 */

function updateTrendPlayback(index) {
  // Playback requires an initialized trend chart; data may already be loaded before Chart.js is ready.
  if (!trendChart) return;

  // Show the historical prefix ending at the selected index for every aligned
  // mission and generic dataset, then redraw without animation for responsive scrubbing.
  trendChart.data.labels =
    telemetryTrendData.labels.slice(
      0,
      index + 1
    );

  trendChart.data.datasets[0].data =
    telemetryTrendData.imu.roll.slice(
      0,
      index + 1
    );

  trendChart.data.datasets[1].data =
    telemetryTrendData.imu.pitch.slice(
      0,
      index + 1
    );

  trendChart.data.datasets[2].data =
    telemetryTrendData.imu.yaw.slice(
      0,
      index + 1
    );

  trendChart.data.datasets[3].data =
    telemetryTrendData.drive.pan.slice(
      0,
      index + 1
    );

  trendChart.data.datasets[4].data =
    telemetryTrendData.drive.tilt.slice(
      0,
      index + 1
    );

  trendChart.data.datasets[5].data =
    telemetryTrendData.drive.rpm.slice(
      0,
      index + 1
    );

  trendChart.data.datasets[6].data =
    telemetryTrendData.drive.current.slice(
      0,
      index + 1
    );

  ["a", "b", "c"].forEach((slot, offset) => {
    if (trendChart.data.datasets[7 + offset]) {
      trendChart.data.datasets[7 + offset].data =
        telemetryTrendData.generic[slot].slice(
          0,
          index + 1
        );
      trendChart.data.datasets[7 + offset].label =
        telemetryTrendData.generic.labels[offset];
    }
  });

  trendChart.update("none");
}

/**

 * @brief Reset hmi runtime state.

 */

function resetHmiRuntimeState() {
  // Reset counters, selection, alarms, device-specific retained controls, and
  // GPS trail before loading another daily database.
  totalPackets = 0;
  trendReplayLoadedDb = "";
  selectedDevice = null;
  activeAlarms.length = 0;
  resetDeviceCachedState("BUTTON_LED_UNIT");
  resetDeviceCachedState("JOYSTICK_UNIT");
  resetDeviceCachedState("LCU_UNIT");
  imuGpsTrailState.reference = null;
  imuGpsTrailState.points.length = 0;
  // Delete every key from live/status/history/usage/control caches in place so
  // references held by renderers remain valid but contain no data from the old DB.
  Object.keys(liveDeviceState)
    .forEach(key => delete liveDeviceState[key]);

  Object.keys(deviceHeartbeat)
    .forEach(key => delete deviceHeartbeat[key]);

  Object.keys(deviceRecentSignals)
    .forEach(key => delete deviceRecentSignals[key]);

  Object.keys(deviceMetrics)
    .forEach(key => delete deviceMetrics[key]);

  Object.keys(deviceEvents)
    .forEach(key => delete deviceEvents[key]);

  Object.keys(deviceAuditHistory)
    .forEach(key => delete deviceAuditHistory[key]);

  Object.keys(devicePacketHistory)
    .forEach(key => delete devicePacketHistory[key]);

  Object.keys(deviceUsageStats)
    .forEach(key => delete deviceUsageStats[key]);

  Object.keys(controlMeta)
    .forEach(key => delete controlMeta[key]);

  Object.keys(immediatePopupState)
    .forEach(key => delete immediatePopupState[key]);

  Object.keys(buttonLedPulseUntil)
    .forEach(key => delete buttonLedPulseUntil[key]);

  Object.keys(joystickPulseUntil)
    .forEach(key => delete joystickPulseUntil[key]);

  Object.keys(lcuStableState.axes)
    .forEach(key => delete lcuStableState.axes[key]);

  Object.keys(lcuStableState.common)
    .forEach(key => delete lcuStableState.common[key]);

  lcuStableState.timestamp = "";

  // Cancel pending pulse timers and clear their latch maps so old momentary
  // activity cannot reappear after the database switch.
  if (buttonLedPulseTimer) {
    clearTimeout(buttonLedPulseTimer);
    buttonLedPulseTimer = null;
  }

  if (joystickPulseTimer) {
    clearTimeout(joystickPulseTimer);
    joystickPulseTimer = null;
  }

  persistedHmiLoads.clear();

  // Clear all trend arrays, labels, generic slot assignments, and visible chart data.
  telemetryTrendData.labels.length = 0;
  telemetryTrendData.timestamps.length = 0;

  Object.values(telemetryTrendData.imu)
    .forEach(arr => arr.length = 0);

  Object.values(telemetryTrendData.drive)
    .forEach(arr => arr.length = 0);

  ["a", "b", "c"].forEach(key => {
    telemetryTrendData.generic[key].length = 0;
  });
  resetGenericTrendSlots();

  if (trendChart) {
    trendChart.update("none");
  }

  // Return playback and packet-count controls to their empty initial positions.
  const slider =
    document.getElementById(
      "timelineSlider"
    );

  if (slider) {
    slider.value = 0;
    slider.max = 0;
  }

  const packetCounter =
    document.getElementById(
      "packetCount"
    );

  if (packetCounter) {
    packetCounter.textContent = "0";
  }
}

/**

 * @brief Reset live graph state.

 */

function resetLiveGraphState() {
  // Clear trend backing arrays when a backend session boundary is detected,
  // preventing timestamp and value sequences from two sessions being joined.
  telemetryTrendData.labels.length = 0;
  telemetryTrendData.timestamps.length = 0;

  Object.values(telemetryTrendData.imu)
    .forEach(series => {
      series.length = 0;
    });

  Object.values(telemetryTrendData.drive)
    .forEach(series => {
      series.length = 0;
    });

  ["a", "b", "c"].forEach(key => {
    telemetryTrendData.generic[key].length = 0;
  });
  resetGenericTrendSlots();

  // Empty every inspector and mission Chart.js dataset in place and redraw once without animation.
  inspectorCharts.forEach(chart => {
    if (!chart || !chart.data) {
      return;
    }

    chart.data.labels = [];
    (chart.data.datasets || []).forEach(dataset => {
      dataset.data = [];
    });
    chart.update("none");
  });

  if (trendChart) {
    trendChart.data.labels = telemetryTrendData.labels;
    trendChart.data.datasets.forEach(dataset => {
      dataset.data = [];
    });
    trendChart.update("none");
  }
}

/**

 * @brief Initialize playback controls.

 */

function initPlaybackControls() {
  // Resolve all timeline controls once; the required primary buttons and slider
  // must exist before event handlers can be installed.
  const liveBtn =
document.getElementById("liveBtn");
  const playBtn =
    document.getElementById("playBtn");

  const pauseBtn =
    document.getElementById("pauseBtn");

  const replayBtn =
    document.getElementById("replayBtn");

  const slider =
    document.getElementById("timelineSlider");
  const rewindBtn =
  document.getElementById("rewindBtn");

const forwardBtn =
  document.getElementById("forwardBtn");

  if (!liveBtn || !playBtn || !pauseBtn || !replayBtn || !slider) {
    return;
  }

  // LIVE stops playback and reconnects every chart dataset to the complete
  // continuously updated telemetry arrays.
  liveBtn.onclick = () => {

  if (!trendChart) {
    return;
  }

  clearInterval(playbackTimer);
  playbackMode = false;

  trendChart.data.labels =
    telemetryTrendData.labels;

  trendChart.data.datasets[0].data =
    telemetryTrendData.imu.roll;

  trendChart.data.datasets[1].data =
    telemetryTrendData.imu.pitch;

  trendChart.data.datasets[2].data =
    telemetryTrendData.imu.yaw;

  trendChart.data.datasets[3].data =
    telemetryTrendData.drive.pan;

  trendChart.data.datasets[4].data =
    telemetryTrendData.drive.tilt;

  trendChart.data.datasets[5].data =
    telemetryTrendData.drive.rpm;

  trendChart.data.datasets[6].data =
    telemetryTrendData.drive.current;

  ["a", "b", "c"].forEach((slot, offset) => {
    if (trendChart.data.datasets[7 + offset]) {
      trendChart.data.datasets[7 + offset].data =
        telemetryTrendData.generic[slot];
      trendChart.data.datasets[7 + offset].label =
        telemetryTrendData.generic.labels[offset];
    }
  });

  trendChart.update();
};

// PLAY ensures database replay data exists, then advances one point every half
// second until the end while synchronizing slider and visible playback time.
playBtn.onclick = async () => {

  await ensureTrendReplayData();

  if (!trendChart || !telemetryTrendData.labels.length) {
    return;
  }

  clearInterval(playbackTimer);

  playbackMode = true;

  playbackTimer = setInterval(() => {

    if (
      playbackIndex >=
      telemetryTrendData.labels.length
    ) {

      clearInterval(playbackTimer);
      return;
    }

    slider.value =
      playbackIndex;

    updateTrendPlayback(
      playbackIndex
    );

    const t =
      document.getElementById(
        "playbackTime"
      );

    if (t) {

      t.textContent =
        telemetryTrendData.labels[
          playbackIndex
        ];
    }

    playbackIndex++;

  }, 500);

};

// PAUSE stops the interval but deliberately remains in playback mode so incoming
// live packets do not replace the historical prefix currently under inspection.
pauseBtn.onclick = () => {

  clearInterval(playbackTimer);

  playbackMode = true;

};
// REPLAY loads history if needed and returns chart and slider to the first point.
replayBtn.onclick = async () => {

  await ensureTrendReplayData();

  if (!trendChart || !telemetryTrendData.labels.length) {
    return;
  }

  clearInterval(playbackTimer);

  playbackMode = true;

  playbackIndex = 0;

  slider.value = 0;

  updateTrendPlayback(0);
};

 // Manual slider movement selects an exact historical prefix and updates its displayed time.
 slider.oninput = () => {

  if (!trendChart) {
    return;
  }

  playbackIndex =
    Number(slider.value);

  updateTrendPlayback(
    playbackIndex
  );

  const t =
    document.getElementById(
      "playbackTime"
    );

  if (t) {

    t.textContent =
      telemetryTrendData.labels[
        playbackIndex
      ] || "--";
  }
};
// Optional rewind/forward buttons move ten samples at a time without exceeding
// the first or last available replay point.
if (rewindBtn) {

  rewindBtn.onclick = async () => {

    await ensureTrendReplayData();

    if (!trendChart || !telemetryTrendData.labels.length) {
      return;
    }

    playbackMode = true;

    playbackIndex =
      Math.max(
        0,
        playbackIndex - 10
      );

    slider.value =
      playbackIndex;

    updateTrendPlayback(
      playbackIndex
    );
  };
}

if (forwardBtn) {

  forwardBtn.onclick = async () => {

    await ensureTrendReplayData();

    if (!trendChart || !telemetryTrendData.labels.length) {
      return;
    }

    playbackMode = true;

    playbackIndex =
      Math.min(
        telemetryTrendData.labels.length - 1,
        playbackIndex + 10
      );

    slider.value =
      playbackIndex;

    updateTrendPlayback(
      playbackIndex
    );
  };
}
}

/**

 * @brief Normalize hmi labels.

 */

function normalizeHmiLabels() {
  // Apply stable operator-facing text to playback buttons because icon or stale
  // cached markup may otherwise leave ambiguous control labels.
  const labels = {
    liveBtn: "LIVE",
    playBtn: "Play",
    pauseBtn: "Pause",
    rewindBtn: "Rewind",
    forwardBtn: "Forward",
    replayBtn: "Replay"
  };

  Object.entries(labels)
    .forEach(([id, text]) => {
      const el = document.getElementById(id);

      if (el) {
        el.textContent = text;
      }
    });
}

/*
==================================================
INIT
==================================================
*/

/**

 * @brief Initialize HMI controls, data sources, charts, event handlers, and live updates.

 * @async

 */

async function init() {
  // Normalize control labels and populate the database selector before any API
  // or chart workflow depends on the selected daily shard.
  normalizeHmiLabels();

  const dbSelect =
    $("dbSelect");

  await loadDbSelect(
    dbSelect
  );

  // Show a controlled empty state and stop initialization when no telemetry database exists.
  if (!App.db) {
    setHtml(
      "hmiStatus",
      '<div class="hmiPowerSummary"><span class="summaryOff">NO DATABASES</span></div>'
    );
    renderDeviceInspector();
    return;
  }

// Initialize charts, live selectors, playback controls, and the one-second
// heartbeat monitor before attaching database and WebSocket event handlers.
initAnalytics();
initLiveSelectors();
initPlaybackControls();
setInterval(
  monitorDeviceHealth,
  1000
);
  if (dbSelect) {
    // Changing database clears all browser state, empties old DOM content, then
    // reloads status, history, latest control snapshots, and KPIs for the new shard.
    dbSelect.onchange = async () => {

    App.db =
      dbSelect.value;

    resetHmiRuntimeState();
    setHtml("hmiCanvas", "");
    setHtml("telemetryFeed", "");
    setHtml("hmiDeviceInfo", "");
    selectedDevice = null;
    selectedProcess = "";
    refreshLiveSelectors();

    await refreshDeviceStatuses();
    await loadInitialHistory();
    await refreshControlPanels();
    updateKpis();
  };
  }

  // On a new WebSocket generation, preserve visible panels while refreshing
  // backend status/history/latest data to reconcile state after reconnect.
  window.addEventListener("scada:connected", event => {
    const generation =
      Number(event.detail?.generation || 0);

    if (generation && generation !== hmiWsGeneration) {
      hmiWsGeneration = generation;
      /* Reconnects are expected during a temporary backend stall.  Preserve
         the last valid panels until fresh packets/status arrive. */
      refreshDeviceStatuses()
        .then(() => loadInitialHistory())
        .then(() => refreshControlPanels())
        .then(() => updateKpis())
        .catch(console.warn);
    }
  });

  // A disconnect triggers immediate health evaluation and selector refresh;
  // normal stale thresholds decide when panels actually become offline.
  window.addEventListener("scada:disconnected", () => {
    monitorDeviceHealth();
    scheduleLiveSelectorRefresh();
  });

  // Start the shared socket, register the HMI's queued event consumer, and poll
  // device status every five seconds only while live messages are unavailable.
  initScadaSocket();
  onScadaEvent(enqueueHmiScadaEvent);

  hmiFallbackTimer = setInterval(() => {
    if (App.wsConnected && Date.now() - (App.wsLastMessageAt || 0) < 15000) {
      return;
    }

    refreshDeviceStatuses().catch(console.error);
  }, 5000);

  /*
  ----------------------------------------
  INITIAL HISTORY LOAD
  ----------------------------------------
  */

  // Populate initial device status, replay history, latest control state, and selectors in dependency order.
  await refreshDeviceStatuses();
  await loadInitialHistory();
  await refreshControlPanels();
  scheduleLiveSelectorRefresh();

  /* Cached control panels are loaded at startup and DB change only.
     Live panel movement must come from websocket telemetry, not DB polling. */
}

/**

 * @brief Load initial history.

 * @async

 */

let trendReplayLoadedDb = "";
let trendReplayLoadPromise = null;

async function loadTrendReplayHistory(db, range = "1m") {
  // Skip invalid, already populated, or duplicate concurrent loads for this database.
  if (!db) return;
  if (trendReplayLoadedDb === db && telemetryTrendData.labels.length) return;
  if (trendReplayLoadPromise) return trendReplayLoadPromise;

  // Load IMU packets and LCU-carried drive packets, grouping flattened fields by
  // device and timestamp into complete payloads suitable for pushTrendPacket.
  trendReplayLoadPromise = (async () => {
    const sources = [
      { queryDevice: "IMU_UNIT", device: "IMU_UNIT" },
      { queryDevice: "LCU_UNIT", device: "DRIVE_UNIT" }
    ];
    const grouped = new Map();

    // Prefer packet-history reconstruction; fall back to flattened `/api/all`
    // rows when packet history is unavailable for an older database.
    await Promise.all(sources.map(async source => {
      let rows = [];
      try {
        const packets = await api(
          "/api/history/packets?db=" + encodeURIComponent(db) +
          "&device=" + encodeURIComponent(source.queryDevice) +
          "&range=" + encodeURIComponent(range),
          30000
        );
        rows = telemetryRowsFromPackets(packets, source.device);
      } catch {
        rows = await api(
          "/api/all?db=" + encodeURIComponent(db) +
          "&device=" + encodeURIComponent(source.queryDevice) +
          "&range=" + encodeURIComponent(range),
          30000
        ).catch(() => []);
      }

      (Array.isArray(rows) ? rows : []).forEach(row => {
        const timestamp = row.packet_ts || row.device_ts ||
          row.server_rx_ts || row.timestamp;
        const timestampMs = timestamp ? parseTs(timestamp) : NaN;
        const key = String(row.key || row.value_key || "").trim();
        const value = row.value_num ?? row.value ?? row.value_text;
        if (!Number.isFinite(timestampMs) || !key) return;
        const groupKey = source.device + "|" + timestamp;
        if (!grouped.has(groupKey)) {
          grouped.set(groupKey, {
            device: source.device,
            timestamp,
            timestampMs,
            payload: {
              timestamp,
              server_rx_ts: row.server_rx_ts || timestamp,
              packet_ts: row.packet_ts || "",
              device_ts: row.device_ts || ""
            }
          });
        }
        grouped.get(groupKey).payload[key.replace(/\./g, "_").toLowerCase()] = value;
      });
    }));

    // Sort reconstructed packet groups chronologically and leave existing live
    // trend state untouched when history contains no usable records.
    const records = [...grouped.values()]
      .sort((a, b) => a.timestampMs - b.timestampMs);
    if (!records.length) return;

    // Snapshot live values, clear backing arrays, append only history timestamps
    // not already present, then restore live values after the historical prefix.
    const existing = {
      labels: telemetryTrendData.labels.slice(),
      timestamps: telemetryTrendData.timestamps.slice(),
      imu: Object.fromEntries(Object.entries(telemetryTrendData.imu)
        .map(([key, values]) => [key, values.slice()])),
      drive: Object.fromEntries(Object.entries(telemetryTrendData.drive)
        .map(([key, values]) => [key, values.slice()]))
    };
    const existingTimes = new Set(existing.timestamps.map(String));
    telemetryTrendData.labels.length = 0;
    telemetryTrendData.timestamps.length = 0;
    Object.values(telemetryTrendData.imu).forEach(values => { values.length = 0; });
    Object.values(telemetryTrendData.drive).forEach(values => { values.length = 0; });
    ["a", "b", "c"].forEach(key => { telemetryTrendData.generic[key].length = 0; });
    const previousPlaybackMode = playbackMode;
    playbackMode = true;
    records
      .filter(record => !existingTimes.has(String(record.timestamp)))
      .forEach(record => pushTrendPacket(record.payload, record.device));
    playbackMode = previousPlaybackMode;

    telemetryTrendData.labels.push(...existing.labels);
    telemetryTrendData.timestamps.push(...existing.timestamps);
    Object.keys(telemetryTrendData.imu).forEach(key =>
      telemetryTrendData.imu[key].push(...existing.imu[key]));
    Object.keys(telemetryTrendData.drive).forEach(key =>
      telemetryTrendData.drive[key].push(...existing.drive[key]));

    // Enforce the same 500-point bound as live ingestion, update replay controls,
    // and redraw the latest point when the operator is not currently replaying.
    const excess = Math.max(0, telemetryTrendData.labels.length - 500);
    if (excess) {
      telemetryTrendData.labels.splice(0, excess);
      telemetryTrendData.timestamps.splice(0, excess);
      Object.values(telemetryTrendData.imu).forEach(values => values.splice(0, excess));
      Object.values(telemetryTrendData.drive).forEach(values => values.splice(0, excess));
    }
    trendReplayLoadedDb = db;
    const slider = document.getElementById("timelineSlider");
    if (slider) slider.max = Math.max(0, telemetryTrendData.labels.length - 1);
    if (!playbackMode && trendChart) {
      updateTrendPlayback(telemetryTrendData.labels.length - 1);
    }
  // Always clear the shared promise when loading settles so future database changes can start a new request.
  })().finally(() => {
    trendReplayLoadPromise = null;
  });

  return trendReplayLoadPromise;
}

async function ensureTrendReplayData() {
  // Load one minute of replay data when the current arrays are empty or belong to another database.
  const db = $("dbSelect")?.value || App.db;
  if (!telemetryTrendData.labels.length || trendReplayLoadedDb !== db) {
    await loadTrendReplayHistory(db, "1m");
  }
}

async function loadInitialHistory() {
  // Use the selected daily database and ensure its one-minute IMU/drive replay
  // series is available before seeding live-looking device cards.
  const db =
    $("dbSelect")?.value || App.db;

  if (!db) return;

  await loadTrendReplayHistory(db, "1m");

  // Request only the last five seconds of flattened telemetry; this startup
  // seed must never make old database rows appear as current device activity.
  let rows = [];

  try {
    rows =
      await api(

      "/api/all?db=" +

      encodeURIComponent(db) +

      "&range=5s"
    );
  } catch (err) {
    console.warn(
      "HMI history load failed:",
      err
    );
    return;
  }

  // Retain rows whose server timestamp is inside the live threshold and whose
  // backend device status is online at initialization time.
  const now = Date.now();
  const liveRows = (Array.isArray(rows) ? rows : [])
    .filter(row => {
      const timestamp = row?.server_rx_ts || row?.timestamp;
      const parsed = timestamp ? parseTs(timestamp) : NaN;
      const device = physicalDeviceForRow(row);
      const status = deviceStatuses[device]?.status;

      return Number.isFinite(parsed) &&
        now - parsed >= 0 &&
        now - parsed <= LIVE_STALE_MS &&
        normalizeStatus(status) === "online";
    });

  // Apply oldest-to-newest so retained state and recent-signal previews finish
  // on the latest value for each online physical device.
  liveRows
    .slice()
    .reverse()
    .forEach(r => {
      const device =
        physicalDeviceForRow(r);

      ensureDevicePanel(device);
      mergeTelemetryRowIntoDeviceState(
        device,
        r
      );
      updateDevicePanelSignals(
        device,
        r
      );

  });

  // Load persisted control/audit details and rebuild selectors after the live seed is merged.
  loadPersistedHmiDevices();
  scheduleLiveSelectorRefresh();
}
/*
==================================================
HMI PERFORMANCE + LAYOUT STABILITY PATCH
==================================================
This patch prevents the HMI from freezing when live packets come very fast.
It throttles DOM rendering, keeps Device Fleet on the right side, and adds
live time/value readout on inspector graph lines.
*/

const HMI_PANEL_RENDER_MS = 700;
const HMI_SIGNAL_RENDER_MS = 700;
const HMI_INSPECTOR_GRAPH_RENDER_MS = 1000;
const HMI_KPI_RENDER_MS = 500;

const hmiLastPanelRenderAt = {};
const hmiLastSignalRenderAt = {};
const hmiLastInspectorGraphAt = {};
let hmiLastKpiRenderAt = 0;

/*
----------------------------------------------
Keep heavy KPI rendering throttled
----------------------------------------------
*/
if (typeof updateKpis === "function") {
  // Preserve the original KPI renderer and wrap it with a 500 ms minimum interval.
  const originalUpdateKpis = updateKpis;

  /**

   * @brief Update total, online, and unavailable device counts from current metrics.

   */

  updateKpis = function throttledUpdateKpis() {
    const now = Date.now();

    // Skip only the DOM repaint; packet handlers have already updated the metrics
    // that the next permitted render will read.
    if (now - hmiLastKpiRenderAt < HMI_KPI_RENDER_MS) {
      return;
    }

    hmiLastKpiRenderAt = now;
    originalUpdateKpis();
  };
}

/*
----------------------------------------------
Throttle device panel DOM updates
----------------------------------------------
*/
if (typeof setDeviceStatus === "function") {
  // Wrap the status renderer without changing its callers or status semantics.
  const originalSetDeviceStatus = setDeviceStatus;

  /**

   * @brief Apply online, warning, or offline status and associated metrics to a device panel.


   * @param status Raw or normalized device status.

   * @param lastSeen Last-activity timestamp shown for the device.

   * @param meta Additional status or channel metadata.

   */

  setDeviceStatus = function throttledSetDeviceStatus(
    device,
    status,
    lastSeen,
    meta = {}
  ) {
    // Canonicalize aliases so one physical device shares a single throttle clock.
    const canonical =
      typeof canonicalInspectorDevice === "function"
        ? canonicalInspectorDevice(device)
        : device;

    const now = Date.now();
    const previous =
      hmiLastPanelRenderAt[canonical] || 0;

    // Bypass throttling for an online/warning/offline transition; otherwise
    // limit repeated count/rate DOM updates to once every 700 ms.
    const importantChange =
      !deviceStatuses[canonical] ||
      normalizeStatus(deviceStatuses[canonical]?.status) !==
        normalizeStatus(status);

    /*
      Always allow important online/offline change.
      Otherwise update panel only every 700ms.
    */
    if (
      !importantChange &&
      now - previous < HMI_PANEL_RENDER_MS
    ) {
      return;
    }

    hmiLastPanelRenderAt[canonical] = now;

    originalSetDeviceStatus(
      device,
      status,
      lastSeen,
      meta
    );
  };
}

/*
----------------------------------------------
Throttle live signal rows in Device Fleet
----------------------------------------------
*/
if (typeof updateDevicePanelSignals === "function") {
  // Keep the original DOM renderer while intercepting high-rate rows to maintain
  // the latest four signal values in memory between permitted repaints.
  const originalUpdateDevicePanelSignals =
    updateDevicePanelSignals;

  /**

   * @brief Update the recent-signal preview displayed on a device card.



   */

  updateDevicePanelSignals = function throttledUpdateDevicePanelSignals(
    device,
    row
  ) {
    if (!device || !row) {
      return;
    }

    // Normalize the device key and update its recent-signal cache for every row,
    // even when the visual repaint below is still inside the throttle window.
    const canonical =
      typeof canonicalInspectorDevice === "function"
        ? canonicalInspectorDevice(device)
        : device;

    const now = Date.now();
    const previous =
      hmiLastSignalRenderAt[canonical] || 0;

    /*
      Store latest signal data, but do not repaint DOM on every packet.
    */
    const key =
      row.key ??
      row.value_key;

    if (key !== undefined && key !== null && String(key).trim() !== "") {
      const value =
        typeof rowValue === "function"
          ? rowValue(row)
          : (
              row.value_num ??
              row.value_text ??
              row.value ??
              "--"
            );

      const signals =
        deviceRecentSignals[canonical] ||
        deviceRecentSignals[device] ||
        [];

      const next =
        signals.filter(signal =>
          signal.key !== String(key)
        );

      next.unshift({
        key: String(key),
        value: value ?? "--",
        timestamp:
          row.timestamp ||
          row.server_timestamp ||
          row.server_rx_ts ||
          ""
      });

      deviceRecentSignals[canonical] =
        next.slice(0, 4);
    }

    // Repaint from the accumulated cache at most once every 700 ms.
    if (now - previous < HMI_SIGNAL_RENDER_MS) {
      return;
    }

    hmiLastSignalRenderAt[canonical] = now;

    originalUpdateDevicePanelSignals(
      canonical,
      row
    );
  };
}

/*
----------------------------------------------
Better graph live readout: value + time
----------------------------------------------
*/
/**
 * @brief Create or update a graph tile's live signal, time, and value readout.
 * @param label Human-readable label.
 */
function hmiSetGraphReadout(tile, key, value, label) {
  // A missing graph tile has no safe location for a live value/time label.
  if (!tile) {
    return;
  }

  // Reuse the tile's readout or create and attach one beneath its header on the
  // first live point, falling back to the tile itself if the header is absent.
  let readout =
    tile.querySelector(".graphLiveReadout");

  if (!readout) {
    readout =
      document.createElement("div");

    readout.className =
      "graphLiveReadout";

    const header =
      tile.querySelector(".inspectorGraphTileHeader");

    if (header) {
      header.appendChild(readout);
    } else {
      tile.prepend(readout);
    }
  }

  // Show the signal's operator label together with the source time and latest formatted value.
  readout.textContent =
    `${displayName(key)} | Time: ${label} | Value: ${formatControlValue(value)}`;
}

/*
----------------------------------------------
Replace live inspector graph update with throttled version
----------------------------------------------
*/
if (typeof updateInspectorGraphsFromLive === "function") {
  /**
   * @brief Update inspector graphs from live.
   */
  updateInspectorGraphsFromLive = function patchedUpdateInspectorGraphsFromLive(device) {
    // Live graph work is useful only for the selected device's visible graph tab
    // after at least one Chart.js instance has been created.
    if (
      inspectorTab !== "graph" ||
      !isSelectedDevice(device) ||
      !inspectorCharts.length
    ) {
      return;
    }

    // Limit each physical device's graph redraw to once per second while still
    // allowing packet handlers to retain every latest field value.
    const canonical =
      canonicalInspectorDevice(device);

    const nowMs = Date.now();
    const previous =
      hmiLastInspectorGraphAt[canonical] || 0;

    if (
      nowMs - previous <
      HMI_INSPECTOR_GRAPH_RENDER_MS
    ) {
      return;
    }

    hmiLastInspectorGraphAt[canonical] =
      nowMs;

    const state =
      liveDeviceState[canonical] ||
      liveDeviceState[device];

    if (!state) {
      return;
    }

    // Flatten nested retained telemetry into both dotted and underscore keys so
    // charts created from either database column style can find their live value.
    const values =
      new Map();

    flattenTelemetryFields(state)
      .forEach(([key, value]) => {
        values.set(String(key), value);
        values.set(
          String(key).replace(/\./g, "_"),
          value
        );
      });

    // Use packet/device/server time for the x-axis label, with browser time only
    // when the retained packet has no timestamp metadata.
    const label =
      state.packet_ts ||
      state.device_ts ||
      state.server_rx_ts ||
      new Date().toLocaleTimeString();

    // Append one finite value to every matching chart, cap each line at 120
    // points, refresh its header/readout, and redraw without animation.
    inspectorCharts.forEach(chart => {
      const key =
        chart.$telemetryKey;

      const value =
        Number(values.get(key));

      if (
        !key ||
        !Number.isFinite(value)
      ) {
        return;
      }

      const labels =
        chart.data.labels ||
        (chart.data.labels = []);

      const points =
        chart.data.datasets?.[0]?.data;

      if (!points) {
        return;
      }

      labels.push(label);
      points.push(value);

      if (labels.length > 120) {
        labels.shift();
      }

      if (points.length > 120) {
        points.shift();
      }

      const tile =
        chart.canvas?.closest(
          ".inspectorGraphTile"
        );

      const latest =
        tile?.querySelector(
          ".inspectorGraphTileHeader span"
        );

      if (latest) {
        latest.textContent =
          formatControlValue(value);
      }

      hmiSetGraphReadout(
        tile,
        key,
        value,
        label
      );

      chart.update("none");
    });
  };
}

/*
----------------------------------------------
Make inspector graph tiles include readout even on initial load
----------------------------------------------
*/
if (typeof loadInspectorGraph === "function") {
  // Preserve history loading and add missing live-readout mounts after its asynchronous DOM render completes.
  const originalLoadInspectorGraph =
    loadInspectorGraph;

  /**

   * @brief Load inspector graph.

   * @param force When true, bypass cached or throttled loading behavior.

   * @async

   */

  loadInspectorGraph = async function patchedLoadInspectorGraph(force = false) {
    await originalLoadInspectorGraph(force);

    // Ensure every initial graph tile has a readout, using its displayed latest
    // value until the first live packet supplies a signal name and timestamp.
    document
      .querySelectorAll(".inspectorGraphTile")
      .forEach(tile => {
        if (!tile.querySelector(".graphLiveReadout")) {
          const span =
            tile.querySelector(
              ".inspectorGraphTileHeader span"
            );

          const value =
            span ? span.textContent : "--";

          const readout =
            document.createElement("div");

          readout.className =
            "graphLiveReadout";

          readout.textContent =
            `Signal: -- | Time: -- | Value: ${value}`;

          const header =
            tile.querySelector(
              ".inspectorGraphTileHeader"
            );

          if (header) {
            header.appendChild(readout);
          }
        }
      });
  };
}

// Start the HMI after all renderer wrappers are installed. A rejected startup
// promise is logged and converted into explicit status and inspector error panels.
init().catch(err => {

  console.error(
    "HMI startup failed:",
    err
  );

  setHtml(
    "hmiStatus",
    '<div class="hmiPowerSummary"><span class="summaryOff">STARTUP ERROR</span></div>'
  );

  setHtml(
    "hmiDeviceInfo",
    '<div class="deviceInspectorEmpty"><h2>HMI startup error</h2></div>'
  );
});
      
    // Build the inspector header, tab controls, status/usage summaries, and the
    // active tab body from the selected device's current cached state. Overview
    // delegates to specialized renderers; event, audit, history, graph, and
    // diagnostics tabs use their corresponding bounded browser collections.
