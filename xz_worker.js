// One xz decoder (vendor/xzwasm.min.js) per worker: viewer.js keeps a small pool of these, so the bundle's xz objects
// decode in parallel and off the page's thread. A worker takes one job at a time (xzwasm's streams share the worker's
// one wasm instance). Message in: {id, buf} (the decrypted object); out: {id, buf} (the plain file) or {id, err}.
importScripts('vendor/xzwasm.min.js' + location.search);  // (the page's version, as this file's)
self.onmessage = async ({ data: { id, buf } }) => {
  try {
    const out = await new Response(new self.xzwasm.XzReadableStream(new Blob([buf]).stream())).arrayBuffer();
    self.postMessage({ id, buf: out }, [out]);
  } catch (e) { self.postMessage({ id, err: String(e) }); }
};
