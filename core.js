/* Agent 89 core — pure analysis logic (no DOM, no network).
 * Works in the browser (window.LuckyCore) and in Node (require). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LuckyCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------- constants
  const POS = { 0: 'TQB', 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'D/ST' };
  const POS_IDS = [1, 0, 2, 3, 4, 5, 16];
  // ESPN lineup slot ids -> display name
  const SLOT_NAMES = { 0: 'QB', 1: 'TQB', 2: 'RB', 3: 'RB/WR', 4: 'WR', 5: 'WR/TE', 6: 'TE', 7: 'OP', 16: 'D/ST', 17: 'K', 20: 'BN', 21: 'IR', 23: 'FLEX', 24: 'ER' };
  // slot id -> eligible default-position ids
  const SLOT_POS = { 0: [1], 1: [0], 2: [2], 3: [2, 3], 4: [3], 5: [3, 4], 6: [4], 7: [1, 2, 3, 4], 16: [16], 17: [5], 23: [2, 3, 4] };
  const NON_STARTER_SLOTS = [20, 21, 24];
  const SLOT_ORDER = [0, 1, 2, 3, 4, 5, 6, 7, 23, 16, 17, 20, 21, 24];
  // ESPN proTeamId -> abbreviation fallback (the API also gives abbrevs)
  const AVAILABILITY = { ACTIVE: 1, QUESTIONABLE: 0.95, DOUBTFUL: 0.8, OUT: 0.65, IR: 0.5, SUSPENDED: 0.6 };
  const DEFAULT_REPLACEMENT = { 0: 12, 1: 12, 2: 7, 3: 7, 4: 5, 5: 7, 16: 6 };
  const MODEL_WEIGHTS = { ros: 0.45, week: 0.2, season: 0.2, recent: 0.15 };
  const DEPTH_CREDIT = 0.25;

  const recentLabel = (p) => (p.recentWeeks.length === 1 ? 'in his last game' : `over his last ${p.recentWeeks.length} games`);
  const r1 = (x) => Math.round(x * 10) / 10;
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const num = (x) => (typeof x === 'number' && isFinite(x) ? x : 0);

  // ------------------------------------------------------------ input parsing
  /** Parse an ESPN league / team URL (or "leagueId=1&teamId=2" or a bare id). */
  function parseLeagueInput(input) {
    const s = String(input || '').trim();
    const out = { leagueId: null, teamId: null, season: null };
    if (!s) return out;
    if (/^\d{3,}$/.test(s)) { out.leagueId = s; return out; }
    const lm = s.match(/leagueId=(\d+)/i);
    const tm = s.match(/teamId=(\d+)/i);
    const sm = s.match(/seasonId=(\d{4})/i);
    if (lm) out.leagueId = lm[1];
    if (tm) out.teamId = tm[1];
    if (sm) out.season = Number(sm[1]);
    return out;
  }

  function normalizeSwid(v) {
    let s = String(v || '').trim().replace(/^swid\s*=\s*/i, '').replace(/[;"'\s]/g, '');
    try { if (/%7B/i.test(s)) s = decodeURIComponent(s); } catch (e) { /* keep */ }
    if (s && s[0] !== '{') s = '{' + s;
    if (s && s[s.length - 1] !== '}') s += '}';
    s = s.toUpperCase();
    const valid = /^\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}$/.test(s);
    return { value: valid ? s : '', valid };
  }

  function normalizeS2(v) {
    let s = String(v || '').trim().replace(/^espn_s2\s*=\s*/i, '').replace(/[;"'\s]/g, '');
    if (s && !/%/.test(s) && /[+/=]/.test(s)) s = encodeURIComponent(s);
    const valid = s.length >= 30 && /^[A-Za-z0-9%._~+\/=-]+$/.test(s);
    return { value: valid ? s : '', valid };
  }

  function maskSecret(v) {
    const s = String(v || '');
    if (s.length <= 10) return s ? '••••••' : '';
    return s.slice(0, 4) + '••••••' + s.slice(-4);
  }

  // --------------------------------------------------------------- ESPN paths
  const API = '/apis/v3/games/ffl';
  function leaguePath(season, leagueId, views) {
    return `${API}/seasons/${season}/segments/0/leagues/${leagueId}` + (views && views.length ? '?' + views.map((v) => 'view=' + v).join('&') : '');
  }
  function schedulePath(season) { return `${API}/seasons/${season}?view=proTeamSchedules_wl`; }
  /** X-Fantasy-Filter for free agents / waiver players, sorted by ESPN rest-of-season projection. */
  function playersFilter({ season, week, posId, limit, statuses }) {
    const slotByPos = { 0: 1, 1: 0, 2: 2, 3: 4, 4: 6, 5: 17, 16: 16 };
    return {
      players: {
        filterStatus: { value: statuses || ['FREEAGENT', 'WAIVERS'] },
        filterSlotIds: { value: [slotByPos[posId]] },
        limit: limit || 30,
        sortAppliedStatTotal: { sortAsc: false, sortPriority: 1, value: '10' + season },
        filterStatsForTopScoringPeriodIds: {
          value: 3,
          additionalValue: ['00' + season, '10' + season, '11' + season + week, '00' + (season - 1)],
        },
      },
    };
  }
  function currentSeason(now) {
    const d = now || new Date();
    return d.getMonth() >= 2 ? d.getFullYear() : d.getFullYear() - 1; // Mar+ => this year's season
  }

  // ------------------------------------------------------------------ parsers
  function parseProTeams(json) {
    const out = { teams: {}, byAbbrev: {} };
    const list = (json && json.settings && json.settings.proTeams) || [];
    for (const t of list) {
      if (!t.id) continue;
      const games = {};
      for (const [period, arr] of Object.entries(t.proGamesByScoringPeriod || {})) {
        const g = arr[0];
        if (!g) continue;
        const home = g.homeProTeamId === t.id;
        games[Number(period)] = { opp: home ? g.awayProTeamId : g.homeProTeamId, home, date: g.date };
      }
      const rec = { id: t.id, abbrev: t.abbrev, name: `${t.location || ''} ${t.name || ''}`.trim(), bye: t.byeWeek || 0, games };
      out.teams[t.id] = rec;
      out.byAbbrev[t.abbrev] = rec;
    }
    return out;
  }

  function parseSettings(json) {
    const s = json.settings || {};
    const st = json.status || {};
    const rs = s.rosterSettings || {};
    const counts = {};
    for (const [k, v] of Object.entries(rs.lineupSlotCounts || {})) counts[Number(k)] = v;
    const final = st.finalScoringPeriod || 17;
    let week = json.scoringPeriodId || st.latestScoringPeriod || st.currentMatchupPeriod || 1;
    week = clamp(week, 1, final);
    const items = (s.scoringSettings && s.scoringSettings.scoringItems) || [];
    const rec = items.find((i) => i.statId === 53);
    const ppr = rec ? num(rec.points) : 0;
    return {
      id: json.id, season: json.seasonId, name: s.name || `League ${json.id}`, size: s.size || (json.teams || []).length,
      week, finalWeek: final,
      regSeasonWeeks: (s.scheduleSettings && s.scheduleSettings.matchupPeriodCount) || final,
      slotCounts: counts, ppr, isPublic: !!s.isPublic,
      waiverNext: st.waiverNextExecutionDate || null,
      playoffTeams: s.scheduleSettings && s.scheduleSettings.playoffTeamCount,
    };
  }

  function normInjury(raw) {
    const s = String(raw || 'ACTIVE').toUpperCase();
    if (s === 'ACTIVE' || s === 'NORMAL' || s === 'PROBABLE') return 'ACTIVE';
    if (s === 'QUESTIONABLE' || s === 'DAY_TO_DAY') return 'QUESTIONABLE';
    if (s === 'DOUBTFUL') return 'DOUBTFUL';
    if (s === 'OUT') return 'OUT';
    if (s === 'INJURY_RESERVE' || s === 'IR') return 'IR';
    if (s.startsWith('SUSPEN')) return 'SUSPENDED';
    return 'ACTIVE';
  }

  /** Normalise a playerPoolEntry-shaped object (roster entry's playerPoolEntry, or a kona_player_info item). */
  function parsePlayer(entry, ctx) {
    const pl = entry.player || {};
    const season = ctx.season, week = ctx.week;
    const stats = {};
    for (const s of pl.stats || []) {
      if (s.seasonId !== season) continue;
      stats[`${s.statSourceId}.${s.statSplitTypeId}.${s.scoringPeriodId}`] = s;
    }
    const seasonAct = stats['0.0.0'];
    const ros = stats['1.0.0'];
    const wk = stats[`1.1.${week}`];
    const recentWeeks = [];
    for (let w = week - 1; w >= 1 && recentWeeks.length < 3 && w >= week - 3; w--) {
      const s = stats[`0.1.${w}`];
      if (s && s.stats && Object.keys(s.stats).length) recentWeeks.push({ week: w, pts: num(s.appliedTotal) });
    }
    const seasonAvg = seasonAct ? num(seasonAct.appliedAverage) : 0;
    const seasonTotal = seasonAct ? num(seasonAct.appliedTotal) : 0;
    const own = pl.ownership || {};
    const posId = pl.defaultPositionId;
    return {
      id: pl.id != null ? pl.id : entry.id,
      name: pl.fullName || `${pl.firstName || ''} ${pl.lastName || ''}`.trim() || 'Unknown',
      posId, pos: POS[posId] || '?',
      proTeamId: pl.proTeamId, team: '',
      injury: normInjury(pl.injuryStatus),
      pctOwned: own.percentOwned != null ? own.percentOwned : null,
      pctStarted: own.percentStarted != null ? own.percentStarted : null,
      onTeamId: entry.onTeamId != null ? entry.onTeamId : null,
      status: entry.status || null, // FREEAGENT | WAIVERS | ONTEAM
      droppable: pl.droppable !== false,
      wkProj: wk ? num(wk.appliedTotal) : 0,
      rosPpg: ros ? num(ros.appliedAverage) : 0,
      rosTotal: ros ? num(ros.appliedTotal) : 0,
      seasonAvg, seasonTotal,
      games: seasonAvg > 0 ? Math.round(seasonTotal / seasonAvg) : 0,
      recentWeeks,
      recent: recentWeeks.length ? recentWeeks.reduce((a, b) => a + b.pts, 0) / recentWeeks.length : null,
      slotId: null,
    };
  }

  function parseTeams(json, ctx) {
    const members = {};
    for (const m of json.members || []) members[m.id] = m.displayName || `${m.firstName || ''} ${m.lastName || ''}`.trim();
    return (json.teams || []).map((t) => {
      const rec = (t.record && t.record.overall) || {};
      const roster = ((t.roster && t.roster.entries) || []).map((e) => {
        const p = parsePlayer(e.playerPoolEntry || { player: {}, id: e.playerId }, ctx);
        p.slotId = e.lineupSlotId;
        p.acquired = e.acquisitionType || null;
        if (p.onTeamId == null) p.onTeamId = t.id;
        return p;
      });
      return {
        id: t.id,
        name: t.name || (t.location ? `${t.location} ${t.nickname || ''}` : `Team ${t.id}`),
        abbrev: t.abbrev, logo: t.logo || null,
        owner: members[t.primaryOwner] || '',
        record: { w: num(rec.wins), l: num(rec.losses), t: num(rec.ties), pf: r1(num(rec.pointsFor)) },
        waiverRank: t.waiverRank,
        roster,
      };
    });
  }

  function parseFreeAgents(json, ctx) {
    return ((json && json.players) || []).map((e) => parsePlayer(e, ctx));
  }

  // -------------------------------------------------------------- value model
  function availability(p) { return AVAILABILITY[p.injury] != null ? AVAILABILITY[p.injury] : 1; }

  /** Blend of ESPN ROS projection, this week's projection, season average, recent form -> points per game. */
  function estimatePpg(p) {
    const parts = [];
    if (p.rosPpg > 0) parts.push({ key: 'ros', label: 'ESPN rest-of-season projection', v: p.rosPpg, w: MODEL_WEIGHTS.ros });
    if (p.wkProj > 0) parts.push({ key: 'week', label: "this week's projection", v: p.wkProj, w: MODEL_WEIGHTS.week });
    if (p.games > 0 && p.seasonAvg > 0) parts.push({ key: 'season', label: 'season average', v: p.seasonAvg, w: MODEL_WEIGHTS.season });
    if (p.recent != null && p.recent > 0) parts.push({ key: 'recent', label: 'last 3 weeks', v: p.recent, w: MODEL_WEIGHTS.recent });
    const wsum = parts.reduce((a, b) => a + b.w, 0);
    const ppg = wsum ? parts.reduce((a, b) => a + b.v * b.w, 0) / wsum : 0;
    return { ppg, parts };
  }

  function teamInfo(p, ctx) { return (ctx.schedule && ctx.schedule.teams[p.proTeamId]) || null; }
  function onBye(p, ctx, week) { const t = teamInfo(p, ctx); return !!(t && t.bye && t.bye === (week || ctx.week)); }

  function gamesLeft(p, ctx) {
    const t = teamInfo(p, ctx);
    const from = ctx.week, to = ctx.horizon;
    if (!t || !Object.keys(t.games).length) return Math.max(0, to - from + 1 - (t && t.bye >= from && t.bye <= to ? 1 : 0));
    let n = 0;
    for (let w = from; w <= to; w++) if (t.games[w]) n++;
    return n;
  }

  /** Mutates players: ppg, avail, games_left, ros (expected rest-of-season points), vorp, team abbrev. */
  function annotate(players, ctx) {
    for (const p of players) {
      const t = teamInfo(p, ctx);
      p.team = t ? t.abbrev : p.team || (p.posId === 16 ? '' : 'FA');
      p.bye = t ? t.bye : 0;
      p.ppg = estimatePpg(p).ppg;
      p.avail = availability(p);
      p.gamesLeft = gamesLeft(p, ctx);
      p.ros = p.ppg * p.avail * p.gamesLeft;
      const repl = (ctx.repl && ctx.repl[p.posId] != null ? ctx.repl[p.posId] : DEFAULT_REPLACEMENT[p.posId]) || 0;
      p.vorp = Math.max(0, p.ppg - repl) * p.avail * p.gamesLeft;
    }
    return players;
  }

  /** Replacement level per position = ppg of the 3rd-best healthy free agent (what you could actually pick up). */
  function computeReplacement(pool, k) {
    const out = Object.assign({}, DEFAULT_REPLACEMENT);
    const rank = k || 3;
    for (const posId of POS_IDS) {
      const list = pool.filter((p) => p.posId === posId && (p.injury === 'ACTIVE' || p.injury === 'QUESTIONABLE') && p.ppg > 0)
        .map((p) => p.ppg * p.avail).sort((a, b) => b - a);
      if (list.length) out[posId] = list[Math.min(rank, list.length) - 1];
    }
    return out;
  }

  /** Build the shared context object used by every analysis function. */
  function buildContext({ settings, schedule, pool }) {
    const ctx = {
      season: settings.season, week: settings.week, horizon: settings.finalWeek,
      schedule: schedule || { teams: {}, byAbbrev: {} }, settings, repl: null, nominalGames: 1,
    };
    const games = Object.values(ctx.schedule.teams).filter((t) => t.id).map((t) => gamesLeft({ proTeamId: t.id }, ctx));
    ctx.nominalGames = games.length ? Math.max(1, games.reduce((a, b) => a + b, 0) / games.length) : Math.max(1, ctx.horizon - ctx.week + 1);
    if (pool && pool.length) { annotate(pool, ctx); ctx.repl = computeReplacement(pool); }
    return ctx;
  }

  // ------------------------------------------------------------------ lineups
  function starterSlots(slotCounts) {
    const out = [];
    for (const id of SLOT_ORDER) {
      if (NON_STARTER_SLOTS.includes(id)) continue;
      for (let i = 0; i < (slotCounts[id] || 0); i++) out.push(id);
    }
    return out;
  }
  const slotAccepts = (slotId, posId) => (SLOT_POS[slotId] || []).includes(posId);

  /** Optimal assignment of players to starting slots maximising sum(scoreFn). IR-status players can't start. */
  function bestLineup(players, slots, scoreFn) {
    const S = slots.length;
    const accept = {};
    for (const pid of POS_IDS) accept[pid] = slots.filter((s) => slotAccepts(s, pid)).length;
    const cand = [];
    for (const pid of POS_IDS) {
      if (!accept[pid]) continue;
      players.filter((p) => p.posId === pid && p.injury !== 'IR')
        .map((p) => ({ p, s: scoreFn(p) })).sort((a, b) => b.s - a.s).slice(0, accept[pid]).forEach((c) => cand.push(c));
    }
    const N = cand.length, M = 1 << S;
    const dp = [], pick = [];
    for (let i = 0; i <= N; i++) dp.push(new Float64Array(M).fill(-Infinity));
    for (let i = 0; i < N; i++) pick.push(new Int8Array(M).fill(-2));
    dp[0][0] = 0;
    for (let i = 0; i < N; i++) {
      const c = cand[i];
      for (let mask = 0; mask < M; mask++) {
        const cur = dp[i][mask];
        if (cur === -Infinity) continue;
        if (cur > dp[i + 1][mask]) { dp[i + 1][mask] = cur; pick[i][mask] = -1; }
        for (let s = 0; s < S; s++) {
          if (mask & (1 << s) || !slotAccepts(slots[s], c.p.posId)) continue;
          const nm = mask | (1 << s), v = cur + c.s;
          if (v > dp[i + 1][nm]) { dp[i + 1][nm] = v; pick[i][nm] = s; }
        }
      }
    }
    let bm = 0;
    for (let m = 0; m < M; m++) if (dp[N][m] > dp[N][bm]) bm = m;
    const total = dp[N][bm];
    const assign = slots.map((slotId) => ({ slotId, player: null, score: 0 }));
    let mask = bm;
    for (let i = N - 1; i >= 0; i--) {
      const pk = pick[i][mask];
      if (pk === -1 || pk === -2) continue;
      assign[pk].player = cand[i].p; assign[pk].score = cand[i].s;
      mask ^= 1 << pk;
    }
    return { total: total === -Infinity ? 0 : total, assign };
  }

  function replacementPlayers(slots, ctx) {
    const out = [];
    for (const pid of POS_IDS) {
      const n = slots.filter((s) => slotAccepts(s, pid)).length;
      for (let i = 0; i < n; i++) {
        const ppg = (ctx.repl && ctx.repl[pid] != null ? ctx.repl[pid] : DEFAULT_REPLACEMENT[pid]) || 0;
        out.push({ id: `repl-${pid}-${i}`, virtual: true, name: `Waiver-level ${POS[pid]}`, posId: pid, pos: POS[pid], injury: 'ACTIVE', ppg, avail: 1, gamesLeft: ctx.nominalGames, ros: ppg * ctx.nominalGames, vorp: 0, team: '' });
      }
    }
    return out;
  }

  /** Full value of a roster: optimal-starting-lineup ROS points (holes filled with waiver-level players) + a small depth credit. */
  function rosterValue(players, ctx, opts) {
    const useRepl = !opts || opts.replacement !== false;
    const slots = starterSlots(ctx.settings.slotCounts);
    const pool = players.filter((p) => !p.virtual);
    const lineup = bestLineup(useRepl ? pool.concat(replacementPlayers(slots, ctx)) : pool, slots, (p) => p.ros);
    const used = new Set(lineup.assign.filter((a) => a.player).map((a) => a.player.id));
    const bench = pool.filter((p) => !used.has(p.id) && p.injury !== 'IR').sort((a, b) => b.vorp - a.vorp).slice(0, 3);
    const depth = DEPTH_CREDIT * bench.reduce((a, p) => a + p.vorp, 0);
    const perPos = {};
    for (const a of lineup.assign) if (a.player) perPos[a.player.posId] = (perPos[a.player.posId] || 0) + a.player.ppg * a.player.avail;
    return { total: lineup.total + depth, lineupTotal: lineup.total, depth, assign: lineup.assign, usedIds: used, perPos, bench };
  }

  // -------------------------------------------------------------- lineup check
  const riskMult = (p, ctx) => {
    if (onBye(p, ctx)) return 0;
    if (p.injury === 'OUT' || p.injury === 'IR' || p.injury === 'SUSPENDED') return 0;
    if (p.injury === 'DOUBTFUL') return 0.6;
    if (p.injury === 'QUESTIONABLE') return 0.95;
    return 1;
  };
  /** This week's expected points: ESPN projection if present, else ppg; then risk-adjusted. */
  function weekScore(p, ctx, raw) {
    if (onBye(p, ctx)) return 0;
    let base = p.wkProj > 0 ? p.wkProj : (p.injury === 'ACTIVE' || p.injury === 'QUESTIONABLE' ? p.ppg : 0);
    if (!raw) base *= riskMult(p, ctx);
    return base;
  }

  function lineupCheck(roster, ctx) {
    const slots = starterSlots(ctx.settings.slotCounts);
    const isStarter = (p) => p.slotId != null && !NON_STARTER_SLOTS.includes(p.slotId);
    const starters = roster.filter(isStarter);
    const flags = [];
    for (const p of starters) {
      const issues = [];
      if (onBye(p, ctx)) issues.push({ level: 'bad', code: 'BYE', text: `${p.team} is on bye in Week ${ctx.week}` });
      if (p.injury === 'OUT') issues.push({ level: 'bad', code: 'OUT', text: 'Listed OUT' });
      else if (p.injury === 'IR') issues.push({ level: 'bad', code: 'IR', text: 'On injured reserve' });
      else if (p.injury === 'SUSPENDED') issues.push({ level: 'bad', code: 'SUSP', text: 'Suspended' });
      else if (p.injury === 'DOUBTFUL') issues.push({ level: 'bad', code: 'DOUBTFUL', text: 'Doubtful — treat as out' });
      else if (p.injury === 'QUESTIONABLE') issues.push({ level: 'warn', code: 'QUESTIONABLE', text: 'Questionable — check status before kickoff' });
      if (!onBye(p, ctx) && p.injury === 'ACTIVE' && p.wkProj === 0 && p.ppg > 0) issues.push({ level: 'warn', code: 'NOPROJ', text: 'ESPN has no projection this week' });
      if (issues.length) flags.push({ player: p, issues });
    }
    // optimal lineup under risk-adjusted projections; tiny bonus keeps current starters on ties
    const cur = new Set(starters.map((p) => p.id));
    const optimal = bestLineup(roster, slots, (p) => weekScore(p, ctx) + (cur.has(p.id) ? 0.001 : 0));
    // current assignment by slot (use ESPN's slotId, matching distinct slots in order)
    const curBySlot = {};
    for (const p of starters) (curBySlot[p.slotId] = curBySlot[p.slotId] || []).push(p);
    const moves = [];
    const usedCur = new Set();
    const optIds = new Set(optimal.assign.filter((a) => a.player).map((a) => a.player.id));
    const benched = starters.filter((p) => !optIds.has(p.id)).sort((a, b) => weekScore(a, ctx) - weekScore(b, ctx));
    const promoted = optimal.assign.filter((a) => a.player && !cur.has(a.player.id)).map((a) => a);
    // pair each promoted player with a benched starter in a slot they can fill (best gain first)
    for (const a of promoted.sort((x, y) => weekScore(y.player, ctx) - weekScore(x.player, ctx))) {
      const outP = benched.filter((b) => !usedCur.has(b.id)).find((b) => slotAccepts(b.slotId, a.player.posId)) || benched.find((b) => !usedCur.has(b.id));
      if (!outP) { moves.push({ slotId: a.slotId, slotName: SLOT_NAMES[a.slotId], out: null, in: a.player, gain: weekScore(a.player, ctx), reason: 'Open starting slot' }); continue; }
      usedCur.add(outP.id);
      const inS = weekScore(a.player, ctx), outS = weekScore(outP, ctx);
      const fl = flags.find((f) => f.player.id === outP.id);
      const bad = fl && fl.issues.find((i) => i.level === 'bad');
      let reason;
      if (bad) reason = `${outP.name}: ${bad.text.toLowerCase()}`;
      else if (fl) reason = `${outP.name} is ${fl.issues[0].code === 'QUESTIONABLE' ? 'questionable' : 'a risk'} and ${a.player.name} projects ${r1(inS - outS)} more`;
      else reason = `${a.player.name} projects ${r1(inS)} vs ${r1(outS)} for ${outP.name}`;
      const gain = inS - outS;
      if (gain >= 0.75 || bad) moves.push({ slotId: outP.slotId, slotName: SLOT_NAMES[outP.slotId] || '', out: outP, in: a.player, gain, reason });
      if (gain >= 2 && !flags.find((f) => f.player.id === outP.id)) flags.push({ player: outP, issues: [{ level: 'warn', code: 'BENCHBETTER', text: `Projected ${r1(gain)} below ${a.player.name} on your bench` }] });
    }
    moves.sort((a, b) => b.gain - a.gain);
    const curTotal = starters.reduce((a, p) => a + weekScore(p, ctx), 0);
    const emptySlots = slots.length - starters.length;
    const bad = flags.reduce((a, f) => a + f.issues.filter((i) => i.level === 'bad').length, 0);
    const warn = flags.reduce((a, f) => a + f.issues.filter((i) => i.level === 'warn').length, 0);
    return {
      flags, moves, currentTotal: curTotal, optimalTotal: optimal.total,
      gain: Math.max(0, optimal.total - curTotal), emptySlots: Math.max(0, emptySlots),
      jinx: clamp(bad * 22 + warn * 8 + Math.max(0, emptySlots) * 15, 0, 100),
    };
  }

  function jinxLabel(j) { return j >= 66 ? 'Red alert' : j >= 33 ? 'Coverage issues' : j > 0 ? 'Watch the film' : 'All clear'; }

  // -------------------------------------------------------------------- trades
  function sideEval(before, after, ctx) {
    const b = rosterValue(before, ctx), a = rosterValue(after, ctx);
    const posDelta = {};
    for (const pid of POS_IDS) { const d = (a.perPos[pid] || 0) - (b.perPos[pid] || 0); if (Math.abs(d) > 0.05) posDelta[pid] = d; }
    return { before: b, after: a, delta: a.total - b.total, perWeek: (a.total - b.total) / ctx.nominalGames, posDelta };
  }
  const verdictFor = (perWeek) => perWeek >= 1.2
    ? { key: 'approve', label: 'Ice up, son', emoji: '🧊' }
    : perWeek >= 0.4 ? { key: 'edge', label: 'Keep pounding', emoji: '🏈' }
      : perWeek <= -1.2 ? { key: 'jinx', label: 'Fumble', emoji: '😬' }
        : perWeek <= -0.4 ? { key: 'cursed', label: 'Shaky intel', emoji: '📡' }
          : { key: 'wash', label: 'Dead even', emoji: '🤝' };

  function evaluateTrade({ mine, theirs, give, get, ctx, brief }) {
    const giveP = mine.filter((p) => give.includes(p.id)), getP = theirs.filter((p) => get.includes(p.id));
    const meAfter = mine.filter((p) => !give.includes(p.id)).concat(getP);
    const themAfter = theirs.filter((p) => !get.includes(p.id)).concat(giveP);
    const me = sideEval(mine, meAfter, ctx), them = sideEval(theirs, themAfter, ctx);
    const sum = (arr, f) => arr.reduce((a, p) => a + f(p), 0);
    const asset = { give: sum(giveP, (p) => p.vorp), get: sum(getP, (p) => p.vorp) };
    asset.delta = asset.get - asset.give;
    const verdict = verdictFor(me.perWeek);
    const acceptance = them.perWeek >= -0.4 ? 'likely' : them.perWeek >= -1.5 ? 'maybe' : 'unlikely';
    const jinx = clamp(Math.round(50 - me.perWeek * 16), 0, 100);
    const res = { giveP, getP, me, them, asset, verdict, acceptance, jinx, netPerWeek: me.perWeek };
    if (!brief) res.reasons = tradeReasons(res, ctx);
    return res;
  }

  function tradeReasons(r, ctx) {
    const out = [];
    const pw = r.me.perWeek;
    out.push({ tone: pw >= 0.4 ? 'good' : pw <= -0.4 ? 'bad' : 'meh', text: `Your best-lineup value moves ${pw >= 0 ? '+' : ''}${r1(r.me.delta)} pts rest-of-season (about ${pw >= 0 ? '+' : ''}${r1(pw)} per week).` });
    const parts = Object.entries(r.me.posDelta).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).filter(([, d]) => Math.abs(d) >= 0.4)
      .map(([pid, d]) => `${POS[pid]} ${d > 0 ? '+' : ''}${r1(d)}/wk`);
    if (parts.length) out.push({ tone: 'meh', text: `Where it shows up in your starting lineup: ${parts.join(', ')}.` });
    else out.push({ tone: 'meh', text: 'Your starting lineup barely changes — this is mostly a bench shuffle.' });
    for (const p of r.getP) {
      if (p.injury !== 'ACTIVE') out.push({ tone: 'bad', text: `${p.name} is listed ${p.injury === 'IR' ? 'on IR' : p.injury}. Value is discounted ×${p.avail} — make sure you can wait.` });
      const bye = p.bye;
      if (bye && bye >= ctx.week && bye <= ctx.horizon) out.push({ tone: 'meh', text: `${p.name} (${p.team}) has a Week ${bye} bye still to come.` });
      if (p.recent != null && p.seasonAvg > 0 && p.recent >= p.seasonAvg * 1.25) out.push({ tone: 'good', text: `${p.name} is running hot: ${r1(p.recent)} ppg ${recentLabel(p)} vs ${r1(p.seasonAvg)} on the year.` });
      if (p.recent != null && p.seasonAvg > 0 && p.recent <= p.seasonAvg * 0.7) out.push({ tone: 'meh', text: `${p.name} has cooled off: ${r1(p.recent)} ppg lately vs ${r1(p.seasonAvg)} on the year.` });
    }
    const best = r.giveP.slice().sort((a, b) => b.ros - a.ros)[0];
    if (best && r.getP.length && best.ros > Math.max(...r.getP.map((p) => p.ros)) * 1.25) out.push({ tone: 'meh', text: `You're sending out your most valuable piece (${best.name}, ~${r1(best.ppg)} ppg).` });
    if (r.getP.length > r.giveP.length) out.push({ tone: 'meh', text: `You get ${r.getP.length} for ${r.giveP.length}, so you'll need to drop ${r.getP.length - r.giveP.length} player(s) to stay under the roster limit.` });
    if (r.giveP.length > r.getP.length) out.push({ tone: 'meh', text: `You send ${r.giveP.length} for ${r.getP.length}, so you'll have an open roster spot to fill from waivers.` });
    const tpw = r.them.perWeek;
    if (r.acceptance === 'likely') out.push({ tone: 'good', text: `They come out ${tpw >= 0 ? 'ahead' : 'about even'} (${tpw >= 0 ? '+' : ''}${r1(tpw)}/wk), so this one is easy to sell.` });
    else if (r.acceptance === 'maybe') out.push({ tone: 'meh', text: `They give up ${r1(-tpw)} pts/wk of lineup value — they'll need a nudge.` });
    else out.push({ tone: 'bad', text: `They'd lose ${r1(-tpw)} pts/wk — lopsided in your favor, so expect a decline.` });
    out.push({ tone: 'meh', text: `Empty starting spots are assumed filled by a waiver-level player (QB ${r1(ctx.repl ? ctx.repl[1] : DEFAULT_REPLACEMENT[1])}, RB ${r1(ctx.repl ? ctx.repl[2] : DEFAULT_REPLACEMENT[2])}, WR ${r1(ctx.repl ? ctx.repl[3] : DEFAULT_REPLACEMENT[3])}, TE ${r1(ctx.repl ? ctx.repl[4] : DEFAULT_REPLACEMENT[4])} ppg).` });
    return out;
  }

  // ------------------------------------------------------------- trade ideas
  function starterCount(slotCounts, posId) {
    let k = 0;
    for (const [id, n] of Object.entries(slotCounts)) {
      const ps = SLOT_POS[id];
      if (!ps || !ps.includes(posId)) continue;
      k += n / ps.length;
    }
    return Math.max(1, Math.round(k));
  }

  function positionalProfile(teams, ctx) {
    const prof = {};
    for (const t of teams) {
      prof[t.id] = {};
      for (const pid of POS_IDS) {
        const k = starterCount(ctx.settings.slotCounts, pid);
        if (!starterSlots(ctx.settings.slotCounts).some((s) => slotAccepts(s, pid))) continue;
        const list = t.roster.filter((p) => p.posId === pid && p.injury !== 'IR').sort((a, b) => b.ppg * b.avail - a.ppg * a.avail);
        const strength = list.slice(0, k).reduce((a, p) => a + p.ppg * p.avail, 0);
        const repl = (ctx.repl && ctx.repl[pid] != null ? ctx.repl[pid] : DEFAULT_REPLACEMENT[pid]) || 0;
        const surplus = list.slice(k).filter((p) => p.ppg * p.avail >= repl + 1.5);
        prof[t.id][pid] = { strength, k, surplus, avg: strength / k };
      }
    }
    const positions = {};
    for (const pid of POS_IDS) {
      const vals = teams.map((t) => ({ id: t.id, s: prof[t.id][pid] && prof[t.id][pid].strength })).filter((x) => x.s != null).sort((a, b) => b.s - a.s);
      if (!vals.length) continue;
      const mean = vals.reduce((a, b) => a + b.s, 0) / vals.length;
      vals.forEach((v, i) => { prof[v.id][pid].rank = i + 1; prof[v.id][pid].leagueMean = mean; prof[v.id][pid].n = vals.length; });
      positions[pid] = mean;
    }
    for (const t of teams) for (const pid of Object.keys(prof[t.id])) {
      const x = prof[t.id][pid];
      const third = x.n / 3;
      x.label = x.rank <= Math.max(1, Math.ceil(third)) && x.strength >= x.leagueMean ? 'strength' : x.rank > x.n - Math.max(1, Math.ceil(third)) && x.strength < x.leagueMean ? 'need' : 'solid';
      if (x.label === 'solid' && x.surplus.length) x.label = 'surplus';
    }
    return prof;
  }

  /** Propose balanced, plausible trades that improve my lineup without crushing the other side. */
  function proposeTrades({ myTeam, teams, ctx, max }) {
    const limit = max || 5;
    const profile = positionalProfile(teams, ctx);
    const mine = myTeam.roster;
    const tradable = (p) => p.injury !== 'IR' && p.ros > 0 && p.posId !== 5 && p.posId !== 16;
    const myCands = mine.filter(tradable).sort((a, b) => b.ros - a.ros).slice(0, 9);
    const all = [];
    for (const t of teams) {
      if (t.id === myTeam.id) continue;
      const theirCands = t.roster.filter((p) => tradable(p) && p.injury !== 'OUT').sort((a, b) => b.ros - a.ros).slice(0, 9);
      const sets = [];
      for (const g of myCands) for (const x of theirCands) {
        if (g.posId === x.posId && Math.abs(g.ros - x.ros) < 1) continue;
        sets.push({ give: [g.id], get: [x.id] });
      }
      const top = (arr) => arr.slice(0, 5);
      const mp = top(myCands), tp = top(theirCands);
      for (let i = 0; i < mp.length; i++) for (let j = i + 1; j < mp.length; j++) for (const x of tp) sets.push({ give: [mp[i].id, mp[j].id], get: [x.id] });
      for (let i = 0; i < tp.length; i++) for (let j = i + 1; j < tp.length; j++) for (const g of mp) sets.push({ give: [g.id], get: [tp[i].id, tp[j].id] });
      for (const s of sets) {
        const r = evaluateTrade({ mine, theirs: t.roster, give: s.give, get: s.get, ctx, brief: true });
        if (r.me.perWeek < 0.25 || r.them.perWeek < -1.2) continue;
        // prefer win-win: reward my gain, lightly reward their gain, punish their loss
        const score = r.me.perWeek + 0.6 * Math.min(r.them.perWeek, 1.5) + (r.them.perWeek < 0 ? 0.8 * r.them.perWeek : 0);
        all.push({ team: t, give: s.give, get: s.get, r, score });
      }
    }
    all.sort((a, b) => b.score - a.score);
    const picked = [], usedMine = new Set(), usedTheirs = new Set(), perTeam = {};
    const take = (c) => {
      c.give.forEach((id) => usedMine.add(id)); c.get.forEach((id) => usedTheirs.add(id));
      perTeam[c.team.id] = (perTeam[c.team.id] || 0) + 1;
      const full = evaluateTrade({ mine, theirs: c.team.roster, give: c.give, get: c.get, ctx });
      full.why = ideaWhy(full, profile, myTeam, c.team, ctx);
      picked.push({ team: c.team, give: c.give, get: c.get, result: full, score: c.score });
    };
    const free = (c) => !c.give.some((id) => usedMine.has(id)) && !c.get.some((id) => usedTheirs.has(id));
    // pass 1: at most 2 per partner; pass 2 (if we still have fewer than limit): relax the per-partner cap
    for (const cap of [2, 99]) {
      for (const c of all) {
        if (picked.length >= limit) break;
        if ((perTeam[c.team.id] || 0) >= cap || !free(c)) continue;
        take(c);
      }
    }
    return { profile, ideas: picked };
  }

  function ideaWhy(r, profile, myTeam, other, ctx) {
    const out = [];
    const getPos = [...new Set(r.getP.map((p) => p.posId))], givePos = [...new Set(r.giveP.map((p) => p.posId))];
    for (const pid of getPos) {
      const me = profile[myTeam.id][pid], them = profile[other.id][pid];
      if (me && me.label === 'need') out.push(`You're thin at ${POS[pid]} (rank ${me.rank}/${me.n} in the league).`);
      if (them && (them.label === 'surplus' || them.label === 'strength')) out.push(`${other.name}: stacked at ${POS[pid]}.`);
    }
    for (const p of r.giveP) {
      const repl = ctx.repl && ctx.repl[p.posId];
      if (repl && p.ppg * p.avail <= repl * 1.1) out.push(`${p.name} is easy to replace: free agents at ${POS[p.posId]} average ~${r1(repl)} ppg, so losing him costs little.`);
    }
    for (const pid of givePos) {
      const me = profile[myTeam.id][pid], them = profile[other.id][pid];
      if (me && me.surplus.length) out.push(`You have spare ${POS[pid]} depth to move (${me.surplus.map((p) => p.name).join(', ')}).`);
      if (them && them.label === 'need') out.push(`${other.name}: could use ${POS[pid]} help (rank ${them.rank}/${them.n}).`);
    }
    return [...new Set(out)];
  }

  // ------------------------------------------------------------------- waivers
  function rankFreeAgents(pool, ctx, posId) {
    return pool.filter((p) => !posId || p.posId === posId).sort((a, b) => b.ros - a.ros);
  }

  function benchInsurance(players, usedIds) {
    return DEPTH_CREDIT * 0.5 * players.filter((p) => !usedIds.has(p.id) && p.injury !== 'IR').sort((a, b) => b.vorp - a.vorp).slice(0, 3).reduce((a, p) => a + p.vorp, 0);
  }
  const waiverValue = (players, ctx) => { const v = rosterValue(players, ctx, { replacement: false }); return v.lineupTotal + benchInsurance(players, v.usedIds); };

  /** Suggest add/drop pairs. Greedy: apply the best pair, then re-evaluate. */
  function proposeAddDrops({ roster, pool, ctx, max }) {
    const limit = max || 4;
    let cur = roster.slice();
    const avail = pool.filter((p) => p.ros > 0 && p.injury !== 'IR' && p.injury !== 'OUT' && p.injury !== 'SUSPENDED').slice(0, 60);
    const used = new Set();
    const out = [];
    for (let n = 0; n < limit; n++) {
      const base = waiverValue(cur, ctx);
      const bv = rosterValue(cur, ctx, { replacement: false });
      const drops = cur.filter((p) => !bv.usedIds.has(p.id) && p.droppable !== false).sort((a, b) => a.ros - b.ros).slice(0, 5);
      let best = null;
      for (const f of avail) {
        if (used.has(f.id)) continue;
        // a pickup is only a candidate if it beats someone droppable or fills a hole
        for (const d of drops.length ? drops : [null]) {
          const next = cur.filter((p) => !d || p.id !== d.id).concat([f]);
          const delta = waiverValue(next, ctx) - base;
          if (!best || delta > best.delta) best = { f, d, delta, next };
        }
      }
      if (!best || best.delta / ctx.nominalGames < 0.5) break;
      used.add(best.f.id);
      const after = rosterValue(best.next, ctx, { replacement: false });
      out.push({ add: best.f, drop: best.d, delta: best.delta, perWeek: best.delta / ctx.nominalGames, starts: after.usedIds.has(best.f.id), reasons: addDropReasons(best, bv, after, cur, ctx) });
      cur = best.next;
    }
    return out;
  }

  function addDropReasons(best, before, after, roster, ctx) {
    const { f, d } = best;
    const out = [];
    const slot = after.assign.find((a) => a.player && a.player.id === f.id);
    if (slot) {
      const prev = before.assign.find((a) => a.slotId === slot.slotId && a.player && a.player.id !== f.id);
      const replaced = roster.find((p) => !after.usedIds.has(p.id) && before.usedIds.has(p.id));
      if (!before.assign.some((a) => a.slotId === slot.slotId && a.player)) out.push(`Fills an empty ${SLOT_NAMES[slot.slotId]} spot in your lineup.`);
      else if (replaced) out.push(`Would start at ${SLOT_NAMES[slot.slotId]} over ${replaced.name} (${r1(replaced.ppg * replaced.avail)} → ${r1(f.ppg * f.avail)} ppg).`);
      else if (prev) out.push(`Upgrades your ${SLOT_NAMES[slot.slotId]} slot.`);
    } else out.push('Bench depth: better insurance than the player you drop.');
    const hurt = roster.filter((p) => before.usedIds.has(p.id) && (p.injury === 'OUT' || p.injury === 'IR'));
    if (hurt.some((p) => p.posId === f.posId)) out.push(`Covers for ${hurt.find((p) => p.posId === f.posId).name} (${hurt.find((p) => p.posId === f.posId).injury}).`);
    if (f.recent != null && f.seasonAvg > 0 && f.recent >= f.seasonAvg * 1.25) out.push(`Hot hand: ${r1(f.recent)} ppg ${recentLabel(f)} vs ${r1(f.seasonAvg)} on the year.`);
    if (f.pctOwned != null) out.push(`${r1(f.pctOwned)}% owned across ESPN.`);
    if (d) out.push(`Drop ${d.name}: your lowest-value droppable ${d.pos} (~${r1(d.ppg * d.avail)} ppg${d.injury !== 'ACTIVE' ? ', ' + d.injury : ''}).`);
    else out.push('You have an open roster spot — no drop needed.');
    out.push(f.status === 'WAIVERS' ? 'On WAIVERS — submit a claim; it processes on ESPN\'s next waiver run.' : 'Free agent — can be added instantly.');
    return out;
  }

  // ----------------------------------------------------------------- reminders
  const ET = 'America/New_York';
  function etParts(date) {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: ET, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' });
    const o = {};
    for (const p of f.formatToParts(date)) o[p.type] = p.value;
    return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour % 24, min: +o.minute, wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(o.weekday) };
  }
  /** First ET calendar date (>= now) falling on weekday `wd` (0=Sun) whose time `hour` hasn't passed yet. */
  function nextEtDate(now, wd, hour) {
    const p = etParts(now);
    let delta = (wd - p.wd + 7) % 7;
    if (delta === 0 && p.h >= hour) delta = 7;
    const d = new Date(Date.UTC(p.y, p.m - 1, p.d + delta));
    return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  }
  function foldLine(line) {
    const out = [];
    let s = line;
    while (s.length > 74) { out.push(s.slice(0, 74)); s = ' ' + s.slice(74); }
    out.push(s);
    return out.join('\r\n');
  }
  const icsEscape = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');

  function buildIcs({ leagueName, leagueId, now, appUrl, until }) {
    const n = now || new Date();
    const stamp = n.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const untilUtc = until || '20270110T160000Z'; // Sun Jan 10 2027 11:00 AM ET = 16:00Z, inclusive
    const events = [
      { key: 'thu', wd: 4, hour: 18, title: 'Mission briefing: Thursday Night', desc: 'Thursday Night Football kicks off soon. Check injuries and lock your lineup.' },
      { key: 'sun', wd: 0, hour: 11, title: 'Mission briefing: Sunday lock', desc: 'Early games kick off at 1 PM ET. Final lineup check: questionable players, byes, and bench swaps.' },
    ];
    const lines = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Agent 89//Fantasy Lineup Reminders//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      'X-WR-CALNAME:Agent 89 lineup reminders', 'X-WR-TIMEZONE:America/New_York',
      'BEGIN:VTIMEZONE', 'TZID:America/New_York', 'X-LIC-LOCATION:America/New_York',
      'BEGIN:DAYLIGHT', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400', 'TZNAME:EDT', 'DTSTART:19700308T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'END:DAYLIGHT',
      'BEGIN:STANDARD', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'TZNAME:EST', 'DTSTART:19701101T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'END:STANDARD',
      'END:VTIMEZONE',
    ];
    for (const e of events) {
      const date = nextEtDate(n, e.wd, e.hour);
      const hh = String(e.hour).padStart(2, '0');
      lines.push(
        'BEGIN:VEVENT',
        `UID:lucky-socks-${e.key}-${leagueId || 'all'}@ourhootshouse.github.io`,
        `DTSTAMP:${stamp}`,
        `DTSTART;TZID=America/New_York:${date}T${hh}0000`,
        `DTEND;TZID=America/New_York:${date}T${hh}1500`,
        `RRULE:FREQ=WEEKLY;UNTIL=${untilUtc}`,
        `SUMMARY:${icsEscape('📋 ' + e.title + (leagueName ? ' — ' + leagueName : ''))}`,
        `DESCRIPTION:${icsEscape(e.desc + (appUrl ? '\n\nOpen Agent 89: ' + appUrl : ''))}`,
        'STATUS:CONFIRMED', 'TRANSP:TRANSPARENT',
        'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEscape('Mission briefing: set your fantasy lineup.')}`, 'TRIGGER:PT0M', 'END:VALARM',
        'END:VEVENT'
      );
    }
    lines.push('END:VCALENDAR');
    return lines.map(foldLine).join('\r\n') + '\r\n';
  }

  // ---------------------------------------------------------------- scouting briefings (exported as SUPERSTITIONS for compatibility)
  const SUPERSTITIONS = [
    { emoji: '🕵️', title: 'Agent 89', tip: 'The best GMs treat Sunday like a scouting trip: film first, feelings later.', advice: 'Real advice: check injury reports Sunday morning before you lock the lineup.' },
    { emoji: '🧊', title: 'Ice up, son', tip: 'After a big win, stay cool. Don\'t spend next week\'s waiver on a celebration dart throw.', advice: 'Real advice: stream kickers and defenses week to week; don\'t hoard them out of loyalty.' },
    { emoji: '🏈', title: 'The Helmet Catch', tip: 'A play isn\'t over until the whistle. Neither is your Monday night flex.', advice: 'Real advice: if you are down, your last flexible move is a late-game starter swap on Monday.' },
    { emoji: '💙', title: 'Keep Pounding', tip: 'Same process every week. The boring GMs are the ones lifting the trophy.', advice: 'Real advice: set a calendar reminder so you check the lineup Thursday and again before Sunday kickoff.' },
    { emoji: '🗂️', title: 'The Dossier', tip: 'Write the matchup down before you accept a trade. Ink beats vibes.', advice: 'Real advice: trade for rest-of-season value, not last week\'s box score.' },
    { emoji: '🎯', title: 'Protect the Pocket', tip: 'Don\'t trade away your only startable QB unless the return is a true difference-maker.', advice: 'Real advice: a hole at a thin position hurts more than surplus at a deep one.' },
    { emoji: '📺', title: 'Monday Night Nerve', tip: 'Never assume a 40-point lead survives a late kickoff.', advice: 'Real advice: players on a bye or OUT score zero. Check them first.' },
    { emoji: '🧤', title: 'Handcuff Protocol', tip: 'If your RB1 is your season, his backup belongs on your bench, not the wire.', advice: 'Real advice: keep a handcuff or a strong bench RB for the day he is not healthy.' },
    { emoji: '📡', title: 'Waiver Deadline', tip: 'Claims are won in the quiet hours, not after the group chat explodes.', advice: 'Real advice: waiver claims run on a schedule — claim before the deadline, not after the drama.' },
    { emoji: '📋', title: 'Flex the Highest Upside', tip: 'The flex is not a participation trophy. Start the leftover with the best path to points.', advice: 'Real advice: your flex should be your highest-upside leftover, not the last guy you thought of.' },
    { emoji: '😌', title: 'Eli Face', tip: 'One bad quarter does not end a career. Take a breath, then watch the film.', advice: 'Real advice: compare rest-of-season projections before you fire off a revenge trade.' },
    { emoji: '📍', title: 'Mission Briefing', tip: 'Thursday night is your first checkpoint, Sunday morning is your last.', advice: 'Real advice: do your lineup check Thursday and again before Sunday kickoff.' },
  ];
  function pickSuperstition(rng) { const r = (rng || Math.random)(); return SUPERSTITIONS[Math.floor(r * SUPERSTITIONS.length) % SUPERSTITIONS.length]; }

  // ------------------------------------------------------------------- helpers
  function groupRoster(roster) {
    const rank = (p) => { const i = SLOT_ORDER.indexOf(p.slotId); return i < 0 ? 99 : i; };
    const sorted = roster.slice().sort((a, b) => rank(a) - rank(b) || b.ppg - a.ppg);
    return {
      starters: sorted.filter((p) => !NON_STARTER_SLOTS.includes(p.slotId)),
      bench: sorted.filter((p) => p.slotId === 20 || p.slotId === 24),
      ir: sorted.filter((p) => p.slotId === 21),
    };
  }

  return {
    POS, POS_IDS, SLOT_NAMES, SLOT_POS, SLOT_ORDER, NON_STARTER_SLOTS, AVAILABILITY, DEFAULT_REPLACEMENT, MODEL_WEIGHTS, SUPERSTITIONS,
    parseLeagueInput, normalizeSwid, normalizeS2, maskSecret,
    leaguePath, schedulePath, playersFilter, currentSeason,
    parseProTeams, parseSettings, parsePlayer, parseTeams, parseFreeAgents, normInjury,
    estimatePpg, availability, gamesLeft, annotate, computeReplacement, buildContext, onBye,
    starterSlots, bestLineup, rosterValue, weekScore, lineupCheck, jinxLabel,
    evaluateTrade, verdictFor, positionalProfile, starterCount, proposeTrades,
    rankFreeAgents, proposeAddDrops, waiverValue,
    nextEtDate, buildIcs, pickSuperstition, groupRoster, r1, clamp,
  };
});
