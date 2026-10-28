/* fx.js — presentation layer. Reads the DOM the engine (app.js) updates
   and drives: 1) connection details panel, 2) data-flow animation whose
   direction follows the current test phase, 3) Bufferbloat grade tinting.
   It never writes to anything the engine owns. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  /* ---------- 1. Connection details (Cloudflare /meta) ---------- */
  const txt = (v) => (v == null ? null : typeof v === 'object' ? (v.code || v.name || v.iata || null) : String(v));

  function applyMeta(m) {
    const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    set('st-i-server', txt(m.hostname) || 'speed.cloudflare.com');
    set('st-i-colo', [txt(m.colo), txt(m.city)].filter(Boolean).join(' · ') || '—');
    set('st-i-conn', (txt(m.asOrganization) || 'unknown network') + (m.asn ? ' · AS' + m.asn : ''));
    set('st-i-ip', txt(m.clientIp) || '—');
    set('st-i-endpoint', [txt(m.httpProtocol), txt(m.hostname)].filter(Boolean).join(' · ') || '—');
  }

  async function loadMeta() {
    try {
      const r = await fetch('https://speed.cloudflare.com/meta', { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      applyMeta(await r.json());
    } catch (e) {
      applyMeta({});
    }
  }
  loadMeta();
  /* the engine already fetches /meta at the start of every run and
     hands it over here, so we never request it twice */
  document.addEventListener('st:meta', (e) => { if (e.detail) applyMeta(e.detail); });

  /* ---------- 2. Phase engine (drives the wire animation) ---------- */
  const flow = $('st-flow');
  let authPhase = '';        // phase stated by the engine's own status line
  let lastActivity = Date.now();

  function setPhase(p) {
    lastActivity = Date.now();
    if (flow) flow.dataset.phase = p;
  }

  function watchText(el, fn) {
    if (!el) return;
    new MutationObserver(fn).observe(el, { childList: true, characterData: true, subtree: true });
  }

  /* engine status strings: "idle — press Start", "latency: warming up",
     "latency: 3/8", "download: 15 MB", "upload: 15 MB", "done", "stopped",
     "failed", plus "✖/⚠ " flashes */
  watchText($('st-phase'), () => {
    const t = ($('st-phase').textContent || '').toLowerCase();
    if (/\bdown/.test(t)) { authPhase = 'download'; setPhase('download'); }
    else if (/\bupload/.test(t)) { authPhase = 'upload'; setPhase('upload'); }
    else if (/latency|ping|loaded|jitter|bufferbloat/.test(t)) { authPhase = 'latency'; setPhase('latency'); }
    else if (/idle|done|stopped|failed|complete|finish|ready/.test(t)) { authPhase = ''; setPhase('idle'); }
  });

  /* fallback: result tiles ticking (covers unexpected status texts) */
  const TICK_PHASE = {
    'st-down': 'download', 'st-up': 'upload',
    'st-lat': 'latency', 'st-load': 'latency', 'st-jit': 'latency'
  };
  Object.keys(TICK_PHASE).forEach((id) => {
    watchText($(id), () => {
      if (!authPhase) setPhase(TICK_PHASE[id]);
    });
  });

  /* safety net: go dormant when everything has been quiet for a while */
  setInterval(() => {
    if (!flow || flow.dataset.phase === 'idle') return;
    const quiet = Date.now() - lastActivity;
    if (quiet > 4000 && (!authPhase || quiet > 9000)) flow.dataset.phase = 'idle';
  }, 1000);

  /* explicit user actions */
  const goBtn = $('st-go');
  const stopBtn = $('st-stop');
  if (goBtn) goBtn.addEventListener('click', () => {
    authPhase = '';
    setPhase('latency');          // the run opens with the latency phase
  });
  if (stopBtn) stopBtn.addEventListener('click', () => { authPhase = ''; setPhase('idle'); });

  /* ---------- 3. Bufferbloat grade -> tint the tile edge ---------- */
  watchText($('st-grade'), () => {
    const el = $('st-grade');
    const m = (el.textContent || '').match(/[A-F]/i);
    const tile = el.closest('.tile');
    if (tile) { if (m) tile.dataset.grade = m[0].toLowerCase(); else tile.removeAttribute('data-grade'); }
  });
})();
