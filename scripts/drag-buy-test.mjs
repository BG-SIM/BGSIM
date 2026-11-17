import { chromium } from 'playwright-core';
import { chromePath } from './chrome.mjs';

const base = 'http://127.0.0.1:8787';
const post = (p, b) =>
  fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
const get = (p) => fetch(base + p).then((r) => r.json());

await post('/api/new', { seed: 31416 });
let st = await get('/api/state');
await post('/api/hero', { id: st.game.me.pending.options[0].id });
st = await get('/api/state');
console.log('start gold', st.game.me.gold, 'hand', st.game.me.hand.length, 'shop', st.game.me.shop.length);

const browser = await chromium.launch({
  executablePath: chromePath(),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('same key')) errors.push('console: ' + m.text().slice(0, 160));
});
await page.goto(base + '/?mode=single', { waitUntil: 'networkidle' });
await page.waitForTimeout(1400);

// mid-drag screenshot: shop minion over the hand zone
const slot = page.locator('.shop-slot').first();
const src = await slot.boundingBox();
const dst = await page.locator('.hand-zone').boundingBox();
await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2);
await page.mouse.down();
await page.mouse.move(src.x + 30, src.y + 40, { steps: 8 });
await page.mouse.move(dst.x + dst.width / 2, dst.y + dst.height / 2, { steps: 12 });
await page.waitForTimeout(250);
console.log('buy overlay', !!(await page.$('.drop-overlay.hand-drop')), 'ghost', !!(await page.$('.drag-ghost')));
await page.screenshot({ path: 'docs/screens/drag-buy.png' });
await page.mouse.up();
await page.waitForTimeout(800);

st = await get('/api/state');
console.log('after shop->hand drag: gold', st.game.me.gold, 'hand', st.game.me.hand.length, 'shop', st.game.me.shop.length);
console.log('errors', errors.slice(0, 4).join(' | ') || 'none');
await browser.close();

