// Lockstep determinism test — the one thing multiplayer cannot get wrong.
//
// Two independent engine processes run the same seed and the same global action
// order, each playing a *different* seat (the game is symmetric: every client
// holds all eight seats, it just looks at one of them). After every round both
// processes must hash their full state to the same value.
//
// Also checks the other side of the coin: applying the same actions in a
// different order must give a *different* hash, otherwise this test would pass
// on a broken relay and prove nothing.
//
//   node scripts/lockstep-test.mjs
import { Fatal, assert, exitWith, freePort, get, post, report, startEngine, verify } from './lib/harness.mjs';

const SEED = 2024;

/** All eight seats need an action: the engine is waiting on a full round. */
function pendingSeats(status) {
  return (status.needs ?? []).map((n, i) => (n ? i : -1)).filter((i) => i >= 0);
}

async function turnStatus(port) {
  return post(port, '/api/net/steps', { steps: [] }); // cheap status probe, applies nothing
}

async function main() {
  const [p1, p2, p3] = await Promise.all([freePort(), freePort(), freePort()]);
  const engines = [];
  const started = Date.now();
  try {
    const a = await startEngine(p1);
    const b = await startEngine(p2);
    const c = await startEngine(p3);
    engines.push(a, b, c);
    console.log(`two clients on ${p1}/${p2} (third for the replay check), seed ${SEED}`);

    // ---- same start ------------------------------------------------------
    await post(p1, '/api/net/new', { seed: SEED, seat: 0 });
    await post(p2, '/api/net/new', { seed: SEED, seat: 5 }); // deliberately not seat 0
    let sa = await post(p1, '/api/net/steps', { steps: [] });
    let sb = await post(p2, '/api/net/steps', { steps: [] });
    assert(sa.turn === 0 && sa.phase === 'hero_select', 'both clients start in hero select');
    assert((await get(p1, '/api/net/hash')).hash === (await get(p2, '/api/net/hash')).hash, 'same seed => same opening state');

    // ---- drive a whole game through the relay's order --------------------
    const stream = []; // [[seat, action], ...] exactly as the relay would number it
    let turn = 0;
    let mark = await get(p1, '/api/net/hash');
    const failures = [];
    for (let guard = 0; guard < 4000; guard += 1) {
      const status = await turnStatus(p1);
      if (status.over) break;
      const seats = pendingSeats(status);
      if (seats.length === 0) break;
      // One action at a time, computed by A (a "single authoritative brain" is
      // all the relay's stream needs to be reproducible) and replayed on both.
      const seat = seats[0];
      const bot = await get(p1, `/api/net/bot?seat=${seat}`);
      if (!bot.ok) break;
      const step = [seat, bot.action];
      const ra = await post(p1, '/api/net/steps', { steps: [step] });
      const rb = await post(p2, '/api/net/steps', { steps: [step] });
      verify(ra.results[0].ok && rb.results[0].ok, `seat ${seat} action ${bot.action} on both clients`, JSON.stringify([ra.results[0], rb.results[0]]));
      stream.push(step);

      const next = await turnStatus(p1);
      if (next.turn !== turn) {
        turn = next.turn;
        const ha = await get(p1, '/api/net/hash');
        const hb = await get(p2, '/api/net/hash');
        if (ha.hash !== hb.hash) failures.push({ turn, a: ha.hash, b: hb.hash });
        if (failures.length === 0) mark = ha;
        if (turn % 3 === 0) console.log(`  round ${turn} · ${stream.length} actions · ${ha.hash}`);
      }
    }
    const done = await turnStatus(p1);
    assert(failures.length === 0, 'state hashes agree every round', failures.length ? JSON.stringify(failures.slice(0, 3)) : `last ${mark.hash}`);
    assert(done.over, 'the game reached game over');

    // ---- rebuild from the stream (page reload / reconnect) ---------------
    const replayA = await post(p3, '/api/net/new', { seed: SEED, seat: 2, replay: stream });
    const freshHash = await get(p3, '/api/net/hash');
    const realHash = await get(p1, '/api/net/hash');
    assert(freshHash.hash === realHash.hash, 'replaying the action log rebuilds the same game', `${freshHash.hash} vs ${realHash.hash}`);
    assert(replayA.game.turn === done.turn, 'replayed game is on the same round');
    const afterOver = await post(p3, '/api/net/steps', { steps: [[0, 0]] });
    assert(afterOver.results[0].skipped === 'over', 'a step after game over is skipped', JSON.stringify(afterOver.results[0]));

    // ---- order really does matter ---------------------------------------
    const order = async (steps) => {
      const port = await freePort();
      const e = await startEngine(port);
      try {
        await post(port, '/api/net/new', { seed: 777, seat: 0 });
        await post(port, '/api/net/steps', { steps: Array.from({ length: 8 }, (_, s) => [s, 30]) }); // hero select
        await post(port, '/api/net/steps', { steps });
        return (await get(port, '/api/net/hash')).hash;
      } finally {
        e.stop();
      }
    };
    const ab = await order([[0, 1], [1, 1]]);
    const ba = await order([[1, 1], [0, 1]]);
    assert(ab !== ba, 'two seats refreshing in a different order diverge (this is why seq exists)', `${ab} vs ${ba}`);

    console.log(`\nlockstep ok — ${stream.length} actions, ${done.turn} rounds, ${((Date.now() - started) / 1000).toFixed(1)}s`);
    return 0;
  } finally {
    for (const e of engines) e.stop();
  }
}

main().then(
  (code) => exitWith(code ?? 0),
  (err) => {
    console.error(err instanceof Fatal ? err.message : err);
    console.error('\nlockstep FAILED');
    exitWith(1);
  },
);
