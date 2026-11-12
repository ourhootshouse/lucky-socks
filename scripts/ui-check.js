// Headless Chromium UI test against the REAL ESPN API (public demo league) + a mocked relay for the private-league path.
// Usage: node scripts/ui-check.js   (serve the app first: python3 -m http.server 8791 in luckysocks/)
const puppeteer = require('/workspace/shotkit/node_modules/puppeteer-core');
const fs = require('fs');
const BASE = process.env.BASE || 'http://localhost:8795/index.html';
const SHOTS = '/workspace/agent89-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (cond, msg) => { console.log((cond ? '  ok   ' : '  FAIL ') + msg); if (!cond) failures++; };

async function assertNoClip(page, label) {
  const issues = await page.evaluate(() => {
    const out = [];
    const brand = document.querySelector('.brand b');
    if (brand) {
      if (brand.innerText.replace(/\s+/g, ' ').trim() !== 'Agent 89') out.push('brand text: ' + JSON.stringify(brand.innerText));
      if (brand.scrollWidth > brand.clientWidth + 1) out.push('brand clipped ' + brand.scrollWidth + '>' + brand.clientWidth);
    }
    const sel = 'h1, h2, h3, .verdict .v, .tabs button span, .btn';
    for (const el of document.querySelectorAll(sel)) {
      const cs = getComputedStyle(el);
      if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 2 && (cs.whiteSpace === 'nowrap' || cs.textOverflow === 'ellipsis' || cs.overflowX === 'hidden')) {
        out.push(((el.innerText || '').trim().slice(0, 48) || el.tagName) + ' (' + el.scrollWidth + '>' + el.clientWidth + ')');
      }
    }
    return out;
  });
  check(issues.length === 0, label + ' no clipped text' + (issues.length ? ': ' + issues.join('; ') : ''));
}

async function waitText(page, sel, re, timeout = 30000) {
  await page.waitForFunction((sel, re) => { const el = document.querySelector(sel); return el && new RegExp(re).test(el.innerText); }, { timeout }, sel, re.source || re);
}
async function clickTab(page, tab) { await page.click(`#tabs button[data-tab="${tab}"]`); await sleep(150); }

async function run(name, vp, mobile) {
  console.log(`\n== ${name} ${vp.width}x${vp.height}`);
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'], headless: 'new' });
  const page = await browser.newPage();
  await page.setViewport(Object.assign({ deviceScaleFactor: mobile ? 2 : 1, isMobile: !!mobile, hasTouch: !!mobile }, vp));
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('requestfailed', (r) => errors.push('requestfailed: ' + r.url() + ' ' + (r.failure() && r.failure().errorText)));
  const shot = async (n, full) => page.screenshot({ path: `${SHOTS}/${name}-${n}.png`, fullPage: !!full });

  await page.goto(BASE + '?nc=' + Date.now(), { waitUntil: 'networkidle2' });
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem('ls.theme', JSON.stringify('dark')); });
  await page.reload({ waitUntil: 'networkidle2' });
  // PWA: manifest, icons, service worker
  const pwa = await page.evaluate(async () => {
    const link = document.querySelector('link[rel=manifest]');
    const m = await (await fetch(link.href)).json();
    const sizes = [];
    for (const i of m.icons) { const img = new Image(); img.src = new URL(i.src, link.href).href; await img.decode(); sizes.push(img.naturalWidth + 'x' + img.naturalHeight + ':' + i.purpose); }
    const reg = await Promise.race([navigator.serviceWorker.ready.then((r) => !!r.active), new Promise((r) => setTimeout(() => r(false), 8000))]);
    return { name: m.short_name, display: m.display, sizes, sw: reg, theme: document.documentElement.getAttribute('data-theme') };
  });
  check(pwa.display === 'standalone' && pwa.sizes.join() === '192x192:any,512x512:any,512x512:maskable', 'manifest + PNG icons ok ' + JSON.stringify(pwa.sizes));
  check(pwa.sw, 'service worker active');
  check(pwa.theme === 'dark', 'dark theme applied');
  check(await page.$eval('.foot', (e) => e.innerText.includes('Fan-made. Not affiliated with the NFL, ESPN, or any team.')), 'footer disclaimer present');
  check(await page.$eval('.hero h1', (e) => /Agent 89/.test(e.innerText)), 'connect hero shown with no leagues');
  check(await page.$eval('.brand b', (e) => e.innerText.trim() === 'Agent 89' && e.scrollWidth <= e.clientWidth + 1), 'header title Agent 89 is fully visible');
  await assertNoClip(page, 'connect');
  await shot('1-connect');

  // ---- demo league (real API)
  await page.click('[data-act="demo"]');
  await page.waitForSelector('.card.tip', { timeout: 40000 });
  await waitText(page, '#view', /Lineup check/);
  check(await page.$eval('#view', (e) => /FFLR Test League/.test(e.innerText)), 'demo league loaded from ESPN');
  check((await page.$$('.pl')).length >= 14, 'roster rows rendered');
  check(await page.$eval('.meter', (e) => /risk \d+%/.test(e.innerText)), 'risk meter visible');
  const txt = await page.$eval('#view', (e) => e.innerText);
  check(/OUT|IR/.test(txt) && /BYE|vs |@ /.test(txt), 'injury badges + opponents shown');
  check(/Suggested swaps/i.test(txt), 'lineup check suggests swaps for the demo roster');
  await assertNoClip(page, 'team');
  await shot('2-team');
  await shot('2-team-full', true);

  // ---- trade
  await clickTab(page, 'trade');
  await page.waitForSelector('#partner');
  const rows = await page.$$('.cols .card:nth-child(1) .pl.pick');
  await rows[1].click(); await sleep(100);
  const theirRows = await page.$$('.cols .card:nth-child(2) .pl.pick');
  await theirRows[0].click(); await sleep(100);
  check(!(await page.$eval('[data-act="evaluate"]', (b) => b.disabled)), 'evaluate enabled after picks');
  await page.click('[data-act="evaluate"]'); await page.waitForSelector('#result');
  await sleep(600);
  const res = await page.$eval('#result', (e) => e.innerText);
  check(/Ice up, son|Keep pounding|Dead even|Shaky intel|Fumble/.test(res) && /why/i.test(res) && /pts\/week/.test(res), 'trade verdict + reasons rendered');
  await assertNoClip(page, 'trade result');
  await shot('3-trade-result');
  await page.evaluate(() => document.getElementById('result').scrollIntoView());
  await shot('3-trade-result-card');
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot('3-trade');

  // ---- ideas
  await clickTab(page, 'ideas');
  await waitText(page, '#view', /Position report/);
  await page.waitForFunction(() => /\bIntel\b/.test(document.getElementById('view').innerText), { timeout: 20000 });
  const ideaCount = (await page.$$('[data-act="open-idea"]')).length;
  check(ideaCount >= 3 && ideaCount <= 5, `3-5 trade ideas (${ideaCount})`);
  await shot('4-ideas'); await shot('4-ideas-full', true);
  await page.click('[data-act="open-idea"]'); await page.waitForSelector('#result');
  check(await page.$eval('#partner', (s) => !!s.value), 'idea opens in evaluator');

  // ---- waivers
  await clickTab(page, 'waivers');
  await waitText(page, '#view', /Recommended pickups/);
  const addCards = await page.$$eval('#view .card .sec', (els) => els.filter((e) => e.innerText === 'ADD' || e.innerText === 'Add').length);
  check(addCards >= 1, `add/drop recommendations (${addCards})`);
  check(/Free agent|Waivers/.test(await page.$eval('#view', (e) => e.innerText)), 'waiver vs free agent status shown');
  await page.click('[data-act="waiver-pos"][data-pos="2"]'); await sleep(100);
  await shot('5-waivers'); await shot('5-waivers-full', true);

  // ---- remind
  await clickTab(page, 'remind');
  check(/Grok Bot reminder/.test(await page.$eval('#view', (e) => e.innerText)), 'Grok Bot reminder note present');
  const ics = await page.evaluate(async () => { const orig = URL.createObjectURL; let blob; URL.createObjectURL = (b) => { blob = b; return orig.call(URL, b); }; document.querySelector('[data-act="ics"]').click(); await new Promise((r) => setTimeout(r, 200)); return blob ? await blob.text() : null; });
  check(ics && /BEGIN:VCALENDAR/.test(ics) && (ics.match(/BEGIN:VALARM/g) || []).length === 2, '.ics generated with 2 alarms');
  await shot('6-remind');

  // ---- leagues + private explainer (real 401 from ESPN)
  await clickTab(page, 'leagues');
  await page.type('#cin', 'https://fantasy.espn.com/football/team?leagueId=1066964&teamId=1');
  await page.click('[data-act="lookup"]');
  await waitText(page, '#view', /Make League Viewable to Public/);
  const priv = await page.$eval('#view', (e) => e.innerText);
  check(/LM Tools/.test(priv) && /Basic Settings/.test(priv) && /espn_s2/.test(priv), 'private-league explainer (public setting + cookies)');
  await shot('7-private-explainer', true);
  // saved league list + relay card
  check(/Relay \(private leagues\)/.test(priv), 'relay settings card present');
  check(errors.filter((e) => !/401|Failed to load resource/.test(e)).length === 0, 'no console/page errors in main flows' + (errors.length ? ': ' + errors.join(' | ') : ''));

  // ---- private league via mocked relay (verifies the cookie headers reach the relay, public league data stands in)
  console.log('  -- relay flow');
  await page.setRequestInterception(true);
  const relayCalls = [];
  page.on('request', async (req) => {
    const u = req.url();
    if (!u.startsWith('http://relay.test')) return req.continue();
    if (req.method() === 'OPTIONS') return req.respond({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
    const h = req.headers();
    relayCalls.push({ s2: h['x-espn-s2'], swid: h['x-espn-swid'], path: new URL(u).searchParams.get('path') });
    const path = new URL(u).searchParams.get('path');
    const f = h['x-fantasy-filter'];
    const r = await fetch('https://lm-api-reads.fantasy.espn.com' + path.replace('1066964', '42654852'), { headers: f ? { 'X-Fantasy-Filter': f } : {} });
    req.respond({ status: r.status, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: await r.text() });
  });
  await page.evaluate(() => localStorage.setItem('ls.relay', JSON.stringify('http://relay.test')));
  await page.reload({ waitUntil: 'networkidle2' });
  await clickTab(page, 'leagues');
  await page.$eval('#cin', (e) => { e.value = ''; });
  await page.type('#cin', 'https://fantasy.espn.com/football/team?leagueId=1066964&teamId=2');
  await page.$eval('#priv', (d) => { d.open = true; });
  await page.type('#s2', 'AEB' + 'x'.repeat(80) + '%2Fabc');
  await page.type('#swid', '{1A2B3C4D-1111-2222-3333-ABCDEF012345}');
  await page.click('[data-act="lookup"]');
  await page.waitForSelector('[data-act="pick-team"]', { timeout: 30000 });
  await shot('8-private-teampick');
  await page.click('[data-act="save-league"]');
  await page.waitForSelector('.card.tip', { timeout: 40000 });
  check(relayCalls.length >= 3 && relayCalls.every((c) => /^AEBx/.test(c.s2) && c.swid === '{1A2B3C4D-1111-2222-3333-ABCDEF012345}'), `private league requests went via relay with cookie headers (${relayCalls.length} calls)`);
  check(relayCalls.every((c) => c.path.startsWith('/apis/v3/games/ffl/')), 'relay only receives ESPN ffl paths');
  const stored = await page.evaluate(() => localStorage.getItem('ls.leagues'));
  check(/"s2":"AEBx/.test(stored), 'cookies stored per league in localStorage');
  await clickTab(page, 'leagues');
  const lg = await page.$eval('#view', (e) => e.innerText);
  check(/AEBx••••••/.test(lg) && !lg.includes('x'.repeat(30)), 'cookie display is masked');
  await shot('9-leagues-saved', true);
  check(errors.filter((e) => !/401|Failed to load resource/.test(e)).length === 0, 'no console/page errors after relay flow' + (errors.length ? ': ' + errors.join(' | ') : ''));

  // ---- light mode
  await page.click('#themeBtn'); await clickTab(page, 'team'); await sleep(300);
  await shot('10-team-light');
  await browser.close();
  return errors;
}

(async () => {
  await run('mobile', { width: 390, height: 844 }, true);
  await run('desktop', { width: 1280, height: 800 }, false);
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL UI CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
