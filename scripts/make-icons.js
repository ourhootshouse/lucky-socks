// Renders icons/*.png as an "89" jersey-number badge with headless Chrome (puppeteer-core). Run: node scripts/make-icons.js
const puppeteer = require('/workspace/shotkit/node_modules/puppeteer-core');
const path = require('path');
const FONT_DIR = '/usr/share/fonts/truetype/sand-box/google/Barlow Condensed';
const fontUrl = (file) => 'url("file://' + path.join(FONT_DIR, file) + '")';

function mark(scale, size) {
  const showWord = size >= 180;
  const plate = `
    <div class="plate">
      ${showWord ? '<div class="word">AGENT</div>' : ''}
      <div class="num">89</div>
    </div>`;
  return `
<style>
  @font-face { font-family: 'BC'; font-weight: 700; src: ${fontUrl('BarlowCondensed-Bold.ttf')} format('truetype'); }
  @font-face { font-family: 'BC'; font-weight: 900; src: ${fontUrl('BarlowCondensed-Black.ttf')} format('truetype'); }
  html, body { margin: 0; width: ${size}px; height: ${size}px; overflow: hidden; }
  .field {
    width: ${size}px; height: ${size}px;
    display: flex; align-items: center; justify-content: center;
    background: linear-gradient(160deg, #0B2265 0%, #071018 100%);
  }
  .inner { transform: scale(${scale}); transform-origin: center center; }
  .plate {
    box-sizing: border-box;
    width: ${size * 0.72}px; height: ${size * 0.72}px;
    border: ${Math.max(2, Math.round(size * 0.028))}px solid #0085CA;
    border-radius: ${Math.round(size * 0.1)}px;
    background: #0a1a3a;
    box-shadow: inset 0 0 0 ${Math.max(1, Math.round(size * 0.01))}px #1a4aa8;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    color: #fff;
  }
  .word {
    font-family: BC, sans-serif;
    font-weight: 700;
    font-size: ${Math.round(size * 0.09)}px;
    letter-spacing: 0.28em;
    color: #0085CA;
    margin: 0 0 ${Math.round(size * 0.01)}px 0.28em;
    line-height: 1;
  }
  .num {
    font-family: BC, sans-serif;
    font-weight: 900;
    font-size: ${Math.round(size * (showWord ? 0.38 : 0.48))}px;
    letter-spacing: -0.04em;
    line-height: 0.85;
    color: #fff;
    text-shadow: 0 ${Math.max(1, Math.round(size * 0.012))}px 0 rgba(0,133,202,.45);
  }
</style>
<div class="field"><div class="inner">${plate}</div></div>`;
}

(async () => {
  const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--allow-file-access-from-files'], headless: 'new' });
  const p = await b.newPage();
  const out = path.join(__dirname, '..', 'icons');
  const jobs = [['icon-192.png', 192, 0.95], ['icon-512.png', 512, 0.95], ['icon-maskable-512.png', 512, 0.72], ['apple-touch-icon.png', 180, 0.88], ['favicon-32.png', 32, 0.98]];
  for (const [name, size, scale] of jobs) {
    await p.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
    await p.setContent(`<!doctype html><html><body>${mark(scale, size)}</body></html>`);
    await p.evaluate(() => document.fonts.ready);
    await p.screenshot({ path: path.join(out, name), clip: { x: 0, y: 0, width: size, height: size } });
  }
  await b.close();
})();
