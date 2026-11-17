// Check the shipped default layout against the values the user exported from
// the UI editor. Reads the inline boxes off the rendered tavern (no window).
import { chromium } from 'playwright-core';
import { chromePath } from './chrome.mjs';

const APP = process.argv[2] || 'http://localhost:5174';
const ENGINE = process.argv[3] || 'http://127.0.0.1:8799';
const CHROME = chromePath();

const post = (p, b) =>
  fetch(ENGINE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
const get = (p) => fetch(ENGINE + p).then((r) => r.json());

const WANT = {
  nameplate: { x: 0, y: 22, w: 230, h: 34 },
  playerPlate: { x: 0, y: 800, w: 268, h: 66 },
  corner: { x: 1446, y: 840, w: 148, h: 46 },
  races: { x: 1300, y: 14, w: 286, h: 68 },
  opponents: { x: 236, y: 148, w: 72, h: 616 },
  bartender: { x: 725, y: 90, w: 150, h: 180 },
  tier: { x: 703, y: 177, w: 61, h: 80 },
  shopButtons: { x: 890, y: 92, w: 196, h: 132 },
  shopRow: { x: 317, y: 258, w: 1015, h: 169 },
  boardRow: { x: 305, y: 430, w: 977, h: 140 },
  handRow: { x: 291, y: 749, w: 1008, h: 169 },
  playerHero: { x: 720, y: 585, w: 152, h: 180 },
  heroPower: { x: 890, y: 612, w: 96, h: 100 },
  gold: { x: 1003, y: 785, w: 226, h: 40 },
  upgrade: { x: 607, y: 132, w: 78, h: 128 },
  trinketGreater: { x: 585, y: 618, w: 78, h: 78 },
  trinketLesser: { x: 642, y: 686, w: 78, h: 78 },
  endTurn: { x: 1186, y: 387, w: 140, h: 62 },
};

await post('/api/new', { seed: 20260113 });
let st = await get('/api/state');
if (st.game.phase === 'hero_select') st = await post('/api/hero', { id: st.game.me.pending.options[0].id });

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto(APP + '/?mode=single', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

const got = await page.evaluate(() => {
  const out = {};
  // Every EditableBox writes its layout numbers as inline styles.
  for (const el of document.querySelectorAll('.stage [style*="position: absolute"]')) {
    const s = el.style;
    if (!s.left || !s.width) continue;
    const cls = (el.className || '').toString().split(/\s+/)[0];
    out[cls] = {
      x: Math.round(parseFloat(s.left)),
      y: Math.round(parseFloat(s.top)),
      w: Math.round(parseFloat(s.width)),
      h: Math.round(parseFloat(s.height)),
    };
  }
  return out;
});

console.log('classes found:', Object.keys(got).sort().join(', '));
const CLASS_OF = {
  nameplate: 'nameplate',
  playerPlate: 'player-plate',
  races: 'lobby-races',
  corner: 'corner-icons',
  opponents: 'opponents-rail',
  bartender: 'bartender',
  tier: 'tavern-tier',
  shopButtons: 'shop-buttons',
  shopRow: 'shop-row',
  boardRow: 'board-row',
  handRow: 'hand-row',
  playerHero: 'player-hero',
  heroPower: 'hero-power-slot',
  gold: 'gold-panel',
  upgrade: 'upgrade-slot',
  trinketGreater: 'trinket-greater',
  trinketLesser: 'trinket-lesser',
  endTurn: 'end-turn-slot',
};
const line = (k, a, b) => `${JSON.stringify(a) === JSON.stringify(b) ? 'OK  ' : 'DIFF'} ${k}: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`;
let bad = 0;
for (const [k, v] of Object.entries(WANT)) {
  const g = got[CLASS_OF[k] ?? k] ?? null;
  if (!g) {
    console.log(`MISS ${k} (${CLASS_OF[k] ?? k} not rendered)`);
    continue;
  }
  const same = g.x === v.x && g.y === v.y && g.w === v.w && g.h === v.h;
  if (!same) bad++;
  console.log(line(k, g, v));
}
const sizes = await page.evaluate(() => {
  const s = document.querySelector('.stage');
  const r = s.getBoundingClientRect();
  const card = document.querySelector('.shop-slot .card-wrap');
  return { stage: Math.round(r.width), shopCard: card ? Math.round(card.getBoundingClientRect().width) : null };
});
console.log('stage width (px):', sizes.stage, 'shop card width:', sizes.shopCard);
console.log(bad === 0 ? 'LAYOUT MATCHES' : `${bad} MISMATCHES`);
await browser.close();


