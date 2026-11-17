// Regenerates the screenshots used by README.md, against a throwaway engine
// (never the game running on :8787). Run `npm run build` first.
//
//   node scripts/readme-shots.mjs
//
// Screenshots are taken in a fresh browser context, so no localStorage layout is
// applied: what you see is the shipped DEFAULT_LAYOUT.
import { chromium } from 'playwright-core';
import { chromePath } from './chrome.mjs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, get, post, sleep, startEngine } from './lib/harness.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'screens');
const W = 1600;
const H = 900;

const port = await freePort();
const engine = await startEngine(port);
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({ executablePath: chromePath(), headless: true });
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 160)));

const shot = async (name) => {
  await page.screenshot({ path: join(OUT, name) });
  console.log('shot', name);
};
const wait = (ms) => page.waitForTimeout(ms);

/** A believable mid-game board/shop/hand, same recipe as the layout editor. */
async function demoScene() {
  const cat = await get(port, '/api/catalog');
  const minions = (cat.cards ?? []).filter((c) => c.kind === 'minion' && c.inPool && c.tier >= 3 && c.tier <= 5);
  const spells = (cat.cards ?? []).filter((c) => c.kind === 'tavern_spell');
  const trinkets = (cat.cards ?? []).filter((c) => typeof c.kind === 'string' && c.kind.startsWith('trinket'));
  await post(port, '/api/debug', { cmd: 'set_player', gold: 10, tier: 4, health: 22, armor: 5 });
  await post(port, '/api/debug', { cmd: 'clear_zone', zone: 'shop' });
  await post(port, '/api/debug', { cmd: 'clear_zone', zone: 'board' });
  for (let i = 0; i < 7; i++) {
    const c = minions[(i * 7 + 3) % Math.max(1, minions.length)];
    if (c) await post(port, '/api/debug', { cmd: 'add_minion', zone: 'board', card: c.id });
  }
  for (let i = 0; i < 6; i++) {
    const c = minions[(i * 11 + 5) % Math.max(1, minions.length)];
    if (c) await post(port, '/api/debug', { cmd: 'add_minion', zone: 'shop', card: c.id });
  }
  if (spells[0]) await post(port, '/api/debug', { cmd: 'add_spell', zone: 'shop', card: spells[0].id });
  if (spells[1]) await post(port, '/api/debug', { cmd: 'add_spell', zone: 'hand', card: spells[1].id });
  if (minions[0]) await post(port, '/api/debug', { cmd: 'add_minion', zone: 'hand', card: minions[0].id });
  for (let i = 0; i < 2 && i < trinkets.length; i++) {
    await post(port, '/api/debug', { cmd: 'give_trinket', card: trinkets[i].id });
  }
}

try {
  // 1) home
  await page.goto(base + '/', { waitUntil: 'networkidle' });
  await wait(1400);
  await shot('home.png');

  // 2) hero select
  await post(port, '/api/new', { seed: 20261111 });
  await page.goto(base + '/?mode=single', { waitUntil: 'networkidle' });
  await wait(1500);
  await shot('hero-select.png');

  // 3) tavern with a real formation
  const st = await get(port, '/api/state');
  const pending = st.game?.me?.pending;
  if (pending?.kind === 'hero' && pending.options?.[0]) {
    await post(port, '/api/hero', { id: pending.options[0].id });
  }
  await demoScene();
  await page.reload({ waitUntil: 'networkidle' });
  await wait(1600);
  await page.mouse.move(10, 890);
  await wait(300);
  await shot('table2.png');

  // 4) board close-up (hover a minion so the tooltip is visible)
  const boardCard = page.locator('.board-row .card-wrap').first();
  if (await boardCard.count()) {
    await boardCard.hover();
    await wait(500);
  }
  await shot('board.png');

  // 5) combat
  await page.mouse.move(10, 890);
  await page.keyboard.press('Space');
  await page.waitForSelector('.combat-layer', { timeout: 20000 }).catch(() => {});
  await wait(900);
  if (await page.locator('.combat-layer').count()) await shot('combat.png');
  await page.waitForSelector('.combat-layer', { state: 'detached', timeout: 40000 }).catch(() => {});
  await wait(600);

  // 6) discover
  await post(port, '/api/debug', { cmd: 'clear_zone', zone: 'hand' });
  await post(port, '/api/debug', { cmd: 'add_spell', zone: 'hand', card: 'BG33_101' });
  await page.reload({ waitUntil: 'networkidle' });
  await wait(1500);
  await page.locator('.hand-card').first().click({ position: { x: 50, y: 70 } });
  await wait(1200);
  await shot('discover.png');
  await page.keyboard.press('Escape');
  await wait(400);

  // 7) dark gift: walk to turn 4 so the gift is unlocked, open the picker
  for (let i = 0; i < 4; i++) {
    const s = await get(port, '/api/state');
    if (s.game?.me?.pending) break;
    if (s.game?.turn >= 4) break;
    await page.keyboard.press('Space');
    await page.waitForSelector('.combat-layer', { state: 'detached', timeout: 40000 }).catch(() => {});
    await wait(500);
  }
  await page.reload({ waitUntil: 'networkidle' });
  await wait(1500);
  const gift = page.locator('.gift-btn');
  if (await gift.count()) {
    await gift.click();
    await wait(1400);
    await shot('darkgift.png');
    // Clear the pending pick so the next screenshots start from a clean table.
    await post(port, '/api/choose', { option: 0 }).catch(() => {});
    await wait(600);
  }

  // 8) layout editor: a fresh game so no picker is left on screen
  await post(port, '/api/new', { seed: 20261112 });
  await page.reload({ waitUntil: 'networkidle' });
  await wait(800);
  const fresh = await get(port, '/api/state');
  if (fresh.game?.me?.pending?.kind === 'hero' && fresh.game.me.pending.options?.[0]) {
    await post(port, '/api/hero', { id: fresh.game.me.pending.options[0].id });
  }
  await demoScene();
  await page.goto(base + '/?mode=single&edit=1', { waitUntil: 'networkidle' });
  await wait(1800);
  await shot('editor.png');
} finally {
  await browser.close();
  engine.stop();
  await sleep(300);
}

console.log('page errors:', errors.slice(0, 5).join(' | ') || 'none');
