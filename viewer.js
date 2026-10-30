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
const BUNDLE = Q.get('bundle') || (/^(live|spectate)\.meltyblood\.org$/.test(location.hostname) ? 'https://web.meltyblood.org/bundle/' : 'bundle/');
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
const KZ = Q.get('kz') !== '0';  // keyframe pages zlib-compressed (?kz=0: zero-word packing only)
const KF_BUDGET = +(Q.get('kfmb') || (LOWMEM ? 40 : 450)) * 1e6;

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
// without persistent storage a browser clears the store when it wants space (mobile Chrome, Safari): ask once; the page
// files themselves are kept by the service worker (sw.js; deployed builds only, a local build has no versioned names)
if (navigator.storage && navigator.storage.persist) navigator.storage.persisted().then(p => p || navigator.storage.persist()).catch(() => {});
if ('serviceWorker' in navigator && /^web\.meltyblood\.org$/.test(location.hostname))
  navigator.serviceWorker.register('/sw.js').catch(e => console.warn('service worker:', e));
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
  }
  return out;
}

// ---- files: fetched once per page, written into every session's MEMFS ----
const cache = new Map();  // game path -> Uint8Array
async function fetchAll(man, paths, label, quiet = false) {
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
// (the result screen's) stay.
function freeLoaded(s) {
  const probe = new Set((man.plan && man.plan.probe) || []);
  for (const p of new Set([...s.opened, ...(s.M.mbaaBootOpened || [])])) {
    if (s.freed.has(p) || /^bgm\//.test(p) || !s.want.has(p)) continue;
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
// Browsers keep an AudioContext suspended until the page gets a click or key press; a replay opened from a link has
// had neither, so the page asks for one (#sound) and starts the BGM the game already requested once audio runs.
function ensureAudio() {
  if (actx) return;
  actx = new AudioContext();
  master = actx.createGain();  // the game's mix at CE level; video export records from here
  outGain = actx.createGain();
  musicGain = actx.createGain(); musicGain.gain.value = ui.music ? 1 : 0; musicGain.connect(master);  // the BGM (music toggle)
  const vol = document.getElementById('vol');
  // 100% = CE's own level (every set already carries the game's DirectSound volume, -16.66 dB at the canonical
  // settings); the slider only attenuates below it. Default 100. Remembered under a new key: the old one stored the
  // 50% default of the full-gain era for everyone who opened the page.
  const setVol = () => { outGain.gain.value = Math.pow(+vol.value / 100, 2); try { localStorage.setItem('mbaaVolCe', vol.value); } catch (e) {} };
  vol.value = 100;
  try { const v = localStorage.getItem('mbaaVolCe'); if (v !== null) vol.value = v; } catch (e) {}
  vol.oninput = () => { setVol(); vol.style.setProperty('--p', `${vol.value}%`); document.querySelector('#mute .i').className = `i ${+vol.value ? 'i-sound' : 'i-mute'}`; };
  vol.oninput();
  master.connect(outGain); outGain.connect(actx.destination);
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
  const bgmChain = dsVoiceChain(musicGain);
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
  s.bgmLog = [];
  const log = ev => { const k = Module._viewer_frame(); if (!s.tl || k >= s.tl.simMax) s.bgmLog.push([k, ...ev]); };
  const play = (path, loop, loopPos, offset) => {
    halt();
    const o = bgmStreamReady && bgmParsed(path.replace(/^\/game\//, ''));
    if (o) {  // streamed (bgm_stream.js): a couple of seconds decoded at a time
      bgmPath = path;
      const fadeGain = actx.createGain(), lead = 0.05;
      fadeGain.connect(bgmChain.g);
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
      n.connect(n.fadeGain); n.fadeGain.connect(bgmChain.g); n.start(0, Math.max(0, off));
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

// ---- a session: one wasm instance playing one replay ----
let session = null;
const pl = { items: [], i: -1 };  // playlist: {name, file, url?} (see startItem)
let man = null;
const misses = new Set();  // bundle files the game looked up that the page had not fetched
function freshCanvas() {
  const old = document.getElementById('canvas');
  const c = old.cloneNode(false);
  old.replaceWith(c);
  return c;
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
  let bytes = 0;
  for (let i = 0; i < n; i++) { pages[i] = packPage(H, i * W, W); bytes += pages[i].bytes; }
  return { top: n * PAGE, pages, bytes };
}
function restoreBoot(s) {
  const M = s.M, snap = s.boot, W = PAGE >> 2;
  call(s, 'viewer_restore_begin');
  for (const st of M.FS.streams) if (st && st.fd > 2) { try { M.FS.close(st); } catch (e) {} }
  const top = M._viewer_mem_top(), H = new Int32Array(M.HEAPU8.buffer);
  snap.pages.forEach((q, i) => unpackPage(q, H, i * W, W));
  if (top > snap.top) M.HEAPU8.fill(0, snap.top, top);
  call(s, 'viewer_restore_end', ++s.gen);
  M._viewer_tex_store_reset();  // the last match's sealed textures (the boot ones stay)
}
async function newSession(rep, name, want) {
  const prev = session;
  if (prev) { try { prev.M.ccall('viewer_stop', null, [], []); } catch (e) {} }
  window.dispatchEvent(new Event('mbaa-session-end'));
  if (prev && prev.boot && (!HASH && !CAPTURE ? Q.get('reuse') !== '0' : Q.get('reuse') === '1')) return reuseSession(prev, rep, name, want);
  // mbaa.wasm is built with mbaa.js: it takes mbaa.js's cache-busting version (tools/web/deploy_pages.sh)
  const wasmV = ((document.querySelector('script[src^="mbaa.js"]') || {}).src || '').split('?')[1];
  const M = await MBAA({ print: t => console.log(t), printErr: t => console.warn(t), canvas: freshCanvas(),
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
    M.mbaaAssetMiss = p => { if (man.files[p] && !(s.want.has(p) && cache.has(p))) misses.add(p); };
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
  M.mbaaAssetMiss = p => { if (man.files[p] && !(s.want.has(p) && cache.has(p))) misses.add(p); };
  trackOpens(s);
  audioHooks(M, s);
  if (!HASH && !bgmStreamReady) for (const p of s.want) if (/^bgm\/.*\.opus$/.test(p) && cache.has(p)) bgmDecode(p);
  return s;
}
const call = (s, f, ...a) => s.M.ccall(f, 'number', a.map(() => 'number'), a);

// play from the start; with catchUp = k, step to frame k first (no pacing) and continue from there
async function play(rep, name, catchUp = 0, want = null) {
  misses.clear();
  const s = await newSession(rep, name, want);
  // stage animations on, except for native comparisons (?stageAnim=0, hash runs): the oracle's settings have them off
  call(s, 'viewer_stage_anim', Q.get('stageAnim') !== null ? +(Q.get('stageAnim') !== '0') : HASH ? 0 : 1);
  if (Q.get('seal') === '0') call(s, 'viewer_seal_off', 1);
  if (!call(s, 'viewer_boot')) { window.__mbaaStarted = -1; status('start failed (see console)'); return; }
  // boot textures to the GPU store first: the snapshot (and every keyframe) then holds no pixels
  if (!s.reused) s.M._viewer_seal_boot();
  if (!s.boot && (!HASH && !CAPTURE || Q.get('reuse') === '1') && !s.M._viewer_files_open()) {
    s.boot = bootSnapshot(s.M);
    s.M.mbaaBootOpened = new Set(s.opened);  // read before the snapshot: a reused instance's later matches never open them
  }
  if (!call(s, 'viewer_load')) { window.__mbaaStarted = -1; status('start failed (see console)'); return; }
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
    status(`catching up ${f}/${catchUp}`);
    await new Promise(r => setTimeout(r, 0));
    if (misses.size) return refetchAndReplay(s, f);
  }
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
    if (LOWMEM && s.freedAt < 0 && s.tl && s.tl.marks.length && !s.seeking && !call(s, 'viewer_files_open')) freeLoaded(s);
    if (call(s, 'viewer_ended') && !s.endShown) {
      s.endShown = true;
      status(`finished ${s.name} (${call(s, 'viewer_frame')} frames)`);
      if (pl.i >= 0 && pl.i + 1 < pl.items.length && !ui.paused) {  // playlist: the next match a moment later
        status(`finished ${s.name}: next up ${pl.items[pl.i + 1].name}`);
        setTimeout(() => { if (s === session && !ui.paused) startItem(pl.i + 1); }, 1200);
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
    if (s.liveSrc) liveCssWatch(s);
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
  w.postMessage({ files: [...s.want].filter(p => cache.has(p)).map(p => [p, cache.get(p)]), probe: (man.plan && man.plan.probe) || [], rep: s.rep, v });
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
    // phones: none before round 1. The intro's frames hold the match's files as the game reads them (a keyframe there
    // kept ~95 MB of them); a seek into the intro simulates from frame 0
    if (LOWMEM && !t.marks.length) return;
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
        t.incStat.dropPages.push([i * PAGE, q.r ? 'raw' : q.z ? 'z' : q.v.length]);
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
      // every raw page has been packed or copied out: a commit buffer grown by a big commit (the one after the match
      // loads copies ~60 MB) is not kept for the rest of the match
      if (t.commitBuf && t.commitBuf.length > (4 << 20)) t.commitBuf = null;
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
  if (s.liveSrc) {
    liveRefeed(s);  // (the stream received since the keyframe)
    s.M._viewer_resolve_reset();  // (the keyframe's path caches predate files added since: the next game's)
  }
  // the restored state-hash / audio row buffers hold the keyframe's leftovers
  if (HASH) { M.ccall('viewer_hash_take', 'string', [], []); M.ccall('viewer_audio_take', 'string', [], []); }
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
  if (!s.endShown) status(ui.paused ? 'paused' : 'playing');
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
  status(ui.paused ? 'paused' : 'playing');
}
// Copy the current moment: a link that opens this replay at this frame when the replay came from a URL (?rep=),
// otherwise the replay name, time and frame as text.
const REPLAY_STORE = 'https://replays.meltyblood.org';

// ---- live CCCaster matches (?live=<id>): the bridge's feed (tools/web/cc_live.mjs) played by the game in spectate
// mode (web/host/spectate.cpp): a boot tape sets the match up, then the stream's index records arrive about once a
// second and the game plays them ~4 s behind the host (faster while it catches up after joining mid-game)
const LIVE = Q.get('liveUrl') || location.origin + location.pathname.replace(/\/[^/]*$/, '');  // (the feed is next to the page)
const LIVE_BEHIND = 240;  // frames kept buffered (4 s)
let liveSrc = null;  // {id, info, since}
async function liveList() {
  const r = await fetch(`${LIVE}/live/list`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function startLive(id) {
  let info;
  try { info = (await liveList()).find(m => m.id === id); } catch (e) { status(`live feed unreachable: ${e.message}`); return; }
  if (!info) { status('that match is not live any more'); return; }
  liveSrc = { id, info, since: info.game };
  const r = await fetch(`${LIVE}/live/${id}/boot.rep?game=${info.game}`, { cache: 'no-store' });
  if (!r.ok) { status(`live match: HTTP ${r.status}`); return; }
  window.__mbaaRepUrl = null;
  await start(new File([await r.arrayBuffer()], `LIVE ${info.names.map(n => n.trim()).join(' vs ')}`));
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
async function liveCatchUp(s, n) {
  const M = s.M, T = M._viewer_frame() + n, DRAW = 2;
  s.seeking = true; s.mute = true;
  s.stopSes(); s.bgmHalt();
  uiApply(s);
  call(s, 'viewer_suppress', 1);
  let f = M._viewer_frame();
  while (f < T - DRAW) {
    const g = call(s, 'viewer_step', Math.min(T - DRAW - f, 600));
    if (g === f) break;
    f = g;
    status(`live: catching up (${((T - f) / 60).toFixed(0)} s to go)`);
    await new Promise(r => setTimeout(r, 0));
    if (session !== s) return;
  }
  call(s, 'viewer_suppress', 0);
  if (f < T) call(s, 'viewer_step', T - f);
  else call(s, 'viewer_represent');
  s.seeking = false; s.mute = ui.paused;
  uiApply(s);
  if (!ui.paused) s.bgmSync(M._viewer_frame());
}
// the panel's "live now" list (refreshed every 15 s; hidden while nothing is live or the feed is unreachable)
async function liveListShow() {
  const sec = document.getElementById('livesec'), ol = document.getElementById('liveitems');
  let l = [];
  try { l = await liveList(); } catch (e) {}
  sec.hidden = !l.length;
  ol.replaceChildren(...l.map(m => {
    const li = document.createElement('li'), a = document.createElement('a');
    a.href = `${location.pathname}?live=${m.id}` +  // (the page's <base> is the site root on the live path) (Q.get('liveUrl') ? `&liveUrl=${encodeURIComponent(Q.get('liveUrl'))}` : '');
    a.textContent = m.matchup || m.names.map(n => n.trim()).join(' vs ');
    if (liveSrc && liveSrc.id === m.id) li.className = 'cur';
    li.append(a);
    return li;
  }));
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
// check's data/<chara>_<moon>.txt (it only stats them, but a missing one changes which moons are offered), its BGM)
function liveCssFiles(man) {
  const out = new Set();
  for (const p of Object.keys(man.files))
    if (/^(grp\/c_sel_aa|grp\/bgselect|data\/_csel)\//.test(p) || /^data\/[^/]+_\d\.txt$/.test(p) || /^bgm\/bgmme99\./.test(p)) out.add(p);
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
  if (g(0x54EEE8) !== CSS_SCENE) { if (s.cssHeld) liveCssHold(s, false); s.cssKey = null; return; }
  const done = g(CSS_OBJ + 0x3C) >= 4, known = c => !!man.plan.chara[`${c}`];
  const sides = [0, 1].map(p => {
    const st = g(CSS_SLOT + p * 0x24 + 4), c = g(CSS_SLOT + p * 0x24 + 0x14), m = g(CSS_SLOT + p * 0x24 + 0x18);
    if (st >= 1 && known(c)) return [c, st >= 2 || done ? Math.max(0, m) : null];
    // Random (99): the battle slot's copy, once the select is finished (its moon is copied a frame after the chara)
    return done && known(g(BATTLE_SLOT + p * 0x2C + 8)) ? [g(BATTLE_SLOT + p * 0x2C + 8), Math.max(0, g(BATTLE_SLOT + p * 0x2C + 0x14))] : null;
  });
  const stage = done ? g(STAGE_ID) : null, key = JSON.stringify([stage, sides]);
  if (key !== s.cssKey) {
    s.cssKey = key;
    const want = new Set();
    for (const [i, side] of sides.entries()) {
      if (!side) continue;
      const k = { stage: null, p1: null, p2: null };
      k[i ? 'p2' : 'p1'] = side[1] === null ? null : side;
      if (side[1] === null) for (const f of man.plan.chara[`${side[0]}`]) want.add(f);  // the moon is not picked yet
      else for (const f of planFiles(man, k)) want.add(f);
    }
    if (stage !== null) for (const f of planFiles(man, { stage, p1: null, p2: null })) want.add(f);
    s.cssNeed = [...withSiblings(man, want)].filter(p => !s.want.has(p));
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
  const ready = s.cssNeed.every(p => s.want.has(p));
  if (done && !ready !== !!s.cssHeld) liveCssHold(s, !ready);
}
function liveCssHold(s, on) {
  s.cssHeld = on;
  call(s, 'viewer_live_hold', on ? 1 : 0);
  if (on) status('live: loading the next game');
}
// fetched files into MEMFS (a stage .dat over its placeholder) and the want list (no miss for them)
function liveInstall(s, paths) {
  let n = 0;
  for (const p of paths) {
    const d = cache.get(p);
    if (!d || s.want.has(p)) continue;
    fsPut(s.M.FS, '/game/' + p, d); s.want.add(p); n++;
    if (!HASH && !bgmStreamReady && /^bgm\/.*\.opus$/.test(p)) bgmDecode(p);
  }
  if (n) s.M._viewer_resolve_reset();  // (directory listings cached without them)
  if (s.cssHeld && s.cssNeed.every(p => s.want.has(p))) liveCssHold(s, false);
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
  document.getElementById('livebtn').classList.toggle('on', on);
}
async function liveGoLive() {
  const s = session;
  if (!s || !s.liveSrc) return;
  if (s.liveSrc.next) return startLive(s.liveSrc.id);  // the game being watched is over: the current one
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
  L.since = L.info.game;
  L.recs = new Map();
  L.next = false;
  liveFollow(s, true);
  call(s, 'viewer_spectate_open', L.info.rollback, L.info.winCount);
  const poll = async () => {
    if (session !== s) return;
    try {
      const r = await fetch(`${LIVE}/live/${L.id}/rec?from=${L.info.game}&since=${L.since}`, { cache: 'no-store' });
      if (r.ok) {
        const b = new Uint8Array(await r.arrayBuffer());
        if (b.length && session === s) {
          liveKeep(L, b);
          liveFeed(s, b);
          L.since = liveLastIndex(b);
        }
      }
    } catch (e) { console.warn('live feed:', e); }
    if (session !== s) return;
    let ahead = call(s, 'viewer_spectate_buffered');
    if (s.tl && !s.seeking) s.tl.est = s.M._viewer_frame() + ahead;  // the timeline reaches the newest frame received
    if (call(s, 'viewer_ended') || L.next) {  // the game is over: the match's next game (or the list, if it ended)
      try {
        const now = (await liveList()).find(m => m.id === L.id);
        if (!now) { status('the match has ended'); return; }
        if (now.game !== L.info.game) {
          if (s.liveFollow) return startLive(L.id);
          L.next = true;  // (DVR: stays on this game; LIVE goes to the current one)
          status('live: watching back; the next game is on (LIVE to join it)');
        }
      } catch (e) {}
    } else if (s.liveFollow) {
      // pace as CCCaster's spectator: at the join (the stream starts at the game's start) jump to LIVE_BEHIND frames
      // behind the newest frame received, unrendered as a seek ("jump to live" off: no jump); from then on normal speed,
      // stalling only when the stream runs dry (until 2 s are buffered again)
      if (!s.liveSynced && ahead > 0) {
        s.liveSynced = true;
        // (the stream grows while the jump runs: again until it is close)
        for (let k = 0; k < 4 && liveJump() && ahead > LIVE_BEHIND + 90 && !s.seeking; ++k) {
          await liveCatchUp(s, ahead - LIVE_BEHIND);
          if (session !== s) return;
          ahead = call(s, 'viewer_spectate_buffered');
        }
      }
      // the link card's picture (tools/web/cc_live.mjs): this frame, now and every 2 minutes
      if (s.liveSynced && !hidden() && performance.now() - (s.liveThumbAt || -1e9) > 120000) {
        s.liveThumbAt = performance.now();
        grabCard().jpeg.then(b => b && fetch(`${LIVE}/live/${L.id}/thumb`, { method: 'POST', body: b }).catch(() => {}));
      }
      const hold = ahead < 15 || (s.liveHeld && ahead < 120);
      s.liveHeld = hold;
      call(s, 'viewer_pause', hold || ui.paused || s.seeking ? 1 : 0);
      // CCCaster's spectateFastFwd: more than 60 frames (2 x NUM_INPUTS) behind, every other frame is not drawn
      // (CC_SKIP_FRAMES) until caught up; here, over the kept buffer: two game frames per drawn frame
      const ff = !hold && ahead > LIVE_BEHIND + 60;
      if (ff !== !!s.liveFF) { s.liveFF = ff; call(s, 'viewer_speed', ff ? 2 : ui.speed); }
      if (s.cssHeld) status('live: loading the next game');
      else status(hold ? `live: waiting for the stream (${(ahead / 60).toFixed(1)} s buffered)`
                  : `live: ${(ahead / 60).toFixed(1)} s behind the players` + (ff ? ' (catching up)' : ''));
    } else if (!s.seeking) {
      status(`live: watching back, ${(ahead / 60).toFixed(0)} s behind (LIVE to catch up)`);
    }
    setTimeout(poll, 1000);
  };
  poll();
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
function grabCard() {
  const jpeg = new Promise(res => {
    try {
      const c = document.createElement('canvas'); c.width = 960; c.height = 480;
      const g = c.getContext('2d'); g.fillStyle = '#12111c'; g.fillRect(0, 0, 960, 480);
      g.imageSmoothingEnabled = false; g.drawImage(document.getElementById('canvas'), 160, 0, 640, 480);
      c.toBlob(res, 'image/jpeg', 0.88);
    } catch (e) { res(null); }
  });
  return { jpeg };
}
async function copyTimestamp() {
  const s = session;
  if (!s) return;
  if (s.liveSrc) { status('links to a moment of a live match: not yet (E saves the clip as a video)'); return; }
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
window.mbaaViewer = { startItem: i => startItem(i), seek: requestSeek, step: stepBy, pause: setPaused, frame: () => session.M._viewer_frame(),
                      tl: () => session.tl, ui, pl, cacheSize: () => cache.size, cacheMap: () => cache, phone: PHONE, lowmem: LOWMEM, bgmStream: () => bgmStreamReady, audioState: () => [actx && actx.state, session && session.mute, session && session.bgmLog && session.bgmLog.length, ui.paused], bgmMap: () => bgmDecoded, clip: () => session && session.clip,
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
    clipTick(s, f);
    if (rec) { try { recTick(s, f); } catch (e) { recFail(e); } }
    const seek = document.getElementById('seek');
    if (+seek.max !== max) seek.max = max;
    if (!seekDragging) seek.value = t.want !== null ? t.want : f;
    document.getElementById('time').textContent = fmtTime(f);
    document.getElementById('dur').textContent = `/ ${fmtTime(max)}${t.end === null ? '+' : ''}`;
    document.getElementById('fc').textContent = `frame ${f}`;
    seek.style.setProperty('--p', `${(100 * seek.value / Math.max(1, max)).toFixed(2)}%`);
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
  const cv = document.getElementById('marks'), dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(cv.clientWidth * dpr); cv.height = Math.round(cv.clientHeight * dpr);
  const g = cv.getContext('2d');
  g.clearRect(0, 0, cv.width, cv.height);
  g.fillStyle = '#2c3350';
  g.fillRect(0, 0, cv.width * Math.min(1, t.simMax / max), cv.height);
  if (c) { g.fillStyle = 'rgba(80, 200, 255, 0.45)'; g.fillRect(cv.width * c.a / max, 0, Math.max(2, cv.width * (c.b - c.a) / max), cv.height); }
  g.fillStyle = '#ffcc40'; g.font = `${Math.round(10 * dpr)}px system-ui, sans-serif`; g.textBaseline = 'top';
  for (const [f, r] of t.marks) {
    const x = Math.round(cv.width * f / max);
    g.fillRect(x, 0, Math.max(1, dpr), cv.height);
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
  const sc = document.getElementById('scale');
  sc.value = scaleMode;
  sc.onchange = () => { scaleMode = sc.value; try { localStorage.setItem('mbaaScale', scaleMode); } catch (e) {} fitStage(); sc.blur(); };
  btn('full', toggleFullscreen);
  document.getElementById('marks').addEventListener('click', e => {
    const s = session;
    if (!s || !s.tl) return;
    const r = e.currentTarget.getBoundingClientRect(), max = tlMax(s.tl), x = (e.clientX - r.left) / r.width * max;
    let best = null;
    for (const [f] of s.tl.marks) if (best === null || Math.abs(f - x) < Math.abs(best - x)) best = f;
    if (best !== null && Math.abs(best - x) / max < 0.04) requestSeek(best); else requestSeek(Math.round(x));
  });
  btn('prevr', () => jumpRound(-1)); btn('nextr', () => jumpRound(1));
  btn('clipa', () => setClip('a')); btn('clipb', () => setClip('b')); btn('clipx', clearClip); btn('cliploop', toggleLoop); btn('clipexp', exportVideo);
  btn('helpb', toggleHelp); btn('mute', toggleMute);
  document.getElementById('help').onclick = toggleHelp;
  btn('plprev', () => startItem(pl.i - 1)); btn('plnext', () => startItem(pl.i + 1)); btn('plshare', copyPlaylist);
  btn('plclear', () => { const cur = pl.items[pl.i]; pl.items = cur ? [cur] : []; pl.i = cur ? 0 : -1; renderPlaylist(); });
  // a click / tap on the picture: during the VS screen it skips it (as a button press does in the game), otherwise
  // it pauses / plays
  document.getElementById('overlay').parentElement.addEventListener('pointerdown', e => {
    if (e.button > 0 || !session) return;
    if (actx && actx.state !== 'running') return;  // this click only turns sound on (the page-wide unlock handles it)
    togglePlay();
  });
  const si = document.getElementById('skipintro');
  si.checked = ui.skipIntro;
  si.onchange = () => { ui.skipIntro = si.checked; try { localStorage.setItem('mbaaSkipIntro', si.checked ? '1' : '0'); } catch (e) {} si.blur(); };
  btn('back5', () => stepBy(-300, false)); btn('back1', () => stepBy(-1)); btn('fwd1', () => stepBy(1)); btn('fwd5', () => stepBy(300, false));
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
    if (k === ' ') togglePlay();
    else if (k === ',' || k === '<') stepBy(-1);
    else if (k === '.' || k === '>') stepBy(1);
    else if (k === 'ArrowLeft') stepBy(-sec, false);
    else if (k === 'ArrowRight') stepBy(sec, false);
    else if (k === 'Home') requestSeek(1);
    else if (k === 'End' && session && session.tl) requestSeek(tlMax(session.tl));
    else if (k === 'c' || k === 'C') copyTimestamp();
    else if (k === 'f' || k === 'F') toggleFullscreen();
    else if (k === '[' || k === 'PageUp') jumpRound(-1);
    else if (k === ']' || k === 'PageDown') jumpRound(1);
    else if (k === '{') setClip('a');
    else if (k === '}') setClip('b');
    else if (k === 'Escape') { if (fx) fx.cancel = true; else if (rec) stopRecording(false); else if (!document.getElementById('help').hidden) toggleHelp(); else clearClip(); }
    else if (k === 'l' || k === 'L') toggleLoop();
    else if (k === 'e' || k === 'E') exportVideo();
    else if (k === 'm' || k === 'M') toggleMute();
    else if (k === 'u' || k === 'U') flip('hud');
    else if (k === 'b' || k === 'B') flip('music');
    else if (k === '?') toggleHelp();
    else if (k === 'n' || k === 'N') startItem(pl.i + 1);
    else if (k === 'p' || k === 'P') startItem(pl.i - 1);
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

// the files a replay needs (the plan), or everything the page has when the bundle has no plan
function wantFor(rep) {
  if (!man.plan) return null;
  let want = planFiles(man, repKeys(rep));
  // ?planDrop=REGEX (test): leave matching files out of the plan, to exercise the miss -> fetch -> catch-up path
  if (Q.get('planDrop')) { const re = new RegExp(Q.get('planDrop')); want = new Set([...want].filter(f => !re.test(f))); }
  return want;
}
async function start(file) {
  ensureAudio(); actx.resume();  // a drop or file pick is a user gesture: audio may start
  const rep = new Uint8Array(await file.arrayBuffer());
  let keys, want;
  try { keys = repKeys(rep); want = wantFor(rep); } catch (e) { status('error: ' + e.message); return; }
  if (want && liveSrc) for (const p of liveCssFiles(man)) want.add(p);
  if (want) {
    status(`stage ${keys.stage}, P1 ${keys.p1[0]}:${keys.p1[1]} vs P2 ${keys.p2[0]}:${keys.p2[1]}: fetching`);
    await fetchAll(man, want, 'match assets');
  }
  window.__mbaaKeys = keys;
  const [, when] = repLabel(file.name);
  document.getElementById('title').textContent = matchTitle(rep) + (when ? ` \u00b7 ${when}` : '');
  const next = pl.items[pl.i + 1];
  await play(rep, file.name, 0, want);
  if (want && next) prefetch(next, want);
  else if (want) for (const p of [...cache.keys()]) if (!want.has(p)) cache.delete(p);  // the last match: the previous one's files go
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
function renderPlaylist() {
  const many = pl.items.length > 1;
  for (const id of ['plshare', 'plprev', 'plnext', 'plclear']) document.getElementById(id).hidden = !many;
  document.getElementById('plpos').textContent = pl.items.length ? `${pl.i + 1 || '\u2013'} / ${pl.items.length}` : '';
  const ol = document.getElementById('plitems');
  let dragFrom = -1;
  ol.replaceChildren(...pl.items.map((it, k) => {
    const li = document.createElement('li'), [nm, when] = repLabel(it.name);
    li.title = it.name; li.className = k === pl.i ? 'cur' : ''; li.draggable = true;
    const a = document.createElement('span'); a.className = 'nm'; a.textContent = nm;
    const d = document.createElement('span'); d.className = 'dt'; d.textContent = when;
    const x = document.createElement('button'); x.title = 'remove from the queue'; x.innerHTML = '<i class="i i-x"></i>';
    x.onclick = e => { e.stopPropagation(); removeItem(k); };
    li.append(a, d, x);
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
function toggleHelp() { const h = document.getElementById('help'); h.hidden = !h.hidden; }
function clearClip() { if (session && session.clip) { session.clip = null; marksKey = ''; status('playing'); } }
// a clip being played stops at its out point; play again from there starts it over
function clipTick(s, f) {
  const c = s.clip;
  if (!c || rec || fx || ui.paused || s.seeking || (s.tl && s.tl.running)) return;
  if (c.round && s.tl) {  // a looped round ends where the next one starts, once the pre-scan has found it
    const next = s.tl.marks.find(x => x[0] > c.a), b = next ? next[0] - 1 : tlMax(s.tl);
    if (b !== c.b) { c.b = b; marksKey = ''; }
  }
  if (loopOn && f >= c.b) { requestSeek(c.a); return; }
  if (!c.stop) return;
  if (f >= c.b) { setPaused(true); if (f > c.b) requestSeek(c.b); status(`clip end (${fmtTime(c.a)} – ${fmtTime(c.b)}): Space plays it again`); }
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
  ensureAudio(); await actx.resume();
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
      if (ui.boxes || ui.inputs) { drawOverlay(); g.drawImage(ov, 0, 0, EXPORT_W, EXPORT_H); }
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
  if (ui.boxes || ui.inputs) r.g.drawImage(document.getElementById('overlay'), 0, 0, 1280, 960);
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
function fitStage() {
  const dpr = window.devicePixelRatio || 1, stage = document.querySelector('.stage'), ctl = document.getElementById('controls');
  const full = document.fullscreenElement === stage;
  const W = full ? screen.width : document.documentElement.clientWidth - 32;
  const H = full ? screen.height : window.innerHeight - 16;
  // controls below the picture take their stacked height; beside it, SIDE_W of width. Pick the layout with the larger picture.
  document.body.classList.remove('side');
  const below = full ? 0 : (ctl ? ctl.offsetHeight + 8 : 0);
  const kSide = Math.floor(Math.min((W - SIDE_W) * dpr / 640, H * dpr / 480));
  const kBelow = Math.floor(Math.min(W * dpr / 640, (H - below) * dpr / 480));
  const side = !full && kSide >= kBelow && W - SIDE_W >= 320;
  document.body.classList.toggle('side', side);
  let w, label;
  if (scaleMode === 'fit') { w = side ? Math.min(W - SIDE_W, H * 4 / 3) : Math.min(W, (H - below) * 4 / 3); label = 'fit'; }
  else if (/^\d$/.test(scaleMode)) { w = 640 * +scaleMode / dpr; label = `${scaleMode}x`; }
  else {
    // high-density screens (phones): a game pixel is already 2+ device pixels, uneven rows are invisible there, and a
    // whole multiple would leave a small picture: fit the width instead
    const k = dpr >= 2 && !full ? 0 : side ? kSide : kBelow;
    w = k >= 1 ? 640 * k / dpr : Math.min(W, 960); label = k >= 1 ? `${k}x` : 'fit';
  }
  document.documentElement.style.setProperty('--w', `${Math.floor(w * 1000) / 1000}px`);
  if (stage) stage.dataset.scale = label;
}
addEventListener('resize', fitStage);
document.addEventListener('fullscreenchange', fitStage);
function toggleFullscreen() {
  const stage = document.querySelector('.stage');
  if (document.fullscreenElement) document.exitFullscreen(); else stage.requestFullscreen().catch(() => {});
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
  } else {
    cryptoKey = await crypto.subtle.importKey('raw', hex(KEY_HEX), 'AES-CTR', false, ['decrypt']);
    status('loading manifest…');
    const r = await fetch(BUNDLE + 'manifest.bin');
    net.bytes += +(r.headers.get('content-length') || 0);
    man = JSON.parse(new TextDecoder().decode(await openObject(await r.arrayBuffer())));
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
  controls();
  for (const key of ['boxes', 'inputs']) if (Q.get(key) === '1') { const el = document.getElementById(key); el.checked = true; el.onchange(); }
  // ?r=<id>: a shared replay in the replay store (tools/web/replay_worker.js); ?rep=<url>: any replay URL
  const rq = Q.get('r') || '';
  const autoload = /^[0-9a-f]{64}$/.test(rq) ? `${REPLAY_STORE}/rep/${rq}.rep`  // links from before short ids
                 : /^[A-Za-z0-9_-]{8,43}$/.test(rq) ? `${REPLAY_STORE}/s/${rq}` : Q.get('rep');
  liveJumpInit();
  liveListShow();
  if (Q.get('live')) {  // spectating: the live controls; no replay queue, no skip-intro
    document.getElementById('plsec').hidden = true;
    document.getElementById('skipintro').closest('label').hidden = true;
    document.getElementById('livebtn').hidden = false;
    document.getElementById('livebtn').onclick = e => { e.target.blur(); liveGoLive(); };
  }
  if (/^[A-Za-z0-9_]{4,64}$/.test(Q.get('live') || '')) return startLive(Q.get('live'));  // a live CCCaster match
  const lq = Q.get('l') || '';
  if (/^[A-Za-z0-9_-]{8,43}$/.test(lq)) {  // a shared playlist
    try {
      const r = await fetch(`${REPLAY_STORE}/l/${lq}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      pl.items = (await r.json()).items.map(it => ({ id: it.id, name: it.name, url: `${REPLAY_STORE}/s/${it.id}` }));
      return startItem(Math.min(pl.items.length, Math.max(1, +(Q.get('i') || 1))) - 1);
    } catch (e) { status(`could not load the playlist: ${e.message}`); return; }
  }
  if (autoload) { window.__mbaaRepUrl = autoload; start(new File([await (await fetch(autoload)).arrayBuffer()], autoload)); }
}
main().catch(e => { console.error(e); status('error: ' + e.message); });
