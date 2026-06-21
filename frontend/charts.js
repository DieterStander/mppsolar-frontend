/* Tiny dependency-free canvas time-series chart.
 * Designed to stay light on a Raspberry Pi and handle thousands of points.
 *
 *   const c = new TimeChart(canvasEl, {
 *     series: [{key:'pv_input_power', label:'PV', color:'#f5a623', unit:'W'}],
 *   });
 *   c.setData(rows);           // rows: [{ts: <seconds>, <key>: <number|null>, ...}]
 *   c.push({ts, key:val,...}); // append a single point and redraw
 *   c.setTheme('dark'|'light');
 */
(function () {
  const THEMES = {
    dark:  { axis: '#8a93a6', grid: 'rgba(255,255,255,0.07)', text: '#c7cedb',
             tip: 'rgba(20,24,33,0.95)', tipText: '#e8ecf3', tipBorder: 'rgba(255,255,255,0.15)' },
    light: { axis: '#5a6478', grid: 'rgba(0,0,0,0.08)', text: '#3a4254',
             tip: 'rgba(255,255,255,0.97)', tipText: '#1c2430', tipBorder: 'rgba(0,0,0,0.15)' },
  };

  class TimeChart {
    constructor(canvas, opts) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.series = opts.series || [];
      this.unit = opts.unit || '';
      this.yMin = opts.yMin == null ? null : opts.yMin;
      this.yMax = opts.yMax == null ? null : opts.yMax;
      this.theme = THEMES[opts.theme || 'dark'];
      this.rows = [];
      this.hover = null;
      this.dpr = window.devicePixelRatio || 1;

      this._onMove = (e) => {
        const r = canvas.getBoundingClientRect();
        this.hover = { x: e.clientX - r.left, y: e.clientY - r.top };
        this.draw();
      };
      this._onLeave = () => { this.hover = null; this.draw(); };
      canvas.addEventListener('mousemove', this._onMove);
      canvas.addEventListener('mouseleave', this._onLeave);

      this._ro = new ResizeObserver(() => this.resize());
      this._ro.observe(canvas);
      this.resize();
    }

    setTheme(name) { this.theme = THEMES[name] || THEMES.dark; this.draw(); }
    setData(rows) { this.rows = rows || []; this.draw(); }
    push(row) {
      this.rows.push(row);
      this.draw();
    }
    trimBefore(ts) { this.rows = this.rows.filter((r) => r.ts >= ts); }

    resize() {
      const w = this.canvas.clientWidth || 600;
      const h = this.canvas.clientHeight || 240;
      this.dpr = window.devicePixelRatio || 1;
      this.canvas.width = Math.round(w * this.dpr);
      this.canvas.height = Math.round(h * this.dpr);
      this.draw();
    }

    draw() {
      const ctx = this.ctx, dpr = this.dpr, T = this.theme;
      const W = this.canvas.width, H = this.canvas.height;
      ctx.clearRect(0, 0, W, H);
      ctx.save();
      ctx.scale(dpr, dpr);
      const w = W / dpr, h = H / dpr;

      const padL = 48, padR = 12, padT = 24, padB = 22;
      const plotW = w - padL - padR, plotH = h - padT - padB;

      ctx.font = '11px system-ui, sans-serif';
      ctx.textBaseline = 'middle';

      const rows = this.rows;
      if (!rows.length) {
        ctx.fillStyle = T.text;
        ctx.textAlign = 'center';
        ctx.fillText('No data yet…', w / 2, h / 2);
        ctx.restore();
        return;
      }

      const t0 = rows[0].ts, t1 = rows[rows.length - 1].ts;
      const tSpan = Math.max(1, t1 - t0);

      // y domain across all series
      let min = Infinity, max = -Infinity;
      for (const r of rows) {
        for (const s of this.series) {
          const v = r[s.key];
          if (v == null || isNaN(v)) continue;
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }
      if (min === Infinity) { min = 0; max = 1; }
      if (min === max) { min -= 1; max += 1; }
      const pad = (max - min) * 0.08;
      min -= pad; max += pad;
      if (min > 0 && min < (max - min)) min = 0; // anchor to zero when sensible
      if (this.yMin != null) min = this.yMin;    // fixed axis bounds when provided
      if (this.yMax != null) max = this.yMax;

      const xOf = (t) => padL + ((t - t0) / tSpan) * plotW;
      const yOf = (v) => padT + plotH - ((v - min) / (max - min)) * plotH;

      // grid + y labels
      ctx.strokeStyle = T.grid; ctx.fillStyle = T.text; ctx.lineWidth = 1;
      ctx.textAlign = 'right';
      const yTicks = 4;
      for (let i = 0; i <= yTicks; i++) {
        const v = min + (i / yTicks) * (max - min);
        const y = yOf(v);
        ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
        ctx.fillText(fmtNum(v), padL - 6, y);
      }
      // emphasised zero line when the axis spans negative → positive
      if (min < 0 && max > 0) {
        const yz = yOf(0);
        ctx.save(); ctx.strokeStyle = T.axis; ctx.globalAlpha = 0.55;
        ctx.beginPath(); ctx.moveTo(padL, yz); ctx.lineTo(w - padR, yz); ctx.stroke(); ctx.restore();
      }

      // x time labels
      ctx.textAlign = 'center';
      const xTicks = Math.min(6, Math.max(2, Math.floor(plotW / 90)));
      for (let i = 0; i <= xTicks; i++) {
        const t = t0 + (i / xTicks) * tSpan;
        const x = xOf(t);
        ctx.fillStyle = T.text;
        ctx.fillText(fmtTime(t, tSpan), x, h - padB + 11);
      }

      // series lines (clipped to the plot so fixed-range outliers don't spill)
      ctx.save();
      ctx.beginPath(); ctx.rect(padL, padT, plotW, plotH); ctx.clip();
      ctx.lineWidth = 1.8;
      ctx.lineJoin = 'round';
      for (const s of this.series) {
        ctx.strokeStyle = s.color;
        ctx.beginPath();
        let pen = false;
        for (const r of rows) {
          const v = r[s.key];
          if (v == null || isNaN(v)) { pen = false; continue; }
          const x = xOf(r.ts), y = yOf(v);
          if (!pen) { ctx.moveTo(x, y); pen = true; } else { ctx.lineTo(x, y); }
        }
        ctx.stroke();
      }
      ctx.restore();

      // hover crosshair + tooltip
      if (this.hover && this.hover.x >= padL && this.hover.x <= w - padR) {
        const tHover = t0 + ((this.hover.x - padL) / plotW) * tSpan;
        let idx = 0, best = Infinity;
        for (let i = 0; i < rows.length; i++) {
          const d = Math.abs(rows[i].ts - tHover);
          if (d < best) { best = d; idx = i; }
        }
        const r = rows[idx];
        const hx = xOf(r.ts);
        ctx.strokeStyle = T.axis; ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(hx, padT); ctx.lineTo(hx, padT + plotH); ctx.stroke();
        ctx.setLineDash([]);
        for (const s of this.series) {
          const v = r[s.key];
          if (v == null || isNaN(v)) continue;
          ctx.fillStyle = s.color;
          ctx.beginPath(); ctx.arc(hx, yOf(v), 3, 0, Math.PI * 2); ctx.fill();
        }
        this._tooltip(ctx, r, hx, padL, padT, plotW, plotH, w);
      }

      ctx.restore();
    }

    _tooltip(ctx, r, hx, padL, padT, plotW, plotH, w) {
      const T = this.theme;
      const lines = [fmtFull(r.ts)];
      for (const s of this.series) {
        const v = r[s.key];
        if (v == null || isNaN(v)) continue;
        lines.push(`${s.label}: ${fmtNum(v)} ${s.unit || this.unit || ''}`.trim());
      }
      ctx.font = '11px system-ui, sans-serif';
      const tw = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 16;
      const th = lines.length * 15 + 8;
      let bx = hx + 10;
      if (bx + tw > padL + plotW) bx = hx - tw - 10;
      let by = padT + 6;
      ctx.fillStyle = T.tip; ctx.strokeStyle = T.tipBorder; ctx.lineWidth = 1;
      roundRect(ctx, bx, by, tw, th, 6); ctx.fill(); ctx.stroke();
      ctx.fillStyle = T.tipText; ctx.textAlign = 'left';
      lines.forEach((l, i) => ctx.fillText(l, bx + 8, by + 14 + i * 15));
    }

    destroy() {
      this._ro.disconnect();
      this.canvas.removeEventListener('mousemove', this._onMove);
      this.canvas.removeEventListener('mouseleave', this._onLeave);
    }
  }

  function fmtNum(v) {
    const a = Math.abs(v);
    if (a >= 1000) return Math.round(v).toString();
    if (a >= 100) return v.toFixed(0);
    if (a >= 10) return v.toFixed(1);
    return v.toFixed(2);
  }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function fmtTime(ts, span) {
    const d = new Date(ts * 1000);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function fmtFull(ts) {
    const d = new Date(ts * 1000);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  window.TimeChart = TimeChart;
})();
