// Renders icons/*.png from an inline SVG with headless Chrome (puppeteer-core). Run: node scripts/make-icons.js
const puppeteer = require('/workspace/shotkit/node_modules/puppeteer-core');
const path = require('path');
const sock = (scale) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="100%" height="100%">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1b2150"/><stop offset="1" stop-color="#5b2a86"/></linearGradient>
    <linearGradient id="sk" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#ffe3ea"/></linearGradient>
    <clipPath id="shape"><path d="M196 96h120v196c0 14 6 26 18 34l60 40c30 20 42 50 30 82-12 32-48 46-84 34l-98-34c-40-14-60-44-60-86z"/></clipPath>
  </defs>
  <rect width="512" height="512" fill="url(#bg)"/>
  <g transform="translate(256 256) scale(${scale}) translate(-256 -256)">
    <ellipse cx="256" cy="452" rx="170" ry="16" fill="#000" opacity=".25"/>
    <path d="M196 96h120v196c0 14 6 26 18 34l60 40c30 20 42 50 30 82-12 32-48 46-84 34l-98-34c-40-14-60-44-60-86z" fill="url(#sk)" stroke="#ff4d6d" stroke-width="10" stroke-linejoin="round"/>
    <g clip-path="url(#shape)">
      <rect x="150" y="86" width="230" height="62" fill="#ff4d6d"/>
      <rect x="150" y="190" width="230" height="26" fill="#ffd166"/>
      <rect x="150" y="238" width="230" height="26" fill="#ff4d6d"/>
      <path d="M150 372l260 90v60H150z" fill="#ffd166" opacity=".9"/>
      <ellipse cx="400" cy="470" rx="70" ry="60" fill="#ff4d6d"/>
    </g>
    <path d="M196 96h120v196c0 14 6 26 18 34l60 40c30 20 42 50 30 82-12 32-48 46-84 34l-98-34c-40-14-60-44-60-86z" fill="none" stroke="#ff4d6d" stroke-width="10" stroke-linejoin="round"/>
    <g fill="#ffd166"><path d="M404 130l10 22 24 4-18 16 5 24-21-12-21 12 5-24-18-16 24-4z"/><path d="M110 200l6 13 14 2-10 10 3 14-13-7-13 7 3-14-10-10 14-2z" opacity=".9"/></g>
  </g>
</svg>`;
(async () => {
  const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'], headless: 'new' });
  const p = await b.newPage();
  const out = path.join(__dirname, '..', 'icons');
  const jobs = [['icon-192.png', 192, 0.9], ['icon-512.png', 512, 0.9], ['icon-maskable-512.png', 512, 0.68], ['apple-touch-icon.png', 180, 0.8], ['favicon-32.png', 32, 0.95]];
  for (const [name, size, scale] of jobs) {
    await p.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
    await p.setContent(`<html><body style="margin:0;width:${size}px;height:${size}px">${sock(scale)}</body></html>`);
    await p.screenshot({ path: path.join(out, name), clip: { x: 0, y: 0, width: size, height: size } });
  }
  await b.close();
})();
