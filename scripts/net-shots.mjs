// Screenshots of the multiplayer surfaces, against the production build served
// by throwaway engines. Run `npm run build` first.
//
//   node scripts/net-shots.mjs
import { chromium } from 'playwright-core';
import { chromePath } from './chrome.mjs';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, get, sleep, startEngine } from './lib/harness.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'screens');
const CHROME = chromePath();

if (!existsSync(join(ROOT, 'dist', 'index.html'))) {
  console.error('run npm run build first');
  process.exit(1);
}

const relayPort = await freePort();
const relay = spawn(process.execPath, [join(ROOT, 'server/relay.mjs'), '--port', String(relayPort), '--need', '3'], {
  stdio: 'ignore',
});
const ports = await Promise.all([freePort(), freePort(), freePort()]);
const engines = [];
for (const port of ports) engines.push(await startEngine(port));
const relayUrl = `ws://127.0.0.1:${relayPort}/net`;
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const autos = [];

for (let i = 0; ; i += 1) {
  try {
    if ((await get(relayPort, '/net/health')).ok) break;
  } catch {
    if (i > 80) throw new Error('relay did not start');
    await sleep(100);
  }
}

try {
  const auto1 = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  autos.push(auto1);
  await auto1.goto(`http://127.0.0.1:${ports[0]}/?mode=net&bot=1&relay=${encodeURIComponent(relayUrl)}`, {
    waitUntil: 'domcontentloaded',
  });

  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  await page.goto(`http://127.0.0.1:${ports[1]}/?relay=${encodeURIComponent(relayUrl)}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(OUT, 'home-multi.png') });

  await page.locator('.home-card[data-mode="multi"]').screenshot({ path: join(OUT, 'home-multi-card.png') });

  await page.locator('.home-item[data-act="net-queue"]').click();
  await page.locator('.net-lobby').waitFor({ state: 'visible', timeout: 10000 });
  await sleep(700);
  await page.screenshot({ path: join(OUT, 'net-lobby.png') });

  // Third player completes the table.
  const auto2 = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  autos.push(auto2);
  await auto2.goto(`http://127.0.0.1:${ports[2]}/?mode=net&bot=1&relay=${encodeURIComponent(relayUrl)}`, {
    waitUntil: 'domcontentloaded',
  });

  await page.waitForSelector('.net-matched', { state: 'visible', timeout: 20000 });
  // Re-open the two-second splash window so the shot is deterministic.
  await page.evaluate(() => window.__bgsim.net.setState({ matchedAt: Date.now() }));
  await sleep(500);
  await page.screenshot({ path: join(OUT, 'net-matched.png') });

  await page.waitForSelector('.hero-pick-screen', { timeout: 30000 }).catch(() => {});
  if (await page.locator('.hero-pick-screen').count()) {
    await page.evaluate(() => window.__bgsim.net.setState({ matchedAt: 0 }));
    await sleep(500);
    await page.screenshot({ path: join(OUT, 'net-hero-select.png') });
    await page.locator('.hero-pick-screen .hs-hero').first().click();
    await page.locator('.hs-confirm').click();
  }

  await page.waitForSelector('.tavern', { timeout: 30000 });
  await sleep(2200);
  await page.screenshot({ path: join(OUT, 'net-tavern.png') });
  await page.locator('.net-hud').screenshot({ path: join(OUT, 'net-hud.png') });

  console.log('shots written to docs/screens');
} finally {
  for (const a of autos) await a.close().catch(() => {});
  await browser.close().catch(() => {});
  for (const e of engines) e.stop();
  relay.kill();
}
