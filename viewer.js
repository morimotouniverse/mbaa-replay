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
const BUNDLE = Q.get('bundle') || 'bundle/';
const HASH = Q.get('hash') === '1', PERF = Q.get('perf') === '1', CAPTURE = Q.get('capture') === '1';
const KF_EVERY = Math.max(10, +(Q.get('kf') || 300));  // playback keyframe interval (frames)
const KF_NEAR = 30;  // a seek that re-simulates further than 3x this keyframes about KF_NEAR frames before its target
const PAGE = Math.min(65536, Math.max(16384, +(Q.get('page') || 16384)));  // keyframe page size (bytes)
const KF_BUDGET = +(Q.get('kfmb') || 450) * 1e6;  // keyframe memory; above it, every second older keyframe is dropped

const hex = h => new Uint8Array(h.match(/../g).map(x => parseInt(x, 16)));
let cryptoKey;
async function openObject(buf) {
  const b = new Uint8Array(buf);
  const z = await crypto.subtle.decrypt({ name: 'AES-CTR', counter: b.slice(0, 16), length: 64 }, cryptoKey, b.slice(16));
  const s = new Blob([z]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
const net = window.mbaaNet = { objects: 0, bytes: 0, cached: 0 };
// Bundle objects are content-addressed (the name is a hash of the content), so a stored copy never goes stale: they
// are kept in the Cache Storage API, and a character / stage seen before loads with no network at all. (Pages' own
// HTTP cache keeps them only 10 minutes.)
let objCache = null;
const objCacheReady = (async () => { try { objCache = await caches.open('mbaa-objects-v1'); } catch (e) {} })();
async function fetchObject(h) {
  const url = `${BUNDLE}o/${h.slice(0, 2)}/${h}`;
  await objCacheReady;
  if (objCache) {
    try { const hit = await objCache.match(url); if (hit) { net.cached++; return openObject(await hit.arrayBuffer()); } } catch (e) {}
  }
  const r = await fetch(url);
  if (!r.ok) throw new Error(`object ${h}: HTTP ${r.status}`);
  const buf = await r.arrayBuffer();
  net.objects++; net.bytes += buf.byteLength;
  if (objCache) objCache.put(url, new Response(buf.slice(0))).catch(() => {});
  return openObject(buf);
}
function status(t) { document.getElementById('status').textContent = t; }

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
  for (const t of p.stage) out.add(fmt(t, keys.stage, 0));
  for (const f of (p.stage_files || {})[keys.stage] || []) out.add(f);
  for (const side of [keys.p1, keys.p2]) {
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
  }
  return out;
}

// ---- files: fetched once per page, written into every session's MEMFS ----
const cache = new Map();  // game path -> Uint8Array
async function fetchAll(man, paths, label) {
  const net0 = net.bytes;  // the counter shows what came over the network (objects are deflated; the game sees ~4x that)
  const queue = [...paths].filter(p => !cache.has(p));
  let done = 0, bytes = 0;
  const n = queue.length;
  async function worker() {
    for (let p; (p = queue.shift());) {
      const f = man.files[p];
      let data;
      if (f.plain) {
        const r = await fetch(f.plain);
        if (!r.ok) { console.warn(`${p}: HTTP ${r.status}`); continue; }
        data = new Uint8Array(await r.arrayBuffer());
      } else data = await fetchObject(f.o);
      cache.set(p, data);
      if (++done % 10 === 0 || done === n) status(`${label} ${done}/${n} (${((net.bytes - net0) / 1e6).toFixed(1)} MB downloaded${net.cached ? `, ${net.cached} files from cache` : ''})`);
    }
  }
  await Promise.all(Array.from({ length: 16 }, worker));
}
function mkdirs(FS, path) {
  let cur = '';
  for (const p of path.split('/').slice(0, -1)) { if (!p) continue; cur += '/' + p; try { FS.mkdir(cur); } catch (e) {} }
}

// ---- audio (WebAudio, shared by sessions) ----
let actx, master;
// Browsers keep an AudioContext suspended until the page gets a click or key press; a replay opened from a link has
// had neither, so the page asks for one (#sound) and starts the BGM the game already requested once audio runs.
function ensureAudio() {
  if (actx) return;
  actx = new AudioContext();
  master = actx.createGain();
  const vol = document.getElementById('vol');
  // 100% = CE's own level (every set already carries the game's DirectSound volume, -16.66 dB at the canonical
  // settings); the slider only attenuates below it. Default 100. Remembered under a new key: the old one stored the
  // 50% default of the full-gain era for everyone who opened the page.
  const setVol = () => { master.gain.value = Math.pow(+vol.value / 100, 2); try { localStorage.setItem('mbaaVolCe', vol.value); } catch (e) {} };
  vol.value = 100;
  try { const v = localStorage.getItem('mbaaVolCe'); if (v !== null) vol.value = v; } catch (e) {}
  vol.oninput = setVol; setVol();
  master.connect(actx.destination);
  const btn = document.getElementById('sound');
  const show = () => { btn.hidden = actx.state === 'running'; };
  btn.onclick = () => actx.resume();
  const unlock = () => { if (actx.state !== 'running') actx.resume(); };
  addEventListener('pointerdown', unlock); addEventListener('keydown', unlock);
  actx.onstatechange = () => { show(); if (actx.state === 'running' && window.__mbaaBgmResume) window.__mbaaBgmResume(); };
  show();
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
  const live = () => !HASH && actx.state === 'running' && session === s && !s.mute;
  const seBuf = new Map();  // bundle path -> decode promise
  const se = window.mbaaSeStats = { registered: 0, calls: 0, played: 0, decodeFailed: 0, stops: 0, params: 0, ctx: () => actx.state };
  const voices = new Map();  // channel -> chain
  const chain = ch => { let v = voices.get(ch); if (!v) { v = dsVoiceChain(master); voices.set(ch, v); } return v; };
  const cut = v => { if (v.src) { try { v.src.stop(); } catch (e) {} v.src.disconnect(); v.src = null; } };
  const apply = (v, vol, pan) => { v.vol = vol; v.pan = pan; v.g.gain.value = dsGain(vol); dsSetPan(v, pan); };
  Module.mbaaVoicePlay = (ch, path, vol, pan) => {
    se.calls++;
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
    if (ch === -1) { log(['param', vol, pan]); apply(bgmChain, vol, pan); return; }
    apply(chain(ch), vol, pan);
  };
  Module.mbaaVoiceStop = ch => {
    se.stops++;
    if (ch === -1) { Module.mbaaBgmStop(); return; }
    const v = voices.get(ch);
    if (v) cut(v);
  };
  s.stopSes = () => { for (const v of voices.values()) cut(v); };
  // BGM: the stream set, one looping track (back to loopPos seconds at the end, as the game's stream does)
  const bgmChain = dsVoiceChain(master);
  let bgm = null, bgmPath = '';
  const halt = () => { if (bgm) { try { bgm.stop(); } catch (e) {} bgm = null; } bgmPath = ''; };
  s.bgmLog = [];
  const log = ev => { const k = Module._viewer_frame(); if (!s.tl || k >= s.tl.simMax) s.bgmLog.push([k, ...ev]); };
  const play = (path, loop, loopPos, offset) => {
    halt();
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
      n.connect(bgmChain.g); n.start(0, Math.max(0, off));
      bgm = n;
    }, () => {});
  };
  Module.mbaaBgmStop = () => { log(['stop']); halt(); };
  // SoundBuffer_Play on the stream: restarts the track from its beginning at the set's volume/pan
  Module.mbaaBgmStart = (path, loop, loopPos, vol, pan) => {
    log(['start', path, loop, loopPos, vol, pan]);
    apply(bgmChain, vol, pan);
    if (!live()) { halt(); return; }
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
    halt();
    if (vp) apply(bgmChain, vp[0], vp[1]);
    if (cur && actx.state === 'running' && !s.mute) play(cur.path, cur.loop, cur.loopPos, Math.max(0, T - cur.k - 1) / 60);
  };
  s.bgmHalt = halt;
  window.__mbaaBgmResume = () => { if (session === s && !s.mute) s.bgmSync(Module._viewer_frame()); };
  window.addEventListener('mbaa-session-end', () => { s.stopSes(); halt(); }, { once: true });
}

// BGM tracks decode when the match's files arrive (a few MB of Opus: decoding at BGM start would stall that frame)
const bgmDecoded = new Map();
function bgmDecode(p) {
  if (!bgmDecoded.has(p)) {
    const d = cache.get(p);
    if (!d || !actx) return null;
    bgmDecoded.set(p, actx.decodeAudioData(d.slice().buffer));
  }
  return bgmDecoded.get(p);
}

// ---- a session: one wasm instance playing one replay ----
let session = null;
let man = null;
const misses = new Set();  // bundle files the game looked up that the page had not fetched
function freshCanvas() {
  const old = document.getElementById('canvas');
  const c = old.cloneNode(false);
  old.replaceWith(c);
  return c;
}
async function newSession(rep, name) {
  if (session) { try { session.M.ccall('viewer_stop', null, [], []); } catch (e) {} }
  window.dispatchEvent(new Event('mbaa-session-end'));
  // mbaa.wasm is built with mbaa.js: it takes mbaa.js's cache-busting version (tools/web/deploy_pages.sh)
  const wasmV = ((document.querySelector('script[src^="mbaa.js"]') || {}).src || '').split('?')[1];
  const M = await MBAA({ print: t => console.log(t), printErr: t => console.warn(t), canvas: freshCanvas(),
                         locateFile: p => (wasmV && p.endsWith('.wasm') ? `${p}?${wasmV}` : p) });
  const s = { M, name, rep, live: true, mute: false, gen: 0 };
  session = s;
  const FS = M.FS;
  FS.mkdir('/game');
  // files the game only checks exist (plan.probe: every stage .dat at boot) get a 1-byte placeholder; the real file
  // (the replay's stage, fetched by the plan) is written over it
  for (const p of (man.plan && man.plan.probe) || []) { mkdirs(FS, '/game/' + p); FS.writeFile('/game/' + p, new Uint8Array(1)); }
  for (const [p, d] of cache) { mkdirs(FS, '/game/' + p); FS.writeFile('/game/' + p, d); }
  FS.writeFile('/game/replay.rep', rep);
  M.mbaaAssetMiss = p => { if (man.files[p] && !cache.has(p)) misses.add(p); };
  audioHooks(M, s);
  if (!HASH) for (const p of cache.keys()) if (/^bgm\/.*\.opus$/.test(p)) bgmDecode(p);
  return s;
}
const call = (s, f, ...a) => s.M.ccall(f, 'number', a.map(() => 'number'), a);

// play from the start; with catchUp = k, step to frame k first (no pacing) and continue from there
async function play(rep, name, catchUp = 0) {
  misses.clear();
  const s = await newSession(rep, name);
  if (!call(s, 'viewer_boot') || !call(s, 'viewer_load')) { window.__mbaaStarted = -1; status('start failed (see console)'); return; }
  if (HASH) s.M.ccall('viewer_hash_enable', null, [], []);
  call(s, 'viewer_play', 0);
  window.__mbaa = { Module: s.M, man };
  if (!HASH || CAPTURE) timelineInit(s);
  if (!HASH && !CAPTURE && !PERF && !catchUp) startScan(s);
  window.__mbaaStarted = 1;
  if (CAPTURE) { status(`loaded ${name} (capture mode)`); return; }
  if (HASH) return hashRun(s);
  for (let f = 0; f < catchUp && s === session;) {
    f = call(s, 'viewer_step', Math.min(240, catchUp - f));
    status(`catching up ${f}/${catchUp}`);
    await new Promise(r => setTimeout(r, 0));
    if (misses.size) return refetchAndReplay(s, f);
  }
  if (PERF) call(s, 'viewer_perf', 1);
  uiApply(s);
  const tq = +(Q.get('t') || 0);
  if (tq > 0 && !catchUp && !PERF && s.tl && window.__mbaaRepUrl) { await requestSeek(tq); }
  else if (ui.skipIntro && !catchUp && !PERF && s.tl) await skipIntro(s);
  if (s !== session) return;
  call(s, 'viewer_run');
  status(`playing ${name}`);
  watch(s);
}
// a planned file was missing: fetch what the game asked for and replay to where this session was
async function refetchAndReplay(s, frame) {
  call(s, 'viewer_stop');
  const want = withSiblings(man, misses);
  console.warn(`asset plan missed ${want.size} files at frame ${frame}:`, [...want]);
  window.mbaaPlanMisses = (window.mbaaPlanMisses || []).concat([...want]);
  await fetchAll(man, want, 'fetching missed files');
  return play(s.rep, s.name, frame);
}
function watch(s) {
  const t = setInterval(() => {
    if (s !== session) return clearInterval(t);
    if (misses.size) { clearInterval(t); refetchAndReplay(s, call(s, 'viewer_frame')); return; }
    if (call(s, 'viewer_ended') && !s.endShown) { s.endShown = true; status(`finished ${s.name} (${call(s, 'viewer_frame')} frames)`); }
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
      await fetchAll(man, withSiblings(man, misses), 'fetching missed files');
      window.mbaaPlanMisses = (window.mbaaPlanMisses || []).concat([...misses]);
      return play(s.rep, s.name);
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
    document.querySelector('.bar').appendChild(a);
  };
  const tag = s.name.replace(/\.rep$/i, '').replace(/^.*\//, '');
  link(h.state.join(''), `${tag}_state.csv`);
  link(h.audio.join(''), `${tag}_audio.csv`);
  status(`state hash done: ${h.frames} frames in ${(h.ms / 1000).toFixed(1)} s`);
}
// ---- timeline: keyframes, seek, frame step ----
const ui = { paused: false, speed: 1, boxes: false, inputs: false, skipIntro: false };
try { ui.skipIntro = localStorage.getItem('mbaaSkipIntro') === '1'; } catch (e) {}
const tlMax = t => t.end !== null ? t.end : Math.max(t.simMax, t.est, 1);
function uiApply(s) {
  call(s, 'viewer_pause', ui.paused || s.seeking ? 1 : 0);
  call(s, 'viewer_speed', ui.speed);
  call(s, 'viewer_boxes_enable', ui.boxes ? 1 : 0);
}
function timelineInit(s) {
  const M = s.M;
  const t = s.tl = { kfs: [], simMax: 0, end: null, marks: [], bytes: 0, lastKf: -1, seekMs: [],
                     want: null, running: false, round: -1, scene: -1, est: repEstimate(s.rep) };
  M.mbaaFrame = f => {
    if (f > t.simMax) {
      t.simMax = f;
      const scene = M.HEAP32[0x54EEE8 >> 2], round = M.HEAP32[0x77BFA4 >> 2];
      if (scene === 1 && (t.scene !== 1 || round !== t.round) && !t.marks.some(m => m[0] === f)) {
        t.marks.push([f, round]); t.marks.sort((a, b) => a[0] - b[0]);
      }
      t.scene = scene; t.round = round;
      if (t.end === null && M._viewer_ended()) t.end = f;
    }
    if (!s.seeking) incTick(s, f);
    else if (f >= t.lastKf + KF_EVERY && f >= t.simMax && !M._viewer_files_open()) keyframe(s, f);
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
  w.postMessage({ files: [...cache], probe: (man.plan && man.plan.probe) || [], rep: s.rep, v });
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
function packPage(H, o, W) {
  let nz = 0;
  for (let j = 0; j < W; j++) if (H[o + j] !== 0) nz++;
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
  for (const pk of packed) if (!pk.r) words += M32 + pk.v.length;
  const buf = new Int32Array(words);
  let o = 0;
  list.forEach((q, k) => {
    const pk = packed[k];
    if (pk.r) { q.r = q.r.slice(); return; }  // kept raw: its own copy (the commit buffer can go)
    buf.set(pk.m, o); q.m = buf.subarray(o, o + M32); o += M32;
    buf.set(pk.v, o); q.v = buf.subarray(o, o + pk.v.length); o += pk.v.length;
    t.bytes += pk.bytes - q.bytes; q.bytes = pk.bytes; delete q.r;
  });
}
function unpackPage(q, H, o, W) {
  if (q.r) { H.set(q.r, o); return; }
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
  t.kfs.splice(at, 0, { frame: f, pages, ms: performance.now() - t0, fresh });
  t.lastKf = t.kfs[t.kfs.length - 1].frame;
  thin(t);
}
// over the memory budget: drop every second keyframe (never the first, the newest or a pending one)
function thin(t) {
  if (t.bytes > KF_BUDGET && t.kfs.length > 4) {
    const keep = t.kfs.filter((k, i) => i === 0 || i === t.kfs.length - 1 || i % 2 === 0 || k.pending);
    for (const k of t.kfs) if (!keep.includes(k)) for (const p of k.pages) pageRef(t, p, -1);
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
function incTick(s, f) {
  const t = s.tl, M = s.M;
  let c = t.inc;
  if (!c) {
    const base = t.kfs[t.kfs.length - 1];
    if (!base || base.pending || f < base.frame + KF_EVERY - KF_PHASE || f < t.simMax) return;
    const hot = t.hotAt || (t.hotAt = new Map());
    const cold = [];
    for (let i = 0; i < base.pages.length; i++) {
      const q = base.pages[i];
      if (q && !hot.has(i) && !(q.v && q.v.length === 0)) cold.push(i);  // a zero page is free heap: hot
    }
    c = t.inc = { F: base.frame + KF_EVERY, base, cold, cur: 0, changed: [], kf: null, t0: 0, ms: 0 };
  }
  const t0 = performance.now(), phase = c.kf ? 'post' : f >= c.F ? 'commit' : 'pre';
  const slice = Math.ceil(c.cold.length / KF_PHASE);
  if (!c.kf) {  // pre pass
    const n = Math.min(c.cold.length, c.cur + (f >= c.F ? c.cold.length : slice));
    if (n > c.cur) {
      const part = c.cold.slice(c.cur, n);
      hashRuns(M, part);
      const hs = hashView(M, part[part.length - 1] + 1);
      for (const i of part) if (!sameHash(hs, i, c.base.pages[i])) c.changed.push(i);
      c.cur = n;
    }
    if (f >= c.F && c.cur === c.cold.length && !M._viewer_files_open() && !t.kfs.some(k => k.frame === f)) incCommit(s, f, c);
  } else {  // post pass
    if (c.raw.length) packBatch(t, c.raw.splice(0, Math.ceil(c.rawTotal / (KF_PHASE / 2))));
    const n = Math.min(c.tentative.length, c.cur + slice);
    const part = c.tentative.slice(c.cur, n);
    if (part.length) {
      hashRuns(M, part);
      const hs = hashView(M, part[part.length - 1] + 1);
      for (const i of part) if (!sameHash(hs, i, c.base.pages[i])) {
        c.bad = true; t.hotAt.set(i, t.kfs.length);
        const q = c.base.pages[i];
        t.incStat.dropPages.push([i * PAGE, q.r ? 'raw' : q.v.length]);
      }
    }
    c.cur = n;
    if (c.bad || (n === c.tentative.length && !c.raw.length)) {
      if (c.bad) {  // a cold page changed around F: its content at F is unknown
        const at = t.kfs.indexOf(c.kf);
        if (at >= 0) { t.kfs.splice(at, 1); for (const p of c.kf.pages) pageRef(t, p, -1); }
        t.lastKf = t.kfs.length ? t.kfs[t.kfs.length - 1].frame : -1;
        t.incDropped = (t.incDropped || 0) + 1;
      } else { c.kf.pending = false; c.kf.ms = c.ms; thin(t); }
      t.inc = null;
    }
  }
  const dt = performance.now() - t0;
  c.ms = Math.max(c.ms, dt);
  const st = t.incStat || (t.incStat = { pre: [], commit: [], post: [], dropPages: [] });
  st[phase].push(Math.round(dt * 10) / 10);
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
  // the changed pages, copied into one buffer (one allocation, not one per page)
  if (!t.commitBuf || t.commitBuf.length < changed.length * W) t.commitBuf = new Int32Array(Math.ceil(changed.length * 1.5) * W);
  const buf = t.commitBuf, raw = [];  // reused: every raw page is packed or copied out during the post pass
  changed.forEach((i, k) => {
    buf.set(H.subarray(i * W, i * W + W), k * W);
    pages[i] = { r: buf.subarray(k * W, k * W + W), bytes: PAGE, h: [hs[4 * i], hs[4 * i + 1], hs[4 * i + 2], hs[4 * i + 3]] };
    raw.push(pages[i]);
  });
  t.bytes += changed.length * PAGE;
  const fresh = changed.length;
  for (let i = 0; i < n; i++) pageRef(t, pages[i], +1);
  (t.commitParts || (t.commitParts = [])).push([now.length, Math.round(T1 - T0), Math.round(performance.now() - T1), fresh]);
  c.kf = { frame: f, pages, ms: 0, fresh, pending: true, inc: true };
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
  s.tl.lastCopied = copied;
  call(s, 'viewer_restore_end', ++s.gen);
  // the restored state-hash / audio row buffers hold the keyframe's leftovers
  if (HASH) { M.ccall('viewer_hash_take', 'string', [], []); M.ccall('viewer_audio_take', 'string', [], []); }
}
// Seek to frame T (the state after T steps; the picture is frame T's). Coalesced: while a seek runs only the latest
// request waits, the ones in between are dropped (dragging the slider, holding the step key).
function requestSeek(T) {
  const s = session;
  if (!s || !s.tl) return Promise.resolve();
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
    if (t.inc.kf) { const at = t.kfs.indexOf(t.inc.kf); if (at >= 0) { t.kfs.splice(at, 1); for (const p of t.inc.kf.pages) pageRef(t, p, -1); } }
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
  t.seekMs.push({ from: cur, to: T, ms: r1(performance.now() - t0), restoreMs: restored ? r1(t1 - t0) : 0,
                  copied: restored ? t.lastCopied : 0, sim: T - f1,
                  simMs: r1(t2 - t1), drawMs: r1(t3 - t2) });
  overlayDirty = true;
  if (!s.endShown) status(`${ui.paused ? 'paused' : 'playing'} ${s.name}`);
}
// Skip the VS intro: simulate (not drawn, silent) up to the first battle frame, then draw from there. The intro is
// still simulated (the match state depends on it); only its picture and sound are skipped.
const SCENE_VS = 8;  // the VS screen scene (g_CurrentSceneId 0x54EEE8)
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
  status(`${ui.paused ? 'paused' : 'playing'} ${s.name}`);
}
// Copy the current moment: a link that opens this replay at this frame when the replay came from a URL (?rep=),
// otherwise the replay name, time and frame as text.
async function copyTimestamp() {
  const s = session;
  if (!s) return;
  const f = s.M._viewer_frame();
  let text;
  if (window.__mbaaRepUrl) {
    const u = new URL(location.href);
    u.searchParams.set('rep', window.__mbaaRepUrl); u.searchParams.set('t', f);
    text = u.toString();
  } else text = `${s.name.replace(/^.*\//, '')} @ ${fmtTime(f)} (frame ${f})`;
  try { await navigator.clipboard.writeText(text); status(`copied: ${text}`); }
  catch (e) { prompt('copy:', text); }
}
function setPaused(p) {
  ui.paused = p;
  document.getElementById('pause').textContent = p ? 'play' : 'pause';
  const s = session;
  if (!s) return;
  s.mute = p || !!s.seeking;
  if (p) { s.stopSes(); s.bgmHalt(); } else if (!s.seeking) s.bgmSync(s.M._viewer_frame());
  if (!s.seeking) uiApply(s);
}
const curFrame = () => session ? (session.tl && session.tl.want !== null ? session.tl.want : session.M._viewer_frame()) : 0;
function stepBy(n, pause = true) {
  if (!session || !session.tl) return Promise.resolve();
  if (pause && !ui.paused) setPaused(true);
  if (n === 1 && session.tl.want === null && !session.tl.running) {  // one frame forward: just step
    call(session, 'viewer_step', 1);
    overlayDirty = true;
    return Promise.resolve();
  }
  return requestSeek(curFrame() + n);
}
window.mbaaViewer = { seek: requestSeek, step: stepBy, pause: setPaused, frame: () => session.M._viewer_frame(),
                      tl: () => session.tl, ui,
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
function drawOverlay() {
  const c = document.getElementById('overlay'), gc = document.getElementById('canvas');
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
}

// ---- controls ----
function fmtTime(f) { const sec = f / 60; return `${Math.floor(sec / 60)}:${(sec % 60).toFixed(1).padStart(4, '0')}`; }
let seekDragging = false, marksKey = '';
function uiLoop() {
  const s = session;
  if (s && s.tl) {
    const t = s.tl, f = s.M._viewer_frame(), max = tlMax(t);
    const seek = document.getElementById('seek');
    if (+seek.max !== max) seek.max = max;
    if (!seekDragging) seek.value = t.want !== null ? t.want : f;
    document.getElementById('fc').textContent = `${f} / ${max}${t.end === null ? '+' : ''}  ${fmtTime(f)}`;
    drawMarks(t, max);
    if (f !== lastDrawnFrame || overlayDirty) { lastDrawnFrame = f; overlayDirty = false; drawOverlay(); }
  }
  requestAnimationFrame(uiLoop);
}
// round starts over the slider; the explored part (seeks inside it restore a keyframe) is shaded
function drawMarks(t, max) {
  const key = `${t.marks.length}/${max}/${Math.round(t.simMax / 60)}`;
  if (key === marksKey) return;
  marksKey = key;
  const c = document.getElementById('marks'), dpr = window.devicePixelRatio || 1;
  c.width = Math.round(c.clientWidth * dpr); c.height = Math.round(c.clientHeight * dpr);
  const g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  g.fillStyle = '#2c3350';
  g.fillRect(0, 0, c.width * Math.min(1, t.simMax / max), c.height);
  g.fillStyle = '#ffcc40'; g.font = `${Math.round(10 * dpr)}px system-ui, sans-serif`; g.textBaseline = 'top';
  for (const [f, r] of t.marks) {
    const x = Math.round(c.width * f / max);
    g.fillRect(x, 0, Math.max(1, dpr), c.height);
    g.fillText(`R${r + 1}`, x + 2 * dpr, 0);
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
  document.getElementById('marks').addEventListener('click', e => {
    const s = session;
    if (!s || !s.tl) return;
    const r = e.currentTarget.getBoundingClientRect(), max = tlMax(s.tl), x = (e.clientX - r.left) / r.width * max;
    let best = null;
    for (const [f] of s.tl.marks) if (best === null || Math.abs(f - x) < Math.abs(best - x)) best = f;
    if (best !== null && Math.abs(best - x) / max < 0.04) requestSeek(best); else requestSeek(Math.round(x));
  });
  btn('prevr', () => jumpRound(-1)); btn('nextr', () => jumpRound(1));
  // a click / tap on the picture during the VS screen skips it, as a button press does in the game
  document.getElementById('overlay').parentElement.addEventListener('pointerdown', () => { if (inIntro(session)) skipIntro(session); });
  const si = document.getElementById('skipintro');
  si.checked = ui.skipIntro;
  si.onchange = () => { ui.skipIntro = si.checked; try { localStorage.setItem('mbaaSkipIntro', si.checked ? '1' : '0'); } catch (e) {} si.blur(); };
  btn('back5', () => stepBy(-300, false)); btn('back1', () => stepBy(-1)); btn('fwd1', () => stepBy(1)); btn('fwd5', () => stepBy(300, false));
  document.getElementById('speed').onchange = e => { ui.speed = +e.target.value; if (session) call(session, 'viewer_speed', ui.speed); e.target.blur(); };
  for (const key of ['boxes', 'inputs']) {
    const el = document.getElementById(key);
    el.onchange = () => {
      ui[key] = el.checked;
      if (session && key === 'boxes') { call(session, 'viewer_boxes_enable', ui.boxes ? 1 : 0); if (ui.boxes) call(session, 'viewer_boxes_refresh'); }
      overlayDirty = true; el.blur();
    };
  }
  addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key, sec = e.shiftKey ? 300 : 60;
    const flip = id => { const el = document.getElementById(id); el.checked = !el.checked; el.onchange(); };
    if (k === ' ') { if (inIntro(session)) skipIntro(session); else setPaused(!ui.paused); }
    else if (k === ',' || k === '<') stepBy(-1);
    else if (k === '.' || k === '>') stepBy(1);
    else if (k === 'ArrowLeft') stepBy(-sec, false);
    else if (k === 'ArrowRight') stepBy(sec, false);
    else if (k === 'Home') requestSeek(1);
    else if (k === 'End' && session && session.tl) requestSeek(tlMax(session.tl));
    else if (k === 'c' || k === 'C') copyTimestamp();
    else if (k === '[' || k === 'PageUp') jumpRound(-1);
    else if (k === ']' || k === 'PageDown') jumpRound(1);
    else if (k === 'h' || k === 'H') flip('boxes');
    else if (k === 'i' || k === 'I') flip('inputs');
    else return;
    e.preventDefault();
  });
  requestAnimationFrame(uiLoop);
}

window.__mbaaPerf = () => {
  const M = session.M, n = call(session, 'viewer_perf_count'), p = call(session, 'viewer_perf_data');
  return Array.from(M.HEAPF64.subarray(p / 8, p / 8 + n));
};

async function start(file) {
  ensureAudio(); actx.resume();  // a drop or file pick is a user gesture: audio may start
  const rep = new Uint8Array(await file.arrayBuffer());
  let keys;
  try { keys = repKeys(rep); } catch (e) { status('error: ' + e.message); return; }
  if (man.plan) {
    status(`stage ${keys.stage}, P1 ${keys.p1[0]}:${keys.p1[1]} vs P2 ${keys.p2[0]}:${keys.p2[1]}: fetching`);
    let want = planFiles(man, keys);
    // ?planDrop=REGEX (test): leave matching files out of the plan, to exercise the miss -> fetch -> catch-up path
    if (Q.get('planDrop')) { const re = new RegExp(Q.get('planDrop')); want = new Set([...want].filter(f => !re.test(f))); }
    await fetchAll(man, want, 'match assets');
  }
  window.__mbaaKeys = keys;
  await play(rep, file.name);
}

async function main() {
  const plainList = Q.get('files'), plainRoot = Q.get('root') || '';
  if (plainList) {
    man = { files: {} };
    for (const p of await (await fetch(plainList)).json()) man.files[p.toLowerCase()] = { plain: plainRoot + p };
    await fetchAll(man, Object.keys(man.files), 'assets');
  } else {
    cryptoKey = await crypto.subtle.importKey('raw', hex(KEY_HEX), 'AES-CTR', false, ['decrypt']);
    status('loading manifest…');
    const r = await fetch(BUNDLE + 'manifest.bin');
    net.bytes += +(r.headers.get('content-length') || 0);
    man = JSON.parse(new TextDecoder().decode(await openObject(await r.arrayBuffer())));
    if (!man.plan) await fetchAll(man, Object.keys(man.files), 'assets');  // a bundle without a plan: everything
  }
  status('ready: drop a .rep file');
  document.getElementById('rep').onchange = e => { e.target.blur(); window.__mbaaRepUrl = null; if (e.target.files[0]) start(e.target.files[0]); };  // blur: keys go to the viewer
  document.body.ondragover = e => e.preventDefault();
  document.body.ondrop = e => { e.preventDefault(); window.__mbaaRepUrl = null; e.dataTransfer.files[0] && start(e.dataTransfer.files[0]); };
  controls();
  for (const key of ['boxes', 'inputs']) if (Q.get(key) === '1') { const el = document.getElementById(key); el.checked = true; el.onchange(); }
  const autoload = Q.get('rep');
  if (autoload) { window.__mbaaRepUrl = autoload; start(new File([await (await fetch(autoload)).arrayBuffer()], autoload)); }
}
main().catch(e => { console.error(e); status('error: ' + e.message); });
