// One engine process, several clients.
//
// This is the regression test for a real bug: two browser tabs on one machine
// share one engine, and the engine used to keep a single multiplayer slot — so
// the second page silently took over the first page's seat. The symptom looked
// like "I picked my hero and his hero screen appeared".
//
//   node scripts/engine-slots-test.mjs
import { Fatal, assert, exitWith, freePort, get, post, startEngine } from './lib/harness.mjs';

const SEED = 606;
const HERO = 30; // first hero option

async function main() {
  const port = await freePort();
  const engine = await startEngine(port);
  try {
    // ---- two pages, one engine, same match ----------------------------
    const a = await post(port, '/api/net/new', { client: 'tab-a', seed: SEED, seat: 0 });
    const b = await post(port, '/api/net/new', { client: 'tab-b', seed: SEED, seat: 1 });
    assert(a.net?.seat === 0 && a.game?.seat === 0, 'tab A keeps its own seat', `seat ${a.game?.seat}`);
    assert(b.net?.seat === 1 && b.game?.seat === 1, 'tab B keeps its own seat', `seat ${b.game?.seat}`);
    assert(b.net?.slots === 2, 'the engine holds one slot per client', `${b.net?.slots} slots`);

    const status = async (client) => get(port, `/api/net/status?client=${client}`);
    const hash = async (client) => get(port, `/api/net/hash?client=${client}`);
    const sa = await status('tab-a');
    const sb = await status('tab-b');
    assert(sa.seat === 0 && sb.seat === 1, 'status answers per client, not per engine', `${sa.seat}/${sb.seat}`);

    // ---- an action only moves the slot it was sent to ------------------
    await post(port, '/api/net/steps', { client: 'tab-a', steps: [[0, HERO]] });
    const afterA = await status('tab-a');
    const stillB = await status('tab-b');
    assert(afterA.revision === 1, 'tab A applied its hero pick', `rev ${afterA.revision}`);
    assert(stillB.revision === 0, 'tab B did not move when A acted', `rev ${stillB.revision}`);
    assert(afterA.needs[0] === false && stillB.needs[0] === true, 'each slot wants its own hero pick');

    // ---- the same stream on both slots stays identical ------------------
    // Tab A already applied seat 0's pick; give it the rest of the round, and
    // give tab B the whole round. Both must land on the same state.
    for (let seat = 1; seat < 8; seat += 1) {
      await post(port, '/api/net/steps', { client: 'tab-a', steps: [[seat, HERO]] });
    }
    const stream = Array.from({ length: 8 }, (_, seat) => [seat, HERO]);
    await post(port, '/api/net/steps', { client: 'tab-b', steps: stream });
    const ha = await hash('tab-a');
    const hb = await hash('tab-b');
    assert(ha.turn === 1 && hb.turn === 1, 'both slots reached round 1', `${ha.turn}/${hb.turn}`);
    assert(ha.hash === hb.hash, 'two slots replaying the same stream are byte-identical', `${ha.hash} vs ${hb.hash}`);
    assert(ha.revision === 8 && hb.revision === 8, 'both slots count the same revisions', `${ha.revision}/${hb.revision}`);

    // ---- a third page gets a third seat, and does not disturb the first
    const c = await post(port, '/api/net/new', { client: 'tab-c', seed: SEED, seat: 5 });
    assert(c.net?.slots === 3, 'a third page opens a third slot', `${c.net?.slots} slots`);
    assert((await status('tab-a')).seat === 0 && (await status('tab-b')).seat === 1, 'the first two seats survived');
    assert((await status('tab-c')).seat === 5, 'the third page has its own seat', `seat ${(await status('tab-c')).seat}`);

    // ---- a request with no client id must not touch the others ---------
    const legacy = await post(port, '/api/net/new', { seed: SEED, seat: 2 });
    assert(legacy.net?.seat === 2, 'a client without an id gets the legacy slot');
    assert((await status('tab-a')).seat === 0, 'the legacy slot does not steal seat 0');

    // ---- slots are bounded (a browser left with many tabs) -------------
    for (let i = 0; i < 12; i += 1) await post(port, '/api/net/new', { client: `spare-${i}`, seed: SEED, seat: 3 });
    const health = await get(port, '/api/health');
    assert(health.netSlots <= 8, 'the engine caps how many slots it keeps', `${health.netSlots}`);

    // ---- the old single-slot variable is gone --------------------------
    const errors = [];
    for (const client of ['tab-a', 'tab-b']) {
      try {
        await status(client);
      } catch (e) {
        errors.push(e.message);
      }
    }
    assert(errors.length === 0, 'status never errors for a live slot', errors.join(' | '));

    console.log('\nengine slots ok');
    return 0;
  } finally {
    engine.stop();
  }
}

main().then(
  (code) => exitWith(code ?? 0),
  (err) => {
    console.error(err instanceof Fatal ? err.message : err);
    console.error('\nengine slots FAILED');
    exitWith(1);
  },
);
