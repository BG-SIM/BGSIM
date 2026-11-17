// Final screenshot pass against the production build (http://127.0.0.1:8787).
import { chromium } from 'playwright-core';
import { chromePath } from './chrome.mjs';

const base = 'http://127.0.0.1:8787';
const post = (p, b) =>
  fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
const get = (p) => fetch(base + p).then((r) => r.json());

await post('/api/new', { seed: 20261111 });
const browser = await chromium.launch({
  executablePath: chromePath(),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(base + '/?mode=single', { waitUntil: 'networkidle' });
await page.waitForTimeout(1400);
await page.screenshot({ path: 'docs/screens/hero-select.png' });

await page.locator('.panel').filter({ hasText: '鎶ょ敳' }).first().click();
await page.waitForTimeout(2200);
await page.screenshot({ path: 'docs/screens/tavern.png' });

// buy + play to show a warband
for (let k = 0; k < 3; k++) {
  const shop = await page.$('.shop-slot .card-wrap');
  if (shop) await shop.click();
  await page.waitForTimeout(320);
  const hand = await page.$('.hand-zone .card-wrap');
  if (hand) await hand.click();
  await page.waitForTimeout(320);
}
// fill the warband so the board shot shows a real formation
const cat = await get('/api/catalog');
const pool = cat.cards.filter((c) => c.kind === 'minion' && c.inPool && c.tier >= 4);
for (let i = 0; i < 6; i++) await post('/api/debug', { cmd: 'add_minion', zone: 'board', card: pool[(i * 7 + 3) % pool.length].id });
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1300);
await page.mouse.move(12, 880);
await page.waitForTimeout(300);
await page.screenshot({ path: 'docs/screens/board.png' });

// combat shot
await page.locator('button:has-text("缁撴潫鍥炲悎")').click();
await page.waitForTimeout(1500);
if (await page.$('.combat-layer')) await page.screenshot({ path: 'docs/screens/combat.png' });
await page.waitForSelector('.combat-layer', { state: 'detached', timeout: 30000 }).catch(() => {});
await page.waitForTimeout(700);

// discover modal via a tavern spell that discovers
await post('/api/debug', { cmd: 'clear_zone', zone: 'hand' });
await post('/api/debug', { cmd: 'add_spell', zone: 'hand', card: 'BG33_101' });
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1400);
const handSpell = await page.$('.hand-zone > div');
if (handSpell) await handSpell.click({ position: { x: 40, y: 60 } });
await page.waitForTimeout(1100);
if (await page.$('.modal-backdrop')) await page.screenshot({ path: 'docs/screens/discover.png' });
const opt = await page.$('.modal [data-option]');
if (opt) await opt.click();
await page.waitForTimeout(600);

await page.locator('button:has-text("鍥鹃壌")').first().click();
await page.waitForTimeout(900);
await page.screenshot({ path: 'docs/screens/catalog.png' });

console.log('errors:', errors.slice(0, 5).join(' | ') || 'none');
await browser.close();

