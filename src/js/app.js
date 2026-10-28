/* app.js — Speedtest v3
   Dependency-free. Network contact: ONLY https://speed.cloudflare.com.
   Results persist in localStorage on this device. The only traffic out
   is random test bytes. No third-party code. There is no visible console
   log anymore — every run note is saved inside its history entry. */
(function () {
  'use strict';

  const BASE = 'https://speed.cloudflare.com';
  const MB = 1048576;
  const LS_HIST = 'speedtest.history.v1';
  const LS_SET = 'speedtest.settings.v1';

  const reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const $ = function (id) { return document.getElementById(id); };
  const p2 = function (x) { return String(x).padStart(2, '0'); };

  /* some /meta fields can arrive as objects — coerce safely */
  function asText(v) {
    if (v == null) return null;
    if (typeof v === 'string') return v;
    if (typeof v === 'object') return v.code || v.name || v.iata || null;
    return String(v);
  }

  /* ---------- status line + recorded notes (replaces the old log box) ---------- */
  let phaseText = 'idle — press Start';
  let flashTimer = null;
  let runNotes = [];

  function phase(txt, pct) {
    if (flashTimer) { clearTimeout(flashTimer); flashTimer = null; }
    phaseText = txt;
    const el = $('st-phase');
    el.textContent = txt;
    el.className = 'phase mono' + (state.running ? ' running' : '');
    if (typeof pct === 'number') $('st-bar').style.width = Math.max(0, Math.min(100, pct)) + '%';
  }
  function flashPhase(msg, kind) {
    const el = $('st-phase');
    el.textContent = (kind === 'err' ? '✖ ' : '⚠ ') + msg;
    el.className = 'phase mono phase-' + (kind === 'err' ? 'err' : 'warn');
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(function () {
      flashTimer = null;
      el.className = 'phase mono' + (state.running ? ' running' : '');
      el.textContent = phaseText;
    }, 2800);
  }
  /* every message that used to go to the on-page log is recorded here
     and saved inside the matching history entry; warnings and errors
     also flash briefly on the status line */
  function note(msg, kind) {
    const dt = state.running ? (performance.now() - state.t0Run) / 1000 : null;
    runNotes.push(dt != null ? '+' + dt.toFixed(1) + 's ' + msg : msg);
    if (kind === 'warn' || kind === 'err') flashPhase(msg, kind);
  }

  /* ---------- tile helpers ---------- */
  function setTile(id, v) { const el = $(id); if (el) el.textContent = v; }
  function tileLive(id, on) {
    const el = $(id);
    if (el && el.parentElement) el.parentElement.classList.toggle('live', !!on);
  }
  function animateTile(id, target, fmt, dur) {
    const el = $(id);
    if (!el) return;
    if (reduceMotion) { el.textContent = fmt(target); return; }
    const d = dur || 900;
    const t0 = performance.now();
    if (el.parentElement) el.parentElement.classList.add('flash');
    setTimeout(function () { if (el.parentElement) el.parentElement.classList.remove('flash'); }, d + 250);
    (function tick(now) {
      const p = Math.min(1, ((now || performance.now()) - t0) / d);
      const e = 1 - Math.pow(1 - p, 3);
      el.textContent = fmt(target * e);
      if (p < 1) requestAnimationFrame(tick);
      else el.textContent = fmt(target);
    })(performance.now());
  }
  const fmtCount = function (v) { return String(Math.round(v)); };

  function humanBytes(n) {
    if (n >= MB) return (n / MB).toFixed(0) + ' MB';
    if (n >= 1024) return (n / 1024).toFixed(0) + ' KB';
    return n + ' B';
  }

  /* ---------- settings & units ---------- */
  const settings = { streams: 4, duration: 10, doUp: true, units: 'mbps' };
  try {
    const saved = JSON.parse(localStorage.getItem(LS_SET) || '{}');
    if (saved.streams) settings.streams = saved.streams;
    if (saved.duration) settings.duration = saved.duration;
    if (typeof saved.doUp === 'boolean') settings.doUp = saved.doUp;
    if (saved.units) settings.units = saved.units;
  } catch (e) { /* fresh */ }
  function saveSettings() {
    try { localStorage.setItem(LS_SET, JSON.stringify(settings)); } catch (e) { /* ignore */ }
  }
  function fmtSpeed(mbps) {
    const v = settings.units === 'mbytes' ? mbps / 8 : mbps;
    return v >= 100 ? v.toFixed(0) : v.toFixed(1);
  }
  function unitStr() { return settings.units === 'mbytes' ? 'MB/s' : 'Mbps'; }
  function syncUnits() {
    $('st-down-unit').textContent = unitStr();
    $('st-up-unit').textContent = unitStr();
  }

  /* ---------- state ---------- */
  const state = {
    running: false,
    stopFlag: false,
    aborters: [],
    bytes: 0,
    samples: [],
    t0Run: 0,
    hoverX: null,
    final: {}
  };
  function resetFinal() {
    state.final = {
      down: null, up: null, idle: null, idleMin: null, loaded: null,
      jitter: null, grade: null, bloat: null, streams: settings.streams,
      upSkipped: false, bytesDown: null, secsDown: null, bytesUp: null, secsUp: null,
      meta: null
    };
  }
  let loadedTimes = [];

  function newAborter() {
    const c = new AbortController();
    state.aborters.push(c);
    return c;
  }
  function abortAll() {
    for (const c of state.aborters) { try { c.abort(); } catch (e) { /* noop */ } }
    state.aborters.length = 0;
  }

  /* ---------- samplers ---------- */
  function startSampler(label, tileId, durMs, pctFrom, pctTo, tPhase) {
    tileLive(tileId, true);
    let lastBytes = 0;
    let lastT = performance.now();
    let inst = 0;
    const iv = setInterval(function () {
      const now = performance.now();
      const dt = (now - lastT) / 1000;
      if (dt <= 0) return;
      const mb = ((state.bytes - lastBytes) * 8 / dt) / 1e6;
      lastBytes = state.bytes;
      lastT = now;
      inst = inst * 0.5 + mb * 0.5;
      state.samples.push({ t: (now - state.t0Run) / 1000, mbps: mb, phase: label });
      setTile(tileId, fmtSpeed(inst));
      drawGraph();
      phase(label + ': ' + humanBytes(state.bytes), pctFrom + Math.min(1, (now - tPhase) / durMs) * (pctTo - pctFrom));
    }, 250);
    return iv;
  }

  function pingOnce(signal) {
    const t0 = performance.now();
    return fetch(BASE + '/__down?bytes=0', { cache: 'no-store', signal: signal })
      .then(function () { return performance.now() - t0; });
  }

  function startLoadedPings() {
    loadedTimes.length = 0;
    const ctrl = newAborter();
    const iv = setInterval(function () {
      if (state.stopFlag) return;
      pingOnce(ctrl.signal).then(function (ms) { loadedTimes.push(ms); }).catch(function () { /* noop */ });
    }, 350);
    return { stop: function () { clearInterval(iv); try { ctrl.abort(); } catch (e) { /* noop */ } } };
  }

  /* ---------- phases ---------- */
  async function fetchMeta() {
    try {
      const res = await fetch(BASE + '/meta', { cache: 'no-store' });
      const j = await res.json();
      const colo = asText(j.colo);
      const city = asText(j.city);
      const country = asText(j.country);
      const org = asText(j.asOrganization);
      const ip = asText(j.clientIp);
      state.final.meta = { colo: colo, city: city, country: country, isp: org, ip: ip };
      document.dispatchEvent(new CustomEvent('st:meta', { detail: j }));
      note('endpoint ' + (colo || '?') + (org ? ' · your network: ' + org : ''));
    } catch (e) {
      note('info probe blocked - test may still work', 'warn');
    }
  }

  async function measureIdleLatency() {
    phase('latency: warming up', 3);
    const samples = [];
    const ctrl = newAborter();
    try {
      await pingOnce(ctrl.signal);
      for (let i = 0; i < 8 && !state.stopFlag; i++) {
        samples.push(await pingOnce(ctrl.signal));
        phase('latency: ' + (i + 1) + '/8', 4 + (i + 1) * 1.2);
      }
    } catch (e) {
      if (e.name !== 'AbortError') throw e;
    }
    if (samples.length < 2) return;
    const avg = samples.reduce(function (a, b) { return a + b; }, 0) / samples.length;
    const min = Math.min.apply(null, samples);
    let jit = 0;
    for (let k = 1; k < samples.length; k++) jit += Math.abs(samples[k] - samples[k - 1]);
    jit /= (samples.length - 1);
    state.final.idle = avg;
    state.final.idleMin = min;
    state.final.jitter = jit;
    animateTile('st-lat', avg, fmtCount);
    animateTile('st-jit', jit, fmtCount);
    note('latency avg ' + avg.toFixed(1) + ' ms · min ' + min.toFixed(1) + ' ms · jitter ' + jit.toFixed(1) + ' ms');
  }

  async function downStream(deadline) {
    let size = 10 * MB;
    const ctrl = newAborter();
    while (!state.stopFlag && performance.now() < deadline) {
      try {
        const t0 = performance.now();
        const res = await fetch(BASE + '/__down?bytes=' + size, { cache: 'no-store', signal: ctrl.signal });
        const reader = res.body.getReader();
        let done = false;
        while (!done) {
          const chunk = await reader.read();
          if (chunk.done) { done = true; break; }
          state.bytes += chunk.value.byteLength;
          if (state.stopFlag || performance.now() >= deadline) { ctrl.abort(); return; }
        }
        const took = performance.now() - t0;
        if (took < 800 && size < 100 * MB) size = Math.min(size * 2, 100 * MB);
        else if (took > 3000 && size > 5 * MB) size = Math.max(Math.round(size / 2), 5 * MB);
      } catch (e) {
        if (e.name === 'AbortError') return;
        note('download stream error: ' + e.message, 'warn');
        return;
      }
    }
  }

  async function measureDownload() {
    const durMs = settings.duration * 1000;
    const deadline = performance.now() + durMs;
    state.bytes = 0;
    const tPhase = performance.now();
    const sampler = startSampler('download', 'st-down', durMs, 15, 55, tPhase);
    const jobs = [];
    for (let i = 0; i < settings.streams; i++) jobs.push(downStream(deadline));
    await Promise.all(jobs);
    clearInterval(sampler);
    tileLive('st-down', false);
    const el = (performance.now() - tPhase) / 1000;
    const mbps = (state.bytes * 8) / el / 1e6;
    state.final.down = mbps;
    state.final.bytesDown = state.bytes;
    state.final.secsDown = el;
    animateTile('st-down', mbps, fmtSpeed);
    note('download ' + fmtSpeed(mbps) + ' ' + unitStr() + ' · ' + humanBytes(state.bytes) + ' in ' + el.toFixed(1) + ' s · ' + settings.streams + ' stream(s)');
  }

  /* one 16 MB random blob, built once; slices are free, so no per-request
     CPU work lands inside the timed window */
  let upBlob = null;
  function makeBlob(size) {
    if (!upBlob) {
      const buf = new Uint8Array(16 * MB);
      for (let off = 0; off < buf.length; off += 65536) {
        crypto.getRandomValues(buf.subarray(off, off + 65536));
      }
      upBlob = new Blob([buf], { type: 'text/plain' });
    }
    return upBlob.slice(0, size);
  }

  /* XHR instead of fetch: upload.onprogress gives real byte counts while the
     request is in flight, so the graph is smooth and partial requests count */
  function upStream(deadline) {
    return new Promise(function (resolve, reject) {
      let size = 1 * MB;
      function next() {
        if (state.stopFlag || state.upFailed || performance.now() >= deadline) { resolve(); return; }
        const x = new XMLHttpRequest();
        let last = 0;
        const timer = setTimeout(function () { try { x.abort(); } catch (e) { /* noop */ } },
          Math.max(300, deadline - performance.now()));
        state.aborters.push({ abort: function () { try { x.abort(); } catch (e) { /* noop */ } } });
        x.open('POST', BASE + '/__up', true);
        x.setRequestHeader('Content-Type', 'text/plain');
        x.upload.onprogress = function (ev) { state.bytes += ev.loaded - last; last = ev.loaded; };
        x.onload = function () {
          clearTimeout(timer);
          if (x.status >= 400) { reject(new Error('HTTP ' + x.status)); return; }
          state.bytes += Math.max(0, size - last);
          size = Math.min(size * 2, 8 * MB);
          next();
        };
        x.onerror = function () { clearTimeout(timer); reject(new Error('network error')); };
        x.onabort = function () { clearTimeout(timer); resolve(); };
        x.send(makeBlob(size));
      }
      next();
    });
  }

  async function measureUpload() {
    const durMs = settings.duration * 1000;
    const deadline = performance.now() + durMs;
    state.bytes = 0;
    const tPhase = performance.now();
    state.upFailed = false;
    const sampler = startSampler('upload', 'st-up', durMs, 55, 92, tPhase);
    try {
      const jobs = [];
      for (let i = 0; i < settings.streams; i++) jobs.push(upStream(deadline));
      await Promise.all(jobs);
    } catch (e) {
      clearInterval(sampler);
      tileLive('st-up', false);
      state.upFailed = true;
      state.final.upSkipped = true;
      setTile('st-up', 'n/a');
      note('upload unavailable (' + (e && e.message ? e.message : 'blocked') + ') - download-only result', 'warn');
      return;
    }
    clearInterval(sampler);
    tileLive('st-up', false);
    const el = (performance.now() - tPhase) / 1000;
    const mbps = (state.bytes * 8) / el / 1e6;
    state.final.up = mbps;
    state.final.bytesUp = state.bytes;
    state.final.secsUp = el;
    animateTile('st-up', mbps, fmtSpeed);
    note('upload ' + fmtSpeed(mbps) + ' ' + unitStr() + ' · ' + humanBytes(state.bytes) + ' in ' + el.toFixed(1) + ' s');
  }
  /* ---------- grade ---------- */
  function gradeFor(deltaMs) {
    if (deltaMs < 5) return 'A';
    if (deltaMs < 30) return 'B';
    if (deltaMs < 60) return 'C';
    if (deltaMs < 200) return 'D';
    if (deltaMs < 400) return 'E';
    return 'F';
  }

  function finishLoaded() {
    if (loadedTimes.length) {
      const avg = loadedTimes.reduce(function (a, b) { return a + b; }, 0) / loadedTimes.length;
      state.final.loaded = avg;
      animateTile('st-load', avg, fmtCount);
      if (state.final.idle != null) {
        const delta = avg - state.final.idle;
        state.final.bloat = delta;
        const g = gradeFor(delta);
        state.final.grade = g;
        const gt = $('st-grade');
        gt.textContent = g;
        gt.className = 'tvalue mono g-' + g.toLowerCase() + ' pop';
        setTimeout(function () { gt.classList.remove('pop'); }, 950);
        note('loaded latency ' + avg.toFixed(1) + ' ms · bufferbloat +' + delta.toFixed(1) + ' ms under load → grade ' + g);
      }
    }
  }

  /* ---------- graph ---------- */
  function computeScale(values) {
    if (!values.length) return 1;
    const sorted = values.slice().sort(function (a, b) { return a - b; });
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    return Math.max(p95 * 1.35, sorted[sorted.length - 1] * 0.5, 1);
  }
  function roundRectPath(ctx, x, y, w2, h2, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w2, y, x + w2, y + h2, r);
    ctx.arcTo(x + w2, y + h2, x, y + h2, r);
    ctx.arcTo(x, y + h2, x, y, r);
    ctx.arcTo(x, y, x + w2, y, r);
    ctx.closePath();
  }

  function drawGraph() {
    const canvas = $('st-canvas');
    if (!canvas || !canvas.getContext) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 600;
    const h = 220;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const s = state.samples;
    const padL = 46, padR = 12, padT = 26, padB = 18;
    const pw = w - padL - padR;
    const ph = h - padT - padB;
    if (s.length < 2) {
      ctx.fillStyle = 'rgba(243,234,216,0.4)';
      ctx.font = '12px ui-monospace, monospace';
      ctx.fillText('speed over time appears here', padL + 4, padT + ph / 2);
      return;
    }

    const maxT = Math.max(s[s.length - 1].t, 1);
    const allVals = [];
    for (let i = 0; i < s.length; i++) allVals.push(s[i].mbps);
    const maxV = computeScale(allVals);
    function X(t) { return padL + (t / maxT) * pw; }
    function Y(v) { return padT + (1 - Math.min(v, maxV) / maxV) * ph; }

    /* grid */
    ctx.strokeStyle = 'rgba(243,234,216,0.09)';
    ctx.fillStyle = 'rgba(243,234,216,0.55)';
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'right';
    ctx.lineWidth = 1;
    for (let g = 0; g <= 4; g++) {
      const v = maxV * g / 4;
      const y = Y(v);
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(w - padR, y);
      ctx.stroke();
      ctx.fillText(fmtSpeed(v), padL - 6, y + 3);
    }

    /* smooth curves with gradient area fills */
    function drawSeries(name, lineColor, gradTop) {
      const pts = [];
      for (let i = 0; i < s.length; i++) if (s[i].phase === name) pts.push(s[i]);
      if (pts.length < 2) return;
      ctx.beginPath();
      ctx.moveTo(X(pts[0].t), Y(pts[0].mbps));
      for (let k = 1; k < pts.length - 1; k++) {
        const xc = (X(pts[k].t) + X(pts[k + 1].t)) / 2;
        const yc = (Y(pts[k].mbps) + Y(pts[k + 1].mbps)) / 2;
        ctx.quadraticCurveTo(X(pts[k].t), Y(pts[k].mbps), xc, yc);
      }
      ctx.lineTo(X(pts[pts.length - 1].t), Y(pts[pts.length - 1].mbps));
      ctx.strokeStyle = lineColor;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.stroke();
      const grad = ctx.createLinearGradient(0, padT, 0, padT + ph);
      grad.addColorStop(0, gradTop);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.lineTo(X(pts[pts.length - 1].t), Y(0));
      ctx.lineTo(X(pts[0].t), Y(0));
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
    }
    drawSeries('download', '#ffb700', 'rgba(255,183,0,0.30)');
    drawSeries('upload', '#4fd1c5', 'rgba(79,209,197,0.30)');

    /* legend */
    ctx.textAlign = 'left';
    ctx.font = '11px ui-monospace, monospace';
    ctx.fillStyle = '#ffb700';
    ctx.fillText('● download', padL + 4, padT - 10);
    ctx.fillStyle = '#4fd1c5';
    ctx.fillText('● upload', padL + 94, padT - 10);

    /* hover crosshair */
    if (state.hoverX != null && state.hoverX >= padL && state.hoverX <= w - padR) {
      const t = (state.hoverX - padL) / pw * maxT;
      let best = null, bd = Infinity;
      for (let i = 0; i < s.length; i++) {
        const d = Math.abs(s[i].t - t);
        if (d < bd) { bd = d; best = s[i]; }
      }
      if (best) {
        const x = X(best.t);
        ctx.strokeStyle = 'rgba(243,234,216,0.35)';
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(x, padT);
        ctx.lineTo(x, padT + ph);
        ctx.stroke();
        ctx.setLineDash([]);
        const label = best.t.toFixed(1) + 's · ' + fmtSpeed(best.mbps) + ' ' + unitStr() + (best.phase === 'download' ? ' ↓' : ' ↑');
        ctx.font = '11px ui-monospace, monospace';
        const tw = ctx.measureText(label).width;
        let bx = x + 8;
        if (bx + tw + 14 > w - padR) bx = x - tw - 20;
        ctx.fillStyle = 'rgba(20,16,10,0.92)';
        ctx.strokeStyle = 'rgba(243,234,216,0.3)';
        roundRectPath(ctx, bx, padT + 2, tw + 12, 20, 5);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#f3ead8';
        ctx.textAlign = 'left';
        ctx.fillText(label, bx + 6, padT + 16);
      }
    }
  }

  /* ---------- history with expandable details ---------- */
  function loadHistory() {
    try { return JSON.parse(localStorage.getItem(LS_HIST) || '[]'); } catch (e) { return []; }
  }
  function saveHistory(list) {
    try { localStorage.setItem(LS_HIST, JSON.stringify(list)); } catch (e) { /* ignore */ }
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function detailHtml(r) {
    const d = r.details || {};
    const m = d.meta || {};
    const rows = [];
    function kv(k, v) {
      if (v != null && v !== '') rows.push('<div class="kv"><span class="k">' + esc(k) + '</span><span class="v mono">' + esc(v) + '</span></div>');
    }
    kv('server', m.colo ? 'cloudflare ' + m.colo + (m.city ? ' · ' + m.city + (m.country ? ', ' + m.country : '') : '') : null);
    kv('your network', m.isp);
    kv('your ip', m.ip);
    kv('ping', d.idle != null ? d.idle.toFixed(1) + ' ms avg · min ' + (d.idleMin != null ? d.idleMin.toFixed(1) : '—') + ' ms' : (r.idle != null ? r.idle.toFixed(1) + ' ms avg' : null));
    kv('jitter', (d.jitter != null ? d.jitter : r.jitter) != null ? (d.jitter != null ? d.jitter : r.jitter).toFixed(1) + ' ms' : null);
    kv('loaded latency', d.loaded != null ? d.loaded.toFixed(1) + ' ms' : null);
    kv('bufferbloat', d.bloat != null ? '+' + d.bloat.toFixed(1) + ' ms under load' : null);
    kv('download', r.down != null ? r.down.toFixed(1) + ' Mbps' + (d.bytesDown != null ? ' · ' + humanBytes(d.bytesDown) + ' in ' + (d.secsDown != null ? d.secsDown.toFixed(1) : '—') + ' s' : '') : null);
    kv('upload', r.up != null ? r.up.toFixed(1) + ' Mbps' + (d.bytesUp != null ? ' · ' + humanBytes(d.bytesUp) + ' in ' + (d.secsUp != null ? d.secsUp.toFixed(1) : '—') + ' s' : '') : null);
    kv('config', (r.streams || '?') + ' stream(s) · ' + (r.seconds || '?') + ' s per direction' + (r.upSkipped ? ' · upload skipped' : ''));
    let html = '<div class="d-grid">' + rows.join('') + '</div>';
    if (r.notes && r.notes.length) {
      html += '<div class="d-notes mono">' + r.notes.map(function (n) { return esc(n); }).join('<br>') + '</div>';
    }
    return html;
  }
  function renderHistory() {
    const list = loadHistory();
    const tb = $('st-history');
    tb.innerHTML = '';
    if (!list.length) {
      const tr0 = document.createElement('tr');
      tr0.innerHTML = '<td colspan="6" class="h-empty">no tests yet</td>';
      tb.appendChild(tr0);
      return;
    }
    for (const r of list) {
      const tr = document.createElement('tr');
      tr.className = 'h-row';
      const d = new Date(r.t);
      tr.innerHTML =
        '<td class="mono">' + d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + '</td>' +
        '<td class="mono">' + (r.down != null ? r.down.toFixed(1) : '—') + '</td>' +
        '<td class="mono">' + (r.up != null ? r.up.toFixed(1) : '—') + '</td>' +
        '<td class="mono">' + (r.idle != null ? Math.round(r.idle) : '—') + '</td>' +
        '<td class="mono">' + (r.loaded != null ? Math.round(r.loaded) : '—') + '</td>' +
        '<td class="mono g-' + String(r.grade || 'na').toLowerCase() + '">' + (r.grade || '—') + '</td>';
      tb.appendChild(tr);
      if (r.details || (r.notes && r.notes.length)) {
        const trd = document.createElement('tr');
        trd.className = 'h-detail';
        trd.style.display = 'none';
        trd.innerHTML = '<td colspan="6">' + detailHtml(r) + '</td>';
        tb.appendChild(trd);
        tr.addEventListener('click', function () {
          trd.style.display = trd.style.display === 'none' ? '' : 'none';
          tr.classList.toggle('open');
        });
      }
    }
  }
  function pushHistory(rec) {
    rec.details = {
      idleMin: state.final.idleMin,
      jitter: state.final.jitter,
      bloat: state.final.bloat,
      bytesDown: state.final.bytesDown,
      secsDown: state.final.secsDown,
      bytesUp: state.final.bytesUp,
      secsUp: state.final.secsUp,
      upSkipped: state.final.upSkipped,
      meta: state.final.meta
    };
    rec.notes = runNotes.slice(0, 24);
    const list = loadHistory();
    list.unshift(rec);
    if (list.length > 60) list.length = 60;
    saveHistory(list);
    renderHistory();
  }
  function btnFlash(id, text) {
    const b = $(id);
    if (!b) return;
    const old = b.textContent;
    b.textContent = text;
    b.disabled = true;
    setTimeout(function () { b.textContent = old; b.disabled = false; }, 1400);
  }
  function summaryText() {
    const list = loadHistory();
    const r = list && list[0];
    if (!r) return 'No test results yet - run a test first.';
    const d = new Date(r.t);
    const det = r.details || {};
    const m = det.meta || {};
    const lines = [];
    lines.push('Speedtest · ' + d.toLocaleString() + ' · ' + (r.streams || '?') + ' streams · ' + (r.seconds || '?') + 's/direction');
    lines.push('down ' + (r.down != null ? r.down.toFixed(1) + ' Mbps' : 'n/a') +
      ' · up ' + (r.up != null ? r.up.toFixed(1) + ' Mbps' : 'n/a') +
      ' · ping ' + (r.idle != null ? r.idle.toFixed(1) + ' ms' : 'n/a') +
      ' · loaded ' + (r.loaded != null ? r.loaded.toFixed(1) + ' ms' : 'n/a') +
      ' · grade ' + (r.grade || 'n/a'));
    if (m.colo || m.isp) lines.push('server ' + (m.colo || '?') + (m.isp ? ' · ' + m.isp : ''));
    if (det.idleMin != null) lines.push('ping min ' + det.idleMin.toFixed(1) + ' ms · jitter ' + (det.jitter != null ? det.jitter.toFixed(1) : '?') + ' ms · bufferbloat +' + (det.bloat != null ? det.bloat.toFixed(1) : '?') + ' ms');
    lines.push('via ' + BASE + ' · measured in-browser, stored locally');
    return lines.join('\n');
  }
  async function copySummary() {
    const text = summaryText();
    try {
      await navigator.clipboard.writeText(text);
      btnFlash('st-copy', 'copied ✓');
    } catch (e) {
      window.prompt('Copy your summary:', text);
    }
  }
  function exportJson() {
    const list = loadHistory();
    if (!list.length) { btnFlash('st-export', 'nothing yet'); return; }
    const payload = { source: 'speedtest', exported: new Date().toISOString(), results: list };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const d = new Date();
    a.href = url;
    a.download = 'speedtest-' + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '-' + p2(d.getHours()) + p2(d.getMinutes()) + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
    btnFlash('st-export', 'exported ✓');
  }
  function clearHistory() {
    if (!confirm('Delete all locally stored test results?')) return;
    saveHistory([]);
    renderHistory();
    btnFlash('st-clear', 'cleared ✓');
  }

  /* ---------- orchestration ---------- */
  async function run() {
    if (state.running) return;
    state.running = true;
    state.stopFlag = false;
    state.samples.length = 0;
    state.hoverX = null;
    runNotes = [];
    resetFinal();
    if ($('st-live')) $('st-live').textContent = '';
    $('st-go').disabled = true;
    $('st-stop').disabled = false;
    $('st-streams').disabled = true;
    $('st-duration').disabled = true;
    const gt = $('st-grade');
    gt.textContent = '—';
    gt.className = 'tvalue mono';
    setTile('st-down', '—'); setTile('st-up', '—');
    setTile('st-lat', '—'); setTile('st-load', '—'); setTile('st-jit', '—');
    tileLive('st-down', false); tileLive('st-up', false);
    state.t0Run = performance.now();
    if (!navigator.onLine) note('browser reports offline - test will likely fail', 'warn');
    note('starting · ' + settings.streams + ' stream(s) · ' + settings.duration + ' s per direction · target ' + BASE);
    let loaded = null;
    try {
      await fetchMeta();
      await measureIdleLatency();
      if (!state.stopFlag) {
        loaded = startLoadedPings();
        await measureDownload();
        if (settings.doUp && !state.stopFlag) {
          await measureUpload();
        } else if (!state.stopFlag) {
          state.final.upSkipped = true;
          note('upload skipped (include upload unchecked)');
        }
      }
      if (loaded) { loaded.stop(); loaded = null; }
      finishLoaded();
      if (state.stopFlag) {
        phase('stopped', 0);
        note('stopped by user', 'warn');
      } else {
        phase('done', 100);
        if ($('st-live')) {
          $('st-live').textContent = 'Test complete. Download ' + (state.final.down != null ? fmtSpeed(state.final.down) + ' ' + unitStr() : 'not measured') +
            ', upload ' + (state.final.up != null ? fmtSpeed(state.final.up) + ' ' + unitStr() : 'not measured') +
            ', latency ' + (state.final.idle != null ? Math.round(state.final.idle) + ' milliseconds' : 'not measured') +
            ', bufferbloat grade ' + (state.final.grade || 'not measured') + '.';
        }
        note('test complete · only random test bytes left this device');
        pushHistory({
          t: Date.now(),
          down: state.final.down,
          up: state.final.up,
          idle: state.final.idle,
          loaded: state.final.loaded,
          grade: state.final.grade,
          streams: settings.streams,
          seconds: settings.duration,
          upSkipped: state.final.upSkipped
        });
      }
    } catch (e) {
      if (loaded) loaded.stop();
      phase('failed', 0);
      note('failed: ' + (e && e.message ? e.message : String(e)), 'err');
    }
    abortAll();
    $('st-go').disabled = false;
    $('st-stop').disabled = true;
    $('st-streams').disabled = false;
    $('st-duration').disabled = false;
    tileLive('st-down', false); tileLive('st-up', false);
    state.running = false;
  }

  /* ---------- wire-up ---------- */
  $('st-go').addEventListener('click', run);
  $('st-stop').addEventListener('click', function () {
    state.stopFlag = true;
    abortAll();
    note('stopping…', 'warn');
  });
  $('st-copy').addEventListener('click', copySummary);
  $('st-export').addEventListener('click', exportJson);
  $('st-clear').addEventListener('click', clearHistory);
  $('st-units').addEventListener('click', function () {
    settings.units = settings.units === 'mbps' ? 'mbytes' : 'mbps';
    saveSettings();
    syncUnits();
    if (state.final.down != null) setTile('st-down', fmtSpeed(state.final.down));
    if (state.final.up != null) setTile('st-up', fmtSpeed(state.final.up));
    drawGraph();
  });
  $('st-streams').value = String(settings.streams);
  $('st-duration').value = String(settings.duration);
  $('st-do-up').checked = settings.doUp;
  $('st-streams').addEventListener('change', function () { settings.streams = Number($('st-streams').value) || 4; saveSettings(); });
  $('st-duration').addEventListener('change', function () { settings.duration = Number($('st-duration').value) || 10; saveSettings(); });
  $('st-do-up').addEventListener('change', function () { settings.doUp = $('st-do-up').checked; saveSettings(); });

  function showConnection() {
    const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (!c) { $('st-conn').textContent = ''; return; }
    const bits = [];
    if (c.effectiveType) bits.push(c.effectiveType);
    if (typeof c.rtt === 'number' && c.rtt) bits.push('rtt ~' + c.rtt + ' ms');
    if (typeof c.downlink === 'number' && c.downlink) bits.push('downlink ~' + c.downlink + ' Mb/s');
    $('st-conn').textContent = bits.length ? 'browser estimate: ' + bits.join(' · ') : '';
  }

  /* canvas hover crosshair */
  const cv = $('st-canvas');
  function hoverFromEvent(e) {
    const rect = cv.getBoundingClientRect();
    const cx = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
    state.hoverX = cx;
    drawGraph();
  }
  cv.addEventListener('mousemove', hoverFromEvent);
  cv.addEventListener('touchmove', function (e) { hoverFromEvent(e); }, { passive: true });
  cv.addEventListener('mouseleave', function () { state.hoverX = null; drawGraph(); });
  cv.addEventListener('touchend', function () { state.hoverX = null; drawGraph(); });

  syncUnits();
  renderHistory();
  showConnection();
  drawGraph();
  window.addEventListener('resize', drawGraph);
}());
