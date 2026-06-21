/* Mock backend for the standalone demo build.
 * Overrides window.fetch and window.WebSocket so the REAL app.js runs unchanged
 * against a simulated 24 V inverter. Only used by the generated mockup page.
 */
(function () {
  const METRICS = /*__METRICS__*/ [];
  const SETTINGS_VIEW = /*__SETTINGS_VIEW__*/ [];

  let profiles = [
    { id: 1, name: 'Solar only (daytime)', description: 'Run loads from solar/battery, charge from solar only.',
      settings: { output_source_priority: '02', charger_source_priority: '03', max_charge_current: '40' },
      created: 0, updated: 0 },
    { id: 2, name: 'Grid-charge overnight', description: 'Top the battery up from utility on a cheap tariff.',
      settings: { output_source_priority: '00', charger_source_priority: '00', max_utility_charge_current: '30' },
      created: 0, updated: 0 },
  ];
  let profileSeq = 3;
  let jobSeq = 1;
  const jobs = {};
  let liveWS = null;

  // ---- simulated telemetry (deterministic in t so history & live align) ----
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  function genValues(t) {
    const day = ((t % 86400) + 86400) % 86400 / 86400;
    const sun = Math.max(0, Math.sin((day - 0.25) * Math.PI * 2));
    let pv = Math.round(sun * 1400 + (sun > 0 ? Math.sin(t / 300) * 70 : 0));
    pv = Math.max(0, pv);
    let load = Math.round(340 + Math.sin(t / 600) * 150 + Math.sin(t / 137) * 60);
    load = Math.max(80, load);
    const net = pv - load;
    const soc = Math.round(clamp(72 + Math.sin(t / 4200) * 24, 28, 100));
    return {
      battery_voltage: Math.round((25.4 + sun * 1.7 + Math.sin(t / 800) * 0.2) * 10) / 10,
      battery_capacity: soc,
      battery_charge_current: net > 0 ? Math.round((net / 27) * 10) / 10 : 0,
      battery_discharge_current: net < 0 ? Math.round((-net / 27) * 10) / 10 : 0,
      pv_input_power: pv,
      pv_input_voltage: pv > 0 ? Math.round((58 + sun * 34) * 10) / 10 : 0,
      ac_output_active_power: load,
      ac_output_apparent_power: Math.round(load * 1.18),
      ac_output_load: Math.round((load / 2000) * 100),
      ac_output_voltage: 230,
      ac_input_voltage: 230,
      heatsink_temp: Math.round(32 + sun * 8 + load / 120),
    };
  }
  function liveState(t) {
    const v = genValues(t);
    return {
      ts: t, connected: true,
      mode: v.battery_discharge_current > 0 ? 'Battery' : 'Line',
      values: v,
      flags: { load_on: true, charging_on: v.battery_charge_current > 0, ac_charging: false,
               scc_charging: v.pv_input_power > 0, charging_to_float: false },
      warnings: [], last_error: null,
    };
  }
  const nowS = () => Date.now() / 1000;

  // ---- mock fetch ----------------------------------------------------------
  const json = (data) => Promise.resolve({ ok: true, status: 200, json: async () => data });
  window.fetch = function (url, opts) {
    const u = new URL(url, location.origin);
    const p = u.pathname, m = (opts && opts.method) || 'GET';
    if (p === '/api/metrics') return json({ metrics: METRICS });
    if (p === '/api/live') return json(liveState(nowS()));
    if (p === '/api/history') {
      const range = parseInt(u.searchParams.get('range') || '3600', 10);
      const end = nowS(), step = Math.max(20, Math.round(range / 280));
      const samples = [];
      for (let t = end - range; t <= end; t += step) samples.push(Object.assign({ ts: Math.round(t) }, genValues(t)));
      return json({ samples, metrics: METRICS.map((x) => x.key) });
    }
    if (p === '/api/settings') return json({ settings: SETTINGS_VIEW, read_at: nowS() });
    if (p === '/api/settings/apply' && m === 'POST') {
      const body = JSON.parse(opts.body);
      return json(startJob(body.items, body.save));
    }
    if (p.startsWith('/api/jobs/')) {
      const id = p.split('/').pop();
      return jobs[id] ? json(jobs[id]) : Promise.resolve({ ok: false, status: 404, json: async () => ({ detail: 'not found' }) });
    }
    if (p === '/api/profiles' && m === 'GET') return json({ profiles });
    if (p === '/api/profiles' && m === 'POST') {
      const b = JSON.parse(opts.body);
      const pr = { id: profileSeq++, name: b.name, description: b.description || '', settings: b.settings, created: nowS(), updated: nowS() };
      profiles.push(pr); return json(pr);
    }
    const pm = p.match(/^\/api\/profiles\/(\d+)$/);
    if (pm) {
      const id = parseInt(pm[1], 10);
      const idx = profiles.findIndex((x) => x.id === id);
      if (m === 'DELETE') { profiles = profiles.filter((x) => x.id !== id); return json({ deleted: id }); }
      if (m === 'PUT') { const b = JSON.parse(opts.body); profiles[idx] = Object.assign({}, profiles[idx], b, { updated: nowS() }); return json(profiles[idx]); }
    }
    const ap = p.match(/^\/api\/profiles\/(\d+)\/apply$/);
    if (ap) {
      const pr = profiles.find((x) => x.id === parseInt(ap[1], 10));
      const items = Object.entries(pr.settings).map(([key, value]) => ({ key, value }));
      const save = u.searchParams.get('save') !== 'false';
      return json(startJob(items, save));
    }
    return Promise.resolve({ ok: false, status: 404, json: async () => ({ detail: 'mock: ' + p }) });
  };

  function startJob(items, save) {
    const id = 'job-' + (jobSeq++);
    const job = { id, status: 'running', started: nowS(), finished: null, save,
      steps: items.map((it) => ({ key: it.key, value: it.value, command: '', label: labelFor(it.key), status: 'pending', response: null })) };
    jobs[id] = job;
    // progress one step at a time, pushing updates over the websocket
    let i = 0;
    const tickStep = () => {
      if (i > 0) job.steps[i - 1].status = 'ok', job.steps[i - 1].response = 'Accepted (ACK)';
      if (i < job.steps.length) {
        job.steps[i].status = 'sending';
        emit({ type: 'job', job });
        i++;
        setTimeout(tickStep, 550);
      } else {
        job.status = 'completed'; job.finished = nowS();
        // reflect applied values into the settings view, then "re-read"
        for (const st of job.steps) {
          const s = SETTINGS_VIEW.find((x) => x.key === st.key);
          if (s) s.current = st.value;
        }
        emit({ type: 'job', job });
        emit({ type: 'settings', settings: SETTINGS_VIEW });
      }
    };
    setTimeout(tickStep, 300);
    return job;
  }
  function labelFor(key) { const s = SETTINGS_VIEW.find((x) => x.key === key); return s ? s.label : key; }
  function emit(msg) { if (liveWS && liveWS.onmessage) liveWS.onmessage({ data: JSON.stringify(msg) }); }

  // ---- mock WebSocket ------------------------------------------------------
  window.WebSocket = class {
    constructor(url) {
      this.url = url; this.readyState = 0; liveWS = this;
      setTimeout(() => {
        this.readyState = 1; this.onopen && this.onopen();
        emit({ type: 'snapshot', live: liveState(nowS()), settings: SETTINGS_VIEW });
        this._t = setInterval(() => {
          const t = nowS();
          emit({ type: 'sample', ts: Math.round(t), values: genValues(t), live: liveState(t) });
        }, 1500);
      }, 60);
    }
    send() {}
    close() { clearInterval(this._t); this.onclose && this.onclose(); }
  };
})();
