// BGM streamed through WebCodecs: the bundle's Ogg Opus track is demuxed once (packets are views into the fetched
// bytes) and decoded about two seconds ahead into small AudioBuffers, instead of the whole track as Float32 PCM
// (36-62 MB a track). Plays as the game's stream does: from an offset, looping back to loopPos at the end.
'use strict';

// Ogg Opus -> { head (OpusHead packet, the decoder's description), ch, preSkip, packets, starts (each packet's first
// sample, pre-skip included), total (samples after pre-skip, the last page's granule) }; null if it is not Ogg Opus
function oggOpusParse(b) {
  const packets = [];
  let cur = [], pos = 0, lastGranule = 0;
  while (pos + 27 <= b.length) {
    if (b[pos] !== 0x4f || b[pos + 1] !== 0x67 || b[pos + 2] !== 0x67 || b[pos + 3] !== 0x53) return null;
    const g = b[pos + 6] | (b[pos + 7] << 8) | (b[pos + 8] << 16) | (b[pos + 9] << 24);
    const gHi = b[pos + 10] | (b[pos + 11] << 8) | (b[pos + 12] << 16) | (b[pos + 13] << 24);
    if (gHi !== -1) lastGranule = (g >>> 0) + gHi * 4294967296;  // -1 / -1: no packet ends on this page
    const nseg = b[pos + 26];
    let o = pos + 27 + nseg;
    for (let i = 0; i < nseg; i++) {
      const l = b[pos + 27 + i];
      cur.push(b.subarray(o, o + l)); o += l;
      if (l < 255) {
        if (cur.length === 1) packets.push(cur[0]);
        else { const n = cur.reduce((a, x) => a + x.length, 0), p = new Uint8Array(n); let k = 0; for (const x of cur) { p.set(x, k); k += x.length; } packets.push(p); }
        cur = [];
      }
    }
    pos = o;
  }
  if (packets.length < 3 || String.fromCharCode(...packets[0].subarray(0, 8)) !== 'OpusHead') return null;
  const head = packets[0], ch = head[9], preSkip = head[10] | (head[11] << 8);
  const audio = packets.slice(2), starts = new Float64Array(audio.length);
  let s = 0;
  for (let i = 0; i < audio.length; i++) { starts[i] = s; s += opusPacketSamples(audio[i]); }
  return { head, ch, preSkip, packets: audio, starts, total: Math.max(0, Math.min(s, lastGranule) - preSkip) };
}
// samples (48 kHz) in one Opus packet, from its TOC byte (RFC 6716 section 3.1)
function opusPacketSamples(p) {
  if (!p.length) return 0;
  const toc = p[0], cfg = toc >> 3;
  const fs = cfg < 12 ? [480, 960, 1920, 2880][cfg & 3] : cfg < 16 ? [480, 960][cfg & 1] : [120, 240, 480, 960][cfg & 3];
  const c = toc & 3, n = c === 0 ? 1 : c === 3 ? (p.length > 1 ? p[1] & 63 : 0) : 2;
  return fs * n;
}

let bgmStreamOk = null;  // a promise: true where AudioDecoder decodes Opus
function bgmStreamSupported() {
  if (bgmStreamOk) return bgmStreamOk;
  bgmStreamOk = typeof AudioDecoder === 'undefined' ? Promise.resolve(false)
    : AudioDecoder.isConfigSupported({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2 }).then(r => !!r.supported, () => false);
  return bgmStreamOk;
}

// Play track `o` (oggOpusParse) into `out` from `offset` seconds, `when` = the AudioContext time that sample sounds.
// Returns { stop(at) }. loop: at the end it goes on from loopPos seconds, sample-exact.
function bgmStreamPlay(ctx, o, out, loop, loopPos, offset, when) {
  const SR = 48000, AHEAD = 2.0, PREROLL = 3840;  // 80 ms of decoder pre-roll before a start point (RFC 7845 4.6)
  const loopS = Math.max(0, Math.min(Math.round(loopPos * SR), o.total));
  const srcs = new Set();
  let dec = null, pi = 0, segFrom = 0, segWhen = 0, segEnd = 0, endTime = when, stopped = false, flushing = false;
  // a segment: track samples [from, total) sounding from time `at`
  function segment(from, at) {
    if (dec) { try { dec.close(); } catch (e) {} }
    dec = new AudioDecoder({ output, error: () => {} });
    dec.ondequeue = pump;  // refilled as the decoder takes packets, not only on the timer
    dec.configure({ codec: 'opus', sampleRate: SR, numberOfChannels: o.ch, description: o.head });
    segFrom = from + o.preSkip; segWhen = at; segEnd = o.total + o.preSkip;
    let lo = 0, hi = o.starts.length - 1;
    const target = Math.max(0, segFrom - PREROLL);
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (o.starts[m] <= target) lo = m; else hi = m - 1; }
    pi = lo; flushing = false;
  }
  function output(d) {
    const d0 = Math.round(d.timestamp * SR / 1e6), n = d.numberOfFrames;
    const a = Math.max(d0, segFrom), b = Math.min(d0 + n, segEnd);
    if (stopped || b <= a) { d.close(); return; }
    const buf = ctx.createBuffer(o.ch, b - a, SR), plane = new Float32Array(n);
    for (let c = 0; c < o.ch; c++) { d.copyTo(plane, { planeIndex: c, format: 'f32-planar' }); buf.copyToChannel(plane.subarray(a - d0, b - d0), c); }
    d.close();
    const t = segWhen + (a - segFrom) / SR, now = ctx.currentTime;
    endTime = Math.max(endTime, t + buf.duration);
    if (t + buf.duration <= now) { if (typeof window !== 'undefined' && window.mbaaBgmStream) window.mbaaBgmStream.late++; return; }  // late (a stalled tab): dropped
    const st = (typeof window !== 'undefined') && (window.mbaaBgmStream || (window.mbaaBgmStream = { buffers: 0, seconds: 0, late: 0 }));
    if (st) { st.buffers++; st.seconds += buf.duration; }
    const s = ctx.createBufferSource();
    s.buffer = buf; s.connect(out);
    s.start(Math.max(t, now), Math.max(0, now - t));
    srcs.add(s); s.onended = () => { srcs.delete(s); s.disconnect(); };
  }
  function pump() {
    if (stopped || flushing) return;
    while (pi < o.packets.length && dec.decodeQueueSize < 64 && segWhen + (o.starts[pi] - segFrom) / SR < ctx.currentTime + AHEAD) {
      dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round(o.starts[pi] * 1e6 / SR), data: o.packets[pi] }));
      pi++;
    }
    if (pi >= o.packets.length) {  // the track's end: everything out, then back to loopPos (or done)
      flushing = true;
      const d = dec, at = segWhen + (segEnd - segFrom) / SR;
      d.flush().then(() => { if (!stopped && d === dec && loop && o.total > loopS) segment(loopS, at); }, () => {});
    }
  }
  let from = Math.round(offset * SR);
  if (from >= o.total) {
    if (!loop || o.total <= loopS) return { stop() {} };
    from = loopS + ((from - loopS) % (o.total - loopS));
  }
  segment(from, when);
  pump();
  const timer = setInterval(pump, 200);
  return {
    stop(at) {
      if (stopped) return;
      stopped = true; clearInterval(timer);
      try { dec.close(); } catch (e) {}
      for (const s of srcs) { try { s.stop(at); } catch (e) {} }
    },
  };
}
if (typeof module !== 'undefined') module.exports = { oggOpusParse, opusPacketSamples };
