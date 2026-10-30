// The page's own files kept on the device (registered by viewer.js). tools/web/deploy_pages.sh names every page file
// with its content hash (viewer.js?v=<hash>, and mbaa.js names mbaa.wasm?v=<hash>), so a versioned URL never changes:
// it is served from here with no network at all, and a deploy's new hash is simply a new entry (the older copies of
// that file are dropped). The page itself and anything unversioned go to the network first (a deploy shows on the
// next load), this copy only when offline. The game's data files have their own store (viewer.js fetchObject).
const SHELL = 'MBAACC page files';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(caches.delete('mbaa-shell-v1').then(() => self.clients.claim())));  // (its first name)

self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const url = new URL(r.url);
  if (url.origin !== location.origin || url.pathname.startsWith('/bundle/') || url.pathname.includes('/live/')) return;
  e.respondWith(url.searchParams.has('v') ? versioned(r, url) : networkFirst(r));
});

async function versioned(r, url) {
  const c = await caches.open(SHELL);
  const hit = await c.match(r);
  if (hit) return hit;
  const res = await fetch(r);
  if (res.ok) {
    await c.put(r, res.clone());
    for (const k of await c.keys()) {  // (older versions of the same file)
      const u = new URL(k.url);
      if (u.pathname === url.pathname && u.search !== url.search) c.delete(k);
    }
  }
  return res;
}

async function networkFirst(r) {
  const c = await caches.open(SHELL);
  const u = new URL(r.url), key = r.mode === 'navigate' ? u.origin + u.pathname : r;  // (a page under its path alone)
  try {
    const res = await fetch(r);
    if (res.ok) c.put(key, res.clone());
    return res;
  } catch (err) {
    const hit = await c.match(key);
    if (hit) return hit;
    throw err;
  }
}
