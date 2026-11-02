/*
 * ================================================================
 * CRITICAL CONTROL BOARD
 * ================================================================
 *
 * LIVE SCADA OPERATOR VIEW
 *
 * Rules:
 *
 * 1. Every telemetry field has a unique identity:
 *
 *      SOURCE IP
 *      + DEVICE
 *      + CHANNEL
 *      + FIELD
 *
 * 2. Controls are never globally mixed between devices.
 *
 * 3. Buttons are momentary:
 *      PRESSED / IDLE
 *
 * 4. Switches are:
 *      ON / OFF
 *
 * 5. Knobs show their telemetry value.
 *
 * 6. No commands are sent from this page.
 *
 * 7. If the source device stops transmitting, its controls
 *    automatically return to OFF/IDLE after the timeout.
 *
 * ================================================================
 */


/* ================================================================
   PHYSICAL CONTROLS
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
   STATE
   ================================================================ */

const latest =
  new Map();

const events = [];

const rpmHistory = [];

const sourceDeviceLastRx =
  new Map();

let lastRender = 0;


/*
 * Device heartbeat timeout.
 *
 * If no packet is received from a source/device for this period,
 * controls are rendered as OFF/IDLE.
 */
const CONTROL_STALE_MS = 5000;


/* ================================================================
   HELPERS
   ================================================================ */

function db() {
  return App.db || "";
}


function normalizeKey(value) {

  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[\s\-./]+/g, "_");
}


function cleanDevice(value) {

  try {
    return canonicalDeviceName(
      String(value || "")
    );
  } catch (_) {
    return String(value || "").trim();
  }
}


function getKey(row) {

  return String(
    row?.key ??
    row?.value_key ??
    row?.field ??
    row?.name ??
    ""
  ).trim();
}


function getValue(row) {

  if (!row) {
    return null;
  }

  if (row.value_type === "text") {
    return row.value_text;
  }

  if (
    row.value !== undefined &&
    row.value !== null
  ) {
    return row.value;
  }

  if (
    row.value_num !== undefined &&
    row.value_num !== null
  ) {
    return row.value_num;
  }

  if (
    row.value_text !== undefined &&
    row.value_text !== null
  ) {
    return row.value_text;
  }

  return null;
}


function sourceIp(row) {

  return String(
    row?.source_ip ??
    row?.src_ip ??
    row?.ip ??
    ""
  ).trim();
}


function sourcePort(row) {

  return row?.source_port ??
    row?.src_port ??
    "";
}


function channel(row) {

  return String(
    row?.channel ??
    row?.channel_name ??
    ""
  ).trim();
}


function rowTimestamp(row) {

  return String(
    row?.timestamp ??
    row?.server_rx_ts ??
    row?.ts ??
    row?.time ??
    new Date().toISOString()
  );
}


function displayValue(value, fallback = "--") {

  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return fallback;
  }

  if (typeof value === "number") {

    if (!Number.isFinite(value)) {
      return fallback;
    }

    return Number.isInteger(value)
      ? String(value)
      : value
          .toFixed(3)
          .replace(/0+$/, "")
          .replace(/\.$/, "");
  }

  return String(value);
}


function numericValue(value) {

  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const n =
    Number(value);

  return Number.isFinite(n)
    ? n
    : null;
}


function esc(value) {

  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}


function setText(
  id,
  value,
  fallback = "--"
) {

  const el =
    $(id);

  if (!el) {
    return;
  }

  el.textContent =
    displayValue(
      value,
      fallback
    );
}


/* ================================================================
   LIVE IDENTITY
   ================================================================ */

function rowIdentity(row) {

  return [
    sourceIp(row),
    cleanDevice(
      row?.device ||
      row?.device_name
    ),
    channel(row),
    getKey(row)
  ].join("::");
}


function sourceDeviceIdentity(row) {

  return [
    sourceIp(row),
    cleanDevice(
      row?.device ||
      row?.device_name
    )
  ].join("::");
}


/* ================================================================
   FRESHNESS
   ================================================================ */

function rowReceiveTime(row) {

  if (
    Number.isFinite(
      Number(row?._receivedAtMs)
    )
  ) {
    return Number(
      row._receivedAtMs
    );
  }

  const parsed =
    Date.parse(
      rowTimestamp(row)
    );

  return Number.isFinite(parsed)
    ? parsed
    : 0;
}


function isFresh(row) {

  if (!row) {
    return false;
  }

  const sourceDevice =
    sourceDeviceIdentity(row);

  const packetTime =
    Number(
      sourceDeviceLastRx.get(
        sourceDevice
      ) || 0
    );

  if (packetTime > 0) {

    return (
      Date.now() - packetTime
    ) <= CONTROL_STALE_MS;
  }

  const fieldTime =
    rowReceiveTime(row);

  if (!fieldTime) {
    return false;
  }

  return (
    Date.now() - fieldTime
  ) <= CONTROL_STALE_MS;
}


/* ================================================================
   BOOLEAN STATE
   ================================================================ */

function isTrue(value) {

  const s =
    normalizeKey(value);

  return (
    s === "1" ||
    s === "TRUE" ||
    s === "ON" ||
    s === "ACTIVE" ||
    s === "ENABLED" ||
    s === "PRESSED" ||
    s === "HIGH"
  )
  ||
  (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0.5
  )
  ||
  (
    typeof value === "string" &&
    Number.isFinite(Number(value)) &&
    Number(value) > 0.5
  );
}


function isFalse(value) {

  const s =
    normalizeKey(value);

  return (
    s === "0" ||
    s === "FALSE" ||
    s === "OFF" ||
    s === "INACTIVE" ||
    s === "DISABLED" ||
    s === "IDLE" ||
    s === "LOW"
  )
  ||
  (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value <= 0.5
  );
}


/* ================================================================
   STATE CLASS
   ================================================================ */

function setStateClass(
  element,
  state
) {

  if (!element) {
    return;
  }

  element.classList.remove(
    "online",
    "ready",
    "warning",
    "fault",
    "offline",
    "unknown"
  );

  const s =
    normalizeKey(state);

  if (
    s.includes("FAULT") ||
    s.includes("ERROR")
  ) {

    element.classList.add(
      "fault"
    );

    return;
  }

  if (
    s.includes("OFFLINE") ||
    s.includes("DISCONNECTED")
  ) {

    element.classList.add(
      "offline"
    );

    return;
  }

  if (
    s.includes("WARN")
  ) {

    element.classList.add(
      "warning"
    );

    return;
  }

  if (
    s.includes("ONLINE") ||
    s.includes("READY") ||
    s.includes("RUNNING") ||
    s.includes("ACTIVE") ||
    s.includes("OK")
  ) {

    element.classList.add(
      "online"
    );

    return;
  }

  element.classList.add(
    "unknown"
  );
}


/* ================================================================
   FIELD LOOKUP
   ================================================================ */

function findField(
  deviceNames,
  fieldNames
) {

  const devices =
    new Set(
      deviceNames.map(
        normalizeKey
      )
    );

  const fields =
    new Set(
      fieldNames.map(
        normalizeKey
      )
    );

  /*
   * Prefer fresh data.
   */
  for (
    const row of latest.values()
  ) {

    const d =
      normalizeKey(
        cleanDevice(
          row.device ||
          row.device_name
        )
      );

    const k =
      normalizeKey(
        getKey(row)
      );

    if (
      devices.has(d) &&
      fields.has(k) &&
      isFresh(row)
    ) {

      return getValue(row);
    }
  }

  /*
   * Return stale data only for informational fields.
   */
  for (
    const row of latest.values()
  ) {

    const d =
      normalizeKey(
        cleanDevice(
          row.device ||
          row.device_name
        )
      );

    const k =
      normalizeKey(
        getKey(row)
      );

    if (
      devices.has(d) &&
      fields.has(k)
    ) {

      return getValue(row);
    }
  }

  return null;
}


function findAnyField(
  fieldNames
) {

  const fields =
    new Set(
      fieldNames.map(
        normalizeKey
      )
    );

  /*
   * Fresh values first.
   */
  for (
    const row of latest.values()
  ) {

    const k =
      normalizeKey(
        getKey(row)
      );

    if (
      fields.has(k) &&
      isFresh(row)
    ) {

      return getValue(row);
    }
  }

  /*
   * Then stale informational values.
   */
  for (
    const row of latest.values()
  ) {

    const k =
      normalizeKey(
        getKey(row)
      );

    if (
      fields.has(k)
    ) {

      return getValue(row);
    }
  }

  return null;
}


/* ================================================================
   TELEMETRY INGESTION
   ================================================================ */

function rowsFromMessage(
  message
) {

  if (!message) {
    return [];
  }

  /*
   * Use the common telemetry parser already supplied by common.js.
   */
  if (
    typeof liveRowsFromScadaEvent ===
    "function"
  ) {

    const rows =
      liveRowsFromScadaEvent(
        message
      );

    const now =
      Date.now();

    return rows.map(row => {

      const normalizedDevice =
        cleanDevice(
          row.device ||
          row.device_name ||
          message.device ||
          message.device_name
        );

      const normalizedIp =
        row.source_ip ||
        message.source_ip ||
        "";

      const normalizedChannel =
        row.channel ||
        row.channel_name ||
        message.channel ||
        message.channel_name ||
        "";

      return {
        ...row,

        device:
          normalizedDevice,

        source_ip:
          normalizedIp,

        source_port:
          row.source_port ||
          message.source_port ||
          0,

        channel:
          normalizedChannel,

        timestamp:
          row.timestamp ||
          row.server_rx_ts ||
          message.timestamp ||
          message.server_rx_ts ||
          new Date().toISOString(),

        _receivedAtMs:
          now
      };
    });
  }

  /*
   * Fallback parser.
   */
  const payload =
    parseLivePayload(
      message?.payload
    )
    ||
    message?.body
    ||
    message;

  if (
    !payload ||
    typeof payload !== "object"
  ) {
    return [];
  }

  const flattened = [];

  flattenLivePayload(
    payload,
    "",
    flattened
  );

  const now =
    Date.now();

  return flattened.map(item => ({
    ...item,

    device:
      cleanDevice(
        message.device ||
        message.device_name ||
        ""
      ),

    source_ip:
      message.source_ip ||
      "",

    source_port:
      message.source_port ||
      0,

    channel:
      message.channel ||
      message.channel_name ||
      "",

    timestamp:
      message.timestamp ||
      message.server_rx_ts ||
      new Date().toISOString(),

    _receivedAtMs:
      now
  }));
}


/* ================================================================
   INGEST ROWS
   ================================================================ */

function ingestRows(rows) {

  if (!Array.isArray(rows)) {
    return;
  }

  const now =
    Date.now();

  rows.forEach(row => {

    const field =
      getKey(row);

    if (!field) {
      return;
    }

    const normalizedDevice =
      cleanDevice(
        row.device ||
        row.device_name
      );

    const normalized = {

      ...row,

      device:
        normalizedDevice,

      source_ip:
        sourceIp(row),

      channel:
        channel(row),

      _receivedAtMs:
        Number(
          row._receivedAtMs
        ) || now
    };

    /*
     * Update device heartbeat.
     */
    const sourceDevice =
      sourceDeviceIdentity(
        normalized
      );

    const previousPacket =
      Number(
        sourceDeviceLastRx.get(
          sourceDevice
        ) || 0
      );

    const receiveTime =
      normalized._receivedAtMs;

    if (
      receiveTime >
      previousPacket
    ) {

      sourceDeviceLastRx.set(
        sourceDevice,
        receiveTime
      );
    }

    /*
     * IMPORTANT:
     *
     * This is the full identity.
     *
     * Same field name on another source IP
     * is a completely different value.
     */
    const identity =
      rowIdentity(
        normalized
      );

    const previous =
      latest.get(
        identity
      );

    latest.set(
      identity,
      normalized
    );

    /*
     * State change history.
     */
    if (
      previous &&
      String(
        getValue(previous)
      ) !==
      String(
        getValue(normalized)
      )
    ) {

      addEvent(
        normalizedDevice,
        field,
        getValue(previous),
        getValue(normalized),
        normalized.timestamp
      );
    }
  });

  renderAll();
}


/* ================================================================
   EVENTS
   ================================================================ */

function addEvent(
  device,
  field,
  previous,
  current,
  timestamp
) {

  events.unshift({

    device,

    field,

    previous,

    current,

    timestamp:
      timestamp ||
      new Date().toISOString()
  });

  if (
    events.length > 20
  ) {

    events.length = 20;
  }
}


/* ================================================================
   DEVICE DEFINITIONS
   ================================================================ */

const DEVICE_DEFINITIONS = [

  {
    id: "DRIVE_UNIT",
    label: "DRIVE",

    fields: [
      [
        "RPM",
        ["rpm", "body_rpm"]
      ],
      [
        "CURRENT",
        ["current", "actual_current"]
      ]
    ]
  },

  {
    id: "CAMERA_UNIT",
    label: "CAMERA",

    fields: [
      [
        "MODE",
        ["mode", "camera_mode"]
      ],
      [
        "TRACK",
        ["tracking", "track"]
      ]
    ]
  },

  {
    id: "BUTTON_LED_UNIT",
    label: "BUTTON / LED",

    fields: [
      [
        "ACTIVE",
        ["active_buttons", "active"]
      ],
      [
        "STATUS",
        ["status", "system_status"]
      ]
    ]
  },

  {
    id: "IMU_UNIT",
    label: "IMU",

    fields: [
      [
        "ROLL",
        ["roll"]
      ],
      [
        "PITCH",
        ["pitch"]
      ]
    ]
  },

  {
    id: "CCE_GATEWAY",
    label: "CCE",

    fields: [
      [
        "MODE",
        ["mode", "cce_mode"]
      ],
      [
        "STATUS",
        ["status", "system_status"]
      ]
    ]
  },

  {
    id: "LCU_UNIT",
    label: "LCU",

    fields: [
      [
        "STATUS",
        ["status", "system_status"]
      ],
      [
        "ALIVE",
        ["alive", "heartbeat"]
      ]
    ]
  },

  {
    id: "WCS_CONSOLE",
    label: "WCS",

    fields: [
      [
        "STATUS",
        ["status", "system_status"]
      ],
      [
        "MODE",
        ["mode"]
      ]
    ]
  },

  {
    id: "MAIN_DISPLAY",
    label: "DISPLAY",

    fields: [
      [
        "STATUS",
        ["status", "system_status"]
      ],
      [
        "MODE",
        ["mode"]
      ]
    ]
  },

  {
    id: "ADVANTECH_IO",
    label: "I/O",

    fields: [
      [
        "STATUS",
        ["status", "system_status"]
      ],
      [
        "HEALTH",
        ["health"]
      ]
    ]
  }

];


/* ================================================================
   DEVICE ROWS
   ================================================================ */

function deviceRows(
  deviceId
) {

  return Array.from(
    latest.values()
  ).filter(
    row =>
      normalizeKey(
        cleanDevice(
          row.device ||
          row.device_name
        )
      ) ===
      normalizeKey(
        deviceId
      )
  );
}


function deviceIsOnline(
  deviceId
) {

  const rows =
    deviceRows(
      deviceId
    );

  if (!rows.length) {
    return false;
  }

  /*
   * Device heartbeat takes priority.
   */
  const live =
    rows.some(
      row =>
        isFresh(row)
    );

  if (!live) {
    return false;
  }

  const connection =
    rows.find(
      row => {

        const k =
          normalizeKey(
            getKey(row)
          );

        return [
          "CONNECTED",
          "CONNECTION",
          "ONLINE",
          "ALIVE",
          "HEALTH"
        ].includes(k);
      }
    );

  if (!connection) {
    return true;
  }

  const v =
    getValue(
      connection
    );

  return !(
    isFalse(v) ||
    normalizeKey(v)
      .includes("OFFLINE") ||
    normalizeKey(v)
      .includes("DISCONNECTED")
  );
}


/* ================================================================
   DEVICE MICRO BLOCKS
   ================================================================ */

function renderDeviceMicroBlocks() {

  const container =
    $("deviceMicroBlocks");

  if (!container) {
    return;
  }

  container.innerHTML =
    DEVICE_DEFINITIONS
      .map(deviceDefinition => {

        const rows =
          deviceRows(
            deviceDefinition.id
          );

        const online =
          deviceIsOnline(
            deviceDefinition.id
          );

        let state =
          "UNKNOWN";

        let stateClass =
          "unknown";

        if (rows.length) {

          state =
            online
              ? "ONLINE"
              : "OFFLINE";

          stateClass =
            online
              ? "online"
              : "offline";
        }

        const values =
          deviceDefinition.fields
            .map(definition => {

              const v =
                findField(
                  [
                    deviceDefinition.id
                  ],
                  definition[1]
                );

              return `
                <div
                  class="device-mini-value"
                >

                  <span>
                    ${esc(
                      definition[0]
                    )}
                  </span>

                  <strong>
                    ${esc(
                      displayValue(v)
                    )}
                  </strong>

                </div>
              `;
            })
            .join("");

        return `
          <div
            class="
              device-micro
              ${stateClass}
            "
          >

            <div
              class="device-micro-header"
            >

              <span
                class="device-micro-name"
              >
                ${esc(
                  deviceDefinition.label
                )}
              </span>

              <span
                class="device-micro-lamp"
              ></span>

            </div>

            <div
              class="device-micro-state"
            >
              ${esc(state)}
            </div>

            <div
              class="device-micro-data"
            >
              ${values}
            </div>

          </div>
        `;
      })
      .join("");
}


/* ================================================================
   EXACT PHYSICAL CONTROL LOOKUP
   ================================================================ */

function findControlRow(
  controlName
) {

  const wanted =
    normalizeKey(
      controlName
    );

  /*
   * Actual button panel devices first.
   */
  const preferredDevices = [
    "BUTTON_LED_UNIT",
    "LCU_UNIT",
    "CCE_GATEWAY"
  ];

  for (
    const preferredDevice of preferredDevices
  ) {

    for (
      const row of latest.values()
    ) {

      if (
        normalizeKey(
          cleanDevice(
            row.device ||
            row.device_name
          )
        ) !==
        normalizeKey(
          preferredDevice
        )
      ) {
        continue;
      }

      if (!isFresh(row)) {
        continue;
      }

      const key =
        normalizeKey(
          getKey(row)
        );

      if (
        key === wanted ||
        key.endsWith(
          "_" + wanted
        ) ||
        key.endsWith(
          "." + wanted
        )
      ) {

        return row;
      }
    }
  }

  /*
   * Exact fallback.
   */
  for (
    const row of latest.values()
  ) {

    if (!isFresh(row)) {
      continue;
    }

    const key =
      normalizeKey(
        getKey(row)
      );

    if (
      key === wanted
    ) {

      return row;
    }
  }

  return null;
}


/* ================================================================
   BUTTON PANEL
   ================================================================ */

function renderButtons() {

  const panel =
    $("buttonPanel");

  if (!panel) {
    return;
  }

  panel.innerHTML =
    BUTTON_IDS
      .map(name => {

        const row =
          findControlRow(
            name
          );

        let state =
          "NO TELEMETRY";

        let cls = "";

        if (row) {

          const v =
            getValue(row);

          if (isTrue(v)) {

            state =
              "PRESSED";

            cls =
              "pressed";

          } else {

            state =
              "IDLE";
          }

        }

        return `
          <div
            class="
              physical-button
              ${cls}
            "
            data-control="${esc(name)}"
          >

            <span
              class="control-name"
            >
              ${esc(name)}
            </span>

            <span
              class="control-state"
            >
              ${esc(state)}
            </span>

          </div>
        `;
      })
      .join("");
}


/* ================================================================
   SWITCH PANEL
   ================================================================ */

function renderSwitches() {

  const panel =
    $("switchPanel");

  if (!panel) {
    return;
  }

  panel.innerHTML =
    SWITCH_IDS
      .map(name => {

        const row =
          findControlRow(
            name
          );

        let state =
          "NO TELEMETRY";

        let cls = "";

        if (row) {

          const v =
            getValue(row);

          if (isTrue(v)) {

            state =
              "ON";

            cls =
              "on";

          } else {

            state =
              "OFF";

            cls =
              "off";
          }
        }

        return `
          <div
            class="
              physical-switch
              ${cls}
            "
            data-control="${esc(name)}"
          >

            <div
              class="switch-body"
            >

              <div
                class="switch-lever"
              ></div>

            </div>

            <div>

              <div
                class="switch-name"
              >
                ${esc(name)}
              </div>

              <div
                class="switch-state"
              >
                ${esc(state)}
              </div>

            </div>

          </div>
        `;
      })
      .join("");
}


/* ================================================================
   KNOBS
   ================================================================ */

function renderKnobs() {

  const panel =
    $("knobPanel");

  if (!panel) {
    return;
  }

  panel.innerHTML =
    KNOB_IDS
      .map(name => {

        const row =
          findControlRow(
            name
          );

        const value =
          row
            ? getValue(row)
            : null;

        const numeric =
          numericValue(
            value
          );

        const angle =
          numeric === null
            ? 0
            : Math.max(
                -135,
                Math.min(
                  135,
                  numeric
                )
              );

        return `
          <div
            class="physical-knob"
          >

            <div
              class="knob-face"
              style="
                --knob-angle:
                  ${angle}deg
              "
            ></div>

            <div>

              <div
                class="knob-name"
              >
                ${esc(name)}
              </div>

              <div
                class="knob-value"
              >
                ${esc(
                  displayValue(
                    value,
                    "NO TELEMETRY"
                  )
                )}
              </div>

            </div>

          </div>
        `;
      })
      .join("");
}


/* ================================================================
   DRIVE
   ================================================================ */

function renderDrive() {

  const rpm =
    findField(
      ["DRIVE_UNIT"],
      [
        "rpm",
        "body_rpm"
      ]
    );

  const current =
    findField(
      ["DRIVE_UNIT"],
      [
        "current",
        "actual_current"
      ]
    );

  const voltage =
    findField(
      ["DRIVE_UNIT"],
      [
        "voltage",
        "dcbus_volt"
      ]
    );

  const connected =
    findField(
      ["DRIVE_UNIT"],
      [
        "connected",
        "drive_connected",
        "body_dio_connected"
      ]
    );

  const fault =
    findField(
      ["DRIVE_UNIT"],
      [
        "fault",
        "fault_raw",
        "body_fault_bits"
      ]
    );

  const status =
    findField(
      ["DRIVE_UNIT"],
      [
        "status",
        "system_status",
        "body_status"
      ]
    );

  const torque =
    findField(
      ["DRIVE_UNIT"],
      [
        "torque",
        "torque_nm"
      ]
    );

  setText(
    "driveRpm",
    rpm
  );

  setText(
    "driveCurrent",
    current
  );

  setText(
    "driveVoltage",
    voltage
  );

  setText(
    "driveConnection",
    connected
  );

  setText(
    "driveFault",
    fault
  );

  setText(
    "driveStatus",
    status
  );

  setText(
    "driveTorque",
    torque
  );

  const state =
    status ??
    connected ??
    "UNKNOWN";

  setText(
    "driveIndicator",
    state,
    "UNKNOWN"
  );

  setStateClass(
    $("driveIndicator"),
    state
  );

  const rpmNumber =
    numericValue(
      rpm
    );

  if (rpmNumber !== null) {

    const rpmBar =
      $("rpmBar");

    if (rpmBar) {

      rpmBar.style.width =
        Math.min(
          100,
          Math.max(
            0,
            Math.abs(
              rpmNumber
            ) / 3000 *
            100
          )
        ) + "%";
    }

    rpmHistory.push(
      rpmNumber
    );

    if (
      rpmHistory.length > 80
    ) {

      rpmHistory.shift();
    }

    renderRpmGraph();
  }
}


/* ================================================================
   RPM GRAPH
   ================================================================ */

function renderRpmGraph() {

  const line =
    $("rpmLine");

  if (
    !line ||
    rpmHistory.length < 2
  ) {
    return;
  }

  const max =
    Math.max(
      100,
      ...rpmHistory.map(
        Math.abs
      )
    );

  const width = 600;
  const height = 130;

  const points =
    rpmHistory
      .map(
        (value, index) => {

          const x =
            index /
            (
              rpmHistory.length - 1
            ) *
            width;

          const y =
            height -
            (
              Math.abs(value) /
              max
            ) *
            (
              height - 10
            ) -
            5;

          return (
            `${x.toFixed(1)},` +
            `${y.toFixed(1)}`
          );
        }
      )
      .join(" ");

  line.setAttribute(
    "points",
    points
  );
}


/* ================================================================
   MOTION / GEO
   ================================================================ */

function renderMotion() {

  setText(
    "panValue",
    findField(
      ["DRIVE_UNIT"],
      [
        "pan",
        "pan_angle",
        "pan_actual_deg"
      ]
    )
  );

  setText(
    "tiltValue",
    findField(
      ["DRIVE_UNIT"],
      [
        "tilt",
        "tilt_angle",
        "tilt_actual_deg"
      ]
    )
  );

  setText(
    "bearingValue",
    findAnyField([
      "bearing",
      "target_bearing"
    ])
  );

  setText(
    "elevationValue",
    findAnyField([
      "elevation",
      "target_elevation"
    ])
  );

  setText(
    "latitudeValue",
    findAnyField([
      "latitude",
      "lat"
    ])
  );

  setText(
    "longitudeValue",
    findAnyField([
      "longitude",
      "lon"
    ])
  );

  setText(
    "altitudeValue",
    findAnyField([
      "altitude",
      "alt"
    ])
  );

  setText(
    "headingValue",
    findAnyField([
      "heading",
      "track"
    ])
  );
}


/* ================================================================
   CAMERA
   ================================================================ */

function renderCamera() {

  const devices = [
    "CAMERA_UNIT",
    "CCE_GATEWAY"
  ];

  const mode =
    findField(
      devices,
      [
        "mode",
        "camera_mode"
      ]
    );

  const dayNight =
    findAnyField([
      "day_night",
      "daynight",
      "day_mode"
    ]);

  const thermal =
    findAnyField([
      "thermal",
      "thermal_on"
    ]);

  const lowLight =
    findAnyField([
      "low_light",
      "lowlight"
    ]);

  const lrf =
    findAnyField([
      "lrf",
      "lrf_on"
    ]);

  const tracking =
    findAnyField([
      "tracking",
      "track",
      "tracking_state"
    ]);

  const zoom =
    findAnyField([
      "zoom",
      "zoom_level"
    ]);

  const range =
    findAnyField([
      "range",
      "target_range"
    ]);

  const bearing =
    findAnyField([
      "bearing",
      "target_bearing"
    ]);

  const elevation =
    findAnyField([
      "elevation",
      "target_elevation"
    ]);

  const health =
    findAnyField([
      "health",
      "camera_health"
    ]);

  setText(
    "cameraMode",
    mode,
    "NO DATA"
  );

  setText(
    "cameraDayNight",
    dayNight
  );

  setText(
    "cameraThermal",
    thermal
  );

  setText(
    "cameraLowLight",
    lowLight
  );

  setText(
    "cameraLrf",
    lrf
  );

  setText(
    "cameraTracking",
    tracking
  );

  setText(
    "cameraZoom",
    zoom
  );

  setText(
    "cameraRange",
    range
  );

  setText(
    "cameraBearing",
    bearing
  );

  setText(
    "cameraElevation",
    elevation
  );

  setText(
    "cameraHealth",
    health
  );

  const state =
    health ??
    "UNKNOWN";

  setText(
    "cameraState",
    state,
    "UNKNOWN"
  );

  setStateClass(
    $("cameraState"),
    state
  );
}


/* ================================================================
   RTS
   ================================================================ */

function renderRts() {

  const mode =
    findAnyField([
      "rts_mode",
      "mode"
    ]);

  const target =
    findAnyField([
      "target",
      "target_id"
    ]);

  const range =
    findAnyField([
      "target_range",
      "range"
    ]);

  const bearing =
    findAnyField([
      "target_bearing",
      "bearing"
    ]);

  const elevation =
    findAnyField([
      "target_elevation",
      "elevation"
    ]);

  const status =
    findAnyField([
      "rts_status",
      "status"
    ]);

  setText(
    "rtsMode",
    mode
  );

  setText(
    "rtsTarget",
    target
  );

  setText(
    "rtsRange",
    range
  );

  setText(
    "rtsBearing",
    bearing
  );

  setText(
    "rtsElevation",
    elevation
  );

  setText(
    "rtsStatus",
    status
  );

  setText(
    "rtsState",
    status,
    "UNKNOWN"
  );

  setStateClass(
    $("rtsState"),
    status
  );
}


/* ================================================================
   CCE / BCU
   ================================================================ */

function renderCce() {

  const cceMode =
    findAnyField([
      "cce_mode",
      "mode"
    ]);

  const bcuMode =
    findAnyField([
      "bcu_mode",
      "bcu"
    ]);

  const controlSource =
    findAnyField([
      "ctrl_src",
      "control_source",
      "control_src"
    ]);

  const connection =
    findField(
      ["CCE_GATEWAY"],
      [
        "connected",
        "connection",
        "online"
      ]
    );

  const heartbeat =
    findAnyField([
      "heartbeat",
      "heartbeat_ms"
    ]);

  const status =
    findField(
      ["CCE_GATEWAY"],
      [
        "status",
        "system_status"
      ]
    );

  setText(
    "cceMode",
    cceMode
  );

  setText(
    "bcuMode",
    bcuMode
  );

  setText(
    "controlSource",
    controlSource
  );

  setText(
    "cceConnection",
    connection
  );

  setText(
    "cceHeartbeat",
    heartbeat
  );

  setText(
    "cceStatus",
    status
  );

  const state =
    status ??
    connection ??
    "UNKNOWN";

  setText(
    "cceState",
    state,
    "UNKNOWN"
  );

  setStateClass(
    $("cceState"),
    state
  );
}


/* ================================================================
   TRACKER
   ================================================================ */

function renderTracker() {

  const mode =
    findAnyField([
      "tracker_mode",
      "mode"
    ]);

  const target =
    findAnyField([
      "tracker_target",
      "target",
      "target_id"
    ]);

  const lock =
    findAnyField([
      "lock",
      "target_lock",
      "locked"
    ]);

  const range =
    findAnyField([
      "target_range",
      "range"
    ]);

  const bearing =
    findAnyField([
      "target_bearing",
      "bearing"
    ]);

  const health =
    findAnyField([
      "tracker_health",
      "health"
    ]);

  setText(
    "trackerMode",
    mode
  );

  setText(
    "trackerTarget",
    target
  );

  setText(
    "trackerLock",
    lock
  );

  setText(
    "trackerRange",
    range
  );

  setText(
    "trackerBearing",
    bearing
  );

  setText(
    "trackerHealth",
    health
  );

  setText(
    "trackerState",
    health,
    "UNKNOWN"
  );

  setStateClass(
    $("trackerState"),
    health
  );
}


/* ================================================================
   IMU
   ================================================================ */

function renderImu() {

  const roll =
    findField(
      ["IMU_UNIT"],
      ["roll"]
    );

  const pitch =
    findField(
      ["IMU_UNIT"],
      ["pitch"]
    );

  const yaw =
    findField(
      ["IMU_UNIT"],
      ["yaw"]
    );

  const latitude =
    findField(
      ["IMU_UNIT"],
      [
        "latitude",
        "lat"
      ]
    );

  const longitude =
    findField(
      ["IMU_UNIT"],
      [
        "longitude",
        "lon"
      ]
    );

  const altitude =
    findField(
      ["IMU_UNIT"],
      [
        "altitude",
        "alt"
      ]
    );

  setText(
    "imuRoll",
    roll
  );

  setText(
    "imuPitch",
    pitch
  );

  setText(
    "imuYaw",
    yaw
  );

  setText(
    "imuLatitude",
    latitude
  );

  setText(
    "imuLongitude",
    longitude
  );

  setText(
    "imuAltitude",
    altitude
  );

  const state =
    (
      roll !== null ||
      pitch !== null ||
      yaw !== null
    )
      ? "ONLINE"
      : "UNKNOWN";

  setText(
    "imuState",
    state
  );

  setStateClass(
    $("imuState"),
    state
  );
}


/* ================================================================
   ALARMS
   ================================================================ */

function renderAlarms() {

  const container =
    $("alarmList");

  if (!container) {
    return;
  }

  const alarms = [];

  for (
    const row of latest.values()
  ) {

    const key =
      normalizeKey(
        getKey(row)
      );

    const value =
      getValue(row);

    const valueText =
      normalizeKey(
        value
      );

    const looksLikeFault =
      key.includes("FAULT") ||
      key.includes("ERROR") ||
      key.includes("ALARM");

    const active =
      looksLikeFault &&
      isFresh(row) &&
      !(
        value === null ||
        isFalse(value) ||
        valueText === "NONE" ||
        valueText === "OK" ||
        valueText === "NORMAL"
      );

    if (active) {

      alarms.push({

        device:
          cleanDevice(
            row.device ||
            row.device_name
          ),

        message:
          `${getKey(row)} = ` +
          `${displayValue(value)}`,

        timestamp:
          row.timestamp
      });
    }
  }

  $("alarmCount").textContent =
    String(
      alarms.length
    );

  if (!alarms.length) {

    container.innerHTML = `
      <div class="empty-state">
        NO ACTIVE ALARMS
      </div>
    `;

    return;
  }

  container.innerHTML =
    alarms
      .slice(0, 20)
      .map(alarm => `
        <div
          class="alarm-row critical"
        >

          <span
            class="alarm-lamp"
          ></span>

          <div>

            <div
              class="alarm-device"
            >
              ${esc(
                alarm.device
              )}
            </div>

            <div
              class="alarm-message"
            >
              ${esc(
                alarm.message
              )}
            </div>

          </div>

          <span
            class="alarm-time"
          >
            ${esc(
              formatTime(
                alarm.timestamp
              )
            )}
          </span>

        </div>
      `)
      .join("");
}


/* ================================================================
   TIME
   ================================================================ */

function formatTime(
  timestamp
) {

  if (!timestamp) {
    return "--:--:--";
  }

  const date =
    new Date(timestamp);

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {

    return String(
      timestamp
    ).slice(-8);
  }

  return date.toLocaleTimeString(
    [],
    {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }
  );
}


/* ================================================================
   EVENTS
   ================================================================ */

function renderEvents() {

  const container =
    $("eventList");

  if (!container) {
    return;
  }

  if (!events.length) {

    container.innerHTML = `
      <div class="empty-state">
        WAITING FOR STATE CHANGES
      </div>
    `;

    return;
  }

  container.innerHTML =
    events
      .map(event => `
        <div
          class="event-row"
        >

          <span
            class="event-time"
          >
            ${esc(
              formatTime(
                event.timestamp
              )
            )}
          </span>

          <span
            class="event-device"
          >
            ${esc(
              event.device
            )}
          </span>

          <span
            class="event-message"
          >
            ${esc(
              event.field
            )}
            :
            ${esc(
              displayValue(
                event.previous
              )
            )}
            →
            ${esc(
              displayValue(
                event.current
              )
            )}
          </span>

        </div>
      `)
      .join("");
}


/* ================================================================
   ALL LIVE DATA
   ================================================================ */

function renderLiveData() {

  const table =
    $("liveDataTable");

  if (!table) {
    return;
  }

  const rows =
    Array.from(
      latest.values()
    )
      .sort(
        (a, b) =>
          String(
            a.device
          ).localeCompare(
            String(
              b.device
            )
          )
          ||
          getKey(a).localeCompare(
            getKey(b)
          )
      );

  table.innerHTML =
    rows
      .slice(0, 5000)
      .map(row => {

        const fresh =
          isFresh(row);

        return `
          <tr>

            <td>
              ${esc(
                cleanDevice(
                  row.device ||
                  row.device_name
                )
              )}
            </td>

            <td>
              ${esc(
                row.channel ||
                row.channel_name ||
                "--"
              )}
            </td>

            <td>
              ${esc(
                getKey(row)
              )}
            </td>

            <td>
              ${esc(
                displayValue(
                  getValue(row)
                )
              )}
            </td>

            <td>
              ${esc(
                row.source_ip ||
                "--"
              )}
            </td>

            <td>
              ${esc(
                formatTime(
                  row.timestamp
                )
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
   GLOBAL STATE
   ================================================================ */

function renderGlobalState() {

  const totalDevices =
    DEVICE_DEFINITIONS.length;

  const onlineDevices =
    DEVICE_DEFINITIONS
      .filter(
        device =>
          deviceRows(
            device.id
          ).length &&
          deviceIsOnline(
            device.id
          )
      )
      .length;

  const system =
    onlineDevices === 0
      ? "NO TELEMETRY"
      : onlineDevices === totalDevices
        ? "SYSTEM READY"
        : "MONITORING";

  setText(
    "systemState",
    system
  );

  const liveCount =
    Array.from(
      latest.values()
    )
      .filter(
        isFresh
      )
      .length;

  setText(
    "telemetryState",
    liveCount
      ? "LIVE"
      : "WAITING"
  );

  setText(
    "lastUpdate",
    new Date().toLocaleTimeString(
      [],
      {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false
      }
    )
  );
}


/* ================================================================
   MASTER RENDER
   ================================================================ */

function renderAll() {

  const now =
    Date.now();

  if (
    now - lastRender < 100
  ) {
    return;
  }

  lastRender =
    now;

  renderGlobalState();

  renderDeviceMicroBlocks();

  renderDrive();

  renderMotion();

  renderButtons();

  renderSwitches();

  renderKnobs();

  renderCamera();

  renderRts();

  renderCce();

  renderTracker();

  renderImu();

  renderAlarms();

  renderEvents();

  renderLiveData();
}


/* ================================================================
   WEBSOCKET
   ================================================================ */

onScadaEvent(
  batch => {

    if (!Array.isArray(batch)) {
      return;
    }

    batch.forEach(
      message => {

        ingestRows(
          rowsFromMessage(
            message
          )
        );
      }
    );
  }
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
     * Bootstrap from database.
     *
     * IMPORTANT:
     *
     * These rows are historical.
     * Their timestamp determines whether they are still LIVE.
     */
    try {

      const data =
        await api(
          "/api/all?db=" +
          encodeURIComponent(db()) +
          "&range=30s"
        );

      let rows = [];

      if (
        Array.isArray(data)
      ) {

        rows =
          data;

      } else if (
        Array.isArray(
          data?.rows
        )
      ) {

        rows =
          data.rows;

      } else if (
        Array.isArray(
          data?.data
        )
      ) {

        rows =
          data.data;
      }

      const now =
        Date.now();

      rows.forEach(row => {

        const timestamp =
          Date.parse(
            rowTimestamp(row)
          );

        row._receivedAtMs =
          Number.isFinite(
            timestamp
          )
            ? timestamp
            : now;

        const identity =
          sourceDeviceIdentity(
            row
          );

        const old =
          Number(
            sourceDeviceLastRx.get(
              identity
            ) || 0
          );

        if (
          row._receivedAtMs > old
        ) {

          sourceDeviceLastRx.set(
            identity,
            row._receivedAtMs
          );
        }
      });

      ingestRows(
        rows
      );

    } catch (error) {

      console.error(
        "Critical dashboard telemetry bootstrap failed:",
        error
      );
    }

    renderAll();

    /*
     * Critical:
     *
     * Even if the simulator stops sending packets,
     * this timer causes all controls to transition to
     * their safe visual state.
     */
    setInterval(
      renderAll,
      1000
    );
  }
);