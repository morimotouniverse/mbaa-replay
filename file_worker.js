// The bundle's file pipeline off the page's thread (viewer.js fileJob): a worker fetches a bundle object (from this
// device's Cache Storage copy, else the network, keeping a copy), decrypts it (AES-CTR, the page's key, sent once) and
// inflates it (deflate-raw; xz objects with the page's xz decoder), and hands the plain bytes back (transferred, no
// copy). A pack (tools/web/bundle_pack.py) is fetched once for all of its files a job asks for.
//   in:  {key, cap}                                 the page's CryptoKey and the device copy's byte budget, first
//        {id, url, parts: [[off, len, z] | null]}   null: the whole object; z: null | 'xz'
//        {sweep: [object hash...]}                  the device copy's parts of other objects deleted (old bundles)
//   out: {id, bufs: [ArrayBuffer...], net: {bytes, cached, device}} | {id, err}
// The device copy (harness-design/engine_core/DESIGN.md phase 5): each part's decoded bytes in this origin's private
// file system (OPFS, files/<object hash>_<offset>), so a returning visitor's match starts without the decode (xz: a
// character's .cg ~0.5-0.9 s). Kept encrypted (AES-CTR under the page's key, a fresh counter each): [counter 16][plain
// length u32][ciphertext]; a short or wrong-sized file is a miss. Written after the decode (createWritable: whole or
// nothing), while the device's use stays under the page's budget.
'use strict';
let key = null, cache = null, xz = null, cap = 0, used = -1;
const CACHE = 'MBAACC game files';  // (viewer.js objCache: the same store)
const cacheReady = (async () => { try { cache = await caches.open(CACHE); } catch (e) {} })();
async function raw(url, net) {
  await cacheReady;
  if (cache) {
    try { const hit = await cache.match(url); if (hit) { net.cached++; return hit.arrayBuffer(); } } catch (e) {}
  }
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const keep = cache ? r.clone() : null;  // (the response itself into the store: no copy of the bytes here)
  const buf = await r.arrayBuffer();
  net.bytes += buf.byteLength;
  if (keep) cache.put(url, keep).catch(() => {});
  return buf;
}
let dir = null;
const dirReady = (async () => { try { dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('files', { create: true }); } catch (e) {} })();
async function devGet(name) {
  try {
    // (getFile, not a sync access handle: its lock made the 1,460 parts of a match 4x slower to read, 5.2 s)
    const b = new Uint8Array(await (await (await dir.getFileHandle(name)).getFile()).arrayBuffer());
    if (b.length < 20 || b.length !== 20 + new DataView(b.buffer).getUint32(16, true)) return null;
    return await crypto.subtle.decrypt({ name: 'AES-CTR', counter: b.slice(0, 16), length: 64 }, key, b.subarray(20));
  } catch (e) { return null; }
}
async function devPut(name, ct, ctr, n) {
  try {
    if (used < 0) { const e = await navigator.storage.estimate(); used = e.usage || 0; }
    if (used + n + 20 > cap) return;
    used += n + 20;
    const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
    const h = new Uint8Array(20); h.set(ctr); new DataView(h.buffer).setUint32(16, n, true);
    await w.write(new Blob([h, ct])); await w.close();
  } catch (e) {}
}
async function open(b, z) {
  const d = await crypto.subtle.decrypt({ name: 'AES-CTR', counter: b.slice(0, 16), length: 64 }, key, b.subarray(16));
  if (z === 'xz') {
    if (!xz) { importScripts('vendor/xz-decompress.min.js' + location.search); xz = self['xz-decompress']; }
    return new Response(new xz.XzReadableStream(new Blob([d]).stream())).arrayBuffer();
  }
  return new Response(new Blob([d]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer();
}
async function sweep(live) {
  await dirReady;
  if (!dir) return;
  const keep = new Set(live), gone = [];
  for await (const name of dir.keys()) if (!keep.has(name.split('_')[0])) gone.push(name);
  for (const name of gone) await dir.removeEntry(name).catch(() => {});
  used = -1;
}
self.onmessage = async ({ data: m }) => {
  if (m.key) { key = m.key; cap = m.cap || 0; return; }
  if (m.sweep) { sweep(m.sweep); return; }
  const net = { bytes: 0, cached: 0, device: 0 };
  try {
    const t0 = performance.now();
    await dirReady;
    const obj = m.url.split('?')[0].split('/').pop(), names = m.parts.map(p => obj + '_' + (p ? p[0] : 'all'));
    const have = dir ? await Promise.all(names.map(devGet)) : names.map(() => null);
    net.device = have.filter(Boolean).length;
    // (every part on the device: no fetch at all)
    const b = have.every(Boolean) ? null : new Uint8Array(await raw(m.url, net));
    const t1 = performance.now(), ms = [], puts = [];
    // (ms: the fetch, then each part's decrypt + decode: viewer.js ?filesprof=1, window.__mbaaFiles)
    const bufs = await Promise.all(m.parts.map(async (p, i) => {
      const ta = performance.now();
      let out = have[i];
      if (!out) {
        out = await open(p ? b.subarray(p[0], p[0] + p[1]) : b, p ? p[2] : m.z);
        if (dir && cap) {   // (encrypted before the plain bytes go to the page (transferred))
          const ctr = crypto.getRandomValues(new Uint8Array(16));
          puts.push([names[i], await crypto.subtle.decrypt({ name: 'AES-CTR', counter: ctr, length: 64 }, key, out), ctr, out.byteLength]);
        }
      }
      ms[i] = performance.now() - ta;
      return out;
    }));
    self.postMessage({ id: m.id, bufs, net, ms: { fetch: t1 - t0, parts: ms }, bytes: b ? b.byteLength : 0 }, bufs);
    for (const [name, ct, ctr, n] of puts) await devPut(name, ct, ctr, n);
  } catch (e) { self.postMessage({ id: m.id, err: String(e && e.message || e), net }); }
};
