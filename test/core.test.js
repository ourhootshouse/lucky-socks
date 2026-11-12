'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core.js');
const league = require('./fixtures/league.json');
const proTeamsJson = require('./fixtures/proTeams.json');
const faRb = require('./fixtures/fa-rb.json');

// ---------------------------------------------------------------- synthetic helpers
function mkSchedule() {
  const teams = {};
  for (let id = 1; id <= 6; id++) {
    const bye = id === 2 ? 10 : id === 3 ? 12 : 5;
    const games = {};
    for (let w = 1; w <= 17; w++) if (w !== bye) games[w] = { opp: 1, home: true };
    teams[id] = { id, abbrev: 'T' + id, bye, games };
  }
  return { teams, byAbbrev: {} };
}
const SLOTS = { 0: 1, 2: 2, 4: 2, 6: 1, 23: 1, 16: 1, 17: 1, 20: 6, 21: 1 };
function mkCtx(extra) {
  const settings = { season: 2026, week: 10, finalWeek: 17, slotCounts: SLOTS, name: 'Test' };
  return C.buildContext(Object.assign({ settings, schedule: mkSchedule(), pool: null }, extra || {}));
}
let uid = 0;
function mk(name, posId, ppg, o) {
  o = o || {};
  return { id: ++uid, name, posId, pos: C.POS[posId], proTeamId: o.team || 1, injury: o.injury || 'ACTIVE', rosPpg: ppg, wkProj: o.wk != null ? o.wk : ppg,
    seasonAvg: 0, games: 0, recent: null, recentWeeks: [], droppable: o.droppable !== false, slotId: o.slot != null ? o.slot : 20, status: o.status || null, pctOwned: 50 };
}
function mkRoster(ctx, spec) { const r = spec.map((s) => mk(...s)); C.annotate(r, ctx); return r; }
const stdRoster = (ctx, over) => mkRoster(ctx, [
  ['QB1', 1, 20, { slot: 0 }], ['RB1', 2, 18, { slot: 2 }], ['RB2', 2, 12, { slot: 2 }], ['WR1', 3, 17, { slot: 4 }], ['WR2', 3, 11, { slot: 4 }],
  ['TE1', 4, 9, { slot: 6 }], ['WR3', 3, 10, { slot: 23 }], ['DST1', 16, 7, { slot: 16 }], ['K1', 5, 8, { slot: 17 }],
  ['RB3', 2, 8, {}], ['WR4', 3, 7, {}],
].concat(over || []));

// ---------------------------------------------------------------- input parsing
test('parseLeagueInput handles team URLs, league URLs, ids', () => {
  assert.deepEqual(C.parseLeagueInput('https://fantasy.espn.com/football/team?leagueId=899513&teamId=3&seasonId=2026'), { leagueId: '899513', teamId: '3', season: 2026 });
  assert.deepEqual(C.parseLeagueInput('https://fantasy.espn.com/football/league?leagueId=42654852'), { leagueId: '42654852', teamId: null, season: null });
  assert.equal(C.parseLeagueInput('  1234567 ').leagueId, '1234567');
  assert.deepEqual(C.parseLeagueInput('hello'), { leagueId: null, teamId: null, season: null });
  assert.equal(C.parseLeagueInput('https://www.espn.com/fantasy/football/?leagueId=55&teamId=2&foo=1').teamId, '2');
});

test('cookie normalisation: SWID braces/encoding and s2 prefixes', () => {
  const swid = '{1A2B3C4D-1111-2222-3333-ABCDEF012345}';
  assert.equal(C.normalizeSwid(swid).value, swid);
  assert.equal(C.normalizeSwid('1a2b3c4d-1111-2222-3333-abcdef012345').value, swid);
  assert.equal(C.normalizeSwid('%7B1A2B3C4D-1111-2222-3333-ABCDEF012345%7D').value, swid);
  assert.equal(C.normalizeSwid('SWID=' + swid + ';').value, swid);
  assert.equal(C.normalizeSwid('nope').valid, false);
  const s2 = 'AEBxyz%2Fabc%2Bdef' + 'A'.repeat(40);
  assert.equal(C.normalizeS2(s2).value, s2);
  assert.equal(C.normalizeS2('espn_s2=' + s2 + ';').value, s2);
  assert.equal(C.normalizeS2('AEB/raw+plus=' + 'B'.repeat(40)).value, encodeURIComponent('AEB/raw+plus=' + 'B'.repeat(40)));
  assert.equal(C.normalizeS2('short').valid, false);
  assert.match(C.maskSecret(s2), /^AEBx•+[A-Za-z0-9]{4}$/);
});

test('ESPN paths and X-Fantasy-Filter use real view/field names', () => {
  assert.equal(C.leaguePath(2026, 99, ['mTeam', 'mRoster']), '/apis/v3/games/ffl/seasons/2026/segments/0/leagues/99?view=mTeam&view=mRoster');
  assert.equal(C.schedulePath(2026), '/apis/v3/games/ffl/seasons/2026?view=proTeamSchedules_wl');
  const f = C.playersFilter({ season: 2026, week: 10, posId: 2, limit: 20 });
  assert.deepEqual(f.players.filterStatus.value, ['FREEAGENT', 'WAIVERS']);
  assert.deepEqual(f.players.filterSlotIds.value, [2]);
  assert.equal(f.players.sortAppliedStatTotal.value, '102026');
  assert.ok(f.players.filterStatsForTopScoringPeriodIds.additionalValue.includes('11202610'));
  assert.deepEqual(C.playersFilter({ season: 2026, week: 1, posId: 16 }).players.filterSlotIds.value, [16]);
  assert.deepEqual(C.playersFilter({ season: 2026, week: 1, posId: 0 }).players.filterSlotIds.value, [1]);
  assert.equal(C.currentSeason(new Date(2026, 10, 11)), 2026);
  assert.equal(C.currentSeason(new Date(2027, 0, 10)), 2026);
});

// ---------------------------------------------------------------- parsers vs real captured ESPN JSON
test('parseSettings reads slots, week, regular season length, PPR', () => {
  const s = C.parseSettings(league);
  assert.equal(s.name, 'FFLR Test League');
  assert.equal(s.week, 10);
  assert.equal(s.finalWeek, 17);
  assert.equal(s.regSeasonWeeks, 17);
  assert.equal(s.slotCounts[0], 1); assert.equal(s.slotCounts[2], 2); assert.equal(s.slotCounts[23], 1); assert.equal(s.slotCounts[16], 1);
  assert.equal(s.isPublic, true);
  assert.equal(C.starterSlots(s.slotCounts).length, 9);
});

test('parseProTeams builds bye map and opponents from proTeamSchedules_wl', () => {
  const p = C.parseProTeams(proTeamsJson);
  assert.equal(p.byAbbrev.ARI.bye, 14);
  assert.equal(p.byAbbrev.IND.bye, 13);
  assert.equal(p.byAbbrev.IND.games[13], undefined);
  assert.ok(p.byAbbrev.IND.games[1].opp > 0);
  assert.equal(p.byAbbrev.IND.games[2].home, false);
});

test('parseTeams normalises players from a real league response', () => {
  const s = C.parseSettings(league);
  const teams = C.parseTeams(league, { season: 2026, week: s.week });
  assert.equal(teams.length, 4);
  const t1 = teams.find((t) => t.id === 1);
  assert.equal(t1.roster.length, 16);
  const puka = t1.roster.find((p) => p.name === 'Puka Nacua');
  assert.equal(puka.pos, 'WR'); assert.equal(puka.injury, 'OUT'); assert.equal(puka.slotId, 4);
  assert.ok(puka.seasonAvg > 20 && puka.games >= 5);
  const walker = t1.roster.find((p) => p.name === 'Kenneth Walker III');
  assert.equal(walker.slotId, 20);
  assert.ok(walker.rosPpg > 20, 'ROS projection average comes from statSourceId 1 / split 0');
  assert.ok(walker.wkProj > 20, 'weekly projection comes from statSourceId 1 / split 1 / scoringPeriodId');
  assert.ok(walker.pctOwned > 90);
  assert.equal(t1.roster.find((p) => p.name === "De'Von Achane").injury, 'IR');
  assert.ok(t1.name && t1.owner !== undefined);
});

test('parseFreeAgents keeps status and ownership', () => {
  const fas = C.parseFreeAgents(faRb, { season: 2026, week: 10 });
  assert.ok(fas.length >= 10);
  assert.ok(fas.every((p) => p.posId === 2));
  assert.equal(fas[0].status, 'FREEAGENT');
  assert.ok(fas[0].rosPpg > 0);
});

test('normInjury maps ESPN statuses', () => {
  assert.equal(C.normInjury('INJURY_RESERVE'), 'IR');
  assert.equal(C.normInjury('NORMAL'), 'ACTIVE');
  assert.equal(C.normInjury(undefined), 'ACTIVE');
  assert.equal(C.normInjury('DOUBTFUL'), 'DOUBTFUL');
  assert.equal(C.normInjury('SUSPENSION'), 'SUSPENDED');
});

// ---------------------------------------------------------------- value model
test('estimatePpg blends available signals and renormalises weights', () => {
  const base = { rosPpg: 20, wkProj: 10, seasonAvg: 15, games: 5, recent: 5 };
  const all = C.estimatePpg(base).ppg;
  const w = C.MODEL_WEIGHTS;
  assert.ok(Math.abs(all - (20 * w.ros + 10 * w.week + 15 * w.season + 5 * w.recent)) < 1e-9);
  assert.equal(C.estimatePpg({ rosPpg: 20, wkProj: 0, seasonAvg: 0, games: 0, recent: null }).ppg, 20);
  assert.equal(C.estimatePpg({ rosPpg: 0, wkProj: 0, seasonAvg: 0, games: 0, recent: null }).ppg, 0);
});

test('availability discounts injured players; bye reduces games left', () => {
  const ctx = mkCtx();
  assert.equal(C.availability({ injury: 'OUT' }), 0.65);
  assert.equal(C.availability({ injury: 'ACTIVE' }), 1);
  const [a, b, c] = mkRoster(ctx, [['A', 2, 10, { team: 1 }], ['B', 2, 10, { team: 2 }], ['C', 2, 10, { team: 3 }]]);
  assert.equal(a.gamesLeft, 8); // weeks 10..17, no bye in range
  assert.equal(b.gamesLeft, 7); // bye in week 10
  assert.equal(c.gamesLeft, 7); // bye in week 12
  assert.equal(a.ros, 80);
  const [hurt] = mkRoster(ctx, [['H', 2, 10, { injury: 'OUT' }]]);
  assert.ok(Math.abs(hurt.ros - 10 * 0.65 * 8) < 1e-9);
});

test('computeReplacement uses the 3rd-best healthy free agent per position', () => {
  const ctx = mkCtx();
  const pool = mkRoster(ctx, [['f1', 2, 15], ['f2', 2, 12], ['f3', 2, 10], ['f4', 2, 9], ['fOut', 2, 30, { injury: 'OUT' }], ['q1', 1, 14]]);
  const repl = C.computeReplacement(pool);
  assert.equal(repl[2], 10);
  assert.ok(Math.abs(repl[1] - 14) < 1e-9); // only one QB -> best available
  assert.equal(repl[16], C.DEFAULT_REPLACEMENT[16]); // untouched default
});

test('buildContext derives replacement + vorp from a pool', () => {
  const ctx = mkCtx();
  const pool = mkRoster(ctx, [['f1', 2, 10], ['f2', 2, 10], ['f3', 2, 10]]);
  const ctx2 = C.buildContext({ settings: ctx.settings, schedule: ctx.schedule, pool });
  assert.equal(ctx2.repl[2], 10);
  const [star] = mkRoster(ctx2, [['Star', 2, 20]]);
  assert.equal(star.vorp, (20 - 10) * 8);
});

// ---------------------------------------------------------------- lineups
test('bestLineup fills FLEX optimally and never starts IR players', () => {
  const ctx = mkCtx();
  const roster = stdRoster(ctx, [['IRguy', 2, 40, { injury: 'IR', slot: 21 }], ['WRstud', 3, 25]]);
  const slots = C.starterSlots(ctx.settings.slotCounts);
  assert.equal(slots.length, 9);
  const lu = C.bestLineup(roster, slots, (p) => p.ppg);
  const names = lu.assign.map((a) => a.player && a.player.name);
  assert.ok(!names.includes('IRguy'));
  assert.ok(names.includes('WRstud') && names.includes('WR1'));
  assert.equal(lu.assign.find((a) => a.slotId === 23).player.name, 'WR2'); // 11 beats RB3 (8), WR3 (10) is lower than WR2? 11 > 10
  assert.equal(lu.total, 20 + 18 + 12 + 25 + 17 + 9 + 11 + 7 + 8);
});

test('bestLineup leaves a slot empty rather than starting an ineligible player', () => {
  const ctx = mkCtx();
  const roster = mkRoster(ctx, [['QB1', 1, 20], ['RB1', 2, 10], ['WR1', 3, 10]]);
  const lu = C.bestLineup(roster, C.starterSlots(ctx.settings.slotCounts), (p) => p.ppg);
  assert.equal(lu.assign.filter((a) => a.player).length, 3); // QB, RB, WR — nothing eligible for the rest
  assert.equal(lu.assign.find((a) => a.slotId === 6).player, null); // no TE
  assert.equal(lu.assign.find((a) => a.slotId === 16).player, null);
});

test('rosterValue fills holes with waiver-level players and credits depth', () => {
  const ctx = mkCtx();
  ctx.repl = { 0: 12, 1: 15, 2: 10, 3: 10, 4: 6, 5: 8, 16: 6 };
  const roster = mkRoster(ctx, [['QB1', 1, 20, { slot: 0 }]]);
  const withRepl = C.rosterValue(roster, ctx);
  const without = C.rosterValue(roster, ctx, { replacement: false });
  assert.equal(without.lineupTotal, 20 * 8);
  assert.ok(withRepl.lineupTotal > without.lineupTotal + 50, 'holes are filled by replacement level');
  const deep = mkRoster(ctx, [['QB1', 1, 20, { slot: 0 }], ['RB-bench', 2, 18, { slot: 20 }], ['RB-bench2', 2, 18, { slot: 20 }], ['RB-bench3', 2, 18, { slot: 20 }]]);
  assert.ok(C.rosterValue(deep, ctx).total > C.rosterValue(roster, ctx).total);
});

// ---------------------------------------------------------------- lineup check
test('lineupCheck flags bye / OUT / Questionable starters and suggests bench swaps', () => {
  const ctx = mkCtx();
  const roster = mkRoster(ctx, [
    ['QB1', 1, 20, { slot: 0 }], ['RB1', 2, 18, { slot: 2, team: 2 }], // team 2 is on bye in week 10
    ['RB2', 2, 12, { slot: 2, injury: 'OUT', wk: 0 }], ['WR1', 3, 17, { slot: 4 }], ['WR2', 3, 11, { slot: 4, injury: 'QUESTIONABLE' }],
    ['TE1', 4, 9, { slot: 6 }], ['FLEXguy', 3, 10, { slot: 23 }], ['DST1', 16, 7, { slot: 16 }], ['K1', 5, 8, { slot: 17 }],
    ['RBbench', 2, 9, { slot: 20 }], ['RBbench2', 2, 6, { slot: 20 }], ['WRbench', 3, 10.5, { slot: 20 }],
  ]);
  const lc = C.lineupCheck(roster, ctx);
  const codes = (name) => (lc.flags.find((f) => f.player.name === name) || { issues: [] }).issues.map((i) => i.code);
  assert.deepEqual(codes('RB1'), ['BYE']);
  assert.deepEqual(codes('RB2'), ['OUT']);
  assert.deepEqual(codes('WR2'), ['QUESTIONABLE']);
  assert.equal(lc.moves.length >= 2, true);
  const rbMoves = lc.moves.filter((m) => m.slotId === 2).map((m) => `${m.out.name}->${m.in.name}`).sort();
  assert.deepEqual(rbMoves, ['RB1->RBbench', 'RB2->RBbench2']);
  assert.ok(lc.moves.every((m) => m.gain > 0));
  assert.ok(lc.optimalTotal > lc.currentTotal);
  assert.ok(lc.jinx >= 44);
});

test('lineupCheck is quiet for a healthy, optimal lineup', () => {
  const ctx = mkCtx();
  const roster = stdRoster(ctx);
  const lc = C.lineupCheck(roster, ctx);
  assert.equal(lc.flags.length, 0);
  assert.equal(lc.moves.length, 0);
  assert.equal(lc.jinx, 0);
  assert.equal(C.jinxLabel(0), 'Blessed 😇');
});

test('lineupCheck flags a starter projected well below an eligible bench player', () => {
  const ctx = mkCtx();
  const roster = stdRoster(ctx, [['WRbetter', 3, 16, { slot: 20 }]]);
  roster.find((p) => p.name === 'WR2').wkProj = 5; // starter now projects 5 vs bench 16
  C.annotate(roster, ctx);
  const lc = C.lineupCheck(roster, ctx);
  assert.ok(lc.flags.some((f) => f.player.name === 'WR2' && f.issues.some((i) => i.code === 'BENCHBETTER')));
  assert.ok(lc.moves.some((m) => m.out.name === 'WR2' && m.in.name === 'WRbetter'));
});

test('lineupCheck on real captured data flags IR/OUT starters and swaps in healthy bench players', () => {
  const settings = C.parseSettings(league);
  const schedule = C.parseProTeams(proTeamsJson);
  const teams = C.parseTeams(league, { season: 2026, week: settings.week });
  const ctx = C.buildContext({ settings, schedule, pool: [] });
  const me = teams.find((t) => t.id === 1);
  C.annotate(me.roster, ctx);
  const lc = C.lineupCheck(me.roster, ctx);
  assert.ok(lc.flags.some((f) => f.player.name === 'Puka Nacua' && f.issues.some((i) => i.code === 'OUT')));
  assert.ok(lc.flags.some((f) => f.player.name === "De'Von Achane" && f.issues.some((i) => i.code === 'IR')));
  assert.ok(lc.moves.length >= 2);
  assert.ok(lc.moves.every((m) => m.in.injury !== 'IR' && m.in.injury !== 'OUT'));
});

// ---------------------------------------------------------------- trades
function twoTeams(ctx) {
  const me = stdRoster(ctx);
  const them = mkRoster(ctx, [
    ['TQB1', 1, 19, { slot: 0 }], ['TRB1', 2, 19, { slot: 2 }], ['TRB2', 2, 15, { slot: 2 }], ['TWR1', 3, 13, { slot: 4 }], ['TWR2', 3, 9, { slot: 4 }],
    ['TTE1', 4, 11, { slot: 6 }], ['TFLEX', 2, 12, { slot: 23 }], ['TDST', 16, 6, { slot: 16 }], ['TK', 5, 8, { slot: 17 }], ['TWRbench', 3, 14, {}],
  ]);
  return { me, them };
}

test('trade: selling your RB1 for a bench scrub is a jinx; the reverse is approved', () => {
  const ctx = mkCtx();
  const { me, them } = twoTeams(ctx);
  const rb1 = me.find((p) => p.name === 'RB1'), scrub = them.find((p) => p.name === 'TWR2');
  const bad = C.evaluateTrade({ mine: me, theirs: them, give: [rb1.id], get: [scrub.id], ctx });
  assert.equal(bad.verdict.key, 'jinx');
  assert.ok(bad.me.delta < 0 && bad.them.delta > 0);
  assert.equal(bad.acceptance, 'likely');
  assert.ok(bad.jinx > 50);
  assert.ok(bad.reasons.length >= 3 && bad.reasons.every((r) => r.text));
  const good = C.evaluateTrade({ mine: them, theirs: me, give: [scrub.id], get: [rb1.id], ctx });
  assert.equal(good.verdict.key, 'approve');
  assert.equal(good.acceptance, 'unlikely'); // the other side gets fleeced
  assert.ok(good.jinx < 50);
});

test('trade: value is conserved symmetrically for a pure one-for-one swap of equal players', () => {
  const ctx = mkCtx();
  const a = mkRoster(ctx, [['A1', 2, 15, { slot: 2 }], ['A2', 2, 5, { slot: 2 }]]);
  const b = mkRoster(ctx, [['B1', 2, 15, { slot: 2 }], ['B2', 2, 5, { slot: 2 }]]);
  const r = C.evaluateTrade({ mine: a, theirs: b, give: [a[0].id], get: [b[0].id], ctx });
  assert.ok(Math.abs(r.me.delta) < 1e-9);
  assert.ok(Math.abs(r.them.delta) < 1e-9);
  assert.equal(r.verdict.key, 'wash');
});

test('trade: positional need drives value (filling a hole beats a surplus swap)', () => {
  const ctx = mkCtx();
  ctx.repl = { 0: 12, 1: 15, 2: 8, 3: 8, 4: 3, 5: 8, 16: 6 };
  const me = stdRoster(ctx, [['SpareWR', 3, 14, {}]]);
  me.find((p) => p.name === 'TE1').injury = 'OUT'; C.annotate(me, ctx);
  const them = mkRoster(ctx, [['TTE', 4, 14, { slot: 6 }], ['TTE2', 4, 12, {}], ['TWR', 3, 5, { slot: 4 }]]);
  const spare = me.find((p) => p.name === 'SpareWR');
  const r = C.evaluateTrade({ mine: me, theirs: them, give: [spare.id], get: [them[0].id], ctx });
  assert.ok(r.me.perWeek > 0.5, 'upgrading an injured TE with a surplus WR should help');
  assert.ok(r.me.posDelta[4] > 0);
});

test('trade: reasons warn about injured incoming players and roster spots', () => {
  const ctx = mkCtx();
  const { me, them } = twoTeams(ctx);
  const hurt = them.find((p) => p.name === 'TRB1');
  hurt.injury = 'OUT'; C.annotate(them, ctx);
  const r = C.evaluateTrade({ mine: me, theirs: them, give: [me.find((p) => p.name === 'RB3').id], get: [hurt.id, them.find((p) => p.name === 'TRB2').id], ctx });
  const text = r.reasons.map((x) => x.text).join(' | ');
  assert.match(text, /TRB1 is listed OUT/);
  assert.match(text, /drop 1 player/);
});

test('proposeTrades suggests balanced swaps that improve my lineup and do not crush the partner', () => {
  const ctx = mkCtx();
  const me = mkRoster(ctx, [
    ['QB1', 1, 20, { slot: 0 }], ['RB1', 2, 8, { slot: 2 }], ['RB2', 2, 7, { slot: 2 }], ['WR1', 3, 18, { slot: 4 }], ['WR2', 3, 17, { slot: 4 }],
    ['TE1', 4, 9, { slot: 6 }], ['WRsurplus', 3, 16, { slot: 23 }], ['DST1', 16, 7, { slot: 16 }], ['K1', 5, 8, { slot: 17 }], ['WRbench', 3, 15, {}],
  ]);
  const them = mkRoster(ctx, [
    ['TQB', 1, 20, { slot: 0 }], ['TRB1', 2, 17, { slot: 2 }], ['TRB2', 2, 16, { slot: 2 }], ['TWR1', 3, 8, { slot: 4 }], ['TWR2', 3, 7, { slot: 4 }],
    ['TTE', 4, 9, { slot: 6 }], ['TRB3', 2, 15, { slot: 23 }], ['TDST', 16, 7, { slot: 16 }], ['TK', 5, 8, { slot: 17 }], ['TRBbench', 2, 14, {}],
  ]);
  const myTeam = { id: 1, name: 'Me', roster: me }, other = { id: 2, name: 'Them', roster: them };
  const out = C.proposeTrades({ myTeam, teams: [myTeam, other], ctx });
  assert.ok(out.ideas.length >= 1 && out.ideas.length <= 5);
  const seen = new Set();
  for (const i of out.ideas) {
    assert.ok(i.result.me.perWeek >= 0.25, 'improves my lineup');
    assert.ok(i.result.them.perWeek >= -1.2, 'not lopsided against them');
    for (const id of i.give) { assert.ok(!seen.has(id)); seen.add(id); }
    assert.ok(i.result.reasons.length > 0);
  }
  const best = out.ideas[0];
  assert.ok(best.result.giveP.some((p) => p.posId === 3) && best.result.getP.some((p) => p.posId === 2), 'sends WR surplus for RB help');
  assert.equal(out.profile[1][2].label, 'need');
  assert.equal(out.profile[2][3].label, 'need');
});

test('proposeTrades never proposes kickers or defences', () => {
  const ctx = mkCtx();
  const { me, them } = twoTeams(ctx);
  const out = C.proposeTrades({ myTeam: { id: 1, name: 'a', roster: me }, teams: [{ id: 1, name: 'a', roster: me }, { id: 2, name: 'b', roster: them }], ctx });
  for (const i of out.ideas) for (const p of i.result.giveP.concat(i.result.getP)) assert.ok(p.posId !== 5 && p.posId !== 16);
});

// ---------------------------------------------------------------- waivers
test('proposeAddDrops adds a better QB, drops the lowest-value bench player, never a starter', () => {
  const ctx = mkCtx();
  const roster = stdRoster(ctx, [['Scrub', 2, 2, {}]]);
  const pool = mkRoster(ctx, [['BigQB', 1, 25, { status: 'FREEAGENT' }], ['WaiverWR', 3, 9, { status: 'WAIVERS' }], ['OutRB', 2, 40, { injury: 'OUT', status: 'FREEAGENT' }]]);
  const res = C.proposeAddDrops({ roster, pool, ctx });
  assert.ok(res.length >= 1);
  assert.equal(res[0].add.name, 'BigQB');
  assert.equal(res[0].drop.name, 'Scrub');
  assert.equal(res[0].starts, true);
  assert.ok(res[0].reasons.some((r) => /start at QB over QB1/.test(r)));
  assert.ok(res[0].reasons.some((r) => /Free agent/.test(r)));
  const starters = new Set(roster.filter((p) => p.slotId !== 20).map((p) => p.name));
  for (const r of res) { assert.ok(!r.drop || !starters.has(r.drop.name) || r.drop.injury !== 'ACTIVE'); assert.notEqual(r.add.name, 'OutRB'); }
});

test('proposeAddDrops explains waivers vs free agent and covers an injured starter', () => {
  const ctx = mkCtx();
  const roster = stdRoster(ctx);
  roster.find((p) => p.name === 'TE1').injury = 'OUT'; C.annotate(roster, ctx);
  const pool = mkRoster(ctx, [['WaiverTE', 4, 10, { status: 'WAIVERS' }]]);
  const res = C.proposeAddDrops({ roster, pool, ctx });
  assert.equal(res[0].add.name, 'WaiverTE');
  assert.ok(res[0].reasons.some((r) => /WAIVERS/.test(r)));
  assert.ok(res[0].reasons.some((r) => /Covers for TE1/.test(r)));
});

test('proposeAddDrops returns nothing when the roster already beats the wire', () => {
  const ctx = mkCtx();
  const roster = stdRoster(ctx);
  const pool = mkRoster(ctx, [['MehQB', 1, 5], ['MehRB', 2, 4]]);
  assert.deepEqual(C.proposeAddDrops({ roster, pool, ctx }), []);
});

test('rankFreeAgents sorts by projected rest-of-season value and filters by position', () => {
  const ctx = mkCtx();
  const pool = mkRoster(ctx, [['a', 2, 5], ['b', 2, 9], ['c', 3, 20]]);
  assert.deepEqual(C.rankFreeAgents(pool, ctx, 2).map((p) => p.name), ['b', 'a']);
  assert.equal(C.rankFreeAgents(pool, ctx)[0].name, 'c');
});

test('full pipeline on real captured data produces sane output', () => {
  const settings = C.parseSettings(league);
  const schedule = C.parseProTeams(proTeamsJson);
  const pctx = { season: 2026, week: settings.week };
  const teams = C.parseTeams(league, pctx);
  const pool = C.parseFreeAgents(faRb, pctx);
  const ctx = C.buildContext({ settings, schedule, pool });
  teams.forEach((t) => C.annotate(t.roster, ctx));
  assert.ok(ctx.repl[2] > 5);
  const me = teams[0];
  const add = C.proposeAddDrops({ roster: me.roster, pool, ctx });
  assert.ok(add.length >= 1 && add[0].add.posId === 2);
  const ideas = C.proposeTrades({ myTeam: me, teams, ctx });
  for (const i of ideas.ideas) assert.ok(Number.isFinite(i.result.me.perWeek));
  const r = C.evaluateTrade({ mine: me.roster, theirs: teams[1].roster, give: [me.roster[0].id], get: [teams[1].roster[0].id], ctx });
  assert.ok(['approve', 'wash', 'jinx'].includes(r.verdict.key));
});

// ---------------------------------------------------------------- reminders (.ics)
test('nextEtDate picks the next Thursday / Sunday in America/New_York', () => {
  // Wed Nov 11 2026 10:30 PM ET == Thu Nov 12 03:30Z
  const now = new Date('2026-11-12T03:30:00Z');
  assert.equal(C.nextEtDate(now, 4, 18), '20261112'); // Thursday 6 PM is still ahead
  assert.equal(C.nextEtDate(now, 0, 11), '20261115');
  // Thu Nov 12 2026 7 PM ET (after 6 PM) -> next Thursday
  assert.equal(C.nextEtDate(new Date('2026-11-13T00:00:00Z'), 4, 18), '20261119');
  // Sunday 10 AM ET (before 11) -> same day
  assert.equal(C.nextEtDate(new Date('2026-11-15T15:00:00Z'), 0, 11), '20261115');
});

test('buildIcs makes weekly recurring Thu 6PM / Sun 11AM ET events with alarms until Jan 10, 2027', () => {
  const ics = C.buildIcs({ leagueName: 'Bustin; with, the boys', leagueId: 5, now: new Date('2026-11-12T03:30:00Z'), appUrl: 'https://ourhootshouse.github.io/lucky-socks/' });
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n') && ics.endsWith('END:VCALENDAR\r\n'));
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 2);
  assert.equal((ics.match(/BEGIN:VALARM/g) || []).length, 2);
  assert.match(ics, /DTSTART;TZID=America\/New_York:20261112T180000/);
  assert.match(ics, /DTSTART;TZID=America\/New_York:20261115T110000/);
  assert.equal((ics.match(/RRULE:FREQ=WEEKLY;UNTIL=20270110T160000Z/g) || []).length, 2);
  assert.match(ics, /BEGIN:VTIMEZONE\r\nTZID:America\/New_York/);
  assert.match(ics, /Bustin\\; with\\, the boys/);
  for (const line of ics.split('\r\n')) assert.ok(line.length <= 75, 'folded: ' + line.length);
  assert.ok(!/[^\r]\n/.test(ics), 'CRLF only');
  const uids = ics.match(/UID:.*/g);
  assert.equal(new Set(uids).size, 2);
});

// ---------------------------------------------------------------- flavor
test('superstition tips are deterministic with an injected rng and always carry real advice', () => {
  assert.equal(C.pickSuperstition(() => 0).title, 'The Lucky Socks');
  assert.ok(C.pickSuperstition(() => 0.999999).advice);
  for (const s of C.SUPERSTITIONS) assert.ok(s.tip && s.advice && s.emoji);
});

test('groupRoster separates starters, bench and IR in slot order', () => {
  const ctx = mkCtx();
  const roster = stdRoster(ctx, [['IR1', 2, 5, { slot: 21, injury: 'IR' }]]);
  const g = C.groupRoster(roster);
  assert.equal(g.starters.length, 9);
  assert.equal(g.starters[0].name, 'QB1');
  assert.equal(g.ir.length, 1);
  assert.equal(g.bench.length, 2);
});
