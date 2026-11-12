// Manual smoke script against the real ESPN API (not part of unit tests): node test/live.js [leagueId] [teamId]
const C = require('../core.js'), E = require('../espn.js');
(async () => {
  const id = process.argv[2] || '42654852', teamId = Number(process.argv[3] || 1);
  const t0 = Date.now();
  const L = await E.loadLeague({}, C.currentSeason(), id);
  console.log('loaded in', Date.now() - t0, 'ms', L.settings.name, 'week', L.settings.week, 'teams', L.teams.length, 'pool', L.pool.length, 'nominal', L.ctx.nominalGames);
  console.log('repl', JSON.stringify(Object.fromEntries(Object.entries(L.ctx.repl).map(([k, v]) => [C.POS[k], C.r1(v)]))));
  const me = L.teams.find((t) => t.id === teamId);
  const g = C.groupRoster(me.roster);
  for (const p of me.roster) console.log(String(C.SLOT_NAMES[p.slotId]).padEnd(5), p.name.padEnd(22), p.pos.padEnd(4), p.team.padEnd(4), p.injury.padEnd(12), 'wk', C.r1(p.wkProj), 'ppg', C.r1(p.ppg), 'g', p.gamesLeft, 'ros', C.r1(p.ros), 'vorp', C.r1(p.vorp));
  const lc = C.lineupCheck(me.roster, L.ctx);
  console.log('LINEUP jinx', lc.jinx, 'gain', C.r1(lc.gain)); for (const f of lc.flags) console.log(' flag', f.player.name, f.issues.map((i) => i.text).join('; ')); for (const m of lc.moves) console.log(' move', m.slotName, m.out && m.out.name, '->', m.in.name, C.r1(m.gain), m.reason);
  let t1 = Date.now();
  const ideas = C.proposeTrades({ myTeam: me, teams: L.teams, ctx: L.ctx });
  console.log('ideas in', Date.now() - t1, 'ms');
  for (const i of ideas.ideas) console.log(' idea', i.team.name, 'give', i.result.giveP.map((p) => p.name), 'get', i.result.getP.map((p) => p.name), C.r1(i.result.me.perWeek), C.r1(i.result.them.perWeek), i.result.verdict.label, i.result.why);
  t1 = Date.now();
  const ad = C.proposeAddDrops({ roster: me.roster, pool: L.pool, ctx: L.ctx });
  console.log('adddrops in', Date.now() - t1, 'ms');
  for (const a of ad) console.log(' add', a.add.name, 'drop', a.drop && a.drop.name, C.r1(a.perWeek), a.reasons);
  const other = L.teams.find((t) => t.id !== teamId);
  const r = C.evaluateTrade({ mine: me.roster, theirs: other.roster, give: [me.roster[0].id], get: [other.roster[0].id], ctx: L.ctx });
  console.log('trade', r.verdict.label, C.r1(r.me.perWeek), C.r1(r.them.perWeek), r.acceptance, r.reasons.map((x) => x.text));
})().catch((e) => { console.error(e); process.exit(1); });
