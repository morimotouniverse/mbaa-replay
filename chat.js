// Live chat for the viewer (private preview): loaded by viewer.js only on the chat page (the Worker gives that page
// <meta name="mbaa-chat">; a local test page: ?chat=1 on 127.0.0.1 / localhost).
//
// IRC over a WebSocket (wss://<page dir>/irc: the Worker passes it on to our Ergo server, tools/chat/ergo/ircd.yaml;
// ?chatUrl= overrides it on a local test page). Minimal IRCv3: CAP message-tags, server-time, echo-message, batch,
// draft/chathistory (#melty: the last 50 lines on joining; a match channel: its whole history, for the timeline).
// Channels: #melty (everyone) and, while a live match is watched, that match's #m-<match key> (joined and shown
// automatically): one per CCCaster netplay session (the bridge's /live/list `match`: a hash of the session id the host
// sends every spectator, tools/web/cc_live.mjs matchKey), so each new match of a host gets its own channel, and every
// viewer, the bridge after a restart and a later replay of the recording derive the same name. (A bridge without
// `match`: #m-<live id>, per host, as before.) Chat is kept forever (Ergo expire-time 0, tools/chat/ergo/ircd.yaml).
//
// Profile: nick, colour, character and moon (the select screen's icon), kept in localStorage and sent with every
// message as client tags (+mbaa/color, +mbaa/chara, +mbaa/moon; +mbaa/cmd: the sender's Niconico commands, e.g.
// "ue big red", from the commands box); plain IRC clients ignore them. The panel shows each line with the sender's icon
// and colour; the overlay (toggle "on picture") shows each new line of the shown channel on the game picture as a
// Niconico comment (laid out and drawn by the vendored niconicomments, see the overlay section), as text in the
// sender's colour unless their commands name another. A match channel's comments are played on the match's own timeline
// instead (the timeline section): at the stream frame they were made at, through seeks, pauses and DVR, as Niconico
// plays a video's comments; the same toggle turns them off (remembered, on by default).
(() => {
  'use strict';
  const api = window.mbaaChatApi;
  if (!api || document.getElementById('chatsec')) return;
  const Q = new URLSearchParams(location.search);
  const LOCAL = /^(127\.0\.0\.1|localhost)$/.test(location.hostname);
  const WS_URL = (LOCAL && Q.get('chatUrl')) ||
    location.origin.replace(/^http/, 'ws') + location.pathname.replace(/\/[^/]*$/, '') + '/irc';
  const GENERAL = '#melty', HISTORY = 50, MAXLEN = 300, MAXLINES = 300;
  // a match channel's history: from its start (CHATHISTORY AFTER an early time), PAGE lines a request (Ergo's
  // chathistory-maxmessages; its CHATHISTORY= token lowers it), the next page after the last msgid
  const HIST_FROM = '2026-01-01T00:00:00.000Z';
  let PAGE = 200;
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
  // the character's whole select-screen icon (its 48x64 cell, as the player block draws it; the canvases are 3:4) and, when
  // moon >= 0, its moon mark in the lower right corner
  function drawIcon(cv, chara, moon) {
    const draw = () => {
      const x = cv.getContext('2d'), W = cv.width, H = cv.height, cell = validChara(chara) ? api.iconCell(chara) : -1;
      x.clearRect(0, 0, W, H);
      if (cell >= 0) x.drawImage(art.icons, 48 * (cell % 10), (Math.floor(cell / 10) + 4) * 64, 48, 64, 0, 0, W, H);
      if (moon >= 0 && moon <= 2) { const m = W * 0.5; x.drawImage(art.cursor, MOON_X[moon], 288, 56, 56, W - m, H - m, m, m); }
    };
    if (art) draw(); else artWait.push(draw);
  }
  const iconCanvas = (cls, size, chara, moon) => {
    const cv = document.createElement('canvas');
    cv.className = cls; cv.height = size; cv.width = size * 3 / 4;  // (size: the height)
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
  #chatlog .cico { width: 18px; height: 24px; flex: none; border-radius: 4px; background: #ffffff0a; }
  #chatlog .cnick { font-weight: 700; margin-right: 4px; }
  #chatlog .ctime { color: var(--faint); font-size: 10px; margin-right: 4px; }
  #chatsec .cform { display: flex; gap: 6px; }
  #chatsec .cform input { flex: 1 1 auto; min-width: 0; background: var(--raise); color: var(--fg); border: 1px solid var(--line);
                          border-radius: 8px; padding: 5px 8px; font: inherit; }
  #chatsec details summary { cursor: pointer; display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); list-style: none; }
  #chatsec details summary::-webkit-details-marker { display: none; }
  #chatsec .me { width: 21px; height: 28px; border-radius: 4px; }
  #chatsec .prow { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 6px; font-size: 12px; }
  #chatsec .prow input[type=text] { width: 130px; background: var(--raise); color: var(--fg); border: 1px solid var(--line); border-radius: 6px; padding: 3px 6px; font: inherit; }
  #chatsec .sw { width: 16px; height: 16px; border-radius: 50%; border: 2px solid transparent; cursor: pointer; padding: 0; }
  #chatsec .sw.on { border-color: #fff; }
  #chatsec input[type=color] { width: 24px; height: 20px; padding: 0; border: none; background: none; cursor: pointer; }
  #chatsec .moons canvas, #chatsec .cgrid canvas { cursor: pointer; border-radius: 4px; border: 2px solid transparent; }
  #chatsec .moons canvas.on, #chatsec .cgrid canvas.on { border-color: #fff; background: #ffffff18; }
  #chatsec .cgrid { display: grid; grid-template-columns: repeat(auto-fill, 34px); grid-auto-rows: 44px; gap: 2px; max-height: 138px; overflow-y: auto; margin-top: 6px; }
  #chatsec .cform input#chatcmd { flex: 0 1 90px; font-size: 11px; color: var(--muted); }
  #chatsec:not(.adv) .cform input#chatcmd { display: none; }
  #chatsec .ctool { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; position: relative; font-size: 11px; }
  #chatsec .cseg { display: inline-flex; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
  #chatsec .ctool button { background: none; border: none; color: var(--muted); font: inherit; font-size: 11px; line-height: 1;
                           min-width: 28px; height: 26px; padding: 0 6px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
  #chatsec .cseg button + button { border-left: 1px solid var(--line); }
  #chatsec .ctool button[aria-pressed=true] { color: #fff; background: #e04a5a33; }
  #chatsec .ctool button:focus-visible { outline: 2px solid var(--accent2); outline-offset: -2px; }
  #chatsec .ctool button.ccol, #chatsec .ctool button.cmore { border: 1px solid var(--line); border-radius: 8px; }
  #chatsec .ctool button.cmore[aria-expanded=true] { color: #fff; background: #ffffff14; }
  #chatsec .ccol .dot { width: 14px; height: 14px; border-radius: 50%; border: 1px solid #ffffff55; display: block; }
  #chatsec .cprev { flex: 1 1 auto; min-width: 40px; text-align: center; color: #fff; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
                    text-shadow: -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000; font-weight: 700; }
  #chatsec .cpop { position: absolute; z-index: 5; left: 0; top: calc(100% + 4px); background: var(--raise); border: 1px solid var(--line);
                   border-radius: 10px; padding: 8px; display: grid; gap: 6px; box-shadow: 0 6px 20px #0008; max-width: calc(100vw - 32px); }
  #chatsec .cpop[hidden] { display: none; }
  #chatsec .cpop .row { display: flex; gap: 4px; flex-wrap: wrap; align-items: center; }
  #chatsec .cpop .row .lbl { font-size: 10px; color: var(--faint); width: 100%; }
  #chatsec .cpop button.sw2 { width: 24px; height: 24px; min-width: 24px; padding: 0; border-radius: 50%; border: 2px solid #ffffff22; }
  #chatsec .cpop button.sw2[aria-pressed=true] { border-color: #fff; background-clip: padding-box; }
  #chatsec .cpop button.mine { width: auto; border-radius: 999px; padding: 0 8px 0 4px; gap: 4px; color: var(--fg); border: 1px solid var(--line); height: 24px; }
  #chatsec .cpop input[type=color] { width: 28px; height: 24px; }
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
    <div class="ctool" role="toolbar" aria-label="how your comments look on the picture (Niconico commands)">
      <span class="cseg" data-k="pos">
        <button type="button" data-v="ue" title="top (ue): fixed at the top for 3 s" aria-label="top"><svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><rect x="1" y="1" width="12" height="3" rx="1"/><rect x="1" y="6" width="12" height="7" rx="1" opacity=".3"/></svg></button>
        <button type="button" data-v="" title="scroll (naka): crosses the picture, the default" aria-label="scroll"><svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><path d="M1 7l4-4v2.5h8v3H5V11z"/></svg></button>
        <button type="button" data-v="shita" title="bottom (shita): fixed at the bottom for 3 s" aria-label="bottom"><svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><rect x="1" y="1" width="12" height="7" rx="1" opacity=".3"/><rect x="1" y="10" width="12" height="3" rx="1"/></svg></button></span>
      <span class="cseg" data-k="size">
        <button type="button" data-v="small" title="small" aria-label="small">S</button>
        <button type="button" data-v="" title="medium (default)" aria-label="medium">M</button>
        <button type="button" data-v="big" title="big" aria-label="big">L</button></span>
      <span class="cseg" data-k="font">
        <button type="button" data-v="" title="default font" aria-label="default font">Aa</button>
        <button type="button" data-v="gothic" title="gothic" aria-label="gothic" style="font-family: sans-serif">ゴ</button>
        <button type="button" data-v="mincho" title="mincho" aria-label="mincho" style="font-family: serif">明</button></span>
      <button type="button" class="ccol" aria-haspopup="true" aria-expanded="false" title="colour" aria-label="colour"><i class="dot"></i></button>
      <span class="cprev" aria-hidden="true" title="how it looks">Aa コメ</span>
      <button type="button" class="cmore" aria-expanded="false" title="type the commands yourself" aria-label="advanced commands">⋯</button>
      <div class="cpop" hidden role="dialog" aria-label="comment colour">
        <div class="row"><button type="button" class="mine" data-c=""><i class="dot"></i>my colour</button></div>
        <div class="row cstd"><span class="lbl">colours</span></div>
        <div class="row cprem"><span class="lbl">premium colours</span></div>
        <div class="row"><span class="lbl">any colour</span><input type="color" class="ccustom" aria-label="any colour"></div>
      </div>
    </div>
    <form class="cform" autocomplete="off"><input id="chatcmd" type="text" maxlength="60" spellcheck="false" placeholder="commands"
      title="Niconico commands for your comments on the picture, e.g. ue / shita (top / bottom, 3 s), big / small, a colour (red, pink, orange, yellow, green, cyan, blue, purple, white, black, white2, red2, …, or #rrggbb). Empty: scrolls, medium, your colour."><input id="chatin" type="text" maxlength="${MAXLEN}" placeholder="say something…" enterkeyhint="send">
      <button type="submit" class="txt">send</button></form>
    <details><summary><canvas class="me" width="42" height="56"></canvas><span class="mynick"></span><span class="cstate"></span></summary>
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
  let toolHook = () => {};  // (the commands toolbar's redraw, set once its section has run: the profile colour shows on it)

  const over = document.createElement('div');
  over.id = 'chatover';
  const stage = document.querySelector('.stage');
  stage.insertBefore(over, document.getElementById('banner0') || null);
  const overOn = $('#chatover_on');
  overOn.checked = store.get('mbaa-chat-over', true);
  over.hidden = !overOn.checked;
  overOn.onchange = () => {
    store.set('mbaa-chat-over', overOn.checked); over.hidden = !overOn.checked;
    if (!overOn.checked) { nicoReset(); tlDrop(); } else tlKick();
    overOn.blur();
  };

  // profile editor
  function profShow() {
    drawIcon($('.me'), prof.chara, prof.moon);
    const n = $('.mynick'); n.textContent = prof.nick; n.style.color = readable(prof.color);
    $('#chatnick').value = prof.nick; $('#chatcolor').value = prof.color;
    sec.querySelectorAll('.sw').forEach(b => b.classList.toggle('on', b.dataset.c.toLowerCase() === prof.color.toLowerCase()));
    sec.querySelectorAll('.moons canvas').forEach((c, m) => c.classList.toggle('on', m === prof.moon));
    sec.querySelectorAll('.cgrid canvas').forEach(c => c.classList.toggle('on', +c.dataset.c === prof.chara));
    toolHook();
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
    const cv = iconCanvas('', 80, c, -1);  // (2x: sharp on high-DPI screens)
    cv.style.width = '30px'; cv.style.height = '40px';
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
    li.append(iconCanvas('cico', 48, l.chara, l.moon));
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
    if (!l.sys && isMatch(name)) tlAdd(l);
    // (history arrives oldest first, before any live line of that channel: kept in time order)
    if (l.hist) { let i = c.lines.length; while (i > 0 && c.lines[i - 1].time > l.time) i--; c.lines.splice(i, 0, l); }
    else c.lines.push(l);
    if (c.lines.length > MAXLINES) c.lines.splice(0, c.lines.length - MAXLINES);
    if (key(name) !== key(shown)) return;
    const stick = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 30;
    if (l.hist) renderSoon();
    else { logEl.append(lineEl(l)); if (logEl.children.length > MAXLINES) logEl.firstChild.remove(); }
    if (stick || l.self) logEl.scrollTop = logEl.scrollHeight;
    // (a match channel's comments: on its timeline, tlAdd above; #melty's: as they arrive)
    if (!l.hist && !l.sys && !isMatch(name)) danmaku(l);
  }
  let renderPend = 0;  // (a match's whole history arrives line by line: one redraw for the lot)
  const renderSoon = () => { if (!renderPend) renderPend = setTimeout(() => { renderPend = 0; render(); }, 0); };
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

  // ---- the commands toolbar: the commands box as buttons ----
  // Position (ue / naka / shita), size (small / medium / big), font (default / gothic / mincho) and colour (a popover:
  // my colour = none given, the profile's; Nico's 10 colours; the premium ones; any #rrggbb) read and write the same
  // commands string as the text box (#chatcmd, behind ⋯ for typing; the same localStorage key), which stays the one
  // source: a click rewrites it, typing redraws the toolbar. Defaults are left out (naka, medium, default font, no
  // colour); commands the toolbar has no button for (ender, full, ...) are kept as typed. A preview shows the colour,
  // size, font and outline.
  const NICO_STD = { white: '#FFFFFF', red: '#FF0000', pink: '#FF8080', orange: '#FFC000', yellow: '#FFFF00', green: '#00FF00',
    cyan: '#00FFFF', blue: '#0000FF', purple: '#C000FF', black: '#000000' };
  const NICO_PREM = { white2: '#CCCC99', red2: '#CC0033', pink2: '#FF33CC', orange2: '#FF6600', yellow2: '#999900', green2: '#00CC66',
    cyan2: '#00CCCC', blue2: '#3399FF', purple2: '#6633CC', black2: '#666666' };
  const NICO_ALIAS = { niconicowhite: '#CCCC99', truered: '#CC0033', passionorange: '#FF6600', madyellow: '#999900',
    elementalgreen: '#00CC66', marinblue: '#3399FF', nobleviolet: '#6633CC' };
  const GROUP = { pos: ['ue', 'shita', 'naka'], size: ['small', 'medium', 'big'], font: ['defont', 'gothic', 'mincho'] };
  const isColor = c => COLOR_RE.test(c) || NICO_COLORS.includes(c);
  // commands -> {pos, size, font, color, rest} (the first of each kind wins, as Nico takes it)
  function cmdParse(t) {
    const st = { pos: '', size: '', font: '', color: '', rest: [] };
    for (const c of nicoCmds(t)) {
      const k = Object.keys(GROUP).find(g => GROUP[g].includes(c));
      if (k) { if (!st[k]) st[k] = c; } else if (isColor(c)) { if (!st.color) st.color = c; } else st.rest.push(c);
    }
    for (const [k, d] of [['pos', 'naka'], ['size', 'medium'], ['font', 'defont']]) if (st[k] === d) st[k] = '';
    return st;
  }
  const cmdJoin = st => [st.pos, st.size, st.font, st.color, ...st.rest].filter(Boolean).join(' ');
  const colorHex = c => !c ? readableHex(prof.color) : COLOR_RE.test(c) ? c : NICO_STD[c] || NICO_PREM[c] || NICO_ALIAS[c] || '#FFFFFF';
  const tool = $('.ctool'), pop = $('.cpop'), colBtn = $('.ccol'), moreBtn = $('.cmore'), prev = $('.cprev'), custom = $('.ccustom');
  function cmdSet(st) {
    cmdIn.value = cmdJoin(st);
    store.set('mbaa-chat-cmd', cmdIn.value);
    toolShow();
  }
  function toolShow() {
    const st = cmdParse(cmdIn.value);
    tool.querySelectorAll('.cseg').forEach(g => g.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === st[g.dataset.k]))));
    const hex = colorHex(st.color);
    colBtn.querySelector('.dot').style.background = hex;
    colBtn.title = `colour: ${st.color || 'my colour'}`;
    pop.querySelector('.mine .dot').style.background = readableHex(prof.color);
    pop.querySelectorAll('[data-c]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.c === st.color)));
    if (COLOR_RE.test(st.color)) custom.value = st.color;
    prev.style.color = hex;
    prev.style.fontSize = { small: '10px', big: '17px' }[st.size] || '13px';
    prev.style.fontFamily = { gothic: 'sans-serif', mincho: 'serif' }[st.font] || '';
    prev.title = `how it looks: ${cmdJoin(st) || 'scroll, medium, my colour'}`;
  }
  tool.querySelectorAll('.cseg').forEach(g => g.querySelectorAll('button').forEach(b => b.onclick = () => {
    const st = cmdParse(cmdIn.value); st[g.dataset.k] = b.dataset.v; cmdSet(st);
  }));
  for (const [row, set] of [['.cstd', NICO_STD], ['.cprem', NICO_PREM]]) for (const [name, hex] of Object.entries(set)) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'sw2'; b.dataset.c = name; b.title = name; b.setAttribute('aria-label', name); b.style.background = hex;
    pop.querySelector(row).append(b);
  }
  function popOpen(on) {
    pop.hidden = !on; colBtn.setAttribute('aria-expanded', String(on));
    if (on) (pop.querySelector('[aria-pressed=true]') || pop.querySelector('.mine')).focus();
  }
  colBtn.onclick = () => popOpen(pop.hidden);
  pop.addEventListener('click', e => {
    const b = e.target.closest('[data-c]');
    if (!b) return;
    const st = cmdParse(cmdIn.value); st.color = b.dataset.c; cmdSet(st); popOpen(false); colBtn.focus();
  });
  custom.oninput = () => { const st = cmdParse(cmdIn.value); st.color = custom.value.toLowerCase(); cmdSet(st); };
  pop.addEventListener('keydown', e => { if (e.key === 'Escape') { popOpen(false); colBtn.focus(); } });
  document.addEventListener('pointerdown', e => { if (!pop.hidden && !pop.contains(e.target) && e.target !== colBtn && !colBtn.contains(e.target)) popOpen(false); });
  moreBtn.onclick = () => {
    const on = !sec.classList.contains('adv');
    sec.classList.toggle('adv', on); moreBtn.setAttribute('aria-expanded', String(on));
    if (on) cmdIn.focus();
  };
  cmdIn.addEventListener('input', toolShow);
  toolHook = toolShow;
  toolShow();
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
    // (a fresh canvas each build: the library takes a WebGL2 context on it, and a second instance on a canvas that already
    // has one swaps in a canvas of its own, which nicoReset would then never remove)
    const cv = document.createElement('canvas');
    if (nico.cv) nico.cv.replaceWith(cv); else over.append(cv);
    nico.cv = cv;
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
  // a comment for niconicomments at time t (vpos units): naka at t + 1 s (the stage's 1 s lead-in: it enters at t),
  // ue / shita at t; the sender's own commands first (Nico takes the first colour given), the profile colour as the default
  function nicoRaw(l, t) {
    const cmds = nicoCmds(l.cmd), fixed = cmds.includes('ue') || cmds.includes('shita');
    const mail = l.color ? [...cmds, readableHex(l.color)] : cmds;
    return { fixed, raw: { id: ++nico.id, vpos: fixed ? t : t + 100, content: l.action ? `${l.nick} ${l.text}` : l.text, mail,
      owner: false, premium: true, date: Math.floor(l.time.getTime() / 1000), user_id: 0, layer: -1, is_my_post: !!l.self } };
  }
  async function danmaku(l) {
    if (!overOn.checked || document.visibilityState === 'hidden') return;
    try { await nicoLoad(); } catch (e) { return; }
    if (!overOn.checked || document.visibilityState === 'hidden') return;
    pin();
    if (!nico.inst) { nico.t0 = performance.now(); nico.list = []; if (!nicoBuild()) return; }
    const { raw, fixed } = nicoRaw(l, vposNow());
    // (gone: naka by its timeline's end, vpos + 300 + 125; fixed after 300)
    const end = raw.vpos + (fixed ? 300 : 425) + 10;
    nico.list.push({ raw, end });
    nico.end = Math.max(nico.end, end);
    if (nico.list.length > 200) nicoBuild(); else nico.inst.addComments(raw);
    if (!nico.raf) nico.raf = requestAnimationFrame(nicoFrame);
  }

  // ---- the match's comment timeline ----
  // Every comment of the watched match's channel (its whole history, fetched on joining; then each new one) gets a
  // STREAM POSITION: [index, frame] of the host's netplay session (CCCaster's IndexedFrame: the same for every viewer,
  // for a re-capture of the session and for a later replay of the recording; a viewer's own frame count is not, each
  // live game boots a new session). Where it comes from:
  //   - our client's comments carry it: +mbaa/at=<index>.<frame>, where the sender's picture was (exact);
  //   - any other (a plain IRC client, KiwiIRC) is placed by its server-time on the capture's clock (GET
  //     <feed>/live/<id>/clock, tools/web/cc_live.mjs clockOf: when each stream frame reached the bridge, whose wall clock
  //     is the droplet's, as Ergo's server-time is): the newest frame received AT_LAG ms before it was sent (the
  //     viewers' feed polls once a second, plus the send), less LIVE_BEHIND frames (a live viewer plays that far behind
  //     the newest frame received: viewer.js LIVE_BEHIND). Approximate (a second or so); unplaced until the clock covers it.
  // The overlay plays the timeline at the picture's own position: local frame = stream frames from the first record fed
  // (viewer.js L.recs; frames: the record's u32 at 240) to the picture's (all fed less viewer_spectate_buffered), vpos =
  // local frame / 60 s. So pausing holds the comments, a seek or a DVR rewind shows the ones made there, a catch-up runs
  // through them (niconicomments draws any vpos: it is a timeline renderer). A comment that arrives while following live
  // from someone whose picture was behind ours is moved up to our position (shown now, as a live comment; kept there).
  const LIVE_BEHIND = 240, AT_LAG = 700, CLOCK_EVERY = 15000;
  const tl = { chan: null, entries: [], clock: null, clockAt: -1e9, clockBusy: false, inst: null, cv: null, size: '',
               recs: null, raf: 0, vpos: -1, placed: 0 };
  const isMatch = name => !!matchChan && key(name) === key(matchChan);
  // the records fed, [[index, frames]] ascending; the picture's local frame; local <-> stream position
  function fedOf(lv) {
    const idx = [];
    for (const [i, b] of lv.recs) idx.push([i, b.length >= 244 ? new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(240, true) : 0]);
    return idx.sort((a, b) => a[0] - b[0]);
  }
  function localOf(idx, pos) {  // null: before the first record fed, or not fed yet
    let n = 0;
    for (let j = 0; j < idx.length; ++j) {
      const [i, c] = idx[j];
      if (i === pos[0]) return j === idx.length - 1 && pos[1] > c ? null : n + Math.min(pos[1], c);
      if (i > pos[0]) return j === 0 ? null : n;
      n += c;
    }
    return null;
  }
  function posOf(idx, f) {
    let n = 0;
    for (const [i, c] of idx) { if (f < n + c) return [i, f - n]; n += c; }
    return idx.length ? [idx[idx.length - 1][0], idx[idx.length - 1][1]] : null;
  }
  function nowOf(lv) {  // {idx, local, pos} of the picture, or null
    if (!lv || !lv.recs || lv.ahead == null) return null;
    const idx = fedOf(lv), total = idx.reduce((n, x) => n + x[1], 0), local = Math.max(0, total - lv.ahead);
    return { idx, local, pos: posOf(idx, local) };
  }
  // a server-time (ms) on the capture's clock: a stream position, or null (not covered: before the capture, or newer
  // than its newest sample)
  function clockPos(c, T) {
    if (!c || c.wall == null || !c.s.length) return null;
    const r = T - c.wall - AT_LAG, s = c.s;
    if (r < s[0][0] - 5000 || r > s[s.length - 1][0] + 1500) return null;
    let lo = 0, hi = s.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (s[m][0] <= r) lo = m; else hi = m - 1; }
    let [t, I, k] = s[lo];
    const nx = s[lo + 1];
    if (r > t && nx && nx[1] === I && nx[0] > t) k = Math.round(k + (nx[2] - k) * Math.min(1, (r - t) / (nx[0] - t)));
    const order = c.idx.map(x => x[0]), count = new Map(c.idx);
    let p = order.indexOf(I), back = LIVE_BEHIND;
    while (back > k && p > 0) { back -= k; I = order[--p]; k = count.get(I) || 0; }
    return [I, Math.max(0, k - back)];
  }
  function tlAdd(l) {
    const e = { l, pos: l.at || null, T: l.time.getTime(), raw: null };
    // live, from a picture behind ours: now (it would otherwise start in our past and never be seen)
    const lv = api.live(), now = !l.hist && lv && lv.follow ? nowOf(lv) : null;
    if (now && e.pos) {
      // (localOf null: before this session's first record (behind) or not fed yet (ahead))
      const f = localOf(now.idx, e.pos);
      const ahead = f == null ? e.pos[0] > now.pos[0] : f >= now.local;
      if (!ahead) e.pos = now.pos;
    } else if (now && !e.pos && !clockPos(tl.clock, e.T)) e.pos = now.pos;  // (untagged and newer than the clock: now)
    tl.entries.push(e);
    tlPlace();
  }
  // position the entries not yet on the overlay (a clock fetch for untagged ones), add the placeable ones
  function tlPlace() {
    const lv = api.live(), now = nowOf(lv);
    if (!now || !overOn.checked || document.visibilityState === 'hidden') return;
    if (tl.recs !== lv.recs) { tlDrop(); tl.recs = lv.recs; }  // (a new live session: local frames start again)
    let need = false;
    for (const e of tl.entries) if (!e.pos) { e.pos = clockPos(tl.clock, e.T); if (!e.pos) need = true; }
    if (need) tlClock(lv);
    const add = [];
    for (const e of tl.entries) {
      if (e.raw || !e.pos) continue;
      const f = localOf(now.idx, e.pos);
      if (f == null) continue;
      e.raw = nicoRaw(e.l, Math.round(f * 100 / 60)).raw;
      add.push(e.raw);
    }
    if (!add.length && tl.inst) return;
    nicoLoad().then(() => {
      if (!tl.inst) tlBuild(); else if (add.length > 50) tlBuild(); else for (const r of add) tl.inst.addComments(r);
      tlKick();
    }, () => {});
  }
  function tlClock(lv) {
    if (tl.clockBusy || performance.now() - tl.clockAt < CLOCK_EVERY) return;
    tl.clockBusy = true; tl.clockAt = performance.now();
    const ch = tl.chan;
    fetch(`${lv.base}/live/${lv.info.id}/clock`, { cache: 'no-store' }).then(r => r.ok ? r.json() : null)
      .then(c => { if (c && tl.chan === ch) { tl.clock = c; tlPlace(); } }, () => {})
      .finally(() => { tl.clockBusy = false; });
  }
  function tlBuild() {
    const w = over.clientWidth, h = over.clientHeight, dpr = Math.min(2, window.devicePixelRatio || 1);
    if (!w || !h || !nico.lib) return false;
    if (tl.inst) try { tl.inst.destroy(); } catch (e) {}
    const cv = document.createElement('canvas');  // (fresh each build, as nicoBuild's)
    if (tl.cv) tl.cv.replaceWith(cv); else over.append(cv);
    tl.cv = cv;
    const cw = h * 16 / 9;
    tl.cv.width = Math.round(cw * dpr); tl.cv.height = Math.round(h * dpr);
    tl.cv.style.width = `${cw}px`; tl.cv.style.left = `${(w - cw) / 2}px`;
    tl.inst = new nico.lib(tl.cv, tl.entries.filter(e => e.raw).map(e => e.raw), { format: 'formatted', mode: 'html5' });
    tl.size = `${w}x${h}@${dpr}`; tl.vpos = -1;
    return true;
  }
  function tlDrop() {
    if (tl.raf) cancelAnimationFrame(tl.raf);
    tl.raf = 0;
    if (tl.inst) try { tl.inst.destroy(); } catch (e) {}
    tl.inst = null; tl.recs = null; tl.vpos = -1;
    for (const e of tl.entries) e.raw = null;
    if (tl.cv) { tl.cv.remove(); tl.cv = null; }
  }
  function tlKick() { if (!tl.raf && tl.inst && overOn.checked) tl.raf = requestAnimationFrame(tlFrame); }
  function tlFrame() {
    tl.raf = 0;
    if (!tl.inst || over.hidden) return;
    const lv = api.live();
    if (!lv || lv.recs !== tl.recs) { tlDrop(); tlPlace(); return; }
    pin();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (`${over.clientWidth}x${over.clientHeight}@${dpr}` !== tl.size && !tlBuild()) return;
    const now = nowOf(lv);
    if (now) {  // (mid-seek: the last picture's comments stay)
      const v = Math.round(now.local * 100 / 60);
      if (v !== tl.vpos) { tl.vpos = v; tl.inst.drawCanvas(v); }
    }
    tl.raf = requestAnimationFrame(tlFrame);
  }
  function tlReset(name) { tlDrop(); tl.entries = []; tl.clock = null; tl.clockAt = -1e9; tl.chan = name; }
  // (each second: pending entries, a session that started meanwhile, the overlay's loop after a hidden spell)
  setInterval(() => { if (matchChan && tl.entries.length) { tlPlace(); tlKick(); } }, 1000);

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
        if (!c.histDone && (irc.caps.has('draft/chathistory') || irc.caps.has('chathistory'))) {
          c.histDone = true;
          // a per-match channel (#m-<match key>): everything, oldest first, for its timeline; else the latest lines
          if (isMatch(c.name) && matchPer) { c.paging = true; irc.send(`CHATHISTORY AFTER ${c.name} timestamp=${HIST_FROM} ${PAGE}`); }
          else irc.send(`CHATHISTORY LATEST ${c.name} * ${HISTORY}`);
        }
        return;
      }
      case 'BATCH': {
        const id = p[0].slice(1);
        if (p[0][0] === '+') { irc.batches.set(id, { type: p[1] || '', target: p[2] || '', n: 0, last: null }); return; }
        const b = irc.batches.get(id);
        irc.batches.delete(id);
        // a match channel's history page: full -> the next one (after its last message)
        if (b && /chathistory/.test(b.type) && b.target) {
          const c = chan(b.target);
          if (c.paging && b.n >= PAGE && b.last) irc.send(`CHATHISTORY AFTER ${c.name} msgid=${b.last} ${PAGE}`);
          else c.paging = false;
        }
        return;
      }
      case '005':  // (CHATHISTORY=<n>: the most lines a request returns)
        for (const t of p) { const m2 = /^CHATHISTORY=(\d+)$/.exec(t); if (m2 && +m2[1] > 0) PAGE = Math.min(PAGE, +m2[1]); }
        return;
      case 'PRIVMSG': case 'NOTICE': {
        const target = p[0], text0 = p[1] || '';
        const bt = m.tags.batch && irc.batches.get(m.tags.batch);
        if (bt) { bt.n++; if (m.tags.msgid) bt.last = m.tags.msgid; }
        if (m.nick === 'HistServ') return;  // (history's join / part events, as messages for clients without event-playback)
        if (target[0] !== '#') { if (m.cmd === 'NOTICE' && !m.nick.includes('.')) return; if (m.cmd === 'NOTICE') sys(clean(text0)); return; }
        let text = text0, action = false;
        if (text.startsWith('\x01')) { if (!text.startsWith('\x01ACTION ')) return; action = true; text = text.slice(8).replace(/\x01$/, ''); }
        const t = m.tags, hist = !!(bt && /chathistory/.test(bt.type));
        const at = /^\d{1,9}\.\d{1,7}$/.test(t['+mbaa/at'] || '') ? t['+mbaa/at'].split('.').map(Number) : null;
        const chara = /^\d{1,2}$/.test(t['+mbaa/chara'] || '') ? +t['+mbaa/chara'] : -1;
        const moon = /^[0-2]$/.test(t['+mbaa/moon'] || '') ? +t['+mbaa/moon'] : -1;
        addLine(target, { nick: m.nick, text: clean(text), action, hist, self: m.nick === irc.nick, msgid: t.msgid,
                          time: t.time ? new Date(t.time) : new Date(), color: COLOR_RE.test(t['+mbaa/color'] || '') ? t['+mbaa/color'] : null,
                          chara: validChara(chara) ? chara : -1, moon, cmd: nicoCmds(t['+mbaa/cmd']).join(' '), at });
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
    // in the match's channel: where our picture is in its stream (the comment's place on the match's timeline)
    const pic = isMatch(shown) ? nowOf(api.live()) : null, at = pic && pic.pos ? pic.pos : null;
    const tags = irc.caps.has('message-tags') ? `@+mbaa/color=${prof.color};+mbaa/chara=${prof.chara};+mbaa/moon=${prof.moon}${cmd ? `;+mbaa/cmd=${cmd.replace(/ /g, '\\s')}` : ''}${at ? `;+mbaa/at=${at[0]}.${at[1]}` : ''} ` : '';
    irc.send(`${tags}PRIVMSG ${shown} :${text}`);
    if (!irc.caps.has('echo-message')) {
      const action = text.startsWith('\x01ACTION ');
      addLine(shown, { nick: irc.nick, text: action ? text.slice(8, -1) : text, action, self: true, time: new Date(),
                       color: prof.color, chara: prof.chara, moon: prof.moon, cmd, at });
    }
  }
  $('.cform').onsubmit = e => { e.preventDefault(); say(input.value); input.value = ''; };

  // the watched live match's channel: joined (and shown) when a match starts, switched when the live view goes on to
  // another match (a new session of the same host, or another host), left once no live match has been shown for
  // LEAVE_MS (the page boots a fresh session for each game: a moment with none is not the match ending)
  const LEAVE_MS = 10000;
  const safe = v => String(v).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60);
  let matchPer = false, noneSince = 0;  // matchPer: the channel is the session's own (its history is the match's)
  setInterval(() => {
    const lv = api.live ? api.live() : null, info = lv && lv.info;
    const id = info ? info.id : api.liveId();
    const want = info && info.match ? `#m-${safe(info.match)}` : id ? `#m-${safe(id)}` : null;
    if (!want && matchChan) { if (!noneSince) noneSince = Date.now(); if (Date.now() - noneSince < LEAVE_MS) return; }
    noneSince = 0;
    if (want === matchChan) return;
    if (matchChan && irc.registered) { irc.send(`PART ${matchChan}`); chan(matchChan).joined = false; }
    if (matchChan) chans.delete(key(matchChan));
    matchChan = want; matchPer = !!(info && info.match);
    tlReset(want);
    if (want) { join(want); shown = want; } else if (shown !== GENERAL) shown = GENERAL;
    tabs(); render();
  }, 1000);

  tabs(); render();
  connect();
  window.mbaaChat = { irc, chans, prof, danmaku, say, nico, tl, clockPos, localOf, posOf, nowOf, feed: raw => on(parse(raw)), show: name => { chan(name); shown = name; tabs(); render(); }, status: () => ({ connected: irc.registered, nick: irc.nick, caps: [...irc.caps], shown, matchChan }) };  // (tests)
})();
