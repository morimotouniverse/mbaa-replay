// The engine's canvas and worker in a cross-site frame (viewer.js XFRAME: desktop Firefox with WebGPU).
// Firefox shows an OLDER frame of a worker's WebGPU canvas whenever the canvas's document repaints (any DOM change on the
// page: the timeline, the status line), the picture flickering back to earlier frames (user 2026-11-10, Firefox 159;
// harness-design/renderer_native/firefox_webgpu/FINDINGS.md: 105-141 old frames in 6 s on a bare repro, 0 with WebGL2).
// A frame from another site runs in its own process: the page's repaints no longer touch the canvas's frames (0 old
// frames), as long as this document itself never repaints. So nothing here but the canvas: the page sends one message
// with a MessagePort and the worker's query; the worker gets the port and the canvas and talks to the page directly.
const PARENTS = /^(https:\/\/watch\.meltyblood\.org|http:\/\/(127\.0\.0\.1|localhost)(:\d+)?)$/;
let w = null;
// (a new canvas for the worker: the first, and after a lost GPU device (the worker's needCanvas))
function fresh() {
  const old = document.getElementById('c'), c = old.cloneNode(false);
  old.replaceWith(c);
  return c.transferControlToOffscreen();
}
addEventListener('message', e => {
  if (w || !PARENTS.test(e.origin) || !e.data || e.data.cmd !== 'engFrame' || !e.ports[0]) return;
  const page = e.source, origin = e.origin;
  w = new Worker('engine.js' + e.data.q);
  w.onerror = ev => page.postMessage({ ev: 'engFrameError', msg: String(ev.message || ev) }, origin);
  w.onmessage = m => {
    const d = m.data;
    if (d && d.ev === 'needCanvas') { const off = fresh(); w.postMessage({ cmd: 'offscreen', id: d.id, off }, [off]); }
  };
  const off = fresh();
  w.postMessage({ cmd: 'port', port: e.ports[0], off }, [e.ports[0], off]);
});
