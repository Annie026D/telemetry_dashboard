// Run with Node (or Electron with ELECTRON_RUN_AS_NODE=1).
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
function context() {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', textContent: '', innerHTML: '',
      dataset: {}, classList: { add() {}, remove() {} }, addEventListener() {} });
    return nodes.get(id);
  };
  return vm.createContext({ console, URL, URLSearchParams, Date, Map, Set,
    location: { href: 'http://localhost/dashboard.html', search: '', host: 'localhost', protocol: 'http:' },
    document: { getElementById: node, addEventListener() {}, querySelectorAll: () => [] },
    window: { addEventListener() {} }, requestAnimationFrame: callback => callback(),
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, AbortController,
    WebSocket: { OPEN: 1, CONNECTING: 0 }, devicePixelRatio: 1,
  });
}
const load = (ctx, file) => vm.runInContext(fs.readFileSync(path.join(root, 'web', file), 'utf8'), ctx);
const ctx = context();
load(ctx, 'common.js');
load(ctx, 'drive-control.js');
vm.runInContext(`
  const input = { device: "DRIVE_UNIT", channel: "tracker_publish", source_ip: "127.0.0.2", source_port: 54321,
    timestamp: new Date().toISOString(), payload: { future_numeric: 42, body: { id: 9, value: 7, future_text: "complete" }, nothing: null } };
  const rows = liveRowsFromScadaEvent(input);
  if (!rows.every(row => row.source_ip === input.source_ip && row.source_port === 54321)) throw Error("source identity lost");
  if (!rows.some(row => row.key === "body_id")) throw Error("nested metadata filtered");
  if (!rows.some(row => row.key === "nothing")) throw Error("null dropped");
  updateRows(rows);
  updateRows(rows.map(row => ({...row, source_ip: "127.0.0.3"})));
  if (Object.keys(latest).length !== rows.length * 2) throw Error("sources merged");
  if (!Object.values(history).some(points => points.some(point => point.value === 42))) throw Error("numeric trend missing");
  const old = new Date(Date.now() - 60000).toISOString();
  updateRows([{device_name:"DRIVE_UNIT",channel_name:"tracker_publish",source_ip:"10.0.0.1",key:"infrequent",value_type:"num",value_num:99,timestamp:old}], false);
  const stale = Object.values(latest).find(row => row.key === "infrequent");
  if (isFresh(stale)) throw Error("snapshot treated as live");
  render();
  if (!$('allDriveFields').innerHTML.includes('infrequent')) throw Error("stale field hidden");
  if (!$('driveGraphs').innerHTML.includes('infrequent')) throw Error("stale numeric graph hidden");
  const batch = Array.from({length: 150}, (_, i) => ({...input, payload: {['field_'+i]: i}}));
  if (coalesceScadaBatch(batch).length !== 150) throw Error("partial packets silently discarded");
`, ctx);
const main = context();
load(main, 'common.js');
load(main, 'mission.js');
vm.runInContext(`missionMerge([{device_name:'NEW_DEVICE',channel_name:'new_channel',source_ip:'10.0.0.8',key:'new_field',value_type:'num',value_num:1,timestamp:new Date().toISOString()}]); missionRender(); if (!$('fleetGrid').innerHTML.includes('NEW_DEVICE')) throw Error('new device hidden');`, main);
// Parse every shipped controller, including unchanged HMI/diagnostic scripts.
for (const file of fs.readdirSync(path.join(root, 'web')).filter(file => file.endsWith('.js'))) {
  new vm.Script(fs.readFileSync(path.join(root, 'web', file), 'utf8'), { filename: file });
}
console.log('GUI checks passed: source identity, unknown fields, nulls, stale values, numeric trends, batch retention, dashboard discovery, JS syntax.');
