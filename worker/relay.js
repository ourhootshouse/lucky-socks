/**
 * Lucky Socks relay logic (imported by worker.js; kept separate because Cloudflare Workers only allow handler exports from the entry module) — a tiny Cloudflare Worker that lets the static Lucky Socks app read a PRIVATE
 * ESPN fantasy league. Browsers can't send ESPN cookies cross-site, so the app sends the user's
 * espn_s2 / SWID values to this Worker in request headers and the Worker forwards them to ESPN as cookies.
 *
 * Safety properties (all covered by test/worker.test.mjs):
 *  - Only proxies GET to https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/** (no open proxy).
 *  - CORS is restricted to ALLOWED_ORIGINS (default https://ourhootshouse.github.io) plus localhost for testing;
 *    requests with no / other Origin are refused.
 *  - Credentials are validated for shape (no header injection), used for one upstream request, and never
 *    logged, stored, cached or echoed back. There are intentionally no console.* calls in this file.
 */
export const ESPN_ORIGIN = 'https://lm-api-reads.fantasy.espn.com';
export const PATH_PREFIX = '/apis/v3/games/ffl/';
export const DEFAULT_ALLOWED_ORIGINS = ['https://ourhootshouse.github.io'];
const LOCALHOST = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;
const SWID_RE = /^\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}$/;
const S2_RE = /^[A-Za-z0-9%._~+\/=-]{30,4096}$/;
const EXPOSE = 'X-Fantasy-Filter-Player-Count, X-Fantasy-Server-Time';

export function allowedOrigins(env) {
  const raw = env && env.ALLOWED_ORIGINS;
  return raw ? String(raw).split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_ALLOWED_ORIGINS;
}

export function originAllowed(origin, env) {
  if (!origin) return false;
  if (allowedOrigins(env).includes(origin)) return true;
  if (env && String(env.ALLOW_LOCALHOST) === 'false') return false;
  return LOCALHOST.test(origin);
}

/** Returns a URL on the ESPN host, or null if `path` isn't an allowed fantasy-football API path. */
export function resolveUpstream(path) {
  if (typeof path !== 'string' || path.length < 2 || path.length > 4096) return null;
  if (path[0] !== '/' || path[1] === '/' || path[1] === '\\') return null;
  if (/[\u0000-\u001f\u007f\\]/.test(path)) return null;
  let url;
  try { url = new URL(path, ESPN_ORIGIN); } catch (e) { return null; }
  if (url.origin !== ESPN_ORIGIN || url.username || url.password) return null;
  if (!url.pathname.startsWith(PATH_PREFIX)) return null;
  return url;
}

export function validCreds(s2, swid) {
  return typeof s2 === 'string' && typeof swid === 'string' && S2_RE.test(s2) && SWID_RE.test(swid);
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'X-ESPN-S2, X-ESPN-SWID, X-Fantasy-Filter, Content-Type',
    'Access-Control-Expose-Headers': EXPOSE,
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

function json(status, body, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }, origin ? corsHeaders(origin) : {}),
  });
}

export async function handleRequest(request, env, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  const origin = request.headers.get('Origin');
  if (!originAllowed(origin, env)) return json(403, { error: 'origin_not_allowed' });
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (request.method !== 'GET') return json(405, { error: 'method_not_allowed' }, origin);

  const reqUrl = new URL(request.url);
  if (reqUrl.pathname === '/health') return json(200, { ok: true, service: 'lucky-socks-relay' }, origin);
  const upstream = resolveUpstream(reqUrl.searchParams.get('path'));
  if (!upstream) return json(400, { error: 'bad_path', hint: 'path must be an ESPN fantasy football API path starting with ' + PATH_PREFIX }, origin);

  const s2 = request.headers.get('X-ESPN-S2'), swid = request.headers.get('X-ESPN-SWID');
  if (!validCreds(s2, swid)) return json(400, { error: 'bad_credentials', hint: 'send X-ESPN-S2 and X-ESPN-SWID headers' }, origin);

  const headers = { Cookie: `espn_s2=${s2}; SWID=${swid}`, Accept: 'application/json', 'User-Agent': 'LuckySocks-Relay/1.0' };
  const filter = request.headers.get('X-Fantasy-Filter');
  if (filter) {
    if (filter.length > 8192) return json(400, { error: 'filter_too_long' }, origin);
    headers['X-Fantasy-Filter'] = filter;
  }

  let res;
  try { res = await doFetch(upstream.toString(), { method: 'GET', headers, redirect: 'manual' }); }
  catch (e) { return json(502, { error: 'upstream_unreachable' }, origin); }
  if (res.status >= 300 && res.status < 400) return json(502, { error: 'upstream_redirect' }, origin);

  // Pass the body through untouched; never forward upstream cookies or caching headers.
  const out = Object.assign({ 'Content-Type': res.headers.get('Content-Type') || 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }, corsHeaders(origin));
  const count = res.headers.get('X-Fantasy-Filter-Player-Count');
  if (count) out['X-Fantasy-Filter-Player-Count'] = count;
  return new Response(res.body, { status: res.status, headers: out });
}
