import { chromium } from 'playwright-core';
import { chromePath } from './chrome.mjs';

const base = 'http://127.0.0.1:8787';
const post = (p, b) =>
  fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
const get = (p) => fetch(base + p).then((r) => r.json());

const log = (...a) => console.log(...a);

await post('/api/new', { seed: 60606 });
let st = await get('/api/state');
await post('/api/hero', { id: st.game.me.pending.options[0].id });

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

// 1) buy a minion, then drag it from hand to the board
await page.locator('.shop-slot .card-wrap').first().click();
await page.waitForTimeout(500);
let board = await page.locator('.board-row .card-wrap').count();
let hand = await page.locator('.hand-zone .card-wrap').count();
log('after buy: board', board, 'hand', hand);

const handCard = page.locator('.hand-zone .card-wrap').first();
const boardRow = page.locator('.board-row');
if (await handCard.count()) {
  await handCard.dragTo(boardRow, { targetPosition: { x: 500, y: 120 } });
  await page.waitForTimeout(700);
}
board = await page.locator('.board-row .card-wrap').count();
hand = await page.locator('.hand-zone .card-wrap').count();
log('after hand->board drag: board', board, 'hand', hand);

// 2) drag the board minion up into the shop -> sell
st = await get('/api/state');
const goldBefore = st.game.me.gold;
const boardCard = page.locator('.board-row .card-wrap').first();
if (await boardCard.count()) {
  await boardCard.dragTo(page.locator('.shop-zone'), { targetPosition: { x: 300, y: 60 } });
  await page.waitForTimeout(700);
}
st = await get('/api/state');
log('after board->shop drag: board', st.game.me.board.length, 'gold', goldBefore, '->', st.game.me.gold);

// 3) targeted spell dragged onto a board minion
await post('/api/debug', { cmd: 'add_minion', zone: 'board', card: 'BG28_300' });
await post('/api/debug', { cmd: 'clear_zone', zone: 'hand' });
await post('/api/debug', { cmd: 'add_spell', zone: 'hand', card: 'BG28_825' });
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1300);
st = await get('/api/state');
const before = st.game.me.board[0];
log('spell target test: board minion', before.id, before.atk + '/' + before.hp);
const spellHand = page.locator('.hand-zone > div').first();
if (await spellHand.count()) {
  await spellHand.dragTo(page.locator('.board-row .card-wrap').first());
  await page.waitForTimeout(900);
}
st = await get('/api/state');
const after = st.game.me.board[0];
log('after spell drag: board minion', after?.atk + '/' + after?.hp, 'kw', after?.kw.join(','), 'pending', st.game.me.pending?.kind ?? 'none');

// 4) targeted spell dragged onto a shop minion
await post('/api/debug', { cmd: 'clear_zone', zone: 'hand' });
await post('/api/debug', { cmd: 'add_spell', zone: 'hand', card: 'BG28_825' });
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1300);
st = await get('/api/state');
const shopBefore = st.game.me.shop.find((s) => s.type === 'minion');
log('shop target test: shop minion', shopBefore?.id, shopBefore?.atk + '/' + shopBefore?.hp);
const spellHand2 = page.locator('.hand-zone > div').first();
if (await spellHand2.count()) {
  await spellHand2.dragTo(page.locator('.shop-slot').first());
  await page.waitForTimeout(900);
}
st = await get('/api/state');
const shopAfter = st.game.me.shop.find((s) => s.type === 'minion');
log('after shop spell drag:', shopAfter?.atk + '/' + shopAfter?.hp, 'kw', shopAfter?.kw?.join(','), 'pending', st.game.me.pending?.kind ?? 'none');

log('errors:', errors.slice(0, 6).join(' | ') || 'none');
await browser.close();

