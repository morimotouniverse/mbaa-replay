// Live chat for the viewer (private preview): loaded by viewer.js only on the chat page (the Worker gives that page
// <meta name="mbaa-chat">; a local test page: ?chat=1 on 127.0.0.1 / localhost).
//
// IRC over a WebSocket (wss://<page dir>/irc: the Worker passes it on to our Ergo server, tools/chat/ergo/ircd.yaml;
// ?chatUrl= overrides it on a local test page). Minimal IRCv3: CAP message-tags, server-time, echo-message, batch,
// draft/chathistory (the last 50 lines on joining). Channels: #melty (everyone) and, while a live match is watched,
// #m-<match id> (joined and shown automatically).
//
// Profile: nick, colour, character and moon (the select screen's icon), kept in localStorage and sent with every
// message as client tags (+mbaa/color, +mbaa/chara, +mbaa/moon; +mbaa/cmd: the sender's Niconico commands, e.g.
// "ue big red", from the commands box); plain IRC clients ignore them. The panel shows each line with the sender's icon
// and colour; the overlay (toggle "on picture") shows each new line of the shown channel on the game picture as a
// Niconico comment (laid out and drawn by the vendored niconicomments, see the overlay section), as text in the
// sender's colour unless their commands name another.
(() => {
  'use strict';
  const api = window.mbaaChatApi;
  if (!api || document.getElementById('chatsec')) return;
  const Q = new URLSearchParams(location.search);
  const LOCAL = /^(127\.0\.0\.1|localhost)$/.test(location.hostname);
  const WS_URL = (LOCAL && Q.get('chatUrl')) ||
    location.origin.replace(/^http/, 'ws') + location.pathname.replace(/\/[^/]*$/, '') + '/irc';
  const GENERAL = '#melty', HISTORY = 50, MAXLEN = 300, MAXLINES = 300;
  const MOON_X = [112, 0, 224], MOON_NAME = ['Crescent', 'Full', 'Half'];
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };

  // ---- profile ----
  const NICK_RE = /^[A-Za-z_\[\]\\^{}|`][A-Za-z0-9_\-\[\]\\^{}|`]{0,23}$/;
  const randNick = () => 'viewer' + Math.floor(1000 + Math.random() * 9000);
  const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
  const PRESETS = ['#e04a5a', '#ff9a3c', '#ffd84a', '#7ee05a', '#40c0ff', '#7a8cff', '#c878e6', '#ff7ac8', '#e8e8f0'];
  const prof = Object.assign({ nick: randNick(), color: PRESETS[Math.floor(Math.random() * PRESETS.length)], chara: 17, moon: 1 },
    store.get('mbaa-chat-profile', {}));
  if (!NICK_RE.test(prof.nick)) prof.nick = randNick();
  if (!COLOR_RE.test(prof.color)) prof.color = PRESETS[0];
  const saveProf = () => store.set('mbaa-chat-profile', prof);
  // the characters with a select-screen icon (no boss versions), in the select screen's order
  const CHARAS = Object.keys(api.chara).map(Number).filter(c => c < 52 && api.iconCell(c) >= 0)
    .sort((a, b) => api.iconCell(a) - api.iconCell(b))
    .filter((c, i, l) => i === 0 || api.iconCell(c) !== api.iconCell(l[i - 1]));
  const validChara = c => Number.isInteger(c) && CHARAS.includes(c);
  if (!validChara(prof.chara)) prof.chara = 17;
  if (![0, 1, 2].includes(prof.moon)) prof.moon = 1;
  // a colour readable on the dark panel / over the game (very dark picks are lifted)
  function readable(hex) {
    if (!COLOR_RE.test(hex || '')) return '#c8c8d8';
    let [r, g, b] = [1, 3, 5].map(i => parseInt(hex.substr(i, 2), 16));
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    if (lum < 0.35) { const k = 0.35 / Math.max(lum, 0.02), m = c => Math.min(255, Math.round(c * k + 40)); [r, g, b] = [m(r), m(g), m(b)]; }
    return `rgb(${r},${g},${b})`;
  }

  // ---- icon art (the player block's: grp/c_sel_aa icons 48x64, large row set from row 4; moons 56x56 at y 288) ----
  let art = null;
  const artWait = [];
  (function artPoll() {
    Promise.resolve(api.art()).then(a => {
      if (a) { art = a; artWait.splice(0).forEach(f => f()); } else setTimeout(artPoll, 1000);
    }, () => setTimeout(artPoll, 2000));
  })();
  // the character's face (the icon's top 48x48) and, when moon >= 0, its moon mark in the lower right corner
  function drawIcon(cv, chara, moon) {
    const draw = () => {
      const x = cv.getContext('2d'), W = cv.width, H = cv.height, cell = validChara(chara) ? api.iconCell(chara) : -1;
      x.clearRect(0, 0, W, H);
      if (cell >= 0) x.drawImage(art.icons, 48 * (cell % 10), (Math.floor(cell / 10) + 4) * 64 + 4, 48, 48, 0, 0, W, H);
      if (moon >= 0 && moon <= 2) x.drawImage(art.cursor, MOON_X[moon], 288, 56, 56, W * 0.55, H * 0.55, W * 0.45, H * 0.45);
    };
    if (art) draw(); else artWait.push(draw);
  }
  const iconCanvas = (cls, size, chara, moon) => {
    const cv = document.createElement('canvas');
    cv.className = cls; cv.width = cv.height = size;
    drawIcon(cv, chara, moon);
    return cv;
  };

  // ---- DOM ----
  const css = document.createElement('style');
  css.textContent = `
  #chatsec .chead { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  #chatsec .ctabs { display: flex; gap: 4px; flex: 1 1 auto; min-width: 0; }
  #chatsec button.ctab { line-height: 1.4; font-size: 11px; padding: 2px 8px; border-radius: 999px; color: var(--faint); background: none; border: 1px solid var(--line);
                   cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 140px; }
  #chatsec button.ctab.on { color: #fff; background: #e04a5a33; border-color: #e04a5a88; }
  #chatsec .ctab .n { opacity: .6; margin-left: 4px; }
  #chatsec .cstate { font-size: 10px; color: var(--faint); }
  #chatlog { list-style: none; margin: 0; padding: 4px; height: 220px; overflow-y: auto; background: #00000033; border-radius: 8px;
             display: flex; flex-direction: column; gap: 2px; font-size: 12px; line-height: 1.35; overscroll-behavior: contain; }
  #chatlog li { display: flex; gap: 5px; align-items: flex-start; word-break: break-word; }
  #chatlog li.sys { color: var(--faint); font-size: 11px; font-style: italic; }
  #chatlog li.hist { opacity: .72; }
  #chatlog .cico { width: 20px; height: 20px; flex: none; border-radius: 4px; background: #ffffff0a; }
  #chatlog .cnick { font-weight: 700; margin-right: 4px; }
  #chatlog .ctime { color: var(--faint); font-size: 10px; margin-right: 4px; }
  #chatsec .cform { display: flex; gap: 6px; }
  #chatsec .cform input { flex: 1 1 auto; min-width: 0; background: var(--raise); color: var(--fg); border: 1px solid var(--line);
                          border-radius: 8px; padding: 5px 8px; font: inherit; }
  #chatsec details summary { cursor: pointer; display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); list-style: none; }
  #chatsec details summary::-webkit-details-marker { display: none; }
  #chatsec .me { width: 24px; height: 24px; border-radius: 4px; }
  #chatsec .prow { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 6px; font-size: 12px; }
  #chatsec .prow input[type=text] { width: 130px; background: var(--raise); color: var(--fg); border: 1px solid var(--line); border-radius: 6px; padding: 3px 6px; font: inherit; }
  #chatsec .sw { width: 16px; height: 16px; border-radius: 50%; border: 2px solid transparent; cursor: pointer; padding: 0; }
  #chatsec .sw.on { border-color: #fff; }
  #chatsec input[type=color] { width: 24px; height: 20px; padding: 0; border: none; background: none; cursor: pointer; }
  #chatsec .moons canvas, #chatsec .cgrid canvas { cursor: pointer; border-radius: 4px; border: 2px solid transparent; }
  #chatsec .moons canvas.on, #chatsec .cgrid canvas.on { border-color: #fff; background: #ffffff18; }
  #chatsec .cgrid { display: grid; grid-template-columns: repeat(auto-fill, 34px); gap: 2px; max-height: 120px; overflow-y: auto; margin-top: 6px; }
  #chatsec .cform input#chatcmd { flex: 0 1 90px; font-size: 11px; color: var(--muted); }
  #chatover { position: absolute; left: 0; top: 0; width: 100%; height: 100%; overflow: hidden; pointer-events: none; z-index: 1; }
  #chatover canvas { position: absolute; top: 0; height: 100%; }
  `;
  document.head.append(css);

  const sec = document.createElement('div');
  sec.className = 'sec'; sec.id = 'chatsec';
  sec.innerHTML = `
    <div class="chead"><span class="lbl">chat</span><span class="ctabs"></span>
      <label class="tog" title="new comments cross the game picture (Nico Nico style)"><input id="chatover_on" type="checkbox"> on picture</label></div>
    <ol id="chatlog" aria-live="polite"></ol>
    <form class="cform" autocomplete="off"><input id="chatcmd" type="text" maxlength="60" spellcheck="false" placeholder="commands"
      title="Niconico commands for your comments on the picture, e.g. ue / shita (top / bottom, 3 s), big / small, a colour (red, pink, orange, yellow, green, cyan, blue, purple, white, black, white2, red2, …, or #rrggbb). Empty: scrolls, medium, your colour."><input id="chatin" type="text" maxlength="${MAXLEN}" placeholder="say something…" enterkeyhint="send">
      <button type="submit" class="txt">send</button></form>
    <details><summary><canvas class="me" width="48" height="48"></canvas><span class="mynick"></span><span class="cstate"></span></summary>
      <div class="prow">nick <input id="chatnick" type="text" maxlength="24" spellcheck="false"></div>
      <div class="prow">colour <span class="sws"></span><input id="chatcolor" type="color" title="any colour"></div>
      <div class="prow">moon <span class="moons"></span></div>
      <div class="cgrid"></div>
    </details>`;
  const controls = document.getElementById('controls');
  const after = document.getElementById('livesec');
  if (after && after.parentNode === controls) after.after(sec); else controls.append(sec);
  const $ = s => sec.querySelector(s);
  const logEl = $('#chatlog'), tabsEl = $('.ctabs'), input = $('#chatin'), cmdIn = $('#chatcmd'), stateEl = $('.cstate');
  cmdIn.value = String(store.get('mbaa-chat-cmd', '')).slice(0, 60);  // (kept, as Nico's command box is)
  cmdIn.onchange = () => store.set('mbaa-chat-cmd', cmdIn.value.trim());

  const over = document.createElement('div');
  over.id = 'chatover';
  const stage = document.querySelector('.stage');
  stage.insertBefore(over, document.getElementById('banner0') || null);
  const overOn = $('#chatover_on');
  overOn.checked = store.get('mbaa-chat-over', true);
  over.hidden = !overOn.checked;
  overOn.onchange = () => { store.set('mbaa-chat-over', overOn.checked); over.hidden = !overOn.checked; if (!overOn.checked) nicoReset(); overOn.blur(); };

  // profile editor
  function profShow() {
    drawIcon($('.me'), prof.chara, prof.moon);
    const n = $('.mynick'); n.textContent = prof.nick; n.style.color = readable(prof.color);
    $('#chatnick').value = prof.nick; $('#chatcolor').value = prof.color;
    sec.querySelectorAll('.sw').forEach(b => b.classList.toggle('on', b.dataset.c.toLowerCase() === prof.color.toLowerCase()));
    sec.querySelectorAll('.moons canvas').forEach((c, m) => c.classList.toggle('on', m === prof.moon));
    sec.querySelectorAll('.cgrid canvas').forEach(c => c.classList.toggle('on', +c.dataset.c === prof.chara));
  }
  for (const c of PRESETS) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'sw'; b.dataset.c = c; b.style.background = c; b.title = c;
    b.onclick = () => { prof.color = c; saveProf(); profShow(); };
    $('.sws').append(b);
  }
  $('#chatcolor').oninput = e => { prof.color = e.target.value; saveProf(); profShow(); };
  [0, 1, 2].forEach(m => {
    const cv = document.createElement('canvas'); cv.width = cv.height = 24; cv.title = MOON_NAME[m];
    const draw = () => cv.getContext('2d').drawImage(art.cursor, MOON_X[m], 288, 56, 56, 0, 0, 24, 24);
    if (art) draw(); else artWait.push(draw);
    cv.onclick = () => { prof.moon = m; saveProf(); profShow(); };
    $('.moons').append(cv);
  });
  for (const c of CHARAS) {
    const cv = iconCanvas('', 30, c, -1);
    cv.dataset.c = c; cv.title = api.chara[c];
    cv.onclick = () => { prof.chara = c; saveProf(); profShow(); };
    $('.cgrid').append(cv);
  }
  $('#chatnick').onchange = e => {
    const n = e.target.value.trim();
    if (!NICK_RE.test(n)) { e.target.value = prof.nick; sys('nick: letters, digits, _ - [ ] { } | ^ ` (not starting with a digit or -), up to 24'); return; }
    prof.nick = n; saveProf(); profShow();
    if (irc.registered && n !== irc.nick) irc.send(`NICK ${n}`);
  };
  profShow();

  // ---- channels and the log ----
  const chans = new Map();  // name (lowercase) -> {name, lines: [], names: Set, joined, histDone}
  let shown = GENERAL, matchChan = null;
  const key = n => n.toLowerCase();
  function chan(name) {
    let c = chans.get(key(name));
    if (!c) chans.set(key(name), c = { name, lines: [], names: new Set(), joined: false, histDone: false, seen: new Set() });
    return c;
  }
  function tabs() {
    tabsEl.replaceChildren();
    for (const name of [GENERAL, matchChan].filter(Boolean)) {
      const c = chan(name), b = document.createElement('button');
      b.type = 'button'; b.className = 'ctab' + (key(name) === key(shown) ? ' on' : '');
      b.textContent = name === GENERAL ? '#melty' : 'this match';
      b.title = name;
      const n = document.createElement('span'); n.className = 'n'; n.textContent = c.names.size || ''; b.append(n);
      b.onclick = () => { shown = name; tabs(); render(); b.blur(); };
      tabsEl.append(b);
    }
  }
  const clean = t => String(t).replace(/\x03\d{0,2}(,\d{1,2})?/g, '').replace(/[\x00-\x1f\x7f]/g, '');
  function lineEl(l) {
    const li = document.createElement('li');
    if (l.sys) { li.className = 'sys'; li.textContent = l.text; return li; }
    if (l.hist) li.className = 'hist';
    li.append(iconCanvas('cico', 40, l.chara, l.moon));
    const body = document.createElement('span');
    const tm = document.createElement('span'); tm.className = 'ctime';
    tm.textContent = l.time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const nk = document.createElement('span'); nk.className = 'cnick'; nk.style.color = readable(l.color);
    nk.textContent = l.action ? `* ${l.nick}` : l.nick;
    body.append(tm, nk, document.createTextNode(l.text));
    li.append(body);
    return li;
  }
  function render() {
    const c = chan(shown);
    logEl.replaceChildren(...c.lines.map(lineEl));
    logEl.scrollTop = logEl.scrollHeight;
  }
  function addLine(name, l) {
    const c = chan(name);
    if (l.msgid) { if (c.seen.has(l.msgid)) return; c.seen.add(l.msgid); }
    // (history arrives oldest first, before any live line of that channel: kept in time order)
    if (l.hist) { let i = c.lines.length; while (i > 0 && c.lines[i - 1].time > l.time) i--; c.lines.splice(i, 0, l); }
    else c.lines.push(l);
    if (c.lines.length > MAXLINES) c.lines.splice(0, c.lines.length - MAXLINES);
    if (key(name) !== key(shown)) return;
    const stick = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 30;
    if (l.hist) render();
    else { logEl.append(lineEl(l)); if (logEl.children.length > MAXLINES) logEl.firstChild.remove(); }
    if (stick || l.self) logEl.scrollTop = logEl.scrollHeight;
    if (!l.hist && !l.sys) danmaku(l);
  }
  const sys = (text, name) => addLine(name || shown, { sys: true, text, time: new Date() });

  // ---- the overlay: Niconico's own comment layout ----
  // Drawn by niconicomments 0.4.1 (MIT, xpadev-net; vendor/niconicomments-0.4.1.js, self-hosted, loaded on the first
  // comment), a reimplementation of the official nicovideo HTML5 player's renderer: its 1920x1080 stage (font sizes
  // from the 384-line Flash stage: small / medium / big), naka comments crossing commentDrawRange + width in 4 s after
  // a 1 s lead-in (so longer comments move faster), the official collision (a row is taken while any earlier comment
  // overlaps this one in time-x at the stage's left / right collision lines; the lowest free row, else a random y),
  // ue / shita fixed 3 s, black outline, Nico's colour names. Our picture is 4:3: the canvas is the 16:9 stage at the
  // picture's height, centred, so the picture shows the stage's 4:3 middle (240..1680, the same area a 4:3 video fills
  // in the official 16:9 player; comments enter at its right edge).
  // Live comments: the overlay keeps its own clock (vpos = hundredths of a second since it was built) and adds each
  // comment as it arrives (addComments), naka at now + 1 s (the stage's 1 s lead-in: it enters as it arrives), fixed
  // ones at now; drawn on rAF while any is on screen, the instance dropped once all have left.
  const NICO_SRC = 'vendor/niconicomments-0.4.1.js?v=0.4.1';
  const NICO_COLORS = ['white', 'red', 'pink', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'black', 'white2',
    'niconicowhite', 'red2', 'truered', 'pink2', 'orange2', 'passionorange', 'yellow2', 'madyellow', 'green2', 'elementalgreen',
    'cyan2', 'blue2', 'marinblue', 'purple2', 'nobleviolet', 'black2'];
  const NICO_CMDS = new Set(['ue', 'shita', 'naka', 'big', 'medium', 'small', 'defont', 'mincho', 'gothic', 'ender', 'full', ...NICO_COLORS]);
  // a sender's commands (the commands box, or a received +mbaa/cmd tag): known Niconico commands and #rrggbb only
  const nicoCmds = t => String(t || '').toLowerCase().split(/[\s　]+/).filter(c => NICO_CMDS.has(c) || COLOR_RE.test(c)).slice(0, 8);
  // the sender's colour, lifted as readable() does, as #rrggbb (Nico's colour code command)
  const readableHex = hex => '#' + readable(hex).match(/\d+/g).map(n => (+n).toString(16).padStart(2, '0')).join('');
  const nico = { lib: null, loading: null, inst: null, cv: null, t0: 0, list: [], id: 0, end: 0, raf: 0, size: '' };
  const vposNow = () => Math.round((performance.now() - nico.t0) / 10);
  function nicoLoad() {
    if (nico.lib || nico.loading) return nico.loading;
    return nico.loading = new Promise((res, rej) => {
      const e = document.createElement('script'); e.src = NICO_SRC;
      e.onload = () => { nico.lib = window.NiconiComments; res(); };
      e.onerror = () => { nico.loading = null; rej(new Error('niconicomments did not load')); };
      document.head.append(e);
    });
  }
  // exactly over the picture (as viewer.js pins #overlay: in fullscreen the picture is not where a centred box would be)
  function pin() {
    const gameCv = document.getElementById('canvas');  // (looked up each time: viewer.js replaces it on a GL context change)
    if (!gameCv) return;
    const L = `${gameCv.offsetLeft}px`, T = `${gameCv.offsetTop}px`, W = `${gameCv.offsetWidth}px`, H = `${gameCv.offsetHeight}px`;
    const st = over.style;
    if (st.left !== L || st.top !== T || st.width !== W || st.height !== H) Object.assign(st, { left: L, top: T, width: W, height: H });
  }
  function nicoReset() {
    if (nico.raf) cancelAnimationFrame(nico.raf);
    nico.raf = 0;
    if (nico.inst) try { nico.inst.destroy(); } catch (e) {}
    nico.inst = null; nico.list = []; nico.size = ''; nico.end = 0;
    if (nico.cv) { nico.cv.remove(); nico.cv = null; }
  }
  // (re)built for the overlay's size: the stage's layout is in its own 1920x1080 units, so a rebuild with the same
  // comments (same order, same vpos) lays them out the same; the comments that have left are dropped then
  function nicoBuild() {
    const w = over.clientWidth, h = over.clientHeight, dpr = Math.min(2, window.devicePixelRatio || 1);
    if (!w || !h) return false;
    const now = vposNow();
    nico.list = nico.list.filter(c => c.end > now);
    if (nico.inst) try { nico.inst.destroy(); } catch (e) {}
    if (!nico.cv) { nico.cv = document.createElement('canvas'); over.append(nico.cv); }
    const cw = h * 16 / 9;
    nico.cv.width = Math.round(cw * dpr); nico.cv.height = Math.round(h * dpr);
    nico.cv.style.width = `${cw}px`; nico.cv.style.left = `${(w - cw) / 2}px`;
    nico.inst = new nico.lib(nico.cv, nico.list.map(c => c.raw), { format: 'formatted', mode: 'html5' });
    nico.size = `${w}x${h}@${dpr}`;
    return true;
  }
  function nicoFrame() {
    nico.raf = 0;
    if (!nico.inst || over.hidden) return;
    pin();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (`${over.clientWidth}x${over.clientHeight}@${dpr}` !== nico.size && !nicoBuild()) return;
    const now = vposNow();
    if (now > nico.end) { nicoReset(); return; }  // (all gone: the next comment starts a fresh stage)
    nico.inst.drawCanvas(now);
    nico.raf = requestAnimationFrame(nicoFrame);
  }
  async function danmaku(l) {
    if (!overOn.checked || document.visibilityState === 'hidden') return;
    try { await nicoLoad(); } catch (e) { return; }
    if (!overOn.checked || document.visibilityState === 'hidden') return;
    pin();
    const cmds = nicoCmds(l.cmd), fixed = cmds.includes('ue') || cmds.includes('shita');
    // the sender's own commands first (Nico takes the first colour given), the profile colour as the default
    const mail = l.color ? [...cmds, readableHex(l.color)] : cmds;
    if (!nico.inst) { nico.t0 = performance.now(); nico.list = []; if (!nicoBuild()) return; }
    const now = vposNow(), vpos = fixed ? now : now + 100;
    const raw = { id: ++nico.id, vpos, content: l.action ? `${l.nick} ${l.text}` : l.text, mail, owner: false, premium: true,
                  date: Math.floor(Date.now() / 1000), user_id: 0, layer: -1, is_my_post: !!l.self };
    // (gone: naka by its timeline's end, vpos + 300 + 125; fixed after 300)
    const end = vpos + (fixed ? 300 : 425) + 10;
    nico.list.push({ raw, end });
    nico.end = Math.max(nico.end, end);
    if (nico.list.length > 200) nicoBuild(); else nico.inst.addComments(raw);
    if (!nico.raf) nico.raf = requestAnimationFrame(nicoFrame);
  }

  // ---- IRC ----
  const irc = { ws: null, registered: false, nick: prof.nick, caps: new Set(), batches: new Map(), retry: 0, lastSend: 0 };
  const WANT = ['message-tags', 'server-time', 'echo-message', 'batch', 'draft/chathistory', 'chathistory'];
  irc.send = line => { if (irc.ws && irc.ws.readyState === 1) irc.ws.send(line); };
  function state(t) { stateEl.textContent = t ? `· ${t}` : ''; }
  const unesc = v => v.replace(/\\(.)/g, (_, c) => ({ ':': ';', s: ' ', '\\': '\\', r: '\r', n: '\n' })[c] ?? c);
  function parse(raw) {
    let s = raw, tags = {}, src = '';
    if (s[0] === '@') { const i = s.indexOf(' '); for (const t of s.slice(1, i).split(';')) { const j = t.indexOf('='); tags[j < 0 ? t : t.slice(0, j)] = j < 0 ? '' : unesc(t.slice(j + 1)); } s = s.slice(i + 1).trimStart(); }
    if (s[0] === ':') { const i = s.indexOf(' '); src = s.slice(1, i); s = s.slice(i + 1).trimStart(); }
    const params = []; let trail = null;
    const ti = s.indexOf(' :');
    if (ti >= 0) { trail = s.slice(ti + 2); s = s.slice(0, ti); } else if (s.startsWith(':')) { trail = s.slice(1); s = ''; }
    params.push(...s.split(' ').filter(Boolean));
    const cmd = (params.shift() || '').toUpperCase();
    if (trail !== null) params.push(trail);
    return { tags, src, nick: src.split('!')[0], cmd, params };
  }
  function connect() {
    state('connecting');
    let ws;
    try { ws = new WebSocket(WS_URL, ['text.ircv3.net']); } catch (e) { state('offline'); return later(); }
    irc.ws = ws; irc.registered = false; irc.caps.clear(); irc.batches.clear();
    ws.onopen = () => {
      irc.send('CAP LS 302');
      irc.nick = prof.nick;
      irc.send(`NICK ${irc.nick}`);
      irc.send(`USER ${irc.nick.replace(/[^A-Za-z0-9]/g, '').slice(0, 10) || 'viewer'} 0 * :MBAACC web viewer`);
    };
    ws.onmessage = e => {  // (text.ircv3.net: a line per frame, no line ending; split anyway)
      for (const l of (typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data)).split(/\r?\n/)) if (l) on(parse(l));
    };
    ws.onclose = () => {
      if (irc.ws !== ws) return;
      irc.ws = null; irc.registered = false;
      for (const c of chans.values()) { c.joined = false; c.names.clear(); }
      tabs(); state('offline, retrying'); later();
    };
    ws.onerror = () => {};
  }
  function later() { const d = Math.min(30000, 1500 * 2 ** irc.retry++); setTimeout(connect, d + Math.random() * 1000); }
  function join(name) { const c = chan(name); if (irc.registered && !c.joined) irc.send(`JOIN ${name}`); }
  function on(m) {
    const p = m.params;
    switch (m.cmd) {
      case 'PING': irc.send(`PONG :${p[p.length - 1] || ''}`); return;
      case 'CAP': {
        const sub = (p[1] || '').toUpperCase();
        if (sub === 'LS') {
          const more = p[2] === '*', list = (more ? p[3] : p[2]) || '';
          for (const c of list.split(' ')) if (c) irc.caps.add(c.split('=')[0]);
          if (!more) {
            const want = WANT.filter(c => irc.caps.has(c));
            irc.caps.clear();
            if (want.length) irc.send(`CAP REQ :${want.join(' ')}`); else irc.send('CAP END');
          }
        } else if (sub === 'ACK') { for (const c of (p[2] || '').split(' ')) if (c) irc.caps.add(c); irc.send('CAP END'); }
        else if (sub === 'NAK') irc.send('CAP END');
        return;
      }
      case '001':
        irc.registered = true; irc.retry = 0; irc.nick = p[0];
        if (irc.nick !== prof.nick) sys(`connected as ${irc.nick}`);
        state('');
        join(GENERAL); if (matchChan) join(matchChan);
        return;
      case '432': case '433': {  // nick taken / not allowed
        if (irc.registered) { sys(`nick ${p[1]} ${m.cmd === '433' ? 'is taken' : 'is not allowed'}`); return; }
        irc.nick = (m.cmd === '433' ? prof.nick.slice(0, 19) + Math.floor(Math.random() * 1000) : randNick());
        irc.send(`NICK ${irc.nick}`);
        return;
      }
      case 'NICK': {
        const to = p[0];
        for (const c of chans.values()) if (c.names.delete(m.nick)) c.names.add(to);
        if (m.nick === irc.nick) irc.nick = to;
        return;
      }
      case 'JOIN': {
        const c = chan(p[0]);
        if (m.nick === irc.nick) c.joined = true;
        c.names.add(m.nick); tabs();
        return;
      }
      case 'PART': { const c = chan(p[0]); c.names.delete(m.nick); if (m.nick === irc.nick) { c.joined = false; c.names.clear(); } tabs(); return; }
      case 'KICK': { const c = chan(p[0]); c.names.delete(p[1]); if (p[1] === irc.nick) { c.joined = false; c.names.clear(); sys(`kicked from ${p[0]}`, p[0]); } tabs(); return; }
      case 'QUIT': for (const c of chans.values()) c.names.delete(m.nick); tabs(); return;
      case '353': { const c = chan(p[2]); for (const n of (p[3] || '').split(' ')) if (n) c.names.add(n.replace(/^[~&@%+]+/, '')); return; }
      case '366': {
        const c = chan(p[1]); tabs();
        if (!c.histDone && (irc.caps.has('draft/chathistory') || irc.caps.has('chathistory'))) { c.histDone = true; irc.send(`CHATHISTORY LATEST ${c.name} * ${HISTORY}`); }
        return;
      }
      case 'BATCH': {
        const id = p[0].slice(1);
        if (p[0][0] === '+') irc.batches.set(id, p[1]); else irc.batches.delete(id);
        return;
      }
      case 'PRIVMSG': case 'NOTICE': {
        const target = p[0], text0 = p[1] || '';
        if (m.nick === 'HistServ') return;  // (history's join / part events, as messages for clients without event-playback)
        if (target[0] !== '#') { if (m.cmd === 'NOTICE' && !m.nick.includes('.')) return; if (m.cmd === 'NOTICE') sys(clean(text0)); return; }
        let text = text0, action = false;
        if (text.startsWith('\x01')) { if (!text.startsWith('\x01ACTION ')) return; action = true; text = text.slice(8).replace(/\x01$/, ''); }
        const t = m.tags, hist = !!(t.batch && /chathistory/.test(irc.batches.get(t.batch) || ''));
        const chara = /^\d{1,2}$/.test(t['+mbaa/chara'] || '') ? +t['+mbaa/chara'] : -1;
        const moon = /^[0-2]$/.test(t['+mbaa/moon'] || '') ? +t['+mbaa/moon'] : -1;
        addLine(target, { nick: m.nick, text: clean(text), action, hist, self: m.nick === irc.nick, msgid: t.msgid,
                          time: t.time ? new Date(t.time) : new Date(), color: COLOR_RE.test(t['+mbaa/color'] || '') ? t['+mbaa/color'] : null,
                          chara: validChara(chara) ? chara : -1, moon, cmd: nicoCmds(t['+mbaa/cmd']).join(' ') });
        return;
      }
      case 'FAIL': sys(`server: ${clean(p.slice(2).join(' '))}`); return;
      case 'ERROR': sys(`disconnected: ${clean(p[0] || '')}`); return;
      case '404': case '473': case '474': case '475': case '477': case '482': sys(clean(p[p.length - 1] || 'refused')); return;
    }
  }
  function say(text) {
    text = text.replace(/[\r\n]+/g, ' ').trim().slice(0, MAXLEN);
    if (!text) return;
    if (text.startsWith('/')) {
      const [cmd, ...rest] = text.slice(1).split(' '), arg = rest.join(' ').trim();
      if (/^me$/i.test(cmd) && arg) text = `\x01ACTION ${arg}\x01`;
      else if (/^nick$/i.test(cmd)) { $('#chatnick').value = arg; $('#chatnick').onchange({ target: $('#chatnick') }); return; }
      else { sys('commands: /me <action>, /nick <name>'); return; }
    }
    if (!irc.registered) { sys('not connected yet'); return; }
    const c = chan(shown);
    if (!c.joined) { join(shown); sys('joining, try again in a moment'); return; }
    const now = performance.now();
    if (now - irc.lastSend < 700) { sys('slow down a little'); return; }
    irc.lastSend = now;
    const cmd = nicoCmds(cmdIn.value).join(' ');
    const tags = irc.caps.has('message-tags') ? `@+mbaa/color=${prof.color};+mbaa/chara=${prof.chara};+mbaa/moon=${prof.moon}${cmd ? `;+mbaa/cmd=${cmd.replace(/ /g, '\\s')}` : ''} ` : '';
    irc.send(`${tags}PRIVMSG ${shown} :${text}`);
    if (!irc.caps.has('echo-message')) {
      const action = text.startsWith('\x01ACTION ');
      addLine(shown, { nick: irc.nick, text: action ? text.slice(8, -1) : text, action, self: true, time: new Date(),
                       color: prof.color, chara: prof.chara, moon: prof.moon, cmd });
    }
  }
  $('.cform').onsubmit = e => { e.preventDefault(); say(input.value); input.value = ''; };

  // the watched live match's channel: joined (and shown) when a match starts, left when another one is picked
  const matchName = id => `#m-${String(id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60)}`;
  setInterval(() => {
    const id = api.liveId(), want = id ? matchName(id) : null;
    if (want === matchChan) return;
    if (matchChan && irc.registered) { irc.send(`PART ${matchChan}`); chan(matchChan).joined = false; }
    if (matchChan) chans.delete(key(matchChan));
    matchChan = want;
    if (want) { join(want); shown = want; } else if (shown !== GENERAL) shown = GENERAL;
    tabs(); render();
  }, 1000);

  tabs(); render();
  connect();
  window.mbaaChat = { irc, chans, prof, danmaku, say, nico, feed: raw => on(parse(raw)), show: name => { chan(name); shown = name; tabs(); render(); }, status: () => ({ connected: irc.registered, nick: irc.nick, caps: [...irc.caps], shown, matchChan }) };  // (tests)
})();
