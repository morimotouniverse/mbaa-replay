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
const KEY_HEX = '6d626161636377656272657061796b65792d6e6f742d612d7365637265742121';
const Q = new URLSearchParams(location.search);
const BUNDLE = Q.get('bundle') || 'bundle/';
const HASH = Q.get('hash') === '1', PERF = Q.get('perf') === '1', CAPTURE = Q.get('capture') === '1';

const hex = h => new Uint8Array(h.match(/../g).map(x => parseInt(x, 16)));
let cryptoKey;
async function openObject(buf) {
  const b = new Uint8Array(buf);
  const z = await crypto.subtle.decrypt({ name: 'AES-CTR', counter: b.slice(0, 16), length: 64 }, cryptoKey, b.slice(16));
  const s = new Blob([z]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
const net = window.mbaaNet = { objects: 0, bytes: 0 };
async function fetchObject(h) {
  const r = await fetch(`${BUNDLE}o/${h.slice(0, 2)}/${h}`);
  if (!r.ok) throw new Error(`object ${h}: HTTP ${r.status}`);
  const buf = await r.arrayBuffer();
  net.objects++; net.bytes += buf.byteLength;
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
      bytes += data.length;
      if (++done % 10 === 0 || done === n) status(`${label} ${done}/${n} (${(bytes / 1e6).toFixed(1)} MB)`);
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
  const setVol = () => { master.gain.value = Math.pow(+vol.value / 100, 2); try { localStorage.setItem('mbaaVol', vol.value); } catch (e) {} };
  try { const v = localStorage.getItem('mbaaVol'); if (v !== null) vol.value = v; } catch (e) {}
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
function audioHooks(Module) {
  ensureAudio();
  const sePath = new Map(), seBuf = new Map();
  const se = window.mbaaSeStats = { registered: 0, calls: 0, played: 0, decodeFailed: 0, ctx: () => actx.state };
  Module.mbaaSeRegister = (i, path) => { sePath.set(i, path); seBuf.delete(i); se.registered++; };
  Module.mbaaSePlay = i => {
    se.calls++;
    const path = sePath.get(i);
    if (!path || actx.state !== 'running' || HASH) return;
    let b = seBuf.get(i);
    if (!b) {
      let bytes;
      try { bytes = Module.FS.readFile(path); } catch (e) { return; }
      b = actx.decodeAudioData(bytes.slice().buffer);
      seBuf.set(i, b);
    }
    b.then(buf => { const n = actx.createBufferSource(); n.buffer = buf; n.connect(master); n.start(); se.played++; },
           () => { se.decodeFailed++; });
  };
  // BGM: one looping track (loop back to loopPos seconds at the end, as the game's stream does)
  let bgm = null, bgmPath = '';
  const bgmGain = actx.createGain();
  bgmGain.gain.value = 0.7;
  bgmGain.connect(master);
  Module.mbaaBgmStop = () => { pending = null; if (bgm) { try { bgm.stop(); } catch (e) {} bgm = null; bgmPath = ''; } };
  let pending = null;  // the BGM the game asked for while audio was still suspended
  window.__mbaaBgmResume = () => { if (pending && session && session.M === Module) { const p = pending; pending = null; Module.mbaaBgmStart(...p); } };
  Module.mbaaBgmStart = (path, loop, loopPos) => {
    if (!HASH && actx.state !== 'running') { pending = [path, loop, loopPos]; return; }
    if (HASH || path === bgmPath) return;
    Module.mbaaBgmStop();
    const dec = bgmDecode(path.replace(/^\/game\//, ''));
    if (!dec) return;
    bgmPath = path;
    dec.then(buf => {
      if (bgmPath !== path || session.M !== Module) return;
      const n = actx.createBufferSource();
      n.buffer = buf; n.loop = !!loop; n.loopStart = Math.min(loopPos, buf.duration); n.loopEnd = buf.duration;
      n.connect(bgmGain); n.start();
      bgm = n;
    }, () => {});
  };
  window.addEventListener('mbaa-session-end', () => Module.mbaaBgmStop(), { once: true });
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
  const M = await MBAA({ print: t => console.log(t), printErr: t => console.warn(t), canvas: freshCanvas() });
  const s = { M, name, rep, live: true };
  session = s;
  const FS = M.FS;
  FS.mkdir('/game');
  // files the game only checks exist (plan.probe: every stage .dat at boot) get a 1-byte placeholder; the real file
  // (the replay's stage, fetched by the plan) is written over it
  for (const p of (man.plan && man.plan.probe) || []) { mkdirs(FS, '/game/' + p); FS.writeFile('/game/' + p, new Uint8Array(1)); }
  for (const [p, d] of cache) { mkdirs(FS, '/game/' + p); FS.writeFile('/game/' + p, d); }
  FS.writeFile('/game/replay.rep', rep);
  M.mbaaAssetMiss = p => { if (man.files[p] && !cache.has(p)) misses.add(p); };
  audioHooks(M);
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
    if (call(s, 'viewer_ended')) { clearInterval(t); status(`finished ${s.name} (${call(s, 'viewer_frame')} frames)`); }
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
  document.getElementById('rep').onchange = e => e.target.files[0] && start(e.target.files[0]);
  document.body.ondragover = e => e.preventDefault();
  document.body.ondrop = e => { e.preventDefault(); e.dataTransfer.files[0] && start(e.dataTransfer.files[0]); };
  document.getElementById('pause').onclick = () => {
    if (!session) return;
    window.__paused = !window.__paused;
    call(session, 'viewer_pause', window.__paused ? 1 : 0);
  };
  document.getElementById('speed').onchange = e => session && call(session, 'viewer_speed', +e.target.value);
  const autoload = Q.get('rep');
  if (autoload) start(new File([await (await fetch(autoload)).arrayBuffer()], autoload));
}
main().catch(e => { console.error(e); status('error: ' + e.message); });
