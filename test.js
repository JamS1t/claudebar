'use strict';
// npm test: data layer, formatting and springs, plus a scan of your real transcripts if present.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const data = require('./data');
const { Spring, tokens, duration, lerpRect, inside, esc } = require('./shared');

(async () => {
  // formatting
  assert.equal(tokens(1500), '1.5K');
  assert.equal(tokens(905700), '906K');
  assert.equal(tokens(1.1e9), '1.1B');
  assert.equal(tokens(42), '42');
  assert.equal(duration(82 * 60e3), '1 hr 22 min');
  assert.equal(duration(2 * 864e5 + 4 * 36e5), '2 days 4 hr');
  assert.equal(duration(-5), 'now');
  assert.equal(esc('<b a="1">&'), '&lt;b a=&quot;1&quot;&gt;&amp;');
  assert.equal(data.planFromTier('default_claude_max_5x'), 'Max 5×');
  assert.equal(data.planFromTier('claude_pro'), 'Pro');
  assert.equal(data.planFromTier(undefined), '');

  // geometry
  assert.deepEqual(lerpRect({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 20, w: 30, h: 40 }, 0.5), { x: 5, y: 10, w: 20, h: 25 });
  assert.ok(inside({ x: 0, y: 0, w: 10, h: 10 }, { x: 12, y: 5 }, 2));
  assert.ok(!inside({ x: 0, y: 0, w: 10, h: 10 }, null));

  // springs settle on target, overshoot a little when underdamped, and are frame-rate independent
  const a = new Spring(0, 230, 25), b = new Spring(0, 230, 25);
  a.set(1); b.set(1);
  let peak = 0;
  for (let i = 0; i < 120; i++) { a.step(1 / 60); peak = Math.max(peak, a.value); }
  for (let i = 0; i < 240; i++) b.step(1 / 120);
  assert.equal(a.value, 1);
  assert.ok(peak > 1 && peak < 1.1, `overshoot ${peak}`);
  assert.ok(Math.abs(a.value - b.value) < 1e-6);
  assert.ok(!a.moving);

  // transcript parsing: usage deduplicated by message id, tools counted per block
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudebar-'));
  const proj = path.join(dir, 'C--proj');
  fs.mkdirSync(path.join(proj, 'sess1', 'subagents'), { recursive: true });
  const ts = new Date().toISOString();
  const msg = (id, name) => JSON.stringify({ type: 'assistant', timestamp: ts, cwd: 'C:\\work\\demo', message: {
    id, model: 'claude-opus-5-5', content: [{ type: 'tool_use', name }],
    usage: { input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 50000, output_tokens: 200,
      cache_creation: { ephemeral_1h_input_tokens: 1000 } } } });
  fs.writeFileSync(path.join(proj, 'sess1.jsonl'), [msg('m1', 'Read'), msg('m1', 'Bash'), msg('m2', 'Read')].join('\n'));
  fs.writeFileSync(path.join(proj, 'sess1', 'subagents', 'agent-a.jsonl'), msg('s1', 'Grep'));
  const agg = await data.parseFile(path.join(proj, 'sess1.jsonl'));
  assert.equal(agg.turns, 2);
  assert.deepEqual(agg.tools, { Read: 2, Bash: 1 });
  assert.equal(agg.cwd, 'C:\\work\\demo');
  assert.equal(agg.peakCtx, 51010);
  const hour = Object.values(agg.hours)[0];
  assert.deepEqual(hour.slice(0, 5), [20, 0, 2000, 100000, 400]);
  assert.ok(Math.abs(hour[5] - data.weigh({ in: 20, cw1h: 2000, cr: 100000, out: 400 }, 'claude-opus-5-5')) < 1e-6);

  const cache = await data.scan({}, dir);
  assert.equal(Object.keys(cache).length, 2);
  const first = Object.keys(cache)[0];
  assert.equal((await data.scan(cache, dir))[first], cache[first], 'unchanged files come from cache');
  // a growing transcript is read from where the last scan stopped, and matches a full parse;
  // a half-written last line waits for the next scan, and blocks straddling the resume point
  // are not counted twice
  const grow = path.join(proj, 'sess2.jsonl');
  fs.writeFileSync(grow, `${msg('g1', 'Read')}\n${msg('g2', 'Grep')}\n`);
  let inc = await data.scan({}, dir);
  assert.equal(inc[grow].off, fs.statSync(grow).size);
  const half = msg('g3', 'Edit');
  fs.appendFileSync(grow, `${msg('g2', 'Bash')}\n${half.slice(0, 40)}`);
  inc = await data.scan(inc, dir);
  assert.equal(inc[grow].turns, 2, 'repeated id and half line not counted');
  fs.appendFileSync(grow, `${half.slice(40)}\n${msg('g4', 'Read')}`);
  inc = await data.scan(inc, dir);
  const full = await data.parseFile(grow);
  for (const k of ['turns', 'tools', 'hours', 'models', 'peakCtx', 'firstCtx', 'cwd']) assert.deepEqual(inc[grow][k], full[k], k);
  assert.equal(inc[grow].turns, 4);
  assert.deepEqual(inc[grow].tools, { Read: 2, Grep: 1, Bash: 1, Edit: 1 });
  // a file that shrank (rewritten) is parsed from scratch
  fs.writeFileSync(grow, msg('r1', 'Read'));
  inc = await data.scan(inc, dir);
  assert.equal(inc[grow].turns, 1);
  fs.rmSync(grow);

  const s = data.summarize(cache);
  assert.equal(s.proj[0][0], 'demo');
  assert.equal(s.live.length, 1, 'subagent transcripts are not sessions');
  assert.deepEqual(s.recent.map(r => r.cwd), ['C:\\work\\demo'], 'one recent folder, subagents excluded');
  assert.ok(s.subW > 0);

  // insights and view model
  const now = Date.now();
  const limits = { limits: [
    { kind: 'session', percent: 85, resets_at: new Date(now + 36e5).toISOString() },
    { kind: 'weekly_all', percent: 50, resets_at: new Date(now + 3.5 * 864e5).toISOString() },
  ], seven_day_breakdown: { rows: [{ display_name: 'Claude Code', percent: 97 }, { display_name: 'Other', percent: 0 }] } };
  assert.ok(Math.abs(data.weeklyPace(data.findLimit(limits, 'weekly_all'), now).pace - 100) < 0.5);
  const { tips, plug, mix } = data.advice(s, limits, { saved: '1M', pct: 50 }, now);
  assert.ok(tips.some(t => t.sev === 'high' && /Session limit/.test(t.title)));
  assert.ok(tips.every(t => t.icon && t.title && t.body));
  assert.ok(Math.abs(mix.reduce((x, m) => x + m.share, 0) - 1) < 1e-9);
  assert.equal(plug.rtk.saved, '1M');
  const vm = data.viewModel({ limits, rtk: null, summary: s, err: '', plan: 'Max 5×' }, now);
  assert.equal(vm.session.pct, 85);
  assert.equal(vm.breakdown.length, 1);
  assert.equal(vm.projects[0].rel, 1);
  assert.equal(data.viewModel({ limits: null, summary: null }).scanning, true);
  fs.rmSync(dir, { recursive: true, force: true });

  // real transcripts, if this machine has any
  const real = await data.scan({});
  if (Object.keys(real).length) {
    const r = data.summarize(real);
    console.log(`real transcripts: ${Object.keys(real).length} files, top project ${r.proj[0] ? r.proj[0][0] : '-'}`);
  }
  console.log('ok');
})().catch(e => { console.error(e); process.exit(1); });
