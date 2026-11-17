/**
 * Ruleset → UI checks: a feature the profile switches off must really disappear
 * from the table (slots, hover icons), and a profile that keeps it must render
 * it exactly as before.
 *
 *   node scripts/profile-ui-test.mjs [app] [engine]
 */
import { chromium } from 'playwright-core';
import { chromePath } from './chrome.mjs';

const APP = (process.argv[2] || 'http://localhost:5174').replace(/\/$/, '');
const ENGINE = (process.argv[3] || 'http://127.0.0.1:8799').replace(/\/$/, '');

const post = async (path, body) => {
  const res = await fetch(ENGINE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
};

let pass = 0;
const fails = [];
const check = (name, ok, detail = '') => {
  if (ok) {
    pass += 1;
    console.log(`PASS  ${name}`);
  } else {
    fails.push(name);
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

const browser = await chromium.launch({ executablePath: chromePath(), headless: true });

async function inspect(profile) {
  await post('/api/new', { seed: 6001, profile });
  // A fresh game starts on the hero picker; the table only renders after it.
  const state = await (await fetch(ENGINE + '/api/state')).json();
  const pending = state.game?.me?.pending;
  if (pending?.kind === 'hero' && pending.options?.[0]) {
    await post('/api/hero', { id: pending.options[0].id });
  }
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text().slice(0, 160));
  });
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 160)));
  await page.goto(APP + '/?mode=single&clock=31', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2600);
  const info = await page.evaluate(() => ({
    profile: window.__bgsim.store.getState().view?.profile ?? null,
    caps: window.__bgsim.store.getState().view?.caps ?? null,
    slots: document.querySelectorAll('.trinket-slot').length,
    rings: document.querySelectorAll('.trinket-empty, .trinket-icon').length,
    hud: document.querySelectorAll('.hero-power-slot, .board-row, .hand-row, .opponents-rail').length,
  }));
  await page.close();

  // The layout editor must not list boxes that the profile switched off.
  await post('/api/new', { seed: 6001, profile });
  const st2 = await (await fetch(ENGINE + '/api/state')).json();
  const p2 = st2.game?.me?.pending;
  if (p2?.kind === 'hero' && p2.options?.[0]) await post('/api/hero', { id: p2.options[0].id });
  const editPage = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  await editPage.goto(APP + '/?mode=single&edit=1', { waitUntil: 'domcontentloaded' });
  await editPage.waitForTimeout(2400);
  const editorNames = await editPage.evaluate(() =>
    [...document.querySelectorAll('.lp-item .lp-name')].map((e) => e.textContent?.trim() ?? ''),
  );
  const gifts = await editPage.evaluate(() => document.querySelectorAll('.gift-slot').length);
  await editPage.close();

  return { ...info, editorNames, gifts, errors };
}

const shipping = await inspect('shipping');
check('shipping: the view advertises its profile', shipping.profile === 'shipping', String(shipping.profile));
check('shipping: both trinket slots are on the table', shipping.slots === 2, JSON.stringify(shipping));
check('shipping: the rest of the HUD is unchanged', shipping.hud >= 4, String(shipping.hud));
check(
  'shipping: the layout editor lists both trinket boxes',
  shipping.editorNames.includes('大饰品') && shipping.editorNames.includes('小饰品'),
  JSON.stringify(shipping.editorNames),
);
check('shipping: the dark gift button is on the table and in the editor', shipping.gifts === 1 && shipping.editorNames.includes('黑暗之赐'), JSON.stringify({ gifts: shipping.gifts, names: shipping.editorNames }));

const vanilla = await inspect('vanilla');
check('vanilla: the view advertises its profile', vanilla.profile === 'vanilla', String(vanilla.profile));
check('vanilla: no trinket slots at all', vanilla.slots === 0, JSON.stringify(vanilla));
check('vanilla: no empty rings or icons left behind', vanilla.rings === 0, JSON.stringify(vanilla));
check('vanilla: the rest of the HUD still renders', vanilla.hud >= 4, String(vanilla.hud));
check(
  'vanilla: the layout editor no longer lists trinket boxes',
  !vanilla.editorNames.includes('大饰品') && !vanilla.editorNames.includes('小饰品'),
  JSON.stringify(vanilla.editorNames),
);
check('vanilla: the dark gift button and its editor row are gone', vanilla.gifts === 0 && !vanilla.editorNames.includes('黑暗之赐'), JSON.stringify({ gifts: vanilla.gifts, names: vanilla.editorNames }));

const lab = await inspect('lab');
check('lab: trinket slots are back', lab.slots === 2, JSON.stringify(lab));
check('lab: timewarp is advertised', lab.caps?.timewarp === true, JSON.stringify(lab.caps));

const allErrors = [...shipping.errors, ...vanilla.errors, ...lab.errors];
check('no page errors in any profile', allErrors.length === 0, allErrors.join(' | '));

await browser.close();
console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log('FAILURES:\n' + fails.map((f) => ` - ${f}`).join('\n'));
  process.exit(1);
}
