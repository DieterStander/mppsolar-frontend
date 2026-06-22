'use strict';
/* Inverter Console - frontend application logic (dependency-free). */

// ---------------------------------------------------------------------------
// Chart + tile definitions
// ---------------------------------------------------------------------------
const CHART_DEFS = [
  { title: 'Power', unit: 'W', yMin: 0, series: [
      { key: 'pv_input_power', label: 'PV', color: '#f5a623' },
      { key: 'ac_output_active_power', label: 'Load', color: '#4c8dff' },
      { key: 'ac_output_apparent_power', label: 'Apparent', color: '#7a86a3' } ] },
  { title: 'Battery Voltage', unit: 'V', yMin: 20, yMax: 30, series: [
      { key: 'battery_voltage', label: 'Battery', color: '#35c08a' } ] },
  { title: 'Battery Current', unit: 'A', hint: 'positive = charging · negative = discharging', series: [
      { key: 'battery_current', label: 'Current', color: '#4c8dff' } ] },
  { title: 'Battery State of Charge', unit: '%', yMin: 0, yMax: 100, series: [
      { key: 'battery_capacity', label: 'SOC', color: '#4c8dff' } ] },
  { title: 'AC Voltage', unit: 'V', yMin: 200, yMax: 250, series: [
      { key: 'ac_input_voltage', label: 'Grid', color: '#f5a623' },
      { key: 'ac_output_voltage', label: 'Output', color: '#4c8dff' } ] },
  { title: 'Heat-sink Temperature', unit: '°C', yMin: 20, yMax: 50, series: [
      { key: 'heatsink_temp', label: 'Temp', color: '#f5566c' } ] },
];

const TILE_DEFS = [
  { key: 'battery_voltage', label: 'Battery', unit: 'V', cls: 'accent', dp: 1, icon: '🔋' },
  { key: 'battery_capacity', label: 'SOC', unit: '%', cls: 'ok', dp: 0, icon: '📊' },
  { key: 'pv_input_power', label: 'PV Power', unit: 'W', cls: 'warn', dp: 0, icon: '☀️' },
  { key: 'ac_output_active_power', label: 'Load', unit: 'W', cls: 'accent', dp: 0, icon: '💡' },
  { key: 'battery_charge_current', label: 'Charge', unit: 'A', cls: 'ok', dp: 1, icon: '⬆️' },
  { key: 'battery_discharge_current', label: 'Discharge', unit: 'A', cls: '', dp: 1, icon: '⬇️' },
];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  rows: [],            // [{ts, <metric>: value, ...}]
  range: 3600,
  charts: [],
  settings: [],        // catalog + current values
  pending: {},         // key -> chosen value (only differing ones live here too)
  profiles: [],
  theme: localStorage.getItem('theme') || 'dark',
  applyingJobId: null,
  expandedChart: null,
  advancedOpen: false,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v != null) e.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c != null) e.append(c);
  return e;
}
function fmt(v, dp) {
  if (v == null || isNaN(v)) return '—';
  return Number(v).toFixed(dp);
}
// human-readable list of every value a setting accepts
function allowedText(s) {
  if (s.type === 'flag') return 'Options: Enable / Disable';
  if (s.type === 'enum') return 'Options: ' + s.options.map((o) => o.label).join(', ');
  if (s.type === 'number') {
    const f = (n) => Number(n).toFixed(1);
    let t = `Range: ${f(s.minimum)}–${f(s.maximum)}`;
    if (s.unit) t += ` ${s.unit}`;
    if (s.step) t += ` · ${f(s.step)} steps`;
    return t;
  }
  return '';
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
const api = {
  metrics: () => fetch('/api/metrics').then((r) => r.json()),
  history: (range) => fetch(`/api/history?range=${range}`).then((r) => r.json()),
  settings: (refresh) => fetch(`/api/settings${refresh ? '?refresh=1' : ''}`).then((r) => r.json()),
  apply: (items, save) => fetch('/api/settings/apply', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items, save }) }).then(handle),
  job: (id) => fetch(`/api/jobs/${id}`).then((r) => r.json()),
  profiles: () => fetch('/api/profiles').then((r) => r.json()),
  createProfile: (b) => fetch('/api/profiles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(handle),
  updateProfile: (id, b) => fetch(`/api/profiles/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(handle),
  deleteProfile: (id) => fetch(`/api/profiles/${id}`, { method: 'DELETE' }).then(handle),
  applyProfile: (id, save) => fetch(`/api/profiles/${id}/apply?save=${save}`, { method: 'POST' }).then(handle),
};
async function handle(r) {
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.detail || r.statusText); }
  return r.json();
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
async function init() {
  applyTheme(state.theme);
  buildTiles();
  buildCharts();
  wireUI();
  await loadHistory();
  connectWS();
  loadSettings();
  loadProfiles();
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  $('#theme-btn').textContent = theme === 'dark' ? '🌙' : '☀️';
  state.theme = theme;
  localStorage.setItem('theme', theme);
  state.charts.forEach((c) => c.chart.setTheme(theme));
  if (state.expandedChart) state.expandedChart.setTheme(theme);
}

// ---------------------------------------------------------------------------
// Dashboard: tiles + charts
// ---------------------------------------------------------------------------
function buildTiles() {
  const wrap = $('#tiles');
  wrap.innerHTML = '';
  for (const t of TILE_DEFS) {
    const tile = el('div', { class: `tile ${t.cls}` }, [
      el('div', { class: 'label' }, [el('span', { class: 'tile-icon' }, t.icon), t.label]),
      el('div', { class: 'value', id: `tile-${t.key}` }, [
        el('span', { class: 'num' }, '—'),
        el('span', { class: 'unit' }, t.unit),
      ]),
    ]);
    wrap.append(tile);
  }
}

function legendSpans(def) {
  return def.series.map((s) => el('span', {}, [el('i', { style: `background:${s.color}` }), s.label]));
}

function buildCharts() {
  const grid = $('#charts-grid');
  grid.innerHTML = '';
  state.charts = [];
  for (const def of CHART_DEFS) {
    const canvas = el('canvas');
    const card = el('div', { class: 'chart-card', title: 'Click to expand' }, [
      el('span', { class: 'expand-hint' }, '⤢'),
      el('h3', {}, `${def.title} (${def.unit})`),
      def.hint ? el('div', { class: 'chart-hint' }, def.hint) : null,
      el('div', { class: 'legend' }, legendSpans(def)),
      canvas,
    ]);
    card.addEventListener('click', () => openChartModal(def));
    grid.append(card);
    const chart = new TimeChart(canvas, { series: def.series, unit: def.unit,
      theme: state.theme, yMin: def.yMin, yMax: def.yMax });
    state.charts.push({ def, chart });
  }
}

function openChartModal(def) {
  $('#chart-modal-title').textContent = `${def.title} (${def.unit})`;
  const lg = $('#chart-modal-legend');
  lg.innerHTML = '';
  legendSpans(def).forEach((n) => lg.append(n));
  $('#range-group-expanded').innerHTML = $('#range-group').innerHTML;
  $('#chart-modal').classList.add('open');
  if (state.expandedChart) state.expandedChart.destroy();
  state.expandedChart = new TimeChart($('#chart-modal-canvas'),
    { series: def.series, unit: def.unit, theme: state.theme, yMin: def.yMin, yMax: def.yMax });
  const cutoff = Date.now() / 1000 - state.range;
  state.expandedChart.setData(state.rows.filter((r) => r.ts >= cutoff));
}

function closeChartModal() {
  $('#chart-modal').classList.remove('open');
  if (state.expandedChart) { state.expandedChart.destroy(); state.expandedChart = null; }
}

// set the active timespan, syncing every range selector on the page
function setRange(range) {
  if (range === state.range) return;
  state.range = range;
  $$('.range-group button').forEach((b) =>
    b.classList.toggle('active', parseInt(b.dataset.range, 10) === range));
  loadHistory();
}

async function loadHistory() {
  try {
    const data = await api.history(state.range);
    state.rows = data.samples.map(normalizeRow);
    refreshCharts();
  } catch (e) { console.warn('history load failed', e); }
}

// history rows are already flat {ts, metric:val}; add a derived signed current
// (charge positive, discharge negative) for the single-line Current chart.
function normalizeRow(s) { return augmentRow(s); }
function augmentRow(row) {
  const c = row.battery_charge_current, d = row.battery_discharge_current;
  row.battery_current = (c == null && d == null) ? null : (c || 0) - (d || 0);
  return row;
}

function refreshCharts() {
  const cutoff = Date.now() / 1000 - state.range;
  const rows = state.rows.filter((r) => r.ts >= cutoff);
  state.charts.forEach((c) => c.chart.setData(rows));
  if (state.expandedChart) state.expandedChart.setData(rows);
}

function onSample(ts, values, live) {
  const row = augmentRow(Object.assign({ ts }, values));
  state.rows.push(row);
  const cutoff = Date.now() / 1000 - Math.max(state.range, 86400);
  if (state.rows.length > 50000) state.rows = state.rows.filter((r) => r.ts >= cutoff);
  refreshCharts();
  updateTiles(values);
  $('#last-update').textContent = 'Updated ' + new Date(ts * 1000).toLocaleTimeString();
}

function updateTiles(values) {
  for (const t of TILE_DEFS) {
    const node = $(`#tile-${t.key}`);
    if (!node) continue;
    node.querySelector('.num').textContent = fmt(values[t.key], t.dp);
  }
}

// ---------------------------------------------------------------------------
// Header / status
// ---------------------------------------------------------------------------
// drive the power-flow diagram from live values + status flags
function updateFlow(live) {
  const v = live.values || {}, f = live.flags || {}, conn = live.connected;
  const setLine = (id, active, cls, reverse) => {
    const e = document.getElementById(id);
    if (!e) return;
    e.classList.toggle('active', !!(active && conn));
    ['acc', 'solar', 'charge'].forEach((c) => e.classList.remove(c));
    if (active && conn && cls) e.classList.add(cls);
    e.classList.toggle('reverse', !!reverse);
  };

  const mode = live.mode;
  // On this PI30 unit "Line" mode means the mains powers the load directly (the
  // LCD shows BYPASS) and may charge the battery — there is no separate "Bypass"
  // mode value. "Battery" means the inverter supplies the load from battery/PV.
  const utilityLoad = conn && (mode === 'Line' || mode === 'Bypass');   // mains → load (bypass arc)
  const pv = conn && ((v.pv_input_power || 0) > 5 || f.scc_charging);
  const charging = conn && (v.battery_charge_current || 0) > 0.2;
  const discharging = conn && (v.battery_discharge_current || 0) > 0.2;
  const loadOn = conn && ((v.ac_output_active_power || 0) > 2 || f.load_on);

  // grid→inverter only when the charger settings allow utility charging AND the
  // battery is actually charging from AC. With "Only Solar" charging (Charger
  // Source Priority = 03) the grid NEVER feeds the inverter — it only bypasses
  // to the load. PV and grid never mix, so grid-charging implies not solar.
  const chargerSrc = (state.settings.find((s) => s.key === 'charger_source_priority') || {}).current;
  const gridChargeAllowed = chargerSrc == null ? true : chargerSrc !== '03';
  const gridCharging = conn && gridChargeAllowed && (f.ac_charging || (charging && !f.scc_charging));
  const invToLoad = conn && loadOn && !utilityLoad;
  const gridActive = utilityLoad || gridCharging;

  setLine('flow-grid-inv', gridCharging, 'acc');
  setLine('flow-pv-inv', pv, 'solar');
  setLine('flow-inv-load', invToLoad, 'acc');
  setLine('flow-bypass', utilityLoad, 'acc');
  // inverter↔battery: charging flows down (green); discharging flows up (reverse)
  setLine('flow-inv-bat', charging || discharging, charging ? 'charge' : 'acc', discharging && !charging);

  document.getElementById('node-pv').classList.toggle('inactive', !pv);
  document.getElementById('node-grid').classList.toggle('inactive', !gridActive);
  document.getElementById('node-load').classList.toggle('inactive', !loadOn);
  document.getElementById('node-battery').classList.toggle('inactive', !conn);

  // live numbers next to each line
  const numv = (x, dp = 0) => (x == null || isNaN(x)) ? '—' : Number(x).toFixed(dp);
  const voltv = (x) => (x == null || isNaN(x)) ? '—'
    : (Math.abs(x) >= 100 ? String(Math.round(x)) : Number(x).toFixed(1));
  const setVal = (id, text, active, cls) => {
    const e = document.getElementById(id);
    if (!e) return;
    e.textContent = conn ? text : '';
    e.setAttribute('class', 'flow-val' + (conn ? (active ? ' ' + cls : ' dim') : ''));
  };
  const battI = discharging ? v.battery_discharge_current : v.battery_charge_current;
  setVal('flow-val-grid', `${voltv(v.ac_input_voltage)} V`, gridActive, 'acc');
  setVal('flow-val-pv', `${numv(v.pv_input_power)} W · ${voltv(v.pv_input_voltage)} V`, pv, 'solar');
  setVal('flow-val-load', `${numv(v.ac_output_active_power)} W · ${voltv(v.ac_output_voltage)} V`, loadOn, 'acc');
  setVal('flow-val-bat', `${numv(battI, 1)} A · ${voltv(v.battery_voltage)} V`, charging || discharging, charging ? 'charge' : 'acc');

  const soc = v.battery_capacity;
  document.getElementById('flow-soc').textContent =
    (soc == null || isNaN(soc)) ? '—' : Math.round(soc) + '%';
  const bs = document.getElementById('flow-bat-state');
  bs.textContent = charging ? 'CHARGING' : discharging ? 'DISCHARGING' : '';
  bs.setAttribute('class', 'flow-cap ' + (charging ? 'charge' : discharging ? 'disch' : ''));
}

function updateStatus(live) {
  const dot = $('#conn-dot'), txt = $('#conn-text');
  if (live.connected) { dot.className = 'dot ok'; txt.textContent = 'connected'; }
  else { dot.className = 'dot bad'; txt.textContent = live.last_error ? 'error' : 'no data'; }
  $('#mode-badge').textContent = live.mode || '—';
  updateFlow(live);
  const wb = $('#warning-banner');
  if (live.warnings && live.warnings.length) {
    wb.classList.remove('hidden');
    wb.textContent = '⚠ ' + live.warnings.join(' · ');
  } else { wb.classList.add('hidden'); }
  if (live.values) updateTiles(live.values);
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'snapshot') {
      if (m.live) updateStatus(m.live);
      if (m.settings && m.settings.length) { state.settings = m.settings; renderSettings(); }
    } else if (m.type === 'sample') {
      onSample(m.ts, m.values, m.live);
      if (m.live) updateStatus(m.live);
    } else if (m.type === 'status') {
      updateStatus(m.live);
    } else if (m.type === 'settings') {
      state.settings = m.settings; reconcilePending(); renderSettings();
    } else if (m.type === 'job') {
      onJobUpdate(m.job);
    }
  };
  ws.onclose = () => setTimeout(connectWS, 2500);
  ws.onerror = () => ws.close();
}

// ---------------------------------------------------------------------------
// Tabs / UI wiring
// ---------------------------------------------------------------------------
function wireUI() {
  $$('nav.tabs button').forEach((b) => b.addEventListener('click', () => {
    $$('nav.tabs button').forEach((x) => x.classList.remove('active'));
    $$('.view').forEach((v) => v.classList.remove('active'));
    b.classList.add('active');
    $(`#view-${b.dataset.view}`).classList.add('active');
  }));

  $('#theme-btn').addEventListener('click', () => applyTheme(state.theme === 'dark' ? 'light' : 'dark'));

  // one delegated handler covers the dashboard selector and the expanded one
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.range-group button');
    if (btn) setRange(parseInt(btn.dataset.range, 10));
  });

  $('#refresh-settings').addEventListener('click', () => loadSettings(true));
  $('#discard-changes').addEventListener('click', () => { state.pending = {}; renderSettings(); });
  $('#review-apply').addEventListener('click', openApplyModal);
  $('#save-as-profile').addEventListener('click', () => openProfileModal(null, true));

  $('#chart-modal-close').addEventListener('click', closeChartModal);
  $('#chart-modal').addEventListener('click', (e) => { if (e.target.id === 'chart-modal') closeChartModal(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeChartModal();
      $$('.modal-backdrop').forEach((b) => b.classList.remove('open'));
    }
  });

  $('#apply-cancel').addEventListener('click', closeApplyModal);
  $('#new-profile').addEventListener('click', () => openProfileModal(null, false));
  $('#profile-cancel').addEventListener('click', () => $('#profile-modal').classList.remove('open'));
  $('#profile-save').addEventListener('click', saveProfile);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
async function loadSettings(refresh) {
  try {
    const data = await api.settings(refresh);
    state.settings = data.settings || [];
    reconcilePending();
    renderSettings();
    if (data.read_at)
      $('#settings-read-at').textContent = 'Last read ' + new Date(data.read_at * 1000).toLocaleTimeString();
  } catch (e) { console.warn('settings load failed', e); }
}

// drop pending edits that now equal the (re-read) current value
function reconcilePending() {
  for (const s of state.settings) {
    if (s.key in state.pending && valuesEqual(s, state.pending[s.key], s.current))
      delete state.pending[s.key];
  }
}

function valuesEqual(setting, a, b) {
  if (a == null || b == null) return a === b;
  if (setting.type === 'number') return Number(a) === Number(b);
  if (setting.type === 'flag') return Boolean(a) === Boolean(b);
  return String(a) === String(b);
}

// effective value of a setting = pending edit if present, else current
function effectiveValue(key) {
  if (key in state.pending) return state.pending[key];
  const s = state.settings.find((x) => x.key === key);
  return s ? s.current : null;
}

// keys that other settings depend on (changing them re-renders dependents)
function controllerKeys() {
  const set = new Set();
  for (const s of state.settings) {
    if (s.depends && s.depends.max_from) set.add(s.depends.max_from);
    if (s.depends && s.depends.requires_key) set.add(s.depends.requires_key);
  }
  return set;
}

// resolve a setting's enabled state + the options it may legally offer right now
function resolveConstraints(s) {
  let enabled = true, note = '';
  let options = s.options || [];
  if (s.depends && s.depends.requires_key) {
    const ctl = state.settings.find((x) => x.key === s.depends.requires_key);
    const ok = String(effectiveValue(s.depends.requires_key)) === String(s.depends.requires_value);
    if (!ok) {
      enabled = false;
      const need = ctl ? ctl.options.find((o) => o.value === s.depends.requires_value) : null;
      note = `Locked — set ${ctl ? ctl.label : 'the required setting'} to “${need ? need.label : s.depends.requires_value}” to adjust.`;
    }
  }
  if (s.depends && s.depends.max_from) {
    const cap = Number(effectiveValue(s.depends.max_from));
    if (!isNaN(cap)) {
      options = options.filter((o) => Number(o.value) <= cap);
      note = note || `Limited to ≤ ${cap} A (the combined charge current).`;
    }
  }
  return { enabled, note, options };
}

function renderSettings() {
  const container = $('#settings-container');
  container.innerHTML = '';
  if (!state.settings.length) {
    container.append(el('div', { class: 'empty' }, 'No settings loaded yet.'));
    updateActionBar();
    return;
  }
  // drop pending edits that became invalid (control now locked, or value over cap)
  for (const s of state.settings) {
    if (!(s.key in state.pending)) continue;
    const c = resolveConstraints(s);
    if (!c.enabled) delete state.pending[s.key];
    else if (s.type === 'enum' && !c.options.some((o) => String(o.value) === String(state.pending[s.key])))
      delete state.pending[s.key];
  }
  const common = state.settings.filter((s) => !s.advanced);
  const advanced = state.settings.filter((s) => s.advanced);

  renderGroups(container, common);

  if (advanced.length) {
    const open = state.advancedOpen;
    const section = el('div', { class: 'advanced-section' + (open ? ' open' : '') });
    const body = el('div', { class: 'advanced-body' });
    renderGroups(body, advanced);
    const toggle = el('div', { class: 'advanced-toggle' }, [
      el('span', { class: 'chev' }, '▸'),
      el('span', { class: 'group-icon' }, '🛠️'),
      el('span', { class: 'adv-title' }, 'Advanced settings'),
      el('span', { class: 'muted', style: 'font-size:12px' }, "Defaults you don't normally need to change"),
    ]);
    toggle.addEventListener('click', () => {
      state.advancedOpen = !state.advancedOpen;
      section.classList.toggle('open', state.advancedOpen);
    });
    section.append(toggle, body);
    container.append(section);
  }
  updateActionBar();
}

const GROUP_ICONS = {
  'Operation & Charging': '⚡',
  'Battery Voltages': '🔋',
  'Operation, Charging & Battery': '⚙️',
  'Toggles': '🎚️',
};

function renderGroups(parent, settings) {
  const groups = {};
  for (const s of settings) (groups[s.group] = groups[s.group] || []).push(s);
  for (const [group, items] of Object.entries(groups)) {
    const grid = el('div', { class: 'settings-grid' });
    for (const s of items) grid.append(renderSetting(s));
    const head = el('h2', {}, [el('span', { class: 'group-icon' }, GROUP_ICONS[group] || '•'), group]);
    parent.append(el('div', { class: 'settings-group' }, [head, grid]));
  }
}

function renderSetting(s) {
  const { enabled, note, options } = resolveConstraints(s);
  const changed = s.key in state.pending;
  const chosen = changed ? state.pending[s.key] : s.current;
  const card = el('div', { class: 'setting' + (changed ? ' changed' : '') });
  card._setting = s;

  const name = el('div', { class: 'name' }, [s.label]);
  if (s.prog) name.append(el('span', { class: 'muted', style: 'font-weight:400;font-size:11px' }, `Prog ${s.prog}`));
  if (changed) name.append(el('span', { class: 'changed-pill' }, 'changed'));
  const head = el('div', { class: 'setting-head' }, [name]);
  if (s.help) head.append(el('div', { class: 'help' }, s.help));
  const allowed = allowedText(s);
  if (allowed) head.append(el('div', { class: 'help allowed' }, allowed));
  // constraint note lives in the head so the control stays pinned to the bottom
  if (note) head.append(el('div', { class: 'cur note' }, note));

  // control block (pinned to the bottom of the card so every selector aligns)
  const body = el('div', { class: 'setting-body' });
  if (s.type === 'flag') {
    const input = el('input', { type: 'checkbox' });
    input.checked = Boolean(chosen);
    input.disabled = !enabled;
    const stateLbl = el('span', { class: 'muted' }, chosen ? 'Enabled' : 'Disabled');
    input.addEventListener('change', () => {
      stateLbl.textContent = input.checked ? 'Enabled' : 'Disabled';
      setPending(s, input.checked, card);
    });
    body.append(el('label', { class: 'toggle' }, [input, el('span', { class: 'track' }), stateLbl]));
  } else if (s.type === 'enum') {
    body.append(el('div', { class: 'cur' }, 'Current: ' + labelFor(s, s.current)));
    const sel = el('select');
    sel.disabled = !enabled;
    for (const o of options) {
      const opt = el('option', { value: o.value }, o.label);
      if (String(chosen) === String(o.value)) opt.selected = true;
      sel.append(opt);
    }
    if (s.current == null || !options.some((o) => String(o.value) === String(s.current)))
      sel.prepend(el('option', { value: '', disabled: 'true', selected: chosen == null ? 'true' : null }, '— unknown —'));
    sel.addEventListener('change', () => setPending(s, sel.value, card));
    body.append(sel);
  } else if (s.type === 'number') {
    body.append(el('div', { class: 'cur' }, 'Current: ' + (s.current == null ? '—' : s.current + ' ' + s.unit)));
    // text (not number) input so the decimal always shows as a period,
    // regardless of the browser's locale; a typed comma is converted to a period.
    const input = el('input', { type: 'text', inputmode: 'decimal', class: 'num-input',
      value: chosen == null ? '' : String(chosen) });
    input.disabled = !enabled;
    input.addEventListener('input', () => {
      const norm = input.value.replace(',', '.');
      if (norm !== input.value) input.value = norm;
      const n = norm === '' ? null : Number(norm);
      setPending(s, (n == null || isNaN(n)) ? null : n, card);
    });
    body.append(input);
  }

  card.append(head, body);
  return card;
}

function labelFor(s, value) {
  if (value == null) return '—';
  const o = (s.options || []).find((o) => String(o.value) === String(value));
  return o ? o.label : String(value);
}

// Update pending state and the affected card in place (NO global re-render,
// so focus is never stolen from a number input while typing).
function setPending(s, value, card) {
  const changed = !valuesEqual(s, value, s.current);
  if (changed) state.pending[s.key] = value;
  else delete state.pending[s.key];
  // If other settings depend on this one, re-render so their options/locks
  // update. These controllers are <select>s, so a re-render is harmless.
  if (controllerKeys().has(s.key)) { renderSettings(); return; }
  if (card) {
    card.classList.toggle('changed', changed);
    const name = card.querySelector('.name');
    const pill = name.querySelector('.changed-pill');
    if (changed && !pill) name.append(el('span', { class: 'changed-pill' }, 'changed'));
    if (!changed && pill) pill.remove();
  }
  updateActionBar();
}

function pendingItems() {
  return Object.entries(state.pending).map(([key, value]) => ({ key, value }));
}

function updateActionBar() {
  const bar = $('#settings-action-bar');
  const n = Object.keys(state.pending).length;
  bar.style.display = n ? 'flex' : 'none';
  $('#changes-summary').textContent = n ? `${n} change${n > 1 ? 's' : ''} pending` : 'No changes';
}

// ---------------------------------------------------------------------------
// Apply modal (review -> confirm -> progress)
// ---------------------------------------------------------------------------
function diffRows(items) {
  return items.map(({ key, value }) => {
    const s = state.settings.find((x) => x.key === key) || { label: key, type: 'enum', options: [] };
    const disp = (v) => (s.type === 'flag' ? (v ? 'Enabled' : 'Disabled') : labelFor(s, v));
    const from = disp(s.current);
    const to = disp(value);
    return el('div', { class: 'diff-row' }, [
      el('span', {}, s.label),
      el('span', {}, [el('span', { class: 'from' }, String(from)), ' → ',
        el('span', { class: 'to' }, String(to))]),
    ]);
  });
}

let applyContext = null; // { mode:'settings'|'profile', items?, profileId?, save }

function openApplyModal() {
  const items = pendingItems();
  if (!items.length) return;
  applyContext = { mode: 'settings', items, save: $('#save-eeprom').checked };
  showApplyReview('Review changes', items);
}

function showApplyReview(title, items) {
  $('#apply-modal-title').textContent = title;
  const diff = $('#apply-diff');
  diff.style.display = '';
  diff.innerHTML = '';
  diffRows(items).forEach((r) => diff.append(r));
  diff.append(el('div', { class: 'muted', style: 'margin-top:10px;font-size:12px' },
    'Changes are sent to the inverter one at a time, with a short pause between each. '
    + (applyContext.save ? 'Settings will be saved to EEPROM after applying.' : 'Settings will NOT be persisted to EEPROM.')));
  $('#apply-progress').style.display = 'none';
  const confirm = $('#apply-confirm');
  confirm.style.display = '';
  confirm.disabled = false;
  confirm.textContent = 'Apply to inverter';
  confirm.onclick = doApply;
  $('#apply-cancel').textContent = 'Cancel';
  $('#apply-modal').classList.add('open');
}

async function doApply() {
  const confirm = $('#apply-confirm');
  confirm.disabled = true;
  try {
    let job;
    if (applyContext.mode === 'profile') job = await api.applyProfile(applyContext.profileId, applyContext.save);
    else job = await api.apply(applyContext.items, applyContext.save);
    state.applyingJobId = job.id;
    showApplyProgress(job);
  } catch (e) {
    alert('Apply failed: ' + e.message);
    confirm.disabled = false;
  }
}

function showApplyProgress(job) {
  $('#apply-diff').style.display = 'none';
  const prog = $('#apply-progress');
  prog.style.display = '';
  $('#apply-confirm').style.display = 'none';
  $('#apply-cancel').textContent = 'Close';
  renderJob(job);
  pollJob(job.id);
}

function renderJob(job) {
  const prog = $('#apply-progress');
  prog.innerHTML = '';
  for (const step of job.steps) {
    const mark = { ok: '✓', failed: '✕', sending: '…', pending: '·' }[step.status] || '·';
    prog.append(el('div', { class: 'step' }, [
      el('span', { class: 'st ' + step.status }, mark),
      el('span', {}, step.label),
      el('span', { class: 'spacer', style: 'flex:1' }),
      el('span', { class: 'muted' }, step.response || ''),
    ]));
  }
  if (job.status && job.status !== 'running') {
    const ok = job.status === 'completed';
    prog.append(el('div', { class: 'step' }, [
      el('span', { class: 'st ' + (ok ? 'ok' : 'failed') }, ok ? '✓' : '!'),
      el('span', {}, ok ? 'All changes applied'
        + (job.save ? ' and saved to EEPROM.' : '.') : 'Completed with errors — check rows above.'),
    ]));
  }
}

function onJobUpdate(job) {
  if (job.id === state.applyingJobId) renderJob(job);
}

async function pollJob(id) {
  try {
    const job = await api.job(id);
    renderJob(job);
    if (job.status === 'running') return setTimeout(() => pollJob(id), 600);
    // done: clear pending edits and refresh the view (a settings re-read also
    // arrives via WS, but don't rely on it).
    state.pending = {};
    renderSettings();
  } catch (e) { /* websocket job updates will still arrive */ }
}

function closeApplyModal() { $('#apply-modal').classList.remove('open'); state.applyingJobId = null; }

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------
async function loadProfiles() {
  try { const data = await api.profiles(); state.profiles = data.profiles || []; renderProfiles(); }
  catch (e) { console.warn('profiles load failed', e); }
}

function renderProfiles() {
  const list = $('#profile-list');
  list.innerHTML = '';
  if (!state.profiles.length) {
    list.append(el('div', { class: 'empty' }, 'No profiles yet. Create one to apply a set of settings in one click.'));
    return;
  }
  for (const p of state.profiles) {
    const kvs = Object.entries(p.settings).map(([k, v]) => {
      const s = state.settings.find((x) => x.key === k);
      const label = s ? s.label : k;
      const val = s ? (s.type === 'flag' ? (v ? 'Enabled' : 'Disabled') : labelFor(s, v)) : v;
      return el('div', { class: 'kv' }, `${label}: ${val}`);
    });
    list.append(el('div', { class: 'profile-card' }, [
      el('h3', {}, p.name),
      p.description ? el('div', { class: 'desc' }, p.description) : null,
      ...kvs,
      el('div', { class: 'actions' }, [
        el('button', { class: 'btn primary small', onclick: () => applyProfileFlow(p) }, 'Apply'),
        el('button', { class: 'btn ghost small', onclick: () => openProfileModal(p, false) }, 'Edit'),
        el('button', { class: 'btn danger small', onclick: () => removeProfile(p) }, 'Delete'),
      ]),
    ]));
  }
}

function applyProfileFlow(p) {
  applyContext = { mode: 'profile', profileId: p.id, save: true };
  const items = Object.entries(p.settings).map(([key, value]) => ({ key, value }));
  // reflect the EEPROM choice from settings tab checkbox if present
  applyContext.save = $('#save-eeprom') ? $('#save-eeprom').checked : true;
  showApplyReview(`Apply profile “${p.name}”`, items);
}

async function removeProfile(p) {
  if (!confirm(`Delete profile “${p.name}”?`)) return;
  try { await api.deleteProfile(p.id); loadProfiles(); }
  catch (e) { alert('Delete failed: ' + e.message); }
}

let editingProfileId = null;

function openProfileModal(profile, prefillFromPending) {
  editingProfileId = profile ? profile.id : null;
  $('#profile-modal-title').textContent = profile ? 'Edit profile' : 'New profile';
  $('#profile-name').value = profile ? profile.name : '';
  $('#profile-desc').value = profile ? profile.description : '';

  // seed selection: existing profile settings, or current pending edits
  const seed = profile ? profile.settings : (prefillFromPending ? Object.assign({}, state.pending) : {});
  const editor = $('#profile-settings-editor');
  editor.innerHTML = '';
  for (const s of state.settings) {
    const included = s.key in seed;
    const chosen = included ? seed[s.key] : s.current;
    const include = el('input', { type: 'checkbox' });
    include.checked = included;
    const control = buildProfileControl(s, chosen);
    const row = el('div', { class: 'diff-row' }, [
      el('label', { class: 'inline' }, [include, s.label]),
      control,
    ]);
    control.dataset.key = s.key;
    include.dataset.key = s.key;
    editor.append(row);
  }
  $('#profile-modal').classList.add('open');
}

function buildProfileControl(s, chosen) {
  if (s.type === 'flag') {
    const sel = el('select');
    sel.append(el('option', { value: 'true' }, 'Enabled'));
    sel.append(el('option', { value: 'false' }, 'Disabled'));
    sel.value = chosen ? 'true' : 'false';
    sel.dataset.type = 'flag';
    return sel;
  } else if (s.type === 'enum') {
    const sel = el('select');
    for (const o of s.options) sel.append(el('option', { value: o.value }, o.label));
    if (chosen != null) sel.value = String(chosen);
    sel.dataset.type = 'enum';
    return sel;
  }
  const input = el('input', { type: 'number', step: s.step ?? 0.1, value: chosen ?? '' });
  input.dataset.type = 'number';
  input.style.maxWidth = '120px';
  return input;
}

async function saveProfile() {
  const name = $('#profile-name').value.trim();
  if (!name) { alert('Please enter a name.'); return; }
  const settings = {};
  $$('#profile-settings-editor .diff-row').forEach((row) => {
    const inc = row.querySelector('input[type=checkbox]');
    const ctl = row.querySelector('[data-key]:not([type=checkbox])');
    if (!inc.checked) return;
    const key = ctl.dataset.key;
    let value = ctl.value;
    if (ctl.dataset.type === 'flag') value = ctl.value === 'true';
    else if (ctl.dataset.type === 'number') value = Number(ctl.value);
    settings[key] = value;
  });
  if (!Object.keys(settings).length) { alert('Include at least one setting.'); return; }
  const body = { name, description: $('#profile-desc').value.trim(), settings };
  try {
    if (editingProfileId) await api.updateProfile(editingProfileId, body);
    else await api.createProfile(body);
    $('#profile-modal').classList.remove('open');
    loadProfiles();
  } catch (e) { alert('Save failed: ' + e.message); }
}

// close modals on backdrop click
$$('.modal-backdrop').forEach((bk) => bk.addEventListener('click', (e) => {
  if (e.target === bk) bk.classList.remove('open');
}));

window.addEventListener('DOMContentLoaded', init);
