// MBAACC web replay viewer: bundle loader + UI glue. The bundle (tools/web/build_bundle.py) is a content-addressed
// object store: o/<h[:2]>/<h> = iv(16) || AES-256-CTR(deflate-raw(file)); manifest.bin is the same encoding of a JSON
// {files: game path -> object, plan: asset plan}. A dropped .rep (or ?rep=URL) is all the page needs: its header names
// the stage and both sides' chara x moon, the plan (tools/web/asset_plan.py) turns that into the files the game will
// open, those land in MEMFS under /game, and the game's own loaders read them and its own render path draws (the D3D9
// seams on WebGL2). A file the plan missed is caught when the game looks it up (Module.mbaaAssetMiss): the page
// fetches it and plays the replay again from the start in a fresh instance up to the frame it had reached, so what is
// shown is always what the game computes with every file present.
// Query flags:
//   ?rep=URL           play that replay on load
//   ?bundle=DIR/       bundle location (default bundle/)
//   ?hash=1            state hash run: no pacing, every Game_FrameUpdate's node-runner state row (MBAA_ORACLE_OUT
//                      format) and audio row; window.__mbaaHash holds them, a link downloads the CSVs
//                      (tools/web_parity/browser_hash.py compares them with the node runner). &frames=N caps the run.
//   ?perf=1            frame pacing record (per rAF tick: time, sim ms, steps); window.__mbaaPerf() returns it
//   ?planDrop=REGEX    test: leave the matching files out of the plan (exercises the run-time miss path)
//   ?files=URL&root=P  dev/capture: load that JSON list of game paths as plain files (no bundle, no plan);
//   ?capture=1         does not start playback (tools/web_parity/browser_capture.py drives viewer_step)
//   ?boxes=1 ?inputs=1 start with the hitbox overlay / input display on (keys H / I)
//   ?kf=N              playback keyframe interval in frames (default 300); ?hash=1&capture=1 with keyframes is the seek test
//                      (tools/web_parity/seek_hash_test.py drives window.mbaaViewer)
// Seek / rewind / frame step: the sim only runs forward, so the page keyframes the whole used wasm memory every KF
// frames (16 KB pages; a page equal to the previous keyframe's is shared, so a keyframe costs its changed pages only)
// and a seek restores the nearest keyframe at or before the target and re-simulates to it with drawing and audio off
// (main_browser.cpp viewer_restore_* / viewer_suppress). Game memory, the host's maps and every host-side counter come
// back with the keyframe; GL objects (outside the wasm memory) are remade on use; audio is resynced from the BGM event
// log (which track, and its position from the frames since it started). The box overlay and the input display only
// read game memory (viewer_boxes / viewer_inputs).
const KEY_HEX = '6d626161636377656272657061796b65792d6e6f742d612d7365637265742121';
const Q = new URLSearchParams(location.search);
// the private live-spectate test copy (live.meltyblood.org/<secret>/, tools/web/cc_live.mjs) loads the public bundle
const BUNDLE = Q.get('bundle') || (/^(live|spectate)\.meltyblood\.org$/.test(location.hostname) ? 'https://watch.meltyblood.org/bundle/' : 'bundle/');
const HASH = Q.get('hash') === '1', PERF = Q.get('perf') === '1', CAPTURE = Q.get('capture') === '1';
const KF_EVERY = Math.max(10, +(Q.get('kf') || 300));  // playback keyframe interval (frames)
const KF_NEAR = 30;  // a seek that re-simulates further than 3x this keyframes about KF_NEAR frames before its target
const PAGE = Math.min(65536, Math.max(16384, +(Q.get('page') || 16384)));  // keyframe page size (bytes)
// keyframe memory; above it, every second older keyframe is dropped. Phones get less (a tab there is killed, and the page
// reloaded, around 1 GB)
const PHONE = matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 820;
// low-memory mode (phones; ?lowmem=1 / 0 forces it): no pre-scan, a small keyframe budget, a match's files freed once
// it has loaded them (freeLoaded) and the next match prefetched to the disk cache only
const LOWMEM = Q.get('lowmem') !== null ? Q.get('lowmem') === '1' : PHONE;
const FREE_FILES = Q.get('free') !== '0';  // (low memory: a match's files freed once it has loaded; ?free=0: kept, tests)
const KZ = Q.get('kz') !== '0';  // keyframe pages zlib-compressed (?kz=0: zero-word packing only)
const KF_VERIFY = Q.get('kfverify') === '1';  // checks: a commit's reused pre-pass copies compared word for word with the page at the commit (window.__kfVerify)
const KF_BUDGET = +(Q.get('kfmb') || (LOWMEM ? 40 : 450)) * 1e6;
// the store textures the kept keyframes pin (kfTexBytes) have a budget of their own: over it, keyframes thin as over KF_BUDGET
const KF_TEX_BUDGET = +(Q.get('kftexmb') || (LOWMEM ? 64 : 256)) * 1e6;
const STORE_GC = Q.get('storegc') !== '0';  // texture store eviction (storeGc; ?storegc=0: off, every sealed texture kept for the match)

const hex = h => new Uint8Array(h.match(/../g).map(x => parseInt(x, 16)));
let cryptoKey;
// z = 'xz' (manifest entry; tools/web/bundle_xz.py): the large files, a third smaller than deflate, decoded by a pool
// of web/shell/xz_worker.js (one xz-decompress each: parallel, and off this thread); everything else deflate, which the browser
// decodes natively. The pool starts on the first xz object; its URL carries viewer.js's version (deploy_pages.sh hashes
// the worker and xz-decompress into it).
let xzPool = null;
function xzDecode(buf) {
  if (!xzPool) {
    const v = ((document.querySelector('script[src^="viewer.js"]') || {}).src || '').split('?')[1] || '';
    const n = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
    xzPool = { idle: [], queue: [], jobs: new Map(), id: 0 };
    for (let i = 0; i < n; i++) {
      const w = new Worker('xz_worker.js' + (v ? `?${v}` : ''));
      w.onmessage = ({ data: { id, buf, err } }) => {
        const j = xzPool.jobs.get(id); xzPool.jobs.delete(id);
        err ? j.rej(new Error(`xz: ${err}`)) : j.res(new Uint8Array(buf));
        xzNext(w);
      };
      xzPool.idle.push(w);
    }
  }
  return new Promise((res, rej) => {
    const id = ++xzPool.id;
    xzPool.jobs.set(id, { res, rej });
    xzPool.queue.push({ id, buf });
    if (xzPool.idle.length) xzNext(xzPool.idle.pop());
  });
}
function xzNext(w) {
  const j = xzPool.queue.shift();
  if (!j) { xzPool.idle.push(w); return; }
  w.postMessage(j, [j.buf]);
}
async function openObject(buf, z = null) {
  const b = new Uint8Array(buf);
  const d = await crypto.subtle.decrypt({ name: 'AES-CTR', counter: b.slice(0, 16), length: 64 }, cryptoKey, b.slice(16));
  if (z === 'xz') return xzDecode(d);
  const s = new Blob([d]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
const net = window.mbaaNet = { objects: 0, bytes: 0, cached: 0 };
// Bundle objects are content-addressed (the name is a hash of the content), so a stored copy never goes stale: they
// are kept in the Cache Storage API, and a character / stage seen before loads with no network at all. (Pages' own
// HTTP cache keeps them only 10 minutes.)
let objCache = null;
const objCacheReady = (async () => {
  try { objCache = await caches.open('MBAACC game files'); caches.delete('mbaa-objects-v1'); } catch (e) {}  // (the deflate-only store)
})();
// without persistent storage a browser clears the store when it wants space (mobile Chrome, Safari): ask once; the page
// files themselves are kept by the service worker (sw.js; deployed builds only, a local build has no versioned names)
if (navigator.storage && navigator.storage.persist) navigator.storage.persisted().then(p => p || navigator.storage.persist()).catch(() => {});
if ('serviceWorker' in navigator && /^(replay|watch)\.meltyblood\.org$/.test(location.hostname))
  navigator.serviceWorker.register('/sw.js').catch(e => console.warn('service worker:', e));
async function fetchObject(h, z = null) { return openObject(await fetchRaw(h), z); }
// an object or a pack (tools/web/bundle_pack.py: a group's small objects back to back) as stored, from this device's
// store or the network
async function fetchRaw(h) {
  const url = `${BUNDLE}o/${h.slice(0, 2)}/${h}`;
  await objCacheReady;
  if (objCache) {
    try { const hit = await objCache.match(url); if (hit) { net.cached++; return hit.arrayBuffer(); } } catch (e) {}
  }
  const r = await fetch(url);
  if (!r.ok) throw new Error(`object ${h}: HTTP ${r.status}`);
  const buf = await r.arrayBuffer();
  net.objects++; net.bytes += buf.byteLength;
  if (objCache) objCache.put(url, new Response(buf.slice(0))).catch(() => {});
  return buf;
}
function status(t) { document.getElementById('status').textContent = t; slogStatus(t); }
// ---- the session log (user 2026-11-01: "I wish I had a log ... x player x match x time and how long x phase took"):
// every status line (a progress run kept as one entry, first and last), each live session's scene changes (VS,
// select, battle, result), holds and their reason, 2x / catch-up, switches, and the game's own spectate: / live:
// console lines, timestamped. ⚙ "copy session log" puts it on the clipboard; a live picture stuck 20 s sends it to the
// bridge (/live/<id>/diag: kept with the captures, no addresses) once per stall ----
const SLOG_MAX = 800, slog = [], slogT0 = performance.now();
let slogNorm = '';
function slogAdd(ev, d = '') {
  slog.push([Math.round(performance.now() - slogT0), new Date().toISOString().slice(11, 23), ev, String(d).slice(0, 300)]);
  if (slog.length > SLOG_MAX) slog.splice(0, slog.length - SLOG_MAX);
}
function slogStatus(t) {
  const n = String(t).replace(/[\d.]+/g, '#');
  const last = slog[slog.length - 1];
  if (n === slogNorm && last && last[2] === 'status') { last[4] = String(t).slice(0, 300); return; }  // (a progress run: its last line)
  slogNorm = n; slogAdd('status', t);
}
for (const k of ['warn', 'error']) {
  const o = console[k].bind(console);
  console[k] = (...a) => { try { const t = a.map(String).join(' '); if (k === 'error' || /^(spectate|live|radio):/.test(t)) slogAdd(k, t); } catch (e) {} o(...a); };
}
addEventListener('error', e => slogAdd('error', `${e.message} @${(e.filename || '').split('/').pop()}:${e.lineno}`));
addEventListener('unhandledrejection', e => slogAdd('error', `promise: ${e.reason && e.reason.message || e.reason}`));
const SCENE_NAME = { 0: 'boot', 1: 'battle', 2: 'title', 5: 'result', 8: 'VS screen', 20: 'character select' };
function slogWatch(s) {
  const M = s.M; if (!M) return;
  const w = s.slogW || (s.slogW = { scene: null, holds: '', ff: false, f: -1, fAt: performance.now(), sent: false });
  const scene = M.HEAP32[0x54EEE8 >> 2], f = M._viewer_frame();
  if (scene !== w.scene) { slogAdd('scene', `${SCENE_NAME[scene] || 'scene ' + scene} (frame ${f})`); w.scene = scene; }
  const holds = [s.cssHeld && 'next game files (select)', s.loadHeld && 'next game setup', s.rematchHeld && 'rematch files',
    s.cssBgHeld && 'select screen files', s.liveHeld && 'stream', s.seeking && 'seeking'].filter(Boolean).join(', ');
  if (holds !== w.holds) { slogAdd('hold', holds ? `held: ${holds}` : 'running'); w.holds = holds; }
  if (!!s.liveFF !== w.ff) { w.ff = !!s.liveFF; slogAdd('speed', w.ff ? '2x catching up' : '1x'); }
  const now = performance.now();
  if (f !== w.f) { w.f = f; w.fAt = now; w.sent = false; }
  else if (!w.sent && s.liveSrc && !ui.paused && !document.hidden && now - w.fAt > 20000) {
    w.sent = true; slogAdd('stall', `no frame for ${Math.round((now - w.fAt) / 1000)} s at frame ${f}`); slogSend(s, 'stall');
  }
}
function slogText() {
  const L = liveSrc, head = [`MBAACC viewer session log, ${new Date(Date.now() - (performance.now() - slogT0)).toISOString()} (UTC)`,
    L ? `live ${L.id}: ${(L.info.names || []).map(n => (n || '?').trim() || '?').join(' vs ')} (game ${L.info.game})` : `page ${location.search.slice(0, 80)}`,
    `${navigator.userAgent.match(/(Firefox|Chrome|Safari|Edg)\/[\d.]+/)?.[0] || ''}${matchMedia('(pointer: coarse)').matches ? ', touch' : ''}${typeof LOWMEM !== 'undefined' && LOWMEM ? ', low memory' : ''}`, ''];
  return head.concat(slog.map(([ms, at, ev, d, d2]) => `+${(ms / 1000).toFixed(1).padStart(7)}s ${at} ${ev.padEnd(6)} ${d}${d2 && d2 !== d ? ` … ${d2}` : ''}`)).join('\n')
    .replace(/\b\d{1,3}(\.\d{1,3}){3}(:\d+)?\b/g, '<ip>');  // (a player named by their address: never shown)
}
function slogSend(s, why) {
  const L = s && s.liveSrc;
  if (!L || !LIVE) return;
  fetch(`${LIVE}/live/${L.id}/diag`, { method: 'POST', body: JSON.stringify({ why, text: slogText() }).slice(0, 120000) }).catch(() => {});
}
window.mbaaSessionLog = slogText;  // (tests, and the console)
document.getElementById('slogcopy')?.addEventListener('click', async e => {
  const b = e.currentTarget, t = slogText();
  try { await navigator.clipboard.writeText(t); b.textContent = 'copied ✓'; }
  catch (err) {  // (no clipboard permission: a box to copy from)
    const ta = Object.assign(document.createElement('textarea'), { value: t, readOnly: true });
    Object.assign(ta.style, { position: 'fixed', inset: '10% 10%', zIndex: 99, background: '#111', color: '#ddd', font: '11px monospace' });
    ta.onblur = () => ta.remove(); document.body.append(ta); ta.focus(); ta.select(); b.textContent = 'select all + copy';
  }
  if (session && session.liveSrc) slogSend(session, 'copied');
  setTimeout(() => { b.textContent = 'copy session log'; }, 2500);
});
// chara id -> display name (charaselect.txt CharaNo_<id>; replay header side block +4), moon (+8): 0 C, 1 F, 2 H
const CHARA = { 0: 'Sion', 1: 'Arcueid', 2: 'Ciel', 3: 'Akiha', 4: 'Hisui & Kohaku', 5: 'Hisui', 6: 'Kohaku', 7: 'Shiki',
  8: 'Miyako', 9: 'Warachia', 10: 'Nrvnqsr', 11: 'V. Sion', 12: 'Red Arcueid', 13: 'V. Akiha', 14: 'Mech-Hisui', 15: 'Nanaya',
  16: 'G. Akiha', 17: 'Satsuki', 18: 'Len', 19: 'P. Ciel', 20: 'Neco-Arc', 22: 'Aoko', 23: 'White Len', 25: 'Neco-Arc Chaos',
  27: 'G. Chaos', 28: 'Kouma', 29: 'Seifuku Akiha', 30: 'Riesbyfe', 31: 'Roa', 32: 'Hermes', 33: 'Ryougi',
  34: 'Neco & Mech', 35: 'Kohaku & Mech', 51: 'Arcueid (Earth)', 53: 'B. Akiha', 58: 'B. Miyako', 59: 'B. Warachia',
  72: 'B. Aoko', 73: 'B. White Len', 85: 'B. Kohaku & Mech' };
function matchTitle(rep) {
  if (rep.length < 0x5C) return 'MBAACC replay';
  const dv = new DataView(rep.buffer, rep.byteOffset, rep.byteLength);
  const side = o => (['C-', 'F-', 'H-'][dv.getInt32(o + 8, true)] || '') + (CHARA[dv.getInt32(o + 4, true)] || `#${dv.getInt32(o + 4, true)}`);
  return `${side(0x3C)} vs ${side(0x4C)}`;
}
// a replay file name (CIELxW_LEN_261009184010) -> ['Ciel vs W Len', 'Oct 9 18:40']; other names pass through
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function repLabel(name) {
  const base = name.replace(/^.*\//, '').replace(/\.rep$/i, ''), m = base.match(/^(.+?)_(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\d{2}$/);
  if (!m || !/x/.test(m[1])) return [base, ''];
  const nice = t => t.split('_').map(w => w.charAt(0) + w.slice(1).toLowerCase()).join(' ');
  return [m[1].split('x').map(nice).join(' vs '), `${MONTHS[+m[3] - 1] || m[3]} ${+m[4]} ${m[5]}:${m[6]}`];
}

// ---- asset plan (mirror of tools/web/asset_plan.py plan_files) ----
function repKeys(rep) {
  const v = new DataView(rep.buffer, rep.byteOffset, rep.byteLength), i = o => v.getInt32(o, true);
  const magic = new TextDecoder().decode(rep.slice(0, 14));
  if (magic !== 'MBAAReplayFile') throw new Error('not an MBAACC replay (.rep)');
  return { stage: i(0x28), p1: [i(0x40), i(0x44), i(0x48)], p2: [i(0x50), i(0x54), i(0x58)] };
}
// Match length estimate for the seek bar before the replay has been played to its end: the rounds' recorded input
// (each round: 4 tracks of (input, frames) runs; a round lasts its longest track) plus the VS intro, round intros/outros
// and the result screen, which take no input. Freeze frames take none either, so this is low by up to a few thousand
// frames on some tapes; the bar switches to the exact end once the replay reaches it.
function repEstimate(rep) {
  try {
    const v = new DataView(rep.buffer, rep.byteOffset, rep.byteLength), u = o => v.getUint32(o, true);
    let o = 0x5C, sum = 0;
    const n = u(o); o += 4;
    if (n > 16) return 0;
    for (let r = 0; r < n; r++) {
      o += 0x80 + 12;
      let longest = 0;
      for (let t = 0; t < 4; t++) {
        const c = u(o); o += 4;
        let f = 0;
        for (let i = 0; i < c; i++) f += rep[o + 6 * i];
        o += 6 * c; longest = Math.max(longest, f);
      }
      o += 4 + 4 * u(o) + 0x90;
      sum += longest;
    }
    return sum + 1200 + 450 * n;
  } catch (e) { return 0; }
}
const fmt = (t, c, m) => t.replace(/\{(\w):02d\}/g, (_, k) => String(k === 'c' ? c : m).padStart(2, '0'))
                          .replace(/\{(\w)\}/g, (_, k) => String(k === 'c' ? c : m));
function planFiles(man, keys) {
  const p = man.plan, out = new Set([...p.boot, ...p.common]);
  if (keys.stage !== null) {
    for (const t of p.stage) out.add(fmt(t, keys.stage, 0));
    for (const f of (p.stage_files || {})[keys.stage] || []) out.add(f);
  }
  for (const side of [keys.p1, keys.p2]) {
    if (!side) continue;
    const [c, m] = side;
    for (const t of p.templates) out.add(fmt(t, c, m));
    for (const f of p.chara[`${c}`] || []) out.add(f);
    if (p.chara[`${c}:${m}`]) for (const f of p.chara[`${c}:${m}`]) out.add(f);
    else for (const [k, v] of Object.entries(p.chara)) if (k.startsWith(`${c}:`)) for (const f of v) out.add(f);
  }
  return withSiblings(man, out);
}
// a .wav/.ogg is its header stub (what the game's loaders read) plus the .opus the page plays
function withSiblings(man, paths) {
  const out = new Set();
  for (const f of paths) {
    if (man.files[f]) out.add(f);
    const opus = f.replace(/\.(wav|ogg)$/, '.opus');
    if (opus !== f && man.files[opus]) out.add(opus);
    // a win quote's Ex version (ResultMenu_LoadWinQuoteData reads story/battle/<name>Ex_win.txt for a winner whose
    // player record has the Ex flag: riesEX, necoEx); the asset plan has the plain one only
    const ex = f.replace(/^(story\/battle\/.+)_win\.txt$/, '$1ex_win.txt');
    if (ex !== f && man.files[ex]) out.add(ex);
  }
  return out;
}

// ---- files: fetched once per page, written into every session's MEMFS ----
const cache = new Map();  // game path -> Uint8Array
async function fetchAll(man, paths, label, quiet = false) {
  const net0 = net.bytes;  // the counter shows what came over the network (objects are deflated; the game sees ~4x that)
  const queue = [...paths].filter(p => !cache.has(p));
  let done = 0, bytes = 0;
  const n = queue.length, packs = new Map();  // pack -> its bytes (one fetch for all of its files in this call)
  async function worker() {
    for (let p; (p = queue.shift());) {
      const f = man.files[p];
      let data;
      if (f.plain) {
        const r = await fetch(f.plain);
        if (!r.ok) { console.warn(`${p}: HTTP ${r.status}`); continue; }
        data = new Uint8Array(await r.arrayBuffer());
      } else if (f.pk) {
        const [h, off, len] = f.pk;
        if (!packs.has(h)) packs.set(h, fetchRaw(h));
        data = await openObject((await packs.get(h)).slice(off, off + len), f.z);
      } else data = await fetchObject(f.o, f.z);
      cache.set(p, data);
      if ((++done % 10 === 0 || done === n) && !quiet) status(`${label} ${done}/${n} (${((net.bytes - net0) / 1e6).toFixed(1)} MB downloaded${net.cached ? `, ${net.cached} files from cache` : ''})`);
    }
  }
  await Promise.all(Array.from({ length: 16 }, worker));
}
function mkdirs(FS, path) {
  let cur = '';
  for (const p of path.split('/').slice(0, -1)) { if (!p) continue; cur += '/' + p; try { FS.mkdir(cur); } catch (e) {} }
}
// The game's reads of /game files (FS.open is what the libc open syscall calls): which files this match has opened, and
// an open of a file freeLoaded dropped (the game asked again: it is refetched and the match replayed to this frame).
function trackOpens(s) {
  const M = s.M, FS = M.FS;
  s.opened = new Set(); s.freed = new Set(); s.freedAt = -1;
  M.mbaaOpened = p => { if (session === s) { s.opened.add(p); if (s.freed.has(p)) misses.add(p); } };
  M.mbaaOpenFail = p => { if (session === s && s.freed.has(p)) misses.add(p); };
  if (!FS.__tracked) wrapOpen(M);
}
// (its own function: a closure made in trackOpens would keep that first session, and its keyframes, alive)
function wrapOpen(M) {
  const FS = M.FS, open = FS.open;
  FS.__tracked = true;
  FS.open = function (path, flags, ...a) {
    const game = typeof path === 'string' && path.startsWith('/game/') && (flags === 'r' || flags === 0 || (typeof flags === 'number' && (flags & 3) === 0));
    try {
      const st = open.call(this, path, flags, ...a);
      if (game) M.mbaaOpened(path.slice(6));
      return st;
    } catch (e) { if (game) M.mbaaOpenFail(path.slice(6)); throw e; }
  };
}
// Low-memory mode, once a match has loaded (round 1 on, no game file open): the files it has read are dropped from
// MEMFS and the cache (the game keeps what it read in its own memory; only the BGM, played from the cache by the page,
// stays). A stage probe the game has read (the replay's stage .dat, 4-12 MB) goes back to its 1-byte placeholder; an
// open of it after that counts as a miss, as a failed open of any other freed file does. Files it has not opened yet
// (the result screen's) stay. keep: files that stay as well (live: the select screen's, and the next game's).
function freeLoaded(s, keep = null) {
  const probe = new Set((man.plan && man.plan.probe) || []);
  for (const p of new Set([...s.opened, ...(s.M.mbaaBootOpened || [])])) {
    // (graphics stay: the game reads its pictures again on later screens of the same match, the victory screen's
    // portraits and cut-ins, the result menu's art; a freed probe file is a 1-byte stand-in that opens fine and decodes
    // to nothing, drawn white: user 2026-11-01, harness-design/web_parity/viewer_tools/live_victory_phone_check.py.
    // They are a few MB; the characters' sprite data and the stage are what freeing saves)
    if (s.freed.has(p) || /^(bgm|grp)\//.test(p) || !s.want.has(p) || (keep && keep.has(p))) continue;
    try { if (probe.has(p)) s.M.FS.writeFile('/game/' + p, new Uint8Array(1)); else s.M.FS.unlink('/game/' + p); } catch (e) { continue; }
    cache.delete(p); s.freed.add(p);
  }
  s.freedAt = s.M._viewer_frame();
}
// a game file into MEMFS sharing the fetched buffer (MEMFS write with canOwn keeps the array instead of copying it; the
// game root is read-only and nothing writes the cache's arrays)
function fsPut(FS, path, d) {
  mkdirs(FS, path);
  const st = FS.open(path, 'w');
  try { FS.write(st, d, 0, d.length, 0, true); } finally { FS.close(st); }
}

// ---- audio (WebAudio, shared by sessions) ----
let actx, master, outGain, musicGain;
// Browsers start an AudioContext only after the page got a click or key press (one made earlier stays suspended, with a
// console warning); a replay opened from a link has had neither. So the context is made on the first gesture: until then
// the page shows #sound, the sessions keep the game's BGM requests (s.bgmLog) and play nothing, and once audio runs the
// BGM the game requested starts from where the match is (__mbaaBgmResume).
// Returns whether audio exists; inGesture: called from a click / key / drop handler.
// (a touch's pointerdown is no gesture to the browser: only its pointerup / touchend / click are; a mouse's pointerdown is)
const GESTURES = ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown'];
const activated = () => !!(navigator.userActivation && navigator.userActivation.hasBeenActive);
function ensureAudio(inGesture = false) {
  if (actx) return true;
  if (!inGesture && !activated()) { audioArm(); return false; }
  // (iPhone: 'playback' makes Web Audio play with the ringer switch on silent, as a video does; Safari 17+)
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) {}
  actx = new AudioContext();
  master = actx.createGain();  // the game's mix at CE level; video export records from here
  outGain = actx.createGain(); outGain.gain.value = volGain();
  musicGain = actx.createGain(); musicGain.gain.value = ui.music ? 1 : 0; musicGain.connect(master);  // the BGM (music toggle)
  master.connect(outGain); outGain.connect(actx.destination);
  const btn = document.getElementById('sound');
  const show = () => { btn.hidden = actx.state === 'running'; };
  btn.onclick = () => actx.resume();
  const unlock = () => { if (actx.state !== 'running') actx.resume(); };
  for (const ev of GESTURES) addEventListener(ev, unlock, true);
  actx.onstatechange = () => { show(); if (actx.state === 'running' && window.__mbaaBgmResume) window.__mbaaBgmResume(); };
  show();
  // the tracks the match already has decode now (the stream decoder needs no context ahead)
  if (session && !HASH && !bgmStreamReady) for (const p of session.want) if (/^bgm\/.*\.opus$/.test(p) && cache.has(p)) bgmDecode(p);
  if (session && window.__mbaaAudioMade) window.__mbaaAudioMade();
  if (actx.state === 'running' && window.__mbaaBgmResume) window.__mbaaBgmResume();
  return true;
}
// before the first gesture: #sound shows, and any click or key makes the context
let audioArmed = false;
function audioArm() {
  if (audioArmed) return;
  audioArmed = true;
  const btn = document.getElementById('sound');
  btn.hidden = false;
  const go = () => { for (const ev of GESTURES) removeEventListener(ev, go, true); ensureAudio(true); actx.resume(); };
  for (const ev of GESTURES) addEventListener(ev, go, true);
}
// the volume slider (works before audio exists: the context takes its level when made)
const volGain = () => Math.pow(+document.getElementById('vol').value / 100, 2);
function volInit() {
  const vol = document.getElementById('vol');
  // 100% = CE's own level (every set already carries the game's DirectSound volume, -16.66 dB at the canonical
  // settings); the slider only attenuates below it. Default 100. Remembered under a new key: the old one stored the
  // 50% default of the full-gain era for everyone who opened the page.
  const setVol = () => { if (outGain) outGain.gain.value = volGain(); try { localStorage.setItem('mbaaVolCe', vol.value); } catch (e) {} };
  vol.value = 100;
  try { const v = localStorage.getItem('mbaaVolCe'); if (v !== null) vol.value = v; } catch (e) {}
  vol.oninput = () => { setVol(); if (typeof pipFollow === 'function') pipFollow(); vol.style.setProperty('--p', `${vol.value}%`); document.querySelector('#mute .i').className = `i ${+vol.value ? 'i-sound' : 'i-mute'}`; };
  vol.oninput();
}
// The game's DirectSound buffers as WebAudio voices (web/host/browser/audio_web.cpp, sound_sets.cpp). Channel = sound
// set: SE i (0..1499), 1500 the result-screen set, -1 the BGM stream. As a DirectSound buffer, a set plays one voice: Play
// restarts it from the beginning (the previous voice of that set is cut), Stop cuts it, SetVolume / SetPan change it while
// it plays. vol and pan are DirectSound units (hundredths of a dB): gain = 10^(vol/2000), -10000 (DSBVOLUME_MIN) silent;
// pan < 0 attenuates the right channel by |pan|, pan > 0 the left by pan, the other side stays at 0 dB (a mono sound plays
// at full level on both sides at pan 0, which WebAudio's mono -> stereo up-mix also does). All of it runs under the
// master volume slider.
// Seeking (s.mute while the viewer re-simulates, s.stopSes / s.bgmHalt / s.bgmSync from the timeline) keeps the voices'
// parameters current but plays nothing; the BGM's start / stop / volume calls are logged with their frame the first time
// that frame is simulated, so after a seek the page knows which track plays at the target, from where and how loud.
const dsGain = v => (v <= -10000 ? 0 : Math.pow(10, v / 2000));
function dsSetPan(ch, pan) {  // ch: {l, r} gain nodes after the stereo split; pan 0 = both at unity
  ch.l.gain.value = pan > 0 ? dsGain(-pan) : 1;
  ch.r.gain.value = pan < 0 ? dsGain(pan) : 1;
}
function dsVoiceChain(out) {  // gain (volume) -> split -> per-side gain (pan) -> merge -> out
  const g = actx.createGain();
  g.channelCount = 2; g.channelCountMode = 'explicit'; g.channelInterpretation = 'speakers';
  const sp = actx.createChannelSplitter(2), mg = actx.createChannelMerger(2);
  const l = actx.createGain(), r = actx.createGain();
  g.connect(sp); sp.connect(l, 0); sp.connect(r, 1); l.connect(mg, 0, 0); r.connect(mg, 0, 1); mg.connect(out);
  return { g, l, r, src: null, vol: 0, pan: 0 };
}
function audioHooks(Module, s) {
  ensureAudio();
  const running = () => !!actx && actx.state === 'running';
  const live = () => !HASH && running() && session === s && !s.mute;
  const seBuf = new Map();  // bundle path -> decode promise
  const se = window.mbaaSeStats = { registered: 0, calls: 0, played: 0, decodeFailed: 0, stops: 0, params: 0, ctx: () => actx.state };
  const voices = new Map();  // channel -> chain
  const chain = ch => { let v = voices.get(ch); if (!v) { v = dsVoiceChain(master); voices.set(ch, v); } return v; };
  const cut = v => { if (v.src) { try { v.src.stop(); } catch (e) {} v.src.disconnect(); v.src = null; } };
  const apply = (v, vol, pan) => { v.vol = vol; v.pan = pan; v.g.gain.value = dsGain(vol); dsSetPan(v, pan); };
  Module.mbaaVoicePlay = (ch, path, vol, pan) => {
    se.calls++;
    if (!actx) return;  // (no audio yet: a Play before it is never heard; the next Play sets the voice up)
    const v = chain(ch);
    cut(v); apply(v, vol, pan);
    if (!live()) return;
    let b = seBuf.get(path);
    if (!b) {
      let bytes;
      try { bytes = Module.FS.readFile(path); } catch (e) { return; }
      b = actx.decodeAudioData(bytes.slice().buffer);
      seBuf.set(path, b); se.registered++;
    }
    const n = actx.createBufferSource();
    v.src = n;  // claimed now: a Stop or a later Play before the decode resolves cancels it
    b.then(buf => { if (v.src !== n || !live()) return; n.buffer = buf; n.connect(v.g); n.start(); se.played++; },
           () => { se.decodeFailed++; });
  };
  Module.mbaaVoiceParam = (ch, vol, pan) => {
    se.params++;
    if (ch === -1) { log(['param', vol, pan]); radioLevel(vol); if (graph()) apply(bgmChain, vol, pan); return; }
    if (actx) apply(chain(ch), vol, pan);
  };
  Module.mbaaVoiceStop = ch => {
    se.stops++;
    if (ch === -1) { Module.mbaaBgmStop(); return; }
    const v = voices.get(ch);
    if (v) cut(v);
  };
  s.stopSes = () => { for (const v of voices.values()) cut(v); };
  // BGM: the stream set, one looping track (back to loopPos seconds at the end, as the game's stream does)
  // (made with the context: s.bgmSync then sets the stream's level from the log)
  // The radio plays at the music's own level: the highest the game has set its stream to (it starts each track silent,
  // -10000, and raises it; fades go below it); before the game's first music, CE's level at the canonical settings
  let bgmChain = null, radioChain = null, radioVol = null;
  const radioLevel = vol => {
    if (vol > -10000 && (radioVol === null || vol > radioVol)) radioVol = vol;
    if (radioChain) apply(radioChain, radioVol === null ? -1666 : radioVol, 0);
  };
  const graph = () => {
    if (!bgmChain && actx) { bgmChain = dsVoiceChain(musicGain); radioChain = dsVoiceChain(musicGain); radioLevel(-10000); }
    return !!bgmChain;
  };
  window.__mbaaAudioMade = () => { if (session === s) graph(); };
  let bgm = null, bgmPath = '';
  // fade = seconds: the track fades out (pause) instead of cutting (seek, track change). Each track has its own fade
  // gain after the stream's volume/pan chain, so a fade never fights the game's own volume changes.
  const halt = (fade = 0) => {
    const n = bgm;
    bgm = null; bgmPath = '';
    if (!n || !n.stop) return;
    if (fade > 0 && n.fadeGain) {
      const t = actx.currentTime;
      n.fadeGain.gain.cancelScheduledValues(t);
      n.fadeGain.gain.setValueAtTime(n.fadeGain.gain.value, t);
      n.fadeGain.gain.linearRampToValueAtTime(0, t + fade);
      try { n.stop(t + fade + 0.02); } catch (e) {}
    } else { try { n.stop(); } catch (e) {} }
  };
  s.bgmPlaying = () => !!(bgm && bgm.stop);
  s.bgmTrack = () => bgmPath;  // (the track playing or decoding: the radio's when it is on)
  s.bgmLog = [];
  const log = ev => { const k = Module._viewer_frame(); if (!s.tl || k >= s.tl.simMax) s.bgmLog.push([k, ...ev]); };
  // Melty radio (radio, set from the panel): its track replaces the match's music (a replay: until its end; a live match: its later games too, start), straight
  // through the game's track changes, stops and seeks, at a steady volume (radioLevel: the music's own level, without its fades)
  const radioOn = () => !!musicNow() && !HASH;  // (the radio's music: the pick's, or the music chosen on its own)
  const play = (path, loop, loopPos, offset) => {
    // (the "...and nothing heart" stage's music: off unless the viewer turned it on; songSub)
    const sub = !radioOn() && songSub(path, Module.HEAP32[STAGE_ID >> 2]);
    if (sub) {
      if (!cache.has(sub.key)) {  // (fetched on first use: then played from where the game's track would be)
        const t0 = actx ? actx.currentTime : 0;
        fetchAll(man, withSiblings(man, [sub.key.replace(/\.opus$/, '.ogg')]), '', true)
          .then(() => { if (session === s && bgmPath === '' && cache.has(sub.key)) play(path, loop, loopPos, offset + (actx ? actx.currentTime - t0 : 0)); })
          .catch(() => {});
        halt();
        return;
      }
      path = sub.path; loop = true; loopPos = sub.loopPos;
    }
    if (radioOn()) {
      const mu = musicNow();
      if (bgm && bgmPath === mu.path) return;
      path = mu.path; loop = true; loopPos = mu.loopPos; offset = 0;
    }
    halt();
    if (!graph()) return;
    const out = radioOn() ? radioChain.g : bgmChain.g;
    const o = bgmStreamReady && bgmParsed(path.replace(/^\/game\//, ''));
    if (o) {  // streamed (bgm_stream.js): a couple of seconds decoded at a time
      bgmPath = path;
      const fadeGain = actx.createGain(), lead = 0.05;
      fadeGain.connect(out);
      const st = bgmStreamPlay(actx, o, fadeGain, loop, loopPos, offset + lead, actx.currentTime + lead);
      bgm = { stop: at => st.stop(at), fadeGain };
      return;
    }
    const dec = bgmDecode(path.replace(/^\/game\//, ''));
    if (!dec) return;
    bgmPath = path;
    const token = {}, t0 = actx.currentTime;
    bgm = token;
    dec.then(buf => {
      if (bgm !== token || session !== s || s.mute) return;
      const n = actx.createBufferSource();
      n.buffer = buf; n.loop = !!loop; n.loopStart = Math.min(loopPos, buf.duration); n.loopEnd = buf.duration;
      let off = offset + (actx.currentTime - t0);
      if (off >= buf.duration) {
        if (!loop) return;
        const span = buf.duration - n.loopStart;
        off = span > 0 ? n.loopStart + ((off - n.loopStart) % span) : 0;
      }
      n.fadeGain = actx.createGain();
      n.connect(n.fadeGain); n.fadeGain.connect(out); n.start(0, Math.max(0, off));
      bgm = n;
    }, () => {});
  };
  Module.mbaaBgmStop = () => { log(['stop']); if (!radioOn()) halt(); };
  // SoundBuffer_Play on the stream: restarts the track from its beginning at the set's volume/pan
  Module.mbaaBgmStart = (path, loop, loopPos, vol, pan) => {
    log(['start', path, loop, loopPos, vol, pan]);
    s.bgmNow = path;
    radioLevel(vol);
    if (graph()) apply(bgmChain, vol, pan);
    if (!live()) { if (!radioOn()) halt(); return; }
    play(path, loop, loopPos, 0);
  };
  // the track at frame T, its position and the stream's last volume / pan before T
  s.bgmSync = T => {
    if (HASH) return;
    let cur = null, vp = null;
    for (const [k, ev, ...a] of s.bgmLog) {
      if (k >= T) break;
      if (ev === 'stop') cur = null;
      else if (ev === 'start') { cur = { path: a[0], loop: a[1], loopPos: a[2], k }; vp = [a[3], a[4]]; }
      else if (ev === 'param') vp = [a[0], a[1]];
    }
    s.bgmNow = cur ? cur.path : null;
    if (radioOn()) { if (running() && !s.mute) play('', 1, 0, 0); else halt(); return; }
    halt();
    if (vp && graph()) apply(bgmChain, vp[0], vp[1]);
    if (cur && running() && !s.mute) play(cur.path, cur.loop, cur.loopPos, Math.max(0, T - cur.k - 1) / 60);
  };
  s.bgmHalt = fade => { if (!radioOn() || fade) halt(fade); };  // (a seek keeps the radio; a pause fades it too)
  s.radioChanged = () => { halt(); if (!s.mute) s.bgmSync(Module._viewer_frame()); };
  window.__mbaaBgmResume = () => { if (session === s && !s.mute) s.bgmSync(Module._viewer_frame()); };
  window.addEventListener('mbaa-session-end', () => { s.stopSes(); halt(); }, { once: true });
}

// BGM tracks decode when the match's files arrive (a few MB of Opus: decoding at BGM start would stall that frame);
// where WebCodecs decodes Opus they are streamed instead (bgm_stream.js; ?bgmStream=0 decodes them whole)
const bgmDecoded = new Map(), bgmParsedMap = new Map();
let bgmStreamReady = false;
bgmStreamSupported().then(ok => { bgmStreamReady = ok && Q.get('bgmStream') !== '0'; });
function bgmParsed(p) {
  if (!bgmParsedMap.has(p)) { const d = cache.get(p); if (!d) return null; bgmParsedMap.set(p, oggOpusParse(d)); }
  return bgmParsedMap.get(p);
}
function bgmDecode(p) {
  if (!bgmDecoded.has(p)) {
    const d = cache.get(p);
    if (!d || !actx) return null;
    bgmDecoded.set(p, actx.decodeAudioData(d.slice().buffer));
  }
  return bgmDecoded.get(p);
}

// Stage 55 ("...and nothing heart", the Ryougi stage): its music (and the Kara no Kyoukai track bgmme55 the game files
// ship) gets streams copyright-struck, so it is replaced by another stage's track unless the viewer turned it on
// (settings: the song, remembered: mbaa-song55). Exports follow what plays. (user 2026-11-01)
const SONG_STAGE = 55, SONG_SUB = 'bgmme30';  // (Silent Rumble, the shrine stage's)
let songOn = false;
try { songOn = localStorage.getItem('mbaa-song55') === '1'; } catch (e) {}
function songSub(path, stage) {
  if (songOn || !path) return null;
  const m = path.match(/bgmme5([56])\.(ogg|opus)$/i);
  if (!m || (m[1] === '6' && stage !== SONG_STAGE)) return null;
  const sp = path.replace(/bgmme5[56]/i, SONG_SUB), key = sp.replace(/^\/game\//, '');
  const t = stagePanel && stagePanel.tracks[SONG_SUB];
  return { path: sp, key, loopPos: t ? t.loopPos : 0 };
}
// ---- a session: one wasm instance playing one replay ----
let session = null;
const pl = { items: [], i: -1 };  // playlist: {name, file, url?} (see startItem)
let man = null;
const misses = new Set();  // bundle files the game looked up that the page had not fetched
function freshCanvas() {
  const old = document.getElementById('canvas');
  const c = old.cloneNode(false);
  old.replaceWith(c);
  if (pipVideo) {  // (picture in picture: the new canvas; the old capture track stopped, else it kept the old canvas and its GL context)
    pipSelfAt = performance.now();
    if (pipVideo.srcObject) for (const tr of pipVideo.srcObject.getTracks()) tr.stop();
    pipVideo.srcObject = pipStream(c); pipVideo.play().catch(() => {});
  }
  // a phone frees a background page's GPU context (switching to another app and back): kept restorable, and the session
  // started again on a fresh instance (its textures, shaders and targets died with the context) where it was
  c.addEventListener('webglcontextlost', e => { e.preventDefault(); if (session) session.glLost = true; });
  c.addEventListener('webglcontextrestored', () => glRecover());
  return c;
}
// the picture's GL context was lost: a new instance (no reuse: the old one's GL names are dead) at the same frame, or for
// a live match the live game again
async function glRecover() {
  const s = session;
  if (!s || !s.glLost || s.glRecovering || document.visibilityState === 'hidden') return;
  s.glRecovering = true;
  status('the browser freed the picture in the background: restoring…');
  try { s.M.ccall('viewer_stop', null, [], []); } catch (e) {}
  s.boot = null;
  // (low-memory mode dropped the files the match had read, the exe among them: a new instance needs them all again)
  const want = withSiblings(man, new Set([...(s.want || []), ...(s.freed || []), ...(s.M.mbaaBootOpened || [])]));
  await fetchAll(man, want, 'restoring the picture');
  if (s.liveSrc) return startLive(s.liveSrc.id, s.liveSrc.info.match);
  return play(s.rep, s.name, curFrame(), s.want ? new Set([...s.want, ...want]) : null);
}
// Background play: a hidden page gets no animation frames, so a worker's timer (not slowed for hidden pages) ticks the
// game instead, sound and all; nothing is drawn unless a picture-in-picture window shows it
let bgTicker = null;
function bgTick(on) {
  if (on && !bgTicker) {
    bgTicker = new Worker(URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 16)'], { type: 'text/javascript' })));
    bgTicker.onmessage = () => {
      const s = session;
      if (s && s.M && document.visibilityState === 'hidden') try { s.M._viewer_tick(document.pictureInPictureElement ? 1 : 0); } catch (e) {}
    };
  } else if (!on && bgTicker) { bgTicker.terminate(); bgTicker = null; }
}
// Picture in picture: the canvas as a (silent: the page plays the sound) video stream, popped out by the button or, where
// the browser allows, by leaving the page while a match plays
let pipVideo = null, pipTrack = null;
// (a stream at 0 fps: frames only when asked. A 60 fps capture made the browser read the whole game canvas back every
// frame for a video nobody watched; now 60 a second only while the picture-in-picture window is open, 2 a second
// otherwise so a pop-out finds a frame ready)
function pipStream(c) {
  const st = c.captureStream(0);
  pipTrack = st.getVideoTracks()[0] || null;
  if (!pipTrack || typeof pipTrack.requestFrame !== 'function') { pipTrack = null; return c.captureStream(60); }
  return st;
}
let pipTickN = 0;
requestAnimationFrame(function pipTick() {
  if (pipTrack && pipVideo && pipTrack.readyState === 'live') {
    if (document.pictureInPictureElement === pipVideo || ++pipTickN % 30 === 0) { try { pipTrack.requestFrame(); } catch (e) {} }
  }
  requestAnimationFrame(pipTick);
});
function pipSource() {
  if (pipVideo) return pipVideo;
  pipVideo = document.createElement('video');
  pipVideo.id = 'pipv'; pipVideo.muted = true; pipVideo.playsInline = true; pipVideo.autoPictureInPicture = true;
  pipVideo.srcObject = pipStream(document.getElementById('canvas'));
  pipSelfAt = performance.now();
  pipVideo.addEventListener('leavepictureinpicture', () => { if (document.visibilityState === 'hidden') bgTick(true); });
  // the window's own controls (Firefox draws volume, mute and play / pause; the video has no sound of its own): the
  // page's volume slider and pause follow them, and they follow the page (pipFollow)
  pipVideo.addEventListener('volumechange', () => {
    const vol = document.getElementById('vol'), want = pipVideo.muted ? 0 : Math.round(pipVideo.volume * 100);
    if (pipUser() && want !== +vol.value) { vol.value = want; vol.oninput(); }
  });
  for (const ev of ['play', 'pause']) pipVideo.addEventListener(ev, () => {
    if (pipUser() && session && ui.paused !== pipVideo.paused) setPaused(pipVideo.paused);
  });
  document.body.append(pipVideo);
  return pipVideo;
}
// an event from the video is the viewer's when it comes from the window's controls: in the window (Firefox has no API to
// tell: any), and not the echo of a change the page just made
let pipSelfAt = -1e9;
const pipUser = () => (document.pictureInPictureElement === pipVideo || !document.pictureInPictureEnabled)
                      && performance.now() - pipSelfAt > 250;
function pipFollow() {
  const v = pipVideo;
  if (!v || (document.pictureInPictureElement !== v && document.pictureInPictureEnabled)) return;
  pipSelfAt = performance.now();
  const n = +document.getElementById('vol').value;
  v.volume = n / 100;
  v.muted = n === 0;
  if (ui.paused !== v.paused) { if (ui.paused) v.pause(); else v.play().catch(() => {}); }
}
async function togglePip() {
  if (!document.pictureInPictureEnabled) return;
  try {
    if (document.pictureInPictureElement) return await document.exitPictureInPicture();
    // (asked straight from the tap: after an await of play() the browser no longer counts it as the user's and ignores it)
    const v = pipSource();
    if (v.paused) v.play().catch(() => {});
    await v.requestPictureInPicture();
    pipFollow();
  } catch (e) { status(`picture in picture: ${e.message}`); }
}
if (document.pictureInPictureEnabled) {
  document.getElementById('pip').hidden = false;
  // (Chrome: the page asks to pop out when it is left while playing)
  try { navigator.mediaSession.setActionHandler('enterpictureinpicture', () => togglePip()); } catch (e) {}
  // (Chrome's window: play / pause buttons)
  try { navigator.mediaSession.setActionHandler('play', () => setPaused(false)); navigator.mediaSession.setActionHandler('pause', () => setPaused(true)); } catch (e) {}
  // (the stream plays from the start, silent, so a tap or an automatic pop-out finds it ready)
  pipSource().play().catch(() => addEventListener('pointerdown', () => pipSource().play().catch(() => {}), { once: true }));
}
document.addEventListener('visibilitychange', () => {
  bgTick(document.visibilityState === 'hidden');
  if (document.visibilityState !== 'visible') return;
  // (a browser that never sends webglcontextrestored: the session is started again once the page is back)
  setTimeout(glRecover, 1000);
  if (actx && actx.state !== 'running' && actx.state !== 'closed') actx.resume().catch(() => {});
});
// Boot snapshot: the used memory right after viewer_boot (pages packed like keyframes). The next match of a playlist
// restores it into the same instance (one wasm instance, one GL context and one copy of the shared files for the whole
// playlist; a new instance per match ran a phone out of memory). Memory above the boot heap is zeroed as in a fresh
// instance (the allocator takes fresh sbrk memory as zero); the restore's new GL generation deletes the last match's
// textures.
function bootSnapshot(M) {
  kzM = M;
  const top = M._viewer_mem_top(), W = PAGE >> 2, H = new Int32Array(M.HEAPU8.buffer), n = Math.ceil(top / PAGE);
  const pages = new Array(n);
  let bytes = 0;
  for (let i = 0; i < n; i++) { pages[i] = packPage(H, i * W, W); bytes += pages[i].bytes; }
  return { top: n * PAGE, pages, bytes };
}
// The picture's comment renderer (overlay_gl.cpp) keeps its fonts, glyph / emoji caches, registered comments and switches
// in the wasm memory too: a restore (the boot snapshot of a live switch / reused session, a keyframe) put them back to the
// snapshot's (before the fonts were sent: nothing drawn until a reload, user 2026-11-01). The page sets it up again.
function ovRestored(s) {
  s.M.mbaaMemGen = (s.M.mbaaMemGen || 0) + 1;
  if (s.M._viewer_ov_restored) s.M._viewer_ov_restored();
  try { if (window.mbaaChat && window.mbaaChat.ovRestored) window.mbaaChat.ovRestored(); } catch (e) { console.warn('overlay restore:', e); }
}
function restoreBoot(s) {
  const M = s.M, snap = s.boot, W = PAGE >> 2;
  call(s, 'viewer_restore_begin');
  for (const st of M.FS.streams) if (st && st.fd > 2) { try { M.FS.close(st); } catch (e) {} }
  const top = M._viewer_mem_top(), H = new Int32Array(M.HEAPU8.buffer);
  snap.pages.forEach((q, i) => unpackPage(q, H, i * W, W));
  if (top > snap.top) M.HEAPU8.fill(0, snap.top, top);
  call(s, 'viewer_restore_end', ++s.gen);
  // (the host's banner state (names on/off, the names, the tuning) lives in the restored memory: it went back to the
  // snapshot's, from before the page set it (the boot, an early keyframe). Set it again: was "CHALLENGER" in place of
  // both names after a catch-up jump or a seek for the rest of the session, user 2026-11-01)
  s.bannerKey = null;
  ovRestored(s);
  M._viewer_tex_store_reset();  // the last match's sealed textures (the boot ones stay)
}
async function newSession(rep, name, want) {
  const prev = session;
  if (prev) { try { prev.M.ccall('viewer_stop', null, [], []); } catch (e) {} }
  window.dispatchEvent(new Event('mbaa-session-end'));
  if (prev && prev.boot && (!HASH && !CAPTURE ? Q.get('reuse') !== '0' : Q.get('reuse') === '1')) return reuseSession(prev, rep, name, want);
  // mbaa.wasm is built with mbaa.js: it takes mbaa.js's cache-busting version (tools/web/deploy_pages.sh)
  const wasmV = ((document.querySelector('script[src^="mbaa.js"]') || {}).src || '').split('?')[1];
  // mbaaStoreKeep: the texture store keeps the last match's textures for the next one (web/host/browser/d3d9_gl.cpp)
  const M = await MBAA({ print: t => console.log(t), printErr: t => console.warn(t), canvas: freshCanvas(), mbaaStoreKeep: !LOWMEM,
                         locateFile: p => (wasmV && p.endsWith('.wasm') ? `${p}?${wasmV}` : p) });
  const s = { M, name, rep, live: true, mute: false, gen: 0 };
  session = s;
  return fillSession(s, want, null);
}
function reuseSession(prev, rep, name, want) {
  const s = { M: prev.M, name, rep, live: true, mute: false, gen: prev.gen, boot: prev.boot, reused: (prev.reused || 0) + 1 };
  session = s;
  restoreBoot(s);
  return fillSession(s, want, new Set([...prev.want].filter(p => !(prev.freed && prev.freed.has(p)))));
}
// MEMFS /game: this match's files. A reused instance keeps the files both matches use and drops the ones only the last
// match used (a stage's file goes back to its boot placeholder)
function fillSession(s, want, had) {
  const M = s.M, rep = s.rep, FS = M.FS;
  s.want = want || new Set(cache.keys());
  const probe = new Set((man.plan && man.plan.probe) || []);
  if (had) {
    for (const p of had) if (!s.want.has(p)) {
      try { if (probe.has(p)) FS.writeFile('/game/' + p, new Uint8Array(1)); else FS.unlink('/game/' + p); } catch (e) {}
    }
    for (const p of s.want) if (!had.has(p)) { const d = cache.get(p); if (d) fsPut(FS, '/game/' + p, d); }
    FS.writeFile('/game/replay.rep', rep);
    M.mbaaAssetMiss = p => { if (man.files[p] && p !== MOVIE && !(s.want.has(p) && cache.has(p))) misses.add(p); };  // (the movie: movieLoad)
    trackOpens(s);
    audioHooks(M, s);
    if (!HASH && !bgmStreamReady) for (const p of s.want) if (/^bgm\/.*\.opus$/.test(p) && cache.has(p)) bgmDecode(p);
    return s;
  }
  FS.mkdir('/game');
  // files the game only checks exist (plan.probe: every stage .dat at boot) get a 1-byte placeholder; the real file
  // (the replay's stage, fetched by the plan) is written over it
  for (const p of (man.plan && man.plan.probe) || []) { mkdirs(FS, '/game/' + p); FS.writeFile('/game/' + p, new Uint8Array(1)); }
  // only this match's files (a playlist's cache also holds the next match's)
  for (const p of s.want) { const d = cache.get(p); if (d) fsPut(FS, '/game/' + p, d); }
  FS.writeFile('/game/replay.rep', rep);
  M.mbaaAssetMiss = p => { if (man.files[p] && p !== MOVIE && !(s.want.has(p) && cache.has(p))) misses.add(p); };  // (the movie: movieLoad)
  if (movieBytes) M.mbaaMovie = movieBytes;
  if (movieH264) M.mbaaMovieVideo = movieVideo(movieH264);
  trackOpens(s);
  audioHooks(M, s);
  if (!HASH && !bgmStreamReady) for (const p of s.want) if (/^bgm\/.*\.opus$/.test(p) && cache.has(p)) bgmDecode(p);
  return s;
}
const call = (s, f, ...a) => s.M.ccall(f, 'number', a.map(() => 'number'), a);

// play from the start; with catchUp = k, step to frame k first (no pacing) and continue from there
async function play(rep, name, catchUp = 0, want = null) {
  { const b = document.getElementById('ffbadge'); if (b) b.hidden = true; } catchUpShow(null);  // (a new session: its own state)
  misses.clear();
  const s = await newSession(rep, name, want);
  try { call(s, 'viewer_rate', 1); } catch (e) {}  // (a reused module keeps the last session's live pacing rate)
  // stage animations on, except for native comparisons (?stageAnim=0, hash runs): the oracle's settings have them off
  call(s, 'viewer_stage_anim', Q.get('stageAnim') !== null ? +(Q.get('stageAnim') !== '0') : HASH ? 0 : 1);
  if (Q.get('seal') === '0') call(s, 'viewer_seal_off', 1);
  if (!call(s, 'viewer_boot')) { window.__mbaaStarted = -1; loading(false); status('start failed (see console)'); return; }
  // boot textures to the GPU store first: the snapshot (and every keyframe) then holds no pixels
  if (!s.reused) s.M._viewer_seal_boot();
  if (!s.boot && (!HASH && !CAPTURE || Q.get('reuse') === '1') && !s.M._viewer_files_open()) {
    s.boot = bootSnapshot(s.M);
    s.M.mbaaBootOpened = new Set(s.opened);  // read before the snapshot: a reused instance's later matches never open them
  }
  if (!call(s, 'viewer_load')) { window.__mbaaStarted = -1; loading(false); status('start failed (see console)'); return; }
  // a live clip's replay: the live session's forcing (clipLtFor), before the first frame
  s.lt = clipLt && clipLt.name === name && !liveSrc ? clipLt.bytes : null;
  if (s.lt && !s.M.ccall('viewer_lt_set', 'number', ['array', 'number'], [s.lt, s.lt.length])) { console.warn('clip: live forcing unreadable'); s.lt = null; }
  if (!s.lt) s.M.ccall('viewer_lt_clear', null, [], []);
  else console.log(`clip: replay played with its live forcing (${s.lt.length} bytes)`);
  if (HASH) s.M.ccall('viewer_hash_enable', null, [], []);
  call(s, 'viewer_play', 0);
  if (liveSrc && Q.get('live')) liveBegin(s);
  call(s, 'viewer_hud', ui.hud ? 1 : 0);
  window.__mbaa = { Module: s.M, man };
  if (!HASH || CAPTURE) timelineInit(s);
  // the pre-scan is a second copy of the game (~400 MB with its files): not in low-memory mode, where marks come as playback reaches them
  if (!HASH && !CAPTURE && !PERF && !catchUp && !s.liveSrc && !(LOWMEM && Q.get('scan') !== '1')) startScan(s);
  window.__mbaaStarted = 1;
  if (CAPTURE) { status(`loaded ${name} (capture mode)`); return; }
  if (HASH) return hashRun(s);
  for (let f = 0; f < catchUp && s === session;) {
    f = call(s, 'viewer_step', Math.min(240, catchUp - f));
    status(`catching up: frame ${f} of ${catchUp}`);
    catchUpShow(catchUp - f, catchUp);
    await new Promise(r => setTimeout(r, 0));
    if (misses.size) { catchUpShow(null); return refetchAndReplay(s, f); }
  }
  catchUpShow(null);
  if (PERF) call(s, 'viewer_perf', 1);
  uiApply(s);
  const tq = +(Q.get('t') || 0);
  if (tq > 0 && !catchUp && !PERF && s.tl && window.__mbaaRepUrl) { await requestSeek(tq); }
  else if ((ui.skipIntro || pl.items.length > 1) && !catchUp && !PERF && s.tl) await skipIntro(s);  // a playlist starts each match at round 1
  const eq = +(Q.get('e') || 0);
  if (eq > tq && tq > 0 && !catchUp && window.__mbaaRepUrl && pl.i <= 0) {
    s.clip = { a: tq, b: eq, stop: true }; marksKey = '';
    if (Q.get('loop') === '1' && !loopOn) toggleLoop();
  }
  if (s !== session) return;
  call(s, 'viewer_run');
  xfRuns++;
  loading(false);
  if (!HASH) movieLoad();
  status(`playing ${name}`);
  watch(s);
}
// a planned file was missing: fetch what the game asked for and replay to where this session was
async function refetchAndReplay(s, frame) {
  call(s, 'viewer_stop');
  const want = withSiblings(man, new Set([...misses, ...(s.freed || [])]));  // every freed file: the replay reads them all
  console.warn(`asset plan missed ${want.size} files at frame ${frame}:`, [...want]);
  window.mbaaPlanMisses = (window.mbaaPlanMisses || []).concat([...want]);
  await fetchAll(man, want, 'fetching missed files');
  return play(s.rep, s.name, frame, new Set([...s.want, ...want]));
}
function watch(s) {
  s.watching = true;
  const t = setInterval(() => {
    if (s !== session) return clearInterval(t);
    if (misses.size && s.liveSrc) { liveMissed(s); }
    else if (misses.size) { clearInterval(t); refetchAndReplay(s, call(s, 'viewer_frame')); return; }
    if (LOWMEM && FREE_FILES && s.freedAt < 0 && s.tl && s.tl.marks.some(m => m[0] > (s.freeArm ?? -1)) && !s.seeking && !call(s, 'viewer_files_open')) freeLoaded(s);
    // a playlist skips the win screen (scene 5: the winner's quote, which runs to the replay's end): the next match
    // starts as the battle ends
    const winScreen = pl.i >= 0 && pl.i + 1 < pl.items.length && !s.seeking && s.M.HEAP32[0x54EEE8 >> 2] === SCENE_WIN;
    if ((call(s, 'viewer_ended') || winScreen) && !s.endShown) {
      s.endShown = true;
      status(`finished ${s.name} (${call(s, 'viewer_frame')} frames)`);
      if (pl.i >= 0 && pl.i + 1 < pl.items.length && !ui.paused) {  // playlist: the next match a moment later
        status(`finished ${s.name}: next up ${pl.items[pl.i + 1].name}`);
        setTimeout(() => { if (s === session && !ui.paused) startItem(pl.i + 1); }, winScreen ? 0 : 1200);
      }
    }
  }, 100);
}
async function hashRun(s) {
  const cap = +(Q.get('frames') || 0);
  const h = window.__mbaaHash = { state: [], audio: [], frames: 0, done: false, ms: 0 };
  const t0 = performance.now();
  while (!call(s, 'viewer_ended') && (!cap || h.frames < cap)) {
    h.frames = call(s, 'viewer_step', cap ? Math.min(120, cap - h.frames) : 120);
    h.state.push(s.M.ccall('viewer_hash_take', 'string', [], []));
    h.audio.push(s.M.ccall('viewer_audio_take', 'string', [], []));
    if (misses.size) {  // the hash run restarts from scratch with the file present
      const extra = withSiblings(man, misses);
      await fetchAll(man, extra, 'fetching missed files');
      window.mbaaPlanMisses = (window.mbaaPlanMisses || []).concat([...misses]);
      return play(s.rep, s.name, 0, new Set([...s.want, ...extra]));
    }
    status(`state hash ${h.frames} frames`);
    await new Promise(r => setTimeout(r, 0));
  }
  h.ms = performance.now() - t0;
  h.done = true;
  const link = (text, file) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
    a.download = file; a.textContent = file; a.style.marginLeft = '8px';
    document.getElementById('status').after(a);
  };
  const tag = s.name.replace(/\.rep$/i, '').replace(/^.*\//, '');
  link(h.state.join(''), `${tag}_state.csv`);
  link(h.audio.join(''), `${tag}_audio.csv`);
  status(`state hash done: ${h.frames} frames in ${(h.ms / 1000).toFixed(1)} s`);
}
// ---- timeline: keyframes, seek, frame step ----
const ui = { paused: false, speed: 1, boxes: false, inputs: false, skipIntro: false, hud: true, music: true };
try { ui.hud = localStorage.getItem('mbaaHud') !== '0'; ui.music = localStorage.getItem('mbaaMusic') !== '0'; } catch (e) {}
try { ui.skipIntro = localStorage.getItem('mbaaSkipIntro') === '1'; } catch (e) {}
try { ui.names = localStorage.getItem('mbaaNames') !== '0'; } catch (e) { ui.names = true; }
const tlMax = t => t.end !== null ? t.end : Math.max(t.simMax, t.est, 1);
function uiApply(s) {
  call(s, 'viewer_pause', ui.paused || s.seeking ? 1 : 0);
  call(s, 'viewer_speed', ui.speed);
  call(s, 'viewer_boxes_enable', ui.boxes ? 1 : 0);
  call(s, 'viewer_hud', ui.hud ? 1 : 0);
}
function timelineInit(s) {
  const M = s.M;
  kzM = M;
  const t = s.tl = { kfs: [], simMax: 0, end: null, marks: [], fights: [], intro: -1, bytes: 0, lastKf: -1, seekMs: [],
                     want: null, running: false, round: -1, scene: -1, est: repEstimate(s.rep), M };
  M.mbaaTexKfRef = new Map();  // (a reused instance: the last match's keyframes are gone with its timeline)
  M.mbaaFrame = f => {
    if (f > t.simMax) {
      t.simMax = f;
      const scene = M.HEAP32[0x54EEE8 >> 2], round = M.HEAP32[0x77BFA4 >> 2];
      if (scene === 1 && (t.scene !== 1 || round !== t.round) && !t.marks.some(m => m[0] === f)) {
        t.marks.push([f, round]); t.marks.sort((a, b) => a[0] - b[0]);
      }
      t.scene = scene; t.round = round;
      // each round's fight start (the intro state 0x55D20B reaching 0 in battle): live clip links anchor on it, as the
      // pre-fight parts (character intros, round calls skipped by the players) run other lengths live and in a replay
      const intro = M.HEAPU8[0x55D20B];
      if (scene === 1 && intro === 0 && t.intro !== 0) t.fights.push(f);
      t.intro = scene === 1 ? intro : -1;
      if (t.end === null && M._viewer_ended()) t.end = f;
    }
    if (s.liveSrc) { liveCssWatch(s); liveRematchHold(s); liveBanner(s); liveStreak(s); slogWatch(s); }
    else if (TUNE) liveBanner(s);
    if (!s.seeking) incTick(s, f);
    else if (f >= t.lastKf + KF_EVERY && f >= t.simMax && !M._viewer_files_open() && !(LOWMEM && !t.marks.length)) keyframe(s, f);  // phones: none in the intro (incTick)
  };
  if (!M._viewer_files_open()) keyframe(s, M._viewer_frame());
}
// Background pre-scan (web/shell/scan_worker.js): a headless copy of the game plays the replay ahead in a worker and
// reports the round starts and the exact end (same rules as above), so the timeline has them before playback does.
function startScan(s) {
  if (typeof Worker === 'undefined') return;
  const v = ((document.querySelector('script[src^="mbaa.js"]') || {}).src || '').split('?')[1] || '';
  const w = new Worker('scan_worker.js' + (v ? `?${v}` : ''));
  s.scan = w;
  window.addEventListener('mbaa-session-end', () => w.terminate(), { once: true });
  w.onmessage = e => {
    const m = e.data, t = s.tl;
    if (m.error) { console.warn('pre-scan:', m.error); w.terminate(); return; }
    t.scanFrame = m.frame;
    for (const mk of m.marks) if (!t.marks.some(x => x[0] === mk[0])) t.marks.push(mk);
    t.marks.sort((a, b) => a[0] - b[0]);
    if (m.done) {
      if (m.end !== null && t.end === null) t.end = m.end;
      t.scanMs = m.ms;
      w.terminate();
    }
  };
  w.onerror = e => { console.warn('pre-scan failed:', e.message); w.terminate(); };
  w.postMessage({ files: [...s.want].filter(p => cache.has(p)).map(p => [p, cache.get(p)]), probe: (man.plan && man.plan.probe) || [], rep: s.rep, v, lt: s.lt || null });
}
// jump to the previous / next round start (dir -1 / +1)
function jumpRound(dir) {
  const s = session;
  if (!s || !s.tl || !s.tl.marks.length) return;
  const f = curFrame(), ms = s.tl.marks.map(m => m[0]);
  const target = dir > 0 ? ms.find(x => x > f + 1) : [...ms].reverse().find(x => x < f - 30);
  if (target !== undefined) requestSeek(target);
  else if (dir < 0) requestSeek(ms[0]);
}
const pageRef = (t, p, d) => {
  if (!p) return;
  p.n = (p.n || 0) + d;
  if (p.n <= 0) t.bytes -= p.bytes;
};
// A stored page: zero words packed out (most changed pages are mostly zero): m = bitmask of the nonzero words, v = those
// words in order; a page with few zeros is kept raw (r).
// Pages with content are stored zlib-compressed (z) when the module that made them can (viewer_kz_*: ~4x on game
// memory; zlib works in a scratch area keyframes exclude); kzM is the current instance. A zero page stays {m, v: []} (the keyframe code treats those as free heap).
let kzM = null;
function kzPack(H, o) {
  const M = kzM;
  if (!M || !M._viewer_kz_pack || PAGE !== 16384) return null;
  const B = M._viewer_kz_base(), U = M.HEAPU8;
  if (H.buffer === U.buffer && o * 4 + 16384 > B && o * 4 < B + M._viewer_kz_size()) return null;  // the scratch's own pages (the boot snapshot covers them)
  // always through the scratch: a page of the wasm C stack would change under zlib's own frames while it runs
  new Int32Array(U.buffer, B, 4096).set(H.subarray(o, o + 4096));
  const n = M._viewer_kz_pack(B);
  if (!n) return null;
  return M.HEAPU8.slice(B + 20480, B + 20480 + n);
}
function kzUnpack(z, H, o) {
  const M = kzM, U = M.HEAPU8, B = M._viewer_kz_base();
  U.set(z, B + 20480);
  // inflated into the scratch, then copied: inflating straight into a page of the wasm C stack overwrote zlib's own
  // live frame (the restore hung), and page 0 is a null output pointer to zlib
  const ok = M._viewer_kz_unpack(B, z.length) && (H.buffer === U.buffer ? U.copyWithin(o * 4, B, B + 16384) : H.set(new Int32Array(U.buffer, B, 4096), o), 1);
  if (!ok) throw new Error(`kz: page at ${o * 4} (${z.length} bytes) did not decompress`);
}
function packPage(H, o, W) {
  let nz = 0;
  for (let j = 0; j < W; j++) if (H[o + j] !== 0) nz++;
  if (nz > 0 && KZ) {
    const z = kzPack(H, o);
    if (z && z.length < Math.min(W * 4, (W >> 5) * 4 + nz * 4)) return { z, bytes: z.length };
  }
  if (nz > W * 0.7) return { r: H.slice(o, o + W), bytes: W * 4 };
  const m = new Int32Array(W >> 5), v = new Int32Array(nz);
  for (let j = 0, k = 0; j < W; j++) { const x = H[o + j]; if (x !== 0) { m[j >> 5] |= 1 << (j & 31); v[k++] = x; } }
  return { m, v, bytes: (m.length + nz) * 4 };
}
// pack pages copied raw into one buffer per batch: per page the mask then the nonzero words (m, v are views)
function packBatch(t, list) {
  const W = PAGE >> 2, M32 = W >> 5;
  const packed = list.map(q => packPage(q.r, 0, W));
  let words = 0;
  for (const pk of packed) if (!pk.r && !pk.z) words += M32 + pk.v.length;
  const buf = new Int32Array(words);
  let o = 0;
  list.forEach((q, k) => {
    const pk = packed[k];
    if (pk.r) { q.r = q.r.slice(); return; }  // kept raw: its own copy (the commit buffer can go)
    if (pk.z) { q.z = pk.z; t.bytes += pk.bytes - q.bytes; q.bytes = pk.bytes; delete q.r; return; }
    buf.set(pk.m, o); q.m = buf.subarray(o, o + M32); o += M32;
    buf.set(pk.v, o); q.v = buf.subarray(o, o + pk.v.length); o += pk.v.length;
    t.bytes += pk.bytes - q.bytes; q.bytes = pk.bytes; delete q.r;
  });
}
function unpackPage(q, H, o, W) {
  if (q.r) { H.set(q.r, o); return; }
  if (q.z) { kzUnpack(q.z, H, o); return; }
  const m = q.m, v = q.v;
  let k = 0;
  for (let w = 0; w < m.length; w++) {
    const bits = m[w], a = o + (w << 5);
    if (bits === 0) { H.fill(0, a, a + 32); continue; }
    for (let j = 0; j < 32; j++) H[a + j] = (bits >>> j) & 1 ? v[k++] : 0;
  }
}
// 128-bit hash of every page below top (wasm viewer_page_hashes: one pass at memory speed), 4 int32 per page
function pageHashes(M, top) {
  const n = Math.ceil(top / PAGE), p = M._viewer_page_hashes(top, PAGE);
  return new Int32Array(M.HEAPU8.buffer, p, n * 4);
}
// The GPU texture store keeps an entry while a live texture or a kept keyframe names it (web/host/browser/d3d9_gl.cpp
// js_store_gc): each keyframe records the store keys sealed when it is taken (kf.tex: k0, k1, fmt triples) and counts
// them per key while it is kept (M.mbaaTexKfRef); after a keyframe is added or dropped the entries neither names go.
// Without it a long session (a live set) kept every texture it ever sealed (the GPU store grew for good).
function kfTexAdd(t, kf) {
  const M = t.M;
  if (!M || !M._viewer_tex_mark) return;
  M._viewer_tex_mark();
  kf.tex = Int32Array.from(M.mbaaTexMark || []);  // (as the store keys spell them: EM_JS passes the u32 words as i32)
  M.mbaaTexMark = null;
  const ref = M.mbaaTexKfRef || (M.mbaaTexKfRef = new Map());
  for (let i = 0; i + 2 < kf.tex.length; i += 3) { const k = kf.tex[i] + ':' + kf.tex[i + 1] + ':' + kf.tex[i + 2]; ref.set(k, (ref.get(k) || 0) + 1); }
}
function kfTexDrop(t, kf) {
  const ref = t.M && t.M.mbaaTexKfRef;
  if (!ref || !kf.tex) return;
  for (let i = 0; i + 2 < kf.tex.length; i += 3) {
    const k = kf.tex[i] + ':' + kf.tex[i + 1] + ':' + kf.tex[i + 2], n = (ref.get(k) || 0) - 1;
    if (n > 0) ref.set(k, n); else ref.delete(k);
  }
  kf.tex = null;
}
// Bytes of the store entries the kept keyframes name (GPU textures and SYSTEMMEM data; perm and stale entries are kept
// anyway, so not counted). A live set's keyframes span many games, each pinning that game's composed frames and images:
// without a bound on these, thinning by page bytes alone kept a game's textures for every game it had a keyframe in.
function kfTexBytes(t) {
  const M = t.M, ref = M && M.mbaaTexKfRef, S = M && M.mbaaTexStore;
  let n = 0;
  if (ref && S) for (const k of ref.keys()) { const e = S.get(k); if (e && !e.perm && !e.stale) n += e.bytes || 0; }
  return n;
}
function storeGc(t) {
  if (STORE_GC && t.M && t.M._viewer_tex_store_gc && session && session.tl === t) t.storeGcN = (t.storeGcN || 0) + t.M._viewer_tex_store_gc();
}
// Keyframe: every page of the used memory [0, sbrk). A page whose hash equals the previous keyframe's is shared with
// it, so a keyframe stores only its changed pages (packed, packPage; h = the page's hash). The hash output array is
// scratch (null pages: never stored, never restored).
function keyframe(s, f) {
  const t = s.tl, M = s.M, t0 = performance.now();
  const top = M._viewer_mem_top(), n = Math.ceil(top / PAGE), W = PAGE >> 2;
  const hs = pageHashes(M, top), H = new Int32Array(M.HEAPU8.buffer);
  let at = t.kfs.length;  // sorted by frame; pages are shared with the nearest earlier keyframe
  while (at > 0 && t.kfs[at - 1].frame > f) at--;
  if (at > 0 && t.kfs[at - 1].frame === f) return;
  const prev = at > 0 ? t.kfs[at - 1].pages : [];
  const x0 = Math.floor(M._viewer_page_hash_area(0) / PAGE), x1 = Math.ceil(M._viewer_page_hash_area(1) / PAGE);
  const pages = new Array(n);
  let fresh = 0;
  for (let i = 0; i < n; i++) {
    if (i >= x0 && i < x1) { pages[i] = null; continue; }
    const q = prev[i], j = i * 4;
    if (q && q.h[0] === hs[j] && q.h[1] === hs[j + 1] && q.h[2] === hs[j + 2] && q.h[3] === hs[j + 3]) pages[i] = q;
    else { pages[i] = packPage(H, i * W, W); pages[i].h = [hs[j], hs[j + 1], hs[j + 2], hs[j + 3]]; t.bytes += pages[i].bytes; fresh++; }
    pageRef(t, pages[i], +1);
  }
  const kf = { frame: f, pages, ms: performance.now() - t0, fresh };
  kfTexAdd(t, kf);
  t.kfs.splice(at, 0, kf);
  t.lastKf = t.kfs[t.kfs.length - 1].frame;
  thin(t);
  storeGc(t);
}
// over the memory budget (keyframe pages, or the store textures they pin): drop every second keyframe (never the first, the newest or a pending one)
function thin(t) {
  if ((t.bytes > KF_BUDGET || (STORE_GC && kfTexBytes(t) > KF_TEX_BUDGET)) && t.kfs.length > 4) {
    const keep = t.kfs.filter((k, i) => i === 0 || i === t.kfs.length - 1 || i % 2 === 0 || k.pending);
    for (const k of t.kfs) if (!keep.includes(k)) { for (const p of k.pages) pageRef(t, p, -1); kfTexDrop(t, k); }
    t.kfs = keep;
    t.thinned = (t.thinned || 0) + 1;
  }
}
// Put a keyframe's memory back: only the pages whose hash differs from the keyframe's are copied.
// Incremental keyframe (playback): a whole-memory hash pass at one frame would stall it for tens of ms, so the work
// is spread over the KF_PHASE frames before and after the keyframe frame F, a slice per simulated frame:
//   pre  (F - KF_PHASE .. F): hash the cold pages (unchanged in the recent keyframes) in slices; one that changed
//        since the base keyframe becomes hot.
//   F    hash the hot pages, the pages above the base's top and the ones the pre pass found changed: those are the
//        pages that may differ from the base; changed ones are copied, the cold ones are taken from the base.
//   post (F .. F + KF_PHASE): hash the cold pages again; if one differs from the base, it may have changed before F,
//        so the keyframe is dropped (and the page becomes hot). Until the post pass ends the keyframe is pending (seeks
//        do not use it).
// A cold page counted as unchanged at F was unchanged at its pre hash and at its post hash, at most 2 x KF_PHASE frames
// apart; and a page once seen changing stays hot. At F the changed pages are copied raw and packed during the post
// pass. Seeks (no frames shown) keyframe in one pass.
const KF_PHASE = 60;
// (the timeline's diagnostics: per frame and per keyframe all a live session long, so the newest STAT_MAX of each)
const STAT_MAX = 2000;
function statPush(a, v) { a.push(v); if (a.length > STAT_MAX + 200) a.splice(0, a.length - STAT_MAX); }
// keyframe packing's time per display frame: PACK_MS from the first pack call of a window (a window = PACK_WIN ms, about
// one refresh); at least one batch per window, so it always finishes
const PACK_MS = 3, PACK_WIN = 12;
let packWin = -1e9, packCalls = 0;
function packTime() {
  const now = performance.now();
  if (now - packWin > PACK_WIN) { packWin = now; packCalls = 0; }
  return packCalls++ === 0 || now - packWin < PACK_MS;
}
function hashRuns(M, idx) {  // hash the listed pages (sorted), one wasm call per run of consecutive pages
  let p = 0;
  for (let i = 0; i < idx.length;) {
    let j = i + 1;
    while (j < idx.length && idx[j] === idx[j - 1] + 1) j++;
    p = M._viewer_page_hashes_range(idx[i], j - i, PAGE);
    i = j;
  }
  return p;
}
const sameHash = (hs, i, q) => q && q.h[0] === hs[4 * i] && q.h[1] === hs[4 * i + 1] && q.h[2] === hs[4 * i + 2] && q.h[3] === hs[4 * i + 3];
function hashView(M, n) { return new Int32Array(M.HEAPU8.buffer, M._viewer_page_hash_area(0), n * 4); }
// The commit copies, in one tick, every page changed since the base keyframe: ~250 pages in play, but after a radio
// stage swap ~3000 (50 MB: 35-50 ms desktop, 200+ ms on a phone, user 2026-11-02 "the stage change still hiccups"). The
// pre pass copies changed pages ahead, a slice a tick (preCopy: a cold page found changed; preCopyHot: the hot pages,
// ~1.5 ms a tick), each with its hash at the copy; the commit takes a copy whose page hashes the same then, so only
// pages changed again since are copied in the commit's tick. (The keyframe is the same: equal hash, equal page.)
function preCopy(M, c, i, hs) {
  const W = PAGE >> 2, H = new Int32Array(M.HEAPU8.buffer);
  (c.pre || (c.pre = new Map())).set(i, { r: H.slice(i * W, i * W + W), h: [hs[4 * i], hs[4 * i + 1], hs[4 * i + 2], hs[4 * i + 3]] });
}
function preCopyHot(M, c) {
  if (!c.hot) {
    const n = Math.ceil(M._viewer_mem_top() / PAGE), cold = new Uint8Array(n);
    const x0 = Math.floor(M._viewer_page_hash_area(0) / PAGE), x1 = Math.ceil(M._viewer_page_hash_area(1) / PAGE);
    for (const i of c.cold) if (i < n) cold[i] = 1;
    c.hot = []; c.hcur = 0;
    for (let i = 0; i < n; i++) if (!cold[i] && !(i >= x0 && i < x1)) c.hot.push(i);
  }
  const t0 = performance.now();
  while (c.hcur < c.hot.length && performance.now() - t0 < 1.5) {
    const part = c.hot.slice(c.hcur, c.hcur + 64);
    c.hcur += part.length;
    hashRuns(M, part);
    const hs = hashView(M, part[part.length - 1] + 1);
    for (const i of part) if (!sameHash(hs, i, c.base.pages[i]) && !(c.pre && c.pre.has(i))) preCopy(M, c, i, hs);
  }
}
function incTick(s, f) {
  const t = s.tl, M = s.M;
  let c = t.inc;
  if (!c) {
    const base = t.kfs[t.kfs.length - 1];
    if (!base || base.pending || f < base.frame + KF_EVERY - KF_PHASE || f < t.simMax) return;
    // phones: none before round 1. The intro's frames hold the match's files as the game reads them (a keyframe there
    // kept ~95 MB of them); a seek into the intro simulates from frame 0
    if (LOWMEM && !t.marks.length) return;
    const hot = t.hotAt || (t.hotAt = new Map());
    const cold = [];
    for (let i = 0; i < base.pages.length; i++) {
      const q = base.pages[i];
      if (q && !hot.has(i) && !(q.v && q.v.length === 0)) cold.push(i);  // a zero page is free heap: hot
    }
    // (F at least a pre pass ahead: a commit dropped late, or one started past its frame, had no pre pass, so it hashed
    // and copied every changed page in one tick: after a radio stage swap, several 40-50 ms ticks in a row)
    c = t.inc = { F: Math.max(base.frame + KF_EVERY, f + KF_PHASE), base, cold, cur: 0, changed: [], kf: null, t0: 0, ms: 0 };
  }
  const t0 = performance.now(), phase = c.kf ? 'post' : f >= c.F ? 'commit' : 'pre';
  const slice = Math.ceil(c.cold.length / KF_PHASE);
  if (!c.kf) {  // pre pass
    const n = Math.min(c.cold.length, c.cur + (f >= c.F ? c.cold.length : slice));
    if (n > c.cur) {
      const part = c.cold.slice(c.cur, n);
      hashRuns(M, part);
      const hs = hashView(M, part[part.length - 1] + 1);
      for (const i of part) if (!sameHash(hs, i, c.base.pages[i])) { c.changed.push(i); if (f < c.F) preCopy(M, c, i, hs); }
      c.cur = n;
    }
    if (f < c.F) preCopyHot(M, c);
    if (f >= c.F && c.cur === c.cold.length && !M._viewer_files_open() && !t.kfs.some(k => k.frame === f)) incCommit(s, f, c);
  } else {  // post pass
    // packed against wall time, not a share per game frame: a catch-up tick runs several game frames, and a share each
    // (zlib on the VS screen's ~2 MB of changed pages: ~40 ms) made a slow tick slower, so one stall fed the next
    while (c.raw.length && packTime()) packBatch(t, c.raw.splice(0, 8));
    const n = Math.min(c.tentative.length, c.cur + slice);
    const part = c.tentative.slice(c.cur, n);
    if (part.length) {
      hashRuns(M, part);
      const hs = hashView(M, part[part.length - 1] + 1);
      for (const i of part) if (!sameHash(hs, i, c.base.pages[i])) {
        c.bad = true; t.hotAt.set(i, t.kfs.length);
        const q = c.base.pages[i];
        statPush(t.incStat.dropPages, [i * PAGE, q.r ? 'raw' : q.z ? 'z' : q.v.length]);
      }
    }
    c.cur = n;
    if (c.bad || (n === c.tentative.length && !c.raw.length)) {
      if (c.bad) {  // a cold page changed around F: its content at F is unknown
        const at = t.kfs.indexOf(c.kf);
        if (at >= 0) { t.kfs.splice(at, 1); for (const p of c.kf.pages) pageRef(t, p, -1); kfTexDrop(t, c.kf); }
        t.lastKf = t.kfs.length ? t.kfs[t.kfs.length - 1].frame : -1;
        t.incDropped = (t.incDropped || 0) + 1;
      } else { c.kf.pending = false; c.kf.ms = c.ms; thin(t); }
      t.inc = null;
      storeGc(t);
      // every raw page has been packed or copied out: a commit buffer grown by a big commit (the one after the match
      // loads copies ~60 MB) is not kept for the rest of the match
      if (t.commitBuf && t.commitBuf.length > (4 << 20)) t.commitBuf = null;
    }
  }
  const dt = performance.now() - t0;
  c.ms = Math.max(c.ms, dt);
  const st = t.incStat || (t.incStat = { pre: [], commit: [], post: [], dropPages: [] });
  statPush(st[phase], Math.round(dt * 10) / 10);
}
function incCommit(s, f, c) {
  const t = s.tl, M = s.M, W = PAGE >> 2;
  const top = M._viewer_mem_top(), n = Math.ceil(top / PAGE);
  const x0 = Math.floor(M._viewer_page_hash_area(0) / PAGE), x1 = Math.ceil(M._viewer_page_hash_area(1) / PAGE);
  const isCold = new Uint8Array(n);
  for (const i of c.cold) if (i < n) isCold[i] = 1;
  for (const i of c.changed) { isCold[i] = 0; t.hotAt.set(i, t.kfs.length); }
  const now = [];
  for (let i = 0; i < n; i++) if (!isCold[i] && !(i >= x0 && i < x1)) now.push(i);
  const T0 = performance.now();
  hashRuns(M, now);
  const T1 = performance.now();
  const hs = hashView(M, n), H = new Int32Array(M.HEAPU8.buffer);
  const pages = new Array(n), tentative = [], changed = [];
  for (let i = 0; i < n; i++) {
    if (i >= x0 && i < x1) { pages[i] = null; continue; }
    const q = c.base.pages[i];
    if (isCold[i]) { pages[i] = q; tentative.push(i); }
    else if (sameHash(hs, i, q)) pages[i] = q;
    else { changed.push(i); if (q) t.hotAt.set(i, t.kfs.length); }
  }
  // the changed pages copied ahead in the pre pass and the same since (its hash now = at the copy): that copy; the
  // rest copied now into one buffer (one allocation, not one per page)
  const raw = [], late = [];
  for (const i of changed) {
    const p = c.pre && c.pre.get(i);
    if (p && sameHash(hs, i, p)) {
      if (KF_VERIFY) { const V = window.__kfVerify || (window.__kfVerify = { reused: 0, bad: 0, late: 0 }); V.reused++;
        for (let j = 0, o = i * W; j < W; j++) if (p.r[j] !== H[o + j]) { V.bad++; break; } }
      pages[i] = { r: p.r, bytes: PAGE, h: p.h }; raw.push(pages[i]);
    }
    else late.push(i);
  }
  c.pre = null;
  if (late.length && (!t.commitBuf || t.commitBuf.length < late.length * W)) t.commitBuf = new Int32Array(Math.ceil(late.length * 1.5) * W);
  const buf = t.commitBuf;  // reused: every raw page is packed or copied out during the post pass
  late.forEach((i, k) => {
    buf.set(H.subarray(i * W, i * W + W), k * W);
    pages[i] = { r: buf.subarray(k * W, k * W + W), bytes: PAGE, h: [hs[4 * i], hs[4 * i + 1], hs[4 * i + 2], hs[4 * i + 3]] };
    raw.push(pages[i]);
  });
  t.bytes += changed.length * PAGE;
  const fresh = changed.length;
  for (let i = 0; i < n; i++) pageRef(t, pages[i], +1);
  statPush(t.commitParts || (t.commitParts = []), [now.length, Math.round(T1 - T0), Math.round(performance.now() - T1), fresh]);
  c.kf = { frame: f, pages, ms: 0, fresh, pending: true, inc: true };
  kfTexAdd(t, c.kf);
  t.kfs.push(c.kf);
  t.lastKf = f;
  c.tentative = tentative; c.raw = raw; c.rawTotal = raw.length; c.cur = 0;
}
function restore(s, kf) {
  const M = s.M;
  call(s, 'viewer_restore_begin');
  // files the game has open now: their streams are closed (a keyframe is only taken with none open)
  for (const st of M.FS.streams) if (st && st.fd > 2) { try { M.FS.close(st); } catch (e) {} }
  const top = M._viewer_mem_top();
  const hs = pageHashes(M, Math.max(top, kf.pages.length * PAGE)), H = new Int32Array(M.HEAPU8.buffer), W = PAGE >> 2;
  let copied = 0;
  for (let i = 0; i < kf.pages.length; i++) {
    const q = kf.pages[i], j = i * 4;
    if (!q || (q.h[0] === hs[j] && q.h[1] === hs[j + 1] && q.h[2] === hs[j + 2] && q.h[3] === hs[j + 3])) continue;
    unpackPage(q, H, i * W, W);
    copied++;
  }
  // zlib's calls (kzUnpack) use the wasm C stack and its arena counter: the pages holding those were written again by
  // each later call. Those few are inflated once more into JS copies and written last, with no wasm call after them.
  if (kf.pages.some(q => q && q.z)) {
    const h1 = pageHashes(M, kf.pages.length * PAGE), late = [];
    for (let i = 0; i < kf.pages.length; i++) {
      const q = kf.pages[i], j = i * 4;
      if (!q || (q.h[0] === h1[j] && q.h[1] === h1[j + 1] && q.h[2] === h1[j + 2] && q.h[3] === h1[j + 3])) continue;
      const tmp = new Int32Array(W);
      unpackPage(q, tmp, 0, W);
      late.push([i, tmp]);
    }
    for (const [i, tmp] of late) H.set(tmp, i * W);
  }
  s.tl.lastCopied = copied;
  call(s, 'viewer_restore_end', ++s.gen);
  // (the host's own settings live in the restored memory too, back to the keyframe's: the banner (names) is set again
  // (liveBanner, by its key), the live pacing (1.05x trim / 2x catch-up) from 1x (the next poll sets what it wants).
  // Was: "CHALLENGER" in place of both names for the rest of a session after a catch-up jump, user 2026-11-01)
  s.bannerKey = null;
  ovRestored(s);
  if (s.liveSrc) { s.liveTrim = false; s.liveFF = false; call(s, 'viewer_rate', 1); call(s, 'viewer_speed', ui.speed); }
  if (s.liveSrc) {
    liveRefeed(s);  // (the stream received since the keyframe)
    s.M._viewer_resolve_reset();  // (the keyframe's path caches predate files added since: the next game's)
  }
  // the restored state-hash / audio row buffers hold the keyframe's leftovers
  if (HASH) { M.ccall('viewer_hash_take', 'string', [], []); M.ccall('viewer_audio_take', 'string', [], []); }
  radioStageSync(s);  // (the keyframe's Raito Radio stage state: the pick's sent again)
}
// Seek to frame T (the state after T steps; the picture is frame T's). Coalesced: while a seek runs only the latest
// request waits, the ones in between are dropped (dragging the slider, holding the step key).
function requestSeek(T) {
  const s = session;
  if (!s || !s.tl) return Promise.resolve();
  if (s.liveSrc && s.liveFollow) liveFollow(s, false);  // a seek on a live match: watching back
  s.tl.want = T;
  if (!s.tl.running) s.tl.running = runSeeks(s);
  return s.tl.running;
}
async function runSeeks(s) {
  const t = s.tl;
  try {
    while (t.want !== null && session === s) { const T = t.want; t.want = null; await seekTo(s, T); }
  } finally { t.running = false; }
}
async function seekTo(s, T) {
  const t = s.tl, M = s.M, t0 = performance.now();
  if (t.end !== null) T = Math.min(T, t.end);
  T = Math.max(1, Math.round(T));
  const cur = M._viewer_frame();
  // the nearest keyframe strictly before T (at least one step is drawn), unless the current state is nearer
  let kf = null;
  for (const k of t.kfs) if (k.frame < T) { if (!k.pending) kf = k; } else break;
  if (t.inc) {  // an incremental keyframe in progress: its passes assume the timeline goes on from here
    if (t.inc.kf) { const at = t.kfs.indexOf(t.inc.kf); if (at >= 0) { t.kfs.splice(at, 1); for (const p of t.inc.kf.pages) pageRef(t, p, -1); kfTexDrop(t, t.inc.kf); } }
    t.inc = null;
    t.lastKf = t.kfs.length ? t.kfs[t.kfs.length - 1].frame : -1;
  }
  s.seeking = true; s.mute = true;
  s.stopSes(); s.bgmHalt();
  uiApply(s);
  let restored = false;
  if (!(T > cur && (!kf || cur >= kf.frame))) { restore(s, kf || t.kfs[0]); restored = true; uiApply(s); }
  const t1 = performance.now(), f1 = M._viewer_frame();
  const DRAW = 2;  // the last frames are drawn (render-target feedback effects read the previous frame)
  let f = M._viewer_frame();
  call(s, 'viewer_suppress', 1);
  // refinement keyframe KF_NEAR frames before T (or the first frame after it with no game file open): stepping back
  // from T stays cheap
  let near = T - f > 3 * KF_NEAR ? T - KF_NEAR : -1;
  while (f < T - DRAW) {
    const g = call(s, 'viewer_step', Math.min(T - DRAW - f, 600, near > f ? near - f : 1e9));
    if (near >= 0 && g >= near) { if (M._viewer_files_open()) near = g + 1; else { keyframe(s, g); near = -1; } }
    if (g === f) break;  // the replay ended
    f = g;
    if (T - f > 1200) {
      status(`seeking ${f}/${T}`);
      await new Promise(r => setTimeout(r, 0));
      if (session !== s) return;
    }
  }
  call(s, 'viewer_suppress', 0);
  const t2 = performance.now();
  if (f < T) call(s, 'viewer_step', T - f);
  else call(s, 'viewer_represent');
  const t3 = performance.now();
  s.seeking = false; s.mute = ui.paused;
  uiApply(s);
  if (!ui.paused) s.bgmSync(M._viewer_frame());
  const r1 = x => Math.round(x * 10) / 10;
  statPush(t.seekMs, { from: cur, to: T, ms: r1(performance.now() - t0), restoreMs: restored ? r1(t1 - t0) : 0,
                  copied: restored ? t.lastCopied : 0, sim: T - f1,
                  simMs: r1(t2 - t1), drawMs: r1(t3 - t2) });
  overlayDirty = true;
  if (!s.endShown) status(ui.paused ? 'paused' : 'playing');
}
// Skip the VS intro: simulate (not drawn, silent) up to the first battle frame, then draw from there. The intro is
// still simulated (the match state depends on it); only its picture and sound are skipped.
const SCENE_VS = 8, SCENE_WIN = 5;  // the VS screen and the win screen (g_CurrentSceneId 0x54EEE8)
const inIntro = s => !!(s && s.tl && !s.tl.marks.length && !s.seeking && s.M.HEAP32[0x54EEE8 >> 2] === SCENE_VS);
async function skipIntro(s) {
  const t = s.tl, M = s.M;
  if (!t || t.marks.length || M._viewer_frame() > 2000) return;
  s.seeking = true; s.mute = true;
  s.stopSes(); s.bgmHalt();
  uiApply(s);
  call(s, 'viewer_suppress', 1);
  status('skipping intro');
  let n = 0;
  while (!t.marks.length && session === s && !call(s, 'viewer_ended') && !misses.size) {
    call(s, 'viewer_step', 1);
    if (++n % 240 === 0) await new Promise(r => setTimeout(r, 0));
  }
  call(s, 'viewer_suppress', 0);
  if (session !== s) return;
  if (!misses.size) call(s, 'viewer_step', 2);  // drawn: render-target feedback effects read the previous frame
  s.seeking = false; s.mute = ui.paused;
  uiApply(s);
  if (!ui.paused) s.bgmSync(M._viewer_frame());
  overlayDirty = true;
  status(ui.paused ? 'paused' : 'playing');
}
// Copy the current moment: a link that opens this replay at this frame when the replay came from a URL (?rep=),
// otherwise the replay name, time and frame as text.
const REPLAY_STORE = 'https://replays.meltyblood.org';

// ---- live CCCaster matches (?live=<id>): the bridge's feed (tools/web/cc_live.mjs) played by the game in spectate
// mode (web/host/spectate.cpp): a boot tape sets the match up, then the stream's index records arrive about once a
// second and the game plays them ~4 s behind the host (faster while it catches up after joining mid-game)
const LIVE = Q.get('liveUrl') || location.origin + location.pathname.replace(/\/[^/]*$/, '');  // (the feed is next to the page)
// the feed exists only on the spectate path (the Worker gives that page <base href="/">) or where ?liveUrl= names one: the
// public page has none to ask for
const LIVE_FEED = !!(Q.get('liveUrl') || document.querySelector('base'));
// the spectate page: named for what it shows from the first paint on (the replay page's heading until a match loads)
if (document.querySelector('base')) { document.getElementById('title').textContent = 'MBAACC live'; document.title = 'MBAACC Live'; }
const LIVE_BEHIND = 240;  // frames kept buffered (4 s)
const LIVE_WIN = 8;  // polls (~8 s) the catch-up decisions look back over (a round end's burst and pause: ~5 s)
let liveSrc = null;  // {id, info, since}
// the feed's state, shown over the picture (index.html #livenotice): the operator's notice (header X-Live-Notice on any
// feed answer: tools/web/bridge_restart.sh sets it before restarting the bridge and clears it once it is back), and failed
// requests (no answer, a timeout, a 5xx from the Worker: the bridge is down). A notice up at the last answer stays up
// while the feed is down (the restart itself); without one, two failures in a row show "unreachable". Meanwhile the polls
// back off (liveNet.delay), and a match missing from the list just after (the bridge re-joining its hosts) is waited for
const liveNet = { fails: 0, troubleAt: -1e9, notice: '' };
liveNet.delay = () => liveNet.fails ? Math.min(1000 * 2 ** (liveNet.fails - 1), 5000) : 1000;
liveNet.recent = () => performance.now() - liveNet.troubleAt < 60000;
function liveNoticeShow() {
  const e = document.getElementById('livenotice'), n = liveNet;
  if (!e) return;
  const t = n.notice || (n.fails >= 2 ? 'Live server unreachable \u2014 retrying\u2026' : '');
  if (e.textContent !== t) e.textContent = t;
  e.hidden = !t;
  e.classList.toggle('down', !n.notice);
}
async function liveFetch(url, opt) {
  const n = liveNet, fail = () => { n.fails++; n.troubleAt = performance.now(); liveNoticeShow(); };
  let r;
  try { r = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined, ...opt }); }
  catch (e) { fail(); throw e; }
  if (r.status >= 500) { fail(); return r; }
  let h = r.headers.get('X-Live-Notice') || '';
  try { h = decodeURIComponent(h); } catch (e) {}
  n.fails = 0; n.notice = h;
  if (h) n.troubleAt = performance.now();
  liveNoticeShow();
  return r;
}
// the live match last asked for (startLive): a retry, or a start still waiting on the network, of another one does
// nothing (was: a pending retry of the match the page had just left started it again: the page went back to it)
let liveWant = null;
function liveRetry(id, match) {  // startLive could not reach the feed: again, unless a replay or another match was opened meanwhile
  if (session && !session.liveSrc) return;
  setTimeout(() => { if ((!session || session.liveSrc) && liveWant === id) startLive(id, match); }, Math.max(2000, liveNet.delay()));
}
// An update reload (updateWatch) of a live page: where it was (the match, its game, how far short of the stream's newest
// frame) for the reloaded page, so it goes on from there: not that game again from its start (user 2026-11-01: a deploy's
// reload at the end of a set rejoined the host's listing and replayed the set's last game), and not another match the
// host started meanwhile (startLive's match)
const LIVE_RESUME = 'mbaa-live-resume';
let liveResume = null;
function liveResumeSave() {
  const s = session;
  if (!s || !s.liveSrc || !s.M) return;
  try {
    const g = call(s, 'viewer_spectate_game');
    sessionStorage.setItem(LIVE_RESUME, JSON.stringify({ id: s.liveSrc.id, match: s.liveSrc.info.match || null,
      names: s.liveSrc.info.names || [], game: g >= 0 ? g : s.liveSrc.info.game, ahead: call(s, 'viewer_spectate_buffered'), at: Date.now() }));
  } catch (e) {}
}
function liveResumeTake(id) {
  try {
    const r = JSON.parse(sessionStorage.getItem(LIVE_RESUME) || 'null');
    sessionStorage.removeItem(LIVE_RESUME);
    return r && r.id === id && Date.now() - r.at < 120000 ? r : null;
  } catch (e) { return null; }
}
// a list entry is the session's own match: the same id (the host) and, both known, the same match key (the CCCaster
// session: cc_live.mjs matchKey). The same id with another key is the host's next match: another match
const liveOurs = (m, L) => !!m && !!L && m.id === L.id && (!m.match || !(L.info && L.info.match) || m.match === L.info.match);
// a match whose host is still connected but nothing has been played for 5 min (the list's age: seconds since its capture
// last grew; the players left CCCaster open on the result menu, a lobby bot still lists the host): idle, listed last
// and dimmed, never followed or moved to
const LIVE_IDLE = 300, liveIdle = m => m.age > LIVE_IDLE, liveGone = m => m.silent > 8 || liveIdle(m);
async function liveList() {
  const r = await liveFetch(`${LIVE}/live/list`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
// id: the host's live id. match: the match key the start must be (a fallback start of the session's own match, a game
// it fell behind on): the host on another match by then is not that match, so ours has ended: the next-match card
async function startLive(id, match = null) {
  let info;
  let all;
  liveWant = id;
  try { all = await liveList(); info = all.find(m => m.id === id); } catch (e) { status(`live feed unreachable: ${e.message}`); return liveRetry(id, match); }
  if (liveWant !== id) return;  // (another match asked for meanwhile)
  if (info && match && info.match && info.match !== match) {
    status('the match has ended');
    if (session && session.liveSrc && session.liveSrc.id === id) { nextCardShow(session, all, 'Match over'); return; }
    info = null;
  }
  if (!info) {
    status('that match is not live any more');
    // (a page opened on a match that has ended (a reload after an update, an old link): the next-match card, its
    // countdown to the next live one or a wait for one; was a black picture, user 2026-11-01)
    if (!session) {
      // (after an update reload: the match it was on, so the card features a set of the same players: the host's next one)
      liveSrc = { id, info: { names: (liveResume && liveResume.id === id && liveResume.names) || [], match }, since: 0 };
      if (nextCardShow(null, all, 'That match has ended')) return;
    }
    return liveNet.recent() ? liveRetry(id, match) : undefined;
  }
  // the same match again (a fallback start): the streaks go on from the session's where the bridge has none for the game
  // (its game over: not mid-battle of an older one)
  const prev = session;
  // (the same match: the host's next match on the same id has its own streaks)
  if (!info.streak && prev && prev.M && liveOurs(info, prev.liveSrc) && prev.streakKnown && prev.M.HEAP32[0x54EEE8 >> 2] !== 1)
    info.streak = STREAK.map(a => prev.M.HEAP32[a >> 2]);
  const r = await liveFetch(`${LIVE}/live/${id}/boot.rep?game=${info.game}`).catch(() => null);
  if (liveWant !== id) return;
  if (!r || !r.ok) { status(`live match: ${r ? `HTTP ${r.status}` : 'unreachable'}`); return !r || r.status >= 500 ? liveRetry(id, match) : undefined; }
  liveSrc = { id, info, since: info.game };
  window.__mbaaRepUrl = null;
  await start(new File([await r.arrayBuffer()], `LIVE ${info.names.map(n => n.trim()).join(' vs ')}`), false, id);
}
// the last index number in a block of .ccs records (u32 index, u32 kind, rng 12 + ring 220, u32 frames, u16 x 2 x frames)
function liveLastIndex(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = 0, last = -1;
  while (o + 244 <= b.length) { last = dv.getUint32(o, true); o += 240 + 4 + 4 * dv.getUint32(o + 240, true); }
  return last;
}
const hidden = () => document.visibilityState === 'hidden';
// "jump to live" (per viewer; off: watch each game from its start at normal speed, as CCCaster's spectate option)
const liveJump = () => document.getElementById('livejump').checked;
function liveJumpInit() {
  const el = document.getElementById('livejump');
  try { el.checked = localStorage.getItem('mbaa-live-jump') !== '0'; } catch (e) {}
  el.onchange = () => { try { localStorage.setItem('mbaa-live-jump', el.checked ? '1' : '0'); } catch (e) {} el.blur(); };
}
// n frames forward as fast as the game runs, nothing drawn but the last frames (seekTo's stepping; the live hold stops
// it at the newest frame received)
// the catch-up overlay over the picture: frames to go of the total (null: hidden). The time shown is the real time
// left at the speed the catching up is going (frames per wall second, measured), not the match time those frames hold
let cuRate = null;  // {t0, f0, fps}
function catchUpShow(left, total) {
  const el = document.getElementById('catchup');
  if (!el) return;
  if (left == null) { el.hidden = true; cuRate = null; return; }
  el.hidden = false;
  const now = performance.now(), done = total - left;
  if (!cuRate || done < cuRate.f0) cuRate = { t0: now, f0: done, fps: 0 };
  else if (now - cuRate.t0 > 250) cuRate.fps = (done - cuRate.f0) / ((now - cuRate.t0) / 1000);
  const secs = cuRate.fps > 0 ? Math.ceil(left / cuRate.fps) : null;
  el.querySelector('.cu-s').textContent = secs == null ? 'catching up…' : `about ${secs} s left`;
  el.querySelector('.cu-bar i').style.width = `${Math.round(100 * (1 - left / Math.max(1, total)))}%`;
}
async function liveCatchUp(s, n) {
  const M = s.M, T = M._viewer_frame() + n, DRAW = 2;
  catchUpShow(n, n);
  s.seeking = true; s.mute = true;
  s.stopSes(); s.bgmHalt();
  uiApply(s);
  call(s, 'viewer_suppress', 1);
  let f = M._viewer_frame();
  while (f < T - DRAW) {
    const g = call(s, 'viewer_step', Math.min(T - DRAW - f, 600));
    if (g === f) break;
    f = g;
    status(`live: catching up (${T - f} frames to go)`);
    catchUpShow(T - f, n);
    await new Promise(r => setTimeout(r, 0));
    if (session !== s) { catchUpShow(null); return; }
  }
  catchUpShow(null);
  call(s, 'viewer_suppress', 0);
  if (f < T) call(s, 'viewer_step', T - f);
  else call(s, 'viewer_represent');
  s.seeking = false; s.mute = ui.paused;
  uiApply(s);
  if (!ui.paused) s.bgmSync(M._viewer_frame());
}
// The player block (spectating): per side the character's select-screen icon in its animated 1P / 2P cursor frame, the
// player's name, the moon and character. The art is the select screen's own (grp/c_sel_aa: icons 48x64, the large row
// set from row 4; cursor frames 64x64, P1 0-9 and P2 10-19, the 1P / 2P tags 20 / 21; moon icons 56x56 at y 288),
// placed as CharaSelectIcons_Draw does (the icon cell from the game's chara -> cell table). The characters come from the
// battle slots, so a game after a character select shows its new picks.
const ICON_CELL = 0x5519F8, BSLOT = 0x74D838, MOON_X = [112, 0, 224], MOON_NAME = ['Crescent', 'Full', 'Half'];
// the select screen's icon cell per character id (MBAA.exe .data ICON_CELL, ids 0..51; -1: none), for drawing before
// a game has booted (the live list)
const ICON_CELLS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 33, 16, 17, 18, 19, -1, 20, 21, -1, 23, -1, -1, 22,
                    24, 25, 26, 27, 28, 31, 32, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 34];
// a character's icon cell; the boss versions have none: their base character's (B. Aoko -> Aoko)
function iconCell(c) {
  const cellOf = id => ICON_CELLS[id] ?? -1;
  if (cellOf(c) >= 0) return cellOf(c);
  const base = CHARA[c] && CHARA[c].startsWith('B. ') ? +Object.keys(CHARA).find(k => CHARA[k] === CHARA[c].slice(3)) : -1;
  return cellOf(base);
}
// a moon mark (canvas, the 56x56 select-sheet cell scaled)
function drawMoon(cv, m) {
  const x = cv.getContext('2d');
  x.clearRect(0, 0, cv.width, cv.height);
  if (plArt && m >= 0 && m <= 2) x.drawImage(plArt.cursor, MOON_X[m], 288, 56, 56, 0, 0, cv.width, cv.height);
}
// this tab's random id, sent with live record requests: the feed counts the tabs watching each match (nothing else)
const VIEWER = Array.from(crypto.getRandomValues(new Uint8Array(12)), b => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
let plArt = null, plKey = '', plCells = [-1, -1];
async function playersArt() {
  if (plArt) return plArt;
  const art = ['grp/c_sel_aa/csel_icon00.png', 'grp/c_sel_aa/csel_cursor00.png'];
  if (!man || !art.every(p => man.files[p])) return null;
  await fetchAll(man, art, '', true);  // (a replay's plan has no select screen)
  const img = async p => { const d = cache.get(p); return d ? createImageBitmap(new Blob([d], { type: 'image/png' })) : null; };
  const [icons, cursor] = await Promise.all([img('grp/c_sel_aa/csel_icon00.png'), img('grp/c_sel_aa/csel_cursor00.png')]);
  return icons && cursor ? (plArt = { icons, cursor }) : null;
}
function playersShow(s) {
  const box = document.getElementById('players');
  if (!s || !s.M) { box.hidden = true; return; }
  const H = s.M.HEAP32, rows = box.querySelectorAll('.pl');
  const names = ((s.liveSrc && s.liveSrc.info.names) || []).map(n => (n || '').trim());  // (a replay has none)
  const sides = [0, 1].map(p => [H[(BSLOT + p * 0x2C + 8) >> 2], H[(BSLOT + p * 0x2C + 0x14) >> 2]]);
  const key = JSON.stringify([sides, names]);
  if (key !== plKey && plArt) {
    plKey = key;
    sides.forEach(([c, m], p) => {
      const row = rows[p];
      plCells[p] = iconCell(c);
      drawMoon(row.querySelector('.moon'), m);
      const moon = m >= 0 && m <= 2 ? MOON_NAME[m] : m === 9 ? 'Eclipse' : '';  // (9: the bosses' moon)
      row.querySelector('.nm .t').textContent = names[p] || CHARA[c] || `Player ${p + 1}`;
      // (the moon is its icon: the line beside it is the character, or with no player name the moon's name)
      row.querySelector('.ch .t').textContent = names[p] ? CHARA[c] || '' : moon;
      row.querySelector('.ch').title = `${moon} ${CHARA[c] || ''}`.trim();
      porShow(p, c);
    });
    box.hidden = false;
    document.getElementById('title').hidden = true;
    requestAnimationFrame(() => marquee(box));
  }
}
// The match card's portraits: each side's select-screen splash (grp/c_sel_aa/chara/csel_c<chara id>.png, 512x512, the
// figure CharaSelectPanel_LoaderThread loads for the hovered character), P1 on the left, P2 mirrored on the right, over
// the stage picture. Fetched on first use (a replay's plan has no select screen); a boss has its base character's.
const porUrls = new Map();
// each portrait's fit on the card, by the portrait's character id (a boss uses its base's): y = down by % of the card's
// height, s = scale (of today's height), x = inward by % of the card's width (P2 mirrored). {0, 1, 0} = the plain rule.
// Dialled on the real card with ?portune=1 (its "Copy JSON" output is pasted here as it is).
const POR_ADJ = {};
function porApply(el, path) {
  const id = path ? +path.match(/csel_c(\d+)\.png$/)[1] : -1, a = (porTune ? porTune.adj : POR_ADJ)[id] || {};
  el.style.setProperty('--por-y', +a.y || 0); el.style.setProperty('--por-s', a.s > 0 ? +a.s : 1); el.style.setProperty('--por-x', +a.x || 0);
}
function porPath(c) {
  const at = id => `grp/c_sel_aa/chara/csel_c${String(id).padStart(2, '0')}.png`;
  if (man && man.files[at(c)]) return at(c);
  const base = CHARA[c] && CHARA[c].startsWith('B. ') ? +Object.keys(CHARA).find(k => CHARA[k] === CHARA[c].slice(3)) : -1;
  return base >= 0 && man && man.files[at(base)] ? at(base) : null;
}
async function porShow(p, c) {
  if (porTune) c = porTuneChar(p);  // (tuning: the panel's pick, whatever is playing)
  const el = document.querySelectorAll('#matchcard .por:not(.xfghost)')[p], path = porPath(c);
  if (!el) return;
  el.dataset.c = c;
  if (!path) { el.hidden = true; document.getElementById('matchcard').classList.toggle('pors', [...document.querySelectorAll('#matchcard .por:not(.xfghost)')].some(e => !e.hidden)); return; }
  try {
    if (!porUrls.has(path)) {
      await fetchAll(man, [path], '', true);
      const d = cache.get(path);
      if (!d) throw new Error('no data');
      porUrls.set(path, URL.createObjectURL(new Blob([d], { type: 'image/png' })));
    }
    if (+el.dataset.c !== c) return;  // (another pick meanwhile)
    xfadeSrc(el, porUrls.get(path)); el.hidden = false;
    porApply(el, path);  // (after the fade's ghost is cloned: the ghost keeps the old character's fit)
  } catch (e) { el.hidden = true; }
  document.getElementById('matchcard').classList.toggle('pors', [...document.querySelectorAll('#matchcard .por:not(.xfghost)')].some(e => !e.hidden));
}
// ---- ?portune=1: dial each character's portrait fit (POR_ADJ) on the real card ----
// A floating panel: the character (and the side it stands on), the opponent (the same one, another, none), y / s / x
// sliders, prev / next, arrow-key nudges, an eye-line guide. Kept in this browser (localStorage) while tuning; "Copy JSON"
// / "Download" give the whole table, pasted into POR_ADJ as it is. With no match playing the card shows a stage picture.
const PORTUNE_KEY = 'mbaa.portune.v1';
const porTune = Q.get('portune') ? (() => {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(PORTUNE_KEY) || 'null'); } catch (e) {}
  const adj = JSON.parse(JSON.stringify(POR_ADJ));
  if (saved && saved.adj) Object.assign(adj, saved.adj);
  return { adj, c: saved && saved.c >= 0 ? saved.c : 0, side: saved && saved.side ? 1 : 0, opp: saved && saved.opp !== undefined ? saved.opp : 'same',
           guide: saved ? !!saved.guide : true, guideY: saved && saved.guideY !== undefined ? saved.guideY : 30, roster: [], stageDone: false };
})() : null;
function porTuneChar(p) {
  const t = porTune;
  if (p === t.side) return t.c;
  return t.opp === 'same' ? t.c : t.opp === 'none' ? -1 : +t.opp;
}
function porTuneSave() {
  const t = porTune;
  try { localStorage.setItem(PORTUNE_KEY, JSON.stringify({ adj: t.adj, c: t.c, side: t.side, opp: t.opp, guide: t.guide, guideY: t.guideY })); } catch (e) {}
}
// the table as pasted into POR_ADJ: only the characters moved off the default, one per line, by id (valid JSON)
function porTuneJson() {
  const ids = Object.keys(porTune.adj).map(Number).sort((a, b) => a - b).filter(id => {
    const a = porTune.adj[id]; return a && ((+a.y || 0) !== 0 || (a.s > 0 ? +a.s : 1) !== 1 || (+a.x || 0) !== 0);
  });
  if (!ids.length) return '{}';
  return '{\n' + ids.map((id, i) => { const a = porTune.adj[id];
    return `  "${id}": { "y": ${+a.y || 0}, "s": ${a.s > 0 ? +a.s : 1}, "x": ${+a.x || 0} }${i < ids.length - 1 ? ',' : ''}`; }).join('\n') + '\n}';
}
async function porTuneStage(box) {
  if (porTune.stageDone) return;
  porTune.stageDone = true;
  const id = Object.keys(stagePanel.stages).find(k => stagePanel.stages[k].art.includes('view'));
  if (id === undefined) return;
  const n = String(id).padStart(2, '0'), paths = stagePanel.stages[id].art.map(k => `web/stage/${k}_${n}.png`);
  await fetchAll(man, paths, '', true);
  for (const k of ['view', 'name']) {
    const img = box.querySelector('.' + k), d = cache.get(`web/stage/${k}_${n}.png`);
    let blob = d ? new Blob([d], { type: 'image/png' }) : null;
    if (blob && k === 'name') try { blob = await trimAlpha(blob); } catch (e) {}
    if (blob) img.src = URL.createObjectURL(blob);
    img.hidden = !blob;
  }
  box.hidden = false;
  porTuneShow();
}
function porTuneShow() {
  if (!porTune.ui) return;
  porShow(0, 0); porShow(1, 0);  // (porShow takes the panel's picks)
  porTune.ui.sync();
  porTuneSave();
}
function porTuneInit() {
  const t = porTune;
  if (!man || t.ui) return !!t.ui;
  const at = id => `grp/c_sel_aa/chara/csel_c${String(id).padStart(2, '0')}.png`;
  t.roster = Object.keys(CHARA).map(Number).filter(id => man.files[at(id)]);
  if (!t.roster.length) return false;
  if (!t.roster.includes(t.c)) t.c = t.roster[0];
  const css = document.createElement('style');
  css.textContent = `#portune { position: fixed; z-index: 10000; top: 8px; right: 8px; width: 300px; max-width: calc(100vw - 16px);
      max-height: calc(100vh - 16px); overflow: auto; box-sizing: border-box; padding: 8px 10px; border-radius: 8px;
      background: #15151ef0; color: #eee; font: 12px/1.35 system-ui, sans-serif; box-shadow: 0 4px 18px #000a; }
    #portune.min > :not(.hd) { display: none; }
    #portune .hd { display: flex; justify-content: space-between; align-items: center; font-weight: 700; margin-bottom: 4px; }
    #portune .row { display: flex; gap: 6px; align-items: center; margin: 4px 0; }
    #portune .row > label:first-child { width: 62px; flex: none; }
    #portune select, #portune input[type=number] { background: #222; color: #eee; border: 1px solid #444; border-radius: 4px; font: inherit; }
    #portune select { flex: 1; min-width: 0; }
    #portune input[type=range] { flex: 1; min-width: 0; }
    #portune input[type=number] { width: 58px; }
    #portune button { background: #2c2c3a; color: #eee; border: 1px solid #555; border-radius: 4px; padding: 2px 7px; font: inherit; cursor: pointer; }
    #portune button.on { background: #6a4cc8; border-color: #8a6cf0; }
    #portune textarea { width: 100%; box-sizing: border-box; height: 74px; background: #111; color: #cfc; border: 1px solid #444; font: 11px monospace; }
    #portune .hint { color: #999; font-size: 11px; }
    #matchcard .porguide { position: absolute; left: 0; right: 0; height: 0; border-top: 1px dashed #0ff; z-index: 4; pointer-events: none;
      box-shadow: 0 0 2px #000; }`;
  document.head.append(css);
  const box = document.createElement('div');
  box.id = 'portune';
  box.innerHTML = `<div class="hd"><span>Portrait tuning</span><button data-a="min" title="fold the panel">–</button></div>
    <div class="row"><label>character</label><button data-a="prev" title="previous (PageUp)">◀</button><select data-k="c"></select><button data-a="next" title="next (PageDown)">▶</button></div>
    <div class="row"><label>side</label><button data-side="0">P1</button><button data-side="1">P2</button></div>
    <div class="row"><label>opponent</label><select data-k="opp"></select></div>
    <div class="row"><label>y (% down)</label><input type="range" data-k="y" min="-80" max="80" step="0.5"><input type="number" data-k="y" step="0.5"></div>
    <div class="row"><label>s (scale)</label><input type="range" data-k="s" min="0.4" max="2.5" step="0.01"><input type="number" data-k="s" step="0.01" min="0.1"></div>
    <div class="row"><label>x (% in)</label><input type="range" data-k="x" min="-40" max="40" step="0.5"><input type="number" data-k="x" step="0.5"></div>
    <div class="row"><label><input type="checkbox" data-k="guide"> guide</label><input type="range" data-k="guideY" min="0" max="100" step="0.5"><input type="number" data-k="guideY" step="0.5"></div>
    <div class="row"><button data-a="reset">Reset this character</button><button data-a="copy">Copy JSON</button><button data-a="dl">Download</button></div>
    <textarea data-k="json" spellcheck="false" title="the whole table (POR_ADJ); edit or paste, then Apply JSON"></textarea>
    <div class="row"><button data-a="apply">Apply JSON</button><span class="hint" data-k="msg"></span></div>
    <div class="hint">keys: ↑↓ y, ←→ x, +/− scale (shift: ×4), PgUp/PgDn character. Kept in this browser.</div>`;
  document.body.append(box);
  const q = s => box.querySelector(s), qa = s => [...box.querySelectorAll(s)];
  const opt = (v, txt) => { const o = document.createElement('option'); o.value = v; o.textContent = txt; return o; };
  q('select[data-k=c]').append(...t.roster.map(id => opt(id, `${CHARA[id]} (${id})`)));
  q('select[data-k=opp]').append(opt('same', 'the same character'), opt('none', 'none'), ...t.roster.map(id => opt(id, CHARA[id])));
  const guide = document.createElement('div');
  guide.className = 'porguide';
  document.getElementById('matchcard').append(guide);
  const cur = () => ({ y: 0, s: 1, x: 0, ...(t.adj[t.c] || {}) });
  const msg = m => { q('[data-k=msg]').textContent = m; };
  const set = (k, v) => {
    if (!Number.isFinite(v)) return;
    const a = cur();
    a[k] = Math.round(v * 1000) / 1000;
    if (k === 's' && a.s <= 0) a.s = 0.01;
    t.adj[t.c] = a;
    porTuneShow();
  };
  t.ui = { sync() {
    const a = cur();
    q('select[data-k=c]').value = t.c; q('select[data-k=opp]').value = t.opp;
    for (const k of ['y', 's', 'x']) for (const e of qa(`input[data-k=${k}]`)) if (document.activeElement !== e || e.type === 'range') e.value = a[k];
    for (const e of qa('input[data-k=guideY]')) if (document.activeElement !== e || e.type === 'range') e.value = t.guideY;
    q('input[data-k=guide]').checked = t.guide;
    qa('[data-side]').forEach(b => b.classList.toggle('on', +b.dataset.side === t.side));
    guide.hidden = !t.guide; guide.style.top = t.guideY + '%';
    if (document.activeElement !== q('textarea')) q('textarea').value = porTuneJson();
  } };
  const step = d => { const i = t.roster.indexOf(t.c); t.c = t.roster[(i + d + t.roster.length) % t.roster.length]; porTuneShow(); };
  q('select[data-k=c]').onchange = e => { t.c = +e.target.value; porTuneShow(); };
  q('select[data-k=opp]').onchange = e => { t.opp = e.target.value; porTuneShow(); };
  qa('[data-side]').forEach(b => b.onclick = () => { t.side = +b.dataset.side; porTuneShow(); });
  for (const k of ['y', 's', 'x']) for (const e of qa(`input[data-k=${k}]`)) e.oninput = () => set(k, parseFloat(e.value));
  for (const e of qa('input[data-k=guideY]')) e.oninput = () => { const v = parseFloat(e.value); if (Number.isFinite(v)) { t.guideY = v; porTuneShow(); } };
  q('input[data-k=guide]').onchange = e => { t.guide = e.target.checked; porTuneShow(); };
  const copy = async txt => {
    try { await navigator.clipboard.writeText(txt); return true; } catch (e) {}
    const ta = q('textarea'); ta.value = txt; ta.select();
    try { return document.execCommand('copy'); } catch (e) { return false; }
  };
  box.onclick = async e => {
    const a = e.target.dataset && e.target.dataset.a;
    if (a === 'prev') step(-1); else if (a === 'next') step(1);
    else if (a === 'min') box.classList.toggle('min');
    else if (a === 'reset') { delete t.adj[t.c]; porTuneShow(); msg(`${CHARA[t.c]}: back to the default`); }
    else if (a === 'copy') { const j = porTuneJson(); q('textarea').value = j; msg(await copy(j) ? 'copied: paste it into POR_ADJ' : 'select the text and copy it'); }
    else if (a === 'dl') {
      const u = URL.createObjectURL(new Blob([porTuneJson() + '\n'], { type: 'application/json' })), l = document.createElement('a');
      l.href = u; l.download = 'por_adj.json'; document.body.append(l); l.click(); l.remove(); setTimeout(() => URL.revokeObjectURL(u), 5000);
    } else if (a === 'apply') {
      try {
        const o = JSON.parse(q('textarea').value);
        t.adj = {};
        for (const [id, v] of Object.entries(o)) t.adj[+id] = { y: +v.y || 0, s: v.s > 0 ? +v.s : 1, x: +v.x || 0 };
        q('textarea').blur(); porTuneShow(); msg('applied');
      } catch (err) { msg('not JSON: ' + err.message); }
    }
  };
  // (the viewer's own keys wait while tuning; a text field keeps its keys)
  addEventListener('keydown', e => {
    if (e.target && e.target.closest && e.target.closest('input[type=number], textarea, select')) return;
    const m = e.shiftKey ? 4 : 1, a = cur();
    const k = { ArrowUp: ['y', -0.5], ArrowDown: ['y', 0.5], ArrowLeft: ['x', -0.5], ArrowRight: ['x', 0.5], '+': ['s', 0.01], '=': ['s', 0.01], '-': ['s', -0.01], '_': ['s', -0.01] }[e.key];
    if (k) set(k[0], a[k[0]] + k[1] * m);
    else if (e.key === 'PageUp') step(-1); else if (e.key === 'PageDown') step(1);
    else return;
    e.preventDefault(); e.stopImmediatePropagation();
  }, true);
  porTuneShow();
  return true;
}
if (porTune) {
  const iv = setInterval(() => { if (porTuneInit()) clearInterval(iv); }, 300);
  window.__porTune = { json: porTuneJson, get state() { return porTune; } };
}
// the cursor frames' loop over the icons, at the select screen's rate (CharaSelectIcons_Update, CE 0x48BAB0: the next of
// 10 frames every 2 game ticks)
// one select-screen cell (64x64, scaled to the canvas): the character icon, side p's cursor frame f (of 10), its P1/P2 tag
function selFrame(cv, cell, p, f) {
  const c = cv.getContext('2d'), k = cv.width / 64, fr = 10 * p + f, tag = 20 + p;
  c.clearRect(0, 0, cv.width, cv.height);
  if (cell >= 0) c.drawImage(plArt.icons, 48 * (cell % 10), (Math.floor(cell / 10) + 4) * 64, 48, 64, 8 * k, 0, 48 * k, 64 * k);  // (centred in the frame, as CharaSelectIcons_Draw)
  c.drawImage(plArt.cursor, (fr % 8) * 64, Math.floor(fr / 8) * 64, 64, 64, 0, 0, 64 * k, 64 * k);
  c.drawImage(plArt.cursor, (tag % 8) * 64, Math.floor(tag / 8) * 64, 64, 64, 0, 0, 64 * k, 64 * k);
}
let plAnimF = -1;
function playersAnimate(t) {
  const box = document.getElementById('players');
  const fNow = Math.floor(t * 60 / 2000) % 10;
  if (fNow === plAnimF) { requestAnimationFrame(playersAnimate); return; }  // (the cursor frame changes 30 times a second)
  plAnimF = fNow;
  if (!box.hidden && plArt) {
    const f = Math.floor(t * 60 / 2000) % 10;
    box.querySelectorAll('.pl').forEach((row, p) => selFrame(row.querySelector('.ico'), plCells[p], p, f));
  }
  // the live list's icons too (each side's cursor, as on the select screen)
  if (plArt && !document.getElementById('livesec').hidden) {
    const f = Math.floor(t * 60 / 2000) % 10;
    for (const cv of document.querySelectorAll('#liveitems .lico')) selFrame(cv, +cv.dataset.cell, +cv.dataset.side, f);
  }
  requestAnimationFrame(playersAnimate);
}
requestAnimationFrame(playersAnimate);
// The stage block and Raito Radio (tools/web/stage_panel.py puts web/stage/* in the bundle, tools/web/old_melty/
// radio_bundle.py web/radio/*): the stage's select-screen preview and name plate, and the title of the music playing;
// the radio's pick replaces the match's music (replays and live) until it is set back to the match's. Its game bar
// switches the track list between MBAACC and the older games (Act Cadenza, Re-ACT, Melty Blood: their list, tracks and
// stage files fetched only when picked); an older game's stage track also runs that game's own stage file in the
// game's background engine in place of the match's stage, and an MBAACC track loads its own MBAACC stage as the game
// loads one (web/host/radio_stage.cpp; the fight is untouched). Each
// tile links Raito's own upload of the song where there is one.
let stagePanel = null, stageKey = '', radio = null, oldRadio = null, radioGame = 'aacc';
const RADIO_GAMES = [['aacc', 'MBAACC'], ['ac', 'Act Cadenza'], ['re', 'Re-ACT'], ['mb', 'Melty Blood']];
const trackOf = path => (path || '').replace(/^.*\//, '').replace(/\.\w+$/, '');
async function stagePanelLoad() {
  if (!man.files['web/stage/panel.json']) return;
  await fetchAll(man, ['web/stage/panel.json'], '', true);
  stagePanel = JSON.parse(new TextDecoder().decode(cache.get('web/stage/panel.json')));
  const grid = document.getElementById('radiogrid'), tog = document.getElementById('radiotog'), bar = document.getElementById('radiogames');
  if (man.files['web/radio/old.json']) {
    bar.replaceChildren(...RADIO_GAMES.map(([g, name]) => {
      const b = document.createElement('button');
      b.className = 'txt'; b.dataset.g = g; b.textContent = name;
      b.onclick = () => radioShowGame(g).catch(e => console.warn('radio:', e));
      return b;
    }));
  }
  tog.onclick = () => {
    grid.hidden = !grid.hidden; bar.hidden = grid.hidden || !bar.children.length;
    document.getElementById('radiosec').classList.toggle('open', !grid.hidden);
    if (!grid.hidden) {
      radioArt(); radioOldLoad().then(() => { radioLinks(); musicOpts(); }).catch(() => {});
      // the picker opens under the panel, often below the window's edge: bring it into view
      requestAnimationFrame(() => grid.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
    }
  };
  document.getElementById('radiosec').hidden = false;
  musicOpts();
  await radioShowGame('aacc');
  radioSet('');
}
// web/radio/old.json: the older games' radio (fetched when the picker first opens)
let oldRadioP = null;
function radioOldLoad() {
  if (!man.files['web/radio/old.json']) return Promise.resolve(null);
  return oldRadioP || (oldRadioP = fetchAll(man, ['web/radio/old.json'], '', true).then(() => {
    oldRadio = JSON.parse(new TextDecoder().decode(cache.get('web/radio/old.json')));
    oldRadio.byKey = {};
    for (const g of oldRadio.games) for (const t of g.tracks) oldRadio.byKey[`${g.id}:${t.id}`] = Object.assign(t, { game: g.id });
    return radioOverrides(oldRadio).then(() => oldRadio);
  }));
}
// the community's names and tiles for the older games' tracks ("Name the tracks", tools/web/track_tags.mjs): approved by
// the reviewers, public on the site root as /radio/overrides.json (the Worker; a local build has none), applied over
// old.json's, so an approval needs no bundle rebuild. A tile is the Worker's /radio/img/<name>.jpg.
async function radioOverrides(o) {
  try {
    const r = await fetch(new URL('/radio/overrides.json', new URL(BUNDLE, location.href)), { cache: 'no-cache', signal: AbortSignal.timeout(4000) });
    if (!r.ok) return;
    const j = await r.json();
    for (const [k, v] of Object.entries((j && j.tracks) || {})) {
      const t = o.byKey[k];
      if (!t || !v) continue;
      if (typeof v.title === 'string' && v.title) { t.title = v.title.slice(0, 80); t.titled = true; }
      if (typeof v.jp === 'string' && v.jp) t.titleJp = v.jp.slice(0, 80);
      if (typeof v.tile === 'string' && /^radio\/img\/[A-Za-z0-9_-]+\.jpg$/.test(v.tile)) t.tileUrl = new URL('/' + v.tile, r.url).href;
    }
  } catch (e) {}
}
function radioTile(f, title, src, sub) {
  const b = document.createElement('button'), img = document.createElement('div'), cap = document.createElement('span');
  b.className = 'tile'; b.dataset.f = f; b.title = sub ? `${title} — ${sub}` : title;
  img.className = 'art';
  if (/^https?:/.test(src)) img.style.backgroundImage = `url("${src}")`;  // (a community tile: radioOverrides)
  else if (src) img.dataset.src = src; else img.textContent = '♪';
  cap.textContent = title;
  b.append(img, cap);
  b.onclick = () => radioSet(f);
  b.classList.toggle('on', f === radioPick);
  return b;
}
// the song's upload on Raito's channel: a small link on the tile (a new tab; the tile itself is not picked)
function radioLinks() {
  for (const b of document.querySelectorAll('#radiogrid .tile')) {
    const f = b.dataset.f, o = oldRadio && (f.includes(':') ? oldRadio.byKey[f] : null);
    const url = o ? o.yt : oldRadio && oldRadio.aaccYt && oldRadio.aaccYt[f];
    if (!url || b.querySelector('.yt')) continue;
    const a = document.createElement('a');
    a.className = 'yt'; a.href = url; a.target = '_blank'; a.rel = 'noopener';
    a.title = 'Raito’s upload of this song on YouTube'; a.setAttribute('aria-label', a.title);
    a.textContent = '▶';
    a.onclick = e => e.stopPropagation();
    b.append(a);
  }
}
async function radioShowGame(g) {
  if (g !== 'aacc' && !(await radioOldLoad())) g = 'aacc';
  radioGame = g;
  for (const b of document.querySelectorAll('#radiogames button')) b.classList.toggle('on', b.dataset.g === g);
  const grid = document.getElementById('radiogrid');
  if (g === 'aacc') {
    const art = {};  // track -> the first stage that plays it (its select-screen preview is the track's tile)
    for (const [id, st] of Object.entries(stagePanel.stages)) if (st.track && !art[st.track] && st.art.includes('view')) art[st.track] = id;
    const t = Object.entries(stagePanel.tracks).filter(([, x]) => x.loop);  // (a radio of looping tracks: no jingles, endings)
    const src = f => art[f] !== undefined ? `web/stage/view_${String(art[f]).padStart(2, '0')}.png`
      : stagePanel.tracks[f].art ? `web/stage/track_${f}.png` : '';  // (a screen's track: its art)
    grid.replaceChildren(radioTile('', 'Match music', ''), ...t.map(([f, x]) => radioTile(f, x.title, src(f))));
  } else {
    const game = oldRadio.games.find(x => x.id === g);
    grid.replaceChildren(radioTile('', 'Match music', ''),
      ...game.tracks.map(t => radioTile(`${g}:${t.id}`, t.title, t.tileUrl || t.tile || '', t.stageName || '')));
  }
  radioArtDone = false;
  if (!grid.hidden) radioArt();
  radioLinks();
}
// the tiles' pictures, fetched when the picker is open
let radioArtDone = false;
async function radioArt() {
  if (radioArtDone) return;
  radioArtDone = true;
  const tiles = [...document.querySelectorAll('#radiogrid .art[data-src]')].filter(e => !e.style.backgroundImage), path = e => e.dataset.src;
  await fetchAll(man, tiles.map(path), '', true);
  for (const e of tiles) {
    const d = cache.get(path(e));
    if (d) e.style.backgroundImage = `url(${URL.createObjectURL(new Blob([d], { type: /\.jpg$/.test(path(e)) ? 'image/jpeg' : 'image/png' }))})`;
  }
}
// an MBAACC track's stages (panel.json: the stages whose BGM it is), the tile's (the first with a preview) first
function radioTrackStages(f) {
  const ids = Object.entries(stagePanel.stages).filter(([, st]) => st.track === f).map(([id, st]) => [+id, st.art.includes('view')]);
  return [...ids.filter(x => x[1]), ...ids.filter(x => !x[1])].map(x => x[0]);
}
// a pick: '' (the match's music), an MBAACC track (bgmmeNN) or an older game's ('ac:01')
function radioTrack(f) {
  if (!f) return null;
  if (!f.includes(':')) {
    const t = stagePanel.tracks[f];
    return t && { title: t.title, key: `bgm/${f}.opus`, fetch: withSiblings(man, [`bgm/${f}.ogg`]), loopPos: t.loopPos,
                  stages: radioTrackStages(f) };
  }
  const t = oldRadio && oldRadio.byKey[f];
  return t && { title: t.title, key: t.f, fetch: [t.f, ...(t.dat ? [t.dat] : []), ...(t.tile ? [t.tile] : [])], loopPos: t.loopPos,
                dat: t.dat, lights: t.lights || [], tile: t.tile, tileUrl: t.tileUrl, stageName: t.stageName,
                game: (RADIO_GAMES.find(([g]) => g === t.game) || [])[1] };
}
let radioPick = '';
let radioLiveId = null;  // (the live match the pick was made on: it lasts for that match's sessions; start)
let xfStagePending = false;  // (a pick's stage swap to crossfade: radioStageSync)
// floatsis (user 2026-11-01): the music chosen apart from the stage. '' the stage's (the radio pick's track, else the
// match's own), 'match' the match's own whatever the pick, or a track (as radioTrack). Kept like the pick: a replay's
// for that replay, a live match's for its whole live match (musicLiveId; start).
let musicPick = '', musicLiveId = null, musicSel = null;
const musicNow = () => musicPick === 'match' ? null : musicPick ? musicSel : radio;
async function musicSet(f) {
  musicPick = f;
  musicLiveId = f && session && session.liveSrc ? session.liveSrc.id : null;
  const sel = document.getElementById('radiomusic');
  if (sel) { if (f && ![...sel.options].some(o => o.value === f)) musicOpts(); sel.value = f; }
  const t = f && f !== 'match' ? radioTrack(f) : null;
  if (t) await fetchAll(man, t.fetch, '', true);
  if (musicPick !== f) return;  // (chosen again meanwhile)
  musicSel = t ? { path: `/game/${t.key}`, loopPos: t.loopPos, file: f, title: t.title, game: t.game } : null;
  if (session && session.radioChanged) session.radioChanged();
  stageKey = '';
}
// the music list: MBAACC's looping tracks, then the older games' once old.json is in
function musicOpts() {
  const sel = document.getElementById('radiomusic');
  if (!sel || !stagePanel) return;
  const keep = sel.value, base = [...sel.options].slice(0, 2);
  const grp = (label, items) => {
    const g = document.createElement('optgroup'); g.label = label;
    for (const [v, t] of items) { const o = document.createElement('option'); o.value = v; o.textContent = t; g.append(o); }
    return g;
  };
  const out = [...base, grp('MBAACC', Object.entries(stagePanel.tracks).filter(([, x]) => x.loop).map(([f, x]) => [f, x.title]))];
  if (oldRadio) for (const g of oldRadio.games) {
    const name = (RADIO_GAMES.find(([id]) => id === g.id) || [])[1] || g.id;
    out.push(grp(name, g.tracks.map(t => [`${g.id}:${t.id}`, t.title])));
  }
  sel.replaceChildren(...out);
  sel.value = [...sel.options].some(o => o.value === keep) ? keep : '';
}
(() => {
  const sel = document.getElementById('radiomusic');
  if (!sel) return;
  const more = () => { if (!oldRadio) radioOldLoad().then(o => { if (o) musicOpts(); }).catch(() => {}); };
  sel.addEventListener('pointerdown', more); sel.addEventListener('focus', more);
  sel.onchange = () => musicSet(sel.value).catch(e => console.warn('radio: music:', e));
})();
// floatsis: the music picked on its own, the stage left alone (off: a radio track changes only the music; remembered)
let radioStageFollow = true;
try { radioStageFollow = localStorage.getItem('mbaaRadioStage') !== '0'; } catch (e) {}
(() => {
  const cb = document.getElementById('radiostage');
  if (!cb) return;
  cb.checked = radioStageFollow;
  cb.onchange = () => {
    radioStageFollow = cb.checked;
    try { localStorage.setItem('mbaaRadioStage', radioStageFollow ? '1' : '0'); } catch (e) {}
    stageKey = '';
    xfStagePending = true;
    radioStageSync(session);
    if (ui.paused && session && session.tl) requestSeek(curFrame());  // (paused: the frame drawn again, with its stage)
  };
})();
async function radioSet(f, stageOnly = 0) {
  radioPick = f;
  radioLiveId = f && session && session.liveSrc ? session.liveSrc.id : null;
  const t = radioTrack(f);
  for (const b of document.querySelectorAll('#radiogrid .tile')) b.classList.toggle('on', b.dataset.f === f);
  document.getElementById('radiotog').textContent = `♪ ${t ? t.title : 'match music'}`;
  if (t) await fetchAll(man, t.fetch, '', true);
  if (radioPick !== f) return;  // (picked again meanwhile)
  radio = t ? { path: `/game/${t.key}`, loopPos: t.loopPos, file: f, title: t.title, tile: t.tile, tileUrl: t.tileUrl, stageName: t.stageName,
                game: t.game, dat: t.dat && cache.has(t.dat) ? t.dat : '', lights: t.lights,
                stages: stageOnly ? [stageOnly] : t.stages || null } : null;  // (a chat ^stage chip: that stage, not the track's first)
  if (session && session.radioChanged) session.radioChanged();
  stageKey = '';
  xfStagePending = true;
  radioStageSync(session);
  if (ui.paused && session && session.tl) requestSeek(curFrame());  // (paused: the frame drawn again, with its stage)
}
// Chat mentions (chat.js: "!song" and "^stage" chips, tap to apply on your own picture only): the music list (musicOpts)
// and the radio's stages (MBAACC's, named from their plates; the older games' stage tracks), and the panel's own picks.
const STAGE_NAMES = { 1: 'Artificial Eden', 2: 'Classic home.Evening party', 3: 'Classic home.Invade', 4: 'Shade Town Mad Parade',
  5: 'Tohno’s mansion.Main gate', 6: 'Night of Walpurgis', 7: 'sabbath', 8: 'Midnight Park', 9: 'Magical Kohaku Prison', 10: 'Back alley',
  12: 'School rush!', 13: 'Iron Maiden', 16: 'Hologram Summer', 17: 'Starlight crossing', 18: 'Witch on the Holy night',
  19: 'Through the Looking-Glass', 20: 'Classic', 21: 'Temple the Seventh Heaven', 22: 'Doctor Kohaku Garage', 23: 'Great Cats Village',
  24: 'Tohno’s mansion.Central garden', 25: 'Huge library', 26: 'Forest of king Cruel', 27: 'Battle field', 28: 'narvous stray vanguard',
  29: 'red moon scherzo', 30: 'lost world’s Biography', 31: 'NECO no you may.', 32: 'Loser Cats Company', 34: 'phantom of the opera',
  35: 'carry back,old village', 36: 'Temple the Seventh Heaven', 37: 'stranger', 38: 'in the park', 39: 'on the park', 40: 'spiral uroboros',
  41: 'cherry blossom', 42: 'desert town', 43: 'Coating earth,Black Land Texture', 44: 'Emerald Table,Melty Blood Texture',
  45: 'Sleeping Forest', 46: 'Farewell town', 47: 'fateful show down', 48: 'the crossing crossing', 49: 'Magical Kohaku Prison',
  50: 'No Control Red', 51: 'NECO Burst Camp', 52: 'stranger', 53: 'Arima’s Chinese kempo home', 54: 'sayonara Dear Friend',
  55: '...and nothing heart', 56: 'ONE LIFE,ONE DEATE', 57: 'G TABLE', 58: 'G TABLE', 59: 'good morning,anima mundi' };
let mentCat = null;
function mentionCatalog() {
  const v = `${!!stagePanel}/${!!oldRadio}`;
  if (mentCat && mentCat.v === v) return mentCat;
  const songs = [], stages = [], seen = new Set();
  if (stagePanel) {
    for (const [f, x] of Object.entries(stagePanel.tracks)) if (x.loop) songs.push({ f, title: x.title, game: 'MBAACC' });
    for (const [id, st] of Object.entries(stagePanel.stages)) {
      const name = STAGE_NAMES[id];
      if (!name || !st.track || seen.has(name)) continue;  // (a stage plays its track's stage pick; a repeated plate: the first)
      seen.add(name);
      stages.push({ key: String(id), name, game: 'MBAACC', f: st.track, thumb: st.art.includes('view') ? `web/stage/view_${String(id).padStart(2, '0')}.png` : '' });
    }
  }
  if (oldRadio) for (const g of oldRadio.games) {
    const game = (RADIO_GAMES.find(([id]) => id === g.id) || [])[1] || g.id;
    for (const t of g.tracks) {
      songs.push({ f: `${g.id}:${t.id}`, title: t.title, game });
      if (t.dat && t.stageName) stages.push({ key: `${g.id}:${t.id}`, name: t.stageName, game, f: `${g.id}:${t.id}`, thumb: t.tileUrl || t.tile || '' });
    }
  }
  return (mentCat = { v, songs, stages });
}
const mentThumbs = new Map();  // path -> Promise<url>
function mentionThumb(p) {
  if (!p) return Promise.resolve('');
  if (/^https?:/.test(p)) return Promise.resolve(p);
  if (!mentThumbs.has(p)) mentThumbs.set(p, fetchAll(man, [p], '', true).then(() => {
    const d = cache.get(p);
    return d ? URL.createObjectURL(new Blob([d], { type: /\.jpg$/.test(p) ? 'image/jpeg' : 'image/png' })) : '';
  }).catch(() => ''));
  return mentThumbs.get(p);
}
// the radio panel opened at a track's tile (a chip tapped with no match playing)
async function radioPanelAt(f) {
  const grid = document.getElementById('radiogrid');
  if (!grid || !stagePanel) return;
  if (grid.hidden) document.getElementById('radiotog').onclick();
  await radioShowGame(f.includes(':') ? f.split(':')[0] : 'aacc');
  const b = [...grid.querySelectorAll('.tile')].find(x => x.dataset.f === f);
  if (b) { b.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); b.classList.add('flash'); setTimeout(() => b.classList.remove('flash'), 1600); b.focus({ preventScroll: true }); }
}
function mentionApply(kind, it) {
  if (!session) return radioPanelAt(it.f);
  if (kind === 'song') return musicSet(it.f);
  return radioSet(it.f, it.key.includes(':') ? 0 : +it.key);
}
// The stage: the pick's stage file into MEMFS (sharing the fetched buffer; a stage file MBAACC also ships is bg/bgNN.dat,
// whose MEMFS copy may be the 1-byte probe placeholder) and sent to the game, which swaps stages between frames. Sent
// whenever the game's wanted stage differs from the pick: a pick, a new match's instance, a keyframe restore (it puts
// back the keyframe's: checked every frame and after each restore). Back to the match's music: the game expands the
// match's stage again, from its file, which low-memory mode may have dropped (put back first; the game waits for it).
const radioDatIds = new Map();
const radioDatId = p => radioDatIds.get(p) || (radioDatIds.set(p, radioDatIds.size + 1), radioDatIds.size);
function radioPut(s, p) {
  const d = cache.get(p), FS = s.M.FS;
  if (!d) return false;
  let n = -1;
  try { n = FS.stat('/game/' + p).size; } catch (e) {}
  if (n !== d.length) fsPut(FS, '/game/' + p, d);
  if (s.freed) s.freed.delete(p);
  return true;
}
let radioOwnFetch = null;
// an MBAACC stage's files, as a match on it loads them (asset plan: bg/bgNN.dat, its Info.txt, DXT5 table, lights;
// its drop object image), without its BGM
function radioStageFiles(id) {
  const p = man.plan;
  if (!p || !p.stage) return [];
  return [...withSiblings(man, [...p.stage.map(t => fmt(t, id, 0)), ...((p.stage_files || {})[id] || [])])].filter(f => !/^bgm\//.test(f));
}
const memfsSize = (M, p) => { try { return M.FS.stat('/game/' + p).size; } catch (e) { return -1; } };
function radioOwnStage(s) {  // the match's stage files back in MEMFS, if they were dropped
  const M = s.M, idx = M._viewer_radio_stage_match ? M._viewer_radio_stage_match() : M.HEAP32[0x54CE90 >> 2];  // (g_BGLoadedStageIndex)
  if (idx <= 0 || idx >= 100 || radioOwnFetch) return;
  const need = radioStageFiles(idx).filter(p => memfsSize(M, p) <= 1);
  if (!need.length) return;
  radioOwnFetch = fetchAll(man, need, '', true).then(() => { if (session === s) for (const p of need) radioPut(s, p); })
    .finally(() => { radioOwnFetch = null; });
}
// an MBAACC pick's stage files into MEMFS (all at once, the .dat with them: the game waits for the .dat); false while
// they are being fetched
let radioStageFetch = null, radioStageBad = 0;
function radioFilesIn(s, id) {
  const files = radioStageFiles(id), miss = files.filter(p => !cache.has(p));
  if (miss.length) {
    if (!radioStageFetch && radioStageBad !== id)
      radioStageFetch = fetchAll(man, miss, '', true).catch(e => { radioStageBad = id; console.warn('radio: stage files:', e); })
        .finally(() => { radioStageFetch = null; });
    return false;
  }
  for (const p of files) radioPut(s, p);
  return true;
}
function radioStageSync(s) {
  const M = s && s.M;
  if (!M || !M._viewer_radio_stage_id || s.glLost) return;
  const st = radio && radio.dat && !HASH && radioStageFollow ? radio : null;
  // an MBAACC track: its stage (the match's own when it is one of the track's: nothing to swap)
  let stage = 0;
  if (!st && radio && radioStageFollow && radio.stages && radio.stages.length && !HASH && M._viewer_radio_stage_want_stage) {
    const own = M._viewer_radio_stage_match();
    stage = radio.stages.includes(own) ? 0 : radio.stages[0];
  }
  if (radio) radio.stageNow = stage;
  const want = st ? radioDatId(st.dat) : stage ? radioDatId(`stage:${stage}`) : 0;
  if (!want && M._viewer_radio_stage_in()) radioOwnStage(s);
  if (M._viewer_radio_stage_id() === want) { xfStagePending = false; return; }
  // (a pick's stage swap: crossfaded once it is sent; a keyframe restore sending it again is not)
  // (in battle only: elsewhere the stage comes in with the battle's own load and fade, and a held copy would freeze the
  // VS screen)
  const fade = () => { if (xfStagePending) { xfStagePending = false; if (M.HEAP32[0x54EEE8 >> 2] === 1) xfGrab(() => M._viewer_radio_stage_in() === want); } };
  if (stage) { if (radioFilesIn(s, stage)) { fade(); M._viewer_radio_stage_want_stage(stage, want); } return; }
  if (st && !radioPut(s, st.dat)) return;
  fade();
  if (st) st.lights.forEach(([pos, power], i) => M._viewer_radio_stage_light(i, pos, power));
  M.ccall('viewer_radio_stage_want', null, ['string', 'number', 'number'], [st ? st.dat : '', want, st ? st.lights.length : 0]);
}
requestAnimationFrame(function radioStageLoop() { try { radioStageSync(session); } catch (e) {} requestAnimationFrame(radioStageLoop); });
// an image cropped to the box of its pixels that are not fully transparent (PNG out)
async function trimAlpha(blob) {
  const bm = await createImageBitmap(blob), cv = document.createElement('canvas');
  cv.width = bm.width; cv.height = bm.height;
  const x = cv.getContext('2d', { willReadFrequently: true });
  x.drawImage(bm, 0, 0);
  const px = x.getImageData(0, 0, cv.width, cv.height).data;
  let x0 = cv.width, y0 = cv.height, x1 = -1, y1 = -1;
  for (let y = 0; y < cv.height; ++y) for (let i = 0; i < cv.width; ++i) if (px[(y * cv.width + i) * 4 + 3] > 8) {
    if (i < x0) x0 = i; if (i > x1) x1 = i; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (x1 < 0) return blob;
  const out = document.createElement('canvas');
  out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
  out.getContext('2d').drawImage(cv, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return await new Promise(r => out.toBlob(b => r(b || blob), 'image/png'));
}
// A picture changing on the card (the stage, its name plate, a side's splash): the old one fades out over the new
// (a copy of the old image laid on it, removed when faded; the old blob URL is let go after). Reduced motion: a cut.
const XF_MS = 450;
function xfadeSrc(img, src, revoke) {
  const prev = img.getAttribute('src');
  const can = prev && src && prev !== src && !img.hidden && img.offsetWidth > 0 && img.complete && img.naturalWidth > 0
    && !(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  if (!can) { if (src) img.src = src; else img.removeAttribute('src'); if (revoke) URL.revokeObjectURL(revoke); return; }
  const g = img.cloneNode(false);
  g.removeAttribute('id'); g.removeAttribute('title'); g.setAttribute('aria-hidden', 'true'); g.classList.add('xfghost');
  if (getComputedStyle(img).position === 'static')
    Object.assign(g.style, { position: 'absolute', left: `${img.offsetLeft}px`, top: `${img.offsetTop}px`, width: `${img.offsetWidth}px`, height: `${img.offsetHeight}px`, margin: '0' });
  g.style.pointerEvents = 'none';
  img.after(g);
  img.src = src;
  let done = false;
  const go = () => {
    if (done) return; done = true;
    g.style.transition = `opacity ${XF_MS}ms ease`;
    requestAnimationFrame(() => { g.style.opacity = '0'; });
    setTimeout(() => { g.remove(); if (revoke) URL.revokeObjectURL(revoke); }, XF_MS + 80);
  };
  (img.decode ? img.decode() : Promise.resolve()).then(go, go);
  setTimeout(go, 1500);  // (a decode that never settles)
}
async function stageShow(s) {
  const box = document.getElementById('stageblk');
  if (porTune && stagePanel && !(s && s.M)) return porTuneStage(box);  // (tuning with no match: a stage picture anyway)
  if (!stagePanel || !s || !s.M) { box.hidden = true; return; }
  const id = radio && radio.stageNow ? radio.stageNow : s.M.HEAP32[STAGE_ID >> 2], st = stagePanel.stages[id];  // (an MBAACC pick's stage)
  const mu = musicNow(), own = musicPick === 'match' ? s.bgmNow : null;
  const f = mu ? mu.file : trackOf(own || s.bgmNow) || (st && st.track), key = `${id}/${f}/${+radioStageFollow}/${radio ? radio.file : ''}/${musicPick}`;
  if (key === stageKey) return;
  stageKey = key;
  const tr = mu ? mu : stagePanel.tracks[f];
  document.getElementById('trk').textContent = tr ? tr.title + (mu ? ` (radio${mu.game ? `, ${mu.game}` : ''})` : '') : '';
  if (radio && radioStageFollow && (radio.tile || radio.tileUrl)) {  // an older game's stage: its picture, its name for the plate
    const view = box.querySelector('.view'), name = box.querySelector('.name'), d = radio.tile && cache.get(radio.tile);
    const old = view.dataset.src && view.dataset.src.startsWith('blob:') ? view.dataset.src : '';
    // (the stage's own render; a track with none shows its community tile)
    view.dataset.src = d ? URL.createObjectURL(new Blob([d], { type: 'image/jpeg' })) : radio.tileUrl || '';
    xfadeSrc(view, view.dataset.src, old); view.hidden = !view.dataset.src; view.title = radio.stageName || '';
    if (name.dataset.src) URL.revokeObjectURL(name.dataset.src);
    name.dataset.src = ''; name.removeAttribute('src'); name.hidden = true;
    if (box.hidden) requestAnimationFrame(() => marquee(document.getElementById('players')));
    box.hidden = false;
    return;
  }
  box.querySelector('.view').title = '';
  if (!st) { box.hidden = true; return; }
  const n = String(id).padStart(2, '0'), paths = st.art.map(k => `web/stage/${k}_${n}.png`);
  await fetchAll(man, paths, '', true);
  for (const k of ['view', 'name']) {
    const img = box.querySelector('.' + k), d = cache.get(`web/stage/${k}_${n}.png`), old = img.dataset.src || '';
    let blob = d ? new Blob([d], { type: 'image/png' }) : null;
    // the name plate's text sits left in a wider sheet cell: cropped to its drawn pixels so the plate centres on the card
    if (blob && k === 'name') try { blob = await trimAlpha(blob); } catch (e) {}
    img.dataset.src = blob ? URL.createObjectURL(blob) : '';
    xfadeSrc(img, img.dataset.src, old); img.hidden = !d;
  }
  if (box.hidden) requestAnimationFrame(() => marquee(document.getElementById('players')));  // (the card's layout: measured again)
  box.hidden = false;
}
setInterval(() => {
  if (document.hidden) return;  // (nothing to show on a hidden page: the next tick once it is back fills it in)
  stageShow(session).catch(() => {});
  playersArt().then(() => playersShow(session)).catch(() => {});
}, 500);
// a text longer than its room (sel: boxes holding a .t) scrolls to its end and back, at ~25 px/s, resting at both ends
// (the player block's room changes with the layout, the card's banner and its fonts: measured again on every resize)
if (window.ResizeObserver && document.getElementById('players'))  // (viewer.js loads at the end of the page: it exists)
  new ResizeObserver(() => marquee(document.getElementById('players'))).observe(document.getElementById('players'));
function marquee(root, sel = '.mqx') {
  for (const nm of root.querySelectorAll(sel)) {
    const over = nm.firstChild.scrollWidth - nm.clientWidth;
    nm.classList.toggle('mq', over > 2);
    const t = nm.firstChild;
    // (a Web Animation with concrete numbers runs on the compositor; the CSS keyframes with var() re-styled the text
    // every frame on the main thread)
    if (t.__mq && t.__mq.over === over) continue;
    if (t.__mq) { t.__mq.anim.cancel(); t.__mq = null; }
    if (over <= 2 || (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) || !t.animate) continue;
    const anim = t.animate([{ transform: 'translateX(0)', offset: 0 }, { transform: 'translateX(0)', offset: 0.15 },
                            { transform: `translateX(${-over}px)`, offset: 0.85 }, { transform: `translateX(${-over}px)`, offset: 1 }],
                           { duration: (over / 60 / 0.7 + 0.5) * 1000, iterations: Infinity, direction: 'alternate', easing: 'ease-in-out' });
    t.__mq = { over, anim };
  }
}
// the watched match's viewer count (the live list's, every 15 s), on the players panel's VS line
function liveWatching(n) {
  const e = document.getElementById('watching');
  if (!e) return;
  e.title = n ? `${n} watching` : '';
  e.replaceChildren(...(n ? [Object.assign(document.createElement('i'), { className: 'i i-eye' }), String(n)] : []));
}
// the panel's "live now" list (refreshed every 15 s; hidden while nothing is live or the feed is unreachable)
// a live match's side, as the live list and the next-match card show it: the character's select icon and moon, then the
// player's name (no name: the character's)
function liveSide(m, p) {
  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  const names = (m.names || []).map(n => (n || '').trim());
  const c = m.chara && m.chara[p], mo = m.moon && m.moon[p], sp = el('span', 'side');
  const ico = el('canvas', 'lico'); ico.width = ico.height = 64;
  ico.dataset.cell = iconCell(c); ico.dataset.side = p;
  const moon = el('canvas', 'lmoon'); moon.width = 14; moon.height = 14;
  if (plArt && iconCell(c) >= 0) { selFrame(ico, iconCell(c), p, 0); drawMoon(moon, mo); sp.append(ico, moon); }
  const nm = el('span', 'lnm');
  nm.append(el('span', 't', names[p] || CHARA[c] || `Player ${p + 1}`));
  sp.append(nm);
  sp.title = `${mo === 9 ? 'Eclipse' : MOON_NAME[mo] || ''} ${CHARA[c] || ''}`.trim();
  return sp;
}
let liveListDeferred = false;
document.addEventListener('visibilitychange', () => { if (!document.hidden && liveListDeferred) { liveListDeferred = false; liveListShow(); } });
async function liveListShow() {
  const sec = document.getElementById('livesec'), ol = document.getElementById('liveitems');
  if (!LIVE_FEED) { sec.hidden = true; return; }
  // a hidden page asks for no list (a phone's radio woken every 15 s for a list nobody sees): asked again once it is back
  if (document.hidden) { liveListDeferred = true; return; }
  let l = [];
  // (a failed fetch, a phone's network dropping one request, keeps the list as it is and asks again in 5 s: it emptied
  // and hid the whole list for 15 s)
  try { l = await liveList(); } catch (e) { if (ol.children.length) { setTimeout(liveListShow, 5000); return; } }
  try { await playersArt(); } catch (e) {}
  sec.hidden = !l.length;
  // a name the watched match didn't have at the join (the list learns it later: the host's GameSetup, a probe) fills in
  // the session's, so the banner and the card show it (was: "Viper" missing for the whole session, user 2026-11-01)
  for (const L of new Set([liveSrc, session && session.liveSrc].filter(Boolean))) {
    const m = l.find(x => liveOurs(x, L)), cur = L.info && L.info.names;
    if (!m || !cur || !m.names) continue;  // (the same id: the same host session, the same players)
    if (cur.some((n, i) => !(n || '').trim() && (m.names[i] || '').trim())) L.info.names = cur.map((n, i) => (n || '').trim() ? n : m.names[i] || '');
  }
  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  // a row whose players haven't changed is kept as it is (a rebuild would restart its names' scrolling mid-way)
  const old = new Map([...ol.children].map(li => [li.dataset.key, li]));
  const badge = (v, n) => { v.title = n ? `${n} watching` : ''; v.replaceChildren(...(n ? [el('i', 'i i-eye'), String(n)] : [])); };
  // (most watched on top, user 2026-11-01; idle hosts last; a tie keeps the order it had, so equal counts never swap)
  const was = new Map([...ol.children].map((li, i) => { try { return [JSON.parse(li.dataset.key)[0], i]; } catch (e) { return [null, i]; } }));
  const at = m => was.has(m.id) ? was.get(m.id) : 1e6 + l.indexOf(m);
  l = [...l.filter(m => !liveIdle(m)), ...l.filter(liveIdle)]
    .map(m => [m, liveIdle(m) ? 1 : 0]).sort((a, b) => a[1] - b[1] || (b[0].viewers || 0) - (a[0].viewers || 0) || at(a[0]) - at(b[0])).map(x => x[0]);
  // FLIP: each kept row's place before the reorder, to slide it from there to its new place
  const before = new Map([...ol.children].map(li => [li, li.getBoundingClientRect().top]));
  const idleTip = m => liveIdle(m) ? `idle: nothing played for ${Math.round(m.age / 60)} min (the host is still open)` : '';
  const rows = l.map(m => {
    const key = JSON.stringify([m.id, m.names, m.chara, m.moon, !!plArt]);
    let li = old.get(key);
    if (li) {
      badge(li.querySelector('.lview'), m.viewers);
      li.className = [liveSrc && liveSrc.id === m.id ? 'cur' : '', liveIdle(m) ? 'idle' : ''].join(' ').trim();
      li.querySelector('a').title = idleTip(m) || m.matchup || (m.names || []).map(n => (n || '').trim()).join(' vs ');
      if (liveSrc && liveSrc.id === m.id) liveWatching(m.viewers);
      return li;
    }
    li = document.createElement('li'); li.dataset.key = key;
    const a = document.createElement('a');
    // (the page's <base> is the site root on the live path: a bare ?live= would leave it)
    a.href = `${location.pathname}?live=${m.id}` + (Q.get('liveUrl') ? `&liveUrl=${encodeURIComponent(Q.get('liveUrl'))}` : '')
      // (a local test page: its chat switches carry over, as chat.js's links do)
      + (/^(127\.0\.0\.1|localhost)$/.test(location.hostname) ? ['chat', 'chatUrl', 'chatAuth', 'lowmem'].filter(k => Q.has(k)).map(k => `&${k}=${encodeURIComponent(Q.get(k))}`).join('') : '');
    const names = (m.names || []).map(n => (n || '').trim());
    a.title = idleTip(m) || m.matchup || names.join(' vs ');
    const side = p => liveSide(m, p);
    const v = el('span', 'lview'); badge(v, m.viewers);
    a.append(side(0), el('span', 'lvs', 'vs'), side(1), v);
    if (liveSrc && liveSrc.id === m.id) { li.className = 'cur'; liveWatching(m.viewers); }
    if (liveIdle(m)) li.classList.add('idle');
    li.append(a);
    return li;
  });
  // (in place: a kept row is never taken out of the list, which would restart its names' scrolling from the start;
  // only rows out of order move)
  rows.forEach((li, i) => { if (ol.children[i] !== li) ol.insertBefore(li, ol.children[i] || null); });
  while (ol.children.length > rows.length) ol.lastElementChild.remove();
  // (a moved row slides to its place; a new one fades in; none under reduced motion)
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches && !document.hidden)
    for (const li of rows) {
      const y0 = before.get(li);
      if (y0 == null) { if (before.size) li.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, easing: 'ease-out' }); continue; }
      const dy = y0 - li.getBoundingClientRect().top;
      if (Math.abs(dy) > 1) li.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 420, easing: 'cubic-bezier(.2,.8,.2,1)' });
    }
  if (!l.some(m => liveSrc && liveSrc.id === m.id)) liveWatching(0);
  marquee(ol, '.lnm:not(.mq)');
  setTimeout(liveListShow, 15000);
}
// the received records by index (each the longest so far), kept outside the game's memory: a seek's keyframe restore
// rolls the game's copy back to what had arrived then, and liveRefeed hands it everything again
function liveKeep(L, b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let o = 0; o + 244 <= b.length;) {
    const n = 244 + 4 * dv.getUint32(o + 240, true), i = dv.getUint32(o, true), old = L.recs.get(i);
    if (o + n > b.length) break;
    if (!old || old.length <= n) L.recs.set(i, b.slice(o, o + n));
    o += n;
  }
}
function liveFeed(s, b) {
  const p = s.M._malloc(b.length);
  s.M.HEAPU8.set(b, p);
  call(s, 'viewer_spectate_feed', p, b.length);
  s.M._free(p);
}
// A live session goes on through the retry menu and the character select (scene 20): their files load with the first
// game (the select screen's parts, portraits and palettes for any character a player hovers, the stage list, the moon
// check's data/<chara>_<moon>.txt (it only stats them, but a missing one changes which moons are offered), its BGM and
// the retry menu's (bgmme98)), and every story/battle/<name>(ex)_table.txt: the select's exit reads both seats' tables
// (CharaSelect_InitSlotBattleBuffer -> StoryMode_LoadBattleTable, one counted RNG draw each when the file is there),
// before the random stage roll; without them the roll picks another stage)
function liveCssFiles(man) {
  const out = new Set();
  for (const p of Object.keys(man.files))
    if (/^(grp\/c_sel_aa|grp\/bgselect|data\/_csel)\//.test(p) || /^data\/[^/]+_\d\.txt$/.test(p) || /^bgm\/bgmme9[89]\./.test(p) ||
        /^story\/battle\/[^/]+_table\.txt$/.test(p)) out.add(p);
  return withSiblings(man, out);
}
// The next game's files, from the select screen's state (read after every frame while it runs): a seat's character once
// it is on the moon disk (CssSlot +0x04 state >= 1, +0x14 chara), its moon from the palette step on (state >= 2, +0x18);
// once the select is finished (scene +0x3C state >= 4: stage chosen) the stage, and for a Random seat the battle slot. Each new
// pick is fetched in the background and put in MEMFS; from the finish on, the game is held (viewer_live_hold: no frame
// steps) until all of them are there. The load comes ~30 frames after the finish (the fade out).
const CSS_SCENE = 20, CSS_OBJ = 0x773158, CSS_SLOT = 0x74D8E8, BATTLE_SLOT = 0x74D838, STAGE_ID = 0x74FD98;
function liveCssWatch(s) {
  const H = s.M.HEAP32, g = a => H[a >> 2];
  // (held only for a game that goes to the select: the players' retry menu choice 'character select' received
  // (liveCssChoice), or the select reached. A rematch reads none of these files: it was held all the same at every
  // result screen until all ~80 MB were in, ~45 s on a phone that joined late in a game, the list meanwhile on the next
  // game, then a fresh start: "they don't work on the phone", 2026-11-01)
  const sc = g(0x54EEE8);
  if (s.cssBgP && !s.cssBgReady && !s.cssBgHeld && (sc === CSS_SCENE || (s.cssChoice && (sc === 5 || call(s, 'viewer_spectate_in_retry'))))) { s.cssBgHeld = true; liveHoldApply(s); }
  if (g(0x54EEE8) !== CSS_SCENE) { if (s.cssHeld) liveCssHold(s, false); s.cssKey = null; return; }
  s.cssPassed = true;  // (the next game's load checks the select's picks against the stream's setup: liveLoaderGate)
  const done = g(CSS_OBJ + 0x3C) >= 4;
  // (the plan's chara keys are "<chara>:<moon>" only: a lookup by the bare id found none, so no pick was ever seen
  // and the next game's files came only at the loader gate, after the VS screen had read its cut-ins: missed)
  const known = c => c >= 0 && Object.keys(man.plan.chara).some(k => k.startsWith(`${c}:`));
  const sides = [0, 1].map(p => {
    const st = g(CSS_SLOT + p * 0x24 + 4), c = g(CSS_SLOT + p * 0x24 + 0x14), m = g(CSS_SLOT + p * 0x24 + 0x18);
    if (st >= 1 && known(c)) return [c, st >= 2 || done ? Math.max(0, m) : null];
    // Random (99): the battle slot's copy, once the select is finished (its moon is copied a frame after the chara)
    return done && known(g(BATTLE_SLOT + p * 0x2C + 8)) ? [g(BATTLE_SLOT + p * 0x2C + 8), Math.max(0, g(BATTLE_SLOT + p * 0x2C + 0x14))] : null;
  });
  // (0: a random stage, rolled as the game loads: liveLoaderGate fetches it)
  const stage = done && g(STAGE_ID) > 0 ? g(STAGE_ID) : null, key = JSON.stringify([stage, sides]);
  if (key !== s.cssKey) {
    s.cssKey = key;
    const want = new Set();
    for (const [i, side] of sides.entries()) {
      if (!side) continue;
      const k = { stage: null, p1: null, p2: null };
      k[i ? 'p2' : 'p1'] = side[1] === null ? null : side;
      // the moon not picked yet: every moon's files (planFiles takes all of them for a moon it has no key for)
      if (side[1] === null) { k[i ? 'p2' : 'p1'] = [side[0], -1]; for (const f of planFiles(man, k)) want.add(f); }
      else for (const f of planFiles(man, k)) want.add(f);
    }
    if (stage !== null) for (const f of planFiles(man, { stage, p1: null, p2: null })) want.add(f);
    s.cssNeed = [...withSiblings(man, want)].filter(p => !liveHas(s, p));
    console.log(`live: next game P1 ${sides[0]} P2 ${sides[1]} stage ${stage}: ${s.cssNeed.length} files to load`);
    const fetching = s.cssFetching || (s.cssFetching = new Set());
    const need = s.cssNeed.filter(p => !fetching.has(p));  // (an earlier pick's download may have them on the way)
    if (need.length) {
      const t0 = performance.now(), b0 = net.bytes;
      for (const p of need) fetching.add(p);
      fetchAll(man, need, 'next game', true)
        .then(() => {
          console.log(`live: ${need.length} next-game files in ${Math.round(performance.now() - t0)} ms (${((net.bytes - b0) / 1e6).toFixed(1)} MB, all downloads)`);
          if (session === s) liveInstall(s, need);
        })
        .catch(e => { console.warn('live: next game files:', e); status(`live: the next game's files did not load (${e.message})`); });
    }
  }
  const ready = s.cssNeed.every(p => liveHas(s, p));
  if (done && !ready !== !!s.cssHeld) liveCssHold(s, !ready);
}
// The game's load starting (web/host/seams_web.cpp g_loaderGate, from VersusIntro): the stage is rolled now (a random
// one is picked only here: the select screen leaves its id 0) and the battle slots are final. Any of the game's files
// not in MEMFS: fetched, the load waits and the game is held until they are (false). The select screen's picks
// (liveCssWatch) usually have them in already.
function liveLoaderGate(s) {
  const H = s.M.HEAP32, g = a => H[a >> 2];
  // After a character select: the game's setup (the bridge's GameSetup for this game, as boot.rep's header) checked
  // against our select's picks first (liveSetupCheck); not known yet: the load waits for it (liveSetupWait)
  if (s.cssPassed) {
    s.cssPassed = false;
    // (the select's index + 1: the game index itself moves there only a frame after the load starts)
    const game = call(s, 'viewer_spectate_next_game'), p = livePrepOf(s, game);
    if (game >= 0 && (!p || !SETUP_WAIT)) { liveSetupWait(s, game); return false; }
    if (p && !liveSetupCheck(s, p)) return false;
  }
  const side = p => [g(BATTLE_SLOT + p * 0x2C + 8), Math.max(0, g(BATTLE_SLOT + p * 0x2C + 0x14))];
  const want = planFiles(man, { stage: g(STAGE_ID), p1: side(0), p2: side(1) });
  const need = [...want].filter(p => !liveHas(s, p));
  if (!need.length) return true;
  if (need.every(p => cache.has(p))) { liveInstall(s, need); return true; }  // (prepared: liveNextPrep)
  console.log(`live: the game's load waits for ${need.length} files (stage ${g(STAGE_ID)})`);
  s.loadNeed = need; s.loadHeld = true; liveHoldApply(s);
  fetchAll(man, need, 'next game', true)
    .then(() => { if (session === s) liveInstall(s, need); })
    .catch(e => { console.warn('live: game files:', e); status(`live: the game's files did not load (${e.message})`); });
  return false;
}
// The next game of the stream, prepared in the background (liveNextPrep: its boot tape from the bridge, every file it
// reads in the page's cache) as soon as the bridge knows its setup (the list's game, or asked for at our own load):
// what the session checks its character select against (liveSetupCheck), and the session switched to when ours did not
// get there (liveSwitch).
const bootSetup = rep => {  // boot.rep's header (cc_live.mjs bootRep): the stage and both sides' chara / moon / palette
  const dv = new DataView(rep.buffer, rep.byteOffset, rep.byteLength), i = o => dv.getInt32(o, true);
  return { stage: i(0x28), chara: [i(0x40), i(0x50)], moon: [i(0x44), i(0x54)], color: [i(0x48), i(0x58)] };
};
// A stage the stock game does not have: a player's own extended bg/BgList.ini (stages 60+, live eD8abT4HcJwn: 62, 66;
// 2 of 746 captures, 2026-11-01). The game's table (BgList_Load 0x4B4A80, Bg_001..Bg_099) has no entry for it and the
// stage load (Stage_LoadBgDat 0x4B6BF0) loads nothing: a black stage and no music. A stock opponent's game never has
// it: their stage select steps through their own list and lands on a stage they have. So: after a select ours stands
// (liveSetupCheck), the same; with no select to follow (a join, a replay) a stand-in, the same one for the same id.
const stageOk = id => id === 0 || !man || !man.files || !!man.files[`bg/bg${String(id).padStart(2, '0')}.dat`];
function stageStandIn(id) {
  const ok = Object.keys(man.files).map(f => /^bg\/bg(\d\d)\.dat$/.exec(f)).filter(Boolean).map(m => +m[1])
    .filter(n => n > 0 && n !== 57 && n !== 58).sort((a, b) => a - b);  // (not the two giant stages: wider)
  return ok.length ? ok[id % ok.length] : 1;
}
function repStageFix(rep) {  // a .rep / boot tape's header stage (0x28), in place
  const dv = new DataView(rep.buffer, rep.byteOffset, rep.byteLength), id = dv.getInt32(0x28, true);
  if (stageOk(id)) return;
  const to = stageStandIn(id);
  console.warn(`stage ${id} is not a stock stage (a modded stage list): stage ${to} stands in`);
  dv.setInt32(0x28, to, true);
}
const livePrepOf = (s, game) => { const p = s.liveSrc.preps && s.liveSrc.preps.get(game); return p && p.ready ? p : null; };
function liveNextPrep(s, game, entry = null) {
  const L = s.liveSrc, preps = L.preps || (L.preps = new Map());
  if (preps.has(game)) return preps.get(game).done;
  for (const g of preps.keys()) if (g < game - 40) preps.delete(g);  // (old games' tapes)
  const p = { game, ready: false };
  preps.set(game, p);
  p.done = (async () => {
    const r = await liveFetch(`${LIVE}/live/${L.id}/boot.rep?game=${game}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    p.rep = new Uint8Array(await r.arrayBuffer());
    p.setup = bootSetup(p.rep);  // (the players' stage as sent: liveSetupCheck keeps ours for one we do not have)
    repStageFix(p.rep);  // (the tape a switch starts from, and its files: a stand-in for a stage we do not have)
    // (the list entry: names, settings, the streak the bridge has for it; else the session's own with this setup)
    p.info = Object.assign({}, entry && entry.game === game ? entry : L.info, p.setup, { game });
    if (!(entry && entry.game === game)) p.info.streak = null;
    p.want = wantFor(p.rep);
    if (p.want) { for (const f of liveCssFiles(man)) p.want.add(f); await fetchAll(man, p.want, 'next game', true); }
    p.ready = true;
    console.log(`live: game ${game} prepared (P1 ${p.setup.chara[0]}:${p.setup.moon[0]} P2 ${p.setup.chara[1]}:${p.setup.moon[1]} stage ${p.setup.stage})`);
    return p;
  })().catch(e => { if (preps.get(game) === p) preps.delete(game); throw e; });
  p.done.catch(() => {});
  return p.done;
}
// the session's game (its battle slots and stage) has this setup: characters, moons, palettes, stage
function liveSameSetup(s, S) {
  const H = s.M.HEAP32, slot = (q, o) => H[(BATTLE_SLOT + q * 0x2C + o) >> 2];
  return (H[STAGE_ID >> 2] === S.stage || !stageOk(S.stage)) && [0, 1].every(q => slot(q, 8) === S.chara[q] && slot(q, 0x14) === S.moon[q] && slot(q, 4) === S.color[q]);
}
// our load after a character select (liveLoaderGate) against the stream's setup of that game: the same characters and
// moons: the stage and palettes set to the stream's (our select's stage pick, a random roll, and the palette step are
// not all followed yet: artifacts/cc_spectate/css_unported.txt) and the game goes on. Other characters or moons: it did
// not follow the players' select: the prepared session takes over (false: the load stays held)
const STAGE_BGM = 0x76E653;  // g_StageBgmId (s8; BattleLoop_StartFightAndRestoreBGM plays it)
const LIVE_TEST_SWITCH = Q.get('liveTestSwitch') === '1';  // (test: every check fails, the switch path runs)
function liveSetupCheck(s, p) {
  const H = s.M.HEAP32, slot = (q, o) => (BATTLE_SLOT + q * 0x2C + o) >> 2, S = p.setup;
  const ours = [0, 1].map(q => [H[slot(q, 8)], H[slot(q, 0x14)]]);
  if (ours.some(([c, m], q) => c !== S.chara[q] || m !== S.moon[q]) || LIVE_TEST_SWITCH) {
    console.warn(`live: our character select picked ${JSON.stringify(ours)}, the players ${JSON.stringify([0, 1].map(q => [S.chara[q], S.moon[q]]))}: switching to game ${p.game}`);
    s.loadHeld = true; s.loadNeed = []; liveHoldApply(s);
    liveSwitch(s, p);
    return false;
  }
  // (a stage our list does not have: ours, from following their select, stands: as on a stock opponent's game)
  if (!stageOk(S.stage)) { console.warn(`live: game ${p.game}: the players' stage ${S.stage} is not a stock stage: ours (${H[STAGE_ID >> 2]}) stands`); S.stage = stageOk(H[STAGE_ID >> 2]) && H[STAGE_ID >> 2] ? H[STAGE_ID >> 2] : stageStandIn(S.stage); }
  if (H[STAGE_ID >> 2] !== S.stage || ours.some((x, q) => H[slot(q, 4)] !== S.color[q]))
    console.log(`live: game ${p.game}: stage ${H[STAGE_ID >> 2]} -> ${S.stage}, palettes ${H[slot(0, 4)]},${H[slot(1, 4)]} -> ${S.color}`);
  // (the battle music: g_StageBgmId, the stage's own unless a pick set another (a replay's playback sets it to the
  // stage id): with the stage when it was our stage's, else our select left the bgm of a stage that isn't loaded)
  if ((s.M.HEAPU8[STAGE_BGM] << 24 >> 24) === H[STAGE_ID >> 2]) s.M.HEAPU8[STAGE_BGM] = S.stage & 255;
  H[STAGE_ID >> 2] = S.stage;
  for (const q of [0, 1]) H[slot(q, 4)] = S.color[q];
  return true;
}
// the setup not known at our load yet (the bridge asks the host for it as the players' game starts): the load waits,
// asked again each second (a host's load and the probe can take ~7 s); none after SETUP_WAIT ms: our own picks, checked
// again once it comes (liveLateCheck)
const SETUP_WAIT = Q.get('liveTestLate') === '1' ? 0 : 20000;  // (test: no wait, the late check runs)
async function liveSetupWait(s, game) {
  s.loadHeld = true; s.loadNeed = []; liveHoldApply(s);
  const t0 = performance.now();
  let p = null;
  while (session === s && !p && performance.now() - t0 < SETUP_WAIT) {
    p = await liveNextPrep(s, game).catch(() => null);
    if (!p) await new Promise(r => setTimeout(r, 1000));
  }
  if (session !== s) return;
  if (p && !liveSetupCheck(s, p)) return;
  if (!p) console.warn(`live: no setup for game ${game} after ${SETUP_WAIT / 1000} s: our own picks`);
  // (the files of the game as it will load now: in the cache from the preparation, else fetched)
  const side = q => [s.M.HEAP32[(BATTLE_SLOT + q * 0x2C + 8) >> 2], Math.max(0, s.M.HEAP32[(BATTLE_SLOT + q * 0x2C + 0x14) >> 2])];
  const need = [...planFiles(man, { stage: s.M.HEAP32[STAGE_ID >> 2], p1: side(0), p2: side(1) })].filter(f => !liveHas(s, f));
  if (need.some(f => !cache.has(f))) await fetchAll(man, need, 'next game', true).catch(e => console.warn('live: game files:', e));
  if (session !== s) return;
  liveInstall(s, need);
  s.loadHeld = false; liveHoldApply(s);
  if (!p) liveLateCheck(s, game);
}
// the setup came later than our load (the bridge's probe slow or retried): our game against it once it is there; any
// difference (characters, moons, palettes, stage): the prepared session of that game, so a select we did not follow
// only ever shows on the select screen, never in the game (asked each second for a minute)
async function liveLateCheck(s, game) {
  const t0 = performance.now();
  let p = null;
  while (session === s && !p && performance.now() - t0 < 60000) {
    p = await liveNextPrep(s, game).catch(() => null);
    if (!p) await new Promise(r => setTimeout(r, 1000));
  }
  if (!p || session !== s) return;
  const H = s.M.HEAP32, slot = (q, o) => H[(BATTLE_SLOT + q * 0x2C + o) >> 2], S = p.setup;
  const same = (H[STAGE_ID >> 2] === S.stage || !stageOk(S.stage)) && [0, 1].every(q => slot(q, 8) === S.chara[q] && slot(q, 0x14) === S.moon[q] && slot(q, 4) === S.color[q]);
  console.log(`live: game ${game}'s setup came after our load: ${same ? 'the same' : 'different: switching'}`);
  if (!same) liveSwitch(s, p);
}
// the players' next game on a new session (prepared: its files in the cache, the instance reused): the picture stays on
// our last frame (no loading movie) until the new one draws. The win streaks go on from ours where the bridge has none.
async function liveSwitch(s, p) {
  if (s.switching || session !== s) return;
  s.switching = true;
  const info = p.info;
  if (!info.streak && s.streakKnown) info.streak = STREAK.map(a => s.M.HEAP32[a >> 2]);
  console.log(`live: on to game ${p.game} (a new session)`);
  liveWant = s.liveSrc.id;
  status('live: on to the next game');
  liveSrc = { id: s.liveSrc.id, info, since: info.game };
  window.__mbaaRepUrl = null;
  await start(new File([p.rep], `LIVE ${(info.names || []).map(n => (n || '').trim()).join(' vs ')}`), true, liveSrc.id);
}
// Live: the players' names on the game's versus banner, instead of CHALLENGER (the streak above them, smaller): drawn
// by the game in its ASCII font (viewer_banner_name: main_browser.cpp banner_draw, a marquee past 20 characters); a
// name with other characters, by the page at the banner's place (#banner0 / #banner1; the streak stays the game's)
const STREAK = [0x76FC14, 0x770EB4];  // g_P1ConsecutiveWinStreak, g_P2ConsecutiveWinStreak (the player records', +0x4A0)
const asciiName = n => /^[\x20-\x7e]*$/.test(n);
// ?tune=1: a panel to fine-tune the banner live (main_browser.cpp BannerTune), also on replays with test names
const TUNE = Q.get('tune') === '1';
const bannerTune = { nameGap: -1, nameSize: 16, nameDy: 0, winsGap: -1, winsSize: 11, winsDy: -11, maxPx: 216, scrollSpeed: 40,
  lapGap: 24, streak: -1, pageFont: 13, testP1: '', testP2: '' };
function liveBanner(s) {
  const T = bannerTune;
  const live = ((s.liveSrc && s.liveSrc.info.names) || []).map(n => (n || '').trim());
  const names = [0, 1].map(p => (TUNE && [T.testP1, T.testP2][p]) || live[p] || '');
  const key = JSON.stringify([names, ui.names, TUNE && T]);
  if (key !== s.bannerKey) {
    s.bannerKey = key;
    call(s, 'viewer_banner_enable', ui.names && (TUNE || names.some(Boolean)) ? 1 : 0);
    slogAdd('names', `banner ${ui.names ? 'on' : 'OFF (the NAMES button)'}: ${names.map(n => n ? JSON.stringify(n) : '(none)').join(' vs ')}`);
    for (const p of [0, 1]) {
      const n = names[p], game = asciiName(n);
      s.M.ccall('viewer_banner_name', null, ['number', 'string', 'number'], [p, game ? n : '', n && !game ? 1 : 0]);
    }
    call(s, 'viewer_banner_tune', T.nameGap, T.nameSize, T.nameDy, T.winsGap, T.winsSize, T.winsDy, T.maxPx, T.scrollSpeed,
      T.lapGap, T.streak);
  }
  const W = document.getElementById('canvas').clientWidth, sc = W / 640;
  for (const p of [0, 1]) {
    const el = document.getElementById(`banner${p}`), n = names[p];
    const y = ui.names && n && !asciiName(n) ? call(s, 'viewer_banner_y', p) : -1000;
    if (y <= -1000) { el.hidden = true; continue; }
    const span = el.firstChild;
    if (span.textContent !== n) span.textContent = n;
    // the game's banner: centred on x 168 / 470, 16 px high from y; marquee past maxPx (as the game-drawn names)
    el.style.setProperty('--bs', (sc * T.pageFont / 13).toFixed(3));
    Object.assign(el.style, { left: `${(p ? 470 : 168) * sc}px`, top: `${(y + T.nameDy + 2) * sc}px`, width: `${T.maxPx * sc}px`,
      textAlign: 'center' });
    el.hidden = false;
    el.classList.toggle('scroll', span.offsetWidth > T.maxPx * sc);
    span.style.animationDuration = `${(span.offsetWidth / sc + T.maxPx) / T.scrollSpeed}s`;  // (the game-drawn speed, px/s)
  }
}
function bannerTunePanel() {
  const T = bannerTune, box = document.createElement('div');
  box.id = 'tunepanel';
  const nums = [['nameGap', 'name: letter gap (px)', -6, 6], ['nameSize', 'name: glyph size', 6, 24], ['nameDy', 'name: y offset', -16, 16],
    ['winsGap', 'wins: letter gap (px)', -6, 6], ['winsSize', 'wins: glyph size', 6, 24], ['winsDy', 'wins: y above name', -30, 10],
    ['maxPx', 'marquee past (px)', 60, 300], ['scrollSpeed', 'marquee: speed (px/s)', 5, 120], ['lapGap', 'marquee: gap between laps (px)', 0, 80],
    ['streak', 'test streak (-1 = real)', -1, 20], ['pageFont', 'page-drawn name: font px', 8, 20]];
  box.innerHTML = '<b>banner tuning</b>' + nums.map(([k, l, lo, hi]) =>
    `<label>${l}<input type="range" min="${lo}" max="${hi}" step="1" data-k="${k}" value="${T[k]}"><output>${T[k]}</output></label>`).join('') +
    '<label>test P1 name<input type="text" data-k="testP1"></label><label>test P2 name<input type="text" data-k="testP2"></label>' +
    '<button type="button">copy values</button>';
  box.addEventListener('input', e => {
    const k = e.target.dataset.k; if (!k) return;
    T[k] = e.target.type === 'range' ? +e.target.value : e.target.value;
    if (e.target.nextElementSibling) e.target.nextElementSibling.textContent = e.target.value;
  });
  box.querySelector('button').onclick = () => {
    const { testP1, testP2, ...v } = T;
    navigator.clipboard.writeText(JSON.stringify(v)).then(() => status('banner values copied'), () => status(JSON.stringify(v)));
  };
  document.body.appendChild(box);
}
if (TUNE) bannerTunePanel();
// The players' win streaks, as the game's own (the banner's "N WINS"; ResultMenu_UpdatePlayerStats counts them on):
// the bridge's for this game (a viewer that knew them sent them), else unknown (from 0, as a CCCaster spectator). Put
// in after viewer_play (CharaSelect_InitReplayMode zeroes them) and before the first frame: the match start copies them
// for the banner (ResetBattleMode: Netplay_GetWinCounts).
function liveSeedStreak(s) {
  if (liveSrc.info.streak) liveSrc.info.streak.forEach((w, p) => { s.M.HEAP32[STREAK[p] >> 2] = w; });
}
// Each game's first battle frame: the streaks it started with, to the bridge (later viewers start from them)
function liveStreak(s) {
  if (!s.streakKnown || s.M.HEAP32[0x54EEE8 >> 2] !== 1) return;
  const g = call(s, 'viewer_spectate_game'), game = g >= 0 ? g : s.liveSrc.info.game;
  if (game === s.streakSent) return;
  s.streakSent = game;
  const w = STREAK.map(a => s.M.HEAP32[a >> 2]);
  fetch(`${LIVE}/live/${s.liveSrc.id}/streak?game=${game}`, { method: 'POST', body: w.join(',') }).catch(() => {});
}
// in MEMFS for the game: in the session's files and not dropped by freeLoaded (low-memory mode; the next game of the
// stream, a rematch above all, reads the same files again)
const liveHas = (s, p) => s.want.has(p) && !s.freed.has(p);
function liveCssHold(s, on) {
  s.cssHeld = on;
  liveHoldApply(s);
}
// the game held (no frame steps) while a next game's files are not in: picked at the select screen, or a rematch's
const liveHoldApply = s => {
  const on = !!(s.cssHeld || s.rematchHeld || s.loadHeld || s.cssBgHeld);
  call(s, 'viewer_live_hold', on ? 1 : 0);
  if (on) status('live: loading the next game');
};
// Low-memory mode: a game's files are freed once it has loaded (freeLoaded); a rematch (the retry menu's choice 0, in
// the stream seconds before the game plays it; the select screen is skipped) reads them all again. They are put back
// as the choice arrives (from the browser's disk cache: warmDisk kept them there), the game held at the retry menu
// until they are in.
function liveRematch(s, b) {
  if (!LOWMEM || !s.freed.size || s.rematchFetch) return;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let rematch = false;
  for (let o = 0; o + 244 <= b.length; o += 244 + 4 * dv.getUint32(o + 240, true))
    if ((dv.getUint32(o + 4, true) >> 8) === 1) rematch = true;  // kind >> 8: the menu choice + 1 (0 = rematch)
  if (!rematch) return;
  const back = [...s.freed];
  s.rematchFetch = fetchAll(man, back, 'rematch', true)
    .then(() => { if (session === s) liveInstall(s, back); })
    .catch(e => { console.warn('live: rematch files:', e); status(`live: the rematch's files did not load (${e.message})`); })
    .finally(() => { s.rematchFetch = null; if (s.rematchHeld) { s.rematchHeld = false; liveHoldApply(s); } });
}
// the players chose 'character select' at the retry menu (kind >> 8: the menu choice + 1; CCCaster MenuIndex 1), seconds
// before the game plays it: from then on the select screen's files (liveCssBg) are needed, and the game waits for them
function liveCssChoice(s, b) {
  if (s.cssBgReady || s.cssChoice) return;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let o = 0; o + 244 <= b.length; o += 244 + 4 * dv.getUint32(o + 240, true))
    if ((dv.getUint32(o + 4, true) >> 8) === 2) { s.cssChoice = true; return; }
}
// fetched files into MEMFS (a stage .dat over its placeholder) and the want list (no miss for them; a freed one is back)
function liveInstall(s, paths) {
  let n = 0, back = 0;
  for (const p of paths) {
    const d = cache.get(p);
    if (!d || liveHas(s, p)) continue;
    if (s.freed.delete(p)) back++;
    fsPut(s.M.FS, '/game/' + p, d); s.want.add(p); n++;
    if (!HASH && !bgmStreamReady && /^bgm\/.*\.opus$/.test(p)) bgmDecode(p);
  }
  if (n) s.M._viewer_resolve_reset();  // (directory listings cached without them)
  // low-memory mode: freed files back (a rematch or a later pick): freed again once the game that reads them has
  // loaded (its first round start after now)
  if (back && LOWMEM) { s.freedAt = -1; s.freeArm = s.M._viewer_frame(); }
  if (s.cssHeld && s.cssNeed.every(p => liveHas(s, p))) liveCssHold(s, false);
  if (s.loadHeld && s.loadNeed.every(p => liveHas(s, p))) { s.loadHeld = false; liveHoldApply(s); }
}
// (each frame, with liveCssWatch) a rematch's files still on the way when the game reaches the retry menu: it waits there
function liveRematchHold(s) {
  const on = !!s.rematchFetch && !!call(s, 'viewer_spectate_in_retry');
  if (on !== !!s.rematchHeld) { s.rematchHeld = on; liveHoldApply(s); }
}
// A file the game looked up that the page did not load: a live session cannot replay from the start (the miss path of
// a replay); it is reported (the plan above must cover it), never retried silently
function liveMissed(s) {
  const l = [...misses];
  misses.clear();
  console.warn(`live: the game asked for ${l.length} files the page did not load:`, l);
  window.mbaaPlanMisses = (window.mbaaPlanMisses || []).concat(l);
  s.liveMissedN = (s.liveMissedN || 0) + l.length;
  status(`live: ${s.liveMissedN} game files were missing (see the console); the picture may be wrong`);
  // fetched now all the same: the game's next look-up of them (the next game, a rematch) finds them
  const want = [...withSiblings(man, new Set(l))].filter(p => !liveHas(s, p));
  if (want.length) fetchAll(man, want, 'missed files', true).then(() => { if (session === s) liveInstall(s, want); }).catch(() => {});
}
function liveRefeed(s) {  // restore(): after the keyframe is back
  const L = s.liveSrc, parts = [...L.recs.keys()].sort((x, y) => x - y).map(i => L.recs.get(i));
  if (!parts.length) return;
  const all = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of parts) all.set(x, o), o += x.length;
  liveFeed(s, all);
}
// live: following the stream (paced, ~LIVE_BEHIND frames behind it); DVR (after a seek, a step or a pause): the replay
// controls on everything received so far, no pacing; the LIVE button goes back
function liveFollow(s, on) {
  s.liveFollow = on;
  if (!on && s.liveFF) { s.liveFF = false; call(s, 'viewer_speed', ui.speed); }
  if (!on && s.liveTrim) { s.liveTrim = false; call(s, 'viewer_rate', 1); }
  document.getElementById('livebtn').classList.toggle('on', on);
}
async function liveGoLive() {
  const s = session;
  if (!s || !s.liveSrc) return;
  if (s.liveSrc.next) return startLive(s.liveSrc.id, s.liveSrc.info.match);  // the game being watched is over: the current one
  if (ui.paused) setPaused(false);
  liveFollow(s, true);
  // (the stream grows while the jump runs: again until it is close)
  for (let k = 0, ahead; k < 4 && (ahead = call(s, 'viewer_spectate_buffered')) > LIVE_BEHIND + 90 && session === s; ++k) {
    await liveCatchUp(s, ahead - LIVE_BEHIND);
  }
}
function liveBegin(s) {  // play(): after viewer_play
  const L = liveSrc;
  s.liveSrc = L;
  s.M.mbaaLoaderGate = () => liveLoaderGate(s);
  s.streakKnown = !!L.info.streak;
  liveSeedStreak(s);
  s.streakSent = -1; s.bannerKey = null;
  L.since = L.info.game;
  L.recs = new Map();
  L.next = false;
  // (the session's finished games' replays, for clip links: liveTapes; a reused instance's older ones go)
  L.tapes = new Map(); L.firstGame = L.info.game; L.clipPend = null;
  try { for (const n of s.M.FS.readdir('/lt')) if (n.endsWith('.rep') || n.endsWith('.lt')) s.M.FS.unlink(`/lt/${n}`); } catch (e) {}
  liveFollow(s, true);
  call(s, 'viewer_spectate_open', L.info.rollback, L.info.winCount);
  // the waits that end on a record (the players' retry menu choice, the host's next index ending the VS screen) end
  // LIVE_BEHIND frames after it arrived, so every game after a result screen starts with the buffer (spectate.cpp
  // arrived_for; was: at the stream's edge, artifacts/xz_check/live_winscreen)
  call(s, 'viewer_spectate_delay', LIVE_BEHIND);
  s.liveHeldSeen = call(s, 'viewer_spectate_held');
  // (an update reload of this match and game: liveResumeTake)
  const R = liveResume;
  liveResume = null;
  if (R && R.id === L.id && (R.match || null) === (L.info.match || null) && R.game === L.info.game) s.liveResumeN = R.ahead;
  const poll = async () => {
    if (session !== s) return;
    try {
      const r = await liveFetch(`${LIVE}/live/${L.id}/rec?from=${L.info.game}&since=${L.since}&v=${VIEWER}`,
        AbortSignal.timeout ? { signal: AbortSignal.timeout(5000) } : undefined);
      // (a 404 is the bridge saying the capture or game is not there: its capture closed (the match over) or the host's
      // id is on another match now: no data, so the stream reads as quiet, not an outage. Was: every 404 restarted the
      // quiet clock, so a session whose match had left the bridge never read as dry and sat frozen)
      if (!r.ok && r.status !== 404) L.failAt = performance.now();
      if (r.ok) {
        const b = new Uint8Array(await r.arrayBuffer());
        // (every answer repeats the newest index whole: new data = a later index or a longer answer, else the stream is
        // quiet, which the dry check below needs to see)
        const last = b.length ? liveLastIndex(b) : -1;
        if (b.length && (last !== L.since || b.length !== L.recLen)) L.dataAt = performance.now();
        L.recLen = b.length;
        if (b.length && session === s) {
          liveKeep(L, b);
          liveFeed(s, b);
          liveRematch(s, b);
          liveCssChoice(s, b);
          L.since = liveLastIndex(b);
        }
      }
    } catch (e) { L.failAt = performance.now(); console.warn('live feed:', e); }
    if (session !== s) return;
    liveTapes(s);
    let ahead = call(s, 'viewer_spectate_buffered');
    // how long the feed has been up and brought nothing new (a failed or timed-out request starts it again: an outage
    // is not the stream going quiet. Was: one 10 s hung request read as "the stream is dry", and with the next game
    // not prepared yet the session was restarted from the list, the streak lost: real1 t=1857)
    const quietFor = performance.now() - Math.max(L.dataAt ?? (L.dataAt = performance.now()), L.failAt ?? -1e9);
    // a Skippable index whose frames ran out, the feed up and quiet 3 s: the players at the result screen (its last
    // frames and the retry menu come with their choice): the game goes on to the win quote (spectate.cpp spectate_ready)
    // (set as soon as the feed is quiet, not once the buffer is low: the game uses it only where the index's frames have
    // run out, and a session LIVE_BEHIND behind gets there after the 3 s, where waiting for the next poll to see the
    // low buffer froze the win pose up to a second)
    const quietSkip = call(s, 'viewer_spectate_quiet', s.liveFollow && quietFor > 3000 ? 1 : 0) === 1 && quietFor > 3000;
    if (s.tl && !s.seeking) s.tl.est = s.M._viewer_frame() + ahead;  // the timeline reaches the newest frame received
    // the buffer's floor over the last LIVE_WIN polls: what the catch-up decisions go by. The stream is bursty: each
    // poll brings ~60 frames at once, and at every round end the host's stream runs ahead (its KO / win pose: ~1.2 s of
    // input messages at twice the rate, ~60-110 frames over real time) then pauses (~1.5 s with no frames while it loads
    // the next round), so the buffer swings ~+100 / -90 frames there and settles back. Judged by the newest sample, the
    // burst set off the 2x fast-forward (and could set off the unrendered jump) right on the KO: a visible hiccup before
    // the win pose (artifacts/xz_check/live_end). A real backlog (a hidden tab, a slow machine, a load) raises the floor too.
    const hist = s.liveAheadHist || (s.liveAheadHist = []);
    hist.push(ahead);
    if (hist.length > LIVE_WIN) hist.shift();
    const floor = Math.min(...hist);
    // the game is over (or, following live, its stream has gone quiet: the players left at the win quote, which CCCaster's
    // spectators never see end): the match's next game, another match when this one has left the list, or wait
    const over = call(s, 'viewer_ended') || L.next;
    const dry = s.liveFollow && ahead < 15 && quietFor > 6000;
    // (following, the list is also read every 5 s for a game the session has not reached: below)
    // (every second outside a battle: the result menu, a character select, a load, where the next game's setup comes)
    // (2 s: each viewer's requests are the feed's 1/s plus this; the list is not rate limited, but every request is a
    // Worker request)
    const listEvery = over || s.M.HEAP32[0x54EEE8 >> 2] !== 1 ? 2000 : 5000;
    if ((over || dry || s.liveFollow) && performance.now() - (L.listAt || -1e9) > listEvery) {
      L.listAt = performance.now();
      try {
        const l = await liveList(), now = l.find(m => m.id === L.id);
        if (session !== s) return;
        // OUR match on the list. A live id is the host's (cc_live.mjs liveId: a hash of its address), not the match's:
        // when a set ends and the same host starts another (a new opponent), the id comes back on the list as that
        // match, with its own match key and game numbers from 2 again. Never our next game: our match is over (user
        // 2026-11-01: Counsel's set with tigre ended, Counsel hosted Inf20 on the same id; the page left, came back to
        // it, and showed the next-match card there)
        const mine = now && liveOurs(now, L) ? now : null, t = performance.now();
        // The end, from evidence that holds up (a list read missing an entry or a host poll that failed is not an end;
        // nor is a quiet stream: players at a result screen): the stream has nothing more for us (ended, or the buffer
        // run down and no new data for 6 s; a 404 feed counts as no data) AND the list has said so: the host is in
        // another match (at once), the list's silent / idle (liveGone: the host's keep-alives stopped) on 3 reads over
        // 5 s, or the match missing from it for 30 s (the bridge's capture closes 30 s after the host goes silent; not
        // while the feed was just down: a restarted bridge re-joins its hosts). Was: one read missing it with the
        // stream quiet showed the card (and its countdown left the match), whatever the reason
        const endSign = !mine || liveGone(mine);
        if (!endSign) { L.endAt = null; L.endReads = 0; }
        else { if (L.endAt == null) L.endAt = t; L.endReads = (L.endReads || 0) + 1; }
        const streamOver = over || (ahead < 15 && quietFor > 6000);
        const ended = streamOver && endSign && (!!now && !mine ||
          (mine ? L.endReads >= 3 && t - L.endAt > 5000 : !liveNet.recent() && t - L.endAt > 30000));
        if (endSign && !L.endSaid) {
          L.endSaid = true;
          slogAdd('live', now && !mine ? `the host is on another match (${liveName(now)}): ours is over` : mine ? `the list has the match silent ${mine.silent} s / idle ${mine.age} s` : 'the match is not on the list');
        }
        if (!endSign) L.endSaid = false;
        if (mine && (over || dry) && mine.index < L.since && liveNet.recent()) {
          return startLive(L.id, L.info.match);  // (after a restart: the bridge's new capture of the match, numbered from its own join)
        } else if (ended) {
          if (!s.liveFollow) { status('the match has ended'); return; }
          // (the next one: the card's countdown with jump to live on, else the card to pick from; or its wait for one)
          status('the match has ended');
          slogAdd('live', 'the match has ended: the next-match card');
          nextCardShow(s, l, 'Match over');
          nextCard.why = null;
          return;
        }
        else if (mine && mine.game !== L.info.game) {
          // the session goes on into the players' next game itself (retry menu, character select, loading; after a
          // character select its load checks the picks against the stream's setup: liveLoaderGate). A newer game on the
          // list it has not reached: prepared in the background at once (liveNextPrep), and switched to (liveSwitch) when
          // the session is not getting there: still at the result / retry menu or the win quote 5 s after the list
          // showed it (a rematch's menu takes ~1-2 s after the choice), or not there by the time its frames to it have played (+3 s). (Before: a fresh start 30 s after
          // the list showed it, the page sitting on the result menu or the select meanwhile.)
          const g0 = call(s, 'viewer_spectate_game'), g = g0 >= 0 ? g0 : L.info.game;  // (-1: still the first)
          const behind = g < mine.game, scene = s.M.HEAP32[0x54EEE8 >> 2];
          if (L.seenGame !== mine.game) { L.seenGame = mine.game; L.seenGameAt = t; L.haveAt = null; L.stuckAt = null; L.lostSaid = false; }
          // the stream as received has the new game (its Loading index): from then on the session should be getting there
          if (L.haveAt == null && L.since >= mine.game) { L.haveAt = t; L.haveAhead = ahead; }
          if (behind && s.liveFollow) liveNextPrep(s, mine.game, mine).catch(e => console.warn(`live: game ${mine.game} not prepared:`, e.message));
          const p = behind ? livePrepOf(s, mine.game) : null;
          const stuckScene = behind && (call(s, 'viewer_spectate_in_retry') || scene === SCENE_WIN);
          if (!stuckScene) L.stuckAt = null; else if (L.stuckAt == null) L.stuckAt = t;
          // LOST: our game did not follow a stream it has: the new game's records received, and the session still at the
          // result / retry menu or the win quote 5 s after both, or not in it by the time those frames played (+3 s). Keyed on
          // the records received, not on the list (the list is ahead of a feed that stalled: real1 t=1857)
          // (+ LIVE_BEHIND: the retry menu takes the players' choice that long after it arrived, viewer_spectate_delay)
          const H = L.haveAt, D = 1000 * LIVE_BEHIND / 60;
          const lost = liveJump() && behind && H != null &&
            ((stuckScene && t - Math.max(L.stuckAt, H) > 5000 + D) || t - H > 1000 * (L.haveAhead / 60 + 3) + D);
          // a rematch (the players' setup unchanged) is followed by the session itself, never switched: only once it has
          // ended (the end of a replayed stream)
          // (not at a character select or the load after one: there the picks decide, and the load checks them)
          const same = p && scene !== 20 && call(s, 'viewer_spectate_next_game') === g0 && liveSameSetup(s, p.setup);
          if (lost && s.liveFollow && !over && !L.lostSaid) {
            L.lostSaid = true;
            console.warn(`live: the list is on game ${mine.game}, this session still on ${g} (scene ${scene}): ` +
              (same ? 'the same setup: waiting for it' : p ? 'switching' : 'preparing it'));
          }
          // (a quiet stream on the game the session is on is the players at its result menu, not an end: nothing to
          // start; restarting that game there replayed it from its start on every long result screen)
          // Only ever forward: to a game of this match newer than the session's (behind). Was: a session whose game had
          // ended (over) restarted the list's game whatever it was, the one being watched included (the same game again
          // from its start)
          if (s.liveFollow && behind && (over || ((dry || lost) && !same))) {
            if (p) return liveSwitch(s, p);
            // (no prepared game: the plain start, once the session is over, or 30 s after the list showed the game)
            if (over || t - L.seenGameAt > 30000) return startLive(L.id, L.info.match);
          }
          if (!s.liveFollow && behind) {
            L.next = true;  // (DVR: stays on this game; LIVE goes to the current one)
            status('live: watching back; the next game is on (LIVE to join it)');
          }
        }
      } catch (e) {}
    }
    if (over) {
    } else if (s.liveFollow) {
      // pace: LIVE_BEHIND frames behind the newest frame received. At the join (the stream starts at the game's start)
      // and whenever the buffer's floor is more than 10 s over (a hidden tab, a slow machine, a load) it jumps
      // there, unrendered as a seek ("jump to live" off: no jump, the game from its start); then normal speed, stalling
      // only when the stream runs dry (until 2 s are buffered again)
      if (ahead > 0) s.liveSynced = true;
      // after an update reload: back where the page was (as many frames short of the stream's newest as then; the
      // stream grown meanwhile: that much later), unrendered, whatever jump to live is (liveResumeTake)
      if (s.liveResumeN != null && s.liveSynced && !s.seeking && !s.cssHeld && !s.loadHeld) {
        const n = ahead - s.liveResumeN;
        s.liveResumeN = null;
        if (n > 0) {
          slogAdd('live', `back where the page was before the update: ${n} frames on`);
          await liveCatchUp(s, n);
          if (session !== s) return;
          ahead = call(s, 'viewer_spectate_buffered');
          hist.length = 0; hist.push(ahead); s.liveJoined = true;
        }
      }
      if (s.liveSynced && liveJump() && !hidden() && !s.cssHeld && !s.loadHeld && !call(s, 'viewer_spectate_in_retry')) {
        // (the stream grows while the jump runs: again until it is close)
        // (at the join: a jump past 2 s over; later only a real backlog, 10 s over the floor: a hidden tab, a load. The
        // stream also drifts ahead ~1-2 s over a few round ends, the host's transitions being shorter than ours: the
        // fast-forward below takes that up, rendered, where a jump cut the sound and skipped the picture at a round end)
        const jumpOver = s.liveJoined ? 600 : 120;
        s.liveJoined = true;
        for (let k = 0; k < 4 && Math.min(ahead, floor) > LIVE_BEHIND + jumpOver && !s.seeking; ++k) {
          await liveCatchUp(s, ahead - LIVE_BEHIND);
          if (session !== s) return;
          ahead = call(s, 'viewer_spectate_buffered');
          hist.length = 0; hist.push(ahead);  // (the floor starts again from where the jump landed)
        }
      }
      // the link card's picture (tools/web/cc_live.mjs): a fight on screen (4 s into the battle scene: past its fade-in;
      // not mid-jump, not dark), as soon as there is one, then every 2 minutes
      const battle = s.M.HEAP32[0x54EEE8 >> 2] === 1;
      if (!battle) s.battleAt = null;
      else if (s.battleAt == null) s.battleAt = performance.now();
      if (s.liveSynced && battle && !hidden() && !s.seeking && performance.now() - s.battleAt > 4000
          && performance.now() - (s.liveThumbAt || -1e9) > 120000 && !cardDark()) {
        s.liveThumbAt = performance.now();
        grabCard().jpeg.then(b => b && fetch(`${LIVE}/live/${L.id}/thumb`, { method: 'POST', body: b }).catch(() => {}));
      }
      // (not at the retry menu: it has no stream frames to count, the players' choice comes when they make it, and
      // CCCaster's spectator never waits there: the game shows the win quote meanwhile)
      // (starved: the game waited for the stream since the last poll, in a battle. ahead is read just after the poll's
      // data went in, so at the stream's edge it was never low here: the game ran dry between polls, ~0.5 s of every
      // second frozen, and the hold that builds 2 s back up never came on)
      slogWatch(s);  // (here too: a stalled game steps no frames, so the frame hook never runs)
      const heldNow = call(s, 'viewer_spectate_held'), starved = heldNow > s.liveHeldSeen && s.M.HEAP32[0x54EEE8 >> 2] === 1;
      s.liveHeldSeen = heldNow;
      // (nor in the last win pose once the players' retry menu choice is in: the game plays the pose out, the win quote
      // and the menu without the stream. Its few frames left read as a low buffer and held the pose ~3 s while the next
      // game's frames built 2 s up: the freeze on the WINNER banner, artifacts/xz_check/live_winscreen after_css_gpu)
      const hold = !call(s, 'viewer_spectate_in_retry') && !quietSkip && !call(s, 'viewer_spectate_match_end') &&
        (ahead < 15 || starved || (s.liveHeld && ahead < 120));
      s.liveHeld = hold;
      call(s, 'viewer_pause', hold || ui.paused || s.seeking ? 1 : 0);
      // up to the jump (or without it): CCCaster's spectateFastFwd, more than 60 frames (2 x NUM_INPUTS) over the kept
      // buffer (its floor: not a burst), two game frames per drawn frame until caught up
      // Pacing: the stream drifts slowly ahead (~1-2 frames a second: each stall's time is not made up). Up to 3 s over
      // the target it is taken up unseen, the clock at 1.05x (63 game frames a second) from 0.5 s over until back on
      // target; 2x (CCCaster's spectateFastFwd, with its badge) only for a real backlog past that. (2x from 1 s over
      // flashed "2x catching up" every 30-40 s all match: artifacts/xz_check/live_catchup)
      const excess = Math.min(ahead, floor) - LIVE_BEHIND;
      const ff = !hold && excess > 180;
      const trim = !hold && !ff && (excess > 30 || (s.liveTrim && excess > 0));
      if (trim !== !!s.liveTrim) { s.liveTrim = trim; call(s, 'viewer_rate', trim ? 1.05 : 1); }
      if (ff !== !!s.liveFF) { s.liveFF = ff; call(s, 'viewer_speed', ff ? 2 : ui.speed); }
      { const b = document.getElementById('ffbadge'); if (b) b.hidden = !ff; }
      if (s.cssHeld || s.loadHeld) status('live: loading the next game');
      else status(hold ? `live: waiting for the stream (${(ahead / 60).toFixed(1)} s buffered)`
                  : `live: ${(ahead / 60).toFixed(1)} s behind the players` + (ff ? ' (catching up)' : ''));
    } else if (!s.seeking) {
      status(`live: watching back, ${(ahead / 60).toFixed(0)} s behind (LIVE to catch up)`);
    }
    setTimeout(poll, liveNet.delay());
  };
  poll();
}
// The next live match once the one watched is over (it left the list, or its host went quiet or idle 5 min: players
// waiting at the result screen are not an end): a card over the picture, "Next: A vs B" with a NEXT_SECS countdown, Go now /
// Stay and the other live matches; nothing live: "waiting", checked every 10 s, and the countdown when one starts.
// Stay: no automatic move for this session (the live list still switches). A switch is in place (startLive: the page,
// its fullscreen and chat stay) and the address follows (?live=). Was: a status line and a jump 2.5 s later.
const NEXT_SECS = 10;
const nextCard = { s: null, id: null, at: 0, timer: 0, raf: 0, stay: null, why: null };
const liveName = m => m.matchup || (m.names || []).map(n => (n || '').trim()).join(' vs ');
function nextCardHide() {
  const el = document.getElementById('nextcard');
  if (el) el.hidden = true;
  clearTimeout(nextCard.timer); cancelAnimationFrame(nextCard.raf);
  nextCard.s = null; nextCard.id = null; nextCard.why = null;
}
function liveGo(id) {
  nextCardHide();
  try {
    const u = new URL(location.href);
    u.searchParams.set('live', id);
    for (const k of ['r', 'rep', 'l', 'i', 'c', 't']) u.searchParams.delete(k);
    history.replaceState(null, '', u);
  } catch (e) {}
  document.body.classList.add('live');
  return startLive(id);
}
// list: the live list as just read (the watched match may be in it). title: what happened ("Match over", ...)
function nextCardShow(s, list, title) {
  if (session !== s || (s && nextCard.stay === s)) return false;  // (s null: a page with no match yet)
  const el = document.getElementById('nextcard');
  if (!el) return false;
  // (the others: every live match but ours; the host's next match on our id is another match, and the likeliest next:
  // it has one of our players)
  const L0 = s ? s.liveSrc : liveSrc, live = list.filter(m => !liveOurs(m, L0) && !liveGone(m));
  const next = liveNextMatch(live, L0);
  // jump to live off: the card to pick from, no countdown (the page never moves to another match by itself)
  const auto = liveJump();
  el.querySelector('.nc-t').textContent = title;
  const row = (m, cls) => {  // (the live list's row: icons, moons, names, watchers)
    const b = document.createElement('button');
    b.className = cls;
    const v = document.createElement('span'); v.className = 'lview';
    if (m.viewers) v.append(Object.assign(document.createElement('i'), { className: 'i i-eye' }), String(m.viewers));
    const vs = document.createElement('span'); vs.className = 'lvs'; vs.textContent = 'vs';
    b.append(liveSide(m, 0), vs, liveSide(m, 1), v);
    b.title = liveName(m);
    b.onclick = e => { e.stopPropagation(); liveGo(m.id); };
    return b;
  };
  const others = el.querySelector('.nc-o');
  others.textContent = '';
  for (const m of live.filter(m => !next || m.id !== next.id).slice(0, 5)) others.append(row(m, 'nc-row'));
  el.querySelector('.nc-ol').hidden = !others.children.length;
  const feat = el.querySelector('.nc-m');
  feat.textContent = '';
  if (next) feat.append(row(next, 'nc-row nc-next'));
  el.querySelector('.nc-go').onclick = e => { e.stopPropagation(); if (nextCard.id) liveGo(nextCard.id); };
  el.querySelector('.nc-stay').onclick = e => { e.stopPropagation(); nextCard.stay = s; nextCardHide(); status('staying on this match (the live list has the others)'); };
  for (const ev of ['pointerdown', 'click', 'touchend']) el['on' + ev] = e => e.stopPropagation();  // (never the picture's)
  el.classList.toggle('wait', !next);
  if (!next) {
    feat.textContent = 'Waiting for the next live match…';
    el.hidden = false;
    if (nextCard.s === s && !nextCard.id) return true;  // (waiting already)
    clearTimeout(nextCard.timer); cancelAnimationFrame(nextCard.raf);
    nextCard.s = s; nextCard.id = null;
    const wait = async () => {
      if (session !== s || nextCard.s !== s || nextCard.id) return;
      const l = await liveList().catch(() => null);
      if (session !== s || nextCard.s !== s) return;
      if (l && l.some(m => !liveOurs(m, L0) && !liveGone(m))) nextCardShow(s, l, title);
      else nextCard.timer = setTimeout(wait, 10000);
    };
    nextCard.timer = setTimeout(wait, 10000);
    return true;
  }
  el.hidden = false;
  if (nextCard.s === s && nextCard.id === next.id && nextCard.auto === auto) return true;  // (counting down to it already)
  clearTimeout(nextCard.timer); cancelAnimationFrame(nextCard.raf);
  nextCard.s = s; nextCard.id = next.id; nextCard.at = performance.now() + NEXT_SECS * 1000; nextCard.auto = auto;
  const bar = el.querySelector('.nc-bar i'), go = el.querySelector('.nc-go');
  el.querySelector('.nc-bar').hidden = !auto;
  if (!auto) { go.textContent = 'Go now'; return true; }
  const tick = () => {
    if (nextCard.s !== s) return;
    const left = Math.max(0, nextCard.at - performance.now());
    bar.style.transform = `scaleX(${left / (NEXT_SECS * 1000)})`;
    go.textContent = `Go now (${Math.ceil(left / 1000)})`;
    nextCard.raf = requestAnimationFrame(tick);
  };
  tick();
  nextCard.timer = setTimeout(() => { if (session === s && nextCard.s === s && nextCard.id) liveGo(nextCard.id); }, NEXT_SECS * 1000);
  return true;
}
// after a match leaves the list: one with either of its players (a new set of theirs), else the most watched
function liveNextMatch(l, L0 = liveSrc) {
  const L = L0 || { id: null, info: {} }, names = new Set((L.info.names || []).map(n => (n || '').trim().toLowerCase()).filter(Boolean));
  const others = l.filter(m => !liveOurs(m, L) && !liveGone(m));
  return others.find(m => (m.names || []).some(n => names.has((n || '').trim().toLowerCase())))
      || others.sort((a, b) => (b.viewers || 0) - (a.viewers || 0))[0] || null;
}
// a local replay is uploaded once (named by its SHA-256, so re-sharing it gives the same link)
async function uploadRep(bytes) {
  const r = await fetch(`${REPLAY_STORE}/rep`, { method: 'POST', body: bytes, headers: { 'Content-Type': 'application/octet-stream' } });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j.id;
}
async function shareId(s) {
  if (s.shareId) return s.shareId;
  const it = pl.items[pl.i];
  if (it && it.id && it.name === s.name) return (s.shareId = it.id);
  return (s.shareId = await uploadRep(s.rep));
}
// a playlist link (?l=<id>): every replay uploaded (once; the store names them by content), then the list itself
async function copyPlaylist() {
  if (pl.items.length < 2) return;
  const shots = session ? grabCard() : null;  // the playlist's link card: what is on screen now
  let text;
  try {
    const items = [];
    for (const [k, it] of pl.items.entries()) {
      status(`uploading playlist ${k + 1}/${pl.items.length}…`);
      if (!it.id) it.id = await uploadRep(new Uint8Array(await (await itemFile(it)).arrayBuffer()));
      items.push({ id: it.id, name: it.name.replace(/\.rep$/i, '') });
    }
    const r = await fetch(`${REPLAY_STORE}/list`, { method: 'POST', body: JSON.stringify({ items }), headers: { 'Content-Type': 'application/json' } });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    const u = new URL(location.origin + location.pathname);
    u.searchParams.set('l', j.id);
    await shareThumb(j.id, 0, shots);
    text = u.toString();
  } catch (e) { console.warn('playlist upload failed:', e); status(`playlist link failed: ${e.message}`); return; }
  try { await navigator.clipboard.writeText(text); status(`copied: ${text}`); }
  catch (e) { prompt('copy:', text); }
}
// the link preview image: the picture as it is now (a 960x480 JPEG card, copyTimestamp), uploaded for (replay, frame); the store's
// Worker puts it in the shared link's preview tags. Best effort: a failed upload only means a preview without a picture.
async function shareThumb(id, f, shots) {
  if (!shots) return;
  const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 5000);
  try {
    const img = await shots.jpeg;
    if (img) await fetch(`${REPLAY_STORE}/thumb/${id}/${f}`, { method: 'POST', body: img, signal: ctl.signal,
                                                               headers: { 'Content-Type': img.type } });
  }
  catch (e) { console.warn('preview image upload failed:', e); }
  finally { clearTimeout(to); }
}
// the picture on screen now: the 640x480 frame centred on a 960x480 dark card (link cards are ~2:1: X crops a 4:3
// image), as JPEG (X does not reliably take WebP). Call it before any await lets playback move on (the GL canvas keeps
// its drawing buffer)
// the game picture's mean brightness under 24 of 255 (a fade, a load, a black stage): not a card
function cardDark() {
  try {
    const c = document.createElement('canvas'); c.width = 32; c.height = 24;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(document.getElementById('canvas'), 0, 0, 32, 24);
    const d = g.getImageData(0, 0, 32, 24).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    return sum / (d.length / 4) < 24;
  } catch (e) { return true; }
}
// link cards (a live match's preview, a shared replay's / playlist's): Steam's own 16:9 layout at 1280x720, P1's sidebar
// portrait at its moon | the picture (960x720) | P2's (web/sidebar/<id>_<l|r>_<moon>.webp, the Steam release's apm_com art:
// tools/web/sidebars_bundle.sh; a character without one: the MELTY BLOOD logo panel, default_<l|r>)
const sideArt = new Map();
function sidebarArt(c, m, p) {
  const sd = p ? 'r' : 'l', id = String(c).padStart(2, '0');
  const path = [`web/sidebar/${id}_${sd}_${m >= 0 && m <= 2 ? m : 0}.webp`, `web/sidebar/default_${sd}.webp`].find(q => man && man.files[q]);
  if (!path) return Promise.resolve(null);
  if (!sideArt.has(path)) sideArt.set(path, (async () => {
    const f = man.files[path];
    return createImageBitmap(new Blob([await fetchObject(f.o, f.z)], { type: 'image/webp' }));
  })().catch(() => { sideArt.delete(path); return null; }));
  return sideArt.get(path);
}
function grabCard() {
  const jpeg = (async () => {
    try {
      const c = document.createElement('canvas'); c.width = 1280; c.height = 720;
      const g = c.getContext('2d'); g.fillStyle = '#12111c'; g.fillRect(0, 0, 1280, 720);
      g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';  // (1.5x: smoothed, as Steam's own 2.25x)
      g.drawImage(document.getElementById('canvas'), 160, 0, 960, 720);  // (now: the picture before any await)
      const H = session && session.M && session.M.HEAP32;
      if (H) {
        const art = await Promise.all([0, 1].map(p => sidebarArt(H[(BSLOT + p * 0x2C + 8) >> 2], H[(BSLOT + p * 0x2C + 0x14) >> 2], p)));
        art.forEach((a, p) => a && g.drawImage(a, p ? 1120 : 0, 0, 160, 720));
      }
      // (the store takes up to 256 KiB, the live feed 300 KB)
      for (const q of [0.88, 0.8, 0.7, 0.6]) {
        const b = await new Promise(r => c.toBlob(r, 'image/jpeg', q));
        if (!b || b.size <= 240 << 10 || q === 0.6) return b;
      }
    } catch (e) { return null; }
  })();
  return { jpeg };
}
async function copyTimestamp() {
  const s = session;
  if (!s) return;
  if (s.liveSrc) return liveClipLink(s);
  const f = s.M._viewer_frame();
  const shots = grabCard();
  const u = new URL(location.origin + location.pathname);
  let text;
  try {
    const m = (window.__mbaaRepUrl || '').match(/\/rep\/([0-9a-f]{64})\.rep$/) || (window.__mbaaRepUrl || '').match(/\/s\/([A-Za-z0-9_-]{8,43})$/);
    if (m) u.searchParams.set('r', m[1]);
    else if (window.__mbaaRepUrl) u.searchParams.set('rep', window.__mbaaRepUrl);
    else { status('uploading replay for the link…'); u.searchParams.set('r', await shareId(s)); }
    // a clip: from its in point to its out point; else from this frame
    const t = s.clip ? s.clip.a : f;
    u.searchParams.set('t', t);
    if (s.clip) u.searchParams.set('e', s.clip.b);
    if (s.clip && loopOn) u.searchParams.set('loop', '1');
    if (u.searchParams.get('r')) await shareThumb(u.searchParams.get('r'), t, shots);
    text = u.toString();
  } catch (e) {
    console.warn('share upload failed:', e);
    text = `${s.name.replace(/^.*\//, '')} @ ${fmtTime(f)} (frame ${f})`;
  }
  window.__mbaaLastLink = text;
  try { await navigator.clipboard.writeText(text); status(`copied: ${text}`); }
  catch (e) { prompt('copy:', text); }
}
function togglePlay() {
  const s = session;
  if (inIntro(s)) return skipIntro(s);
  if (s && s.clip && s.clip.stop && ui.paused && curFrame() >= s.clip.b) { requestSeek(s.clip.a).then(() => setPaused(false)); return; }
  setPaused(!ui.paused);
}
function setPaused(p) {
  ui.paused = p;
  pipFollow();
  if (p && session && session.liveSrc && session.liveFollow) liveFollow(session, false);
  document.querySelector('#pause .i').className = `i ${p ? 'i-play' : 'i-pause'}`;
  const s = session;
  if (!s) return;
  s.mute = p || !!s.seeking;
  if (p) { s.stopSes(); s.bgmHalt(0.35); } else if (!s.seeking) s.bgmSync(s.M._viewer_frame());  // pause: the music fades out
  if (!s.seeking) uiApply(s);
}
const curFrame = () => session ? (session.tl && session.tl.want !== null ? session.tl.want : session.M._viewer_frame()) : 0;
function stepBy(n, pause = true) {
  if (!session || !session.tl) return Promise.resolve();
  if (session.liveSrc && session.liveFollow) liveFollow(session, false);
  if (pause && !ui.paused) setPaused(true);
  if (n === 1 && session.tl.want === null && !session.tl.running) {  // one frame forward: just step
    call(session, 'viewer_step', 1);
    overlayDirty = true;
    return Promise.resolve();
  }
  return requestSeek(curFrame() + n);
}
window.__mbaaSession = () => session;  // tests
window.__mbaaSeek = T => requestSeek(T);  // tests
window.__mbaaMisses = () => [...misses];  // tests (freed files the game opened again; bundle files not fetched)
// live chat (web/shell/chat.js), only on the chat page: the Worker adds <meta name="mbaa-chat"> to it (a local test page:
// ?chat=1 on 127.0.0.1 / localhost); chat.js draws its icons with the player block's art and follows the watched match
window.mbaaChatApi = { art: playersArt, iconCell, chara: CHARA, liveId: () => session && session.liveSrc ? session.liveSrc.id : null,
  // the watched live match for chat.js's per-match channel and comment timeline: the list entry (id, match key), the feed's
  // base, following live or not, the records fed (index -> .ccs record) and the stream frames still ahead of the picture
  // (ahead null: not fed yet, or mid-seek; null: no live match)
  live: () => { const s = session, L = s && s.liveSrc;
    return L && s.M ? { info: L.info, base: LIVE, follow: !!s.liveFollow, recs: L.recs || null,
                        ahead: L.recs && !s.seeking ? call(s, 'viewer_spectate_buffered') : null } : null; },
  // chat's clickable timestamps and link cards: the picture's frame and the last seekable one (null: no timeline yet),
  // a seek (a live match goes to watching back, as any seek), the live list (the feed's /live/list)
  frame: () => session && session.tl ? curFrame() : null, seekMax: () => session && session.tl ? tlMax(session.tl) : null,
  seek: f => requestSeek(f), lives: () => liveList(),
  // chat's !song / ^stage mentions: the catalog (v changes as the lists load), a thumbnail's url, a tap's pick, the older
  // games' lists loaded (their names join the catalog)
  mentions: () => mentionCatalog(), mentionThumb, mentionApply: (kind, it) => mentionApply(kind, it).catch(e => console.warn('chat mention:', e)),
  mentionsMore: () => radioOldLoad().catch(() => null) };
if (document.querySelector('meta[name="mbaa-chat"]') || (/^(127\.0\.0\.1|localhost)$/.test(location.hostname) && Q.has('chat'))) {
  document.body.classList.add('haschat');  // (the chat layout from the start: fitStage)
  const el = document.createElement('script');
  el.src = (document.querySelector('meta[name="mbaa-chatjs"]') || { content: 'chat.js' }).content;
  document.body.append(el);
}
window.mbaaViewer = { startItem: i => startItem(i), card: () => grabCard().jpeg, seek: requestSeek, step: stepBy, pause: setPaused, frame: () => session.M._viewer_frame(),
                      tl: () => session.tl, ui, pl, cacheSize: () => cache.size, cacheMap: () => cache, phone: PHONE, lowmem: LOWMEM, bgmStream: () => bgmStreamReady, audioState: () => [actx && actx.state, session && session.mute, session && session.bgmLog && session.bgmLog.length, ui.paused], bgmMap: () => bgmDecoded, clip: () => session && session.clip,
                      clipFirst: () => clipFirst(session), clipPanel: () => clipPanel,
                      stats: () => { const t = session.tl; return { kfs: t.kfs.length, kfFrames: t.kfs.map(k => k.frame),
                        kfMs: t.kfs.map(k => Math.round(k.ms * 10) / 10), kfFresh: t.kfs.map(k => k.fresh), bytes: t.bytes,
                        memTop: session.M._viewer_mem_top(), heap: session.M.HEAPU8.length, simMax: t.simMax, end: t.end,
                        thinned: t.thinned || 0, page: PAGE, every: KF_EVERY, incDropped: t.incDropped || 0, kfInc: t.kfs.map(k => k.inc ? 1 : 0),
                        marks: t.marks, seekMs: t.seekMs }; } };

// ---- overlay: hitboxes and inputs (read-only) ----
let overlayDirty = true, lastDrawnFrame = -1;
const BOX_STYLE = [  // kind -> [stroke, fill] (colours after the community Extended Training Mode)
  ['#d8d8d8', 'rgba(216,216,216,0.06)'],  // 0 collision / push
  ['#30e030', 'rgba(48,224,48,0.12)'],    // 1 hurt
  ['#ff2828', 'rgba(255,40,40,0.25)'],    // 2 attack
  ['#ff9090', 'rgba(255,40,40,0.06)'],    // 3 attack whose hits are used up
  ['#ffe020', 'rgba(255,224,32,0.25)'],   // 4 clash
  ['#40a0ff', 'rgba(64,160,255,0.25)'],   // 5 shield
  ['#c878e6', 'rgba(200,120,230,0.20)'],  // 6 other special
];
const DRAW_ORDER = [0, 6, 5, 1, 4, 3, 2];
const ARROW = ['·', '↙', '↓', '↘', '←', '·', '→', '↖', '↑', '↗'];
let overlayClear = false;  // (the overlay canvas holds nothing: nothing to clear or place)
function drawOverlay() {
  const c = document.getElementById('overlay'), gc = document.getElementById('canvas');
  // hitboxes and inputs off: one clear when they go off, then nothing per frame (no layout reads, no full-canvas clear)
  if (!ui.boxes && !ui.inputs && !clipChat) {
    if (!overlayClear) { c.getContext('2d').clearRect(0, 0, c.width, c.height); overlayClear = true; }
    return;
  }
  overlayClear = false;
  // (exactly over the picture: in fullscreen the picture is not where a centred overlay would be once the controls
  // column sits beside it)
  const L = `${gc.offsetLeft}px`, T = `${gc.offsetTop}px`;
  if (c.style.left !== L || c.style.top !== T) { c.style.left = L; c.style.top = T; }
  const dpr = window.devicePixelRatio || 1, w = Math.round(gc.clientWidth * dpr), h = Math.round(gc.clientHeight * dpr);
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const g = c.getContext('2d');
  g.clearRect(0, 0, w, h);
  const s = session;
  if (!s || !s.tl || s.seeking) return;
  const M = s.M, sx = w / 640, sy = h / 480;
  if (ui.boxes) {
    const n = M._viewer_box_count(), p = M._viewer_boxes() >> 2, B = M.HEAP32.subarray(p, p + n * 5);
    g.lineWidth = Math.max(1, dpr);
    for (const kind of DRAW_ORDER) {
      const [stroke, fill] = BOX_STYLE[kind];
      g.strokeStyle = stroke; g.fillStyle = fill;
      g.setLineDash(kind === 3 ? [4 * dpr, 3 * dpr] : []);
      for (let i = 0; i < n; i++) {
        if (B[i * 5] !== kind) continue;
        const x = Math.round(B[i * 5 + 1] * sx), y = Math.round(B[i * 5 + 2] * sy);
        const bw = Math.round(B[i * 5 + 3] * sx) - x, bh = Math.round(B[i * 5 + 4] * sy) - y;
        g.fillRect(x, y, bw, bh);
        g.strokeRect(x + 0.5, y + 0.5, bw - 1, bh - 1);
      }
    }
    g.setLineDash([]); g.strokeStyle = '#ffffff';
    for (let i = 0; i < n; i++) {
      if (B[i * 5] !== 7) continue;
      const x = Math.round(B[i * 5 + 1] * sx) + 0.5, y = Math.round(B[i * 5 + 2] * sy) + 0.5, r = 6 * dpr;
      g.beginPath(); g.moveTo(x - r, y); g.lineTo(x + r, y); g.moveTo(x, y - r); g.lineTo(x, y + r); g.stroke();
    }
  }
  if (ui.inputs) {
    const n = M._viewer_input_count(), p = M._viewer_inputs() >> 2, I = M.HEAP32.subarray(p, p + n * 5);
    const fs = Math.round(Math.max(10, 12 * w / 960 / dpr) * dpr);
    g.font = `bold ${fs}px ui-monospace, Consolas, monospace`;
    g.textBaseline = 'top';
    for (let side = 0; side < 2; side++) {
      const runs = [];  // newest first: [dir, buttons, frames]
      for (let i = n - 1; i >= 0; i--) {
        const d = I[i * 5 + 1 + side * 2], b = I[i * 5 + 2 + side * 2], r = runs[runs.length - 1];
        if (r && r[0] === d && r[1] === b) r[2]++;
        else { if (runs.length >= 14) break; runs.push([d, b, 1]); }
      }
      const cw = g.measureText('0000000000').width;
      runs.forEach(([d, b, k], j) => {
        const btn = ['A', 'B', 'C', 'D', 'E', 'F'].filter((_, i) => b & (1 << i)).join('');
        const txt = `${String(k).padStart(3)} ${ARROW[d] || '·'} ${btn}`;
        const x = side ? w - 8 * dpr - cw : 8 * dpr, y = (h * 0.25) + j * (fs + 3 * dpr);
        g.fillStyle = 'rgba(0,0,0,0.5)'; g.fillRect(x - 4 * dpr, y - 2 * dpr, cw + 8 * dpr, fs + 4 * dpr);
        g.fillStyle = j === 0 ? '#ffffff' : '#b8b8c8'; g.fillText(txt, x, y);
      });
    }
  }
  clipChatDraw(g, w, h, M._viewer_frame());  // (a live clip's chat: ?c=)
}

// ---- controls ----
function fmtTime(f) { const sec = f / 60; return `${Math.floor(sec / 60)}:${(sec % 60).toFixed(1).padStart(4, '0')}`; }
let seekDragging = false, marksKey = '';
// (the page writes only what changed: a text or a slider rewritten every display frame costs a style / layout pass on
// phones; the time changes 10 times a second, the slider's fill when it moves a whole pixel, the frame number only
// where it shows)
const uiLast = { time: '', dur: '', fc: '', px: -1, vpx: -1, sw: 0, fcShown: false, measured: false };
// (sizes read on resize, never inside the frame: a layout read after the frame's writes would force a synchronous layout)
const uiMeasure = () => { const sk = document.getElementById('seek'), fc = document.getElementById('fc');
  uiLast.sw = sk ? sk.clientWidth : 0; uiLast.fcShown = !!fc && fc.offsetParent !== null; uiLast.px = uiLast.vpx = -1; };
addEventListener('resize', () => requestAnimationFrame(uiMeasure));
if (window.ResizeObserver) addEventListener('load', () => { const tb = document.querySelector('.tbar'); if (tb) new ResizeObserver(() => uiMeasure()).observe(tb); });
const setText = (id, k, v) => { if (uiLast[k] !== v) { uiLast[k] = v; document.getElementById(id).textContent = v; } };
function uiLoop() {
  const s = session;
  if (s && s.tl) {
    const t = s.tl, f = s.M._viewer_frame(), max = tlMax(t);
    clipTick(s, f);
    if (rec) { try { recTick(s, f); } catch (e) { recFail(e); } }
    const seek = document.getElementById('seek');
    if (+seek.max !== max) seek.max = max;
    // (the slider's value only when its thumb moves a whole pixel: a new value every frame re-laid the thumb every frame)
    if (!uiLast.measured) { uiLast.measured = true; uiMeasure(); }
    if (!seekDragging) {
      const v = t.want !== null ? t.want : f, vpx = Math.round((uiLast.sw || 1000) * v / Math.max(1, max));
      if (vpx !== uiLast.vpx || t.want !== null) { uiLast.vpx = vpx; if (+seek.value !== v) seek.value = v; }
    }
    setText('time', 'time', fmtTime(f));
    setText('dur', 'dur', `/ ${fmtTime(max)}${t.end === null ? '+' : ''}`);
    // (phones hide it; playing, 10 a second is all an eye reads; paused or stepping, every frame)
    if (uiLast.fcShown && !document.body.classList.contains('mob') && (ui.paused || f - (uiLast.fcF ?? -99) >= 6 || f < uiLast.fcF)) {
      uiLast.fcF = f; setText('fc', 'fc', `frame ${f}`);
    }
    const px = Math.round((uiLast.sw || 1000) * seek.value / Math.max(1, max));
    if (px !== uiLast.px) { uiLast.px = px; seek.style.setProperty('--p', `${(100 * seek.value / Math.max(1, max)).toFixed(2)}%`); }
    drawMarks(t, max);
    if (f !== lastDrawnFrame || overlayDirty) { lastDrawnFrame = f; overlayDirty = false; drawOverlay(); }
  }
  requestAnimationFrame(uiLoop);
}
// round starts over the slider; the explored part (seeks inside it restore a keyframe) is shaded
function drawMarks(t, max) {
  const c = session && session.clip;
  const key = `${t.marks.length}/${max}/${Math.round(t.simMax / 60)}/${c ? c.a + ':' + c.b : ''}`;
  if (key === marksKey) return;
  marksKey = key;
  clipUi(max);
  const cv = document.getElementById('marks'), dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(cv.clientWidth * dpr); cv.height = Math.round(cv.clientHeight * dpr);
  const g = cv.getContext('2d');
  g.clearRect(0, 0, cv.width, cv.height);
  g.fillStyle = '#2c3350';
  g.fillRect(0, 0, cv.width * Math.min(1, t.simMax / max), cv.height);
  if (c) { g.fillStyle = 'rgba(80, 200, 255, 0.45)'; g.fillRect(cv.width * c.a / max, 0, Math.max(2, cv.width * (c.b - c.a) / max), cv.height); }
  // A live session (or any replay with several games) as games: a game starts at each round 1, every other game a
  // lighter band, its number (G2, G3, ...) at its start; rounds as short ticks, labelled only where the label fits
  // before the next mark (a long session's "R1 R2 R3 R1 R2 ..." ran together)
  const xs = t.marks.map(([f]) => Math.round(cv.width * f / max)), H = cv.height, room = 22 * dpr;
  const starts = t.marks.map(([, r], i) => r === 0 || i === 0);
  const games = starts.filter(Boolean).length;
  g.font = `${Math.round(10 * dpr)}px system-ui, sans-serif`; g.textBaseline = 'top';
  if (games > 1) {
    let n = 0;
    t.marks.forEach(([f], i) => {
      if (!starts[i]) return;
      n++;
      const x = i === 0 ? 0 : xs[i], end = xs.find((x2, j) => j > i && starts[j]) ?? Math.round(cv.width * Math.min(1, t.simMax / max));
      if (n % 2 === 0) { g.fillStyle = 'rgba(255, 255, 255, 0.07)'; g.fillRect(x, 0, Math.max(0, end - x), H); }
      g.fillStyle = '#ffe9a8';
      g.fillRect(xs[i], 0, Math.max(1, 1.5 * dpr), H);
      if (end - x >= room) { g.font = `600 ${Math.round(10 * dpr)}px system-ui, sans-serif`; g.fillText(`G${n}`, xs[i] + 3 * dpr, 1 * dpr); }
    });
  }
  g.font = `${Math.round(9 * dpr)}px system-ui, sans-serif`;
  t.marks.forEach(([f, r], i) => {
    if (games > 1 && starts[i]) return;
    g.fillStyle = '#ffcc40';
    g.fillRect(xs[i], games > 1 ? H * 0.45 : 0, Math.max(1, dpr), games > 1 ? H * 0.55 : H);
    const next = i + 1 < xs.length ? xs[i + 1] : cv.width;
    if (next - xs[i] >= room) g.fillText(`R${r + 1}`, xs[i] + 2 * dpr, games > 1 ? H * 0.42 : 0);
  });
}
// the seek actions with a key and a button (the bar, the phone sheet): 1 s = 60 frames, 5 s = 300
const ACT = {
  start: () => requestSeek(1),
  end: () => { if (session && session.tl) requestSeek(tlMax(session.tl)); },
  back5: () => stepBy(-300, false), back1s: () => stepBy(-60, false), fwd1s: () => stepBy(60, false), fwd5: () => stepBy(300, false),
};
const VIEW_TOGGLES = ['boxes', 'inputs', 'hud', 'names', 'music'];
function flipView(id) { const el = document.getElementById(id); el.checked = !el.checked; el.onchange(); }
function syncChips() {
  for (const b of document.querySelectorAll('[data-flip]')) {
    const on = document.getElementById(b.dataset.flip).checked;
    b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on));
  }
}
function controls() {
  const seek = document.getElementById('seek');
  seek.addEventListener('pointerdown', () => { seekDragging = true; });
  addEventListener('pointerup', () => { if (seekDragging) { seekDragging = false; seek.blur(); } });
  seek.addEventListener('input', () => requestSeek(+seek.value));
  const btn = (id, fn) => { document.getElementById(id).onclick = e => { fn(); e.currentTarget.blur(); }; };
  btn('pause', () => setPaused(!ui.paused));
  btn('copyt', copyTimestamp);
  const sc = document.getElementById('scale');
  sc.value = scaleMode;
  const segOn = () => document.querySelectorAll('.sizeseg button').forEach(x => x.setAttribute('aria-checked', String(x.dataset.v === scaleMode)));
  sc.onchange = () => { scaleMode = sc.value; try { localStorage.setItem('mbaaScale', scaleMode); } catch (e) {} segOn(); fitStage(); sc.blur(); };
  segOn();
  btn('full', toggleFullscreen); btn('fsx', toggleFullscreen); btn('pip', togglePip);
  document.getElementById('marks').addEventListener('click', e => {
    const s = session;
    if (!s || !s.tl) return;
    const r = e.currentTarget.getBoundingClientRect(), max = tlMax(s.tl), x = (e.clientX - r.left) / r.width * max;
    let best = null;
    for (const [f] of s.tl.marks) if (best === null || Math.abs(f - x) < Math.abs(best - x)) best = f;
    if (best !== null && Math.abs(best - x) / max < 0.04) requestSeek(best); else requestSeek(Math.round(x));
  });
  btn('prevr', () => jumpRound(-1)); btn('nextr', () => jumpRound(1));
  btn('clipnow', clipNow); clipControls();
  btn('clipx', clearClip); btn('cliploop', toggleLoop); btn('clipexp', exportVideo);
  btn('helpb', toggleHelp); btn('helpx', toggleHelp); btn('mute', toggleMute);
  document.getElementById('help').addEventListener('click', e => { if (e.target === e.currentTarget) toggleHelp(); });  // (the backdrop)
  // the seek buttons that are not frame step (the bar's on desktop, the menu sheet's on phones): one action each, as
  // its key does
  for (const el of document.querySelectorAll('[data-act]')) el.onclick = e => { e.currentTarget.blur(); ACT[el.dataset.act](); };
  // the view toggles in the bar: each flips its checkbox (the state, kept in the panel / the phone sheet), as its key does
  for (const el of document.querySelectorAll('[data-flip]')) el.onclick = e => { e.currentTarget.blur(); flipView(el.dataset.flip); };
  btn('plprev', () => startItem(pl.i - 1)); btn('plnext', () => startItem(pl.i + 1)); btn('plshare', copyPlaylist);
  btn('plsort', sortByDate);
  btn('plclear', () => { const cur = pl.items[pl.i]; pl.items = cur ? [cur] : []; pl.i = cur ? 0 : -1; renderPlaylist(); });
  // a click / tap on the picture: during the VS screen it skips it (as a button press does in the game), otherwise
  // it pauses / plays
  const stageEl = document.getElementById('overlay').parentElement;
  const barOver = () => stageEl.classList.contains('fs') || stageEl.classList.contains('ovl');
  stageEl.addEventListener('pointermove', e => { if (barOver() && e.pointerType === 'mouse') fsWake(); });
  // (the desktop overlay, not fullscreen: the bar goes as the mouse leaves the picture, as on YouTube; paused it stays)
  stageEl.addEventListener('pointerleave', e => {
    if (stageEl.classList.contains('ovl') && !stageEl.classList.contains('fs') && e.pointerType === 'mouse' && !ui.paused && !seekDragging && !clipPanel) { clearTimeout(fsTimer); stageEl.classList.add('idle'); }
  });
  stageEl.addEventListener('pointerdown', e => {
    if (e.target.closest('.fsbar')) { fsWake(); return; }  // (the bar's own controls)
    if (e.target.closest('#help')) return;  // (the help over the picture: its own clicks)
    if (e.target.closest('#chatcol')) return;  // (the chat beside the picture in fullscreen: its own clicks)
    // touch: outside fullscreen a tap goes fullscreen; in it, a tap shows / hides the controls over the picture (beside
    // it they stay); pause is a button. A mouse click pauses / plays, as always.
    if (e.pointerType !== 'mouse') {
      if (!stageEl.classList.contains('fs')) { toggleFullscreen(); return; }
      if (stageEl.classList.contains('sidebar')) return;
      if (stageEl.classList.contains('idle')) fsWake(); else { clearTimeout(fsTimer); stageEl.classList.add('idle'); }
      return;
    }
    if (barOver()) fsWake();
    if (e.button > 0 || !session) return;
    if (actx && actx.state !== 'running') return;  // this click only turns sound on (the page-wide unlock handles it)
    togglePlay();
  });
  const si = document.getElementById('skipintro');
  si.checked = ui.skipIntro;
  si.onchange = () => {
    ui.skipIntro = si.checked; try { localStorage.setItem('mbaaSkipIntro', si.checked ? '1' : '0'); } catch (e) {} si.blur();
    if (si.checked && inIntro(session)) skipIntro(session);  // (switched on during the intro: skip this one too)
  };
  btn('back1', () => stepBy(-1)); btn('fwd1', () => stepBy(1));
  document.getElementById('speed').onchange = e => { ui.speed = +e.target.value; if (session) call(session, 'viewer_speed', ui.speed); e.target.blur(); };
  const hudEl = document.getElementById('hud'), musicEl = document.getElementById('music');
  hudEl.checked = ui.hud; musicEl.checked = ui.music;
  hudEl.onchange = () => {
    ui.hud = hudEl.checked; hudEl.blur();
    try { localStorage.setItem('mbaaHud', ui.hud ? '1' : '0'); } catch (e) {}
    const s = session;
    if (s) { call(s, 'viewer_hud', ui.hud ? 1 : 0); if (ui.paused && s.tl) requestSeek(curFrame()); }  // paused: draw the frame again
  };
  musicEl.onchange = () => {
    ui.music = musicEl.checked; musicEl.blur();
    try { localStorage.setItem('mbaaMusic', ui.music ? '1' : '0'); } catch (e) {}
    if (musicGain) musicGain.gain.value = ui.music ? 1 : 0;
  };
  const namesEl = document.getElementById('names');
  namesEl.checked = ui.names;
  namesEl.onchange = () => {
    ui.names = namesEl.checked; namesEl.blur();
    try { localStorage.setItem('mbaaNames', ui.names ? '1' : '0'); } catch (e) {}
  };
  for (const key of ['boxes', 'inputs']) {
    const el = document.getElementById(key);
    el.onchange = () => {
      ui[key] = el.checked;
      if (session && key === 'boxes') { call(session, 'viewer_boxes_enable', ui.boxes ? 1 : 0); if (ui.boxes) call(session, 'viewer_boxes_refresh'); }
      overlayDirty = true; el.blur();
    };
  }
  // (each toggle's chip in the bar follows its checkbox, whoever changed it)
  for (const id of VIEW_TOGGLES) { const el = document.getElementById(id), f = el.onchange; el.onchange = () => { f(); syncChips(); }; }
  syncChips();
  addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const tg = e.target;  // (typing in a text field: its keys, not the shortcuts)
    if (tg && (tg.isContentEditable || tg.tagName === 'TEXTAREA' || (tg.tagName === 'INPUT' && !/^(checkbox|range|radio|button)$/.test(tg.type)))) return;
    const k = e.key;
    const flip = flipView, live = !!(session && session.liveSrc) || document.body.classList.contains('live');
    if (k === ' ') togglePlay();
    else if (k === ',' || k === '<') stepBy(-1);
    else if (k === '.' || k === '>') stepBy(1);
    else if (k === 'ArrowLeft') ACT[e.shiftKey ? 'back5' : 'back1s']();
    else if (k === 'ArrowRight') ACT[e.shiftKey ? 'fwd5' : 'fwd1s']();
    else if (k === 'Home') ACT.start();
    else if (k === 'End') ACT.end();
    else if (k === 'c' || k === 'C') copyTimestamp();
    else if (k === 'f' || k === 'F') toggleFullscreen();
    else if (k === '[' || k === 'PageUp') jumpRound(-1);
    else if (k === ']' || k === 'PageDown') jumpRound(1);
    else if (k === 'x' || k === 'X') clipNow();
    else if (k === '{') setClip('a');
    else if (k === '}') setClip('b');
    else if (k === 'Escape') { if (fx) fx.cancel = true; else if (rec) stopRecording(false); else if (!document.getElementById('help').hidden) toggleHelp(); else if (!document.fullscreenElement && document.querySelector('.stage.fs')) setFs(false); else clearClip(); }
    else if ((k === 'l' || k === 'L') && live) liveGoLive();  // (live: the LIVE button; a replay: loop)
    else if (k === 'l' || k === 'L') toggleLoop();
    else if (k === 'e' || k === 'E') exportVideo();
    else if (k === 'm' || k === 'M') toggleMute();
    else if (k === 'u' || k === 'U') flip('hud');
    else if ((k === 't' || k === 'T') && live) flip('names');
    else if (k === 'b' || k === 'B') flip('music');
    else if (k === '?') toggleHelp();
    else if ((k === 'n' || k === 'N') && !live) startItem(pl.i + 1);  // (the queue: replays only)
    else if ((k === 'o' || k === 'O') && window.mbaaCommentsToggle) window.mbaaCommentsToggle();  // (comments on the picture)
    else if ((k === 'p' || k === 'P') && !live) startItem(pl.i - 1);
    else if (k === 'h' || k === 'H') flip('boxes');
    else if (k === 'i' || k === 'I') flip('inputs');
    else return;
    e.preventDefault();
  });
  requestAnimationFrame(uiLoop);
}

// ?perf=hud: an on-screen readout for measuring a real phone (screenshot it): display rate, game frames a second, the
// engine tick's wall time (game + render), missed frames, long tasks, heaps, the GPU and the picture's size
if (Q.get('perf') === 'hud') (() => {
  const el = document.createElement('pre');
  el.id = 'perfhud';
  el.style.cssText = 'position:fixed;left:4px;top:4px;z-index:9999;margin:0;padding:6px 8px;background:#000c;color:#7f7;font:11px/1.35 ui-monospace,monospace;pointer-events:none;white-space:pre;border-radius:6px';
  document.body.append(el);
  let gpu = '?';
  try { const g = document.createElement('canvas').getContext('webgl2'), x = g && g.getExtension('WEBGL_debug_renderer_info'); gpu = x ? g.getParameter(x.UNMASKED_RENDERER_WEBGL) : g ? g.getParameter(g.RENDERER) : 'none'; } catch (e) {}
  const raf = [], longs = [];
  let last = performance.now();
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) longs.push([e.startTime, e.duration]); }).observe({ type: 'longtask', buffered: false }); } catch (e) {}
  (function tick(t) { raf.push([t, t - last]); last = t; requestAnimationFrame(tick); })(last);
  const pc = (a, q) => { if (!a.length) return 0; const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(q * b.length))]; };
  let f0 = -1, t0 = 0, gfps = 0, missMax = 0;
  setInterval(() => {
    const now = performance.now();
    while (raf.length && raf[0][0] < now - 2000) raf.shift();
    while (longs.length && longs[0][0] < now - 5000) longs.shift();
    const iv = raf.map(r => r[1]), med = pc(iv, 0.5) || 16.7;
    const missed = iv.filter(v => v > Math.max(med, 16.7) * 1.5).length;
    const s = session, M = s && s.M;
    let tk = [], heap = 0, f = -1;
    if (M && M._viewer_tick_ms) {
      const p = M._viewer_tick_ms() / 8, n = Math.min(128, M._viewer_tick_count() >>> 0);
      tk = Array.from(M.HEAPF64.subarray(p, p + n));
      heap = M.HEAP32.buffer.byteLength; f = M._viewer_frame();
    }
    if (f0 >= 0 && f >= f0) gfps = (f - f0) / ((now - t0) / 1000);
    f0 = f; t0 = now;
    const cv = document.getElementById('canvas'), M0 = session && session.M, dm = M0 && M0._viewer_ov_count ? M0._viewer_ov_count() : 0;
    el.textContent = [
      `display ${(1000 / med).toFixed(0)} Hz  rAF p95 ${pc(iv, 0.95).toFixed(1)} ms  missed ${missed}/2s`,
      `game ${gfps.toFixed(1)} fps${ui.paused ? ' (paused)' : ''}  frame ${f}`,
      `tick p50 ${pc(tk, 0.5).toFixed(2)}  p95 ${pc(tk, 0.95).toFixed(2)}  max ${tk.length ? Math.max(...tk).toFixed(1) : 0} ms`,
      `long tasks ${longs.length}/5s  worst ${longs.length ? Math.max(...longs.map(l => l[1])).toFixed(0) : 0} ms`,
      `wasm ${(heap / 1048576).toFixed(0)} MB  js ${performance.memory ? (performance.memory.usedJSHeapSize / 1048576).toFixed(0) + ' MB' : 'n/a'}`,
      `canvas ${cv ? cv.width + 'x' + cv.height : '-'} css ${cv ? cv.clientWidth + 'x' + cv.clientHeight : '-'} dpr ${devicePixelRatio}`,
      `comments ${dm} (native)  lowmem ${typeof LOWMEM !== 'undefined' && LOWMEM ? 1 : 0}`,
      `gpu ${gpu}`.slice(0, 60),
    ].join('\n');
  }, 500);
})();
window.__mbaaPerf = () => {
  const M = session.M, n = call(session, 'viewer_perf_count'), p = call(session, 'viewer_perf_data');
  return Array.from(M.HEAPF64.subarray(p / 8, p / 8 + n));
};

// the files a replay needs (the plan), or everything the page has when the bundle has no plan
function wantFor(rep) {
  if (!man.plan) return null;
  let want = planFiles(man, repKeys(rep));
  // ?planDrop=REGEX (test): leave matching files out of the plan, to exercise the miss -> fetch -> catch-up path
  if (Q.get('planDrop')) { const re = new RegExp(Q.get('planDrop')); want = new Set([...want].filter(f => !re.test(f))); }
  return want;
}
// ---- the VS movie (web/host/vsmovie_frames.cpp): its frames file (the canonical DirectShow decode, lossless, 32 MB)
// stays out of the game's memory, which keyframes and the boot snapshot hold: the page keeps it (Module.mbaaMovie) and
// the game reads a record at a time. Fetched once a match plays, never ahead of one (until it is here the panel stays
// dark: the picture only); a capture run has it before it starts (its pictures are compared with the game's).
const MOVIE = 'dat/dat_m_vs.vsmv';
// The VS movie's frames, fetched once a match plays (the panel stays dark until then; no game state depends on it):
// the lossless file (32 MB: the picture matches CE exactly), or in low-memory mode (phones) the 2 MB H.264 copy of it
// (tools/web/vsmovie/vsmovie_h264.py; lossy), decoded by movieVideo
const MOVIE_H264 = 'dat/dat_m_vs.vsmh';
let movieBytes = null, movieH264 = null, movieLoading = null;
function movieLoad() {
  if (!movieLoading) movieLoading = (async () => {
    const f = man.files[LOWMEM ? MOVIE_H264 : MOVIE];
    if (!f) return;
    if (LOWMEM && !(typeof VideoDecoder !== 'undefined' && (await VideoDecoder.isConfigSupported(movieConfig(new Uint8Array(0)))).supported))
      throw new Error('this browser cannot decode the H.264 movie (WebCodecs)');
    const b = f.plain ? new Uint8Array(await (await fetch(f.plain)).arrayBuffer()) : await fetchObject(f.o, f.z);
    if (LOWMEM) { movieH264 = b; if (session) session.M.mbaaMovieVideo = movieVideo(b); }
    else { movieBytes = b; if (session) session.M.mbaaMovie = b; }
  })().catch(e => { movieLoading = null; console.warn('VS movie:', e); });
  return movieLoading;
}
// the decoder setup of a VSMH file (b empty: the one it is built with, for the support check)
function movieConfig(b) {
  if (!b.length) return { codec: 'avc1.640020', codedWidth: 640, codedHeight: 480 };
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength), u = i => dv.getUint32(i, true), dl = u(24), cl = u(28);
  return { codec: new TextDecoder().decode(b.subarray(32, 32 + cl)), codedWidth: u(8), codedHeight: u(12),
           description: b.slice(32 + cl, 32 + cl + dl), optimizeForLatency: true };
}
// A VSMH file (H.264 samples by frame, a keyframe every `key`) decoded by frame index: frame(f) is frame f's VideoFrame
// once decoded, null until then (the host asks again on its next frame: web/host/browser/d3d9_gl.cpp js_movie_frame).
// Decoding runs AHEAD frames past the one asked for; a jump (a seek, a replay switch) starts again from the keyframe at or
// before f. Frames outside f .. f + AHEAD are closed.
function movieVideo(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength), u = i => dv.getUint32(i, true);
  const cfg = movieConfig(b), n = u(16), key = u(20), tab = 32 + u(28) + u(24), off = i => u(tab + 4 * i);
  const AHEAD = 8, have = new Map();
  let dec = null, next = -1, sent = [], flushed = false;
  const restart = f => {
    if (!dec || dec.state === 'closed')
      dec = new VideoDecoder({ output: fr => { const i = sent.shift(); if (i === undefined) fr.close(); else have.set(i, fr); },
                               error: e => { console.warn('VS movie decode:', e); dec = null; } });
    else dec.reset();
    dec.configure(cfg);
    for (const fr of have.values()) fr.close();
    have.clear(); sent = []; flushed = false;
    next = f - f % key;
  };
  return {
    frame(f) {
      f = Math.min(Math.max(f, 0), n - 1);
      for (const [i, fr] of have) if (i < f || i > f + AHEAD) { fr.close(); have.delete(i); }
      if (!have.has(f) && !sent.includes(f) && (!dec || f < next || f >= next + key)) restart(f);
      while (next < n && next <= f + AHEAD && dec.decodeQueueSize < 16) {
        dec.decode(new EncodedVideoChunk({ type: next % key ? 'delta' : 'key', timestamp: next * 16667, data: b.subarray(off(next), off(next + 1)) }));
        sent.push(next++);
      }
      if (next === n && sent.length && !flushed) { flushed = true; dec.flush().catch(() => {}); }  // (the last frames out)
      return have.get(f) || null;
    },
  };
}
// the loading picture: the game's opening movie (web/shell/opening.webm, from Movie/Original MBAA_OP.mpeg: 640x480 60 fps VP9, artifacts/opening/README.md; no
// sound), fetched the first time a match loads; shown from the first fetch until the game draws
// (user 2026-11-01: it fades in over the last picture and out over the game's first frames, XF_STAGE_MS; hidden and
// paused once faded: nothing composited after)
let loadFadeT = 0;
function loading(on) {
  const v = document.getElementById('loadvid');
  if (HASH || CAPTURE || PERF) return;
  clearTimeout(loadFadeT);
  if (on) {
    if (!v.src) v.src = 'opening.webm?v=640p60';  // (the query: past the edge's copy of the old 480x360 file)
    if (v.hidden && !xfReduced()) { v.classList.add('xfout'); v.hidden = false; requestAnimationFrame(() => requestAnimationFrame(() => v.classList.remove('xfout'))); }
    else { v.hidden = false; v.classList.remove('xfout'); }
    v.play().catch(() => {});
  } else if (!v.hidden) {
    if (xfReduced()) { v.hidden = true; v.pause(); return; }
    // (two frames on: the game's first frame drawn under it; the game is not held back meanwhile)
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (v.hidden) return;
      v.classList.add('xfout');
      loadFadeT = setTimeout(() => { v.hidden = true; v.pause(); v.classList.remove('xfout'); }, XF_STAGE_MS + 60);
    }));
  }
}
// The stage crossfade (user 2026-11-01): a new match / live switch, a radio stage pick. The picture on screen is copied
// (the GL canvas keeps its drawing buffer) into #xfcv, laid over the game canvas; once the new stage is drawn (until():
// true for 2 frames; 4 s at most) it fades out over XF_STAGE_MS and is hidden (display: none, its pixels let go): no
// per-frame work once done, and the game is never held back (it runs and draws under the copy). Reduced motion: a cut.
const XF_STAGE_MS = 350;
let xf = null, xfRuns = 0;
const xfReduced = () => !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
function xfGrab(until) {
  if (HASH || CAPTURE || PERF || xfReduced()) return false;
  const src = document.getElementById('canvas'), c = document.getElementById('xfcv');
  if (!c || !src || !src.offsetWidth || !session) return false;
  if (!xf || xf.fading) {  // (a grab already up: it holds the older picture, which is what was on screen)
    try {
      c.width = src.width; c.height = src.height;
      c.getContext('2d').drawImage(src, 0, 0);
    } catch (e) { return false; }
    Object.assign(c.style, { left: `${src.offsetLeft}px`, top: `${src.offsetTop}px`, width: `${src.offsetWidth}px`,
                             height: `${src.offsetHeight}px`, transition: 'none', opacity: '1' });
    c.hidden = false;
  }
  xf = { until, t0: performance.now(), n: 0 };
  window.__mbaaXf = (window.__mbaaXf || 0) + 1;  // (the checks: grabs made)
  requestAnimationFrame(xfWatch);
  return true;
}
function xfWatch() {
  const me = xf;
  if (!me || me.fading || me.watching === false) return;
  let ok = false;
  try { ok = me.until(); } catch (e) { ok = true; }
  if (ok ? ++me.n >= 2 : performance.now() - me.t0 > 4000) { xfFade(me); return; }
  requestAnimationFrame(xfWatch);
}
function xfFade(me) {
  const c = document.getElementById('xfcv');
  me.fading = true;
  c.style.transition = `opacity ${XF_STAGE_MS}ms ease`;
  requestAnimationFrame(() => { if (xf === me) c.style.opacity = '0'; });
  setTimeout(() => { if (xf !== me) return; xf = null; c.hidden = true; c.width = c.height = 1; }, XF_STAGE_MS + 60);
}
async function start(file, quiet = false, liveId = null) {
  nextCardHide();  // (a new session: any next-match card was the old one's)
  if (quiet && session) { const n0 = xfRuns; xfGrab(() => xfRuns > n0); }  // (the last game's picture, faded into the next's)
  if (!quiet) loading(true);  // (quiet: a live switch, the last game's picture stays until the next one draws)
  // a pick on the radio lasts for its match: a replay's for that replay (a playlist's next, another file has its own
  // music); a live match's for the whole live match (liveId: its next games on a new session, a fallback start), until
  // the viewer changes it or goes to another match (user 2026-11-01)
  if (radioPick && !(liveId && radioLiveId === liveId)) radioSet('');
  if (musicPick && !(liveId && musicLiveId === liveId)) musicSet('');
  xfStagePending = false;  // (the session's start has its own fade)
  if (ensureAudio()) actx.resume();  // (after a drop or file pick: the page has had its gesture)
  const rep = new Uint8Array(await file.arrayBuffer());
  let keys, want;
  try { repKeys(rep); repStageFix(rep); keys = repKeys(rep); want = wantFor(rep); } catch (e) { loading(false); status('error: ' + e.message); return; }
  // live: the select screen's files (every character's portraits and palettes, ~80 MB: they were 80% of a first live
  // join's download, 10-30 s before the first frame) come in the background once the match plays; the retry menu's
  // BGM (small) with the match. liveCssBg holds the game at the result screen if they are not in yet
  const cssBg = want && liveSrc ? [...liveCssFiles(man)].filter(p => !/^bgm\//.test(p)) : null;
  if (want && liveSrc) for (const p of liveCssFiles(man)) if (/^bgm\//.test(p)) want.add(p);
  if (want) {
    status(`stage ${keys.stage}, P1 ${keys.p1[0]}:${keys.p1[1]} vs P2 ${keys.p2[0]}:${keys.p2[1]}: fetching`);
    await fetchAll(man, want, 'match assets');
  }
  window.__mbaaKeys = keys;
  const [, when] = repLabel(file.name);
  document.getElementById('title').textContent = matchTitle(rep) + (when ? ` \u00b7 ${when}` : '');
  const next = pl.items[pl.i + 1];
  if (CAPTURE) await movieLoad();
  await play(rep, file.name, 0, want);
  if (want && next) prefetch(next, want);
  else if (want) for (const p of [...cache.keys()]) if (!want.has(p) && !(cssBg && cssBg.includes(p))) cache.delete(p);  // the last match: the previous one's files go
  if (cssBg && session && session.liveSrc) liveCssBg(session, cssBg);
}
// (live) the select screen's files in the background; until they are in MEMFS the game is held on reaching the result
// screen (scene 5) or the retry menu, where the next select may follow (a match lasts minutes: in practice never held)
function liveCssBg(s, paths) {
  s.cssBgReady = false;
  s.cssBgP = fetchAll(man, paths, '', true)
    .then(() => { if (session !== s) return; liveInstall(s, paths); s.cssBgReady = true; if (s.cssBgHeld) { s.cssBgHeld = false; liveHoldApply(s); } })
    .catch(e => { console.warn('live: select screen files:', e); if (session === s) { s.cssBgP = null; s.cssBgHeld = false; liveHoldApply(s); } });
}
// ---- playlist: several replays played back to back (each from round 1); the next one's files load during play ----
async function prefetch(it, cur) {
  try {
    const nextWant = wantFor(new Uint8Array(await (await itemFile(it)).arrayBuffer()));
    for (const p of [...cache.keys()]) if (!cur.has(p) && !nextWant.has(p)) cache.delete(p);  // the rest stays in Cache Storage
    for (const p of [...bgmDecoded.keys()]) if (!cur.has(p) && !nextWant.has(p)) bgmDecoded.delete(p);  // ~70 MB a track decoded
    for (const p of [...bgmParsedMap.keys()]) if (!cur.has(p) && !nextWant.has(p)) bgmParsedMap.delete(p);
    if (LOWMEM) await warmDisk(man, nextWant); else await fetchAll(man, nextWant, 'next match', true);
  } catch (e) { console.warn('prefetch failed:', e); }
}
// low-memory prefetch: the next match's objects into Cache Storage only (fetchAll reads them from there at the switch)
async function warmDisk(man, paths) {
  await objCacheReady;
  const queue = [...paths].filter(p => !cache.has(p) && man.files[p]);
  async function worker() {
    for (let p; (p = queue.shift());) {
      const f = man.files[p];
      try {
        if (f.plain) { await (await fetch(f.plain)).arrayBuffer(); continue; }  // the HTTP cache keeps it
        const url = `${BUNDLE}o/${f.o.slice(0, 2)}/${f.o}`;
        if (!objCache || await objCache.match(url)) continue;
        const r = await fetch(url);
        if (r.ok) await objCache.put(url, r);
      } catch (e) {}
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker));
}
// a playlist item's replay: a local file, or fetched from the store the first time it is needed
async function itemFile(it) {
  if (!it.file) it.file = new File([await (await fetch(it.url)).arrayBuffer()], it.name);
  return it.file;
}
async function startItem(i) {
  if (i < 0 || i >= pl.items.length) return;
  pl.i = i;
  if (Q.get('l')) {  // a playlist link remembers where it is (a reload, or the browser killing the tab, resumes there)
    const u = new URL(location.href);
    if (i) u.searchParams.set('i', i + 1); else u.searchParams.delete('i');
    for (const k of ['t', 'e', 'loop']) u.searchParams.delete(k);
    history.replaceState(null, '', u);
  }
  window.__mbaaRepUrl = pl.items[i].url || null;
  renderPlaylist();
  try { return start(await itemFile(pl.items[i])); } catch (e) { status(`could not load ${pl.items[i].name}: ${e.message}`); }
}
// the .rep files among dropped / picked files, in name order (replay names carry their date)
function repFiles(files) {
  return [...files].filter(f => /\.rep$/i.test(f.name) || files.length === 1).sort((a, b) => a.name.localeCompare(b.name));
}
// picked / dropped replays join the queue; with nothing playing (or the current replay finished) the first one starts
function loadPlaylist(files) {
  if (!files.length) { status('no .rep files there'); return; }
  const s = session;
  if (!pl.items.length && s) pl.items = [{ name: s.name, file: new File([s.rep], s.name), id: s.shareId }], pl.i = 0;
  const have = new Set(pl.items.map(it => it.name)), add = files.filter(f => !have.has(f.name));
  if (!add.length) { status('already in the queue'); return; }
  const first = pl.items.length;
  pl.items.push(...add.map(f => ({ name: f.name, file: f })));
  if (!s || s.endShown) return startItem(first);
  renderPlaylist();
  status(`added ${add.length} to the queue`);
  if (first === pl.i + 1 && s.want) prefetch(pl.items[first], s.want);
}
function removeItem(k) {
  const playing = k === pl.i;
  pl.items.splice(k, 1);
  if (k < pl.i) pl.i--;
  if (playing) {  // the replay being watched keeps playing until the next one is picked
    pl.i = -1;
  }
  renderPlaylist();
}
function moveItem(from, to) {
  if (from === to) return;
  const cur = pl.items[pl.i], [it] = pl.items.splice(from, 1);
  pl.items.splice(to, 0, it);
  pl.i = pl.items.indexOf(cur);
  renderPlaylist();
}
// the queue by when each replay was recorded (its name's YYMMDDhhmmss: a set in the order it was played); again: newest
// first. Replays without a date keep their order, after the dated ones; the one playing stays the current one.
let plSortDir = 1;
function sortByDate() {
  const when = it => ((it.name || '').replace(/^.*\//, '').match(/_(\d{12})\d{0,2}(?:\.rep)?$/i) || [])[1] || null;
  const cur = pl.items[pl.i];
  const keyed = pl.items.map((it, k) => [when(it), k, it]);
  keyed.sort((a, b) => (a[0] === null) - (b[0] === null) || (a[0] && b[0] && a[0] !== b[0] ? (a[0] < b[0] ? -plSortDir : plSortDir) : a[1] - b[1]));
  pl.items = keyed.map(x => x[2]);
  pl.i = pl.items.indexOf(cur);
  document.getElementById('plsort').title = plSortDir > 0 ? 'sorted oldest first: click for newest first' : 'sorted newest first: click for oldest first';
  plSortDir = -plSortDir;
  renderPlaylist();
}
function renderPlaylist() {
  const many = pl.items.length > 1;
  for (const id of ['plshare', 'plsort', 'plclear']) document.getElementById(id).hidden = !many;
  document.getElementById('plprev').disabled = !(pl.i > 0);
  document.getElementById('plnext').disabled = !(pl.i + 1 < pl.items.length);
  document.getElementById('plpos').textContent = pl.items.length ? `${pl.i + 1 || '\u2013'} / ${pl.items.length}` : '';
  const ol = document.getElementById('plitems');
  let dragFrom = -1;
  ol.replaceChildren(...pl.items.map((it, k) => {
    const li = document.createElement('li'), [nm, when] = repLabel(it.name);
    li.title = it.name; li.className = k === pl.i ? 'cur' : ''; li.draggable = true;
    const a = document.createElement('span'); a.className = 'nm'; a.textContent = nm;
    const d = document.createElement('span'); d.className = 'dt'; d.textContent = when;
    const x = document.createElement('button'); x.title = 'Remove from the queue'; x.innerHTML = '<i class="i i-x"></i>';
    x.onclick = e => { e.stopPropagation(); removeItem(k); };
    const g = document.createElement('span'); g.className = 'grip'; g.title = 'Drag to reorder'; g.textContent = '\u2807\u2807';
    li.append(g, a, d, x);
    li.onclick = () => startItem(k);
    li.ondragstart = e => { dragFrom = k; li.classList.add('drag'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', ''); };
    li.ondragend = () => li.classList.remove('drag');
    li.ondragover = e => { if (dragFrom < 0) return; e.preventDefault(); e.stopPropagation(); li.classList.add('over'); };
    li.ondragleave = () => li.classList.remove('over');
    li.ondrop = e => { if (dragFrom < 0) return; e.preventDefault(); e.stopPropagation(); moveItem(dragFrom, k); };
    return li;
  }));
  const cur = ol.children[pl.i];
  if (cur) cur.scrollIntoView({ block: 'nearest' });
}
// ---- clips: an in / out range; a clip link plays just that range and stops ----
function setClip(which) {
  const s = session;
  if (!s || !s.tl) return;
  const f = curFrame(), c = s.clip || { a: 1, b: tlMax(s.tl), stop: false, round: true };
  // an in point alone ends the clip with its round (the out point, once set, is kept)
  if (which === 'a') { c.a = f; if (c.round || c.b <= f) Object.assign(c, roundClip(s, f), { a: f }); }
  else { c.b = f; c.round = false; if (c.a >= f) c.a = 1; }
  s.clip = c; marksKey = '';
  status(c.round ? `clip from ${fmtTime(c.a)} to the end of the round: } sets an out point, E saves it as a video`
                 : `clip ${fmtTime(c.a)} – ${fmtTime(c.b)} (${((c.b - c.a) / 60).toFixed(1)} s): C copies a link, E saves a video`);
}
// loop: playing past the clip's out point jumps back to its in point (with no clip set yet, L loops the current round)
let loopOn = false;
function roundClip(s, f = curFrame()) {
  const m = s.tl.marks, k = m.findIndex(x => x[0] > f);
  const a = k > 0 ? m[k - 1][0] : k === 0 ? 1 : (m.length ? m[m.length - 1][0] : 1);
  return { a, b: k >= 0 ? m[k][0] - 1 : tlMax(s.tl), stop: false, round: true };
}
function toggleLoop() {
  loopOn = !loopOn;
  document.getElementById('cliploop').classList.toggle('on', loopOn);
  const s = session;
  if (loopOn && s && s.tl && !s.clip) { s.clip = roundClip(s); marksKey = ''; }  // no clip: the round being watched
  if (s && s.clip) status(loopOn ? `looping ${fmtTime(s.clip.a)} – ${fmtTime(s.clip.b)}` : 'playing');
}
let unmuted = 100;
function toggleMute() {
  const vol = document.getElementById('vol');
  if (+vol.value > 0) { unmuted = +vol.value; vol.value = 0; } else vol.value = unmuted || 100;
  vol.dispatchEvent(new Event('input'));
}
function toggleHelp() {
  const h = document.getElementById('help');
  h.hidden = !h.hidden;
  if (!h.hidden) { const st = document.querySelector('.stage'); if (st.classList.contains('fs')) fsWake(); }
}
function clearClip() {
  const s = session, c = s && s.clip;
  if (c) { s.clip = null; marksKey = ''; status('playing'); }
  clipPanelShow(false);
  if (c && c.wasLive && s.liveSrc) liveGoLive();  // (a clip taken while following live: back to live)
}
// a clip being played stops at its out point; play again from there starts it over
function clipTick(s, f) {
  const c = s.clip;
  if (!c || rec || fx || ui.paused || s.seeking || (s.tl && s.tl.running)) return;
  if (c.round && s.tl) {  // a looped round ends where the next one starts, once the pre-scan has found it
    const next = s.tl.marks.find(x => x[0] > c.a), b = next ? next[0] - 1 : tlMax(s.tl);
    if (b !== c.b) { c.b = b; marksKey = ''; }
  }
  if ((loopOn || (c.preview && clipPanel)) && !clipDrag && f >= c.b) { requestSeek(c.a); return; }
  if (!c.stop) return;
  if (f >= c.b) { setPaused(true); if (f > c.b) requestSeek(c.b); status(`clip end (${fmtTime(c.a)} – ${fmtTime(c.b)}): Space plays it again`); }
}

// ---- clip that: one button / key (X) takes the last CLIP_LEN frames up to the frame on screen (clamped to the first
// frame there is; live: up to the newest frame shown) and opens the clip panel: the range as two handles over the
// timeline (drag them, or nudge a frame at a time), a looped preview while the panel is open, and Copy link / Save MP4 /
// Clear. The handles and the panel's text change only when the clip does (drawMarks -> clipUi), never per frame.
const CLIP_LEN = 1800;  // 30 s
let clipPanel = false, clipPanelKey = '', clipDrag = null;
const clipFirst = s => Math.max(1, s.tl.kfs.length ? s.tl.kfs[0].frame : 1);  // (the earliest frame a seek reaches)
const clipLast = s => s.liveSrc ? Math.max(s.tl.simMax, s.M._viewer_frame()) : tlMax(s.tl);
const clipIsLive = s => !!(s && s.liveSrc) || document.body.classList.contains('live');
function clipNow() {
  const s = session;
  if (!s || !s.tl || fx || rec) return;
  document.body.classList.remove('sheet');  // (phones: taken from the menu sheet; the panel is over the picture)
  const lo = clipFirst(s), b = Math.max(lo + 1, s.liveSrc ? s.M._viewer_frame() : curFrame()), a = Math.max(lo, b - CLIP_LEN);
  s.clip = { a, b, stop: false, round: false, preview: true, wasLive: !!(s.liveSrc && s.liveFollow) };
  if (s.liveSrc) Object.assign(s.clip, liveClipWhere(s));
  marksKey = '';
  clipPanelShow(true);
  status(`clip ${fmtTime(a)} – ${fmtTime(b)} (${((b - a) / 60).toFixed(1)} s): drag the handles to trim; ` +
         (clipIsLive(s) ? (liveClipCan() ? 'Copy link (C) saves this game as a replay, Save MP4 (E), Esc clears' : `Save MP4 (E) keeps it; ${LIVE_SIGNIN}`)
                        : 'Copy link (C), Save MP4 (E), Esc clears'));
  requestSeek(a).then(() => { if (session === s && s.clip && s.clip.preview && clipPanel && !clipDrag) setPaused(false); });
}
function clipPanelShow(on) {
  clipPanel = on; clipPanelKey = '';
  document.getElementById('clippanel').hidden = !on;
  document.getElementById('cliph').hidden = !on;
  document.getElementById('clipnow').classList.toggle('on', on);
  marksKey = '';
  if (on && document.querySelector('.stage.fs')) fsWake();
}
// the handles' places and the panel's text (from drawMarks, when the timeline's key changed)
function clipUi(max) {
  if (!clipPanel) return;
  const s = session, c = s && s.clip;
  if (!c) { clipPanelShow(false); return; }
  const pa = `${(100 * c.a / Math.max(1, max)).toFixed(3)}%`, pb = `${(100 * c.b / Math.max(1, max)).toFixed(3)}%`;
  const ha = document.getElementById('chA'), hb = document.getElementById('chB');
  if (ha.style.left !== pa) ha.style.left = pa;
  if (hb.style.left !== pb) hb.style.left = pb;
  const live = clipIsLive(s), can = live && liveClipCan(), pend = live && liveClipPending(s), key = `${c.a}:${c.b}:${live}:${can}:${pend}`;
  if (key === clipPanelKey) return;
  clipPanelKey = key;
  document.getElementById('cpa').textContent = fmtTime(c.a);
  document.getElementById('cpb').textContent = fmtTime(c.b);
  document.getElementById('cplen').textContent = `${((c.b - c.a) / 60).toFixed(1)} s`;
  ha.setAttribute('aria-valuenow', c.a); ha.setAttribute('aria-valuetext', fmtTime(c.a));
  hb.setAttribute('aria-valuenow', c.b); hb.setAttribute('aria-valuetext', fmtTime(c.b));
  const link = document.getElementById('cplink');
  link.disabled = live && !can;
  link.title = !live ? 'Copy a link that plays just this clip (C)'
             : !can ? `Copy link: ${LIVE_SIGNIN}`
             : pend ? 'Copy link: waiting for this game to end (its replay is saved then); the link is copied when it is ready'
             : 'Copy a link to this clip (C): this game is saved as a replay (once, whoever clips it) with the chat said during the clip';
  link.classList.toggle('pend', !!pend);
}
// move an end of the clip (w: 'a' in, 'b' out) to frame f, kept inside what there is and at least a frame long
function clipSet(w, f, seek) {
  const s = session, c = s && s.clip;
  if (!c || !s.tl) return;
  if (w === 'a') c.a = Math.max(clipFirst(s), Math.min(Math.round(f), c.b - 1));
  else c.b = Math.min(clipLast(s), Math.max(Math.round(f), c.a + 1));
  c.round = false; marksKey = '';
  if (seek) requestSeek(c[w]);
}
// a frame-accurate nudge: pauses on the moved end's frame
function clipNudge(w, d) {
  if (!session || !session.clip) return;
  if (!ui.paused) setPaused(true);
  clipSet(w, session.clip[w] + d, true);
}
// after a drag: the preview goes on from the in point (or just before the out point), if it was playing
function clipResume(w, playing) {
  const s = session, c = s && s.clip;
  if (!c || !playing) return;
  requestSeek(w === 'a' ? c.a : Math.max(c.a, c.b - 90)).then(() => { if (session === s && s.clip && clipPanel && !clipDrag) setPaused(false); });
}
function clipControls() {
  const tl = document.querySelector('#transportsec .timeline');
  for (const [id, w] of [['chA', 'a'], ['chB', 'b']]) {
    const h = document.getElementById(id);
    const at = e => { const r = tl.getBoundingClientRect(); return (e.clientX - r.left) / Math.max(1, r.width) * tlMax(session.tl); };
    h.addEventListener('pointerdown', e => {
      const s = session;
      if (!s || !s.clip || !s.tl || e.button > 0) return;
      e.preventDefault(); e.stopPropagation();
      try { h.setPointerCapture(e.pointerId); } catch (err) {}
      clipDrag = { w, playing: !ui.paused, id: e.pointerId };
      if (!ui.paused) setPaused(true);
      h.classList.add('drag');
    });
    h.addEventListener('pointermove', e => {
      if (!clipDrag || clipDrag.w !== w || clipDrag.id !== e.pointerId || !session || !session.tl) return;
      clipSet(w, at(e), true);
    });
    const end = e => {
      if (!clipDrag || clipDrag.w !== w || clipDrag.id !== e.pointerId) return;
      const d = clipDrag; clipDrag = null; h.classList.remove('drag');
      clipResume(d.w, d.playing);
    };
    h.addEventListener('pointerup', end); h.addEventListener('pointercancel', end);
    h.addEventListener('keydown', e => {  // (a focused handle: arrows nudge it, 1 frame; Shift 1 s)
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault(); e.stopPropagation();
      clipNudge(w, (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 60 : 1));
    });
  }
  for (const b of document.querySelectorAll('#clippanel [data-nudge]')) {
    b.onclick = e => { e.currentTarget.blur(); const [w, d] = b.dataset.nudge.split(','); clipNudge(w, +d); };
  }
  const on = (id, f) => { document.getElementById(id).onclick = e => { e.currentTarget.blur(); f(); }; };
  on('cplink', copyTimestamp); on('cpsave', exportVideo); on('cpclear', clearClip);
}

// ---- live clip links: a clip of a live match as a replay link (?r=<id>&t=<in>&e=<out>&c=<clip id>&loop=1) ----
// The game itself keeps a finished game's replay: the session plays the stream in record mode, and at the game's retry
// menu web/host/spectate.cpp tape_keep writes the game's own tape to MEMFS /lt/g<game>_f<battle start>_e<end>.rep
// (game: its Loading index, -1 the session's first). liveTapes moves it into the page (L.tapes; nothing leaves the page
// otherwise). Copy link on a live clip (signed-in chat accounts only): the game's tape and the chat said during the clip
// go to the Worker (POST <chat path>/clip, tools/web/replay_worker.js liveClip): the replay is stored in the replay
// store like a shared one (named by its content: one stored replay per game however many clip it), with the players'
// names in its PCRM block, and the clip's chat as a small JSON (c/<id>) the link names. A game still being played: the
// link is made when it ends (the clip panel says so; the link is copied, or C copies it, once it is there).
// Frames: a replay's battle starts at viewer frame REP_BATTLE_AT (the VS screen's 9.4 s first; every replay:
// harness-design/web_parity/viewer_tools/rep_battle_start_probe.py), the session's at the tape's recFrame + 1 (a live boot
// goes straight to battle, a rematch after its retry menu and VS screen): replay frame = live frame - recFrame - 1 + REP_BATTLE_AT.
const REP_BATTLE_AT = 566;
const LIVE_SIGNIN = 'sign in to share live clips (the chat’s Sign in)';
const liveClipCan = () => { const C = window.mbaaChat; return !!(C && C.irc && C.irc.account); };
const liveClipPending = s => !!(s && s.liveSrc && s.liveSrc.clipPend && s.clip && s.liveSrc.clipPend.clip === s.clip);
// the game at the clip and the chat timeline's local frame - viewer frame (clipNow: the picture is at the clip's out point)
function liveClipWhere(s) {
  const L = s.liveSrc, g = call(s, 'viewer_spectate_game'), out = { game: g >= 0 ? g : L.firstGame, loc0: null };
  // (the chat's local frame: the stream frames fed (each record's u32 at 240) less those still ahead of the picture,
  // chat.js nowOf; worked out here, as mbaaChatApi.live() gives no buffer count mid-seek)
  if (L.recs && L.recs.size) {
    let total = 0;
    for (const b of L.recs.values()) if (b.length >= 244) total += new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(240, true);
    out.loc0 = Math.max(0, total - call(s, 'viewer_spectate_buffered')) - s.M._viewer_frame();
  }
  return out;
}
function liveTapes(s) {
  const L = s.liveSrc;
  if (!L || !s.M) return;
  let names = [];
  try { names = s.M.FS.readdir('/lt'); } catch (e) { return; }
  for (const n of names) {
    const m = n.match(/^g(-?\d+)_f(\d+)_e(\d+)\.rep$/);
    if (!m) continue;
    let rep = null, lt = null;
    try { rep = s.M.FS.readFile(`/lt/${n}`); s.M.FS.unlink(`/lt/${n}`); } catch (e) { continue; }
    // (its live forcing, <stem>.lt, written before it: what the session did to the game from outside its frames, which a
    // replay of the tape needs to play what the session showed: web/host/live_tape.cpp)
    const ltn = `/lt/${n.slice(0, -4)}.lt`;
    try { lt = s.M.FS.readFile(ltn); s.M.FS.unlink(ltn); } catch (e) {}
    const g = +m[1] < 0 ? L.firstGame : +m[1];
    const old = L.tapes.get(g);
    if (!old) console.log(`live: game ${g}'s replay kept (${rep.length} bytes, live forcing ${lt ? lt.length : 0} bytes, battle from frame ${m[2]}, end ${m[3]})`);
    if (!old || !old.id) L.tapes.set(g, { rep, lt, rec: +m[2], end: +m[3] });
  }
  const p = L.clipPend;
  if (p && L.tapes.has(p.game) && !p.busy) liveClipUpload(s, p);
  const can = liveClipCan();
  if (can !== L.clipCan) { L.clipCan = can; clipPanelKey = ''; marksKey = ''; }
}
// the chat lines said during the clip (#melty and the match channel): each placed at its stream position (+mbaa/at, else
// its server time on the capture's clock), as the overlay places them; [{o: frames after the clip's in point, n: name,
// x: text as on the picture, m: Niconico commands, c: the sender's colour, a: 1 an action}]. Nothing else of a line.
async function liveClipChat(s, c) {
  const C = window.mbaaChat, lv = window.mbaaChatApi.live(), L = s.liveSrc;
  if (!C || !lv || !lv.recs || c.loc0 == null) return [];
  const idx = C.nowOf({ ...lv, ahead: 0 }).idx;
  let clock = C.tl && C.tl.clock;
  try { const r = await fetch(`${LIVE}/live/${L.id}/clock`, { cache: 'no-store' }); if (r.ok) clock = await r.json(); } catch (e) {}
  const st = C.status(), want = ['#melty', st.matchChan].filter(Boolean).map(n => n.toLowerCase()), out = [];
  for (const ch of C.chans.values()) {
    if (!want.includes(String(ch.name).toLowerCase())) continue;
    for (const l of ch.lines) {
      if (l.sys || l.gone) continue;
      const pic = String((l.pic != null ? l.pic : l.text) || ''), x = l.action ? pic : pic.replace(/^(@\S+[:,]?\s*)+/, '').trim();
      if (!x) continue;
      const pos = l.at || C.clockPos(clock, +l.time);
      const loc = pos ? C.localOf(idx, pos) : null;
      if (loc == null) continue;
      const f = loc - c.loc0;
      if (f < c.a || f > c.b) continue;
      out.push({ o: f - c.a, n: String(l.nick || '').slice(0, 40), x: x.slice(0, 300), m: String(l.cmd || '').slice(0, 80),
                 c: /^#[0-9a-f]{6}$/i.test(l.color || '') ? l.color : '', a: l.action ? 1 : 0 });
    }
  }
  return out.sort((p, q) => p.o - q.o).slice(0, 500);
}
async function liveClipLink(s) {
  const L = s.liveSrc, c = s.clip;
  if (!c) { status('live: take a clip (X) to share a moment of a live match'); return; }
  if (!liveClipCan()) { status(`live clip: ${LIVE_SIGNIN}`); return; }
  if (L.clipPend && L.clipPend.clip === c) {  // (its link is there: copy it now, a click being a user gesture)
    if (L.clipPend.link) return liveClipCopy(L.clipPend.link);
    status('live clip: the link is made when this game ends (its replay is saved then): Esc to watch on, it is copied then');
    return;
  }
  const p = { clip: c, game: c.game, a: c.a, b: c.b, chat: await liveClipChat(s, c), link: null, busy: false };
  L.clipPend = p; clipPanelKey = ''; marksKey = '';
  liveTapes(s);
  if (!L.tapes.has(p.game) && !p.busy)
    status('live clip: the link is made when this game ends (its replay is saved then): Esc to watch on, it is copied then');
}
async function liveClipUpload(s, p) {
  const L = s.liveSrc, T = L.tapes.get(p.game);
  p.busy = true;
  status('live clip: saving the game as a replay…');
  try {
    // frames in the replay: anchored at the battle's first frame (the session's frame T.rec + 1: T.rec is the 0-based
    // step the game went to record mode at; the replay's REP_BATTLE_AT). With the game's live forcing (T.lt) the replay
    // then plays the session's frames exactly, rounds, intros and win poses included (live_clip_link_check: clipFix moves 0)
    const off = T.rec + 1 - REP_BATTLE_AT;
    const t = Math.max(1, p.a - off), e = Math.max(t + 1, Math.min(T.end - off, p.b - off));
    const rep = T.rep.slice();
    // the header's date: the game's start on the capture's clock (the same for every viewer: one stored replay per game)
    try {
      const r = await fetch(`${LIVE}/live/${L.id}/clock`, { cache: 'no-store' });
      const k = r.ok ? await r.json() : null, at = k && k.wall != null ? k.s.find(x => x[1] >= p.game) : null;
      if (at) {
        const d = new Date(k.wall + at[0]), dv = new DataView(rep.buffer);
        [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()].forEach((v, i) => dv.setUint16(0x18 + 2 * i, v, true));
      }
    } catch (err) {}
    const b64 = u => { let bin = ''; for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(bin); };
    const chat = p.chat.map(x => ({ ...x, o: x.o + (p.a - off - t) })).filter(x => x.o >= 0 && x.o <= e - t);
    // the clip by the game's fight starts (k: the round's fight, da / db: frames after its start), which the link's page
    // turns into its own frames (clipFix): t / e above are the estimate the link carries
    const fights = s.tl.fights.filter(f => f >= T.rec && f <= T.end), k = Math.max(0, fights.filter(f => f <= p.a).length - 1);
    const at = fights.length ? { k, da: p.a - fights[k], db: p.b - fights[k] } : null;
    // lt: the game's live forcing (liveTapes), which the link's page plays the replay with (clipLtFor)
    const body = { rep: b64(rep), lt: T.lt ? b64(T.lt) : null, t, e, at, names: (L.info.names || []).map(n => String(n || '').trim()), match: L.info.match || null, chat };
    const r = await fetch(`${LIVE}/clip`, { method: 'POST', credentials: 'same-origin', body: JSON.stringify(body),
                                           headers: { 'Content-Type': 'application/json' } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    T.id = j.r;
    const u = new URL(LIVE_CLIP_SITE + '/');
    u.searchParams.set('r', j.r); u.searchParams.set('t', t); u.searchParams.set('e', e);
    if (j.c) u.searchParams.set('c', j.c);
    u.searchParams.set('loop', '1');
    p.link = u.toString(); p.t = t; p.e = e; p.id = j.r; p.cid = j.c;
    window.__mbaaLastLink = p.link;
    clipPanelKey = ''; marksKey = '';
    try { await navigator.clipboard.writeText(p.link); status(`copied: ${p.link}`); }
    catch (err) { status(`live clip link ready: Copy link (C) copies it: ${p.link}`); }
  } catch (err) {
    console.warn('live clip link failed:', err);
    status(`live clip link failed: ${err.message || err}`);
    if (L.clipPend === p) L.clipPend = null;
    clipPanelKey = ''; marksKey = '';
  } finally { p.busy = false; }
}
async function liveClipCopy(text) {
  try { await navigator.clipboard.writeText(text); status(`copied: ${text}`); } catch (e) { prompt('copy:', text); }
}
// (links go to the public site, never to the chat page's own path)
const LIVE_CLIP_SITE = Q.get('clipSite') || (/^(127\.0\.0\.1|localhost)$/.test(location.hostname) ? location.origin + location.pathname.replace(/\/[^/]*$/, '') : 'https://watch.meltyblood.org');

// ---- a live clip's chat on a replay link (?c=<clip id>): the comments said during the clip, drawn over the picture as
// the chat's Niconico overlay draws them (its 1920x1080 stage scaled to the picture's height; scrolling (naka) comments
// cross in (1725 + width) / v s, ue / shita stay 3 s), at the replay's frames, so pauses, seeks and the loop show them
// where they were said; Save MP4 draws them too (drawOverlay)
let clipChat = null;  // [{f, x, col, px, row, loc, w, v, life, y}] or null
const CC_SIZE = { small: [51, 51], medium: [76, 82], big: [110, 129] };
const CC_COLOR = { white: '#FFFFFF', red: '#FF0000', pink: '#FF8080', orange: '#FFC000', yellow: '#FFFF00', green: '#00FF00',
  cyan: '#00FFFF', blue: '#0000FF', purple: '#C000FF', black: '#000000', white2: '#CCCC99', niconicowhite: '#CCCC99',
  red2: '#CC0033', truered: '#CC0033', pink2: '#FF33CC', orange2: '#FF6600', passionorange: '#FF6600', yellow2: '#999900',
  madyellow: '#999900', green2: '#00CC66', elementalgreen: '#00CC66', cyan2: '#00CCCC', blue2: '#3399FF', marinblue: '#3399FF',
  purple2: '#6633CC', nobleviolet: '#6633CC', black2: '#666666' };
const CC_FONT = '"Arial", "MS PGothic", "Hiragino Kaku Gothic ProN", "Noto Sans CJK JP", sans-serif';
async function clipChatLoad(jp, t) {
  try {
    const j = await jp, ms = document.createElement('canvas').getContext('2d'), out = [];
    const base = Number.isFinite(+j.t) ? +j.t : t;
    for (const l of (j.chat || [])) {
      const cmds = String(l.m || '').toLowerCase().split(/\s+/).filter(Boolean);
      const loc = cmds.find(c => c === 'ue' || c === 'shita') || 'naka', size = cmds.find(c => CC_SIZE[c]) || 'medium';
      const col = cmds.map(c => CC_COLOR[c] || (/^#[0-9a-f]{6}$/.test(c) ? c : null)).find(Boolean) || l.c || '#FFFFFF';
      const x = Array.from(l.a ? `${l.n} ${l.x}` : String(l.x || '')), text = x.length > 75 ? x.slice(0, 74).join('') + '…' : x.join('');
      const [px, row] = CC_SIZE[size];
      ms.font = `600 ${px}px ${CC_FONT}`;
      const w = Math.ceil(ms.measureText(text).width) + 8, c = { f: base + (+l.o || 0), text, col, px, row, loc, w, y: 0 };
      if (loc === 'naka') { c.v = (1530 + 0.95 * w) / 4; c.life = (1725 + w) / c.v; } else c.life = 3;
      out.push(c);
    }
    // rows: the topmost where it meets no comment placed before it (ue from the top, shita from the bottom)
    out.sort((p, q) => p.f - q.f);
    const xAt = (c, T) => c.loc === 'naka' ? 1725 - c.v * (T - c.f / 60) : (1920 - c.w) / 2;
    const meet = (a, c) => {
      if (a.loc !== c.loc) return false;
      const s0 = Math.max(a.f / 60, c.f / 60), s1 = Math.min(a.f / 60 + a.life, c.f / 60 + c.life);
      if (s0 >= s1) return false;
      if (c.loc !== 'naka') return true;
      const r0 = xAt(c, s0) - xAt(a, s0), r1 = xAt(c, s1) - xAt(a, s1);
      return Math.min(r0, r1) <= a.w + 5 && Math.max(r0, r1) >= -(c.w + 5);
    };
    for (const [k, c] of out.entries()) {
      const near = out.slice(0, k).filter(a => meet(a, c));
      let y = 0;
      for (let moved = true; moved;) { moved = false; for (const a of near) if (y < a.y + a.row && a.y < y + c.row) { y = a.y + a.row; moved = true; } }
      c.y = y + c.row > 1080 ? Math.floor(Math.random() * Math.max(1, 1080 - c.row)) : y;
    }
    clipChat = out;
    overlayDirty = true;
    console.log(`clip chat: ${out.length} comments`);
    if (j.at && Number.isInteger(j.at.k)) clipFix(j.at);
  } catch (e) { console.warn('clip chat:', e); }
}
// A live clip's replay is played with the game's live forcing (the clip JSON's lt, base64 of the live session's .lt:
// web/host/live_tape.cpp): the raw pad words of every pre-fight / win pose phase (skipped intros and win poses), the RNG
// forced at the join point, CCCaster's intro clear. Without it the replay plays the full intro and win poses (other round
// start frames and start positions than the live session showed). For the replay of that link only (play(): by name)
let clipLt = null;  // {name, bytes} or null
async function clipLtFor(jp, name) {
  try {
    const j = await jp;
    if (j && typeof j.lt === 'string' && j.lt) clipLt = { name, bytes: Uint8Array.from(atob(j.lt), ch => ch.charCodeAt(0)) };
  } catch (e) { console.warn('clip:', e); }
}
// the link's t / e are an estimate (the live session's frames less a fixed lag); the clip JSON has the clip by the
// game's fight starts ({k, da, db}: tl.fights), exact: once this replay has played to that fight start, the clip (and
// its chat) move there
async function clipFix(at) {
  let s = null;
  for (let i = 0; i < 600 && !(s && s.clip && s.tl && !s.seeking); i++) { await new Promise(r => setTimeout(r, 100)); s = session; }
  if (!s || !s.clip) return;
  for (let i = 0; i < 40 && s.tl.fights.length <= at.k && s.tl.end === null && session === s; i++) await requestSeek(s.tl.simMax + 600);
  if (session !== s || s.tl.fights.length <= at.k || !s.clip) return;
  const F = s.tl.fights[at.k], a = Math.max(1, F + at.da), b = Math.max(a + 1, F + at.db), d = a - s.clip.a;
  if (clipChat) for (const c of clipChat) c.f += d;
  s.clip.a = a; s.clip.b = b; marksKey = ''; overlayDirty = true;
  if (d) console.log(`clip: moved ${d} frames to the fight start's (round ${at.k})`);
  await requestSeek(a);
}
// g: the overlay canvas' context (w x h over the picture); f: the frame on screen
function clipChatDraw(g, w, h, f) {
  if (!clipChat || !clipChat.length || Q.get('clipchat') === '0') return;
  const k = h / 1080, x0 = (w - h * 16 / 9) / 2, T = f / 60;
  g.save();
  g.beginPath(); g.rect(0, 0, w, h); g.clip();
  g.textBaseline = 'middle'; g.lineJoin = 'round';
  for (const c of clipChat) {
    const dt = T - c.f / 60;
    if (dt < 0 || dt > c.life) continue;
    const x = c.loc === 'naka' ? 1725 - c.v * dt : (1920 - c.w) / 2;
    const y = c.loc === 'shita' ? 1080 - c.y - c.row / 2 : c.y + c.row / 2;
    g.font = `600 ${(c.px * k).toFixed(2)}px ${CC_FONT}`;
    g.lineWidth = Math.max(1, 4 * k); g.strokeStyle = c.col === '#000000' ? '#FFFFFF' : '#000000';
    g.strokeText(c.text, x0 + (x + 4) * k, y * k);
    g.fillStyle = c.col; g.fillText(c.text, x0 + (x + 4) * k, y * k);
  }
  g.restore();
}

// ---- video export: the clip, or the round being watched, as a 1280x960 60 fps video (every game frame drawn 2x,
// nearest neighbour, with the hitbox / input overlay) with the game's sound at its own level (before the volume slider).
// Fast path (WebCodecs): the game is stepped as fast as it runs and each frame encoded (H.264, VP9 where there is no
// H.264 encoder), the sound events of those frames are logged and rendered in an OfflineAudioContext, and both go into an
// MP4 (vendor/mp4-muxer). Without WebCodecs the range is played at 1x and recorded with MediaRecorder.
let rec = null, fx = null;
const REC_TYPES = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'];
const EXPORT_W = 1280, EXPORT_H = 960, EXPORT_SR = 48000, EXPORT_PREROLL = 180;  // pre-roll: sounds already playing at the in point
async function exportVideo() {
  const s = session;
  if (fx) { fx.cancel = true; return; }
  if (rec) return stopRecording(true);
  if (!s || !s.tl) return;
  ensureAudio(true); await actx.resume();
  if (inIntro(s)) await skipIntro(s);
  const c = s.clip ? { ...s.clip } : roundClip(s);
  if (s.liveSrc) {  // a live match: up to the newest frame received (the round may not have ended yet)
    c.b = Math.min(c.b, s.M._viewer_frame() + call(s, 'viewer_spectate_buffered'));
    if (c.b <= c.a) { status('nothing received after the clip start yet'); return; }
  }
  if (window.VideoEncoder && window.VideoFrame && Q.get('exportMode') !== 'realtime') {
    try { if (await fastExport(s, c)) return; }
    catch (e) { console.error('video export failed:', e); status(`video export failed: ${e.message || e}`); return; }
  }
  return exportRealtime(s, c);
}
function loadScript(src) {
  return new Promise((res, rej) => { const e = document.createElement('script'); e.src = src; e.onload = res;
    e.onerror = () => rej(new Error(`could not load ${src}`)); document.head.append(e); });
}
async function exportCodecs() {
  let video = null, audio = null;
  // H.264 Constrained Baseline (level 4.2): no B-frames, which the muxer needs (Firefox's High profile encoder emits
  // them, out of decode order); VP9 where there is no H.264 encoder
  for (const codec of ['avc1.42E02A', 'vp09.00.40.08']) {
    const cfg = { codec, width: EXPORT_W, height: EXPORT_H, bitrate: 12e6, framerate: 60, latencyMode: 'quality' };
    if (codec.startsWith('avc1')) cfg.avc = { format: 'avc' };
    try { if ((await VideoEncoder.isConfigSupported(cfg)).supported) { video = cfg; break; } } catch (e) {}
  }
  if (window.AudioEncoder) for (const codec of ['mp4a.40.2', 'opus']) {
    const cfg = { codec, sampleRate: EXPORT_SR, numberOfChannels: 2, bitrate: 192000 };
    try { if ((await AudioEncoder.isConfigSupported(cfg)).supported) { audio = cfg; break; } } catch (e) {}
  }
  return { video, audio };
}
function exportName(c, ext) {
  return `${document.getElementById('title').textContent.replace(/[\\/:*?"<>|\u00b7]+/g, ' ').replace(/\s+/g, ' ').trim()} ${fmtTime(c.a).replace(/[:.]/g, '-')}.${ext}`;
}
function saveBlob(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  window.__mbaaLastExport = { name, size: blob.size, type: blob.type };
}
async function fastExport(s, c) {
  const codecs = await exportCodecs();
  if (!codecs.video) return false;
  if (!window.Mp4Muxer) await loadScript('vendor/mp4-muxer.min.js');
  const M = s.M, t0 = performance.now(), pre = Math.max(1, c.a - EXPORT_PREROLL);
  fx = { cancel: false };
  if (M._viewer_ov_on) M._viewer_ov_on(0);  // (the chat's comments stay out of the video)
  document.getElementById('clipexp').classList.add('on');
  setPaused(true);
  const hooks = ['mbaaVoicePlay', 'mbaaVoiceParam', 'mbaaVoiceStop', 'mbaaBgmStart', 'mbaaBgmStop'], orig = {};
  try {
    await requestSeek(pre);
    const muxer = new Mp4Muxer.Muxer({ target: new Mp4Muxer.ArrayBufferTarget(), fastStart: 'in-memory',
      video: { codec: codecs.video.codec.startsWith('avc1') ? 'avc' : 'vp9', width: EXPORT_W, height: EXPORT_H, frameRate: 60 },
      ...(codecs.audio ? { audio: { codec: codecs.audio.codec === 'opus' ? 'opus' : 'aac', sampleRate: EXPORT_SR, numberOfChannels: 2 } } : {}) });
    let encErr = null;
    const venc = new VideoEncoder({ output: (ch, meta) => muxer.addVideoChunk(ch, meta), error: e => { encErr = e; } });
    venc.configure(codecs.video);
    // the sound events of every stepped frame, with the frame they happen in
    const ev = [];
    for (const h of hooks) { orig[h] = M[h]; M[h] = (...a) => { ev.push([M._viewer_frame(), h, ...a]); return orig[h](...a); }; }
    const out = document.createElement('canvas'); out.width = EXPORT_W; out.height = EXPORT_H;
    const g = out.getContext('2d'); g.imageSmoothingEnabled = false;
    const cv = document.getElementById('canvas'), ov = document.getElementById('overlay');
    let lastUi = 0;
    for (let k = pre; k < c.b; k++) {
      if (fx.cancel || session !== s) throw new Error('cancelled');
      if (encErr) throw encErr;
      const k0 = M._viewer_frame();
      call(s, 'viewer_step', 1);
      if (M._viewer_frame() === k0) break;  // the end of the replay (or of the live stream received)
      if (k < c.a) continue;
      g.drawImage(cv, 0, 0, EXPORT_W, EXPORT_H);
      if (ui.boxes || ui.inputs || clipChat) { drawOverlay(); g.drawImage(ov, 0, 0, EXPORT_W, EXPORT_H); }
      const vf = new VideoFrame(out, { timestamp: Math.round((k - c.a) * 1e6 / 60), duration: Math.round(1e6 / 60) });
      venc.encode(vf, { keyFrame: (k - c.a) % 120 === 0 }); vf.close();
      while (venc.encodeQueueSize > 6) await new Promise(r => setTimeout(r, 1));
      if (performance.now() - lastUi > 150) {  // let the page breathe and show progress
        lastUi = performance.now();
        const done = (k - c.a + 1) / (c.b - c.a), speed = (k - c.a + 1) / 60 / ((lastUi - t0) / 1000);
        status(`exporting ${Math.round(100 * done)}% (${speed.toFixed(1)}x real time; E or Esc cancels)`);
        overlayDirty = true;
        await new Promise(r => setTimeout(r, 0));
      }
    }
    for (const h of hooks) M[h] = orig[h];
    await venc.flush(); venc.close();
    if (encErr) throw encErr;
    if (codecs.audio) {
      status('exporting: sound');
      const pcm = await renderExportAudio(s, ev, pre, c);
      let aerr = null;
      const aenc = new AudioEncoder({ output: (ch, meta) => muxer.addAudioChunk(ch, meta), error: e => { aerr = e; } });
      aenc.configure(codecs.audio);
      const skip = Math.round((c.a - pre) / 60 * EXPORT_SR), L = pcm.getChannelData(0), R = pcm.getChannelData(1), step = 4800;
      for (let i = skip; i < pcm.length; i += step) {
        const n = Math.min(step, pcm.length - i), data = new Float32Array(2 * n);
        data.set(L.subarray(i, i + n), 0); data.set(R.subarray(i, i + n), n);
        const ad = new AudioData({ format: 'f32-planar', sampleRate: EXPORT_SR, numberOfFrames: n, numberOfChannels: 2,
                                   timestamp: Math.round((i - skip) * 1e6 / EXPORT_SR), data });
        aenc.encode(ad); ad.close();
      }
      await aenc.flush(); aenc.close();
      if (aerr) throw aerr;
    }
    muxer.finalize();
    const blob = new Blob([muxer.target.buffer], { type: 'video/mp4' }), name = exportName(c, 'mp4');
    saveBlob(blob, name);
    const secs = (performance.now() - t0) / 1000;
    status(`saved ${name} (${(blob.size / 1048576).toFixed(1)} MB, ${((c.b - c.a) / 60).toFixed(1)} s of video in ${secs.toFixed(1)} s)`);
    window.__mbaaLastExport.ms = Math.round(secs * 1000);
    window.__mbaaLastExport.codecs = [codecs.video.codec, codecs.audio && codecs.audio.codec];
  } catch (e) {
    if (e.message !== 'cancelled') throw e;
    status('export cancelled');
  } finally {
    for (const h of hooks) if (orig[h]) M[h] = orig[h];
    fx = null; overlayDirty = true;
    if (window.mbaaOvSync) window.mbaaOvSync();
    document.getElementById('clipexp').classList.remove('on');
  }
  return true;
}
// The logged sound events rendered offline the way audioHooks plays them live: one voice per sound set (Play restarts
// it, Stop cuts it, volume / pan in DirectSound units), the BGM stream from where it was at the pre-roll start.
async function renderExportAudio(s, ev, pre, c) {
  const M = s.M, oc = new OfflineAudioContext(2, Math.ceil((c.b - pre) / 60 * EXPORT_SR), EXPORT_SR);
  const at = k => Math.max(0, (k - pre) / 60);
  const chainOf = () => {
    const g = oc.createGain(); g.channelCount = 2; g.channelCountMode = 'explicit'; g.channelInterpretation = 'speakers';
    const sp = oc.createChannelSplitter(2), mg = oc.createChannelMerger(2), l = oc.createGain(), r = oc.createGain();
    g.connect(sp); sp.connect(l, 0); sp.connect(r, 1); l.connect(mg, 0, 0); r.connect(mg, 0, 1); mg.connect(oc.destination);
    return { g, l, r, src: null };
  };
  const setVp = (v, vol, pan, t) => {
    v.g.gain.setValueAtTime(dsGain(vol), t);
    v.l.gain.setValueAtTime(pan > 0 ? dsGain(-pan) : 1, t); v.r.gain.setValueAtTime(pan < 0 ? dsGain(pan) : 1, t);
  };
  const cutAt = (v, t) => { if (v.src) { try { v.src.stop(t); } catch (e) {} v.src = null; } };
  const decoded = new Map();
  for (const [, h, , path] of ev) if (h === 'mbaaVoicePlay' && !decoded.has(path)) {
    let bytes = null; try { bytes = M.FS.readFile(path); } catch (e) {}
    decoded.set(path, bytes ? oc.decodeAudioData(bytes.slice().buffer).catch(() => null) : Promise.resolve(null));
  }
  const bufs = new Map(await Promise.all([...decoded].map(async ([p, d]) => [p, await d])));
  const voices = new Map(), bgmV = chainOf(), exportBgm = new Map();
  const voice = ch => { let v = voices.get(ch); if (!v) voices.set(ch, v = chainOf()); return v; };
  const bgmStart = async (path, loop, loopPos, t, offset) => {
    cutAt(bgmV, t);
    const p = path.replace(/^\/game\//, '');
    if (!exportBgm.has(p)) exportBgm.set(p, bgmDecoded.get(p) || (cache.get(p) ? actx.decodeAudioData(cache.get(p).slice().buffer) : null));
    const dec = exportBgm.get(p);  // this export's own decode (dropped with it) unless the track is already decoded
    const buf = dec && await dec.catch(() => null);
    if (!buf) return;
    const n = oc.createBufferSource();
    n.buffer = buf; n.loop = !!loop; n.loopStart = Math.min(loopPos, buf.duration); n.loopEnd = buf.duration;
    let off = offset;
    if (off >= buf.duration) {
      if (!loop) return;
      const span = buf.duration - n.loopStart;
      off = span > 0 ? n.loopStart + ((off - n.loopStart) % span) : 0;
    }
    n.connect(bgmV.g); n.start(t, Math.max(0, off)); bgmV.src = n;
  };
  // the BGM at the pre-roll start (as s.bgmSync finds it)
  let cur = null, vp = null;
  for (const [k, e, ...a] of s.bgmLog) {
    if (k >= pre) break;
    if (e === 'stop') cur = null;
    else if (e === 'start') { cur = { path: a[0], loop: a[1], loopPos: a[2], k }; vp = [a[3], a[4]]; }
    else if (e === 'param') vp = [a[0], a[1]];
  }
  if (!ui.music) cur = null;  // music off: the video has none either
  if (vp) setVp(bgmV, vp[0], vp[1], 0);
  if (cur) await bgmStart(cur.path, cur.loop, cur.loopPos, 0, Math.max(0, pre - cur.k - 1) / 60);
  for (const [k, h, ...a] of ev) {
    const t = at(k);
    if (h === 'mbaaVoicePlay') {
      const [ch, path, vol, pan] = a, v = voice(ch), buf = bufs.get(path);
      cutAt(v, t); setVp(v, vol, pan, t);
      if (buf) { const n = oc.createBufferSource(); n.buffer = buf; n.connect(v.g); n.start(t); v.src = n; }
    } else if (h === 'mbaaVoiceParam') { const [ch, vol, pan] = a; setVp(ch === -1 ? bgmV : voice(ch), vol, pan, t); }
    else if (h === 'mbaaVoiceStop') { if (a[0] !== -1 && voices.has(a[0])) cutAt(voices.get(a[0]), t); }
    else if (h === 'mbaaBgmStart') { if (!ui.music) continue; const [path, loop, loopPos, vol, pan] = a; setVp(bgmV, vol, pan, t); await bgmStart(path, loop, loopPos, t, 0); }
    else if (h === 'mbaaBgmStop') cutAt(bgmV, t);
  }
  return oc.startRendering();
}
async function exportRealtime(s, c) {
  if (!window.MediaRecorder || !REC_TYPES.some(t => MediaRecorder.isTypeSupported(t))) { status('this browser cannot record video'); return; }
  setPaused(true);
  await requestSeek(c.a);
  const out = document.createElement('canvas'); out.width = 1280; out.height = 960;
  const g = out.getContext('2d'); g.imageSmoothingEnabled = false;
  // a frame per game frame (requestFrame); where the capture track has no requestFrame, the canvas is captured at 60 fps
  let stream = out.captureStream(0);
  const manual = typeof stream.getVideoTracks()[0].requestFrame === 'function';
  if (!manual) { stream.getTracks().forEach(t => t.stop()); stream = out.captureStream(60); }
  const dest = actx.createMediaStreamDestination();
  master.connect(dest);
  stream.addTrack(dest.stream.getAudioTracks()[0]);
  let mr = null, type = '';
  for (const t of REC_TYPES.filter(t => MediaRecorder.isTypeSupported(t))) {  // the first format whose recorder starts
    try { mr = new MediaRecorder(stream, { mimeType: t, videoBitsPerSecond: 8e6, audioBitsPerSecond: 192e3 }); mr.start(1000); type = t; break; }
    catch (e) { console.warn(`recorder ${t} failed:`, e); mr = null; }
  }
  if (!mr) { master.disconnect(dest); status('video export failed: no recorder format would start'); return; }
  const chunks = [];
  mr.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  mr.onerror = e => recFail(e.error || e);
  if (s.M._viewer_ov_on) s.M._viewer_ov_on(0);  // (the chat's comments stay out of the video)
  rec = { s, a: c.a, b: c.b, round: !!c.round, mr, g, out, dest, chunks, type, last: -1, save: true,
          speed: ui.speed, track: stream.getVideoTracks()[0] };
  if (ui.speed !== 1) call(s, 'viewer_speed', 1);
  document.getElementById('clipexp').classList.add('on');
  recDraw();
  setPaused(false);
}
function recDraw() {
  const r = rec;
  r.g.drawImage(document.getElementById('canvas'), 0, 0, 1280, 960);
  if (ui.boxes || ui.inputs || clipChat) r.g.drawImage(document.getElementById('overlay'), 0, 0, 1280, 960);
  if (r.track.requestFrame) r.track.requestFrame();
}
function recTick(s, f) {
  const r = rec;
  if (r.s !== s) return stopRecording(false);
  if (s.seeking || (s.tl && s.tl.running)) return;
  if (r.round) {  // the round's end, once the pre-scan has found it
    const next = s.tl.marks.find(x => x[0] > r.a); r.b = next ? next[0] - 1 : tlMax(s.tl);
  }
  if (f !== r.last) { r.last = f; recDraw(); }
  status(`recording ${fmtTime(Math.max(0, f - r.a))} / ${fmtTime(r.b - r.a)} (E stops and saves, Esc cancels)`);
  if (f >= r.b || (s.tl.end !== null && f >= s.tl.end)) stopRecording(true);
}
function recFail(e) {
  console.error('video export failed:', e);
  stopRecording(false);
  status(`video export failed: ${(e && e.message) || e}`);
}
function stopRecording(save) {
  const r = rec;
  if (!r) return;
  rec = null;
  if (window.mbaaOvSync) window.mbaaOvSync();
  setPaused(true);
  if (ui.speed !== 1 && session === r.s) call(r.s, 'viewer_speed', ui.speed);
  document.getElementById('clipexp').classList.remove('on');
  r.mr.onstop = () => {
    master.disconnect(r.dest);
    if (!save) { if (!/failed/.test(document.getElementById('status').textContent)) status('recording cancelled'); return; }
    const blob = new Blob(r.chunks, { type: r.type.split(';')[0] }), name = exportName(r, r.type.startsWith('video/mp4') ? 'mp4' : 'webm');
    saveBlob(blob, name);
    status(`saved ${name} (${(blob.size / 1048576).toFixed(1)} MB)`);
  };
  if (r.mr.state === 'inactive') r.mr.onstop(); else r.mr.stop();
}
// Integer scaling: the picture is the largest whole multiple of 640x480 in physical pixels that fits the window above
// the controls (every game pixel the same size); below 1x it fits the width.
let scaleMode = 'auto';
try { scaleMode = localStorage.getItem('mbaaScale') || 'auto'; } catch (e) {}
const SIDE_W = 320 + 16;  // the controls panel beside the picture, with its gap
const FS_SIDE = 212;  // fullscreen: the least room beside the picture for the controls column (with its gap)
// Chat pages (body.haschat, index.html's layout notes): by the window's shape, 'port' (an upright phone or tablet: the
// picture on top, chat filling the rest), 'land' (a phone on its side: the picture left, chat right), 'desk' (the chat
// column right, the controls under the picture). While the on-screen keyboard is up (body.kbd) the shape is kept (it
// only shortens the window). chatHidden: the chat column hidden (its button; not upright, where chat is the page).
let chatHidden = false, layMode = '';
try { chatHidden = localStorage.getItem('mbaaChatHidden') === '1'; } catch (e) {}
function chatLayout() {
  const b = document.body, W = window.innerWidth, H = window.innerHeight;
  if (!b.classList.contains('haschat')) return W > H && H < 520 ? 'land' : '';  // (no chat: a phone on its side, the same less chat)
  if (b.classList.contains('kbd') && layMode) return layMode;
  return W < H ? (W < 900 ? 'port' : 'desk') : (H < 520 ? 'land' : 'desk');
}
function fitStage() {
  overlayDirty = true;  // (the picture moved or changed size: the overlay drawn again over it)
  const dpr = window.devicePixelRatio || 1, stage = document.querySelector('.stage'), ctl = document.getElementById('controls');
  const full = !!stage && stage.classList.contains('fs'), b = document.body, root = document.documentElement;
  const tr = document.getElementById('transportsec');
  if (!full) {  // (fullscreen keeps the page's layout under it)
    layMode = chatLayout();
    const mob = layMode === 'port' || layMode === 'land';
    b.classList.toggle('mob', mob); document.documentElement.classList.toggle('mob', mob); placeControls(mob); b.classList.toggle('port', layMode === 'port'); b.classList.toggle('land', layMode === 'land');
    b.classList.toggle('nochat', (chatHidden || !b.classList.contains('haschat')) && (layMode === 'land' || layMode === 'desk'));
    b.classList.toggle('deskchat', layMode === 'desk' && !chatHidden);
    if (!mob) b.classList.remove('sheet', 'kbd');
    const ct = document.getElementById('chattog');
    if (ct) ct.classList.toggle('on', !chatHidden);
  }
  const setW = (w, label) => { root.style.setProperty('--w', `${Math.floor(w * 1000) / 1000}px`); if (stage) stage.dataset.scale = label; };
  if (!full && b.classList.contains('mob')) {
    // the visual viewport (the window less the on-screen keyboard) is the page: .main pinned to it
    const vv = window.visualViewport, zoomed = vv && vv.scale > 1.01;
    const vh = vv && !zoomed ? vv.height : window.innerHeight, W = root.clientWidth;
    root.style.setProperty('--vvh', `${vh}px`); root.style.setProperty('--vvt', `${vv && !zoomed ? vv.offsetTop : 0}px`);
    let w;
    if (layMode === 'port') {  // the picture as wide as leaves chat its least height under it and the transport
      const trH = tr && tr.offsetParent ? tr.offsetHeight : 0;
      // (typing, the keyboard up: 190 for the chat, its match card row hidden (chat.js): ~4 lines over the input; 170 with
      // the card left ~1.5, "messaging kinda sux on mobile", 2026-11-01)
      w = Math.min(W, (vh - trH - (b.classList.contains('kbd') ? 190 : 220)) * 4 / 3);
    } else w = Math.min(W - (b.classList.contains('nochat') ? 200 : Math.max(W * 0.35, 240)), vh * 4 / 3);
    if (/^\d$/.test(scaleMode)) w = Math.min(w, 640 * +scaleMode / dpr);
    return setW(Math.max(w, 120), 'fit');
  }
  // the transport under the picture (in fullscreen it is over it): its height at a picture width, measured at that
  // width (its bar is one row when wide, two or three when narrow), so a narrow picture's tall bar does not keep the
  // picture narrow: the widest picture's bar first, then the chosen picture's, until they agree
  // Desktop, auto size: when the picture alone (the window's height) takes a larger whole multiple than it does with the
  // transport under it (a 1080p window, ~970 px: 2x, against 1x with the bar under), the bar goes over the picture's
  // bottom and fades on idle (.ovl, YouTube's player). wSide / wBelow: the picture's room beside the panel / full width.
  // Returns [width, label, side (null: unchanged)].
  const ovlPick = (wSide, wBelow, r) => {
    const Hp = window.innerHeight - 8, k = /^(\d)x$/.exec(r[1]) ? +r[1][0] : 0;
    let on = false, out = [r[0], r[1], null];
    if (!b.classList.contains('mob') && dpr < 2 && scaleMode === 'auto') {
      const kS = Math.floor(Math.min(wSide / 640, Hp / 480)), kB = Math.floor(Math.min(wBelow / 640, Hp / 480));
      const kO = Math.max(kS, kB);
      if (kO > k && kO >= 1) { on = true; out = [640 * kO, `${kO}x`, kS >= kB]; }
    }
    if (stage && stage.classList.contains('ovl') !== on) { stage.classList.toggle('ovl', on); barPlace(); }
    return out;
  };
  const trAt = w => {
    if (full || !tr) return 0;
    const o = tr.style.width; tr.style.width = `${Math.floor(w)}px`;
    const h = tr.offsetHeight + 6; tr.style.width = o; return h;
  };
  if (!full && b.classList.contains('deskchat')) {
    const chatW = Math.round(Math.min(400, Math.max(300, window.innerWidth * 0.24)));
    root.style.setProperty('--chatw', `${chatW}px`);
    const W = root.clientWidth - 32 - chatW - 12;
    const pick = trH => {
      const H = window.innerHeight - 16 - trH;
      const k = Math.floor(Math.min(W * dpr / 640, H * dpr / 480)), fit = Math.min(W, H * 4 / 3);
      if (scaleMode === 'fit') return [fit, 'fit'];
      if (/^\d$/.test(scaleMode)) return [640 * +scaleMode / dpr, `${scaleMode}x`];
      return k >= 1 && dpr < 2 ? [640 * k / dpr, `${k}x`] : [fit, 'fit'];
    };
    let trH = trAt(W), r = pick(trH);
    for (let n = 0; n < 3; n++) { const h = trAt(r[0]); if (h === trH) break; trH = h; r = pick(trH); }
    const o = ovlPick(W, W, r);
    return setW(o[0], o[1]);
  }
  if (full) fsChatPlace();  // (a phone turned in fullscreen: the chat beside only on its side)
  const fsMob = b.classList.contains('mob');
  // (a phone on its side: the picture the full height, the chat the rest, at least 240 px, at most 45 % of the width)
  const fsChatW = full && stage.classList.contains('fschat')
    ? Math.round(fsMob ? Math.min(window.innerWidth * 0.45, Math.max(240, window.innerWidth - window.innerHeight * 4 / 3))
                       : Math.min(400, Math.max(300, window.innerWidth * 0.22))) : 0;
  if (fsChatW) root.style.setProperty('--chatw', `${fsChatW}px`);
  const Wwin = full ? window.innerWidth - fsChatW : document.documentElement.clientWidth - 32;
  const H = full ? window.innerHeight : window.innerHeight - 16;
  // a phone in fullscreen with FS_SIDE or more beside the full-height picture (landscape): the controls go there
  // (.sidebar); desktop (any shape, 16:9 to 32:9) keeps the bar over the picture's bottom
  const sidebar = full && !fsChatW && b.classList.contains('mob') && Wwin - H * 4 / 3 >= FS_SIDE;
  if (stage) stage.classList.toggle('sidebar', sidebar);
  const W = sidebar ? Wwin - FS_SIDE : Wwin;
  const pick = trH => {
    // controls below the picture take their stacked height; beside it, SIDE_W of width. Pick the layout with the larger
    // picture. (the transport is under the picture in both)
    document.body.classList.remove('side');
    const below = full ? 0 : (ctl ? ctl.offsetHeight + 8 : 0) + trH, Hs = H - trH;
    const kSide = Math.floor(Math.min((W - SIDE_W) * dpr / 640, Hs * dpr / 480));
    const kBelow = Math.floor(Math.min(W * dpr / 640, (H - below) * dpr / 480));
    // (high-density screens, auto: no whole multiples, the larger fitted picture: beside the panel, or the width with the
    // picture and the transport in the window, the panel scrolled to below)
    const hiAuto = !full && dpr >= 2 && scaleMode === 'auto';
    const wSide = Math.min(W - SIDE_W, Hs * 4 / 3), wBelow = Math.min(W, 960, Math.max(320, Hs * 4 / 3));
    const side = !full && W - SIDE_W >= 320 && (hiAuto ? wSide >= wBelow : kSide >= kBelow);
    document.body.classList.toggle('side', side);
    if (scaleMode === 'fit') return [side ? Math.min(W - SIDE_W, Hs * 4 / 3) : Math.min(W, (H - below) * 4 / 3), 'fit'];
    if (/^\d$/.test(scaleMode)) return [640 * +scaleMode / dpr, `${scaleMode}x`];
    // high-density screens (phones): a game pixel is already 2+ device pixels, uneven rows are invisible there, and a
    // whole multiple would leave a small picture: fit the width instead (beside the panel: the room there)
    // (fullscreen on such a screen: the whole screen, as large as it fits)
    const k = dpr >= 2 ? 0 : side ? kSide : kBelow;
    return [k >= 1 ? 640 * k / dpr : full ? Math.min(W, H * 4 / 3) : side ? wSide : wBelow, k >= 1 ? `${k}x` : 'fit'];
  };
  let trH = trAt(Math.min(W, 1280)), r = pick(trH);
  for (let n = 0; n < 3; n++) { const h = trAt(r[0]); if (h === trH) break; trH = h; r = pick(trH); }
  if (!full) {
    const o = ovlPick(W - SIDE_W, W, r);
    if (o[2] !== null) document.body.classList.toggle('side', o[2]);
    r = o;
  }
  setW(r[0], r[1]);
  // desktop fullscreen with room under the picture for the whole bar (1080p at 2x: 960 + 120): the picture and the
  // bar as one block, centred, the bar under the picture instead of over its bottom (.fsroom); no room: over it
  const bar = stage && stage.querySelector('.fsbar');
  if (bar) {
    stage.classList.add('fsroom');  // (its compact padding, to measure)
    const fk = parseFloat(getComputedStyle(bar).getPropertyValue('--fk')) || 1, barH = bar.offsetHeight * fk, picH = r[0] * 3 / 4;
    const room = full && !sidebar && H - picH >= barH;
    stage.classList.toggle('fsroom', room);
    if (room) root.style.setProperty('--fstop', `${Math.floor((H - picH - barH) / 2)}px`);
  }
}
addEventListener('resize', fitStage);
// the layout's own controls: the phone menu sheet, the chat column's show / hide, the chat profile; the on-screen
// keyboard (a chat text field focused on a phone: body.kbd) and the visual viewport it shortens
// Where the view's controls live: desktop, in the transport under the picture (#tright: volume, speed, settings, PiP,
// fullscreen, help; the overlay chips, skip intro and size in the settings popover #setpop); phones, where they were
// in the panel (the ⋯ sheet). Each moved node leaves a comment behind to go back to.
const MOVED = [];
function placeControls(mob) {
  if (!MOVED.length) {
    const byId = id => document.getElementById(id);
    const chips = byId('boxes') && byId('boxes').closest('.row');
    const tr = byId('tright'), pop = byId('setpop'), setb = byId('setb'), tclip = byId('tclip');
    if (!tr || !pop || !chips || !tclip) return;
    const sizeRow = document.createElement('div'); sizeRow.className = 'row';
    // (desktop: the size as a row of buttons, the select (#scale, the state; phones' sheet uses it) kept hidden in it)
    const seg = document.createElement('div'); seg.className = 'sizeseg'; seg.setAttribute('role', 'radiogroup'); seg.setAttribute('aria-label', 'picture size');
    const segL = document.createElement('span'); segL.className = 'lbl'; segL.textContent = 'size';
    for (const [v, t, tip] of [['auto', 'auto', 'the largest whole multiple that fits (the bar over the picture when that makes it larger)'], ['1', '1x'], ['2', '2x'], ['3', '3x'], ['fit', 'fit', 'as large as fits, not a whole multiple']]) {
      const bt = document.createElement('button'); bt.type = 'button'; bt.textContent = t; bt.dataset.v = v; bt.setAttribute('role', 'radio'); bt.setAttribute('aria-checked', String(v === scaleMode)); bt.title = tip || `${t}: every game pixel ${v}x${v} screen pixels`;
      bt.onclick = e => { e.stopPropagation(); const sc = byId('scale'); sc.value = v; sc.dispatchEvent(new Event('change')); };
      seg.append(bt);
    }
    sizeRow.append(segL, seg);
    pop.append(sizeRow);
    for (const [el, to, before] of [[byId('mute'), tr, setb], [byId('vol'), tr, setb], [byId('speed'), tr, setb],
                                    [byId('pip'), tr, null], [byId('full'), tr, null], [byId('helpb'), tr, null],
                                    [chips, pop, sizeRow], [byId('scale'), sizeRow, null], [byId('clipgrp'), tclip, null]]) {
      if (!el) continue;
      const mark = document.createComment(el.id || 'chips');
      el.before(mark);
      MOVED.push({ el, mark, to, before });
    }
    setb.onclick = e => { e.stopPropagation(); pop.hidden = !pop.hidden; setb.setAttribute('aria-expanded', String(!pop.hidden)); };
    document.addEventListener('click', e => { if (!pop.hidden && !pop.contains(e.target) && e.target !== setb) { pop.hidden = true; setb.setAttribute('aria-expanded', 'false'); } });
  }
  // phones: the mute button (and the volume, where the bar has room: landscape / fullscreen) in the transport bar
  // (#mvolgrp, before fullscreen), not only in the menu
  const mvg = document.getElementById('mvolgrp');
  for (const m of MOVED) {
    if (mob && mvg && (m.el.id === 'mute' || m.el.id === 'vol')) { if (m.el.parentNode !== mvg) mvg.append(m.el); }
    else if (mob) { if (m.el.previousSibling !== m.mark) m.mark.after(m.el); }
    else if (m.el.parentNode !== m.to) m.before ? m.to.insertBefore(m.el, m.before) : m.to.append(m.el);
  }
  if (mob) { const pop = document.getElementById('setpop'); if (pop) pop.hidden = true; }
}
(function layoutControls() {
  const b = document.body, on = (id, f) => { const el = document.getElementById(id); if (el) el.onclick = e => { e.currentTarget.blur(); f(); }; };
  on('menub', () => b.classList.add('sheet'));
  on('sheetx', () => b.classList.remove('sheet'));
  on('profb', () => { b.classList.remove('sheet'); const d = document.querySelector('#chatsec details'); if (d) d.open = true; });
  // the comments-on-the-picture switch: the chat's own "on picture" box (chat.js #chatover_on) is the state
  const cmtog = document.getElementById('cmtog');
  const cmSync = () => { const box = document.getElementById('chatover_on'); if (cmtog && box) cmtog.setAttribute('aria-pressed', String(box.checked)); };
  window.mbaaCommentsToggle = () => { const box = document.getElementById('chatover_on'); if (!box) return; box.checked = !box.checked; box.dispatchEvent(new Event('change')); cmSync(); };
  if (cmtog) { cmtog.onclick = e => { e.currentTarget.blur(); window.mbaaCommentsToggle(); }; document.addEventListener('change', e => { if (e.target && e.target.id === 'chatover_on') cmSync(); }); window.mbaaCmSync = cmSync; setTimeout(cmSync, 0); }
  on('chattog', () => { chatHidden = !chatHidden; try { localStorage.setItem('mbaaChatHidden', chatHidden ? '1' : '0'); } catch (e) {} fsChatPlace(); fitStage(); });
  const typing = el => !!el && el.matches && el.matches('#chatsec input[type=text], #chatsec textarea');
  document.addEventListener('focusin', e => { if (b.classList.contains('mob') && typing(e.target) && !b.classList.contains('kbd')) { b.classList.add('kbd'); fitStage(); } });
  document.addEventListener('focusout', () => setTimeout(() => {
    if (b.classList.contains('kbd') && !typing(document.activeElement)) { b.classList.remove('kbd'); fitStage(); }
  }, 60));
  if (window.visualViewport) { visualViewport.addEventListener('resize', fitStage); visualViewport.addEventListener('scroll', fitStage); }
})();
addEventListener('resize', () => marquee(document.getElementById('players')));
document.addEventListener('fullscreenchange', () => setFs(document.fullscreenElement === document.querySelector('.stage')));
// Fullscreen: the stage (the Fullscreen API; a phone also turns to landscape), or where there is none for a page element
// (iPhone) the stage over the whole window. The timeline and transport move into it as a bar over the picture's bottom,
// hidden after FS_IDLE ms without a tap or a mouse move (kept while paused or seeking); a tap while it is hidden only
// shows it.
const FS_IDLE = 3000;
let fsTimer = 0;
function setFs(on) {
  const stage = document.querySelector('.stage'), sec = document.getElementById('transportsec');
  if (stage.classList.contains('fs') === on) return;
  stage.classList.toggle('fs', on);
  // (remembered: a page opened again, or reloaded for a new version, offers it back: fsOfferInit; browsers enter
  // fullscreen only on a tap)
  try { localStorage.setItem('mbaa-fs', on ? '1' : '0'); } catch (e) {}
  if (on) { const o = document.getElementById('fsoffer'); if (o) o.hidden = true; }
  barPlace();
  fsChatPlace();
  marksKey = '';  // (the timeline's width changed: its marks are drawn again)
  fitStage();
}
// the transport in a bar over the picture's bottom (.fsbar: fullscreen, or the desktop overlay .ovl, where the picture
// takes the window's height at a whole multiple the bar under it would not leave room for) or back at its place
function barPlace() {
  const stage = document.querySelector('.stage'), sec = document.getElementById('transportsec');
  const want = stage.classList.contains('fs') || stage.classList.contains('ovl'), bar = stage.querySelector(':scope > .fsbar');
  if (want && !bar) {
    const nb = document.createElement('div');
    nb.className = 'fsbar';
    sec.before(Object.assign(document.createElement('div'), { id: 'transporthome', hidden: true }));
    nb.append(sec);
    stage.append(nb);
    fsWake();
  } else if (!want && bar) {
    document.getElementById('transporthome').replaceWith(sec);
    bar.remove();
    stage.classList.remove('idle');
    clearTimeout(fsTimer);
  }
  marksKey = '';
}
// fullscreen with the chat shown (desktop, a chat page): the chat column moves into the fullscreen layer, on the right,
// the picture fitted to the rest (Twitch's fullscreen chat); the chat toggle in the bar takes it out again
function fsChatPlace() {
  const stage = document.querySelector('.stage'), col = document.getElementById('chatcol'), b = document.body;
  if (!stage || !col) return;
  // (phones: on their side only; upright the picture takes the screen)
  const want = stage.classList.contains('fs') && b.classList.contains('haschat') && !chatHidden
    && (!b.classList.contains('mob') || window.innerWidth > window.innerHeight);
  const home = document.getElementById('chathome');
  if (want && !home) { col.before(Object.assign(document.createElement('div'), { id: 'chathome', hidden: true })); stage.append(col); }
  else if (!want && home) home.replaceWith(col);
  stage.classList.toggle('fschat', want);
  const ct = document.getElementById('chattog');
  if (ct) ct.classList.toggle('on', !chatHidden);
}
function fsWake() {
  const stage = document.querySelector('.stage');
  stage.classList.remove('idle');
  clearTimeout(fsTimer);
  fsTimer = setTimeout(function idle() {
    if (ui.paused || seekDragging || clipPanel) { fsTimer = setTimeout(idle, FS_IDLE); return; }
    stage.classList.add('idle');
  }, FS_IDLE);
}
// last time fullscreen: a one-tap button over the picture (20 s)
function fsOfferInit() {
  const o = document.getElementById('fsoffer');
  let want = false;
  try { want = localStorage.getItem('mbaa-fs') === '1'; } catch (e) {}
  if (!o || !want || document.querySelector('.stage.fs')) return;
  o.hidden = false;
  o.onclick = e => { e.stopPropagation(); o.hidden = true; toggleFullscreen(); };
  o.onpointerdown = e => e.stopPropagation();
  setTimeout(() => { o.hidden = true; }, 20000);
}
function toggleFullscreen() {
  const stage = document.querySelector('.stage');
  if (stage.classList.contains('fs')) {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); else setFs(false);
    return;
  }
  if (!stage.requestFullscreen) { setFs(true); return; }
  stage.requestFullscreen({ navigationUI: 'hide' }).then(() => {
    if (screen.orientation && screen.orientation.lock && matchMedia('(pointer: coarse)').matches) screen.orientation.lock('landscape').catch(() => {});
  }, () => setFs(true));
}
matchMedia && addEventListener('load', fitStage);
async function main() {
  fitStage();
  // the engine downloads while the match's files do (MBAA() later fetches the same URL: an HTTP cache hit)
  const wasmV = ((document.querySelector('script[src^="mbaa.js"]') || {}).src || '').split('?')[1];
  fetch('mbaa.wasm' + (wasmV ? `?${wasmV}` : '')).then(r => r.arrayBuffer()).catch(() => {});
  const plainList = Q.get('files'), plainRoot = Q.get('root') || '';
  if (plainList) {
    man = { files: {} };
    for (const p of await (await fetch(plainList)).json()) man.files[p.toLowerCase()] = { plain: plainRoot + p };
    await fetchAll(man, Object.keys(man.files), 'assets');
    man.files[MOVIE] = { plain: plainRoot + MOVIE };  // (the page keeps them: movieLoad)
    man.files[MOVIE_H264] = { plain: plainRoot + MOVIE_H264 };
  } else {
    cryptoKey = await crypto.subtle.importKey('raw', hex(KEY_HEX), 'AES-CTR', false, ['decrypt']);
    status('loading manifest…');
    // the manifest this page was deployed with (deploy_pages.sh writes its hash into the page): a page and a manifest
    // from different deploys never meet (an older page cannot read a newer bundle's objects, nor the reverse)
    const mv = (document.querySelector('meta[name="mbaa-manifest"]') || {}).content || '';
    const r = await fetch(BUNDLE + 'manifest.bin' + (mv ? `?v=${mv}` : ''), { cache: mv ? 'default' : 'no-cache' });
    net.bytes += +(r.headers.get('content-length') || 0);
    man = JSON.parse(new TextDecoder().decode(await openObject(await r.arrayBuffer())));
    stagePanelLoad().catch(e => console.warn('stage panel:', e));
    if (!man.plan) await fetchAll(man, Object.keys(man.files), 'assets');  // a bundle without a plan: everything
  }
  status('ready: drop a .rep file');
  // one or many replays (a playlist), from the file picker or a drop
  document.getElementById('rep').onchange = e => {
    e.target.blur();  // keys go to the viewer
    loadPlaylist(repFiles(e.target.files));
  };
  document.body.ondragover = e => e.preventDefault();
  document.body.ondrop = e => { e.preventDefault(); loadPlaylist(repFiles(e.dataTransfer.files)); };
  controls(); volInit();
  for (const key of ['boxes', 'inputs']) if (Q.get(key) === '1') { const el = document.getElementById(key); el.checked = true; el.onchange(); }
  // ?r=<id>: a shared replay in the replay store (tools/web/replay_worker.js); ?rep=<url>: any replay URL
  const rq = Q.get('r') || '';
  const autoload = /^[0-9a-f]{64}$/.test(rq) ? `${REPLAY_STORE}/rep/${rq}.rep`  // links from before short ids
                 : /^[A-Za-z0-9_-]{8,43}$/.test(rq) ? `${REPLAY_STORE}/s/${rq}` : Q.get('rep');
  // a live clip (?c=): its JSON (the chat said during it, and the game's live forcing, which the replay is played with)
  const clipJ = /^[A-Za-z0-9_-]{8,43}$/.test(Q.get('c') || '') && autoload
    ? fetch(`${REPLAY_STORE}/c/${Q.get('c')}`).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }) : null;
  if (clipJ) clipChatLoad(clipJ, +(Q.get('t') || 0));
  liveJumpInit();
  fsOfferInit();
  { const el = document.getElementById('song55');  // (songSub)
    if (el) { el.checked = songOn; el.onchange = () => { songOn = el.checked; try { localStorage.setItem('mbaa-song55', songOn ? '1' : '0'); } catch (e) {}
      el.blur(); if (session && session.bgmSync && session.M) session.bgmSync(session.M._viewer_frame()); }; } }
  liveListShow();
  if (Q.get('live')) {  // spectating: the live controls and the player block; the replay-only controls go (.replayonly)
    document.body.classList.add('live');
    document.getElementById('livebtn').hidden = false;
    document.getElementById('livebtn').onclick = e => { e.target.blur(); liveGoLive(); };
  }
  if (/^[A-Za-z0-9_]{4,64}$/.test(Q.get('live') || '')) {  // a live CCCaster match
    // (after an update reload: the match it was on, and where; liveResumeTake)
    liveResume = liveResumeTake(Q.get('live'));
    return startLive(Q.get('live'), liveResume && liveResume.match);
  }
  const lq = Q.get('l') || '';
  if (/^[A-Za-z0-9_-]{8,43}$/.test(lq)) {  // a shared playlist
    try {
      const r = await fetch(`${REPLAY_STORE}/l/${lq}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      pl.items = (await r.json()).items.map(it => ({ id: it.id, name: it.name, url: `${REPLAY_STORE}/s/${it.id}` }));
      return startItem(Math.min(pl.items.length, Math.max(1, +(Q.get('i') || 1))) - 1);
    } catch (e) { status(`could not load the playlist: ${e.message}`); return; }
  }
  if (autoload) {
    window.__mbaaRepUrl = autoload;
    const file = new File([await (await fetch(autoload)).arrayBuffer()], autoload);
    if (clipJ) await clipLtFor(clipJ, autoload);  // (before the first frame: the forcing starts at the battle's first)
    start(file);
  }
}
main().catch(e => { console.error(e); status('error: ' + e.message); });

// New version: every deploy rewrites index.html (each page file's content hash), so the page checks it every 3 min (past
// the Worker's and the service worker's caches) and, once it changed, reloads itself at the next safe moment, the URL
// (the live match, the replay) and the chat's sign-in carry over:
//   live: off the battle scene (character select, VS, result / win quote, loading, a match over) or paused;
//   a replay: paused, or nothing playing;
//   any: the tab hidden. Never while exporting a video or with a chat message typed and not sent.
// A short "updating" card shows first.
(function updateWatch() {
  const page = () => fetch(`${location.pathname}?_v=${Date.now()}`, { cache: 'no-store' }).then(r => r.ok ? r.text() : null).catch(() => null);
  // (a version: the static page's own script and version-meta values, the same on the document running and in a fetched copy)
  const verOf = d => [...d.querySelectorAll('script[src^="mbaa.js"], script[src^="bgm_stream.js"], script[src^="viewer.js"], meta[name^="mbaa-"]')]
    .map(e => e.getAttribute('src') || e.getAttribute('content')).join(' ');
  const ver = t => t && verOf(new DOMParser().parseFromString(t, 'text/html'));
  // (a local page has no ?v= hashes: nothing to compare)
  const mine = /\?v=/.test(verOf(document)) ? verOf(document) : null;
  let pending = false;
  const safe = () => {
    if (rec) return false;
    const typed = document.activeElement && document.activeElement.id === 'chatin' && document.activeElement.value;
    if (typed) return false;
    if (document.visibilityState === 'hidden') return true;
    const s = session;
    if (!s || ui.paused) return true;
    if (document.body.classList.contains('live')) { try { return s.M.HEAP32[0x54EEE8 >> 2] !== 1; } catch (e) { return false; } }
    return false;
  };
  const go = () => {
    const c = document.getElementById('catchup');
    if (c) { c.querySelector('.cu-t').textContent = 'Updating to the new version'; c.querySelector('.cu-s').textContent = 'back in a moment';
             c.querySelector('.cu-bar i').style.width = '100%'; c.hidden = false; }
    liveResumeSave();
    setTimeout(() => location.reload(), document.visibilityState === 'hidden' ? 0 : 1200);
  };
  setInterval(async () => {
    if (pending || !mine) return;
    const v = ver(await page());
    if (v && v !== mine) { pending = true; console.log('update: a new version is live; reloading at the next safe moment'); }
  }, 180000);
  setInterval(() => { if (pending && safe()) { pending = false; go(); } }, 1000);
  window.__mbaaUpdate = { check: async () => ver(await page()), mine, force: () => { pending = true; } };  // (tests)
})();
