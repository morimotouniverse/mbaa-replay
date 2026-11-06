// The bundle's file pipeline off the page's thread (viewer.js fileJob): a worker fetches a bundle object (from this
// device's Cache Storage copy, else the network, keeping a copy), decrypts it (AES-CTR, the page's key, sent once) and
// inflates it (deflate-raw; xz objects with the page's xz decoder), and hands the plain bytes back (transferred, no
// copy). A pack (tools/web/bundle_pack.py) is fetched once for all of its files a job asks for.
//   in:  {key}                                      the page's CryptoKey, first
//        {id, url, parts: [[off, len, z] | null]}   null: the whole object; z: null | 'xz'
//   out: {id, bufs: [ArrayBuffer...], net: {bytes, cached}} | {id, err}
'use strict';
let key = null, cache = null, xz = null;
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
async function open(b, z) {
  const d = await crypto.subtle.decrypt({ name: 'AES-CTR', counter: b.slice(0, 16), length: 64 }, key, b.subarray(16));
  if (z === 'xz') {
    if (!xz) { importScripts('vendor/xz-decompress.min.js' + location.search); xz = self['xz-decompress']; }
    return new Response(new xz.XzReadableStream(new Blob([d]).stream())).arrayBuffer();
  }
  return new Response(new Blob([d]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer();
}
self.onmessage = async ({ data: m }) => {
  if (m.key) { key = m.key; return; }
  const net = { bytes: 0, cached: 0 };
  try {
    const b = new Uint8Array(await raw(m.url, net));
    const bufs = await Promise.all(m.parts.map(p => open(p ? b.subarray(p[0], p[0] + p[1]) : b, p ? p[2] : m.z)));
    self.postMessage({ id: m.id, bufs, net }, bufs);
  } catch (e) { self.postMessage({ id: m.id, err: String(e && e.message || e), net }); }
};
