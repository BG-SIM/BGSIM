// Shapes returned by engine/server.py (a compact projection of taverngym's view).

export type Phase = 'hero_select' | 'recruit' | 'combat' | 'game_over';

export interface CardRef {
  id: string;
  name: string;
  nameZh: string;
  text: string;
  textZh: string;
  tier: number | null;
  kind: string;
  races: string[];
  goldenId: string | null;
  atk: number | null;
  hp: number | null;
  cost: number | null;
  armor?: number | null;
  scripted?: boolean;
  heroPower?: CardRef | null;
}

export interface Minion {
  id: string;
  eid: number;
  name: string;
  nameZh: string;
  textZh: string;
  tier: number | null;
  races: string[];
  atk: number;
  hp: number;
  maxHp: number;
  kw: string[];
  golden: boolean;
  goldenId?: string | null;
  shield: number;
  shieldMax: number;
  act: number | null;
  actN: number;
  counter: number;
  gems: number;
  triple: boolean;
  attached: CardRef[];
}

export interface Item {
  id: string;
  name: string;
  nameZh: string;
  textZh: string;
  tier: number | null;
  races: string[];
  type: 'minion' | 'spell';
  cost: number | null;
  atk: number | null;
  hp: number | null;
  kw: string[];
  golden: boolean;
  goldenId: string | null;
  unplayable: boolean;
  price: number | null;
  sid: number | null;
  hid: number | null;
  frozen: boolean;
  kept: boolean;
  ticket: boolean;
  owned: number | null;
  tripleNeed: number | null;
  costsHealth: boolean;
  locked: number | null;
  temporary: boolean;
  combined: boolean;
  data: number | null;
  attached?: CardRef[];
}

export interface HeroPower extends CardRef {
  slot: number;
  action: number;
  price: number | null;
  usable: boolean;
  passive: boolean;
  usesTurn: number;
  usesGame: number;
  counter: number;
}

export interface QuestState {
  quest: CardRef;
  reward: CardRef;
  progress: number;
  goal: number;
}

export interface Opponent {
  id: number;
  hero: CardRef | null;
  health: number;
  armor: number;
  tier: number;
  alive: boolean;
  placement: number;
  /** The board they had when we last ran into them, and the turn of that sighting. */
  seenBoard: Minion[];
  seenTurn: number;
  /** Tribe counts on their board at the end of last round (always known). */
  lastRaces: Record<string, number>;
  /** Triples they have made this game. */
  triples: number;
  /** Consecutive wins; a draw keeps the streak but does not add to it. */
  streak: number;
  isNext: boolean;
  wasLast: boolean;
  trinkets: CardRef[];
  /** Their live hero powers, when the engine exposes them. */
  heroPowers?: CardRef[];
  quests: QuestState[];
}

export type Pending =
  | { kind: 'hero'; options: CardRef[] }
  | { kind: 'discover'; source: CardRef | null; options: Item[] }
  | { kind: 'choose_one'; source: CardRef | null; options: CardRef[] }
  | { kind: 'target'; targets: { action: number; choice: number; location: { slot: number; zone: string } }[] }
  | { kind: 'hero_power'; slot: number; options: CardRef[] }
  | {
      kind: 'trinket';
      free: boolean;
      replace: CardRef | null;
      options: (CardRef & { cost: number; baseCost: number; weight: number })[];
    }
  | {
      kind: 'timewarp';
      chronum: number;
      major: boolean;
      leave: number;
      options: (Item & { chronumCost: number })[];
    }
  | { kind: 'quest'; options: (CardRef & { goal: number; reward: CardRef })[] };

export interface Me {
  hero: CardRef | null;
  heroPowers: HeroPower[];
  health: number;
  armor: number;
  alive: boolean;
  placement: number;
  tier: number;
  gold: number;
  maxGold: number;
  maxGoldBonus: number;
  goldNextTurn: number;
  upgradePrice: number;
  canUpgrade: boolean;
  refreshPrice: number;
  minionPrice: number;
  freeRefreshes: number;
  frozen: boolean;
  endedTurn: boolean;
  board: Minion[];
  hand: Item[];
  shop: Item[];
  trinkets: CardRef[];
  quests: QuestState[];
  rewards: CardRef[];
  secrets: CardRef[];
  effects: { card: CardRef; stacks: number }[];
  scheduled: { card: CardRef; turnsLeft: number; ifWon: boolean }[];
  pending: Pending | null;
  cancellable: boolean;
  casting: number | null;
  darkGift: {
    available: boolean;
    uses: number;
    max_uses: number;
    cost: number;
    unlock_turn: number;
    tiers: number[];
    next_tiers: number[];
    slots: { tiers: number[]; typed: boolean }[];
    used_this_turn: boolean;
  } | null;
  deity: { card: CardRef; atk: number; hp: number; golden: boolean; reborn: boolean } | null;
  buddy: CardRef | null;
  buddyButton: {
    card: CardRef;
    claims: number;
    price: number;
    discount: number;
    available: boolean;
    quantity: number;
  } | null;
  nextOpponent: number | null;
  nextIsGhost: boolean;
  lastOpponent: number | null;
  lastDamage: number;
  winStreak: number;
  /** Tribe counts on our own board, plus the public counters. */
  lastRaces: Record<string, number>;
  triples: number;
  streak: number;
  handLimit: number;
  chronum: number;
  stats: Record<string, number | string | boolean | null>;
}

export interface CombatMinion {
  id: string;
  eid: number;
  atk: number;
  hp: number;
  maxHp: number;
  kw: string[];
  golden: boolean;
  goldenId?: string | null;
  shield: number;
  shieldMax: number;
  tier: number | null;
  races: string[];
}

export interface CombatFrame {
  attacks: [number, number][];
  log: string[];
  boards: [CombatMinion[], CombatMinion[]];
}

/** One line of the round's combat table: seats `a` and `b`, who won, damage taken. */
export interface CombatSummary {
  a: number;
  /** `null` when `a` fought a ghost (a dead player's board). */
  b: number | null;
  /** 0 = `a` won, 1 = `b` won, anything else = draw. */
  winner: number | null;
  /** Damage the loser took (0 on a draw). */
  damage: number;
  turn: number;
}

export interface Combat {
  turn: number;
  a: number;
  b: number | null;
  winner: number | null;
  damage: number;
  truncated: boolean;
  frames: CombatFrame[];
}

export interface GameView {
  seat: number;
  turn: number;
  phase: Phase;
  version: string;
  alive: number;
  lobbyRaces: string[];
  hasAberrations: boolean;
  deity: CardRef | null;
  paradox: CardRef | null;
  me: Me;
  opponents: Opponent[];
  actions: Record<string, number>;
  legal: number[];
  /** Which ruleset this match runs (see engine/profiles.py). */
  profile?: string;
  /** Mechanic switches: a feature is mounted unless its key is false. */
  caps?: Record<string, boolean>;
  combat?: Combat | null;
  combatSummaries?: CombatSummary[];
}

export interface StateResponse {
  game: GameView | null;
  revision: number;
  canUndo: boolean;
  catalogVersion?: string;
  elapsed?: number;
  log?: string[];
}

/* ─────────────────────────── net play (engine side) ─────────────────────────── */

/** What the local engine says about its slice of the shared game. */
export interface NetEngineStatus {
  game: boolean;
  revision: number;
  seat: number;
  turn?: number;
  phase?: Phase;
  /** Per seat: does the engine want an action from it right now? */
  needs?: boolean[];
  over?: boolean;
  boundary?: { turn: number; hash: string; rev: number } | null;
  stats?: { applied: number; skipped: number; illegal: number };
}

/** Screenshot of a relay-ordered batch: enough to drive the UI without a view. */
export interface NetStepResponse extends NetEngineStatus {
  results?: { seat: number; action: number; ok: boolean; skipped?: string; reason?: string }[];
  mismatch?: { seat: number; action: number; turn: number } | null;
  /** Digest of the state right after the round last changed hands, plus the
   *  revision it belongs to. Identical on every client; the relay compares them. */
  boundary?: { turn: number; hash: string; rev: number } | null;
}

export interface NetStateResponse extends StateResponse {
  net?: NetEngineStatus;
  replayed?: number;
}

export interface NetHash {
  game: boolean;
  turn?: number;
  revision?: number;
  hash?: string;
  bytes?: number;
}

/* ─────────────────────────── net play (wire protocol) ─────────────────────────── */

export interface NetSeatInfo {
  seat: number;
  name: string;
  /** The engine's bot plays this seat (a table with fewer than eight humans). */
  bot?: boolean;
}

/** relay → client */
export type RelayMessage =
  | { t: 'welcome'; v: number; id: number; need: number; key?: string; caps?: { engine: string; game: string }; maxSeats?: number }
  | { t: 'incompatible'; reason: 'proto' | 'token'; proto?: number; you?: number | null }
  | { t: 'queue'; n: number; need: number; key?: string; names: string[]; others?: { key: string; n: number }[] }
  | {
      t: 'start';
      v: number;
      room: string;
      key?: string;
      seed: number;
      seat: number;
      token: string;
      config: Record<string, unknown>;
      seats: NetSeatInfo[];
      need: number;
      captain: number | null;
      botSeats: number[];
    }
  | { t: 'act'; seq: number; seat: number; action: number; timeout?: boolean }
  | { t: 'deadline'; turn: number; at: number; ms?: number; fired?: boolean }
  | { t: 'progress'; turn: number; ended: number[]; timeout?: boolean }
  | { t: 'peer'; seat: number; connected: boolean; name: string }
  | { t: 'captain'; seat: number | null }
  | { t: 'desync'; turn: number; seats: { seat: number; hash: string }[] }
  | {
      t: 'sync';
      room: string;
      key?: string;
      seed: number;
      seat: number;
      config: Record<string, unknown>;
      seats: NetSeatInfo[];
      need: number;
      captain: number | null;
      botSeats: number[];
      seq: number;
      from: number;
      actions: { seq: number; seat: number; action: number }[];
      turn: number;
      deadline: { turn: number; at: number; ms?: number } | null;
      over: boolean;
    }
  | { t: 'over'; turn: number; actions: number }
  | { t: 'left'; room: string }
  | { t: 'gone'; room: string; reason?: 'token' | 'version'; room_key?: string; client_key?: string }
  | { t: 'replaced'; room: string }
  | { t: 'pong'; at: number | null; now: number }
  | { t: 'error'; error: string };

export interface CatalogCard extends CardRef {
  normalId: string | null;
  inPool: boolean;
  implemented: boolean;
  tier7: boolean;
}

export interface Catalog {
  version: string;
  engine: string;
  races: Record<string, string>;
  cards: CatalogCard[];
  byId: Record<string, CatalogCard>;
}

export interface Toast {
  id: number;
  text: string;
  kind?: 'info' | 'error' | 'success';
}

/** Local art pack (资源包) — see engine/assets.py. */
export interface AssetKind {
  label: string;
  total: number;
  done: number;
  missing: number;
  errors: number;
  bytes: number;
  diskBytes: number;
  files: number;
  running: boolean;
  complete: boolean;
  /** Rough size for the whole kind, for the UI before downloading. */
  estimate: number;
}

export interface AssetStatus {
  enabled: boolean;
  running: boolean;
  kinds: Record<string, AssetKind>;
  error: string | null;
  startedAt: number | null;
  cdn: string;
  prefetch: string[];
  /** Rough size of the full pack. */
  estimate: number;
}
