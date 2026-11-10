// The engine worker (WORKER_PLAN.md): the game module, its session, timeline, keyframes and seeking run here, drawing
// into the page's canvas as an OffscreenCanvas. engine.js = this head + the engine's statements cut from viewer.js
// (tools/web/emit_engine.mjs) + engine_tail.js. This head: the worker's shims, and the page's names the engine code
// reaches, as messages to the page (events) or values the page gave at init.
'use strict';
self.window = self;
// (one clock with the page: performance.now() here reads the page's (its time origin on the worker's address), so every
// time the page hands the renderer (comment times on the wall clock, its pin, swell / gradient phases) and every
// timestamp the engine posts mean the same moment on both sides; rAF times shifted with it)
// (and while the page is hidden (cmd vis) the worker's animation frames wait, as a hidden page's do: the module's loop
// and the state ticker stand still and the hidden page's clock (engine_tail.js engBgTick) is the only one; a browser that
// still gave a hidden page's worker its frames drew and ticked twice)
let engHidden = false, engPip = false, engRafRelease = () => {};
{
  const to = +new URLSearchParams(self.location.search).get('to');
  const d = to > 0 ? performance.timeOrigin - to : 0, now = performance.now.bind(performance), raf = self.requestAnimationFrame.bind(self);
  const held = [];
  performance.now = () => now() + d;
  // (after each animation-frame callback, the module's game tick among them: engAfterRaf, while the picture it drew is
  // still in the canvas (not preserved past the frame): exportRealtime's frames, engine_tail.js)
  const run = (f, t) => { if (engIncPend) engIncRun();
    if (!engTL) { f(t + d); if (engAfterRaf) engAfterRaf(); return; }
    const a = now(); f(t + d); const b = now(); if (engAfterRaf) engAfterRaf(); engTlRec(t + d, b - a, a - t, f.name || '?', now() - b); };
  self.requestAnimationFrame = f => raf(t => { if (engHidden) { held.push(f); return; } run(f, t); });
  engRafRelease = () => { for (const f of held.splice(0)) raf(t => run(f, t)); };
}
let engAfterRaf = null;
// A game frame's keyframe work (viewer.js incTick: pre / commit / post), run at the start of this thread's next
// animation callback, before anything there steps the game: memory is still at that frame. At 120 Hz that callback is
// the refresh between two game frames (no step, no draw), so the work has the refresh to itself instead of adding to
// the frame's sim + render. A seek / restore drops a pending one (engine_tail.js)
let engIncPend = null;
function engIncRun() {
  const p = engIncPend; engIncPend = null;
  if (!p || p[0] !== session || p[0].seeking) return;
  const t0 = performance.now();
  incTick(p[0], p[1]);
  // (the tick's idle work gets what this refresh has left: main_browser.cpp viewer_idle_spent)
  const M = p[0].M; if (M && M._viewer_idle_spent) M._viewer_idle_spent(performance.now() - t0);
}
// The frame timeline (WORKER_PLAN phase 0 / 4, tests: cmd tl): every animation-frame callback of this thread timed:
// [rAF time, CPU ms, game frame, texture uploads, draws, heap MB, sim / scene / submit ms (the engine's profiler)].
// Off (null) unless a test asks; a refresh's callbacks share its rAF time
let engTlPart = {};
self.__tlCount = (k, v) => { if (engTL) engTlPart[k] = (engTlPart[k] || 0) + v; };  // (ms in the frame hook and its parts since the last callback)
let engTL = null, engTlPF = 0, engTlMsg = 0, engTlCmds = {}, engTlTimers = {};
// (while the timeline runs: the time this thread spends in timers, by the timer's first line, and the commands it gets)
{
  const st = self.setTimeout.bind(self), si = self.setInterval.bind(self);
  const wrap = f => { if (typeof f !== 'function') return f; const k = String(f).slice(0, 60);
    return (...a) => { if (!engTL) return f(...a); const t0 = performance.now(); try { return f(...a); } finally { const x = engTlTimers[k] || (engTlTimers[k] = [0, 0]); x[0]++; x[1] += performance.now() - t0; engTlMsg += performance.now() - t0; } }; };
  self.setTimeout = (f, ...a) => st(wrap(f), ...a);
  self.setInterval = (f, ...a) => si(wrap(f), ...a);
}  // (engTlMsg: ms this thread spent on messages since the last callback)
const engTlP0 = [0, 0, 0];
let engTlRes0 = 0;
function engTlRes(M) {  // (palette resolve draws since the last record: store.cpp g_storeStats[4])
  if (!M || !M._viewer_store_stats_ptr) return -1;
  const v = M.HEAPF64[(M._viewer_store_stats_ptr() >> 3) + 4], d = v - engTlRes0; engTlRes0 = v; return d;
}
function engTlRec(t, ms, lat, fn, after) {  // (lat: how late the callback ran after its frame began: this thread busy)
  const M = session && session.M;
  let fr = 0, up = 0, dr = 0, hp = 0, sim = 0, scn = 0, sub = 0;
  if (M) {
    try {
      hp = M.HEAPU8.length >> 20; fr = M._viewer_frame();
      const v = M._viewer_render_stats() >> 2; up = M.HEAP32[v + 5]; dr = M.HEAP32[v + 2];
      if (engTlPF) { const q = engTlPF >> 3, H = M.HEAPF64; sim = H[q] - engTlP0[0]; scn = H[q + 1] - engTlP0[1]; sub = H[q + 2] - engTlP0[2]; engTlP0[0] = H[q]; engTlP0[1] = H[q + 1]; engTlP0[2] = H[q + 2]; }
    } catch (e) { up = -1; }
  }
  engTL.push([t, ms, fr, up, dr, hp, sim, scn, sub, lat, engTlMsg, fn, after, engTlPart, self.__engOpens || 0, M ? M.HEAP32[0x54EEE8 >> 2] : -1, M ? M.HEAP32[0x74FD98 >> 2] : -1, engTlRes(M), self.__engPal || 0, M ? M.HEAP32[(M._viewer_render_stats() >> 2) + 15] : 0, self.__engArrB || 0]); self.__engPal = 0; self.__engArrB = 0; engTlMsg = 0; engTlPart = {}; self.__engOpens = 0;
}
let engOff = null, engWasmV = '';
const engPost = (m, tr) => postMessage(m, tr || []);
// (emscripten looks the canvas up by '#canvas'; the engine code reads mbaa.js's version from its script tag)
// (a live extension module (the secret stages) loads its scripts with a script tag: importScripts here)
// (the page's visibility, as it sends it (cmd vis): glRecover waits for a shown page, as on the page)
self.document = {
  get visibilityState() { return engHidden ? 'hidden' : 'visible'; },
  get hidden() { return engHidden; },
  querySelector: s => (s === '#canvas' ? engOff : /^script\[src\^="mbaa\.js"\]$/.test(s) ? { src: `mbaa.js?${engWasmV}` } : null),
  getElementById: id => (id === 'canvas' ? engOff : null),
  createElement: tag => (tag === 'script' ? {} : new OffscreenCanvas(1, 1)),
  get baseURI() { return self.location.href; },
  head: { append: sc => setTimeout(() => { try { importScripts(sc.src); } catch (e) { if (sc.onerror) sc.onerror(e); return; } if (sc.onload) sc.onload(); }) },
};
// (the page's settings the engine code and extensions read: given at init)
let engLS = {};
self.localStorage = { getItem: k => (k in engLS ? engLS[k] : null), setItem: (k, v) => { engLS[k] = String(v); } };
self.dispatchEvent = () => true;
self.requestIdleCallback = self.requestIdleCallback || (f => setTimeout(() => f({ timeRemaining: () => 8, didTimeout: false }), 1));
// the page's names (events out)
const bootMarks = {};
const bootMark = k => { if (bootMarks[k] == null) { bootMarks[k] = Math.round(performance.now()); engPost({ ev: 'bootMark', k }); } };
const status = t => engPost({ ev: 'status', t });
const loading = on => engPost({ ev: 'loading', on });
const catchUpShow = (left, total) => engPost({ ev: 'catchUp', left, total });
const swMark = (k, first, id) => engPost({ ev: 'swMark', k, first: typeof first === 'boolean' ? first : true, id: typeof id === 'string' ? id : null });
const setPaused = p => { ui.paused = p; engPost({ ev: 'paused', p }); if (session) { session.mute = p || !!session.seeking; if (!session.seeking) uiApply(session); } };
const toggleLoop = () => engPost({ ev: 'toggleLoop' });
const startItem = i => engPost({ ev: 'startItem', i });
// (a memory restore put the comment renderer back to the snapshot's (viewer.js ovRestored): set up again here, in the
// restore's own task, from what the page last sent (engine_tail.js engOvReplay))
self.mbaaChat = { ovRestored: () => engOvReplay(session && session.M) };
// (the canvas: the one the page handed over; a context lost for good (glRecover) asks the page for a new one first, as
// the page path's freshCanvas gives each new instance a new canvas element)
const freshCanvas = () => engOff;
// (the hash run's results: the page shows them and keeps window.__mbaaHash, with the plan's misses it fetched)
const hashDone = (name, h) => engPost({ ev: 'hashDone', name, h, misses: self.mbaaPlanMisses || null });
// (given by the page at init)
let LOWMEM = false, SW_KEEP = false;
// (the asset plan's misses (refetchAndReplay, liveMissed, the hash run): the page's window.mbaaPlanMisses, kept in step)
{ let pm; Object.defineProperty(self, 'mbaaPlanMisses', { configurable: true, get: () => pm, set: v => { pm = v; engPost({ ev: 'planMisses', l: v ? [...v] : null }); } }); }
const SPECTOR_P = null;
// files: the page owns the fetch (its file workers); the engine asks and they come back transferred
const engNeed = new Map();
let engNeedId = 0;
function fetchAll(man_, want, label = '', quiet = false) {
  const miss = [...want].filter(p => !cache.has(p));
  if (!miss.length) return Promise.resolve();
  const id = ++engNeedId;
  return new Promise(res => { engNeed.set(id, res); engPost({ ev: 'needFiles', id, paths: miss, label, quiet }); });
}
// sound: the page plays it (its audioHooks, WebAudio). Every call the game makes goes over stamped with its frame and
// the stage (what the page's hooks read off the module); the BGM log (keyframes keep it, a seek restores it) stays here
// and goes with each sync
function audioHooks(Module, s) {
  const q = s.sfxQueue = [];
  const at = () => [Module._viewer_frame(), Module.HEAP32[0x74FD98 >> 2], !!s.mute];
  s.bgmLog = [];
  const log = ev => { const k = Module._viewer_frame(); if (!s.tl || k >= s.tl.simMax) s.bgmLog.push([k, ...ev]); };
  Module.mbaaVoicePlay = (ch, path, vol, pan) => q.push([...at(), 'play', ch, path, vol, pan]);
  Module.mbaaVoiceParam = (ch, vol, pan) => { if (ch === -1) log(['param', vol, pan]); q.push([...at(), 'param', ch, vol, pan]); };
  Module.mbaaVoiceStop = ch => { if (ch === -1) log(['stop']); q.push([...at(), 'stop', ch]); };
  Module.mbaaBgmStop = () => { log(['stop']); q.push([...at(), 'bgmStop']); };
  Module.mbaaBgmStart = (path, loop, loopPos, vol, pan) => { log(['start', path, loop, loopPos, vol, pan]); q.push([...at(), 'bgmStart', path, loop, loopPos, vol, pan]); };
  s.stopSes = () => q.push([...at(), 'stopSes']);
  s.bgmHalt = fade => q.push([...at(), 'bgmHalt', fade]);
  s.bgmSync = T => q.push([...at(), 'bgmSync', T, s.bgmLog.slice()]);
}
// (the site's announcer lines: the page's, its audioHooks plays them)
const annDefaultLoad = () => engPost({ ev: 'annDefaultLoad' });
// the VS movie: the page fetches it (its object fetch) and transfers the bytes; the worker decodes (movieVideo)
let engMovieAsked = false;
const movieLoad = async () => { if (!engMovieAsked) { engMovieAsked = true; engPost({ ev: 'needMovie' }); } };
// the radio pick's stage (radioStageSync runs here, each frame): the page's pick as it sends it (cmd radio); a
// cross-fade over the swap is the page's (xfGrab: its picture held until the engine says the swap is in)
const engXf = new Map();
let engXfId = 0;
function xfGrab(until, max = 4000) { const id = ++engXfId; engXf.set(id, until); engPost({ ev: 'xfGrab', id, max }); return true; }
function engXfTick() { for (const [id, f] of engXf) { let done = true; try { done = !!f(); } catch (e) {} if (done) { engXf.delete(id); engPost({ ev: 'xfDone', id }); } } }
const livePreloadAll = () => {};
// ---- live (WORKER_PLAN.md to-do 2): liveBegin's poll runs here (the records, the snapshot join, the catch-up, hold /
// follow / rate, the select and load watchers, the banner, streaks, tapes); the page keeps the list, the decisions that
// start another session (startLive, liveSwitch, the next-match card) and the DOM, reached by events ----
let LIVE = '';  // (the feed's address: the page's, given at init)
// the page's state the live code reads, mirrored (cmd page): jump to live, the tab hidden, signed in (clips, streaks)
const engPage = { jump: true, hidden: false, clip: false };
const liveJump = () => engPage.jump, hidden = () => engPage.hidden, liveClipCan = () => engPage.clip;
const net = { bytes: 0 };
// (a worker's timers are not slowed in a hidden tab: the page's wTimeout is a plain timer here)
const wTimeout = (f, ms) => setTimeout(f, ms);
// the feed's requests, made here; the feed's state (its notice, failures) shown by the page
async function liveFetch(url, opt) {
  const n = liveNet, show = () => engPost({ ev: 'liveNet', fails: n.fails, notice: n.notice, trouble: n.troubleAt });
  const fail = () => { n.fails++; n.troubleAt = performance.now(); show(); };
  let r;
  try { r = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined, ...opt }); }
  catch (e) { fail(); throw e; }
  if (r.status >= 500) { fail(); return r; }
  let h = r.headers.get('X-Live-Notice') || '';
  try { h = decodeURIComponent(h); } catch (e) {}
  n.fails = 0; n.notice = h;
  if (h) n.troubleAt = performance.now();
  show();
  return r;
}
// the list, read here (the poll's end / next-game checks); each read to the page (its list panel, liveListLast)
async function liveList() {
  const r = await liveFetch(`${LIVE}/live/list`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const l = await r.json();
  engPost({ ev: 'liveList', l });
  return l;
}
// a snapshot asked for again (liveSnapJoin: the bridge had none yet); the first is the page's (its card prefetch)
function liveSnapFetch(id, info) {
  return liveFetch(`${LIVE}/live/${id}/snap?game=${info.game}` + (info.match ? `&match=${encodeURIComponent(info.match)}` : ''),
                   AbortSignal.timeout ? { signal: AbortSignal.timeout(60000) } : undefined)
    .then(async r => r.ok ? { bytes: new Uint8Array(await r.arrayBuffer()), frame: +r.headers.get('X-Snap-Frame'), age: +r.headers.get('X-Snap-Age'), got: performance.now() } : null)
    .catch(() => null);
}
// what the page answers for a live start (the play command's): the first records and the snapshot, as they come
const engLiveD = new Map();
function engLiveDef(k) {
  let d = engLiveD.get(k);
  if (!d) { let res; d = new Promise(r => { res = r; }); d.res = res; engLiveD.set(k, d); }
  return d;
}
// (the play's side: the entry goes once both the play and the page's answer have been, in either order)
function engLiveTake(k) { const p = engLiveDef(k); if (p.done) engLiveD.delete(k); else p.taken = true; return p; }
// the page's halves, as events (each sent when it changes where it is per frame)
const engSent = {};
const engPostOnce = (k, m) => { const j = JSON.stringify(m); if (engSent[k] !== j) { engSent[k] = j; engPost(m); } };
const livePreStart = () => engPost({ ev: 'livePreStart' });
const liveExtSet = (id, v) => engPost({ ev: 'liveExtSet', id, v });
const nextCardShow = (s, l, why) => { if (s === session) engPost({ ev: 'nextCard', l, why }); return true; };
const startLive = (id, match = null) => engPost({ ev: 'startLive', id, match });
async function liveSwitch(s, p) {  // (the page's start of the prepared game: its tape and entry)
  if (s.switching || session !== s) return;
  s.switching = true;
  if (!p.info.streak && s.streakKnown) p.info.streak = STREAK.map(a => s.M.HEAP32[a >> 2]);
  engPost({ ev: 'liveSwitch', rep: p.rep.slice(), info: p.info, game: p.game });
}
const liveThumb = () => engPost({ ev: 'liveThumb' });
const ffBadge = on => engPostOnce('ff', { ev: 'ffBadge', on });
const liveFollowUi = on => engPost({ ev: 'liveFollowUi', on });
const bannerPage = (ys, names, key) => engPostOnce('banner', { ev: 'bannerPage', ys, names, key });
const cardDraw = () => engPost({ ev: 'cardDraw' });
const slogSend = (s, why) => engPost({ ev: 'slogSend', why });
const liveClipUpload = () => {};  // (the page uploads a clip from the tapes it is sent: liveTapes, engine_tail.js)

// The engine's own code (WORKER_PLAN.md phase 5: moved out of viewer.js, the in-page engine path deleted). Built into
// web/_b/site/engine.js by tools/web/emit_engine.mjs: engine_head.js + this (each `//@viewer <name>` line: that statement
// from viewer.js, which the page reads too) + engine_tail.js. Runs only in the engine worker.

const Q = new URLSearchParams(location.search);  // (the page's query: viewer.js gives the worker its own address with it)
// viewer.js:167
const HASH = Q.get('hash') === '1', PERF = Q.get('perf') === 'pace', CAPTURE = Q.get('capture') === '1';
// viewer.js:182
const KF_EVERY = Math.max(10, +(Q.get('kf') || 300));  // playback keyframe interval (frames)
const KF_NEAR = 30;  // a seek that re-simulates further than 3x this keyframes about KF_NEAR frames before its target
// viewer.js:183
const PAGE = Math.min(65536, Math.max(16384, +(Q.get('page') || 16384)));  // keyframe page size (bytes)
const FREE_FILES = Q.get('free') !== '0';  // (low memory: a match's files freed once it has loaded; ?free=0: kept, tests)
const KZ = Q.get('kz') !== '0';  // keyframe pages zlib-compressed (?kz=0: zero-word packing only)
const KF_VERIFY = Q.get('kfverify') === '1';  // checks: a commit's reused pre-pass copies compared word for word with the page at the commit (window.__kfVerify)
const KF_BUDGET = +(Q.get('kfmb') || (LOWMEM ? 40 : 450)) * 1e6;
// the store textures the kept keyframes pin (kfTexBytes) have a budget of their own: over it, keyframes thin as over KF_BUDGET
// (low memory: beyond the newest keyframe's own textures, kfTexBytes)
const KF_TEX_BUDGET = +(Q.get('kftexmb') || (LOWMEM ? 32 : 256)) * 1e6;
const STORE_GC = Q.get('storegc') !== '0';  // texture store eviction (storeGc; ?storegc=0: off, every sealed texture kept for the match)
// viewer.js:325
const SLOG_MAX = 800, slog = [], slogT0 = performance.now();
// viewer.js:328
function slogAdd(ev, d = '') {
  slog.push([Math.round(performance.now() - slogT0), new Date().toISOString().slice(11, 23), ev, String(d).slice(0, 300)]);
  if (slog.length > SLOG_MAX) slog.splice(0, slog.length - SLOG_MAX);
}
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
  const now = performance.now(), tk = M._viewer_tick_count() >>> 0;
  // (the engine's loop ran lately: a window covered by another (a game in front of it) is never 'hidden' but its
  // browser stops the animation frames, so no frame is no stall of ours: 8 such reports from one Firefox on 2026-11-07)
  if (tk !== w.tk) { w.tk = tk; w.tkAt = now; }
  if (f !== w.f) { w.f = f; w.fAt = now; w.sent = false; }
  else if (!w.sent && s.liveSrc && !ui.paused && !hidden() && now - w.tkAt < 2000 && now - w.fAt > 20000) {
    w.sent = true; slogAdd('stall', `no frame for ${Math.round((now - w.fAt) / 1000)} s at frame ${f}`); slogSend(s, 'stall');
  }
}
// viewer.js:402
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
// viewer.js:408
const fmt = (t, c, m) => t.replace(/\{(\w):02d\}/g, (_, k) => String(k === 'c' ? c : m).padStart(2, '0'))
                          .replace(/\{(\w)\}/g, (_, k) => String(k === 'c' ? c : m));
// viewer.js:410
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
// viewer.js:427
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
// viewer.js:442
const cache = new Map();  // game path -> Uint8Array
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
      if (game) { M.mbaaOpened(path.slice(6)); self.__engOpens = (self.__engOpens || 0) + 1; }  // (engine timeline: a load)
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
  // the newest round start reached: the load that read the freed files is before it, so a restore from a keyframe at or
  // after it re-reads none of them (seekTo: kfSafe); one before it re-simulates that load
  if (s.tl) { const m = s.tl.marks.filter(m => m[0] <= s.freedAt).pop(); s.tl.safeFrom = m ? m[0] : s.freedAt; }
}
// a game file into MEMFS sharing the fetched buffer (MEMFS write with canOwn keeps the array instead of copying it; the
// game root is read-only and nothing writes the cache's arrays)
function fsPut(FS, path, d) {
  mkdirs(FS, path);
  const st = FS.open(path, 'w');
  try { FS.write(st, d, 0, d.length, 0, true); } finally { FS.close(st); }
}
// viewer.js:508
let actx, master, outGain, musicGain, sfxGain;
// viewer.js:794
const bgmDecoded = new Map(), bgmParsedMap = new Map();
// viewer.js:795
let bgmStreamReady = false;
// viewer.js:823
function bgmDecode(p) {
  if (!bgmDecoded.has(p)) {
    const d = cache.get(p);
    if (!d || !actx) return null;
    bgmDecoded.set(p, actx.decodeAudioData(d.slice().buffer));
  }
  return bgmDecoded.get(p);
}
// viewer.js:847
let session = null;
// viewer.js:848
const pl = { items: [], i: -1 };  // playlist: {name, file, url?} (see startItem)
// viewer.js:849
let man = null;
// viewer.js:850
const misses = new Set();  // bundle files the game looked up that the page had not fetched
// a WebGPU instance's device lost (the GPU process restarted, a driver reset, device.destroy()): as a lost GL context, the
// session started again on a new instance (its own device) at the same frame. The page path and the engine worker both
// (newSession / engineWarm); an instance lost before it was the session's (the prewarmed one) is not taken
function gpuLostHook(M) {
  const d = M.__wgBoot && M.__wgBoot.device;
  if (d) d.lost.then(() => {
    M.mbaaGpuDead = true;
    const s = session;
    if (s && s.M === M && !s.glLost) { s.glLost = true; glRecover(); }
  });
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
// viewer.js:1027
const frameBus = new Set();
// viewer.js:1028
let frameBusAt = -1e9;
// viewer.js:1029
function frameBusRun(now) {
  frameBusAt = now;
  for (const f of frameBus) { try { f(now); } catch (e) { console.warn('frame:', e); } }
}
// Boot snapshot: the used memory right after viewer_boot (pages packed like keyframes). The next match of a playlist
// restores it into the same instance (one wasm instance, one GL context and one copy of the shared files for the whole
// playlist; a new instance per match ran a phone out of memory). Memory above the boot heap is zeroed as in a fresh
// instance (the allocator takes fresh sbrk memory as zero); the restore's new GL generation deletes the last match's
// textures.
function bootSnapshot(M) {
  kzM = M;
  const top = M._viewer_mem_top(), W = PAGE >> 2, H = new Int32Array(M.HEAPU8.buffer), n = Math.ceil(top / PAGE);
  const pages = new Array(n);
  // (each page's hash, as a keyframe's, taken before packing (zlib's scratch changes as pages are packed): a kept live
  // match's keyframe (liveKeepTake) takes the boot page for one the game has not changed since boot, so only its changed
  // pages cost memory. None for the hash output and the zlib scratch: their content is not what was hashed)
  const hs = Array.from(pageHashes(M, n * PAGE));
  const x0 = Math.floor(M._viewer_page_hash_area(0) / PAGE), x1 = Math.ceil(M._viewer_page_hash_area(1) / PAGE);
  const z0 = M._viewer_kz_base ? Math.floor(M._viewer_kz_base() / PAGE) : -1, z1 = M._viewer_kz_base ? Math.ceil((M._viewer_kz_base() + M._viewer_kz_size()) / PAGE) : -1;
  let bytes = 0;
  for (let i = 0; i < n; i++) { pages[i] = packPage(H, i * W, W); pages[i].bootPage = 1; bytes += pages[i].bytes; }
  // (and only where the page hashes the same after packing: the pages zlib's calls wrote meanwhile (its C stack frames,
  // its arena counter) were packed with content other than what was hashed)
  const h2 = pageHashes(M, n * PAGE);
  for (let i = 0; i < n; i++) {
    const j = 4 * i;
    if ((i >= x0 && i < x1) || (i >= z0 && i < z1) || hs[j] !== h2[j] || hs[j + 1] !== h2[j + 1] || hs[j + 2] !== h2[j + 2] || hs[j + 3] !== h2[j + 3]) continue;
    pages[i].h = [hs[j], hs[j + 1], hs[j + 2], hs[j + 3]];
  }
  // (?bootcheck=1, the checks: each page's hash, to compare a prewarmed boot with play()'s own)
  if (Q.get('bootcheck') === '1') window.__mbaaBootImg = M.HEAPU8.slice(0x400000, 0x800000);
  if (Q.get('bootcheck') === '1') window.__mbaaBootPages = pages.map(q => (q.h ? q.h.map(x => (x >>> 0).toString(16)).join('') : 'x'));
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
  liveKeptStale(M);  // (a kept live match's textures survive the reset: liveKeepTake)
  M._viewer_tex_store_reset();  // the last match's sealed textures (the boot ones stay)
}
// viewer.js:1117
const PREWARM = !HASH && !CAPTURE && Q.get('reuse') !== '0' && !Q.get('files');
let warmP = null;
function engineWarm() {
  if (warmP || !PREWARM || session || !man || !man.plan || !man.plan.boot) return warmP;
  warmP = (async () => {
    const boot = withSiblings(man, new Set(man.plan.boot));
    await fetchAll(man, boot, '', true);
    if (session) return null;
    bootMark('warmModule');
    const wasmV = ((document.querySelector('script[src^="mbaa.js"]') || {}).src || '').split('?')[1];
    if (SPECTOR_P) await SPECTOR_P;
    const M = await MBAA({ print: t => console.log(t), printErr: t => console.warn(t), canvas: freshCanvas(), mbaaStoreKeep: !LOWMEM,
                           locateFile: p => (wasmV && p.endsWith('.wasm') ? `${p}?${wasmV}` : p) });
    gpuLostHook(M);
    if (session) return null;
    const w = { M, name: '', rep: new Uint8Array(0), live: true, mute: false, gen: 0, warm: true };
    // (the session's hooks act for the current session only: this one is it while it boots (one synchronous run, from
    // here to the snapshot), so its boot opens are tracked as play()'s are; then none again)
    session = w;
    try {
    fillSession(w, boot, null);
    // (play()'s settings before its viewer_boot)
    try { call(w, 'viewer_rate', 1); } catch (e) {}
    call(w, 'viewer_stage_anim', Q.get('stageAnim') !== null ? +(Q.get('stageAnim') !== '0') : 1);
    if (Q.get('seal') === '0') call(w, 'viewer_seal_off', 1);
    if (!call(w, 'viewer_boot')) return null;
    M._viewer_seal_boot();
    if (M._viewer_files_open()) return null;
    w.boot = bootSnapshot(M);
    M.mbaaBootOpened = new Set(w.opened);
    } finally { if (session === w) session = null; }
    bootMark('warm');
    // (the live matches' files after the engine: a list drawn before the manifest preloaded none)
    if (liveListLast) livePreloadAll(liveListLast.l);
    // (the shader programs built at idle while the list shows, one pass a callback: the tick's own idle step does it
    // once a match runs, so a tap's first frame waited on their links)
    if (M._viewer_gl_prewarm_step) (async () => {
      for (let more = 1; more && (!session || session.M === M);) {
        await new Promise(r => window.requestIdleCallback ? requestIdleCallback(() => r(), { timeout: 1000 }) : setTimeout(r, 30));
        more = M._viewer_gl_prewarm_step();
      }
      bootMark('glWarm');
    })().catch(e => console.warn('shader prewarm:', e));
    return w;
  })().catch(e => { console.warn('engine prewarm:', e); return null; });
  return warmP;
}
// the prewarmed instance as this session's (fillSession's reused path: the match's files over the boot ones)
function warmTake(w, rep, name, want) {
  const s = { M: w.M, name, rep, live: true, mute: false, gen: w.gen, boot: w.boot, reused: 1 };
  session = s;
  const M = s.M;
  if (movieBytes) M.mbaaMovie = movieBytes;
  else if (movieH264) M.mbaaMovieVideo = movieVideo(movieH264);
  movieLoad();
  return fillSession(s, want, new Set(w.want));
}
async function newSession(rep, name, want) {
  if (!session && warmP) {
    const w = await warmP;
    warmP = null;
    if (w && !session && !w.M.mbaaGpuDead) { bootMark('moduleStart'); bootMark('module'); return warmTake(w, rep, name, want); }
  }
  const prev = session;
  if (prev) { try { prev.M.ccall('viewer_stop', null, [], []); } catch (e) {} }
  window.dispatchEvent(new Event('mbaa-session-end'));
  if (prev && prev.boot && (!HASH && !CAPTURE ? Q.get('reuse') !== '0' : Q.get('reuse') === '1')) return reuseSession(prev, rep, name, want);
  if (prev && prev.M.mbaaMovieVideo) { prev.M.mbaaMovieVideo.close(); delete prev.M.mbaaMovieVideo; }
  // mbaa.wasm is built with mbaa.js: it takes mbaa.js's cache-busting version (tools/web/deploy_pages.sh)
  const wasmV = ((document.querySelector('script[src^="mbaa.js"]') || {}).src || '').split('?')[1];
  // mbaaStoreKeep: the texture store keeps the last match's textures for the next one (web/host/browser/d3d9_gl.cpp)
  bootMark('moduleStart');
  if (SPECTOR_P) await SPECTOR_P;
  const M = await MBAA({ print: t => console.log(t), printErr: t => console.warn(t), canvas: freshCanvas(), mbaaStoreKeep: !LOWMEM,
                         locateFile: p => (wasmV && p.endsWith('.wasm') ? `${p}?${wasmV}` : p) });
  gpuLostHook(M);
  bootMark('module');
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
  // (a reused instance: the last session's live load gate let go (liveBegin sets this one's). It was kept when a replay
  // followed a live match: that closure held the live session, its timeline and every keyframe, up to KF_BUDGET)
  M.mbaaLoaderGate = null;
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
  else if (movieH264) M.mbaaMovieVideo = movieVideo(movieH264);
  if (!HASH && !s.warm) movieLoad();  // (as soon as a match loads: its VS screen comes first; not for a prewarmed engine)
  trackOpens(s);
  audioHooks(M, s);
  if (!HASH && !bgmStreamReady) for (const p of s.want) if (/^bgm\/.*\.opus$/.test(p) && cache.has(p)) bgmDecode(p);
  return s;
}
// viewer.js:1118
const call = (s, f, ...a) => s.M.ccall(f, 'number', a.map(() => 'number'), a);
// play from the start; with catchUp = k, step to frame k first (no pacing) and continue from there
async function play(rep, name, catchUp = 0, want = null, liveId = null) {
  { const b = document.getElementById('ffbadge'); if (b) b.hidden = true; } catchUpShow(null);  // (a new session: its own state)
  misses.clear();
  const s = await newSession(rep, name, want);
  swMark('session');
  try { call(s, 'viewer_rate', 1); } catch (e) {}  // (a reused module keeps the last session's live pacing rate)
  // stage animations on, except for native comparisons (?stageAnim=0, hash runs): the oracle's settings have them off
  call(s, 'viewer_stage_anim', Q.get('stageAnim') !== null ? +(Q.get('stageAnim') !== '0') : HASH ? 0 : 1);
  if (Q.get('seal') === '0') call(s, 'viewer_seal_off', 1);
  bootMark('session');
  if (!call(s, 'viewer_boot')) { window.__mbaaStarted = -1; loading(false); status('start failed (see console)'); return; }
  // boot textures to the GPU store first: the snapshot (and every keyframe) then holds no pixels
  bootMark('booted');
  if (!s.reused) s.M._viewer_seal_boot();
  // a texture the game makes in play (a stage, a sprite bank at the fight's start) is stored raw and compact-coded in the
  // time later refreshes leave (main_browser.cpp gl_idle_step): coded in place it was ~50 ms of the VS -> fight frames on
  // desktop, ~150 on the Moto G (phase4). Phones: at most ENC_BUDGET MB waiting raw, the rest coded in place
  if (ENC_LATER && s.M._viewer_encode_later) s.M._viewer_encode_later(1, ENC_BUDGET * 1048576);
  if (!s.boot && (!HASH && !CAPTURE || Q.get('reuse') === '1') && !s.M._viewer_files_open()) {
    s.boot = bootSnapshot(s.M);
    s.M.mbaaBootOpened = new Set(s.opened);  // read before the snapshot: a reused instance's later matches never open them
  }
  bootMark('bootSnap');
  if (!call(s, 'viewer_load')) { window.__mbaaStarted = -1; loading(false); status('start failed (see console)'); return; }
  // a live clip's replay: the live session's forcing (clipLtFor), before the first frame
  s.lt = clipLt && clipLt.name === name && !liveSrc ? clipLt.bytes : null;
  if (s.lt && !s.M.ccall('viewer_lt_set', 'number', ['array', 'number'], [s.lt, s.lt.length])) { console.warn('clip: live forcing unreadable'); s.lt = null; }
  if (!s.lt) s.M.ccall('viewer_lt_clear', null, [], []);
  else console.log(`clip: replay played with its live forcing (${s.lt.length} bytes)`);
  if (HASH || CU_HASH) s.M.ccall('viewer_hash_enable', null, [], []);
  call(s, 'viewer_play', 0);
  swMark('play'); swMark('load');
  // (a live start: start()'s liveId, not the page's ?live=: a chat page joins a match in place (pushState), and with the
  // URL's parameters as loaded it played the boot tape as a replay, the players idle until a reload; user 2026-11-04)
  if (liveSrc && liveId && liveSrc.id === liveId) { liveBegin(s); swMark('boot', true, liveSrc.id); }
  call(s, 'viewer_hud', ui.hud ? 1 : 0);
  hitstunApply(s);
  window.__mbaa = { Module: s.M, man };
  bootMark('played');
  if (!HASH || CAPTURE) timelineInit(s);
  bootMark('timeline');
  swMark('timeline', s);
  if (s.liveResumeK && s.tl) liveResumeApply(s);  // (back to a kept live match: its keyframe)
  // the pre-scan is a second copy of the game (~400 MB with its files): not in low-memory mode, where marks come as playback reaches them
  if (!HASH && !CAPTURE && !PERF && !catchUp && !s.liveSrc && !(LOWMEM && Q.get('scan') !== '1')) startScan(s);
  window.__mbaaStarted = 1;
  if (!annDefault.p) setTimeout(annDefaultLoad, 500);  // (Neco's lines: once the first match runs, after its first frames)
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
  bootMark('run');
  swMark('run');
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
    if (LOWMEM && FREE_FILES && s.freedAt < 0 && s.tl && s.tl.marks.some(m => m[0] > (s.freeArm ?? -1) && m[0] <= s.M._viewer_frame()) && !s.seeking && !call(s, 'viewer_files_open')) freeLoaded(s);
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
  hashDone(s.name, h);
}
// viewer.js:1137
const ui = { paused: false, speed: 1, boxes: false, inputs: false, skipIntro: false, hud: true, music: true, hitstun: true };
// viewer.js:1144
const HS_STYLE = Q.get('hitstunStyle');  // (the bar's look while it is designed: 0 ETM, 1 ETM+, 2 UNI, 3 UNI + bounce diamonds)
// viewer.js:1145
const hitstunApply = s => {  // (an engine without it: nothing)
  if (s.M._viewer_hitstun_style && HS_STYLE != null) call(s, 'viewer_hitstun_style', +HS_STYLE);
  if (s.M._viewer_hitstun_bar) call(s, 'viewer_hitstun_bar', ui.hitstun ? 1 : 0);
};
function uiApply(s) {
  call(s, 'viewer_pause', ui.paused || s.seeking ? 1 : 0);
  call(s, 'viewer_speed', ui.speed);
  call(s, 'viewer_boxes_enable', ui.boxes ? 1 : 0);
  call(s, 'viewer_hud', ui.hud ? 1 : 0);
  hitstunApply(s);
}
function timelineInit(s) {
  const M = s.M;
  kzM = M;
  const t = s.tl = { kfs: [], simMax: 0, end: null, marks: [], fights: [], intro: -1, bytes: 0, lastKf: -1, seekMs: [],
                     want: null, running: false, round: -1, scene: -1, est: repEstimate(s.rep), M };
  M.mbaaTexKfRef = new Map();  // (a reused instance: the last match's keyframes are gone with its timeline)
  for (const [k, n] of M.mbaaTexHold || []) M.mbaaTexKfRef.set(k, n);  // (a kept live match's: liveKeepTake)
  M.mbaaFrame = f => {
    if (fb.on) fbSample(s, f);  // (the frame bar: every frame, a seek's re-simulation too)
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
    const cu = s.cu;
    if (cu) {
      // a live catch-up (liveCatchUp): the watchers where they can act, outside a battle, at the retry menu, a scene or
      // retry change, and every CU_WATCH frames (a streak post a few frames later); the banner once at the end. In a
      // battle with no retry menu they have nothing to hold or start: a select's files, the retry menu's rematch
      const sc = M.HEAP32[0x54EEE8 >> 2], rt = M._viewer_spectate_in_retry();
      if (sc !== 1 || rt || sc !== cu.scene || rt !== cu.retry || f - cu.full >= CU_WATCH) {
        cu.scene = sc; cu.retry = rt; cu.full = f;
        liveCssWatch(s); liveRematchHold(s); liveStreak(s); slogWatch(s);
      }
    } else if (s.liveSrc) { liveCssWatch(s); liveRematchHold(s); liveBanner(s); liveStreak(s); slogWatch(s); }
    else if (TUNE) liveBanner(s);
    if (!s.seeking) { if (incDefer) incDefer(s, f); else incTick(s, f); }
    // (a live catch-up: a keyframe every CU_KF_EVERY frames, every KF_EVERY in its last CU_KF_TAIL; low memory: none,
    // CU_KF_LOW, s.cuNoKf: also not in its last drawn frames, ~2 s at 4x against the frame-0 keyframe; the first is the
    // incremental one after the landing, incTick's slices)
    else if (!s.cuNoKf && f >= t.lastKf + (cu && f < cu.T - CU_KF_TAIL ? CU_KF_EVERY : KF_EVERY) && f >= t.simMax && !M._viewer_files_open() && !(LOWMEM && !t.marks.length)) keyframe(s, f);  // phones: none in the intro (incTick)
    // (the page's frame, once per tick: a tick stepping two game frames runs it once)
    if (!s.seeking && !cu && session === s) { const now = performance.now(); if (now - frameBusAt > 4) frameBusRun(now); }
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
const pageRef = (t, p, d) => {
  if (!p || p.bootPage) return;  // (a boot snapshot page shared by a keyframe: the snapshot holds it, not counted here)
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
// The live keyframes' pages packed in a worker (renderer GOAL C: zlib on the main thread took up to PACK_MS of a display
// frame while a keyframe packed, the game tick's p95). The same choice as packPage (zlib when smaller than the mask
// form, raw when mostly nonzero, else mask + nonzero words), zlib by the browser's CompressionStream ('deflate': a zlib
// stream, its 32 KB window inflated by viewer_kz_unpack). A page stays raw (q.r, usable by a restore) until its result
// comes back; a result for a page no longer held (n <= 0) or re-stored meanwhile is dropped.
const PACK_WORKER_SRC = `
onmessage = async e => {
  const { id, buf, n, W } = e.data, M32 = W >> 5, out = [];
  for (let p = 0; p < n; p++) {
    const r = buf.subarray(p * W, (p + 1) * W);
    let nz = 0;
    for (let j = 0; j < W; j++) if (r[j] !== 0) nz++;
    if (nz > 0) {
      const z = new Uint8Array(await new Response(new Blob([r]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
      if (z.length < Math.min(W * 4, M32 * 4 + nz * 4)) { out.push({ z }); continue; }
    }
    if (nz > W * 0.7) { out.push({ raw: 1 }); continue; }
    const m = new Int32Array(M32), v = new Int32Array(nz);
    for (let j = 0, k = 0; j < W; j++) { const x = r[j]; if (x !== 0) { m[j >> 5] |= 1 << (j & 31); v[k++] = x; } }
    out.push({ m, v });
  }
  postMessage({ id, out }, out.flatMap(o => o.z ? [o.z.buffer] : o.m ? [o.m.buffer, o.v.buffer] : []));
};`;
let packW = null, packId = 0;
const packJobs = new Map();
function packSend(t, list) {
  if (!packW) {
    packW = new Worker(URL.createObjectURL(new Blob([PACK_WORKER_SRC], { type: 'text/javascript' })));
    packW.onmessage = e => {
      const job = packJobs.get(e.data.id);
      packJobs.delete(e.data.id);
      if (!job) return;
      e.data.out.forEach((pk, k) => {
        const q = job.qs[k];
        if (q.r !== job.rs[k] || !(q.n > 0)) return;  // (dropped, or stored again since)
        if (pk.raw) { if (q.r.byteLength !== q.r.buffer.byteLength) q.r = q.r.slice(); return; }  // (its own copy: not a run's buffer kept)
        const bytes = pk.z ? pk.z.length : (pk.m.length + pk.v.length) * 4;
        if (pk.z) q.z = pk.z; else { q.m = pk.m; q.v = pk.v; }
        delete q.r;
        job.t.bytes += bytes - q.bytes; q.bytes = bytes;
      });
    };
  }
  // (the batch's pages into one buffer, transferred: each page's own copy was cloned on the way, and views of a run's
  // or the commit buffer's pages would clone the whole buffer)
  const id = ++packId, W = PAGE >> 2, buf = new Int32Array(list.length * W);
  list.forEach((q, k) => buf.set(q.r, k * W));
  // (a page in the commit buffer keeps a copy of its own until packed: that buffer is reused by the next commit)
  for (const q of list) if (t.commitBuf && q.r.buffer === t.commitBuf.buffer) q.r = q.r.slice();
  packJobs.set(id, { t, qs: list, rs: list.map(q => q.r) });
  packW.postMessage({ id, buf, n: list.length, W }, [buf.buffer]);
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
// Low memory: only the entries the newest keyframe does not name (that one's are the match's live textures, ~75-90 MB
// in a battle, kept by the store anyway): counted with them, one post-load keyframe alone was over the 64 MB budget, so
// a phone kept 3-4 keyframes whatever their page bytes (perf_plan R1, replay_load/r1/tex_probe.log)
function kfTexBytes(t) {
  const M = t.M, ref = M && M.mbaaTexKfRef, S = M && M.mbaaTexStore;
  let n = 0;
  const hold = M && M.mbaaTexHold;
  let live = null;
  if (LOWMEM) {
    const kf = t.kfs.find(k => k.frame === t.kfNewFrame) || t.kfs[t.kfs.length - 1];
    if (kf && kf.tex) { live = new Set(); for (let i = 0; i + 2 < kf.tex.length; i += 3) live.add(kf.tex[i] + ':' + kf.tex[i + 1] + ':' + kf.tex[i + 2]); }
  }
  if (ref && S) for (const k of ref.keys()) { const e = S.get(k); if (e && !e.perm && !e.stale && !(hold && hold.has(k)) && !(live && live.has(k))) n += e.bytes || 0; }
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
  // (the first keyframe: shared with the boot snapshot (same instance), so the pages the match has not changed since the
  // boot (~most of the exe's data and the boot files' heap) are not packed again: at 4x the first keyframe after a
  // live join took ~350 ms. Only those with a hash (the hash output and the zlib scratch have none)).
  const prev = at > 0 ? t.kfs[at - 1].pages : (s.boot ? s.boot.pages : []);
  const x0 = Math.floor(M._viewer_page_hash_area(0) / PAGE), x1 = Math.ceil(M._viewer_page_hash_area(1) / PAGE);
  const pages = new Array(n);
  let fresh = 0;
  for (let i = 0; i < n; i++) {
    if (i >= x0 && i < x1) { pages[i] = null; continue; }
    const q = prev[i], j = i * 4;
    if (q && q.h && q.h[0] === hs[j] && q.h[1] === hs[j + 1] && q.h[2] === hs[j + 2] && q.h[3] === hs[j + 3]) pages[i] = q;
    else { pages[i] = packPage(H, i * W, W); pages[i].h = [hs[j], hs[j + 1], hs[j + 2], hs[j + 3]]; t.bytes += pages[i].bytes; fresh++; }
    pageRef(t, pages[i], +1);
  }
  const kf = { frame: f, pages, ms: performance.now() - t0, fresh };
  kfTexAdd(t, kf);
  t.kfs.splice(at, 0, kf);
  t.lastKf = t.kfs[t.kfs.length - 1].frame;
  t.kfNewFrame = f;
  thin(t);
  storeGc(t);
}
// The first keyframe after the match's load (its first round start; low memory: the round start the freed files were
// freed after, t.safeFrom): restoring it re-simulates no load, so it is never thinned. Without it a phone's back seek
// past the thinned keyframes went to frame 0 and re-ran the load with its files freed (a stage .dat read as its 1-byte
// stand-in): the renderer crashed (perf_plan R1)
function kfPinned(t) {
  const from = t.safeFrom ?? (t.marks.length ? t.marks[0][0] : -1);
  return from < 0 ? null : t.kfs.find(k => k.frame >= from && !k.pending && !k.preSnap) || null;
}
// Over the memory budget (keyframe pages, or the store textures they pin): keyframes dropped one at a time, each time
// the one whose neighbours are closest (the spacing stays even: a back seek's re-simulation stays short everywhere),
// never the first, the last, a pending one, the pinned post-load one or the one just made (a seek's refinement keyframe
// near its target). Was: every second one dropped at once, so a phone kept a power-of-two spread and a back seek
// re-simulated up to 1,700 frames (perf_plan R1)
const kfOver = t => t.bytes > KF_BUDGET || (STORE_GC && kfTexBytes(t) > KF_TEX_BUDGET);
function thin(t) {
  let dropped = 0;
  while (t.kfs.length > 4 && kfOver(t)) {
    const pin = kfPinned(t);
    let best = -1, gap = Infinity;
    for (let i = 1; i < t.kfs.length - 1; i++) {
      const k = t.kfs[i];
      if (k.pending || k === pin || k.frame === t.kfNewFrame) continue;
      const g = t.kfs[i + 1].frame - t.kfs[i - 1].frame;
      if (g < gap) { gap = g; best = i; }
    }
    if (best < 0) break;
    const [k] = t.kfs.splice(best, 1);
    for (const p of k.pages) pageRef(t, p, -1);
    kfTexDrop(t, k);
    dropped++;
  }
  if (dropped) t.thinned = (t.thinned || 0) + dropped;
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
// (the engine worker runs a frame's keyframe work in its thread's next callback, before that one steps the game: at
// 120 Hz the refresh between two game frames, memory still at this frame: engine_tail.js. null: in the frame)
let incDefer = null;
// (the timeline's diagnostics: per frame and per keyframe all a live session long, so the newest STAT_MAX of each)
const STAT_MAX = 2000;
function statPush(a, v) { a.push(v); if (a.length > STAT_MAX + 200) a.splice(0, a.length - STAT_MAX); }
const POST_MS = 2.5;  // post pass: a tick checks (hash + copy) a commit's unhashed pages for ~POST_MS
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
// (the listed pages, sorted: each run of neighbours copied with one slice, a view of it per page. A slice per page made
// the first keyframe after a load (~4500 pages, the match's data) cost ~70 ms of the Moto G's engine thread plus its
// GC, 16 KB allocated and zeroed at a time: phase4 prof_560_600)
function preCopyList(M, c, list, hs) {
  const W = PAGE >> 2, H = new Int32Array(M.HEAPU8.buffer), pre = c.pre || (c.pre = new Map());
  for (let a = 0; a < list.length;) {
    let b = a + 1;
    while (b < list.length && list[b] === list[b - 1] + 1) b++;
    const run = H.slice(list[a] * W, (list[b - 1] + 1) * W);
    for (let k = a; k < b; k++) { const i = list[k]; pre.set(i, { r: run.subarray((k - a) * W, (k - a + 1) * W), h: [hs[4 * i], hs[4 * i + 1], hs[4 * i + 2], hs[4 * i + 3]] }); }
    a = b;
  }
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
    preCopyList(M, c, part.filter(i => !sameHash(hs, i, c.base.pages[i]) && !(c.pre && c.pre.has(i))), hs);
  }
}
function incTick(s, f) {
  const t = s.tl, M = s.M;
  // (a live match being left for another (liveWant: the tap's match) keeps playing until the new one's first frame, ~3 s
  // on a phone while the new match's files decode; its keyframe slices ran on through that: 0.45-0.65 s of the Moto G's
  // main thread per switch (join_phone_nokf_1107 profiles, deflate under incTick from the tap to the files mark).
  // Paused while another match is wanted; a want back to this one resumes them)
  if (s.liveSrc && liveWant && liveWant !== s.liveSrc.id) return;
  let c = t.inc;
  if (!c) {
    const base = t.kfs[t.kfs.length - 1];
    if (!base || base.pending || f < base.frame + KF_EVERY - KF_PHASE || f < t.simMax) return;
    // phones: none before round 1. The intro's frames hold the match's files as the game reads them (a keyframe there
    // kept ~95 MB of them); a seek into the intro simulates from frame 0
    if (LOWMEM && !t.marks.length) return;
    const hot = t.hotAt || (t.hotAt = new Map());
    const cold = [], top = Math.ceil(M._viewer_mem_top() / PAGE);
    const x0 = Math.floor(M._viewer_page_hash_area(0) / PAGE), x1 = Math.ceil(M._viewer_page_hash_area(1) / PAGE);
    // (a zero page (free heap) is cold too: ~4000 of them (64 MB) hashed at every commit cost ~6 ms of it on the Moto G;
    // one an allocation writes in the window drops that keyframe and is hot from then on. So is a page above the base's
    // heap top: the ~4500 a match load adds were hashed at every commit, 8 ms of a 12-22 ms tick, phase4 akiha_load)
    for (let i = 0; i < top; i++) if (!hot.has(i) && !(i >= x0 && i < x1)) cold.push(i);
    // (F at least a pre pass ahead: a commit dropped late, or one started past its frame, had no pre pass, so it hashed
    // and copied every changed page in one tick: after a radio stage swap, several 40-50 ms ticks in a row)
    c = t.inc = { F: Math.max(base.frame + KF_EVERY, f + KF_PHASE), base, cold, cur: 0, changed: [], kf: null, t0: 0, ms: 0 };
  }
  const t0 = performance.now(), phase = c.kf ? 'post' : f >= c.F ? 'commit' : 'pre';
  const slice = Math.ceil(c.cold.length / KF_PHASE);
  if (!c.kf) {  // pre pass
    // The scan, in the first half of the window at twice the share, finds the pages changed since the base and keeps
    // their hashes (c.seen), no copy: the commit takes them unhashed and the post pass copies each one whose hash is
    // still the same (its content then = at F). The second half checks them again: one changed since is hot (hashed and
    // copied at the commit). (Copying them ahead allocated the load's ~70 MB per attempt: GC, 27 -> 78 misses, akiha_top)
    const n = Math.min(c.cold.length, c.cur + (f >= c.F ? c.cold.length : 2 * slice));
    if (n > c.cur) {
      const part = c.cold.slice(c.cur, n);
      hashRuns(M, part);
      const hs = hashView(M, part[part.length - 1] + 1);
      const seen = c.seen || (c.seen = new Map());
      for (const i of part) if (!sameHash(hs, i, c.base.pages[i])) { c.changed.push(i); seen.set(i, [hs[4 * i], hs[4 * i + 1], hs[4 * i + 2], hs[4 * i + 3]]); }
      c.cur = n;
    }
    else if (f < c.F && c.seen) {  // the check again: a page changed since is hot from now on
      const r = c.ref || (c.ref = { list: [...c.seen.keys()], cur: 0 });
      const m = Math.min(r.list.length, r.cur + Math.ceil((r.list.length - r.cur) / Math.max(1, c.F - f)));
      if (m > r.cur) {
        const part = r.list.slice(r.cur, m);
        hashRuns(M, part);
        const hs = hashView(M, part[part.length - 1] + 1);
        for (const i of part) if (!sameHash(hs, i, { h: c.seen.get(i) })) { t.hotAt.set(i, t.kfs.length); c.seen.delete(i); }
        r.cur = m;
      }
    }
    if (f < c.F) preCopyHot(M, c);
    if (f >= c.F && c.cur === c.cold.length && !M._viewer_files_open() && !t.kfs.some(k => k.frame === f)) incCommit(s, f, c);
  } else {  // post pass
    // packed against wall time, not a share per game frame: a catch-up tick runs several game frames, and a share each
    // (zlib on the VS screen's ~2 MB of changed pages: ~40 ms) made a slow tick slower, so one stall fed the next
    // (one budget for the tick: packing up to half of POST_MS (one batch at least), the check the rest; packing on its
    // own window (PACK_MS 3) plus the check made 6-18 ms ticks on the Moto G, akiha_lazy3/4)
    for (let b = 0; !c.bad && c.raw.length && (b === 0 || performance.now() - t0 < POST_MS / 2); b++) packSend(t, c.raw.splice(0, 16));
    // (soon after F: a page that changed after F is taken for one changed around it, so the longer the check the more
    // keyframes it drops for nothing: over 60 frames the drops were found 11-47 frames after F, phase4 dbg_drops)
    // (and by time: 64 pages at a time while under POST_MS of the callback, so a tick's hash + copy of the load's pages
    // stays inside the refresh: a share per frame was 7-15 ms ticks on the Moto G, akiha_lazy1)
    let n = c.cur;
    while (n < c.tentative.length && (n === c.cur || performance.now() - t0 < POST_MS)) {
    const part = c.tentative.slice(n, Math.min(c.tentative.length, n + 64));
    n += part.length;
    {
      hashRuns(M, part);
      const hs = hashView(M, part[part.length - 1] + 1);
      const lazy = [];
      for (const i of part) {
        const q = c.kf.pages[i];
        if (!sameHash(hs, i, q)) {
          c.bad = true; t.hotAt.set(i, t.kfs.length);
          statPush(t.incStat.dropPages, [i * PAGE, q.lazy ? 'lazy' : q.r ? 'raw' : q.z ? 'z' : q.v.length, c.kf.frame, f]);
        } else if (q.lazy && !c.bad) lazy.push(i);
      }
      // (the same hash as at the scan and the check before F: its content now is its content at F; copied run by run)
      const H = new Int32Array(M.HEAPU8.buffer), W = PAGE >> 2;
      for (let a = 0; a < lazy.length;) {
        let b = a + 1;
        while (b < lazy.length && lazy[b] === lazy[b - 1] + 1) b++;
        const run = H.slice(lazy[a] * W, (lazy[b - 1] + 1) * W);
        for (let k = a; k < b; k++) {
          const q = c.kf.pages[lazy[k]];
          q.r = run.subarray((k - a) * W, (k - a + 1) * W); q.lazy = 0; c.raw.push(q);
          if (q.vr) { const V = self.__kfVerify || (self.__kfVerify = { reused: 0, bad: 0, late: 0 }); for (let j = 0; j < W; j++) if (q.r[j] !== q.vr[j]) { V.tentBad = (V.tentBad || 0) + 1; c.vbad = (c.vbad || 0) + 1; (c.vbadAt || (c.vbadAt = [])).push([lazy[k] * PAGE, j * 4, q.vr[j], q.r[j]]); break; } q.vr = null; }
        }
        a = b;
      }
    }
    }
    c.cur = n;
    // (a dropped keyframe still checks the rest of its pages, unpacked: each one that changed is hot from then on, so the
    // next attempt hashes them all at its commit and holds; stopping at the first made every attempt find a few more,
    // 21 dropped in a row on a phone-memory run, a big commit each)
    if (n === c.tentative.length && (c.bad || !c.raw.length)) {
      if (c.bad) {  // a cold page changed around F: its content at F is unknown
        const at = t.kfs.indexOf(c.kf);
        if (at >= 0) { t.kfs.splice(at, 1); for (const p of c.kf.pages) pageRef(t, p, -1); kfTexDrop(t, c.kf); }
        t.lastKf = t.kfs.length ? t.kfs[t.kfs.length - 1].frame : -1;
        t.incDropped = (t.incDropped || 0) + 1;
      } else {
        if (c.vbad && self.__kfVerify) self.__kfVerify.keptBad = (self.__kfVerify.keptBad || 0) + c.vbad; if (c.vbadAt && self.__kfVerify) (self.__kfVerify.keptBadAt || (self.__kfVerify.keptBadAt = [])).push(...c.vbadAt.slice(0, 8));  // (kfverify: a kept keyframe holding a stale copy)
        c.kf.pending = false; c.kf.ms = c.ms; t.kfNewFrame = c.kf.frame; thin(t);
      }
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
  const t = s.tl, M = s.M, W = PAGE >> 2, TS = performance.now();
  const top = M._viewer_mem_top(), n = Math.ceil(top / PAGE);
  const x0 = Math.floor(M._viewer_page_hash_area(0) / PAGE), x1 = Math.ceil(M._viewer_page_hash_area(1) / PAGE);
  // isCold: 1 = the same as the base in the pre pass, 2 = changed then, the same at its check again, not hot (c.seen).
  // Both are taken without a hash now and checked in the post pass (its hash then = the one taken; else the keyframe is
  // dropped and the page is hot); a 2 is copied there. Hashing the pages a load changed at the commit was 8-9 ms of a
  // 13-23 ms tick on the Moto G (~4900 pages in the commits after a match loads, phase4 akiha_enc2)
  const isCold = new Uint8Array(n);
  for (const i of c.cold) if (i < n) isCold[i] = 1;
  for (const i of c.changed) {
    if (c.seen && c.seen.has(i) && !t.hotAt.has(i)) { isCold[i] = 2; continue; }
    isCold[i] = 0; t.hotAt.set(i, t.kfs.length);
  }
  const now = [];
  for (let i = 0; i < n; i++) if (!isCold[i] && !(i >= x0 && i < x1)) now.push(i);
  const T0 = performance.now();
  if (self.__tlCount) { self.__tlCount('commitPages', now.length); self.__tlCount('c_preMs', T0 - TS); }
  hashRuns(M, now);
  const T1 = performance.now();
  const hs = hashView(M, n), H = new Int32Array(M.HEAPU8.buffer);
  const pages = new Array(n), tentative = [], changed = [], raw = [];
  let lazyN = 0;
  for (let i = 0; i < n; i++) {
    if (i >= x0 && i < x1) { pages[i] = null; continue; }
    const q = c.base.pages[i];
    if (isCold[i] === 1) { pages[i] = q; tentative.push(i); }
    else if (isCold[i] === 2) {
      pages[i] = { r: null, bytes: PAGE, h: c.seen.get(i), lazy: 1 }; tentative.push(i); lazyN++;
      if (KF_VERIFY) pages[i].vr = H.slice(i * W, i * W + W);  // (kfverify: its content at F, against the post pass's copy)
    }
    else if (sameHash(hs, i, q)) {
      pages[i] = q;
      // (a hot page the same as the base, marked hot two keyframes ago or more: cold again. Pages that changed once (a
      // round change, a load) stayed hot for good: 329 -> 1839 hashed at each commit over 40 s)
      const h = t.hotAt.get(i);
      if (h !== undefined && h <= t.kfs.length - 2) t.hotAt.delete(i);
    }
    else { changed.push(i); if (q) t.hotAt.set(i, t.kfs.length); }
  }
  // the changed pages copied ahead in the pre pass and the same since (its hash now = at the copy): that copy; the
  // rest copied now into one buffer (one allocation, not one per page)
  const late = [], TL0 = performance.now();
  for (const i of changed) {
    const p = c.pre && c.pre.get(i);
    if (p && sameHash(hs, i, p)) {
      if (KF_VERIFY) { const V = self.__kfVerify || (self.__kfVerify = { reused: 0, bad: 0, late: 0 }); V.reused++;
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
  const TL1 = performance.now();
  const fresh = raw.length + lazyN;  // (the changed pages and the ones the post pass copies)
  t.bytes += fresh * PAGE;
  for (let i = 0; i < n; i++) pageRef(t, pages[i], +1);
  if (self.__tlCount) { self.__tlCount('c_lateMs', TL1 - TL0); self.__tlCount('c_late', late.length); self.__tlCount('c_refMs', performance.now() - TL1); self.__tlCount('c_scanMs', TL0 - T1); }
  statPush(t.commitParts || (t.commitParts = []), [now.length, Math.round(T1 - T0), Math.round(performance.now() - T1), fresh]);
  const TT = performance.now();
  c.kf = { frame: f, pages, ms: 0, fresh, pending: true, inc: true };
  kfTexAdd(t, c.kf);
  t.kfs.push(c.kf);
  t.lastKf = f;
  if (self.__tlCount) self.__tlCount('c_tailMs', performance.now() - TT);
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
// a keyframe a restore can re-simulate from: none of the files the game would read from there was freed
const kfSafe = (s, kf) => !kf || !s.freed || !s.freed.size || s.tl.safeFrom == null || kf.frame >= s.tl.safeFrom;
// a replay's freed files back into MEMFS (a seek to before the match's load); freed again once playback passes a round
// start (watch, freeArm)
async function filesBack(s) {
  const back = [...s.freed];
  status(`seeking: reloading ${back.length} files`);
  try { await fetchAll(man, back, 'seeking: reloading files', true); }
  catch (e) { console.warn('seek: freed files:', e); status(`seek: the match's files did not load (${e.message})`); return false; }
  if (session !== s) return false;
  for (const p of back) { const d = cache.get(p); if (!d) { status(`seek: ${p} did not come back`); return false; } fsPut(s.M.FS, '/game/' + p, d); s.freed.delete(p); }
  s.M._viewer_resolve_reset();
  s.freedAt = -1; s.freeArm = -1; s.tl.safeFrom = null;
  return true;
}
async function seekTo(s, T) {
  const t = s.tl, M = s.M, t0 = performance.now();
  if (t.end !== null) T = Math.min(T, t.end);
  T = Math.max(1, Math.round(T));
  if (s.snapFrom != null && T <= s.snapFrom) T = s.snapFrom + 1;  // (a snapshot join: nothing of the game before its load)
  const cur = M._viewer_frame();
  // the nearest keyframe strictly before T (at least one step is drawn), unless the current state is nearer
  let kf = null;
  for (const k of t.kfs) if (k.frame < T) { if (!k.pending && !k.preSnap) kf = k; } else break;
  // (the frame bar on, its frames before T not kept: from a keyframe FB_BACK frames further back, so the bar has them)
  const fbBack = fbSeekBack(T);
  if (fbBack && kf) for (const k of t.kfs) if (k.frame < T - fbBack) { if (!k.pending && !k.preSnap) kf = k; } else break;
  // (a snapshot join: nothing to restore before the first keyframe after its load)
  if (s.snapFrom != null && !kf && !(T > cur)) { status('live: not kept this far back yet'); return; }
  // low memory: a restore from before the freed files' load (kfSafe) re-simulates it. A replay gets the files back
  // first (the browser's cache has them); live goes back no further than its pinned keyframe (re-simulating a set from
  // its first game would take minutes on a phone)
  const from = kf || t.kfs[0], pinned = kfPinned(t);
  // (live, low memory: never from before the pinned keyframe, freed files or not: the frame-0 keyframe re-simulates the
  // whole catch-up, ~20 s at phone speed)
  if (!(T > cur && (!kf || cur >= kf.frame)) && (!kfSafe(s, from) || (s.liveSrc && LOWMEM && (!pinned || from.frame < pinned.frame)))) {
    if (s.liveSrc) {
      const pin = pinned;
      if (!pin || !kfSafe(s, pin) || pin.frame >= cur) { status('live: not kept this far back on this device'); return; }
      if (T <= pin.frame) { T = pin.frame + 1; status('live: back to the earliest point kept on this device'); }
      kf = pin;
    } else if (!await filesBack(s)) return;
  }
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
  // (low memory: none before the match's first round start: the intro's frames hold its files as the game reads them,
  // ~20 MB of pages, and thinning then dropped the match's keyframes to make room)
  let near = T - f > 3 * KF_NEAR && !(LOWMEM && T <= (t.marks.length ? t.marks[0][0] : Infinity)) ? T - KF_NEAR : -1;
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
// viewer.js:1178
const SCENE_VS = 8, SCENE_WIN = 5;  // the VS screen and the win screen (g_CurrentSceneId 0x54EEE8)
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
const LIVE_BEHIND = 240;  // frames kept buffered (4 s)
const LIVE_WIN = 8;  // polls (~8 s) the catch-up decisions look back over (a round end's burst and pause: ~5 s)
// viewer.js:1197
let liveSrc = null;  // {id, info, since}
// viewer.js:1207
const wClock = { w: null, n: 0, cb: new Map() };
// viewer.js:1208
const wClear = t => { if (t < 0) wClock.cb.delete(-t); else clearTimeout(t); };
// viewer.js:1221
const liveNet = { fails: 0, troubleAt: -1e9, notice: '',
  delay: () => liveNet.fails ? Math.min(1000 * 2 ** (liveNet.fails - 1), 5000) : 1000,
  recent: () => performance.now() - liveNet.troubleAt < 60000 };
// viewer.js:1256
const annDefault = { files: null, p: null, src: '' };
// viewer.js:1355
let liveWant = null, liveCss = null;
// viewer.js:1365
let liveResume = null;
// viewer.js:1384
const liveOurs = (m, L) => !!m && !!L && m.id === L.id && (!m.match || !(L.info && L.info.match) || m.match === L.info.match);
// viewer.js:1388
const LIVE_IDLE = 300, liveIdle = m => m.age > LIVE_IDLE, liveGone = m => m.silent > 8 || liveIdle(m);
// viewer.js:1393
let sw = null;
// viewer.js:1443
let liveListLast = null;  // {at, l}: the newest list read (an entry from it is fresh for LIVE_FRESH ms)
// ---- the server snapshot join (artifacts/xz_check/perf_plan/snapjoin): the bridge's snapshot runner (tools/web/cc_snap.mjs)
// keeps a typed snapshot of each live game every ~1.5 s (web/host/snapshot.cpp: PC's MBAACC typed deep-join format + the
// web sections). A join loads it at its battle's first frames instead of re-simulating the game up to the live point, then
// catches up only the seconds after it. The one way in to a battle under way (2026-11-07, no fallbacks: the join that
// re-simulated the whole game is gone): no snapshot yet (a bridge just restarted: its runner makes one within seconds)
// is waited for, asked again each second; a refused load or one whose state hash differs starts the match again (a
// fresh snapshot), after SNAP_RETRY_MS once it has failed twice. The DVR goes back no further than the load (the frames before it are the
// joiner's own, not the game's: s.snapFrom), and the game gives no clip replay (its tape lacks the rounds before the join:
// web/host/spectate.cpp noTape).
const JOIN_PROF = Q.get('joinprof') === '1', SNAP_RETRY_MS = 5000;
const snapBad = new Map();   // ("<id>:<game>" -> loads refused / differing so far: the restarts back off after two)
// the join's load: true when loaded (the catch-up then has only the rest); window.__mbaaSnapJoin: what happened (the checks)
// (goal D) the join's load stores its sprite pages raw and codes them after (viewer_encode_later): desktop all of them;
// low-memory mode (phones) at most ENC_BUDGET MB raw (?encbudget=<MB>), the pages past it coded in place (user ruling
// 2026-11-06: a 16-24 MB cap)
const ENC_LATER = !HASH && !CAPTURE;
const ENC_BUDGET = LOWMEM ? Math.max(1, +(Q.get('encbudget') || 24)) : 0;
async function liveSnapJoin(s) {
  const L = s.liveSrc, M = s.M, t0 = performance.now(), J = window.__mbaaSnapJoin = { t0, ok: false };
  const p = L.snapP;
  L.snapP = null;
  if (!p || !M._viewer_snap_load) return false;
  // the base: this game's battle under way (scene code and committed scene 1, the live session InGame), unrendered
  const base = () => M.HEAP32[0x55D1D0 >> 2] === 1 && M.HEAP32[0x54EEE8 >> 2] === 1 && call(s, 'viewer_spectate_phase') === 2;
  if (JOIN_PROF) console.profile('join-base');   // (?joinprof=1, the checks: a CPU profile of the base's stepping)
  let f = M._viewer_frame(), stalls = 0, stallAt = 0, heldAt = 0, stepMs = 0, slow = [];
  const f0 = f, tw = performance.now();
  // (the load's sprite pages coded after the join: viewer_encode_later, on for all play since the session began)
  try {
  while (!base() && session === s) {
    const ta = performance.now(), g = M._viewer_step(1), d = performance.now() - ta;
    stepMs += d;
    if (d > 8 && slow.length < 24) slow.push(`${g}:${Math.round(d)}`);
    // (held: the match's files, the stream. Waited for by time, not turns: 600 message-channel turns were well under
    // a second, so a join that crossed a character select into a new pair gave up while that pair's files were still
    // downloading, and the next steps read them missing: "21 game files were missing", then index out of bounds, user
    // 2026-11-07. A stream that stops is the poll's to handle)
    if (g === f) { if (!stalls++) { stallAt = performance.now(); heldAt = call(s, 'viewer_spectate_held'); } else if (performance.now() - stallAt > 60000) break;
                   // (held by the stream itself (its hold count growing: the records end before this game's battle, or short
                   // of the LIVE_BEHIND margin a hold waits for, spectate_set_delay; a wait on files is not that): this game's battle is not in the records yet (a
                   // join that started on its character intro: a bridge restart's re-join). Its records come only from
                   // the poll, which awaits this join (liveCatchUp): it waited the 60 s out with the picture frozen. The
                   // snapshot goes back to the source and the join to the poll: the next poll joins once the battle is in)
                   if (performance.now() - stallAt > 1000 && call(s, 'viewer_spectate_held') > heldAt) { L.snapP = p; J.why = 'no battle yet'; console.warn('live: the snapshot join waits for the battle\'s records (back to the poll)'); return 'later'; }
                   await new Promise(r => setTimeout(r, stalls < 50 ? 0 : 20)); continue; }
    stalls = 0;
    f = g;
    if (f % 60 === 0) await cuTurn();
  }
  } finally {}
  // (the checks: frames stepped, time in the steps, the held steps (waits on files / the stream), the slow frames)
  Object.assign(J, { baseFrom: f0, stepMs: Math.round(stepMs), waitMs: Math.round(performance.now() - tw - stepMs), stalls, slow: slow.join(' ') });
  J.baseFrame = f; J.baseMs = performance.now() - t0;
  if (JOIN_PROF) console.profileEnd('join-base');
  if (session !== s || !base()) { J.why = 'no battle base'; return false; }
  // (a battle under way: its snapshot, waited for; asked again each second while the bridge has none)
  // A fetch still downloading is waited for, never dropped: a slow line (the ~1.4 MB snapshot over 5 s) used to start a
  // new fetch every 5 s and ignore the late answers, so it never joined (artifacts/ah3_join_layers run_before_delay). A
  // new one is asked for only once the last has settled without one (the bridge had none yet, or the request failed).
  let pend = p, settled = false, sn = null, tries = 0;
  const watch = q => { settled = false; Promise.resolve(q).then(() => { if (pend === q) settled = true; }, () => { if (pend === q) settled = true; }); };
  watch(pend);
  const race = (q, ms) => Promise.race([Promise.resolve(q).catch(() => null), new Promise(r => setTimeout(() => r(null), ms))]);
  while (session === s) {
    sn = await race(pend, 2500);
    if (sn || session !== s) break;
    if (++tries === 2) { status('live: joining: waiting for the match\'s snapshot'); slogAdd('live', 'waiting for the match\'s snapshot'); }
    if (!settled) continue;   // (still downloading)
    await new Promise(r => setTimeout(r, 1000));
    if (session !== s) break;
    pend = liveSnapFetch(L.id, L.info, true); watch(pend);
  }
  J.fetched = performance.now() - t0; J.tries = tries;
  if (!sn || session !== s) { J.why = 'left'; return null; }
  Object.assign(J, { bytes: sn.bytes.length, senderFrame: sn.frame, age: sn.age });
  const t = s.tl;
  if (M._viewer_spectate_set_first_game) M._viewer_spectate_set_first_game(L.firstGame ?? L.info.game);   // (the snapshot's same-game check)
  const buf = M._malloc(sn.bytes.length);
  M.HEAPU8.set(sn.bytes, buf);
  const tl = performance.now(), r = M._viewer_snap_load(buf, sn.bytes.length);
  J.loadMs = performance.now() - tl;
  M._free(buf);
  J.result = r;
  if (r !== 1) {
    J.why = M.ccall('viewer_snap_why', 'string', [], []);
    // (refused, or loaded with a differing state hash: this session's state is not the game's; the match again, from a
    // fresh snapshot)
    const k = `${L.id}:${L.info.game}`, n = (snapBad.get(k) || 0) + 1;
    snapBad.set(k, n);
    console.warn(`live: snapshot not used (${J.why}, ${n}): the match again`);
    setTimeout(() => { if (session === s) startLive(L.id, L.info.match || null); }, n > 2 ? SNAP_RETRY_MS : 0);
    J.restart = true;
    return null;
  }
  // the timeline from here: the keyframes before the load are the joiner's own frames, not the game's. The newest stays
  // only as the incremental keyframes' base (its pages shared; preSnap: never restored, seekTo / kfPinned); no keyframe is
  // made here (a whole-memory one: ~1.5 s at phone speed), the first after the load comes KF_EVERY frames on (incTick).
  // A rewind before it: refused (seekTo)
  if (t) {
    const keep = t.kfs.filter(k => !k.pending).pop();
    for (const k of t.kfs.splice(0)) if (k !== keep) { for (const q of k.pages) pageRef(t, q, -1); kfTexDrop(t, k); }
    if (keep) { keep.preSnap = true; t.kfs.push(keep); }
    t.inc = null;
    t.lastKf = keep ? keep.frame : -1;
    t.safeFrom = f + 1;
    t.marks = t.marks.filter(m => m[0] > f);
    t.simMax = Math.max(t.simMax || 0, f);
  }
  s.snapFrom = f;
  J.ok = true; J.ms = performance.now() - t0;
  console.log(`live: joined from the server's snapshot (sender frame ${sn.frame}, ${sn.age} ms old, ${sn.bytes.length} bytes) at frame ${f} in ${Math.round(J.ms)} ms`);
  return true;
}
// the last index number in a block of .ccs records (u32 index, u32 kind, rng 12 + ring 220, u32 frames, u16 x 2 x frames)
function liveLastIndex(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = 0, last = -1;
  while (o + 244 <= b.length) { last = dv.getUint32(o, true); o += 240 + 4 + 4 * dv.getUint32(o + 240, true); }
  return last;
}
// Catch-up (SWITCH_PLAN.md phases 4-5): frames stepped in ~CU_SLICE_MS tasks, then a real task turn (a message: timers,
// worker replies and network completions run in it; no 4 ms timer clamp); the frame hook's live watchers only where they
// can act (outside a battle, the retry menu, a scene change, every CU_WATCH frames: frameHook); DVR keyframes every
// CU_KF_EVERY frames until the last CU_KF_TAIL (there every KF_EVERY, as playback: a seek back from live finds them);
// one frame drawn every CU_SHOW_MS (the new match on screen at once, a fast-forward under the progress overlay). Drawn
// and undrawn frames are the same game state (a tick owing several frames draws only its last). (The old path, every
// watcher every frame, deleted 2026-11-07.) ?cuhash=1: the state-hash rows, for the checks
const CU_HASH = Q.get('cuhash') === '1';
// (the checks: the landing frame rounded down to a multiple of ?cuRound=, so runs that started catching up a few frames
// apart land on the same frame)
const CU_ROUND = +(Q.get('cuRound') || 0);
const cuTarget = (M, n) => { const f = M._viewer_frame(), T = f + n; return CU_ROUND && Math.floor(T / CU_ROUND) * CU_ROUND > f + 2 ? Math.floor(T / CU_ROUND) * CU_ROUND : T; };
// Phones (low memory): one frame drawn every 1.5 s (each costs ~100 ms at phone speed, texture uploads: 23% of a join),
// and no keyframes during the catch-up (21%: ~4 s of a 21 s join at 4x; the one against the frame-0 keyframe alone,
// 69 MB raw, ~424 ms): a rewind right after the join goes back to the landing keyframe at most (seekTo, kfPinned).
// ?cuKf=1: the keyframes as on desktop (the checks); ?cuShow=: the cadence (perf_plan L2 + L3)
const CU_SLICE_MS = +(Q.get('cuSlice') || 50), CU_SHOW_MS = +(Q.get('cuShow') ?? (LOWMEM ? 1500 : 200)), CU_KF_EVERY = 1800, CU_KF_TAIL = 600, CU_WATCH = 30;
const CU_KF_LOW = !LOWMEM || Q.get('cuKf') === '1';
const cuTurn = () => new Promise(r => { const ch = new MessageChannel(); ch.port1.onmessage = () => { ch.port1.close(); r(); }; ch.port2.postMessage(0); });
// marks of a match switch (performance.now(); window.__mbaaSwitch, the checks): click, picture (the new match's first
// frame drawn), cuStart / cuEnd (catch-up), live (caught up)
async function liveCatchUp(s, n) {
  bootMark('catchUp');
  if (s.liveSrc && s.liveSrc.snapP) {
    const was = s.seeking;
    s.seeking = true; s.mute = true; s.stopSes(); s.bgmHalt(); call(s, 'viewer_suppress', 1);
    let ok = false;
    try { ok = await liveSnapJoin(s); } finally { call(s, 'viewer_suppress', 0); s.seeking = was; }
    if (session !== s || ok === null) return;   // (left, or the match started again for a fresh snapshot)
    // (the battle not in the stream yet: back to the poll, which fetches it; its next jump joins (at the join's own
    // margin, not a later backlog's))
    if (ok === 'later') { s.liveJoined = false; s.mute = ui.paused; return; }
    if (ok) n = call(s, 'viewer_spectate_buffered') - LIVE_BEHIND;
    if (ok && n <= 2) {
      call(s, 'viewer_represent'); s.mute = ui.paused; uiApply(s); if (!ui.paused) s.bgmSync(s.M._viewer_frame());
      if (s.liveSrc) { liveCssWatch(s); liveRematchHold(s); liveBanner(s); liveStreak(s); slogWatch(s); }
      s.livePic = true; swMark('picture'); swMark('battlePic');
      cuDone(s, s.M._viewer_frame(), window.__mbaaSnapJoin.t0, 0);
      return;
    }
  }
  const M = s.M, T = cuTarget(M, n), DRAW = 2, t0 = performance.now(), f0 = M._viewer_frame();
  catchUpShow(T - f0, T - f0);
  s.seeking = true; s.mute = true;
  s.stopSes(); s.bgmHalt();
  uiApply(s);
  call(s, 'viewer_suppress', 1);
  s.cu = { T, scene: -1, retry: -1, full: -1e9 };
  s.cuNoKf = !CU_KF_LOW;
  swMark('cuStart', true, s.liveSrc && s.liveSrc.id);
  if (sw && s.liveSrc && sw.id === s.liveSrc.id) sw.cuFrames = (sw.cuFrames || 0) + (T - f0);
  let f = f0, per = 0.5, shown = -1e9, said = 0, stalled = false, drawn = 0;
  const pf = s.cuProf = { sim: 0, draw: 0, turn: 0, turns: 0 };
  try {
    while (f < T - DRAW && !stalled) {
      // a picture now and then, the first before any stepping (a game's first frames load it: its versus screen is on
      // screen meanwhile); not the last frames before T, drawn below
      if (CU_SHOW_MS > 0 && f < T - DRAW - 1 && performance.now() - shown >= CU_SHOW_MS && !hidden()) {
        const td = performance.now();
        if (s.liveSrc) liveBanner(s);  // (the players' names on the banner of the frame drawn)
        call(s, 'viewer_suppress', 0);
        const g = M._viewer_step(1);
        call(s, 'viewer_suppress', 1);
        pf.draw += performance.now() - td;
        if (g === f) { stalled = true; break; }
        f = g; drawn++; shown = performance.now();
        if (!s.livePic) { s.livePic = true; swMark('picture'); }
        if (M.HEAP32[0x54EEE8 >> 2] === 1) swMark('battlePic');
      }
      const ts = performance.now();
      // a task's worth: steps sized to the time left in the slice at the measured cost per frame
      for (let now = ts; f < T - DRAW && now - ts < CU_SLICE_MS; now = performance.now()) {
        const k = Math.max(1, Math.min(T - DRAW - f, Math.floor((CU_SLICE_MS - (now - ts)) / per)));
        const g = M._viewer_step(k), t1 = performance.now();
        pf.sim += t1 - now;
        if (g === f) { stalled = true; break; }  // (held: a select's files, the stream)
        per = Math.max(0.02, 0.5 * per + 0.5 * (t1 - now) / (g - f));
        f = g;
      }
      if (performance.now() - said > 200 || f >= T - DRAW) { said = performance.now(); status(`live: catching up (${T - f} frames to go)`); catchUpShow(T - f, T - f0); }
      const tt = performance.now();
      await cuTurn();
      pf.turn += performance.now() - tt; pf.turns++;
      if (session !== s) { catchUpShow(null); return; }
    }
  } finally { if (s.cu && s.cu.T === T) s.cu = null; }
  catchUpShow(null);
  call(s, 'viewer_suppress', 0);
  const tl0 = performance.now();
  if (f < T) call(s, 'viewer_step', T - f);
  else call(s, 'viewer_represent');
  s.cuLandMs = performance.now() - tl0;  // (the landing frames' time, drawn: the checks)
  s.cuNoKf = false;
  if (session === s && s.liveSrc) { liveCssWatch(s); liveRematchHold(s); liveBanner(s); liveStreak(s); slogWatch(s); }  // (the watchers once at the end)
  s.seeking = false; s.mute = ui.paused;
  uiApply(s);
  if (!ui.paused) s.bgmSync(M._viewer_frame());
  s.livePic = true;
  swMark('picture'); swMark('battlePic');
  cuDone(s, f0, t0, drawn);
}
// (the checks) the catch-up's rate, and the game state where it landed: the state-hash rows of every frame so far
// (?cuhash=1: viewer_hash_enable at the start) and the hashes of every memory page
function cuDone(s, f0, t0, drawn) {
  const M = s.M, f = M._viewer_frame(), ms = performance.now() - t0;
  const r = { frames: f - f0, ms, fps: (f - f0) / (ms / 1000), from: f0, frame: f, drawn, kfs: s.tl ? s.tl.kfs.length : 0, prof: s.cuProf || null,
             at: performance.now(), snap: s.snapFrom != null ? { ...window.__mbaaSnapJoin } : null,
             kfMs: s.tl ? s.tl.kfs.filter(k => k.frame >= f0).map(k => Math.round(k.ms)) : [], landMs: s.cuLandMs ?? null };
  s.cuProf = null;
  if (CU_HASH) {
    const rows = M.ccall('viewer_hash_take', 'string', [], []);
    s.cuRows = (s.cuRows || '') + rows;
    let h = 0x811c9dc5;
    for (let i = 0; i < s.cuRows.length; i++) h = Math.imul(h ^ s.cuRows.charCodeAt(i), 0x01000193);
    const lines = s.cuRows.split('\n').filter(l => l && !l.startsWith('k,'));
    Object.assign(r, { rowsHash: (h >>> 0).toString(16), rows: lines.length, lastRow: lines[lines.length - 1] || '' });
    const top = M._viewer_mem_top(), hs = pageHashes(M, top);
    const x0 = Math.floor(M._viewer_page_hash_area(0) / PAGE), x1 = Math.ceil(M._viewer_page_hash_area(1) / PAGE);
    const pages = [];
    for (let i = 0; i * 4 < hs.length; i++) pages.push(i >= x0 && i < x1 ? '' : [0, 1, 2, 3].map(j => (hs[i * 4 + j] >>> 0).toString(16)).join(''));
    r.pages = pages; r.top = top;
  }
  (window.__mbaaCatchUp = window.__mbaaCatchUp || []).push(r);
  swMark('cuEnd'); swMark('live');
  if (s.cssBgGo) s.cssBgGo();
  console.log(`live: caught up ${r.frames} frames in ${Math.round(ms)} ms (${Math.round(r.fps)} frames/s, ${drawn} drawn)`);
}
// viewer.js:1877
const VIEWER = Array.from(crypto.getRandomValues(new Uint8Array(12)), b => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
// viewer.js:2463
let stagePanel = null, stageKey = '', radio = null, oldRadio = null, radioGame = 'aacc';
// viewer.js:2614
let xfStagePending = false;  // (a pick's stage swap to crossfade: radioStageSync)
// viewer.js:2615
let xfYieldPending = false;  // (a pick's or a clear's swap with a live extension's page-drawn stage, to fade: radioStageSync)
// viewer.js:2664
let radioStageFollow = true;
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
// viewer.js:2767
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
// viewer.js:2776
const stageFollows = () => radioStageFollow || !!(radio && radio.chip);
// viewer.js:2777
const radioPickHasStage = () => !!(radio && stageFollows() && !HASH && (radio.dat || (radio.stages && radio.stages.length)));
function radioStageSync(s) {
  const M = s && s.M;
  if (!M || !M._viewer_radio_stage_id || s.glLost) return;
  // this viewer's own stage pick on the radio (a track with a stage, the stage following it) wins on this screen over a
  // live match's extension's stage (user 2026-11-03: a pick under a forced 3D stage showed the match's real stage, not
  // the pick): an override told so (its second argument, {own: true}) returns none, and a page-drawn stage gives way
  // (Module.__bgExtYield, below); cleared, the extension's stage is back
  const own = radioPickHasStage();
  // a private page's own stage file (window.mbaaStageOverride(s, {own}) -> {dat, lights, data}: a bgmake file the page
  // holds, put into MEMFS at /game/<dat>); it takes the radio's place while it returns one
  let ov = null;
  try { ov = window.mbaaStageOverride ? window.mbaaStageOverride(s, { own }) : null; } catch (e) {}
  if (ov && ov.data && memfsSize(M, ov.dat) !== ov.data.length) fsPut(M.FS, '/game/' + ov.dat, ov.data);
  const st = ov && ov.data ? ov : radio && radio.dat && !HASH && stageFollows() ? radio : null;
  // an MBAACC track: its stage (the match's own when it is one of the track's: nothing to swap)
  let stage = 0;
  if (!st && radio && stageFollows() && radio.stages && radio.stages.length && !HASH && M._viewer_radio_stage_want_stage) {
    const own = M._viewer_radio_stage_match();
    stage = radio.stages.includes(own) ? 0 : radio.stages[0];
  }
  if (radio) radio.stageNow = stage;
  const want = st ? radioDatId(st.dat) : stage ? radioDatId(`stage:${stage}`) : 0;
  // (the page-drawn stage (Module.__bgExt, d3d9_gl.cpp) gives way once the pick's stage is in the game and its swap's
  // crossfade is over, so the stage the pick replaced, hidden under the page's until then, never shows between; back at
  // once when the pick is cleared. The cut is the page's picture faded, as a stage swap's with no draw slot of its own)
  const ph = M._viewer_radio_stage_phase ? Math.floor(M._viewer_radio_stage_phase() / 10000) : 0;
  const yld = own && M._viewer_radio_stage_in() === want && ph !== 1 && ph !== 2 ? 1 : 0;
  // (faded only for a pick or a clear made just now, xfYieldPending: a keyframe restore swapping the pick's stage in again
  // cuts as it would without an extension)
  if ((M.__bgExtYield | 0) !== yld) {
    if (xfYieldPending && M.__bgExt && M.__bgExtOn && M.HEAP32[0x54EEE8 >> 2] === 1) xfGrab(() => true);
    M.__bgExtYield = yld;
  }
  if (M.__bgExtYield === undefined) M.__bgExtYield = 0;
  if (M._viewer_radio_stage_id() === want && (M.__bgExtYield | 0) === yld && (!own || yld)) xfYieldPending = false;
  if (!want && M._viewer_radio_stage_in()) radioOwnStage(s);
  if (M._viewer_radio_stage_id() === want) { xfStagePending = false; return; }
  // (a pick's stage swap: crossfaded once it is sent; a keyframe restore sending it again is not)
  // (in battle only: elsewhere the stage comes in with the battle's own load and fade, and a held copy would freeze the
  // VS screen)
  // (the two-phase swap, web/host/radio_stage.cpp, crossfades the stage alone in its own draw slot: no page snapshot,
  // which would fade the fighters and HUD too; the page fade stays only for the all-at-once reference, mbaaRadioDefer 0)
  const fade = () => { if (xfStagePending) { xfStagePending = false; if (M.HEAP32[0x54EEE8 >> 2] === 1 && !(M._viewer_radio_stage_phase && M.mbaaRadioDefer !== 0)) xfGrab(() => M._viewer_radio_stage_in() === want); } };
  if (stage) { if (radioFilesIn(s, stage)) { fade(); M._viewer_radio_stage_want_stage(stage, want); } return; }
  if (st && !st.data && !radioPut(s, st.dat)) return;
  fade();
  if (st) st.lights.forEach(([pos, power], i) => M._viewer_radio_stage_light(i, pos, power));
  M.ccall('viewer_radio_stage_want', null, ['string', 'number', 'number'], [st ? st.dat : '', want, st ? st.lights.length : 0]);
}
// viewer.js:3195
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
// viewer.js:3210
function liveCssFiles(man) {
  const out = new Set();
  for (const p of Object.keys(man.files))
    if (/^(grp\/c_sel_aa|grp\/bgselect|data\/_csel)\//.test(p) || /^data\/[^/]+_\d\.txt$/.test(p) || /^bgm\/bgmme9[89]\./.test(p) ||
        /^story\/battle\/[^/]+_table\.txt$/.test(p)) out.add(p);
  return withSiblings(man, out);
}
// viewer.js:3222
const CSS_SCENE = 20, CSS_OBJ = 0x773158, CSS_SLOT = 0x74D8E8, BATTLE_SLOT = 0x74D838, STAGE_ID = 0x74FD98;
function liveCssWatch(s) {
  const H = s.M.HEAP32, g = a => H[a >> 2];
  // (held only for a game that goes to the select: the players' retry menu choice 'character select' received
  // (liveCssChoice), or the select reached. A rematch reads none of these files: it was held all the same at every
  // result screen until all ~80 MB were in, ~45 s on a phone that joined late in a game, the list meanwhile on the next
  // game, then a fresh start: "they don't work on the phone", 2026-11-01)
  const sc = g(0x54EEE8);
  if (s.cssBgP && !s.cssBgReady && !s.cssBgHeld && (sc === CSS_SCENE || (s.cssChoice && (sc === 5 || call(s, 'viewer_spectate_in_retry'))))) { s.cssBgHeld = true; if (s.cssBgGo) s.cssBgGo(); liveHoldApply(s); }
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
// viewer.js:3228
const stageOk = id => id === 0 || !man || !man.files || !!man.files[`bg/bg${String(id).padStart(2, '0')}.dat`];
// viewer.js:3229
function stageStandIn(id) {
  const ok = Object.keys(man.files).map(f => /^bg\/bg(\d\d)\.dat$/.exec(f)).filter(Boolean).map(m => +m[1])
    .filter(n => n > 0 && n !== 57 && n !== 58).sort((a, b) => a - b);  // (not the two giant stages: wider)
  return ok.length ? ok[id % ok.length] : 1;
}
// viewer.js:3234
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
// (2 s: the bridge's probe of the host often takes 5-35 s or fails (journal 2026-11-03: "no InitialGameState; again in
// 5 s", "not offered"); at 20 s the picture sat on the select's end that long, then jumped in and fast-forwarded the
// backlog: user 2026-11-02. Our select follows the players', so our picks go on and the late check switches if not)
const SETUP_WAIT = Q.get('liveTestLate') === '1' ? 0 : 2000;  // (test: no wait, the late check runs)
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
// viewer.js:3258
const STREAK = [0x76FC14, 0x770EB4];  // g_P1ConsecutiveWinStreak, g_P2ConsecutiveWinStreak (the player records', +0x4A0)
const asciiName = n => /^[\x20-\x7e]*$/.test(n);
// viewer.js:3260
const TUNE = Q.get('tune') === '1';
// viewer.js:3261
const bannerTune = { nameGap: -1, nameSize: 16, nameDy: 0, winsGap: -1, winsSize: 11, winsDy: -11, maxPx: 216, scrollSpeed: 40,
  lapGap: 24, streak: -1, pageFont: 13, testP1: '', testP2: '' };
function liveBanner(s) {
  const T = bannerTune;
  const ln = (s.liveSrc && s.liveSrc.info.names) || [];
  // (every frame: only a change does work; the page layout is read only then, as reading it each frame forced a
  // layout per frame against the other per-frame style writes, renderer GOAL C)
  const names = [0, 1].map(p => (TUNE && [T.testP1, T.testP2][p]) || (ln[p] || '').trim() || '');
  const key = names[0] + '\0' + names[1] + '\0' + (ui.names ? 1 : 0) + (TUNE ? JSON.stringify(T) : '');
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
  bannerPage([0, 1].map(p => (ui.names && names[p] && !asciiName(names[p]) ? call(s, 'viewer_banner_y', p) : -1000)), names, key);
}
// The players' win streaks, as the game's own (the banner's "N WINS"; ResultMenu_UpdatePlayerStats counts them on):
// the bridge's for this game (a viewer that knew them sent them), else unknown (from 0, as a CCCaster spectator). Put
// in after viewer_play (CharaSelect_InitReplayMode zeroes them) and before the first frame: the match start copies them
// for the banner (ResetBattleMode: Netplay_GetWinCounts).
function liveSeedStreak(s) {
  if (liveSrc.info.streak) liveSrc.info.streak.forEach((w, p) => { s.M.HEAP32[STREAK[p] >> 2] = w; });
}
// Each game's first battle frame: the streaks it started with, to the bridge (later viewers start from them)
// Also the moment a game is won (the result counts them on): the next game's, sent ahead (game + 1), so viewers who
// (re)load between games (a site update reloads everyone at once) still start from them; that game's own first-frame
// send then confirms them. (Before: everyone reloaded between games -> nobody knew -> the count restarted at 0, 2026-11-02)
function liveStreak(s) {
  if (!s.streakKnown) return;
  const g = call(s, 'viewer_spectate_game'), game = g >= 0 ? g : s.liveSrc.info.game;
  const w = STREAK.map(a => s.M.HEAP32[a >> 2]), post = (gm, ws) =>
    liveClipCan() && fetch(`${LIVE}/live/${s.liveSrc.id}/streak?game=${gm}`, { method: 'POST', body: ws.join(',') }).catch(() => {});  // (signed in only: F-06)
  if (s.M.HEAP32[0x54EEE8 >> 2] === 1 && game !== s.streakSent) {
    s.streakSent = game; s.streakAt = w.join(','); s.streakAhead = null;
    post(game, w);
    return;
  }
  // (after this game's start: a change is the win being counted)
  // (only a count going up, in the battle or win scene (the result counts them there): the next game's setup zeroes them, never sent ahead)
  const was = s.streakAt == null ? null : s.streakAt.split(',').map(Number);
  if (game === s.streakSent && was && [1, SCENE_WIN].includes(s.M.HEAP32[0x54EEE8 >> 2]) && w.every((x, i) => x >= was[i]) && w.some((x, i) => x > was[i])
      && s.streakAhead !== w.join(',')) {
    s.streakAhead = w.join(',');
    post(game + 1, w);
  }
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
// viewer.js:3331
const KEEP_MS = +(Q.get('keepms') || 300000);
// viewer.js:3332
let liveKept = null, liveResumeK = null, liveClickAt = null;
// viewer.js:3335
const texKey = (a, i) => a[i] + ':' + a[i + 1] + ':' + a[i + 2];
// the store entries a kept keyframe names: counted in M.mbaaTexHold, and in the timeline's reference map (store eviction
// skips them; timelineInit seeds a new session's map from the hold)
function liveHoldTex(M, tex, d) {
  const hold = M.mbaaTexHold || (M.mbaaTexHold = new Map()), ref = M.mbaaTexKfRef;
  for (let i = 0; i + 2 < tex.length; i += 3) {
    const k = texKey(tex, i), n = (hold.get(k) || 0) + d;
    if (n > 0) hold.set(k, n); else hold.delete(k);
    if (ref) { const r = (ref.get(k) || 0) + d; if (r > 0) ref.set(k, r); else ref.delete(k); }
  }
}
// (restoreBoot, before the store reset: a held entry the match being left did not use was marked stale by the reset
// before, and a stale one goes at the next: unmarked, the reset marks it stale again and keeps it)
function liveKeptStale(M) {
  const S = M.mbaaTexStore;
  if (S && M.mbaaTexHold) for (const k of M.mbaaTexHold.keys()) { const e = S.get(k); if (e) e.stale = 0; }
}
function liveMemTight() {
  const m = performance.memory;  // (Chromium only; elsewhere the 5 minutes and the one-match cap bound it)
  return !!(m && m.jsHeapSizeLimit && m.usedJSHeapSize > 0.8 * m.jsHeapSizeLimit);
}
function liveKeptDrop(why) {
  const K = liveKept;
  if (!K) return;
  liveKept = null;
  wClear(K.timer);
  try { liveHoldTex(K.M, K.kf.tex, -1); } catch (e) {}
  console.log(`live: the kept match is dropped (${why})`);
  if (session && session.tl && session.M === K.M) storeGc(session.tl);
}
// viewer.js:3337
function liveKeptStat(K) {
  const S = K.M.mbaaTexStore, seen = new Set(), cur = session && session.want;
  let tex = 0, texOnly = 0, files = 0, recs = 0;
  for (let i = 0; i + 2 < K.kf.tex.length; i += 3) {
    const k = texKey(K.kf.tex, i), e = S && S.get(k);
    if (seen.has(k) || !e || e.perm) continue;
    seen.add(k); tex += e.bytes || 0; if (e.stale) texOnly += e.bytes || 0;
  }
  for (const p of K.want) if (!(cur && cur.has(p))) { const d = cache.get(p); if (d) files += d.length; }
  for (const b of K.recs.values()) recs += b.length;
  const r1 = x => Math.round(x / 1e5) / 10;
  return { frame: K.kf.frame, game: K.game, pagesMB: r1(K.bytes), pagesOwn: K.own, pagesBoot: K.shared, texMB: r1(tex),
           texOnlyMB: r1(texOnly), filesOnlyMB: r1(files), recsKB: Math.round(recs / 1e3), awayS: Math.round((Date.now() - K.at) / 100) / 10,
           polls: K.polls, takeMs: Math.round(K.ms * 10) / 10 };
}
// the session being left for another live match (startLive, just before the new one starts): kept
function liveKeepTake(s) {
  if (!SW_KEEP || !s || !s.liveSrc || !s.tl || !s.boot || !s.M || session !== s) return;
  const L = s.liveSrc, M = s.M, t = s.tl, t0 = performance.now();
  if (L.moved || L.next || L.backEnded || s.cssHeld || s.loadHeld || call(s, 'viewer_ended')) return;
  if (liveMemTight()) { console.log('live: the match left is not kept (memory pressure)'); return; }
  // (an incremental keyframe in progress: dropped, as a seek does: its pages are not all packed yet)
  if (t.inc) {
    if (t.inc.kf) { const at = t.kfs.indexOf(t.inc.kf); if (at >= 0) { t.kfs.splice(at, 1); for (const p of t.inc.kf.pages) pageRef(t, p, -1); kfTexDrop(t, t.inc.kf); } }
    t.inc = null;
    t.lastKf = t.kfs.length ? t.kfs[t.kfs.length - 1].frame : -1;
  }
  const f = M._viewer_frame();
  if (!M._viewer_files_open()) keyframe(s, f);
  let kf = null;
  for (const k of t.kfs) if (k.frame <= f && !k.pending) kf = k;
  if (!kf || kf.frame < f - 600) { console.log('live: the match left is not kept (no keyframe near its frame)'); return; }
  const B = s.boot.pages;
  let bytes = 0, shared = 0, own = 0;
  const pages = kf.pages.map((q, i) => {
    if (!q) return null;
    const b = B[i];
    if (b && b.h && q.h && b.h[0] === q.h[0] && b.h[1] === q.h[1] && b.h[2] === q.h[2] && b.h[3] === q.h[3]) { shared++; return { boot: b }; }
    own++; bytes += q.bytes;
    const c = { bytes: q.bytes, h: q.h };
    if (q.r) c.r = q.r; else if (q.z) c.z = q.z; else { c.m = q.m; c.v = q.v; }
    return c;
  });
  const g0 = call(s, 'viewer_spectate_game');
  liveKeptDrop('another match kept');
  const K = liveKept = {
    M, id: L.id, match: L.info.match || null, info: L.info, game: g0 >= 0 ? g0 : L.info.game, rep: s.rep, name: s.name,
    want: new Set([...s.want].filter(p => !s.freed.has(p))), kf: { frame: kf.frame, pages, tex: kf.tex ? Int32Array.from(kf.tex) : new Int32Array(0) },
    recs: L.recs, since: L.since, tapes: L.tapes, firstGame: L.firstGame, marks: t.marks.slice(), fights: t.fights.slice(),
    // (the game's music requests up to the keyframe: the track playing there started before it, in this session; without
    // them a switch back played no music until the next game, a live extension's music none either: user 2026-11-07)
    bgm: (s.bgmLog || []).filter(e => e[0] <= kf.frame),
    streakKnown: s.streakKnown, at: Date.now(), bytes, shared, own, polls: 0, ms: 0, timer: 0 };
  liveHoldTex(M, K.kf.tex, +1);
  K.ms = performance.now() - t0;
  K.timer = wTimeout(() => liveKeptPoll(K), 1000);
  console.log(`live: the match left is kept for a switch back (frame ${kf.frame}, ${(bytes / 1e6).toFixed(1)} MB of its own pages, ` +
              `${shared} pages the boot snapshot's, ${K.ms.toFixed(1)} ms)`);
}
// while away: the kept match's records, read on as the session would (not counted as a viewer: no v=), kept only
async function liveKeptPoll(K) {
  if (liveKept !== K) return;
  if (Date.now() - K.at > KEEP_MS) return liveKeptDrop(`kept ${Math.round(KEEP_MS / 1000)} s`);
  if (liveMemTight()) return liveKeptDrop('memory pressure');
  try {
    const r = await fetch(`${LIVE}/live/${K.id}/rec?from=${K.info.game}&since=${K.since}` + (K.match ? `&match=${encodeURIComponent(K.match)}` : ''),
      { cache: 'no-store', ...(AbortSignal.timeout ? { signal: AbortSignal.timeout(5000) } : {}) });
    if (liveKept !== K) return;
    if (r.status === 404) return liveKeptDrop('it left the feed');
    if (r.ok) {
      const b = new Uint8Array(await r.arrayBuffer());
      if (liveKept !== K) return;
      if (b.length) { liveKeep(K, b); K.since = liveLastIndex(b); }
      K.polls++;
    }
  } catch (e) {}
  if (liveKept === K) K.timer = wTimeout(() => liveKeptPoll(K), 1000);
}
// viewer.js:3357
function liveBackTake(K, prev, click) {
  liveKept = null; wClear(K.timer);  // (its texture hold stays until the restore takes it over: liveResumeApply)
  const B = window.__mbaaSwitchBack = { click, start: performance.now(), awayS: (Date.now() - K.at) / 1000, kept: liveKeptStat(K) };
  if (prev && prev.liveSrc && prev.liveSrc.id !== K.id) liveKeepTake(prev);
  console.log(`live: back to the kept match (${B.awayS.toFixed(1)} s away)`);
  liveResumeK = K;
  return B;
}
// play(), after timelineInit: the kept keyframe restored into the new session (the instance's boot state + this match's
// load are under it), the records fed again, then the time away caught up
function liveResumeApply(s) {
  const K = s.liveResumeK, t = s.tl, M = s.M, t0 = performance.now(), B = window.__mbaaSwitchBack || (window.__mbaaSwitchBack = {});
  s.liveResumeK = null;
  // (pages of its own for this timeline's counts; a boot page counts no bytes: the boot snapshot holds it anyway)
  const kf = { frame: K.kf.frame, ms: 0, fresh: 0, pages: K.kf.pages.map(q => !q ? null : q.boot ? { ...q.boot, n: 0, bytes: 0 } : { ...q, n: 0 }) };
  for (const q of kf.pages) if (q) { t.bytes += q.bytes; pageRef(t, q, +1); }
  liveHoldTex(M, K.kf.tex, -1);  // (the hold, from here the timeline's own reference)
  kf.tex = K.kf.tex;
  for (let i = 0; i + 2 < kf.tex.length; i += 3) { const k = texKey(kf.tex, i); M.mbaaTexKfRef.set(k, (M.mbaaTexKfRef.get(k) || 0) + 1); }
  let at = t.kfs.length;
  while (at > 0 && t.kfs[at - 1].frame > kf.frame) at--;
  if (at > 0 && t.kfs[at - 1].frame === kf.frame) { const o = t.kfs.splice(at - 1, 1)[0]; for (const p of o.pages) pageRef(t, p, -1); kfTexDrop(t, o); at--; }
  t.kfs.splice(at, 0, kf);
  t.lastKf = t.kfs[t.kfs.length - 1].frame;
  t.marks = K.marks; t.fights = K.fights; s.bgmLog = K.bgm;  // (later requests come again as the catch-up steps past kf)
  restore(s, kf);
  const scene = M.HEAP32[0x54EEE8 >> 2];
  t.simMax = Math.max(t.simMax, kf.frame); t.scene = scene; t.round = M.HEAP32[0x77BFA4 >> 2]; t.intro = scene === 1 ? M.HEAPU8[0x55D20B] : -1;
  s.liveHeldSeen = call(s, 'viewer_spectate_held');
  s.liveJoined = false;  // (the first poll's jump threshold: as at a join)
  s.swBack = B;
  B.restored = performance.now(); B.restoreMs = Math.round((B.restored - t0) * 10) / 10; B.frame = kf.frame; B.copied = t.lastCopied;
  if (Q.get('swhash') === '1') {  // (test: the state rows of the 30 frames after the restored one, live_switch_back_check.py)
    const wt = M.HEAP32[0x55D1D4 >> 2];
    M.ccall('viewer_hash_enable', null, [], []);
    call(s, 'viewer_suppress', 1); call(s, 'viewer_step', 30); call(s, 'viewer_suppress', 0);
    B.rows0 = { from: kf.frame, wt, csv: M.ccall('viewer_hash_take', 'string', [], []) };
  }
  B.gap = call(s, 'viewer_spectate_buffered') - LIVE_BEHIND;
  // (after play() has started the loop: the gap, unrendered; the first poll's jump finds the session seeking)
  setTimeout(async () => {
    if (session !== s) return;
    const n = call(s, 'viewer_spectate_buffered') - LIVE_BEHIND;
    B.catchStart = performance.now(); B.catchN = n;
    if (n > 30 && !s.seeking) await liveCatchUp(s, n);
    if (session !== s) return;
    B.caught = performance.now();
    console.log(`live: back at the kept match's live point: restore ${B.restoreMs} ms (${B.copied} pages), ${n} frames caught up, ` +
                `${Math.round(B.caught - (B.click ?? B.start))} ms from the click`);
  }, 0);
}
// viewer.js:3376
function liveStateNow() {
  const s = session;
  if (!s || !s.liveSrc || !s.M) return null;
  return { id: s.liveSrc.id, frame: s.M._viewer_frame(), ahead: call(s, 'viewer_spectate_buffered'), seeking: !!s.seeking,
           follow: !!s.liveFollow, game: call(s, 'viewer_spectate_game'), scene: s.M.HEAP32[0x54EEE8 >> 2], swLive: s.swLive ?? null,
           wt: s.M.HEAP32[0x55D1D4 >> 2],  // (g_WorldTimer: the game's own frame; a session's frame numbers are its own)
           kfs: s.tl ? s.tl.kfs.length : 0, tlMB: s.tl ? Math.round(s.tl.bytes / 1e5) / 10 : 0, heapMB: Math.round(s.M.HEAPU8.length / 1e5) / 10 };
}
// viewer.js:3384
async function stateRowsTake(k, n) {
  const s = session;
  if (!s) return null;
  if (k != null) await requestSeek(k);
  const f0 = s.M._viewer_frame(), wt = s.M.HEAP32[0x55D1D4 >> 2];
  s.M.ccall('viewer_hash_enable', null, [], []);
  call(s, 'viewer_suppress', 1); call(s, 'viewer_step', n); call(s, 'viewer_suppress', 0); call(s, 'viewer_represent');
  return { from: f0, wt, csv: s.M.ccall('viewer_hash_take', 'string', [], []) };
}
function liveFollow(s, on) {
  s.liveFollow = on;
  if (!on && s.liveFF) { s.liveFF = false; call(s, 'viewer_speed', ui.speed); }
  if (!on && s.liveTrim) { s.liveTrim = false; call(s, 'viewer_rate', 1); }
  liveFollowUi(on);
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
  livePreStart();
  const L = liveSrc;
  s.liveSrc = L;
  s.M.mbaaLoaderGate = () => liveLoaderGate(s);
  s.streakKnown = !!L.info.streak;
  liveSeedStreak(s);
  s.streakSent = -1; s.streakAt = null; s.streakAhead = null; s.bannerKey = null;
  L.since = L.info.game;
  L.recs = new Map();
  // (a start whose entry is fresh (the join, a list read just now): the first poll goes straight to the records and the
  // jump; its list read comes with the poll after (was: awaited before the catch-up could start)
  if (L.fresh) { L.fresh = false; L.listAt = performance.now(); }
  L.next = false;
  // (the session's finished games' replays, for clip links: liveTapes; a reused instance's older ones go)
  L.tapes = new Map(); L.firstGame = L.info.game; L.clipPend = null;
  // (back to a kept match: its records, read on while away, and its finished games' tapes; play() restores its keyframe)
  const KB = liveResumeK && liveResumeK.id === L.id && liveResumeK.M === s.M ? liveResumeK : null;
  liveResumeK = null;
  s.swClick = liveClickAt; liveClickAt = null;
  if (KB) { L.recs = KB.recs; L.since = KB.since; L.tapes = KB.tapes; L.firstGame = KB.firstGame; s.streakKnown = KB.streakKnown; s.liveResumeK = KB; }
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
      // (match: our match's key; the bridge answers 404 once the host is on another match, and so does the page itself
      // once the list has said so (L.moved): another match's records fed into ours hung the picture, user 2026-11-02)
      // (the first answer: the records startLive asked for with the boot tape or the join, the same request)
      const f0 = L.first;
      L.first = null;
      const f = f0 && !L.moved ? await f0 : null;
      const r = f ? { ok: true, status: 200, headers: { get: () => f.ext }, arrayBuffer: async () => f.bytes }
        : L.moved ? { ok: false, status: 404 } : await liveFetch(`${LIVE}/live/${L.id}/rec?from=${L.info.game}&since=${L.since}&v=${VIEWER}` +
        (L.info.match ? `&match=${encodeURIComponent(L.info.match)}` : ''),
        AbortSignal.timeout ? { signal: AbortSignal.timeout(5000) } : undefined);
      if (r.ok && session === s) liveExtSet(L.id, r.headers.get('X-Live-Ext'));
      // (a 404 is the bridge saying the capture or game is not there: its capture closed (the match over) or the host's
      // id is on another match now: no data, so the stream reads as quiet, not an outage. Was: every 404 restarted the
      // quiet clock, so a session whose match had left the bridge never read as dry and sat frozen)
      if (!r.ok && r.status !== 404) L.failAt = performance.now();
      // (404 with the match still ours on the list: after a bridge restart: the list check below)
      if (r.status === 404 && !L.moved && !f) L.noGameAt ??= performance.now(); else if (r.ok) L.noGameAt = null;
      if (r.ok) {
        const b = new Uint8Array(await r.arrayBuffer());
        // (every answer repeats the newest index whole: new data = a later index or a longer answer, else the stream is
        // quiet, which the dry check below needs to see)
        const last = b.length ? liveLastIndex(b) : -1;
        if (b.length && (last !== L.since || b.length !== L.recLen)) L.dataAt = performance.now();
        L.recLen = b.length;
        if (b.length && session === s) {
          swMark('records', true, L.id);
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
    // (watching back: once its picture has reached the stream's newest frame too, the end is looked for there. Was: only
    // following, so a viewer watching back never read the list and never saw the match end: match_end_follow_check)
    if ((over || dry || s.liveFollow || ahead < 15) && performance.now() - (L.listAt || -1e9) > listEvery) {
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
        if (now && !mine) L.moved = true;  // (the host on another match: nothing more of ours comes; the poll stops asking)
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
        // The bridge restarted mid-set: its new capture of our match holds the games from its own join on, so our
        // records (asked from the game this session started on, from=L.info.game) are a 404 'no such game' for good
        // while the list still has our match. Index numbers are the host's, so the rule below (mine.index < L.since)
        // never fires there, and a rematch (same setup) waited for that stream forever (user 2026-11-09: the page sat
        // at the result screen after a restart). 3 s of 404s with our match listed: start again on its current game.
        if (mine && L.noGameAt != null && t - L.noGameAt > 3000 && (s.liveFollow || over || ahead < 15) && liveNet.recent()) {
          console.warn(`live: the feed has no game ${L.info.game} any more (the bridge re-joined the match): starting again on game ${mine.game}`);
          return startLive(L.id, L.info.match);
        }
        if (mine && (over || dry) && mine.index < L.since && liveNet.recent()) {
          return startLive(L.id, L.info.match);  // (after a restart: the bridge's new capture of the match, numbered from its own join)
        } else if (ended && !s.liveFollow && (ui.paused || !(call(s, 'viewer_ended') || ahead < 15))) {
          // (watching back (a seek, a chat timestamp, a step): the card once the picture has played to the end (the game
          // over, or the stream's last frames played: a spectator's game waits there, never ends), unless paused. Was:
          // never, so a viewer who had clicked a chat timestamp stayed on the ended match for good: part of the audience
          // lost at every match end, user 2026-11-03. The poll goes on meanwhile (was: a return, which stopped it: the
          // end was never looked at again)
          L.backEnded = true;
        } else if (ended) {
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
      // (timing: each poll between the first records and the catch-up, what the jump waits on)
      if (sw && sw.id === L.id && sw.marks.records != null && sw.marks.cuStart == null && (sw.polls || (sw.polls = [])).length < 12)
        sw.polls.push({ t: Math.round(performance.now() - sw.t0), ahead, floor, synced: !!s.liveSynced, css: !!s.cssHeld, load: !!s.loadHeld,
                        retry: call(s, 'viewer_spectate_in_retry'), seeking: !!s.seeking });
      // (the jump only while the engine's loop runs: a covered window's browser runs no animation frames, and jumping
      // its stalled session to live every ~17 s only spent the CPU of the game in front of it)
      const tkNow = s.M._viewer_tick_count() >>> 0, looping = tkNow !== s.pollTk;
      s.pollTk = tkNow;
      if (s.liveSynced && liveJump() && !hidden() && looping && !s.cssHeld && !s.loadHeld && !call(s, 'viewer_spectate_in_retry')) {
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
      if (s.liveSynced && !s.seeking && !s.livePic) { s.livePic = true; swMark('picture'); if (s.cssBgGo) s.cssBgGo(); }  // (no catch-up: drawn as it plays)
      // the link card's picture (tools/web/cc_live.mjs): a fight on screen (4 s into the battle scene: past its fade-in;
      // not mid-jump, not dark), as soon as there is one, then every 2 minutes
      const battle = s.M.HEAP32[0x54EEE8 >> 2] === 1;
      if (!battle) s.battleAt = null;
      else if (s.battleAt == null) s.battleAt = performance.now();
      if (s.liveSynced && battle && !hidden() && !s.seeking && performance.now() - s.battleAt > 4000) liveThumb(s, L);
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
      if (s.liveSynced && !s.seeking && ahead <= LIVE_BEHIND + 90 && ahead > 0) {
        if (sw && sw.marks.frame == null) swMark('frame', true, L.id);
        swMark('live', true, L.id);
        if (!s.cardLive) { s.cardLive = true; cardDraw(); }  // (the engine's data from here: redrawn only where they differ)
      }
      const ff = !hold && excess > 180;
      const trim = !hold && !ff && (excess > 30 || (s.liveTrim && excess > 0));
      if (trim !== !!s.liveTrim) { s.liveTrim = trim; call(s, 'viewer_rate', trim ? 1.05 : 1); }
      if (ff !== !!s.liveFF) { s.liveFF = ff; call(s, 'viewer_speed', ff ? 2 : ui.speed); }
      ffBadge(ff);
      // (a switch's time to live: the click to the session caught up and paced near LIVE_BEHIND (no 2x fast-forward,
      // excess within 180 frames); window.__mbaaSwitchTimes, newest last; a switch back to a kept match: also
      // __mbaaSwitchBack.live)
      if (s.swClick != null && s.swLive == null && s.liveSynced && !s.seeking && !hold && ahead >= 15 && !ff && (!s.swBack || s.swBack.caught)) {
        s.swLive = performance.now();
        if (s.swBack) { s.swBack.live = s.swLive; s.swBack.liveAhead = ahead; }
        const a = window.__mbaaSwitchTimes || (window.__mbaaSwitchTimes = []);
        a.push({ id: L.id, back: !!s.swBack, ms: Math.round(s.swLive - s.swClick), frame: s.M._viewer_frame() });
        if (a.length > 20) a.shift();
      }
      if (s.cssHeld || s.loadHeld) status('live: loading the next game');
      else status(hold ? `live: waiting for the stream (${(ahead / 60).toFixed(1)} s buffered)`
                  : `live: ${(ahead / 60).toFixed(1)} s behind the players` + (ff ? ' (catching up)' : ''));
    } else if (!s.seeking) {
      status(L.backEnded ? 'the match has ended (watching back: the next match once this one has played out)'
                         : `live: watching back, ${(ahead / 60).toFixed(0)} s behind (LIVE to catch up)`);
    }
    wTimeout(poll, liveNet.delay());
  };
  poll();
}
// viewer.js:3476
const nextCard = { s: null, id: null, at: 0, timer: 0, raf: 0, stay: null, why: null };
// viewer.js:3477
const liveName = m => m.matchup || (m.names || []).map(n => (n || '').trim()).join(' vs ');
// viewer.js:3777
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
// viewer.js:3852
const FB_CAP = 1024, FB_PER = 20, FB_N = 2 * FB_PER + 7, FB_CELLS = 75, FB_MEM = 400, FB_INTERVAL = 20;
// viewer.js:3855
const FBC = { INACT: 1, JUMP: 2, HITSTUN: 3, BLOCK: 4, ACTIVE: 5, FREE: 6, ADV: 7, NEUTRAL: 8, FREEZE: 9, THROWN: 11,
              HITSTOP: 12, SHIELD: 13, THROW: 14 };
// viewer.js:3859
const fb = { on: false, s: null, raw: null, tag: null, last: -1, procF: -1, rebuild: false, dirty: false, m: null, cv: null, place: true };
// viewer.js:3860
function fbMachine() {
  const P = () => ({ main: new Uint8Array(FB_MEM), sub: new Uint8Array(FB_MEM), air: new Uint8Array(FB_MEM), proj: new Uint8Array(FB_MEM),
                     lastBusy: 0, lastActive: 0, lastProj: 0, firstActive: 0, firstCounter: 0, gotFirst: false, total: 0 });
  return { p: [P(), P()], counter: 0, interval: 0, intervalMax: FB_CELLS, isReset: false, doReset: false, doAdv: false,
           shared: 0, lastFc: 0, lastTrue: -1, clock: 0, inEx: false, freeAt: [-1, -1], adv: 0, advCell: -1, any: false };
}
// viewer.js:3866
function fbResetBars(m) {
  m.isReset = true; m.counter = 0; m.advCell = -1; m.interval = 0; m.doReset = false; m.intervalMax = FB_CELLS;
  for (const P of m.p) { P.main.fill(0); P.sub.fill(0); P.air.fill(0); P.proj.fill(0); }
}
// viewer.js:3871
function fbStep(m, R, o) {
  const g = o + 2 * FB_PER, X = [o, o + FB_PER];
  if (R[g + 3] !== 1) return;  // (not in a battle)
  const fc = R[g + 1], trueF = R[g + 2];
  if (trueF === m.lastTrue) return;
  if (m.lastTrue < 0) m.lastFc = fc;
  const b0 = R[X[0]], b1 = R[X[1]];
  if (fc !== m.lastFc && !R[g + 4]) m.clock += fc - m.lastFc;
  // the advantage (above); doAdv: ETM's, for the cells' advantage colour
  if (b0 === 0 && b1 === 0) m.doAdv = false;
  else if (b0 !== 0 && b1 !== 0) m.doAdv = true;
  if (b0 !== 0 && b1 !== 0) { m.inEx = true; m.freeAt[0] = m.freeAt[1] = -1; }
  else if (m.inEx) {
    if (b0 === 0 && m.freeAt[0] < 0) m.freeAt[0] = m.clock;
    if (b1 === 0 && m.freeAt[1] < 0) m.freeAt[1] = m.clock;
    if (m.freeAt[0] >= 0 && m.freeAt[1] >= 0) { m.adv = m.freeAt[1] - m.freeAt[0]; m.inEx = false; m.any = true; m.advCell = m.counter; }
  }
  // BarHandling
  let upd = !!(b0 || b1 || R[X[0] + 10] || R[X[1] + 10] || R[X[0] + 14] || R[X[1] + 14]);
  if (upd) { m.isReset = false; m.interval = 0; } else m.interval++;
  if (m.counter >= FB_CELLS) m.intervalMax = FB_INTERVAL;
  if (m.interval > m.intervalMax) m.doReset = true;
  if (m.doReset && upd) fbResetBars(m);
  if (m.interval < m.intervalMax && !m.isReset) upd = true;
  if (upd) {
    m.shared = R[X[0] + 3] && R[X[1] + 3] ? m.shared + 1 : 0;
    const freeze = R[g + 6] || m.shared > 1;
    for (let i = 0; i < 2; i++) {  // IncrementFirstActive
      const P = m.p[i], x = X[i];
      if (!R[g] && !R[g + 5] && R[x + 3] === 0 && R[x + 8] === 0) P.firstCounter++;
    }
    if (!freeze) {
      for (let i = 0; i < 2; i++) if (R[X[i]] !== 0) m.p[i].total = R[X[i]];  // HandleInactive
      for (let i = 0; i < 2; i++) fbCell(m, m.p[i], R, X[i], g);
      if (fc !== m.lastFc) m.counter++;  // (ETM steps back when the count does: its training mode's rewind; not here)
    }
  }
  for (let i = 0; i < 2; i++) {  // UpdatePlayers
    const P = m.p[i], x = X[i];
    P.lastBusy = R[x]; P.lastActive = R[x + 7]; P.lastProj = R[x + 14];
    if (R[x + 16] !== -1) { P.gotFirst = false; P.firstCounter = 0; }
  }
  m.lastFc = fc; m.lastTrue = trueF;
}
// viewer.js:3916
function fbCell(m, P, R, x, g) {
  const first = () => { if (!P.gotFirst) { P.firstActive = P.firstCounter; P.gotFirst = true; } };
  let c;
  if (R[x] !== 0) {
    c = FBC.INACT;
    if (R[x + 1] >= 35 && R[x + 1] <= 37) c = FBC.JUMP;
    else if (R[x + 6] !== 0 && !R[x + 5]) c = FBC.HITSTUN;
    else if (R[x + 5]) c = FBC.BLOCK;
    else if (R[x + 7]) { c = FBC.ACTIVE; if (P.lastActive === 0) first(); }
  } else {
    c = FBC.FREE;
    if (P.lastBusy !== 0 || (R[x + 18] === 1 && R[x + 9] !== 1)) c = FBC.NEUTRAL;
    else if (m.doAdv) c = FBC.ADV;
  }
  if (R[x + 4]) c = FBC.THROWN;
  else if (R[x + 3]) c = FBC.HITSTOP;
  else if (R[x + 13] & 1) c = FBC.SHIELD;
  else if (R[x + 13] & 2) { first(); c = FBC.THROW; }
  if (R[g]) c = FBC.FREEZE;
  if (R[x + 14] && !P.lastProj) first();
  const k = m.counter % FB_MEM;
  P.main[k] = c; P.sub[k] = R[x + 12]; P.air[k] = R[x + 9] === 1 ? (R[x + 11] ? 2 : 1) : 0; P.proj[k] = R[x + 14] ? 1 : 0;
}
// viewer.js:3939
function fbClear(s) {
  fb.s = s; fb.last = -1; fb.procF = -1; fb.rebuild = false; fb.m = fbMachine(); fb.dirty = true;
  if (!fb.raw) { fb.raw = new Int32Array(FB_CAP * FB_N); fb.tag = new Int32Array(FB_CAP); }
  fb.tag.fill(-1);
}
// Module.mbaaFrame (every game frame, also a seek's re-simulation) while the bar is on
function fbSample(s, f) {
  const M = s.M;
  if (!M._viewer_framebar_sample) return;
  if (fb.s !== s) fbClear(s);
  const p = M._viewer_framebar_sample() >> 2;
  fbPut(s, f, M.HEAP32.subarray(p, p + FB_N));
}
// viewer.js:3945
function fbPut(s, f, R) {
  if (fb.s !== s) fbClear(s);
  const i = f % FB_CAP;
  fb.raw.set(R, i * FB_N);
  fb.tag[i] = f;
  if (f === fb.procF + 1 && !fb.rebuild) { fbStep(fb.m, fb.raw, i * FB_N); fb.procF = f; }
  else fb.rebuild = true;
  fb.last = f; fb.dirty = true;
}
// a seek to T: how much further back its re-simulation should start for the bar (0: the frames before T are kept)
const FB_BACK = 180;
function fbSeekBack(T) {
  if (!fb.on) return 0;
  if (!fb.tag || fb.s !== session) return FB_BACK;
  for (let f = Math.max(0, T - FB_BACK); f < T; f++) if (fb.tag[f % FB_CAP] !== f) return FB_BACK;
  return 0;
}
// viewer.js:4044
let overlayDirty = true, lastDrawnFrame = -1;
// viewer.js:4137
let seekDragging = false, marksKey = '';
// viewer.js:4530
function perfProfiler(host) {
  const WAIT = Q.get('perfwait') || 'battle', GPU_MODE = /^(fence|off)$/.test(Q.get('perfgpu') || '') ? Q.get('perfgpu') : 'sync';
  const GPU_N = Math.max(5, +(Q.get('perfgpuN') || 30));
  let SECS = Math.max(2, Math.min(120, +(Q.get('perfsecs') || 10)));
  const COLS = ['t', 'iv', 'eng', 'other', 'tick', 'ticks', 'game', 'gl', 'draws', 'fbBind', 'fbSwitch', 'upN', 'upKB',
    'hook', 'hookN', 'rdraw', 'front', 'upMs', 's3dDraws', 'culled', 'objs', 'clTag', 'clGlow', 'gpuPre', 'gpuCpu', 'gpuTail', 'gpuFence', 'flags'];
  const C = Object.fromEntries(COLS.map((k, i) => [k, i])), NC = COLS.length;
  const A = new Float64Array(NC);   // (the frame being recorded)
  let D = null, cap = 0, n = 0;     // (rows: NC numbers each)
  const parts = new Map();          // R.stats *Ms fields: name -> Float64Array(cap)
  const partsA = new Map();
  // ---- WebGL calls on the game's context ----
  const G = { tot: 0, draws: 0, fb: 0, fbSw: 0, lastFb: undefined, upN: 0, upB: 0, by: new Float64Array(1024) };
  const glNames = [], glIdx = new Map(), wrapped = new WeakSet();
  const DRAW = /^(draw(Arrays|Elements)(Instanced)?|drawRangeElements)$/;
  const comps = f => ({ 0x1908: 4, 0x8D99: 4, 0x1907: 3, 0x8D98: 3, 0x8227: 2, 0x8228: 2, 0x190A: 2, 0x1903: 1, 0x8D94: 1, 0x1906: 1, 0x1909: 1 })[f] || 4;
  const bpp = (f, t) => t === 0x1406 || t === 0x1405 || t === 0x1404 ? 4 * comps(f) : t === 0x140B || t === 0x8D61 || t === 0x1403 || t === 0x1402 ? 2 * comps(f)
    : t === 0x8033 || t === 0x8034 || t === 0x8363 ? 2 : t === 0x8368 || t === 0x8C3B || t === 0x8C3E || t === 0x84FA ? 4 : comps(f);
  const viewLen = (v, off, len) => !v || typeof v !== 'object' ? 0 : len ? len * (v.BYTES_PER_ELEMENT || 1)
    : ArrayBuffer.isView(v) ? v.byteLength - (off || 0) * (v.BYTES_PER_ELEMENT || 1) : v.byteLength || 0;
  const srcDims = v => v && typeof v === 'object' && 'width' in v ? (v.width * v.height * 4) || 0 : 0;
  // (bytes per upload call; Emscripten passes the whole wasm heap with an offset, so sizes come from the dimensions / length)
  const UPB = {
    texImage2D: a => a.length >= 8 ? a[3] * a[4] * bpp(a[6], a[7]) : srcDims(a[5]),
    texSubImage2D: a => a.length >= 8 ? a[4] * a[5] * bpp(a[6], a[7]) : srcDims(a[6]),
    texImage3D: a => a[3] * a[4] * a[5] * bpp(a[7], a[8]),
    texSubImage3D: a => a[5] * a[6] * a[7] * bpp(a[8], a[9]),
    compressedTexImage2D: a => viewLen(a[6], a[7], a[8]),
    compressedTexSubImage2D: a => viewLen(a[7], a[8], a[9]),
    compressedTexImage3D: a => viewLen(a[7], a[8], a[9]),
    compressedTexSubImage3D: a => viewLen(a[9], a[10], a[11]),
    bufferData: a => typeof a[1] === 'number' ? a[1] : viewLen(a[1], a[3], a[4]),
    bufferSubData: a => viewLen(a[2], a[3], a[4]),
  };
  let gl = null, glM = null, glFence = null, glWait = null, glDelSync = null, gpuStr = '', gpuVendor = '', timerQ = false, glSync = null;
  function wrapGl(g) {
    if (wrapped.has(g)) return;
    wrapped.add(g);
    const proto = Object.getPrototypeOf(g);
    glFence = proto.fenceSync; glWait = proto.clientWaitSync; glDelSync = proto.deleteSync;
    // (sync: a 1x1 readPixels of the default framebuffer, the read framebuffer and pack buffer put back; unwrapped calls)
    const px = new Uint8Array(4), gp = proto.getParameter, bf = proto.bindFramebuffer, bb = proto.bindBuffer, rp = proto.readPixels;
    glSync = h => {
      const rf = gp.call(h, 0x8CAA), pb = gp.call(h, 0x88ED);   // (READ_FRAMEBUFFER_BINDING, PIXEL_PACK_BUFFER_BINDING)
      if (rf) bf.call(h, 0x8CA8, null);
      if (pb) bb.call(h, 0x88EB, null);
      try { rp.call(h, 0, 0, 1, 1, 0x1908, 0x1401, px); } finally { if (rf) bf.call(h, 0x8CA8, rf); if (pb) bb.call(h, 0x88EB, pb); }
    };
    for (const k of Object.getOwnPropertyNames(proto)) {
      let d; try { d = Object.getOwnPropertyDescriptor(proto, k); } catch (e) { continue; }
      if (!d || typeof d.value !== 'function' || k === 'constructor') continue;
      // (under the engine's GL state cache when it holds the method: the calls Chrome gets, d3d9_gl.cpp js_gl_state_cache)
      const raw = g.__scRaw && g.__scRaw[k] ? g.__scRaw : null, o = raw ? raw[k] : d.value, by = G.by;
      let id = glIdx.get(k);
      if (id === undefined) { id = glNames.length; glNames.push(k); glIdx.set(k, id); }
      if (id >= by.length) continue;
      let fn;
      if (DRAW.test(k)) fn = function () { G.tot++; G.draws++; by[id]++; return o.apply(this, arguments); };
      else if (k === 'bindFramebuffer') fn = function (t, f) { G.tot++; G.fb++; by[id]++; if ((t === 0x8D40 || t === 0x8CA9) && f !== G.lastFb) { G.fbSw++; G.lastFb = f; } return o.apply(this, arguments); };
      else if (UPB[k]) { const sz = UPB[k]; fn = function () { G.tot++; G.upN++; by[id]++; try { G.upB += sz(arguments) || 0; } catch (e) {} return o.apply(this, arguments); }; }
      else fn = function () { G.tot++; by[id]++; return o.apply(this, arguments); };
      if (raw) raw[k] = fn; else g[k] = fn;
    }
    try {
      const x = g.getExtension('WEBGL_debug_renderer_info');
      gpuStr = String(x ? g.getParameter(x.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER)).slice(0, 120);
      gpuVendor = String(x ? g.getParameter(x.UNMASKED_VENDOR_WEBGL) : g.getParameter(g.VENDOR)).slice(0, 60);
      timerQ = (g.getSupportedExtensions() || []).includes('EXT_disjoint_timer_query_webgl2');
    } catch (e) {}
  }
  // the game's context, once its engine has drawn (getContext then returns the existing one, never makes one)
  function glFind() {
    const M = session && session.M;
    if (!M || M === glM || !M.canvas || !M._viewer_frame || !(M._viewer_frame() > 0)) return;
    // (the WebGPU backend: its own counters stand in for the wrapped calls (boundary); no GPU samples)
    if (M.__wg) { glM = M; gl = null; gpuStr = ('webgpu ' + (M.__wg.info || '')).slice(0, 120); gpuVendor = ''; return; }
    const g = M.canvas.getContext('webgl2');
    if (!g) return;
    glM = M; gl = g; wrapGl(g);
  }
  // ---- per frame ----
  let frameT = -1, prevT = -1, t0 = 0, g0 = { tot: 0, draws: 0, fb: 0, fbSw: 0, upN: 0, upB: 0 }, byStart = null;
  const ENG_PARTS = ['simMs', 'renderMs', 'submitMs', 'bgExtMs', 'lightMs', 'glowPx', 'specPx', 'tagged'];
  let lastPS = null, lastM = null, lastTickN = -1, lastF = -1, lastCl = null, gpuCount = 0, skipNext = false, pend = null, longs = [], lo = null, startedAt = 0;
  const P = { on: false, done: false, mode: GPU_MODE };
  function boundary(t) {
    if (glM && glM.__wg) { const w = glM.__wg.st; G.tot = w.api; G.draws = w.draws; G.fb = G.fbSw = w.passes; G.upN = w.uploads + w.bufUploads; G.upB = w.uploadBytes; }
    if (P.on && frameT >= 0) {
      A[C.t] = frameT - t0; A[C.iv] = prevT >= 0 ? frameT - prevT : 0;
      A[C.gl] = G.tot - g0.tot; A[C.draws] = G.draws - g0.draws; A[C.fbBind] = G.fb - g0.fb; A[C.fbSwitch] = G.fbSw - g0.fbSw;
      A[C.upN] = G.upN - g0.upN; A[C.upKB] = (G.upB - g0.upB) / 1024;
      if (prevT < 0) A[C.flags] = A[C.flags] | 8;   // (the first: no interval)
      if (n < cap) {
        D.set(A, n * NC);
        for (const [k, v] of partsA) { let a = parts.get(k); if (!a) parts.set(k, a = new Float64Array(cap)); a[n] = v; }
        n++;
      }
      if (n >= cap || frameT - t0 >= SECS * 1000) finish();
    }
    A.fill(0); partsA.clear();
    if (skipNext) { A[C.flags] = 2; skipNext = false; }
    g0.tot = G.tot; g0.draws = G.draws; g0.fb = G.fb; g0.fbSw = G.fbSw; g0.upN = G.upN; g0.upB = G.upB;
    prevT = P.on ? frameT : -1; frameT = t;
    if (!glM || (session && session.M !== glM)) glFind();
    if (!P.on && !P.done && WAIT !== 'manual') autoStart(t);
  }
  let battleSince = 0;
  function autoStart(t) {
    const M = session && session.M;
    if (!M || !glM || host.hidden()) { battleSince = 0; return; }
    // (battle: steady play, not a live join's 2x catch-up, a hold or a seek, for 3 s)
    const s = session, ok = WAIT === '0' ? M._viewer_frame() > 0
      : M.HEAP32[0x54EEE8 >> 2] === 1 && !s.liveFF && !s.seeking && !s.liveHeld && !s.loadHeld && !s.cssHeld && !(typeof ui !== 'undefined' && ui.paused);
    if (!ok) { battleSince = 0; return; }
    if (!battleSince) battleSince = t;
    if (t - battleSince > (WAIT === '0' ? 2000 : 3000)) start();
  }
  // after the engine's callback: its tick, game frames, the 3D hook's counters, the fighter light's
  function engAfter() {
    const M = session && session.M;
    if (!M) return;
    if (M !== lastM) {   // (a new instance: its counters start again; an engine with viewer_prof_on keeps its split only when asked)
      lastM = M; lastTickN = -1; lastF = -1; lastCl = null; lastPS = null;
      if (M._viewer_prof_on) try { M._viewer_prof_on(1); } catch (e) {}
    }
    if (M._viewer_tick_count) {
      const c = M._viewer_tick_count() >>> 0;
      if (lastTickN >= 0 && c !== lastTickN) { A[C.tick] += M.HEAPF64[M._viewer_tick_ms() / 8 + ((c - 1) & 127)]; A[C.ticks] += (c - lastTickN) >>> 0; }
      lastTickN = c;
    }
    const f = M._viewer_frame ? M._viewer_frame() : -1;
    if (lastF >= 0 && f >= lastF) A[C.game] += f - lastF;
    lastF = f;
    const h = M.__bgExt, pr = h && h.prof;
    if (pr) {
      A[C.hook] += pr.ms; A[C.hookN] += pr.n; A[C.rdraw] += pr.rdraw; A[C.front] += pr.front; A[C.upMs] += pr.up;
      A[C.s3dDraws] += pr.draws; A[C.culled] += pr.culled; A[C.objs] += pr.objs;
      for (const k in pr.parts) { partsA.set(k, (partsA.get(k) || 0) + pr.parts[k]); pr.parts[k] = 0; }
      pr.n = pr.ms = pr.rdraw = pr.draws = pr.culled = pr.objs = pr.front = pr.frontN = pr.up = pr.upN = 0;
    }
    // (the engine's own split, when the build exports viewer_prof_stats(): a pointer to cumulative doubles, ENG_PARTS order;
    // PROFILING.md "hooks"): per-frame deltas as cpu.parts engine.<name>
    if (M._viewer_prof_stats) {
      const p = M._viewer_prof_stats() / 8, H = M.HEAPF64;
      if (lastPS) for (let i = 0; i < ENG_PARTS.length; i++) { const d = H[p + i] - lastPS[i]; if (d) partsA.set('engine.' + ENG_PARTS[i], (partsA.get('engine.' + ENG_PARTS[i]) || 0) + d); }
      lastPS = H.slice(p, p + ENG_PARTS.length);
    }
    if (M._viewer_chara_light_stats) {
      const a = M._viewer_chara_light_stats(0) >>> 0, b = M._viewer_chara_light_stats(1) >>> 0;
      if (lastCl) { A[C.clTag] += (a - lastCl[0]) >>> 0; A[C.clGlow] += (b - lastCl[1]) >>> 0; }
      lastCl = [a, b];
    }
  }
  // fence mode: polled from later tasks (the sync's state changes only between tasks): message tasks for the first 30
  // polls (sub-ms), then setTimeout (~4 ms steps: a busy message loop delays the GPU process's reply); 2 s at most
  const mc = new MessageChannel(), fenceOut = { ok: 0, timeout: 0, failed: 0 };
  const fencePoll = () => {
    if (!pend) return;
    let r = 0;
    try { r = glWait.call(pend.g, pend.s, 0, 0); } catch (e) { r = 0x911D; }
    const dt = performance.now() - pend.t1;
    if (r === 0x911A || r === 0x911C || r === 0x911D || dt > 2000) {   // (ALREADY_SIGNALED, CONDITION_SATISFIED, WAIT_FAILED)
      const v = r === 0x911D || dt > 2000 ? NaN : dt;
      if (pend.row < n) D[pend.row * NC + C.gpuFence] = v; else if (pend.row === n) A[C.gpuFence] = v;
      fenceOut[r === 0x911D ? 'failed' : dt > 2000 ? 'timeout' : 'ok']++;
      try { glDelSync.call(pend.g, pend.s); } catch (e) {}
      pend = null;
    } else if (++pend.polls < 30) mc.port2.postMessage(0);
    else setTimeout(fencePoll, 0);
  };
  mc.port1.onmessage = fencePoll;
  // window.requestAnimationFrame wrapped (profiler mode only): each callback timed; Emscripten's main loop (MainLoop_runner)
  // is the engine
  const rafOrig = self.requestAnimationFrame.bind(self);
  self.requestAnimationFrame = cb => rafOrig(t => {
    if (t !== frameT) boundary(t);
    if (cb.name !== 'MainLoop_runner') {
      const a = performance.now();
      try { return cb(t); } finally { A[C.other] += performance.now() - a; }
    }
    const g = gl, samp = P.on && g && GPU_MODE !== 'off' && !pend && ++gpuCount % GPU_N === 0;
    if (samp && GPU_MODE === 'sync') { const a = performance.now(); glSync(g); A[C.gpuPre] = performance.now() - a; }
    const a = performance.now();
    try { return cb(t); } finally {
      const t1 = performance.now();
      A[C.eng] += t1 - a; A[C.flags] = A[C.flags] | 4;
      if (samp) {
        A[C.flags] = A[C.flags] | 1; A[C.gpuCpu] = t1 - a; skipNext = true;
        if (GPU_MODE === 'sync') { glSync(g); A[C.gpuTail] = performance.now() - t1; }
        else { try { pend = { g, s: glFence.call(g, 0x9117, 0), t1, row: n, polls: 0 }; g.flush(); mc.port2.postMessage(0); } catch (e) { pend = null; } }
      }
      try { engAfter(); } catch (e) {}
    }
  });
  // ---- recording ----
  function start(secs) {
    if (secs) SECS = Math.max(1, Math.min(120, +secs));
    cap = Math.ceil(SECS * 150) + 64; D = new Float64Array(cap * NC); n = 0; parts.clear(); longs = [];
    byStart = G.by.slice(); t0 = performance.now(); startedAt = Date.now(); frameT = -1; prevT = -1; gpuCount = 0;
    fenceOut.ok = fenceOut.timeout = fenceOut.failed = 0;
    try { lo = new PerformanceObserver(l => { for (const e of l.getEntries()) if (longs.length < 2000) longs.push([e.startTime - t0, e.duration]); }); lo.observe({ type: 'longtask' }); } catch (e) { lo = null; }
    P.on = true; P.done = false; P.sum = null;
    host.panel(`perf: recording ${SECS} s…`, P);
  }
  function finish() {
    if (!P.on) return;
    P.on = false; P.done = true;
    if (lo) { try { lo.disconnect(); } catch (e) {} lo = null; }
    P.sum = summary();
    host.result(P.sum, { columns: COLS, frames: frames(), longTasks: longs }, P);
  }
  // ---- summary ----
  const r2 = v => v == null || !isFinite(v) ? null : Math.round(v * 100) / 100;
  function stat(a) {
    const b = a.filter(v => isFinite(v)).sort((x, y) => x - y), q = p => b.length ? b[Math.min(b.length - 1, Math.floor(p * b.length))] : null;
    if (!b.length) return null;
    return { n: b.length, mean: r2(b.reduce((x, y) => x + y, 0) / b.length), p50: r2(q(0.5)), p90: r2(q(0.9)), p95: r2(q(0.95)), p99: r2(q(0.99)), max: r2(b[b.length - 1]) };
  }
  const col = (k, keep) => { const o = []; for (let i = 0; i < n; i++) if (!keep || keep(i)) o.push(D[i * NC + C[k]]); return o; };
  const flags = i => D[i * NC + C.flags];
  function summary() {
    const clean = i => !(flags(i) & 11), eng = i => clean(i) && (flags(i) & 4), hooked = i => D[i * NC + C.hookN] > 0;
    const iv = col('iv', clean), secs = n ? (D[(n - 1) * NC] + (D[(n - 1) * NC + C.iv] || 0)) / 1000 : 0;
    const share = (a, x) => a.length ? r2(a.filter(v => v > x).length / a.length) : null;
    const M = session && session.M, h = M && M.__bgExt, cv = M && M.canvas;
    let s3dq = '', xlight = '';
    try { s3dq = localStorage.getItem('s3dq') || ''; xlight = localStorage.getItem('xlight') || ''; } catch (e) {}
    const idle = []; for (let i = 0; i < n; i++) if (clean(i)) idle.push(D[i * NC + C.iv] - D[i * NC + C.eng] - D[i * NC + C.other]);
    const top = [];
    for (let i = 0; i < glNames.length; i++) { const d = G.by[i] - (byStart ? byStart[i] : 0); if (d > 0) top.push([glNames[i], r2(d / Math.max(1, n))]); }
    top.sort((a, b) => b[1] - a[1]);
    const pt = {}, ept = {};
    for (const [k, a] of parts) {
      const e = k.startsWith('engine.');
      (e ? ept : pt)[e ? k.slice(7) : k] = stat(Array.from(a.subarray(0, n)).filter((v, i) => e ? eng(i) : hooked(i)));
    }
    let tex = null; try { tex = h && h.stats ? h.stats().texBytes : null; } catch (e) {}
    return {
      v: 1, kind: 'mbaa-frame-profile', at: new Date(startedAt).toISOString(), secs: r2(secs), frames: n,
      page: host.page(cv),
      gpu: { renderer: gpuStr, vendor: gpuVendor, timerQuery: timerQ },
      stage: { scene: M ? M.HEAP32[0x54EEE8 >> 2] : null, s3d: !!h, tier: h && h.tier ? h.tier : null, s3dq, xlight,
        light: h && h.light ? h.light.mode : 0, texMB: tex ? r2(tex / 1048576) : null },
      display: { fps: secs ? r2(n / secs) : null, iv: stat(iv), over20: share(iv, 20), over33: share(iv, 33.4), over50: share(iv, 50) },
      game: { fps: secs ? r2(col('game').reduce((a, b) => a + b, 0) / secs) : null },
      cpu: { engine: stat(col('eng', eng)), tick: stat(col('tick', i => eng(i) && D[i * NC + C.ticks] > 0)), otherRaf: stat(col('other', clean)), idle: stat(idle),
        parts: Object.keys(ept).length ? ept : null },
      s3d: h ? { hook: stat(col('hook', i => clean(i) && hooked(i))), rdraw: stat(col('rdraw', i => clean(i) && hooked(i))), front: stat(col('front', i => clean(i) && hooked(i))),
        draws: stat(col('s3dDraws', hooked)), culled: stat(col('culled', hooked)), objs: stat(col('objs', hooked)), hookedFrames: col('hookN', hooked).length,
        uploadMs: r2(col('upMs').reduce((a, b) => a + b, 0)), parts: pt } : null,
      gl: { calls: stat(col('gl', clean)), draws: stat(col('draws', clean)), fbBinds: stat(col('fbBind', clean)), fbSwitches: stat(col('fbSwitch', clean)),
        uploads: stat(col('upN', clean)), uploadKB: stat(col('upKB')), top: top.slice(0, 20) },
      light: { tagged: stat(col('clTag', eng)), glow: stat(col('clGlow', eng)) },
      long: { n: longs.length, totalMs: r2(longs.reduce((a, b) => a + b[1], 0)), max: r2(longs.reduce((a, b) => Math.max(a, b[1]), 0)),
        worst: longs.slice().sort((a, b) => b[1] - a[1]).slice(0, 10).map(([s, d]) => [r2(s), r2(d)]) },
      gpuEst: { mode: GPU_MODE, every: GPU_N, samples: col('gpuCpu', i => flags(i) & 1).length,
        cpu: stat(col('gpuCpu', i => flags(i) & 1)),
        pre: GPU_MODE === 'sync' ? stat(col('gpuPre', i => flags(i) & 1)) : null, tail: GPU_MODE === 'sync' ? stat(col('gpuTail', i => flags(i) & 1)) : null,
        fence: GPU_MODE === 'fence' ? stat(col('gpuFence', i => flags(i) & 1)) : null, fenceOutcomes: GPU_MODE === 'fence' ? { ...fenceOut } : null,
        note: GPU_MODE === 'sync' ? '1x1 readPixels round trip before (pre) and after (tail) the engine callback on sampled frames; tail = GPU time not overlapped with submission (an estimate, includes the GPU process and the round trip)'
          : GPU_MODE === 'fence' ? 'fenceSync after the engine callback, polled from later tasks: submission end -> signalled (coarse: Chrome updates sync status up to a frame late)' : 'off' },
    };
  }
  function frames() {
    const rows = [];
    for (let i = 0; i < n; i++) { const r = {}; for (let k = 0; k < NC; k++) r[COLS[k]] = r2(D[i * NC + k]); for (const [k, a] of parts) r[k] = r2(a[i]); rows.push(r); }
    return rows;
  }
  P.start = start; P.stop = finish; P.summary = () => P.sum || (n ? summary() : null); P.frames = frames;
  if (WAIT !== 'manual') host.panel(WAIT === '0' ? 'perf: waiting for the game' : 'perf: waiting for a battle', P);
  return P;
}
// viewer.js:4861
function wantFor(rep) {
  if (!man.plan) return null;
  let want = planFiles(man, repKeys(rep));
  // ?planDrop=REGEX (test): leave matching files out of the plan, to exercise the miss -> fetch -> catch-up path
  if (Q.get('planDrop')) { const re = new RegExp(Q.get('planDrop')); want = new Set([...want].filter(f => !re.test(f))); }
  return want;
}
// viewer.js:4872
const MOVIE = 'dat/dat_m_vs.vsmv';
// viewer.js:4877
let movieBytes = null, movieH264 = null, movieLoading = null, movieHook = null;
// viewer.js:4913
function movieConfig(b) {
  if (!b.length) return { codec: 'avc1.640020', codedWidth: 640, codedHeight: 480 };
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength), u = i => dv.getUint32(i, true), dl = u(24), cl = u(28);
  return { codec: new TextDecoder().decode(b.subarray(32, 32 + cl)), codedWidth: u(8), codedHeight: u(12),
           description: b.slice(32 + cl, 32 + cl + dl), optimizeForLatency: true };
}
// viewer.js:4923
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
    // (an instance dropped (a new one for a lost picture, a replay not reusing it): its decoded frames closed, not left
    // to the garbage collector, which Chrome warns stalls the decoder)
    close() {
      for (const fr of have.values()) fr.close();
      have.clear(); sent = [];
      if (dec && dec.state !== 'closed') try { dec.close(); } catch (e) {}
      dec = null;
    },
  };
}
// viewer.js:4989
let xf = null, xfRuns = 0;
// (live) the select screen's files in the background; until they are in MEMFS the game is held on reaching the result
// screen (scene 5) or the retry menu, where the next select may follow (a match lasts minutes: in practice never held)
function liveCssBg(s, paths) {
  s.cssBgReady = false;
  // (not while the join's catch-up runs: ~80 MB read, decrypted and stored competed with it for the main thread in
  // every task turn it gives, a third of a phone's catch-up time. Started at its end (cuDone), on the first poll that
  // needs none, at a hold (liveCssWatch: the game at a result screen or select wanting them), or 20 s on)
  let go;
  const gate = new Promise(r => { go = r; });
  s.cssBgGo = () => { if (go) { const g = go; go = null; g(); } };
  s.cssBgP = gate.then(() => fetchAll(man, paths, '', true))
    .then(() => { if (session !== s) return; liveInstall(s, paths); s.cssBgReady = true; if (s.cssBgHeld) { s.cssBgHeld = false; liveHoldApply(s); } })
    .catch(e => { console.warn('live: select screen files:', e); if (session === s) { s.cssBgP = null; s.cssBgHeld = false; liveHoldApply(s); } });
  if (s.livePic) s.cssBgGo(); else setTimeout(s.cssBgGo, 20000);
}
// viewer.js:5200
let loopOn = false;
// viewer.js:5297
let clipPanel = false, clipPanelKey = '', clipDrag = null;
// viewer.js:5486
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
// viewer.js:5752
let clipLt = null;  // {name, bytes} or null
// viewer.js:6784
let labCfg = null, labOn = null;
// viewer.js:6785
function labApply(c) {
  labCfg = c || null;
  self.__mbaaLabSet = c && c.set ? c.set : null;
  labAttach();
}
// viewer.js:6790
function labAttach() {
  const m = session && session.M;
  if (labOn && labOn !== m) { try { delete labOn.__labSync; labOn.__labVoid = 0; labOn.mbaaRadioDefer = labOn.__labDefer; delete labOn.__labDefer; } catch (e) {} labOn = null; }
  if (!m) return;
  if (labCfg) {
    if (labOn !== m) { m.__labDefer = m.mbaaRadioDefer; m.mbaaRadioDefer = 0; }
    const w = labCfg.words;
    m.__labSync = ptr => { if (w) m.HEAP32.set(w, ptr >> 2); };
    m.__labVoid = labCfg.void ? 1 : 0; labOn = m;
  } else if (labOn === m) { delete m.__labSync; m.__labVoid = 0; m.mbaaRadioDefer = m.__labDefer; delete m.__labDefer; labOn = null; }
}
// viewer.js:6803
function labInfo() {
  const m = session && session.M, objs = [];
  if (m && m.HEAPU8 && !m.__remote) {
    const U8 = m.HEAPU8, dv = new DataView(U8.buffer), fd = dv.getUint32(0x750830, true);
    for (let i = 0; fd && i < 256; i++) {
      const off = dv.getInt32(fd + 0x54 + 4 * i, true);
      if (off === -1 || off < 0 || off > 0x4000000) continue;
      const h = fd + off, n = dv.getUint32(h, true);
      if (n > 4096) continue;
      const f0 = h + 0x3C;
      objs.push({ i, n, parX: dv.getInt16(h + 4, true), layer: dv.getUint32(h + 8, true), parYraw: dv.getInt16(h + 0x18, true),
                  scale: dv.getUint16(h + 0x20, true) / 1000 || 1, sprite: dv.getUint16(f0, true), x: dv.getInt16(f0 + 2, true), y: dv.getInt16(f0 + 4, true),
                  react: U8[h + 0x1A] === 1 });
    }
  }
  return { stage: self.__mbaaLabStage || null, objs };
}

// ---- the engine worker's messages (engine_head.js) ----
// in:  init {off, search, wasmV, man, ui, lowmem}  files {list: [[path, bytes]]}  play {rep, name, catchUp, want}
//      ui {ui}  seek {T}  step {n}  skip {}  call {f, a}  filesDone {id, list}
// out: ev (status, loading, catchUp, bootMark, swMark, paused, needFiles, ...), st (the per-callback state)
let engState = null, engExKeep = null;
// ?perf=1: the frame profiler (viewer.js perfProfiler) runs here, where the engine's rAF and GL context are: installed
// before the module's main loop starts; its panel text and result go to the page's panel (perfPanel) and its
// window.__mbaaProf stand-in (start / stop from there: cmd perf)
const engProf = Q.get('perf') === '1' ? perfProfiler({
  hidden: () => false,
  page: () => ({ canvas: engOff ? [engOff.width, engOff.height] : null }),
  panel: (text, P) => engPost({ ev: 'perf', text, on: P.on, done: P.done }),
  result: (sum, dl, P) => engPost({ ev: 'perf', sum, dl, on: P.on, done: P.done }),
}) : null;
// the renderer's profiler ring (Module.__rsProf, web/host/render/profiler.cpp) for the page's render_stats.js: once the
// page reads it (cmd rsSub), each frame the records new since the last post and the 16 before them (their GPU times /
// CPU split land a few frames late) go over, with the ring's counters; a new engine instance starts a new ring there
let engRsSub = false, engRsR = null, engRsInst = 0, engRsSent = 0;
function engRsFlush() {
  const M = session && session.M, R = M && M.__rsProf;
  if (!engRsSub || !R) return;
  if (R !== engRsR) { engRsR = R; engRsInst++; engRsSent = 0; }
  const from = Math.max(0, engRsSent - 16, R.seq - R.N), n = R.seq - from, W = R.W;
  const ring = new Uint32Array(n * W), t = new Float64Array(n);
  for (let s = from, j = 0; s < R.seq; s++, j++) { const o = (s % R.N) * W; ring.set(R.ring.subarray(o, o + W), j * W); t[j] = R.t[s % R.N]; }
  engPost({ ev: 'rs', inst: engRsInst, N: R.N, W, seq: R.seq, on: R.on, timer: R.timer, backend: R.backend, from, ring, t }, [ring.buffer, t.buffer]);
  engRsSent = R.seq;
}
// the memory the page reads (its HEAP32 / HEAPU8 stand-ins): a fixed set and any the page asks for since ('i:addr' /
// 'b:addr'); the overlay's boxes and inputs each frame
const engPeek = new Set(['i:5566184', 'i:7667096', 'i:7657536', 'i:7657548', 'i:7657580', 'i:7657592', 'b:7792211']);
function engPeekNow(M) {
  const o = {};
  for (const k of engPeek) { const a = +k.slice(2); o[k] = k[0] === 'i' ? M.HEAP32[a >> 2] : M.HEAPU8[a]; }
  return o;
}
const engSwHash = Q.get('swhash') === '1';  // (the switch-back check's live state + kept match, mirrored)
function engStateNow() {
  const s = session; if (!s || !s.M) return null;
  const M = s.M, t = s.tl;
  let tick = 0; try { tick = M._viewer_tick_ms ? M._viewer_tick_ms() : 0; } catch (e) {}
  return {
    frame: M._viewer_frame(), ended: M.ccall('viewer_ended', 'number', [], []), name: s.name, seeking: !!s.seeking, cu: !!s.cu,
    scene: M.HEAP32[0x54EEE8 >> 2], tick, backend: M._viewer_render_backend ? M._viewer_render_backend() : 0, memGen: M.mbaaMemGen || 0,
    ovf: M._viewer_ov_has ? M._viewer_ov_has(0x41) : 1,
    ovn: M._viewer_ov_count ? M._viewer_ov_count() : 0, q: engCur, hb: ++engHb, cvw: engOff.width, cvh: engOff.height,
    rsi: M._viewer_radio_stage_in ? M._viewer_radio_stage_in() : 0, rsp: M._viewer_radio_stage_phase ? M._viewer_radio_stage_phase() : 0,
    rsid: M._viewer_radio_stage_id ? M._viewer_radio_stage_id() : 0,
    tl: t ? { simMax: t.simMax, end: t.end, est: t.est, intro: t.intro, round: t.round, scene: t.scene, want: t.want,
              running: !!t.running, marks: t.marks.length, kfs: t.kfs.length, bytes: t.bytes } : null,
    peek: engPeekNow(M),
    live: s.liveSrc ? { follow: !!s.liveFollow, synced: !!s.liveSynced, cardLive: !!s.cardLive, streakKnown: !!s.streakKnown, next: !!s.liveSrc.next,
                        held: !!s.liveHeld, ff: !!s.liveFF, game: M.ccall('viewer_spectate_game', 'number', [], []), ahead: M.ccall('viewer_spectate_buffered', 'number', [], []),
                        switchTimes: self.__mbaaSwitchTimes || null, snapJoin: self.__mbaaSnapJoin || null,
                        switchBack: self.__mbaaSwitchBack || null } : null,
    ...(engSwHash ? { lstate: liveStateNow(), kept: liveKept ? liveKeptStat(liveKept) : null } : null),
    boxes: M._viewer_box_count ? M.HEAP32.slice(M._viewer_boxes() >> 2, (M._viewer_boxes() >> 2) + M._viewer_box_count() * 5) : null,
    inputs: M._viewer_input_count ? M.HEAP32.slice(M._viewer_inputs() >> 2, (M._viewer_inputs() >> 2) + M._viewer_input_count() * 5) : null,
  };
}
// the frame bar's samples (fbSample: every frame the game runs, a seek's re-simulation too) go to the page's bar
const engFbF = [], engFbRaw = [];
const fbPut0 = fbPut;
fbPut = (s, f, R) => { fbPut0(s, f, R); engFbF.push(f); engFbRaw.push(R.slice()); };
function engFbFlush() {
  if (!engFbF.length) return;
  const raw = new Int32Array(engFbF.length * FB_N);
  engFbRaw.forEach((r, j) => raw.set(r, j * FB_N));
  engPost({ ev: 'fb', f: engFbF.splice(0), raw }, [raw.buffer]); engFbRaw.length = 0;
}
// exportRealtime on the page (cmd rec): each frame the game shows, posted as a VideoFrame with its boxes / inputs (the
// page records them: its recTick per frame). Taken right after the animation-frame callback that drew it (engAfterRaf),
// from the canvas as drawn: no second present (a re-present per frame slowed the worker's ticks to ~23 ms and the
// game stepped 2-6 frames a tick, 358 of 600 frames recorded); the clip's first frame (paused, drawn long before)
// presented again once
let engRec = false, engRecLast = -1;
function engRecTick(again) {
  const s = session, M = s && s.M;
  if (!engRec || !M || s.seeking) return;
  const f = M._viewer_frame();
  if (f === engRecLast) return;
  engRecLast = f;
  if (again && M._viewer_present_now) M._viewer_present_now();
  const vf = new VideoFrame(engOff, { timestamp: 0, alpha: 'discard' }), st = engStateNow();
  engPost({ ev: 'recFrame', f, vf, boxes: st.boxes, inputs: st.inputs }, [vf]);
}
engAfterRaf = () => { if (engRec) try { engRecTick(false); } catch (e) { engPost({ ev: 'error', cmd: 'rec', msg: String(e && e.stack || e) }); } };
// (keyframe work off the stepped frame: engine_head.js engIncPend)
// (a callback that steps twice: the first frame's work is not run on the second's memory; this frame's runs here, in
// its frame, as before the deferral)
incDefer = (s, f) => { if (engIncPend) { engIncPend = null; incTick(s, f); return; } engIncPend = [s, f]; };
{ const r0 = restore; restore = function (...a) { engIncPend = null; return r0.apply(this, a); }; }
// one state message per animation frame of the worker (the module's own loop draws in its callbacks)
const engRaf = self.requestAnimationFrame.bind(self);
// the owner's background tool's view of the engine (labInfo: the stage file's objects, an extension's stage), posted
// when it changes (looked at every 10 frames); its hooks follow the session's module (labAttach)
let engLabN = 0, engLabKey = '';
function engLabTick() {
  labAttach();
  if (++engLabN % 10) return;
  const r = labInfo(), k = JSON.stringify(r);
  if (k !== engLabKey) { engLabKey = k; engPost({ ev: 'lab', info: r }); }
}
// (a re-present the page asks for (viewer_represent: a toggle, the comments changed on a paused picture, a resize) is
// drawn in this worker's next animation frame: a WebGL frame drawn in a message task, outside one, never reaches the
// page's canvas, so a paused picture kept its old look (comments put before a backward seek stayed off it))
let engRepresent = 0;  // (frames left: a few, the overlay makes new letters on a time budget, some in the next present)
function engFrame() {
  if (engRepresent > 0 && session && session.M) { engRepresent--; try { session.M._viewer_present_now(); } catch (e) {} }
  if (session && session.M) { try { radioStageSync(session); } catch (e) {} engXfTick(); }
  try { engLabTick(); } catch (e) {}
  engFbFlush();
  engRsFlush();
  if (session && session.sfxQueue && session.sfxQueue.length) engPost({ ev: 'sfx', q: session.sfxQueue.splice(0) });
  const st = engStateNow();
  if (st) { if (st.tl && session.tl.marks.length !== (engState && engState.tl ? engState.tl.marks : -1)) st.marksList = session.tl.marks; engPost({ st }); engState = st; }
}
(function engTick() { engFrame(); engRaf(engTick); })();
// Background play (the page path's bgTick): a hidden page gives the worker no animation frames either, so its own timer
// ticks the game while the page is hidden (cmd vis), the same viewer_tick the page's timer worker calls (nothing drawn
// unless a picture-in-picture window shows it), and each tick's state / sounds / frame bar go out as a frame's would.
let engBg = null;
function engBgTick(on) {
  if (on && !engBg) engBg = setInterval(() => {
    const s = session;
    if (!engHidden || !s || !s.M) return;
    try { s.M._viewer_tick(engPip ? 1 : 0); } catch (e) {}
    engFrame();
  }, 16);
  else if (!on && engBg) { clearInterval(engBg); engBg = null; }
}
// a lost picture: the GL context (OffscreenCanvas webglcontextlost / restored) or the WebGPU device (its lost promise:
// gpuLostHook, cut from viewer.js) - the session started again on a new instance at the same frame (glRecover, cut from viewer.js),
// drawing into a new canvas the page transfers (as the page path's freshCanvas gives a new instance a new element)
function engCanvasHooks(c) {
  c.addEventListener('webglcontextlost', e => { e.preventDefault(); if (session) session.glLost = true; });
  c.addEventListener('webglcontextrestored', () => glRecover());
}
const glRecover0 = glRecover;
glRecover = async function glRecoverW() {
  const s = session;
  if (!s || !s.glLost || s.glRecovering || engHidden) return;
  // (a restored event and the shown page's retry: one new canvas, both wait for it; a page hidden again before
  // glRecover0 runs makes it return, and the next shown page's retry goes on with the canvas already handed over)
  if (!s.glCanvas) { const id = ++engNeedId; s.glCanvas = new Promise(r => { engNeed.set(id, r); engPost({ ev: 'needCanvas', id }); }); }
  await s.glCanvas;
  if (session !== s || engHidden) return;
  return glRecover0();
};
// a live extension (the secret stages: liveExtSet on the page sends its URL): imported here, where the game module is;
// its music / announcer / stage-card calls go to the page's liveExtApi (tokens: this side's, mapped there)
let engExtSeq = 0, engExtV = '', engExtTok = 0;
const engExtOff = new Map();
const engExtApi = {
  abi: 2,
  module: () => session && session.M,
  liveId: () => null,
  current: () => engExtV,
  setLocal: v => engPost({ ev: 'extSetLocal', v }),
};
for (const kind of ['music', 'announcer', 'stage']) engExtApi[kind] = (o, tok) => {
  if (o) { const n = ++engExtTok; engPost({ ev: 'extApi', kind, o, wtok: n }); return n; }
  engPost({ ev: 'extApi', kind, o: null, wtok: tok || 0 }); return null;
};
// ---- the comment overlay's tiles (chat.js glov on the page): what the renderer asks for synchronously, drawn here as
// the page's glovEmoji / glovRun / glovRunW do, from the lists the page sends (ovLists) and the fonts it gave the
// renderer (worker FontFaces of the same bytes) ----
const engOv = { emo: [null], run: [null], sans: '', serif: '', cv: null, runW: new Map(), fonts: 0 };
const engOvCtx = (w, h) => {
  if (!engOv.cv) engOv.cv = new OffscreenCanvas(1, 1);
  if (engOv.cv.width < w || engOv.cv.height < h) { engOv.cv.width = Math.max(engOv.cv.width, w); engOv.cv.height = Math.max(engOv.cv.height, h); }
  return engOv.cv.getContext('2d', { willReadFrequently: true });
};
const engOvSrc = d => d;  // (the page's decoded emote bitmaps, drawn as they are)
const engOvAnim = id => { const g = engOv.emo[id]; return g && g.pix && g.pix.length > 1 ? g : null; };
const engOvRunFont = (f, px) => f === 2 ? `400 ${px}px MbaaOv2, ${engOv.serif}` : f === 1 ? `400 ${px}px MbaaOv1, ${engOv.sans}` : `700 ${px}px MbaaOv0, ${engOv.sans}`;
const engOvHooks = {
  mbaaOvEmoAr: id => { const g = engOv.emo[id]; return g && g.pix ? (g.ar || 1) : 0; },
  mbaaOvEmoFrames: id => { const g = engOvAnim(id); return g ? g.pix.length : 1; },
  mbaaOvEmoDur: id => { const g = engOvAnim(id); return g ? g.fdur : 100; },
  mbaaOvEmoji(id, spx, box, ptr, frame = 0) {
    const g = engOv.emo[id], M = session && session.M;
    if (!g || !M) return 0;
    const x = engOvCtx(box, box);
    x.clearRect(0, 0, box, box);
    if (g.pix) {
      const d = g.pix[frame | 0] || g.pix[0];
      if (!d || !d.width) return 0;
      const k = Math.min(box / d.width, box / d.height), w = d.width * k, h = d.height * k;
      x.imageSmoothingQuality = 'high';
      x.drawImage(engOvSrc(d), (box - w) / 2, (box - h) / 2, w, h);
    } else {
      x.font = `${spx}px MbaaFlags, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
      x.textAlign = 'center'; x.textBaseline = 'middle';
      x.fillText(g.g, box / 2, box / 2);
    }
    M.HEAPU8.set(x.getImageData(0, 0, box, box).data, ptr);
    return 1;
  },
  mbaaOvRunW(id, px, f) {
    const r = engOv.run[id];
    if (!r) return 0;
    const k = `${id}|${px}|${f}`;
    let w = engOv.runW.get(k);
    if (w === undefined) { const x = engOvCtx(1, 1); x.font = engOvRunFont(f, px); x.direction = r.dir; w = x.measureText(r.t).width; engOv.runW.set(k, w); }
    return w;
  },
  mbaaOvRun(id, spx, f, W, H, x0, y0, ptr) {
    const r = engOv.run[id], M = session && session.M;
    if (!r || !M) return 0;
    const x = engOvCtx(W, H);
    x.clearRect(0, 0, W, H);
    x.font = engOvRunFont(f, spx); x.direction = r.dir; x.textAlign = 'left'; x.textBaseline = 'alphabetic';
    x.fillStyle = '#fff';
    x.fillText(r.t, x0, y0);
    const d = x.getImageData(0, 0, W, H).data, h = M.HEAPU8;
    for (let i = 0, j = 3; i < W * H; i++, j += 4) h[ptr + i] = d[j];
    return 1;
  },
};
function engOvInstall(M) { if (M && M.mbaaOvEmoji !== engOvHooks.mbaaOvEmoji) Object.assign(M, engOvHooks); }
// The comment renderer's setup as the page last made it, kept here and put back inside a memory restore (viewer.js
// ovRestored: a keyframe seek / boot snapshot rolls the renderer back): in the page path the chat sets it up again in
// that same task, so the seek's own frames draw the comments ("behind the fighters" draws them inside the game frame, a
// re-present cannot add them); from the worker the chat would hear of it only after the seek drew. The fonts, the
// switches, and each comment's add (with its code points) and later style / face / motion calls; a removed comment
// dropped, wall-clock ones dropped once long gone (the renderer drops them too)
const engOvJ = { faces: new Map(), set: new Map(), cm: new Map(), cps: null };
const ENG_OV_ONE = new Set(['_viewer_ov_canvas', '_viewer_ov_behind', '_viewer_ov_on', '_viewer_ov_clock', '_viewer_ov_wall_pin']);
const ENG_OV_MORE = new Set(['_viewer_ov_style', '_viewer_ov_shadow', '_viewer_ov_face', '_viewer_ov_fx', '_viewer_ov_move']);
function engOvRecord(f, a) {
  const J = engOvJ;
  if (f === '_viewer_ov_font_face' && engMem.has(a[1])) J.faces.set(a[0], engMem.get(a[1]).b);
  else if (f === '_viewer_ov_font' && engMem.has(a[0])) J.faces.set(0, engMem.get(a[0]).b);
  else if (ENG_OV_ONE.has(f)) J.set.set(f, a);
  else if (f === '_viewer_ov_show') J.set.set(`${f}:${a[0]}`, a);
  else if (f === '_viewer_ov_add') {
    J.cm.set(a[0], [[f, a, J.cps]]);
    if (J.cm.size > 300) { const now = performance.now() / 1000; for (const [id, c] of J.cm) { const x = c[0][1]; if (!x[2] && now > x[3] + x[8] + 10) J.cm.delete(id); } }
  } else if (ENG_OV_MORE.has(f)) { const c = J.cm.get(a[0]); if (c) c.push([f, a]); }
  else if (f === '_viewer_ov_remove') J.cm.delete(a[0]);
  else if (f === '_viewer_ov_clear') { for (const [id, c] of J.cm) if (a[0] < 0 || (c[0][1][2] ? 1 : 0) === a[0]) J.cm.delete(id); }
}
function engOvReplay(M) {
  if (!M || !M._viewer_ov_add) return;
  engOvInstall(M);
  for (const [f, b] of engOvJ.faces) { const p = M._malloc(b.length); M.HEAPU8.set(b, p); M._viewer_ov_font_face(f, p, b.length); M._free(p); }
  for (const [k, a] of engOvJ.set) M[k.split(':')[0]](...a);
  for (const c of engOvJ.cm.values()) for (const [f, a, cps] of c) {
    if (cps) { const p = M._viewer_ov_buf(cps.length); M.HEAP32.set(new Int32Array(cps.buffer, cps.byteOffset, cps.length), p >> 2); }
    M[f](...a);
  }
}
// (memory the page staged: its pretend pointers to this module's)
const engMem = new Map();
async function engFont(name, bytes, desc) {
  try { const ff = new FontFace(name, bytes, desc || {}); await ff.load(); self.fonts.add(ff); engOv.runW.clear(); } catch (e) { console.warn('engine font', name, e); }
}
// commands run one after another (a comment's calls after the play that made its session); the file / movie / setting
// hand-offs an awaited command waits for run at once
const ENG_NOW = new Set(['init', 'vis', 'offscreen', 'loseGl', 'files', 'movie', 'peek', 'fb', 'radio', 'extSeq', 'ext', 'extOff', 'ui', 'ovColors', 'perf', 'rsSub', 'liveFirst', 'liveSnap', 'page', 'liveFollow', 'rec', 'lab', 'tl']);
let engQ = Promise.resolve();
let engCur = '', engHb = 0;  // (the queued command running now: in the state, for a queue that stopped)
// (a command that fails is reported and the queue goes on: a rejected link skipped every command after it for good)
self.onmessage = e => { const t0 = engTL ? performance.now() : 0; try { engOnMsg(e); } finally { if (engTL) { engTlMsg += performance.now() - t0; const k = e.data.cmd + (e.data.f ? ':' + e.data.f : ''); engTlCmds[k] = (engTlCmds[k] || 0) + 1; } } };
const engOnMsg = e => {
  if (ENG_NOW.has(e.data.cmd)) { engCmd(e).catch(err => engPost({ ev: 'error', cmd: e.data.cmd, msg: String(err && err.stack || err) })); return; }
  engQ = engQ.then(async () => {
    engCur = e.data.cmd + (e.data.f ? ':' + e.data.f : '');
    try { await engCmd(e); } catch (err) { engPost({ ev: 'error', cmd: e.data.cmd, msg: String(err && err.stack || err) }); } finally { engCur = ''; }
  });
};
const engCmd = async e => {
  const d = e.data;
  try {
    if (d.cmd === 'init') {
      engOff = d.off; engCanvasHooks(engOff); engWasmV = d.wasmV || ''; LOWMEM = !!d.lowmem; SW_KEEP = !!d.swKeep; engLS = d.ls || {};
      importScripts('mbaa.js' + (engWasmV ? `?${engWasmV}` : ''));
      man = d.man; Object.assign(ui, d.ui || {}); fb.on = !!d.fbOn; LIVE = d.live || ''; Object.assign(engPage, d.page || {});
      engPost({ ev: 'ready' });
      engineWarm();  // (the boot ahead of the first match: play takes it, warmTake)
    } else if (d.cmd === 'vis') {  // (the page's visibility: hidden, its timer ticks the game; shown again, a lost picture restored)
      engHidden = !!d.hidden; engPip = !!d.pip;
      engBgTick(engHidden);
      if (!engHidden) engRafRelease();
      if (!engHidden && d.shown) setTimeout(glRecover, 1000);
    } else if (d.cmd === 'offscreen') {  // (glRecover's new canvas, at the old one's size)
      const o = engOff; engOff = d.off; engOff.width = o.width; engOff.height = o.height; engCanvasHooks(engOff);
      if (d.id && engNeed.has(d.id)) { engNeed.get(d.id)(); engNeed.delete(d.id); }
    } else if (d.cmd === 'loseGl') {  // (tests: the context lost (WEBGL_lose_context), restored after d.ms; or the WebGPU device destroyed: a real loss)
      const M = session && session.M, D = M && M.__wg && M.__wgBoot && M.__wgBoot.device;
      if (D) { D.destroy(); engPost({ ev: 'ret', id: d.id, kind: 'webgpu' }); return; }
      const g = M && engOff.GLctxObject && engOff.GLctxObject.GLctx, x = g && g.getExtension('WEBGL_lose_context');
      if (!x) { engPost({ ev: 'ret', id: d.id, err: 'no WEBGL_lose_context' }); return; }
      x.loseContext();
      if (d.ms >= 0) setTimeout(() => { try { x.restoreContext(); } catch (e) {} }, d.ms);
      engPost({ ev: 'ret', id: d.id, kind: 'webgl' });
    } else if (d.cmd === 'files') {
      for (const [p, b] of d.list) cache.set(p, b);
      if (d.id && engNeed.has(d.id)) { engNeed.get(d.id)(); engNeed.delete(d.id); }
    } else if (d.cmd === 'movie') {  // (the page's movieLoad: the H.264 copy first on desktop, then the lossless file)
      if (d.lossless) { movieBytes = d.lossless; movieH264 = null; if (session) { session.M.mbaaMovie = movieBytes; if (session.M.mbaaMovieVideo) session.M.mbaaMovieVideo.close(); delete session.M.mbaaMovieVideo; } }
      else if (d.h264 && !movieBytes) { movieH264 = d.h264; if (session) session.M.mbaaMovieVideo = movieVideo(movieH264); }
      if (d.id && engNeed.has(d.id)) { engNeed.get(d.id)(); engNeed.delete(d.id); }
    } else if (d.cmd === 'play') {
      // (a live start: the page's startLive / liveSwitch made the source; its first records and snapshot follow as they come)
      const v = d.live;
      if (v) {
        liveSrc = { id: v.id, info: v.info, since: v.since, fresh: !!v.fresh,
                    first: v.first ? engLiveTake(`first:${v.seq}`) : null, snapP: v.snap ? engLiveTake(`snap:${v.seq}`) : null };
        liveResume = v.resume || null; liveClickAt = v.click ?? null; liveWant = v.id;
      }
      await play(d.rep, d.name, d.catchUp || 0, d.want ? new Set(d.want) : null, v ? v.id : null);
      engPost({ ev: 'played', id: d.id, started: self.__mbaaStarted });
    } else if (d.cmd === 'liveFirst' || d.cmd === 'liveSnap') {
      // (ENG_NOW: it can come before its play, which waits in the queue behind a running command; the entry stays until
      // both have been: was deleted here, and a play run after it waited on a new promise for good)
      const k = `${d.cmd === 'liveFirst' ? 'first' : 'snap'}:${d.seq}`, p = engLiveDef(k);
      p.res(d.v); p.done = true; if (p.taken) engLiveD.delete(k);
    } else if (d.cmd === 'page') {
      Object.assign(engPage, d.page);
    } else if (d.cmd === 'liveFollow') {
      if (session && session.liveSrc) liveFollow(session, d.on);
    } else if (d.cmd === 'liveCssBg') {
      if (session && session.liveSrc) liveCssBg(session, new Set(d.paths));
    } else if (d.cmd === 'liveGoLive') {
      await liveGoLive();
    } else if (d.cmd === 'fb') {
      fb.on = d.on; if (!d.on) { fb.raw = fb.tag = fb.m = null; fb.s = null; }
    } else if (d.cmd === 'perf') {  // (the page's __mbaaProf.start / stop)
      if (!engProf) return;
      if (d.start !== undefined) engProf.start(d.start || undefined);
      else if (d.stop) { if (engProf.on) engProf.stop(); else engPost({ ev: 'perf', stopped: 1, on: false, done: engProf.done }); }
    } else if (d.cmd === 'rsSub') {
      engRsSub = true;
    } else if (d.cmd === 'peek') {
      for (const k of d.keys) engPeek.add(k);
    } else if (d.cmd === 'ui') {
      // (the page's play / pause: its sound unmuted as the page's setPaused does; a seek made while paused left the
      // session muted, and every sound after it went over muted: a realtime export after its seek was silent)
      Object.assign(ui, d.ui); if (session) session.mute = !!ui.paused || !!session.seeking;
      if (session && !session.seeking) uiApply(session);
    } else if (d.cmd === 'seek') {
      await requestSeek(d.T); engPost({ ev: 'seeked', T: d.T, id: d.id });
    } else if (d.cmd === 'step') {
      await stepBy(d.n, d.pause); engPost({ ev: 'stepped', id: d.id });
    } else if (d.cmd === 'skip') {
      if (session) await skipIntro(session); engPost({ ev: 'skipped', id: d.id });
    } else if (d.cmd === 'keepTake') {  // (startLive: the live match being left, kept warm for a switch back: liveKeepTake)
      if (session && session.liveSrc && session.liveSrc.id === d.from) liveKeepTake(session);
    } else if (d.cmd === 'keptDrop') {
      liveKeptDrop(d.why);
    } else if (d.cmd === 'keepBack') {  // (startLive's switch back: the kept match taken for the play that follows)
      const K = liveKept;
      if (!K || K.id !== d.lid || !session || K.M !== session.M || Date.now() - K.at > KEEP_MS) { liveKeptDrop('not resumable'); engPost({ ev: 'ret', id: d.id, ok: false }); }
      else {
        // (its records, read on while away, for the page's session (chat positions, clip links: liveBegin hands the
        // worker's the same Map); the poll stopped with the take, so nothing comes between this and liveBegin)
        const parts = [...K.recs.keys()].sort((x, y) => x - y).map(i => K.recs.get(i));
        const recs = new Uint8Array(parts.reduce((n, b) => n + b.length, 0));
        let o = 0; for (const b of parts) { recs.set(b, o); o += b.length; }
        liveBackTake(K, session, d.click); engKeptPost(); engPost({ ev: 'ret', id: d.id, ok: true, recs, firstGame: K.firstGame });
      }
    } else if (d.cmd === 'tl') {  // (tests: the frame timeline on (reset) / off (its records back))
      const M = session && session.M;
      if (d.on) {
        engTL = []; engTlPF = 0;
        // (the frame hook's share, and its keyframe / hash parts: wrapped once, timed while the timeline runs)
        if (!self.__engTlW) {
          self.__engTlW = 1;
          const T = (name, f) => function (...a) { if (!engTL) return f.apply(this, a); const t0 = performance.now(); try { return f.apply(this, a); } finally { engTlPart[name] = (engTlPart[name] || 0) + performance.now() - t0; } };
          incTick = T('incTick', incTick); hashRuns = T('hashRuns', hashRuns); preCopyHot = T('preCopyHot', preCopyHot); incCommit = T('incCommit', incCommit); kfTexAdd = T('kfTexAdd', kfTexAdd); storeGc = T('storeGc', storeGc); thin = T('thin', thin); packSend = T('packSend', packSend);
          if (typeof fbSample === 'function') fbSample = T('fbSample', fbSample);
        }
        if (M && !M.__tlW) { M.__tlW = 1; const h = M.mbaaFrame; M.mbaaFrame = function (f) { if (!engTL) return h(f); const t0 = performance.now(); try { return h(f); } finally { engTlPart.hook = (engTlPart.hook || 0) + performance.now() - t0; } }; }
        if (d.prof && M && M._viewer_prof_on) { M._viewer_prof_on(1); engTlPF = M._viewer_prof_stats(); const q = engTlPF >> 3; for (let i = 0; i < 3; i++) engTlP0[i] = M.HEAPF64[q + i]; }
        engPost({ ev: 'ret', id: d.id, ok: true });
      } else { const r = engTL || [], cmds = engTlCmds, timers = engTlTimers; engTL = null; engTlCmds = {}; engTlTimers = {}; if (M && M._viewer_prof_on && !self.__mbaaProfOn) M._viewer_prof_on(0); engPost({ ev: 'ret', id: d.id, tl: r, cmds, timers, kfv: self.__kfVerify || null, kfs: session && session.tl ? session.tl.kfs.map(k => [k.frame, k.pending ? 1 : 0]) : null, drops: session && session.tl ? session.tl.incDropped || 0 : 0, dropPages: session && session.tl && session.tl.incStat ? session.tl.incStat.dropPages.slice() : null }); }
    } else if (d.cmd === 'stateRows') {  // (?swhash=1 tests: __mbaaStateRows)
      engPost({ ev: 'ret', id: d.id, v: await stateRowsTake(d.k, d.n) });
    } else if (d.cmd === 'eval') {  // (tests, tools/stage3d/s3d_render_ab.py: a function's source run here with the module)
      let v, err = null;
      try { v = await (0, eval)('(' + d.src + ')')(session && session.M, d.arg); } catch (e) { err = String(e && e.stack || e); }
      engPost({ ev: 'ret', id: d.id, v, err });
    } else if (d.cmd === 'capture') {  // (tests, frame_hashes.py: frame k's back buffer, as its GRAB on the page did)
      const M = session.M;
      M.ccall('viewer_capture_at', null, ['number'], [d.k]);
      const f = M.ccall('viewer_frame', 'number', [], []);
      if (f <= d.k) M.ccall('viewer_step', 'number', ['number'], [d.k + 1 - f]);
      for (let t = 0; t < (d.wait || 40) && !M.ccall('viewer_capture_ready', 'number', [], []); t++) await new Promise(r => setTimeout(r, 25));
      if (!M.ccall('viewer_capture_ready', 'number', [], [])) { engPost({ ev: 'captured', id: d.id, b: null }); return; }
      const n = 640 * 480 * 4, p = M._malloc(n); M.ccall('viewer_capture_read', null, ['number'], [p]);
      const b = M.HEAPU8.slice(p, p + n); M._free(p);
      engPost({ ev: 'captured', id: d.id, b, draws: M.ccall('viewer_stat', 'number', ['number'], [2]) }, [b.buffer]);
    } else if (d.cmd === 'radio') {  // (the page's radio pick: its stage part)
      radio = d.radio; radioStageFollow = d.follow;
      if (d.xfS) xfStagePending = true;
      if (d.xfY) xfYieldPending = true;
      if (session && session.M) radioStageSync(session);
    } else if (d.cmd === 'lab') {  // (the owner's background tool: window.__mbaaLab.set on the page)
      labApply(d.c);
    } else if (d.cmd === 'extSeq') {
      engExtSeq = d.seq;
    } else if (d.cmd === 'ext') {
      engExtSeq = d.seq; engExtV = d.v;
      const m = await import(d.href);
      if (m.abi !== engExtApi.abi) { engPost({ ev: 'ret', id: d.id, err: `module ABI ${m.abi}, engine ${engExtApi.abi}` }); return; }
      const r = await m.default(engExtApi, () => d.seq === engExtSeq);
      if (typeof r === 'function') engExtOff.set(d.seq, r);
      engPost({ ev: 'ret', id: d.id, off: typeof r === 'function' });
    } else if (d.cmd === 'extOff') {
      const f = engExtOff.get(d.seq); engExtOff.delete(d.seq);
      if (f) await f();
      engPost({ ev: 'ret', id: d.id });
    } else if (d.cmd === 'fn') {  // (a module function the page called: its setters, fire and forget)
      const M = session && session.M;
      if (M) engOvInstall(M);
      if (d.f === '_viewer_ov_font_face' && engMem.has(d.a[1])) engFont(`MbaaOv${d.a[0]}`, engMem.get(d.a[1]).b.slice().buffer);
      if (d.f === '_viewer_represent') engRepresent = 4;
      else if (M && M[d.f]) { M[d.f](...d.a.map(x => (engMem.has(x) ? engMem.get(x).p : x))); if (d.f.startsWith('_viewer_ov_')) engOvRecord(d.f, d.a); }
    } else if (d.cmd === 'mem') {
      const M = session.M, p = M._malloc(d.b.length); M.HEAPU8.set(d.b, p); engMem.set(d.p, { p, b: d.b });
    } else if (d.cmd === 'memFree') {
      const m = engMem.get(d.p); engMem.delete(d.p); if (m && session) session.M._free(m.p);
    } else if (d.cmd === 'ovbuf') {
      const M = session.M, p = M._viewer_ov_buf(d.cps.length); M.HEAP32.set(new Int32Array(d.cps.buffer, d.cps.byteOffset, d.cps.length), p >> 2);
      engOvJ.cps = d.cps;
    } else if (d.cmd === 'ovLists') {
      if (d.reset) { engOv.emo = [null]; engOv.run = [null]; engOv.runW.clear(); engOv.sans = d.sans; engOv.serif = d.serif; }
      if (d.flags && d.flags.src && !engOv.fonts++) engFont('MbaaFlags', d.flags.src, d.flags.range ? { unicodeRange: d.flags.range } : {});
      for (const x of d.emo || []) engOv.emo[x.id] = x;
      for (const x of d.run || []) engOv.run[x.id] = x;
      if (session && session.M) engOvInstall(session.M);
    } else if (d.cmd === 'ovMeasure') {  // (tests: the renderer's own measure of code points, against the page's)
      const M = session.M, p = M._viewer_ov_buf(d.cps.length); M.HEAP32.set(Int32Array.from(d.cps), p >> 2);
      engPost({ ev: 'ret', id: d.id, w: M._viewer_ov_measure_face(d.cps.length, d.px, d.f), has: d.cps.map(c => M._viewer_ov_has(c)) });
    } else if (d.cmd === 'ovProbe') {  // (tests: the renderer's overlay stats, and comment ids' first quads)
      const M = session.M, st = Array.from(new Float64Array(M.HEAPU8.buffer, M._viewer_ov_stats(), 22));
      engPost({ ev: 'ret', id: d.id, stats: st, q: (d.ids || []).map(g => Array.from(new Float32Array(M.HEAPU8.buffer, M._viewer_ov_probe(g), 10))) });
    } else if (d.cmd === 'ovColors') {
      const M = session && session.M;
      if (M && M._viewer_ov_colors) engPost({ ev: 'ovColors', gid: d.id, c: Array.from(new Float64Array(M.HEAPU8.buffer, M._viewer_ov_colors(d.id), 3)) });
    } else if (d.cmd === 'canvas') {  // (the page's canvas size at its device pixels: the renderer draws at it)
      if (!engExKeep) { engOff.width = d.w; engOff.height = d.h; }
    } else if (d.cmd === 'rec') {
      engRec = !!d.on; engRecLast = -1;
      engRecTick(true);  // (the clip's first frame, shown now: before the game moves on)
    } else if (d.cmd === 'exportBegin') {  // fastExport: the canvas at the video's size (the page's placeholder cannot be resized)
      engExKeep = { w: engOff.width, h: engOff.height }; engOff.width = d.w; engOff.height = d.h;
      engPost({ ev: 'ret', id: d.id });
    } else if (d.cmd === 'exportEnd') {
      if (engExKeep) { engOff.width = engExKeep.w; engOff.height = engExKeep.h; const M = session && session.M;
        if (M && M._viewer_ov_canvas) M._viewer_ov_canvas(engExKeep.w, engExKeep.h); if (M && M._viewer_represent) M._viewer_represent(); engExKeep = null; }
      engPost({ ev: 'ret', id: d.id });
    } else if (d.cmd === 'exportPreroll') {  // simulated for its sounds, nothing drawn
      const M = session.M;
      M.ccall('viewer_suppress', 'number', ['number'], [1]);
      try { for (let k = M._viewer_frame(); k < d.to; k++) { const k0 = M._viewer_frame(); M.ccall('viewer_step', 'number', ['number'], [1]); if (M._viewer_frame() === k0) break; } }
      finally { M.ccall('viewer_suppress', 'number', ['number'], [0]); }
      engPost({ ev: 'ret', id: d.id, frame: M._viewer_frame(), sfx: session.sfxQueue.splice(0) });
    } else if (d.cmd === 'exportStep') {  // one frame: stepped, its picture as a VideoFrame (transferred), its boxes / inputs / sounds
      const M = session.M, k0 = M._viewer_frame();
      M.ccall('viewer_step', 'number', ['number'], [1]);
      const f = M._viewer_frame(), st = engStateNow();
      const vf = f !== k0 ? new VideoFrame(engOff, { timestamp: 0, alpha: 'discard' }) : null;
      engPost({ ev: 'ret', id: d.id, frame: f, vf, boxes: st.boxes, inputs: st.inputs, sfx: session.sfxQueue.splice(0) }, vf ? [vf] : []);
    } else if (d.cmd === 'call') {
      const r = session ? session.M.ccall(d.f, 'number', d.a.map(() => 'number'), d.a) : 0; if (d.id) engPost({ ev: 'ret', id: d.id, r });
    }
  } catch (err) { engPost({ ev: 'error', cmd: d.cmd, msg: String(err && err.stack || err) }); if (d.id) engPost({ ev: 'ret', id: d.id, err: String(err && err.message || err) }); }
};

// ---- live: what the page mirrors of the worker's session (engine_head.js) ----
// the records as they come (the page's chat maps its lines' stream positions on them), the finished games' tapes (clip
// links), the session log's lines
const liveKeep0 = liveKeep;
liveKeep = (L, b) => { liveKeep0(L, b); if (session && session.liveSrc === L) engPost({ ev: 'liveRecs', b: b.slice() }); };
// the kept match (switch back), as the page's startLive reads it: posted when it is taken or dropped
let engKeptLast = null;
function engKeptPost() {
  const K = liveKept;
  if (K === engKeptLast) return;
  engKeptLast = K;
  engPost({ ev: 'kept', k: K ? { id: K.id, match: K.match, info: K.info, game: K.game, at: K.at, frame: K.kf.frame, want: [...K.want] } : null });
}
const liveKeepTake0 = liveKeepTake, liveKeptDrop0 = liveKeptDrop;
liveKeepTake = s => { liveKeepTake0(s); engKeptPost(); };
liveKeptDrop = why => { liveKeptDrop0(why); engKeptPost(); };
const liveTapes0 = liveTapes;
liveTapes = s => {
  const L = s.liveSrc, was = L && L.tapes ? new Map(L.tapes) : null;
  liveTapes0(s);
  if (L && L.tapes) for (const [g, t] of L.tapes) if (!was || was.get(g) !== t)
    engPost({ ev: 'liveTape', g, t: { rep: t.rep.slice(), lt: t.lt ? t.lt.slice() : null, rec: t.rec, end: t.end } });
};
const slogAdd0 = slogAdd;
slogAdd = (ev, d = '') => { slogAdd0(ev, d); engPost({ ev: 'slog', e: ev, d: String(d) }); };
// (tests that run in the engine's realm (Playwright's worker.evaluate: the owner's stage sweep with --engine
// worker): the same names the page engine has)
self.__mbaaSession = () => session;
self.__mbaaSeek = T => requestSeek(T);
