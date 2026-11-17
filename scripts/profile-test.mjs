/**
 * Ruleset profile checks: the plumbing that lets a mechanic rotate out without
 * deleting its code.
 *
 *   node scripts/profile-test.mjs [engine]
 *
 * It proves three things against the bundled engine:
 *   1. `/api/profiles` lists the shipping profile and the lab profile;
 *   2. a solo game advertises `profile` + `caps` and the shipping profile keeps
 *      timewarp switched off;
 *   3. the lab profile really flips timewarp back on at the engine level, and
 *      the vanilla profile really stops trinkets from ever being offered.
 */
const ENGINE = (process.argv[2] || 'http://127.0.0.1:8787').replace(/\/$/, '');

const get = async (path) => {
  const res = await fetch(ENGINE + path);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
};
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

/** Drive the solo game forward until `turn` is reached (or a stop kind shows). */
async function playTo({ turn, stopKind }) {
  const kinds = new Set();
  const seen = { timewarp: [], trinket: [], dark: [] };
  for (let i = 0; i < 400; i++) {
    const state = await get('/api/state');
    const game = state.game;
    if (!game || game.phase === 'game_over') break;
    const pending = game.me?.pending;
    if (pending) {
      kinds.add(pending.kind);
      if (pending.kind === 'timewarp') seen.timewarp.push(game.turn);
      if (pending.kind === 'trinket') seen.trinket.push(game.turn);
      if (pending.kind === 'discover' || pending.kind === 'quest' || pending.kind === 'trinket' || pending.kind === 'choose_one' || pending.kind === 'timewarp') {
        await post('/api/choose', { option: 0 }).catch(() => post('/api/action', { action: 30 }));
      } else if (pending.kind === 'hero') {
        await post('/api/hero', { id: pending.options[0].id });
      } else {
        await post('/api/action', { action: 30 }).catch(() => {});
      }
      if (stopKind && pending.kind === stopKind) return { kinds, seen, turn: game.turn };
      continue;
    }
    if (game.turn >= turn) return { kinds, seen, turn: game.turn };
    await post('/api/action', { action: 0 });
  }
  const state = await get('/api/state');
  return { kinds, seen, turn: state.game?.turn ?? -1 };
}

const profiles = await get('/api/profiles');
const ids = (profiles.profiles || []).map((p) => p.id);
check('profiles endpoint lists shipping + lab', ids.includes('shipping') && ids.includes('lab'), JSON.stringify(ids));
check('the default profile is shipping', profiles.default === 'shipping', String(profiles.default));

// -- shipping: timewarp is off, the view advertises the capability ----------
await post('/api/new', { seed: 4242, profile: 'shipping' });
let state = await get('/api/state');
check('the game advertises its profile id', state.game?.profile === 'shipping', String(state.game?.profile));
check('the game advertises capabilities', typeof state.game?.caps === 'object' && state.game.caps !== null, JSON.stringify(state.game?.caps));
check('shipping has timewarp off', state.game?.caps?.timewarp === false, JSON.stringify(state.game?.caps));
check('shipping keeps trinkets on', state.game?.caps?.trinkets !== false);
const shipped = await playTo({ turn: 7 });
check('shipping never opens the timewarp tavern', shipped.seen.trinket.length > 0 && shipped.seen.timewarp.length === 0, `trinket ${shipped.seen.trinket} timewarp ${shipped.seen.timewarp}`);
const shippedGift = (await get('/api/state')).game?.me?.darkGift;
check('shipping unlocks the dark gift', shippedGift?.unlock_turn === 3 && shippedGift?.available === true, JSON.stringify(shippedGift));

// -- lab: a disabled mechanic can be switched back on ----------------------
await post('/api/new', { seed: 4242, profile: 'lab' });
state = await get('/api/state');
check('lab turns timewarp on in the capabilities', state.game?.caps?.timewarp === true, JSON.stringify(state.game?.caps));
const lab = await playTo({ turn: 7, stopKind: 'timewarp' });
check('lab really opens the timewarp tavern at the engine level', lab.seen.timewarp.length > 0, `turn ${lab.turn}, kinds ${[...lab.kinds]}`);

// -- vanilla: trinkets never offered ---------------------------------------
await post('/api/new', { seed: 4242, profile: 'vanilla' });
state = await get('/api/state');
check('vanilla turns trinkets off', state.game?.caps?.trinkets === false, JSON.stringify(state.game?.caps));
const vanilla = await playTo({ turn: 11 });
check('vanilla never offers a trinket', vanilla.seen.trinket.length === 0, `trinket ${vanilla.seen.trinket} up to turn ${vanilla.turn}`);
const vanillaGift = (await get('/api/state')).game?.me?.darkGift;
check(
  'vanilla leaves the dark gift locked',
  vanillaGift ? vanillaGift.unlock_turn === 999 && vanillaGift.available === false : true,
  JSON.stringify(vanillaGift),
);

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log('FAILURES:\n' + fails.map((f) => ` - ${f}`).join('\n'));
  process.exit(1);
}
