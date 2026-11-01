// "Name the tracks" (web/shell/tracks.html): Raito Radio's older-game tracks, playable, with a suggestion form for a
// name, a Japanese name and a tile picture (cropped here to the radio tile's 256x96 JPEG), and for the reviewers the
// queue with approve / reject. Served by the Worker under the chat path (tools/web/track_tags.mjs: its API is
// <page path>api/*); the sign-in is the chat's (/<CHAT_PATH>/auth/*). The track list and audio come from the site's
// bundle as the viewer reads them (viewer.js radioOldLoad / fetchObject: manifest.bin, web/radio/old.json,
// web/radio/<g>/<NN>.opus, the tiles), the approved names from /radio/overrides.json.
'use strict';
const KEY_HEX = '6d626161636377656272657061796b65792d6e6f742d612d7365637265742121';
const BUNDLE = 'bundle/';
const GAMES = [['', 'All'], ['mb', 'Melty Blood'], ['re', 'Re-ACT'], ['ac', 'Act Cadenza']];
const GAME_NAME = { mb: 'Melty Blood', re: 'Re-ACT', ac: 'Act Cadenza' };
const TEXT_MAX = 80;
// the page's path: /<CHAT_PATH>/tracks/ -> its API and the sign-in beside it (opened elsewhere, e.g. a local /tracks.html: read only)
const PAGE = location.pathname.replace(/[^/]*$/, '');
const API = /\/tracks\/$/.test(PAGE) ? PAGE + 'api/' : null;
const AUTH = API ? PAGE.replace(/tracks\/$/, 'auth/') : null;
const $ = id => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

// ---- the bundle (viewer.js openObject / fetchRaw, without its caches) ----
let cryptoKey, man;
const hex = h => new Uint8Array(h.match(/../g).map(x => parseInt(x, 16)));
async function openObject(buf) {
  const b = new Uint8Array(buf);
  const d = await crypto.subtle.decrypt({ name: 'AES-CTR', counter: b.slice(0, 16), length: 64 }, cryptoKey, b.slice(16));
  return new Uint8Array(await new Response(new Blob([d]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
}
async function fetchRaw(h) {
  const r = await fetch(`${BUNDLE}o/${h.slice(0, 2)}/${h}`);
  if (!r.ok) throw new Error(`object ${h}: HTTP ${r.status}`);
  return r.arrayBuffer();
}
const files = new Map();
function bundleFile(p) {
  if (!files.has(p)) files.set(p, (async () => {
    const f = man.files[p];
    if (!f) throw new Error(`${p}: not in the bundle`);
    if (f.z) throw new Error(`${p}: unsupported encoding`);
    if (f.pk) { const [h, off, len] = f.pk; return openObject((await fetchRaw(h)).slice(off, off + len)); }
    return openObject(await fetchRaw(f.o));
  })());
  const p0 = files.get(p);
  p0.catch(() => files.delete(p));
  return p0;
}
const blobUrls = new Map();
async function bundleUrl(p, type) {
  if (!blobUrls.has(p)) blobUrls.set(p, URL.createObjectURL(new Blob([await bundleFile(p)], { type })));
  return blobUrls.get(p);
}

// ---- state ----
let tracks = [];                 // [{key, game, id, f, title (old.json's), titled, stageName, tile, yt, titleJp}]
let ov = {};                     // key -> {title, jp, tile, by}
let me = { signedIn: false };    // /api/me
let pending = [], counts = {};   // /api/list
let game = '', untitledOnly = true, openForm = null;
try { const v = JSON.parse(localStorage.getItem('mbaa_tracks_view') || '{}'); game = GAMES.some(g => g[0] === v.g) ? v.g : ''; untitledOnly = v.u !== false; } catch (e) {}
const saveView = () => { try { localStorage.setItem('mbaa_tracks_view', JSON.stringify({ g: game, u: untitledOnly })); } catch (e) {} };

const name = t => (ov[t.key] && ov[t.key].title) || (t.titled ? t.title : '');
const jpName = t => (ov[t.key] && ov[t.key].jp) || t.titleJp || '';
const untitled = t => !name(t);
const label = t => name(t) || `Track ${String(t.id).padStart(2, '0')}`;
const fmtT = s => !isFinite(s) ? '-:--' : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
function toast(t, ms = 3200) {
  const e = $('toast'); e.textContent = t; e.hidden = false;
  clearTimeout(toast.h); toast.h = setTimeout(() => { e.hidden = true; }, ms);
}
async function api(path, body) {
  const r = await fetch(API + path, body === undefined ? { cache: 'no-store', credentials: 'same-origin' }
    : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let j = {};
  try { j = await r.json(); } catch (e) {}
  if (!r.ok) throw Object.assign(new Error(j.error || `HTTP ${r.status}`), { status: r.status, j });
  return j;
}

// ---- audio: one player; each row's seek bar follows it while that row plays ----
const audio = $('audio');
let playing = null;  // key
const rows = new Map();  // key -> {row, play, seek, tm}
async function playKey(key, at = null) {
  const t = tracks.find(x => x.key === key);
  if (!t) return;
  if (playing === key && at === null) { if (audio.paused) audio.play().catch(() => {}); else audio.pause(); return; }
  const prev = playing;
  playing = key;
  if (prev && prev !== key) paint(prev);
  for (const r of allPlayButtons(key)) { r.classList.add('busy'); r.textContent = '…'; }
  try {
    const url = await bundleUrl(t.f, 'audio/ogg');
    if (playing !== key) return;
    if (audio.dataset.key !== key) { audio.src = url; audio.dataset.key = key; }
    if (at !== null) {
      const go = () => { audio.currentTime = at * (audio.duration || 0); };
      if (audio.readyState >= 1) go(); else audio.addEventListener('loadedmetadata', go, { once: true });
    }
    await audio.play();
  } catch (e) { toast(`could not play: ${e.message}`); playing = null; }
  paint(key);
}
const allPlayButtons = key => document.querySelectorAll(`[data-play="${CSS.escape(key)}"]`);
function paint(key) {
  const on = playing === key && !audio.paused;
  for (const b of allPlayButtons(key)) { b.classList.remove('busy'); b.textContent = on ? '❚❚' : '▶'; b.title = on ? 'pause' : 'play'; }
  const r = rows.get(key);
  if (r) r.row.classList.toggle('playing', playing === key);
  if (r && playing !== key) { r.seek.value = 0; r.tm.textContent = `0:00 / ${fmtT(r.dur)}`; }
}
audio.addEventListener('play', () => playing && paint(playing));
audio.addEventListener('pause', () => playing && paint(playing));
audio.addEventListener('ended', () => playing && paint(playing));
audio.addEventListener('timeupdate', () => {
  const r = playing && rows.get(playing);
  if (!r || r.dragging) return;
  r.dur = audio.duration;
  r.seek.value = audio.duration ? Math.round(1000 * audio.currentTime / audio.duration) : 0;
  r.tm.textContent = `${fmtT(audio.currentTime)} / ${fmtT(audio.duration)}`;
});

// ---- the track list ----
function tileArt(t, box) {
  const o = ov[t.key];
  box.textContent = '';
  box.style.backgroundImage = '';
  if (o && o.tile) { box.style.backgroundImage = `url("/${o.tile}")`; return; }
  if (!t.tile) { box.textContent = '♪'; return; }
  box.dataset.tile = t.tile;
  artObserver.observe(box);
}
const artObserver = new IntersectionObserver(es => {
  for (const e of es) {
    if (!e.isIntersecting) continue;
    artObserver.unobserve(e.target);
    const p = e.target.dataset.tile;
    bundleUrl(p, 'image/jpeg').then(u => { if (e.target.dataset.tile === p) e.target.style.backgroundImage = `url("${u}")`; }).catch(() => { e.target.textContent = '♪'; });
  }
}, { rootMargin: '300px' });

function render() {
  const list = $('list'), shown = tracks.filter(t => (!game || t.game === game) && (!untitledOnly || untitled(t)));
  for (const b of $('games').children) b.classList.toggle('on', b.dataset.g === game);
  rows.clear();
  list.replaceChildren(...shown.map(row));
  const left = tracks.filter(untitled).length;
  $('count').textContent = `${shown.length} track${shown.length === 1 ? '' : 's'}`;
  $('stats').textContent = `${left} of ${tracks.length} radio tracks still have no name` +
    (Object.keys(ov).length ? ` · ${Object.keys(ov).length} named or pictured by the community` : '');
  $('status').textContent = shown.length ? '' : untitledOnly ? 'every track here has a name now. Untick "untitled only" to see them all.' : 'no tracks';
  if (playing) paint(playing);
}
function row(t) {
  const o = ov[t.key] || {}, r = el('div', 'trk'), art = el('div', 'art'), meta = el('div', 'meta'), acts = el('div', 'acts');
  r.dataset.key = t.key;
  tileArt(t, art);
  const tl = el('div', 't' + (name(t) ? '' : ' none'));
  tl.append(el('span', 'n', label(t)));
  if (!name(t)) tl.append(el('span', 'tag untitled', 'untitled'));
  else if (o.title) tl.append(el('span', 'tag comm', 'community name'));
  const jp = el('div', 'jp' + (jpName(t) ? '' : ' none'), jpName(t) || 'no Japanese name yet');
  const sub = el('div', 'sub', [GAME_NAME[t.game], t.stageName || (t.stage === null || t.stage === undefined ? 'not a stage track' : ''), `#${String(t.id).padStart(2, '0')}`].filter(Boolean).join(' · '));
  meta.append(tl, jp, sub);
  const by = o.by ? [...new Set(Object.values(o.by).filter(Boolean))] : [];
  if (by.length) meta.append(el('div', 'credit', `suggested by ${by.join(', ')}`));
  const pr = el('div', 'playrow'), play = el('button', 'play', '▶'), seek = el('input', 'seek'), tm = el('span', 'tm', `0:00 / ${fmtT(t.dur)}`);
  play.dataset.play = t.key; play.title = 'play'; play.setAttribute('aria-label', `play ${label(t)}`);
  play.onclick = () => playKey(t.key);
  Object.assign(seek, { type: 'range', min: 0, max: 1000, value: 0 });
  seek.setAttribute('aria-label', `seek ${label(t)}`);
  const ent = { row: r, play, seek, tm, dur: t.dur, dragging: false };
  seek.oninput = () => { ent.dragging = true; const d = playing === t.key ? audio.duration : t.dur; tm.textContent = `${fmtT(seek.value / 1000 * d)} / ${fmtT(d)}`; };
  seek.onchange = () => {
    ent.dragging = false;
    if (playing === t.key && audio.duration) audio.currentTime = seek.value / 1000 * audio.duration;
    else playKey(t.key, seek.value / 1000);
  };
  pr.append(play, seek, tm);
  meta.append(pr);
  rows.set(t.key, ent);
  // actions: suggest (or sign in), waiting count, YouTube, the reviewers' take-back buttons
  const sug = el('button', 'txt' + (untitled(t) ? ' primary' : ''), 'suggest');
  if (!API) sug.disabled = true, sug.title = 'suggestions need the site';
  sug.onclick = () => {
    if (!me.signedIn) { if (me.signin) location.href = me.signin; else toast(me.need ? 'pick a chat name first (on the chat page)' : 'sign-in is not available'); return; }
    toggleForm(t, r);
  };
  if (!me.signedIn && me.signin) sug.textContent = 'sign in to suggest';
  acts.append(sug);
  if (counts[t.key]) acts.append(el('span', 'pend', `${counts[t.key]} waiting for review`));
  if (t.yt) { const a = el('a', 'yt', '▶ Raito’s upload'); a.href = t.yt; a.target = '_blank'; a.rel = 'noopener'; acts.append(a); }
  if (me.reviewer && (o.title || o.jp || o.tile)) {
    const c = el('div', 'clr');
    for (const [f, txt] of [['title', 'undo name'], ['jp', 'undo JP'], ['tile', 'undo picture']]) {
      if (!o[f]) continue;
      const b = el('button', 'txt', txt);
      b.onclick = () => clearOverride(t, f);
      c.append(b);
    }
    acts.append(c);
  }
  r.append(art, meta, acts);
  if (openForm && openForm.key === t.key) r.append(openForm.form);
  return r;
}
async function clearOverride(t, field) {
  if (!confirm(`Take back the approved ${field === 'tile' ? 'picture' : field === 'jp' ? 'Japanese name' : 'name'} of ${label(t)}?`)) return;
  try { const j = await api('clear', { key: t.key, field }); if (j.override) ov[t.key] = j.override; else delete ov[t.key]; render(); toast('taken back'); }
  catch (e) { toast(e.message); }
}

// ---- the suggestion form ----
function toggleForm(t, r) {
  if (openForm && openForm.key === t.key) { openForm.form.remove(); openForm = null; return; }
  if (openForm) openForm.form.remove();
  openForm = { key: t.key, form: suggestForm(t) };
  r.append(openForm.form);
  openForm.form.querySelector('input').focus();
}
function suggestForm(t) {
  const f = el('form', 'sug');
  const mk = (lbl, nm, ph, val) => {
    const l = el('label', 'f', lbl), i = el('input');
    Object.assign(i, { type: 'text', name: nm, maxLength: TEXT_MAX, placeholder: ph, value: val || '' });
    i.autocomplete = 'off';
    l.append(i); return l;
  };
  f.append(mk('Name', 'title', 'the song’s name (English or romaji)', ''), mk('Japanese name', 'jp', '日本語の曲名', ''));
  const imgrow = el('div', 'imgrow'), fb = el('label', 'txt filebtn', 'choose a picture…'), file = el('input');
  Object.assign(file, { type: 'file', accept: 'image/*' });
  fb.style.cssText = 'padding:6px 11px;font-size:12px;background:var(--raise);border-radius:8px;cursor:pointer';
  fb.append(file);
  const url = el('input'), useUrl = el('button', 'txt', 'use link');
  Object.assign(url, { type: 'url', placeholder: 'or paste an image link (or the image itself)' });
  useUrl.type = 'button';
  imgrow.append(fb, el('span', 'or', 'or'), url, useUrl);
  const crop = el('div', 'crop'), cv = el('canvas'), knobs = el('div', 'knobs');
  cv.width = 256; cv.height = 96;
  crop.hidden = true;
  const knob = (lbl, min, max, v) => { const l = el('label', '', lbl), i = el('input'); Object.assign(i, { type: 'range', min, max, value: v }); l.append(i); knobs.append(l); return i; };
  const zoom = knob('zoom', 100, 400, 100), px = knob('left–right', 0, 100, 50), py = knob('up–down', 0, 100, 45);
  const rm = el('button', 'txt', 'remove picture'); rm.type = 'button';
  knobs.append(el('span', 'faint', 'The radio tile is 256 × 96. Drag the sliders to frame it.'), rm);
  crop.append(cv, knobs);
  const foot = el('div', 'foot'), msg = el('span', 'msg', `Suggesting for ${GAME_NAME[t.game]} ${label(t)}${t.stageName ? ` (${t.stageName})` : ''}.`);
  const send = el('button', 'txt primary', 'send suggestion'), cancel = el('button', 'txt', 'cancel');
  cancel.type = 'button'; send.type = 'submit';
  foot.append(msg, cancel, send);
  f.append(imgrow, crop, foot);
  let bmp = null;
  const draw = () => {
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 256, 96);
    if (!bmp) return;
    const s = Math.max(256 / bmp.width, 96 / bmp.height) * zoom.value / 100, dw = bmp.width * s, dh = bmp.height * s;
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, -(dw - 256) * px.value / 100, -(dh - 96) * py.value / 100, dw, dh);
  };
  for (const k of [zoom, px, py]) k.oninput = draw;
  const setMsg = (t, cls = '') => { msg.textContent = t; msg.className = 'msg' + (cls ? ` ${cls}` : ''); };
  async function useBlob(b) {
    if (!b || !/^image\//.test(b.type || 'image/')) { setMsg('that is not an image', 'err'); return; }
    if (b.size > 20e6) { setMsg('that picture is too large (20 MB at most)', 'err'); return; }
    try { bmp = await createImageBitmap(b); } catch (e) { setMsg('could not read that picture', 'err'); return; }
    zoom.value = 100; px.value = 50; py.value = 45;
    crop.hidden = false; draw(); setMsg('Picture ready: frame it with the sliders.');
  }
  file.onchange = () => file.files[0] && useBlob(file.files[0]);
  useUrl.onclick = async () => {
    const u = url.value.trim();
    if (!u) { url.focus(); return; }
    useUrl.disabled = true; setMsg('fetching the picture…');
    try {
      const r = await fetch(API + 'fetchimg', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: u }) });
      if (!r.ok) { let j = {}; try { j = await r.json(); } catch (e) {} throw new Error(j.error || `HTTP ${r.status}`); }
      await useBlob(await r.blob());
    } catch (e) { setMsg(e.message, 'err'); }
    useUrl.disabled = false;
  };
  url.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); useUrl.onclick(); } };
  f.addEventListener('paste', e => {
    const it = [...(e.clipboardData || {}).items || []].find(i => i.kind === 'file' && /^image\//.test(i.type));
    if (it) { e.preventDefault(); useBlob(it.getAsFile()); }
  });
  f.ondragover = e => e.preventDefault();
  f.ondrop = e => { e.preventDefault(); const x = e.dataTransfer.files[0]; if (x) useBlob(x); };
  rm.onclick = () => { bmp = null; crop.hidden = true; file.value = ''; setMsg('Picture removed.'); };
  cancel.onclick = () => { f.remove(); openForm = null; };
  f.onsubmit = async e => {
    e.preventDefault();
    const title = f.elements.namedItem('title').value.trim(), jp = f.elements.namedItem('jp').value.trim();
    let img = '';
    if (bmp) {
      draw();
      for (const q of [0.88, 0.8, 0.7, 0.6]) {
        const b = await new Promise(r => cv.toBlob(r, 'image/jpeg', q));
        if (b && b.size <= 60000) { const a = new Uint8Array(await b.arrayBuffer()); let s = ''; for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode(...a.subarray(i, i + 0x8000)); img = btoa(s); break; }
      }
      if (!img) { setMsg('could not make the picture small enough', 'err'); return; }
    }
    if (!title && !jp && !img) { setMsg('suggest a name, a Japanese name or a picture', 'err'); return; }
    send.disabled = true; setMsg('sending…');
    try {
      await api('submit', { key: t.key, title, jp, img });
      f.remove(); openForm = null;
      toast('Thanks! Your suggestion is waiting for review.');
      await loadList(); render(); renderReview();
    } catch (err) { setMsg(err.message, 'err'); send.disabled = false; }
  };
  return f;
}

// ---- review (owner / mods) and the user's own waiting suggestions ----
function renderReview() {
  const box = $('review'), list = $('revlist');
  const items = pending;
  box.hidden = !me.signedIn || (!me.reviewer && !items.length);
  if (box.hidden) return;
  $('revtitle').textContent = me.reviewer ? 'Waiting for review' : 'Your suggestions waiting for review';
  $('revn').textContent = items.length;
  if (!items.length) { list.replaceChildren(el('div', 'empty', 'Nothing waiting. New suggestions show here.')); return; }
  list.replaceChildren(...items.map(p => {
    const t = tracks.find(x => x.key === p.key) || { key: p.key, game: p.key.split(':')[0], id: +p.key.split(':')[1] };
    const r = el('div', 'rv'), art = el('div', 'art'), what = el('div', 'what'), btns = el('div', 'btns');
    if (p.img) art.style.backgroundImage = `url("${API}simg/${encodeURIComponent(p.sid)}")`; else tileArt(t, art);
    what.append(el('div', 'trkname', `${GAME_NAME[t.game] || t.game} · ${label(t)}${t.stageName ? ` · ${t.stageName}` : ''}`));
    what.append(el('div', 'nm' + (p.title ? '' : ' none'), p.title || '(no name suggested)'));
    if (p.jp) what.append(el('div', 'jp', p.jp));
    what.append(el('div', 'faint', `${p.img ? 'with a picture · ' : ''}by ${p.by || '?'} · ${ago(p.t)}`));
    const listen = el('button', 'play listen', '▶');
    listen.dataset.play = p.key; listen.title = 'listen'; listen.onclick = () => playKey(p.key);
    btns.append(listen);
    if (me.reviewer) {
      const ok = el('button', 'txt okb', 'approve'), no = el('button', 'txt', 'reject');
      ok.onclick = () => decide(p, 'approve', ok, no);
      no.onclick = () => decide(p, 'reject', ok, no);
      btns.append(ok, no);
    }
    r.append(art, what, btns);
    return r;
  }));
  if (playing) paint(playing);
}
const ago = ms => { const s = (Date.now() - ms) / 1000; return s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`; };
async function decide(p, what, ...btns) {
  for (const b of btns) b.disabled = true;
  try {
    const j = await api(what, { sid: p.sid });
    if (what === 'approve' && j.override) ov[p.key] = j.override;
    toast(what === 'approve' ? 'Approved: it shows in Raito Radio now.' : 'Rejected.');
  } catch (e) { toast(e.message); }
  await loadList();
  render(); renderReview();
}

// ---- sign-in state ----
function renderWho() {
  const w = $('who');
  w.replaceChildren();
  if (!API) { w.append(el('span', 'faint', 'read only')); return; }
  if (me.signedIn) {
    w.append('signed in as ', el('b', '', me.name));
    if (me.reviewer) w.append(el('span', 'rev', 'reviewer'));
    const out = el('button', 'txt', 'sign out');
    out.onclick = async () => {
      await fetch(AUTH + 'logout', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
      location.reload();
    };
    w.append(out);
  } else if (me.signin) {
    const a = el('a', 'signin', 'Sign in with Discord'); a.href = me.signin; w.append(a);
  } else if (me.need) {
    const a = el('a', '', 'pick your chat name first'); a.href = me.chat || '/'; w.append(a);
  } else if (me.denied) w.append(el('span', 'faint', 'this account cannot suggest'));
  else w.append(el('span', 'faint', 'sign-in is not available'));
}
async function loadMe() {
  if (!API) return;
  // (/auth/token re-checks an old session at the community service, as the chat does, and refreshes the cookie)
  try { await fetch(AUTH + 'token', { cache: 'no-store', credentials: 'same-origin' }); } catch (e) {}
  try { me = await api('me'); } catch (e) { me = { signedIn: false }; }
}
async function loadList() {
  if (!API) return;
  try { const j = await api('list'); pending = j.pending || []; counts = j.counts || {}; } catch (e) { pending = []; counts = {}; }
}
async function loadOverrides() {
  try {
    const r = await fetch('/radio/overrides.json', { cache: 'no-cache' });
    if (r.ok) ov = (await r.json()).tracks || {};
  } catch (e) {}
}

async function main() {
  $('games').replaceChildren(...GAMES.map(([g, n]) => {
    const b = el('button', '', n); b.dataset.g = g;
    b.onclick = () => { game = g; saveView(); render(); };
    return b;
  }));
  const ut = $('untitled');
  ut.checked = untitledOnly;
  ut.onchange = () => { untitledOnly = ut.checked; saveView(); render(); };
  if (/#chat-signin=/.test(location.hash)) { toast(`sign-in: ${decodeURIComponent(location.hash.split('=')[1])}`); history.replaceState(null, '', location.pathname); }
  const meP = loadMe().then(renderWho);
  cryptoKey = await crypto.subtle.importKey('raw', hex(KEY_HEX), 'AES-CTR', false, ['decrypt']);
  const mv = (document.querySelector('meta[name="mbaa-manifest"]') || {}).content || '';
  const r = await fetch(BUNDLE + 'manifest.bin' + (mv ? `?v=${mv}` : ''), { cache: mv ? 'default' : 'no-cache' });
  if (!r.ok) throw new Error(`manifest: HTTP ${r.status}`);
  man = JSON.parse(new TextDecoder().decode(await openObject(await r.arrayBuffer())));
  const [old] = await Promise.all([bundleFile('web/radio/old.json').then(d => JSON.parse(new TextDecoder().decode(d))), loadOverrides(), meP, loadList()]);
  const order = { mb: 0, re: 1, ac: 2 };
  tracks = old.games.flatMap(g => g.tracks.map(t => ({ key: `${g.id}:${t.id}`, game: g.id, id: t.id, f: t.f, title: t.title, titled: t.titled !== false,
    titleJp: t.titleJp || '', stage: t.stage, stageName: t.stageName || '', tile: t.tile || '', yt: t.yt || '', dur: t.dur || NaN })))
    .sort((a, b) => order[a.game] - order[b.game] || a.id - b.id);
  render(); renderReview();
}
main().catch(e => { $('status').textContent = `could not load the tracks: ${e.message}`; console.error(e); });
