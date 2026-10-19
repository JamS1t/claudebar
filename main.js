'use strict';
// Main process: one transparent, click-through, always-on-top window along the right edge of the
// primary display. The renderer draws the glass dock, popovers and panel inside it.
const { app, BrowserWindow, Menu, desktopCapturer, ipcMain, powerMonitor, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Worker } = require('worker_threads');
const data = require('./data');

// Started from inside a Claude Code session (dev runs), the marker would leak into every session the
// projects launcher opens and turn their transcript saving off.
delete process.env.CLAUDE_CODE_CHILD_SESSION;

// Windows' occlusion tracking can decide an always-on-top overlay is hidden (after sleep, lock or a
// fullscreen app) and stop painting it, which looks like a frozen dock.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

const WIDTH = 480; // room for dock + gap + panel + shadow
const LIMITS_EVERY = 120e3, SCAN_EVERY = 60e3;
// Cursor polling: fast while the pointer is over or near the window, slow (and silent) elsewhere.
const CURSOR_NEAR = 33, CURSOR_FAR = 150, NEAR_PX = 60;
// --snap=<dir>: render each UI state, save PNGs of the page and quit (visual checks; the window
// itself is invisible to screenshots because it is excluded from capture)
const SNAP_DIR = (process.argv.find(a => a.startsWith('--snap=')) || '').slice(7);

if (!SNAP_DIR && !app.requestSingleInstanceLock()) app.exit(0); // snapshots run beside a live dock

let win, display, worker, bounds = null;
const state = { limits: null, rtk: null, summary: null, err: '', scanErr: '', plan: data.planName() };
let quitting = false;

const alive = () => win && !win.isDestroyed();
const frameBounds = () => {
  const a = display.workArea;
  return { x: a.x + a.width - WIDTH, y: a.y, width: WIDTH, height: a.height };
};
const geometry = () => ({ win: win.getBounds(), display: display.bounds });
const send = (channel, value) => { if (alive() && !win.webContents.isDestroyed()) win.webContents.send(channel, value); };
// Identical state is not re-sent: every push made the page rebuild the open panel.
let lastState = '';
const push = () => {
  const json = JSON.stringify(data.viewModel({ ...state, err: [state.err, state.scanErr].filter(Boolean).join(' ') }));
  if (json === lastState) return;
  lastState = json;
  send('state', JSON.parse(json));
};
const wait = ms => new Promise(r => setTimeout(r, ms));

// Writes through a temporary file, so a shutdown mid-write can't leave a corrupt cache behind.
// Never throws: a locked file (antivirus, backup) only costs the cache, not the fresh data.
function writeAtomic(file, text) {
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch (e) {
    console.error(`Couldn't save ${file}:`, e.message);
  }
}

function placeWindow() {
  display = screen.getPrimaryDisplay();
  if (!alive()) return;
  win.setBounds(frameBounds());
  bounds = win.getBounds();
  win.setAlwaysOnTop(true, 'floating');
  send('geometry', geometry());
}

function createWindow() {
  display = screen.getPrimaryDisplay();
  win = new BrowserWindow({
    ...frameBounds(), show: false, frame: false, transparent: true, backgroundColor: '#00000000',
    resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, focusable: false, hasShadow: false, alwaysOnTop: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false },
  });
  bounds = win.getBounds();
  win.setAlwaysOnTop(true, 'floating');
  // Excluded from screen capture, so the glass can sample what is behind it without seeing itself.
  win.setContentProtection(true);
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(__dirname, 'index.html'));
  const show = () => { if (alive() && !win.isVisible()) win.showInactive(); };
  win.once('ready-to-show', show);
  setTimeout(show, 8000); // a GPU still starting after login can delay the first paint

  // Self-healing: a crashed or hung page is reloaded instead of leaving a dead dock on screen.
  const wc = win.webContents;
  let hung = 0;
  wc.on('render-process-gone', (_, d) => {
    if (d.reason === 'clean-exit') return;
    console.error('Renderer gone:', d.reason);
    setTimeout(() => { if (alive()) { lastState = ''; wc.reload(); } }, 1000);
  });
  wc.on('unresponsive', () => {
    clearTimeout(hung);
    hung = setTimeout(() => {
      if (!alive()) return;
      console.error('Renderer unresponsive for 10 s; reloading.');
      wc.forcefullyCrashRenderer(); // render-process-gone then reloads it
    }, 10e3);
  });
  wc.on('responsive', () => clearTimeout(hung));
  wc.on('did-finish-load', () => win.setIgnoreMouseEvents(true, { forward: true }));
}

ipcMain.handle('geometry', () => geometry());
ipcMain.handle('capture-source', async () => {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
  const src = sources.find(s => s.display_id === String(display.id)) || sources[0];
  if (!src) return null; // too early after login, or the session is locked: the page retries
  // half the css size: exactly the glass's blur resolution (see startCapture in app.js)
  return { id: src.id, width: Math.ceil(display.size.width / 2), height: Math.ceil(display.size.height / 2) };
});
ipcMain.on('ignore', (_, ignore) => { if (alive()) win.setIgnoreMouseEvents(ignore, { forward: true }); });

// Start at login, from the menu. Unpackaged runs pass the app folder to electron.exe.
const loginItem = () => ({ path: process.execPath, args: process.defaultApp ? [path.resolve(app.getAppPath())] : [] });
const startsAtLogin = () => {
  try { return app.getLoginItemSettings(loginItem()).openAtLogin; } catch { return false; }
};
ipcMain.on('menu', () => {
  if (!alive()) return;
  Menu.buildFromTemplate([
    { label: 'Refresh Now', click: () => refreshAll(true) }, // still waits out a backoff
    { label: 'Start at Login', type: 'checkbox', checked: startsAtLogin(),
      click: item => app.setLoginItemSettings({ ...loginItem(), openAtLogin: item.checked }) },
    { label: 'Reload Dock', click: () => { if (alive()) { lastState = ''; win.webContents.reload(); } } },
    { type: 'separator' },
    { label: 'Quit Claude Dock', click: () => app.quit() },
  ]).popup({ window: win });
});
ipcMain.on('ready', () => { lastState = ''; push(); });
// The window is normally unfocusable so hovering never steals focus; the search field borrows it.
ipcMain.handle('focus', (_, on) => {
  if (!alive()) return;
  if (on) { win.setFocusable(true); win.focus(); } else { win.blur(); win.setFocusable(false); }
});
// Projects launcher: resume Claude in a project folder. The folder must be one our own scan found,
// so the page can never choose an arbitrary path to launch in.
ipcMain.on('open-project', (_, cwd) => {
  const r = ((state.summary && state.summary.recent) || []).find(x => x.cwd === cwd);
  if (!r) return;
  fs.access(r.cwd, err => {
    if (err) return;
    const fallback = () => spawn('cmd.exe', ['/c', 'start', '""', '/D', r.cwd, 'cmd', '/k', 'claude --continue'],
      { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    const wt = spawn('wt.exe', ['-d', r.cwd, 'cmd', '/k', 'claude --continue'], { detached: true, stdio: 'ignore' });
    wt.on('error', fallback); // no Windows Terminal: plain console window
    wt.unref();
  });
});

// Hover must work while the window ignores the mouse, and must notice the pointer leaving the
// window, so the cursor position is polled and sent window-relative. Far from the window it is
// polled slowly and nothing is sent, except one last position as the pointer leaves.
function pollCursor() {
  let last = '', wasNear = false;
  const tick = () => {
    let near = false;
    if (alive() && bounds) {
      const p = screen.getCursorScreenPoint();
      const rel = { x: p.x - bounds.x, y: p.y - bounds.y };
      near = rel.x >= -NEAR_PX && rel.x <= bounds.width + NEAR_PX && rel.y >= -NEAR_PX && rel.y <= bounds.height + NEAR_PX;
      const key = `${rel.x},${rel.y}`;
      if ((near || wasNear) && key !== last) { last = key; send('cursor', rel); }
    }
    wasNear = near;
    setTimeout(tick, near ? CURSOR_NEAR : CURSOR_FAR);
  };
  tick();
}

// Last good limits live on disk, so a restart shows them at once and skips the request while they
// are fresh. Failures back off (Retry-After, else doubling up to 30 min) instead of retrying every
// poll, which only prolongs a rate limit.
const limitsPath = () => path.join(app.getPath('userData'), 'limits.json');
let nextLimits = 0, backoff = 0, limitsBusy = false, rtkAt = 0;
const RTK_EVERY = 10 * 60e3;
function loadLimits() {
  try {
    const c = JSON.parse(fs.readFileSync(limitsPath(), 'utf8'));
    Object.assign(state, { limits: c.limits, limitsAt: c.at });
    nextLimits = c.at + LIMITS_EVERY;
  } catch { /* first run, or an unreadable file: fetch fresh */ }
}
async function refreshLimits(force) {
  if (limitsBusy) return; // the timer, the menu and wake-up can overlap
  limitsBusy = true;
  try {
    if (Date.now() >= nextLimits || (force === true && !backoff)) {
      try {
        state.limits = await data.fetchLimits();
        state.limitsAt = Date.now();
        state.err = '';
        backoff = 0;
        nextLimits = state.limitsAt + LIMITS_EVERY;
        writeAtomic(limitsPath(), JSON.stringify({ at: state.limitsAt, limits: state.limits }));
      } catch (e) {
        backoff = Math.min(Math.max(backoff * 2, LIMITS_EVERY), 30 * 60e3);
        const wait = Math.max(e.retryAfter || 0, backoff);
        nextLimits = Date.now() + wait;
        state.err = `Couldn't ${state.limits ? 'refresh' : 'load'} limits (${e.message}). Retrying in ${Math.ceil(wait / 60e3)} min.`;
      }
    }
    push();
    // rtk totals move slowly; no need to spawn a process every couple of minutes
    if (force === true || Date.now() - rtkAt >= RTK_EVERY) {
      rtkAt = Date.now();
      state.rtk = await data.fetchRtk();
      push();
    }
  } finally {
    limitsBusy = false;
  }
}

// A worker that dies (out of memory, a bad file) is restarted, otherwise scans silently stop.
function startWorker() {
  worker = new Worker(path.join(__dirname, 'scan-worker.js'),
    { workerData: { cachePath: path.join(app.getPath('userData'), 'scan-cache.json') }, resourceLimits: { maxOldGenerationSizeMb: 512 } });
  worker.on('message', m => {
    if (m.ok) { state.summary = m.summary; state.scanErr = ''; }
    else state.scanErr = `Couldn't scan transcripts (${m.error}).`;
    push();
    snapTour();
  });
  worker.on('error', e => { state.scanErr = `Couldn't scan transcripts (${e.message}).`; push(); });
  worker.on('exit', () => {
    worker = null;
    if (!quitting) setTimeout(() => { if (!worker && !quitting) { startWorker(); scan(); } }, 5000);
  });
}
const scan = () => { if (worker) worker.postMessage('scan'); };

function refreshAll(force) {
  refreshLimits(force);
  scan();
}

let snapped = false;
async function snapTour() {
  if (!SNAP_DIR || snapped || !state.summary) return;
  snapped = true;
  // --white: a plain white window behind the dock, to check the glass against bright backgrounds
  // --split: black left, white right, the edge under the middle of the panel (mixed backdrops)
  const split = process.argv.includes('--split');
  if (split || process.argv.includes('--white')) {
    const a = display.workArea;
    const bg = new BrowserWindow({ ...a, frame: false, backgroundColor: '#ffffff', skipTaskbar: true, focusable: false });
    if (split) bg.loadURL(`data:text/html,<body style="margin:0;height:100vh;background:linear-gradient(90deg,%23000 ${a.width - 250}px,%23fff 0)">`);
    bg.showInactive();
  }
  await wait(2500);
  fs.mkdirSync(SNAP_DIR, { recursive: true });
  const steps = [
    ['01-dock', {}, 1200], ['02-fly-session', { fly: 'session' }, 900], ['03-fly-weekly', { fly: 'weekly' }, 900],
    ['04-closing', {}, 120], ['05-closed', {}, 900], ['06-opening', { panel: true, tab: 0 }, 130],
    ['07-overview', { panel: true, tab: 0 }, 1100], ['08-projects', { panel: true, tab: 1 }, 800],
    ['09-insights', { panel: true, tab: 2 }, 800], ['10-plugins', { panel: true, tab: 3 }, 800],
    ['11-morph-to-weekly', { fly: 'weekly' }, 140], ['12-weekly', { fly: 'weekly' }, 900],
    ['13-morph-to-panel', { panel: true, tab: 3 }, 140], ['14-panel', { panel: true, tab: 3 }, 900],
    ['15-morph-to-projects', { projects: true }, 140], ['16-projects', { projects: true }, 900],
    ['17-search', { projects: true, q: 'claude' }, 300],
  ];
  for (const [name, s, ms] of steps) {
    await win.webContents.executeJavaScript(`window.__dock.force(${JSON.stringify(s)})`);
    await wait(ms);
    fs.writeFileSync(path.join(SNAP_DIR, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  }
  fs.writeFileSync(path.join(SNAP_DIR, 'bounds.json'), JSON.stringify(win.getBounds()));
  app.quit();
}

app.whenReady().then(() => {
  loadLimits();
  createWindow();
  startWorker();
  refreshAll();
  setInterval(refreshLimits, LIMITS_EVERY);
  setInterval(scan, SCAN_EVERY);
  pollCursor();
  // Display changes (resolution, scaling, docking, a monitor unplugged): re-fit the window and
  // restart the capture, which may now point at the wrong screen.
  let settle = 0;
  const displayChanged = () => {
    clearTimeout(settle);
    settle = setTimeout(() => { placeWindow(); send('recapture'); }, 300);
  };
  screen.on('display-metrics-changed', displayChanged);
  screen.on('display-added', displayChanged);
  screen.on('display-removed', displayChanged);
  // Sleep, lock and wake kill the capture stream and can drop the window out of always-on-top.
  const woke = () => {
    setTimeout(() => {
      placeWindow();
      send('recapture');
      refreshLimits(); // network may need a moment after wake
      scan();
    }, 3000);
  };
  powerMonitor.on('resume', woke);
  powerMonitor.on('unlock-screen', woke);
  // Fullscreen apps and Explorer restarts can demote a topmost window; keep claiming the spot.
  setInterval(() => { if (alive()) win.setAlwaysOnTop(true, 'floating'); }, 60e3);
});
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => app.quit());
