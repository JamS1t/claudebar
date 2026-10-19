'use strict';
// Scans transcripts off the main thread. Each 'scan' message reads what changed, saves the cache
// when anything did and replies with a summary.
const fs = require('fs');
const { parentPort, workerData } = require('worker_threads');
const { scan, summarize } = require('./data');

let cache = {};
try { cache = JSON.parse(fs.readFileSync(workerData.cachePath, 'utf8')); } catch { /* first run, or a damaged file */ }
let busy = false;

const changed = (a, b) => {
  const ka = Object.keys(a);
  return ka.length !== Object.keys(b).length || ka.some(k => a[k] !== b[k]);
};

parentPort.on('message', async () => {
  if (busy) return;
  busy = true;
  try {
    const next = await scan(cache);
    const dirty = changed(next, cache);
    cache = next;
    if (dirty) {
      // through a temporary file, so a shutdown mid-write can't corrupt it and force a full rescan
      const tmp = `${workerData.cachePath}.tmp`;
      try {
        await fs.promises.writeFile(tmp, JSON.stringify(cache));
        await fs.promises.rename(tmp, workerData.cachePath);
      } catch { /* locked or full disk: the next change saves it */ }
    }
    parentPort.postMessage({ ok: true, summary: summarize(cache) });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: e.message });
  } finally {
    busy = false;
  }
});
