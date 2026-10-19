'use strict';
// Usage data: Claude Code transcripts, the plan-limits endpoint and `rtk gain`.
// Pure Node, no Electron, so the scan worker and the tests can load it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { duration, tokens } = require('./shared');

const HOME = path.join(os.homedir(), '.claude');
const PROJECTS = path.join(HOME, 'projects');

// Rough cost weights in input-token equivalents, mirroring API price ratios (cache read 0.1x,
// 5m cache write 1.25x, 1h write 2x, output 5x). Plan limits are not published per token, so
// weighted numbers only rank usage against itself.
const W = { in: 1, cw5: 1.25, cw1h: 2, cr: 0.1, out: 5 };
const KEYS = ['in', 'cw5', 'cw1h', 'cr', 'out'];
const MODEL_W = { haiku: 0.2, sonnet: 0.6 }; // opus, fable and anything else = 1

const modelWeight = m => Object.entries(MODEL_W).find(([k]) => (m || '').includes(k))?.[1] ?? 1;
const weigh = (t, m) => KEYS.reduce((s, k) => s + (t[k] || 0) * W[k], 0) * modelWeight(m);
const add = (into, from) => { for (const [k, v] of Object.entries(from)) into[k] = (into[k] || 0) + v; };

// ---------- transcripts ----------

// Aggregates one transcript. Assistant messages are written once per content block with the
// same message id and usage, so usage is deduplicated by id.
//
// Transcripts only ever grow, so a file that got longer is read from where the last scan stopped
// (`off`) instead of from the start: busy sessions reach tens of MB, and re-reading all of them
// every minute kept a core busy on a loaded laptop. `tail` keeps the last few message ids, enough
// to deduplicate blocks that straddle the point where reading resumes.
const TAIL_IDS = 8, CHUNK = 1 << 20;

const freshAgg = () => ({ cwd: null, hours: {}, tools: {}, models: {}, peakCtx: 0, firstCtx: null, turns: 0, off: 0, tail: [] });

function feed(agg, line, seen, ids) {
  if (!line.includes('"assistant"')) {
    if (agg.cwd === null && line.includes('"cwd"')) {
      const m = line.match(/"cwd":"((?:[^"\\]|\\.)*)"/);
      if (m) try { agg.cwd = JSON.parse(`"${m[1]}"`); } catch { /* malformed escape: try the next line */ }
    }
    return;
  }
  let d;
  try { d = JSON.parse(line); } catch { return; }
  const msg = d.message || {};
  agg.cwd = agg.cwd || d.cwd || null;
  for (const c of Array.isArray(msg.content) ? msg.content : []) {
    if (c && c.type === 'tool_use') agg.tools[c.name || '?'] = (agg.tools[c.name || '?'] || 0) + 1;
  }
  const u = msg.usage;
  if (!u || seen.has(msg.id) || msg.model === '<synthetic>') return;
  seen.add(msg.id);
  ids.push(msg.id);
  const cw1h = (u.cache_creation || {}).ephemeral_1h_input_tokens || 0;
  const cw = u.cache_creation_input_tokens || 0;
  const t = { in: u.input_tokens || 0, cw5: cw - cw1h, cw1h, cr: u.cache_read_input_tokens || 0, out: u.output_tokens || 0 };
  const ctx = t.in + cw + t.cr;
  agg.peakCtx = Math.max(agg.peakCtx, ctx);
  if (agg.firstCtx === null) agg.firstCtx = ctx;
  agg.turns++;
  const model = msg.model || '?';
  const w = weigh(t, model);
  agg.models[model] = (agg.models[model] || 0) + w;
  const h = (agg.hours[(d.timestamp || '').slice(0, 13)] ||= [0, 0, 0, 0, 0, 0]);
  KEYS.forEach((k, i) => { h[i] += t[k]; });
  h[5] += w;
}

// prev: the cached aggregate to continue from (its `off` must be within the file), or none.
async function parseFile(file, prev) {
  const agg = prev && prev.off >= 0 ? structuredClone(prev) : freshAgg();
  if (!Array.isArray(agg.tail)) agg.tail = [];
  const seen = new Set(agg.tail), ids = agg.tail.slice();
  const fh = await fs.promises.open(file, 'r');
  try {
    const size = (await fh.stat()).size;
    const buf = Buffer.allocUnsafe(CHUNK);
    let pos = agg.off, rest = null;
    while (pos < size) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, size - pos), pos);
      if (!bytesRead) break;
      pos += bytesRead;
      const chunk = rest ? Buffer.concat([rest, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
      let start = 0, nl;
      while ((nl = chunk.indexOf(10, start)) !== -1) {
        feed(agg, chunk.toString('utf8', start, nl), seen, ids);
        start = nl + 1;
      }
      rest = start < chunk.length ? Buffer.from(chunk.subarray(start)) : null;
      agg.off = pos - (rest ? rest.length : 0);
    }
    // A last line without a newline counts only once it is complete JSON; a half-written one is
    // read again next time.
    if (rest) {
      const line = rest.toString('utf8');
      let complete = true;
      try { JSON.parse(line); } catch { complete = false; }
      if (complete) { feed(agg, line, seen, ids); agg.off += rest.length; }
    }
  } finally {
    await fh.close();
  }
  agg.tail = ids.slice(-TAIL_IDS);
  return agg;
}

// Re-parses only transcripts whose size or mtime changed since the cached scan; ones that only
// grew are read from where the last scan stopped.
async function scan(cache, root = PROJECTS) {
  let files;
  try { files = fs.readdirSync(root, { recursive: true }).filter(f => f.endsWith('.jsonl')); } catch { return {}; }
  const out = {};
  for (const rel of files) {
    const file = path.join(root, rel);
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    const old = cache[file];
    if (old && old.sig[0] === st.size && old.sig[1] === st.mtimeMs) { out[file] = old; continue; }
    const grew = old && typeof old.off === 'number' && st.size > old.sig[0] && old.off <= st.size;
    let agg;
    try { agg = await parseFile(file, grew ? old : null); } catch { continue; }
    const parts = rel.split(/[\\/]/);
    out[file] = Object.assign(agg, {
      sig: [st.size, st.mtimeMs], mtime: st.mtimeMs, projdir: parts[0],
      subagent: parts.includes('subagents'), session: (parts[1] || '').split('.')[0],
    });
  }
  return out;
}

const baseName = p => String(p).split(/[\\/]/).filter(Boolean).pop() || String(p);

function summarize(cache, now = Date.now()) {
  const weekAgo = new Date(now - 7 * 864e5).toISOString().slice(0, 13);
  const entries = Object.values(cache);
  const cwdByDir = {};
  for (const a of entries) if (a.cwd && !a.subagent) cwdByDir[a.projdir] = a.cwd;
  const proj = {}, tools = {}, models = {}, sessions = {}, dirs = {};
  const tot = [0, 0, 0, 0, 0, 0];
  let subW = 0;
  for (const a of entries) {
    const cwd = a.cwd || cwdByDir[a.projdir];
    const name = baseName(cwd || a.projdir);
    if (cwd && !a.subagent) {
      const k = cwd.toLowerCase();
      if (!dirs[k] || dirs[k].mtime < a.mtime) dirs[k] = { name, cwd, mtime: a.mtime };
    }
    let recent = false;
    for (const [hr, h] of Object.entries(a.hours)) {
      if (hr < weekAgo) continue;
      recent = true;
      proj[name] = (proj[name] || 0) + h[5];
      h.forEach((v, i) => { tot[i] += v; });
      if (a.subagent) subW += h[5];
    }
    if (!recent) continue;
    add(tools, a.tools);
    add(models, a.models);
    if (!a.subagent) sessions[a.session] = { name, peakCtx: a.peakCtx, firstCtx: a.firstCtx, turns: a.turns, mtime: a.mtime };
  }
  const list = Object.values(sessions);
  const firsts = list.map(s => s.firstCtx).filter(Boolean).sort((a, b) => a - b);
  return {
    proj: Object.entries(proj).sort((a, b) => b[1] - a[1]),
    tools: Object.entries(tools).sort((a, b) => b[1] - a[1]),
    models, tot, subW,
    live: list.filter(s => now - s.mtime < 15 * 60e3).sort((a, b) => b.mtime - a.mtime)
      .map(s => ({ name: s.name, ctx: s.peakCtx, turns: s.turns })),
    sessions: list.map(s => ({ name: s.name, peakCtx: s.peakCtx })),
    // every project folder Claude has run in, newest first (the projects launcher)
    recent: Object.values(dirs).sort((a, b) => b.mtime - a.mtime),
    baseCtx: firsts.length ? firsts[Math.floor(firsts.length / 2)] : 0,
  };
}

// ---------- limits, plan, rtk ----------

const findLimit = (limits, kind) => ((limits || {}).limits || []).find(l => l.kind === kind) || null;

// pace = % of the weekly budget used relative to the share of the week elapsed (100 = even burn)
function weeklyPace(weekly, now = Date.now()) {
  if (!weekly || !weekly.resets_at) return null;
  const left = new Date(weekly.resets_at).getTime() - now;
  return { pace: weekly.percent / Math.max(0.01, 1 - left / (7 * 864e5)), left };
}

function readCredentials() {
  return JSON.parse(fs.readFileSync(path.join(HOME, '.credentials.json'), 'utf8')).claudeAiOauth || {};
}

async function fetchLimits() {
  const { accessToken } = readCredentials(); // read per request so token refreshes by Claude Code are picked up
  const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
    headers: { Authorization: `Bearer ${accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'claudebar' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const e = new Error(`HTTP ${res.status}`);
    e.retryAfter = Number(res.headers.get('retry-after')) * 1000 || 0; // seconds form only
    throw e;
  }
  return res.json();
}

function planFromTier(tier) {
  const m = /(max|pro|team|enterprise)(?:_(\d+)x)?/.exec(tier || '');
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)}${m[2] ? ` ${m[2]}×` : ''}` : '';
}

function planName() {
  try { return planFromTier(readCredentials().rateLimitTier); } catch { return ''; }
}

function fetchRtk() {
  return new Promise(resolve => {
    execFile('rtk', ['gain'], { timeout: 30000, windowsHide: true, encoding: 'utf8' }, (err, out) => {
      const m = !err && /Tokens saved:\s*([\d.]+\w?)\s*\(([\d.]+)%\)/.exec(out || '');
      resolve(m ? { saved: m[1], pct: Number(m[2]) } : null);
    });
  });
}

// ---------- insights ----------

function advice(s, limits, rtk, now = Date.now()) {
  const tips = [];
  const weekly = findLimit(limits, 'weekly_all'), session = findLimit(limits, 'session');
  const wp = weeklyPace(weekly, now);
  if (wp) {
    const pct = weekly.percent, resets = duration(wp.left);
    if (wp.pace > 105) {
      const days = (100 - pct) / (wp.pace / 7); // pace/7 = % of the budget burned per day at this rate
      tips.push({ sev: 'warn', icon: 'gauge', title: 'Ahead of weekly pace',
        body: `At this rate you reach the limit in about ${duration(days * 864e5)}, and the week resets in ${resets}. Schedule heavy runs after the reset.` });
    } else if (pct < 80 && wp.left < 2 * 864e5) {
      tips.push({ sev: 'good', icon: 'gauge', title: 'Weekly budget to spare',
        body: `${100 - pct}% is left and resets in ${resets}. A good time for big refactors, reviews or research.` });
    } else {
      tips.push({ sev: 'ok', icon: 'gauge', title: 'Weekly pace on track', body: `You're at ${Math.round(wp.pace)}% of an even burn rate.` });
    }
  }
  if (session && session.percent >= 80) {
    tips.push({ sev: 'high', icon: 'hourglass', title: 'Session limit almost reached',
      body: `${session.percent}% used. Wrap up or switch to Sonnet; it resets in ${duration(new Date(session.resets_at) - now)}.` });
  }

  const wsum = s.tot[5] || 1;
  const part = Object.fromEntries(KEYS.map((k, i) => [k, s.tot[i] * W[k]]));
  const psum = Object.values(part).reduce((a, b) => a + b, 0) || 1;
  const cr = part.cr / psum, cw = (part.cw5 + part.cw1h) / psum, out = part.out / psum;
  if (cr + cw > 0.6) {
    tips.push({ sev: 'warn', icon: 'layers', title: 'Context is the main cost',
      body: `Re-reading and caching context makes up ${Math.round((cr + cw) * 100)}% of weighted usage. Use /clear between unrelated tasks and /compact at milestones.` });
  }
  const fat = s.sessions.filter(x => x.peakCtx > 300e3).sort((a, b) => b.peakCtx - a.peakCtx);
  if (fat.length) {
    tips.push({ sev: 'warn', icon: 'doc', title: 'Oversized sessions',
      body: `${fat.length} session${fat.length > 1 ? 's' : ''} grew past 300K this week. The largest, ${fat[0].name}, reached ${tokens(fat[0].peakCtx)}, and every turn re-reads all of it.` });
  }
  if (s.baseCtx > 40e3) {
    tips.push({ sev: 'warn', icon: 'bolt', title: 'Heavy starting context',
      body: `A fresh session holds about ${tokens(s.baseCtx)} before you type: system prompt, CLAUDE.md, skills, MCP tools and hooks. Turn off plugins and MCP servers a project doesn't use.` });
  }
  if (s.subW / wsum > 0.25) {
    tips.push({ sev: 'ok', icon: 'people', title: 'Subagents are a large share',
      body: `${Math.round((s.subW / wsum) * 100)}% of usage. Worth it for parallel work; for single lookups, searching directly is cheaper.` });
  }
  const msum = Object.values(s.models).reduce((a, b) => a + b, 0) || 1;
  const top = Object.entries(s.models).filter(([m]) => /opus|fable/.test(m)).reduce((a, [, v]) => a + v, 0);
  if (top / msum > 0.9) {
    tips.push({ sev: 'ok', icon: 'cpu', title: 'Almost everything runs on Opus or Fable', body: 'Switch to Sonnet with /model for mechanical edits, renames and docs.' });
  }
  const t = Object.fromEntries(s.tools);
  if ((t.Read || 0) > 3 * Math.max(1, t.Grep || 0)) {
    tips.push({ sev: 'ok', icon: 'search', title: 'Reading more than searching', body: 'Search with Grep first, then Read with an offset and limit.' });
  }

  // caveman and ponytail only shrink output tokens, so the output share is their ceiling
  const plug = { out, save: out / 2, rtk,
    verdict: out < 0.3 ? 'Keep them, but context size matters far more than output length.' : 'Output is a large share here, so they pay off.' };
  const mix = [
    { key: 'cacheRead', label: 'Cache read', share: cr },
    { key: 'cacheWrite', label: 'Cache write', share: cw },
    { key: 'output', label: 'Output', share: out },
    { key: 'input', label: 'Input', share: part.in / psum },
  ];
  return { tips, plug, mix };
}

// Everything the renderer draws, as plain data.
function viewModel({ limits, limitsAt, rtk, summary, err, plan }, now = Date.now()) {
  const lim = kind => {
    const l = findLimit(limits, kind);
    return l ? { pct: l.percent, resetsAt: new Date(l.resets_at).getTime() } : null;
  };
  const weekly = lim('weekly_all');
  const wp = weeklyPace(findLimit(limits, 'weekly_all'), now);
  if (weekly && wp) weekly.pace = wp.pace;
  const rows = ((limits || {}).seven_day_breakdown || {}).rows || [];
  const vm = { plan, err, updated: limitsAt || now, session: lim('session'), weekly, scanning: !summary,
    breakdown: rows.filter(r => r.percent).map(r => ({ name: r.display_name, pct: r.percent })) };
  if (!summary) return vm;
  const { tips, plug, mix } = advice(summary, limits, rtk, now);
  const total = summary.proj.reduce((a, [, v]) => a + v, 0) || 1;
  const first = summary.proj.length ? summary.proj[0][1] : 1;
  return Object.assign(vm, {
    live: summary.live.slice(0, 5),
    recent: (summary.recent || []).map(r => ({ name: r.name, cwd: r.cwd, mtime: r.mtime })),
    projects: summary.proj.slice(0, 7).map(([name, v]) => ({ name, share: v / total, rel: v / first })),
    tools: summary.tools.slice(0, 5),
    subShare: summary.subW / (summary.tot[5] || 1),
    tips, plug, mix,
  });
}

module.exports = { parseFile, scan, summarize, advice, viewModel, weeklyPace, findLimit, fetchLimits, fetchRtk, planName, planFromTier, weigh };
