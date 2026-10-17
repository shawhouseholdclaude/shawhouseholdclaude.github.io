/* Crokinole scorecards: scan page, review screen, standings.
   Routes (the QR code on each card opens the first one):
     /C/<TOURNAMENT>-<CARD>/<LAYOUT>   scan or re-scan that card
     /T/<TOURNAMENT>                   standings, checks, CSV
     /                                 home: type a tournament code */
(function () {
  'use strict';
  const CFG = window.CROK_CONFIG || {};
  const app = document.getElementById('app');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
  const h = (html) => { app.innerHTML = html; window.scrollTo(0, 0); };
  const VALUES = [2, 1, 0, null];

  /* ---------------- talking to the results store ---------------- */
  async function api(params, body) {
    if (!CFG.api) throw new Error('This site isn\'t connected to a results sheet yet (config.js has no api address).');
    const url = CFG.api + (params ? (CFG.api.includes('?') ? '&' : '?') + new URLSearchParams(params) : '');
    const res = await fetch(url, body ? {method: 'POST', body: JSON.stringify(body), headers: {'Content-Type': 'text/plain;charset=utf-8'}, redirect: 'follow'} : {redirect: 'follow'});
    if (!res.ok) throw new Error('The results sheet answered ' + res.status);
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || 'The results sheet refused the request');
    return j;
  }
  const getTournament = code => api({action: 'get', t: code, _: Date.now()});

  /* ---------------- routing ---------------- */
  function route() {
    const p = decodeURIComponent(location.pathname).toUpperCase();
    let m;
    if ((m = p.match(/\/C\/([A-Z0-9]+)-(\d+)(?:\/(V\d+-[A-Z0-9-]+?))?\/?$/))) return scanPage(m[1], m[2], m[3]);   // layout optional (older QR codes had it)
    if ((m = p.match(/\/T\/([A-Z0-9]+)\/?$/))) return standingsPage(m[1]);
    return homePage();
  }

  function homePage() {
    h(`<h1>Crokinole scorecards</h1>
      <p class="sub">Scan the QR code on your scorecard with your phone's camera to enter your scores.</p>
      <div class="panel"><label class="field">Tournament code (printed at the bottom of each card, before the dash)
        <input id="code" autocapitalize="characters" autocomplete="off" placeholder="e.g. YDN7"></label>
        <button class="btn primary" id="go">See standings</button></div>
      <div class="panel"><b>Organizers:</b> <a href="/generator.html">make scorecards and publish a tournament</a></div>`);
    const go = () => { const c = document.getElementById('code').value.trim().toUpperCase().replace(/-.*/, ''); if (c) location.href = '/T/' + c; };
    document.getElementById('go').onclick = go;
    document.getElementById('code').onkeydown = e => { if (e.key === 'Enter') go(); };
  }

  function errorPage(msg, retry) {
    h(`<h1>Something went wrong</h1><div class="note bad">${esc(msg)}</div>
       ${retry ? '<button class="btn primary" id="retry">Try again</button>' : ''}<a class="btn" href="/">Home</a>`);
    if (retry) document.getElementById('retry').onclick = retry;
  }

  /* ---------------- templates (where everything is printed on the card) ---------------- */
  let BASE = null;
  async function loadTemplate(setup, tid) {
    const t = setup.templates && setup.templates[tid];
    if (!t) return null;
    if (!BASE) BASE = await (await fetch('/base.json')).json();
    return {template_id: tid, markers: t.markers, orientation_marker: t.orientation_marker || 'tl_large', qr: t.qr,
            bubbles: t.b.map(([game, round, value, cx, cy, d]) => ({game, round, value, cx, cy, d})), base: BASE.base, bubbleMm: t.b[0][5]};
  }

  /* ---------------- scan page ---------------- */
  async function scanPage(code, card, tid) {
    h(`<p class="muted">Loading tournament ${esc(code)}…</p>`);
    let T;
    try { T = await getTournament(code); } catch (e) { return errorPage(e.message, () => scanPage(code, card, tid)); }
    const setup = T.setup, player = setup.players[card];
    if (!player) return errorPage(`Card #${card} isn't part of tournament ${code}. Check the code at the bottom of your card.`);
    tid = tid || ((setup.groups || [])[player.group] || {}).template;
    const tpl = await loadTemplate(setup, tid);
    const prev = (T.cards || []).find(c => c.card === card);
    const G = (setup.opp[card] || []).length;
    const ctx = {code, card, tid, setup, player, tpl, G, name: T.name || setup.name || ''};
    const prevPts = prev ? prev.rounds.flat().reduce((s, v) => s + (v || 0), 0) : 0;
    h(`<h1>Card #${esc(card)}${player.name ? ' · ' + esc(player.name) : ''}</h1>
      <p class="sub">${esc(ctx.name)}${setup.groups && setup.groups.length > 1 ? ' · ' + esc(setup.groups[player.group].label) : ''}</p>
      ${prev ? `<div class="note ok">Already saved: ${prevPts} points. Scanning again replaces it.</div>` : ''}
      ${tpl ? `<div class="panel guide"><div class="frame"><i></i><i></i><i></i><i></i></div>
        <ul><li>Lay the card flat in good light</li><li>Hold the phone straight above it</li><li>All four black corner squares in the photo</li><li>Card fills most of the screen</li></ul></div>
      <label class="btn primary" for="cam">Take photo of your card</label>
      <input type="file" id="cam" accept="image/*" capture="environment">
      <label class="btn" for="pick">Choose an existing photo</label><input type="file" id="pick" accept="image/*">`
      : `<div class="note warn">This card's layout can't be scanned yet. Please enter your scores by hand.</div>`}
      <button class="btn" id="manual">Enter scores by hand instead</button>
      <p class="muted" style="margin-top:16px"><a href="/T/${esc(code)}">Standings</a></p>`);
    document.getElementById('manual').onclick = () => review(ctx, null, null, prev);
    for (const id of ['cam', 'pick']) { const el = document.getElementById(id); if (el) el.onchange = e => { const f = e.target.files[0]; if (f) readPhoto(ctx, f, prev); }; }
  }

  async function loadImage(file, maxSide) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => bad(new Error('That file isn\'t a photo the browser can open.')); i.src = url; });
      const s = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);              // browsers apply the photo's rotation tag here
      return c;
    } finally { URL.revokeObjectURL(url); }
  }

  let worker = null, jobId = 0;
  function runReader(canvas, tpl) {
    worker = worker || new Worker('/worker.js');
    const id = ++jobId, data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    return new Promise((ok, bad) => {
      worker.onmessage = e => { if (e.data.id === id) ok(e.data); };
      worker.onerror = e => bad(new Error(e.message || 'reader crashed'));
      worker.postMessage({id, w: canvas.width, h: canvas.height, data, tpl: {...tpl}}, [data.buffer]);
    });
  }

  async function readPhoto(ctx, file, prev) {
    h(`<h1>Reading your card…</h1><div class="panel row" style="align-items:center"><div class="spin" style="flex:none"></div><span>This takes a few seconds.</span></div>`);
    let canvas, res;
    try {
      canvas = await loadImage(file, 2600);
      res = await runReader(canvas, ctx.tpl);
    } catch (e) { return errorPage(e.message, () => scanPage(ctx.code, ctx.card, ctx.tid)); }
    if (!res.ok) {
      h(`<h1>Couldn't find the card in that photo</h1>
        <div class="panel guide"><div class="frame"><i></i><i></i><i></i><i></i></div>
        <ul><li>All four black corner squares must be in the photo</li><li>Hold the phone straight above the card, not at an angle</li><li>Card flat, filling most of the screen</li><li>Avoid glare and your own shadow</li></ul></div>
        <label class="btn primary" for="cam">Take another photo</label><input type="file" id="cam" accept="image/*" capture="environment">
        <button class="btn" id="manual">Enter scores by hand instead</button>`);
      document.getElementById('cam').onchange = e => { const f = e.target.files[0]; if (f) readPhoto(ctx, f, prev); };
      document.getElementById('manual').onclick = () => review(ctx, null, null, prev);
      return;
    }
    review(ctx, res, canvas, prev);
  }

  /* ---------------- review screen ---------------- */
  function stripFor(res, tpl, g) {                // the straightened image of one game's bubbles
    const bs = tpl.bubbles.filter(b => b.game === g);
    const S = 10, PAD = 50, r = bs[0].d / 2;
    const x0 = Math.min(...bs.map(b => b.cx)) - r - 2, x1 = Math.max(...bs.map(b => b.cx)) + r + 2;
    const y0 = Math.min(...bs.map(b => b.cy)) - r - 2.5, y1 = Math.max(...bs.map(b => b.cy)) + r + 2.5;
    const R = res.rect, X0 = Math.max(0, Math.round(x0 * S + PAD)), Y0 = Math.max(0, Math.round(y0 * S + PAD));
    const W = Math.min(R.w - X0, Math.round((x1 - x0) * S)), H = Math.min(R.h - Y0, Math.round((y1 - y0) * S));
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const im = c.getContext('2d').createImageData(W, H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const v = R.d[(Y0 + y) * R.w + X0 + x], k = (y * W + x) * 4; im.data[k] = im.data[k + 1] = im.data[k + 2] = v; im.data[k + 3] = 255; }
    c.getContext('2d').putImageData(im, 0, 0);
    c.className = 'strip';
    return c;
  }

  function review(ctx, res, canvas, prev) {
    const {G, setup, card} = ctx;
    /* state[g][r] = {v: 2|1|0|null, check: bool (reader unsure: needs a tap), touched} */
    const state = [];
    for (let g = 0; g < G; g++) {
      state.push([]);
      for (let r = 0; r < 4; r++) {
        let v = null, check = false;
        if (res) {
          const a = res.answers[g + 1] && res.answers[g + 1][r];
          if (a) {
            if (a.answer === '?' || a.answer === 'MULTI') { check = true; v = a.guess; }
            else v = a.answer;
          }
        } else if (prev && prev.rounds[g]) v = prev.rounds[g][r];
        state[g].push({v: v === undefined ? null : v, check});
      }
    }
    const nCheck = () => state.flat().filter(s => s.check).length;
    const opp = setup.opp[card] || [], tables = (setup.tables || {})[card] || [];
    const gameHead = g => {
      const o = opp[g];
      const who = o == null ? 'BYE' : 'vs #' + o + (setup.players[o] && setup.players[o].name ? ' ' + setup.players[o].name : '');
      return `<b>Game ${g + 1}</b> <span>${esc(who)}${tables[g] ? ' · T' + tables[g] : ''}</span>`;
    };
    h(`<h1>Check your scores</h1>
      <p class="sub">Card #${esc(card)}${ctx.player.name ? ' · ' + esc(ctx.player.name) : ''}. ${res ? 'Tap a number to change it. Yellow rounds: the reader wasn\'t sure, so please tap the right one.' : 'Tap your points for each round (– = not played).'}</p>
      <div class="panel" id="games"></div>
      <div class="panel"><label class="field">Total 20s on your card (Total 20s box at the bottom)
        <input type="number" id="tw" inputmode="numeric" min="0" max="999" value="${prev && prev.twenties != null && !res ? prev.twenties : ''}"></label></div>
      <div class="sticky"><div class="in"><span class="tot" id="tot"></span><button class="btn primary" id="send">Submit</button></div></div>`);
    const box = document.getElementById('games');
    for (let g = 0; g < G; g++) {
      if (opp[g] === null && setup.opp[card]) { /* bye: nothing to enter */ }
      const div = document.createElement('div'); div.className = 'game';
      div.innerHTML = `<div class="ghead"><div>${gameHead(g)}</div><span class="pts" id="gp${g}"></span></div>`;
      if (opp[g] == null) { div.innerHTML += '<p class="muted" style="margin:0">Bye: no game.</p>'; box.appendChild(div); continue; }
      if (res) div.appendChild(stripFor(res, ctx.tpl, g + 1));
      const rr = document.createElement('div'); rr.className = 'rounds';
      for (let r = 0; r < 4; r++) {
        const cell = document.createElement('div'); cell.className = 'rnd'; cell.id = `c${g}_${r}`;
        cell.innerHTML = `<div class="lbl">Round ${r + 1}</div><div class="opts">` + VALUES.map(v => `<button type="button" data-v="${v}" class="${v === null ? 'blank' : ''}">${v === null ? '–' : v}</button>`).join('') + '</div>';
        cell.querySelectorAll('button').forEach(b => b.onclick = () => { const s = state[g][r]; s.v = b.dataset.v === 'null' ? null : +b.dataset.v; s.check = false; paint(); });
        rr.appendChild(cell);
      }
      div.appendChild(rr); box.appendChild(div);
    }
    function paint() {
      let total = 0;
      for (let g = 0; g < G; g++) {
        if (opp[g] == null) continue;
        let gp = 0, any = false;
        for (let r = 0; r < 4; r++) {
          const s = state[g][r], cell = document.getElementById(`c${g}_${r}`);
          cell.classList.toggle('check', s.check);
          cell.querySelectorAll('button').forEach(b => b.classList.toggle('on', (b.dataset.v === 'null' ? null : +b.dataset.v) === s.v && !(s.check && s.v === null)));
          if (s.v !== null) { gp += s.v; any = true; }
        }
        total += gp;
        document.getElementById('gp' + g).textContent = any ? gp + ' pts' : '';
      }
      const n = nCheck();
      document.getElementById('tot').textContent = total + ' points';
      const send = document.getElementById('send');
      send.disabled = n > 0; send.textContent = n ? `Check ${n} yellow round${n > 1 ? 's' : ''}` : 'Submit';
    }
    paint();
    const firstCheck = document.querySelector('.rnd.check'); if (firstCheck) setTimeout(() => firstCheck.scrollIntoView({block: 'center'}), 50);
    document.getElementById('send').onclick = async () => {
      const tw = document.getElementById('tw');
      if (tw.value === '' || isNaN(+tw.value)) { tw.focus(); tw.style.borderColor = 'var(--bad)'; return; }
      const rounds = state.map((rs, g) => opp[g] == null ? [null, null, null, null] : rs.map(s => s.v));
      const unsure = res ? Object.values(res.answers).flat().filter(a => a.answer === '?' || a.answer === 'MULTI').length : 0;
      const body = {action: 'submit', t: ctx.code, card, player: ctx.player.name || '', rounds, twenties: +tw.value, unsure, source: res ? 'scan' : 'manual'};
      if (canvas) {
        const s = Math.min(1, 1400 / Math.max(canvas.width, canvas.height)), c = document.createElement('canvas');
        c.width = Math.round(canvas.width * s); c.height = Math.round(canvas.height * s);
        c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
        body.photo = c.toDataURL('image/jpeg', 0.75).split(',')[1];
      }
      const btn = document.getElementById('send'); btn.disabled = true; btn.textContent = 'Saving…';
      try { await api(null, body); }
      catch (e) { btn.disabled = false; btn.textContent = 'Submit'; alertBox(e.message + ' Your entries are still here; try Submit again.'); return; }
      const total = rounds.flat().reduce((s, v) => s + (v || 0), 0);
      h(`<h1>Saved</h1><div class="note ok">Card #${esc(card)}: ${total} points, ${body.twenties} twenties.</div>
        <a class="btn primary" href="/T/${esc(ctx.code)}">See standings</a>
        <a class="btn" href="${esc(location.pathname)}">Scan this card again</a>`);
    };
  }
  function alertBox(msg) {
    let n = document.getElementById('msg');
    if (!n) { n = document.createElement('div'); n.id = 'msg'; n.className = 'note bad'; app.prepend(n); }
    n.textContent = msg; window.scrollTo(0, 0);
  }

  /* ---------------- standings ---------------- */
  let timer = null;
  async function standingsPage(code, quiet) {
    if (!quiet) h(`<p class="muted">Loading standings for ${esc(code)}…</p>`);
    let T;
    try { T = await getTournament(code); } catch (e) { if (!quiet) errorPage(e.message, () => standingsPage(code)); return; }
    const setup = T.setup, st = CrokStandings.computeStandings(setup, T.cards || []);
    const groups = setup.groups && setup.groups.length > 1 ? setup.groups : null;
    const cnt = s => st.matches.filter(m => m.status === s).length;
    const N = Object.keys(setup.players).length, scanned = (T.cards || []).length;
    const cardLink = r => `/C/${code}-${r.card}`;
    const rowHtml = r => `<tr><td>${r.rank}</td><td>#${esc(r.card)}</td><td><a href="${esc(cardLink(r))}">${esc(r.name || 'Card #' + r.card)}</a>${r.provisional ? `<span class="tag p">${r.provisional} provisional</span>` : ''}${r.disputed ? `<span class="tag d">${r.disputed} disputed</span>` : ''}</td>
       <td>${r.games}</td><td><b>${r.points}</b></td><td>${r.twenties == null ? '–' : r.twenties}</td></tr>`;
    const tableFor = rows => `<table><thead><tr><th>#</th><th>Card</th><th>Name</th><th>Games</th><th>Pts</th><th>20s</th></tr></thead><tbody>${rows.map(rowHtml).join('')}</tbody></table>`;
    const issues = st.issues.filter(i => i.kind !== 'missing'), missing = st.issues.filter(i => i.kind === 'missing');
    const byGame = {};
    for (const m of st.matches) (byGame[m.game] = byGame[m.game] || []).push(m);
    const label = {confirmed: 'confirmed', provisional: 'one card', disputed: 'DISAGREE', pending: 'not scanned'};
    h(`<h1>${esc(T.name || setup.name || code)}</h1>
      <p class="sub">Tournament ${esc(code)} · updates by itself every 30 s · <a href="#" id="refresh">refresh now</a></p>
      <div class="stats"><div><b>${scanned}/${N}</b><span>cards in</span></div><div><b>${cnt('confirmed')}</b><span>confirmed</span></div>
        <div><b>${cnt('provisional')}</b><span>one card only</span></div><div><b>${cnt('disputed')}</b><span>disagree</span></div></div>
      ${issues.length ? `<div class="panel"><b>To check</b><ul class="issues">${issues.map(i => `<li>${esc(i.text)}</li>`).join('')}</ul></div>` : ''}
      <h2>Standings</h2>
      ${groups ? groups.map((g, gi) => `<h2>${esc(g.label)}</h2><div class="panel">${tableFor(st.rows.filter(r => r.group === gi))}</div>`).join('') : `<div class="panel">${tableFor(st.rows)}</div>`}
      <p class="muted">Tap a name to open that card: to enter or correct it for a player. Ranked by points, then head-to-head points between tied players (only if they all played each other), then total 20s. "Provisional": only one of the two cards is in so far.</p>
      <button class="btn" id="csv">Download standings (CSV, opens in Excel)</button>
      ${missing.length ? `<div class="panel"><b>Not scanned yet</b><ul class="issues">${missing.map(i => `<li>${esc(i.text.replace(' not scanned yet', ''))}</li>`).join('')}</ul></div>` : ''}
      <h2>Games</h2>
      <div class="panel mgrid"><table><thead><tr><th>Game</th><th>Match</th><th>Points</th><th>Status</th></tr></thead><tbody>
      ${Object.keys(byGame).map(g => byGame[g].map(m => `<tr><td>${m.game}</td><td>#${m.a} v #${m.b}</td><td>${m.pa == null ? '' : m.pa + '–' + m.pb}</td><td class="st-${m.status}">${label[m.status]}</td></tr>`).join('')).join('')}
      </tbody></table></div>
      <div class="panel muted">Players' photos and every submission are in the organizer's Google Sheet (Cards tab) and Drive folder "Crokinole scan photos".</div>`);
    document.getElementById('refresh').onclick = e => { e.preventDefault(); standingsPage(code, true); };
    document.getElementById('csv').onclick = () => {
      const blob = new Blob(['﻿' + CrokStandings.toCSV(st, setup)], {type: 'text/csv'});
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `standings-${code}.csv`; a.click();
    };
    clearTimeout(timer); timer = setTimeout(() => standingsPage(code, true), 30000);
  }

  route();
})();
