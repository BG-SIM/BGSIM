// Multiplayer UI test: the human path, not the autoplay path.
//
// One player is auto-played (`?bot=1`) so a match can start with two people;
// the other drives the real screens with a mouse: launcher → queue → match →
// hero select → tavern → end turn → next round. Everything it asserts is
// something a player would notice.
//
//   npm run build && node scripts/net-ui-test.mjs
import { chromium } from 'playwright-core';
import { chromePath } from './chrome.mjs';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Fatal, assert, exitWith, freePort, get, sleep, startEngine } from './lib/harness.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = chromePath();

function startRelay(port, need) {
  const proc = spawn(
    process.execPath,
    [join(ROOT, 'server', 'relay.mjs'), '--port', String(port), '--need', String(need), '--hero-ms', '180000'],
    { cwd: ROOT, stdio: 'ignore' },
  );
  return { proc, stop: () => proc.kill() };
}

async function state(page) {
  return page.evaluate(() => {
    const store = window.__bgsim.store.getState();
    const net = window.__bgsim.net.getState();
    return {
      status: net.status,
      seat: net.seat,
      needMe: net.needMe,
      queued: net.queued,
      inQueue: net.inQueue,
      turn: store.view?.turn ?? null,
      phase: store.view?.phase ?? null,
      screen: store.screen,
      mode: store.mode,
      ended: net.endedSeats.length,
      clock: document.querySelector('.topbar-time')?.textContent ?? null,
    };
  });
}

/** Wait for a predicate on the page state, polling. */
async function waitFor(label, fn, ms = 30000) {
  const until = Date.now() + ms;
  let last = null;
  while (Date.now() < until) {
    last = await fn();
    if (last) return last;
    await sleep(200);
  }
  throw new Fatal(`timed out waiting for ${label}`);
}

/** Drag one card onto another spot, the way the game is actually played. */
async function drag(page, fromSel, toSel, { steps = 14, settle = 600 } = {}) {
  const from = page.locator(fromSel).first();
  const to = page.locator(toSel).first();
  const b = await from.boundingBox();
  const t = await to.boundingBox();
  if (!b || !t) throw new Fatal(`drag: missing ${fromSel} / ${toSel}`);
  const sx = b.x + b.width / 2;
  const sy = b.y + b.height / 2;
  const tx = t.x + t.width / 2;
  const ty = t.y + t.height / 2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  for (let i = 1; i <= steps; i += 1) {
    const p = i / steps;
    await page.mouse.move(sx + (tx - sx) * p, sy + (ty - sy) * p);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
  await page.waitForTimeout(settle);
}

async function main() {
  if (!existsSync(join(ROOT, 'dist', 'index.html'))) throw new Fatal('run npm run build first');
  const relayPort = await freePort();
  // Three humans so the lobby is actually observable: the second player sees
  // "2/3" and waits, instead of a match starting under their cursor.
  const relay = startRelay(relayPort, 3);
  const engines = [];
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const errors = [];
  const relayUrl = `ws://127.0.0.1:${relayPort}/net`;
  const autos = [];
  let human = null;
  const started = Date.now();
  try {
    for (let i = 0; ; i += 1) {
      try {
        if ((await get(relayPort, '/net/health')).ok) break;
      } catch {
        if (i > 100) throw new Fatal('relay did not start');
        await sleep(100);
      }
    }
    const ports = await Promise.all([freePort(), freePort(), freePort()]);
    for (const port of ports) engines.push(await startEngine(port));
    console.log(`relay :${relayPort} · engines ${ports.join(',')}`);

    // ---- the auto seat, so three people are enough for a table ----------
    const auto1 = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    autos.push(auto1);
    auto1.on('pageerror', (e) => errors.push(`auto: ${e.message}`));
    await auto1.goto(`http://127.0.0.1:${ports[0]}/?mode=net&bot=1&relay=${encodeURIComponent(relayUrl)}`, {
      waitUntil: 'domcontentloaded',
    });

    // ---- the human seat: start from the launcher -------------------------
    human = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    human.on('pageerror', (e) => errors.push(`human: ${e.message}`));
    human.on('console', (m) => {
      if (m.type() === 'error') errors.push(`human console: ${m.text().slice(0, 200)}`);
    });
    // The relay address travels in the URL so the built app knows where to go.
    await human.goto(`http://127.0.0.1:${ports[1]}/?relay=${encodeURIComponent(relayUrl)}`, { waitUntil: 'networkidle' });
    const card = human.locator('.home-card[data-mode="multi"]');
    assert((await card.count()) === 1, 'launcher shows a real multiplayer card');
    const multiItems = await card.locator('.home-item').allTextContents();
    assert(
      multiItems.some((t) => t.includes('开始排队')),
      'the multiplayer card offers 开始排队',
      multiItems.join(' / ').slice(0, 80),
    );

    await card.locator('.home-item[data-act="net-queue"]').click();
    const lobby = human.locator('.net-lobby');
    await lobby.waitFor({ state: 'visible', timeout: 10000 });
    await waitFor('my queue slot', async () => {
      const n = Number((await human.locator('.net-lobby-count').textContent())?.replace(/\D+/g, ''));
      return n >= 2 ? n : null;
    }, 10000);
    const queueText = await human.locator('.net-lobby-count').textContent();
    assert(/排队中 2\/3/.test(queueText ?? ''), 'the lobby shows the queue filling', queueText);
    assert((await human.locator('.net-dot.on').count()) === 2, 'two of the three lobby lights are lit');

    // ---- third player joins: the match starts --------------------------
    const auto2 = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    autos.push(auto2);
    auto2.on('pageerror', (e) => errors.push(`auto: ${e.message}`));
    await auto2.goto(`http://127.0.0.1:${ports[2]}/?mode=net&bot=1&relay=${encodeURIComponent(relayUrl)}`, {
      waitUntil: 'domcontentloaded',
    });

    await waitFor('hero select', async () => {
      const s = await state(human);
      return s.phase === 'hero_select' || s.phase === 'recruit' ? s : null;
    }, 30000);
    // The match-made splash is the hand-off between lobby and table.
    const splashSeen = await human.evaluate(() => Boolean(document.querySelector('.net-matched')));
    assert(splashSeen, 'a match-made splash bridges lobby and table');
    const atStart = await state(human);
    assert(atStart.mode === 'net' && atStart.screen === 'net', 'the match takes over the screen', `${atStart.mode}/${atStart.screen}`);
    assert(atStart.seat === 1, 'the second player sits in seat 2', `seat ${atStart.seat + 1}`);

    // Hero select is the first real screen: click a hero.
    if ((await state(human)).phase === 'hero_select') {
      const heroes = human.locator('.hero-pick-screen .hs-hero');
      await heroes.first().waitFor({ state: 'visible', timeout: 15000 });
      const count = await heroes.count();
      assert(count === 4, 'four heroes are offered', `${count}`);
      await heroes.nth(1).click();
      await human.locator('.hs-confirm').click();
      await waitFor('tavern after hero pick', async () => {
        const s = await state(human);
        return s.phase === 'recruit' ? s : null;
      }, 30000);
    }

    // ---- the tavern has the multiplayer furniture ----------------------
    const hud = human.locator('.net-hud');
    await hud.waitFor({ state: 'visible', timeout: 15000 });
    const hudText = (await hud.textContent()) ?? '';
    assert(/座位 2/.test(hudText), 'the HUD shows the seat number', hudText.slice(0, 60));
    assert((await human.locator('.net-pip').count()) === 8, 'the HUD draws all eight seat lights');
    await human.locator('.hud-btn[aria-label="菜单"]').click();
    const undoInMenu = human.locator('.modal .btn', { hasText: '撤销上一步' });
    assert(await undoInMenu.isDisabled(), 'undo is disabled in a net match');
    await human.locator('.modal .btn', { hasText: '继续游戏' }).click();

    // ---- it is my turn: buy something, then end it ----------------------
    const endBtn = human.locator('.end-turn-btn');
    await waitFor('my turn', async () => (await state(human)).needMe, 60000);
    assert(await endBtn.isEnabled(), 'the end-turn button is live on my turn');

    const beforeBuy = await human.evaluate(() => {
      const v = window.__bgsim.store.getState().view;
      return { hand: v.me.hand.length, gold: v.me.gold, shop: v.me.shop.length, price: v.me.shop[0]?.price ?? 3 };
    });
    if (beforeBuy.shop > 0 && beforeBuy.gold >= beforeBuy.price) {
      await drag(human, '.shop-row .card-wrap', '.hand-row', { settle: 700 });
      const afterBuy = await human.evaluate(() => {
        const v = window.__bgsim.store.getState().view;
        return { hand: v.me.hand.length, gold: v.me.gold, shop: v.me.shop.length };
      });
      assert(afterBuy.hand === beforeBuy.hand + 1, 'dragging a tavern card buys it through the relay', `hand ${beforeBuy.hand}→${afterBuy.hand}`);
      assert(afterBuy.gold < beforeBuy.gold, 'and the gold was charged once', `gold ${beforeBuy.gold}→${afterBuy.gold}`);
      assert(afterBuy.shop === beforeBuy.shop - 1, 'and the bought slot is gone from the tavern', `${beforeBuy.shop}→${afterBuy.shop}`);
    }

    const beforeTurn = (await state(human)).turn;
    const beforeSeq = await human.evaluate(() => window.__bgsim.net.getState().appliedSeq);
    await endBtn.click();
    await waitFor('my action went through the relay', async () => {
      const seq = await human.evaluate(() => window.__bgsim.net.getState().appliedSeq);
      return seq > beforeSeq ? seq : null;
    }, 20000);

    // ---- the relay's deadline is the clock -----------------------------
    await waitFor('next round', async () => {
      const s = await state(human);
      return s.turn > beforeTurn || s.phase === 'game_over' ? s : null;
    }, 180000);
    const next = await state(human);
    assert(next.turn === beforeTurn + 1 || next.phase === 'game_over', 'the round advanced for everybody', `turn ${next.turn}`);
    assert(/^\d+秒/.test(next.clock ?? ''), 'the HUD shows the relay clock', next.clock);

    // ---- three more rounds, the match keeps moving ---------------------
    let rounds = 0;
    for (let i = 0; i < 3; i += 1) {
      const mine = await waitFor('my turn', async () => {
        const s = await state(human);
        return s.needMe ? s : null;
      }, 180000);
      if (!mine || mine.phase === 'game_over') break;
      const t0 = mine.turn;
      await human.locator('.end-turn-btn').click();
      await waitFor('next round', async () => {
        const s = await state(human);
        return s.turn > t0 || s.phase === 'game_over' ? s : null;
      }, 180000);
      rounds += 1;
    }
    const played = await state(human);
    assert(rounds >= 1, 'several rounds went by without a hitch', `${rounds} rounds, now turn ${played.turn}`);

    // ---- leaving hands the app back to single player -------------------
    await human.locator('.net-hud-btn', { hasText: '离开' }).click();
    await human.locator('.net-hud-btn', { hasText: '确认离开' }).click();
    await waitFor('home after leaving', async () => {
      const s = await human.evaluate(() => ({
        screen: window.__bgsim.store.getState().screen,
        mode: window.__bgsim.store.getState().mode,
        hud: Boolean(document.querySelector('.net-hud')),
      }));
      return s.screen === 'home' && s.mode === 'solo' && !s.hud ? s : null;
    }, 15000);
    assert(true, 'leaving the match returns to the launcher in single-player mode');
    const soloCardCenter = await human.locator('.home-card[data-mode="single"]').isVisible();
    assert(soloCardCenter, 'the single-player card is still there and usable');
    assert(errors.length === 0, 'no page errors during the whole flow', errors.slice(0, 3).join(' | '));

    console.log(`\nnet ui ok — ${played.turn} rounds in ${((Date.now() - started) / 1000).toFixed(0)}s`);
    return 0;
  } finally {
    for (const a of autos) await a.close().catch(() => {});
    if (human) await human.close().catch(() => {});
    await browser.close().catch(() => {});
    for (const e of engines) e.stop();
    relay.stop();
  }
}

main().then(
  (code) => exitWith(code ?? 0),
  (err) => {
    console.error(err instanceof Fatal ? err.message : err);
    console.error('\nnet ui FAILED');
    exitWith(1);
  },
);
