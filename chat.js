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
//
// Signing in and moderation (tools/chat/ergo/ircd.yaml, tools/chat/meltybot.mjs): guests read every channel and its
// history; speaking needs an account (channel mode +M). The account is the user's PovertyCaster community account,
// signed in with Discord through the page's auth endpoint (<page dir>/auth/, the Worker: tools/chat/chat_auth_routes.mjs;
// ?chatAuth= on a local test page): GET <auth>/token -> 200 {token, name, provider} (signed in: a short-lived token,
// fetched again for each connection, sent as SASL PLAIN authcid "token"), 401 {signin, provider} (a guest: "Sign in
// with Discord to chat"), 409 {need: "name", suggest} (no community account yet: the panel asks for a name, POST
// <auth>/create {name}), 403 {denied} (banned), anything else (no sign-in on this server: chat as before). POST
// <auth>/name {name} renames, POST <auth>/logout signs out. Signed in, the nick is the account, "<Name>-<tag>" (Ergo
// force-nick-equals-account; tools/chat/ergo/chat_auth.py), shown as "Name#tag" for a message whose account tag is that
// nick (+mbaa/name carries the exact display name, used when it maps to the nick); colour / character / moon as before.
// Only the bot creates channels: a JOIN refused with 403 (or a channel the bot is not in) sends it "open <channel>" and
// joins again. REDACT (draft/message-redaction: the bot's filter, a mod, or the sender deleting their own line) removes
// the line from the panel, the overlay and the timeline; Ergo deletes it from the history too. Channel operators (the bot,
// mods) and a signed-in sender get a delete button on a line. A guest's nick is checked with the slur filter here too
// (a copy of tools/web/name_filter.mjs's lists, below; the bot renames one that gets through).
(() => {
  'use strict';
  const api = window.mbaaChatApi;
  if (!api || document.getElementById('chatsec')) return;
  const Q = new URLSearchParams(location.search);
  const LOCAL = /^(127\.0\.0\.1|localhost)$/.test(location.hostname);
  const WS_URL = (LOCAL && Q.get('chatUrl')) ||
    location.origin.replace(/^http/, 'ws') + location.pathname.replace(/\/[^/]*$/, '') + '/irc';
  const AUTH_URL = (LOCAL && Q.get('chatAuth')) || location.pathname.replace(/\/[^/]*$/, '') + '/auth';
  const BOT = 'MeltyBot';  // (the moderation bot's nick = its account, meltybot; IRC nicks compare case-insensitively)
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

  // ---- the name filter (a copy of tools/web/name_filter.mjs nameOk: keep the lists in sync; mod_e2e_test.py checks) ----
  const LEET = { '0': 'o', '1': 'i', '!': 'i', '|': 'i', '3': 'e', '4': 'a', '@': 'a', '5': 's', '$': 's', '7': 't', '+': 't', '9': 'g', '6': 'g', '8': 'b' };
  const fold = t => String(t || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[0-9!|@$+]/g, c => LEET[c] || c);
  const pat = w => w.split('').map(c => `${c}+`).join('');
  const SUB = ['nigger', 'nigga', 'niglet', 'negroid', 'faggot', 'fagot', 'retard', 'tranny', 'trannie', 'kike', 'wetback', 'beaner',
    'chingchong', 'shemale', 'hitler', 'siegheil', 'gaschamber', 'killallblacks', 'killalljews', 'pedophile', 'paedophile']
    .map(w => new RegExp(pat(w)));
  const WORD = ['fag', 'fags', 'spic', 'spics', 'chink', 'chinks', 'gook', 'gooks', 'coon', 'coons', 'dyke', 'dykes', 'paki',
    'pakis', 'kys', 'nazi', 'nazis', 'rape', 'raped', 'rapist', 'jigaboo', 'zipperhead'].map(w => new RegExp(`^${pat(w)}$`));
  function nameOk(name) {
    const f = fold(name), letters = f.replace(/[^a-z]/g, '');
    if (SUB.some(r => r.test(letters))) return false;
    return ![letters, ...f.split(/[^a-z]+/)].some(w => w && WORD.some(r => r.test(w)));
  }

  // ---- profile ----
  const NICK_RE = /^[A-Za-z_\[\]\\^{}|`][A-Za-z0-9_\-\[\]\\^{}|`]{0,23}$/;
  const randNick = () => 'viewer' + Math.floor(1000 + Math.random() * 9000);
  const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
  const PRESETS = ['#e04a5a', '#ff9a3c', '#ffd84a', '#7ee05a', '#40c0ff', '#7a8cff', '#c878e6', '#ff7ac8', '#e8e8f0'];
  const prof = Object.assign({ nick: randNick(), color: PRESETS[Math.floor(Math.random() * PRESETS.length)], chara: -1, moon: -1 },
    store.get('mbaa-chat-profile', {}));
  // no default character or moon: each viewer picks their own (-1 = not set: no icon, no tag sent). Profiles saved before
  // this held the old default F-Satsuki without the viewer choosing it; those without the 'picked' mark start unset.
  if (!prof.picked) { if (prof.chara === 17) prof.chara = -1; if (prof.moon === 1) prof.moon = -1; prof.picked = 1; store.set('mbaa-chat-profile', prof); }
  if (!NICK_RE.test(prof.nick) || !nameOk(prof.nick)) prof.nick = randNick();
  if (!COLOR_RE.test(prof.color)) prof.color = PRESETS[0];
  const saveProf = () => store.set('mbaa-chat-profile', prof);
  // the characters with a select-screen icon (no boss versions), in the select screen's order
  const CHARAS = Object.keys(api.chara).map(Number).filter(c => c < 52 && api.iconCell(c) >= 0)
    .sort((a, b) => api.iconCell(a) - api.iconCell(b))
    .filter((c, i, l) => i === 0 || api.iconCell(c) !== api.iconCell(l[i - 1]));
  const validChara = c => Number.isInteger(c) && CHARAS.includes(c);
  if (!validChara(prof.chara)) prof.chara = -1;
  if (![0, 1, 2].includes(prof.moon)) prof.moon = -1;
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
  #chatsec .prow[hidden] { display: none; }
  #chatspread { font-size: 11px; padding: 2px 4px; border-radius: 6px; background: var(--panel); color: inherit; border: 1px solid var(--line); }
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
  /* (the profile opens and closes on its summary: said plainly there, plus a done button and Esc / a click outside) */
  #chatsec details summary::after { content: 'edit profile ▾'; margin-left: auto; font-size: 11px; color: var(--accent2, #8ab4ff);
    border: 1px solid var(--line); border-radius: 999px; padding: 2px 8px; white-space: nowrap; }
  #chatsec details[open] summary::after { content: 'close ✕'; color: #fff; background: var(--accent); border-color: var(--accent); }
  #chatsec details .pdone { justify-content: flex-end; margin-top: 6px; }
  #chatsec details .pdonebtn { background: var(--accent); color: #fff; padding: 4px 16px; border-radius: 999px; }
  #chatsec .me { width: 21px; height: 28px; border-radius: 4px; }
  #chatsec .me.unset { border: 1px dashed var(--line); }
  #chatsec .phint { color: var(--accent2, #8ab4ff); font-size: 12px; }
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
  #chatsec .cauth { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 11px; color: var(--muted); }
  #chatsec .cauth[hidden] { display: none; }
  #chatsec .cauth a.signin { display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; border-radius: 8px; background: #5865f2; color: #fff;
                             text-decoration: none; font-weight: 700; font-size: 12px; }
  #chatsec .cauth button.signout { background: none; border: none; color: var(--faint); text-decoration: underline; cursor: pointer; font: inherit; padding: 0; }
  #chatsec .cform[hidden] { display: none; }
  #chatsec .cauth form.cname { display: flex; gap: 6px; width: 100%; }
  #chatsec .cauth form.cname input { flex: 1 1 auto; min-width: 0; background: var(--raise); color: var(--fg); border: 1px solid var(--line); border-radius: 8px; padding: 4px 8px; font: inherit; }
  #chatsec .cauth .cerr { color: #ff8080; width: 100%; }
  #chatlog li .cdel { margin-left: auto; flex: none; background: none; border: none; color: var(--faint); cursor: pointer; font-size: 12px; line-height: 1;
                      padding: 0 2px; opacity: 0; }
  #chatlog li:hover .cdel, #chatlog li .cdel:focus-visible { opacity: 1; }
  #chatover { position: absolute; left: 0; top: 0; width: 100%; height: 100%; overflow: hidden; pointer-events: none; z-index: 1; }
  #chatover .dmstage { position: absolute; left: 0; top: 0; width: 1920px; height: 1080px; transform-origin: 0 0; contain: strict; }
  #chatover .dm { position: absolute; left: 0; top: 0; white-space: pre; line-height: 1.25; padding: 0 6px 0.12em; will-change: transform;
                  /* (room for descenders and the outline: the composited layer is the box, a line-height: 1 box cut g / j / y) */
                  paint-order: stroke fill; -webkit-text-stroke: 7px rgba(0, 0, 0, .4); }
  `;
  document.head.append(css);

  const sec = document.createElement('div');
  sec.className = 'sec'; sec.id = 'chatsec';
  sec.innerHTML = `
    <div class="chead"><span class="lbl">chat</span><span class="ctabs"></span>
      <label class="tog" title="new comments cross the game picture (Nico Nico style)"><input id="chatover_on" type="checkbox"> on picture</label>
      <select id="chatspread" title="spread: how long a comment keeps its row on the picture, so comments a little apart still fan out to new rows (tight: Niconico's own)" aria-label="comment spread">
        <option value="0">tight</option><option value="1">spread 1 s</option><option value="2">spread 2 s</option><option value="4">spread 4 s</option></select></div>
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
    <div class="cauth" hidden></div>
    <form class="cform" autocomplete="off"><input id="chatcmd" type="text" maxlength="60" spellcheck="false" placeholder="commands"
      title="Niconico commands for your comments on the picture, e.g. ue / shita (top / bottom, 3 s), big / small, a colour (red, pink, orange, yellow, green, cyan, blue, purple, white, black, white2, red2, …, or #rrggbb). Empty: scrolls, medium, your colour."><input id="chatin" type="text" maxlength="${MAXLEN}" placeholder="say something…" enterkeyhint="send">
      <button type="submit" class="txt">send</button></form>
    <details><summary><canvas class="me" width="42" height="56"></canvas><span class="mynick"></span><span class="cstate"></span></summary>
      <div class="prow">nick <input id="chatnick" type="text" maxlength="24" spellcheck="false"></div>
      <div class="prow"><label><input id="chattags" type="checkbox"> show #tags (Name#1234)</label></div>
      <div class="prow">colour <span class="sws"></span><input id="chatcolor" type="color" title="any colour"></div>
      <div class="prow phint" hidden>pick your moon and character (none set yet)</div>
      <div class="prow">moon <span class="moons"></span></div>
      <div class="cgrid"></div>
      <div class="prow pdone"><button type="button" class="txt pdonebtn">done</button></div>
    </details>`;
  // (the page's chat column, beside or under the picture: index.html / viewer.js fitStage; an older page: the panel)
  const controls = document.getElementById('controls'), col = document.getElementById('chatcol');
  const after = document.getElementById('livesec');
  if (col) col.append(sec); else if (after && after.parentNode === controls) after.after(sec); else controls.append(sec);
  const $ = s => sec.querySelector(s);
  {  // the profile panel: a done button, Esc and a click outside it close it
    const d = sec.querySelector('details');
    sec.querySelector('.pdonebtn').onclick = () => { d.open = false; };
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && d.open) d.open = false; });
    document.addEventListener('pointerdown', e => { if (d.open && !d.contains(e.target)) d.open = false; });
  }
  const logEl = $('#chatlog'), tabsEl = $('.ctabs'), input = $('#chatin'), cmdIn = $('#chatcmd'), stateEl = $('.cstate');
  // the newest line stays in view when the log's box changes size (the on-screen keyboard, a rotation, the layout)
  let logStick = true;
  logEl.addEventListener('scroll', () => { logStick = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 30; }, { passive: true });
  if (window.ResizeObserver) new ResizeObserver(() => { if (logStick) logEl.scrollTop = logEl.scrollHeight; }).observe(logEl);
  cmdIn.value = String(store.get('mbaa-chat-cmd', '')).slice(0, 60);  // (kept, as Nico's command box is)
  cmdIn.onchange = () => store.set('mbaa-chat-cmd', cmdIn.value.trim());
  // Signed-in names are "Name#1234" (the community account's tag keeps them unique); shown without the #tag unless the
  // viewer turns tags on (kept); the full name stays in the tooltip.
  let showTags = !!store.get('mbaa-chat-tags', false);
  const disp = n => showTags ? String(n) : String(n).replace(/#\d{4}$/, '');
  $('#chattags').checked = showTags;
  $('#chattags').onchange = e => {
    showTags = e.target.checked; store.set('mbaa-chat-tags', showTags);
    for (const el of sec.querySelectorAll('.cnick[data-full]')) el.textContent = (el.dataset.act ? '* ' : '') + disp(el.dataset.full);
    authShow();
  };
  let toolHook = () => {};  // (the commands toolbar's redraw, set once its section has run: the profile colour shows on it)

  const over = document.createElement('div');
  over.id = 'chatover';
  const stage = document.querySelector('.stage');
  stage.insertBefore(over, document.getElementById('banner0') || null);
  // spread (#chatspread, remembered): a comment keeps its row for this many seconds more after it would have freed it, so
  // slow chat still fans out down the picture instead of every line taking the top row (dmPlace)
  const spreadSel = $('#chatspread');
  spreadSel.value = String(store.get('mbaa-nico-spread', 1));
  if (!spreadSel.value) spreadSel.value = '1';
  const spreadOf = () => +spreadSel.value || 0;
  spreadSel.onchange = () => { store.set('mbaa-nico-spread', +spreadSel.value); tlRelayout(); spreadSel.blur(); };
  const overOn = $('#chatover_on');
  overOn.checked = store.get('mbaa-chat-over', true);
  over.hidden = !overOn.checked;
  overOn.onchange = () => {
    store.set('mbaa-chat-over', overOn.checked); over.hidden = !overOn.checked;
    if (!overOn.checked) { dmClear(nico); tlDrop(); } else tlKick();
    overOn.blur();
  };

  // profile editor
  function profShow() {
    drawIcon($('.me'), prof.chara, prof.moon);
    $('.me').classList.toggle('unset', !validChara(prof.chara));
    $('.phint').hidden = validChara(prof.chara) && prof.moon >= 0;
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
    if (irc.account) { e.target.value = disp(shownNick(irc.account, irc.account, auth.name)); sys('signed in: your name is your account (change it with "change name")'); return; }
    if (!NICK_RE.test(n)) { e.target.value = prof.nick; sys('nick: letters, digits, _ - [ ] { } | ^ ` (not starting with a digit or -), up to 24'); return; }
    if (!nameOk(n)) { e.target.value = prof.nick; sys('that nick is not allowed'); return; }
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
    if (!c) chans.set(key(name), c = { name, lines: [], names: new Set(), ops: new Set(), joined: false, histDone: false, seen: new Set(),
                                       tries: 0, retryAt: 0 });
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
    // (no character picked: no icon at all, rather than an empty square)
    if (validChara(l.chara)) li.append(iconCanvas('cico', 48, l.chara, l.moon));
    const body = document.createElement('span');
    const tm = document.createElement('span'); tm.className = 'ctime';
    tm.textContent = l.time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const nk = document.createElement('span'); nk.className = 'cnick'; nk.style.color = readable(l.color);
    nk.textContent = l.action ? `* ${disp(l.nick)}` : disp(l.nick);
    nk.dataset.full = l.nick; nk.title = l.nick; if (l.action) nk.dataset.act = '1';
    body.append(tm, nk, document.createTextNode(l.text));
    li.append(body);
    if (l.msgid) {
      li.dataset.msgid = l.msgid;
      // (channel operators: any line; a signed-in sender: their own; Ergo checks either way)
      const c = l.chan && chans.get(key(l.chan));
      if (c && (c.ops.has(key(irc.nick)) || (l.self && irc.account))) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'cdel'; b.textContent = '×'; b.title = 'delete this message'; b.setAttribute('aria-label', 'delete this message');
        b.onclick = () => { irc.send(`REDACT ${c.name} ${l.msgid}`); b.disabled = true; };
        li.append(b);
      }
    }
    return li;
  }
  function render() {
    const c = chan(shown);
    logEl.replaceChildren(...c.lines.map(lineEl));
    logEl.scrollTop = logEl.scrollHeight;
  }
  function addLine(name, l) {
    const c = chan(name);
    l.chan = c.name;
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
    // (a match channel's comments: on its timeline, tlAdd above, while watching back (DVR); following live, as they
    // arrive, as #melty's: on the wall clock, so they keep crossing through the result screen, a character select and
    // the switch to the next game, where the stream position stops or starts again)
    if (!l.hist && !l.sys && (!isMatch(name) || following())) danmaku(l);
  }
  let renderPend = 0;  // (a match's whole history arrives line by line: one redraw for the lot)
  const renderSoon = () => { if (!renderPend) renderPend = setTimeout(() => { renderPend = 0; render(); }, 0); };
  const sys = (text, name) => addLine(name || shown, { sys: true, text, time: new Date() });
  // a deleted message (REDACT): out of the panel, the overlay and the timeline (its msgid stays seen: history won't bring
  // it back, and Ergo has deleted it from the history anyway)
  function unsay(name, msgid) {
    const c = chans.get(key(name));
    if (!c || !msgid) return;
    c.seen.add(msgid);
    const i = c.lines.findIndex(l => l.msgid === msgid);
    if (i >= 0) { c.lines[i].gone = true; c.lines.splice(i, 1); }
    if (key(name) === key(shown)) { const li = logEl.querySelector(`li[data-msgid="${CSS.escape(msgid)}"]`); if (li) li.remove(); }
    for (const c of nico.list.filter(x => x.msgid === msgid)) dmRemove(nico, c);
    const e = tl.entries.find(x => x.l.msgid === msgid);
    if (e) { tl.entries = tl.entries.filter(x => x !== e); if (e.c) tlRelayout(); }
  }

  // ---- the overlay: Niconico's own comment layout ----
  // Drawn by niconicomments 0.4.1 (MIT, xpadev-net; vendor/niconicomments-0.4.1.js, self-hosted, loaded on the first
  // comment), a reimplementation of the official nicovideo HTML5 player's renderer: its 1920x1080 stage (font sizes
  // from the 384-line Flash stage: small / medium / big), naka comments crossing commentDrawRange + width in 4 s after
  // a 1 s lead-in (so longer comments move faster), the official collision (a row is taken while any earlier comment
  // overlaps this one in time-x at the stage's left / right collision lines; the lowest free row, else a random y),
  // ue / shita fixed 3 s, black outline, Nico's colour names. Our picture is 4:3: the canvas is the 16:9 stage at the
  // picture's height, centred, so the picture shows the stage's 4:3 middle (240..1680, the same area a 4:3 video fills
  // in the official 16:9 player; comments enter at its right edge).
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
  // ---- the overlay's renderer (danmaku) ----
  // Our own Niconico (html5) renderer, built so the overlay costs the game nothing: each comment is one DOM element whose
  // text is rasterised once, when it appears, and moved by the compositor (a Web Animations transform: no script, canvas
  // clear or second GL context per frame; niconicomments, used before, redrew a full-stage WebGL canvas from script every
  // frame and made each comment's text image on the main thread, which cost the game frames).
  // Geometry is Niconico's 1920 x 1080 stage (niconicomments' html5 config): a 16:9 box over the picture, scaled to it.
  // A naka comment enters at x 1725 (draw padding 195 + range 1530) and moves (1530 + 0.95 w) units per 4 s; ue / shita
  // stay 3 s, centred (shrunk to fit 1530, or 1920 with "full"). Sizes: html5 font 18 / 27 / 39 on the 384-high stage
  // (x 1920/683), rows of 1080 / 21, 13.1, 8.4 lines. Outline: black at 0.4 (white for black text).
  // Rows (dmPlace): Niconico's rule, the topmost row where the comment meets no other on screen with it; none free: a
  // row picked at random (seeded by the comment, so a relayout gives the same). spread: a comment holds its row that many
  // seconds longer. Placement depends only on the comments and their times, so the timeline lays out the same after a seek.
  const DM_SIZE = { small: [51, 51], medium: [76, 82], big: [110, 129] };  // [font px, row height], stage units
  const DM_FONT = { defont: [600, 'Arial, "MS PGothic", "Hiragino Kaku Gothic ProN", "Noto Sans CJK JP", sans-serif'],
    gothic: [400, '"MS PGothic", "Hiragino Kaku Gothic ProN", "Noto Sans CJK JP", sans-serif'],
    mincho: [400, '"MS PMincho", "Hiragino Mincho ProN", "Noto Serif CJK JP", serif'] };
  const DM_COLOR = { white: '#FFFFFF', red: '#FF0000', pink: '#FF8080', orange: '#FFC000', yellow: '#FFFF00', green: '#00FF00',
    cyan: '#00FFFF', blue: '#0000FF', purple: '#C000FF', black: '#000000', white2: '#CCCC99', niconicowhite: '#CCCC99',
    red2: '#CC0033', truered: '#CC0033', pink2: '#FF33CC', orange2: '#FF6600', passionorange: '#FF6600', yellow2: '#999900',
    madyellow: '#999900', green2: '#00CC66', elementalgreen: '#00CC66', cyan2: '#00CCCC', blue2: '#3399FF', marinblue: '#3399FF',
    purple2: '#6633CC', nobleviolet: '#6633CC', black2: '#666666' };
  // On the picture a comment is at most Niconico's own 75 characters (the chat keeps the whole line)
  const NICO_MAX = 75, NICO_ON_SCREEN = 60;
  const nicoClip = t => { const a = Array.from(t); return a.length > NICO_MAX ? a.slice(0, NICO_MAX - 1).join('') + '…' : t; };
  const measure = document.createElement('canvas').getContext('2d');
  // a comment's look and timing; t: when it enters, in seconds on its stage's clock
  function dmMake(l, t) {
    const cmds = nicoCmds(l.cmd);
    const loc = cmds.find(c => c === 'ue' || c === 'shita') || 'naka';
    const size = cmds.find(c => DM_SIZE[c]) || 'medium', font = cmds.find(c => DM_FONT[c]) || 'defont';
    // (Niconico takes the first colour given; none: the sender's profile colour)
    const col = cmds.map(c => DM_COLOR[c] || (COLOR_RE.test(c) ? c : null)).find(Boolean) || (l.color ? readableHex(l.color) : '#FFFFFF');
    const text = nicoClip(l.action ? `${disp(l.nick)} ${l.text}` : l.text);
    const [px, row] = DM_SIZE[size], [wt, fam] = DM_FONT[font], css = `${wt} ${px}px ${fam}`;
    measure.font = css;
    const w = Math.ceil(measure.measureText(text).width) + 8;  // (+ the outline)
    let seed = 0; for (const ch of (l.msgid || text) + t) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
    const c = { msgid: l.msgid, text, loc, css, col, w, h: row, t, y: 0, scale: 1, seed, el: null, anim: null };
    if (loc === 'naka') { c.v = (1530 + 0.95 * w) / 4; c.life = (1725 + w) / c.v; }
    else { c.life = 3; const max = cmds.includes('full') ? 1920 : 1530; if (w > max) c.scale = max / w; }
    return c;
  }
  const dmX = (c, dt) => c.loc === 'naka' ? 1725 - c.v * dt : (1920 - c.w * c.scale) / 2;
  // do a (placed earlier) and c meet on screen in the same row band? (a holds its row spread s longer)
  function dmMeet(a, c, spread) {
    if (a.loc !== c.loc) return false;
    const s0 = Math.max(a.t, c.t), s1 = Math.min(a.t + a.life + spread, c.t + c.life);
    if (s0 >= s1) return false;
    if (c.loc !== 'naka') return true;
    const pad = 5 + spread * a.v;
    const rel = T => dmX(c, T - c.t) - dmX(a, T - a.t);
    const r0 = rel(s0), r1 = rel(s1);
    return Math.min(r0, r1) <= a.w + pad && Math.max(r0, r1) >= -(c.w + 5);
  }
  function dmPlace(placed, c, spread) {
    const near = placed.filter(a => dmMeet(a, c, spread));
    const up = c.loc !== 'shita';
    let y = up ? 0 : 1080 - c.h, moved = true, n = 0;
    while (moved && n++ < 200) {
      moved = false;
      for (const a of near) if (y < a.y + a.h && a.y < y + c.h) { y = up ? a.y + a.h : a.y - c.h; moved = true; }
    }
    if (y < 0 || y + c.h > 1080) y = Math.floor((c.seed % 1000) / 1000 * Math.max(0, 1080 - c.h));  // (full: a random row)
    c.y = y;
  }
  // a stage: a 16:9 box of 1920 x 1080 units over the picture
  function dmStage(cls) {
    const box = document.createElement('div'); box.className = `dmstage ${cls}`;
    over.append(box);
    return { box, list: [] };
  }
  function dmFit(st) {
    const w = over.clientWidth, h = over.clientHeight;
    if (!w || !h) return false;
    const k = h / 1080, key = `${w}x${h}`;
    if (st.fit !== key) { st.fit = key; st.box.style.transform = `translate(${((w - h * 16 / 9) / 2).toFixed(2)}px, 0) scale(${k.toFixed(5)})`; }
    return true;
  }
  function dmEl(st, c) {
    const e = document.createElement('div');
    e.className = 'dm'; e.textContent = c.text;
    e.style.font = c.css; e.style.color = c.col;
    if (c.col.toUpperCase() === '#000000') e.style.webkitTextStrokeColor = 'rgba(255,255,255,.4)';
    st.box.append(e);
    return c.el = e;
  }
  const dmXf = (c, dt) => `translate(${dmX(c, dt).toFixed(1)}px, ${c.y}px)${c.scale !== 1 ? ` scale(${c.scale.toFixed(4)})` : ''}`;
  function dmRemove(st, c) {
    if (c.anim) { c.anim.cancel(); c.anim = null; }
    if (c.el) { c.el.remove(); c.el = null; }
    const i = st.list.indexOf(c); if (i >= 0) st.list.splice(i, 1);
  }
  function dmClear(st) { for (const c of [...st.list]) dmRemove(st, c); }

  // Live comments (nico): on the wall clock, each entering as it arrives; the compositor runs it to the end
  const nico = dmStage('dmlive');
  const wallNow = () => performance.now() / 1000;
  function danmaku(l) {
    if (!overOn.checked || document.visibilityState === 'hidden' || l.gone) return;
    pin();
    if (!dmFit(nico)) return;
    const now = wallNow(), spread = spreadOf();
    for (const a of [...nico.list]) if (a.t + a.life + spread < now) dmRemove(nico, a);
    // (a crowded picture: past NICO_ON_SCREEN at once a new comment stays in the chat only)
    if (nico.list.filter(a => a.t + a.life > now).length >= NICO_ON_SCREEN) return;
    const c = dmMake(l, now);
    dmPlace(nico.list, c, spread);
    nico.list.push(c);
    const e = dmEl(nico, c);
    c.anim = e.animate([{ transform: dmXf(c, 0) }, { transform: dmXf(c, c.life) }], { duration: c.life * 1000, easing: 'linear', fill: 'both' });
    c.anim.onfinish = () => { if (c.el) { c.el.remove(); c.el = null; } c.anim = null; };
  }
  // the overlay follows the picture's box (pin) on any layout change, not per frame
  { const ro = new ResizeObserver(() => { pin(); dmFit(nico); if (tl.st) dmFit(tl.st); tl.T = -1; tlKick(); });
    ro.observe(over); ro.observe(stage);
    document.addEventListener('fullscreenchange', () => { pin(); dmFit(nico); }); }

  // exactly over the picture (as viewer.js pins #overlay: in fullscreen the picture is not where a centred box would be)
  function pin() {
    const gameCv = document.getElementById('canvas');  // (looked up each time: viewer.js replaces it on a GL context change)
    if (!gameCv) return;
    const L = `${gameCv.offsetLeft}px`, T = `${gameCv.offsetTop}px`, W = `${gameCv.offsetWidth}px`, H = `${gameCv.offsetHeight}px`;
    const st = over.style;
    if (st.left !== L || st.top !== T || st.width !== W || st.height !== H) Object.assign(st, { left: L, top: T, width: W, height: H });
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
  // through them (each comment is placed at its time and drawn wherever the picture's time puts it). A comment that arrives while following live
  // from someone whose picture was behind ours is moved up to our position (shown now, as a live comment; kept there).
  const LIVE_BEHIND = 240, AT_LAG = 700, CLOCK_EVERY = 15000;
  const tl = { chan: null, entries: [], clock: null, clockAt: -1e9, clockBusy: false, st: null, recs: null, raf: 0, T: -1 };
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
    let add = false;
    for (const e of tl.entries) {
      if (e.c || !e.pos) continue;
      const f = localOf(now.idx, e.pos);
      if (f == null) continue;
      e.c = dmMake(e.l, f / 60);
      add = true;
    }
    if (add) { tlRelayout(); tlKick(); }
  }
  // every placed comment laid out again in time order (cheap arithmetic: a new one may come before others, history
  // arrives out of order), so the layout is the same whenever it is built
  function tlRelayout() {
    if (!tl.st) tl.st = dmStage('dmtl');
    const cs = tl.entries.filter(e => e.c).map(e => e.c).sort((a, b) => a.t - b.t), spread = spreadOf(), done = [];
    for (const c of cs) { dmPlace(done.filter(a => a.t + a.life + spread > c.t), c, spread); done.push(c); }
    for (const c of tl.st.list) if (!cs.includes(c) && c.el) { c.el.remove(); c.el = null; }
    tl.st.list = cs; tl.T = -1;
  }
  function tlClock(lv) {
    if (tl.clockBusy || performance.now() - tl.clockAt < CLOCK_EVERY) return;
    tl.clockBusy = true; tl.clockAt = performance.now();
    const ch = tl.chan;
    fetch(`${lv.base}/live/${lv.info.id}/clock`, { cache: 'no-store' }).then(r => r.ok ? r.json() : null)
      .then(c => { if (c && tl.chan === ch) { tl.clock = c; tlPlace(); } }, () => {})
      .finally(() => { tl.clockBusy = false; });
  }
  function tlDrop() {
    if (tl.raf) cancelAnimationFrame(tl.raf);
    tl.raf = 0; tl.recs = null; tl.T = -1;
    if (tl.st) { dmClear(tl.st); tl.st.box.remove(); tl.st = null; }
    for (const e of tl.entries) e.c = null;
  }
  function following() { const lv = api.live(); return !!(lv && lv.follow); }
  function tlKick() { if (!tl.raf && tl.st && overOn.checked) tl.raf = requestAnimationFrame(tlFrame); }
  // (watching back only: the comments on screen at the picture's time, moved by transform, which the compositor applies;
  // following live they run on the wall clock (danmaku) and this does nothing but wait)
  function tlFrame() {
    tl.raf = 0;
    if (!tl.st || over.hidden) return;
    const lv = api.live();
    if (!lv || lv.recs !== tl.recs) { tlDrop(); tlPlace(); return; }
    tl.st.box.style.visibility = lv.follow ? 'hidden' : '';
    if (!lv.follow) {
      const now = nowOf(lv);
      if (now && dmFit(tl.st)) {  // (mid-seek: the last picture's comments stay)
        const T = now.local / 60;
        if (T !== tl.T) {
          tl.T = T;
          for (const c of tl.st.list) {
            const dt = T - c.t;
            if (dt >= 0 && dt < c.life) { (c.el || dmEl(tl.st, c)).style.transform = dmXf(c, dt); }
            else if (c.el) { c.el.remove(); c.el = null; }
          }
        }
      }
    }
    tl.raf = requestAnimationFrame(tlFrame);
  }
  function tlReset(name) { tlDrop(); tl.entries = []; tl.clock = null; tl.clockAt = -1e9; tl.chan = name; }
  // (each second: pending entries, a session that started meanwhile, the overlay's loop after a hidden spell)
  setInterval(() => { if (matchChan && tl.entries.length) { tlPlace(); tlKick(); } }, 1000);

  // ---- IRC ----
  const irc = { ws: null, registered: false, nick: prof.nick, caps: new Set(), batches: new Map(), retry: 0, lastSend: 0, account: null };
  const WANT = ['message-tags', 'server-time', 'echo-message', 'batch', 'draft/chathistory', 'chathistory', 'draft/message-redaction',
    'multi-prefix', 'sasl', 'account-tag'];
  // a signed-in sender's name: "<Name>-0042" (+ a letter on a clash) -> "Name#0042"; +mbaa/name's exact display name
  // when it maps to that nick (chat_auth.py safe())
  // (as the auth-script's safe(): ASCII letters, digits, _ and accented Latin letters; anything else _)
  const safeName = n => String(n).normalize('NFC').replace(/[^A-Za-z0-9_\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F]/g, '_').replace(/^_+|_+$/g, '').slice(0, 19) || 'user';
  function shownNick(nick, account, tagName) {
    const mm = account && key(account) === key(nick) ? /^(.+)-(\d{4})[a-z]?$/.exec(nick) : null;
    if (!mm) return nick;
    const t = /^(.{1,64})#(\d{4})$/.exec(tagName || '');
    return t && t[2] === mm[2] && key(safeName(t[1])) === key(mm[1]) ? tagName : `${mm[1]}#${mm[2]}`;
  }

  // ---- signing in (the auth endpoint: see the top) ----
  const auth = { state: 'unknown', token: null, name: null, provider: null, signin: null, suggest: '', err: '' };
  const authEl = $('.cauth'), formEl = $('.cform');
  async function authFetch() {
    try {
      const r = await fetch(`${AUTH_URL}/token`, { cache: 'no-store', credentials: 'same-origin' });
      const j = [200, 401, 403, 409].includes(r.status) ? await r.json().catch(() => ({})) : null;
      if (r.status === 200 && j && j.token) Object.assign(auth, { state: 'signed', token: j.token, name: j.name || null, provider: j.provider || null });
      else if (r.status === 401 && j && j.signin) Object.assign(auth, { state: 'guest', token: null, signin: j.signin, provider: j.provider || null });
      else if (r.status === 409 && j && j.need === 'name') Object.assign(auth, { state: 'name', token: null, suggest: j.suggest || '' });
      else if (r.status === 403 && j && j.denied) Object.assign(auth, { state: 'denied', token: null });
      else Object.assign(auth, { state: 'none', token: null });
    } catch (e) { Object.assign(auth, { state: 'none', token: null }); }
    authShow();
  }
  function authShow() {
    authEl.replaceChildren();
    const signedIn = !!irc.account;
    if (signedIn) {
      const t = document.createElement('span');
      t.textContent = `signed in as ${disp(shownNick(irc.account, irc.account, auth.name))}${auth.provider ? ` (with ${auth.provider})` : ''}`;
      const b = document.createElement('button'); b.type = 'button'; b.className = 'signout'; b.textContent = 'sign out';
      b.onclick = async () => {
        try { await fetch(`${AUTH_URL}/logout`, { method: 'POST', credentials: 'same-origin' }); } catch (e) {}
        Object.assign(auth, { state: 'unknown', token: null });
        if (irc.ws) irc.ws.close();  // (reconnects as a guest)
      };
      authEl.append(t, b);
      const rn = document.createElement('button'); rn.type = 'button'; rn.className = 'signout'; rn.textContent = 'change name';
      rn.onclick = () => { auth.renaming = true; authShow(); };
      authEl.append(rn);
      if (auth.renaming) nameForm('name', irc.account.replace(/-\d{4}[a-z]?$/, ''), 'rename');
    } else if (auth.state === 'name') {
      const t = document.createElement('span'); t.textContent = 'Pick your name (your PovertyCaster account, the same one the launcher uses):';
      authEl.append(t);
      nameForm('create', auth.suggest, 'create account');
    } else if (auth.state === 'denied') {
      const t = document.createElement('span'); t.textContent = 'This account may not chat.'; authEl.append(t);
    } else if (auth.state === 'guest' || (auth.state === 'signed' && irc.registered)) {
      const a = document.createElement('a'); a.className = 'signin';
      const ret = location.pathname + location.search;
      a.href = auth.signin ? auth.signin + (auth.signin.includes('?') ? '&' : '?') + 'return=' + encodeURIComponent(ret) : '#';
      a.textContent = `Sign in${auth.provider ? ` with ${auth.provider}` : ''} to chat`;
      authEl.append(a);
      const n = document.createElement('span'); n.textContent = 'guests can read'; authEl.append(n);
    }
    if (auth.err) { const e = document.createElement('span'); e.className = 'cerr'; e.textContent = auth.err; authEl.append(e); }
    authEl.hidden = !authEl.childElementCount;
    // a guest on a server with sign-in: no input (channels are +M); without sign-in (auth 'none'): as before
    formEl.hidden = !signedIn && auth.state !== 'none' && auth.state !== 'unknown';
    $('#chatnick').disabled = signedIn;
    // (signed in, the name is the account: "change name" above renames it; a guest on a sign-in server cannot speak)
    $('#chatnick').closest('.prow').hidden = signedIn || formEl.hidden;
    if (signedIn) {  // (the nick box shows the name, not the IRC nick "Name-1234"; renaming is "change name")
      const full = shownNick(irc.account, irc.account, auth.name);
      $('.mynick').textContent = disp(full); $('.mynick').title = full; $('#chatnick').value = disp(full);
    }
  }
  // a name box: create the community account (POST <auth>/create) or rename it (<auth>/name); then a fresh connection
  function nameForm(what, value, label) {
    const f = document.createElement('form'); f.className = 'cname';
    const i = document.createElement('input'); i.type = 'text'; i.maxLength = 32; i.value = value || ''; i.placeholder = 'name'; i.spellcheck = false;
    const b = document.createElement('button'); b.type = 'submit'; b.className = 'txt'; b.textContent = label;
    f.append(i, b);
    f.onsubmit = async e => {
      e.preventDefault();
      const name = i.value.trim();
      if (!name) return;
      if (!nameOk(name)) { auth.err = 'that name is not allowed'; authShow(); return; }
      b.disabled = true;
      let r = null, j = {};
      try { r = await fetch(`${AUTH_URL}/${what}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }); j = await r.json().catch(() => ({})); } catch (e2) {}
      if (!r || r.status !== 200) {
        auth.err = { bad_name: 'that name is not allowed (letters, digits, a few symbols; not too long)', name_taken: 'that name is taken' }[j.error] || (j.detail || j.error || 'could not save the name');
        authShow(); return;
      }
      auth.err = ''; auth.renaming = false;
      if (irc.ws) irc.ws.close(); else start();  // (reconnects signed in, with the new name)
    };
    authEl.append(f);
  }
  // the bot opens a channel we may not create (403) or is not in yet; we join again shortly
  function askOpen(c) {
    const now = Date.now();
    if (now < c.retryAt) return;
    c.retryAt = now + Math.min(15000, 1500 * 2 ** Math.min(c.tries++, 4));
    irc.send(`PRIVMSG ${BOT} :open ${c.name}`);
    setTimeout(() => { if (!c.joined && irc.registered) irc.send(`JOIN ${c.name}`); }, 1200);
  }
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
      irc.account = null;
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
      irc.account = null; authShow();
      tabs(); state('offline, retrying'); later();
    };
    ws.onerror = () => {};
  }
  function later() { const d = Math.min(30000, 1500 * 2 ** irc.retry++); setTimeout(start, d + Math.random() * 1000); }
  // each connection: a fresh sign-in token first (short-lived), then the socket
  async function start() { await authFetch(); connect(); }
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
        } else if (sub === 'ACK') {
          for (const c of (p[2] || '').split(' ')) if (c) irc.caps.add(c);
          if (irc.caps.has('sasl') && auth.token) irc.send('AUTHENTICATE PLAIN'); else irc.send('CAP END');
        }
        else if (sub === 'NAK') irc.send('CAP END');
        return;
      }
      case 'AUTHENTICATE':
        if (p[0] === '+' && auth.token) {
          const b = btoa(String.fromCharCode(...new TextEncoder().encode(`\0token\0${auth.token}`)));
          for (let i = 0; i < b.length; i += 400) irc.send(`AUTHENTICATE ${b.slice(i, i + 400)}`);
          if (b.length % 400 === 0) irc.send('AUTHENTICATE +');
        }
        return;
      case '900': irc.account = p[2] || null; return;  // (logged in as <account>)
      case '903': irc.send('CAP END'); return;
      case '902': case '904': case '905': case '906': case '908':
        if (m.cmd !== '908') { sys('sign-in failed: chatting as a guest (reload to try again)'); auth.token = null; irc.send('CAP END'); }
        return;
      case '001':
        irc.registered = true; irc.retry = 0; irc.nick = p[0];
        if (irc.nick !== prof.nick) sys(`connected as ${irc.nick}`);
        state(''); authShow();
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
        if (m.nick === irc.nick) { c.joined = true; c.tries = 0; c.retryAt = 0; c.ops.clear(); }
        c.names.add(m.nick); tabs();
        return;
      }
      case 'PART': { const c = chan(p[0]); c.names.delete(m.nick); c.ops.delete(key(m.nick)); if (m.nick === irc.nick) { c.joined = false; c.names.clear(); } tabs(); return; }
      case 'KICK': { const c = chan(p[0]); c.names.delete(p[1]); if (p[1] === irc.nick) { c.joined = false; c.names.clear(); sys(`kicked from ${p[0]}`, p[0]); } tabs(); return; }
      case 'QUIT': for (const c of chans.values()) c.names.delete(m.nick); tabs(); return;
      case '353': {
        const c = chan(p[2]);
        for (const n of (p[3] || '').split(' ')) {
          if (!n) continue;
          const pre = n.match(/^[~&@%+]*/)[0], nk = n.slice(pre.length).split('!')[0];
          c.names.add(nk);
          if (/[~&@%]/.test(pre)) c.ops.add(key(nk)); else c.ops.delete(key(nk));
        }
        return;
      }
      case 'MODE': {  // (operator status: who gets delete buttons)
        const c = p[0][0] === '#' ? chans.get(key(p[0])) : null;
        if (!c) return;
        let add = true, ai = 2, mine = false;
        for (const ch of p[1] || '') {
          if (ch === '+' || ch === '-') { add = ch === '+'; continue; }
          if ('qaohv'.includes(ch)) {
            const nk = p[ai++] || '';
            if ('qaoh'.includes(ch)) { if (add) c.ops.add(key(nk)); else c.ops.delete(key(nk)); if (key(nk) === key(irc.nick)) mine = true; }
          } else if ('beIkf'.includes(ch) || (ch === 'l' && add)) ai++;
        }
        if (mine && key(c.name) === key(shown)) render();
        return;
      }
      case 'REDACT': unsay(p[0], p[1]); return;
      case '403': {  // (only the bot creates channels: ask it to open ours)
        const c = chans.get(key(p[1] || ''));
        if (c && !c.joined && (key(c.name) === key(GENERAL) || isMatch(c.name))) askOpen(c);
        else sys(clean(p[p.length - 1] || 'no such channel'));
        return;
      }
      case '366': {
        const c = chan(p[1]); tabs();
        if (!c.names.has(BOT) && ![...c.names].some(n => key(n) === key(BOT))) { c.retryAt = 0; irc.send(`PRIVMSG ${BOT} :open ${c.name}`); }
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
      case 'TAGMSG': {  // (the bot's live-server notice, +mbaa/notice: shown to who is here now; Ergo keeps no TAGMSG history)
        const nt = m.tags['+mbaa/notice'];
        if (nt && key(m.nick) === key(BOT) && p[0] && p[0][0] === '#') sys(clean(nt).slice(0, 200), p[0]);
        return;
      }
      case 'PRIVMSG': case 'NOTICE': {
        const target = p[0], text0 = p[1] || '';
        const bt = m.tags.batch && irc.batches.get(m.tags.batch);
        if (bt) { bt.n++; if (m.tags.msgid) bt.last = m.tags.msgid; }
        if (m.nick === 'HistServ') return;  // (history's join / part events, as messages for clients without event-playback)
        if (target[0] !== '#') {
          if (key(m.nick) === key(BOT)) {  // (the bot: "opened #chan" -> join it now; anything else is for us to read)
            const o = /^opened (#\S+)$/.exec(text0);
            if (o) { const c = chans.get(key(o[1])); if (c && !c.joined) irc.send(`JOIN ${c.name}`); return; }
            if (m.cmd === 'NOTICE') sys(clean(text0));
            return;
          }
          if (m.cmd === 'NOTICE' && !m.nick.includes('.')) return; if (m.cmd === 'NOTICE') sys(clean(text0)); return;
        }
        let text = text0, action = false;
        if (text.startsWith('\x01')) { if (!text.startsWith('\x01ACTION ')) return; action = true; text = text.slice(8).replace(/\x01$/, ''); }
        const t = m.tags, hist = !!(bt && /chathistory/.test(bt.type));
        const at = /^\d{1,9}\.\d{1,7}$/.test(t['+mbaa/at'] || '') ? t['+mbaa/at'].split('.').map(Number) : null;
        const chara = /^\d{1,2}$/.test(t['+mbaa/chara'] || '') ? +t['+mbaa/chara'] : -1;
        const moon = /^[0-2]$/.test(t['+mbaa/moon'] || '') ? +t['+mbaa/moon'] : -1;
        addLine(target, { nick: shownNick(m.nick, t.account, clean(t['+mbaa/name'] || '')), text: clean(text), action, hist, self: m.nick === irc.nick, msgid: t.msgid,
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
    const tags = irc.caps.has('message-tags') ? `@+mbaa/color=${prof.color}${validChara(prof.chara) ? `;+mbaa/chara=${prof.chara}` : ''}${prof.moon >= 0 ? `;+mbaa/moon=${prof.moon}` : ''}${cmd ? `;+mbaa/cmd=${cmd.replace(/ /g, '\\s')}` : ''}${at ? `;+mbaa/at=${at[0]}.${at[1]}` : ''}${irc.account && auth.name ? `;+mbaa/name=${auth.name.replace(/\\/g, '\\\\').replace(/;/g, '\\:').replace(/ /g, '\\s')}` : ''} ` : '';
    irc.send(`${tags}PRIVMSG ${shown} :${text}`);
    if (!irc.caps.has('echo-message')) {
      const action = text.startsWith('\x01ACTION ');
      addLine(shown, { nick: shownNick(irc.nick, irc.account, auth.name), text: action ? text.slice(8, -1) : text, action, self: true, time: new Date(),
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
  start();
  window.mbaaChat = { irc, auth, nameOk, chans, prof, danmaku, say, nico, tl, clockPos, localOf, posOf, nowOf, feed: raw => on(parse(raw)), show: name => { chan(name); shown = name; tabs(); render(); }, status: () => ({ connected: irc.registered, nick: irc.nick, caps: [...irc.caps], shown, matchChan }) };  // (tests)
})();
