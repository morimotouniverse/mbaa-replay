// Background pre-scan (viewer.js startScan): a second, headless copy of the game (mbaa_scan.js, no WebGL, no audio)
// plays the replay as fast as it can and reports every round start and the exact end, so the timeline shows all rounds
// and the real length before playback reaches them. It never touches the playing session.
self.onmessage = async e => {
  const { files, probe, rep, v } = e.data;
  importScripts('mbaa_scan.js' + (v ? `?${v}` : ''));
  const M = await MBAASCAN({ print: () => {}, printErr: () => {},
                            locateFile: p => (v && p.endsWith('.wasm') ? `${p}?${v}` : p) });
  const FS = M.FS;
  const mkdirs = path => { let cur = ''; for (const p of path.split('/').slice(0, -1)) { if (!p) continue; cur += '/' + p; try { FS.mkdir(cur); } catch (x) {} } };
  for (const p of probe) { mkdirs('/game/' + p); FS.writeFile('/game/' + p, new Uint8Array(1)); }
  for (const [p, d] of files) { mkdirs('/game/' + p); FS.writeFile('/game/' + p, d); }
  FS.writeFile('/game/replay.rep', rep);
  if (!M._scan_start()) { postMessage({ error: 'scan boot failed' }); return; }
  const marks = () => { const n = M._scan_mark_count(), p = M._scan_marks() >> 2, out = [];
                        for (let i = 0; i < n; i++) out.push([M.HEAP32[p + 2 * i], M.HEAP32[p + 2 * i + 1]]); return out; };
  const t0 = performance.now();
  let f = 0;
  while (!M._scan_ended()) {
    const g = M._scan_step(600);
    if (g === f) break;
    f = g;
    postMessage({ frame: f, marks: marks() });
  }
  postMessage({ frame: f, marks: marks(), end: M._scan_ended() ? f : null, ms: performance.now() - t0, done: true });
};
