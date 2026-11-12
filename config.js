// Agent 89 config. RELAY_URL is the private-league Worker (see worker/README.md). Leave it empty only if you have not deployed one.
window.LUCKY_CONFIG = {
  // Built-in Cloudflare Worker that forwards ESPN cookies for PRIVATE leagues. The Leagues tab uses this automatically.
  RELAY_URL: 'https://lucky-socks-relay.ourhootshouse.workers.dev',
  // Public ESPN league used by "Try with a demo league" (fflr package's public test league, 4 teams).
  DEMO_LEAGUE_ID: '42654852',
  DEMO_TEAM_ID: 1,
  // Leave null to auto-detect the NFL season from today's date.
  SEASON: null,
};
