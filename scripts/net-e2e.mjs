// End-to-end multiplayer: real browsers, one engine each, one relay.
//
// Every page runs the whole eight-player game locally, exactly like a player's
// machine would; they only agree on the *order* of actions through the relay.
// The test therefore proves the two things that matter:
//   1. eight independent simulations stay byte-identical, round after round;
//   2. a page can be reloaded mid-match and rebuild itself from the action log.
//
//   npm run build && node scripts/net-e2e.mjs              # eight humans
//   node scripts/net-e2e.mjs --humans 2 --build            # two humans + six bots
//
// Everything runs on throwaway ports; the player's game on 8787 is never touched.
import { chromium } from 'playwright-core';
import { chromePath } from './chrome.mjs';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Fatal, assert, exitWith, freePort, get, report, sleep, startEngine } from './lib/harness.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  return fallback;
};

const HUMANS = Math.max(1, Math.min(8, Number(opt('humans', 8))));
const POLL_MS = Number(opt('poll', 400));
const TIMEOUT_MS = Number(opt('timeout', 420_000));
const CHROME = chromePath();

if (!existsSync(join(ROOT, 'dist', 'index.html'))) {
  console.error('dist/ is missing — run `npm run build` first');
  process.exit(1);
}

async function build() {
  console.log('building…');
  const code = await new Promise((ok) => {
    const p = spawn(process.execPath, [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], {
      cwd: ROOT,
      stdio: 'ignore',
    });
    p.on('exit', ok);
  });
  if (code !== 0) throw new Fatal('build failed');
}

function startRelay(port, need) {
  const proc = spawn(
    process.execPath,
    [join(ROOT, 'server', 'relay.mjs'), '--port', String(port), '--need', String(need), '--hero-ms', '180000'],
    { cwd: ROOT, stdio: 'ignore' },
  );
  return { proc, stop: () => proc.kill() };
}

/** What one page thinks the world looks like. The hash is read together with
 *  the engine revision it belongs to, so two clients can be compared exactly. */
async function snapshot(page) {
  return page.evaluate(async () => {
    const w = window;
    const net = w.__bgsim.net.getState();
    const store = w.__bgsim.store.getState();
    let info = { hash: null, revision: null };
    try {
      info = await w.__bgsim.hash();
    } catch {
      info = { hash: null, revision: null };
    }
    return {
      status: net.status,
      seat: net.seat,
      room: net.room,
      seed: net.seed,
      turn: store.view?.turn ?? null,
      phase: store.view?.phase ?? null,
      appliedSeq: net.appliedSeq,
      serverSeq: net.serverSeq,
      /** The exact point in the stream the hash describes. */
      rev: info.revision ?? net.appliedSeq,
      needMe: net.needMe,
      over: net.over,
      desync: net.desync,
      rebuilding: net.rebuilding,
      hasView: Boolean(store.view),
      peers: net.peers.length,
      placement: store.view?.me?.placement ?? null,
      cap: net.captain,
      hash: info.hash,
    };
  });
}

async function main() {
  if (flag('build')) await build();

  const relayPort = await freePort();
  const relay = startRelay(relayPort, HUMANS);
  const engines = [];
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const pages = [];
  const startedAt = Date.now();
  try {
    // Wait for the relay.
    for (let i = 0; ; i += 1) {
      try {
        if ((await get(relayPort, '/net/health')).ok) break;
      } catch {
        if (i > 100) throw new Fatal('relay did not start');
        await sleep(100);
      }
    }
    const ports = await Promise.all(Array.from({ length: HUMANS }, () => freePort()));
    for (const port of ports) engines.push(await startEngine(port));
    console.log(`${HUMANS} page(s) + ${8 - HUMANS} bot(s), relay :${relayPort}, engines ${ports.join(',')}`);

    const relayUrl = `ws://127.0.0.1:${relayPort}/net`;
    for (const port of ports) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      page.on('pageerror', (e) => console.log(`  [pageerror ${port}] ${e.message}`));
      await page.goto(`http://127.0.0.1:${port}/?mode=net&bot=1&relay=${encodeURIComponent(relayUrl)}`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      pages.push({ page, port });
    }

    // ---- everyone lands in the same room --------------------------------
    let ready = false;
    for (let i = 0; i < 120 && !ready; i += 1) {
      await sleep(250);
      const snaps = [];
      for (const p of pages) snaps.push(await snapshot(p.page));
      ready = snaps.every((s) => s.status === 'playing' || s.status === 'over');
    }
    const first = await snapshot(pages[0].page);
    assert(first.status === 'playing', 'every page is in the match', first.status);
    assert(first.peers === 8, 'the room has eight seats (humans + bots)', `${first.peers}`);

    // ---- play the whole game, checking hashes as it goes ----------------
    const hashesByTurn = new Map();
    const turnsSeen = new Set();
    const hashAtSeq = new Map(); // `${seq}` -> {hash, seats}
    let lastTurn = -1;
    let reloaded = false;
    let rounds = 0;
    let over = false;
    let stalled = 0;
    let maxSeq = -1;

    while (Date.now() - startedAt < TIMEOUT_MS) {
      await sleep(POLL_MS);
      const snaps = [];
      for (const p of pages) snaps.push(await snapshot(p.page));

      // Two clients at the same point in the stream must hash to the same
      // thing. Clients at *different* points (one batch behind) are normal.
      let diverged = null;
      for (const s of snaps) {
        if (!s.hash || s.rev === null || s.rev === undefined) continue;
        const known = hashAtSeq.get(s.rev);
        if (!known) hashAtSeq.set(s.rev, { hash: s.hash, seat: s.seat });
        else if (known.hash !== s.hash) diverged = { seq: s.rev, a: known, b: s };
      }
      if (diverged) {
        const detail = snaps.map((s) => `#${s.seat + 1}@${s.rev}:${s.hash}`).join(' ');
        assert(false, `clients disagree at seq ${diverged.seq}`, detail);
      }

      const seqs = snaps.map((s) => s.rev);
      const turn = snaps[0].turn;
      if (Math.max(...seqs) === maxSeq) stalled += 1;
      else {
        stalled = 0;
        maxSeq = Math.max(...seqs);
      }
      if (stalled > 25) {
        const engineView = [];
        for (const port of ports) {
          try {
            const st = await get(port, '/api/net/status');
            engineView.push(`:${port} turn ${st.turn} need [${(st.needs ?? []).map((n, i) => (n ? i : '')).join('')}] rev ${st.revision}`);
          } catch {
            engineView.push(`:${port} unreachable`);
          }
        }
        const detail = snaps
          .map(
            (s) =>
              `#${s.seat + 1} turn ${s.turn} seq ${s.appliedSeq} need ${s.needMe} status ${s.status} view ${s.hasView} rebuild ${s.rebuilding}`,
          )
          .join(' | ');
        assert(false, 'the match stopped advancing', `${detail}\n    ${engineView.join('\n    ')}`);
      }

      // Everyone on the same round and the same seq: record the digest once.
      const sameTurn = new Set(snaps.map((s) => s.turn)).size === 1;
      const sameSeq = new Set(seqs).size === 1;
      if (sameTurn && sameSeq && turn !== null) {
        const hash = snaps[0].hash;
        // Key by round *and* stream position: the board changes during a round.
        const key = `${turn}@${seqs[0]}`;
        if (hash) {
          const known = hashesByTurn.get(key);
          if (!known) {
            hashesByTurn.set(key, hash);
            turnsSeen.add(turn);
            rounds += 1;
            if (turn % 3 === 0 && seqs[0] === maxSeq) console.log(`  round ${turn} · seq ${seqs[0]} · ${hash}`);
          } else if (known !== hash) {
            assert(false, `round ${turn} diverged between clients`, `${known} vs ${hash}`);
          }
        }
      }
      for (const s of snaps) {
        if (s.desync) assert(false, 'a client reported an action its engine rejected', s.desync);
      }

      // ---- reload one player in the middle of the match ------------------
      if (!reloaded && turn >= 3 && snaps.every((s) => s.status === 'playing')) {
        reloaded = true;
        const index = pages.length > 1 ? 1 : 0;
        const victim = pages[index];
        const before = snaps[index];
        console.log(`  reloading seat ${before.seat + 1} on round ${turn}…`);
        await victim.page.reload({ waitUntil: 'domcontentloaded' });
        // It must come back on the same seat and end up at the same state as
        // everybody else — the relay replays the whole action log for it.
        let converged = null;
        const until = Date.now() + 30000;
        while (Date.now() < until) {
          await sleep(350);
          const all = [];
          for (const p of pages) all.push(await snapshot(p.page));
          const back = all[index];
          if (back.status !== 'playing' && back.status !== 'over') continue;
          const seqs = new Set(all.map((s) => s.rev));
          const hashes = new Set(all.map((s) => s.hash));
          if (seqs.size === 1 && hashes.size === 1 && back.room === first.room) {
            converged = { all, back };
            break;
          }
        }
        assert(converged, 'a reloaded page rejoins and catches up', `round ${turn}`);
        assert(converged.back.seat === before.seat, 'the reloaded page got its old seat back', `seat ${converged.back.seat + 1}`);
        console.log(`  seat ${converged.back.seat + 1} resumed at seq ${converged.back.appliedSeq} · ${converged.back.hash}`);
      }

      if (snaps.every((s) => s.over)) {
        over = true;
        lastTurn = turn;
        break;
      }
    }

    assert(over, 'the match reached game over in every browser', `last round ${lastTurn}`);
    assert(turnsSeen.size >= 5, 'the match was a real game, not a two-round stub', `${turnsSeen.size} rounds`);
    assert(reloaded, 'a mid-match reload was exercised');

    // ---- the relay's view of the match ---------------------------------
    const health = await get(relayPort, '/net/health');
    const room = health.rooms.find((r) => r.id === first.room);
    assert(room && room.over === true, 'relay closed the room', room ? `seq ${room.seq}` : 'missing');
    assert(room && room.desync === false, 'relay never saw a desync', JSON.stringify(room?.desync));

    // ---- final standings are identical everywhere ----------------------
    // The last round's combat replay still has to play out on every board
    // (the game-over screen only appears once it has finished).
    const settleUntil = Date.now() + 20000;
    let settled = false;
    while (Date.now() < settleUntil) {
      await sleep(400);
      const all = [];
      for (const p of pages) all.push(await snapshot(p.page));
      if (all.every((s) => s.phase === 'game_over')) {
        settled = true;
        break;
      }
    }
    assert(settled, 'every board reached the standings screen', `after ${Math.round((Date.now() - startedAt) / 1000)}s`);

    const finals = [];
    for (const p of pages) finals.push(await snapshot(p.page));
    const placements = finals.map((f) => f.placement);
    assert(placements.every((p) => typeof p === 'number' && p >= 1), 'every player has a placement', JSON.stringify(placements));
    const occupancy = new Map();
    for (const pl of placements) occupancy.set(pl, (occupancy.get(pl) || 0) + 1);
    assert([...occupancy.values()].every((n) => n === 1), 'placements do not collide', JSON.stringify(placements));

    console.log(
      `\nnet e2e ok — ${turnsSeen.size} rounds, ${room?.seq ?? '?'} relayed actions, ${((Date.now() - startedAt) / 1000).toFixed(0)}s, placements ${placements.join(',')}`,
    );
    return 0;
  } finally {
    for (const p of pages) await p.page.close().catch(() => {});
    await browser.close().catch(() => {});
    for (const e of engines) e.stop();
    relay.stop();
  }
}

main().then(
  (code) => exitWith(code ?? 0),
  (err) => {
    console.error(err instanceof Fatal ? err.message : err);
    console.error('\nnet e2e FAILED');
    exitWith(1);
  },
);
