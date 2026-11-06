// The bundle's object decoder (viewer.js keeps a small pool of these, so objects decode in parallel and off the page's
// thread). xz: one decoder (vendor/xz-decompress.min.js: xzwasm's maintained fork, which copies each output chunk out of
// the wasm memory; xzwasm's views were overwritten before Firefox read them), its jobs one at a time; deflate jobs run
// alongside. Messages in:
//   {id, buf}                 a decrypted xz object -> {id, buf} (the plain file) or {id, err}
//   {id, enc, z, key}         an object as stored (iv(16) || AES-CTR(deflate-raw | xz)): decrypted here too (goal D,
//                             2026-11-05: ~900 small objects a match, each a decrypt and a DecompressionStream on the
//                             page's thread, were most of a live join's file time); key: the bundle key (hex), once
importScripts('vendor/xz-decompress.min.js' + location.search);  // (the page's version, as this file's)
let key = null, xzChain = Promise.resolve();
const xz = buf => (xzChain = xzChain.then(() => new Response(new self['xz-decompress'].XzReadableStream(new Blob([buf]).stream())).arrayBuffer()));
self.onmessage = async ({ data: { id, buf, enc, z, key: k } }) => {
  try {
    let out;
    if (enc) {
      if (k && !key) key = crypto.subtle.importKey('raw', new Uint8Array(k.match(/../g).map(x => parseInt(x, 16))), 'AES-CTR', false, ['decrypt']);
      const b = new Uint8Array(enc);
      const d = await crypto.subtle.decrypt({ name: 'AES-CTR', counter: b.subarray(0, 16), length: 64 }, await key, b.subarray(16));
      out = z === 'xz' ? await xz(d) : await new Response(new Blob([d]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer();
    } else out = await xz(buf);
    self.postMessage({ id, buf: out }, [out]);
  } catch (e) { self.postMessage({ id, err: String(e) }); }
};
