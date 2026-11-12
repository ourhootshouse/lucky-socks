# Lucky Socks relay (Cloudflare Worker)

Lets the static Lucky Socks app read a **private** ESPN fantasy league. Browsers will not send your ESPN
cookies to ESPN from another site, so the app sends your `espn_s2` and `SWID` to *your own* Worker, which
forwards them to ESPN as cookies and returns the JSON.

**What it does / does not do**
- GET only, and only to `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/**` (not an open proxy).
- CORS locked to `https://ourhootshouse.github.io` (plus `http://localhost` / `127.0.0.1` for testing).
  Requests with no or another `Origin` get `403`.
- Credentials are only ever used for the one upstream request. No logging (`console.*` is not used), no KV/D1,
  no caching (`Cache-Control: no-store`), never echoed back.
- You are trusting *your own* Worker with your cookies in transit — deploy it to your own Cloudflare account.

## Deploy (about 3 minutes, free tier is plenty)

1. Install Node 18+ and log in to Cloudflare (free account is fine):
   ```bash
   npm install -g wrangler
   wrangler login
   ```
2. Deploy from this folder:
   ```bash
   cd luckysocks/worker
   wrangler deploy
   ```
   Wrangler prints your URL, e.g. `https://lucky-socks-relay.<your-subdomain>.workers.dev`.
3. Check it: `curl -H "Origin: http://localhost" https://lucky-socks-relay.<your-subdomain>.workers.dev/health`
   should return `{"ok":true,"service":"lucky-socks-relay"}`.
4. Tell the app about it, either:
   - edit `RELAY_URL` in `luckysocks/config.js` (commit + push), **or**
   - open the app → **Leagues** tab → *Relay URL* → paste the Worker URL → Save (stored in this browser only).

To allow another site (e.g. a custom domain), change `ALLOWED_ORIGINS` in `wrangler.toml` and run `wrangler deploy` again.

## Local test

```bash
wrangler dev            # serves http://localhost:8787
node --test "../test/**/*.test.*js"    # unit tests for the allow-list / CORS / credential logic (no network)
```

## Request format

```
GET /?path=<URL-encoded ESPN path + query>
X-ESPN-S2: <espn_s2 cookie value>
X-ESPN-SWID: <SWID cookie value, with braces>
X-Fantasy-Filter: <optional JSON filter>
```

Example path: `/apis/v3/games/ffl/seasons/2026/segments/0/leagues/123456?view=mTeam&view=mRoster`
