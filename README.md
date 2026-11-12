# Agent 89 — fantasy football scouting desk

Static PWA (plain HTML/CSS/JS, no build step) that reads your ESPN fantasy league straight from the browser and gives you
lineup checks, trade grades, intel, and waiver add/drop picks — with a secret-agent, film-room tone.
Publish the folder root to GitHub Pages (`ourhootshouse/lucky-socks`, `main` / root). All paths are relative.

| File | Purpose |
|---|---|
| `index.html`, `styles.css`, `app.js` | UI (mobile-first, dark/light) |
| `core.js` | All analysis: parsers, value model, lineup check, trade scoring, trade ideas, add/drop, .ics (unit-tested) |
| `espn.js` | ESPN API client (direct for public leagues, via relay for private leagues) |
| `config.js` | `RELAY_URL` (built-in private-league Worker), demo league id |
| `worker/` | Cloudflare Worker relay for private leagues (see `worker/README.md`) |
| `sw.js`, `manifest.webmanifest`, `icons/` | PWA (installable, offline app shell; ESPN calls are never cached) |
| `test/` | `node --test` unit tests (core + worker) |
| `scripts/` | icon generator, live ESPN smoke script, headless UI test, relay end-to-end test |

## Run / test
```bash
python3 -m http.server 8080        # open http://localhost:8080
node --test                        # unit tests (no network)
node scripts/live.js 42654852 1    # prints a full analysis from the real ESPN API
```

## Data source
`https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/{season}/segments/0/leagues/{id}` with views
`mTeam`, `mRoster`, `mSettings`; free agents via `view=kona_player_info` + `X-Fantasy-Filter`; NFL byes/schedule via
`/seasons/{season}?view=proTeamSchedules_wl`. Public leagues need no auth. Private leagues need `espn_s2` + `SWID`
cookies and the relay Worker. Demo league = ESPN public test league **42654852** ("FFLR Test League", from the fflr R package docs).

Fan-made. Not affiliated with the NFL, ESPN, or any team.
