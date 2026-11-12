/* Lucky Socks UI. Pure DOM + string templates; all analysis lives in core.js, all ESPN I/O in espn.js. */
(function () {
  'use strict';
  const C = window.LuckyCore, E = window.LuckyEspn, CFG = window.LUCKY_CONFIG || {};
  const $ = (s, r) => (r || document).querySelector(s);
  const view = $('#view');
  const r1 = C.r1;

  // ------------------------------------------------------------------ storage
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };
  const S = {
    tab: 'leagues', leagues: store.get('ls.leagues', []), activeKey: store.get('ls.active', null),
    L: null, me: null, loading: false, error: null,
    tip: C.pickSuperstition(),
    trade: { partner: null, give: new Set(), get: new Set(), result: null },
    ideas: null, waivers: { recs: null, pos: 0 },
    connect: { input: '', s2: '', swid: '', teams: null, settings: null, leagueId: null, season: null, teamId: null, busy: false, error: null, openPriv: false, note: '' },
    relayTest: '',
  };
  const saveLeagues = () => { store.set('ls.leagues', S.leagues); store.set('ls.active', S.activeKey); };
  const activeLeague = () => S.leagues.find((l) => l.key === S.activeKey) || null;
  const relayUrl = () => (store.get('ls.relay', '') || CFG.RELAY_URL || '').trim();
  const cfgFor = (lg) => ({ relayUrl: relayUrl(), creds: lg && lg.creds ? lg.creds : null });
  const season = (lg) => (lg && lg.season) || CFG.SEASON || C.currentSeason();

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (x) => (x == null || !isFinite(x) ? '–' : r1(x).toFixed(1));
  const sgn = (x) => (x >= 0 ? '+' : '') + r1(x).toFixed(1);
  const cls = (x) => (x > 0.05 ? 'pos' : x < -0.05 ? 'neg' : '');

  // ------------------------------------------------------------------ small components
  const BADGE = { QUESTIONABLE: ['Q', 'Q'], DOUBTFUL: ['D', 'D'], OUT: ['O', 'OUT'], IR: ['IR', 'IR'], SUSPENDED: ['S', 'SUSP'] };
  function badges(p) {
    let h = '';
    if (BADGE[p.injury]) h += `<span class="badge ${BADGE[p.injury][0]}" title="${esc(p.injury)}">${BADGE[p.injury][1]}</span>`;
    if (S.L && C.onBye(p, S.L.ctx)) h += '<span class="badge BYE">BYE</span>';
    return h;
  }
  function opp(p) {
    const t = S.L && S.L.schedule.teams[p.proTeamId];
    if (!t) return '';
    if (t.bye === S.L.ctx.week) return 'bye week';
    const g = t.games[S.L.ctx.week];
    if (!g) return '';
    const o = S.L.schedule.teams[g.opp];
    return `${g.home ? 'vs' : '@'} ${o ? o.abbrev : '?'}`;
  }
  function slotChip(p) {
    const n = C.SLOT_NAMES[p.slotId] || '';
    return `<span class="slot ${p.slotId === 20 || p.slotId === 24 ? 'bn' : p.slotId === 21 ? 'ir' : ''}">${esc(n)}</span>`;
  }
  function playerRow(p, o) {
    o = o || {};
    const sel = o.sel ? ' sel' : '';
    const proj = C.onBye(p, S.L.ctx) ? 0 : p.wkProj;
    const lead = o.pick ? `<input type="checkbox" ${o.sel ? 'checked' : ''} tabindex="-1" aria-label="select ${esc(p.name)}">` : (o.noSlot ? '' : slotChip(p));
    const right = o.ros ? `<div class="num"><b>${fmt(p.ppg * p.avail)}</b><small>ppg · ROS ${Math.round(p.ros)}</small></div>`
      : `<div class="num"><b>${fmt(proj)}</b><small>wk ${S.L.ctx.week} proj</small></div>`;
    return `<div class="pl${o.pick ? ' pick' : ''}${sel}" ${o.pick ? `data-act="${o.pick}" data-id="${esc(p.id)}"` : ''}>
      ${lead}<div class="grow"><div class="nm">${esc(p.name)}${badges(p)}</div>
      <div class="meta">${esc(p.pos)} · ${esc(p.team || '—')}${opp(p) ? ' · ' + esc(opp(p)) : ''}${o.extra ? ' · ' + o.extra : ''}</div></div>${right}</div>`;
  }
  function jinxMeter(j, label) {
    return `<div class="jinx"><div class="bar"><div class="pin" style="left:${Math.max(3, Math.min(97, j))}%"></div></div>
      <div class="lbls"><span>Blessed 😇</span><span><b>${esc(label || C.jinxLabel(j))}</b> · jinx ${Math.round(j)}%</span><span>Cursed 💀</span></div></div>`;
  }
  const spinner = (t) => `<div class="card center"><span class="spin"></span>${esc(t || 'Rubbing the lucky socks…')}</div>`;

  // ------------------------------------------------------------------ explainers
  function privateExplainer(info, lg) {
    info = info || {};
    const hasCreds = !!info.hasCreds, relay = relayUrl();
    let head = 'This league is private 🔒';
    let state = '';
    if (hasCreds && !relay) state = '<div class="notice warn"><b>Cookies saved, but no relay is set up yet.</b> Browsers can\'t send your ESPN cookies to ESPN from another site, so private leagues need the small relay Worker. Deploy <code>worker/</code> (instructions in its README), then paste its URL under <b>Leagues → Relay</b>.</div>';
    else if (hasCreds && info.viaRelay) state = '<div class="notice bad"><b>ESPN rejected those cookies.</b> They may be expired, copied from the wrong account, or missing a character. Re-copy <code>espn_s2</code> and <code>SWID</code> (steps below) and try again.</div>';
    else if (!hasCreds) state = '<div class="notice warn">ESPN said <b>"not authorized"</b> — that\'s what private leagues look like to an outside website.</div>';
    return `<div class="card"><h2>${head}</h2>${state}
      <h3>Option A — easiest (needs the league manager)</h3>
      <p class="small">On a <b>desktop browser</b> (the ESPN app doesn't have this), the league manager opens the league, goes to <b>LM Tools → Basic Settings → Edit</b>, sets <b>"Make League Viewable to Public"</b> to <b>Yes</b>, and saves. Nobody can join or change anything — they can only view. Then reconnect here with just the league link.</p>
      <h3>Option B — your own private cookies</h3>
      <p class="small">Paste your <code>espn_s2</code> and <code>SWID</code> cookies below. They're stored only in this browser and sent only to your own relay Worker. ${relay ? '' : '<b>You\'ll also need the relay URL</b> (Leagues → Relay).'}</p>
      ${lg ? '' : ''}</div>`;
  }

  const COOKIE_HELP = `<details><summary>How do I find my espn_s2 and SWID cookies?</summary>
    <p class="small"><b>Desktop Chrome / Edge / Brave</b></p>
    <ol class="small">
      <li>Go to <b>fantasy.espn.com/football</b> and make sure you're signed in.</li>
      <li>Open DevTools: <b>F12</b> (Windows/Linux) or <b>⌘⌥I</b> (Mac).</li>
      <li>Click the <b>Application</b> tab → <b>Storage → Cookies</b> in the left sidebar → pick <b>https://fantasy.espn.com</b> (or <b>espn.com</b>).</li>
      <li>In the filter box type <code>espn_s2</code>. Double-click its <b>Value</b>, copy it (a very long string starting with <code>AEB…</code>).</li>
      <li>Filter for <code>SWID</code> and copy that value too (looks like <code>{1A2B3C4D-…}</code>, braces included).</li>
    </ol>
    <p class="small"><b>Desktop Safari</b></p>
    <ol class="small">
      <li>Safari → <b>Settings → Advanced</b> → tick <b>Show features for web developers</b>.</li>
      <li>On fantasy.espn.com press <b>⌘⌥I</b> → <b>Storage</b> tab → <b>Cookies</b> → <b>fantasy.espn.com</b> / <b>espn.com</b>.</li>
      <li>Double-click the Value of <code>espn_s2</code> and <code>SWID</code> and copy each.</li>
    </ol>
    <p class="small"><b>Firefox:</b> DevTools (<b>F12</b>) → <b>Storage</b> → Cookies → espn.com.</p>
    <p class="tiny muted">These cookies last about a year. If Lucky Socks says "private league" again later, copy fresh ones. Treat them like a password: anyone holding them can act as you on ESPN, so only paste them into a relay <i>you</i> deployed. You can do this on your phone too by copying them on a desktop and sending them to yourself via a password manager.</p>
  </details>`;

  // ------------------------------------------------------------------ loading
  async function loadActive() {
    const lg = activeLeague();
    S.L = null; S.me = null; S.error = null; S.ideas = null; S.waivers.recs = null;
    S.trade = { partner: null, give: new Set(), get: new Set(), result: null };
    if (!lg) { render(); return; }
    S.loading = true; render();
    try {
      const L = await E.loadLeague(cfgFor(lg), season(lg), lg.leagueId);
      S.L = L;
      S.me = L.teams.find((t) => String(t.id) === String(lg.teamId)) || L.teams[0];
      if (L.settings.name && lg.name !== L.settings.name && !lg.demo) { lg.name = L.settings.name; saveLeagues(); }
    } catch (e) {
      S.error = e instanceof E.EspnError ? e : new E.EspnError('http', e.message || String(e));
    }
    S.loading = false; render();
  }

  // ------------------------------------------------------------------ views: Team
  function loadingOrError(where) {
    if (S.loading) return spinner();
    if (S.error) return errorCard(S.error);
    return `<div class="card center"><h2>No league yet</h2><p class="muted">Connect a league to see your ${esc(where)}.</p><button class="btn" data-act="tab" data-tab="leagues">Connect a league</button></div>`;
  }
  function errorCard(err) {
    if (err.kind === 'private') {
      const lg = activeLeague();
      return privateExplainer(err, lg) + COOKIE_HELP +
        `<div class="row wrap"><button class="btn" data-act="tab" data-tab="leagues">Add cookies / relay</button><button class="btn ghost" data-act="reload">Retry</button></div>`;
    }
    const tips = { relay: 'Check the relay URL under Leagues → Relay (and that your Worker is deployed).', notfound: 'Double-check the league ID and season.', network: 'Check your connection and try again.' };
    return `<div class="card"><h2>Hmm, the socks tripped 🧦</h2><p>${esc(err.message)}</p><p class="muted small">${esc(tips[err.kind] || 'ESPN\'s unofficial API can be moody — try again in a minute.')}</p><button class="btn" data-act="reload">Try again</button></div>`;
  }

  function viewTeam() {
    if (!S.L || !S.me) return loadingOrError('team');
    const L = S.L, me = S.me, ctx = L.ctx;
    const lc = C.lineupCheck(me.roster, ctx);
    const g = C.groupRoster(me.roster);
    const t = S.tip;
    const rec = `${me.record.w}-${me.record.l}${me.record.t ? '-' + me.record.t : ''}`;
    let check = '';
    if (!lc.flags.length && !lc.moves.length) check = '<div class="notice good">✅ Lineup looks lucky — no byes, no injured starters, no better bench options.</div>';
    else {
      check += `<div class="notice ${lc.moves.length ? 'warn' : ''}"><b>${lc.flags.length} thing${lc.flags.length === 1 ? '' : 's'} look jinxed.</b>${lc.gain >= 0.5 ? ` Fixing them is worth about <b>+${fmt(lc.gain)} projected pts</b> this week.` : ''}</div>`;
      check += '<ul class="why">' + lc.flags.map((f) => f.issues.map((i) => `<li class="${i.level === 'bad' ? 'bad' : 'warn'}"><b>${esc(f.player.name)}</b> (${esc(C.SLOT_NAMES[f.player.slotId])}) — ${esc(i.text)}</li>`).join('')).join('') + '</ul>';
      if (lc.moves.length) check += '<div class="sec">Suggested swaps</div><ul class="why">' + lc.moves.map((m) =>
        `<li class="good">${m.out ? `Bench <b>${esc(m.out.name)}</b>, ` : ''}start <b>${esc(m.in.name)}</b> at ${esc(m.slotName)} <span class="${cls(m.gain)}">(${sgn(m.gain)} proj)</span><br><span class="muted small">${esc(m.reason)}</span></li>`).join('') + '</ul>';
    }
    return `
    <div class="card tip"><div class="row"><div style="font-size:30px">${t.emoji}</div><div><b>${esc(t.title)}</b><div class="small">${esc(t.tip)}</div><div class="small muted">${esc(t.advice)}</div></div></div></div>
    <div class="card"><div class="row between"><div><h2 class="mb0">${esc(me.name)}</h2><div class="muted small">${esc(L.settings.name)} · ${esc(rec)} · Week ${ctx.week}${L.settings.ppr ? ' · ' + (L.settings.ppr === 1 ? 'PPR' : L.settings.ppr === 0.5 ? 'Half-PPR' : L.settings.ppr + ' PPR') : ' · Standard'}</div></div>
      <button class="btn ghost small" data-act="reload">↻ Refresh</button></div>
      ${jinxMeter(lc.jinx)}</div>
    <div class="card"><h2>Lineup check</h2>${check}</div>
    <div class="card"><h2>Roster</h2>
      <div class="sec">Starters</div><div class="players">${g.starters.map((p) => playerRow(p)).join('') || '<div class="muted small">No starters set.</div>'}</div>
      <div class="sec">Bench</div><div class="players">${g.bench.map((p) => playerRow(p)).join('') || '<div class="muted small">Empty bench.</div>'}</div>
      ${g.ir.length ? `<div class="sec">Injured reserve</div><div class="players">${g.ir.map((p) => playerRow(p)).join('')}</div>` : ''}
    </div>`;
  }

  // ------------------------------------------------------------------ views: Trade
  function viewTrade() {
    if (!S.L || !S.me) return loadingOrError('trades');
    const L = S.L, me = S.me, T = S.trade;
    const others = L.teams.filter((t) => t.id !== me.id);
    if (T.partner == null) T.partner = others[0] && others[0].id;
    const partner = others.find((t) => t.id === T.partner) || others[0];
    if (!partner) return '<div class="card">No other teams in this league.</div>';
    const mineSorted = me.roster.slice().sort((a, b) => b.ros - a.ros);
    const theirsSorted = partner.roster.slice().sort((a, b) => b.ros - a.ros);
    const ready = T.give.size > 0 && T.get.size > 0;
    return `<div class="card"><h2>Trade evaluator</h2><p class="muted small">Pick what you'd give and what you'd get. Lucky Socks scores your best starting lineup (rest of season) before vs after, for both teams.</p>
      <label class="lbl" for="partner">Trade partner</label>
      <select id="partner" class="field" data-change="partner">${others.map((t) => `<option value="${t.id}" ${t.id === partner.id ? 'selected' : ''}>${esc(t.name)}${t.owner ? ' — ' + esc(t.owner) : ''}</option>`).join('')}</select></div>
      <div class="cols">
        <div class="card"><h3>You give <span class="chip">${T.give.size}</span></h3><div class="players">${mineSorted.map((p) => playerRow(p, { pick: 'give', sel: T.give.has(String(p.id)), ros: true, noSlot: true })).join('')}</div></div>
        <div class="card"><h3>You get <span class="chip">${T.get.size}</span></h3><div class="players">${theirsSorted.map((p) => playerRow(p, { pick: 'get', sel: T.get.has(String(p.id)), ros: true, noSlot: true })).join('')}</div></div>
      </div>
      <div class="row"><button class="btn grow" data-act="evaluate" ${ready ? '' : 'disabled'}>Ask the socks 🧦</button><button class="btn ghost" data-act="clear-trade">Clear</button></div>
      ${T.result ? tradeResultCard(T.result, partner) : ''}`;
  }

  function tradeResultCard(r, partner) {
    const v = r.verdict;
    const lineupRows = r.me.before.assign.map((a, i) => ({ slot: a.slotId, before: a.player, after: r.me.after.assign[i].player }))
      .filter((x) => (x.before && x.before.id) !== (x.after && x.after.id));
    return `<div class="card" id="result"><div class="verdict ${v.key}"><div class="v">${esc(v.label)}</div><div class="muted small">with ${esc(partner.name)}</div></div>
      ${jinxMeter(r.jinx, 'Trade jinx')}
      <div class="stat-grid"><div class="stat"><b class="${cls(r.me.perWeek)}">${sgn(r.me.perWeek)}</b><span>your pts/week</span></div>
        <div class="stat"><b class="${cls(r.me.delta)}">${sgn(r.me.delta)}</b><span>your ROS value Δ</span></div>
        <div class="stat"><b class="${cls(r.them.perWeek)}">${sgn(r.them.perWeek)}</b><span>their pts/week</span></div></div>
      <div class="small muted">Raw player value (above waiver level): you get <b>${Math.round(r.asset.get)}</b> vs give <b>${Math.round(r.asset.give)}</b> (${sgn(r.asset.delta)}). Would they accept? <b>${esc(r.acceptance)}</b>.</div>
      <div class="sec">Why</div><ul class="why">${r.reasons.map((x) => `<li class="${x.tone}">${esc(x.text)}</li>`).join('')}</ul>
      ${lineupRows.length ? `<div class="sec">Your starting lineup changes</div><table class="t"><tr><th>Slot</th><th>Before</th><th>After</th></tr>${lineupRows.map((x) => `<tr><td>${esc(C.SLOT_NAMES[x.slot])}</td><td>${esc(x.before ? x.before.name : '—')}</td><td>${esc(x.after ? x.after.name : '—')}</td></tr>`).join('')}</table>` : ''}
      <details><summary>How the score works</summary><ul class="small">
        <li>Each player's points-per-game = blend of ESPN's rest-of-season projection (45%), this week's projection (20%), season average (20%) and last-3-weeks form (15%); missing pieces are dropped and the rest re-weighted.</li>
        <li>× games left (from ESPN's NFL schedule, so byes count) × an availability factor (Questionable ×0.95, Doubtful ×0.8, OUT ×0.65, IR ×0.5).</li>
        <li>Positional scarcity: any starting slot you can't fill is assumed filled by a <b>waiver-level</b> player (the 3rd-best healthy free agent at that position), so surplus at a deep position is worth little and a hole at a thin one hurts.</li>
        <li>Your value = best legal starting lineup (using your league's slots, incl. FLEX) over the rest of the season, plus a small credit for bench depth. Verdict is the change in that value per week (±1.2 pts/week = approve / jinx).</li>
      </ul></details></div>`;
  }

  // ------------------------------------------------------------------ views: Ideas
  function viewIdeas() {
    if (!S.L || !S.me) return loadingOrError('trade ideas');
    if (!S.ideas) { setTimeout(() => { S.ideas = C.proposeTrades({ myTeam: S.me, teams: S.L.teams, ctx: S.L.ctx, max: 5 }); if (S.tab === 'ideas') render(); }, 30); return spinner('Scouting trade partners…'); }
    const { profile, ideas } = S.ideas;
    const mine = profile[S.me.id];
    const rows = C.POS_IDS.filter((p) => mine[p]).map((pid) => {
      const x = mine[pid];
      const tag = { strength: ['good', 'Strength'], need: ['bad', 'Need'], surplus: ['info', 'Surplus'], solid: ['', 'Solid'] }[x.label];
      return `<tr><td><b>${C.POS[pid]}</b></td><td>${fmt(x.strength)}</td><td>${fmt(x.leagueMean)}</td><td>${x.rank}/${x.n}</td><td><span class="chip ${tag[0]}">${tag[1]}</span></td></tr>`;
    }).join('');
    const cards = ideas.map((i, n) => {
      const r = i.result;
      return `<div class="card"><div class="row between"><b>#${n + 1} · ${esc(i.team.name)}</b><span class="chip ${r.verdict.key === 'approve' || r.verdict.key === 'edge' ? 'good' : ''}">${esc(r.verdict.label)}</span></div>
        <div class="mt"><div class="small muted">You give</div>${r.giveP.map((p) => playerRow(p, { noSlot: true, ros: true })).join('')}
        <div class="small muted mt">You get</div>${r.getP.map((p) => playerRow(p, { noSlot: true, ros: true })).join('')}</div>
        <div class="stat-grid"><div class="stat"><b class="${cls(r.me.perWeek)}">${sgn(r.me.perWeek)}</b><span>you, pts/wk</span></div><div class="stat"><b class="${cls(r.them.perWeek)}">${sgn(r.them.perWeek)}</b><span>them, pts/wk</span></div><div class="stat"><b>${esc(r.acceptance)}</b><span>they accept?</span></div></div>
        <ul class="why">${r.why.map((w) => `<li>${esc(w)}</li>`).join('')}${r.reasons.filter((x) => x.tone !== 'meh' || /lineup/i.test(x.text)).slice(0, 3).map((x) => `<li class="${x.tone}">${esc(x.text)}</li>`).join('')}</ul>
        <button class="btn ghost small" data-act="open-idea" data-i="${n}">Open in evaluator</button></div>`;
    }).join('');
    return `<div class="card"><h2>Position report</h2><p class="muted small">Starter strength = projected points per game from your starters at each position, compared with the league.</p>
      <table class="t"><tr><th>Pos</th><th>You</th><th>League avg</th><th>Rank</th><th>Verdict</th></tr>${rows}</table></div>
      <div class="row between"><h2 class="mb0">Trade ideas</h2><button class="btn ghost small" data-act="refresh-ideas">↻ Re-scout</button></div>
      <p class="muted small">Plausible swaps: they improve your starting lineup without leaving the other team worse off by much.</p>
      ${cards || '<div class="card center">Nothing both sides would like right now. Your lineup is already pretty lucky — or your league is stacked. Check Waivers!</div>'}`;
  }

  // ------------------------------------------------------------------ views: Waivers
  function viewWaivers() {
    if (!S.L || !S.me) return loadingOrError('waiver wire');
    const W = S.waivers;
    if (!W.recs) { setTimeout(() => { W.recs = C.proposeAddDrops({ roster: S.me.roster, pool: S.L.pool, ctx: S.L.ctx, max: 4 }); if (S.tab === 'waivers') render(); }, 30); return spinner('Scanning the wire…'); }
    const next = S.L.settings.waiverNext ? new Date(S.L.settings.waiverNext).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : null;
    const posIds = C.POS_IDS.filter((p) => S.L.pool.some((x) => x.posId === p));
    const list = C.rankFreeAgents(S.L.pool, S.L.ctx, W.pos || 0).slice(0, 15);
    const status = (p) => (p.status === 'WAIVERS' ? '<span class="chip warn">Waivers</span>' : '<span class="chip good">Free agent</span>');
    const recs = W.recs.map((r, n) => `<div class="card"><div class="row between"><b>Move #${n + 1}</b><span class="chip good">${sgn(r.perWeek)} pts/wk</span></div>
      <div class="sec">Add</div>${playerRow(r.add, { noSlot: true, ros: true, extra: r.add.status === 'WAIVERS' ? 'on waivers' : 'free agent' })}
      <div class="sec">Drop</div>${r.drop ? playerRow(r.drop, { noSlot: true, ros: true }) : '<div class="muted small">Nobody — you have an open roster spot.</div>'}
      <ul class="why">${r.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`).join('');
    return `<div class="card"><h2>Waiver wire</h2>
      <p class="muted small"><span class="chip good">Free agent</span> = add instantly. <span class="chip warn">Waivers</span> = submit a claim; it clears on ESPN's next waiver run${next ? ` (<b>${esc(next)}</b>)` : ''}.</p></div>
      <h2>Recommended pickups &amp; drops</h2>
      ${recs || '<div class="card center">No add/drop beats your current roster by a meaningful margin. Hold tight 🤞</div>'}
      <div class="card"><h2>Top available</h2><div class="chips"><button data-act="waiver-pos" data-pos="0" class="${!W.pos ? 'on' : ''}">All</button>${posIds.map((p) => `<button data-act="waiver-pos" data-pos="${p}" class="${W.pos === p ? 'on' : ''}">${C.POS[p]}</button>`).join('')}</div>
      <div class="players">${list.map((p) => playerRow(p, { noSlot: true, ros: true, extra: (status(p)) + (p.pctOwned != null ? ` <span class="muted">${r1(p.pctOwned)}% owned</span>` : '') })).join('')}</div>
      <p class="tiny muted">Ranked by expected rest-of-season points (ESPN projection blend × games left × health). Waiver-wire rankings come from the top ~35 free agents at each position, sorted by ESPN's projection.</p></div>`;
  }

  // ------------------------------------------------------------------ views: Remind
  function viewRemind() {
    const lg = activeLeague();
    const canInstall = !!window.__lsInstall;
    return `<div class="card"><h2>Lineup reminders ⏰</h2>
      <p>Web apps can't push notifications without a server, so Lucky Socks gives you two reliable options:</p>
      <h3>1 · Calendar alerts (works everywhere)</h3>
      <p class="small">Adds repeating events: <b>Thursdays 6:00 PM ET</b> (Thursday Night Football) and <b>Sundays 11:00 AM ET</b> (before the early games), each with an alert at the event time, running through <b>Jan 10, 2027</b>.</p>
      <button class="btn block" data-act="ics">📅 Add lineup reminders to my calendar (.ics)</button>
      <p class="tiny muted">Open the downloaded file to import it into Apple Calendar, Google Calendar, or Outlook.</p>
      <h3 class="mt">2 · Grok Bot reminder</h3>
      <p class="small">🤖 The Grok Bot lineup reminder is also set up, so you'll get a nudge there too.</p>
      <h3 class="mt">Put Lucky Socks on your home screen</h3>
      <p class="small"><b>iPhone:</b> Share → <b>Add to Home Screen</b>. <b>Android/Chrome:</b> menu → <b>Install app</b>.</p>
      ${canInstall ? '<button class="btn ghost" data-act="install">📲 Install app</button>' : ''}
      ${lg ? '' : '<p class="tiny muted">Tip: connect a league first and the calendar events will carry its name.</p>'}</div>`;
  }

  // ------------------------------------------------------------------ views: Leagues / connect
  function viewLeagues() {
    const c = S.connect;
    const relay = relayUrl();
    const relaySource = store.get('ls.relay', '') ? 'saved in this browser' : CFG.RELAY_URL ? 'from config.js' : 'not set';
    const saved = S.leagues.map((l) => `<div class="pl"><div class="grow"><div class="nm">${esc(l.name || 'League ' + l.leagueId)}${l.demo ? ' <span class="chip info">demo</span>' : ''}${l.key === S.activeKey ? ' <span class="chip good">active</span>' : ''}</div>
      <div class="meta">ID ${esc(l.leagueId)} · team ${esc(l.teamName || l.teamId)} · season ${esc(season(l))}${l.creds ? ` · 🔒 <span class="mono">${esc(C.maskSecret(l.creds.s2))}</span>` : ''}</div></div>
      <div class="row"><button class="btn small ${l.key === S.activeKey ? 'ghost' : ''}" data-act="use-league" data-key="${esc(l.key)}">${l.key === S.activeKey ? 'Reload' : 'Open'}</button>
      <button class="btn ghost small" data-act="del-league" data-key="${esc(l.key)}" aria-label="Remove league">✕</button></div></div>`).join('');
    let teamPick = '';
    if (c.teams) {
      teamPick = `<div class="card"><h2>Which team is yours?</h2><p class="muted small">${esc(c.settings.name)} · ${c.teams.length} teams</p>
        <div class="players">${c.teams.map((t) => `<label class="pl pick ${String(c.teamId) === String(t.id) ? 'sel' : ''}" data-act="pick-team" data-id="${t.id}"><input type="radio" name="team" ${String(c.teamId) === String(t.id) ? 'checked' : ''}><div class="grow"><div class="nm">${esc(t.name)}</div><div class="meta">${esc(t.owner || '')} · ${t.record.w}-${t.record.l}${t.record.t ? '-' + t.record.t : ''}</div></div></label>`).join('')}</div>
        <button class="btn block mt" data-act="save-league" ${c.teamId ? '' : 'disabled'}>Use this team</button></div>`;
    }
    const errBox = c.error ? (c.error.kind === 'private' ? privateExplainer(c.error, null) : `<div class="notice bad">${esc(c.error.message || c.error)}</div>`) : '';
    return `${S.leagues.length ? '' : `<div class="hero"><div class="big">🧦</div><h1>Lucky Socks</h1><p>Your fantasy football GM assistant — lineup checks, trade grades, trade ideas and waiver picks, with a healthy respect for superstition.</p></div>`}
      <div class="card"><h2>Connect your ESPN league</h2>
        <label class="lbl" for="cin">League link or ID</label>
        <input id="cin" type="text" inputmode="url" autocomplete="off" autocapitalize="off" placeholder="https://fantasy.espn.com/football/team?leagueId=123456&teamId=3" data-bind="input" value="${esc(c.input)}">
        <p class="tiny muted">Open your team on fantasy.espn.com and copy the URL from the address bar. A bare league ID works too.</p>
        <details ${c.openPriv ? 'open' : ''} id="priv"><summary>🔒 Private league? Add your cookies</summary>
          <p class="small">Leagues that aren't public need your <code>espn_s2</code> and <code>SWID</code> cookies, sent through your relay Worker.</p>
          <label class="lbl" for="s2">espn_s2</label><input id="s2" type="password" autocomplete="off" placeholder="AEB…" data-bind="s2" value="${esc(c.s2)}">
          <label class="lbl" for="swid">SWID</label><input id="swid" type="password" autocomplete="off" placeholder="{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}" data-bind="swid" value="${esc(c.swid)}">
          ${c.s2 ? `<p class="tiny muted">Entered: <span class="mono">${esc(C.maskSecret(c.s2))}</span> · <span class="mono">${esc(C.maskSecret(c.swid))}</span></p>` : ''}
          ${relay ? '' : '<div class="notice warn small">No relay URL yet — private leagues won\'t load until you add one below.</div>'}
          ${COOKIE_HELP}
        </details>
        <div class="row mt"><button class="btn grow" data-act="lookup" ${c.busy ? 'disabled' : ''}>${c.busy ? '<span class="spin"></span>Looking…' : 'Find my league'}</button>
        <button class="btn gold" data-act="demo">Try a demo league</button></div>
        ${c.note ? `<div class="notice good small">${esc(c.note)}</div>` : ''}${errBox}
      </div>
      ${teamPick}
      ${S.leagues.length ? `<div class="card"><h2>Your leagues</h2><div class="players">${saved}</div></div>` : ''}
      <div class="card"><h2>Relay (private leagues)</h2>
        <p class="small muted">A tiny Cloudflare Worker you deploy (see <code>worker/README.md</code>) that forwards your ESPN cookies. Public leagues never use it.</p>
        <label class="lbl" for="relay">Relay URL</label><input id="relay" type="url" autocomplete="off" placeholder="https://lucky-socks-relay.your-name.workers.dev" value="${esc(store.get('ls.relay', ''))}">
        <div class="tiny muted">Currently: <b>${relay ? esc(relay) : 'none'}</b> (${relaySource})</div>
        <div class="row mt wrap"><button class="btn ghost small" data-act="relay-save">Save</button><button class="btn ghost small" data-act="relay-test" ${relay ? '' : 'disabled'}>Test</button>${S.relayTest ? `<span class="small">${esc(S.relayTest)}</span>` : ''}</div></div>`;
  }

  // ------------------------------------------------------------------ render + routing
  const VIEWS = { team: viewTeam, trade: viewTrade, ideas: viewIdeas, waivers: viewWaivers, remind: viewRemind, leagues: viewLeagues };
  function render() {
    const y = window.scrollY;
    for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('on', b.dataset.tab === S.tab);
    const sw = $('#leagueSwitch');
    sw.hidden = S.leagues.length < 1;
    sw.innerHTML = S.leagues.map((l) => `<option value="${esc(l.key)}" ${l.key === S.activeKey ? 'selected' : ''}>${esc(l.name || l.leagueId)}</option>`).join('');
    view.innerHTML = VIEWS[S.tab]();
    window.scrollTo(0, y);
  }
  function go(tab) { S.tab = tab; render(); window.scrollTo(0, 0); }

  // ------------------------------------------------------------------ actions
  async function lookup() {
    const c = S.connect;
    c.error = null; c.note = ''; c.teams = null;
    const parsed = C.parseLeagueInput(c.input);
    if (!parsed.leagueId) { c.error = { message: 'Paste your ESPN team/league link (or just the league ID).' }; render(); return; }
    let creds = null;
    if (c.s2 || c.swid) {
      const s2 = C.normalizeS2(c.s2), swid = C.normalizeSwid(c.swid);
      if (!s2.valid || !swid.valid) { c.openPriv = true; c.error = { message: `That ${!s2.valid ? 'espn_s2' : 'SWID'} doesn't look right. espn_s2 is a very long string starting with AEB…; SWID looks like {XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}.` }; render(); return; }
      creds = { s2: s2.value, swid: swid.value };
    }
    c.busy = true; c.leagueId = parsed.leagueId; c.season = parsed.season || CFG.SEASON || C.currentSeason(); c.creds = creds; render();
    try {
      const { settings, teams } = await E.fetchTeamList({ relayUrl: relayUrl(), creds }, c.season, parsed.leagueId);
      c.teams = teams; c.settings = settings; c.teamId = parsed.teamId || null;
      if (c.teamId && !teams.some((t) => String(t.id) === String(c.teamId))) c.teamId = null;
    } catch (e) {
      c.error = e instanceof E.EspnError ? e : { message: e.message };
      if (e.kind === 'private') c.openPriv = true;
    }
    c.busy = false; render();
  }

  function saveLeague(demo) {
    const c = S.connect;
    const team = c.teams.find((t) => String(t.id) === String(c.teamId));
    const key = `${c.leagueId}:${c.teamId}`;
    const rec = { key, leagueId: String(c.leagueId), teamId: Number(c.teamId), teamName: team ? team.name : '', season: c.season, name: demo ? 'Demo: ' + c.settings.name : c.settings.name, demo: !!demo, creds: c.creds || null };
    S.leagues = S.leagues.filter((l) => l.key !== key).concat([rec]);
    S.activeKey = key; saveLeagues();
    S.connect = { input: '', s2: '', swid: '', teams: null, settings: null, leagueId: null, season: null, teamId: null, busy: false, error: null, openPriv: false, note: '' };
    S.tab = 'team'; loadActive();
  }

  async function demo() {
    const c = S.connect;
    c.error = null; c.busy = true; render();
    try {
      c.leagueId = CFG.DEMO_LEAGUE_ID; c.season = CFG.SEASON || C.currentSeason(); c.creds = null; c.teamId = CFG.DEMO_TEAM_ID;
      const { settings, teams } = await E.fetchTeamList({ relayUrl: '', creds: null }, c.season, c.leagueId);
      c.teams = teams; c.settings = settings;
      saveLeague(true);
    } catch (e) { c.error = e instanceof E.EspnError ? e : { message: e.message }; c.busy = false; render(); return; }
    c.busy = false;
  }

  function downloadIcs() {
    const lg = activeLeague();
    const ics = C.buildIcs({ leagueName: lg && lg.name, leagueId: lg && lg.leagueId, now: new Date(), appUrl: location.href.split('#')[0].split('?')[0].replace(/index\.html$/, '') });
    const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'lucky-socks-lineup-reminders.ics';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function evaluate() {
    const T = S.trade;
    const partner = S.L.teams.find((t) => t.id === T.partner);
    T.result = C.evaluateTrade({ mine: S.me.roster, theirs: partner.roster, give: [...T.give].map(norm(S.me.roster)), get: [...T.get].map(norm(partner.roster)), ctx: S.L.ctx });
    render();
    const el = $('#result'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  const norm = (roster) => (id) => { const p = roster.find((x) => String(x.id) === String(id)); return p ? p.id : id; };
  const toggle = (set, id) => { if (set.has(id)) set.delete(id); else set.add(id); };

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const a = el.dataset.act;
    if (a === 'tab') go(el.dataset.tab);
    else if (a === 'reload') loadActive();
    else if (a === 'lookup') lookup();
    else if (a === 'demo') demo();
    else if (a === 'pick-team') { S.connect.teamId = el.dataset.id; render(); }
    else if (a === 'save-league') saveLeague(false);
    else if (a === 'use-league') { S.activeKey = el.dataset.key; saveLeagues(); S.tab = 'team'; loadActive(); }
    else if (a === 'del-league') {
      S.leagues = S.leagues.filter((l) => l.key !== el.dataset.key);
      if (S.activeKey === el.dataset.key) { S.activeKey = S.leagues[0] ? S.leagues[0].key : null; saveLeagues(); loadActive(); } else { saveLeagues(); render(); }
    } else if (a === 'give') { e.preventDefault(); S.trade.result = null; toggle(S.trade.give, el.dataset.id); render(); }
    else if (a === 'get') { e.preventDefault(); S.trade.result = null; toggle(S.trade.get, el.dataset.id); render(); }
    else if (a === 'clear-trade') { S.trade.give.clear(); S.trade.get.clear(); S.trade.result = null; render(); }
    else if (a === 'evaluate') evaluate();
    else if (a === 'refresh-ideas') { S.ideas = null; render(); }
    else if (a === 'open-idea') {
      const i = S.ideas.ideas[Number(el.dataset.i)];
      S.trade = { partner: i.team.id, give: new Set(i.give.map(String)), get: new Set(i.get.map(String)), result: null };
      S.tab = 'trade'; evaluate(); window.scrollTo(0, 0);
    } else if (a === 'waiver-pos') { S.waivers.pos = Number(el.dataset.pos); render(); }
    else if (a === 'ics') downloadIcs();
    else if (a === 'install' && window.__lsInstall) { window.__lsInstall.prompt(); window.__lsInstall = null; render(); }
    else if (a === 'relay-save') { const v = $('#relay').value.trim().replace(/\/+$/, ''); if (v) store.set('ls.relay', v); else store.del('ls.relay'); S.relayTest = v ? 'Saved.' : 'Cleared.'; render(); }
    else if (a === 'relay-test') {
      S.relayTest = 'Testing…'; render();
      fetch(relayUrl().replace(/\/+$/, '') + '/health', { cache: 'no-store' }).then((r) => r.json()).then((j) => { S.relayTest = j && j.ok ? '✅ Relay is up' : '⚠️ Unexpected reply'; render(); })
        .catch(() => { S.relayTest = '❌ Could not reach the relay (check URL / CORS origin)'; render(); });
    }
  });
  document.addEventListener('change', (e) => {
    const el = e.target;
    if (el.id === 'leagueSwitch') { S.activeKey = el.value; saveLeagues(); S.tab = S.tab === 'leagues' ? 'team' : S.tab; loadActive(); }
    else if (el.dataset && el.dataset.change === 'partner') { S.trade = { partner: Number(el.value), give: new Set(), get: new Set(), result: null }; render(); }
  });
  document.addEventListener('input', (e) => {
    const b = e.target.dataset && e.target.dataset.bind;
    if (b) { S.connect[b] = e.target.value; if (b === 's2' || b === 'swid') S.connect.openPriv = true; }
  });
  $('#tabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) go(b.dataset.tab); });

  // theme
  const root = document.documentElement;
  const applyTheme = (t) => { if (t === 'light' || t === 'dark') root.setAttribute('data-theme', t); else root.removeAttribute('data-theme'); };
  let theme = store.get('ls.theme', null);
  if (!theme) theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  applyTheme(theme);
  $('#themeBtn').addEventListener('click', () => { theme = theme === 'dark' ? 'light' : 'dark'; store.set('ls.theme', theme); applyTheme(theme); const m = document.querySelector('meta[name=theme-color]'); if (m) m.content = theme === 'dark' ? '#0f1220' : '#f6f4ff'; });

  // PWA
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); window.__lsInstall = e; if (S.tab === 'remind') render(); });
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }

  // expose for tests/debug
  window.__luckySocks = { S, go, render };

  // boot
  if (S.activeKey && activeLeague()) { S.tab = 'team'; loadActive(); } else { S.tab = 'leagues'; render(); }
})();
