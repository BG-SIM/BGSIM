// Regression + feel metrics for the board UI.
// Usage: node scripts/feel-test.mjs [appUrl] [engineUrl]
import { chromium } from 'playwright-core';
import { chromePath } from './chrome.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.argv[2] || 'http://localhost:5174';
const ENGINE = process.argv[3] || 'http://127.0.0.1:8799';
const CHROME = chromePath();

const post = (p, b) =>
  fetch(ENGINE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
const get = (p) => fetch(ENGINE + p).then((r) => r.json());

const fail = [];
const ok = [];
function check(name, cond, detail = '') {
  (cond ? ok : fail).push(`${name}${detail ? ' — ' + detail : ''}`);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

/* ── fresh game ─────────────────────────────────────────────── */
await post('/api/new', { seed: 987654 });
let st = await get('/api/state');
if (st.game.phase === 'hero_select') {
  st = await post('/api/hero', { id: st.game.me.pending.options[0].id });
}
await post('/api/debug', { cmd: 'set_player', gold: 20 });
st = await get('/api/state');
console.log('start:', { turn: st.game.turn, gold: st.game.me.gold, shop: st.game.me.shop.length, hand: st.game.me.hand.length, board: st.game.me.board.length });

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200));
});

await page.goto(APP + '/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

/* ── 0. launcher: three modes, single player opens the game ───── */
{
  const cards = await page.evaluate(() =>
    [...document.querySelectorAll('.home-card')].map((el) => ({
      mode: el.getAttribute('data-mode'),
      title: el.querySelector('.home-card-title')?.textContent ?? '',
      items: el.querySelectorAll('.home-item').length,
      clickable: el.getAttribute('role') === 'button',
    })),
  );
  check(
    'the launcher lists single player, multiplayer and resource packs',
    cards.length === 3 && cards.map((c) => c.mode).join(',') === 'single,multi,packs',
    JSON.stringify(cards),
  );
  check(
    'only single player is clickable for now',
    cards[0]?.clickable === true && cards[1]?.clickable === false && cards[2]?.clickable === false,
    JSON.stringify(cards.map((c) => c.clickable)),
  );
  const single = await page.evaluate(() =>
    [...document.querySelectorAll('.home-card[data-mode="single"] .home-item-name')].map((el) => el.textContent ?? ''),
  );
  check(
    'the single-player list is 继续游戏 / 开始对局 / 自定义游戏 / 卡牌图鉴',
    single.join(',') === '继续游戏,开始对局,自定义游戏,卡牌图鉴',
    single.join(','),
  );

  /* ── 0b. custom game: pinned hero, pinned tribes, no turn clock ── */
  {
    await page.locator('.home-item[data-act="custom"]').click();
    await page.waitForTimeout(400);
    const panel = await page.evaluate(() => ({
      open: Boolean(document.querySelector('.home-custom')),
      heroes: [...document.querySelectorAll('.hc-select option')].map((o) => o.textContent ?? ''),
      chips: [...document.querySelectorAll('.home-custom .hc-chip')].map((el) => el.textContent?.trim() ?? ''),
    }));
    check(
      '自定义游戏 opens a panel with hero, tribes and the clock switch',
      panel.open && panel.heroes.length > 50 && panel.chips.length === 13,
      JSON.stringify({ open: panel.open, heroes: panel.heroes.length, chips: panel.chips.length }),
    );
    check(
      'the placeholder hero is not offered',
      !panel.heroes.some((name) => /baconph/i.test(name)),
      panel.heroes.filter((n) => /baconph/i.test(n)).join(',') || 'clean',
    );

    // Six clicks, five picks: the lobby only ever holds five tribes.
    for (const tribe of ['野兽', '恶魔', '龙', '元素', '机械', '鱼人']) {
      await page.locator('.home-custom .hc-chip', { hasText: tribe }).click();
    }
    const capped = await page.evaluate(() =>
      [...document.querySelectorAll('.home-custom .hc-chip[data-tribe].on')].map((el) => el.textContent?.trim() ?? ''),
    );
    check('at most five tribes can be picked', capped.length === 5 && !capped.includes('鱼人'), capped.join(','));

    // Settle on two: 野兽 plus the aberration twist.
    for (const tribe of ['恶魔', '龙', '元素', '机械']) {
      await page.locator('.home-custom .hc-chip', { hasText: tribe }).click();
    }
    await page.locator('.home-custom .hc-chip', { hasText: '畸变怪' }).click();

    const hero = await page.evaluate(() => {
      const opt = document.querySelector('.hc-select')?.options[3];
      return opt ? { id: opt.value, name: opt.text } : null;
    });
    await page.selectOption('.hc-select', hero.id);
    await page.locator('.home-custom .hc-chip', { hasText: '无时间限制' }).click();
    await page.locator('.hc-actions .btn').click();
    await page.waitForTimeout(2400);

    const started = (await get('/api/state')).game;
    check(
      'the custom game starts with the chosen hero',
      started.me.hero?.id === hero.id && started.phase === 'recruit',
      `${started.me.hero?.id ?? 'none'} vs ${hero.id} (${hero.name})`,
    );
    const races = [...started.lobbyRaces];
    check(
      'the chosen tribes are guaranteed, the rest is random',
      races.length === 5 && races.includes('BEAST') && races.includes('ABERRATION'),
      JSON.stringify(races),
    );
    check(
      '畸变怪 brings a deity (克苏恩 / 亚煞极 / …)',
      started.hasAberrations === true && Boolean(started.me.deity?.card),
      `aberrations=${started.hasAberrations}, deity=${started.me.deity?.card?.nameZh ?? started.me.deity?.card?.name ?? 'none'}`,
    );
    // Some heroes open a second picker (hero power) before the turn starts.
    if (started.me.pending) {
      await post('/api/action', { action: 30 });
      await page.goto(APP + '/?mode=single', { waitUntil: 'networkidle' });
      await page.waitForTimeout(1300);
    }
    const hud = await page.evaluate(() => ({
      text: document.querySelector('.topbar-time')?.textContent ?? '',
      title: document.querySelector('.topbar-time')?.title ?? '',
      rope: Boolean(document.querySelector('.burn-rope')),
    }));
    check('an untimed game shows a free-running clock, no rope', hud.text.includes('∞') && !hud.rope, JSON.stringify(hud));

    // Back to a normal, timed game — the rest of the suite expects one.
    await page.locator('.hud-btn[aria-label="菜单"]').click();
    await page.locator('.modal .btn', { hasText: '返回首页' }).click();
    await page.waitForTimeout(700);
    const again = page.locator('.home-item[data-act="start"]');
    await again.click();
    await page.waitForTimeout(350);
    await again.click();
    // A normal game starts at hero select: the timed mode must be back on.
    await page.waitForTimeout(1200);
    const back = await page.evaluate(() => ({
      flag: localStorage.getItem('bgsim.timeLimit'),
      heroSelect: Boolean(document.querySelector('.hero-pick-screen')),
    }));
    check('开始对局 goes back to a timed game', back.flag === '1' && back.heroSelect, JSON.stringify(back));

    // Pick a hero so the rest of the suite has a playable (recruit) game.
    const pick = (await get('/api/state')).game.me.pending;
    if (pick?.kind === 'hero') await post('/api/hero', { id: pick.options[0].id });
    const power = (await get('/api/state')).game.me.pending;
    if (power) await post('/api/action', { action: 30 });

    // The suite is long: running on a 45-second round clock would end turns
    // under the later tests' feet, so switch the clock off for the rest of it.
    // 26a turns it back on for the countdown/rope checks.
    await page.evaluate(() => localStorage.setItem('bgsim.timeLimit', '0'));

    // Back to the launcher for the click-into-game check below.
    await page.goto(APP + '/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);
  }

  // Click the card's header, not its centre: the centre now lands on a list item.
  await page.locator('.home-card[data-mode="single"] .home-card-title').click();
  await page.waitForTimeout(900);
  const inGame = await page.evaluate(() => ({
    home: Boolean(document.querySelector('.home')),
    tavern: Boolean(document.querySelector('.opponents-rail')) || Boolean(document.querySelector('.hero-pick-screen')),
  }));
  check('clicking 单机模式 enters the game', inGame.home === false && inGame.tavern === true, JSON.stringify(inGame));
}

// The rest of the suite reloads a lot; ?mode=single keeps them out of the launcher.
await page.goto(APP + '/?mode=single', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

async function drag(fromSel, toSel, { toOffset = null, steps = 14, settle = 450 } = {}) {
  const from = page.locator(fromSel).first();
  const b = await from.boundingBox();
  const to = page.locator(toSel).first();
  const t = await to.boundingBox();
  if (!b || !t) throw new Error(`missing box ${fromSel} / ${toSel}`);
  const sx = b.x + b.width / 2;
  const sy = b.y + b.height / 2;
  const tx = toOffset ? t.x + toOffset.x : t.x + t.width / 2;
  const ty = toOffset ? t.y + toOffset.y : t.y + t.height / 2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    const p = i / steps;
    await page.mouse.move(sx + (tx - sx) * p, sy + (ty - sy) * p);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
  await page.waitForTimeout(settle);
}

const me = async () => (await get('/api/state')).game.me;

/** Top up gold and roll a fresh tavern so shop-dependent tests always have cards. */
async function refill() {
  await post('/api/debug', { cmd: 'set_player', gold: 30 });
  await page.waitForTimeout(150);
  await page.keyboard.press('r');
  await page.waitForTimeout(900);
}

/* ── 1. a click buys nothing — dragging is the only gesture ── */
{
  await refill();
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  const before = await me();
  await page.locator('.shop-slot:not(.empty)').first().click();
  await page.waitForTimeout(600);
  const after = await me();
  check(
    'clicking a tavern card buys nothing',
    after.hand.length === before.hand.length && after.gold === before.gold,
    `hand ${before.hand.length}→${after.hand.length}, gold ${before.gold}→${after.gold}`,
  );
}

/* ── 1a. …and a click does not play a hand card either ─────── */
{
  await post('/api/debug', { cmd: 'clear_zone', zone: 'hand' });
  await post('/api/debug', { cmd: 'add_minion', zone: 'hand', card: 'BG20_104' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  const before = await me();
  await page.locator('.hand-card').first().click();
  await page.waitForTimeout(600);
  const after = await me();
  check(
    'clicking a hand card does not play it',
    after.hand.length === before.hand.length && after.board.length === before.board.length,
    `hand ${before.hand.length}→${after.hand.length}, board ${before.board.length}→${after.board.length}`,
  );
  await page.mouse.move(800, 40);
}

/* ── 1b. buying re-aligns the tavern, and the shift is animated ── */
{
  const boxes = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.shop-slot')].map((el) => {
        const r = el.getBoundingClientRect();
        return { id: el.dataset.flipKey, x: Math.round(r.x), y: Math.round(r.y) };
      }),
    );
  const before = await boxes();
  // Buy by dragging the first slot onto the hand row, then look at the shift
  // the moment it lands — the re-flow is short.
  await drag('.shop-slot:not(.empty)', '.hand-row', { settle: 90 });
  const animating = await page.evaluate(
    () => [...document.querySelectorAll('.shop-row [data-flip-key]')].some((el) => el.getAnimations().length > 0),
  );
  await page.waitForTimeout(700);
  const after = await boxes();
  check('tavern closes the gap after a buy', after.length === before.length - 1, `${before.length}→${after.length} cards`);
  check('…and the re-flow is animated, not a jump', animating);
}

/* ── 1c. rows animate instead of jumping ───────────────────── */
{
  await post('/api/debug', { cmd: 'clear_zone', zone: 'hand' });
  for (const id of ['BG20_104', 'BG36_331']) await post('/api/debug', { cmd: 'add_minion', zone: 'hand', card: id });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  await drag('.hand-card', '.board-row');
  await drag('.hand-card', '.board-row', { settle: 70 });
  const anims = await page.evaluate(
    () => document.querySelectorAll('.board-row [data-flip-key]').length && [...document.querySelectorAll('.board-row [data-flip-key]')].some((el) => el.getAnimations().length > 0),
  );
  check('board cards animate when the row re-centres', Boolean(anims));
  await page.waitForTimeout(500);
}

/* ── 1d. a burst of drags is queued, not dropped ──────────── */
{
  await post('/api/debug', { cmd: 'set_player', gold: 30 });
  await page.keyboard.press('r');
  await page.waitForTimeout(700);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  const before = await me();
  // Back-to-back drags: each one lands while the previous buy is still in
  // flight, the harshest case for a busy-gated UI.
  const n = Math.min(3, await page.locator('.shop-slot:not(.empty)').count());
  for (let i = 0; i < n; i++) await drag('.shop-slot:not(.empty)', '.hand-row', { settle: 70 });
  await page.waitForTimeout(1800);
  const after = await me();
  check('3 drags in a burst all buy (none dropped)', after.hand.length === before.hand.length + n, `hand ${before.hand.length}→${after.hand.length}, expected +${n}`);
  check('gold charged exactly once per buy', before.gold - after.gold === 3 * n, `gold ${before.gold}→${after.gold}`);

  // A grab that is released over nothing must not buy: the card flies back.
  const before2 = await me();
  const b = await page.locator('.shop-slot:not(.empty)').first().boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + 40, b.y + 8, { steps: 6 });
  await page.mouse.move(60, 500, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(900);
  const after2 = await me();
  check(
    'a drag released over nothing buys nothing',
    after2.hand.length === before2.hand.length && after2.gold === before2.gold,
    `hand ${before2.hand.length}→${after2.hand.length}, gold ${before2.gold}→${after2.gold}`,
  );
}

/* ── 1e. a bought card flies from the tavern into the hand ─── */
{
  await refill();
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  const src = await page.locator('.shop-slot:not(.empty)').first().boundingBox();
  await page.evaluate(() => {
    // Only track the card that is about to be bought, not the ones already there.
    const seen = new Set([...document.querySelectorAll('.hand-card')].map((el) => el.dataset.flipKey));
    window.__samples = [];
    const t0 = performance.now();
    const spin = () => {
      const el = [...document.querySelectorAll('.hand-card')].find((e) => !seen.has(e.dataset.flipKey));
      if (el) {
        const r = el.getBoundingClientRect();
        window.__samples.push({ t: Math.round(performance.now() - t0), x: Math.round(r.x), y: Math.round(r.y) });
      }
      if (performance.now() - t0 < 1600) requestAnimationFrame(spin);
    };
    requestAnimationFrame(spin);
  });
  await drag('.shop-slot:not(.empty)', '.hand-row', { settle: 900 });
  const samples = await page.evaluate(() => window.__samples);
  const first = samples[0];
  const settle = samples[samples.length - 1];
  check(
    'bought card flies from the tavern slot',
    Boolean(first && settle) && Math.abs(first.y - src.y) < 100 && Math.abs(first.x - src.x) < 100,
    first ? `start ${first.x},${first.y} vs slot ${Math.round(src.x)},${Math.round(src.y)}` : 'no samples',
  );
  check('…and lands in the hand row', Boolean(settle) && settle.y > 640, settle ? `settled ${settle.x},${settle.y}` : 'no samples');
}

/* ── 1f. a hand card flies onto the board when played ──────── */
{
  await post('/api/debug', { cmd: 'clear_zone', zone: 'hand' });
  await post('/api/debug', { cmd: 'clear_zone', zone: 'board' });
  await post('/api/debug', { cmd: 'add_minion', zone: 'hand', card: 'BG20_104' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  const hb = await page.locator('.hand-card').first().boundingBox();
  const beforeKeys = await page.evaluate(() =>
    [...document.querySelectorAll('.board-row [data-flip-key]')].map((el) => el.dataset.flipKey),
  );
  await page.evaluate((keys) => {
    const seen = new Set(keys);
    window.__samples = [];
    window.__flight = null;
    const t0 = performance.now();
    const spin = () => {
      const el = [...document.querySelectorAll('.board-row [data-flip-key]')].find((e) => !seen.has(e.dataset.flipKey));
      if (el) {
        const r = el.getBoundingClientRect();
        window.__samples.push({ t: Math.round(performance.now() - t0), x: Math.round(r.x), y: Math.round(r.y) });
        // The flight is a WAAPI animation whose first keyframe is the offset
        // back to where the card came from — read it instead of racing the
        // 300ms animation with a sampler. (Chrome serialises it as a matrix.)
        if (!window.__flight) {
          const kf = el.getAnimations()[0]?.effect?.getKeyframes?.() ?? [];
          if (kf.length) {
            const t = String(kf[0].transform ?? '');
            const m = /matrix\(([^)]+)\)/.exec(t);
            window.__flight = t;
            window.__fromY = m ? Number(m[1].split(',')[5]) : Number(/translate\([^,]+,\s*(-?[\d.]+)/.exec(t)?.[1] ?? NaN);
          }
        }
      }
      if (performance.now() - t0 < 1600) requestAnimationFrame(spin);
    };
    requestAnimationFrame(spin);
  }, beforeKeys);
  await drag('.hand-card', '.board-row', { settle: 900 });
  const { samples, flight, fromY } = await page.evaluate(() => ({
    samples: window.__samples,
    flight: window.__flight,
    fromY: window.__fromY,
  }));
  const settle = samples[samples.length - 1];
  check(
    'played card flies out of the hand',
    Number.isFinite(fromY) && fromY > 150,
    `flight ${flight ?? 'none'} → ${fromY}px above its slot (hand at y ${Math.round(hb.y)})`,
  );
  check('…and lands on the board', Boolean(settle) && settle.y < 640, settle ? `settled ${settle.x},${settle.y}` : 'no samples');
}

/* ── 1g. the dragged card is life-size, not the hovered (enlarged) one ── */
{
  await post('/api/debug', { cmd: 'clear_zone', zone: 'hand' });
  await post('/api/debug', { cmd: 'add_minion', zone: 'hand', card: 'BG20_104' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  const hb = await page.locator('.hand-card').first().boundingBox();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.waitForTimeout(350);
  // The hovered card is lifted as its own pointer-transparent layer now, so the
  // enlargement lives on .hand-zoom, not on the frame in the fan.
  const hovered = await page.evaluate(() => {
    const el = document.querySelector('.hand-card.zoomed .hand-card-inner');
    return el ? Math.round(el.getBoundingClientRect().width) : 0;
  });
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2, hb.y - 120, { steps: 8 });
  await page.waitForTimeout(80);
  const ghost = await page.evaluate(() => {
    const el = document.querySelector('.drag-card');
    const r = el?.getBoundingClientRect();
    return r ? Math.round(r.width) : null;
  });
  await page.waitForTimeout(200);
  const source = await page.evaluate(() => Math.round(document.querySelector('.hand-card .hand-card-inner').getBoundingClientRect().width));
  await page.mouse.move(800, 40, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  check('hovered hand card is enlarged', hovered > 150, `${hovered}px`);
  check('the drag ghost is life-size, not the enlarged card', Boolean(ghost) && ghost < 135, `ghost ${ghost}px vs hovered ${hovered}px`);
  check('the source card shrinks back to normal while dragging', source < 135, `${source}px`);
}

/* ── 2. drag tavern card onto the hand row (buy) ───────────── */
{
  await refill();
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  const before = await me();
  await drag('.shop-slot', '.hand-row');
  const after = await me();
  check('drag tavern→hand buys', after.hand.length === before.hand.length + 1, `hand ${before.hand.length}→${after.hand.length}`);
  check('drag tavern→hand spends gold', after.gold < before.gold, `gold ${before.gold}→${after.gold}`);
}

/* ── 3. drag tavern card onto the board (buy, never plays a hand card) ── */
{
  await refill();
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  const before = await me();
  const handIds = before.hand.map((c) => c.hid).join(',');
  await drag('.shop-slot', '.board-row');
  const after = await me();
  const handIdsAfter = after.hand.map((c) => c.hid).join(',');
  check('drag tavern→board buys instead of playing a hand card', after.hand.length === before.hand.length + 1, `hand ${before.hand.length}→${after.hand.length}`);
  check('hand contents only gained cards', after.hand.length !== before.hand.length || handIds !== handIdsAfter, 'no card was consumed from hand');
}

/* ── 4. drag a hand minion onto the board ──────────────────── */
{
  await post('/api/debug', { cmd: 'clear_zone', zone: 'hand' });
  await post('/api/debug', { cmd: 'add_minion', zone: 'hand', card: 'BG28_300' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  const before = await me();
  await drag('.hand-card', '.board-row');
  const after = await me();
  check('drag hand→board plays the minion', after.hand.length === before.hand.length - 1 && after.board.length === before.board.length + 1, `hand ${before.hand.length}→${after.hand.length}, board ${before.board.length}→${after.board.length}`);
}

/* ── 5. drag a board minion onto the tavern (sell) ─────────── */
{
  const before = await me();
  await drag('.board-row .card-wrap', '.shop-row');
  const after = await me();
  check('drag board→tavern sells', after.board.length === before.board.length - 1 && after.gold === before.gold + 1, `board ${before.board.length}→${after.board.length}, gold ${before.gold}→${after.gold}`);
}

/* ── 6. drag does not fire the trailing click ──────────────── */
{
  await post('/api/debug', { cmd: 'clear_zone', zone: 'hand' });
  await post('/api/debug', { cmd: 'add_minion', zone: 'hand', card: 'BG28_300' });
  await post('/api/debug', { cmd: 'add_minion', zone: 'hand', card: 'BG28_301' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  const before = await me();
  // Drag a hand card, drop it on the tavern (invalid) — must return, not be played.
  await drag('.hand-card', '.nameplate');
  await page.waitForTimeout(400);
  const after = await me();
  check('dropping on a non-target plays nothing', after.hand.length === before.hand.length && after.board.length === before.board.length, `hand ${before.hand.length}→${after.hand.length}, board ${before.board.length}→${after.board.length}`);
}

/* ── 7. drag ghost tracking (the whole point) ──────────────── */
{
  await refill();
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  await page.evaluate(() => {
    window.__probe = { moves: 0, transforms: new Set(), ticks: 0 };
    addEventListener('pointermove', () => { window.__probe.moves++; }, true);
    let last = null;
    const tick = () => {
      window.__probe.ticks++;
      const el = document.querySelector('.drag-card');
      if (el) {
        const tr = el.style.transform;
        if (tr !== last) {
          window.__probe.transforms.add(tr);
          last = tr;
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const b = await page.locator('.shop-slot:not(.empty)').first().boundingBox();
  const sx = b.x + b.width / 2;
  const sy = b.y + b.height / 2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  const start = Date.now();
  // Sweep across the board in small steps at input speed.
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(sx + Math.sin(i / 2) * 80, sy - i * 55, { steps: 8 });
  }
  const elapsed = Date.now() - start;
  await page.mouse.up();
  const probe = await page.evaluate(() => ({ moves: window.__probe.moves, n: window.__probe.transforms.size, ticks: window.__probe.ticks }));
  const ratio = probe.n / Math.max(1, probe.moves);
  console.log(`pointermove ${probe.moves}, ghost updates ${probe.n} over ${elapsed}ms (rAF ${probe.ticks}) → ${(probe.n / elapsed * 1000).toFixed(1)} Hz, tracking ratio ${ratio.toFixed(2)}`);
  check('ghost tracks every pointer move (ratio >= 0.8)', ratio >= 0.8, ratio.toFixed(2));
  check('ghost updates at >= 45Hz', probe.n / elapsed * 1000 >= 45, `${(probe.n / elapsed * 1000).toFixed(1)} Hz`);
  await page.waitForTimeout(300);
}

/* ── 8. targeted spell dragged onto a board minion ─────────── */
{
  await post('/api/debug', { cmd: 'clear_zone', zone: 'hand' });
  await post('/api/debug', { cmd: 'clear_zone', zone: 'board' });
  await post('/api/debug', { cmd: 'add_minion', zone: 'board', card: 'BG20_104' });
  await post('/api/debug', { cmd: 'add_spell', zone: 'hand', card: 'BG28_825' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1100);
  const before = await me();
  const target = before.board[0];
  await drag('.hand-card', '.board-row [data-slot-zone="board"]');
  const after = await me();
  const now = after.board.find((m) => m.eid === target.eid);
  check(
    'spell drag applies to the minion under the pointer',
    after.hand.length === 0 && now && (now.atk !== target.atk || now.hp !== target.hp || now.kw.length !== target.kw.length),
    `hand ${before.hand.length}→${after.hand.length}, ${target.atk}/${target.hp}→${now ? now.atk + '/' + now.hp : 'gone'}`,
  );
  check('no target prompt left open', !after.pending, after.pending ? after.pending.kind : 'clear');
}

/* ── 9. Escape cancels a drag ──────────────────────────────── */
{
  await post('/api/debug', { cmd: 'clear_zone', zone: 'hand' });
  await post('/api/debug', { cmd: 'add_minion', zone: 'hand', card: 'BG20_104' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  const before = await me();
  const hb = await page.locator('.hand-card').first().boundingBox();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2, hb.y - 80, { steps: 8 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await page.waitForTimeout(400);
  const after = await me();
  check('Escape cancels without dropping', after.hand.length === before.hand.length && after.board.length === before.board.length,
    `hand ${before.hand.length}→${after.hand.length}, board ${before.board.length}→${after.board.length}`);
}

/* ── 10. right-click still sells a board minion ────────────── */
{
  const before = await me();
  check('board has a minion to right-click', before.board.length > 0, `board ${before.board.length}`);
  if (before.board.length > 0) {
    await page.locator('.board-row .card-wrap').first().click({ button: 'right' });
    await page.waitForTimeout(500);
    const after = await me();
    check('right-click sells a board minion', after.board.length === before.board.length - 1, `board ${before.board.length}→${after.board.length}`);
  }
}

/* ── 11. end turn → combat replay → next turn ──────────────── */
{
  await post('/api/debug', { cmd: 'clear_zone', zone: 'hand' });
  await post('/api/debug', { cmd: 'add_minion', zone: 'board', card: 'BG20_104' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  const before = await me();
  await page.locator('.end-turn-btn').click();
  await page.waitForTimeout(1500);
  const inCombat = await page.locator('.combat-layer').count();
  check('ending the turn starts the combat replay', inCombat > 0, inCombat ? 'overlay up' : 'no overlay');
  if (inCombat) {
    // Click anywhere on the replay to fast-forward, then again to continue.
    await page.mouse.click(160, 820);
    await page.waitForTimeout(500);
    if (await page.locator('.combat-layer').count()) {
      await page.mouse.click(160, 820);
      await page.waitForTimeout(800);
    }
  }
  const after = await me();
  check('the next turn is playable again', after.pending === null && after.gold >= 0, `gold ${after.gold}, board ${after.board.length}`);
}

/* ── 12. board minions stay clickable (发动 / target picking) ── */
{
  await post('/api/debug', { cmd: 'clear_zone', zone: 'hand' });
  await post('/api/debug', { cmd: 'clear_zone', zone: 'board' });
  await post('/api/debug', { cmd: 'add_minion', zone: 'board', card: 'BG20_104' });
  await post('/api/debug', { cmd: 'add_spell', zone: 'hand', card: 'BG28_825' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1100);
  const before = await me();
  // Clicking the card itself must reach it (it used to be swallowed by the
  // pointer-capture wrapper, so 发动 was unreachable).
  const target = await page.evaluate(() => {
    const el = document.querySelector('.board-row .card-wrap');
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return hit ? Boolean(hit.closest('.card-wrap')) : false;
  });
  check('a click on a board minion lands on the card, not an overlay', target);

  // A targeted spell dropped where there is no target asks for one — the drag
  // cannot know the spell was targeted until it has been played.
  await drag('.hand-card', '.board-row', { toOffset: { x: 40, y: 82 } });
  await page.waitForTimeout(400);
  const picking = await me();
  check('playing a targeted spell opens the picker', picking.pending?.kind === 'target', picking.pending?.kind ?? 'none');
  await page.locator('.board-row .card-wrap').first().click(); // pick the target
  await page.waitForTimeout(700);
  const after = await me();
  const m = after.board[0];
  check(
    'clicking a board minion finishes the target pick',
    !after.pending && m && (m.atk !== before.board[0].atk || m.hp !== before.board[0].hp),
    `${before.board[0].atk}/${before.board[0].hp} → ${m ? m.atk + '/' + m.hp : 'gone'}`,
  );
}

/* ── 12b. an 发动 that targets the tavern is finished by clicking a card ── */
{
  // 深潜狮子鱼: 发动 costs 2 gold and eats a tavern minion, so its picker only
  // offers shop slots. Removing click-to-buy must not break picking them.
  await post('/api/new', { seed: 11 });
  const fresh = await get('/api/state');
  await post('/api/hero', { id: fresh.game.me.pending.options[0].id });
  const pre = (await get('/api/state')).game.me.pending;
  if (pre?.kind) await post('/api/action', { action: 30 });
  await post('/api/debug', { cmd: 'set_player', gold: 30 });
  await post('/api/debug', { cmd: 'clear_zone', zone: 'board' });
  await post('/api/debug', { cmd: 'clear_zone', zone: 'hand' });
  await post('/api/debug', { cmd: 'add_minion', zone: 'board', card: 'BG36_201' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1100);

  const before = await me();
  const card = await page.locator('.board-row .card-wrap').first().boundingBox();
  await page.mouse.move(card.x + card.width / 2, card.y + card.height / 2);
  await page.waitForTimeout(300);
  const hint = await page.locator('.activate-hint').count();
  await page.locator('.board-row .card-wrap').first().click();
  await page.waitForTimeout(800);
  const opened = await me();
  const shopTargets = (opened.pending?.kind === 'target' ? opened.pending.targets : []).filter((t) => t.location.zone === 'shop').length;
  check(
    'clicking a minion with 发动 opens its target picker',
    hint === 1 && opened.pending?.kind === 'target' && shopTargets > 0,
    `hint ${hint}, pending ${opened.pending?.kind ?? 'none'}, ${shopTargets} shop targets`,
  );

  await page.locator('.shop-slot').first().click();
  await page.waitForTimeout(900);
  const after = await me();
  check(
    'clicking a tavern card finishes the 发动',
    !after.pending && after.gold === before.gold - 2 && after.board[0].atk > before.board[0].atk,
    `pending ${after.pending?.kind ?? 'none'}, gold ${before.gold}→${after.gold}, ${before.board[0].atk}/${before.board[0].hp} → ${after.board[0].atk}/${after.board[0].hp}`,
  );
}

/* ── 13. an enlarged hand card must not steal its neighbour's clicks ── */
{
  await post('/api/debug', { cmd: 'clear_zone', zone: 'hand' });
  for (const id of ['BG30_123', 'BG20_101', 'BG20_104', 'BG36_331', 'BG20_101']) {
    await post('/api/debug', { cmd: 'add_minion', zone: 'hand', card: id });
  }
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1100);
  const n = await page.locator('.hand-card').count();
  const first = await page.locator('.hand-card').first().boundingBox();
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
  await page.waitForTimeout(300); // let it enlarge
  const wrong = await page.evaluate(() =>
    [...document.querySelectorAll('.hand-card')].filter((el) => {
      // A fanned card only shows a sliver, and the hovered one zooms over part
      // of its neighbour, so a single centre point is too strict: every card
      // must still be reachable somewhere along its painted box.
      const r = el.querySelector('.hand-card-frame')?.getBoundingClientRect() ?? el.getBoundingClientRect();
      for (let i = 1; i < 10; i++) {
        for (let j = 1; j < 10; j++) {
          const under = document.elementFromPoint(r.x + (r.width * i) / 10, r.y + (r.height * j) / 10);
          if (under?.closest('.hand-card') === el) return false;
        }
      }
      return true;
    }).length,
  );
  check('with a card enlarged, every other hand card is still hit-testable', wrong === 0, `${n} cards, ${wrong} mismatched`);
  await page.mouse.move(800, 40);
}

/* ── 13b. a big hand can be picked left-to-right, card by card ── */
{
  await post('/api/debug', { cmd: 'clear_zone', zone: 'hand' });
  // distinct ids — three of the same minion would triple into a golden card
  const ids = ['BG30_123', 'BG20_101', 'BG29_611', 'BG36_331', 'BG34_405', 'BG28_741', 'BG31_177', 'BG34_171'];
  for (const id of ids) await post('/api/debug', { cmd: 'add_minion', zone: 'hand', card: id });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  const boxes = [];
  for (const c of await page.locator('.hand-card').all()) boxes.push(await c.boundingBox());
  const keys = await page.evaluate(() => [...document.querySelectorAll('.hand-card')].map((el) => el.dataset.flipKey));

  // Which card is on top at each x, sampled along the lower band of the fan
  // (the rotated cards overlap at mid-height, so the band near their bottoms is
  // where every card shows its own sliver). Every card must appear, in order.
  const hits = await page.evaluate(() => {
    const frames = [...document.querySelectorAll('.hand-card')].map(
      (e) => e.querySelector('.hand-card-frame')?.getBoundingClientRect() ?? e.getBoundingClientRect(),
    );
    const x0 = Math.min(...frames.map((b) => b.x));
    const x1 = Math.max(...frames.map((b) => b.right));
    const y = Math.min(892, Math.max(...frames.map((b) => b.bottom)) - 20);
    const seq = [];
    for (let x = x0 + 2; x <= x1 - 2; x += 2) {
      const k = document.elementFromPoint(x, y)?.closest('.hand-card')?.dataset.flipKey;
      if (k && seq[seq.length - 1] !== k) seq.push(k);
    }
    return seq;
  });
  const asNumbers = hits.map((k) => keys.indexOf(k) + 1);
  const consecutive = hits.length === keys.length && asNumbers.every((v, i) => v === i + 1);
  check('a full hand is picked 1→N in order, with no skipped cards', consecutive, `order ${asNumbers.join('→')} of ${keys.length}`);
  await page.mouse.move(800, 40);
}

/* ── 14. magnetic minions attach to the Mech on their right ── */
{
  await post('/api/debug', { cmd: 'clear_zone', zone: 'hand' });
  await post('/api/debug', { cmd: 'clear_zone', zone: 'board' });
  await post('/api/debug', { cmd: 'add_minion', zone: 'board', card: 'BG29_611' }); // mech
  await post('/api/debug', { cmd: 'add_minion', zone: 'hand', card: 'BG26_146' }); // 磁力
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1100);

  const before = await me();
  const mech = before.board[0];
  const hb = await page.locator('.hand-card').first().boundingBox();
  const mb = await page.locator('.board-row .card-wrap').first().boundingBox();
  // drop on the LEFT half of the mech -> the magnetic minion would sit to its left
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2, hb.y - 80, { steps: 6 });
  await page.mouse.move(mb.x + mb.width * 0.25, mb.y + mb.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(700);

  const after = await me();
  const grown = after.board[1] ?? after.board[0];
  check(
    'magnetic minion dropped left of a Mech attaches instead of sitting beside it',
    after.board.length === 1 && after.hand.length === 0,
    `board ${before.board.length}→${after.board.length}, hand ${before.hand.length}→${after.hand.length}`,
  );
  check(
    '…and the Mech got its stats',
    Boolean(grown) && grown.eid === mech.eid && grown.atk + grown.hp > mech.atk + mech.hp,
    `${mech.atk}/${mech.hp} → ${grown ? grown.atk + '/' + grown.hp : 'gone'}`,
  );
}

/* ── 15. …but a magnetic minion dropped to its RIGHT stays separate ── */
{
  await post('/api/debug', { cmd: 'clear_zone', zone: 'hand' });
  await post('/api/debug', { cmd: 'clear_zone', zone: 'board' });
  await post('/api/debug', { cmd: 'add_minion', zone: 'board', card: 'BG29_611' });
  await post('/api/debug', { cmd: 'add_minion', zone: 'hand', card: 'BG26_146' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1100);
  const before = await me();
  const hb = await page.locator('.hand-card').first().boundingBox();
  const mb = await page.locator('.board-row .card-wrap').first().boundingBox();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2, hb.y - 80, { steps: 6 });
  await page.mouse.move(mb.x + mb.width * 0.85, mb.y + mb.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(700);
  const after = await me();
  check(
    'magnetic minion dropped to the right of the Mech is played normally',
    after.board.length === before.board.length + 1,
    `board ${before.board.length}→${after.board.length}`,
  );
}

/* ── 16. attaching still works when the board is full ──────── */
{
  await post('/api/debug', { cmd: 'clear_zone', zone: 'hand' });
  await post('/api/debug', { cmd: 'clear_zone', zone: 'board' });
  // Seven *distinct* mechs — repeating an id three times would trigger a triple.
  for (const id of ['BG29_611', 'BG34_405', 'BG28_741', 'BG31_177', 'BG34_171', 'BG35_341', 'BG36_366']) {
    const r = await post('/api/debug', { cmd: 'add_minion', zone: 'board', card: id });
    if (r.error) console.log('   add_minion failed:', id, r.error);
  }
  await post('/api/debug', { cmd: 'add_minion', zone: 'hand', card: 'BG26_146' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1100);
  const before = await me();
  check('board starts full', before.board.length === 7, `${before.board.length}/7`);
  const hb = await page.locator('.hand-card').first().boundingBox();
  const mb = await page.locator('.board-row .card-wrap').first().boundingBox();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2, hb.y - 80, { steps: 6 });
  await page.mouse.move(mb.x + mb.width * 0.25, mb.y + mb.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(700);
  const after = await me();
  check(
    'a magnetic minion can still attach with a full board',
    after.board.length === 7 && after.hand.length === 0,
    `board ${before.board.length}→${after.board.length}, hand ${before.hand.length}→${after.hand.length}`,
  );
}

/* ── 17. a divine-shield minion draws exactly one bubble ───── */
{
  await post('/api/debug', { cmd: 'clear_zone', zone: 'hand' });
  await post('/api/debug', { cmd: 'clear_zone', zone: 'board' });
  await post('/api/debug', { cmd: 'add_minion', zone: 'board', card: 'BG29_611' }); // 圣盾
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1100);
  const counts = await page.evaluate(() => ({
    shield: document.querySelectorAll('.board-row .shield-frame').length,
    glow: document.querySelectorAll('.board-row .shield-glow').length,
  }));
  check('divine shield draws one bubble, not two', counts.shield === 1 && counts.glow === 0, JSON.stringify(counts));

  // The tavern projection drops `shield_hits`, so shop minions only expose the
  // keyword — they used to lose the bubble entirely.
  for (let i = 0; i < 40; i++) {
    const s = await get('/api/state');
    if (s.game.me.shop.some((it) => (it.kw || []).includes('DIVINE_SHIELD'))) break;
    await post('/api/debug', { cmd: 'refresh_shop' });
  }
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1100);
  const shopShield = await page.evaluate(() => document.querySelectorAll('.shop-row .shield-frame').length);
  check('tavern minions keep their divine shield bubble', shopShield >= 1, `${shopShield} bubbles`);

  // The shield used to pulse with a gold drop-shadow, which read as "golden
  // card" — the same signal the golden glow uses. It must stay a plain bubble.
  const shieldStyle = await page.evaluate(() => {
    const el = document.querySelector('.board-row .shield-frame');
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { filter: cs.filter, animation: cs.animationName, dropshadow: cs.filter.includes('drop-shadow') };
  });
  check(
    'divine shield does not glow like a golden card',
    Boolean(shieldStyle) && !shieldStyle.dropshadow && shieldStyle.animation === 'none',
    JSON.stringify(shieldStyle),
  );
}

/* ── 17b. windfury draws its wind aura ─────────────────────── */
{
  await post('/api/debug', { cmd: 'clear_zone', zone: 'board' });
  await post('/api/debug', { cmd: 'add_minion', zone: 'board', card: 'BGS_119' }); // 圣盾 + 风怒
  await post('/api/debug', { cmd: 'add_minion', zone: 'board', card: 'BG20_104' }); // 只有风怒
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  const wf = await page.evaluate(() => ({
    auras: document.querySelectorAll('.board-row .windfury-frame').length,
    shields: document.querySelectorAll('.board-row .shield-frame').length,
    src: document.querySelector('.board-row .windfury-frame')?.getAttribute('src') ?? null,
    loaded: [...document.querySelectorAll('.board-row .windfury-frame')].every((i) => i.naturalWidth > 0),
  }));
  check(
    'windfury minions get the wind aura, others do not',
    wf.auras === 2 && wf.shields === 1 && wf.loaded && wf.src === '/img/minions/windfury.png',
    JSON.stringify(wf),
  );
}

/* ── 17c. targeted hero power aims like Slay the Spire ─────── */
{
  await post('/api/new', { seed: 4711 });
  let s = await get('/api/state');
  await post('/api/hero', { id: s.game.me.pending.options[0].id });
  // 大调颂歌: give a minion Attack equal to your tier — needs a target.
  await post('/api/debug', { cmd: 'set_hero', hero: 'BG26_HERO_102' });
  await post('/api/debug', { cmd: 'set_player', gold: 30 });
  await post('/api/debug', { cmd: 'add_minion', zone: 'board', card: 'BG20_104' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1300);

  const bb = await page.locator('.power-btn').first().boundingBox();
  const tb = await page.locator('.board-slot').first().boundingBox();
  const from = { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 };
  const to = { x: tb.x + tb.width / 2, y: tb.y + tb.height / 2 };

  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.waitForTimeout(400);
  const opened = await page.evaluate(() => ({
    aiming: Boolean(document.querySelector('.power-btn.aiming')),
    validSlots: document.querySelectorAll('.target-valid').length,
  }));
  check('pressing a targeted power opens the aim (no click needed)', opened.aiming && opened.validSlots > 0, JSON.stringify(opened));

  for (let i = 1; i <= 10; i++) {
    const t = i / 10;
    await page.mouse.move(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
    await page.waitForTimeout(18);
  }
  await page.waitForTimeout(150);
  const aiming = await page.evaluate(() => ({
    arrow: Boolean(document.querySelector('.target-arrow')),
    gold: Boolean(document.querySelector('.target-arrow.valid')),
    hover: document.querySelectorAll('.target-hover').length,
  }));
  check('dragging draws the arrow and highlights the target under it', aiming.arrow && aiming.gold && aiming.hover === 1, JSON.stringify(aiming));

  const before = (await get('/api/state')).game.me.board[0];
  await page.mouse.up();
  await page.waitForTimeout(120);
  const flashing = await page.evaluate(() => document.querySelectorAll('.target-cast').length);
  await page.waitForTimeout(620);
  const after = (await get('/api/state')).game.me.board[0];
  const cleared = await page.evaluate(() => ({
    arrow: Boolean(document.querySelector('.target-arrow')),
    pending: Boolean(document.querySelector('.target-prompt')),
  }));
  check(
    'releasing on the target casts and clears the arrow',
    after.atk === before.atk + 1 && !cleared.arrow && !cleared.pending,
    `${before.atk}/${before.hp} → ${after.atk}/${after.hp}, ${JSON.stringify(cleared)}`,
  );
  check('the target flashes when the power lands', flashing === 1, `${flashing} flashing slots`);
}

/* ── 17d. targeted hand spells aim the same way ────────────── */
{
  await post('/api/new', { seed: 919 });
  let s = await get('/api/state');
  await post('/api/hero', { id: s.game.me.pending.options[0].id });
  await post('/api/debug', { cmd: 'set_player', gold: 30 });
  await post('/api/debug', { cmd: 'add_minion', zone: 'board', card: 'BG20_104' });
  await post('/api/debug', { cmd: 'add_spell', zone: 'hand', card: 'BG20_GEM' }); // 血宝石：给一个随从 +1/+1
  // Some heroes open a hero-power pick right after selection; clear it first.
  let pre = (await get('/api/state')).game.me.pending;
  if (pre?.kind === 'hero_power' || pre?.kind === 'discover' || pre?.kind === 'choose_one') {
    await post('/api/action', { action: 30 });
  }
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1300);

  const cb = await page.locator('.hand-card').first().boundingBox();
  const tb = await page.locator('.board-slot').first().boundingBox();
  const from = { x: cb.x + cb.width / 2, y: cb.y + 24 };
  const to = { x: tb.x + tb.width / 2, y: tb.y + tb.height / 2 };

  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.waitForTimeout(400);
  // Pressing a card no longer plays it: the play goes out on release.
  const held = (await get('/api/state')).game.me;
  check('a hand spell is not played on press', held.hand.length === 1 && held.pending === null, `hand=${held.hand.length}, pending=${held.pending?.kind ?? 'none'}`);
  for (let i = 1; i <= 12; i++) {
    const t = i / 12;
    await page.mouse.move(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
    await page.waitForTimeout(18);
  }
  await page.waitForTimeout(150);
  const aiming = await page.evaluate(() => ({
    arrow: Boolean(document.querySelector('.target-arrow.valid')),
    hover: document.querySelectorAll('.target-hover').length,
  }));

  const before = (await get('/api/state')).game.me.board[0];
  await page.mouse.up();
  await page.waitForTimeout(700);
  const after = (await get('/api/state')).game.me.board[0];
  const settled = (await get('/api/state')).game.me;
  const handLeft = settled.hand.length;
  check(
    'a hand spell aims from the card and casts on release',
    settled.pending === null && aiming.arrow && aiming.hover === 1 && after.atk === before.atk + 1 && after.hp === before.hp + 1 && handLeft === 0,
    `pending=${settled.pending?.kind ?? 'none'}, ${JSON.stringify(aiming)}, ${before.atk}/${before.hp} → ${after.atk}/${after.hp}, hand=${handLeft}`,
  );
}

/* ── 18. the side rail is a health leaderboard ─────────────── */
{
  const pure = await page.evaluate(async () => {
    const m = await import('/src/lib/standings.ts');
    return m
      .sortStandings([
        { id: 1, health: 10, armor: 0, alive: true, placement: 0 },
        { id: 2, health: 5, armor: 20, alive: true, placement: 0 },
        { id: 5, health: 3, armor: 2, alive: true, placement: 0 },
        { id: 4, health: 0, armor: 0, alive: false, placement: 7 },
        { id: 3, health: 0, armor: 0, alive: false, placement: 8 },
      ])
      .map((e) => e.id);
  });
  check(
    'standings: hp+armour descending, eliminated at the bottom with 8th last',
    JSON.stringify(pure) === JSON.stringify([2, 1, 5, 4, 3]),
    JSON.stringify(pure),
  );

  const st2 = await get('/api/state');
  const expected = await page.evaluate(async (game) => {
    const m = await import('/src/lib/standings.ts');
    const entries = [
      { id: 0, health: game.me.health, armor: game.me.armor, alive: game.me.alive, placement: game.me.placement },
      ...game.opponents.map((o) => ({ id: o.id, health: o.health, armor: o.armor, alive: o.alive, placement: o.placement })),
    ];
    return m.sortStandings(entries).map((e) => (e.id === 0 ? 'o-self' : 'o' + e.id));
  }, st2.game);
  const actual = await page.evaluate(() =>
    [...document.querySelectorAll('.opponents-rail [data-flip-key]')].map((el) => el.dataset.flipKey),
  );
  check('the rendered rail follows that order', JSON.stringify(actual) === JSON.stringify(expected), `dom ${actual.join(',')}`);
}

/* ── 19. 亡语图标只给真正有亡语的随从 ──────────────────── */
{
  await post('/api/debug', { cmd: 'clear_zone', zone: 'board' });
  await post('/api/debug', { cmd: 'clear_zone', zone: 'hand' });
  await post('/api/debug', { cmd: 'add_minion', zone: 'board', card: 'BG25_354' }); // "你的亡语额外触发一次"，本身无亡语
  await post('/api/debug', { cmd: 'add_minion', zone: 'board', card: 'BG28_300' }); // 真·亡语
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1100);
  const icons = await page.evaluate(() =>
    [...document.querySelectorAll('.board-row .board-slot')].map((slot) => ({
      eid: slot.querySelector('.card-wrap') !== null,
      dr: slot.querySelectorAll('.overlay-img[src*="deathrattle"]').length,
    })),
  );
  check('deathrattle icon only on minions that actually have one', icons[0]?.dr === 0 && icons[1]?.dr === 1, JSON.stringify(icons.map((i) => i.dr)));
}

/* ── 20. 冻结：只有卡面左下角的雪花，没有蓝色蒙版 ──────── */
{
  await post('/api/debug', { cmd: 'clear_zone', zone: 'board' });
  await post('/api/debug', { cmd: 'set_player', gold: 10 });
  await post('/api/action', { action: 2 }); // freeze
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1100);
  const r = await page.evaluate(() => {
    const mark = document.querySelector('.shop-slot .freeze-mark');
    const card = mark?.closest('.shop-slot')?.querySelector('.card-wrap');
    if (!mark || !card) return null;
    const m = mark.getBoundingClientRect();
    const c = card.getBoundingClientRect();
    return {
      inside: m.left >= c.left - 1 && m.right <= c.right + 1 && m.top >= c.top - 1 && m.bottom <= c.bottom + 1,
      leftSide: m.left - c.left < c.width * 0.35,
      bottomSide: c.bottom - m.bottom < c.height * 0.35,
      veils: document.querySelectorAll('.freeze-veil').length,
    };
  });
  check('frozen card shows a snowflake on its own bottom-left corner', Boolean(r && r.inside && r.leftSide && r.bottomSide), JSON.stringify(r));
  check('no blue freeze overlay is drawn', r?.veils === 0, `veils ${r?.veils}`);
}

/* ── 21. 出售区是一整块（鲍勃区 + 酒馆，中间无空白）──────── */
{
  await post('/api/debug', { cmd: 'clear_zone', zone: 'hand' });
  await post('/api/debug', { cmd: 'add_minion', zone: 'board', card: 'BG20_104' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1100);
  const b = await page.locator('.board-row .card-wrap').first().boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y - 60, { steps: 8 });
  await page.mouse.move(700, 200, { steps: 12 });
  await page.waitForTimeout(150);
  const zone = await page.evaluate(() => {
    const z = document.querySelector('.sell-zone');
    if (!z) return null;
    const r = z.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), shop: Math.round(document.querySelector('.shop-row').getBoundingClientRect().bottom), bart: Math.round(document.querySelector('.bartender').getBoundingClientRect().top) };
  });
  await page.mouse.up();
  await page.waitForTimeout(300);
  check('sell area spans bartender → tavern with no gap', Boolean(zone) && Math.abs(zone.y - zone.bart) <= 2 && Math.abs(zone.y + zone.h - zone.shop) <= 2, JSON.stringify(zone));
}

/* ── 22. 金色手牌统一使用酒馆卡面 ──────────────────────── */
{
  await post('/api/debug', { cmd: 'clear_zone', zone: 'hand' });
  for (const id of ['BG26_805_G', 'BG29_611_G', 'BG36_208_G']) {
    await post('/api/debug', { cmd: 'add_minion', zone: 'hand', card: id });
  }
  await post('/api/debug', { cmd: 'add_spell', zone: 'hand', card: 'BG28_825' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1400);
  const info = await page.evaluate(() =>
    [...document.querySelectorAll('.hand-card')].map((c) => ({
      golden: c.classList.contains('golden'),
      src: c.querySelector('img')?.getAttribute('src') || '',
      glow: getComputedStyle(c).animationName,
      stats: [...c.querySelectorAll('.card-stat')].map((s) => s.textContent),
    })),
  );
  check(
    'golden hand cards pulse with the gold glow',
    info.filter((i) => i.golden).length > 0 &&
      info.filter((i) => i.golden).every((i) => i.glow === 'goldCardGlow') &&
      info.filter((i) => !i.golden).every((i) => i.glow === 'none'),
    `${info.filter((i) => i.golden).length} golden`,
  );
  check('hand cards never use the constructed card render', info.every((i) => !i.src.includes('/v1/render/')), info.map((i) => i.src.split('/').pop()).join(','));
  check(
    'every minion in hand paints its live stats',
    info.filter((i) => i.stats.length > 0 || i.golden).every((i) => i.stats.length === 2),
    info.map((i) => i.stats.join('/') || 'spell').join(' | '),
  );
  const spellNoStats = await page.evaluate(async () => {
    const st = await fetch('/api/state').then((r) => r.json());
    const minions = st.game.me.hand.filter((h) => h.type === 'minion').length;
    const spells = st.game.me.hand.filter((h) => h.type === 'spell').length;
    return {
      minions,
      spells,
      painted: document.querySelectorAll('.hand-card .card-stat').length,
    };
  });
  check(
    'hand spells never paint stats',
    spellNoStats.spells > 0 && spellNoStats.painted === spellNoStats.minions * 2,
    JSON.stringify(spellNoStats),
  );
  const strayStats = await page.evaluate(
    () => document.querySelectorAll('.card-stat').length - document.querySelectorAll('.hand-card .card-stat').length,
  );
  check('only hand cards paint stats (no 0/0 on spells or trinkets)', strayStats === 0, `stray ${strayStats}`);
}

/* ── 23. 顶部种族栏：图标都有、畸变只出现一次 ──────────── */
{
  // seed 101 的大厅含 野兽 + 畸变，并带一个神明
  await post('/api/new', { seed: 101 });
  let s = await get('/api/state');
  if (s.game.phase === 'hero_select') s = await post('/api/hero', { id: s.game.me.pending.options[0].id });
  for (let i = 0; i < 8; i++) {
    s = await get('/api/state');
    const p = s.game.me.pending;
    if (!p) break;
    if (['discover', 'quest', 'trinket', 'choose_one', 'timewarp'].includes(p.kind)) await post('/api/choose', { option: 0 });
    else break;
  }
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1400);

  const chips = await page.evaluate(() =>
    [...document.querySelectorAll('.tier-pop-races .race-chip')].map((el) => ({
      text: el.textContent.trim(),
      loaded: (el.querySelector('img')?.naturalWidth ?? 0) > 0,
    })),
  );
  check('every lobby race chip has a working icon', chips.length > 0 && chips.every((c) => c.loaded), chips.map((c) => c.text).join(','));
  const beast = chips.find((c) => c.text === '野兽');
  check('the beast tribe shows an icon', Boolean(beast && beast.loaded), beast ? 'icon loaded' : 'no beast chip');
  const aber = chips.filter((c) => c.text.includes('畸变'));
  check('aberration is listed once, labelled 畸变怪', aber.length === 1 && aber[0].text.startsWith('畸变怪'), JSON.stringify(aber.map((c) => c.text)));
}

/* ── 24. opponent rail: next marker + scouted-turn + race chips ── */
{
  await post('/api/new', { seed: 4242 });
  let s = await get('/api/state');
  if (s.game.phase === 'hero_select') s = await post('/api/hero', { id: s.game.me.pending.options[0].id });
  for (let i = 0; i < 4; i++) await post('/api/action', { action: 0 });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  const nextMark = await page.evaluate(() => {
    const el = document.querySelector('.opp-avatar.next');
    if (!el) return null;
    const face = el.querySelector('.opp-face');
    return {
      transform: getComputedStyle(el).transform,
      border: face ? getComputedStyle(face).borderTopColor : null,
      tier: el.querySelector('.opp-tier-badge')?.textContent?.trim() ?? null,
    };
  });
  check(
    'the next opponent slides half a slot and wears a red frame',
    nextMark?.transform === 'matrix(1, 0, 0, 1, 32, 0)' && /224, 70, 58/.test(nextMark?.border ?? ''),
    JSON.stringify(nextMark),
  );

  // buying a tavern card: the drop area must reach 2/3 of the hero portrait
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  const slot = await page.locator('.shop-slot').first().boundingBox();
  await page.mouse.move(slot.x + slot.width / 2, slot.y + slot.height / 2);
  await page.mouse.down();
  await page.mouse.move(slot.x + slot.width / 2, slot.y + 40, { steps: 8 });
  await page.mouse.move(800, 760, { steps: 10 });
  await page.waitForTimeout(180);
  const zone = await page.evaluate(() => {
    const z = document.querySelector('.hand-drop-zone');
    const hero = document.querySelector('.player-hero')?.getBoundingClientRect();
    const hand = document.querySelector('.hand-row')?.getBoundingClientRect();
    if (!z || !hero || !hand) return null;
    const r = z.getBoundingClientRect();
    return {
      top: Math.round(r.top),
      width: Math.round(r.width),
      twoThirds: Math.round(hero.top + hero.height / 3),
      handWidth: Math.round(hand.width),
    };
  });
  await page.mouse.up();
  await page.waitForTimeout(300);
  check(
    'the buy-into-hand zone reaches 2/3 of the hero and keeps the hand width',
    Boolean(zone) && Math.abs(zone.top - zone.twoThirds) <= 2 && Math.abs(zone.width - zone.handWidth) <= 2,
    JSON.stringify(zone),
  );

  // Opponent panel: the chip comes from last round's board (public), the cards
  // from the warband we actually saw, plus triples/streak on the same row.
  const board = (await get('/api/state')).game;
  const expected = new Map();
  const summarize = (races) => {
    const entries = Object.entries(races ?? {});
    let best = 0;
    for (const [, n] of entries) if (n > best) best = n;
    const top = entries.filter(([, n]) => n === best);
    return {
      kind: entries.length === 0 ? 'none' : top.length > 1 ? 'mixed' : 'race',
      race: top.length === 1 ? top[0][0] : null,
      count: best,
    };
  };
  for (const o of board.opponents) {
    const ago = o.seenBoard.length > 0 && o.seenTurn > 0 ? Math.max(0, board.turn - o.seenTurn) : null;
    expected.set(`o${o.id}`, {
      ...summarize(o.lastRaces),
      cards: o.seenBoard.length,
      ago,
      triples: o.triples,
      streak: o.streak,
    });
  }
  // Our own avatar gets the same panel, minus the warband and the sighting line.
  expected.set('o-self', {
    ...summarize(board.me.lastRaces),
    cards: 0,
    ago: null,
    triples: board.me.triples,
    streak: board.me.streak,
  });
  const keys = await page.evaluate(() => [...document.querySelectorAll('.opp-wrap')].map((e) => e.dataset.flipKey));
  const seen = [];
  for (const key of keys) {
    const box = await page.locator(`.opp-wrap[data-flip-key="${key}"]`).boundingBox();
    if (!box) continue;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(140);
    const info = await page.evaluate(() => {
      const el = document.querySelector('.opp-pop');
      if (!el) return null;
      return {
        head: el.querySelector('.oph-title')?.textContent ?? '',
        chip: el.querySelector('.oph-tribes .oph-race-name')?.textContent?.trim() ?? null,
        count: el.querySelector('.oph-tribes .oph-race-count')?.textContent?.trim() ?? null,
        mixed: (el.querySelector('.oph-tribes .oph-race-name')?.textContent?.trim() ?? null) === '混合随从' ? '混合随从' : null,
        chips: [...el.querySelectorAll('.oph-tribes .oph-race-name')].filter(
          (e) => !['混合随从', '阵容未知'].includes(e.textContent?.trim() ?? ''),
        ).length,
        stats: [...el.querySelectorAll('.opp-stat')].map((e) => ({
          kind: e.getAttribute('data-stat'),
          value: Number(e.getAttribute('data-value')),
        })),
        cards: el.querySelectorAll('.opp-pop-cards .card-wrap').length,
        peek: document.querySelectorAll('.warband-peek-row .card-wrap').length,
      };
    });
    if (info) seen.push({ key, ...info });
    await page.mouse.move(5, 5);
    await page.waitForTimeout(60);
  }

  check(
    'the tier line still says when we last met them',
    seen.length > 0 &&
      seen.every((s) => {
        const ago = expected.get(s.key)?.ago;
        if (ago === null) return !/回合前|本回合/.test(s.head);
        return ago === 0 ? s.head.includes('本回合') : s.head.includes(`${ago} 回合前`);
      }),
    JSON.stringify(seen.map((s) => [s.key, s.head, expected.get(s.key)?.ago])),
  );
  const chipOk = seen.every((s) => {
    const want = expected.get(s.key);
    if (!want) return false;
    if (want.kind === 'race') return s.chips === 1 && s.count === String(want.count);
    return s.chips === 0;
  });
  check('only the most numerous race is shown, with its count', chipOk, JSON.stringify(seen.map((s) => [s.key, s.chip, s.count])));
  check('a tie at the top reads as 混合随从', seen.every((s) => {
    const want = expected.get(s.key);
    return want?.kind === 'mixed' ? s.mixed === '混合随从' : !s.mixed;
  }), JSON.stringify(seen.filter((s) => s.mixed).map((s) => s.key)));
  check(
    'the hovered warband floats above Bob, and only as much as we saw',
    seen.every((s) => s.peek === expected.get(s.key)?.cards),
    JSON.stringify(seen.map((s) => [s.key, s.peek, expected.get(s.key)?.cards])),
  );
  check('triples and streak sit on the same row as the race chip', seen.every((s) => s.stats.length === 2 && s.stats[0].kind === 'triples' && s.stats[1].kind === 'streak'), JSON.stringify(seen[0]?.stats));
  check('the counters match the engine\'s log', seen.every((s) => {
    const want = expected.get(s.key);
    return s.stats[0]?.value === want?.triples && s.stats[1]?.value === want?.streak;
  }), JSON.stringify(seen.map((s) => [s.key, s.stats.map((x) => x.value), expected.get(s.key)?.triples, expected.get(s.key)?.streak])));

  const self = seen.find((s) => s.key === 'o-self');
  check(
    'our own avatar shows the counters, but no warband and no sighting label',
    Boolean(self) &&
      self.cards === 0 &&
      self.peek === 0 &&
      !/回合前|本回合/.test(self.head) &&
      self.stats.length === 2 &&
      self.stats[0].value === expected.get('o-self')?.triples &&
      self.stats[1].value === expected.get('o-self')?.streak,
    JSON.stringify(self),
  );
}

/* ── 26. opponent combat log ───────────────────────────────── */
{
  // Fresh game so the log starts empty and the board/HP do not decide the run.
  await post('/api/new', { seed: 987654 });
  let fresh = await get('/api/state');
  if (fresh.game.phase === 'hero_select') fresh = await post('/api/hero', { id: fresh.game.me.pending.options[0].id });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1100);
  // Turn one: the bots already have minions, but nothing about their warband is
  // public until a combat round has resolved.
  const atStart = (await get('/api/state')).game;
  check(
    'no public warband info before the first combat',
    atStart.turn === 1 && atStart.opponents.every((o) => Object.keys(o.lastRaces).length === 0),
    JSON.stringify(atStart.opponents.map((o) => o.lastRaces)),
  );
  // Three rounds of combat, driven through the UI so the client is the one
  // that records them (the engine only keeps the round that just resolved).
  const clearPending = async () => {
    for (let g = 0; g < 6; g++) {
      // Discover now floats as an overlay; the other pickers are still modals.
      if (!(await page.locator('[data-option="0"]').count())) return;
      const opt = page.locator('[data-option="0"]').first();
      await opt.click({ force: true });
      await page.waitForTimeout(500);
    }
  };
  const rounds = [];
  let firstRoundRaces = null;
  for (let i = 0; i < 3; i++) {
    await clearPending();
    const btn = page.locator('.end-turn-btn').first();
    if (await btn.isDisabled()) break;
    await btn.click();
    await page.waitForTimeout(700);
    // Fast-forward the replay, then dismiss it (same clicks as section 11).
    for (let g = 0; g < 8 && (await page.locator('.combat-layer').count()); g++) {
      await page.mouse.click(160, 820);
      await page.waitForTimeout(350);
    }
    await page.waitForTimeout(400);
    await clearPending();
    const s = (await get('/api/state')).game;
    rounds.push(s.combatSummaries ?? []);
    if (i === 0) firstRoundRaces = s.opponents.map((o) => o.lastRaces);
  }
  const last = rounds[rounds.length - 1] ?? [];
  check('ending a turn yields the round\'s fight table', last.length > 0, `rounds=${rounds.length} last=${last.length}`);

  // Turn 2 must describe round 1's boards (one minion each with 3 starting
  // gold), not the shopping the bots already did for their next turn.
  const totals = (firstRoundRaces ?? []).map((r) => Object.values(r).reduce((a, b) => a + b, 0));
  check(
    'the turn-2 tribes come from round 1\'s board, not the live one',
    totals.length > 0 && totals.every((n) => n <= 2) && totals.filter((n) => n === 1).length >= 4,
    JSON.stringify({ totals, firstRoundRaces }),
  );

  const afterRounds = (await get('/api/state')).game;
  check(
    'tribe counts go public once a round has resolved',
    afterRounds.opponents.some((o) => Object.keys(o.lastRaces).length > 0),
    JSON.stringify(afterRounds.opponents.map((o) => o.lastRaces)),
  );

  const seen = [];
  for (const key of await page.evaluate(() => [...document.querySelectorAll('.opp-wrap')].map((e) => e.dataset.flipKey))) {
    const box = await page.locator(`.opp-wrap[data-flip-key="${key}"]`).boundingBox();
    if (!box) continue;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(160);
    const info = await page.evaluate(() => {
      const pop = document.querySelector('.opp-pop');
      if (!pop) return null;
      return {
        title: pop.querySelector('.opp-log .rail-title')?.textContent ?? '',
        rows: [...pop.querySelectorAll('.combat-log-row')].map((r) => ({
          sides: [...r.querySelectorAll('.cl-side')].map((s) => s.className),
          badges: [...r.querySelectorAll('.cl-dmg')].map((b) => ({
            side: b.classList.contains('left') ? 'L' : 'R',
            dmg: Number(b.getAttribute('data-dmg')),
            text: b.textContent,
          })),
        })),
      };
    });
    await page.mouse.move(5, 5);
    await page.waitForTimeout(60);
    if (info) seen.push({ key, ...info });
  }

  check('the panel is titled 战斗记录', seen.every((s) => s.title === '战斗记录') && seen.length > 0, `panels=${seen.length}`);
  check('no panel shows the old 最近战斗 block', seen.every((s) => !s.title.includes('最近')));

  const withRows = seen.filter((s) => s.rows.length > 0);
  check('opponents accumulate a fight log', withRows.length > 0, `withRows=${withRows.length}/${seen.length}`);
  check(
    'each opponent keeps exactly 3 fights (one per round so far)',
    withRows.every((s) => s.rows.length === Math.min(3, rounds.length)),
    JSON.stringify(withRows.map((s) => s.rows.length)),
  );

  // Newest row has to describe the round that just resolved. Prefer a decided
  // fight so the "damage sits on the loser's side" rule is actually exercised.
  const decided = last.find((c) => c.a !== 0 && c.b !== null && (c.winner === 0 || c.winner === 1));
  const drawn = last.find((c) => c.winner !== 0 && c.winner !== 1 && c.a !== 0);
  const match = decided ?? drawn ?? last[0];
  const seat = match ? match.a : -1;
  const panel = seen.find((s) => s.key === `o${seat}`);
  if (match && panel) {
    const row = panel.rows[0];
    const draw = match.winner !== 0 && match.winner !== 1;
    const loser = draw ? null : match.winner === 0 ? match.b : match.a;
    const expected = draw
      ? [{ side: 'L', dmg: 0 }, { side: 'R', dmg: 0 }]
      : [{ side: loser === seat ? 'L' : 'R', dmg: match.damage }];
    const got = row.badges.map((b) => ({ side: b.side, dmg: b.dmg }));
    check(
      'damage lands on the side that took it',
      JSON.stringify(got) === JSON.stringify(expected),
      `seat=${seat} match=${JSON.stringify(match)} got=${JSON.stringify(got)}`,
    );
    check(
      'the newest row is the round that just resolved',
      draw ? row.badges.length === 2 : row.badges[0].dmg === match.damage,
      JSON.stringify(got),
    );
    check(
      'the losing side shows a minus sign',
      draw ? row.badges.every((b) => b.text === '0') : row.badges[0].text === `-${match.damage}`,
      JSON.stringify(row.badges.map((b) => b.text)),
    );
  } else {
    check('found a panel for the round that just resolved', false, `seat=${seat} match=${Boolean(match)}`);
  }

  // A draw has to read as 0 on both sides even if it was not the newest row.
  if (drawn) {
    const panel2 = seen.find((s) => s.key === `o${drawn.a}`);
    const idx = panel2?.rows.findIndex((r) => r.badges.length === 2 && r.badges.every((b) => b.dmg === 0)) ?? -1;
    check('a drawn fight shows 0 on both sides', idx >= 0, `seat=${drawn.a} rows=${panel2?.rows.length}`);
  }
}

/* ── 26a. the turn clock and its burning rope ─────────────── */
{
  await post('/api/new', { seed: 4242 });
  const fresh = await get('/api/state');
  await post('/api/hero', { id: fresh.game.me.pending.options[0].id });
  const pre = (await get('/api/state')).game.me.pending;
  if (pre?.kind) await post('/api/action', { action: 30 });
  // The suite runs with the clock off (see 0b); this section needs it on.
  await page.evaluate(() => localStorage.setItem('bgsim.timeLimit', '1'));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1300);

  const limits = await page.evaluate(async () => {
    const m = await import('/src/lib/turnClock.ts');
    return [1, 4, 5, 9, 10, 15].map((t) => m.turnLimit(t));
  });
  check(
    'turn limits: 45s / 120s / 180s by round',
    JSON.stringify(limits) === JSON.stringify([45, 45, 120, 120, 180, 180]),
    JSON.stringify(limits),
  );

  const watch = () =>
    page.evaluate(() => {
      const rope = document.querySelector('.burn-rope');
      const tail = document.querySelector('.burn-rope-tail');
      const rb = rope?.getBoundingClientRect();
      return {
        time: document.querySelector('.topbar-time')?.textContent ?? '',
        urgent: Boolean(document.querySelector('.turn-plaque.urgent')),
        rope: Boolean(rope),
        tail: tail && rb ? Math.round((tail.getBoundingClientRect().width / rb.width) * 100) : null,
        box: rb ? { x: Math.round(rb.x), y: Math.round(rb.y), w: Math.round(rb.width), h: Math.round(rb.height) } : null,
      };
    });

  const fresh2 = await watch();
  const secs = Number(fresh2.time.replace('秒', ''));
  check('the HUD counts down, not up', /^\d+秒$/.test(fresh2.time) && secs > 40 && secs <= 45, `${fresh2.time} (${secs}s)`);
  check('no rope while there is time on the clock', !fresh2.rope && !fresh2.urgent, JSON.stringify(fresh2));

  // Wind the clock to 18 seconds left (the `clock` seam on boot).
  await page.goto(APP + '/?mode=single&clock=27', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  const burn = await watch();
  check('the last 20 seconds turn the HUD red and show the rope', burn.rope && burn.urgent, JSON.stringify(burn));
  // The rope length must track the countdown: left/20 of the strip.
  const burnSecs = Number(burn.time.replace('秒', ''));
  const expectedTail = Math.min(100, (burnSecs / 20) * 100);
  check(
    'the rope burns down with the clock (left/20 of the strip)',
    burn.tail !== null && burnSecs > 0 && burnSecs <= 20 && Math.abs(burn.tail - expectedTail) <= 8,
    `${burn.tail}% drawn vs ${Math.round(expectedTail)}% expected at ${burn.time}`,
  );
  // The rope is drawn from the layout: it starts just inside the warband row and
  // stops short of the end-turn button. Derive the expectation from the boxes
  // instead of hard-coding pixels, so a re-exported layout does not break it.
  const boxes = await page.evaluate(() => {
    const r = (sel) => {
      const b = document.querySelector(sel)?.getBoundingClientRect();
      return b ? { x: b.x, y: b.y, w: b.width, h: b.height, right: b.right } : null;
    };
    const board = r('.board-row');
    const endTurn = r('.end-turn-slot') ?? r('.end-turn-btn');
    return { board, endTurn };
  });
  check(
    'the rope is centred on the turn clock',
    Boolean(burn.box && boxes.board && boxes.endTurn) &&
      Math.abs(burn.box.y + burn.box.h / 2 - (Math.round(boxes.endTurn.y) + Math.round(boxes.endTurn.h) / 2)) <= 2 &&
      Math.abs(burn.box.x - (Math.round(boxes.board.x) + 6)) <= 2 &&
      burn.box.w > 700,
    JSON.stringify({ rope: burn.box, endTurn: boxes.endTurn, board: boxes.board }),
  );
  const layers = await page.evaluate(() => ({
    rope: Number(getComputedStyle(document.querySelector('.burn-rope')).zIndex),
    board: Number(getComputedStyle(document.querySelector('.board-row')).zIndex),
    shop: Number(getComputedStyle(document.querySelector('.shop-row')).zIndex),
  }));
  check('the rope is layered under the cards', layers.rope < Math.min(layers.board, layers.shop), JSON.stringify(layers));

  // Let it burn out: the turn has to end by itself.
  await page.goto(APP + '/?mode=single&clock=44.4', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2200);
  const next = (await get('/api/state')).game;
  check(
    'the turn ends by itself when the rope burns out',
    next.turn === 2 || Boolean(next.combat),
    `turn ${next.turn}, combat ${Boolean(next.combat)}`,
  );

  // Back to no clock: the remaining sections poke at the UI for a while.
  await page.evaluate(() => localStorage.setItem('bgsim.timeLimit', '0'));
}

/* ── 26b. the refresh button says how many free rolls are left ── */
{
  await post('/api/new', { seed: 606 });
  const fresh = await get('/api/state');
  await post('/api/hero', { id: fresh.game.me.pending.options[0].id });
  const pre = (await get('/api/state')).game.me.pending;
  if (pre?.kind) await post('/api/action', { action: 30 });
  await post('/api/debug', { cmd: 'set_player', gold: 30, free_refreshes: 2 });
  // Clean URL: the previous section left `?clock=` behind, which would wind the
  // new turn's clock forward too.
  await page.goto(APP + '/?mode=single', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1300);

  const tipOf = () =>
    page.evaluate(() => {
      const el = document.querySelector('.btn-tip');
      return el ? { text: el.textContent ?? '', opacity: getComputedStyle(el).opacity } : null;
    });

  await page.locator('.faithful-btn').first().hover();
  await page.waitForTimeout(350);
  const on = await tipOf();
  check('hovering the refresh button counts the free rolls', Boolean(on) && on.text.includes('2') && on.opacity === '1', JSON.stringify(on));

  await post('/api/debug', { cmd: 'set_player', free_refreshes: 0 });
  await page.goto(APP + '/?mode=single', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1300);
  await page.locator('.faithful-btn').first().hover();
  await page.waitForTimeout(350);
  const off = await tipOf();
  check('…and says nothing when there are none', off === null, JSON.stringify(off));
}

/* ── 27. catalog tier 7 + local art pack ──────────────────── */
{
  // 7-star minions never enter the shop pool; the catalog has to include them
  // explicitly or the tier-7 tab is empty.
  await page.locator('.hud-btn[aria-label="图鉴"]').first().click();
  await page.waitForTimeout(500);
  await page.locator('.modal .btn', { hasText: '7' }).first().click();
  await page.waitForTimeout(900);
  const tier7 = await page.evaluate(() => ({
    cards: document.querySelectorAll('.modal .card-wrap').length,
    header: document.querySelector('.modal .sub')?.textContent ?? '',
  }));
  check('the catalog shows tier-7 minions', tier7.cards > 0, JSON.stringify(tier7));
  await page.locator('.modal .btn', { hasText: '关闭' }).first().click();
  await page.waitForTimeout(300);

  // Art pack: status shape, and the cached files are served by the engine.
  const pack = await get('/api/assets');
  check(
    'the art pack reports per-kind totals',
    ['hero', 'portrait', 'render'].every((k) => pack.kinds?.[k] && typeof pack.kinds[k].total === 'number'),
    JSON.stringify(Object.keys(pack.kinds ?? {})),
  );

  // The whole pack is downloadable, but only for the ids the game shows:
  // 256px renders (512px would be 3x the bytes) and no golden `_G` duplicates.
  check(
    'the pack covers every card the game shows, without golden duplicates',
    pack.kinds.hero?.total > 100 && pack.kinds.portrait?.total > 500 && pack.kinds.render?.total > 500 && pack.kinds.render?.total <= pack.kinds.portrait?.total,
    JSON.stringify({ hero: pack.kinds.hero?.total, portrait: pack.kinds.portrait?.total, render: pack.kinds.render?.total }),
  );
  const started = await post('/api/assets/download', { kinds: ['hero'] });
  check(
    'any kind can be bulk downloaded',
    started.ok !== false || started.already === true,
    JSON.stringify(started),
  );
  check(
    'the full pack stays near 250 MB',
    pack.estimate > 150 * 1048576 && pack.estimate < 400 * 1048576,
    `${Math.round((pack.estimate ?? 0) / 1048576)} MB`,
  );
  if (pack.kinds?.hero?.files > 0 && pack.enabled) {
    const hero = (await get('/api/state')).game.me.hero?.id;
    const res = await fetch(`${ENGINE}/art/hero/${hero}`);
    check(
      'cached art is served from the local pack',
      res.ok && (res.headers.get('content-type') ?? '').startsWith('image/'),
      `${res.status} ${res.headers.get('content-type')}`,
    );
  } else {
    check('cached art is served from the local pack', true, 'skipped: hero pack not downloaded on this machine');
  }
}

/* ── 28. screenshot ────────────────────────────────────────── */
await page.waitForTimeout(400);
await page.screenshot({ path: join(tmpdir(), 'feel-board.png') });

check('no page errors', errors.length === 0, errors.slice(0, 4).join(' | '));

console.log(`\n${ok.length} passed, ${fail.length} failed`);
if (fail.length) {
  console.log('FAILURES:');
  for (const f of fail) console.log(' - ' + f);
}
await browser.close();
process.exit(fail.length ? 1 : 0);
