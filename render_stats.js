// The renderer's profiler, page side (harness-design/renderer_native/SPEC.md section 8 is this file's reference).
// An external script (site CSP: no inline script, no eval). Reads the engine's ring (Module.__rsProf, filled by
// web/host/render/profiler.cpp at each game frame) and draws a small debug overlay over the page (DOM + one 2D canvas:
// no WebGL call, so the game's GL stream is the same with the overlay shown or hidden).
//   window.mbaaRenderStats()            -> the newest complete frame (CPU split, GPU times, done latency in), or null
//   window.mbaaRenderStats({frames: n}) -> the last n frames, oldest first (ring of 600)
//   window.mbaaRenderStats.overlay(on)  -> show / hide the overlay (undefined: the state); F9 toggles it; the engine's
//                                          viewer_render_overlay(1 / 0 / -1) calls this too. Off by default, no URL flag.
//   window.mbaaRenderStats.profile(on)  -> GPU timing / fences / CPU split on or off (viewer_prof_on); the overlay turns
//                                          it on while shown and puts it back when hidden
// Frame fields: {seq, backend: 'webgl2' | 'webgpu' | 'webgpu-compat', gameFrame, presents, apiCalls, draws, multiDrawCalls,
// binds, targetSwitches, uploads, uploadBytes, bufferUploads, flushes, submitMs, recordMs, simMs, presentCpuMs, gpuMs,
// presentGpuMs, doneLatencyMs, gpuTimer, profiling, profCalls, runs, gameDraws, copies, t, passes: [{kind, target, draws,
// apiCalls, binds, stateCalls, cpuMs, gpuMs}]}; a time not measured (profiling off, no timer on this device, still in
// flight) is null.
(() => {
  'use strict';
  const BACKENDS = ['webgl2', 'webgpu', 'webgpu-compat'];
  const KINDS = ['Prep', 'Mesh', 'Scene', 'Target', 'Chains'];
  const engine = () => {
    try { const s = window.__mbaaSession && window.__mbaaSession(); if (s && s.M) return s.M; } catch (e) {}
    return window.__mbaa && window.__mbaa.Module || null;
  };
  const ms = v => (v >= 0 && Number.isFinite(v) ? v : null);
  function rec(R, s) {
    const o = (s % R.N) * R.W, u = R.ring, F = R.F;
    if (u[o] !== s) return null;
    const n = Math.min(u[o + 2], 24), passes = [];
    for (let i = 0; i < n; i++) {
      const p = o + 32 + 8 * i;
      passes.push({ kind: KINDS[u[p]] || u[p], target: u[p + 1], draws: u[p + 2], apiCalls: u[p + 3], binds: u[p + 4],
        stateCalls: u[p + 5], cpuMs: ms(F[p + 6]), gpuMs: ms(F[p + 7]) });
    }
    return { seq: s, backend: BACKENDS[u[o + 24]] || 'webgl2', gameFrame: u[o + 1], presents: u[o + 12], apiCalls: u[o + 3],
      draws: u[o + 4], multiDrawCalls: u[o + 5], binds: u[o + 6], targetSwitches: u[o + 7], uploads: u[o + 8],
      uploadBytes: u[o + 9], bufferUploads: u[o + 10], flushes: u[o + 11], submitMs: ms(F[o + 13]), recordMs: ms(F[o + 16]),
      simMs: ms(F[o + 17]), presentCpuMs: ms(F[o + 18]), gpuMs: ms(F[o + 14]), presentGpuMs: ms(F[o + 19]),
      doneLatencyMs: ms(F[o + 15]), gpuTimer: !!(u[o + 27] & 1), gpuDropped: !!(u[o + 27] & 2), gpuPending: u[o + 26],
      profiling: !!u[o + 25], profCalls: u[o + 20], runs: u[o + 21], gameDraws: u[o + 22], copies: u[o + 23],
      t: R.t[s % R.N], passes };
  }
  function stats(opt) {
    const M = engine(), R = M && M.__rsProf;
    if (!R || !R.seq) return null;
    if (opt && opt.frames > 0) {
      const n = Math.min(opt.frames | 0, R.N, R.seq), out = [];
      for (let s = R.seq - n; s < R.seq; s++) { const r = rec(R, s); if (r) out.push(r); }
      return out;
    }
    // the newest frame with everything in: its CPU split (known one frame later), its GPU times and its done latency
    // (1-3 frames later, when measured); else the newest with its CPU split
    for (let s = R.seq - 2; s >= 0 && s >= R.seq - 16; s--) {
      const o = (s % R.N) * R.W;
      if (R.ring[o] !== s) break;
      if (R.ring[o + 26] === 0 && (!R.ring[o + 25] || R.F[o + 15] >= 0)) return rec(R, s);
    }
    return rec(R, R.seq >= 2 ? R.seq - 2 : R.seq - 1);
  }
  const profile = on => {
    const M = engine();
    if (!M || !M._viewer_prof_on) return false;
    M._viewer_prof_on(on ? 1 : 0);
    return true;
  };

  // ---- the overlay ----
  let el = null, txt = null, cv = null, timer = 0, shownOn = null, prevOn = 0;
  const f1 = v => (v == null ? '  -  ' : v.toFixed(2).padStart(5));
  function build() {
    el = document.createElement('div');
    el.id = 'mbaa-render-stats';
    el.setAttribute('aria-hidden', 'true');
    el.style.cssText = 'position:fixed;left:4px;top:4px;z-index:2147483000;pointer-events:none;max-width:calc(100vw - 8px);'
      + 'width:300px;box-sizing:border-box;padding:4px 6px;background:rgba(0,0,0,.72);color:#e8e8e8;border-radius:4px;'
      + 'font:10px/1.25 ui-monospace,Menlo,Consolas,monospace;white-space:pre;overflow:hidden';
    txt = document.createElement('div');
    cv = document.createElement('canvas');
    cv.width = 288; cv.height = 48;
    cv.style.cssText = 'display:block;width:100%;height:48px;margin-top:3px';
    el.append(txt, cv);
  }
  function draw() {
    const M = engine(), R = M && M.__rsProf;
    if (R && R !== shownOn) { shownOn = R; prevOn = R.on; if (!R.on) profile(1); }   // (a new engine instance)
    const all = stats({ frames: 120 }) || [];
    const r = stats();
    if (!r) { txt.textContent = 'renderer: no frames yet'; return; }
    let fps = 0;
    if (all.length > 1) { const a = all[0], b = all[all.length - 1]; if (b.t > a.t) fps = (b.seq - a.seq) * 1000 / (b.t - a.t); }
    const L = [];
    L.push(`${r.backend}${r.gpuTimer ? ' +timer' : ''}  f${r.gameFrame}  ${fps.toFixed(1)} game fps  x${r.presents} present`);
    L.push(`cpu  sim ${f1(r.simMs)} rec ${f1(r.recordMs)} sub ${f1(r.submitMs)}`);
    L.push(`gpu  ${f1(r.gpuMs)}  present ${f1(r.presentGpuMs)}  done ${f1(r.doneLatencyMs)}`);
    L.push(`calls ${r.apiCalls} draws ${r.draws} (md ${r.multiDrawCalls}) binds ${r.binds}`);
    L.push(`fb ${r.targetSwitches} up ${r.uploads}/${(r.uploadBytes / 1024).toFixed(0)}K buf ${r.bufferUploads} flush ${r.flushes} prof ${r.profCalls}`);
    L.push(`runs ${r.runs} game draws ${r.gameDraws} copies ${r.copies}`);
    for (let i = 0; i < r.passes.length && i < 10; i++) {
      const p = r.passes[i];
      L.push(`${String(i).padStart(2)} ${String(p.kind).padEnd(6)} ${String(p.target).padStart(5)} d${String(p.draws).padStart(3)} c${String(p.apiCalls).padStart(4)} ${f1(p.cpuMs)} ${f1(p.gpuMs)}`);
    }
    if (r.passes.length > 10) L.push(`   +${r.passes.length - 10} passes`);
    txt.textContent = L.join('\n');
    // per frame: CPU (sim + record + submit) up, GPU down from the middle line; 8.3 / 16.7 ms guides
    const c = cv.getContext('2d'), W = cv.width, H = cv.height, mid = H / 2, sc = mid / 16.7;
    c.clearRect(0, 0, W, H);
    c.fillStyle = 'rgba(255,255,255,.25)';
    c.fillRect(0, mid - 8.3 * sc, W, 1); c.fillRect(0, mid + 8.3 * sc, W, 1); c.fillRect(0, mid, W, 1);
    const bw = W / 120, x0 = W - all.length * bw;
    all.forEach((f, i) => {
      const cpu = (f.simMs || 0) + (f.recordMs || 0) + (f.submitMs || 0);
      c.fillStyle = cpu > 8.3 ? '#ff6a5a' : '#6ad0ff';
      c.fillRect(x0 + i * bw, mid - Math.min(mid, cpu * sc), Math.max(1, bw - 0.5), Math.min(mid, cpu * sc));
      const g = f.gpuMs != null ? f.gpuMs : f.doneLatencyMs;
      if (g != null) { c.fillStyle = f.gpuMs != null ? '#9cff7a' : '#c9a0ff'; c.fillRect(x0 + i * bw, mid + 1, Math.max(1, bw - 0.5), Math.min(mid - 1, g * sc)); }
    });
  }
  function overlay(on) {
    const shown = !!(el && el.isConnected);
    if (on === undefined) return shown;
    if (!!on === shown) return shown;
    if (on) {
      if (!el) build();
      document.body.append(el);
      shownOn = null;
      draw();
      timer = setInterval(draw, 250);
    } else {
      clearInterval(timer); timer = 0;
      el.remove();
      if (shownOn && shownOn === (engine() || {}).__rsProf && !prevOn) profile(0);
      shownOn = null;
    }
    return !!on;
  }
  addEventListener('keydown', e => {
    if (e.key !== 'F9' || e.ctrlKey || e.metaKey || e.altKey) return;
    const tg = e.target;
    if (tg && (tg.isContentEditable || tg.tagName === 'TEXTAREA' || tg.tagName === 'INPUT')) return;
    overlay(!overlay());
    e.preventDefault();
  });
  stats.overlay = overlay;
  stats.profile = profile;
  window.mbaaRenderStats = stats;
})();
