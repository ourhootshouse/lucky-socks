// End-to-end: real browser -> real local Worker runtime (wrangler dev on :8787) -> real ESPN.
// The demo league is public, so bogus cookies are simply ignored by ESPN; this proves routing, headers, CORS, filters.
const puppeteer = require('/workspace/shotkit/node_modules/puppeteer-core');
(async () => {
  const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'], headless: 'new' });
  const p = await b.newPage();
  await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true });
  const errors = [], workerCalls = [];
  p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('request', (r) => { if (r.url().startsWith('http://127.0.0.1:8787/?')) workerCalls.push(r.url()); });
  await p.goto('http://localhost:8795/index.html', { waitUntil: 'networkidle2' });
  await p.evaluate(() => { localStorage.clear(); localStorage.setItem('ls.relay', JSON.stringify('http://127.0.0.1:8787')); });
  await p.reload({ waitUntil: 'networkidle2' });
  await p.click('#tabs button[data-tab="leagues"]');
  await p.type('#cin', 'https://fantasy.espn.com/football/team?leagueId=42654852&teamId=1');
  await p.$eval('#priv', (d) => { d.open = true; });
  await p.type('#s2', 'AEB' + 'x'.repeat(80) + '%2Fabc');
  await p.type('#swid', '{1A2B3C4D-1111-2222-3333-ABCDEF012345}');
  await p.click('[data-act="lookup"]');
  await p.waitForSelector('[data-act="pick-team"]', { timeout: 30000 });
  await p.click('[data-act="save-league"]');
  await p.waitForSelector('.card.tip', { timeout: 40000 });
  const ok = await p.$eval('#view', (e) => /Lineup check/.test(e.innerText) && /Austin Astronauts/.test(e.innerText));
  console.log('worker calls:', workerCalls.length, '| league rendered via worker:', ok, '| errors:', JSON.stringify(errors));
  await b.close();
  process.exit(ok && workerCalls.length >= 8 && !errors.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
