import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/worker.js';
import { handleRequest, resolveUpstream, validCreds, originAllowed, ESPN_ORIGIN } from '../worker/relay.js';

const S2 = 'AEB' + 'x'.repeat(60) + '%2Fyz';
const SWID = '{1A2B3C4D-1111-2222-3333-ABCDEF012345}';
const ORIGIN = 'https://ourhootshouse.github.io';
const PATH = '/apis/v3/games/ffl/seasons/2026/segments/0/leagues/123?view=mTeam&view=mRoster';

function req(opts = {}) {
  const headers = new Headers();
  if (opts.origin !== null) headers.set('Origin', opts.origin || ORIGIN);
  if (opts.s2 !== null) headers.set('X-ESPN-S2', opts.s2 || S2);
  if (opts.swid !== null) headers.set('X-ESPN-SWID', opts.swid || SWID);
  if (opts.filter) headers.set('X-Fantasy-Filter', opts.filter);
  const path = opts.path === undefined ? PATH : opts.path;
  const url = 'https://relay.example.workers.dev/' + (opts.route || '') + (path === null ? '' : '?path=' + encodeURIComponent(path));
  return new Request(url, { method: opts.method || 'GET', headers });
}
function spyFetch(body = '{"ok":true}', status = 200, extra = {}) {
  const calls = [];
  const f = async (url, init) => { calls.push({ url, init }); return new Response(body, { status, headers: Object.assign({ 'Content-Type': 'application/json;charset=utf-8', 'Set-Cookie': 'evil=1', 'X-Fantasy-Filter-Player-Count': '7' }, extra) }); };
  f.calls = calls;
  return f;
}

test('proxies an allowed path to ESPN with the cookies and filter, and nothing else', async () => {
  const f = spyFetch();
  const res = await handleRequest(req({ filter: '{"players":{}}' }), {}, f);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, ESPN_ORIGIN + PATH);
  assert.equal(f.calls[0].init.headers.Cookie, `espn_s2=${S2}; SWID=${SWID}`);
  assert.equal(f.calls[0].init.headers['X-Fantasy-Filter'], '{"players":{}}');
  assert.equal(f.calls[0].init.method, 'GET');
  assert.equal(f.calls[0].init.redirect, 'manual');
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.equal(res.headers.get('Set-Cookie'), null, 'upstream cookies are not forwarded');
  assert.equal(res.headers.get('X-Fantasy-Filter-Player-Count'), '7');
});

test('credentials are never echoed in the response (headers or body), even on errors', async () => {
  for (const f of [spyFetch(), spyFetch('{"messages":["nope"]}', 401), async () => { throw new Error(`boom ${S2}`); }]) {
    const res = await handleRequest(req(), {}, f);
    const text = await res.text() + JSON.stringify([...res.headers]);
    assert.ok(!text.includes(S2) && !text.includes(SWID) && !text.includes('x'.repeat(30)));
  }
});

test('upstream status codes (401 for private/unauthorised) pass through to the app', async () => {
  assert.equal((await handleRequest(req(), {}, spyFetch('{"messages":["x"]}', 401))).status, 401);
  assert.equal((await handleRequest(req(), {}, spyFetch('{}', 404))).status, 404);
});

test('allow-list: refuses other hosts, other sports, traversal, odd schemes', async () => {
  const bad = [
    'https://evil.example.com/apis/v3/games/ffl/x', '//evil.example.com/apis/v3/games/ffl/x', '/\\evil.example.com/apis/v3/games/ffl/x',
    '/apis/v3/games/fba/seasons/2026', '/apis/v3/games/ffl/../../../secret', '/apis/v3/games/ffl/%2e%2e/%2e%2e/x', '/other', '/', '', 'apis/v3/games/ffl/x',
    'javascript:alert(1)', '/apis/v3/games/ffl/x\r\nHost: evil', '@evil.example.com/apis/v3/games/ffl/', '/apis/v3/games/ffl@evil.example.com/',
  ];
  for (const p of bad) {
    const f = spyFetch();
    const res = await handleRequest(req({ path: p }), {}, f);
    const u = resolveUpstream(p);
    assert.ok(res.status === 400, `${JSON.stringify(p)} -> ${res.status} (upstream ${u})`);
    assert.equal(f.calls.length, 0);
  }
  assert.equal((await handleRequest(req({ path: null }), {}, spyFetch())).status, 400);
  // the "@" case that is a legit path segment must stay on the ESPN host
  const u = resolveUpstream('/apis/v3/games/ffl/seasons/2026/@x');
  assert.equal(u.origin, ESPN_ORIGIN);
});

test('CORS: only the Lucky Socks origin (and localhost) may call; others and no-Origin get 403', async () => {
  assert.equal((await handleRequest(req({ origin: 'https://evil.example.com' }), {}, spyFetch())).status, 403);
  assert.equal((await handleRequest(req({ origin: null }), {}, spyFetch())).status, 403);
  assert.equal((await handleRequest(req({ origin: 'http://ourhootshouse.github.io' }), {}, spyFetch())).status, 403);
  assert.equal((await handleRequest(req({ origin: 'https://ourhootshouse.github.io.evil.com' }), {}, spyFetch())).status, 403);
  assert.equal((await handleRequest(req({ origin: 'http://localhost:8080' }), {}, spyFetch())).status, 200);
  assert.equal((await handleRequest(req({ origin: 'http://127.0.0.1:5500' }), {}, spyFetch())).status, 200);
  assert.equal((await handleRequest(req({ origin: 'http://localhost:8080' }), { ALLOW_LOCALHOST: 'false' }, spyFetch())).status, 403);
  assert.equal(originAllowed('https://mydomain.example', { ALLOWED_ORIGINS: 'https://mydomain.example, https://x.y' }), true);
  assert.equal(originAllowed(ORIGIN, { ALLOWED_ORIGINS: 'https://mydomain.example' }), false);
});

test('OPTIONS preflight returns CORS headers allowing the custom headers', async () => {
  const res = await handleRequest(new Request('https://relay.example/', { method: 'OPTIONS', headers: { Origin: ORIGIN } }), {}, spyFetch());
  assert.equal(res.status, 204);
  assert.match(res.headers.get('Access-Control-Allow-Headers'), /X-ESPN-S2/i);
  assert.match(res.headers.get('Access-Control-Allow-Headers'), /X-ESPN-SWID/i);
  assert.match(res.headers.get('Access-Control-Allow-Headers'), /X-Fantasy-Filter/i);
  const bad = await handleRequest(new Request('https://relay.example/', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }), {}, spyFetch());
  assert.equal(bad.status, 403);
});

test('rejects non-GET methods, missing or malformed credentials (header injection safe)', async () => {
  assert.equal((await handleRequest(req({ method: 'POST' }), {}, spyFetch())).status, 405);
  assert.equal((await handleRequest(req({ s2: null }), {}, spyFetch())).status, 400);
  assert.equal((await handleRequest(req({ swid: null }), {}, spyFetch())).status, 400);
  assert.equal((await handleRequest(req({ swid: 'not-a-swid' }), {}, spyFetch())).status, 400);
  assert.equal((await handleRequest(req({ s2: 'short' }), {}, spyFetch())).status, 400);
  assert.equal(validCreds(S2 + '; evil=1', SWID), false);
  assert.equal(validCreds(S2, SWID), true);
  assert.equal((await handleRequest(req({ filter: 'x'.repeat(9000) }), {}, spyFetch())).status, 400);
});

test('upstream failures become 502 without leaking detail; redirects are not followed', async () => {
  const boom = await handleRequest(req(), {}, async () => { throw new Error('dns'); });
  assert.equal(boom.status, 502);
  const redir = await handleRequest(req(), {}, async () => new Response(null, { status: 302, headers: { Location: 'https://espn.com/login' } }));
  assert.equal(redir.status, 502);
});

test('health endpoint works for allowed origins and the default export delegates to handleRequest', async () => {
  const res = await handleRequest(req({ route: 'health', path: null, s2: null, swid: null }), {}, spyFetch());
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
  const def = await worker.fetch(req({ origin: 'https://evil.example.com' }), {});
  assert.equal(def.status, 403);
});

test('worker source never logs or stores credentials', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../worker/relay.js', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/console\./.test(code));
  assert.ok(!/\b(KV|caches|localStorage|waitUntil)\b/.test(code));
});

test('entry module only exports a default handler (Cloudflare rejects other exports)', async () => {
  const mod = await import('../worker/worker.js');
  assert.deepEqual(Object.keys(mod), ['default']);
  assert.equal(typeof mod.default.fetch, 'function');
});
