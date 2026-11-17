import { create } from 'zustand';
import { api } from '../api';
import { turnLimit } from '../lib/turnClock';
import type { GameView, NetSeatInfo, RelayMessage, StateResponse } from '../types';

/**
 * Multiplayer client.
 *
 * The relay never simulates anything: it numbers actions and shouts them at
 * eight browsers. Each browser owns a full copy of the game and applies that one
 * ordered stream, which is why every client ends up byte-identical
 * (scripts/lockstep-test.mjs proves it). This module is the part that keeps the
 * local engine in step with the stream and never applies an action twice.
 */

export type NetStatus = 'idle' | 'connecting' | 'online' | 'queue' | 'starting' | 'playing' | 'over' | 'error';

export interface NetPeer extends NetSeatInfo {
  connected: boolean;
  bot?: boolean;
}

export interface NetDeadline {
  turn: number;
  at: number;
  ms: number;
}

interface NetState {
  status: NetStatus;
  error: string | null;
  /** Players waiting in the lobby and how many make a game. */
  queued: number;
  need: number;
  inQueue: boolean;
  name: string;
  relay: string;
  /** Protocol version the server spoke, and the engine build it groups by. */
  proto: number | null;
  serverKey: string | null;
  /** This client's own engine build key (`engine|game`). */
  localKey: string;
  /** Round-trip time of the last ping, in ms. */
  latency: number | null;
  /** Players queued on a *different* client build (they can never share a table). */
  otherQueues: { key: string; n: number }[];
  /** Set once matched. */
  seat: number;
  room: string | null;
  seed: number | null;
  peers: NetPeer[];
  /** Last action applied locally / last action the relay announced. */
  appliedSeq: number;
  serverSeq: number;
  /** Seats played by the engine's bot (fewer than eight humans at the table). */
  botSeats: number[];
  /** Lowest connected human: it drives the bot seats. */
  captain: number | null;
  deadline: NetDeadline | null;
  endedSeats: number[];
  /** The engine is waiting on *this* player right now. */
  needMe: boolean;
  over: boolean;
  desync: string | null;
  /** Rebuilding the local engine from the action log (reconnect / reload). */
  rebuilding: boolean;
  /** Drop-in takeover: play the current seat automatically. */
  autoBot: boolean;
  /** A match can be rejoined after a reload (stored in sessionStorage). */
  resumable: boolean;
  /** When the current match was made (drives the match-made splash). */
  matchedAt: number;
}

/** What the store lends us; set by `initNet` so this module never imports it. */
interface NetHost {
  absorbNet: (res: StateResponse) => void;
  setScreen: (screen: 'home' | 'single' | 'net') => void;
  setMode: (mode: 'solo' | 'net') => void;
  toast: (text: string, kind?: 'info' | 'error' | 'success') => void;
  /** Is the view currently showing the final standings? */
  phaseIsGameOver: () => boolean;
  /** This client's engine build — the server must match it to the millisecond
   *  of a build, or the eight simulations drift apart on the first random roll. */
  caps: () => { engine: string; game: string };
}

let host: NetHost | null = null;

export function initNet(h: NetHost): void {
  host = h;
}

const NAME_KEY = 'bgsim.net.name';
const RELAY_KEY = 'bgsim.relay';
const SESSION_KEY = 'bgsim.net.session';
const CLIENT_KEY = 'bgsim.net.client';

/**
 * A stable id for *this tab*. One engine process holds a seat per client, so
 * two tabs on one machine are two players instead of fighting over one seat
 * (that fight used to look like "I picked my hero and his hero screen
 * appeared"). It lives in sessionStorage on purpose: one tab == one player, and
 * a reload of that tab keeps its slot.
 */
const CLIENT_ID = (() => {
  const stored = (() => {
    try {
      return sessionStorage.getItem(CLIENT_KEY);
    } catch {
      return null;
    }
  })();
  if (stored) return stored;
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    sessionStorage.setItem(CLIENT_KEY, id);
  } catch {
    /* private mode: the id only has to be unique for this session anyway */
  }
  return id;
})();

/** Relay baked in at build time — the deployed client's default. */
const BUILD_RELAY = String((import.meta.env as Record<string, unknown>).VITE_RELAY_URL ?? '').trim();

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
}
function readSession(): StoredSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as StoredSession) : null;
  } catch {
    return null;
  }
}
function writeSession(s: StoredSession | null): void {
  try {
    if (s) sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* private mode */
  }
}

interface StoredSession {
  room: string;
  token: string;
  seat: number;
  seed: number;
  config: Record<string, unknown>;
  seats: NetSeatInfo[];
  captain?: number | null;
  botSeats?: number[];
}

export function defaultName(): string {
  const stored = read(NAME_KEY);
  if (stored) return stored;
  const n = `玩家${Math.floor(Math.random() * 900 + 100)}`;
  write(NAME_KEY, n);
  return n;
}

/** Where the relay lives: `?relay=` → saved → baked in at build → same origin. */
export function relayUrl(): string {
  const q = new URLSearchParams(window.location.search).get('relay');
  if (q) return normalizeRelayUrl(q) || q;
  const saved = read(RELAY_KEY);
  if (saved) return saved;
  if (BUILD_RELAY) return normalizeRelayUrl(BUILD_RELAY) || BUILD_RELAY;
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/net`;
}

/** The URL the packaged client would use with no saved override. */
export function defaultRelayUrl(): string {
  if (BUILD_RELAY) return normalizeRelayUrl(BUILD_RELAY) || BUILD_RELAY;
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/net`;
}

const LOCAL_HOST = /^(localhost|127\.|\[::1\]|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i;

/**
 * Accepts what people actually type: `bg.example.com`, `bg.example.com:8790`,
 * `ws://host:8790`, `wss://host/net?token=…`. A bare public host becomes `wss`
 * (it is going over the internet), a bare LAN/loopback host becomes `ws`.
 */
export function normalizeRelayUrl(input: string): string {
  const raw = String(input || '').trim();
  if (!raw) return '';
  let url = raw;
  if (!/^wss?:\/\//i.test(url)) {
    const host = url.split(/[/?#]/)[0];
    url = `${LOCAL_HOST.test(host) ? 'ws' : 'wss'}://${url}`;
  }
  try {
    const u = new URL(url);
    if (!u.pathname || u.pathname === '/') u.pathname = '/net';
    u.pathname = u.pathname.replace(/\/$/, '');
    return u.toString();
  } catch {
    return '';
  }
}

/** True inside the Tauri shell (the page is served by the local engine, which
 *  has no relay proxy — the relay address must be absolute there). */
export function isPackagedApp(): boolean {
  const w = window as unknown as Record<string, unknown>;
  return Boolean(w.__TAURI_INTERNALS__) || window.location.protocol === 'tauri:' || window.location.hostname === 'tauri.localhost';
}

export function setRelayUrl(url: string): void {
  const clean = normalizeRelayUrl(url);
  if (clean) write(RELAY_KEY, clean);
  else {
    try {
      localStorage.removeItem(RELAY_KEY);
    } catch {
      /* private mode */
    }
  }
  set({ relay: clean || defaultRelayUrl() });
}

export function resetRelayUrl(): void {
  try {
    localStorage.removeItem(RELAY_KEY);
  } catch {
    /* private mode */
  }
  set({ relay: defaultRelayUrl() });
}

/* ─────────────────────────────── UI state ─────────────────────────────── */

export const useNet = create<NetState>(() => ({
  status: 'idle',
  error: null,
  queued: 0,
  need: 8,
  inQueue: false,
  name: defaultName(),
  relay: relayUrl(),
  proto: null,
  serverKey: null,
  localKey: '',
  latency: null,
  otherQueues: [],
  seat: 0,
  room: null,
  seed: null,
  peers: [],
  appliedSeq: 0,
  serverSeq: 0,
  botSeats: [],
  captain: null,
  deadline: null,
  endedSeats: [],
  needMe: false,
  over: false,
  desync: null,
  rebuilding: false,
  autoBot: false,
  resumable: Boolean(readSession()),
  matchedAt: 0,
}));

const set = (patch: Partial<NetState>) => useNet.setState(patch);
const patch = (fn: (s: NetState) => Partial<NetState>) => useNet.setState(fn);

/* ───────────────────────────── session plumbing ───────────────────────────── */

let ws: WebSocket | null = null;
let session: StoredSession | null = null;
/** Engine built for the current match and ready to take actions. */
let ready = false;
let mySeat = 0;
let applied = 0;
let incoming: { seq: number; seat: number; action: number }[] = [];
let pumping = false;
let inflight: { action: number; seq: number | null; resolve: () => void; reject: (e: Error) => void; timer: number } | null =
  null;
let viewTurn = -1;
let reportedTurn = -1;
let prevNeedMe = false;
let autoTimer: number | null = null;
let reconnectTimer: number | null = null;
let reconnectDelay = 500;
let wantGame = false; // the user intends to be in a match (drives auto-resume)
let pingTimer: number | null = null;

function socketOpen(): boolean {
  return ws !== null && ws.readyState === WebSocket.OPEN;
}

function send(msg: Record<string, unknown>): boolean {
  if (!socketOpen()) return false;
  try {
    ws!.send(JSON.stringify(msg));
    return true;
  } catch {
    return false;
  }
}

function stopPing(): void {
  if (pingTimer !== null) window.clearInterval(pingTimer);
  pingTimer = null;
}

function startPing(): void {
  stopPing();
  pingTimer = window.setInterval(() => send({ t: 'ping', at: Date.now() }), 20_000);
}

/** The engine build is part of the handshake (the server buckets the queue by
 *  it), so never say hello before we know it. Ask the engine directly: the
 *  catalog is big and may still be loading right after a page load, and an
 *  empty build key would put this player in a phantom queue bucket where nobody
 *  can ever match them. */
async function localCaps(): Promise<{ engine: string; game: string }> {
  for (let i = 0; i < 50; i += 1) {
    try {
      const health = await api.health();
      if (health.engine && health.game) return { engine: health.engine, game: health.game };
    } catch {
      /* engine still starting */
    }
    const cached = host?.caps?.() ?? { engine: '', game: '' };
    if (cached.engine && cached.game) return cached;
    await new Promise((r) => window.setTimeout(r, 200));
  }
  const cached = host?.caps?.() ?? { engine: '', game: '' };
  return cached;
}

/** Connect (idempotent) and resolve once the relay said hello. */
export async function connect(): Promise<void> {
  if (socketOpen()) return;
  if (ws && ws.readyState === WebSocket.CONNECTING) {
    await new Promise<void>((resolve, reject) => {
      const t = window.setTimeout(() => reject(new Error('连接联机服务器超时')), 8000);
      ws!.addEventListener('open', () => {
        window.clearTimeout(t);
        resolve();
      });
      ws!.addEventListener('error', () => {
        window.clearTimeout(t);
        reject(new Error('无法连接联机服务器'));
      });
    });
    return;
  }
  const url = relayUrl();
  set({ status: 'connecting', error: null, relay: url });
  const caps = await localCaps();
  if (!caps.engine || !caps.game) {
    // Queueing without a build key would silently land in a bucket nobody else
    // can ever join (the server matches on `engine|game`).
    const text = '本机引擎还没就绪，稍等一下再排队';
    set({ status: 'error', error: text });
    host?.toast(text, 'error');
    throw new Error(text);
  }
  set({ localKey: `${caps.engine}|${caps.game}` });
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };
    const timer = window.setTimeout(() => done(new Error('连接联机服务器超时')), 8000);
    let sock: WebSocket;
    try {
      sock = new WebSocket(url);
    } catch {
      done(new Error(`联机地址无效：${url}`));
      return;
    }
    ws = sock;
    sock.addEventListener('open', () => {
      sock.send(
        JSON.stringify({
          t: 'hello',
          proto: 1,
          name: useNet.getState().name,
          // The engine build has to match or the eight simulations drift apart
          // on the first random roll — the server buckets the queue by it.
          engine: caps.engine,
          game: caps.game,
        }),
      );
      startPing();
      // One ping right away so the lobby can show a latency number.
      sock.send(JSON.stringify({ t: 'ping', at: Date.now() }));
    });
    sock.addEventListener('message', (ev) => {
      let msg: RelayMessage;
      try {
        msg = JSON.parse(String(ev.data)) as RelayMessage;
      } catch {
        return;
      }
      if (msg.t === 'welcome') {
        set({ status: 'online', need: msg.need, proto: msg.v, serverKey: msg.key ?? null });
        reconnectDelay = 500;
        done();
        return;
      }
      if (msg.t === 'incompatible') {
        // The server speaks a different protocol / wants a token; nothing this
        // client can do by retrying.
        const text =
          msg.reason === 'token'
            ? '服务器需要口令：把联机地址写成 wss://…/net?token=… 再试'
            : `客户端与服务端的协议不匹配（服务器 v${msg.proto ?? '?'}，客户端 v${msg.you ?? 1}），请更新客户端`;
        set({ status: 'error', error: text, inQueue: false });
        host?.toast(text, 'error');
        wantGame = false;
        try {
          sock.close();
        } catch {
          /* already gone */
        }
        done(new Error(text));
        return;
      }
      void onMessage(msg);
    });
    sock.addEventListener('close', () => {
      if (ws === sock) ws = null;
      stopPing();
      // A socket can die without a frame (sleep, wifi, proxy): never fake
      // "connected", always try to rebuild the seat.
      if (wantGame && session) {
        set({ status: 'connecting', error: '与联机服务器断开，正在重连…' });
        scheduleReconnect();
      } else if (useNet.getState().status !== 'idle') {
        set({ status: 'error', error: '与联机服务器的连接已断开' });
      }
      done(new Error('连接已断开'));
    });
    sock.addEventListener('error', () => {
      // Same-origin `/net` only exists behind the dev server: a build served
      // straight from the engine has no relay proxy, so say what to do.
      const sameOrigin = url.startsWith(`${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`);
      done(
        new Error(
          sameOrigin
            ? `这台机器上没有联机服务（${url}）。先运行 npm run relay，或在下面填中继地址。`
            : `无法连接联机服务器（${url}）`,
        ),
      );
    });
    sock.addEventListener('close', () => {
      if (ws === sock) ws = null;
      stopPing();
      // A socket can die without a frame (sleep, wifi, proxy): never fake
      // "connected", always try to rebuild the seat.
      if (wantGame && session) {
        set({ status: 'connecting', error: '与联机服务器断开，正在重连…' });
        scheduleReconnect();
      } else if (useNet.getState().status !== 'idle') {
        set({ status: 'error', error: '与联机服务器的连接已断开' });
      }
      done(new Error('连接已断开'));
    });
  });
}

function scheduleReconnect(): void {
  if (reconnectTimer !== null) return;
  reconnectTimer = window.setTimeout(async () => {
    reconnectTimer = null;
    if (!wantGame || !session) return;
    try {
      await connect();
      send({ t: 'resume', room: session.room, token: session.token, lastSeq: 0 });
    } catch {
      reconnectDelay = Math.min(8000, reconnectDelay * 2);
      scheduleReconnect();
    }
  }, reconnectDelay);
}

/* ───────────────────────────── lobby actions ───────────────────────────── */

export async function enqueue(): Promise<void> {
  // Never silently park a running match behind a new queue.
  if (useNet.getState().status === 'playing' && !useNet.getState().over) {
    host?.toast('这局还在打，先离开才能重新排队', 'error');
    return;
  }
  // Queueing *is* the lobby: show it even if the relay then refuses, because
  // that screen is where the relay address lives.
  host?.setScreen('net');
  set({ error: null, autoBot: false });
  try {
    await connect();
  } catch (err) {
    set({ status: 'error', error: err instanceof Error ? err.message : String(err) });
    return;
  }
  wantGame = false;
  send({ t: 'queue' });
  set({ status: 'queue', inQueue: true });
}

export function cancelQueue(): void {
  send({ t: 'leave' });
  set({ status: 'online', inQueue: false, queued: 0 });
}

/** Leave a running match for good (the seat stays open on the relay until it
 *  times out, but this browser forgets it). */
export function abandonGame(): void {
  wantGame = false;
  session = null;
  writeSession(null);
  ready = false;
  incoming = [];
  stopSafety();
  if (inflight) {
    window.clearTimeout(inflight.timer);
    inflight.reject(new Error('已离开对局'));
    inflight = null;
  }
  send({ t: 'leave' });
  set({
    status: 'online',
    inQueue: false,
    room: null,
    seed: null,
    peers: [],
    needMe: false,
    over: false,
    deadline: null,
    endedSeats: [],
    desync: null,
    resumable: false,
    matchedAt: 0,
  });
}

export function setName(name: string): void {
  const clean = name.slice(0, 16);
  write(NAME_KEY, clean);
  set({ name: clean });
  if (socketOpen()) send({ t: 'hello', name: clean, version: 'bgsim/1' });
}

export function setAutoBot(on: boolean): void {
  set({ autoBot: on });
  if (on) kickAuto();
}

/** Continue a match this browser was in before a reload / crash. */
export async function resumeGame(): Promise<void> {
  const stored = readSession();
  if (!stored) {
    set({ resumable: false });
    return;
  }
  session = stored;
  wantGame = true;
  host?.setScreen('net');
  set({ error: null, rebuilding: true });
  try {
    await connect();
  } catch (err) {
    set({ status: 'error', error: err instanceof Error ? err.message : String(err), rebuilding: false });
    return;
  }
  send({ t: 'resume', room: stored.room, token: stored.token, lastSeq: 0 });
}

/* ───────────────────────────── wire messages ───────────────────────────── */

async function onMessage(msg: RelayMessage): Promise<void> {
  switch (msg.t) {
    case 'queue':
      set({
        queued: msg.n,
        need: msg.need,
        inQueue: msg.names.includes(useNet.getState().name) || useNet.getState().inQueue,
        otherQueues: msg.others ?? [],
      });
      break;
    case 'start':
      await beginMatch({
        room: msg.room,
        token: msg.token,
        seat: msg.seat,
        seed: msg.seed,
        config: msg.config,
        seats: msg.seats,
        captain: msg.captain,
        botSeats: msg.botSeats,
      });
      set({ need: msg.need });
      break;
    case 'sync':
      // Reconnect: the relay hands the whole ordered log back, so the local
      // engine is rebuilt from scratch — always identical, never half-applied.
      await beginMatch(
        {
          room: msg.room,
          token: session?.token ?? '',
          seat: msg.seat,
          seed: msg.seed,
          config: msg.config,
          seats: msg.seats,
          captain: msg.captain,
          botSeats: msg.botSeats,
        },
        { actions: msg.actions, seq: msg.seq, deadline: msg.deadline, over: msg.over },
      );
      set({ need: msg.need });
      break;
    case 'act':
      pushAction(msg.seq, msg.seat, msg.action);
      break;
    case 'captain':
      set({ captain: msg.seat });
      driveBots();
      break;
    case 'deadline':
      if (msg.at === 0) set({ deadline: { turn: msg.turn, at: 0, ms: 0 } });
      else set({ deadline: { turn: msg.turn, at: msg.at, ms: msg.ms ?? msg.at - Date.now() } });
      break;
    case 'progress':
      set({ endedSeats: msg.ended });
      break;
    case 'peer':
      patch((s) => ({
        peers: s.peers.map((p) => (p.seat === msg.seat ? { ...p, connected: msg.connected, name: msg.name || p.name } : p)),
      }));
      break;
    case 'desync':
      set({ desync: `第 ${msg.turn} 回合状态不一致：${msg.seats.map((s) => `#${s.seat + 1} ${s.hash}`).join(' / ')}` });
      host?.toast('检测到状态不同步，本局结果可能不可信', 'error');
      break;
    case 'over':
      set({ over: true, status: 'over', serverSeq: msg.actions, needMe: false });
      wantGame = false;
      // Another client finished first: our engine may still be catching up on
      // the last few actions, so pull the final view once it has them.
      if (ready) void refreshView(true);
      break;
    case 'pong':
      // `at` is the timestamp we sent; the difference is the real round trip.
      if (typeof msg.at === 'number' && msg.at > 0) set({ latency: Math.max(0, Date.now() - msg.at) });
      break;
    case 'gone':
      session = null;
      writeSession(null);
      wantGame = false;
      ready = false;
      set({
        status: 'online',
        resumable: false,
        room: null,
        needMe: false,
        error:
          msg.reason === 'version'
            ? `这局是用另一个客户端版本开的（服务器记的是 ${msg.room_key ?? '?'}，你的是 ${msg.client_key ?? '?'}），换回旧版本或等下一局`
            : '这局已经结束了',
      });
      break;
    case 'replaced':
      session = null;
      writeSession(null);
      wantGame = false;
      set({ status: 'online', resumable: false, error: '这个座位已在另一个窗口里打开', room: null });
      break;
    default:
      break;
  }
}

async function beginMatch(
  info: StoredSession,
  tail?: {
    actions: { seq: number; seat: number; action: number }[];
    seq: number;
    deadline: { turn: number; at: number; ms?: number } | null;
    over: boolean;
  },
): Promise<void> {
  session = info;
  writeSession(info);
  wantGame = true;
  mySeat = info.seat;
  applied = 0;
  viewTurn = -1;
  prevNeedMe = false;
  incoming = [];
  ready = false;
  set({
    status: 'starting',
    room: info.room,
    seed: info.seed,
    seat: info.seat,
    peers: info.seats.map((s) => ({ ...s, connected: true })),
    appliedSeq: 0,
    serverSeq: tail?.seq ?? 0,
    deadline: tail?.deadline
      ? { turn: tail.deadline.turn, at: tail.deadline.at, ms: tail.deadline.ms ?? Math.max(0, tail.deadline.at - Date.now()) }
      : null,
    endedSeats: [],
    needMe: false,
    over: false,
    desync: null,
    botSeats: info.botSeats ?? [],
    captain: info.captain ?? null,
    rebuilding: Boolean(tail && tail.actions.length > 0),
    resumable: true,
    matchedAt: tail ? 0 : Date.now(),
    error: null,
  });
  host?.setMode('net');
  host?.setScreen('net');
  send({ t: 'meta', end: 0 });

  const replay = tail ? (tail.actions.map((a) => [a.seat, a.action]) as [number, number][]) : [];
  try {
    const res = await api.netNew({ client: CLIENT_ID, seed: info.seed, seat: info.seat, config: info.config, replay, combats: false });
    viewTurn = res.game?.turn ?? -1;
    host?.absorbNet(res);
    applied = tail ? tail.seq : 0;
    ready = true;
    lastNeeds = res.net?.needs ?? [];
    botBusy = false;
    botSeq = null;
    // A rebuilt client is already at the current round; do not re-report old
    // boundaries (the others reported them long ago).
    lastBoundaryTurn = res.net?.turn ?? -1;
    // The engine already knows whether it is waiting on us (hero select needs
    // all eight seats at once, so nothing else would ever tell this client it
    // is its turn).
    const mine = Boolean(res.net?.needs?.[info.seat]);
    prevNeedMe = mine;
    set({ status: 'playing', rebuilding: false, appliedSeq: applied, needMe: mine, over: Boolean(res.net?.over) });
    if (res.game) reportTurn(res.game.turn);
    if (tail?.over) set({ over: true, status: 'over' });
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    set({ status: 'error', error: `无法在本机建立这局游戏：${text}`, rebuilding: false });
    host?.toast(`无法在本机建立这局游戏：${text}`, 'error');
    return;
  }
  if (tail) {
    // Anything the relay announced while we were rebuilding still has to land.
    for (const a of tail.actions) {
      if (a.seq > applied) incoming.push({ seq: a.seq, seat: a.seat, action: a.action });
    }
  }
  startSafety();
  void pump();
  kickAuto();
  driveBots();
}

/* ───────────────────────────── the action stream ───────────────────────────── */

/** Which seats the engine is waiting on, as of the last applied batch. */
let lastNeeds: boolean[] = [];
let botBusy = false;
let botSeq: number | null = null;
let lastBoundaryTurn = -1;

function pushAction(seq: number, seat: number, action: number): void {
  if (seq <= applied) return;
  incoming.push({ seq, seat, action });
  const st = useNet.getState();
  set({ serverSeq: Math.max(st.serverSeq, seq) });
  // Note where the captain's bot action landed; it stays "busy" until the
  // engine has actually applied it, so the next bot order cannot be computed
  // from a stale board.
  if (st.botSeats.includes(seat) && botSeq === null) botSeq = seq;
  if (inflight && inflight.seq === null && seat === mySeat && action === inflight.action) inflight.seq = seq;
  void pump();
}

async function pump(): Promise<void> {
  if (pumping || !ready) return;
  pumping = true;
  try {
    while (incoming.length > 0) {
      const batch = incoming.splice(0).sort((a, b) => a.seq - b.seq);
      const steps: [number, number][] = [];
      let cursor = applied;
      let gap = false;
      for (const m of batch) {
        if (m.seq <= cursor) continue;
        if (m.seq !== cursor + 1) {
          gap = true;
          break;
        }
        steps.push([m.seat, m.action]);
        cursor = m.seq;
      }
      if (gap) {
        // A message went missing (socket hiccup). Ask for the whole log again
        // instead of guessing — the rebuild is exact by construction.
        incoming = [];
        if (session) {
          set({ rebuilding: true });
          send({ t: 'resume', room: session.room, token: session.token, lastSeq: 0 });
        }
        return;
      }
      if (steps.length === 0) continue;

      const own = steps.some((s) => s[0] === mySeat);
      let st;
      try {
        st = await api.netSteps(CLIENT_ID, steps);
      } catch (err) {
        // The local engine died or rejected the request: rebuild it from the log.
        incoming = [];
        set({ rebuilding: true, error: err instanceof Error ? err.message : String(err) });
        if (session) send({ t: 'resume', room: session.room, token: session.token, lastSeq: 0 });
        return;
      }
      applied = cursor;
      lastNeeds = st.needs ?? lastNeeds;
      // Did the engine refuse one of *my* actions? That happens when two players
      // do the same thing at nearly the same time: the relay picks an order, and
      // whoever comes second is replayed against a board where the card/gold is
      // already gone. Everyone drops it identically (so no desync), but the
      // player must be told instead of watching a click do nothing.
      const dropped = (st.results ?? []).some(
        (r, i) => (steps[i]?.[0] ?? -1) === mySeat && (!r.ok || r.skipped === 'not-needed' || r.skipped === 'over'),
      );
      if (dropped) {
        const last = [...(st.results ?? [])].reverse().find((r) => (r.ok === false || r.skipped) && r.seat === mySeat);
        const why =
          last?.skipped === 'illegal' || last?.ok === false
            ? '这个操作没生效：慢了一步，牌/金币已经被改掉了'
            : '这个操作没生效：这一回合已经结束了';
        host?.toast(why, 'error');
      }
      // Round boundary reached: publish the engine's own digest. Every client
      // computes the same one from the same stream, so the relay comparing
      // eight of them is the desync alarm.
      const boundary = st.boundary;
      if (boundary && boundary.turn > lastBoundaryTurn) {
        lastBoundaryTurn = boundary.turn;
        send({ t: 'hash', turn: boundary.turn, seq: boundary.rev, hash: boundary.hash });
      }
      if (botSeq !== null && applied >= botSeq) {
        botSeq = null;
        botBusy = false;
      }
      const prevOver = useNet.getState().over;
      const prevNeed = prevNeedMe;
      prevNeedMe = Boolean(st.needs?.[mySeat]);
      const turn = st.turn ?? viewTurn;
      const over = Boolean(st.over);
      set({
        appliedSeq: applied,
        needMe: prevNeedMe,
        over,
        status: over ? 'over' : 'playing',
        serverSeq: Math.max(useNet.getState().serverSeq, applied),
      });
      const turnChanged = turn !== viewTurn;
      const showsOver = host?.phaseIsGameOver?.() ?? false;
      // A dropped action also means the view the player is looking at is a lie
      // (that card is gone / the turn already ended): pull the truth back.
      if (turnChanged || (prevNeedMe && !prevNeed) || (over && !showsOver) || own || dropped) {
        await refreshView(turnChanged || over);
      }
      resolveInflight();
      if (over && !prevOver) {
        send({ t: 'over' });
        wantGame = false;
      }
    }
  } finally {
    pumping = false;
    kickAuto();
    driveBots();
  }
}

/**
 * The captain client plays the bot seats. Everything it does still goes through
 * the relay, so a table with two humans and six bots is the exact same action
 * stream as eight humans — nothing special happens on the engine side.
 */
function driveBots(): void {
  if (botBusy) return;
  const st = useNet.getState();
  if (st.over || !ready || st.captain !== mySeat) return;
  const seat = st.botSeats.find((s) => lastNeeds[s]);
  if (seat === undefined) return;
  botBusy = true;
  botSeq = null;
  // If the relay never echoes (socket hiccup), give up this turn's slot: the
  // round deadline will end the seat anyway, and the next batch retries.
  window.setTimeout(() => {
    if (botBusy) {
      botBusy = false;
      botSeq = null;
      driveBots();
    }
  }, 2500);
  void (async () => {
    try {
      const r = await api.netBot(CLIENT_ID, seat);
      if (r?.ok) {
        send({ t: 'act', seat, action: r.action });
        return;
      }
      // The board moved on since `lastNeeds` was recorded (a stale order).
      // Re-read what the engine actually wants instead of waiting for a
      // deadline that may be minutes away.
      const fresh = await api.netStatus(CLIENT_ID);
      lastNeeds = fresh.needs ?? lastNeeds;
      botBusy = false;
      botSeq = null;
      driveBots();
    } catch {
      botBusy = false;
      botSeq = null;
    }
  })();
}

async function refreshView(withCombat: boolean): Promise<void> {
  try {
    const res = await api.netState(CLIENT_ID, withCombat);
    const turn = res.game?.turn ?? viewTurn;
    viewTurn = turn;
    host?.absorbNet(res);
    if (res.game) reportTurn(turn);
  } catch (err) {
    set({ error: err instanceof Error ? err.message : String(err) });
  }
}

/** Tell the relay which round this client is on, so it can own the deadline. */
function reportTurn(turn: number): void {
  if (turn === reportedTurn) return;
  reportedTurn = turn;
  send({ t: 'turn', turn, limit: turnLimit(Math.max(1, turn)) });
}

function resolveInflight(): void {
  if (!inflight || inflight.seq === null || applied < inflight.seq) return;
  const f = inflight;
  inflight = null;
  window.clearTimeout(f.timer);
  f.resolve();
}

/** One player action, through the relay: number first, apply second. */
export async function dispatchAction(action: number): Promise<void> {
  const st = useNet.getState();
  if (st.status === 'over' || st.over) throw new Error('对局已经结束');
  if (!socketOpen()) throw new Error('没有连接到联机服务器');
  if (!ready) throw new Error('本机还在准备这局游戏');
  if (!st.needMe) throw new Error('还没轮到你行动');
  if (inflight) throw new Error('上一个操作还在处理');
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      if (inflight && inflight.action === action) {
        inflight = null;
        reject(new Error('联机服务器没有响应'));
      }
    }, 10_000);
    inflight = { action, seq: null, resolve, reject, timer };
    if (!send({ t: 'act', action })) {
      inflight = null;
      window.clearTimeout(timer);
      reject(new Error('没有连接到联机服务器'));
    }
  });
}

/* ───────────────────────────── auto-play (drop-in) ───────────────────────────── */

let safetyTimer: number | null = null;

/** A slow heartbeat that restarts anything a dropped frame left waiting: the
 *  bot orders for empty seats and the drop-in autoplay for this seat. */
function startSafety(): void {
  if (safetyTimer !== null) return;
  safetyTimer = window.setInterval(() => {
    const st = useNet.getState();
    if (st.status !== 'playing') return;
    driveBots();
    kickAuto();
    // Heartbeat: if nobody has told us whether it is our turn in a while, ask
    // the engine directly. Cheap (no view, just the mask summary) and it means
    // a dropped websocket frame can never leave the table frozen.
    if (!st.needMe && !st.over) {
      void (async () => {
        try {
          const fresh = await api.netStatus(CLIENT_ID);
          if (fresh.over) return;
          lastNeeds = fresh.needs ?? lastNeeds;
          const mine = Boolean(fresh.needs?.[mySeat]);
          if (mine !== useNet.getState().needMe) {
            set({ needMe: mine });
            if (mine) await refreshView(false);
          }
        } catch {
          /* engine busy or restarting */
        }
      })();
    }
  }, 2000);
}

function stopSafety(): void {
  if (safetyTimer !== null) window.clearInterval(safetyTimer);
  safetyTimer = null;
}

/** Keep the seat moving when the player is away — also what the e2e test uses. */
function kickAuto(): void {
  if (autoTimer !== null) return;
  const st = useNet.getState();
  if (!st.autoBot || st.status !== 'playing' || !st.needMe || !ready || inflight) return;
  autoTimer = window.setTimeout(() => {
    autoTimer = null;
    const now = useNet.getState();
    if (!now.autoBot || now.status !== 'playing' || !now.needMe) return;
    void (async () => {
      try {
        const res = await api.netBot(CLIENT_ID, mySeat);
        if (res?.ok) await dispatchAction(res.action);
      } catch {
        /* the relay may be mid-round; the next pump tick retries */
      }
      kickAuto();
    })();
  }, 140);
}

/* ───────────────────────────── misc ───────────────────────────── */

/** Exposed for the end-to-end test: the engine's own digest, read atomically
 *  with the revision it belongs to (so a compare never mixes two states). */
export async function localHash(): Promise<{ hash: string | null; revision: number | null; turn: number | null }> {
  try {
    const h = await api.netHash(CLIENT_ID);
    return { hash: h.hash ?? null, revision: h.revision ?? null, turn: h.turn ?? null };
  } catch {
    return { hash: null, revision: null, turn: null };
  }
}

export type { GameView };
