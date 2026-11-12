/* Agent 89 ESPN client. Public leagues are fetched straight from ESPN (CORS ok);
 * private leagues (with cookies) go through the user's relay Worker. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./core.js'));
  else root.LuckyEspn = factory(root.LuckyCore);
})(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';
  const ESPN_HOST = 'https://lm-api-reads.fantasy.espn.com';

  class EspnError extends Error {
    constructor(kind, message, extra) { super(message); this.kind = kind; Object.assign(this, extra || {}); }
  }

  /**
   * cfg: { relayUrl, creds: {s2, swid} | null }
   * Returns parsed JSON or throws EspnError(kind: 'private' | 'notfound' | 'relay' | 'network' | 'http').
   */
  async function espnGet(cfg, path, filter, opts) {
    const o = opts || {};
    const useRelay = !!(cfg.creds && cfg.creds.s2 && cfg.creds.swid && cfg.relayUrl) && !o.forceDirect;
    const headers = {};
    if (filter) headers['X-Fantasy-Filter'] = JSON.stringify(filter);
    let url;
    if (useRelay) {
      url = cfg.relayUrl.replace(/\/+$/, '') + '/?path=' + encodeURIComponent(path);
      headers['X-ESPN-S2'] = cfg.creds.s2;
      headers['X-ESPN-SWID'] = cfg.creds.swid;
    } else url = ESPN_HOST + path;
    let res;
    try { res = await fetch(url, { headers, cache: 'no-store' }); }
    catch (e) { throw new EspnError(useRelay ? 'relay' : 'network', useRelay ? 'Could not reach the relay Worker.' : 'Could not reach ESPN (network or CORS).', { cause: e }); }
    if (res.status === 401 || res.status === 403) {
      throw new EspnError('private', 'Private league', { viaRelay: useRelay, hasCreds: !!(cfg.creds && cfg.creds.s2), hasRelay: !!cfg.relayUrl, status: res.status });
    }
    if (res.status === 404) throw new EspnError('notfound', 'ESPN could not find that league for this season.');
    if (!res.ok) throw new EspnError('http', `ESPN returned HTTP ${res.status}`, { status: res.status });
    try { return await res.json(); }
    catch (e) { throw new EspnError('http', 'ESPN sent something that was not JSON.'); }
  }

  /** League-level data needed for team list/picker (cheap-ish): teams + settings. */
  async function fetchTeamList(cfg, season, leagueId) {
    const json = await espnGet(cfg, C.leaguePath(season, leagueId, ['mTeam', 'mSettings']));
    const settings = C.parseSettings(json);
    const ctx = { season: settings.season || season, week: settings.week };
    const teams = C.parseTeams(json, ctx).map((t) => ({ id: t.id, name: t.name, abbrev: t.abbrev, logo: t.logo, owner: t.owner, record: t.record }));
    return { settings, teams };
  }

  /** Everything the analysis needs: rosters, settings, pro schedule/byes, and a free-agent pool. */
  async function loadLeague(cfg, season, leagueId) {
    const [leagueJson, schedJson] = await Promise.all([
      espnGet(cfg, C.leaguePath(season, leagueId, ['mTeam', 'mRoster', 'mSettings'])),
      espnGet(cfg, C.schedulePath(season), null, { forceDirect: true }),
    ]);
    const settings = C.parseSettings(leagueJson);
    const pctx = { season: settings.season || season, week: settings.week };
    const teams = C.parseTeams(leagueJson, pctx);
    const schedule = C.parseProTeams(schedJson);
    const slots = C.starterSlots(settings.slotCounts);
    const wanted = C.POS_IDS.filter((pid) => slots.some((s) => C.SLOT_POS[s].includes(pid)));
    const pools = await Promise.all(wanted.map((pid) => espnGet(cfg, C.leaguePath(pctx.season, leagueId, ['kona_player_info']),
      C.playersFilter({ season: pctx.season, week: pctx.week, posId: pid, limit: pid === 5 || pid === 16 || pid === 0 ? 12 : 35 }))));
    const pool = [].concat(...pools.map((j) => C.parseFreeAgents(j, pctx)));
    const ctx = C.buildContext({ settings, schedule, pool });
    for (const t of teams) C.annotate(t.roster, ctx);
    return { settings, teams, schedule, pool, ctx, loadedAt: Date.now() };
  }

  return { ESPN_HOST, EspnError, espnGet, fetchTeamList, loadLeague };
});
