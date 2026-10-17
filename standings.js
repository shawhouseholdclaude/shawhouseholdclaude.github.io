/* Standings and checks from the scanned cards.  computeStandings(setup, cards) -> {rows, matches, issues}

   setup.opp[card] = opponent card number per game (null = bye), straight from the printed schedule.
   cards = latest submission per card: {card, rounds: [[2,1,0,null] per game], twenties}.

   Each match (two players, one game) is:
     pending      neither card has anything for that game yet
     provisional  only one card has it: the other player's rounds are taken as 2 minus this player's
     confirmed    both cards agree (every round adds up to 2, blanks match)
     disputed     both cards have it but disagree: each player keeps their own card's points until the
                  organizer sorts it out (as on paper)
   Rounds left blank on both cards are unplayed and score setup.unplayed (0 each by default, or 1 each). */
(function (root) {
  'use strict';

  function computeStandings(setup, cards) {
    const byCard = {};
    for (const c of cards) byCard[c.card] = c;
    const unplayedPts = setup.unplayed === 'one' ? 1 : 0;
    const nums = Object.keys(setup.players).sort();
    const P = {};
    for (const n of nums) P[n] = {card: n, name: setup.players[n].name || '', group: setup.players[n].group || 0, points: 0, games: 0,
                                 twenties: byCard[n] && byCard[n].twenties != null ? Number(byCard[n].twenties) : null,
                                 scanned: !!byCard[n], h2h: {}, flags: []};
    const matches = [], issues = [];
    const roundsOf = (n, g) => { const c = byCard[n]; if (!c || !c.rounds || !c.rounds[g]) return null; const r = c.rounds[g]; return r.every(v => v === null || v === undefined) ? null : r.map(v => v === undefined ? null : v); };

    const G = Math.max(...nums.map(n => (setup.opp[n] || []).length), 0);
    for (let g = 0; g < G; g++) {
      const seen = new Set();
      for (const a of nums) {
        const b = (setup.opp[a] || [])[g];
        if (b === null || b === undefined) continue;                    // bye
        const key = [a, b].sort().join('-');
        if (seen.has(key)) continue; seen.add(key);
        const ra = roundsOf(a, g), rb = roundsOf(b, g);
        const m = {game: g + 1, a, b, status: 'pending', pa: null, pb: null, rounds: null, note: ''};
        if (!ra && !rb) { matches.push(m); continue; }
        if (ra && rb) {
          const bad = [];
          for (let r = 0; r < 4; r++) {
            const x = ra[r], y = rb[r];
            if (x === null && y === null) continue;
            if (x === null || y === null || x + y !== 2) bad.push(r + 1);
          }
          m.status = bad.length ? 'disputed' : 'confirmed';
          if (bad.length) m.note = 'Cards disagree in round' + (bad.length > 1 ? 's ' : ' ') + bad.join(', ');
          m.rounds = [ra, rb];
        } else {
          m.status = 'provisional';
          const own = ra || rb, other = own.map(v => v === null ? null : 2 - v);
          m.rounds = ra ? [ra, other] : [other, rb];
          m.note = 'Waiting for card #' + (ra ? b : a);
        }
        const score = rs => rs.reduce((s, v) => s + (v === null ? unplayedPts : v), 0);
        m.pa = score(m.rounds[0]); m.pb = score(m.rounds[1]);
        for (const [x, y, px, py] of [[a, b, m.pa, m.pb], [b, a, m.pb, m.pa]]) {
          if (!P[x]) continue;
          P[x].points += px; P[x].games += 1;
          P[x].h2h[y] = (P[x].h2h[y] || 0) + px;
        }
        for (const [n, rs] of [[a, ra], [b, rb]]) if (rs && rs.some(v => v === null) && rs.some(v => v !== null))
          issues.push({card: n, game: g + 1, kind: 'blank', text: '#' + n + ' game ' + (g + 1) + ': some rounds left blank (counted as unplayed)'});
        if (m.status === 'disputed') issues.push({card: a, game: g + 1, kind: 'dispute', text: 'Game ' + (g + 1) + ', #' + a + ' vs #' + b + ': ' + m.note});
        matches.push(m);
      }
    }
    for (const n of nums) {
      if (!P[n].scanned) issues.push({card: n, kind: 'missing', text: 'Card #' + n + ' (' + (P[n].name || 'no name') + ') not scanned yet'});
      else if (P[n].twenties === null) issues.push({card: n, kind: 'twenties', text: 'Card #' + n + ': total 20s not entered'});
    }

    /* rank: points, then head-to-head points among the tied players (only if they all played each other),
       then total 20s. Ties that survive everything share a rank. */
    const rows = nums.map(n => P[n]);
    const byGroup = {};
    for (const r of rows) (byGroup[r.group] = byGroup[r.group] || []).push(r);
    const ranked = [];
    for (const gk of Object.keys(byGroup).sort((x, y) => x - y)) {
      const list = byGroup[gk].slice().sort((x, y) => y.points - x.points);
      let i = 0; const out = [];
      while (i < list.length) {
        let j = i; while (j < list.length && list[j].points === list[i].points) j++;
        out.push(...breakTie(list.slice(i, j)));
        i = j;
      }
      let rank = 0, prev = null;
      out.forEach((r, k) => { if (!prev || !sameKey(prev, r)) rank = k + 1; r.rank = rank; prev = r; });
      ranked.push(...out);
    }
    function breakTie(t) {
      if (t.length === 1) return t;
      const allMet = t.every(x => t.every(y => x === y || x.h2h[y.card] !== undefined));
      t.forEach(x => { x.tieH2H = allMet ? t.reduce((s, y) => s + (x.h2h[y.card] || 0), 0) : null; });
      return t.slice().sort((x, y) => (allMet ? (y.tieH2H - x.tieH2H) : 0) || ((y.twenties || 0) - (x.twenties || 0)) || x.card.localeCompare(y.card));
    }
    function sameKey(x, y) { return x.points === y.points && (x.tieH2H ?? null) === (y.tieH2H ?? null) && (x.twenties || 0) === (y.twenties || 0); }
    for (const r of ranked) {
      const mine = matches.filter(m => m.a === r.card || m.b === r.card);
      r.pending = mine.filter(m => m.status === 'pending').length;
      r.provisional = mine.filter(m => m.status === 'provisional').length;
      r.disputed = mine.filter(m => m.status === 'disputed').length;
    }
    return {rows: ranked, matches, issues};
  }

  function toCSV(st, setup) {
    const q = v => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const multi = (setup.groups || []).length > 1;
    const head = [...(multi ? ['Group'] : []), 'Rank', 'Card', 'Name', 'Games', 'Points', '20s', 'Provisional games', 'Disputed games', 'Games not reported'];
    const lines = [head.join(',')];
    for (const r of st.rows) lines.push([...(multi ? [setup.groups[r.group].label] : []), r.rank, '#' + r.card, r.name, r.games, r.points, r.twenties, r.provisional, r.disputed, r.pending].map(q).join(','));
    return lines.join('\n');
  }

  root.CrokStandings = {computeStandings, toCSV};
  if (typeof module !== 'undefined') module.exports = root.CrokStandings;
})(typeof window !== 'undefined' ? window : globalThis);
