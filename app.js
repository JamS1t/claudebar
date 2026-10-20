// Renderer: layout, hover intent, spring-driven morphing between the dock, the popovers and the
// panel, and the panel's content. Glass pixels come from glass.js; text and controls are DOM.
(function () {
  'use strict';
  const { Spring, clamp, lerp, lerpRect, inside, tokens, duration, esc } = window.Shared;
  const bridge = window.bridge;
  const $ = id => document.getElementById(id);
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // geometry, css px
  const DOCK_W = 62, DOCK_H = 264, FLY_W = 248, FLY_H = 88, PANEL_W = 368, PANEL_MAX_H = 600, PROJ_W = 320, PROJ_MAX_H = 460;
  const PANEL_GAP = 14, FLY_GAP = 12, RING_Y = { session: 34, weekly: 102 }, LAUNCH_Y = 170, EXPAND_Y = 232;
  const OPEN_DELAY = 90, CLOSE_DELAY = 260, FLY_DELAY = 50, FLY_HIDE = 140, SWAP_DELAY = 120;
  const MAX_ROWS = 60; // launcher rows drawn at once

  const RING = { session: ['#FFB340', '#FF6A3D'], weekly: ['#64D2FF', '#0A84FF'], critical: ['#FF8A80', '#FF453A'] };
  const SEV = { good: '#30D158', ok: '#0A84FF', warn: '#FF9F0A', high: '#FF453A' };
  const MIX = { cacheRead: '#FF9F0A', cacheWrite: '#FFD60A', output: '#0A84FF', input: '#30D158' };
  const ICON = {
    gauge: '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
    hourglass: '<path d="M5 22h14M5 2h14"/><path d="M17 22v-4.17a2 2 0 0 0-.59-1.42L12 12l-4.41 4.41A2 2 0 0 0 7 17.83V22"/><path d="M7 2v4.17a2 2 0 0 0 .59 1.42L12 12l4.41-4.41A2 2 0 0 0 17 6.17V2"/>',
    layers: '<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/>',
    doc: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8"/>',
    bolt: '<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>',
    people: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    cpu: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M15 2v2M15 20v2M2 15h2M2 9h2M20 15h2M20 9h2M9 2v2M9 20v2"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    pie: '<path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/>',
    message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    scissors: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.12 15.88M14.47 14.48 20 20M8.12 8.12 12 12"/>',
    terminal: '<path d="m4 17 6-6-6-6M12 19h8"/>',
    chevron: '<path d="m9 6 6 6-6 6"/>',
  };

  const state = { vm: null, w: innerWidth, h: innerHeight, dockY: 0, pointer: null, zone: null,
    fly: null, flyKind: null, flyFrom: null, panelFrom: null, lastFly: null, lastPanel: null,
    panel: false, pmode: 'details', // panel: false | 'details' | 'projects'; pmode outlives it while closing
    tab: 0, forced: null, drag: null, ignoring: true };
  const springs = {
    panel: new Spring(0, 230, 25), fly: new Spring(0, 340, 31), flyY: new Spring(0, 420, 40),
    hover: new Spring(0, 320, 26), tDock: new Spring(0, 70, 17), tFly: new Spring(0, 70, 17), tPanel: new Spring(0, 70, 17),
  };
  const timers = {};
  const later = (name, ms, fn) => { if (!timers[name]) timers[name] = setTimeout(() => { timers[name] = 0; fn(); }, ms); };
  const cancel = name => { clearTimeout(timers[name]); timers[name] = 0; };

  // ---------- geometry ----------
  const dockLeft = () => state.w - DOCK_W;
  const dockRect = () => ({ x: dockLeft(), y: state.dockY, w: DOCK_W, h: DOCK_H });
  const ringRect = k => ({ x: dockLeft() + 11, y: state.dockY + RING_Y[k] - 20, w: 40, h: 40 });
  const expandRect = () => ({ x: dockLeft() + 13, y: state.dockY + EXPAND_Y - 14, w: 36, h: 28 });
  const launchRect = () => ({ x: dockLeft() + 11, y: state.dockY + LAUNCH_Y - 20, w: 40, h: 40 });
  const panelTarget = (mode = state.pmode) => {
    const [w, maxH, cy] = mode === 'projects' ? [PROJ_W, PROJ_MAX_H, LAUNCH_Y] : [PANEL_W, PANEL_MAX_H, DOCK_H / 2];
    const h = Math.min(maxH, state.h - 24);
    return { x: dockLeft() - PANEL_GAP - w, y: clamp(state.dockY + cy - h / 2, 12, state.h - h - 12), w, h };
  };
  const panelOrigin = () => (state.pmode === 'projects' ? launchRect() : expandRect());
  const flyTargetY = k => clamp(state.dockY + RING_Y[k] - FLY_H / 2, 8, state.h - FLY_H - 8);
  const flyTarget = () => ({ x: dockLeft() - FLY_GAP - FLY_W, y: springs.flyY.value, w: FLY_W, h: FLY_H });

  // ---------- glass + frame loop ----------
  const glass = new window.Glass($('glass'));
  // without WebGL the surfaces get a plain tinted background from CSS
  glass.onStatus = ok => { document.body.classList.toggle('noglass', !ok); kick(); };
  document.body.classList.toggle('noglass', !glass.ok);
  let raf = 0, last = 0, lastDraw = 0, idleTimer = 0;
  const kick = () => { if (!raf) raf = requestAnimationFrame(frame); };
  // While nothing moves and the pointer is away, the backdrop only needs a few redraws a second.
  // Redrawing at full capture rate kept the GPU busy all day and starved clicks on a loaded machine.
  const IDLE_FRAME = 1000 / 10;
  const awake = () => !!(state.zone || state.panel || state.fly || state.drag) ||
    Object.values(springs).some(s => s.moving);
  glass.onFrame = () => {
    if (raf || idleTimer) return;
    const wait = IDLE_FRAME - (performance.now() - lastDraw);
    if (wait <= 0 || awake()) kick();
    else idleTimer = setTimeout(() => { idleTimer = 0; kick(); }, wait);
  };

  function frame(now) {
    raf = 0;
    lastDraw = performance.now();
    const dt = last ? Math.min((now - last) / 1000, 1 / 30) : 1 / 60;
    last = now;
    let moving = false;
    for (const s of Object.values(springs)) {
      if (REDUCED) s.snap(s.target); else s.step(dt);
      moving = moving || s.moving;
    }
    layout();
    if (moving) kick(); else last = 0;
  }

  function layout() {
    const P = springs.panel.value, F = springs.fly.value, H = springs.hover.value;
    const d = dockRect();
    // the dock swells slightly under the pointer, like interactive glass
    const dock = { rect: { x: d.x - 2 * H, y: d.y - 3 * H, w: d.w + 48 + 2 * H, h: d.h + 6 * H },
      radius: DOCK_W / 2 + 2 * H, exp: 2, merge: 0, theme: springs.tDock.value, frost: 1, shadow: 0.2, tint: 0.12 };

    if (state.flyKind && F <= 0.002 && springs.fly.target === 0) state.flyKind = null;
    let fly = null, flyRect = null;
    if (state.flyKind && F > 0.002) {
      const f = clamp(F, 0, 1);
      flyRect = lerpRect(state.flyFrom || ringRect(state.flyKind), flyTarget(), F);
      fly = { rect: flyRect, radius: lerp(20, 24, f), exp: lerp(2, 4, f), merge: 28 * (1 - f), theme: springs.tFly.value, frost: 1, shadow: 0.24 * f, tint: 0.17, sample: flyTarget() };
    }
    let panel = null, panelRect = null;
    if (P > 0.002) {
      const p = clamp(P, 0, 1);
      panelRect = lerpRect(state.panelFrom || panelOrigin(), panelTarget(), P);
      panel = { rect: panelRect, radius: lerp(14, 30, p), exp: lerp(2, 4, p), merge: 36 * (1 - p), theme: springs.tPanel.value, frost: 1, shadow: 0.3 * p, tint: 0.2, sample: panelTarget() };
    }
    state.lastFly = flyRect;
    state.lastPanel = panelRect;
    glass.render([dock, fly, panel], state.w + 8);

    css($('dock'), 'transform', `translate(${d.x}px, ${d.y}px)`);
    place($('fly'), flyTarget(), flyRect, fly && fly.radius, F);
    const proj = state.pmode === 'projects';
    place($('panel'), panelTarget(), proj ? null : panelRect, panel && panel.radius, P);
    place($('projects'), panelTarget(), proj ? panelRect : null, panel && panel.radius, P);
    ink($('dock'), springs.tDock.value);
    ink($('fly'), springs.tFly.value);
    ink($('panel'), springs.tPanel.value);
    ink($('projects'), springs.tPanel.value);
    themeFromBackdrop();
  }

  // Content sits at its final rect and is revealed through the growing glass shape.
  // Only touches the DOM when a value changes: this runs on every captured video frame, and
  // rewriting clip-path each time repaints the whole panel and stalls tab switches.
  function place(el, target, cur, radius, progress) {
    if (!cur) { css(el, 'visibility', 'hidden'); return; }
    const t = Math.max(0, cur.y - target.y), l = Math.max(0, cur.x - target.x);
    const r = Math.max(0, target.x + target.w - cur.x - cur.w), b = Math.max(0, target.y + target.h - cur.y - cur.h);
    const o = clamp((progress - 0.5) / 0.38, 0, 1);
    css(el, 'visibility', 'visible');
    css(el, 'transform', `translate(${target.x}px, ${target.y}px)`);
    css(el, 'height', `${target.h}px`);
    css(el, 'clipPath', o >= 1 && !t && !r && !b && !l ? `inset(0 round ${radius}px)` :
      `inset(${t.toFixed(1)}px ${r.toFixed(1)}px ${b.toFixed(1)}px ${l.toFixed(1)}px round ${radius.toFixed(1)}px)`);
    css(el, 'opacity', o.toFixed(3));
  }
  function css(el, k, v) {
    const c = el._css || (el._css = {});
    if (c[k] !== v) { c[k] = v; el.style[k] = v; }
  }
  function text(el, v) { if (el.textContent !== v) el.textContent = v; }
  function setHtml(el, v) { if (el._html !== v) { el._html = v; el.innerHTML = v; } }

  function ink(el, t) {
    const v = Math.round(255 * (1 - t));
    if (el._ink === v) return;
    el._ink = v;
    el.style.setProperty('--ink', `${v}, ${v}, ${v}`);
    el.classList.toggle('light', t > 0.5);
  }

  // Light backdrop -> light glass with dark text, and back, with hysteresis. A surface that just
  // appeared asks for a reading of its own backdrop at once and snaps to it, instead of fading
  // over from the appearance it had wherever it was last open.
  const themeGen = [0, 0, 0], themeFirst = [false, true, true];
  function themeFromBackdrop() {
    const shown = [true, !!state.lastFly, !!state.lastPanel];
    ['tDock', 'tFly', 'tPanel'].forEach((k, i) => {
      const s = springs[k];
      if (!shown[i]) { themeFirst[i] = true; return; }
      if (themeFirst[i] === true) {
        themeFirst[i] = 'waiting';
        themeGen[i] = glass.lumaGen[i];
        glass.sampleSoon();
        if (s.target !== springs.tDock.target) s.snap(springs.tDock.target); // until it has one
      }
      if (glass.lumaGen[i] === themeGen[i]) return; // no new reading yet
      themeGen[i] = glass.lumaGen[i];
      const l = glass.luma[i];
      if (themeFirst[i]) { themeFirst[i] = false; s.snap(l > 0.54 ? 1 : 0); kick(); }
      else if (l > 0.62 && s.target === 0) { s.set(1); kick(); }
      else if (l < 0.46 && s.target === 1) { s.set(0); kick(); }
    });
  }

  // ---------- hover intent ----------
  function zoneAt(p) {
    if (!p) return null;
    for (const k of ['session', 'weekly']) if (inside(ringRect(k), p, 8)) return k;
    if (inside(launchRect(), p, 6)) return 'launch';
    if (inside(expandRect(), p, 6)) return 'expand';
    return inside(dockRect(), p) ? 'dock' : null;
  }

  function onPointer(p) {
    state.pointer = p;
    if (state.forced || state.drag) return;
    const zone = zoneAt(p);
    setHover(zone);
    const t = panelTarget();
    const inPanel = state.panel && inside(t, p, 6);
    const bridgeZone = state.panel && p.x >= t.x + t.w - 4 && p.x <= dockLeft() + 6 &&
      p.y >= Math.min(t.y, state.dockY) && p.y <= Math.max(t.y + t.h, state.dockY + DOCK_H);

    const ring = zone === 'session' || zone === 'weekly';
    const want = zone === 'expand' ? 'details' : zone === 'launch' ? 'projects' : null;
    // resting on another dock control morphs the open panel into that control's surface
    intent('swapRing', state.panel && ring, SWAP_DELAY, () => { if (zoneAt(state.pointer) === zone) setFly(zone); });
    intent('swapPanel', state.panel && want && want !== state.panel, SWAP_DELAY, () => { if (zoneAt(state.pointer) === zone) setPanel(want); });
    intent('open', !state.panel && want && !state.clickedShut, OPEN_DELAY, () => { if (zoneAt(state.pointer) === zone) setPanel(want); });
    if (state.panel) {
      // a search in progress keeps the launcher open until Esc, a pick, or a click elsewhere
      if (zone || inPanel || bridgeZone || searching()) cancel('close'); else later('close', CLOSE_DELAY, () => setPanel(false));
    }

    if (!state.panel && ring) {
      cancel('flyHide');
      if (state.fly) setFly(zone); else later('flyShow', FLY_DELAY, () => setFly(zone));
    } else {
      cancel('flyShow');
      if (state.fly) later('flyHide', FLY_HIDE, () => setFly(null));
    }

    const interactive = !!zone || (inPanel && springs.panel.value > 0.4);
    if (interactive === state.ignoring) {
      state.ignoring = !interactive;
      bridge.setIgnore(state.ignoring);
    }
  }

  function intent(name, active, ms, fn) { if (active) later(name, ms, fn); else cancel(name); }
  const searching = () => state.panel === 'projects' && document.activeElement === $('q');

  function setHover(zone) {
    if (zone === state.zone) return;
    state.zone = zone;
    // per visit to a control: was its panel already open on arrival, and did a click shut it
    state.enterPanel = state.panel;
    state.clickedShut = false;
    $('ring-session').classList.toggle('hover', zone === 'session');
    $('ring-weekly').classList.toggle('hover', zone === 'weekly');
    $('expand').classList.toggle('hover', zone === 'expand');
    $('launch').classList.toggle('hover', zone === 'launch');
    springs.hover.set(zone ? 1 : 0);
    kick();
  }

  function setFly(kind) {
    cancel('flyShow');
    cancel('flyHide');
    if (kind) {
      if (state.panel) {
        // morph: the panel's glass becomes the popover, growing from where the panel is now
        state.flyFrom = state.lastPanel;
        closePanelNow();
        springs.fly.snap(0);
        springs.flyY.snap(flyTargetY(kind));
      } else if (!state.flyKind) { state.flyFrom = null; springs.flyY.snap(flyTargetY(kind)); }
      springs.flyY.set(flyTargetY(kind));
      state.fly = state.flyKind = kind;
      renderFly();
      springs.fly.set(1);
    } else {
      state.fly = null;
      state.flyFrom = null;
      springs.fly.set(0);
    }
    kick();
  }

  function closePanelNow() {
    cancel('close');
    state.panel = false;
    state.panelFrom = null;
    springs.panel.snap(0);
    panelClosed();
  }

  function panelClosed() {
    $('expand').classList.remove('open');
    $('launch').classList.remove('open');
    if (document.activeElement === $('q')) { $('q').blur(); bridge.focus(false); }
  }

  // mode: false | 'details' | 'projects'
  function setPanel(mode) {
    cancel('open');
    cancel('close');
    cancel('swapPanel');
    if (mode === state.panel) return;
    if (mode) {
      // morph: a visible popover's, or the other panel's, glass grows into this panel
      const fromFly = state.flyKind && springs.fly.value > 0.3;
      const fromPanel = state.panel && springs.panel.value > 0.3;
      state.panelFrom = fromFly ? state.lastFly : fromPanel ? state.lastPanel : null;
      if (fromFly) { springs.fly.snap(0); state.flyKind = null; state.flyFrom = null; }
      if (fromPanel) { springs.panel.snap(0); panelClosed(); }
      setFly(null);
      state.panel = state.pmode = mode;
      if (mode === 'details') { $('content').scrollTop = 0; renderPanel(true); }
      else { $('q').value = ''; $('proj-list').scrollTop = 0; renderProjects(); }
      $('expand').classList.toggle('open', mode === 'details');
      $('launch').classList.toggle('open', mode === 'projects');
    } else {
      state.panel = false;
      state.panelFrom = null;
      panelClosed();
    }
    springs.panel.set(mode ? 1 : 0);
    kick();
  }

  // No fade on switch: Element.animate on #content made Chromium restyle it from a stale base style
  // that still inherited the closed panel's visibility: hidden, leaving the new tab blank.
  function setTab(i) {
    if (i === state.tab) return;
    state.tab = i;
    renderPanel(false); // rings/bars show final values at once; only opening the panel animates them
    $('content').scrollTop = 0;
  }

  // ---------- rendering ----------
  const ringColors = (kind, pct) => (pct >= 90 ? RING.critical : RING[kind]);
  const pctW = v => `${clamp(v * 100, 2, 100).toFixed(1)}%`;
  const svg = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[name] || ''}</svg>`;
  // biggest unit only, so the time never squeezes the project name: "now", "4 min", "3 hr", "2 days"
  const ago = t => {
    const m = Math.floor((Date.now() - t) / 60e3), h = Math.floor(m / 60), d = Math.floor(h / 24);
    return m < 1 ? 'now' : d ? `${d} day${d > 1 ? 's' : ''} ago` : h ? `${h} hr ago` : `${m} min ago`;
  };
  const resetsIn = l => (l ? `Resets in ${duration(l.resetsAt - Date.now())}` : 'Loading…');
  const section = (title, note = '') => `<div class="section"><h3>${title}</h3><span>${note}</span></div>`;
  const empty = text => `<div class="group"><div class="empty">${esc(text)}</div></div>`;
  const row = ({ icon, color, title, sub, val, top }) =>
    `<div class="row${top ? ' top' : ''}" style="--inset:54px"><span class="tile" style="background:${color}">${svg(icon)}</span>` +
    `<div class="row-main"><div class="row-line"><span class="row-title strong">${esc(title)}</span>` +
    `${val ? `<span class="row-val num">${esc(val)}</span>` : ''}</div>${sub ? `<div class="row-sub">${esc(sub)}</div>` : ''}</div></div>`;

  function updateDock() {
    for (const kind of ['session', 'weekly']) {
      const l = state.vm && state.vm[kind];
      const pct = l ? l.pct : 0;
      const ring = $(`ring-${kind}`);
      const [c1, c2] = ringColors(kind, pct);
      const stops = ring.querySelectorAll('stop');
      stops[0].setAttribute('stop-color', c1);
      stops[1].setAttribute('stop-color', c2);
      ring.querySelector('.arc').style.strokeDashoffset = String(108.38 * (1 - clamp(pct, 0, 100) / 100));
      ring.querySelector('.ring-val').textContent = l ? String(pct) : '–';
      ring.setAttribute('aria-label', `${kind === 'session' ? 'Session' : 'Weekly'} usage ${l ? `${pct}%` : 'loading'}`);
    }
  }

  function renderFly() {
    const kind = state.flyKind, vm = state.vm;
    if (!kind) return;
    const l = vm && vm[kind];
    const pct = l ? l.pct : 0;
    const [c1, c2] = ringColors(kind, pct);
    $('fly-dot').style.background = c2;
    $('fly-title').textContent = kind === 'session' ? 'Session' : 'Weekly';
    $('fly-val').textContent = l ? `${pct}%` : '—';
    $('fly-sub').textContent = resetsIn(l) + (kind === 'weekly' && l && l.pace != null ? ` · Pace ${Math.round(l.pace)}%` : '');
    $('fly-bar').style.width = `${clamp(pct, 0, 100)}%`;
    $('fly-bar').style.background = `linear-gradient(90deg, ${c1}, ${c2})`;
  }

  function concentric(vm) {
    const ring = (kind, r, id) => {
      const pct = vm[kind] ? vm[kind].pct : 0;
      const [c1, c2] = ringColors(kind, pct);
      const C = 2 * Math.PI * r;
      return `<defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>` +
        `<circle cx="60" cy="60" r="${r}" stroke="${c2}" stroke-opacity=".2" stroke-width="12"/>` +
        `<circle class="arc" cx="60" cy="60" r="${r}" stroke="url(#${id})" stroke-width="12" stroke-dasharray="${C}" stroke-dashoffset="${C}" data-offset="${C * (1 - clamp(pct, 0, 100) / 100)}"/>`;
    };
    return `<svg viewBox="0 0 120 120" aria-hidden="true">${ring('session', 52, 'hero-s')}${ring('weekly', 37, 'hero-w')}</svg>`;
  }

  function overview(vm) {
    const stat = (kind, title) => {
      const l = vm[kind];
      return `<div><div class="hero-label"><i class="dot" style="background:${ringColors(kind, l ? l.pct : 0)[1]}"></i>${title}</div>` +
        `<div class="hero-val num">${l ? `${l.pct}%` : '—'}</div><div class="hero-sub">${resetsIn(l)}</div></div>`;
    };
    let html = `<div class="group hero">${concentric(vm)}<div class="hero-stats">${stat('session', 'Session')}${stat('weekly', 'Weekly')}</div></div>`;
    const rows = [];
    if (vm.weekly && vm.weekly.pace != null) {
      const p = Math.round(vm.weekly.pace);
      rows.push(row({ icon: 'gauge', color: p > 105 ? SEV.warn : SEV.ok, title: 'Weekly pace', val: `${p}%`,
        sub: p > 105 ? 'Ahead of an even burn rate' : p >= 95 ? 'Right on an even burn rate' : 'Below an even burn rate' }));
    }
    if (vm.breakdown.length) {
      rows.push(row({ icon: 'pie', color: '#5E5CE6', title: 'By surface', sub: vm.breakdown.map(b => `${b.name} ${b.pct}%`).join(' · ') }));
    }
    if (rows.length) html += `<div class="group">${rows.join('')}</div>`;
    if (vm.err) html += `<div class="group"><div class="empty error">${esc(vm.err)}</div></div>`;
    html += section('Live Sessions', 'Context of 1M');
    if (vm.scanning) return html + empty('Scanning transcripts…');
    if (!vm.live.length) return html + empty('No sessions active in the last 15 minutes.');
    return html + `<div class="group">${vm.live.map(s => {
      const c = s.ctx > 300e3 ? SEV.high : s.ctx > 150e3 ? SEV.warn : SEV.good;
      return `<div class="row" style="--inset:34px"><i class="dot" style="background:${c}"></i><div class="row-main">` +
        `<div class="row-line"><span class="row-title">${esc(s.name)}</span><span class="row-detail num">${tokens(s.ctx)} · ${s.turns} turns</span></div>` +
        `<div class="bar"><i style="width:${pctW(s.ctx / 1e6)};background:${c}"></i></div></div></div>`;
    }).join('')}</div>`;
  }

  function projects(vm) {
    if (vm.scanning) return empty('Scanning transcripts…');
    let html = section('Top Projects', 'Last 7 days') + `<div class="group">${vm.projects.map((p, i) =>
      `<div class="row" style="--inset:40px"><span class="rank num">${i + 1}</span><div class="row-main">` +
      `<div class="row-line"><span class="row-title">${esc(p.name)}</span><span class="row-val num">${Math.round(p.share * 100)}%</span></div>` +
      `<div class="bar"><i style="width:${pctW(p.rel)};background:linear-gradient(90deg, ${RING.session[0]}, ${RING.session[1]})"></i></div></div></div>`).join('')}</div>`;
    html += section('Where Tokens Go', 'Weighted by cost') +
      `<div class="group"><div class="mix">${vm.mix.filter(m => m.share > 0.004).map(m => `<i style="flex:${m.share};background:${MIX[m.key]}"></i>`).join('')}</div>` +
      `<div class="legend">${vm.mix.map(m => `<div><i class="dot" style="background:${MIX[m.key]}"></i>${m.label}<b class="num">${Math.round(m.share * 100)}%</b></div>`).join('')}</div></div>`;
    html += `<p class="foot">Subagents account for ${Math.round(vm.subShare * 100)}% of usage. Most-used tools: ` +
      `${vm.tools.map(([n, c]) => `${esc(n)} ${c.toLocaleString()}`).join(', ')}.</p>`;
    return html;
  }

  function insights(vm) {
    if (vm.scanning) return empty('Scanning transcripts…');
    return `<div class="group">${vm.tips.map(t => row({ icon: t.icon, color: SEV[t.sev], title: t.title, sub: t.body, top: true })).join('')}</div>`;
  }

  function plugins(vm) {
    if (vm.scanning) return empty('Scanning transcripts…');
    const p = vm.plug;
    const stats = [
      [`${Math.round(p.out * 100)}%`, 'of usage is output'],
      [`~${Math.round(p.save * 100)}%`, 'saved at most by halving output'],
      [p.rtk ? p.rtk.saved : '—', p.rtk ? `saved by RTK, ${Math.round(p.rtk.pct)}% of command output` : 'RTK not found'],
    ];
    return `<div class="stats">${stats.map(([v, c]) => `<div class="stat"><b class="num">${esc(v)}</b><span>${esc(c)}</span></div>`).join('')}</div>` +
      section('What Each Does') + `<div class="group">${[
      { icon: 'message', color: '#5E5CE6', title: 'Caveman', sub: 'Shorter replies from Claude. Cuts output tokens only.' },
      { icon: 'scissors', color: '#FF375F', title: 'Ponytail', sub: 'Less code written per change. Also cuts output tokens only.' },
      { icon: 'terminal', color: '#30B0C7', title: 'RTK', sub: 'Filters command output before Claude reads it. Cuts context, which is most of your usage.' },
    ].map(r => row({ ...r, top: true })).join('')}</div><p class="foot">${esc(p.verdict)}</p>`;
  }

  const TABS = [overview, projects, insights, plugins];

  function renderPanel(animate) {
    const vm = state.vm;
    if (!vm) return;
    text($('plan'), vm.plan || '');
    text($('updated'), `Updated ${new Date(vm.updated).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`);
    document.querySelectorAll('#seg button').forEach((b, i) => {
      b.classList.toggle('on', i === state.tab);
      b.setAttribute('aria-selected', String(i === state.tab));
    });
    css($('thumb'), 'transform', `translateX(${state.tab * 100}%)`);
    const content = $('content');
    const html = TABS[state.tab](vm);
    // Unchanged content is left alone: replacing it on every refresh repainted the panel and could
    // swallow a click whose target was swapped out between press and release.
    if (!animate && content._html === html) return;
    content._html = html;
    const scroll = content.scrollTop;
    content.innerHTML = html;
    content.scrollTop = scroll;
    const arcs = content.querySelectorAll('.arc[data-offset]');
    const apply = () => arcs.forEach(a => { a.style.strokeDashoffset = a.dataset.offset; });
    if (animate && !REDUCED) requestAnimationFrame(() => requestAnimationFrame(apply));
    else { arcs.forEach(a => { a.style.transition = 'none'; }); apply(); }
  }

  // ---------- projects launcher ----------
  // every whitespace-separated term must appear in the folder name or path
  function matches() {
    const terms = $('q').value.toLowerCase().split(/\s+/).filter(Boolean);
    return ((state.vm && state.vm.recent) || []).filter(r => {
      const hay = `${r.name}\n${r.cwd}`.toLowerCase();
      return terms.every(t => hay.includes(t));
    });
  }

  function renderProjects() {
    const vm = state.vm, list = $('proj-list');
    const all = (vm && vm.recent) || [];
    text($('proj-count'), all.length ? `${all.length} folders` : '');
    if (!vm || vm.scanning) { setHtml(list, empty('Scanning transcripts…')); return; }
    const q = $('q').value, found = matches();
    if (!found.length) { setHtml(list, empty(q ? 'No project matches.' : 'No projects yet.')); return; }
    // Long histories (worktrees, temp folders) reach thousands of folders; drawing them all made
    // opening the launcher stall. Search still covers every folder.
    const shown = found.slice(0, MAX_ROWS);
    setHtml(list, section(q ? 'Matches' : 'Recent', 'Resume in terminal') + `<div class="group">${shown.map((r, i) =>
      `<div class="row action${i === 0 && q ? ' first' : ''}" style="--inset:54px" data-cwd="${esc(r.cwd)}" title="${esc(r.cwd)}">` +
      `<span class="tile" style="background:#30B0C7">${svg('terminal')}</span><div class="row-main">` +
      `<div class="row-line"><span class="row-title strong">${esc(r.name)}</span>` +
      `<span class="row-detail">${esc(ago(r.mtime))}</span></div><div class="row-sub path">${esc(r.cwd)}</div></div>` +
      `<span class="go">${svg('chevron')}</span></div>`).join('')}</div>` +
      (found.length > shown.length ? `<p class="foot">${found.length - shown.length} older folders. Search to find them.</p>` : ''));
  }

  function launch(cwd, el) {
    bridge.openProject(cwd);
    if (el && !REDUCED) el.animate([{ transform: 'scale(.97)' }, { transform: 'none' }], { duration: 220, easing: 'cubic-bezier(.34, 1.36, .64, 1)' });
    setTimeout(() => setPanel(false), 300); // the terminal takes focus; get out of the way
  }

  function update() {
    updateDock();
    if (state.flyKind) renderFly();
    if (state.panel === 'details') renderPanel(false);
    if (state.panel === 'projects' && !searching()) renderProjects();
  }

  // ---------- input ----------
  $('proj-list').addEventListener('click', e => {
    const a = e.target.closest('[data-cwd]');
    if (a) launch(a.dataset.cwd, a);
  });
  // borrow keyboard focus only once the search field is clicked
  $('q').addEventListener('pointerdown', async e => {
    if (document.activeElement === $('q')) return;
    e.preventDefault();
    await bridge.focus(true);
    $('q').focus();
  });
  $('q').addEventListener('input', () => { $('proj-list').scrollTop = 0; renderProjects(); });
  $('q').addEventListener('keydown', e => {
    if (e.key === 'Escape') setPanel(false);
    else if (e.key === 'Enter') { const r = matches()[0]; if (r) launch(r.cwd, $('proj-list').querySelector('.row.action')); }
  });
  // clicking anywhere outside the window ends the search
  addEventListener('blur', () => { if (state.panel === 'projects') setPanel(false); });
  $('seg').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (b) setTab(Number(b.dataset.tab));
  });

  const dockEl = $('dock');
  dockEl.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    state.drag = { y: e.clientY, from: state.dockY, moved: false, zone: zoneAt({ x: e.clientX, y: e.clientY }) };
    dockEl.setPointerCapture(e.pointerId);
  });
  dockEl.addEventListener('pointermove', e => {
    const d = state.drag;
    if (!d) return;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.abs(dy) > 4) { d.moved = true; setFly(null); }
    if (d.moved) { state.dockY = clamp(d.from + dy, 8, state.h - DOCK_H - 8); kick(); }
  });
  dockEl.addEventListener('pointerup', () => {
    const d = state.drag;
    state.drag = null;
    if (!d) return;
    if (d.moved) { try { localStorage.setItem('dockY', String(state.dockY)); } catch { /* storage unavailable */ } }
    else if (d.zone === 'expand' || d.zone === 'launch') {
      // Hover has usually opened the panel by the time the click lands, so a click only closes a
      // panel that was already open when the pointer arrived, and keeps it shut until the pointer leaves.
      const mode = d.zone === 'expand' ? 'details' : 'projects';
      state.clickedShut = state.panel === mode && state.enterPanel === mode;
      setPanel(state.clickedShut ? false : mode);
    }
  });
  // A press whose release never arrives (focus stolen, the system took the pointer) must not leave
  // a drag behind: while one is set, hover and clicks are ignored and the dock seems frozen.
  const dropDrag = () => { state.drag = null; };
  dockEl.addEventListener('pointercancel', dropDrag);
  dockEl.addEventListener('lostpointercapture', () => setTimeout(dropDrag, 0)); // after pointerup
  dockEl.addEventListener('contextmenu', e => { e.preventDefault(); bridge.menu(); });
  addEventListener('mousemove', e => onPointer({ x: e.clientX, y: e.clientY }));

  function resize() {
    state.w = innerWidth;
    state.h = innerHeight;
    state.dockY = clamp(state.dockY, 8, state.h - DOCK_H - 8);
    glass.resize(state.w, state.h, devicePixelRatio);
    kick();
  }
  addEventListener('resize', resize);

  // ---------- screen capture ----------
  // The capture stream dies on sleep, lock, display changes and GPU resets, and can fail outright
  // right after login. A dead stream used to leave the glass frozen on its last frame (and stuck on
  // whatever appearance that frame gave it), so it is restarted whenever it ends or goes quiet.
  const STALL_MS = 10e3;
  let capGen = 0, capStream = null, capRetry = 0, capFails = 0, capStartedAt = 0;

  function stopCapture() {
    capGen++;
    clearTimeout(capRetry);
    capRetry = 0;
    glass.detachVideo();
    if (capStream) capStream.getTracks().forEach(t => t.stop());
    capStream = null;
    $('capture').srcObject = null;
  }

  function retryCapture(ms) {
    clearTimeout(capRetry);
    capRetry = setTimeout(() => { capRetry = 0; startCapture(); }, ms);
  }

  async function startCapture() {
    stopCapture();
    const gen = capGen;
    try {
      const src = await bridge.captureSource();
      if (!src) throw new Error('no screen to capture yet');
      // Half the screen's css size is the blur buffer's resolution, so nothing visible is lost,
      // and a quarter of the pixels to copy and upload compared with full resolution.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: {
        chromeMediaSource: 'desktop', chromeMediaSourceId: src.id, maxWidth: src.width, maxHeight: src.height, maxFrameRate: 30 } } });
      if (gen !== capGen) { stream.getTracks().forEach(t => t.stop()); return; }
      capStream = stream;
      stream.getVideoTracks().forEach(t => t.addEventListener('ended', () => { if (gen === capGen) retryCapture(1000); }));
      const video = $('capture');
      video.srcObject = stream;
      await video.play();
      if (gen !== capGen) return;
      capStartedAt = performance.now();
      capFails = 0;
      glass.attachVideo(video);
    } catch (e) {
      if (gen !== capGen) return;
      capFails++;
      console.error('Screen capture failed; retrying. The glass shows a solid tint meanwhile.', e);
      retryCapture(Math.min(60e3, 1000 * 2 ** capFails));
    }
  }

  // No frames for a while: restart, waiting longer after each restart that didn't help (a screen
  // that never changes may simply produce no frames). A stream still delivering well after it
  // started counts as healthy again.
  let capStalls = 0;
  setInterval(() => {
    if (!capStream || capRetry) return;
    if (glass.lastFrameAt - capStartedAt > 3 * STALL_MS) capStalls = 0;
    const lastFrame = Math.max(glass.lastFrameAt, capStartedAt);
    if (performance.now() - lastFrame > STALL_MS * 2 ** Math.min(capStalls, 4)) { capStalls++; startCapture(); }
  }, 5000);

  // Scripted states for --snap screenshots.
  window.__dock = {
    force(s) {
      state.forced = s;
      setHover(null);
      if (s.tab != null) setTab(s.tab);
      if (s.projects) { setPanel('projects'); if (s.q) { $('q').value = s.q; renderProjects(); } }
      else if (s.panel) setPanel('details');
      else if (s.fly) setFly(s.fly); // from an open panel this takes the morph path
      else { setPanel(false); setFly(null); }
    },
  };

  // ---------- start ----------
  let saved = NaN;
  try { saved = parseFloat(localStorage.getItem('dockY')); } catch { /* storage unavailable */ }
  state.dockY = Number.isFinite(saved) ? saved : (innerHeight - DOCK_H) / 2;
  resize();
  bridge.geometry().then(g => { glass.setGeometry(g); kick(); });
  bridge.onGeometry(g => { glass.setGeometry(g); resize(); });
  bridge.onState(vm => { state.vm = vm; update(); });
  bridge.onCursor(p => onPointer(p));
  // wake from sleep, unlock, display changes: the old stream is dead or shows the wrong screen
  bridge.onRecapture(() => { capFails = 0; capStalls = 0; startCapture(); });
  setInterval(update, 15000); // countdowns
  startCapture();
  bridge.ready();
})();
