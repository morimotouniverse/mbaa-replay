// One xz decoder (vendor/xz-decompress.min.js: xzwasm's maintained fork, which copies each output chunk out of the wasm
// memory; xzwasm's views were overwritten before Firefox read them) per worker: viewer.js keeps a small pool of these,
// so the bundle's xz objects decode in parallel and off the page's thread. A worker takes one job at a time. Message in: {id, buf} (the decrypted object); out: {id, buf} (the plain file) or {id, err}.
importScripts('vendor/xz-decompress.min.js' + location.search);  // (the page's version, as this file's)
self.onmessage = async ({ data: { id, buf } }) => {
  try {
    const out = await new Response(new self['xz-decompress'].XzReadableStream(new Blob([buf]).stream())).arrayBuffer();
    self.postMessage({ id, buf: out }, [out]);
  } catch (e) { self.postMessage({ id, err: String(e) }); }
};
