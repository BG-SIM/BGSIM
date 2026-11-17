#!/usr/bin/env node
// BGSIM relay — the server side of multiplayer.
//
// This process is INDEPENDENT of the game client: it can be built, deployed and
// restarted on its own, on a VPS, in Docker, or on a friend's laptop. It has no
// engine, no Python, no game rules and no database.
//
// What it does:
//   * matches players from a queue into an eight-seat table;
//   * stamps every action with a global, monotonic `seq` and broadcasts the
//     stream to all eight clients (that order is the whole protocol);
//   * owns the round deadline and injects END on behalf of whoever ran out;
//   * keeps the action log so a reconnecting client can rebuild the game;
//   * compares the per-round state digests and screams if they disagree;
//   * refuses clients whose protocol or engine build would diverge.
//
// What it deliberately does not do: simulate anything, know what the actions
// mean (beyond END, which clients declare), or trust clients with anything but
// their own seat's actions.
//
//   node server/relay.mjs                      # 127.0.0.1:8790, 8 players
//   PORT=8790 HOST=0.0.0.0 node server/relay.mjs
//   RELAY_TOKEN=s3cret node server/relay.mjs   # friends-only gate
//
// Every setting can also be passed as `--name value`; CLI wins over env.
import http from 'node:http';
import { randomBytes, randomInt } from 'node:crypto';
import { WebSocketServer } from 'ws';

/* ────────────────────────────── configuration ────────────────────────────── */

const argv = process.argv.slice(2);
function arg(name) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  return undefined;
}
function setting(name, envName, fallback, { int = false, bool = false } = {}) {
  const raw = arg(name) ?? process.env[envName];
  if (raw === undefined || raw === '') return fallback;
  if (bool) return raw === '1' || raw === 'true' || raw === 'yes';
  if (int) {
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  }
  return raw;
}

const PORT = setting('port', 'PORT', 8790, { int: true });
// 0.0.0.0 for a real server (that is the point of deploying one); loopback is
// the safe default when someone just runs it next to their game.
const HOST = setting('host', 'HOST', '127.0.0.1');
const NEED = Math.max(1, Math.min(8, setting('need', 'NEED', 8, { int: true })));
const SEATS = 8;
const MAX_TURNS = setting('max-turns', 'MAX_TURNS', 60, { int: true });
const HERO_SELECT_MS = setting('hero-ms', 'HERO_SELECT_MS', 90_000, { int: true });
const ROOM_TTL_MS = setting('room-ttl', 'ROOM_TTL_MS', 300_000, { int: true });
const MAX_ROOMS = setting('max-rooms', 'MAX_ROOMS', 200, { int: true });
const MAX_CLIENTS = setting('max-clients', 'MAX_CLIENTS', 512, { int: true });
const RATE_PER_SEC = setting('rate', 'RATE_PER_SEC', 25, { int: true });
const RATE_BURST = setting('burst', 'RATE_BURST', 60, { int: true });
const TOKEN = setting('token', 'RELAY_TOKEN', '');
const VERBOSE = setting('verbose', 'RELAY_VERBOSE', false, { bool: true });

/** Wire protocol version. Bump when a message changes shape. */
const PROTO = 1;

/* ──────────────────────────────── logging ───────────────────────────────── */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const LOG_LEVEL = LEVELS[String(setting('log-level', 'LOG_LEVEL', 'info')).toLowerCase()] ?? 2;
const clock = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
function emit(level, ...args) {
  if (LEVELS[level] > LOG_LEVEL) return;
  const line = `[${clock()}] ${level.toUpperCase().padEnd(5)} ${args.join(' ')}`;
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}
const log = {
  info: (...a) => emit('info', ...a),
  warn: (...a) => emit('warn', ...a),
  error: (...a) => emit('error', ...a),
  debug: (...a) => emit('debug', ...a),
};

/* ──────────────────────────────── state ─────────────────────────────────── */

const clients = new Set();
const rooms = new Map();
/** Queue buckets, keyed by engine build — two different client builds must
 *  never share a table, or the simulations diverge on the first random roll. */
const queues = new Map();
let nextClientId = 1;
let nextRoomId = 1;

const stats = { startedAt: Date.now(), rooms: 0, actions: 0, rejected: 0, desyncs: 0 };

function bucket(key) {
  let list = queues.get(key);
  if (!list) {
    list = [];
    queues.set(key, list);
  }
  return list;
}
function queueLength() {
  let n = 0;
  for (const list of queues.values()) n += list.length;
  return n;
}

function send(ws, msg) {
  if (!ws || ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify(msg));
  } catch (err) {
    log.debug('send failed:', err.message);
  }
}
const sendClient = (client, msg) => send(client?.ws, msg);

function broadcast(room, msg, except = null) {
  for (const s of room.seats) {
    if (s.client && s.client !== except) sendClient(s.client, msg);
  }
}

/** The version key a queue/room is built around: the engine build is what the
 *  determinism proof depends on, so that is what must match. */
function buildKey(caps) {
  const engine = String(caps?.engine || '');
  const game = String(caps?.game || '');
  if (!engine && !game) return 'unknown';
  return `${engine || '?'}|${game || '?'}`;
}

function queueSnapshot(key) {
  const list = queues.get(key) ?? [];
  // Players still waiting on a *different* client build. Showing them is the
  // only honest answer to "why is nobody joining?": they are not on your build.
  const others = [...queues.entries()]
    .filter(([k, l]) => k !== key && l.length > 0)
    .map(([k, l]) => ({ key: k, n: l.length }));
  return { t: 'queue', n: list.length, need: NEED, key, names: list.map((c) => c.name), others };
}
function broadcastQueue(key) {
  for (const c of queues.get(key) ?? []) sendClient(c, queueSnapshot(key));
}
/** Every bucket hears about every change: a crowded other bucket is useful news. */
function broadcastAllQueues() {
  for (const key of queues.keys()) broadcastQueue(key);
}

function defaultConfig() {
  return {
    record_log: true,
    hero_choices: 4,
    start_gold: 3,
    gold_refill_cap: 10,
    turn_action_caps: [],
    max_turns: MAX_TURNS,
  };
}

/* ─────────────────────────────── matching ───────────────────────────────── */

function pumpQueue(key) {
  const list = bucket(key);
  while (list.length >= NEED) {
    if (rooms.size >= MAX_ROOMS) {
      log.warn(`refusing a new room: ${MAX_ROOMS} running`);
      return;
    }
    const picked = list.splice(0, NEED);
    startRoom(picked, key);
  }
  broadcastAllQueues();
}

function startRoom(players, key) {
  const seats = players.map((client, seat) => ({
    seat,
    client,
    name: client.name || `玩家${seat + 1}`,
    token: randomBytes(9).toString('hex'),
    key,
    connected: true,
    goneAt: 0,
    ended: -1,
    hashTurn: -1,
    hash: '',
    bot: false,
  }));
  for (let seat = players.length; seat < SEATS; seat += 1) {
    seats.push({
      seat,
      client: null,
      name: `电脑${seat + 1}`,
      token: '',
      key,
      connected: true, // a bot is never "disconnected"
      goneAt: 0,
      ended: -1,
      hashTurn: -1,
      hash: '',
      bot: true,
    });
  }
  const room = {
    id: `r${nextRoomId++}`,
    key,
    seed: randomInt(1, 2 ** 31 - 1),
    config: defaultConfig(),
    seats,
    seq: 0,
    actions: [],
    turn: -1,
    deadline: null,
    timer: null,
    endAction: 0,
    over: false,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    desync: false,
    captain: players.length > 0 ? 0 : null,
  };
  rooms.set(room.id, room);
  stats.rooms += 1;
  for (const s of room.seats) {
    if (!s.client) continue;
    s.client.room = room.id;
    s.client.seat = s.seat;
    s.client.token = s.token;
    s.client.inQueue = false;
  }
  const seatInfo = room.seats.map((s) => ({ seat: s.seat, name: s.name, bot: s.bot }));
  for (const s of room.seats) {
    if (!s.client) continue;
    sendClient(s.client, {
      t: 'start',
      v: PROTO,
      room: room.id,
      key,
      seed: room.seed,
      seat: s.seat,
      token: s.token,
      config: room.config,
      seats: seatInfo,
      need: NEED,
      captain: room.captain,
      botSeats: room.seats.filter((x) => x.bot).map((x) => x.seat),
    });
  }
  const humans = room.seats.filter((s) => !s.bot).length;
  log.info(
    `room ${room.id} started · key ${key} · seed ${room.seed} · ${humans} human(s)` +
      (SEATS - humans > 0 ? ` + ${SEATS - humans} bot(s)` : ''),
  );
  armDeadline(room, 0, HERO_SELECT_MS);
}

/** Lowest-seat connected human: the one responsible for the bot seats. */
function captainOf(room) {
  const human = room.seats.find((s) => !s.bot && s.connected && s.client);
  return human ? human.seat : null;
}

function refreshCaptain(room) {
  const next = captainOf(room);
  if (next === room.captain) return;
  room.captain = next;
  broadcast(room, { t: 'captain', seat: next });
  log.info(`room ${room.id}: captain is now ${next === null ? 'nobody' : `seat ${next + 1}`}`);
}

/* ─────────────────────────────── deadlines ──────────────────────────────── */

function armDeadline(room, turn, ms) {
  if (room.timer) clearTimeout(room.timer);
  room.deadline = { turn, at: Date.now() + ms, ms };
  broadcast(room, { t: 'deadline', turn, at: room.deadline.at, ms });
  room.timer = setTimeout(() => expireDeadline(room, turn), ms + 30);
}

function expireDeadline(room, turn) {
  room.timer = null;
  if (room.over || room.turn !== turn) return;
  if (turn <= 0) {
    // Hero select has no timeout action: the relay cannot pick a hero, and END
    // is not legal before one is chosen. Nag and wait instead.
    const waiting = room.seats.filter((s) => s.connected).map((s) => s.name).join(', ');
    log.warn(`room ${room.id}: still choosing heroes (${waiting || 'nobody connected'})`);
    if (room.turn === 0) armDeadline(room, 0, 30_000);
    return;
  }
  const late = room.seats.filter((s) => s.ended !== turn);
  if (late.length === 0) return;
  log.info(`room ${room.id} round ${turn}: time up, ending for seat(s) ${late.map((s) => s.seat + 1).join(',')}`);
  for (const s of late) {
    // Same stream, same seq: a timeout is indistinguishable from a click.
    s.ended = turn;
    stamp(room, s.seat, room.endAction, { timeout: true });
  }
  broadcast(room, { t: 'deadline', turn, at: 0, fired: true });
  broadcast(room, {
    t: 'progress',
    turn,
    ended: room.seats.filter((x) => x.ended === turn).map((x) => x.seat),
    timeout: true,
  });
  // If nobody reports the next round (everyone gone), try again later instead
  // of leaving the room stuck forever.
  room.timer = setTimeout(() => {
    room.timer = null;
    if (!room.over && room.turn === turn) expireDeadline(room, turn);
  }, 15_000);
}

/* ─────────────────────────────── the stream ─────────────────────────────── */

function stamp(room, seat, action, extra = {}) {
  const rec = { t: 'act', seq: ++room.seq, seat, action };
  room.actions.push({ seq: rec.seq, seat, action });
  room.lastActivity = Date.now();
  stats.actions += 1;
  broadcast(room, { ...rec, ...(extra.timeout ? { timeout: true } : {}) });
  return rec;
}

const seatOf = (room, client) => room.seats.find((s) => s.client === client);
const getRoom = (client) => (client.room ? rooms.get(client.room) ?? null : null);

function onAct(client, msg) {
  const room = getRoom(client);
  if (!room || room.over) return;
  const me = seatOf(room, client);
  if (!me) return;
  const action = Number(msg.action);
  if (!Number.isInteger(action)) return;
  // Normally a client may only act for its own seat. The captain is the one
  // exception: it drives the bot seats (a table with fewer than eight humans).
  let seat = me.seat;
  if (msg.seat !== undefined && Number(msg.seat) !== me.seat) {
    const target = room.seats[Number(msg.seat)];
    if (me.seat !== room.captain || !target || !target.bot) {
      stats.rejected += 1;
      return;
    }
    seat = target.seat;
  }
  stamp(room, seat, action);
  // The relay knows the END number (every client declares it in `meta`), so it
  // can track who is done without a second message per turn.
  if (action === room.endAction) {
    room.seats[seat].ended = room.turn;
    broadcast(room, {
      t: 'progress',
      turn: room.turn,
      ended: room.seats.filter((s) => s.ended === room.turn).map((s) => s.seat),
    });
  }
}

function onTurn(client, msg) {
  const room = getRoom(client);
  if (!room || room.over) return;
  const turn = Number(msg.turn);
  if (!Number.isFinite(turn) || turn <= room.turn) return;
  room.turn = turn;
  room.lastActivity = Date.now();
  const limit = Math.max(5, Math.min(600, Number(msg.limit) || 90));
  armDeadline(room, turn, turn <= 0 ? HERO_SELECT_MS : limit * 1000);
  log.info(`room ${room.id} round ${turn} · ${turn <= 0 ? 'hero select' : `${limit}s`}`);
}

function onEnded(client, msg) {
  const room = getRoom(client);
  if (!room || room.over) return;
  const seat = seatOf(room, client);
  if (!seat) return;
  const turn = Number(msg.turn);
  seat.ended = Number.isFinite(turn) ? turn : room.turn;
  broadcast(room, {
    t: 'progress',
    turn: seat.ended,
    ended: room.seats.filter((s) => s.ended === seat.ended).map((s) => s.seat),
  });
}

function onHash(client, msg) {
  const room = getRoom(client);
  if (!room || room.over) return;
  const seat = seatOf(room, client);
  if (!seat) return;
  const turn = Number(msg.turn);
  seat.hashTurn = turn;
  seat.hash = String(msg.hash || '');
  const same = room.seats.filter((s) => s.hashTurn === turn);
  if (same.length < 2) return;
  const values = new Set(same.map((s) => s.hash));
  if (values.size > 1 && !room.desync) {
    room.desync = true;
    stats.desyncs += 1;
    log.error(`room ${room.id} DESYNC on round ${turn}: ${same.map((s) => `#${s.seat + 1}=${s.hash}`).join(' ')}`);
    broadcast(room, { t: 'desync', turn, seats: same.map((s) => ({ seat: s.seat, hash: s.hash })) });
  }
}

function onOver(client) {
  const room = getRoom(client);
  if (!room || room.over) return;
  room.over = true;
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
  broadcast(room, { t: 'over', turn: room.turn, actions: room.seq });
  log.info(`room ${room.id} over after ${room.seq} action(s), ${Math.round((Date.now() - room.createdAt) / 1000)}s`);
  // Everyone is free to queue again; the room itself lingers briefly so a late
  // reconnect can still pull the final state.
  for (const s of room.seats) {
    if (s.client) s.client.room = null;
  }
  setTimeout(() => {
    if (rooms.get(room.id) === room) {
      rooms.delete(room.id);
      log.info(`room ${room.id} closed`);
    }
  }, ROOM_TTL_MS).unref();
}

/* ─────────────────────────────── reconnect ──────────────────────────────── */

function onResume(client, msg) {
  const room = rooms.get(String(msg.room));
  if (!room) {
    sendClient(client, { t: 'gone', room: msg.room });
    return;
  }
  const seat = room.seats.find((s) => s.token === msg.token);
  if (!seat) {
    sendClient(client, { t: 'gone', room: msg.room, reason: 'token' });
    return;
  }
  // Same seat, different engine build (client was updated mid-match): the
  // replay would silently diverge, so refuse it instead. A client that could
  // not report its build is let through — the round digests still catch drift.
  if (client.key !== 'unknown' && seat.key !== client.key) {
    sendClient(client, { t: 'gone', room: room.id, reason: 'version', room_key: seat.key, client_key: client.key });
    return;
  }
  if (client.key === 'unknown') log.warn(`room ${room.id}: seat ${seat.seat + 1} resumed without a build key`);
  // Detach whoever held the seat (a zombie socket, a second tab).
  if (seat.client && seat.client !== client) {
    const old = seat.client;
    old.room = null;
    old.seat = -1;
    sendClient(old, { t: 'replaced', room: room.id });
    old.ws.close(4001, 'replaced');
  }
  seat.client = client;
  seat.connected = true;
  seat.goneAt = 0;
  client.room = room.id;
  client.seat = seat.seat;
  client.token = seat.token;
  const from = Math.max(0, Math.min(room.seq, Number(msg.lastSeq) || 0));
  sendClient(client, {
    t: 'sync',
    v: PROTO,
    room: room.id,
    key: room.key,
    seed: room.seed,
    seat: seat.seat,
    config: room.config,
    seats: room.seats.map((s) => ({ seat: s.seat, name: s.name, bot: s.bot })),
    need: NEED,
    captain: room.captain,
    botSeats: room.seats.filter((x) => x.bot).map((x) => x.seat),
    seq: room.seq,
    from,
    actions: room.actions.filter((a) => a.seq > from),
    turn: room.turn,
    deadline: room.deadline,
    over: room.over,
  });
  broadcast(room, { t: 'peer', seat: seat.seat, connected: true, name: seat.name }, client);
  refreshCaptain(room);
  log.info(`room ${room.id}: seat ${seat.seat + 1} resumed at seq ${from}/${room.seq}`);
}

/* ──────────────────────────────── protocol ──────────────────────────────── */

function tokenOk(client, msg) {
  if (!TOKEN) return true;
  const fromUrl = client.urlToken;
  const fromHello = typeof msg.token === 'string' ? msg.token : '';
  return fromUrl === TOKEN || fromHello === TOKEN;
}

function onMessage(client, raw) {
  if (!client.hello && raw.length > 4096) {
    client.ws.close(4009, 'hello first');
    return;
  }
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (!msg || typeof msg.t !== 'string') return;
  if (!client.hello && msg.t !== 'hello' && msg.t !== 'ping') {
    sendClient(client, { t: 'error', error: 'send hello first' });
    return;
  }
  switch (msg.t) {
    case 'hello': {
      if (!tokenOk(client, msg)) {
        stats.rejected += 1;
        sendClient(client, { t: 'incompatible', reason: 'token' });
        client.ws.close(4003, 'token');
        return;
      }
      if (Number(msg.proto ?? PROTO) !== PROTO) {
        stats.rejected += 1;
        sendClient(client, { t: 'incompatible', reason: 'proto', proto: PROTO, you: msg.proto ?? null });
        client.ws.close(4002, 'protocol');
        return;
      }
      client.hello = true;
      client.name = String(msg.name || '').slice(0, 16) || `玩家${client.id}`;
      client.caps = { engine: msg.engine || '', game: msg.game || '' };
      client.key = buildKey(client.caps);
      sendClient(client, {
        t: 'welcome',
        v: PROTO,
        id: client.id,
        need: NEED,
        key: client.key,
        caps: client.caps,
        maxSeats: SEATS,
      });
      break;
    }
    case 'queue': {
      if (client.room) return;
      if (!client.inQueue) {
        client.inQueue = true;
        bucket(client.key ?? 'unknown').push(client);
      }
      broadcastAllQueues();
      pumpQueue(client.key ?? 'unknown');
      break;
    }
    case 'leave': {
      if (client.inQueue) {
        client.inQueue = false;
        const list = queues.get(client.key ?? 'unknown');
        if (list) {
          const i = list.indexOf(client);
          if (i >= 0) list.splice(i, 1);
        }
        broadcastAllQueues();
      }
      // Leaving a room frees the seat immediately: the round clock keeps the
      // match moving, and this client is allowed to queue for a new one.
      const room = getRoom(client);
      if (room) {
        const seat = seatOf(room, client);
        if (seat) {
          seat.connected = false;
          seat.goneAt = Date.now();
          seat.client = null;
          broadcast(room, { t: 'peer', seat: seat.seat, connected: false, name: seat.name }, client);
          refreshCaptain(room);
          log.info(`room ${room.id}: seat ${seat.seat + 1} left (${seat.name})`);
        }
        client.room = null;
        sendClient(client, { t: 'left', room: room.id });
      }
      break;
    }
    case 'meta': {
      const room = getRoom(client);
      if (room && msg.end !== undefined) room.endAction = Number(msg.end) || 0;
      break;
    }
    case 'act':
      onAct(client, msg);
      break;
    case 'turn':
      onTurn(client, msg);
      break;
    case 'ended':
      onEnded(client, msg);
      break;
    case 'hash':
      onHash(client, msg);
      break;
    case 'over':
      onOver(client);
      break;
    case 'resume':
      onResume(client, msg);
      break;
    case 'ping':
      sendClient(client, { t: 'pong', at: msg.at ?? null, now: Date.now() });
      break;
    default:
      log.debug('unknown message:', msg.t);
  }
}

function onClose(client) {
  clients.delete(client);
  if (client.inQueue) {
    client.inQueue = false;
    const list = queues.get(client.key ?? 'unknown');
    if (list) {
      const i = list.indexOf(client);
      if (i >= 0) list.splice(i, 1);
    }
    broadcastAllQueues();
  }
  const room = getRoom(client);
  if (!room) return;
  const seat = seatOf(room, client);
  if (!seat) return;
  seat.connected = false;
  seat.goneAt = Date.now();
  seat.client = null;
  client.room = null;
  broadcast(room, { t: 'peer', seat: seat.seat, connected: false, name: seat.name }, client);
  refreshCaptain(room);
  log.info(`room ${room.id}: seat ${seat.seat + 1} disconnected (seat kept for a reconnect)`);
}

/* ───────────────────────────────── http ─────────────────────────────────── */

function health() {
  return {
    ok: true,
    service: 'bgsim-relay',
    proto: PROTO,
    now: Date.now(),
    uptime: Math.round(process.uptime()),
    need: NEED,
    seats: SEATS,
    maxRooms: MAX_ROOMS,
    clients: clients.size,
    queued: queueLength(),
    queues: [...queues.entries()]
      .filter(([, list]) => list.length > 0)
      .map(([key, list]) => ({ key, queued: list.length })),
    stats: { ...stats, startedAt: new Date(stats.startedAt).toISOString() },
    rooms: [...rooms.values()].map((r) => ({
      id: r.id,
      key: r.key,
      turn: r.turn,
      seq: r.seq,
      over: r.over,
      desync: r.desync,
      seconds: Math.round((Date.now() - r.createdAt) / 1000),
      seats: r.seats.map((s) => ({ seat: s.seat, name: s.name, bot: s.bot, connected: s.connected })),
    })),
  };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const path = url.pathname;
  if (path === '/healthz' || path === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('ok\n');
    return;
  }
  if (path === '/net/health' || path === '/api/net/health' || path === '/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(health()));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('BGSIM relay: WebSocket at /net, health at /healthz.\n');
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', 'http://localhost');
  // Accept /net (the documented path) and / (a bare host) — anything else is a
  // misconfigured URL and should fail loudly rather than silently attach.
  if (url.pathname !== '/net' && url.pathname !== '/') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws, req) => {
  if (clients.size >= MAX_CLIENTS) {
    ws.close(1013, 'server full');
    return;
  }
  const url = new URL(req.url || '/', 'http://localhost');
  const client = {
    id: nextClientId++,
    ws,
    name: '',
    urlToken: url.searchParams.get('token') || '',
    hello: false,
    caps: null,
    key: 'unknown',
    room: null,
    seat: -1,
    token: '',
    inQueue: false,
    // Token bucket: a player is a human clicking buttons, not a botnet.
    tokens: RATE_BURST,
    lastRefill: Date.now(),
  };
  clients.add(client);
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });
  ws.on('message', (raw) => {
    ws.isAlive = true;
    const now = Date.now();
    client.tokens = Math.min(RATE_BURST, client.tokens + ((now - client.lastRefill) / 1000) * RATE_PER_SEC);
    client.lastRefill = now;
    if (client.tokens < 1) {
      stats.rejected += 1;
      log.warn(`client ${client.id} flooding, closing`);
      ws.close(4008, 'slow down');
      return;
    }
    client.tokens -= 1;
    onMessage(client, raw.toString());
  });
  ws.on('close', () => onClose(client));
  ws.on('error', () => onClose(client));
  log.debug(`client ${client.id} connected (${clients.size} total)`);
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      /* socket already gone */
    }
  }
}, 20_000);
heartbeat.unref();

// Rooms whose players all vanished eventually stop being worth keeping.
setInterval(() => {
  const now = Date.now();
  for (const room of [...rooms.values()]) {
    const live = room.seats.some((s) => s.connected);
    if (!live && now - room.lastActivity > ROOM_TTL_MS) {
      if (room.timer) clearTimeout(room.timer);
      rooms.delete(room.id);
      log.info(`room ${room.id} dropped (empty)`);
    }
  }
}, 30_000).unref();

server.listen(PORT, HOST, () => {
  log.info(
    `BGSIM relay ready on ws://${HOST}:${PORT}/net · proto ${PROTO} · need ${NEED}/8` +
      (TOKEN ? ' · token required' : ''),
  );
  log.info(`health: http://${HOST}:${PORT}/healthz`);
});

let closing = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (closing) return;
    closing = true;
    log.info('shutting down (closing sockets)');
    for (const ws of wss.clients) {
      try {
        ws.close(1001, 'relay restarting');
      } catch {
        /* already gone */
      }
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
