// Visual smoke test: loads the app, reports console errors, screenshots the stage
// and a close-up of the first minion card. Usage: node scripts/shot.mjs [url] [out]
import { chromium } from 'playwright-core';
import { chromePath } from './chrome.mjs';
import { existsSync } from 'node:fs';

const url = process.argv[2] || 'http://localhost:5173/';
const out = process.argv[3] || 'docs/screens/dev.png';
const executablePath = chromePath();

const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text()}`);
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('requestfailed', (r) => errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));

await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 }).catch((e) => errors.push(`goto: ${e.message}`));
await page.waitForTimeout(1500);
await page.screenshot({ path: out });
const card = await page.$('.card-wrap');
if (card) {
  const box = await card.boundingBox();
  if (box) {
    await page.screenshot({
      path: out.replace(/\.png$/, '_card.png'),
      clip: { x: Math.max(0, box.x - 20), y: Math.max(0, box.y - 20), width: box.width + 40, height: box.height + 40 },
    });
    console.log('card box', JSON.stringify(box));
  }
}
const stats = await page.evaluate(() => {
  const q = (s) => document.querySelector(s);
  const r = (el) => (el ? el.getBoundingClientRect().toJSON() : null);
  return {
    stage: r(q('.stage')),
    shopRow: r(q('.shop-row')),
    boardRow: r(q('.board-row')),
    firstCard: r(q('.card-wrap')),
    firstCardInner: r(q('.card-wrap .card-inner')),
    portrait: r(q('.card-wrap .portrait')),
    stat: r(q('.card-wrap .stat-num')),
    border: r(q('.card-wrap .overlay-img')),
    cards: document.querySelectorAll('.card-wrap').length,
  };
});
console.log(JSON.stringify(stats, null, 2));
console.log(errors.slice(0, 20).join('\n') || 'no errors');
await browser.close();

