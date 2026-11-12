// Lucky Socks config. Edit RELAY_URL after deploying worker/ (see worker/README.md), or paste it in the app under Leagues → Relay.
window.LUCKY_CONFIG = {
  // Cloudflare Worker that forwards ESPN cookies for PRIVATE leagues. Leave empty until deployed.
  RELAY_URL: '',
  // Public ESPN league used by "Try with a demo league" (fflr package's public test league, 4 teams).
  DEMO_LEAGUE_ID: '42654852',
  DEMO_TEAM_ID: 1,
  // Leave null to auto-detect the NFL season from today's date.
  SEASON: null,
};
