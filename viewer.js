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
//   ?perf=pace         frame pacing record (per rAF tick: time, sim ms, steps); window.__mbaaPerf() returns it
//                      (tools/web_parity/browser_perf.py; was ?perf=1)
//   ?perf=1            the frame profiler (opt-in; harness-design/stage3d_perf/PROFILING.md): ~10 s of per-frame timings,
//                      then a summary to download or send; ?perf=hud an on-screen readout
//   ?spector=1         local pages only (127.0.0.1 / localhost): Spector.js WebGL capture (/__spector/, a dev server route)
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
// a page's first-load steps (performance.now(), the first time each is reached): window.__mbaaBoot (the join-time checks,
// artifacts/xz_check/perf_plan/snapjoin goal D)
const bootMarks = window.__mbaaBoot = {};
const bootMark = k => { if (bootMarks[k] == null) bootMarks[k] = Math.round(performance.now()); };
// ---- name styles: one system (user 2026-11-04: "the nico text gradient animated the same way as in the chat") ----
// The stylers' look (the bot's spec: glow, a 2-3 colour gradient, ~wave~, shadow) is parsed here once and its motion
// computed here once, for every place it is drawn: the chat column (chat.js styleApply: CSS custom properties and the
// ogslide / owave animations), the picture's comments (overlay_gl: the gradient's colours, period and phase as shader
// uniforms, the ~wave~ per quad; the same numbers from chat.js glovStyle) and the 2D clip chat (clipChatDraw, also in
// the MP4 export). The motion:
//   gradient  the chat's linear-gradient(90deg, c0, c1[, c2], c0) at 200% of the text's width, its background-position
//             0 -> 200% over the period 16 / speed s, linear: the colour at place u (0..1 across the text) at time t
//             is the cycle's at fract(u / 2 + t / period) (gradAt); half the cycle shows at a time
//   ~wave~    letter i: translateY from +a to -a over the half period 2.2 - 0.18 * speed s, ease-in-out, alternate,
//             i * 0.6 rad ahead (waveY; overlay_gl waveY is the same curve)
//   glow      a still halo (no pulse in the chat either: text-shadow r and 2r)
// One clock (now(), seconds): performance.now() / 1000, the CSS animations' document timeline (lock(): each style
// animation's startTime 0, so a line made at any moment is in phase with every other and with the renderer, whose wall
// clock is the same performance.now()); a clip page (chat.js clip mode) puts it on the picture's time (picClock): the
// renderer's wall clock pinned to it (viewer_ov_wall_pin) and the column's animations held at it (tick), so a pause
// holds both and a seek moves both; the MP4 export pins the renderer to the video's own frame time (deterministic).
window.mbaaNameFx = (() => {
  const clampI = (v, a, b) => Math.max(a, Math.min(b, Math.round(+v || 0)));
  // the bot's canonical spec ("glow=rrggbb.<1-12>,grad=rrggbb-rrggbb[-rrggbb].<1-10>,wave=<1-10>.<1-10>,
  // shadow=rrggbb.<1-4>.<o|d>", parts optional) -> {glow: {c, r}, grad: {cs, s}, wave: {a, s}, shadow: {c, s, k}};
  // null if any part is off (the bot's styleCanon rules, tools/chat/meltybot.mjs)
  function parse(spec) {
    const t = String(spec || '').toLowerCase(), out = {};
    if (!t) return out;
    if (t.length > 120) return null;
    for (const part of t.split(',')) {
      let mm;
      if ((mm = /^glow=([0-9a-f]{6})\.(\d{1,2})$/.exec(part))) out.glow = { c: `#${mm[1]}`, r: clampI(mm[2], 1, 12) };
      else if ((mm = /^grad=([0-9a-f]{6})-([0-9a-f]{6})(?:-([0-9a-f]{6}))?\.(\d{1,2})$/.exec(part))) out.grad = { cs: [mm[1], mm[2], mm[3]].filter(Boolean).map(c => `#${c}`), s: clampI(mm[4], 1, 10) };
      else if ((mm = /^wave=(\d{1,2})\.(\d{1,2})$/.exec(part))) out.wave = { a: clampI(mm[1], 1, 10), s: clampI(mm[2], 1, 10) };
      else if ((mm = /^shadow=([0-9a-f]{6})\.(\d{1,2})\.([od])$/.exec(part))) out.shadow = { c: `#${mm[1]}`, s: clampI(mm[2], 1, 4), k: mm[3] };
      else if (part === 'font=kiwi') out.font = 'kiwi';  // (the name in KiwiSoda: the site owner's alone, the bot decides; user 2026-11-08)
      else return null;
    }
    return out;
  }
  const spec = st => [st.glow && `glow=${st.glow.c.slice(1)}.${st.glow.r}`, st.grad && `grad=${st.grad.cs.map(c => c.slice(1)).join('-')}.${st.grad.s}`,
    st.wave && `wave=${st.wave.a}.${st.wave.s}`, st.shadow && `shadow=${st.shadow.c.slice(1)}.${st.shadow.s}.${st.shadow.k}`, st.font === 'kiwi' && 'font=kiwi'].filter(Boolean).join(',');
  // the motion's numbers: the gradient's period (s); the wave's amplitude (px at the chat's font size), half period (s)
  // and phase a letter (rad); a style without a wave part waves at the default
  const gradPeriod = st => 16 / st.grad.s;
  const WAVE_STEP = 0.6;
  const waveOf = st => { const w = st.wave || { a: 4, s: 5 }; return { a: w.a, dur: 2.2 - w.s * 0.18, step: WAVE_STEP }; };
  // the chat's CSS gradient image (one cycle: the first colour again at its end)
  const gradCss = st => `linear-gradient(90deg, ${[...st.grad.cs, st.grad.cs[0]].join(', ')})`;
  // the clock
  let pic = null;
  const now = () => { const t = pic ? pic() : null; return t != null && Number.isFinite(t) ? t : performance.now() / 1000; };
  const gradPhase = (st, t) => { const p = t / gradPeriod(st); return p - Math.floor(p); };
  const rgb = c => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
  // the colour [r, g, b] at place u across the text at time t (the shader's, overlay_gl / SHADER_GRAD below)
  function gradAt(st, u, t) {
    const cs = st.grad.cs, n = cs.length, v = Math.min(1, Math.max(0, u)) * 0.5 + gradPhase(st, t);
    const s = (v - Math.floor(v)) * n, i = Math.floor(s), f = s - i, a = rgb(cs[i % n]), b = rgb(cs[(i + 1) % n]);
    return a.map((x, k) => Math.round(x + (b[k] - x) * f));
  }
  // the gradient over [0, 1] at t as stops [u, '#rrggbb'] (a canvas gradient: the cycle's colours where they fall)
  function gradStops(st, t) {
    const n = st.grad.cs.length, p = gradPhase(st, t), out = [[0, gradAt(st, 0, t)]];
    for (let k = 1; k <= 2 * n; k++) { const u = (k / n - p) * 2; if (u > 0 && u < 1) out.push([u, gradAt(st, u, t)]); }
    out.push([1, gradAt(st, 1, t)]);
    return out.map(([u, c]) => [u, `rgb(${c.join(',')})`]);
  }
  // CSS ease-in-out (cubic-bezier(.42, 0, .58, 1)) and the ~wave~ letter i's offset at t, in amplitudes (+ down)
  function ease(x) {
    let s = x;
    for (let k = 0; k < 6; k++) {
      const bx = 3 * (1 - s) * (1 - s) * s * 0.42 + 3 * (1 - s) * s * s * 0.58 + s * s * s;
      const d = 3 * (1 - s) * (1 - s) * 0.42 + 6 * (1 - s) * s * 0.16 + 3 * s * s * 0.42;
      if (Math.abs(d) < 1e-5) break;
      s = Math.min(1, Math.max(0, s - (bx - x) / d));
    }
    return s * s * (3 - 2 * s);
  }
  function waveY(st, i, t) {
    const w = waveOf(st), u = ((t + i * w.step / Math.PI * w.dur) / w.dur) % 2, uu = u < 0 ? u + 2 : u;
    return 1 - 2 * ease(uu < 1 ? uu : 2 - uu);
  }
  // ---- the chat column's CSS animations on the clock ----
  const ANIMS = new Set(['ogslide', 'owave']);
  let held = [];  // (on the picture's clock: the animations held at it, tick())
  function lock(root) {
    if (!root || !root.getAnimations) return;
    let as;
    try { as = root.getAnimations({ subtree: true }).filter(a => ANIMS.has(a.animationName)); } catch (e) { return; }
    if (pic) { held = as; tick(true); return; }
    for (const a of as) if (a.startTime !== 0) { try { a.startTime = 0; } catch (e) {} }
  }
  let lockRoot = null, lockRaf = 0;
  // (batched: every styled element made this frame, after it is in the page)
  function lockSoon(root) {
    if (root) lockRoot = root;
    if (!lockRaf) lockRaf = requestAnimationFrame(() => { lockRaf = 0; lock(lockRoot); });
  }
  let heldT = NaN;
  function tick(force) {
    const t = now();
    if (!force && t === heldT) return;
    heldT = t;
    for (const a of held) { try { if (a.playState !== 'paused') a.pause(); a.currentTime = t * 1000; } catch (e) {} }
  }
  // the picture's clock (a function giving seconds, or null for performance.now())
  function picClock(fn) { pic = fn || null; heldT = NaN; if (!pic) { for (const a of held) { try { a.play(); a.startTime = 0; } catch (e) {} } held = []; } }
  // ---- the picture's gradient (overlay_gl's fragment shader) ----
  // The renderer already sends each gradient slot's phase now, fract(wall / period) (u_g[s * 3 + 1].w; wall: pinned or
  // performance.now() / 1000), but the mbaa.wasm of 2026-11-02 to 11-04 drew the colours still across the string. Its
  // shader is rewritten here as the renderer compiles it, to the chat's sliding cycle (gradAt); a renderer that already
  // draws it so (overlay_gl.cpp from nico-grad on) does not match and is left alone.
  const SHADER_OLD = /float f = clamp\(v_gx, 0\.0, 1\.0\) \* \(A\.w - 1\.0\), t = fract\(f\);[\s\S]*?fill = A\.w > 2\.5 \? mix\(a, b, f >= 2\.0 \? 1\.0 : t\) : mix\(A\.rgb, B\.rgb, clamp\(f, 0\.0, 1\.0\)\);/;
  const SHADER_GRAD = 'float n = A.w, s = fract(clamp(v_gx, 0.0, 1.0) * 0.5 + B.w) * n, t = fract(s);' +
    ' vec3 a = s < 1.0 ? A.rgb : s < 2.0 ? B.rgb : C.rgb;' +
    ' vec3 b = s < 1.0 ? B.rgb : s < 2.0 && n > 2.5 ? C.rgb : A.rgb;' +
    ' fill = mix(a, b, t);';
  let patched = 0;
  const G2 = window.WebGL2RenderingContext;
  if (G2 && G2.prototype.shaderSource && Q.get('nicograd') !== 'still') {
    const orig = G2.prototype.shaderSource;
    G2.prototype.shaderSource = function (sh, src) {
      if (typeof src === 'string' && src.includes('uniform vec4 u_g[') && SHADER_OLD.test(src)) { src = src.replace(SHADER_OLD, SHADER_GRAD); patched++; }
      return orig.call(this, sh, src);
    };
  }
  return { parse, spec, clampI, gradPeriod, gradCss, gradPhase, gradAt, gradStops, waveOf, waveY, now, lock, lockSoon, tick, picClock,
    patched: () => patched };
})();
// the private live-spectate test copy (live.meltyblood.org/<secret>/, tools/web/cc_live.mjs) loads the public bundle
const BUNDLE = Q.get('bundle') || (/^(live|spectate)\.meltyblood\.org$/.test(location.hostname) ? 'https://watch.meltyblood.org/bundle/' : 'bundle/');
const HASH = Q.get('hash') === '1', PERF = Q.get('perf') === 'pace', CAPTURE = Q.get('capture') === '1';
// ?spector=1 (local test pages only, never the public site: the library is not in the site build; the local dev servers
// serve it at /__spector/ from tools/stage3d/vendor/spector): Spector.js spies every canvas made after it loads, so the
// engine waits for it (SPECTOR_P) before its first context. window.__mbaaSpector (tools/stage3d/phone/spector_capture.py)
const SPECTOR_P = Q.get('spector') === '1' && /^(127\.0\.0\.1|localhost|\[::1\])$/.test(location.hostname) ? new Promise(res => {
  const sc = document.createElement('script');
  sc.src = '/__spector/spector.bundle.js';
  sc.onload = () => {
    try { const sp = window.__mbaaSpector = new SPECTOR.Spector(); sp.spyCanvases(); if (Q.get('spectorui') === '1') sp.displayUI(); }
    catch (e) { console.warn('spector:', e); }
    res();
  };
  sc.onerror = () => { console.warn('spector: /__spector/ is not served here'); res(); };
  document.head.append(sc);
}) : null;
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
// (low memory: beyond the newest keyframe's own textures, kfTexBytes)
const KF_TEX_BUDGET = +(Q.get('kftexmb') || (LOWMEM ? 32 : 256)) * 1e6;
const STORE_GC = Q.get('storegc') !== '0';  // texture store eviction (storeGc; ?storegc=0: off, every sealed texture kept for the match)

const hex = h => new Uint8Array(h.match(/../g).map(x => parseInt(x, 16)));
let cryptoKey;
// z = 'xz' (manifest entry; tools/web/bundle_xz.py): the large files, a third smaller than deflate; everything else
// deflate. A pool of web/shell/xz_worker.js decodes them off this thread and in parallel: decodeObject hands a worker an
// object as stored (it decrypts and inflates / xz-decodes it), xzDecode a decrypted xz one. Each job goes to the worker
// with the fewest bytes pending; a worker runs its xz jobs one at a time and its deflate ones alongside. The pool starts
// on the first job; its URL carries viewer.js's version (deploy_pages.sh hashes the worker and xz-decompress into it).
let xzPool = null;
function xzJob(msg, cost, transfer) {
  if (!xzPool) {
    const v = ((document.querySelector('script[src^="viewer.js"]') || {}).src || '').split('?')[1] || '';
    const n = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
    xzPool = { ws: [], jobs: new Map(), id: 0 };
    for (let i = 0; i < n; i++) {
      const w = new Worker('xz_worker.js' + (v ? `?${v}` : ''));
      w.load = 0; w.keyed = false;
      w.onmessage = ({ data: { id, buf, err } }) => {
        const j = xzPool.jobs.get(id); xzPool.jobs.delete(id);
        w.load -= j.cost;
        err ? j.rej(new Error(`object: ${err}`)) : j.res(new Uint8Array(buf));
      };
      xzPool.ws.push(w);
    }
  }
  return new Promise((res, rej) => {
    const id = ++xzPool.id, w = xzPool.ws.reduce((a, b) => (b.load < a.load ? b : a));
    xzPool.jobs.set(id, { res, rej, cost });
    w.load += cost;
    if (msg.enc && !w.keyed) { msg.key = KEY_HEX; w.keyed = true; }
    w.postMessage({ id, ...msg }, transfer);
  });
}
const xzDecode = buf => xzJob({ buf }, buf.byteLength * 8, [buf]);
// an object as stored (an ArrayBuffer of its own: it is transferred) -> its plain bytes, in a worker; the page's own
// path (openObject) where workers fail
let objWorkers = typeof Worker !== 'undefined' && typeof DecompressionStream !== 'undefined' && Q.get('objworkers') !== '0';
function decodeObject(buf, z = null) {
  if (!objWorkers) return openObject(buf, z);
  const copy = buf.slice(0);  // (kept for the fallback: the job transfers its own)
  return xzJob({ enc: copy, z }, buf.byteLength * (z === 'xz' ? 8 : 1), [copy]).catch(e => {
    console.warn('object worker failed, decoding on the page:', e); objWorkers = false; return openObject(buf, z);
  });
}
async function openObject(buf, z = null) {
  const b = new Uint8Array(buf);
  const d = await crypto.subtle.decrypt({ name: 'AES-CTR', counter: b.slice(0, 16), length: 64 }, cryptoKey, b.slice(16));
  if (z === 'xz') return xzDecode(d);
  const s = new Blob([d]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
const net = window.mbaaNet = { objects: 0, bytes: 0, cached: 0 };
// The file pipeline in workers (web/shell/file_worker.js; 11-04 live-switch work, rescued 2026-11-06): fetch (with the
// Cache Storage copy), decrypt and inflate off this thread, the plain bytes transferred back; a pack is fetched once for
// all of its files a load asks for. decodeObject already moves decrypt + inflate off this thread; this also moves the
// fetch, the store's copy and the fallback copy. A worker that fails turns the pool off: this thread's path as before.
// on by default (user 2026-11-06, after artifacts/xz_check/file_worker/RESULTS.md); ?fileworker=0: off
let filePool = null, filePoolOff = Q.get('fileworker') === '0' || typeof Worker === 'undefined' || typeof DecompressionStream === 'undefined';
function fileJob(h, parts, z = null) {
  if (filePoolOff || !cryptoKey) return Promise.reject(new Error('no file workers'));
  if (!filePool) {
    const v = ((document.querySelector('script[src^="viewer.js"]') || {}).src || '').split('?')[1] || '';
    const n = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1));
    filePool = { ws: [], jobs: new Map(), id: 0, rr: 0 };
    try {
      for (let i = 0; i < n; i++) {
        const w = new Worker('file_worker.js' + (v ? `?${v}` : ''));
        w.onmessage = ({ data: m }) => {
          const j = filePool && filePool.jobs.get(m.id);
          if (!j) return;
          filePool.jobs.delete(m.id);
          if (m.net) { net.bytes += m.net.bytes; net.cached += m.net.cached; if (m.net.bytes) net.objects++; }
          if (m.err) j.rej(new Error(`object ${j.h}: ${m.err}`));
          else { const out = m.bufs.map(b => new Uint8Array(b)); out.ms = m.ms; out.bytes = m.bytes; j.res(out); }  // (ms / bytes: ?filesprof=1)
        };
        w.onerror = e => { e.preventDefault(); fileOff('worker failed: ' + (e.message || 'no script')); };
        w.postMessage({ key: cryptoKey });
        filePool.ws.push(w);
      }
    } catch (e) { fileOff(String(e)); return Promise.reject(e); }
  }
  return new Promise((res, rej) => {
    const id = ++filePool.id;
    filePool.jobs.set(id, { res, rej, h });
    filePool.ws[filePool.rr++ % filePool.ws.length].postMessage({ id, url: new URL(`${BUNDLE}o/${h.slice(0, 2)}/${h}`, document.baseURI).href, parts, z });
  });
}
// the pool off: every job waiting fails over to this thread's path (the callers fall back on a rejection)
function fileOff(why) {
  if (filePoolOff) return;
  filePoolOff = true;
  console.warn('file workers off:', why);
  if (!filePool) return;
  for (const w of filePool.ws) w.terminate();
  for (const j of filePool.jobs.values()) j.rej(new Error(why));
  filePool = null;
}

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
async function fetchObject(h, z = null) {
  const w = filePoolOff ? null : await fileJob(h, [null], z).catch(() => null);
  return w ? w[0] : openObject(await fetchRaw(h), z);
}
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
let slogTexMiss = false;
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
  console[k] = (...a) => {
    try {
      const t = a.map(String).join(' ');
      if (k === 'error' || /^(spectate|live|radio|gl|bgm):/.test(t)) slogAdd(k, t);
      // (a texture drawn blank: its pixels gone from the GPU store, d3d9_gl.cpp ensure_uploaded / texture_read. Sent
      // once a session: the stage "built with wholly missing blocks" a refresh fixes, user 2026-11-07, never caught)
      if (/^gl: .*missing from the store/.test(t) && !slogTexMiss) { slogTexMiss = true; setTimeout(() => slogSend(session, 'texmiss'), 3000); }
    } catch (e) {}
    o(...a);
  };
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
  const now = performance.now(), tk = M._viewer_tick_count() >>> 0;
  // (the engine's loop ran lately: a window covered by another (a game in front of it) is never 'hidden' but its
  // browser stops the animation frames, so no frame is no stall of ours: 8 such reports from one Firefox on 2026-11-07)
  if (tk !== w.tk) { w.tk = tk; w.tkAt = now; }
  if (f !== w.f) { w.f = f; w.fAt = now; w.sent = false; }
  else if (!w.sent && s.liveSrc && !ui.paused && !document.hidden && now - w.tkAt < 2000 && now - w.fAt > 20000) {
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
// (moons spelled out, never C- / F- / H-: user 2026-11-06 "Full Moon Arcueid", not "Full-Arcueid"; 51 is Archetype:Earth, as the wiki)
const MOON_LABEL = ['Crescent Moon', 'Full Moon', 'Half Moon'];
const CHARA = { 0: 'Sion', 1: 'Arcueid', 2: 'Ciel', 3: 'Akiha', 4: 'Hisui & Kohaku', 5: 'Hisui', 6: 'Kohaku', 7: 'Shiki',
  8: 'Miyako', 9: 'Warachia', 10: 'Nrvnqsr', 11: 'V. Sion', 12: 'Red Arcueid', 13: 'V. Akiha', 14: 'Mech-Hisui', 15: 'Nanaya',
  16: 'G. Akiha', 17: 'Satsuki', 18: 'Len', 19: 'P. Ciel', 20: 'Neco-Arc', 22: 'Aoko', 23: 'White Len', 25: 'Neco-Arc Chaos',
  27: 'G. Chaos', 28: 'Kouma', 29: 'Seifuku Akiha', 30: 'Riesbyfe', 31: 'Roa', 32: 'Hermes', 33: 'Ryougi',
  34: 'Neco & Mech', 35: 'Kohaku & Mech', 51: 'Archetype:Earth', 53: 'B. Akiha', 58: 'B. Miyako', 59: 'B. Warachia',
  72: 'B. Aoko', 73: 'B. White Len', 85: 'B. Kohaku & Mech' };
function matchTitle(rep) {
  if (rep.length < 0x5C) return 'MBAACC replay';
  const dv = new DataView(rep.buffer, rep.byteOffset, rep.byteLength);
  const side = o => { const m = MOON_LABEL[dv.getInt32(o + 8, true)]; return (m ? m + ' ' : '') + (CHARA[dv.getInt32(o + 4, true)] || `#${dv.getInt32(o + 4, true)}`); };
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
// files being fetched (path -> promise): a second fetchAll asking for one waits for that fetch (a live switch starts its
// match's files with the boot tape's request, and start() asks for them again)
const inflight = new Map();
const FILES_PROF = Q.get('filesprof') === '1';  // (the checks: window.__mbaaFiles, each object's fetch and decode times)
async function fetchAll(man, paths, label, quiet = false) {
  const net0 = net.bytes;  // the counter shows what came over the network (objects are deflated; the game sees ~4x that)
  // (the big xz objects first, largest first: each is one worker's job for a while (a character's .cg, ~0.3-0.5 s);
  // started last they were the long pole of a match's files, the small ones long done)
  const big = p => { const f = man.files[p]; return f && f.z === 'xz' && !f.pk ? f.n || 0 : -1; };
  const queue = [...paths].filter(p => !cache.has(p)).sort((a, b) => big(b) - big(a));
  let done = 0, bytes = 0;
  const n = queue.length, packs = new Map();  // pack -> its bytes (one fetch for all of its files in this call)
  // (file workers: a pack once for all of its files in this call -> their plain bytes, by path; null: this thread's path)
  const packParts = new Map(), packOut = new Map();
  if (!filePoolOff) for (const p of queue) { const f = man.files[p]; if (f && f.pk && !f.plain) { const l = packParts.get(f.pk[0]) || []; l.push(p); packParts.set(f.pk[0], l); } }
  // (?filesprof=1: [path, codec ('xz' | 'd' deflate, 'pk:' a pack's part), bytes in, bytes out, queued, fetched, done] per object)
  const prof = (p, z, nin, out, t0, t1, t2) => (window.__mbaaFiles || (window.__mbaaFiles = [])).push([p, z, nin, out.length, Math.round(t0), Math.round(t1), Math.round(t2)]);
  const viaPack = (h, p) => {
    if (!packOut.has(h)) {
      const ps = packParts.get(h) || [p], t0 = performance.now();
      packOut.set(h, fileJob(h, ps.map(q => [man.files[q].pk[1], man.files[q].pk[2], man.files[q].z || null]))
        .then(bufs => { const t2 = performance.now(); if (FILES_PROF) ps.forEach((q, i) => prof(q, 'pk:' + (man.files[q].z || 'd'), man.files[q].pk[2], bufs[i], t0, t2 - (bufs.ms ? bufs.ms.parts[i] : 0), t2)); return new Map(ps.map((q, i) => [q, bufs[i]])); }).catch(() => null));
    }
    return packOut.get(h).then(m => m && m.get(p));
  };
  const one = async p => {
    const f = man.files[p], t0 = performance.now();
    let data;
    if (!f.plain && !filePoolOff && (data = await (f.pk ? viaPack(f.pk[0], p) : fileJob(f.o, [null], f.z).then(b => { if (FILES_PROF) prof(p, f.z || 'd', b.bytes || 0, b[0], t0, t0 + (b.ms ? b.ms.fetch : 0), performance.now()); return b[0]; }).catch(() => null)))) {
      cache.set(p, data); return;
    }
    if (f.plain) {
      const r = await fetch(f.plain);
      if (!r.ok) { console.warn(`${p}: HTTP ${r.status}`); return; }
      data = new Uint8Array(await r.arrayBuffer());
    } else if (f.pk) {
      const [h, off, len] = f.pk;
      if (!packs.has(h)) packs.set(h, fetchRaw(h));
      const t0 = performance.now(), pb = await packs.get(h), t1 = performance.now();
      data = await decodeObject(pb.slice(off, off + len), f.z);
      if (FILES_PROF) (window.__mbaaFiles || (window.__mbaaFiles = [])).push([p, 'pk:' + (f.z || 'd'), len, data.length, Math.round(t0), Math.round(t1), Math.round(performance.now())]);
    } else if (FILES_PROF) {
      const t0 = performance.now(), raw = await fetchRaw(f.o), t1 = performance.now();
      data = await decodeObject(raw, f.z);
      (window.__mbaaFiles || (window.__mbaaFiles = [])).push([p, f.z || 'd', raw.byteLength, data.length, Math.round(t0), Math.round(t1), Math.round(performance.now())]);
    } else data = await decodeObject(await fetchRaw(f.o), f.z);
    cache.set(p, data);
  };
  async function worker() {
    for (let p; (p = queue.shift());) {
      if (inflight.has(p)) await inflight.get(p);
      else if (!cache.has(p)) {
        const job = one(p);
        inflight.set(p, job);
        try { await job; } finally { inflight.delete(p); }
      }
      if ((++done % 10 === 0 || done === n) && !quiet) status(`${label} ${done}/${n} (${((net.bytes - net0) / 1e6).toFixed(1)} MB downloaded${net.cached ? `, ${net.cached} files from cache` : ''})`);
    }
  }
  // (48 at once: the decoding is the pool's (decodeObject), off this thread; with 16 the small objects waited their turn
  // behind the big ones, ~0.5 s of a match's files)
  await Promise.all(Array.from({ length: objWorkers ? 48 : 16 }, worker));
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

// ---- audio (WebAudio, shared by sessions) ----
let actx, master, outGain, musicGain, sfxGain;
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
  musicGain = actx.createGain(); musicGain.gain.value = musicLevel(); musicGain.connect(master);  // the BGM and the radio (music toggle, music level)
  sfxGain = actx.createGain(); sfxGain.gain.value = sfxLevel(); sfxGain.connect(master);  // the game's sounds: hits, voices, announcer (effects level)
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
// The chain joins `out` only while it has a sound (dsOn / dsOff): Chrome renders every connected node each 128-sample
// quantum, silent or not, and a session keeps one chain per sound set it ever touched. Idle chains left connected cost the
// phone's audio thread 47 % of a core at 50 chains and all of it at 200 (Moto G Power, tools/stage3d/phone/
// audio_latency_probe.py, 2026-11-06); a live session had that running under every frame.
function dsVoiceChain(out) {  // gain (volume) -> split -> per-side gain (pan) -> merge -> out
  const g = actx.createGain();
  g.channelCount = 2; g.channelCountMode = 'explicit'; g.channelInterpretation = 'speakers';
  const sp = actx.createChannelSplitter(2), mg = actx.createChannelMerger(2);
  const l = actx.createGain(), r = actx.createGain();
  g.connect(sp); sp.connect(l, 0); sp.connect(r, 1); l.connect(mg, 0, 0); r.connect(mg, 0, 1);
  return { g, l, r, mg, out, on: false, src: null, vol: 0, pan: 0 };
}
function dsOn(v) { if (!v.on) { v.mg.connect(v.out); v.on = true; } }
function dsOff(v) { if (v.on && !v.src) { v.mg.disconnect(); v.on = false; } }
function audioHooks(Module, s) {
  ensureAudio();
  const running = () => !!actx && actx.state === 'running';
  const live = () => !HASH && running() && session === s && !s.mute;
  // bundle path (an announcer's line: ann<set>:<id>) -> {p: decode promise, bytes}, least recently played first. Decoded
  // sounds are PCM (48 kHz float: ~0.4 MB a second of a stereo line), and a live session lasts a whole set: every voice line
  // of every character it saw stayed decoded (and every announcer set's lines). Kept to SE_BUDGET bytes; one evicted is
  // decoded again when it plays next (a few ms, off the game's thread)
  const seBuf = new Map();
  const SE_BUDGET = (LOWMEM ? 24 : 96) * 1e6;
  let seAnnN = 0;
  const se = window.mbaaSeStats = { registered: 0, ann: 0, annSrc: { ext: 0, neco: 0 }, annLog: [], calls: 0, played: 0, decodeFailed: 0, stops: 0, params: 0, bytes: 0, evicted: 0, ctx: () => actx.state };
  const seKeep = (key, e) => {  // (a decode settled: its bytes counted, the oldest dropped past the budget)
    if (seBuf.get(key) !== e) return;
    se.bytes += e.bytes;
    for (const [k, x] of seBuf) {
      if (se.bytes <= SE_BUDGET || k === key) break;
      seBuf.delete(k); se.bytes -= x.bytes; se.evicted++;
    }
  };
  const seDrop = k => { const x = seBuf.get(k); if (x) { seBuf.delete(k); se.bytes -= x.bytes; } };
  const voices = new Map();  // channel -> chain
  const chain = ch => { let v = voices.get(ch); if (!v) { v = dsVoiceChain(sfxGain); voices.set(ch, v); } return v; };
  const cut = v => { if (v.src) { try { v.src.stop(); } catch (e) {} v.src.disconnect(); v.src = null; } dsOff(v); };
  const apply = (v, vol, pan) => { v.vol = vol; v.pan = pan; v.g.gain.value = dsGain(vol); dsSetPan(v, pan); };
  Module.mbaaVoicePlay = (ch, path, vol, pan) => {
    se.calls++;
    if (!actx) return;  // (no audio yet: a Play before it is never heard; the next Play sets the voice up)
    const v = chain(ch);
    cut(v); apply(v, vol, pan);
    if (!live()) return;
    // (an announcer line: an extension's set (liveExtApi.announcer), else the site's (annDefault: Neco-Arc), decoded once
    // per set; else the game's own)
    const A = liveExt.ann, al = annLine(path), ab = al && al.bytes;
    const key = al ? al.key : path;
    // (another announcer set, or none: the last one's lines go)
    const annN = A ? A.n : 0;
    if (annN !== seAnnN) { seAnnN = annN; for (const k of [...seBuf.keys()]) if (k.startsWith('ann')) seDrop(k); }
    let e = seBuf.get(key);
    if (e) { seBuf.delete(key); seBuf.set(key, e); }  // (most recently played: last)
    else {
      let bytes = ab;
      if (!bytes) { try { bytes = Module.FS.readFile(path); } catch (err) { return; } se.registered++; }
      e = { p: actx.decodeAudioData(bytes.slice().buffer), bytes: 0 };
      seBuf.set(key, e);
      const ent = e;
      e.p.then(buf => { ent.bytes = buf.length * buf.numberOfChannels * 4; seKeep(key, ent); }, () => {});
    }
    if (al && al.src === 'ext') se.ann++;
    if (al) se.annSrc[al.src]++;
    { const m = /normal_se[\\/]se(\d{3})\./i.exec(path); if (m) { se.annLog.push([+m[1], al ? al.src : 'game']); if (se.annLog.length > 256) se.annLog.shift(); } }
    const b = e.p;
    const n = actx.createBufferSource();
    v.src = n;  // claimed now: a Stop or a later Play before the decode resolves cancels it
    // (off the mix again when it ends, unless another Play has claimed the voice since)
    n.onended = () => { if (v.src === n) { v.src = null; dsOff(v); } };
    b.then(buf => { if (v.src !== n || !live()) return; n.buffer = buf; n.connect(v.g); dsOn(v); n.start(); se.played++; },
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
    if (!bgmChain && actx) { bgmChain = dsVoiceChain(musicGain); radioChain = dsVoiceChain(musicGain); dsOn(bgmChain); dsOn(radioChain); radioLevel(-10000); }
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
  // (a live extension's music, liveExt.music, is not radio: it takes the match's own music's place and follows the game's
  // starts, stops and seeks (round to round, the results screen, a seek), at the game's volume; extSub below)
  const radioOn = () => !!musicLocal() && !HASH;  // (the radio's music: the pick's, or the music chosen on its own)
  const play = (path, loop, loopPos, offset) => {
    // (the "...and nothing heart" stage's music: off unless the viewer turned it on; songSub)
    // (only the fight's own track: bgm.txt's stage tracks, bgmme01-59; character select (99), the win jingle (98), VS (84)
    // and the rest keep the game's music, user 2026-11-03)
    const ext = !HASH && !radioOn() && liveExt.music && /bgmme(0[1-9]|[1-5]\d)\.(ogg|opus)$/i.test(path || '') && liveExt.music;
    if (ext && path) {   // (the extension's track where the game's would play: same start, same position, looped at its own point)
      if (!cache.has(ext.key)) { halt(); return; }
      path = ext.path; loop = true; loopPos = ext.loopPos;
    }
    const sub = !ext && !radioOn() && songSub(path, Module.HEAP32[STAGE_ID >> 2]);
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
// A game file out of the page's cache, with its parsed / decoded BGM: a parsed track's packets are views into the file's
// bytes, so the parse kept every track ever played (and a live extension's replaced music) alive after the cache let go
function cacheDrop(p) { cache.delete(p); bgmDecoded.delete(p); bgmParsedMap.delete(p); }
// the files held for the viewer's own picks (the radio's track and stage, the music pick, a live extension's music): a
// pick lasts across a live match's sessions, and a new session's cache prune took them (the radio's older-game stage
// file then never went in again: radioPut reads the cache)
function cachePinned() {
  const out = new Set();
  for (const t of [radio, musicSel, liveExt.music]) if (t && t.path) out.add(t.path.replace(/^\/game\//, ''));
  for (const p of livePreKeep) out.add(p);  // (the likeliest next live match's files: livePreTick)
  for (const [, w] of cardHot) for (const p of w) out.add(p);  // (the live cards' preloaded / hovered files)
  if (radio && radio.dat) out.add(radio.dat);
  if (radio && radio.stages && man) for (const id of radio.stages) for (const p of radioStageFiles(id)) out.add(p);
  return out;
}
// everything but keep (and the picks') out of the cache: the rest stays in Cache Storage, a fetch away
function cachePrune(keep) {
  const pin = cachePinned();
  if (liveKept) for (const p of liveKept.want) pin.add(p);  // (a kept live match's files: its switch-back reads them)
  for (const p of [...cache.keys()]) if (!keep.has(p) && !pin.has(p)) cacheDrop(p);
  for (const m of [bgmDecoded, bgmParsedMap]) for (const p of [...m.keys()]) if (!cache.has(p)) m.delete(p);
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
// ---- the site's own right-click / long-press menu (user 2026-11-08): on a live list row, the picture, the match card and a
// chat tab. Everyone: copy the match's link, a link at this moment, its chat as a tab, open it in a new tab, pop a chat
// out into its own window; mods and admins (operators in the chat): pin a match to the top of everyone's live list
// (the chat bot keeps the pins: pin / unpin, sent to all as +mbaa/pins). Links always name the public site.
// (the game picture's own browser menu stays off: every canvas freshCanvas makes; the CSP forbids an inline handler)
const ctxPublic = () => /^(127\.0\.0\.1|localhost)$/.test(location.hostname) ? location.origin + location.pathname : 'https://watch.meltyblood.org/';
const ctxMatchUrl = m => `${ctxPublic()}?live=${m.id}`;
const ctxPinKey = m => (m && (m.match || m.id)) || '';
const ctxChat = () => window.mbaaChat || null;
async function ctxCopy(text, what) {
  try { await navigator.clipboard.writeText(text); status(`copied ${what}: ${text}`); } catch (e) { prompt('copy:', text); }
}
// a live chat in its own window (?popchat=<channel>: the chat column alone, no game loaded)
function ctxPopChat(chanName) {
  const u = new URL(location.origin + location.pathname);
  u.searchParams.set('popchat', chanName);
  const w = window.open(u.toString(), `mbaachat${chanName.replace(/[^A-Za-z0-9]/g, '')}`, 'popup,width=440,height=760');
  if (!w) status('pop-out: the browser blocked the window (allow pop-ups for this site)');
}
// "Copy link at this moment" on the match being watched: a replay at the frame on screen (live: the game so far, saved
// as a replay now: liveClipLink's moment; a live link needs a chat sign-in, as clips do)
function ctxMoment() {
  const s = session;
  if (!s) return;
  if (!s.liveSrc) return copyTimestamp(true);
  if (!liveClipCan()) { status(`live moment link: ${LIVE_SIGNIN}`); return; }
  const lo = clipFirst(s), b = Math.max(lo + 1, s.M._viewer_frame());
  const c = Object.assign({ a: Math.max(lo, b - 600), b }, liveClipWhere(s));
  return liveClipLink(s, c, true);
}
// the menu's items for a live match (m: a live list entry; the watched one is the session's)
function ctxMatchItems(m) {
  const C = ctxChat(), watching = !!(m && session && session.liveSrc && liveOurs(m, session.liveSrc)), it = [];
  if (!m) return it;
  it.push({ t: 'Copy link to the match', fn: () => ctxCopy(ctxMatchUrl(m), 'the match link') });
  if (watching) it.push({ t: 'Copy link at this moment', fn: ctxMoment });
  it.push({ t: 'Open in a new tab', fn: () => window.open(`${location.pathname}?live=${m.id}`, '_blank', 'noopener') });
  if (C && m.match && !watching) it.push({ t: 'Open its chat as a tab', fn: () => C.openMatch(m) });
  if (C && m.match) it.push({ t: 'Pop out its chat', fn: () => ctxPopChat(`#m-${String(m.match).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60)}`) });
  if (C && C.isMod && C.isMod()) {
    const k = ctxPinKey(m), on = !!(C.pins && C.pins().has(k));
    it.push(null, { t: on ? 'Unpin from the top' : 'Pin to the top for everyone', fn: () => C.pin(k, !on), mod: true });
  }
  return it;
}
// the watched match as a live list entry (the list's own, else one made from the session)
function ctxWatched() {
  const L = session && session.liveSrc;
  if (!L) return null;
  const l = liveListLast ? liveListLast.l : [];
  return (l || []).find(m => liveOurs(m, L)) || { id: L.id, match: L.info && L.info.match, names: L.info && L.info.names };
}
function ctxItemsFor(target) {
  if (!target || !target.closest) return null;
  if (target.closest('#ctxm, input, textarea, select, [contenteditable]')) return null;
  const row = target.closest('#liveitems li');
  if (row && row.__m) return ctxMatchItems(row.__m);
  const tab = target.closest('#chatsec .ctab[data-chan]');
  if (tab) {
    const C = ctxChat(), name = tab.dataset.chan, it = [], m = (liveListLast && liveListLast.l || []).find(x => x.match && `#m-${x.match}`.toLowerCase() === name.toLowerCase());
    it.push({ t: name === '#melty' ? 'Pop out #melty' : 'Pop out this chat', fn: () => ctxPopChat(name) });
    if (m) it.push(null, ...ctxMatchItems(m).filter(x => !x || x.t !== 'Pop out its chat' && x.t !== 'Open its chat as a tab'));
    else if (C && /^#m-/.test(name)) it.push({ t: 'Copy link to its chat', fn: () => ctxCopy(`${ctxPublic()}?popchat=${encodeURIComponent(name)}`, 'the chat link') });
    return it;
  }
  if (target.closest('#matchcard, #players')) return session && session.liveSrc ? ctxMatchItems(ctxWatched()) : null;
  const st = target.closest('.stage');
  if (st && !target.closest('.fsbar, #chatcol, button, a') && session) {
    if (session.liveSrc) return ctxMatchItems(ctxWatched());
    return [{ t: 'Copy link at this moment', fn: () => copyTimestamp(true) }, { t: 'Copy link to the replay', fn: () => copyTimestamp(false) }];
  }
  return null;
}
let ctxEl = null;
function ctxClose() { if (ctxEl) { ctxEl.remove(); ctxEl = null; } }
function ctxOpen(x, y, items) {
  ctxClose();
  items = items.filter((v, i, a) => v || (i > 0 && i < a.length - 1 && a[i - 1]));
  if (!items.some(Boolean)) return;
  const m = ctxEl = document.createElement('div');
  m.id = 'ctxm'; m.setAttribute('role', 'menu');
  for (const v of items) {
    if (!v) { m.append(Object.assign(document.createElement('div'), { className: 'sep' })); continue; }
    const b = document.createElement('button');
    b.type = 'button'; b.setAttribute('role', 'menuitem'); b.textContent = v.t;
    if (v.mod) b.className = 'mod';
    // (the action in the click itself: the clipboard and window.open want the user's gesture)
    b.onclick = e => { e.stopPropagation(); ctxClose(); try { const r = v.fn(); if (r && r.catch) r.catch(err => status(String(err.message || err))); } catch (err) { status(String(err.message || err)); } };
    m.append(b);
  }
  (document.fullscreenElement || document.body).append(m);
  const r = m.getBoundingClientRect(), W = innerWidth, H = innerHeight;
  m.style.left = `${Math.max(4, Math.min(x, W - r.width - 4))}px`;
  m.style.top = `${Math.max(4, y + r.height > H - 4 ? y - r.height : y)}px`;
  const first = m.querySelector('button');
  if (first) first.focus({ preventScroll: true });
}
document.addEventListener('contextmenu', e => {
  if (e.target && e.target.id === 'canvas') e.preventDefault();
  if (e.shiftKey) return;  // (Shift + right-click: the browser's own menu)
  const items = ctxItemsFor(e.target);
  if (!items) return;
  e.preventDefault(); ctxPress = null;
  ctxOpen(e.clientX, e.clientY, items);
});
// a touch held ~0.5 s: the menu (iPhones fire no contextmenu; Android does, which opens it first and ends this press)
let ctxPress = null, ctxSwallow = 0;
document.addEventListener('pointerdown', e => {
  if (ctxEl && !e.target.closest('#ctxm')) ctxClose();
  if (e.pointerType !== 'touch') return;
  const p = ctxPress = { x: e.clientX, y: e.clientY, t: e.target };
  setTimeout(() => {
    if (ctxPress !== p) return;
    ctxPress = null;
    const items = ctxItemsFor(p.t);
    if (items) { ctxSwallow = performance.now(); ctxOpen(p.x, p.y, items); }
  }, 520);
}, true);
for (const ev of ['pointerup', 'pointercancel']) document.addEventListener(ev, () => { ctxPress = null; }, true);
document.addEventListener('pointermove', e => { if (ctxPress && Math.hypot(e.clientX - ctxPress.x, e.clientY - ctxPress.y) > 10) ctxPress = null; }, true);
// (the tap that ends a long press does not also follow the row's link)
document.addEventListener('click', e => { if (performance.now() - ctxSwallow < 700 && !e.target.closest('#ctxm')) { e.preventDefault(); e.stopPropagation(); ctxSwallow = 0; } }, true);
document.addEventListener('keydown', e => {
  if (!ctxEl) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); ctxClose(); return; }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const bs = [...ctxEl.querySelectorAll('button')], i = bs.indexOf(document.activeElement);
    e.preventDefault(); e.stopPropagation();
    bs[(i + (e.key === 'ArrowDown' ? 1 : bs.length - 1)) % bs.length].focus();
  }
}, true);
for (const ev of ['blur', 'resize']) addEventListener(ev, ctxClose);
document.addEventListener('scroll', ctxClose, true);
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
    const u = URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 16)'], { type: 'text/javascript' }));
    bgTicker = new Worker(u);
    URL.revokeObjectURL(u);  // (the worker has its script: one URL a hidden spell was kept)
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
// ---- one frame for the page (goal 3a, harness-design/stage3d_perf/ASSESSMENT_1107.md item 2): the shell's moving parts
// (the chat's name effects, the players' icons, the time and seek bar, the radio stage's sync, the pop-out's frames)
// update inside the game's frame, so Chrome composites one frame per game frame. Was: each on its own
// requestAnimationFrame (the chat's name worker at the display's rate), and a 120 Hz phone presented 76-83 frames a second
// for a 60 fps game, half of them 8 ms apart (Buffer Stuffing). Driven by the game's frames as they play (Module.mbaaFrame,
// once per tick); with none for 50 ms (paused, a seek, between matches, no match) by a 60-a-second timer.
const frameBus = new Set();
let frameBusAt = -1e9;
function frameBusRun(now) {
  frameBusAt = now;
  for (const f of frameBus) { try { f(now); } catch (e) { console.warn('frame:', e); } }
}
setInterval(() => { const now = performance.now(); if (now - frameBusAt > 50) frameBusRun(now); }, 1000 / 60);
window.mbaaFrameBus = frameBus;  // (chat.js: its name effects)
let pipTickN = 0;
frameBus.add(function pipTick() {
  if (pipTrack && pipVideo && pipTrack.readyState === 'live') {
    if (document.pictureInPictureElement === pipVideo || ++pipTickN % 30 === 0) { try { pipTrack.requestFrame(); } catch (e) {} }
  }
});
function pipSource() {
  if (pipVideo) return pipVideo;
  pipVideo = document.createElement('video');
  pipVideo.id = 'pipv'; pipVideo.muted = true; pipVideo.playsInline = true; pipVideo.autoPictureInPicture = true;
  pipVideo.srcObject = pipStream(document.getElementById('canvas'));
  pipSelfAt = performance.now();
  pipVideo.addEventListener('leavepictureinpicture', () => { pipCover(false); if (document.visibilityState === 'hidden') bgTick(true); });
  pipVideo.addEventListener('enterpictureinpicture', () => pipCover(true));
  // the window's own controls (Firefox draws volume, mute and play / pause; the video has no sound of its own): the
  // page's volume slider and pause follow them, and they follow the page (pipFollow)
  pipVideo.addEventListener('volumechange', () => {
    const vol = document.getElementById('vol'), want = pipVideo.muted ? 0 : Math.round(pipVideo.volume * 100);
    if (pipUser() && want !== +vol.value) { vol.value = want; vol.oninput(); }
  });
  for (const ev of ['play', 'pause']) pipVideo.addEventListener(ev, () => {
    if (pipUser() && session && ui.paused !== pipVideo.paused) { if (pipVideo.paused) setPaused(true); else playOn(); }
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
// (user 2026-11-03: the match kept playing on the page too, a duplicate of the window: the page's picture covered while
// the window is open. The canvas still draws underneath: the window's stream is that canvas)
function pipCover(on) {
  document.getElementById('pipcover').hidden = !on;
  document.getElementById('pip').classList.toggle('on', on);
}
document.getElementById('pipback').onclick = () => { if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {}); };
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
  try { navigator.mediaSession.setActionHandler('play', () => { if (ui.paused) playOn(); }); navigator.mediaSession.setActionHandler('pause', () => setPaused(true)); } catch (e) {}
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
// ---- the engine started ahead (goal D, 2026-11-05: a tap on a live card paid the module, the game's boot and the boot
// snapshot after all of the match's files were in, ~0.5 s desktop / ~1.7 s at 4x). As soon as the manifest is in, the
// page fetches the boot files only (plan.boot), makes the instance and boots it exactly as play() does (the same
// settings before viewer_boot, the boot textures sealed, the boot snapshot); the first session then takes it over as a
// reused instance that has never run past its boot (no restore). The match's files and the boot tape meanwhile come in
// alongside. Never in hash / capture runs or with ?reuse=0. (Was behind ?prewarm=1 while it was a suspect for the owner
// stage squares, 2026-11-06; those were the snapshot's background block, radio_stage.cpp snap_keep_bg_*.)
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
    if (w && !session) { bootMark('moduleStart'); bootMark('module'); return warmTake(w, rep, name, want); }
  }
  const prev = session;
  if (prev) { try { prev.M.ccall('viewer_stop', null, [], []); } catch (e) {} }
  window.dispatchEvent(new Event('mbaa-session-end'));
  if (prev && prev.boot && (!HASH && !CAPTURE ? Q.get('reuse') !== '0' : Q.get('reuse') === '1')) return reuseSession(prev, rep, name, want);
  // mbaa.wasm is built with mbaa.js: it takes mbaa.js's cache-busting version (tools/web/deploy_pages.sh)
  const wasmV = ((document.querySelector('script[src^="mbaa.js"]') || {}).src || '').split('?')[1];
  // mbaaStoreKeep: the texture store keeps the last match's textures for the next one (web/host/browser/d3d9_gl.cpp)
  bootMark('moduleStart');
  if (SPECTOR_P) await SPECTOR_P;
  const M = await MBAA({ print: t => console.log(t), printErr: t => console.warn(t), canvas: freshCanvas(), mbaaStoreKeep: !LOWMEM,
                         locateFile: p => (wasmV && p.endsWith('.wasm') ? `${p}?${wasmV}` : p) });
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
const ui = { paused: false, speed: 1, boxes: false, inputs: false, skipIntro: false, hud: true, music: true, hitstun: true };
// ETM's hitstun bar (engine-drawn on the combo counter's underline, so in exports too): on unless this browser turned it
// off (user 2026-11-04, after the ETM+ redesign);
// ?hitstun=0/1 overrides; capture mode (CE-parity pictures) has it off unless asked for
try { ui.hitstun = localStorage.getItem('mbaaHitstun') !== '0'; } catch (e) {}
if (CAPTURE) ui.hitstun = false;
if (Q.get('hitstun') === '0' || Q.get('hitstun') === '1') ui.hitstun = Q.get('hitstun') === '1';
const HS_STYLE = Q.get('hitstunStyle');  // (the bar's look while it is designed: 0 ETM, 1 ETM+, 2 UNI, 3 UNI + bounce diamonds)
const hitstunApply = s => {  // (an engine without it: nothing)
  if (s.M._viewer_hitstun_style && HS_STYLE != null) call(s, 'viewer_hitstun_style', +HS_STYLE);
  if (s.M._viewer_hitstun_bar) call(s, 'viewer_hitstun_bar', ui.hitstun ? 1 : 0);
};
try { ui.hud = localStorage.getItem('mbaaHud') !== '0'; ui.music = localStorage.getItem('mbaaMusic') !== '0'; } catch (e) {}
try { ui.skipIntro = localStorage.getItem('mbaaSkipIntro') === '1'; } catch (e) {}
// the frame bar (ETM's, framebarSet): off unless this browser turned it on; ?framebar=0/1 overrides
try { ui.framebar = localStorage.getItem('mbaaFramebar') === '1'; } catch (e) { ui.framebar = false; }
if (Q.get('framebar') === '0' || Q.get('framebar') === '1') ui.framebar = Q.get('framebar') === '1';
try { ui.names = localStorage.getItem('mbaaNames') !== '0'; } catch (e) { ui.names = true; }
const tlMax = t => t.end !== null ? t.end : Math.max(t.simMax, t.est, 1);
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
    if (!s.seeking) incTick(s, f);
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
      } else { c.kf.pending = false; c.kf.ms = c.ms; t.kfNewFrame = c.kf.frame; thin(t); }
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
  for (const p of back) { const d = cache.get(p); if (!d) return false; fsPut(s.M.FS, '/game/' + p, d); s.freed.delete(p); }
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
// (?liveUrl= only on a local test page: on the site a link could otherwise play someone else's feed and send them the
// viewer's session log and pictures; security AUDIT_1107 F-02)
const LIVE_URL = /^(127\.0\.0\.1|localhost)$/.test(location.hostname) ? Q.get('liveUrl') : null;
const LIVE = LIVE_URL || location.origin + location.pathname.replace(/\/[^/]*$/, '');  // (the feed is next to the page)
// the feed exists only on the spectate path (the Worker gives that page <base href="/">) or where ?liveUrl= names one: the
// public page has none to ask for
const LIVE_FEED = !!(LIVE_URL || document.querySelector('base'));
// the spectate page: named for what it shows from the first paint on (the replay page's heading until a match loads)
if (document.querySelector('base')) { document.getElementById('title').textContent = 'necoTV'; document.title = 'necoTV · Melty Blood TV'; }
const LIVE_BEHIND = 240;  // frames kept buffered (4 s)
const LIVE_WIN = 8;  // polls (~8 s) the catch-up decisions look back over (a round end's burst and pause: ~5 s)
let liveSrc = null;  // {id, info, since}
// the feed's state, shown over the picture (index.html #livenotice): the operator's notice (header X-Live-Notice on any
// feed answer: tools/web/bridge_restart.sh sets it before restarting the bridge and clears it once it is back), and failed
// requests (no answer, a timeout, a 5xx from the Worker: the bridge is down). A notice up at the last answer stays up
// while the feed is down (the restart itself); without one, two failures in a row show "unreachable". Meanwhile the polls
// back off (liveNet.delay), and a match missing from the list just after (the bridge re-joining its hosts) is waited for
// A timer that still runs on time in a hidden tab (dewmeer 2026-11-03: "keep the game in sync while the tab's not
// active"): browsers slow a background page's own timers to once a second or less (Chrome: once a minute after 5 min),
// which starved the live feed while the game kept ticking (bgTick), so the match fell behind and stalled. A worker's
// timer is not slowed: while hidden, the live loops wait on one.
const wClock = { w: null, n: 0, cb: new Map() };
const wClear = t => { if (t < 0) wClock.cb.delete(-t); else clearTimeout(t); };
function wTimeout(fn, ms) {
  if (document.visibilityState !== 'hidden') return setTimeout(fn, ms);
  try {
    if (!wClock.w) {
      const u = URL.createObjectURL(new Blob(['onmessage = e => setTimeout(() => postMessage(e.data[0]), e.data[1])'], { type: 'text/javascript' }));
      wClock.w = new Worker(u); URL.revokeObjectURL(u);
      wClock.w.onmessage = e => { const f = wClock.cb.get(e.data); wClock.cb.delete(e.data); if (f) f(); };
    }
    const id = ++wClock.n; wClock.cb.set(id, fn); wClock.w.postMessage([id, ms]);
    return -id;  // (wClear)
  } catch (e) { return setTimeout(fn, ms); }
}
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
// A live match's extension: the feed's answers about a match may carry X-Live-Ext, a path on this site naming an ES
// module (tools/web/cc_live.mjs; set by the site owner only, tools/web/live_ext.mjs). The page imports it and calls its
// default export with liveExtApi; what it returns (a function) is called when the feed stops naming it, or the page goes to
// another match or a replay. The same value again does nothing; a late joiner gets it with its first answer.
const liveExt = { id: null, v: '', off: null, seq: 0, music: null, musicN: 0, stage: null, stageN: 0, ann: null, annN: 0 };
// The site's announcer for every match, replay or live (user 2026-11-03: "i want neco to be the announcer for every
// match"): Neco-Arc's lines (the Announcer Voice Selector's 'neco' set, tools/web/announcer_pack.py -> announcer/neco.bin,
// 17 lines, ~93 KB of Ogg Opus; deploy_pages.sh names it with its hash in the mbaa-announcer meta tag). Fetched once, 0.5 s
// after the first match starts (never in the way of its first frame); until it is in, a line is the game's own. An
// extension's set (liveExtApi.announcer) replaces it while set, and Neco is back when that one clears. ?ann=game: the
// game's own announcer (a parity check against CE)
const annDefault = { files: null, p: null, src: '' };
function annDefaultLoad() {
  if (annDefault.p || HASH || Q.get('ann') === 'game') return;
  const url = (document.querySelector('meta[name="mbaa-announcer"]') || {}).content || 'announcer/neco.bin';
  annDefault.src = url;
  annDefault.p = fetch(url).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); }).then(buf => {
    const d = new Uint8Array(buf), v = new DataView(buf);
    if (String.fromCharCode(...d.subarray(0, 4)) !== 'ANN1') throw new Error('not an ANN1 pack');
    const n = v.getUint32(4, true), files = new Map();
    let off = 8 + 6 * n;
    for (let i = 0; i < n; i++) {
      const id = v.getUint16(8 + 6 * i, true), len = v.getUint32(10 + 6 * i, true);
      if (off + len > d.length) throw new Error('short pack');
      files.set(id, d.subarray(off, off + len)); off += len;
    }
    annDefault.files = files;
  }).catch(e => console.warn('announcer pack:', e));
}
// which announcer serves this sound: {key (the decode cache's), bytes, src: 'ext' | 'neco'} | null (the game's own file).
// An extension's set is whole while set: a line it has no file for stays the game's (never Neco's in another's set)
function annLine(path) {
  const m = /normal_se[\\/]se(\d{3})\.(wav|opus|ogg)$/i.exec(path);
  if (!m) return null;
  const id = +m[1], A = liveExt.ann;
  if (A) { const b = A.files.get(id); return b ? { key: `ann${A.n}:${m[1]}`, bytes: b, src: 'ext' } : null; }
  const b = annDefault.files && annDefault.files.get(id);
  return b ? { key: `neco:${m[1]}`, bytes: b, src: 'neco' } : null;
}
const liveExtApi = {
  module: () => session && session.M,          // the game's Module (a new one per session: read it each time)
  liveId: () => (session && session.liveSrc ? session.liveSrc.id : null),
  current: () => liveExt.v,
  // a local test page's own (the secret test page: the same module, on whatever this page plays; kept across replays)
  setLocal: (v) => liveExtSet('local', v),
  // music in place of the match's (and of a radio pick) while set: {key, data: Ogg Opus bytes, loopPos (s), title} | null
  // (returns a token; music(null, token) clears it only while it is still that one: an extension taken off after the next
  // one went on leaves the next one's)
  music(o, tok) {
    // (the token is a counter, not the key: the next module with the same stage brings the same key, and the one before's
    // off, after it, took that one's music off: an announcer pick fell back to the game's music, user 2026-11-03)
    if (!o && tok && (!liveExt.music || liveExt.music.n !== tok)) return null;
    if (liveExt.music) cacheDrop(liveExt.music.key);
    liveExt.music = o && o.data ? { key: `x/${o.key}.opus`, path: `/game/x/${o.key}.opus`, loopPos: +o.loopPos || 0, file: `x:${o.key}`, title: String(o.title || ''), yt: /^https:\/\/www\.youtube\.com\/watch\?v=[\w-]+$/.test(o.yt || '') ? o.yt : '', ext: true, n: ++liveExt.musicN } : null;
    if (liveExt.music) cache.set(liveExt.music.key, o.data);
    if (session && session.radioChanged) session.radioChanged();
    return liveExt.music ? liveExt.music.n : null;
  },
  // the match card's stage in place of the match's while set: {name, view: image Blob | null, plate: image Blob | null} |
  // null (stageShow: the picture, the name plate, the name as its tooltip; the radio panel's "Match music" tile)
  // announcer lines in place of the game's while set: {files: {seId: WAV bytes}} | null (only se/normal_se/SE<id>.wav that
  // the set has; every other sound stays the game's); a token as music's
  announcer(o, tok) {
    if (!o && tok && (!liveExt.ann || liveExt.ann.n !== tok)) return null;
    const files = new Map();
    if (o && o.files) for (const [k, v] of Object.entries(o.files)) if (/^\d{1,3}$/.test(k) && v instanceof Uint8Array) files.set(+k, v);
    liveExt.ann = files.size ? { n: ++liveExt.annN, files } : null;
    return liveExt.ann ? liveExt.ann.n : null;
  },
  stage(o, tok) {   // (a token as music's)
    if (!o && tok && (!liveExt.stage || liveExt.stage.n !== tok)) return null;
    liveExt.stage = o ? { n: ++liveExt.stageN, name: String(o.name || ''), view: o.view instanceof Blob ? o.view : null,
                          plate: o.plate instanceof Blob ? o.plate : null } : null;
    stageKey = '';
    stageShow(session).catch(() => {});
    radioExtTile();
    // (the link card's picture follows the stage: a new one 4 s on, once the stage is drawn (a 3D one's textures upload
    // over a few frames); none of the routine ones meanwhile, so no frame of the old stage lands after the switch)
    liveExt.thumbDue = performance.now() + 4000;
    return liveExt.stage ? liveExt.stage.n : null;
  },
};
window.__mbaaExt = liveExtApi;
async function liveExtSet(id, v) {
  try { v = decodeURIComponent(v || ''); } catch (e) { v = ''; }
  if (v === liveExt.v && (id === liveExt.id || !v)) return;
  const seq = ++liveExt.seq;
  liveExt.v = v; liveExt.id = v ? id : null;
  const offNow = async () => { const f = liveExt.off; liveExt.off = null; if (f) { try { await f(); } catch (e) { console.warn('live ext off:', e); } } };
  if (!v) return offNow();
  let u;
  try { u = new URL(v, location.origin); } catch (e) { return offNow(); }
  if (u.origin !== location.origin) return offNow();
  try {
    const m = await import(u.href);
    if (seq !== liveExt.seq) return;
    const r = await m.default(liveExtApi, () => seq === liveExt.seq);
    if (seq !== liveExt.seq) { if (typeof r === 'function') await r(); return; }
    // (the one before stays on until this one is ready, then goes: one stage to the next with no MBAA stage between)
    await offNow();
    if (typeof r === 'function') liveExt.off = r;
  } catch (e) { console.warn('live ext:', e); if (seq === liveExt.seq) await offNow(); }
}
// the live match last asked for (startLive): a retry, or a start still waiting on the network, of another one does
// nothing (was: a pending retry of the match the page had just left started it again: the page went back to it)
let liveWant = null, liveCss = null;
function liveRetry(id, match) {  // startLive could not reach the feed: again, unless a replay or another match was opened meanwhile
  if (session && !session.liveSrc) return;
  wTimeout(() => { if ((!session || session.liveSrc) && liveWant === id) startLive(id, match); }, Math.max(2000, liveNet.delay()));
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
// ---- live switch timing (SWITCH_PLAN.md phase 1): window.__mbaaSwitch, the marks of the newest switch in ms after the
// click (liveGo): list, bootRep, files, boot, records, cuStart, cuEnd, frame (the first frame drawn after the catch-up),
// stageArt (the stage art fetch resolved), cardPlayers / cardStage / cardPor / cardTrack and card (all of the card
// painted for the clicked match), live (following at 1x within LIVE_BEHIND + 90). Read by tools/web/live_switch_time_check.py.
let sw = null;
function swBegin(id) {
  const m = ((liveListLast && liveListLast.l) || []).find(x => x.id === id) || null;
  const st = m && m.chara ? (stageOk(m.stage) ? m.stage : stageStandIn(m.stage)) : null;
  sw = window.__mbaaSwitch = { id, t0: performance.now(), marks: {}, want: m && m.chara ? { stage: st, chara: m.chara.slice() } : null, n: ((sw && sw.n) || 0) + 1 };
  const me = sw;
  const tick = () => { if (sw !== me) return; swCard(); if (!me.marks.card && performance.now() - me.t0 < 60000) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
}
// first: only the first time per switch (else the newest time: cuEnd after a second jump)
function swMark(k, first = true, id = null) {
  // (a switch back to a kept match (phase 7): its steps in window.__mbaaSwitchBack; the second argument may be the session)
  const ses = first && typeof first === 'object' ? first : null;
  if (ses) first = true;
  const B = window.__mbaaSwitchBack;
  if (B && !B.restored && (liveResumeK || (ses && ses.liveResumeK))) (B.steps || (B.steps = {}))[k] = Math.round(performance.now() - (B.click ?? B.start));
  if (!sw || (id && id !== sw.id) || (first && sw.marks[k] != null)) return;
  sw.marks[k] = Math.round(performance.now() - sw.t0);
}
// the card's parts painted for the switch's match (run in an animation frame: what is on screen)
function swCard() {
  if (!sw || !sw.want) return;
  const W = sw.want, card = document.getElementById('matchcard'), box = document.getElementById('stageblk');
  const players = document.getElementById('players'), pors = [...card.querySelectorAll('.por:not(.xfghost)')];
  const shown = e => e && !e.hidden && getComputedStyle(e).display !== 'none';
  const img = e => shown(e) && e.complete && e.naturalWidth > 0;
  let pk = null; try { pk = JSON.parse(plKey || 'null'); } catch (e) {}
  if (shown(players) && pk && pk[0].every(([c], p) => c === W.chara[p])) swMark('cardPlayers');
  const stOk = shown(box) && +box.dataset.stage === W.stage && img(box.querySelector('.view'));
  if (stOk) swMark('cardStage');
  const porOk = pors.every((e, p) => +e.dataset.c === W.chara[p] && img(e));
  if (porOk) swMark('cardPor');
  const trOk = stOk && document.getElementById('trk').textContent.trim() !== '';
  if (trOk) swMark('cardTrack');
  if (sw.marks.cardPlayers != null && stOk && porOk && trOk) swMark('card');
}
async function liveList() {
  const r = await liveFetch(`${LIVE}/live/list`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const l = await r.json();
  // (a name the bridge learnt since the panel was drawn (a joiner's, from the hosts list): the panel redrawn from this
  // read at once, not at its next 15 s refresh: user 2026-11-05, "Ciel" listed while the card and the banner had the name)
  const nk = x => JSON.stringify((x || []).map(m => [m.id, m.names]));
  const renamed = liveListLast && nk(liveListLast.l) !== nk(l) && liveListLast.l.length === l.length;
  liveListLast = { at: performance.now(), l };
  if (renamed && !liveListDrawing) liveListShow(l).catch(() => {});
  return l;
}
let liveListLast = null;  // {at, l}: the newest list read (an entry from it is fresh for LIVE_FRESH ms)
const LIVE_FRESH = 3000;
// The bridge's one-request join (cc_live.mjs /join: the entry, the newest game's boot tape and its records; have / since:
// only the records after those the page holds). null: no answer, or a bridge without the route (liveJoinOk goes off for
// the page: the old requests from then on); {entry: null}: the match is not live
let liveJoinOk = Q.get('liveJoin') !== '0';
async function liveJoin(id, { have = null, since = null, v = false } = {}) {
  if (!liveJoinOk) return null;
  const q = new URLSearchParams();
  if (have != null) { q.set('have', have); q.set('since', since); }
  if (v) q.set('v', VIEWER);
  const r = await liveFetch(`${LIVE}/live/${id}/join?${q}`).catch(() => null);
  if (!r) return null;
  if (!r.headers.get('X-Live-Join')) { if (r.status === 404) liveJoinOk = false; return null; }
  if (r.status === 404) return { entry: null };
  if (!r.ok) return null;
  const b = new Uint8Array(await r.arrayBuffer()), n = new DataView(b.buffer).getUint32(0, true);
  const h = JSON.parse(new TextDecoder().decode(b.subarray(4, 4 + n)));
  return { ...h, boot: b.slice(4 + n, 4 + n + h.boot), rec: b.subarray(4 + n + h.boot), ext: r.headers.get('X-Live-Ext') };
}
// a list entry's boot tape header (cc_live.mjs bootRep: the stage and both sides' chara / moon / palette): enough for
// its files (wantFor) before the tape itself has come
function liveHeadOf(info) {
  const rep = new Uint8Array(0x5C), dv = new DataView(rep.buffer);
  rep.set(new TextEncoder().encode('MBAAReplayFile'));
  dv.setInt32(0x28, info.stage, true);
  for (const q of [0, 1]) [info.chara[q], info.moon[q], info.color[q]].forEach((v, k) => dv.setInt32(0x40 + 0x10 * q + 4 * k, v, true));
  repStageFix(rep);
  return rep;
}
// the files start() fetches for a live game of this setup (its plan and the retry menu's BGM)
function liveWantOf(info) {
  if (!man || !info || info.css || !info.chara) return null;
  const want = wantFor(liveHeadOf(info));
  if (want) for (const p of liveCssFiles(man)) if (/^bgm\//.test(p)) want.add(p);
  return want;
}
// records (rec's format) into a map index -> record, a later copy of an index (longer: more frames) over an earlier one
function liveRecsPut(map, b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let o = 0; o + 244 <= b.length;) {
    const n = 244 + 4 * dv.getUint32(o + 240, true), i = dv.getUint32(o, true), old = map.get(i);
    if (o + n > b.length) break;
    if (!old || old.length <= n) map.set(i, b.slice(o, o + n));
    o += n;
  }
}
const liveRecsBytes = map => {
  const parts = [...map.keys()].sort((x, y) => x - y).map(i => map.get(i)), out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
// id: the host's live id. match: the match key the start must be (a fallback start of the session's own match, a game
// it fell behind on): the host on another match by then is not that match, so ours has ended: the next-match card.
// entry: the list entry the click came from (the live list, the next-match card): no list read before the start.
// The requests that do not depend on each other go out together: the join (or the boot tape and the first records), the
// match's files (known from the entry's setup), and a check of a stale entry against the list
async function startLive(id, match = null, entry = null) {
  bootMark('startLive');
  let info = null, all = null, boot = null, first = null, ext = null, snapQ = null;
  liveWant = id;
  if (entry && entry.id === id && !entry.css) liveFiles(entry);  // (with the join: the setup is the entry's but after a select)
  const jp = liveJoinPress && liveJoinPress.id === id && performance.now() - liveJoinPress.at < SNAP_PRE_MS ? liveJoinPress : null;
  liveJoinPress = null;
  if (jp) jp.used = true;
  if (liveReqs && liveReqs.id === id) liveReqs.used = true;
  const pre = jp ? jp.pre : livePre.get(id);
  const j = jp ? await jp.p : await liveJoin(id, pre && pre.recs.size ? { have: pre.game, since: pre.last, v: true } : { v: true });
  if (liveWant !== id) return;
  if (j && j.entry) {
    info = j.entry; ext = j.ext;
    if (!info.css) {
      boot = j.boot;
      const map = pre && pre.game === j.game && j.from > j.game ? new Map(pre.recs) : new Map();
      liveRecsPut(map, j.rec);
      first = Promise.resolve({ bytes: liveRecsBytes(map), ext });
    }
  } else if (j && !j.entry) {
    try { all = await liveList(); } catch (e) {}
    if (liveWant !== id) return;
  } else {
    const fresh = entry && entry.id === id && liveListLast && performance.now() - liveListLast.at < LIVE_FRESH;
    const listP = fresh ? null : liveList();
    if (fresh || entry) info = { ...entry };
    if (!fresh) {
      // (a stale entry: its game's tape, records and files are asked for meanwhile; the list's game decides)
      if (info && !info.css) liveStartReqs(id, info);
      try { all = await listP; info = all.find(m => m.id === id); } catch (e) { status(`live feed unreachable: ${e.message}`); return liveRetry(id, match); }
      if (liveWant !== id) return;
      if (info && entry && (info.game !== entry.game || info.css)) liveReqs = null;  // (another game by now)
    }
  }
  swMark('list', true, id);
  {  // (the card: the match's newest entry, a later game than the click's; none, a select: the engine's)
    const was = JSON.stringify(cardMeta);
    cardSet(info && !(match && info.match && info.match !== match) ? info : null);
    if (JSON.stringify(cardMeta) !== was) cardDraw();
  }
  if (info && match && info.match && info.match !== match) {
    status('the match has ended');
    if (!all) try { all = await liveList(); } catch (e) { all = []; }
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
      if (nextCardShow(null, all || [], 'That match has ended')) return;
    }
    return liveNet.recent() ? liveRetry(id, match) : undefined;
  }
  // (the same match again (a fallback start): the streaks go on from the session's where the bridge has none for the game
  // (its game over: not mid-battle of an older one)
  // (on its first character select: no game to play yet; waits on the list until the first game loads)
  // (liveCss: the match key on its character select, for chat's channel: the session still on screen is the host's match
  // before, and its key showed that match's old chat, user 2026-11-03)
  if (info.css) {
    liveCss = { id, match: info.match || null };
    status('on character select: the match starts with its first game');
    // (counted as its viewer meanwhile: the bridge counts the tabs asking for a match's records, and a tab waiting on a
    // character select asked for none, so the count halved at every new set until its first game loaded. The join counted it)
    if (!j) liveFetch(`${LIVE}/live/${id}/rec?from=-1&v=${VIEWER}` + (info.match ? `&match=${encodeURIComponent(info.match)}` : '')).catch(() => {});
    return liveRetry(id, match);
  }
  liveCss = null;
  const prev = session;
  // (the match kept warm when the page left it (liveKeepTake): back to it from its keyframe, if its game is still the
  // list's and it was kept on this instance)
  const K = liveKept;
  if (K && K.id === id && K.match === (info.match || null)) {
    if (K.game === info.game && prev && prev.M === K.M && Date.now() - K.at <= KEEP_MS) return liveResumeStart(K, prev);
    liveKeptDrop(K.game !== info.game ? `its game moved on (${K.game} -> ${info.game})` : 'not resumable');
  }
  // (the same match: the host's next match on the same id has its own streaks)
  if (!info.streak && prev && prev.M && liveOurs(info, prev.liveSrc) && prev.streakKnown && prev.M.HEAP32[0x54EEE8 >> 2] !== 1)
    info.streak = STREAK.map(a => prev.M.HEAP32[a >> 2]);
  if (!boot) {
    const q = liveReqs && liveReqs.id === id && liveReqs.game === info.game && performance.now() - liveReqs.at < SNAP_PRE_MS ? liveReqs : liveStartReqs(id, info);
    liveReqs = null;
    snapQ = q.snap;
    const r = await q.boot;
    if (r && r.ok) liveExtSet(id, ext = r.headers.get('X-Live-Ext'));
    if (liveWant !== id) return;
    if (!r || !r.ok) { status(`live match: ${r ? `HTTP ${r.status}` : 'unreachable'}`); return !r || r.status >= 500 ? liveRetry(id, match) : undefined; }
    boot = new Uint8Array(await r.arrayBuffer());
    first = q.first;
  } else {
    liveExtSet(id, ext);
    liveFiles(info);  // (the files: from the setup, while start() reads the tape)
  }
  swMark('bootRep', true, id);
  bootMark('bootRep');
  if (liveWant !== id) return;
  // (the live match being left for another: kept warm for a switch back)
  if (prev && prev.liveSrc && prev.liveSrc.id !== id) liveKeepTake(prev);
  liveSrc = { id, info, since: info.game, first, fresh: true, snapP: snapQ || liveSnapFetch(id, info) };
  window.__mbaaRepUrl = null;
  // (a switch from a match on screen: quiet, the old picture held until the new match's first frame is drawn and
  // crossfaded into it, not the opening movie; a first load: the movie)
  await start(new File([boot], `LIVE ${info.names.map(n => n.trim()).join(' vs ')}`), session && session.M ? 'switch' : false, id);
}
// a start's requests without the join: the boot tape, the first records (the poll's first request, sent now) and the files
let liveReqs = null;
// A press on a live card (goal D, user ruling 2026-11-06): the join request (the bridge's /join: the entry, the boot
// tape, the records; it counts this tab as the match's viewer) goes on the press, not the tap (~0.1 s and one bridge
// round trip earlier); a bridge without /join: the start's requests (liveStartReqs). The tap's startLive takes it within
// SNAP_PRE_MS. A press that never became a tap (a scroll, a press let go elsewhere): after PRESS_LEAVE_MS the tab is
// taken off that match's viewers again (/live/<id>/leave), so the count settles. (The snapshot and the files: the
// card prefetch on the same pointerdown, liveCardPrefetch)
const PRESS_LEAVE_MS = 3000;
let liveJoinPress = null;  // {id, game, at, p, used}
function livePress(m) {
  if (m.css || liveIdle(m) || (session && session.liveSrc && session.liveSrc.id === m.id)) return;
  const now = performance.now();
  if (liveJoinPress && liveJoinPress.id === m.id && liveJoinPress.game === m.game && now - liveJoinPress.at < SNAP_PRE_MS) return;
  if (liveReqs && liveReqs.id === m.id && liveReqs.game === m.game && now - liveReqs.at < SNAP_PRE_MS) return;
  let P;
  if (liveJoinOk) {
    const pre = livePre.get(m.id);
    P = liveJoinPress = { id: m.id, game: m.game, at: now, used: false,
      p: liveJoin(m.id, pre && pre.recs.size ? { have: pre.game, since: pre.last, v: true } : { v: true }), pre };
    liveFiles(m);
  } else P = liveStartReqs(m.id, m);
  wTimeout(() => {
    if (P.used || liveWant === m.id || (session && session.liveSrc && session.liveSrc.id === m.id)) return;
    if (liveJoinPress === P) liveJoinPress = null;
    if (liveReqs === P) liveReqs = null;
    liveFetch(`${LIVE}/live/${m.id}/leave?v=${VIEWER}`).catch(() => {});
  }, PRESS_LEAVE_MS);
}
function liveStartReqs(id, info) {
  const rec = `${LIVE}/live/${id}/rec?from=${info.game}&since=${info.game}&v=${VIEWER}` + (info.match ? `&match=${encodeURIComponent(info.match)}` : '');
  const q = liveReqs = { id, game: info.game, at: performance.now(), boot: liveFetch(`${LIVE}/live/${id}/boot.rep?game=${info.game}`).catch(() => null),
    first: liveFetch(rec).then(async r => r.ok ? { bytes: new Uint8Array(await r.arrayBuffer()), ext: r.headers.get('X-Live-Ext') } : null).catch(() => null),
    snap: liveSnapFetch(id, info) };
  liveFiles(info);
  return q;
}
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
function liveSnapFetch(id, info, fresh) {
  // (one fetched for its card a moment ago (liveCardPrefetch: a hover, a touch): that one)
  const pre = fresh ? null : snapPre.get(id);
  snapPre.delete(id);
  if (pre && pre.game === info.game && performance.now() - pre.at < SNAP_PRE_MS) return pre.p;
  // (60 s, not liveFetch's 10: its timeout covers the body too, and the ~1.4 MB snapshot on a slow line takes longer)
  return liveFetch(`${LIVE}/live/${id}/snap?game=${info.game}` + (info.match ? `&match=${encodeURIComponent(info.match)}` : ''),
                   AbortSignal.timeout ? { signal: AbortSignal.timeout(60000) } : undefined)
    .then(async r => r.ok ? { bytes: new Uint8Array(await r.arrayBuffer()), frame: +r.headers.get('X-Snap-Frame'), age: +r.headers.get('X-Snap-Age'), got: performance.now() } : null)
    .catch(() => null);
}
// A card the viewer is about to tap (pointer over it, a touch starting on it, keyboard focus): its match's snapshot asked
// for now (the bridge makes a fresh one if its newest is old: cc_live.mjs SNAP_FRESH_MS) and its game's files into the
// disk cache, so the tap finds both. Once per card per SNAP_PRE_MS; nothing with Save-Data / 2G (livePreOff). The list's
// first card gets its files only (no snapshot) when the list shows, on desktop (LOWMEM / a phone: on its touch alone).
const SNAP_PRE_MS = 4000, snapPre = new Map(), cardWarm = new Set(), cardHot = [];
// The decoded files of the cards most likely tapped (hovered, pressed, or preloaded: livePreloadAll), beside the
// session's and the prewarmed engine's: at most HOT_N matches and HOT_MB MB of decoded files (the oldest go first); kept
// through the session's own cache prunes (cachePinned)
const HOT_N = 4, HOT_MB = 320;
function cardHotAdd(key, want) {
  const at = cardHot.findIndex(([k]) => k === key);
  if (at >= 0) cardHot.splice(at, 1);
  cardHot.push([key, want]);
  cardHotTrim();
}
function cardHotTrim() {
  const mb = () => { const seen = new Set(); let b = 0;
    for (const [, w] of cardHot) for (const p of w) if (!seen.has(p)) { seen.add(p); const d = cache.get(p); if (d) b += d.byteLength; }
    return b / 1048576; };
  let drop = false;
  while (cardHot.length > HOT_N || (cardHot.length > 1 && mb() > HOT_MB)) { cardWarm.delete(cardHot.shift()[0]); drop = true; }
  if (drop) cachePrune(new Set([...((session && session.want) || []), ...((man.plan && man.plan.boot) || []), ...cardHot.flatMap(([, w]) => [...w])]));
}
// Live-match preload (goal D, user ruling 2026-11-06): when the live list shows or updates, each live match's files (its
// list entry: stage, characters, moons, palettes) at idle, one match at a time, the list's order (the likeliest tap
// first): desktop decoded into memory (cardHot: at most HOT_N matches / HOT_MB MB); low memory (phones) into the disk
// cache only (a match's decoded files are ~50-80 MB, past a phone's 16-24 MB budget; a tap then decodes them in the
// worker pool). Matches gone from the list leave cardHot. Nothing on Save-Data / 2G (livePreOff); ?preload=0: off
// (the hover / press prefetch stays).
const PRELOAD = Q.get('preload') !== '0';
let preloadRun = null;
function livePreloadAll(list) {
  if (!PRELOAD || livePreOff() || !man || !list) return;
  const ids = new Set(list.map(m => m.id));
  const gone = cardHot.filter(([k]) => !ids.has(JSON.parse(k)[0]));
  if (gone.length) { for (const [k] of gone) { cardWarm.delete(k); cardHot.splice(cardHot.findIndex(([x]) => x === k), 1); } cardHotTrim(); }
  const todo = list.filter(m => !m.css && !liveIdle(m) && !(session && session.liveSrc && session.liveSrc.id === m.id)).slice(0, LOWMEM ? 8 : HOT_N);
  const run = preloadRun = {};   // (a newer list's run takes over)
  (async () => {
    for (const m of todo) {
      if (preloadRun !== run) return;
      await new Promise(r => window.requestIdleCallback ? requestIdleCallback(() => r(), { timeout: 2000 }) : setTimeout(r, 200));
      const key = JSON.stringify([m.id, m.game, m.stage, m.chara, m.moon, m.color]);
      if (cardWarm.has(key)) continue;
      const want = liveWantOf(m);
      if (!want) continue;
      cardWarm.add(key);
      if (LOWMEM) { await warmDisk(man, want).catch(() => {}); continue; }
      // (one already preloaded stays where it is: a preload never pushes out a card the viewer hovered)
      cardHot.unshift([key, want]);
      cardHotTrim();
      if (!cardHot.some(([k]) => k === key)) { cardWarm.delete(key); continue; }
      await fetchAll(man, want, '', true).catch(() => {});
      cardHotTrim();
    }
  })().catch(e => console.warn('live preload:', e));
}
function liveCardPrefetch(m, snap = true) {
  if (livePreOff() || !m || m.css || liveIdle(m)) return;
  const key = JSON.stringify([m.id, m.game, m.stage, m.chara, m.moon, m.color]);
  // (desktop: decoded into the page's file cache, so a tap finds them ready, not only on disk: the decode of a match's
  // files was ~0.55 s of a desktop tap, goal D; low memory: the disk only)
  if (!cardWarm.has(key)) {
    cardWarm.add(key);
    const want = liveWantOf(m);
    if (want && LOWMEM) warmDisk(man, want).catch(() => {});
    else if (want) {
      cardHotAdd(key, want);
      fetchAll(man, want, '', true).then(cardHotTrim, () => {});
    }
  }
  const pre = snapPre.get(m.id);
  if (!snap || (pre && pre.game === m.game && performance.now() - pre.at < SNAP_PRE_MS)) return;
  const p = liveSnapFetch(m.id, m);
  if (p) snapPre.set(m.id, { game: m.game, p, at: performance.now() });
}
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
  let f = M._viewer_frame(), stalls = 0, stallAt = 0, stepMs = 0, slow = [];
  const f0 = f, tw = performance.now();
  // (desktop: the load's sprite pages coded after the join, viewer_encode_later; the same store contents)
  const encLater = ENC_LATER && !!M._viewer_encode_later;
  if (encLater) M._viewer_encode_later(1, ENC_BUDGET * 1048576);
  try {
  while (!base() && session === s) {
    const ta = performance.now(), g = M._viewer_step(1), d = performance.now() - ta;
    stepMs += d;
    if (d > 8 && slow.length < 24) slow.push(`${g}:${Math.round(d)}`);
    // (held: the match's files, the stream. Waited for by time, not turns: 600 message-channel turns were well under
    // a second, so a join that crossed a character select into a new pair gave up while that pair's files were still
    // downloading, and the next steps read them missing: "21 game files were missing", then index out of bounds, user
    // 2026-11-07. A stream that stops is the poll's to handle)
    if (g === f) { if (!stalls++) stallAt = performance.now(); else if (performance.now() - stallAt > 60000) break;
                   await new Promise(r => setTimeout(r, stalls < 50 ? 0 : 20)); continue; }
    stalls = 0;
    f = g;
    if (f % 60 === 0) await cuTurn();
  }
  } finally { if (encLater) M._viewer_encode_later(0, 0); }
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
// the match's files, from its setup, into the cache (start() waits on the same fetches)
function liveFiles(info) {
  const want = liveWantOf(info);
  if (want) fetchAll(man, want, '', true).catch(() => {});
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
// the catch-up's steps: ~STEP_SLICE_MS of game each (the frame cost measured as it goes), so the page gets turns
const STEP_SLICE_MS = 12;
function stepSlicer() {
  let per = 0.5;  // ms per frame, measured (a first slice of 24 frames)
  return {
    n: () => Math.max(1, Math.min(600, Math.floor(STEP_SLICE_MS / per))),
    took(ms, frames) { if (frames > 0) per = Math.max(0.02, 0.5 * per + 0.5 * (ms / frames)); },
  };
}
// a real task turn: a message, then a timer (queued behind the timers, network and worker tasks already waiting)
const taskTurn = () => new Promise(r => { const ch = new MessageChannel(); ch.port1.onmessage = () => setTimeout(r, 0); ch.port2.postMessage(0); });
// a short yield (scheduler.yield: its continuation runs ahead of other tasks; else a timer)
const yieldTask = () => (globalThis.scheduler && typeof scheduler.yield === 'function') ? scheduler.yield() : new Promise(r => setTimeout(r, 0));
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
// The player block (spectating): per side the character's select-screen icon in its animated 1P / 2P cursor frame, the
// player's name, the moon and character. The art is the select screen's own (grp/c_sel_aa: icons 48x64, the large row
// set from row 4; cursor frames 64x64, P1 0-9 and P2 10-19, the 1P / 2P tags 20 / 21; moon icons 56x56 at y 288),
// placed as CharaSelectIcons_Draw does (the icon cell from the game's chara -> cell table). The characters come from the
// battle slots, so a game after a character select shows its new picks.
const ICON_CELL = 0x5519F8, BSLOT = 0x74D838, MOON_NAME = ['Crescent', 'Full', 'Half'];
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
// ---- the site's look (gx: MBAACC's, redrawn in CSS / SVG; web/shell/gx/, user 2026-11-07 "ship it"): index.html loads
// gx.css and sets the theme before the first paint; here ?theme=dark|light|auto (auto: the device's), the settings menu's
// theme row, the device's own switch while on auto, and the moon marks (gx/moons.svg, drawn at the canvas's resolution).
const GX = (() => {
  // dark unless the viewer chose (user 2026-11-07); only a choice is stored (mbaaTheme2). The old mbaaTheme was written as
  // 'auto' on every visit, so only an explicit dark / light in it carries over (theme.js does the same before first paint)
  let th = 'dark';
  try {
    const q = new URLSearchParams(location.search);
    if (/^(dark|light|auto)$/.test(q.get('theme') || '')) localStorage.setItem('mbaaTheme2', q.get('theme'));
    localStorage.removeItem('mbaaUi');  // (the trial's switch, gone)
    const o = localStorage.getItem('mbaaTheme');
    th = localStorage.getItem('mbaaTheme2') || (o === 'light' || o === 'dark' ? o : 'dark');
  } catch (e) {}
  const root = document.documentElement, mq = matchMedia('(prefers-color-scheme: light)');
  const g = { theme: th, moons: new Image() };
  g.apply = (t, save = true) => {
    g.theme = t; if (save) try { localStorage.setItem('mbaaTheme2', t); } catch (e) {}
    root.dataset.theme = t === 'auto' ? (mq.matches ? 'light' : 'dark') : t;
    const tc = document.querySelector('meta[name=theme-color]');   // (the phone browser's address bar in the theme's background)
    if (tc) tc.content = root.dataset.theme === 'light' ? '#f6f2ff' : '#0d0620';
  };
  mq.addEventListener('change', () => { if (g.theme === 'auto') g.apply('auto', false); });
  g.apply(th, false);
  g.moons.onload = () => { plKey = ''; for (const cv of document.querySelectorAll('canvas[data-moon]')) drawMoon(cv, +cv.dataset.moon); };
  g.moons.src = 'gx/moons.svg';
  return g;
})();
// a moon mark (canvas, the 56x56 select-sheet cell scaled; gx: gx/moons.svg's four 48-unit cells)
function drawMoon(cv, m) {
  const x = cv.getContext('2d');
  x.clearRect(0, 0, cv.width, cv.height);
  cv.dataset.moon = m;
  const k = m >= 0 && m <= 2 ? m : m === 9 ? 3 : -1;
  // (until the SVG is in: nothing; its onload draws every moon canvas)
  // (the cell's 48 units minus 3 of empty glow margin each side: the disc fills the canvas; the live list's moons
  // showed ~4 px of blank to their left, user 2026-11-07)
  if (GX.moons.complete && GX.moons.naturalWidth && k >= 0) { const w = GX.moons.naturalWidth / 4, h = GX.moons.naturalHeight, in_ = w * 3 / 48;
    x.drawImage(GX.moons, k * w + in_, in_, w - 2 * in_, h - 2 * in_, 0, 0, cv.width, cv.height); }
}
// this tab's random id, sent with live record requests: the feed counts the tabs watching each match (nothing else)
const VIEWER = Array.from(crypto.getRandomValues(new Uint8Array(12)), b => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
let plArt = null, plKey = '', plCells = [-1, -1];
// ---- the match card from metadata (SWITCH_PLAN.md phase 2) ----
// A live switch draws the card at the click from the live-list entry clicked (stage, characters, moons, colours, names:
// cc_live.mjs setupFor), not from the engine's memory, which has nothing for the new match until it has booted and caught
// up. cardMeta is that match's setup; the card shows it for the old session still on screen and for the new one until
// it is live (s.cardLive: caught up and following). Then it is the engine's again (it is authoritative: a character
// select followed, a stage stand-in); the same data give the same keys (plKey / stageKey), so nothing is redrawn and
// nothing jumps unless the data differ. The art comes preloaded (cardPreload, from every list read), so the click draws
// it in the same frame; xfInstant: no crossfade from the old match's card (it showed the old card ~80% for 100 ms).
let cardMeta = null, xfInstant = false;
function cardSet(m) {
  if (!m || !Array.isArray(m.chara) || m.css) { cardMeta = null; return; }
  cardMeta = { id: m.id, game: m.game, stage: m.stage, chara: m.chara.slice(), moon: (m.moon || []).slice(), color: (m.color || []).slice(),
               names: (m.names || []).slice(), streak: m.streak || null };
}
// the card's source for session s: the click's metadata, or null (the engine's memory)
function cardMetaFor(s) {
  const C = cardMeta;
  if (!C) return null;
  if (!s || !s.M || !s.liveSrc || s.liveSrc.id !== C.id) return C;  // (the old match still on screen, or none yet)
  if (s.cardLive || s.liveSrc.info.game !== C.game) { cardMeta = null; return null; }  // (live, or a later game: the engine's)
  return C;
}
const cardStageId = id => stageOk(id) ? id : stageStandIn(id);  // (what the engine plays: repStageFix)
// draw the card now (a click, a new entry for the match): not on the next 500 ms tick
function cardDraw(instant = false) {
  xfInstant = instant;
  try {
    stageShow(session).catch(() => {});
    if (plArt) playersShow(session); else playersArt().then(() => playersShow(session)).catch(() => {});
  } finally { xfInstant = false; }
}
// the stage art per stage id, decoded once: {view, name} blob URLs (the name plate trimmed), or a promise of them
const stageArt = new Map();
function stageArtGet(id) {
  if (stageArt.has(id)) return stageArt.get(id);
  const st = stagePanel && stagePanel.stages[id];
  if (!st || !man) return null;
  const n = String(id).padStart(2, '0'), paths = st.art.map(k => `web/stage/${k}_${n}.png`).filter(p => man.files[p]);
  const pr = (async () => {
    await fetchAll(man, paths, '', true);
    const art = {};
    for (const k of ['view', 'name']) {
      const d = cache.get(`web/stage/${k}_${n}.png`);
      let blob = d ? new Blob([d], { type: 'image/png' }) : null;
      // the name plate's text sits left in a wider sheet cell: cropped to its drawn pixels so the plate centres on the card
      if (blob && k === 'name') try { blob = await trimAlpha(blob); } catch (e) {}
      art[k] = blob ? URL.createObjectURL(blob) : '';
      if (art[k]) await imgReady(art[k]);
    }
    stageArt.set(id, art);
    return art;
  })();
  pr.catch(() => stageArt.delete(id));
  stageArt.set(id, pr);
  return pr;
}
// a blob URL decoded once ahead (the card's <img> then paints it in the frame it is set)
const imgReady = url => { const i = new Image(); i.src = url; return (i.decode ? i.decode() : Promise.resolve()).catch(() => {}); };
// the splash with its shadow drawn in, once (it was the card's CSS filter: drop-shadow(0 0 8px #000c), redone in every
// frame the aura canvas under it changed: Firefox under software WebRender 46 fps with it, 91 drawn in (live page, a replay
// playing, tools/web/ff_por_live.mjs), a viewer's lag
// report 2026-11-09). Canvas shadowBlur is CSS's blur (sigma = blur / 2), drawn in the
// splash's own pixels (the card shows it at ~1x on desktop)
async function porShadowed(blob) {
  const bm = await createImageBitmap(blob);
  const cv = document.createElement('canvas'); cv.width = bm.width; cv.height = bm.height;
  const x = cv.getContext('2d');
  x.shadowColor = 'rgba(0, 0, 0, 0.8)'; x.shadowBlur = 8;
  x.drawImage(bm, 0, 0); bm.close();
  const out = await new Promise((res, rej) => cv.toBlob(b => (b ? res(b) : rej(new Error('portrait shadow'))), 'image/png'));
  return URL.createObjectURL(out);
}
// a splash's blob URL (porUrls), loaded and decoded once
const porLoading = new Map();
function porLoad(path) {
  if (porUrls.has(path)) return Promise.resolve(porUrls.get(path));
  if (porLoading.has(path)) return porLoading.get(path);
  const pr = (async () => {
    await fetchAll(man, [path], '', true);
    const d = cache.get(path);
    if (!d) throw new Error('no data');
    const u = await porShadowed(new Blob([d], { type: 'image/png' }));
    await imgReady(u);
    porUrls.set(path, u);
    return u;
  })().finally(() => porLoading.delete(path));
  porLoading.set(path, pr);
  return pr;
}
// every listed match's card art (stage picture and plate, both splashes; the select sheet; the track title is data),
// one file at a time in idle time, so it never competes with a match loading. A phone (LOWMEM): the first 4 listed.
let cardPreQ = [], cardPreRun = false;
function cardPreload(list) {
  const want = [];
  for (const m of (list || []).filter(m => Array.isArray(m.chara) && !m.css).slice(0, LOWMEM ? 4 : 32)) {
    want.push(['s', cardStageId(m.stage)]);
    for (const c of m.chara) { const p = porPath(c); if (p) want.push(['p', p]); }
  }
  const have = new Set(cardPreQ.map(x => x.join()));
  for (const x of want) if (!have.has(x.join()) && !(x[0] === 's' ? stageArt.get(x[1]) && !(stageArt.get(x[1]) instanceof Promise) : porUrls.has(x[1]))) { cardPreQ.push(x); have.add(x.join()); }
  if (cardPreRun || !cardPreQ.length) return;
  cardPreRun = true;
  const idle = () => new Promise(r => window.requestIdleCallback ? requestIdleCallback(() => r(), { timeout: 500 }) : setTimeout(r, 50));
  (async () => {
    try {
      await playersArt().catch(() => {});
      for (let x; (x = cardPreQ.shift());) {
        await idle();
        try { await (x[0] === 's' ? stageArtGet(x[1]) : porLoad(x[1])); } catch (e) {}
      }
    } finally { cardPreRun = false; }
  })();
}
async function playersArt() {
  if (plArt) return plArt;
  const art = ['grp/c_sel_aa/csel_icon00.png', 'grp/c_sel_aa/csel_cursor00.png'];
  if (!man || !art.every(p => man.files[p])) return null;
  await fetchAll(man, art, '', true);  // (a replay's plan has no select screen)
  const img = async p => { const d = cache.get(p); return d ? createImageBitmap(new Blob([d], { type: 'image/png' })) : null; };
  const [icons, cursor] = await Promise.all([img('grp/c_sel_aa/csel_icon00.png'), img('grp/c_sel_aa/csel_cursor00.png')]);
  if (!icons || !cursor) return null;
  plArt = { icons, cursor };
  cselArt().catch(() => {});  // (the name art and the ring: after, never holding the card)
  return plArt;
}
// ---- the select screen's own art on the card (user 2026-11-08) ----
// Each side's character line is the select screen's name art, Japanese over romaji (CharacterSelectScene_Render
// 0x48A720: csel_name00_<side> 168x32 cells, 16 a column; csel_name01_<side> 168x24, 21 a column; side 0's sheets left
// aligned, side 1's right aligned), the moon its icon alone. Under the VS, behind the splashes, the select screen's centre
// ring and its rising particles, the game's code (CharaSelectAura_Update 0x487E60 / _Draw 0x4881C0) with our own random
// numbers, stepped once per game frame. RE notes: harness-design/card_css_art/RE.md
const CSEL_NAME_CELL = { 16: 29, 17: 16, 18: 17, 19: 18, 20: 19, 22: 20, 23: 21, 25: 22, 28: 23, 29: 24, 30: 25, 31: 26, 32: 27, 33: 28, 34: 29, 35: 30, 51: 31 };
const cselCell = c => (c >= 0 && c <= 15 ? c : CSEL_NAME_CELL[c] ?? -1);
const CSEL_FILES = ['csel_name00_0', 'csel_name00_1', 'csel_name01_0', 'csel_name01_1', 'csel_ef00', 'csel_part00'].map(f => `grp/c_sel_aa/${f}.png`);
let cselA = null;
async function cselArt() {
  if (cselA) return cselA;
  if (!man || !CSEL_FILES.every(p => man.files[p])) return null;
  await fetchAll(man, CSEL_FILES, '', true);
  const bm = await Promise.all(CSEL_FILES.map(p => { const d = cache.get(p); return d ? createImageBitmap(new Blob([d], { type: 'image/png' })) : null; }));
  if (bm.some(b => !b)) return null;
  cselA = { jp: [bm[0], bm[1]], ro: [bm[2], bm[3]], ring: bm[4], parts: bm[5] };
  plKey = ''; playersShow(session);  // (the names drawn again, as art)
  auraStart();
  return cselA;
}
// a side's name art (168 x 56: Japanese over romaji) into its canvas; false: none for this character
function cselName(cv, p, c) {
  const k = cselCell(c);
  if (!cselA || k < 0) return false;
  cv.width = 168; cv.height = 56;
  const x = cv.getContext('2d');
  x.clearRect(0, 0, 168, 56);
  x.drawImage(cselA.jp[p], 168 * (k >> 4), 32 * (k & 15), 168, 32, 0, 0, 168, 32);
  x.drawImage(cselA.ro[p], 168 * Math.floor(k / 21), 24 * (k % 21), 168, 24, 0, 32, 168, 24);
  return true;
}
// the ring and particles: CharaSelectAura_Update, f32 where the game keeps f32; the random numbers a subtractive
// generator of our own (the game draws its battle stream; ours is the card's alone)
const F32 = Math.fround;
function subRng(seed) {
  const M = 0x80000000, ma = new Array(56).fill(0);
  let mj = (161803398 - Math.abs(seed)) % M, mk = 1;
  ma[55] = mj;
  for (let i = 1; i <= 54; i++) { const ii = (21 * i) % 55; ma[ii] = mk; mk = mj - mk; if (mk < 0) mk += M; mj = ma[ii]; }
  for (let k = 0; k < 4; k++) for (let i = 1; i <= 55; i++) { ma[i] -= ma[1 + ((i + 30) % 55)]; if (ma[i] < 0) ma[i] += M; }
  let a = 0, b = 31;
  return () => { if (++a === 56) a = 1; if (++b === 56) b = 1; let j = ma[a] - ma[b]; if (j < 0) j += M; ma[a] = j; return j; };
}
const aura = { cv: null, n: 0, timer: 0, rng: subRng(20261108), lastF: null, raf: 0,
  rings: Array.from({ length: 4 }, () => ({ state: 0, t: 0, scale: 0, ds: 0, fade: 0 })),
  parts: Array.from({ length: 20 }, () => ({ on: 0, kind: 0, dir: 0, t: 0, rise: 0, phase: 0, speed: 0 })) };
function auraStep(A) {
  const f = A.n++;
  if (f % 60 === 0) { const r = A.rings.find(r => !r.state); if (r) Object.assign(r, { state: 1, t: 0, scale: F32(0.1), ds: F32(0.05), fade: 0 }); }
  for (const r of A.rings) {
    if (!r.state) continue;
    if (r.state === 1) { r.fade = F32(r.fade + F32(1 / 30)); if (r.fade > 1) { r.state = 10; r.fade = 1; r.t = 0; } }
    else if (r.state === 10) { if (r.t > 60) { r.state = 100; r.t = 0; } }
    else if (r.state === 100) { r.fade = F32(r.fade - F32(1 / 30)); if (r.fade <= 0) { r.state = 0; r.fade = 0; r.t = 0; continue; } }
    r.t++; r.scale = F32(r.scale + r.ds); r.ds = F32(r.ds * F32(0.98));
  }
  if (A.timer <= 0) {
    const p = A.parts.find(p => !p.on);
    if (p) { const R = A.rng; Object.assign(p, { on: 1, kind: R() % 2, dir: R() % 2, speed: F32(R() * 4.656612875e-10 + 0.8), t: 0, rise: 0, phase: 0 }); A.timer = R() % 90 + 20; }
  }
  A.timer--;
  for (const p of A.parts) {
    if (!p.on) continue;
    p.rise = F32(p.rise + p.speed);
    if (p.rise > 480) { p.on = 0; continue; }
    if (p.dir) { p.phase = F32(p.phase - F32(0.005)); if (p.phase < 0) p.phase = F32(p.phase + 1); }
    else { p.phase = F32(p.phase + F32(0.005)); if (p.phase >= 1) p.phase = F32(p.phase - 1); }
    p.t++;
  }
}
// CharaSelectAura_Draw in the card's own 640 x 480 (its height the card's; x centred under the VS), additive
function auraDraw(A) {
  const cv = A.cv, dpr = window.devicePixelRatio || 1, w = Math.max(1, Math.round(cv.clientWidth * dpr)), h = Math.max(1, Math.round(cv.clientHeight * dpr));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  // (at the splashes' scale: a splash is 512 px on the select screen's 480, so the ring keeps its size against the
  // figures as there; its centre, the screen's (320, 420), on the VS)
  const card = cv.parentNode, cr = card.getBoundingClientRect(), por = card.querySelector('.por:not([hidden])'), vs = card.querySelector('#players .vs');
  // (capped by the card's width: on a narrow card the splash scale made the ring the card's whole width)
  const k = Math.min(por && por.offsetHeight ? por.offsetHeight / 512 : cr.height / 480, cr.width / 640 * 1.2) * dpr;
  const vr = vs ? vs.getBoundingClientRect() : null, cy = (vr && vr.height ? vr.top + vr.height / 2 - cr.top : cr.height * 0.85) * dpr;
  const x = cv.getContext('2d');
  x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, w, h);
  // (the names' dark band, drawn here under the ring: as the band's CSS background it covered the ring; .aura-on drops it)
  const pl = card.querySelector('#players');
  if (pl) {
    const r = pl.getBoundingClientRect(), y0 = (r.top - cr.top) * dpr, y1 = (r.bottom - cr.top) * dpr, g = x.createLinearGradient(0, y0, 0, y1);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(0.58, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.733)');
    x.globalCompositeOperation = 'source-over'; x.globalAlpha = 1; x.fillStyle = g; x.fillRect((r.left - cr.left) * dpr, y0, r.width * dpr, y1 - y0);
  }
  x.setTransform(k, 0, 0, k, w / 2 - 320 * k, cy - 420 * k);
  x.globalCompositeOperation = 'lighter'; x.imageSmoothingEnabled = true;
  for (const r of A.rings) {
    if (!r.state) continue;
    const rw = Math.trunc(r.scale * 128), rh = Math.trunc(r.scale * 24);
    x.globalAlpha = Math.trunc(r.fade * 255) / 255;
    x.drawImage(cselA.ring, 0, 0, 128, 128, Math.trunc((640 - rw) / 2), 420 - Math.trunc(rh / 2), rw, rh);
  }
  x.globalAlpha = 1;
  for (const p of A.parts) if (p.on)
    x.drawImage(cselA.parts, 16 * (p.kind + 19), 80, 16, 16, Math.trunc(Math.sin(p.phase * 360 * Math.PI / 180) * 24 + 320 - 8), Math.trunc(420 - p.rise - 8), 16, 16);
}
// one step per game frame (paused: still; a seek: the frames between, at most 2 s of them; no match: the card's own 60 Hz)
function auraStart() {
  const card = document.getElementById('matchcard');
  if (!card || aura.cv) return;
  const cv = document.createElement('canvas'); cv.className = 'aura'; cv.setAttribute('aria-hidden', 'true');
  card.insertBefore(cv, card.firstChild);
  aura.cv = cv; card.classList.add('aura-on');
  for (let i = 0; i < 150; i++) auraStep(aura);  // (already going when the card first shows, as on the select screen)
  let t0 = performance.now();
  const tick = now => {
    aura.raf = requestAnimationFrame(tick);
    if (document.hidden || !card.classList.contains('pors') || !cv.clientHeight) { aura.lastF = null; t0 = now; return; }
    let n;
    if (session && session.M) {
      const f = curFrame();
      n = aura.lastF === null ? 1 : f - aura.lastF;
      aura.lastF = f;
      if (n < 0) n = 1;  // (a seek back: on from here)
    } else { n = Math.floor((now - t0) / (1000 / 60)); t0 += n * (1000 / 60); aura.lastF = null; }
    if (n <= 0) return;
    for (let i = Math.min(n, 120); i > 0; i--) auraStep(aura);
    auraDraw(aura);
  };
  aura.raf = requestAnimationFrame(tick);
}
function playersShow(s) {
  const box = document.getElementById('players'), C = cardMetaFor(s);
  if (!C && (!s || !s.M)) { box.hidden = true; return; }
  const rows = box.querySelectorAll('.pl');
  const names = ((C ? C.names : s.liveSrc && s.liveSrc.info.names) || []).map(n => (n || '').trim());  // (a replay has none)
  const sides = C ? [0, 1].map(p => [C.chara[p], C.moon[p]])
    : [0, 1].map(p => [s.M.HEAP32[(BSLOT + p * 0x2C + 8) >> 2], s.M.HEAP32[(BSLOT + p * 0x2C + 0x14) >> 2]]);
  const key = JSON.stringify([sides, names]);
  if (key !== plKey && plArt) {
    plKey = key;
    sides.forEach(([c, m], p) => {
      const row = rows[p];
      plCells[p] = iconCell(c);
      drawMoon(row.querySelector('.moon'), m);
      const moon = m >= 0 && m <= 2 ? MOON_LABEL[m] : m === 9 ? 'Eclipse' : '';  // (9: the bosses' moon)
      row.querySelector('.nm .t').textContent = names[p] || CHARA[c] || `Player ${p + 1}`;
      // (the moon is its icon: the line beside it is the character, or with no player name the moon's name)
      row.querySelector('.ch .t').textContent = names[p] ? CHARA[c] || '' : moon;
      row.querySelector('.ch').title = `${moon} ${CHARA[c] || ''}`.trim();
      // (the select screen's name art in the line's place, the moon its icon alone, static: user 2026-11-08)
      const ch = row.querySelector('.ch');
      let art = ch.querySelector('canvas.cnm');
      if (!art) { art = document.createElement('canvas'); art.className = 'cnm'; art.setAttribute('aria-label', CHARA[c] || ''); ch.append(art); }
      const on = cselName(art, p, c);
      art.hidden = !on; ch.querySelector('.mqx').hidden = on; ch.classList.toggle('art', on);
      if (on) art.setAttribute('aria-label', CHARA[c] || '');
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
// Neco-Arc (20) and Neco-Arc Chaos (25): their splashes stand the figure in the image's lower half (head at row ~254 / 262
// of 512, the rest at ~40-150), so on the plain rule the head sat at the picture's foot or under it: raised (necoTV #5)
const POR_ADJ = { 20: { y: -55 }, 25: { y: -57 } };
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
    if (!porUrls.has(path)) { const inst = xfInstant; await porLoad(path); xfInstant = inst; }  // (preloaded: no wait)
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
// one select-screen icon as a strip of its 10 cursor frames (a 640x64 canvas inside the .ico / .lico box, which clips it):
// the character icon, side p's cursor frame f (of 10) and its P1/P2 tag per frame, drawn once per (icon, side); the
// animation then moves the strip by a transform from the frame bus (a compositor move: no 2D-canvas raster per step).
// Before, each icon canvas was cleared and redrawn 30 times a second: on the Moto G ~1 ms of CrGpuMain raster per
// redraw, 112-130 ms/s for four icons (phone runs e_trace_1107 / canvas_tally_1107)
function selStrip(box, cell, p) {
  let cv = box.firstElementChild;
  if (!cv) { cv = document.createElement('canvas'); cv.width = 640; cv.height = 64; box.append(cv); }
  const key = `${cell}/${p}`;
  if (box.dataset.strip === key) return;
  box.dataset.strip = key;
  const c = cv.getContext('2d'), tag = 20 + p;
  c.clearRect(0, 0, cv.width, cv.height);
  for (let f = 0; f < 10; f++) {
    const x = 64 * f, fr = 10 * p + f;
    if (cell >= 0) c.drawImage(plArt.icons, 48 * (cell % 10), (Math.floor(cell / 10) + 4) * 64, 48, 64, x + 8, 0, 48, 64);  // (centred in the frame, as CharaSelectIcons_Draw)
    c.drawImage(plArt.cursor, (fr % 8) * 64, Math.floor(fr / 8) * 64, 64, 64, x, 0, 64, 64);
    c.drawImage(plArt.cursor, (tag % 8) * 64, Math.floor(tag / 8) * 64, 64, 64, x, 0, 64, 64);
  }
}
// the strip's frame f shown (a box not rendered, e.g. the players' icons hidden on a phone: left alone; the visibility
// read forces style, so it is taken once per loop of the 10 frames, ~3 times a second: 180 reads/s cost 12 ms/s on the
// Moto G, join_phone_1107 profiles)
function selStep(box, cell, p, f) {
  if (f === 0 || box.__vis == null) box.__vis = box.checkVisibility ? box.checkVisibility() : box.offsetParent !== null;
  if (!box.__vis) return;
  selStrip(box, cell, p);
  const cv = box.firstElementChild, tr = `translateX(${-10 * f}%)`;
  if (cv.style.transform !== tr) cv.style.transform = tr;
}
let plAnimF = -1;
function playersAnimate(t) {
  const box = document.getElementById('players');
  const fNow = Math.floor(t * 60 / 2000) % 10;
  if (fNow === plAnimF) return;  // (the cursor frame changes 30 times a second)
  plAnimF = fNow;
  if (!box.hidden && plArt) box.querySelectorAll('.pl').forEach((row, p) => selStep(row.querySelector('.ico'), plCells[p], p, fNow));
  // the live list's icons too (each side's cursor, as on the select screen)
  if (plArt && !document.getElementById('livesec').hidden)
    for (const b of document.querySelectorAll('#liveitems .lico, #nextcard .lico')) selStep(b, +b.dataset.cell, +b.dataset.side, fNow);
}
frameBus.add(playersAnimate);
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
let oldRadioP = null, oldRadioFailed = false;
function radioOldLoad() {
  if (!man.files['web/radio/old.json']) return Promise.resolve(null);
  return oldRadioP || (oldRadioP = fetchAll(man, ['web/radio/old.json'], '', true).then(() => {
    const o = JSON.parse(new TextDecoder().decode(cache.get('web/radio/old.json')));
    o.byKey = {};
    for (const g of o.games) for (const t of g.tracks) o.byKey[`${g.id}:${t.id}`] = Object.assign(t, { game: g.id, title0: t.title });
    // (set once its titles are final: the chat's slugs come from them)
    return radioOverrides(o).then(() => (oldRadio = o));
  }).catch(e => { oldRadioFailed = true; throw e; }));
}
// the community's names and tiles for the older games' tracks ("Name the tracks", tools/web/track_tags.mjs): approved by
// the reviewers, public on the site root as /radio/overrides.json (the Worker; a local build has none), applied over
// old.json's, so an approval needs no bundle rebuild. A tile is the Worker's /radio/img/<name>.jpg.
async function radioOverrides(o) {
  try {
    const r = await fetch(new URL('/radio/overrides.json', new URL(BUNDLE, document.baseURI)), { cache: 'no-cache', signal: AbortSignal.timeout(4000) });
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
  radioExtTile();
}
// the "Match music" tile while a live match's extension has its own stage on (liveExtApi.stage): that stage's picture
let radioExtUrl = '';
function radioExtTile() {
  const a = document.querySelector('#radiogrid .tile[data-f=""] .art'), X = liveExt.stage;
  if (radioExtUrl) { URL.revokeObjectURL(radioExtUrl); radioExtUrl = ''; }
  if (!a) return;
  if (X && X.view) { radioExtUrl = URL.createObjectURL(X.view); a.style.backgroundImage = `url(${radioExtUrl})`; a.textContent = ''; a.parentNode.title = X.name; }
  else if (!a.dataset.src) { a.style.backgroundImage = ''; a.textContent = '♪'; a.parentNode.title = 'Match music'; }
}
// the tiles' pictures, fetched when the picker is open
let radioArtDone = false;
async function radioArt() {
  if (radioArtDone) return;
  radioArtDone = true;
  const tiles = [...document.querySelectorAll('#radiogrid .art[data-src]')].filter(e => !e.style.backgroundImage), path = e => e.dataset.src;
  await fetchAll(man, tiles.map(path).filter(p => !radioArtUrls.has(p)), '', true);
  for (const e of tiles) {
    const p = path(e), d = cache.get(p);
    if (!radioArtUrls.has(p) && d) radioArtUrls.set(p, URL.createObjectURL(new Blob([d], { type: /\.jpg$/.test(p) ? 'image/jpeg' : 'image/png' })));
    if (radioArtUrls.has(p)) e.style.backgroundImage = `url(${radioArtUrls.get(p)})`;
  }
}
// (one picture URL a tile: the grid is made again at every game switched to, and each had made new ones, never let go)
const radioArtUrls = new Map();
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
let xfYieldPending = false;  // (a pick's or a clear's swap with a live extension's page-drawn stage, to fade: radioStageSync)
// floatsis (user 2026-11-01): the music chosen apart from the stage. '' the stage's (the radio pick's track, else the
// match's own), 'match' the match's own whatever the pick, or a track (as radioTrack). Kept like the pick: a replay's
// for that replay, a live match's for its whole live match (musicLiveId; start).
let musicPick = '', musicLiveId = null, musicSel = null;
// the viewer's own music: the music chosen on its own, else the radio pick's track ('match': none)
const musicLocal = () => musicPick === 'match' ? null : musicPick ? musicSel : radio;
// (a live match's extension may bring its own music, liveExt below: it takes the match's music's place; the viewer's own
// pick still wins, as a radio pick's stage wins over the extension's stage (user 2026-11-08: a ♪ chip tapped on an AH3
// stage kept the AH3 music))
const musicNow = () => musicLocal() || liveExt.music;
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
    xfStagePending = xfYieldPending = true;
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
                stages: stageOnly ? [stageOnly] : t.stages || null, chip: !!stageOnly } : null;  // (a chat ^stage chip: that stage, not the track's first)
  if (session && session.radioChanged) session.radioChanged();
  stageKey = '';
  xfStagePending = xfYieldPending = true;
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
// (the chat's slugs come from the whole of both lists, so every viewer reads the same "!slug" / "^slug": empty until
// MBAACC's panel and the older games' radio are both in (the radio list fetched for this even if the panel never opens;
// it failing or missing: MBAACC's alone))
function mentionCatalog() {
  const wantOld = !!(man && man.files['web/radio/old.json']) && !oldRadio && !oldRadioFailed;
  if (stagePanel && wantOld) radioOldLoad().catch(() => {});
  const v = !stagePanel || wantOld ? 'loading' : `ok/${!!oldRadio}`;
  if (mentCat && mentCat.v === v) return mentCat;
  const songs = [], stages = [], seen = new Set();
  if (v !== 'loading') {
    for (const [f, x] of Object.entries(stagePanel.tracks)) if (x.loop) songs.push({ f, title: x.title, slugName: x.title, game: 'MBAACC' });
    for (const [id, st] of Object.entries(stagePanel.stages)) {
      const name = STAGE_NAMES[id];
      if (!name || !st.track || seen.has(name)) continue;  // (a stage plays its track's stage pick; a repeated plate: the first)
      seen.add(name);
      stages.push({ key: String(id), name, slugName: name.split(',')[0], game: 'MBAACC', f: st.track, thumb: st.art.includes('view') ? `web/stage/view_${String(id).padStart(2, '0')}.png` : '' });
    }
  }
  if (v !== 'loading' && oldRadio) for (const g of oldRadio.games) {
    const game = (RADIO_GAMES.find(([id]) => id === g.id) || [])[1] || g.id;
    for (const t of g.tracks) {
      // (slugs from the list's own titles: a title override (radioOverrides, fetched with a timeout) only renames the label)
      songs.push({ f: `${g.id}:${t.id}`, title: t.title, slugName: t.title0 || t.title, game });
      if (t.dat && t.stageName) stages.push({ key: `${g.id}:${t.id}`, name: t.stageName, slugName: t.stageName.split(',')[0], game, f: `${g.id}:${t.id}`, thumb: t.tileUrl || t.tile || '' });
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
// (the viewer's own radio pick names a stage: an older game's stage track, or an MBAACC track's stage, the match's own
// included)
// (a ^stage chip's pick always takes its stage: "stage changes" off is for the radio's track picks; user 2026-11-03,
// gaku's chip under a forced stage changed only the music)
const stageFollows = () => radioStageFollow || !!(radio && radio.chip);
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
frameBus.add(function radioStageLoop() { radioStageSync(session); });
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
  const can = !xfInstant && prev && src && prev !== src && !img.hidden && img.offsetWidth > 0 && img.complete && img.naturalWidth > 0
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
  const C = cardMetaFor(s);
  if (!stagePanel || (!C && (!s || !s.M))) { box.hidden = true; return; }
  // (the click's metadata: the stage and its own track; a radio / extension pick is the match's, after its start)
  const id = C ? cardStageId(C.stage) : radio && radio.stageNow ? radio.stageNow : s.M.HEAP32[STAGE_ID >> 2], st = stagePanel.stages[id];  // (an MBAACC pick's stage)
  const mu = C ? null : musicNow(), own = !C && musicPick === 'match' ? s.bgmNow : null;
  const f = mu ? mu.file : trackOf(own || (C ? null : s.bgmNow)) || (st && st.track), key = `${id}/${f}/${+stageFollows()}/${radio ? radio.file : ''}/${musicPick}/${liveExt.stage ? liveExt.stage.n : ''}`;
  if (key === stageKey) return;
  stageKey = key;
  const tr = mu ? mu : stagePanel.tracks[f];
  document.getElementById('trk').textContent = tr ? tr.title + (mu && !mu.ext ? ` (radio${mu.game ? `, ${mu.game}` : ''})` : '') : '';
  if (mu && mu.ext && mu.yt) {  // (a live match's extension's track: Raito's upload of it, as the radio tiles link)
    const a = document.createElement('a');
    a.className = 'yt'; a.href = mu.yt; a.target = '_blank'; a.rel = 'noopener'; a.textContent = ' ▶';
    a.title = 'Raito’s upload of this song on YouTube'; a.setAttribute('aria-label', a.title);
    document.getElementById('trk').append(a);
  }
  if (!C && liveExt.stage && !radioPickHasStage()) {  // a live match's extension's stage (liveExtApi.stage): its picture and plate over the match's
    // (not while this viewer's own radio stage pick is on: that stage is the one on screen, radioStageSync)
    const X = liveExt.stage;
    for (const k of ['view', 'name']) {
      const img = box.querySelector('.' + k), b = k === 'view' ? X.view : X.plate, old = img.dataset.src || '';
      img.dataset.src = b ? URL.createObjectURL(b) : '';
      xfadeSrc(img, img.dataset.src, old); img.hidden = !b;
    }
    box.querySelector('.view').title = X.name; box.querySelector('.name').alt = X.name;
    if (box.hidden) requestAnimationFrame(() => marquee(document.getElementById('players')));
    box.hidden = false;
    return;
  }
  if (!C && radio && stageFollows() && (radio.tile || radio.tileUrl)) {  // an older game's stage: its picture, its name for the plate
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
  const view = box.querySelector('.view');
  // (no art for the stage, or not loaded yet (a cold cache): the picture's place held by a plain panel, so the card's
  // layout, the splashes and the names are there at once; was: the block hidden, and the CSS hid the splashes with it)
  const hold = () => {
    for (const k of ['view', 'name']) { const img = box.querySelector('.' + k); img.dataset.src = ''; img.removeAttribute('src'); img.hidden = k === 'name'; }
    view.classList.add('ph'); box.dataset.stage = '';
    if (box.hidden) requestAnimationFrame(() => marquee(document.getElementById('players')));
    box.hidden = false;
  };
  let art = st ? stageArtGet(id) : null;
  if (art instanceof Promise) {
    const inst = xfInstant;
    if (box.hidden || +box.dataset.stage !== id) hold();
    art = await art.catch(() => null);
    xfInstant = inst;
    if (stageKey !== key) return;  // (another stage meanwhile)
  }
  if (!art) { hold(); return; }
  swMark('stageArt', true, C ? C.id : s.liveSrc && s.liveSrc.id);
  box.dataset.stage = id;
  view.classList.remove('ph');
  for (const k of ['view', 'name']) {  // (cached URLs: kept, never revoked)
    const img = box.querySelector('.' + k), old = img.dataset.src || '';
    img.dataset.src = art[k] || '';
    xfadeSrc(img, img.dataset.src, old.startsWith('blob:') && ![...stageArt.values()].some(a => a && (a.view === old || a.name === old)) ? old : '');
    img.hidden = !art[k];
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
// (the live list's names too: fullscreen moves the list beside the picture at another width, and the 15 s refresh measured
// only names not yet scrolling: a name that then fit kept scrolling with its copy, one that no longer fit was cut; user
// 2026-11-08 "in fullscreen the names are popping and not marquee properly". Width changes only: a row added changes the height)
for (const [id, sel] of [['liveitems', '.lnm'], ['nextcard', '.lnm']]) {
  const box = document.getElementById(id);
  if (!window.ResizeObserver || !box) continue;
  let w0 = -1;
  new ResizeObserver(() => { const w = box.clientWidth; if (w === w0) return; w0 = w; marquee(box, sel); }).observe(box);
}
// (while a match plays (body.mplay) the shell's own CSS animations hold still: the banner's scroll, the clip link's
// pulse and the 2x badge; each ran compositor frames between the game's, goal 3a. The name marquees go on, stepped
// from this frame bus: paused, they froze a long name cut off at both ends (user 2026-11-07); free-running, each ticked
// the compositor at the panel's rate (Moto G 120 Hz: 74-80 presented frames/s, impl frames every 8.3 ms, phone-perf
// run c_before_1107); stepped, each moves only in the frames the game presents)
const mqAnims = new Set();
let mPlay = false, mqAt = 0;
frameBus.add(function marqueeStep(now) {
  const dt = Math.min(now - mqAt, 100); mqAt = now;
  if (!mPlay) return;
  for (const a of mqAnims) { try { a.currentTime = (a.currentTime || 0) + dt; } catch (e) {} }
});
// a row rebuilt (the live list every 15 s) keeps its name's place in the loop: the old row's animation hands its time on;
// animations whose text left the page are dropped (they were stepped forever)
function mqTakeOver(key) {
  let t0 = 0;
  for (const a of mqAnims) {
    const el = a.effect && a.effect.target;
    if (el && el.isConnected) continue;
    if (a.__key === key) t0 = a.currentTime || 0;
    a.cancel(); mqAnims.delete(a);
  }
  return t0;
}
frameBus.add(function playState() {
  const on = !!(session && session.tl && !ui.paused && !document.hidden);
  if (on === mPlay) return;
  mPlay = on; document.body.classList.toggle('mplay', on);
  for (const a of mqAnims) { try { if (on) a.pause(); else a.play(); } catch (e) {} }
});
// a name longer than its room scrolls one way and loops, as the game's own HUD names do (main_browser.cpp banner_draw:
// 40 px/s, a 24 px gap between laps; a viewer, 2026-11-07: ours went to the end and back): the text and a copy of it
// after the gap move left by one lap, linearly, forever, so the copy takes the original's place seamlessly
const MQ_SPEED = 40, MQ_GAP = 24;
function marquee(root, sel = '.mqx') {
  for (const nm of root.querySelectorAll(sel)) {
    const t = nm.firstChild;
    if (!t) continue;
    const q = t.__mq;
    if (q && q.clone.parentNode === t) q.clone.remove();  // (measured without the copy; a new name replaced both anyway)
    const w = t.scrollWidth, over = w - nm.clientWidth;
    nm.classList.toggle('mq', over > 2);
    // (a Web Animation with concrete numbers runs on the compositor; the CSS keyframes with var() re-styled the text
    // every frame on the main thread)
    if (q && q.w === w && over > 2 && q.anim.playState !== 'idle') { t.appendChild(q.clone); continue; }
    // (a name measured again at another width (its font loaded, the box resized) goes on from where it was: it started
    // over at its first letter, a jump back mid-scroll, user 2026-11-08 "the names are popping")
    const was = q ? q.anim.currentTime || 0 : 0;
    if (q) { q.anim.cancel(); mqAnims.delete(q.anim); t.__mq = null; }
    if (over <= 2 || (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) || !t.animate) continue;
    const key = t.textContent, t0 = mqTakeOver(key) || was;
    const clone = document.createElement('span');
    clone.className = 'mqc'; clone.setAttribute('aria-hidden', 'true'); clone.style.paddingLeft = `${MQ_GAP}px`;
    for (const c of [...t.childNodes]) clone.appendChild(c.cloneNode(true));
    t.appendChild(clone);
    const lap = w + MQ_GAP;
    const anim = t.animate([{ transform: 'translateX(0)' }, { transform: `translateX(${-lap}px)` }],
                           { duration: lap / MQ_SPEED * 1000, iterations: Infinity, easing: 'linear' });
    anim.__key = key; if (t0) anim.currentTime = t0 % (lap / MQ_SPEED * 1000);
    t.__mq = { w, over, anim, clone }; mqAnims.add(anim);
    if (mPlay) anim.pause();
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
// The live list's character icons: hover (touch: tap the icon) shows a card with the character's select-screen portrait,
// its moon and name, and a link to its Mizuumi wiki page (that moon's page). Page names from mizuumi.wiki's own page
// list (api.php allpages, Melty Blood/MBAACC/, non-redirects, 2026-11-06): every one has Crescent / Full / Half Moon
// subpages. G. Akiha (16) has no page of its own: no link. (user / community request 2026-11-06)
const MIZU = { 0: 'Sion Eltnam Atlasia', 1: 'Arcueid Brunestud', 2: 'Ciel', 3: 'Akiha Tohno', 4: 'Hisui & Kohaku', 5: 'Hisui',
  6: 'Kohaku', 7: 'Shiki Tohno', 8: 'Miyako Arima', 9: 'Warachia', 10: 'Nero Chaos', 11: 'Sion TATARI', 12: 'Red Arcueid',
  13: 'Akiha Vermilion', 14: 'Mech-Hisui', 15: 'Shiki Nanaya', 17: 'Satsuki Yumizuka', 18: 'Len', 19: 'Powered Ciel',
  20: 'Neco-Arc', 22: 'Aoko Aozaki', 23: 'White Len', 25: 'Neco-Arc Chaos', 28: 'Kouma Kishima', 29: 'Akiha Tohno (Seifuku)',
  30: 'Riesbyfe Stridberg', 31: 'Roa', 33: 'Shiki Ryougi', 34: 'Neco & Mech', 35: 'Koha & Mech', 51: 'Archetype: Earth' };
function mizuUrl(c, mo) {
  const base = CHARA[c] && CHARA[c].startsWith('B. ') ? +Object.keys(CHARA).find(k => CHARA[k] === CHARA[c].slice(3)) : c;
  const pg = MIZU[base];
  if (!pg) return null;
  const moon = MOON_NAME[mo];
  const t = `Melty Blood/MBAACC/${pg}${moon ? `/${moon} Moon` : ''}`.replace(/ /g, '_');
  return 'https://mizuumi.wiki/w/' + t.split('/').map(encodeURIComponent).join('/');
}
let charPop = null, charPopFor = null, charPopHide = 0;
function charPopEl() {
  if (charPop) return charPop;
  charPop = document.createElement('div'); charPop.id = 'charpop'; charPop.hidden = true;
  charPop.innerHTML = '<div class="cp-por"><img alt=""></div><div class="cp-txt"><canvas class="cp-moon" width="14" height="14"></canvas><span class="cp-nm"></span></div><a class="cp-wiki" target="_blank" rel="noopener">Mizuumi wiki ↗</a>';
  charPop.addEventListener('pointerenter', () => clearTimeout(charPopHide));
  charPop.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') charPopSoon(); });
  document.body.append(charPop);
  document.addEventListener('pointerdown', e => { if (charPop && !charPop.hidden && !charPop.contains(e.target) && !(charPopFor && charPopFor.contains(e.target))) charPopClose(); }, true);
  addEventListener('scroll', () => charPopClose(), { passive: true, capture: true });
  return charPop;
}
function charPopClose() { clearTimeout(charPopHide); if (charPop) charPop.hidden = true; charPopFor = null; }
function charPopSoon() { clearTimeout(charPopHide); charPopHide = setTimeout(charPopClose, 220); }
function charPopShow(anchor, c, mo) {
  const el = charPopEl(), img = el.querySelector('img'), url = mizuUrl(c, mo), path = porPath(c);
  clearTimeout(charPopHide);
  charPopFor = anchor;
  el.querySelector('.cp-nm').textContent = `${mo === 9 ? 'Eclipse' : MOON_LABEL[mo] || ''} ${CHARA[c] || ''}`.trim();
  drawMoon(el.querySelector('.cp-moon'), mo);
  const a = el.querySelector('.cp-wiki');
  a.hidden = !url; if (url) a.href = url;
  img.hidden = true; img.removeAttribute('src');
  if (path) porLoad(path).then(u => { if (charPopFor === anchor) { img.src = u; img.hidden = false; charPopPlace(anchor); } }, () => {});
  el.hidden = false;
  charPopPlace(anchor);
}
function charPopPlace(anchor) {
  const el = charPop, r = anchor.getBoundingClientRect(), w = el.offsetWidth, h = el.offsetHeight, m = 8;
  let x = r.left + r.width / 2 - w / 2, y = r.top - h - 6;
  if (y < m) y = r.bottom + 6;
  x = Math.max(m, Math.min(innerWidth - w - m, x)); y = Math.max(m, Math.min(innerHeight - h - m, y));
  el.style.left = `${Math.round(x)}px`; el.style.top = `${Math.round(y)}px`;
}
function charPopWire(t, c, mo) {
  t.addEventListener('pointerenter', e => { if (e.pointerType === 'mouse') charPopShow(t, c, mo); });
  t.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') charPopSoon(); });
  // (touch / pen: a tap on the icon opens the card, not the match: the rest of the row still switches)
  t.addEventListener('pointerdown', e => { if (e.pointerType !== 'mouse') e.stopPropagation(); });
  t.addEventListener('click', e => {
    if (e.pointerType === 'mouse' || (e.pointerType === undefined && matchMedia('(hover: hover)').matches)) return;
    e.preventDefault(); e.stopPropagation();
    if (charPopFor === t && charPop && !charPop.hidden) charPopClose(); else charPopShow(t, c, mo);
  });
}
function liveSide(m, p) {
  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  const names = (m.names || []).map(n => (n || '').trim());
  const c = m.chara && m.chara[p], mo = m.moon && m.moon[p], sp = el('span', 'side');
  const ico = el('span', 'lico');  // (the icon's cursor-frame strip goes inside: selStrip)
  ico.dataset.cell = iconCell(c); ico.dataset.side = p;
  const moon = el('canvas', 'lmoon'); moon.width = 60; moon.height = 60;  // (shown at 20 px: sharp at 3x)
  if (plArt && iconCell(c) >= 0) {
    selStrip(ico, iconCell(c), p); drawMoon(moon, mo);
    const ch = el('span', 'lchar'); ch.append(ico, moon); charPopWire(ch, c, mo); sp.append(ch);
  }
  const nm = el('span', 'lnm');
  nm.append(el('span', 't', names[p] || CHARA[c] || `Player ${p + 1}`));
  sp.append(nm);
  sp.title = `${mo === 9 ? 'Eclipse' : MOON_LABEL[mo] || ''} ${CHARA[c] || ''}`.trim();
  return sp;
}
let liveListDeferred = false;
document.addEventListener('visibilitychange', () => { if (!document.hidden && liveListDeferred) { liveListDeferred = false; liveListShow(); } });
let liveListDrawing = false;
// given: a list just read (liveList's redraw): drawn without a fetch or a next refresh of its own
async function liveListShow(given = null) {
  if (liveListDrawing && given) return;
  liveListDrawing = true;
  try { await liveListDraw(given); } finally { liveListDrawing = false; }
}
async function liveListDraw(given) {
  const sec = document.getElementById('livesec'), ol = document.getElementById('liveitems');
  if (!LIVE_FEED) { sec.hidden = true; return; }
  // a hidden page asks for no list (a phone's radio woken every 15 s for a list nobody sees): asked again once it is back
  if (document.hidden) { liveListDeferred = true; return; }
  let l = [];
  // (a failed fetch, a phone's network dropping one request, keeps the list as it is and asks again in 5 s: it emptied
  // and hid the whole list for 15 s)
  if (given) l = given;
  else try { l = await liveList(); } catch (e) { if (ol.children.length) { wTimeout(liveListShow, 5000); return; } }
  try { await playersArt(); } catch (e) {}
  cardPreload(l);
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
  // (pinned by a mod or admin: on top, for everyone, in the order pinned; user 2026-11-08)
  const pinned = (window.mbaaChat && window.mbaaChat.pins && window.mbaaChat.pins()) || new Set(), pinAt = m => [...pinned].indexOf(ctxPinKey(m));
  l = [...l.filter(m => !liveIdle(m)), ...l.filter(liveIdle)]
    .map(m => [m, pinAt(m) >= 0 ? pinAt(m) - 1000 : liveIdle(m) ? 1 : 0]).sort((a, b) => a[1] - b[1] || (b[0].viewers || 0) - (a[0].viewers || 0) || at(a[0]) - at(b[0])).map(x => x[0]);
  // FLIP: each kept row's place before the reorder, to slide it from there to its new place
  const before = new Map([...ol.children].map(li => [li, li.getBoundingClientRect().top]));
  const idleTip = m => liveIdle(m) ? `idle: nothing played for ${Math.round(m.age / 60)} min (the host is still open)` : m.css ? 'on character select' : '';
  const rows = l.map(m => {
    const key = JSON.stringify([m.id, m.names, m.chara, m.moon, !!plArt, !!m.css]);
    let li = old.get(key);
    if (li) {
      li.__m = m; li.classList.toggle('pin', pinned.has(ctxPinKey(m)));
      badge(li.querySelector('.lview'), m.viewers);
      li.className = [liveSrc && liveSrc.id === m.id ? 'cur' : '', liveIdle(m) ? 'idle' : '', pinned.has(ctxPinKey(m)) ? 'pin' : ''].join(' ').trim();
      li.querySelector('a').title = idleTip(m) || m.matchup || (m.names || []).map(n => (n || '').trim()).join(' vs ');
      if (liveSrc && liveSrc.id === m.id) liveWatching(m.viewers);
      return li;
    }
    li = document.createElement('li'); li.dataset.key = key; li.__m = m;
    if (pinned.has(ctxPinKey(m))) li.classList.add('pin');
    const a = document.createElement('a');
    // (the page's <base> is the site root on the live path: a bare ?live= would leave it)
    a.href = `${location.pathname}?live=${m.id}` + (LIVE_URL ? `&liveUrl=${encodeURIComponent(Q.get('liveUrl'))}` : '')
      // (a local test page: its chat switches carry over, as chat.js's links do)
      + (/^(127\.0\.0\.1|localhost)$/.test(location.hostname) ? ['chat', 'chatUrl', 'chatAuth', 'lowmem'].filter(k => Q.has(k)).map(k => `&${k}=${encodeURIComponent(Q.get(k))}`).join('') : '');
    const names = (m.names || []).map(n => (n || '').trim());
    a.title = idleTip(m) || m.matchup || names.join(' vs ');
    const side = p => liveSide(m, p);
    const v = el('span', 'lview'); badge(v, m.viewers);
    a.append(side(0), el('span', 'lvs', 'vs'), side(1), v);
    // (the chat page: this match's chat as a tab, the picture stays; user 2026-11-07, chat.js xOpen)
    if (CHAT_PAGE && m.match) {
      const ch = el('span', 'lchat'); ch.setAttribute('role', 'button'); ch.title = "open this match's chat (your picture stays)";
      ch.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z"/><path d="M8 9h8M8 12h5"/></svg>';
      ch.addEventListener('pointerdown', e => e.stopPropagation());
      ch.onclick = e => { e.preventDefault(); e.stopPropagation(); if (window.mbaaChat && window.mbaaChat.openMatch) window.mbaaChat.openMatch(m); };
      a.append(ch);
    }
    if (liveSrc && liveSrc.id === m.id) { li.classList.add('cur'); liveWatching(m.viewers); }
    if (liveIdle(m)) li.classList.add('idle');
    // (in place: the chat, the radio and the loaded game stay; a new tab / window with a modifier or the middle button)
    // (a hover warms the card's files only; its snapshot (a runner wake on the bridge) waits for a press or focus: plan 0b)
    a.addEventListener('pointerenter', () => liveCardPrefetch(m, false), { passive: true });
    for (const ev of ['pointerdown', 'focus']) a.addEventListener(ev, () => liveCardPrefetch(m), { passive: true });
    // (a press: the tap follows in ~0.1 s; its start's requests go now (livePress), the tap's startLive takes them; goal D)
    a.addEventListener('pointerdown', () => livePress(m), { passive: true });
    a.onclick = e => {
      if (e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      if (session && session.liveSrc && session.liveSrc.id === m.id) return;
      liveGo(m.id, true, m);
    };
    li.append(a);
    return li;
  });
  // (in place: a kept row is never taken out of the list, which would restart its names' scrolling from the start;
  // only rows out of order move)
  rows.forEach((li, i) => { if (ol.children[i] !== li) ol.insertBefore(li, ol.children[i] || null); });
  livePreloadAll(l);   // (every live match's files, at idle: livePreloadAll)
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
  if (!given) wTimeout(liveListShow, 15000);
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
// ---- Switch-back (harness-design/live_switch/SWITCH_PLAN.md phase 7, option D): desktop only. The live match left for
// another one is kept warm: a keyframe at the moment it was left (its live point; a page the game has not changed since
// boot is the boot snapshot's own, so only the changed pages cost memory), its records, read on in the background while
// away (kept, never played: no simulation), its files in memory and the store textures its keyframe names (held through
// the next match's store reset and eviction). Back to it (the live list, Back): the same instance restores that keyframe
// into a new session of the match and catches up only the time away (~60 frames a second away, ~1,300 simulated a
// second). One match kept (the next switch keeps the one left then); dropped after KEEP_MS, on memory pressure, when it
// leaves the feed or its game moves on (a new game: a fresh start is as quick), and when a replay opens. Phones / low
// memory: never (LOWMEM). ?swkeep=0: off.
const SW_KEEP = !LOWMEM && !HASH && !CAPTURE && Q.get('swkeep') !== '0' && Q.get('reuse') !== '0' &&
  !(navigator.deviceMemory && navigator.deviceMemory < 4);
const KEEP_MS = +(Q.get('keepms') || 300000);
let liveKept = null, liveResumeK = null, liveClickAt = null;
const SNAP_BACK_S = 4;  // (a switch back after this many seconds away joins from the bridge's snapshot: liveResumeStart)
// (a switch back's steps, ms since the click: __mbaaSwitchBack.steps)
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
window.__mbaaKept = () => (liveKept ? liveKeptStat(liveKept) : null);
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
// startLive: back to the kept match (its game still the list's). The match being left is kept in its turn.
async function liveResumeStart(K, prev) {
  liveKept = null; wClear(K.timer);  // (its texture hold stays until the restore takes it over: liveResumeApply)
  const B = window.__mbaaSwitchBack = { click: liveClickAt, start: performance.now(), awayS: (Date.now() - K.at) / 1000, kept: liveKeptStat(K) };
  if (prev && prev.liveSrc && prev.liveSrc.id !== K.id) liveKeepTake(prev);
  console.log(`live: back to the kept match (${B.awayS.toFixed(1)} s away)`);
  liveResumeK = K;
  // (away long: the bridge's snapshot, asked for now, joins the live point (liveCatchUp's snapshot path) instead of
  // stepping the whole time away from the kept keyframe muted (~260 frames/s: 18 s away was ~5 s without sound or
  // music, run_music3's third return, user 2026-11-07). A short absence steps from the keyframe, faster than a fetch)
  liveSrc = { id: K.id, info: K.info, since: K.info.game, snapP: B.awayS > SNAP_BACK_S ? liveSnapFetch(K.id, K.info) : null };
  window.__mbaaRepUrl = null;
  await start(new File([K.rep], K.name), true, K.id);
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
    M.ccall('viewer_hash_enable', null, [], []);
    call(s, 'viewer_suppress', 1); call(s, 'viewer_step', 30); call(s, 'viewer_suppress', 0);
    B.rows0 = { from: kf.frame, csv: M.ccall('viewer_hash_take', 'string', [], []) };
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
// (test, ?swhash=1: the live session's state for the check; the state rows of n frames from frame k (a seek there), or
// from the current frame (k null))
if (Q.get('swhash') === '1') window.__mbaaLiveState = () => {
  const s = session;
  if (!s || !s.liveSrc || !s.M) return null;
  return { id: s.liveSrc.id, frame: s.M._viewer_frame(), ahead: call(s, 'viewer_spectate_buffered'), seeking: !!s.seeking,
           follow: !!s.liveFollow, game: call(s, 'viewer_spectate_game'), scene: s.M.HEAP32[0x54EEE8 >> 2], swLive: s.swLive ?? null,
           kfs: s.tl ? s.tl.kfs.length : 0, tlMB: s.tl ? Math.round(s.tl.bytes / 1e5) / 10 : 0, heapMB: Math.round(s.M.HEAPU8.length / 1e5) / 10 };
};
if (Q.get('swhash') === '1') window.__mbaaStateRows = async (k, n) => {
  const s = session;
  if (!s) return null;
  if (k != null) await requestSeek(k);
  const f0 = s.M._viewer_frame();
  s.M.ccall('viewer_hash_enable', null, [], []);
  call(s, 'viewer_suppress', 1); call(s, 'viewer_step', n); call(s, 'viewer_suppress', 0); call(s, 'viewer_represent');
  return { from: f0, csv: s.M.ccall('viewer_hash_take', 'string', [], []) };
};
// live: following the stream (paced, ~LIVE_BEHIND frames behind it); DVR (after a seek, a step or a pause): the replay
// controls on everything received so far, no pacing; End (or L) goes back
function liveFollow(s, on) {
  s.liveFollow = on;
  if (!on && s.liveFF) { s.liveFF = false; call(s, 'viewer_speed', ui.speed); }
  if (!on && s.liveTrim) { s.liveTrim = false; call(s, 'viewer_rate', 1); }
  const te = document.getElementById('toend');
  te.classList.toggle('on', on); te.title = on ? 'following live' : 'back to live (End / L)';
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
// ---- the likely next matches kept warm (SWITCH_PLAN.md Phase 6): a switch to one of them finds its files in the page's
// memory (the likeliest, desktop) or Cache Storage, and its game's records up to a few seconds ago (the join then brings
// only the rest). Candidates: the next-match card's (liveNextCands, the likeliest first: liveNextMatch), from the newest
// list read. Desktop: files for 4, records for 2; a phone (low memory): one, its files on disk only. Never on Save-Data /
// 2G, never while the page is hidden, the session is loading or catching up. Records every PRE_EVERY ms per candidate
// (a join answer: a few KB), so a viewer's Worker requests grow by at most 2 per PRE_EVERY
const livePre = new Map();  // id -> {game, recs: Map index -> record, last, at, files: the setup whose files are warm}
let livePreKeep = new Set(), livePreRun = false;
const PRE_EVERY = 10000, PRE_FILES = LOWMEM ? 1 : 4, PRE_RECS = LOWMEM ? 1 : 2;
const livePreOff = () => { const c = navigator.connection; return !LIVE_FEED || Q.get('livePre') === '0' || !!(c && (c.saveData || /2g/.test(c.effectiveType || ''))); };
function livePreStart() {
  if (livePreRun || livePreOff()) return;
  livePreRun = true;
  const tick = async () => {
    try { await livePreTick(); } catch (e) { console.warn('live prefetch:', e); }
    setTimeout(tick, PRE_EVERY);
  };
  setTimeout(tick, 3000);
}
async function livePreTick() {
  const s = session, L = s && s.liveSrc, ll = liveListLast;
  if (!L || hidden() || !ll || performance.now() - ll.at > 30000) return;
  if (s.seeking || !s.liveSynced || inflight.size) return;  // (the session's own load and catch-up first)
  const cands = liveNextCands(ll.l, L).filter(m => !m.css && !liveIdle(m) && m.chara);
  const top = liveNextMatch(cands, L);
  const order = [...(top ? [top] : []), ...cands.filter(m => m !== top).sort((a, b) => (b.viewers || 0) - (a.viewers || 0))].slice(0, PRE_FILES);
  for (const id of [...livePre.keys()]) if (!order.some(m => m.id === id)) livePre.delete(id);
  for (const [k, m] of order.entries()) {
    if (session !== s || s.seeking) return;
    const pre = livePre.get(m.id) || { game: null, recs: new Map(), last: null, at: 0, files: '' };
    livePre.set(m.id, pre);
    const key = JSON.stringify([m.stage, m.chara, m.moon, m.color]);
    if (pre.files !== key) {
      const want = liveWantOf(m);
      if (want) {
        // (the likeliest on desktop: in memory, kept through the session's cache prunes; the others: on disk)
        if (k === 0 && !LOWMEM) { livePreKeep = want; await fetchAll(man, want, '', true); }
        else await warmDisk(man, want);
      }
      pre.files = key;
    }
    if (k < PRE_RECS && liveJoinOk) {
      const j = await liveJoin(m.id, pre.game != null && pre.recs.size ? { have: pre.game, since: pre.last } : {});
      if (!j || !j.entry || j.entry.css) { if (j && !j.entry) livePre.delete(m.id); continue; }
      if (j.game !== pre.game || j.from <= j.game) pre.recs = new Map();
      pre.game = j.game;
      liveRecsPut(pre.recs, j.rec);
      pre.last = pre.recs.size ? Math.max(...pre.recs.keys()) : null;
      pre.at = performance.now();
    }
  }
  if (!LOWMEM && !(top && livePre.has(top.id))) livePreKeep = new Set();
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
      const due = liveExt.thumbDue, extNow = due != null && performance.now() >= due;
      // (cardDark reads the canvas back, a GPU stall of 40-80 ms on a phone: only once the picture is due, never per poll)
      if (s.liveSynced && battle && !hidden() && !s.seeking && performance.now() - s.battleAt > 4000
          && (extNow || (due == null && performance.now() - (s.liveThumbAt || -1e9) > 120000)) && liveClipCan() && !cardDark()) {
        // (signed in only: the bridge takes link-card pictures from signed-in viewers alone (AUDIT_1107 F-06); a guest's
        // POST was a 401 in its console)
        s.liveThumbAt = performance.now(); liveExt.thumbDue = null;
        // (ext: the extension this frame shows; the bridge keeps a frame of the match's current one over an older one's. In the
        // query, not a header: a custom header would need a CORS preflight the bridge does not answer)
        grabCard().jpeg.then(b => b && fetch(`${LIVE}/live/${L.id}/thumb?ext=${encodeURIComponent(liveExt.v || '')}`,
          { method: 'POST', body: b }).catch(() => {}));
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
      if (s.liveSynced && !s.seeking && ahead <= LIVE_BEHIND + 90 && ahead > 0) {
        if (sw && sw.marks.frame == null) swMark('frame', true, L.id);
        swMark('live', true, L.id);
        if (!s.cardLive) { s.cardLive = true; cardDraw(); }  // (the engine's data from here: redrawn only where they differ)
      }
      const ff = !hold && excess > 180;
      const trim = !hold && !ff && (excess > 30 || (s.liveTrim && excess > 0));
      if (trim !== !!s.liveTrim) { s.liveTrim = trim; call(s, 'viewer_rate', trim ? 1.05 : 1); }
      if (ff !== !!s.liveFF) { s.liveFF = ff; call(s, 'viewer_speed', ff ? 2 : ui.speed); }
      { const b = document.getElementById('ffbadge'); if (b) b.hidden = !ff; }
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
  wClear(nextCard.timer); cancelAnimationFrame(nextCard.raf);
  nextCard.s = null; nextCard.id = null; nextCard.why = null;
}
// push: a new history entry (a click on the live list or Go now: Back returns to the match before, no reload; user
// 2026-11-02 "clicking another live match must not reload the page"); the automatic move replaces the entry
// entry: the list entry clicked (startLive starts from it)
function liveGo(id, push = false, entry = null) {
  swBegin(id);
  cardSet(((liveListLast && liveListLast.l) || []).find(m => m.id === id));
  cardDraw(true);
  liveClickAt = performance.now();
  nextCardHide();
  try {
    const u = new URL(location.href);
    u.searchParams.set('live', id);
    for (const k of ['r', 'rep', 'l', 'i', 'c', 't']) u.searchParams.delete(k);
    if (push && u.href !== location.href) history.pushState({ live: id }, '', u); else history.replaceState({ live: id }, '', u);
  } catch (e) {}
  document.body.classList.add('live'); syncChips();
  return startLive(id, null, entry);
}
// Back / Forward between matches switched in place: the match of that entry, again in place; an entry that is not a
// live match (the replay page the viewer came from) loads as a page
addEventListener('popstate', () => {
  const id = new URLSearchParams(location.search).get('live');
  if (!id) { location.reload(); return; }
  if (session && session.liveSrc && session.liveSrc.id === id) return;
  cardSet(((liveListLast && liveListLast.l) || []).find(m => m.id === id)); cardDraw(true);
  liveClickAt = performance.now();
  nextCardHide();
  document.body.classList.add('live'); syncChips();
  startLive(id, null, liveListLast && liveListLast.l.find(m => m.id === id));
});
// list: the live list as just read (the watched match may be in it). title: what happened ("Match over", ...)
function nextCardShow(s, list, title) {
  if (session !== s || (s && nextCard.stay === s)) return false;  // (s null: a page with no match yet)
  const el = document.getElementById('nextcard');
  if (!el) return false;
  // (the others: every live match but ours; the host's next match on our id is another match, and the likeliest next:
  // it has one of our players)
  const L0 = s ? s.liveSrc : liveSrc, live = liveNextCands(list, L0);
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
    b.onclick = e => { e.stopPropagation(); liveGo(m.id, true, m); };
    return b;
  };
  const others = el.querySelector('.nc-o');
  others.textContent = '';
  for (const m of live.filter(m => !next || m.id !== next.id).slice(0, 5)) others.append(row(m, 'nc-row'));
  el.querySelector('.nc-ol').hidden = !others.children.length;
  const feat = el.querySelector('.nc-m');
  feat.textContent = '';
  if (next) feat.append(row(next, 'nc-row nc-next'));
  requestAnimationFrame(() => marquee(el, '.lnm'));   // (a long name scrolls, as in the live list)
  el.querySelector('.nc-go').onclick = e => { e.stopPropagation(); if (nextCard.id) liveGo(nextCard.id, true, nextCard.m); };
  el.querySelector('.nc-stay').onclick = e => { e.stopPropagation(); nextCard.stay = s; nextCardHide(); status('staying on this match (the live list has the others)'); };
  for (const ev of ['pointerdown', 'click', 'touchend']) el['on' + ev] = e => e.stopPropagation();  // (never the picture's)
  el.classList.toggle('wait', !next);
  if (!next) {
    feat.textContent = 'Waiting for the next live match…';
    el.hidden = false;
    if (nextCard.s === s && !nextCard.id) return true;  // (waiting already)
    wClear(nextCard.timer); cancelAnimationFrame(nextCard.raf);
    nextCard.s = s; nextCard.id = null;
    const wait = async () => {
      if (session !== s || nextCard.s !== s || nextCard.id) return;
      const l = await liveList().catch(() => null);
      if (session !== s || nextCard.s !== s) return;
      if (l && liveNextCands(l, L0).length) nextCardShow(s, l, title);
      else nextCard.timer = wTimeout(wait, 10000);
    };
    nextCard.timer = wTimeout(wait, 10000);
    return true;
  }
  el.hidden = false;
  if (nextCard.s === s && nextCard.id === next.id && nextCard.auto === auto) return true;  // (counting down to it already)
  wClear(nextCard.timer); cancelAnimationFrame(nextCard.raf);
  nextCard.s = s; nextCard.id = next.id; nextCard.m = next; nextCard.at = performance.now() + NEXT_SECS * 1000; nextCard.auto = auto;
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
  nextCard.timer = wTimeout(() => { if (session === s && nextCard.s === s && nextCard.id) liveGo(nextCard.id, false, nextCard.m); }, NEXT_SECS * 1000);
  return true;
}
// a list entry with either of the session's players (a new set of theirs: the host's next match)
function liveSamePlayers(m, L0 = liveSrc) {
  const L = L0 || { id: null, info: {} }, names = new Set((L.info.names || []).map(n => (n || '').trim().toLowerCase()).filter(Boolean));
  return (m.names || []).some(n => names.has((n || '').trim().toLowerCase()));
}
// the next-match card's candidates: every live match but ours, and not one on its first character select unless it is a
// set of our players (the host's next match starts there: startLive waits on it for its first game. Was: left out, so
// the card moved the audience to whatever else was on, or waited, while the host they watched started their next set:
// user 2026-11-03 "people are dropping out when matches end and we get moved to another")
const liveNextCands = (l, L0) => l.filter(m => !liveOurs(m, L0) && !liveGone(m) && (!m.css || liveSamePlayers(m, L0)));
// after a match leaves the list: one with either of its players (a new set of theirs), else the most watched
function liveNextMatch(l, L0 = liveSrc) {
  const L = L0 || { id: null, info: {} };
  const others = l.filter(m => !liveOurs(m, L) && !liveGone(m));
  return others.find(m => liveSamePlayers(m, L))
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
    // (4 uploads at a time, counted as they finish, then each later step named: one by one, a phone's round trips were
    // most of the wait, and "uploading playlist 17/17" was shown from the last upload's start through the list and its
    // preview picture, which read as stuck; the store allows 120 a minute)
    const n = pl.items.length;
    let done = pl.items.filter(it => it.id).length, next = 0;
    const shown = () => status(`uploading playlist replays ${done}/${n}…`);
    shown();
    const up = async () => {
      while (next < n) {
        const it = pl.items[next++];
        if (it.id) continue;
        it.id = await uploadRep(new Uint8Array(await (await itemFile(it)).arrayBuffer()));
        done++; shown();
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, n) }, up));
    const items = pl.items.map(it => ({ id: it.id, name: it.name.replace(/\.rep$/i, '') }));
    status('creating the playlist link…');
    const r = await fetch(`${REPLAY_STORE}/list`, { method: 'POST', body: JSON.stringify({ items }), headers: { 'Content-Type': 'application/json' } });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    const u = new URL(location.origin + location.pathname);
    u.searchParams.set('l', j.id);
    status('adding the link\'s preview picture…');
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
// image), as JPEG (X does not reliably take WebP). Call it before any await lets playback move on (canvasNow:
// the frame presented again, read in the same task)
// the game picture's mean brightness under 24 of 255 (a fade, a load, a black stage): not a card
// the game canvas with the current frame in it: the drawing buffer is not preserved (d3d9_gl.cpp gl_init), so it holds
// the picture only in the task that presented it. A reader at any other time presents the frame again first (the same
// picture, with the comments of now)
function canvasNow() {
  if (session && session.M && session.M._viewer_represent) try { session.M._viewer_represent(); } catch (e) {}
  return document.getElementById('canvas');
}
function cardDark() {
  try {
    const c = document.createElement('canvas'); c.width = 32; c.height = 24;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(canvasNow(), 0, 0, 32, 24);
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
      g.drawImage(canvasNow(), 160, 0, 960, 720);  // (now: the picture before any await)
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
async function copyTimestamp(at = true) {
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
    if (at) {
      u.searchParams.set('t', t);
      if (s.clip) u.searchParams.set('e', s.clip.b);
      if (s.clip && loopOn) u.searchParams.set('loop', '1');
    }
    if (u.searchParams.get('r')) await shareThumb(u.searchParams.get('r'), at ? t : 0, shots);
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
  if (ui.paused) return playOn();
  setPaused(true);
}
// playOn: a clip that stopped at (or was left past) its out point starts over from its in point, as a video player at
// its end does (the play button, Space, a click on the picture, the media keys and the PiP window's play all come here)
function playOn() {
  const s = session, c = s && s.clip;
  if (c && c.stop && !fx && !rec && curFrame() >= c.b) {
    requestSeek(c.a).then(() => { if (session === s && s.clip === c) setPaused(false); });
    return;
  }
  setPaused(false);
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
window.mbaaChatApi = { pinsChanged: () => { if (liveListLast && liveListLast.l) liveListShow(liveListLast.l).catch(() => {}); }, art: playersArt, iconCell, chara: CHARA, liveList: () => (liveListLast ? liveListLast.l : null), liveId: () => session && session.liveSrc ? session.liveSrc.id : null,
  // a chat link to a live match: switch in place (chat, radio and the engine stay), a history entry for Back
  liveGo: id => { if (!/^[A-Za-z0-9_]{4,64}$/.test(id || '')) return false; if (session && session.liveSrc && session.liveSrc.id === id) return true; liveGo(id, true); return true; },
  // the watched live match for chat.js's per-match channel and comment timeline: the list entry (id, match key), the feed's
  // base, following live or not, the records fed (index -> .ccs record) and the stream frames still ahead of the picture
  // (ahead null: not fed yet, or mid-seek; null: no live match)
  // (a match on its first character select: {id, match} while the page waits on it; null otherwise)
  liveCss: () => (liveCss && liveCss.id === liveWant ? liveCss : null),
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
  mentionsMore: () => radioOldLoad().catch(() => null),
  // a live clip's link page (not the chat page): its JSON, for chat.js's clip column and its comments on the picture
  // (drawn by the native renderer there, clipNative), and the clip's frames as this replay has them (clipFix moves them)
  exporting: () => !!fx, clip: null, clipRange: () => session && session.clip ? { a: session.clip.a, b: session.clip.b } : null };
// ?c=<clip id> with a replay (?r= / ?rep=): a live clip's link; its JSON fetched once (clipJson), by chat.js and the page
const CLIP_ID = /^[A-Za-z0-9_-]{8,43}$/.test(Q.get('c') || '') && (Q.get('r') || Q.get('rep')) ? Q.get('c') : null;
let clipJP = null, clipNative = false;
const clipJson = () => clipJP || (clipJP = fetch(`${REPLAY_STORE}/c/${CLIP_ID}`).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }));
const CHAT_PAGE = !!document.querySelector('meta[name="mbaa-chat"]') || (/^(127\.0\.0\.1|localhost)$/.test(location.hostname) && Q.has('chat'));
// a chat popped out into its own window (the right-click menu's "Pop out"): the chat column alone, no game loaded
const POPCHAT = CHAT_PAGE && /^#(melty|m-[A-Za-z0-9_-]{1,60})$/.test(Q.get('popchat') || '') ? Q.get('popchat') : null;
if (POPCHAT) { document.body.classList.add('popchat'); document.title = `${POPCHAT} · chat`; }
// a clip link on the public site: the chat column with the clip's chat (read only), as the live page's (?clipchat=0: none)
if (CLIP_ID && !CHAT_PAGE && Q.get('clipchat') !== '0') {
  const jp = clipJson();
  jp.catch(() => {});
  window.mbaaChatApi.clip = () => { clipNative = true; return { json: jp }; };
}
if (CHAT_PAGE || window.mbaaChatApi.clip) {
  document.body.classList.add('haschat');  // (the chat layout from the start: fitStage)
  const el = document.createElement('script');
  el.src = (document.querySelector('meta[name="mbaa-chatjs"]') || { content: 'chat.js' }).content;
  document.body.append(el);
}
window.mbaaViewer = { startItem: i => startItem(i), card: () => grabCard().jpeg, canvas: canvasNow, seek: requestSeek, step: stepBy, pause: setPaused, frame: () => session.M._viewer_frame(),
                      tl: () => session.tl, ui, pl, cacheSize: () => cache.size, cacheMap: () => cache, phone: PHONE, lowmem: LOWMEM, bgmStream: () => bgmStreamReady, audioState: () => [actx && actx.state, session && session.mute, session && session.bgmLog && session.bgmLog.length, ui.paused], bgmMap: () => bgmDecoded, clip: () => session && session.clip,
                      clipFirst: () => clipFirst(session), clipPanel: () => clipPanel,
                      stats: () => { const t = session.tl; return { kfs: t.kfs.length, kfFrames: t.kfs.map(k => k.frame),
                        kfMs: t.kfs.map(k => Math.round(k.ms * 10) / 10), kfFresh: t.kfs.map(k => k.fresh), bytes: t.bytes,
                        memTop: session.M._viewer_mem_top(), heap: session.M.HEAPU8.length, simMax: t.simMax, end: t.end,
                        thinned: t.thinned || 0, page: PAGE, every: KF_EVERY, incDropped: t.incDropped || 0, kfInc: t.kfs.map(k => k.inc ? 1 : 0),
                        marks: t.marks, seekMs: t.seekMs }; } };

// ---- frame bar (necoTV issue #4): Extended Training Mode's frame bar (Extended-Training-Mode-DLL/FrameBar.cpp) over
// the picture's bottom: per side the last 75 bar frames coloured by state, and ETM's "Startup / Total / Advantage" line.
// The engine reads the facts once per game frame (viewer_framebar_sample, web/host/browser/framebar.cpp: each side's
// busy count g_TeamAux +0x208, pattern, hitstop, block / hitstun, attack record, AS canMove / stance, boxes, ...); the
// page keeps them by frame number (fb.raw, the last FB_CAP frames) and runs ETM's bar logic over them:
// - advantage: an exchange is a stretch with both sides busy; after its last both-busy frame each side's first free
//   frame is kept, on a clock of the game's frame count less freeze frames (ETM CalculateAdvantage's: no global or
//   player super freeze); once both are free the advantage is P2's free frame less P1's, shown until the next exchange
//   ends. (Not ETM's running count: that nets off the frames the attacker spends busy again before the defender is
//   free, a dash after a blocked move read +1 for a +4 move, and resets the moment both are busy again)
// - cells (UpdateBars): busy -> inactionable green / jump startup / hitstun / blockstun / active red; actionable -> dark,
//   advantage darker, the first free frame dark green; over those: thrown, hitstop, shield, throw active, freeze.
//   Frames of a global freeze or shared hitstop are left off (ETM's default). Numbers: each run's length at its end.
// - startup (IncrementFirstActive): busy frames out of hitstop since the last queued pattern, at the first active frame;
//   total: the last busy count
// A seek or a step back re-runs it over the frames kept up to the frame shown (the re-simulation refills them). Off: the
// sampling, drawing and frame bus entry are all gone (fb.on false, fbDraw not on the bus).
const FB_CAP = 1024, FB_PER = 20, FB_N = 2 * FB_PER + 7, FB_CELLS = 75, FB_MEM = 400, FB_INTERVAL = 20;
const FB_COL = [null, '#41c800', '#f1e084', '#8c8c8c', '#b4b4b4', '#ff0000', '#202020', '#101010', '#205a00', '#3c3c3c',
                '#ff8080', '#6e6e6e', '#3c5080', '#91c2ff', '#c00080'];
const FBC = { INACT: 1, JUMP: 2, HITSTUN: 3, BLOCK: 4, ACTIVE: 5, FREE: 6, ADV: 7, NEUTRAL: 8, FREEZE: 9, THROWN: 11,
              HITSTOP: 12, SHIELD: 13, THROW: 14 };
const FB_NUMBERED = new Set([FBC.INACT, FBC.JUMP, FBC.HITSTUN, FBC.BLOCK, FBC.ACTIVE, FBC.ADV, FBC.THROWN, FBC.HITSTOP, FBC.SHIELD, FBC.THROW]);
const FB_SUB = [null, '#ffffff', '#e1b800', '#c465ea'];  // invulnerable, clash, special box
const fb = { on: false, s: null, raw: null, tag: null, last: -1, procF: -1, rebuild: false, dirty: false, m: null, cv: null, place: true };
function fbMachine() {
  const P = () => ({ main: new Uint8Array(FB_MEM), sub: new Uint8Array(FB_MEM), air: new Uint8Array(FB_MEM), proj: new Uint8Array(FB_MEM),
                     lastBusy: 0, lastActive: 0, lastProj: 0, firstActive: 0, firstCounter: 0, gotFirst: false, total: 0 });
  return { p: [P(), P()], counter: 0, interval: 0, intervalMax: FB_CELLS, isReset: false, doReset: false, doAdv: false,
           shared: 0, lastFc: 0, lastTrue: -1, clock: 0, inEx: false, freeAt: [-1, -1], adv: 0, advCell: -1, any: false };
}
function fbResetBars(m) {
  m.isReset = true; m.counter = 0; m.advCell = -1; m.interval = 0; m.doReset = false; m.intervalMax = FB_CELLS;
  for (const P of m.p) { P.main.fill(0); P.sub.fill(0); P.air.fill(0); P.proj.fill(0); }
}
// one game frame's sample (R from o: side 0, side 1, globals) through ETM's UpdateFrameBar
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
// ETM UpdateBars: the cell at the bar's counter
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
  const p = M._viewer_framebar_sample() >> 2, i = f % FB_CAP;
  fb.raw.set(M.HEAP32.subarray(p, p + FB_N), i * FB_N);
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
// after a seek: the bar again from the kept frames up to the one shown
function fbRebuild() {
  let a = fb.last;
  while (a > 0 && fb.last - a < FB_CAP - 1 && fb.tag[(a - 1) % FB_CAP] === a - 1) a--;
  fb.m = fbMachine();
  if (fb.last >= 0) for (let f = a; f <= fb.last; f++) fbStep(fb.m, fb.raw, (f % FB_CAP) * FB_N);
  fb.procF = fb.last; fb.rebuild = false;
}
function fbPlace() {
  const c = fb.cv, gc = document.getElementById('canvas');
  const L = `${gc.offsetLeft}px`, W = gc.clientWidth, H = gc.clientHeight;
  const T = `${gc.offsetTop + Math.round(H * 372 / 480)}px`, CH = Math.round(H * 70 / 480);
  if (c.style.left !== L || c.style.top !== T) { c.style.left = L; c.style.top = T; }
  if (c.style.width !== `${W}px` || c.style.height !== `${CH}px`) { c.style.width = `${W}px`; c.style.height = `${CH}px`; }
  const dpr = window.devicePixelRatio || 1, w = Math.round(W * dpr), h = Math.round(CH * dpr);
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  fb.place = false; fb.dirty = true;
}
// the frame bus entry (only while on): draws when a frame came in, a seek ended or the picture moved
function fbDraw() {
  const s = session;
  if (!s || s.seeking || fb.s !== s) return;
  if (fb.place) fbPlace();
  if (!fb.dirty) return;
  fb.dirty = false;
  if (fb.rebuild) fbRebuild();
  const c = fb.cv, g = c.getContext('2d'), u = c.width / 640, m = fb.m;
  g.clearRect(0, 0, c.width, c.height);
  if (!m.any && !m.counter) return;
  // (640 x 480 game units from the canvas top at y 372: P1's line, the two rows at ETM's 26-unit bar, P2's line)
  const x0 = 20 * u, bw = 600 * u, cw = bw / FB_CELLS, top = 16 * u, bh = 26 * u, rh = bh * 0.38;
  g.fillStyle = 'rgba(0,0,0,0.6)'; g.fillRect(x0 - 2 * u, top - 1 * u, bw + 4 * u, bh + 2 * u);
  const n = Math.min(m.counter, FB_CELLS), k0 = m.counter - n;
  g.textBaseline = 'middle'; g.textAlign = 'right';
  for (let r = 0; r < 2; r++) {
    const P = m.p[r], y = top + bh * (r ? 0.56 : 0.06);
    for (let j = 0; j < n; j++) {
      const k = (k0 + j) % FB_MEM, x = x0 + j * cw, c0 = P.main[k];
      if (!c0) continue;
      g.fillStyle = FB_COL[c0]; g.fillRect(x, y, cw * 0.9, rh);
      if (P.sub[k]) { g.fillStyle = FB_SUB[P.sub[k]]; for (let i = 0; i < rh; i += 2 * u) g.fillRect(x, y + i, cw * 0.9, u); }
      if (P.proj[k]) { g.fillStyle = '#ff0000'; g.fillRect(x, y + rh * 0.9, cw * 0.9, rh * 0.2); }
      if (P.air[k]) { g.fillStyle = P.air[k] === 2 ? '#e184f1' : '#f1e084'; g.fillRect(x, y - rh * 0.1, cw * 0.9, rh * 0.2); }
    }
    // each run's length at its end (ETM's numbers)
    g.font = `bold ${Math.round(rh * 1.05)}px ui-monospace, monospace`;
    g.lineWidth = Math.max(1, 1.5 * u); g.strokeStyle = '#000';
    let run = 0;
    for (let j = 0; j < n; j++) {
      const c0 = P.main[(k0 + j) % FB_MEM], nx = j + 1 < n ? P.main[(k0 + j + 1) % FB_MEM] : -1;
      run = j > 0 && P.main[(k0 + j - 1) % FB_MEM] === c0 ? run + 1 : 1;
      if (c0 === nx || !FB_NUMBERED.has(c0)) continue;
      const tx = x0 + (j + 1) * cw - 0.1 * cw, ty = y + rh / 2;
      g.strokeText(String(run), tx, ty); g.fillStyle = '#fff'; g.fillText(String(run), tx, ty);
    }
  }
  // where the last exchange ended (its advantage is the lines' number): a white tick across both rows
  if (m.advCell >= k0 && m.advCell < m.counter) { g.fillStyle = '#fff'; g.fillRect(x0 + (m.advCell - k0) * cw - u, top - u, 1.5 * u, bh + 2 * u); }
  // ETM's lines: Startup / Total / Advantage
  g.textAlign = 'left'; g.font = `bold ${Math.round(10 * u)}px ui-monospace, monospace`;
  for (let r = 0; r < 2; r++) {
    const P = m.p[r], a = r ? -m.adv : m.adv, y = r ? top + bh + 9 * u : top - 8 * u;
    const parts = [[`P${r + 1}  Startup ${P.firstActive || '-'}  Total ${P.total || '-'}  Advantage `, '#fff'],
                   [m.any ? (a > 0 ? `+${a}` : `${a}`) : '-', !m.any || a === 0 ? '#fff' : a > 0 ? '#5f5' : '#f66']];
    let x = x0;
    for (const [t, col] of parts) {
      g.strokeText(t, x, y); g.fillStyle = col; g.fillText(t, x, y); x += g.measureText(t).width;
    }
  }
}
function framebarSet(on) {
  if (!fb.cv) {
    fb.cv = document.getElementById('framebar');
    const pl = () => { fb.place = true; };
    if (window.ResizeObserver) new ResizeObserver(pl).observe(document.getElementById('canvas'));
    addEventListener('resize', pl); document.addEventListener('fullscreenchange', pl);
  }
  fb.on = on; fb.cv.hidden = !on;
  if (on) {
    fb.s = null; fb.place = true; frameBus.add(fbDraw);
    // paused: the bar filled from the keyframe before the frame shown (the seek's re-simulation samples it)
    if (session && session.tl && ui.paused) requestSeek(curFrame());
  } else { frameBus.delete(fbDraw); fb.raw = fb.tag = fb.m = null; fb.s = null; }
}
window.__mbaaFramebar = () => (fb.rebuild && session && !session.seeking && fbRebuild(), fb.m) && { counter: fb.m.counter, adv: fb.m.adv, any: fb.m.any, last: fb.last,
  p: fb.m.p.map(P => ({ startup: P.firstActive, total: P.total, cells: Array.from({ length: Math.min(fb.m.counter, FB_CELLS) },
    (_, j) => P.main[(fb.m.counter - Math.min(fb.m.counter, FB_CELLS) + j) % FB_MEM]) })),
  raw: f => fb.tag && fb.tag[f % FB_CAP] === f ? Array.from(fb.raw.subarray((f % FB_CAP) * FB_N, (f % FB_CAP + 1) * FB_N)) : null };  // tests

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
  if (!ui.boxes && !ui.inputs && !(clipChat && !clipNative)) {
    if (!overlayClear) { c.getContext('2d').clearRect(0, 0, c.width, c.height); overlayClear = true; }
    return;
  }
  overlayClear = false;
  // (exactly over the picture: in fullscreen the picture is not where a centred overlay would be once the controls
  // column sits beside it)
  // and as large as the picture: its CSS box was the stage's (100% x 100%), which is taller than the picture whenever
  // the stage holds more (the bar over it, a notice), so what was drawn for the picture's box was stretched past it
  const L = `${gc.offsetLeft}px`, T = `${gc.offsetTop}px`, CW = `${gc.clientWidth}px`, CH = `${gc.clientHeight}px`;
  if (c.style.left !== L || c.style.top !== T) { c.style.left = L; c.style.top = T; }
  if (c.style.width !== CW || c.style.height !== CH) { c.style.width = CW; c.style.height = CH; }
  const dpr = window.devicePixelRatio || 1, w = Math.round(gc.clientWidth * dpr), h = Math.round(gc.clientHeight * dpr);
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const g = c.getContext('2d');
  g.clearRect(0, 0, w, h);
  paintOverlay(g, w, h, dpr, true);
}
// the hitboxes, inputs and clip chat painted into g over a w x h picture (dpr: device pixels per CSS pixel; the video
// export paints them straight into its 1920x1440 frame, crisp, not the screen's overlay scaled)
function paintOverlay(g, w, h, dpr, screen = false) {
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
  // (a live clip's chat: ?c=; on screen the native renderer draws it where chat.js runs the clip's column: clipNative)
  if (!clipNative) clipChatDraw(g, w, h, M._viewer_frame());
}

// ---- controls ----
function fmtTime(f) {   // (tenths first: 59.96 s is 1:00.0, not 0:60.0)
  const t = Math.round(f / 6), m = Math.floor(t / 600);
  return `${m}:${((t - m * 600) / 10).toFixed(1).padStart(4, '0')}`;
}
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
  // (a live catch-up: the time, seek bar, marks and overlay 4 times a second, not at every animation frame between its
  // slices: the marks redrawn every time, as the timeline grows)
  if (s && s.cu && performance.now() - (uiLast.cuAt || 0) < 250) return;
  if (s && s.cu) uiLast.cuAt = performance.now();
  if (s && s.tl) {
    const t = s.tl, f = s.M._viewer_frame(), max = tlMax(t);
    clipTick(s, f);
    if (rec) { try { recTick(s, f); } catch (e) { recFail(e); } }
    const seek = document.getElementById('seek');
    // (the slider spans the timeline's view: the whole replay, or zoomed in while clipping, tlView)
    const { lo, hi } = tlView(s, max), span = Math.max(1, hi - lo);
    // (a new view: the thumb placed again; a min raised past the value had clamped it to the edge)
    if (+seek.min !== lo || +seek.max !== hi) { seek.min = lo; seek.max = hi; uiLast.vpx = uiLast.px = -1; seek.value = t.want !== null ? t.want : f; }
    // (the slider's value only when its thumb moves a whole pixel: a new value every frame re-laid the thumb every frame)
    if (!uiLast.measured) { uiLast.measured = true; uiMeasure(); }
    // (the thumb moves in 4-px steps while playing (~4 times a second over a match), every pixel while seeking or at the
    // end: each move repaints the slider and lays out the transport block, ~12/s per pixel on the Moto G)
    const STEP = 4, end = max - f <= 2;
    if (!seekDragging) {
      const v = t.want !== null ? t.want : f, vpx = Math.round((uiLast.sw || 1000) * (v - lo) / span);
      if (Math.abs(vpx - uiLast.vpx) >= STEP || t.want !== null || end || uiLast.vpx < 0) { uiLast.vpx = vpx; if (+seek.value !== v) seek.value = v; }
    }
    setText('time', 'time', fmtTime(f));
    setText('dur', 'dur', `/ ${fmtTime(max)}${t.end === null ? '+' : ''}`);
    // (phones hide it; playing, 10 a second is all an eye reads; paused or stepping, every frame)
    if (uiLast.fcShown && !document.body.classList.contains('mob') && (ui.paused || f - (uiLast.fcF ?? -99) >= 6 || f < uiLast.fcF)) {
      uiLast.fcF = f; setText('fc', 'fc', `frame ${f}`);
    }
    const px = Math.round((uiLast.sw || 1000) * (seek.value - lo) / span);
    if (Math.abs(px - uiLast.px) >= STEP || t.want !== null || end || uiLast.px < 0) { uiLast.px = px; seek.style.setProperty('--p', `${(100 * (seek.value - lo) / span).toFixed(2)}%`); }
    drawMarks(t, max);
    if (f !== lastDrawnFrame || overlayDirty) { lastDrawnFrame = f; overlayDirty = false; drawOverlay(); }
  }
}
// round starts over the slider; the explored part (seeks inside it restore a keyframe) is shaded
function drawMarks(t, max) {
  const c = session && session.clip, v = tlView(session, max), { lo, hi } = v, span = Math.max(1, hi - lo);
  const key = `${t.marks.length}/${max}/${Math.round(t.simMax / 60)}/${c ? c.a + ':' + c.b : ''}/${lo}:${hi}`;
  if (key === marksKey) return;
  marksKey = key;
  clipUi(max);
  const tlEl = document.querySelector('#transportsec .timeline');
  if (tlEl) tlEl.classList.toggle('zoom', v.zoom);
  const cv = document.getElementById('marks'), dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(cv.clientWidth * dpr); cv.height = Math.round(cv.clientHeight * dpr);
  const g = cv.getContext('2d'), X = f => cv.width * (f - lo) / span;
  g.clearRect(0, 0, cv.width, cv.height);
  g.fillStyle = '#2c3350';
  g.fillRect(0, 0, Math.max(0, Math.min(cv.width, X(t.simMax))), cv.height);
  if (c) { g.fillStyle = 'rgba(80, 200, 255, 0.45)'; g.fillRect(X(c.a), 0, Math.max(2, X(c.b) - X(c.a)), cv.height); }
  // A live session (or any replay with several games) as games: a game starts at each round 1, every other game a
  // lighter band, its number (G2, G3, ...) at its start; rounds as short ticks, labelled only where the label fits
  // before the next mark (a long session's "R1 R2 R3 R1 R2 ..." ran together)
  const xs = t.marks.map(([f]) => Math.round(X(f))), H = cv.height, room = 22 * dpr;
  const starts = t.marks.map(([, r], i) => r === 0 || i === 0);
  const games = starts.filter(Boolean).length;
  g.font = `${Math.round(10 * dpr)}px system-ui, sans-serif`; g.textBaseline = 'top';
  if (games > 1) {
    let n = 0;
    t.marks.forEach(([f], i) => {
      if (!starts[i]) return;
      n++;
      const x = i === 0 ? Math.round(X(0)) : xs[i], end = xs.find((x2, j) => j > i && starts[j]) ?? Math.round(Math.min(cv.width, X(t.simMax)));
      if (end < 0 || x > cv.width) return;  // (zoomed: a game outside the view)
      if (n % 2 === 0) { g.fillStyle = 'rgba(255, 255, 255, 0.07)'; g.fillRect(x, 0, Math.max(0, end - x), H); }
      g.fillStyle = '#ffe9a8';
      g.fillRect(xs[i], 0, Math.max(1, 1.5 * dpr), H);
      // (zoomed in past a game's start: its number at the view's left edge)
      const lx = Math.max(0, xs[i]);
      if (end - lx >= room) { g.font = `600 ${Math.round(10 * dpr)}px system-ui, sans-serif`; g.fillText(`G${n}`, lx + 3 * dpr, 1 * dpr); }
    });
  }
  g.font = `${Math.round(9 * dpr)}px system-ui, sans-serif`;
  t.marks.forEach(([f, r], i) => {
    if (games > 1 && starts[i]) return;
    g.fillStyle = '#ffcc40';
    g.fillRect(xs[i], games > 1 ? H * 0.45 : 0, Math.max(1, dpr), games > 1 ? H * 0.55 : H);
    const next = i + 1 < xs.length ? xs[i + 1] : cv.width, lx = Math.max(0, xs[i]);
    if (next - lx >= room && lx < cv.width) g.fillText(`R${r + 1}`, lx + 2 * dpr, games > 1 ? H * 0.42 : 0);
  });
}
// ---- the timeline's view: the frames the seek bar, its marks and the clip handles span (one mapping for all) ----
// The whole replay (live: the session so far), or, while the clip panel is open and zoomed (clipZoom; Z or the panel's
// Whole set / Zoom button), the round the clip was taken in (the round holding the playhead then) widened to keep the
// clip and a margin inside: a 30 s clip in a long set was a sliver its handles could not be set on. The zoomed view only
// ever widens (a handle dragged past an edge pans it out, clipControls); Clear or closing the panel shows the whole bar.
let clipZoom = true;
function clipViewFor(s, f) {
  const m = s.tl.marks;
  let k = -1;
  for (let i = 0; i < m.length; i++) if (m[i][0] <= f) k = i;
  const a = k >= 0 ? m[k][0] : 0, b = k + 1 < m.length ? m[k + 1][0] : Infinity;
  const pad = Math.max(30, Math.round(((b === Infinity ? tlMax(s.tl) : b) - a) * 0.02));
  return { lo: Math.max(0, a - pad), hi: b === Infinity ? Infinity : b + pad };
}
function tlView(s, max) {
  const c = s && s.clip;
  if (!clipPanel || !clipZoom || !c || !s.tl) { if (s) s.clipView = null; return { lo: 0, hi: max, zoom: false }; }
  const v = s.clipView || (s.clipView = clipViewFor(s, curFrame()));
  // the clip always inside, with a margin (8% of the view, at least 1 s: the handles clear the bar's ends and their
  // time labels; live: an out point near the newest frame keeps the view's end on it)
  // The margin is worked out again only when the clip moves: from the view's width, which on a live set grows with every
  // frame received, it pushed the view's start back a little every frame while the clip stood still
  const ck = c.a + ':' + c.b;
  if (v.padFor !== ck) { v.padFor = ck; v.pad = Math.max(60, Math.round((Math.max(Math.min(v.hi, max), c.b) - Math.min(v.lo, c.a)) * 0.08)); }
  const pad = v.pad;
  if (c.a - pad < v.lo) v.lo = Math.max(0, c.a - pad);
  if (c.b + pad > v.hi) v.hi = c.b + pad >= max ? Infinity : c.b + pad;
  const lo = v.lo, hi = Math.max(lo + 1, Math.min(v.hi, max));
  return lo <= 0 && hi >= max ? { lo: 0, hi: max, zoom: false } : { lo, hi, zoom: true };
}
function toggleClipZoom() {
  const s = session;
  clipZoom = !clipZoom;
  if (s) s.clipView = null;
  marksKey = ''; clipPanelKey = '';
  status(clipZoom ? 'timeline zoomed to the clip\'s round (Z: whole set)' : 'timeline: the whole set (Z: zoom to the clip\'s round)');
}
// the seek actions with a key and a button (the bar, the phone sheet): 1 s = 60 frames, 5 s = 300
const ACT = {
  start: () => requestSeek(1),
  end: () => { if (session && session.liveSrc) liveGoLive(); else if (session && session.tl) requestSeek(tlMax(session.tl)); },   // (live: back to live, paced)
  back5: () => stepBy(-300, false), back1s: () => stepBy(-60, false), fwd1s: () => stepBy(60, false), fwd5: () => stepBy(300, false),
};
const VIEW_TOGGLES = ['boxes', 'inputs', 'hitstun', 'framebar', 'hud', 'names', 'music'];
function flipView(id) { const el = document.getElementById(id); el.checked = !el.checked; el.onchange(); }
function syncChips() {
  let n = 0;
  for (const b of document.querySelectorAll('[data-flip]')) {
    const on = document.getElementById(b.dataset.flip).checked;
    b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on));
    if (on && b.closest('#viewpop') && (!b.classList.contains('liveonly') || document.body.classList.contains('live'))) n++;
  }
  const vn = document.querySelector('#viewb .vn');
  if (vn) vn.textContent = n ? String(n) : '';
}
function controls() {
  const seek = document.getElementById('seek');
  seek.addEventListener('pointerdown', () => { seekDragging = true; });
  addEventListener('pointerup', () => { if (seekDragging) { seekDragging = false; seek.blur(); } });
  seek.addEventListener('input', () => requestSeek(+seek.value));
  const btn = (id, fn) => { document.getElementById(id).onclick = e => { fn(); e.currentTarget.blur(); }; };
  btn('pause', togglePlay);
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
    const r = e.currentTarget.getBoundingClientRect(), { lo, hi } = tlView(s, tlMax(s.tl)), span = Math.max(1, hi - lo);
    const x = lo + (e.clientX - r.left) / r.width * span;
    let best = null;
    for (const [f] of s.tl.marks) if (best === null || Math.abs(f - x) < Math.abs(best - x)) best = f;
    if (best !== null && Math.abs(best - x) / span < 0.04) requestSeek(best); else requestSeek(Math.round(x));
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
  for (const el of document.querySelectorAll('[data-flip]')) el.onclick = e => { e.stopPropagation(); if (!el.closest('#viewpop')) e.currentTarget.blur(); flipView(el.dataset.flip); };
  // the View button (user 2026-11-07, one button in place of the bar's seven chips): its menu stays open while toggling;
  // a click outside it or Esc closes it
  const viewb = document.getElementById('viewb'), viewpop = document.getElementById('viewpop');
  const viewSet = on => { viewpop.hidden = !on; viewb.setAttribute('aria-expanded', String(on)); syncChips(); };
  viewb.onclick = e => { e.stopPropagation(); viewSet(viewpop.hidden); viewb.blur(); };
  document.addEventListener('click', e => { if (!viewpop.hidden && !viewpop.contains(e.target)) viewSet(false); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !viewpop.hidden) viewSet(false); });
  btn('plprev', () => startItem(pl.i - 1)); btn('plnext', () => startItem(pl.i + 1)); btn('plshare', copyPlaylist);
  btn('plsort', sortByDate);
  btn('plclear', () => { const cur = pl.items[pl.i]; pl.items = cur ? [cur] : []; pl.i = cur ? 0 : -1; renderPlaylist(); });
  // a click / tap on the picture: during the VS screen it skips it (as a button press does in the game), otherwise
  // it pauses / plays
  const stageEl = document.getElementById('overlay').parentElement;
  const barOver = () => stageEl.classList.contains('fs') || stageEl.classList.contains('ovl');
  // (the mouse in the fullscreen chat column: reading or typing there does not bring the bar back over the picture)
  stageEl.addEventListener('pointermove', e => { if (barOver() && e.pointerType === 'mouse' && !e.target.closest('#chatcol')) fsWake(); });
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
      // (going fullscreen waits for the finger's lift: a touch pointerdown is no user activation, so requestFullscreen
      // there was refused and the page's own fullscreen taken instead: upright, the browser's bars kept; pointerup is one)
      if (!stageEl.classList.contains('fs')) { tapFs = e.pointerId; return; }
      if (stageEl.classList.contains('sidebar')) return;
      if (stageEl.classList.contains('idle')) fsWake(); else { clearTimeout(fsTimer); stageEl.classList.add('idle'); }
      return;
    }
    if (barOver()) fsWake();
    if (e.button > 0 || !session) return;
    if (actx && actx.state !== 'running') return;  // this click only turns sound on (the page-wide unlock handles it)
    togglePlay();
  });
  let tapFs = null;
  stageEl.addEventListener('pointerup', e => {
    if (e.pointerId !== tapFs) return;
    tapFs = null;
    if (!stageEl.classList.contains('fs')) toggleFullscreen();
  });
  stageEl.addEventListener('pointercancel', () => { tapFs = null; });  // (a scroll or a pinch, not a tap)
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
    if (musicGain) musicGain.gain.value = musicLevel();
  };
  const hsEl = document.getElementById('hitstun');
  hsEl.checked = ui.hitstun;
  hsEl.onchange = () => {
    ui.hitstun = hsEl.checked; hsEl.blur();
    try { localStorage.setItem('mbaaHitstun', ui.hitstun ? '1' : '0'); } catch (e) {}
    const s = session;
    if (s) { hitstunApply(s); if (ui.paused && s.tl) requestSeek(curFrame()); }  // paused: draw the frame again
  };
  const fbEl = document.getElementById('framebar');
  fbEl.checked = ui.framebar;
  fbEl.onchange = () => {
    ui.framebar = fbEl.checked; fbEl.blur();
    try { localStorage.setItem('mbaaFramebar', ui.framebar ? '1' : '0'); } catch (e) {}
    framebarSet(ui.framebar);
  };
  if (ui.framebar) framebarSet(true);
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
    else if ((k === 'z' || k === 'Z') && clipPanel) toggleClipZoom();
    else if (k === '{') setClip('a');
    else if (k === '}') setClip('b');
    else if (k === 'Escape') { if (fx) fx.cancel = true; else if (rec) stopRecording(false); else if (!document.getElementById('help').hidden) toggleHelp(); else if (!document.fullscreenElement && document.querySelector('.stage.fs')) setFs(false); else clearClip(); }
    else if ((k === 'l' || k === 'L') && live) liveGoLive();  // (live: back to live, as End; a replay: loop)
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
    else if (k === 'k' || k === 'K') flip('hitstun');
    else if (k === 'g' || k === 'G') flip('framebar');
    else return;
    e.preventDefault();
  });
  frameBus.add(uiLoop);
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
// ?perf=1: the frame profiler (harness-design/stage3d_perf/PROFILING.md, layer 2). Opt-in: without the flag nothing below
// runs (no wrapping, no listeners). Once a battle has played steadily for 3 s (no live catch-up, hold, seek or pause;
// ?perfwait=0: once frames run; manual: only start()), for
// ?perfsecs= (10) s, per presented frame (one rAF):
//   the rAF interval; the engine's rAF callback (Emscripten's main loop: game, render, the 3D stage hook) and the page's
//   other rAF callbacks (window.requestAnimationFrame is wrapped to time each); the engine tick (viewer_tick_ms) and game
//   frames; WebGL calls on the game's context (its methods wrapped: all, draws, framebuffer binds and real switches,
//   uploads and their bytes, approximate); the 3D stage hook (ext_module.js hook.prof: the whole hook, R.draw, the front
//   objects, upload slices, s3d_render.js R.stats and any other numeric field it adds: s3d.parts); the engine's own split
//   when the build exports viewer_prof_stats / viewer_prof_on (cpu.parts); the fighter light's tagged sprites and glow
//   draws; long tasks.
// 1 engine frame in ?perfgpuN= (30) is a GPU sample, ?perfgpu= sync (default) | fence | off. sync: a 1x1 readPixels from
// the default framebuffer (a real round trip that waits for the GPU; Chrome's gl.finish() does not wait, measured
// 2026-11-06: 0 ms while the next readPixels waited 14-35 ms; 'finish' is taken as sync) before the engine's callback
// (pre: earlier work drained) and after it (tail: the GPU still busy with this frame once its commands were sent; tail +
// the callback's own time bounds the frame's GPU time from above). fence: a fenceSync after the callback, polled from
// later tasks: no stall, but coarse (Chrome's sync status lags the GPU by up to a frame). Both are estimates (the floor
// phone's Chrome has no timer query): they include the GPU process's command decoding and the round trip, and a
// sampled frame and the one after it are left out of the frame statistics. Then a summary (percentiles, per-part means, GPU string, DPR, sizes, 3D tier / light) on a
// panel: download it as JSON (with the per-frame rows), or send it (a button: opt-in) to the bridge's diag log
// (/live/<id>/diag, why 'perf': no address, no names). window.__mbaaProf: start(secs), stop(), summary(), frames().
if (Q.get('perf') === '1') (() => {
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
    const g = M.canvas.getContext('webgl2');
    if (!g) return;
    glM = M; gl = g; wrapGl(g);
  }
  // ---- per frame ----
  let frameT = -1, prevT = -1, t0 = 0, g0 = { tot: 0, draws: 0, fb: 0, fbSw: 0, upN: 0, upB: 0 }, byStart = null;
  const ENG_PARTS = ['simMs', 'renderMs', 'submitMs', 'bgExtMs', 'lightMs', 'glowPx', 'specPx', 'tagged'];
  let lastPS = null, lastM = null, lastTickN = -1, lastF = -1, lastCl = null, gpuCount = 0, skipNext = false, pend = null, longs = [], lo = null, startedAt = 0;
  const P = window.__mbaaProf = { on: false, done: false, mode: GPU_MODE };
  function boundary(t) {
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
    if (!M || !gl || document.hidden) { battleSince = 0; return; }
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
  const rafOrig = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = cb => rafOrig(t => {
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
    panel(`perf: recording ${SECS} s…`);
  }
  function finish() {
    if (!P.on) return;
    P.on = false; P.done = true;
    if (lo) { try { lo.disconnect(); } catch (e) {} lo = null; }
    P.sum = summary();
    panelResult(P.sum);
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
    const ua = navigator.userAgent;
    return {
      v: 1, kind: 'mbaa-frame-profile', at: new Date(startedAt).toISOString(), secs: r2(secs), frames: n,
      page: { browser: (ua.match(/(Firefox|Edg|OPR|SamsungBrowser|Chrome|Version)\/[\d.]+/) || [''])[0], os: (ua.match(/\(([^)]*)\)/) || ['', ''])[1].slice(0, 80),
        mobile: PHONE, dpr: devicePixelRatio, screen: [screen.width, screen.height], canvas: cv ? [cv.width, cv.height] : null,
        css: cv ? [cv.clientWidth, cv.clientHeight] : null, cores: navigator.hardwareConcurrency || null, mem: navigator.deviceMemory || null,
        lowmem: !!LOWMEM, live: !!(session && session.liveSrc), paused: !!(typeof ui !== 'undefined' && ui.paused) },
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
  // ---- the panel: a result to read, download, or send (opt-in) ----
  let el = null;
  function panel(text) {
    if (!el) {
      el = document.createElement('div');
      el.id = 'perfprof';
      el.style.cssText = 'position:fixed;left:4px;bottom:4px;z-index:9999;max-width:min(96vw,460px);padding:6px 8px;background:#000d;color:#9f9;font:11px/1.35 ui-monospace,monospace;border-radius:6px;white-space:pre-wrap';
      document.body.append(el);
    }
    el.textContent = text;
    return el;
  }
  function panelResult(s) {
    const f = (o, k = 'p50') => o ? o[k] : '-';
    const lines = [
      `perf ${s.secs} s, ${s.frames} frames: display ${s.display.fps} fps, >20 ms ${Math.round((s.display.over20 || 0) * 100)}%, rAF p95 ${f(s.display.iv, 'p95')} ms`,
      `engine p50/p95 ${f(s.cpu.engine)}/${f(s.cpu.engine, 'p95')} ms, other rAF ${f(s.cpu.otherRaf, 'mean')} ms, idle ${f(s.cpu.idle, 'mean')} ms, game ${s.game.fps} fps`,
      s.s3d ? `3D hook p50/p95 ${f(s.s3d.hook)}/${f(s.s3d.hook, 'p95')} ms (draw ${f(s.s3d.rdraw)}, front ${f(s.s3d.front)}), ${f(s.s3d.draws)} draws` : '3D stage: off',
      `GL ${f(s.gl.calls)} calls, ${f(s.gl.draws)} draws, ${f(s.gl.fbSwitches)} target switches a frame; long tasks ${s.long.n} (max ${s.long.max} ms)`,
      `GPU est (${s.gpuEst.mode}, ${s.gpuEst.samples}): ` + (s.gpuEst.mode === 'fence' ? `signalled ${f(s.gpuEst.fence)} ms after submit` : `tail p50/p95 ${f(s.gpuEst.tail)}/${f(s.gpuEst.tail, 'p95')} ms, pre ${f(s.gpuEst.pre)} ms`),
      `${s.gpu.renderer}`.slice(0, 70),
    ];
    panel(lines.join('\n'));
    const btn = (t, fn) => { const b = document.createElement('button'); b.textContent = t; b.style.cssText = 'margin:4px 6px 0 0;font:11px ui-monospace,monospace'; b.onclick = fn; el.append(document.createElement('wbr'), b); return b; };
    el.append('\n');
    btn('download JSON', () => {
      const blob = new Blob([JSON.stringify({ summary: s, columns: COLS, frames: frames(), longTasks: longs }, null, 1)], { type: 'application/json' });
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `mbaa_perf_${s.at.replace(/[:.]/g, '-')}.json` });
      document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    });
    const sb = btn('send to the devs', async () => {
      sb.disabled = true;
      const id = (session && session.liveSrc && session.liveSrc.id) || 'perf';
      try {
        const r = await fetch(`${LIVE}/live/${encodeURIComponent(id)}/diag`, { method: 'POST', body: JSON.stringify({ why: 'perf', text: JSON.stringify(s) }) });
        sb.textContent = r.ok ? 'sent ✓' : `not sent (${r.status}): download it instead`;
      } catch (e) { sb.textContent = 'not sent: download it instead'; }
    });
    btn('again', () => start());
    btn('×', () => { el.remove(); el = null; });
  }
  P.start = start; P.stop = finish; P.summary = () => P.sum || (n ? summary() : null); P.frames = frames;
  if (WAIT !== 'manual') panel(WAIT === '0' ? 'perf: waiting for the game' : 'perf: waiting for a battle');
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
// (user 2026-11-03: "the vs movie is missing on our site, just black": the 32 MB file was fetched once the match was already
// running, so over the network the first VS screen (~10 s in a replay, ~0.5 s live) was over before it came. Now it is
// fetched as soon as a match starts loading, and on desktop the 2 MB H.264 copy plays first (here in ~1 s) until the
// lossless file is in, which then takes over (CE-exact from then on); a capture run waits for the lossless file only)
const movieGet = f => f.plain ? fetch(f.plain).then(r => r.arrayBuffer()).then(b => new Uint8Array(b)) : fetchObject(f.o, f.z);
const movieCanH264 = async () => typeof VideoDecoder !== 'undefined' && (await VideoDecoder.isConfigSupported(movieConfig(new Uint8Array(0))).catch(() => ({}))).supported;
function movieLoad() {
  if (!movieLoading) movieLoading = (async () => {
    const fh = man.files[MOVIE_H264], fl = man.files[MOVIE];
    if (LOWMEM || !fl) {
      if (!fh) return;
      if (!(await movieCanH264())) throw new Error('this browser cannot decode the H.264 movie (WebCodecs)');
      movieH264 = await movieGet(fh);
      if (session) session.M.mbaaMovieVideo = movieVideo(movieH264);
      return;
    }
    // (desktop: the H.264 copy meanwhile, not in a capture run (its pictures are compared with CE's))
    const quick = !CAPTURE && fh && (async () => {
      if (!(await movieCanH264())) return;
      const b = await movieGet(fh);
      if (movieBytes) return;  // (the lossless one came first)
      movieH264 = b;
      if (session && !session.M.mbaaMovie) session.M.mbaaMovieVideo = movieVideo(b);
    })().catch(e => console.warn('VS movie (H.264):', e));
    movieBytes = await movieGet(fl);
    movieH264 = null;
    if (session) { session.M.mbaaMovie = movieBytes; delete session.M.mbaaMovieVideo; }
    await quick;
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
// (canvasNow: the frame presented again) into #xfcv, laid over the game canvas; once the new stage is drawn (until():
// true for 2 frames; 4 s at most) it fades out over XF_STAGE_MS and is hidden (display: none, its pixels let go): no
// per-frame work once done, and the game is never held back (it runs and draws under the copy). Reduced motion: a cut.
const XF_STAGE_MS = 350;
let xf = null, xfRuns = 0;
const xfReduced = () => !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
function xfGrab(until, max = 4000) {
  if (HASH || CAPTURE || PERF || xfReduced()) return false;
  const src = document.getElementById('canvas'), c = document.getElementById('xfcv');
  if (!c || !src || !src.offsetWidth || !session) return false;
  if (!xf || xf.fading) {  // (a grab already up: it holds the older picture, which is what was on screen)
    try {
      c.width = src.width; c.height = src.height;
      c.getContext('2d').drawImage(canvasNow(), 0, 0);
    } catch (e) { return false; }
    Object.assign(c.style, { left: `${src.offsetLeft}px`, top: `${src.offsetTop}px`, width: `${src.offsetWidth}px`,
                             height: `${src.offsetHeight}px`, transition: 'none', opacity: '1' });
    c.hidden = false;
  }
  xf = { until, t0: performance.now(), n: 0, max };
  window.__mbaaXf = (window.__mbaaXf || 0) + 1;  // (the checks: grabs made)
  requestAnimationFrame(xfWatch);
  return true;
}
function xfWatch() {
  const me = xf;
  if (!me || me.fading || me.watching === false) return;
  let ok = false;
  try { ok = me.until(); } catch (e) { ok = true; }
  if (ok ? ++me.n >= 2 : performance.now() - me.t0 > me.max) { xfFade(me); return; }
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
  if (!liveId) { liveKeptDrop('a replay opened'); liveResumeK = null; }
  // (the last game's picture, faded into the next's; quiet 'switch', another live match picked (startLive): once the
  // new session has drawn a frame of its match, the catch-up's first (s.livePic), or follows with none needed)
  if (quiet && session) { const n0 = xfRuns, old = session; quiet === 'switch' ? xfGrab(() => session !== old && !!session.livePic, 8000) : xfGrab(() => xfRuns > n0); }
  if (!quiet) loading(true);  // (quiet: a live switch, the last game's picture stays until the next one draws)
  // a pick on the radio lasts for its match: a replay's for that replay (a playlist's next, another file has its own
  // music); a live match's for the whole live match (liveId: its next games on a new session, a fallback start), until
  // the viewer changes it or goes to another match (user 2026-11-01)
  if (radioPick && !(liveId && radioLiveId === liveId)) radioSet('');
  if (liveExt.id && liveExt.id !== 'local' && liveExt.id !== liveId) liveExtSet(null, '');  // (a match's extension is that match's only)
  if (musicPick && !(liveId && musicLiveId === liveId)) musicSet('');
  xfStagePending = xfYieldPending = false;  // (the session's start has its own fade)
  if (ensureAudio()) actx.resume();  // (after a drop or file pick: the page has had its gesture)
  const rep = new Uint8Array(await file.arrayBuffer());
  let keys, want;
  try { repKeys(rep); repStageFix(rep); keys = repKeys(rep); want = wantFor(rep); } catch (e) { loading(false); status('error: ' + e.message); return; }
  // live: the select screen's files (every character's portraits and palettes, ~80 MB: they were 80% of a first live
  // join's download, 10-30 s before the first frame) come in the background once the match plays; the retry menu's
  // BGM (small) with the match. liveCssBg holds the game at the result screen if they are not in yet
  const cssBg = want && liveSrc ? [...liveCssFiles(man)].filter(p => !/^bgm\//.test(p)) : null;
  if (want && liveSrc) for (const p of liveCssFiles(man)) if (/^bgm\//.test(p)) want.add(p);
  if (want && liveResumeK) for (const p of liveResumeK.want) want.add(p);  // (back to a kept match: every file it had in)
  if (want) {
    status(`stage ${keys.stage}, P1 ${keys.p1[0]}:${keys.p1[1]} vs P2 ${keys.p2[0]}:${keys.p2[1]}: fetching`);
    bootMark('filesStart');
    await fetchAll(man, want, 'match assets');
    bootMark('files');
    swMark('files');
  }
  if (liveId) swMark('files', true, liveId);
  window.__mbaaKeys = keys;
  const [, when] = repLabel(file.name);
  document.getElementById('title').textContent = matchTitle(rep) + (when ? ` \u00b7 ${when}` : '');
  const next = pl.items[pl.i + 1];
  if (CAPTURE) await movieLoad();
  await play(rep, file.name, 0, want, liveId);
  if (want && next) prefetch(next, want);
  else if (want) cachePrune(new Set([...want, ...(cssBg || [])]));  // the last match: the previous one's files go
  if (cssBg && session && session.liveSrc) liveCssBg(session, cssBg);
}
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
// ---- playlist: several replays played back to back (each from round 1); the next one's files load during play ----
async function prefetch(it, cur) {
  try {
    const nextWant = wantFor(new Uint8Array(await (await itemFile(it)).arrayBuffer()));
    cachePrune(new Set([...cur, ...nextWant]));  // the rest stays in Cache Storage (a decoded track: ~70 MB)
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
// Music and effects levels (user 2026-11-03: "change sfx/music independently ... really use it as melty radio"): two
// sliders in a popover by the volume (#mixb), under the main volume; remembered. Music = the game's BGM and the radio,
// effects = every game sound (hits, voices, the announcer). "music only" = effects 0, music 100.
const mix = { music: 100, sfx: 100 };
try { const m = JSON.parse(localStorage.getItem('mbaaMix') || 'null'); if (m) { mix.music = +m.music; mix.sfx = +m.sfx; } } catch (e) {}
for (const k of ['music', 'sfx']) if (!(mix[k] >= 0 && mix[k] <= 100)) mix[k] = 100;
const lv = n => Math.pow(n / 100, 2);
function musicLevel() { return ui.music ? lv(mix.music) : 0; }
function sfxLevel() { return lv(mix.sfx); }
function mixInit() {
  const b = document.getElementById('mixb'), pop = document.getElementById('mixpop');
  if (!b || !pop) return;
  const mu = document.getElementById('mixmusic'), sx = document.getElementById('mixsfx'), radio = document.getElementById('mixradio');
  const show = () => {
    mu.value = mix.music; sx.value = mix.sfx;
    document.getElementById('mixmusicv').textContent = mix.music; document.getElementById('mixsfxv').textContent = mix.sfx;
    for (const r of [mu, sx]) r.style.setProperty('--p', `${r.value}%`);
    radio.classList.toggle('on', mix.sfx === 0 && mix.music > 0);
    if (musicGain) musicGain.gain.value = musicLevel();
    if (sfxGain) sfxGain.gain.value = sfxLevel();
    try { localStorage.setItem('mbaaMix', JSON.stringify(mix)); } catch (e) {}
  };
  mu.oninput = () => { mix.music = +mu.value; show(); };
  sx.oninput = () => { mix.sfx = +sx.value; show(); };
  radio.onclick = e => {
    e.stopPropagation();
    mix.sfx = 0; if (!mix.music) mix.music = 100;
    // (the music chip off would leave nothing: on with it)
    const me = document.getElementById('music'); if (me && !me.checked) { me.checked = true; me.dispatchEvent(new Event('change')); }
    show();
  };
  document.getElementById('mixreset').onclick = e => { e.stopPropagation(); mix.music = 100; mix.sfx = 100; show(); };
  const place = () => {
    const r = b.getBoundingClientRect(), w = pop.offsetWidth || 240, h = pop.offsetHeight || 120;
    pop.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, r.right - w))}px`;
    pop.style.top = `${r.top - h - 8 >= 8 ? r.top - h - 8 : r.bottom + 8}px`;
  };
  const open = on => { pop.hidden = !on; b.setAttribute('aria-expanded', String(on)); if (on) place(); };
  b.onclick = e => { e.stopPropagation(); b.blur(); open(pop.hidden); };
  pop.addEventListener('click', e => e.stopPropagation());
  document.addEventListener('click', () => { if (!pop.hidden) open(false); });
  addEventListener('resize', () => { if (!pop.hidden) place(); });
  addEventListener('keydown', e => { if (e.key === 'Escape' && !pop.hidden) open(false); });
  show();
}
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
  s.clipView = clipViewFor(s, b);  // (the timeline zooms to the round the clip ends in, tlView)
  marksKey = '';
  clipPanelShow(true);
  status(`clip ${fmtTime(a)} – ${fmtTime(b)} (${((b - a) / 60).toFixed(1)} s): drag the handles to trim; ` +
         (clipIsLive(s) ? (liveClipCan() ? 'Copy link (C) saves the game so far as a replay, Save MP4 (E), Esc clears' : `Save MP4 (E) keeps it; ${LIVE_SIGNIN}`)
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
  const { lo, hi, zoom } = tlView(s, max), span = Math.max(1, hi - lo);
  const pa = `${(100 * (c.a - lo) / span).toFixed(3)}%`, pb = `${(100 * (c.b - lo) / span).toFixed(3)}%`;
  const ha = document.getElementById('chA'), hb = document.getElementById('chB');
  if (ha.style.left !== pa) ha.style.left = pa;
  if (hb.style.left !== pb) hb.style.left = pb;
  const live = clipIsLive(s), can = live && liveClipCan(), pend = live && liveClipPending(s), key = `${c.a}:${c.b}:${live}:${can}:${pend}:${clipZoom}:${zoom}`;
  if (key === clipPanelKey) return;
  clipPanelKey = key;
  const zb = document.getElementById('cpzoom');
  zb.classList.toggle('on', clipZoom);
  zb.querySelector('.zl').textContent = clipZoom ? 'Whole set' : 'Zoom in';
  zb.querySelector('.i-smaller').hidden = !clipZoom; zb.querySelector('.i-full').hidden = clipZoom;
  zb.title = clipZoom ? 'Show the whole set on the timeline (Z)' : 'Zoom the timeline to the clip\'s round (Z)';
  document.getElementById('cpa').textContent = fmtTime(c.a);
  document.getElementById('cpb').textContent = fmtTime(c.b);
  document.getElementById('cplen').textContent = `${((c.b - c.a) / 60).toFixed(1)} s`;
  ha.setAttribute('aria-valuenow', c.a); ha.setAttribute('aria-valuetext', fmtTime(c.a));
  hb.setAttribute('aria-valuenow', c.b); hb.setAttribute('aria-valuetext', fmtTime(c.b));
  const link = document.getElementById('cplink');
  link.disabled = live && !can;
  link.title = !live ? 'Copy a link that plays just this clip (C)'
             : !can ? `Copy link: ${LIVE_SIGNIN}`
             : pend ? 'Copy link: making the link (the game so far is saved as a replay); it is copied when it is ready'
             : 'Copy a link to this clip (C): the game so far is saved as a replay with the chat said during the clip';
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
  // A handle dragged past the zoomed view's edge: the handle goes on past it, faster the further out the pointer is (the
  // view widens with the clip, tlView), until the pointer comes back in or lets go. The rate is in replay time per wall
  // second, from the clock (not per tick: a page busy seeking or drawing moved it at another speed): just past the edge
  // 1.5 s/s, a bar's width out 60 s/s (PAN_FPS), however long the page's seeks keep its timers waiting (a live set's DVR
  // seek re-simulates for a second or more: a cap of 250 ms per step ran the pan at a fifth of its speed); only a stall
  // over 10 s is not caught up. While panning the picture follows when no seek is running, at most twice a
  // second (each move a seek, the heavy part), and lands on the handle at the end.
  const PAN_FPS = out => Math.min(3600, 90 + 3510 * Math.abs(out));  // frames of replay per second held
  let pan = null;
  const panStop = () => { if (pan) { clearInterval(pan.t); pan = null; } };
  for (const [id, w] of [['chA', 'a'], ['chB', 'b']]) {
    const h = document.getElementById(id);
    // the pointer's place on the bar (0..1; outside: past an edge) and the view it maps into
    const at = e => { const r = tl.getBoundingClientRect(), v = tlView(session, tlMax(session.tl));
      return { fr: (e.clientX - r.left) / Math.max(1, r.width), v }; };
    const move = e => {
      const { fr, v } = at(e), span = Math.max(1, v.hi - v.lo);
      const out = fr < 0 ? fr : fr > 1 ? fr - 1 : 0;
      // (out past an edge, the pan below moves the handle: set to the edge on every move, the view widened by its margin
      // each time and ran away)
      if (!out || !v.zoom) clipSet(w, v.lo + Math.max(0, Math.min(1, fr)) * span, true);
      if (!out || !v.zoom) { panStop(); return; }
      if (pan) { pan.out = out; return; }
      // (window.__clipPan: the pan's ticks, for tests: tools/web/clip_zoom_check.py / clip_zoom_live_check.py)
      window.__clipPan = { ticks: 0, dtMax: 0, frames: 0, seeks: 0, out, t0: performance.now() };
      pan = { out, last: performance.now(), acc: 0, seekAt: 0, moved: false, t: setInterval(() => {
        const s = session;
        if (!pan || !clipDrag || !s || !s.clip || !s.tl) { panStop(); return; }
        const now = performance.now(), dt = Math.min(10000, now - pan.last);
        pan.last = now; pan.acc += PAN_FPS(pan.out) * dt / 1000;
        const st = window.__clipPan; st.ticks++; st.dtMax = Math.max(st.dtMax, now - (st.lastAt || now)); st.lastAt = now; st.out = pan.out;
        const step = Math.floor(pan.acc);
        if (!step) return;
        pan.acc -= step;
        const seek = now - pan.seekAt >= 500 && !s.tl.running;
        if (seek) pan.seekAt = now;
        clipSet(w, s.clip[w] + Math.sign(pan.out) * step, seek);
        pan.moved = !seek; st.frames += step; st.seeks += seek ? 1 : 0;
      }, 30) };
    };
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
      move(e);
    });
    const end = e => {
      if (!clipDrag || clipDrag.w !== w || clipDrag.id !== e.pointerId) return;
      const last = pan && pan.moved;  // (the pan's last step not shown yet: the picture to the handle)
      panStop();
      const d = clipDrag; clipDrag = null; h.classList.remove('drag');
      if (last && session && session.clip && !d.playing) requestSeek(session.clip[d.w]);
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
  on('cplink', copyTimestamp); on('cpsave', exportVideo); on('cpclear', clearClip); on('cpzoom', toggleClipZoom);
}

// ---- live clip links: a clip of a live match as a replay link (?r=<id>&t=<in>&e=<out>&c=<clip id>&loop=1) ----
// The game itself keeps a finished game's replay: the session plays the stream in record mode, and at the game's retry
// menu web/host/spectate.cpp tape_keep writes the game's own tape to MEMFS /lt/g<game>_f<battle start>_e<end>.rep
// (game: its Loading index, -1 the session's first). liveTapes moves it into the page (L.tapes; nothing leaves the page
// otherwise). Copy link on a live clip (signed-in chat accounts only): the game's tape and the chat said during the clip
// go to the Worker (POST <chat path>/clip, tools/web/replay_worker.js liveClip): the replay is stored in the replay
// store like a shared one (named by its content: one stored replay per game however many clip it), with the players'
// names in its PCRM block, and the clip's chat as a small JSON (c/<id>) the link names. A game still being played: the
// game so far is saved at once (liveTapeNow: the session seeks to the clip's out point, web/host/spectate.cpp
// spectate_tape_snap writes the tape and its live forcing up to there without changing the game, the picture goes back),
// uploaded, and the link copied in the same click (a ClipboardItem given the link to come; else C copies it once it is
// there). Only where no snapshot can be made (not in a game's battle) the link waits for the game's end, as before.
// Frames: a replay's battle starts at viewer frame REP_BATTLE_AT (the VS screen's 9.4 s first; every replay:
// harness-design/web_parity/viewer_tools/rep_battle_start_probe.py), the session's at the tape's recFrame + 1 (a live boot
// goes straight to battle, a rematch after its retry menu and VS screen): replay frame = live frame - recFrame - 1 + REP_BATTLE_AT.
const REP_BATTLE_AT = 566;
const LIVE_SIGNIN = 'sign in to share live clips (the chat’s Sign in)';
const liveClipCan = () => { const C = window.mbaaChat; return !!(C && C.irc && C.irc.account); };
// (a pending link is for the clip as it was when Copy was pressed: moving its in / out points makes it another clip)
const clipSame = (p, c) => !!(p && c && p.clip === c && p.game === c.game && p.a === c.a && p.b === c.b);
const liveClipPending = s => !!(s && s.liveSrc && s.liveSrc.clipPend && clipSame(s.liveSrc.clipPend, s.clip) && !s.liveSrc.clipPend.link);
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
// the capture's clock (the feed's /clock), fetched once per link and never waited on for more than 1.5 s (the link is instant)
const liveClock = (L, p) => p.clockP || (p.clockP = fetch(`${LIVE}/live/${L.id}/clock`,
  { cache: 'no-store', ...(AbortSignal.timeout ? { signal: AbortSignal.timeout(1500) } : {}) }).then(r => r.ok ? r.json() : null).catch(() => null));
async function liveClipChat(s, c, p) {
  const C = window.mbaaChat, lv = window.mbaaChatApi.live(), L = s.liveSrc;
  if (!C || !lv || !lv.recs || c.loc0 == null) return [];
  const idx = C.nowOf({ ...lv, ahead: 0 }).idx;
  let clock = C.tl && C.tl.clock;
  const k = await liveClock(L, p);
  if (k) clock = k;
  const st = C.status(), want = ['#melty', st.matchChan].filter(Boolean).map(n => n.toLowerCase()), out = [];
  for (const ch of C.chans.values()) {
    if (!want.includes(String(ch.name).toLowerCase())) continue;
    for (const l of ch.lines) {
      if (l.sys || l.gone) continue;
      const pic = String((l.pic != null ? l.pic : l.text) || ''), x = l.action ? pic : pic.replace(/^(@\S+[:,]?\s*)+/, '').trim();
      if (!x) continue;
      // (the frame the picture showed it at here, when it was put on the picture (chat.js danmaku_: l.dmAt): the clip
      // shows it at the same frame and row; a comment still crossing at the in point keeps its earlier start (o < 0).
      // A line never put on the picture here (the overlay off, a full picture): its stream position)
      let f;
      if (l.dmAt && l.dmAt.f != null) { f = l.dmAt.f; if (f < c.a - 900 || f > c.b) continue; }
      else {
        const pos = l.at || C.clockPos(clock, +l.time);
        const loc = pos ? C.localOf(idx, pos) : null;
        if (loc == null) continue;
        f = loc - c.loc0;
        if (f < c.a || f > c.b) continue;
      }
      out.push({ o: f - c.a, n: String(l.nick || '').slice(0, 40), x: x.slice(0, 300), m: String(l.cmd || '').slice(0, 80),
                 c: /^#[0-9a-f]{6}$/i.test(l.color || '') ? l.color : '', a: l.action ? 1 : 0,
                 // (the chat's text, the sender's name style, the ~wave~ text, icon, an operator's line: chat.js clipLine)
                 ...(C.clipLine ? C.clipLine(l) : {}) });
    }
  }
  return out.sort((p, q) => p.o - q.o).slice(0, 500);
}
// (moment: the right-click menu's "Copy link at this moment" on a live match: a few seconds up to the frame on screen,
// the link plays on from there (no out point, no loop))
async function liveClipLink(s, c = s.clip, moment = false) {
  const L = s.liveSrc;
  if (!c) { status('live: take a clip (X) to share a moment of a live match'); return; }
  if (!liveClipCan()) { status(`live clip: ${LIVE_SIGNIN}`); return; }
  if (L.clipPend && clipSame(L.clipPend, c)) {  // (its link is there: copy it now, a click being a user gesture)
    if (L.clipPend.link) return liveClipCopy(L.clipPend.link);
    status(L.clipPend.busy ? 'live clip: making the link…' : 'live clip: the link is made when this game ends (its replay is saved then): Esc to watch on, it is copied then');
    return;
  }
  // the clipboard, written now (this click or C is the user gesture the browser wants) with the link to come
  // (ClipboardItem given a promise: Chrome, Safari, Firefox 127+); elsewhere liveClipUpload copies it, or C does
  let give = null, wrote = null;
  if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
    const lp = new Promise((res, rej) => { give = { res, rej }; });
    lp.catch(() => {});
    try { wrote = navigator.clipboard.write([new ClipboardItem({ 'text/plain': lp.then(t => new Blob([t], { type: 'text/plain' })) })]); wrote.catch(() => {}); }
    catch (e) { wrote = null; give = null; }
  }
  const p = { clip: c, game: c.game, a: c.a, b: c.b, chat: [], link: null, busy: true, give, wrote, moment };
  L.clipPend = p; clipPanelKey = ''; marksKey = '';
  status('live clip: saving the game so far as a replay…');
  p.chat = await liveClipChat(s, c, p);
  p.busy = false;
  liveTapes(s);  // (the game has ended: its whole replay, liveTapes uploads it)
  if (L.tapes.has(p.game) || p.busy || L.clipPend !== p) return;
  p.busy = true;
  const T = await liveTapeNow(s, p).catch(e => { console.warn('live clip: no snapshot:', e); return null; });
  p.busy = false;
  if (L.clipPend !== p) return;
  if (T) return liveClipUpload(s, p, T);
  liveTapes(s);
  if (L.tapes.has(p.game) || p.busy) return;
  if (p.give) { p.give.rej(new Error('the link is made when this game ends')); p.give = null; }
  status('live clip: the link is made when this game ends (its replay is saved then): Esc to watch on, it is copied then');
  clipPanelKey = ''; marksKey = '';
}
// the clip's game so far as a replay (a game still being played): the session at the clip's out point (a seek, paused:
// the DVR re-simulates there, the same frames the session showed), spectate_tape_snap writes its tape and live forcing
// up to there (/lt/s<game>_f<battle start>_e<end>.rep + .lt; the game's memory unchanged, the game-end tape_keep still
// gets everything), then the picture goes back where it was. -> {rep, lt, rec, end, snap: true} | null
async function liveTapeNow(s, p) {
  const L = s.liveSrc, M = s.M, f0 = M._viewer_frame(), paused = ui.paused;
  const gameNow = () => { const g = call(s, 'viewer_spectate_game'); return g >= 0 ? g : L.firstGame; };
  if (!paused) setPaused(true);  // (the preview's loop (clipTick) would seek away meanwhile)
  let T = null;
  try {
    const t0 = performance.now();
    if (f0 !== p.b) await requestSeek(p.b);
    const why = session !== s ? 'session gone' : M._viewer_frame() < p.b ? `at frame ${M._viewer_frame()}, not ${p.b}` : gameNow() !== p.game ? `in game ${gameNow()}, not ${p.game}` : '';
    try { for (const n of M.FS.readdir('/lt')) if (/^s-?\d+_/.test(n)) M.FS.unlink(`/lt/${n}`); } catch (e) {}
    if (why || !call(s, 'viewer_live_tape_now')) { console.log(`live clip: no snapshot (${why || 'not in a game being recorded'}; seek ${Math.round(performance.now() - t0)} ms)`); return null; }
    console.log(`live clip: snapshot at frame ${M._viewer_frame()} (seek from ${f0}: ${Math.round(performance.now() - t0)} ms)`);
    for (const n of M.FS.readdir('/lt')) {
      const m = n.match(/^s(-?\d+)_f(\d+)_e(\d+)\.rep$/);
      if (!m) continue;
      const rep = M.FS.readFile(`/lt/${n}`), ltn = `/lt/${n.slice(0, -4)}.lt`;
      let lt = null;
      try { lt = M.FS.readFile(ltn); M.FS.unlink(ltn); } catch (e) {}
      M.FS.unlink(`/lt/${n}`);
      T = { rep, lt, rec: +m[2], end: +m[3], snap: true };
      console.log(`live: game ${p.game} so far kept for a clip (${rep.length} bytes, live forcing ${lt ? lt.length : 0} bytes, battle from frame ${m[2]}, end ${m[3]})`);
    }
    return T && T.end >= p.b ? T : null;
  } finally {
    if (session === s) {
      const back = M._viewer_frame() !== f0 ? requestSeek(f0) : Promise.resolve();
      if (!paused) back.then(() => { if (session === s && ui.paused) setPaused(false); });
    }
  }
}
async function liveClipUpload(s, p, snap) {
  const L = s.liveSrc, T = snap || L.tapes.get(p.game);
  p.busy = true;
  status(snap ? 'live clip: uploading the game so far…' : 'live clip: saving the game as a replay…');
  try {
    // frames in the replay: anchored at the battle's first frame (the session's frame T.rec + 1: T.rec is the 0-based
    // step the game went to record mode at; the replay's REP_BATTLE_AT). With the game's live forcing (T.lt) the replay
    // then plays the session's frames exactly, rounds, intros and win poses included (live_clip_link_check: clipFix moves 0)
    const off = T.rec + 1 - REP_BATTLE_AT;
    const t = Math.max(1, p.a - off), e = Math.max(t + 1, Math.min(T.end - off, p.b - off));
    const rep = T.rep.slice();
    // the header's date: the game's start on the capture's clock (the same for every viewer: one stored replay per game)
    try {
      const k = await liveClock(L, p), at = k && k.wall != null ? k.s.find(x => x[1] >= p.game) : null;
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
    if (!snap) T.id = j.r;
    const u = new URL(LIVE_CLIP_SITE + '/');
    u.searchParams.set('r', j.r); u.searchParams.set('t', p.moment ? e : t);
    if (!p.moment) u.searchParams.set('e', e);
    if (j.c) u.searchParams.set('c', j.c);
    if (!p.moment) u.searchParams.set('loop', '1');
    p.link = u.toString(); p.t = t; p.e = e; p.id = j.r; p.cid = j.c;
    window.__mbaaLastLink = p.link;
    clipPanelKey = ''; marksKey = '';
    // (the clipboard: the write the click started gets the link; else written now, which some browsers allow only in a
    // click: then C copies it)
    let copied = false;
    if (p.give) { p.give.res(p.link); p.give = null; copied = await p.wrote.then(() => true, () => false); }
    if (!copied) copied = await navigator.clipboard.writeText(p.link).then(() => true, () => false);
    p.copied = copied;
    status(copied ? `copied: ${p.link}` : `live clip link ready: Copy link (C) copies it: ${p.link}`);
  } catch (err) {
    console.warn('live clip link failed:', err);
    if (p.give) { p.give.rej(err); p.give = null; }
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
let clipChat = null;  // [{f, x, col, px, row, loc, w, v, life, y, st, grad, segs}] or null
const CC_SIZE = { small: [51, 51], medium: [76, 82], big: [110, 129] };
const CC_COLOR = { white: '#FFFFFF', red: '#FF0000', pink: '#FF8080', orange: '#FFC000', yellow: '#FFFF00', green: '#00FF00',
  cyan: '#00FFFF', blue: '#0000FF', purple: '#C000FF', black: '#000000', white2: '#CCCC99', niconicowhite: '#CCCC99',
  red2: '#CC0033', truered: '#CC0033', pink2: '#FF33CC', orange2: '#FF6600', passionorange: '#FF6600', yellow2: '#999900',
  madyellow: '#999900', green2: '#00CC66', elementalgreen: '#00CC66', cyan2: '#00CCCC', blue2: '#3399FF', marinblue: '#3399FF',
  purple2: '#6633CC', nobleviolet: '#6633CC', black2: '#666666' };
const CC_FONT = 'MbaaFlags, "Arial", "MS PGothic", "Hiragino Kaku Gothic ProN", "Noto Sans CJK JP", sans-serif';
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
      // (a styler's line: their look as the chat's and the native renderer's, mbaaNameFx; the gradient when no colour
      // command is given; ~wave~ from the picture's wave text (segments between U+E000 / U+E001), letter by letter)
      const st = typeof l.s === 'string' && l.s ? mbaaNameFx.parse(l.s) : null;
      if (st && Object.keys(st).length) {
        c.st = st; c.grad = !!st.grad && !cmds.some(k => CC_COLOR[k] || /^#[0-9a-f]{6}$/.test(k));
        const xw = typeof l.xw === 'string' && l.xw.includes('\uE000') ? (l.a ? `${l.n} ${l.xw}` : l.xw) : null;
        if (xw) {
          c.segs = [];
          xw.split('\uE000').forEach((piece, n) => {
            const [inside, after] = n === 0 ? ['', piece] : piece.includes('\uE001') ? piece.split('\uE001', 2) : [piece, ''];
            if (inside) c.segs.push({ t: inside, wave: true });
            if (after) c.segs.push({ t: after.replace(/[\uE000\uE001]/g, ''), wave: false });
          });
        }
      }
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
    if (c.st) { clipChatStyled(g, c, x0 + (x + 4) * k, y * k, k, T); continue; }
    g.lineWidth = Math.max(1, 4 * k); g.strokeStyle = c.col === '#000000' ? '#FFFFFF' : '#000000';
    g.strokeText(c.text, x0 + (x + 4) * k, y * k);
    g.fillStyle = c.col; g.fillText(c.text, x0 + (x + 4) * k, y * k);
  }
  g.restore();
}
// a styler's comment in 2D at x, y (device px; k device px a stage unit; T the picture's time, the clip page's style
// clock): the same numbers as overlay_gl's (chat.js glovStyle): the gradient's colours where the cycle has them at T,
// the glow (radius r * px / 18, in place of the outline), the shadow (s px at the chat's ~15 px font, scaled gently), the
// ~wave~ letters' offsets (mbaaNameFx.waveY, amplitude a * px / 15)
function clipChatStyled(g, c, x, y, k, T) {
  const F = mbaaNameFx, st = c.st, segs = c.segs || [{ t: c.text, wave: false }];
  const parts = [];  // [char, dx, wave index or -1]
  let dx = 0;
  for (const sg of segs) Array.from(sg.t).forEach((ch, i) => { parts.push([ch, dx, sg.wave ? i : -1]); dx += g.measureText(ch).width; });
  const tw = Math.max(1, dx), amp = (st.wave || { a: 4 }).a * c.px / 15 * k;
  let fill = c.col;
  if (c.grad) { const gr = g.createLinearGradient(x, 0, x + tw, 0); for (const [u, col] of F.gradStops(st, T)) gr.addColorStop(u, col); fill = gr; }
  const yOf = p => y + (p[2] >= 0 ? Math.round(F.waveY(st, p[2], T) * amp) : 0);
  const draw = (ox, oy, style) => { g.fillStyle = style; for (const p of parts) g.fillText(p[0], x + p[1] + ox, yOf(p) + oy); };
  if (st.shadow) {
    const full = st.shadow.s * c.px / 15 * k, r = Math.max(0.5, st.shadow.s * Math.pow(Math.max(1, full / st.shadow.s), 0.3)), d = r * Math.SQRT1_2;
    const offs = st.shadow.k === 'd' ? [[r, r]] : [[r, 0], [-r, 0], [0, r], [0, -r], [d, d], [-d, d], [d, -d], [-d, -d]];
    for (const [ox, oy] of offs) draw(ox, oy, st.shadow.c);
  }
  if (st.glow) { g.shadowColor = st.glow.c; g.shadowBlur = st.glow.r * c.px / 18 * k; }
  draw(0, 0, fill);
  if (st.glow) { g.shadowBlur = 0; g.shadowColor = 'transparent'; }
}

// ---- video export: the clip, or the round being watched, as a 1280x960 60 fps video (every game frame drawn 2x,
// nearest neighbour, with the hitbox / input overlay) with the game's sound at its own level (before the volume slider).
// Fast path (WebCodecs): the game is stepped as fast as it runs and each frame encoded (H.264, VP9 where there is no
// H.264 encoder), the sound events of those frames are logged and rendered in an OfflineAudioContext, and both go into an
// MP4 (vendor/mp4-muxer). Without WebCodecs the range is played at 1x and recorded with MediaRecorder.
let rec = null, fx = null;
// Firefox's H.264 encoder hands over a malformed avcC (every SPS/PPS NAL header byte doubled, reserved bits missing):
// strict players and upload sites reject the file ("SPS decoding failure"). A config that does not check out is rebuilt
// from the keyframe's own in-band SPS/PPS (the chunk is length-prefixed, format 'avc').
function avcOk(d) {
  if (!d || d.length < 11 || d[0] !== 1 || (d[4] & 0xFC) !== 0xFC || (d[5] & 0xE0) !== 0xE0 || !(d[5] & 0x1F)) return false;
  const n = d[6] << 8 | d[7];
  return n > 3 && 8 + n <= d.length && (d[8] & 0x1F) === 7 && d[9] === d[1] && d[10] === d[2] && d[11] === d[3];
}
function avcFix(ch, meta) {
  const dc = meta && meta.decoderConfig;
  if (!dc || !dc.description || !String(dc.codec || '').startsWith('avc1')) return meta;
  const d = new Uint8Array(dc.description instanceof ArrayBuffer ? dc.description : dc.description.buffer.slice(dc.description.byteOffset, dc.description.byteOffset + dc.description.byteLength));
  if (avcOk(d) || ch.type !== 'key') return meta;
  const b = new Uint8Array(ch.byteLength); ch.copyTo(b);
  const sps = [], pps = [];
  for (let i = 0; i + 4 <= b.length;) {
    const n = (b[i] << 24 | b[i + 1] << 16 | b[i + 2] << 8 | b[i + 3]) >>> 0; i += 4;
    if (!n || i + n > b.length) break;
    const t = b[i] & 0x1F;
    if (t === 7) sps.push(b.subarray(i, i + n)); else if (t === 8) pps.push(b.subarray(i, i + n));
    i += n;
  }
  if (!sps.length || !pps.length) return meta;
  const s0 = sps[0], parts = [1, s0[1], s0[2], s0[3], 0xFF, 0xE0 | sps.length];
  for (const x of sps) parts.push(x.length >> 8, x.length & 255, ...x);
  parts.push(pps.length);
  for (const x of pps) parts.push(x.length >> 8, x.length & 255, ...x);
  // High and up: chroma format / bit depths / no SPS-ext (4:2:0, 8-bit, what the encoder makes)
  if (![66, 77, 88].includes(s0[1])) parts.push(0xFC | 1, 0xF8, 0xF8, 0);
  return { ...meta, decoderConfig: { ...dc, description: new Uint8Array(parts) } };
}
const REC_TYPES = ['video/mp4;codecs=avc1.640033,mp4a.40.2', 'video/mp4;codecs=avc1.640033,opus', 'video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'];
// Sizes (user 2026-11-04): every one an exact whole multiple of the game's 640x480, nearest neighbour, 60 fps. Picked
// in a chooser each time Save MP4 / E is pressed (user 2026-11-04: "i didnt see any settings beforehand"); the last pick
// is the next default, 1280x960 the first one. Bitrates (user 2026-11-04: a 1920x1440 export at 24 Mbps lagged and
// drifted out of sync playing in Discord / the browser: 75 MB for 25 s, more than a streamed player keeps up with):
// nearest-upscaled pixel art needs far less than camera video. X takes at most 1280x1024
// (docs.x.com/x-api/media/quickstart/best-practices): 1280x960 is the size for X and Discord.
const EXPORT_SIZES = { 1: [640, 480, 3e6], 2: [1280, 960, 8e6], 3: [1920, 1440, 14e6] };
const EXPORT_NOTE = { 1: 'small file', 2: 'for Discord and Twitter', 3: 'largest; slow to save in Firefox' };
let exportScale = 2;
try { const v = +localStorage.getItem('mbaaExportScale2'); if (EXPORT_SIZES[v]) exportScale = v; } catch (e) {}
{ const m = +Q.get('exportMbps'); if (m > 0) for (const k in EXPORT_SIZES) EXPORT_SIZES[k][2] = m * 1e6; }  // (tests)
function exportScaleSet(v) {
  if (!EXPORT_SIZES[v]) return;
  exportScale = v;
  try { localStorage.setItem('mbaaExportScale2', String(v)); } catch (e) {}
}
const exportDims = () => EXPORT_SIZES[exportScale];
const EXPORT_SR = 48000, EXPORT_ABPS = 192000, EXPORT_PREROLL = 180;  // pre-roll: sounds already playing at the in point
const IS_FIREFOX = /Firefox\//.test(navigator.userAgent);
// Save MP4 / E: the size chooser first (1/2/3 or a click picks, Enter takes the highlighted one, Esc closes); E again
// while it is open closes it. ?exportScale=1|2|3 skips it (tests).
function exportVideo() {
  if (fx) { fx.cancel = true; return; }
  if (rec) return stopRecording(true);
  const s = session;
  if (!s || !s.tl) return;
  const qs = +Q.get('exportScale');
  if (EXPORT_SIZES[qs]) { exportScaleSet(qs); return exportVideoGo(); }
  exportChooser();
}
function exportChooser() {
  const stage = document.getElementById('canvas').closest('.stage') || document.body;
  let el = document.getElementById('xpick');
  if (el && !el.hidden) { el.hidden = true; return; }
  if (!el) {
    el = document.createElement('div'); el.id = 'xpick'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Save MP4');
    stage.append(el);
  }
  const s = session, c = s && (s.clip || roundClip(s)), secs = c ? Math.max(0, c.b - c.a) / 60 : 0;
  el.innerHTML = '<div class="xpt">Save MP4 · 60 fps' + (secs ? ` · ${secs.toFixed(1)} s` : '') + '</div>' +
    Object.keys(EXPORT_SIZES).sort((a, b) => b - a).map(k => {
      const [w, h, bps] = EXPORT_SIZES[k], mb = (bps + EXPORT_ABPS) * secs / 8 / 1048576;
      return `<button data-k="${k}" class="${+k === exportScale ? 'on' : ''}"><b>${w}&times;${h}</b><span>${EXPORT_NOTE[k]}${secs ? ` · ~${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB` : ''}</span><kbd>${k}</kbd></button>`;
    }).join('') + '<div class="xph">1 / 2 / 3 or click · Esc closes</div>';
  el.hidden = false;
  const close = () => { el.hidden = true; document.removeEventListener('keydown', key, true); };
  const go = k => { close(); exportScaleSet(+k); exportVideoGo(); };
  const key = e => {
    if (el.hidden) { document.removeEventListener('keydown', key, true); return; }
    if (e.key === 'Escape' || e.key === 'e' || e.key === 'E') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (EXPORT_SIZES[+e.key]) { e.preventDefault(); e.stopPropagation(); go(e.key); }
    else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); go(exportScale); }
  };
  document.addEventListener('keydown', key, true);
  for (const b of el.querySelectorAll('button')) b.onclick = e => { e.stopPropagation(); go(b.dataset.k); };
}
async function exportVideoGo() {
  const s = session;
  if (fx || rec || !s || !s.tl) return;
  ensureAudio(true); await actx.resume();
  if (inIntro(s)) await skipIntro(s);
  const c = s.clip ? { ...s.clip } : roundClip(s);
  if (s.liveSrc) {  // a live match: up to the newest frame received (the round may not have ended yet)
    c.b = Math.min(c.b, s.M._viewer_frame() + call(s, 'viewer_spectate_buffered'));
    if (c.b <= c.a) { status('nothing received after the clip start yet'); return; }
  }
  if (window.VideoEncoder && window.VideoFrame && Q.get('exportMode') !== 'realtime') {
    try {
      const codecs = await exportCodecs(exportScale);
      // each encoder setup in turn: one that fails (a hardware encoder that will not start, or one that emits B-frames:
      // frames out of order, which the muxer cannot take) is dropped for the next
      for (let i = 0; i < codecs.videos.length; i++) {
        try { if (await fastExport(s, c, codecs.videos[i], codecs.audio)) return; }
        catch (e) {
          if (e.message === 'cancelled' || i === codecs.videos.length - 1) throw e;
          console.warn(`${codecs.videos[i].codec} (${codecs.videos[i].hardwareAcceleration || 'any'}): ${e.message || e}; next encoder setup`);
        }
      }
    } catch (e) { console.error('video export failed:', e); status(`video export failed: ${e.message || e}`); return; }
  }
  return exportRealtime(s, c);
}
function loadScript(src) {
  return new Promise((res, rej) => { const e = document.createElement('script'); e.src = src; e.onload = res;
    e.onerror = () => rej(new Error(`could not load ${src}`)); document.head.append(e); });
}
// The video encoder setups this browser takes for that size, best first, at 60 fps. H.264 at the level the size needs
// (640x480: 3.1, 1280x960: 4.2, 1920x1440: 5.1 (10800 macroblocks, 648000 a second; 5.0 allows 589824)): High (Chrome;
// Firefox's High profile encoder emits B-frames, out of decode order, which the muxer cannot take, so Firefox gets
// Constrained Baseline), then Main and Constrained Baseline, then VP9 where there is no H.264 encoder; each with a
// hardware encoder first where the browser has one (much faster; the same bitrate). A smaller size only where nothing
// takes the one asked for. Audio: AAC-LC always (X and Windows Media Player take no Opus in MP4): the browser's
// AudioEncoder where it has one, else FFmpeg's (vendor/aac_enc.js, aacSoft).
const EXPORT_AVC = { 1: ['1F', '20'], 2: ['2A', '32'], 3: ['33', '34'] }, EXPORT_VP9 = { 1: '31', 2: '40', 3: '50' };
async function exportCodecs(scale) {
  const videos = [];
  for (let sc = scale; sc >= 1 && !videos.length; sc--) {
    const [w, h, bps] = EXPORT_SIZES[sc], lv = EXPORT_AVC[sc];
    const avc = [];
    for (const p of IS_FIREFOX ? ['42E0'] : ['6400', '4D00', '42E0']) for (const l of lv) avc.push(`avc1.${p}${l}`);
    for (const codec of [...avc, `vp09.00.${EXPORT_VP9[sc]}.08`]) {
      const cfg = { codec, width: w, height: h, bitrate: bps, framerate: 60, latencyMode: 'quality' };
      if (codec.startsWith('avc1')) cfg.avc = { format: 'avc' };
      for (const hw of ['prefer-hardware', null]) {
        const x = hw ? { ...cfg, hardwareAcceleration: hw } : cfg;
        try { if ((await VideoEncoder.isConfigSupported(x)).supported) videos.push(x); } catch (e) {}
      }
    }
  }
  let audio = null;
  if (window.AudioEncoder) {
    const cfg = { codec: 'mp4a.40.2', sampleRate: EXPORT_SR, numberOfChannels: 2, bitrate: EXPORT_ABPS };
    try { if ((await AudioEncoder.isConfigSupported(cfg)).supported) audio = cfg; } catch (e) {}
  }
  return { videos, audio: audio || { codec: 'mp4a.40.2', soft: true } };
}
// AAC-LC by FFmpeg's native encoder (web/aac: built to vendor/aac_enc.{js,wasm}, loaded on the first export that needs
// it): planar stereo pcm from sample `skip` on -> the muxer's AAC chunks, sample exact with the video: the encoder
// delays its output by its priming (aac_delay) and its first packet needs the one before for its overlap, so it is fed
// from (priming + one packet) before `skip` (the pre-roll's sound) and those packets dropped: the first kept packet
// decodes to the samples from `skip` (its first 1024 samples without the overlap of the packet before: a ~21 ms fade
// in; the muxer writes no edit list).
let aacMod = null;
async function aacSoft(pcm, skip, add) {
  if (!aacMod) aacMod = (async () => {
    if (!window.AACENC) await loadScript('vendor/aac_enc.js');
    return AACENC({ locateFile: f => `vendor/${f}` });
  })();
  let A;
  try { A = await aacMod; } catch (e) { aacMod = null; throw e; }
  if (!A._aac_open(EXPORT_SR, 2, EXPORT_ABPS)) throw new Error('AAC encoder: open failed');
  try {
    const F = A._aac_frame(), D = A._aac_delay(), asc = A.HEAPU8.slice(A._aac_asc(), A._aac_asc() + A._aac_asc_len());
    const L = pcm.getChannelData(0), R = pcm.getChannelData(1), n0 = skip - D - F, end = pcm.length;
    const buf = A._malloc(2 * F * 4);
    const meta = { decoderConfig: { codec: 'mp4a.40.2', sampleRate: EXPORT_SR, numberOfChannels: 2, description: asc } };
    let j = 0, first = true;
    const take = n => {
      for (let i = 0; i < n; i++, j++) {
        const d = A.HEAPU8.slice(A._aac_pkt(i), A._aac_pkt(i) + A._aac_pkt_len(i));
        if (j < 1) continue;  // (the packet before the first kept one)
        const ts = Math.round((j - 1) * F * 1e6 / EXPORT_SR), dur = Math.round(F * 1e6 / EXPORT_SR);
        if ((j - 1) * F >= end - skip) return;  // (past the pcm's end: the encoder's tail)
        add(d, ts, dur, first ? meta : undefined); first = false;
      }
    };
    for (let p = n0; p < end; p += F) {
      const n = Math.min(F, end - p), f32 = A.HEAPF32.subarray(buf >> 2, (buf >> 2) + 2 * n);
      for (let i = 0; i < n; i++) { const q = p + i; f32[i] = q >= 0 ? L[q] : 0; f32[n + i] = q >= 0 ? R[q] : 0; }
      const k = A._aac_encode(buf, n);
      if (k < 0) throw new Error('AAC encoder: encode failed');
      take(k);
      if (p + F >= end) break;
    }
    for (let k; (k = A._aac_encode(0, 0)) > 0;) take(k);
    A._free(buf);
  } finally { A._aac_close(); }
}
function exportName(c, ext) {
  return `${document.getElementById('title').textContent.replace(/[\\/:*?"<>|·]+/g, ' ').replace(/\s+/g, ' ').trim()} ${fmtTime(c.a).replace(/[:.]/g, '-')}.${ext}`;
}
function saveBlob(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  window.__mbaaLastExport = { name, size: blob.size, type: blob.type };
}
// the export's progress over the picture (the picture itself is hidden while the video's frames are drawn: they are
// drawn as fast as the machine goes, not as playback)
function exportProgress(on, frac, text) {
  const stage = document.querySelector('.stage');
  let el = document.getElementById('xprog');
  if (!on) { if (el) el.hidden = true; if (stage) stage.classList.remove('exporting'); return; }
  if (!el && stage) {
    el = document.createElement('div'); el.id = 'xprog';
    el.innerHTML = '<div class="xpt"></div><div class="xpb"><i></i></div><div class="xph">E or Esc cancels</div>';
    stage.append(el);
  }
  if (!el) return;
  if (stage) stage.classList.add('exporting');
  el.hidden = false;
  el.querySelector('.xpt').textContent = text;
  el.querySelector('.xpb i').style.width = `${(100 * Math.max(0, Math.min(1, frac))).toFixed(1)}%`;
}
// The fast path. The game's canvas is drawn at the video's size while exporting: the page's own present blits the
// 640x480 back buffer into it by whole pixels (exactly 2x / 3x, nearest) and the native comment renderer draws a clip
// page's comments into it at that size with their live styles (the clock: the frame's time; the wall clock of their
// animations pinned to video time); each frame is the canvas itself (no 2D copy) unless the hitboxes / inputs (or the
// 2D clip chat) are on, which are painted over a copy. Frames are encoded with a few in flight (the next frame is
// simulated while the encoder works); the pre-roll is simulated without drawing.
async function fastExport(s, c, vcfg, acfg) {
  if (!vcfg) return false;
  const codecs = { video: vcfg, audio: acfg }, W = vcfg.width, H = vcfg.height;
  if (!window.Mp4Muxer) await loadScript('vendor/mp4-muxer.min.js');
  const M = s.M, t0 = performance.now(), pre = Math.max(1, c.a - EXPORT_PREROLL), N = c.b - c.a;
  const P = { seek: 0, preroll: 0, step: 0, copy: 0, vframe: 0, encode: 0, wait: 0, ui: 0, loop: 0, flush: 0, audioRender: 0, audioEnc: 0, mux: 0 };
  fx = { cancel: false };
  const ovNative = clipNative && !!M._viewer_ov_on;  // (a clip page: its comments are drawn by the renderer, into the video too)
  if (M._viewer_ov_on && !ovNative) M._viewer_ov_on(0);  // (the chat page's live comments stay out of the video)
  document.getElementById('clipexp').classList.add('on');
  setPaused(true);
  const hooks = ['mbaaVoicePlay', 'mbaaVoiceParam', 'mbaaVoiceStop', 'mbaaBgmStart', 'mbaaBgmStop'], orig = {};
  const cv = document.getElementById('canvas'), keep = { w: cv.width, h: cv.height };
  let venc = null, sized = false;
  const pinned = ovNative && M._viewer_ov_wall_pin;
  try {
    exportProgress(true, 0, 'Saving MP4: seeking');
    await requestSeek(pre);
    P.seek = performance.now() - t0;
    const muxer = new Mp4Muxer.Muxer({ target: new Mp4Muxer.ArrayBufferTarget(), fastStart: 'in-memory',
      video: { codec: codecs.video.codec.startsWith('avc1') ? 'avc' : 'vp9', width: W, height: H, frameRate: 60 },
      ...(codecs.audio ? { audio: { codec: codecs.audio.codec === 'opus' ? 'opus' : 'aac', sampleRate: EXPORT_SR, numberOfChannels: 2 } } : {}) });
    // every frame has to land: one chunk per frame, timestamps 1/60 s apart in order (a decreasing one is a B-frame)
    let encErr = null, nOut = 0, lastTs = -1, nIn = 0, wake = null;
    venc = new VideoEncoder({ output: (ch, meta) => {
      if (ch.timestamp <= lastTs && !encErr) { encErr = new Error(`${codecs.video.codec}: frames out of order (B-frames)`); encErr.bframes = true; }
      lastTs = ch.timestamp; nOut++;
      if (!encErr) muxer.addVideoChunk(ch, avcFix(ch, meta));
      if (wake) wake();
    }, error: e => { encErr = e; if (wake) wake(); } });
    venc.configure(codecs.video);
    venc.addEventListener && venc.addEventListener('dequeue', () => { if (wake) wake(); });
    // the encoder's queue kept at most this deep: the next frames are simulated while it works
    const DEPTH = 8, room = () => new Promise(r => {
      if (venc.encodeQueueSize < DEPTH || encErr) return r();
      const t = setInterval(() => { if (venc.encodeQueueSize < DEPTH || encErr) done(); }, 4);  // (no dequeue event: polled)
      const done = () => { clearInterval(t); wake = null; r(); };
      wake = () => { if (venc.encodeQueueSize < DEPTH || encErr) done(); };
    });
    // the sound events of every stepped frame, with the frame they happen in
    const ev = [];
    for (const h of hooks) { orig[h] = M[h]; M[h] = (...a) => { ev.push([M._viewer_frame(), h, ...a]); return orig[h](...a); }; }
    // the pre-roll: simulated for its sounds, nothing drawn
    let q = performance.now();
    call(s, 'viewer_suppress', 1);
    try {
      for (let k = M._viewer_frame(); k < c.a; k++) {
        const k0 = M._viewer_frame();
        call(s, 'viewer_step', 1);
        if (M._viewer_frame() === k0) break;
      }
    } finally { call(s, 'viewer_suppress', 0); }
    P.preroll = performance.now() - q;
    if (M._viewer_frame() !== c.a) throw new Error(`the pre-roll ended at frame ${M._viewer_frame()}, not ${c.a}`);
    const over = () => ui.boxes || ui.inputs || (clipChat && !clipNative);
    // Firefox reads a WebGL canvas back slowly (a 1920x1440 VideoFrame: ~24 ms a frame, 0.4x real time in all): there the
    // canvas stays at the game's own 640x480, each frame is read at that size (a ninth of the pixels) and scaled up here
    // by whole pixels (the same nearest picture the page's present draws). Not with the renderer's clip comments or the
    // painted overlays (both drawn at the video's size). ?exportRead=up|canvas forces either way (tests).
    const rd = Q.get('exportRead'), S = W / 640;
    const upRead = (rd === 'up' || (rd !== 'canvas' && IS_FIREFOX)) && !ovNative && !over() && Number.isInteger(S) && S >= 1;
    let upSrc = null, upDst = null, upFmt = null;
    const upFrame = (ts, dur) => {
      const f = new VideoFrame(cv, { timestamp: ts, duration: dur, alpha: 'discard' });
      try {
        const fw = f.codedWidth, fh = f.codedHeight;
        if (fw !== 640 || fh !== 480 || !/^(RGB|BGR)[AX]$/.test(f.format || '')) throw new Error(`frame ${fw}x${fh} ${f.format}`);
        if (!upSrc) { upSrc = new Uint8Array(640 * 480 * 4); upDst = new Uint32Array(W * H); }
        f.copyTo(upSrc);
        upFmt = f.format.slice(0, 3) + 'X';
      } finally { f.close(); }
      const s32 = new Uint32Array(upSrc.buffer), d = upDst;
      for (let y = 0; y < 480; y++) {
        const r0 = y * S * W;
        let o = r0;
        for (let x = 0, i = y * 640; x < 640; x++, i++) { const v = s32[i]; for (let j = 0; j < S; j++) d[o++] = v; }
        for (let j = 1; j < S; j++) d.copyWithin(r0 + j * W, r0, r0 + W);
      }
      return new VideoFrame(d, { format: upFmt, codedWidth: W, codedHeight: H, timestamp: ts, duration: dur });
    };
    if (upRead) { cv.width = 640; cv.height = 480; sized = true; }
    else {
      cv.width = W; cv.height = H; sized = true;
      if (M._viewer_ov_canvas) M._viewer_ov_canvas(W, H);
    }
    let out = null, g = null;
    let lastUi = performance.now();
    for (let k = c.a; k < c.b; k++) {
      if (fx.cancel || session !== s) throw new Error('cancelled');
      if (encErr) throw encErr;
      const k0 = M._viewer_frame();
      // (the renderer's wall clock, which the name styles' gradient and the emotes' frames run on, pinned to the frame's
      // own time: the clip page's clock (mbaaNameFx), so every export of a range animates alike)
      if (ovNative) { M._viewer_ov_clock((k0 + 1) / 60); if (pinned) M._viewer_ov_wall_pin((k0 + 1) / 60); }
      q = performance.now();
      call(s, 'viewer_step', 1);
      P.step += performance.now() - q;
      if (M._viewer_frame() === k0) break;  // the end of the replay (or of the live stream received)
      q = performance.now();
      let src = cv;
      if (over()) {  // the hitboxes / inputs painted over a copy, at the video's size (crisp)
        if (!out) { out = document.createElement('canvas'); out.width = W; out.height = H; g = out.getContext('2d', { alpha: false }); }
        g.drawImage(cv, 0, 0);
        paintOverlay(g, W, H, W / 960);
        src = out;
      }
      P.copy += performance.now() - q; q = performance.now();
      const ts = Math.round((k - c.a) * 1e6 / 60), dur = Math.round(1e6 / 60);
      const vf = upRead ? upFrame(ts, dur) : new VideoFrame(src, { timestamp: ts, duration: dur, alpha: 'discard' });
      P.vframe += performance.now() - q; q = performance.now();
      venc.encode(vf, { keyFrame: (k - c.a) % 120 === 0 }); vf.close(); nIn++;
      P.encode += performance.now() - q; q = performance.now();
      if (venc.encodeQueueSize >= DEPTH) await room();
      P.wait += performance.now() - q;
      if (performance.now() - lastUi > 150) {  // let the page breathe and show progress
        lastUi = performance.now();
        const done = (k - c.a + 1) / N, speed = (k - c.a + 1) / 60 / ((lastUi - t0) / 1000);
        exportProgress(true, done * 0.95, `Saving MP4 ${W}x${H}: ${Math.round(100 * done)}% (${speed.toFixed(1)}x real time)`);
        status(`exporting ${Math.round(100 * done)}% (${speed.toFixed(1)}x real time; E or Esc cancels)`);
        q = performance.now();
        await new Promise(r => setTimeout(r, 0));
        P.ui += performance.now() - q;
      }
    }
    P.loop = performance.now() - t0;
    for (const h of hooks) M[h] = orig[h];
    q = performance.now();
    exportProgress(true, 0.95, 'Saving MP4: finishing the video');
    await venc.flush(); venc.close();
    P.flush = performance.now() - q; q = performance.now();
    if (encErr) throw encErr;
    if (nOut !== nIn) throw new Error(`the encoder gave ${nOut} frames for ${nIn}`);
    let audioCodec = null;
    if (codecs.audio) {
      status('exporting: sound'); exportProgress(true, 0.97, 'Saving MP4: sound');
      const pcm = await renderExportAudio(s, ev, pre, c);
      P.audioRender = performance.now() - q; q = performance.now();
      const skip = Math.round((c.a - pre) / 60 * EXPORT_SR);
      if (codecs.audio.soft) {
        await aacSoft(pcm, skip, (d, ts, dur, meta) => muxer.addAudioChunkRaw(d, 'key', ts, dur, meta));
        audioCodec = 'mp4a.40.2 (ffmpeg aac)';
      } else {
        let aerr = null;
        const aenc = new AudioEncoder({ output: (ch, meta) => muxer.addAudioChunk(ch, meta), error: e => { aerr = e; } });
        aenc.configure(codecs.audio);
        const L = pcm.getChannelData(0), R = pcm.getChannelData(1), step = 4800;
        for (let i = skip; i < pcm.length; i += step) {
          const n = Math.min(step, pcm.length - i), data = new Float32Array(2 * n);
          data.set(L.subarray(i, i + n), 0); data.set(R.subarray(i, i + n), n);
          const ad = new AudioData({ format: 'f32-planar', sampleRate: EXPORT_SR, numberOfFrames: n, numberOfChannels: 2,
                                     timestamp: Math.round((i - skip) * 1e6 / EXPORT_SR), data });
          aenc.encode(ad); ad.close();
        }
        await aenc.flush(); aenc.close();
        if (aerr) throw aerr;
        audioCodec = 'mp4a.40.2';
      }
      P.audioEnc = performance.now() - q; q = performance.now();
    }
    muxer.finalize();
    const blob = new Blob([muxer.target.buffer], { type: 'video/mp4' }), name = exportName(c, 'mp4');
    P.mux = performance.now() - q;
    saveBlob(blob, name);
    const secs = (performance.now() - t0) / 1000;
    status(`saved ${name} (${W}x${H}, ${(blob.size / 1048576).toFixed(1)} MB, ${(N / 60).toFixed(1)} s of video in ${secs.toFixed(1)} s)`);
    for (const k in P) P[k] = Math.round(P[k]);
    Object.assign(window.__mbaaLastExport, { ms: Math.round(secs * 1000), prof: P, codecs: [codecs.video.codec, audioCodec],
      hw: codecs.video.hardwareAcceleration || 'no-preference', width: W, height: H, bitrate: codecs.video.bitrate, frames: nIn,
      chunks: nOut, clipFrames: N, mode: 'webcodecs', read: upRead ? 'up' : 'canvas' });
  } catch (e) {
    if (e.message !== 'cancelled') throw e;
    status('export cancelled');
  } finally {
    for (const h of hooks) if (orig[h]) M[h] = orig[h];
    if (venc && venc.state !== 'closed') try { venc.close(); } catch (e) {}
    if (pinned) M._viewer_ov_wall_pin(-1);
    if (sized) {  // the canvas back at its own size, the picture on it again
      cv.width = keep.w; cv.height = keep.h;
      if (M._viewer_ov_canvas) M._viewer_ov_canvas(keep.w, keep.h);
      if (M._viewer_represent) M._viewer_represent();
    }
    fx = null; overlayDirty = true;
    exportProgress(false);
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
  // (each sound as the page plays it now: an announcer line from the extension's set or Neco's, annLine)
  const decoded = new Map(), keyOf = new Map();
  for (const [, h, , path] of ev) if (h === 'mbaaVoicePlay' && !keyOf.has(path)) {
    const al = annLine(path), key = al ? al.key : path;
    keyOf.set(path, key);
    if (decoded.has(key)) continue;
    let bytes = al ? al.bytes : null; if (!bytes) try { bytes = M.FS.readFile(path); } catch (e) {}
    decoded.set(key, bytes ? oc.decodeAudioData(bytes.slice().buffer).catch(() => null) : Promise.resolve(null));
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
      const [ch, path, vol, pan] = a, v = voice(ch), buf = bufs.get(keyOf.get(path));
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
  const [EW, EH, EB] = exportDims(), out = document.createElement('canvas'); out.width = EW; out.height = EH;
  const g = out.getContext('2d', { alpha: false }); g.imageSmoothingEnabled = false;
  // a frame per game frame (requestFrame); where the capture track has no requestFrame, the canvas is captured at 60 fps
  let stream = out.captureStream(0);
  const manual = typeof stream.getVideoTracks()[0].requestFrame === 'function';
  if (!manual) { stream.getTracks().forEach(t => t.stop()); stream = out.captureStream(60); }
  const dest = actx.createMediaStreamDestination();
  master.connect(dest);
  stream.addTrack(dest.stream.getAudioTracks()[0]);
  let mr = null, type = '';
  for (const t of REC_TYPES.filter(t => MediaRecorder.isTypeSupported(t))) {  // the first format whose recorder starts
    try { mr = new MediaRecorder(stream, { mimeType: t, videoBitsPerSecond: EB, audioBitsPerSecond: 192e3 }); mr.start(1000); type = t; break; }
    catch (e) { console.warn(`recorder ${t} failed:`, e); mr = null; }
  }
  if (!mr) { master.disconnect(dest); status('video export failed: no recorder format would start'); return; }
  const chunks = [];
  mr.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  mr.onerror = e => recFail(e.error || e);
  if (s.M._viewer_ov_on) s.M._viewer_ov_on(0);  // (the chat's comments stay out of the video)
  rec = { s, a: c.a, b: c.b, round: !!c.round, mr, g, out, dest, chunks, type, last: -1, save: true,
          speed: ui.speed, track: stream.getVideoTracks()[0], frames: 0 };
  if (ui.speed !== 1) call(s, 'viewer_speed', 1);
  document.getElementById('clipexp').classList.add('on');
  recDraw();
  setPaused(false);
}
function recDraw() {
  const r = rec;
  const W = r.out.width, H = r.out.height;
  r.g.imageSmoothingEnabled = false; r.g.drawImage(canvasNow(), 0, 0, W, H);
  if (ui.boxes || ui.inputs || (clipChat && !clipNative)) paintOverlay(r.g, W, H, W / 960);
  if (r.track.requestFrame) r.track.requestFrame();
  r.frames++;
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
    Object.assign(window.__mbaaLastExport, { mode: 'realtime', width: r.out.width, height: r.out.height, frames: r.frames, clipFrames: r.b - r.a, type: r.type });
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
// desktop fullscreen chat (necoTV #2): the column takes the room the full-height 4:3 picture leaves (16:9: a quarter of
// the width, 480 px at 1080p, 640 at 1440p), at least FS_CHAT_MIN (16:10, 4:3: the picture narrows, black over and
// under it) and at most FS_CHAT_MAX (21:9, 32:9: black either side of the picture, the column docked right)
const FS_CHAT_MIN = 300, FS_CHAT_MAX = 640;
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
                       : Math.min(FS_CHAT_MAX, Math.max(FS_CHAT_MIN, window.innerWidth - window.innerHeight * 4 / 3))) : 0;
  if (fsChatW) root.style.setProperty('--fschatw', `${fsChatW}px`);  // (its own: --chatw is the page's column)
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
    // Fullscreen, auto: the picture from the whole screen (its height, or the width beside the chat), not a whole
    // multiple: the bar is over it, so hiding the bar never moves it, and no strip is left empty (necoTV #2)
    const k = dpr >= 2 || full ? 0 : side ? kSide : kBelow;
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
    {  // (the theme, as a row like the size's)
      const row = document.createElement('div'); row.className = 'row';
      const sg = document.createElement('div'); sg.className = 'sizeseg'; sg.setAttribute('role', 'radiogroup'); sg.setAttribute('aria-label', 'theme');
      const lb = document.createElement('span'); lb.className = 'lbl'; lb.textContent = 'theme';
      for (const v of ['auto', 'dark', 'light']) {
        const bt = document.createElement('button'); bt.type = 'button'; bt.textContent = v; bt.setAttribute('role', 'radio'); bt.setAttribute('aria-checked', String(v === GX.theme));
        bt.onclick = e => { e.stopPropagation(); GX.apply(v); for (const b of sg.children) b.setAttribute('aria-checked', String(b === bt)); };
        sg.append(bt);
      }
      row.append(lb, sg); pop.prepend(row);
    }
    for (const [el, to, before] of [[byId('mute'), tr, setb], [byId('vol'), tr, setb], [byId('mixb'), tr, setb], [byId('speed'), tr, setb],
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
    if (mob && mvg && (m.el.id === 'mute' || m.el.id === 'vol' || m.el.id === 'mixb')) { if (m.el.parentNode !== mvg) mvg.append(m.el); }
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
  document.documentElement.classList.toggle('fsmode', on);
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
// fullscreen: the bar stays while the mouse is over it (as on YouTube) or its settings / levels popover is open
function fsBarHeld(stage) {
  const bar = stage.querySelector(':scope > .fsbar'), open = id => { const el = document.getElementById(id); return !!el && !el.hidden; };
  return !!bar && stage.classList.contains('fs') && (bar.matches(':hover') || open('setpop') || open('mixpop') || open('viewpop'));
}
function fsWake() {
  const stage = document.querySelector('.stage');
  stage.classList.remove('idle');
  clearTimeout(fsTimer);
  fsTimer = setTimeout(function idle() {
    if (ui.paused || seekDragging || clipPanel || fsBarHeld(stage)) { fsTimer = setTimeout(idle, FS_IDLE); return; }
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
  bootMark('main');
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
    bootMark('manifest');
    stagePanelLoad().catch(e => console.warn('stage panel:', e));
    engineWarm();  // (the engine boots while the page shows its list / the match's files come in)
    if (!PREWARM && liveListLast) livePreloadAll(liveListLast.l);   // (no prewarm: the live matches' files now)
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
  controls(); volInit(); mixInit();
  for (const key of ['boxes', 'inputs']) if (Q.get(key) === '1') { const el = document.getElementById(key); el.checked = true; el.onchange(); }
  // ?r=<id>: a shared replay in the replay store (tools/web/replay_worker.js); ?rep=<url>: any replay URL
  const rq = Q.get('r') || '';
  const autoload = /^[0-9a-f]{64}$/.test(rq) ? `${REPLAY_STORE}/rep/${rq}.rep`  // links from before short ids
                 : /^[A-Za-z0-9_-]{8,43}$/.test(rq) ? `${REPLAY_STORE}/s/${rq}` : Q.get('rep');
  // a live clip (?c=): its JSON (the chat said during it, and the game's live forcing, which the replay is played with)
  const clipJ = CLIP_ID && autoload ? clipJson() : null;
  if (clipJ) clipChatLoad(clipJ, +(Q.get('t') || 0));
  liveJumpInit();
  fsOfferInit();
  { const el = document.getElementById('song55');  // (songSub)
    if (el) { el.checked = songOn; el.onchange = () => { songOn = el.checked; try { localStorage.setItem('mbaa-song55', songOn ? '1' : '0'); } catch (e) {}
      el.blur(); if (session && session.bgmSync && session.M) session.bgmSync(session.M._viewer_frame()); }; } }
  liveListShow();
  if (POPCHAT) return;  // (the chat alone: the live list still read, for its tabs' names and the pins)
  if (Q.get('live')) {  // spectating: the live controls and the player block; the replay-only controls go (.replayonly)
    document.body.classList.add('live'); syncChips();
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
