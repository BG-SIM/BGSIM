// Relay protocol test — no browser, no engine. Fake clients verify the parts of
// multiplayer that are pure coordination: matching, one global sequence,
// deadline END injection, reconnect catch-up, desync reports, and the
// client/server contract that keeps independently-updated clients compatible
// (protocol version, engine-build buckets, optional token).
//
//   node scripts/relay-test.mjs
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Fatal, assert, exitWith, freePort, get, sleep } from './lib/harness.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = { engine: '1.1.0', game: '37.0.2.256589' };

class FakeClient {
  constructor(name, caps = BUILD, hello = {}) {
    this.name = name;
    this.caps = caps;
    this.helloExtra = hello;
    this.msgs = [];
    this.seat = -1;
    this.token = '';
    this.room = null;
  }

  async open(port, { token = '', proto = 1 } = {}) {
    const query = token ? `?token=${encodeURIComponent(token)}` : '';
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/net${query}`);
    this.ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data);
      this.msgs.push(msg);
      if (msg.t === 'start') {
        this.seat = msg.seat;
        this.token = msg.token;
        this.room = msg.room;
      }
    });
    await new Promise((ok, fail) => {
      this.ws.addEventListener('open', ok, { once: true });
      this.ws.addEventListener('error', fail, { once: true });
    });
    this.send({ t: 'hello', name: this.name, proto, engine: this.caps.engine, game: this.caps.game, ...this.helloExtra });
    await this.waitFor((m) => m.t === 'welcome' || m.t === 'incompatible');
  }

  send(msg) {
    if (this.ws.readyState !== 1) return;
    this.ws.send(JSON.stringify(msg));
  }

  async waitFor(pred, ms = 5000) {
    const until = Date.now() + ms;
    for (;;) {
      const hit = this.msgs.find(pred);
      if (hit) return hit;
      if (Date.now() > until) throw new Fatal(`${this.name}: timed out waiting`);
      await sleep(20);
    }
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}

function startRelay(port, { args = [], env = {} } = {}) {
  const proc = spawn(process.execPath, [join(ROOT, 'server', 'relay.mjs'), '--port', String(port), ...args], {
    cwd: ROOT,
    stdio: 'ignore',
    env: { ...process.env, ...env },
  });
  return { proc, stop: () => proc.kill() };
}

async function waitUp(port) {
  const until = Date.now() + 15000;
  for (;;) {
    try {
      if ((await get(port, '/net/health')).ok) return;
    } catch {
      if (Date.now() > until) throw new Fatal(`relay on ${port} did not start`);
      await sleep(100);
    }
  }
}

async function main() {
  const port = await freePort();
  const relay = startRelay(port, { args: ['--need', '8', '--hero-ms', '600000'] });
  const clients = [];
  try {
    await waitUp(port);
    const health = await get(port, '/net/health');
    assert(health.ok && health.need === 8, 'relay answers /net/health', `need=${health.need}`);
    assert(health.proto === 1, 'health reports the wire protocol version', `proto ${health.proto}`);
    const healthz = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.text());
    assert(healthz.trim() === 'ok', 'a plain /healthz exists for uptime monitors', healthz.trim());

    // ---- eight players queue up ---------------------------------------
    for (let i = 0; i < 8; i += 1) {
      const c = new FakeClient(`P${i}`);
      clients.push(c);
      await c.open(port);
      c.send({ t: 'queue' });
    }
    for (const c of clients) await c.waitFor((m) => m.t === 'start', 8000);
    const starts = clients.map((c) => c.msgs.find((m) => m.t === 'start'));
    assert(
      new Set(starts.map((s) => s.seed)).size === 1 && new Set(starts.map((s) => JSON.stringify(s.config))).size === 1,
      'all eight get the same seed and config',
      `seed ${starts[0].seed}`,
    );
    assert(
      new Set(starts.map((s) => JSON.stringify(s.seats.map((x) => x.seat)))).size === 1 &&
        JSON.stringify(starts[0].seats.map((x) => x.seat)) === '[0,1,2,3,4,5,6,7]',
      'seats 0..7 assigned',
    );
    for (const c of clients) c.send({ t: 'meta', end: 0 });

    // ---- one global order ---------------------------------------------
    for (const c of clients) c.send({ t: 'turn', turn: 0, limit: 600 });
    for (const c of clients) c.send({ t: 'act', action: 30 });
    for (const c of clients) await c.waitFor((m) => m.t === 'act' && m.seat === 7);
    const seqs = (c) => c.msgs.filter((m) => m.t === 'act').map((m) => `${m.seq}:${m.seat}`);
    const reference = seqs(clients[0]).slice(0, 8).join(',');
    assert(seqs(clients[7]).slice(0, 8).join(',') === reference, 'every client sees the same seq => seat order', reference);
    assert(new Set(clients[0].msgs.filter((m) => m.t === 'act').map((m) => m.seq)).size === 8, 'seq is unique and monotonic');

    // ---- round with a deadline ----------------------------------------
    for (const c of clients) c.send({ t: 'turn', turn: 1, limit: 5 });
    const dl = await clients[0].waitFor((m) => m.t === 'deadline' && m.turn === 1);
    assert(dl.at > Date.now() - 1000, 'relay publishes a round deadline', `in ${Math.round((dl.at - Date.now()) / 1000)}s`);
    // Only six of eight end in time; the relay must end for everyone else.
    for (const c of clients.slice(0, 6)) c.send({ t: 'act', action: 0 });
    for (const c of clients) await c.waitFor((m) => m.t === 'act' && m.timeout === true, 40000);
    const late = clients[0].msgs.filter((m) => m.t === 'act' && m.timeout === true);
    assert(
      JSON.stringify(late.map((m) => m.seat).sort()) === '[6,7]',
      'relay injects END for the two who ran out of time',
      JSON.stringify(late.map((m) => m.seat)),
    );
    assert(
      late.every((m) => m.action === 0),
      'injected action is the END number the clients declared',
    );
    const progress = await clients[6].waitFor((m) => m.t === 'progress' && m.timeout);
    assert(progress.ended.length === 8, 'progress reports eight ended seats', JSON.stringify(progress.ended));

    // ---- desync report -------------------------------------------------
    clients[0].send({ t: 'hash', turn: 1, hash: 'aaaa' });
    clients[1].send({ t: 'hash', turn: 1, hash: 'bbbb' });
    const desync = await clients[0].waitFor((m) => m.t === 'desync');
    assert(desync.turn === 1 && desync.seats.length === 2, 'relay flags a state hash mismatch');

    // ---- reconnect -----------------------------------------------------
    const seq = Math.max(...clients[0].msgs.filter((m) => m.t === 'act').map((m) => m.seq));
    const dropped = clients[5];
    dropped.close();
    await sleep(150);
    for (const c of clients.slice(0, 5)) c.send({ t: 'act', action: 7 });
    await clients[0].waitFor((m) => m.t === 'act' && m.seq > seq);
    const back = new FakeClient('P5again');
    clients[5] = back;
    await back.open(port);
    back.send({ t: 'resume', room: dropped.room, token: dropped.token, lastSeq: seq });
    const sync = await back.waitFor((m) => m.t === 'sync', 8000);
    assert(sync.seat === 5 && sync.seed === starts[0].seed, 'resume hands the seat and seed back', `seat ${sync.seat}`);
    assert(sync.actions.length >= 5 && sync.actions.every((a) => a.seq > seq), 'sync replays exactly the missed actions', `${sync.actions.length} actions`);
    assert(sync.actions.at(-1).seq === sync.seq, 'sync ends at the current seq', `${sync.actions.at(-1).seq}/${sync.seq}`);

    // ---- over ----------------------------------------------------------
    clients[2].send({ t: 'over' });
    const over = await clients[0].waitFor((m) => m.t === 'over');
    assert(over.actions > 0, 'relay ends the room and reports the stream length', `${over.actions} actions`);
    const afterHealth = await get(port, '/net/health');
    assert(afterHealth.rooms[0]?.over === true, 'health shows the room is over');

    // ---- a finished room does not trap its players ---------------------
    // Everyone is free to queue again as soon as the game is over.
    for (const c of clients) c.msgs = [];
    for (const c of clients) c.send({ t: 'queue' });
    for (const c of clients) await c.waitFor((m) => m.t === 'start', 8000);
    const second = clients[0].msgs.find((m) => m.t === 'start');
    assert(second.room !== starts[0].room, 'a second match gets a fresh room and seed', second.room);
    const health2 = await get(port, '/net/health');
    assert(health2.rooms.length === 2, 'the finished room lingers for reconnects, the new one runs', `${health2.rooms.length} rooms`);

    // ---- leaving mid-match frees the seat (and the player) --------------
    clients[0].send({ t: 'leave' });
    await clients[1].waitFor((m) => m.t === 'peer' && m.seat === 0 && m.connected === false);
    assert(true, 'leaving tells the table that the seat is gone');
    const leftHealth = await get(port, '/net/health');
    const room2 = leftHealth.rooms.find((r) => r.id === second.room);
    assert(room2?.seats[0]?.connected === false, 'health shows the abandoned seat as offline');
    // …and that client can queue for yet another match instead of being stuck.
    clients[0].msgs = [];
    clients[0].send({ t: 'queue' });
    const queued = await clients[0].waitFor((m) => m.t === 'queue', 4000);
    assert(queued.n >= 1, 'the player who left can queue again', `queued ${queued.n}`);
    clients[0].send({ t: 'leave' });

    // ---- independently updated clients never share a table -------------
    // Eight clients must run the same engine build, so a client on a different
    // build is queued in its own bucket and told who it is waiting with.
    const oldBuild = { engine: '1.1.0', game: 'OLD-BUILD' };
    const newBuild = { engine: '1.1.0', game: 'NEW-BUILD' };
    const bucketA = [];
    const bucketB = [];
    for (let i = 0; i < 3; i += 1) {
      const a = new FakeClient(`old${i}`, oldBuild);
      const b = new FakeClient(`new${i}`, newBuild);
      bucketA.push(a);
      bucketB.push(b);
      await a.open(port);
      await b.open(port);
      a.send({ t: 'queue' });
      b.send({ t: 'queue' });
    }
    await sleep(300);
    const seeA = await bucketA[0].waitFor(
      (m) => m.t === 'queue' && m.n === 3 && m.others?.some((o) => o.key === '1.1.0|NEW-BUILD' && o.n === 3),
      5000,
    );
    assert(seeA.key === '1.1.0|OLD-BUILD', 'queue buckets are keyed by the engine build', seeA.key);
    assert(
      seeA.others?.some((o) => o.key === '1.1.0|NEW-BUILD' && o.n === 3),
      'a waiting client is told how many players are stuck on another build',
      JSON.stringify(seeA.others),
    );
    assert(
      !bucketA.some((c) => c.msgs.some((m) => m.t === 'start')) && !bucketB.some((c) => c.msgs.some((m) => m.t === 'start')),
      'six players on two builds do not start a mismatched table',
    );
    for (const c of [...bucketA, ...bucketB]) {
      c.send({ t: 'leave' });
      c.close();
    }

    // ---- protocol mismatch is refused, not mis-simulated ---------------
    const futuristic = new FakeClient('future', BUILD, {});
    await futuristic.open(port, { proto: 99 });
    const refused = await futuristic.waitFor((m) => m.t === 'incompatible', 4000);
    assert(refused.reason === 'proto' && refused.proto === 1, 'a protocol mismatch is refused with the server version', JSON.stringify(refused));
    futuristic.close();

    // ---- optional token gate -------------------------------------------
    const tokenPort = await freePort();
    const tokenRelay = startRelay(tokenPort, { env: { RELAY_TOKEN: 'friends-only' } });
    try {
      await waitUp(tokenPort);
      const noToken = new FakeClient('nope');
      await noToken.open(tokenPort);
      const rejected = await noToken.waitFor((m) => m.t === 'incompatible', 4000);
      assert(rejected.reason === 'token', 'a relay with RELAY_TOKEN refuses clients without it', JSON.stringify(rejected));
      noToken.close();
      const withUrlToken = new FakeClient('friend');
      await withUrlToken.open(tokenPort, { token: 'friends-only' });
      assert(withUrlToken.msgs.some((m) => m.t === 'welcome'), 'the token can travel in the connect URL');
      withUrlToken.close();
      const withHelloToken = new FakeClient('friend2', BUILD, { token: 'friends-only' });
      await withHelloToken.open(tokenPort);
      assert(withHelloToken.msgs.some((m) => m.t === 'welcome'), 'or in the hello message');
      withHelloToken.close();
    } finally {
      tokenRelay.stop();
    }

    console.log('\nrelay ok');
    return 0;
  } finally {
    for (const c of clients) c.close();
    relay.stop();
  }
}

main().then(
  (code) => exitWith(code ?? 0),
  (err) => {
    console.error(err instanceof Fatal ? err.message : err);
    console.error('\nrelay FAILED');
    exitWith(1);
  },
);
