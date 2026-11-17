import { create } from 'zustand';
import { api, type ActionResult } from './api';
import { useCombatLog } from './store/combatLog';
import { captureRects } from './lib/flip';
import { setLocalArt } from './lib/assets';
import { magnetizeAction } from './lib/magnet';
import { dispatchAction as netDispatch, initNet, useNet } from './store/net';
import type { AssetStatus, Catalog, Combat, GameView, StateResponse, Toast } from './types';

interface PlayOpts {
  /** Identity of the hand card, so a queued play survives the hand shifting underneath it. */
  hid?: number | null;
  pos?: number;
  target?: { zone: string; slot: number };
}

/** Which top-level page is showing: the launcher, a mode inside it. */
export type Screen = 'home' | 'single' | 'net';
/** Which game the store is currently showing. The engine keeps both alive. */
export type Mode = 'solo' | 'net';

interface Store {
  screen: Screen;
  setScreen: (screen: Screen) => void;
  /** solo = the single-player run, net = the seat in a multiplayer match. */
  mode: Mode;
  /** The single-player game, kept aside while a net match is on screen. */
  soloView: GameView | null;
  enterSolo: () => void;
  enterNet: () => void;
  view: GameView | null;
  catalog: Catalog | null;
  combat: Combat | null;
  afterCombat: StateResponse | null;
  log: string[];
  toasts: Toast[];
  busy: boolean;
  booting: boolean;
  canUndo: boolean;
  error: string | null;
  revision: number;
  turnStartedAt: number;
  startedAt: number;
  showCatalog: boolean;
  showMenu: boolean;
  seed: number | null;
  /** Turn clock on/off (custom games can play without a time limit). */
  timeLimitOn: boolean;
  /** Local art pack status (null until the first probe). */
  assets: AssetStatus | null;
  refreshAssets: () => Promise<void>;
  downloadAssets: (kinds?: string[]) => Promise<void>;
  clearAssets: (kinds?: string[]) => Promise<void>;
  setAssetsEnabled: (on: boolean) => Promise<void>;

  boot: () => Promise<void>;
  /** `opts` is the custom-game form: pinned hero, pinned tribes, turn clock on/off. */
  start: (seed?: number, opts?: StartOptions) => Promise<void>;
  act: (action: number) => Promise<void>;
  /** Buy the tavern card with this `sid` (already bought → ignored). */
  buy: (sid: number | null) => Promise<void>;
  /** Sell the board minion with this `eid`. */
  sell: (eid: number) => Promise<void>;
  /** Move a board minion to a new slot. */
  move: (eid: number, to: number) => Promise<void>;
  playCard: (handIndex: number, opts?: PlayOpts) => Promise<void>;
  choose: (option: number) => Promise<void>;
  pickHero: (id: string) => Promise<void>;
  undo: () => Promise<void>;
  finish: () => Promise<void>;
  resolveCombat: () => void;
  toast: (text: string, kind?: Toast['kind']) => void;
  dismissToast: (id: number) => void;
  setShowCatalog: (v: boolean) => void;
  setShowMenu: (v: boolean) => void;
  clearError: () => void;
}

const N_POS = 8;
const N_BOARD = 7;

let toastSeq = 1;

/** `StartOptions` describes a custom game; everything defaults to "surprise me". */
export interface StartOptions {
  hero?: string | null;
  races?: string[];
  /** false = no turn clock at all (no countdown, no rope, no auto end-turn). */
  timeLimit?: boolean;
}

const TIME_LIMIT_KEY = 'bgsim.timeLimit';

function readTimeLimit(): boolean {
  try {
    return localStorage.getItem(TIME_LIMIT_KEY) !== '0';
  } catch {
    return true;
  }
}

function writeTimeLimit(on: boolean): void {
  try {
    localStorage.setItem(TIME_LIMIT_KEY, on ? '1' : '0');
  } catch {
    /* private mode */
  }
}

function nowMs() {
  return Date.now();
}

export const useStore = create<Store>((set, get) => {
  /**
   * Actions run strictly one after another. Anything the player clicks while
   * one is in flight is queued instead of dropped — with a ~40ms round trip,
   * dropping input made fast buying feel broken.
   */
  let tail: Promise<void> = Promise.resolve();
  let pending = 0;

  /** The net match's own view, kept apart from the single-player one. */
  let netView: GameView | null = null;

  const applyState = (res: StateResponse, opts: { keepView?: boolean } = {}) => {
    const game = res.game;
    if (!game) {
      // A single-player response with no game (e.g. `boot()` landing while a
      // net match is already on screen) must not wipe the net view.
      if (get().mode === 'net') {
        set({ soloView: null });
        return;
      }
      set({ view: null, log: res.log ?? [] });
      return;
    }
    const prev = get().view;
    const patch: Partial<Store> = {
      error: null,
      canUndo: Boolean(res.canUndo),
      revision: res.revision,
    };
    if (game.phase === 'game_over') patch.toasts = [];
    if (!opts.keepView) {
      patch.view = game;
      // Remember the single-player game while a net match is on screen, so the
      // launcher can still offer "继续游戏" for it.
      if (get().mode === 'solo') patch.soloView = game;
      if (res.log) patch.log = res.log;
      if (!prev || prev.turn !== game.turn) patch.turnStartedAt = nowMs();
      patch.afterCombat = null;
    } else {
      patch.afterCombat = res;
      if (res.log) patch.log = res.log;
    }
    // Small celebratory toasts for the events players care about.
    if (prev && prev !== game) {
      const goldenBefore = new Set(prev.me.board.filter((m) => m.golden).map((m) => m.eid));
      const freshGolden = game.me.board.find((m) => m.golden && !goldenBefore.has(m.eid));
      if (freshGolden && game.turn === prev.turn) {
        get().toast(`三连！${freshGolden.nameZh} 已升级为金色`, 'success');
      }
      if (game.me.health < prev.me.health) {
        get().toast(`受到 ${prev.me.health - game.me.health} 点伤害`, 'error');
      }
    }
    // Remember where every card sits right now, so the rows can animate their
    // shift instead of jumping once this patch is committed.
    if (!opts.keepView) captureRects();
    // Fold the round's fights into the per-opponent history shown on hover.
    useCombatLog.getState().record(game);
    set(patch);
  };

  /** Apply a full state response, diverting into the combat replay when needed. */
  const absorb = (res: StateResponse) => {
    const combat = res.game?.combat ?? null;
    if (combat && combat.frames.length > 0) {
      applyState(res, { keepView: true });
      set({ combat, afterCombat: res, toasts: [] });
    } else {
      applyState(res);
    }
  };

  const runTask = (task: () => Promise<void>) => {
    pending++;
    set({ busy: true });
    const wrapped = async () => {
      try {
        await task();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        set({ error: message });
        get().toast(message, 'error');
      } finally {
        pending--;
        set({ busy: pending > 0 });
      }
    };
    tail = tail.then(wrapped, wrapped);
    return tail;
  };

  const run = (fn: () => Promise<StateResponse>) =>
    runTask(async () => {
      absorb(await fn());
    });

  /**
   * Every player action goes through here. In a net match the number is not
   * ours to apply: the relay numbers it first, every client applies it in that
   * order, and only then does the local view move.
   */
  const dispatch = async (action: number) => {
    if (get().mode === 'net') {
      await netDispatch(action);
      return;
    }
    absorb(await api.action(action));
  };

  /** Resolve a hand card by its stable id, falling back to the array index. */
  const handIndexOf = (index: number, hid?: number | null): number => {
    const view = get().view;
    if (!view) return -1;
    if (hid === undefined || hid === null) return index;
    return view.me.hand.findIndex((h) => h.hid === hid);
  };

  /** Hero select: the option index is the CHOOSE action, resolved from the view
   *  so multiplayer and single player send exactly the same number. */
  const dispatchHero = async (id: string) => {
    const view = get().view;
    const pending = view?.me.pending;
    if (!view || pending?.kind !== 'hero') {
      get().toast('当前不在英雄选择阶段', 'error');
      return;
    }
    const index = pending.options.findIndex((o) => o.id === id);
    if (index < 0) {
      get().toast('该英雄不在候选中', 'error');
      return;
    }
    await dispatch((view.actions.CHOOSE ?? 30) + index);
  };

  // Multiplayer drives the view itself; hand it the same absorb path so combat
  // replays, toasts and card animations all behave identically.
  initNet({
    absorbNet: (res) => {
      netView = res.game ?? null;
      if (get().mode === 'net') absorb(res);
    },
    setScreen: (screen) => get().setScreen(screen),
    setMode: (mode) => set({ mode }),
    toast: (text, kind) => get().toast(text, kind),
    phaseIsGameOver: () => get().view?.phase === 'game_over',
    caps: () => {
      const catalog = get().catalog;
      return { engine: catalog?.engine ?? '', game: catalog?.version ?? '' };
    },
  });

  return {
    screen: 'home',
    setScreen: (screen) => set({ screen, showCatalog: false, showMenu: false }),
    view: null,
    mode: 'solo',
    soloView: null,
    /** Switch to single player, putting that game back on screen. */
    enterSolo: () =>
      set((s) => ({
        mode: 'solo',
        screen: s.screen === 'home' ? 'home' : 'single',
        view: s.soloView,
        combat: null,
        afterCombat: null,
        canUndo: false,
      })),
    /** Switch to the multiplayer match, putting it back on screen. */
    enterNet: () =>
      set((s) => ({
        mode: 'net',
        screen: 'net',
        view: netView,
        combat: null,
        afterCombat: null,
        canUndo: false,
        showCatalog: false,
        showMenu: false,
      })),
    catalog: null,
    combat: null,
    afterCombat: null,
    log: [],
    toasts: [],
    busy: false,
    booting: true,
    canUndo: false,
    error: null,
    revision: 0,
    turnStartedAt: nowMs(),
    startedAt: nowMs(),
    showCatalog: false,
    showMenu: false,
    seed: null,
    timeLimitOn: readTimeLimit(),
    assets: null,

    refreshAssets: async () => {
      try {
        const status = await api.assets();
        setLocalArt(status.enabled);
        set({ assets: status });
      } catch {
        /* the engine may be mid-restart; the launcher just shows the CDN state */
      }
    },
    downloadAssets: async (kinds) => {
      try {
        const res = await api.assetsDownload(kinds);
        if (res.error) get().toast(res.error, 'error');
      } catch (err) {
        get().toast(err instanceof Error ? err.message : '下载失败', 'error');
      }
      await get().refreshAssets();
    },
    clearAssets: async (kinds) => {
      try {
        const status = await api.assetsClear(kinds);
        setLocalArt(status.enabled);
        set({ assets: status });
        get().toast('已清空本地美术素材', 'success');
      } catch (err) {
        get().toast(err instanceof Error ? err.message : '清空失败', 'error');
      }
    },
    setAssetsEnabled: async (on) => {
      try {
        const status = await api.assetsEnabled(on);
        setLocalArt(status.enabled);
        set({ assets: status, revision: get().revision + 1 });
      } catch (err) {
        get().toast(err instanceof Error ? err.message : '切换失败', 'error');
      }
    },

    boot: async () => {
      set({ booting: true });
      try {
        const [catalog, state] = await Promise.all([api.catalog(), api.state()]);
        // Resolve the art source before the first card paints: otherwise the
        // first frame asks the CDN for art we already have locally (a flash of
        // remote art, and broken images when the machine is offline).
        await get().refreshAssets();
        set({ catalog, booting: false });
        applyState(state);
        // Test seam: `?clock=27` pretends the current turn started 27s ago, so
        // the rope and the auto end-turn can be checked without waiting.
        const offsetSeconds = Number(new URLSearchParams(window.location.search).get('clock'));
        if (Number.isFinite(offsetSeconds) && offsetSeconds > 0) {
          set({ turnStartedAt: nowMs() - offsetSeconds * 1000 });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        set({ booting: false, error: message });
      }
    },

    start: async (seed, opts) => {
      const timeLimit = opts?.timeLimit !== false;
      set({ busy: true, error: null, seed: seed ?? null });
      useCombatLog.getState().reset();
      try {
        const res = await api.newGame(seed, opts);
        applyState(res);
        // The clock has no server side: remember the mode so a reload keeps it.
        writeTimeLimit(timeLimit);
        set({ combat: null, afterCombat: null, startedAt: nowMs(), turnStartedAt: nowMs(), timeLimitOn: timeLimit });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        set({ error: message });
        get().toast(message, 'error');
      } finally {
        set({ busy: pending > 0 });
      }
    },

    act: (action) => runTask(() => dispatch(action)),

    buy: (sid) =>
      runTask(async () => {
        const view = get().view;
        if (!view || sid === null) return;
        const index = view.me.shop.findIndex((s) => s.sid === sid);
        if (index < 0) return; // already bought by an earlier click
        const action = view.actions.BUY + index;
        if (!view.legal.includes(action)) {
          const item = view.me.shop[index];
          get().toast((item?.price ?? 99) > view.me.gold ? '金币不足' : '现在无法购买这张牌', 'error');
          return;
        }
        await dispatch(action);
      }),

    sell: (eid) =>
      runTask(async () => {
        const view = get().view;
        if (!view) return;
        const index = view.me.board.findIndex((m) => m.eid === eid);
        if (index < 0) return;
        const action = view.actions.SELL + index;
        if (!view.legal.includes(action)) return;
        await dispatch(action);
      }),

    move: (eid, to) =>
      runTask(async () => {
        const view = get().view;
        if (!view) return;
        const from = view.me.board.findIndex((m) => m.eid === eid);
        if (from < 0) return;
        const action = view.actions.MOVE + from * N_BOARD + Math.max(0, Math.min(N_BOARD - 1, to));
        if (!view.legal.includes(action)) return;
        await dispatch(action);
      }),

    playCard: (handIndex, opts) =>
      runTask(async () => {
        const view = get().view;
        if (!view) return;
        const index = handIndexOf(handIndex, opts?.hid);
        if (index < 0) return; // already played by an earlier click
        const actions = view.actions;

        // A magnetic minion played to the left of a Mech attaches to it.
        const landing = opts?.pos !== undefined ? opts.pos : view.me.board.length;
        const magnetize = magnetizeAction(view, index, landing);
        if (magnetize !== null) {
          await dispatch(magnetize);
          return;
        }

        const at = (p: number) => {
          const a = actions.PLAY + index * N_POS + p;
          return view.legal.includes(a) ? a : -1;
        };
        let action = opts?.pos !== undefined ? at(opts.pos) : -1;
        if (action < 0) {
          for (let p = 0; p < N_POS; p++) {
            const a = at(p);
            if (a >= 0) {
              action = a;
              break;
            }
          }
        }
        if (action < 0) {
          get().toast('现在无法打出这张牌', 'error');
          return;
        }
        await dispatch(action);
        if (!opts?.target) return;
        // The card opened a target picker: finish it for the drop position.
        const pendingView = get().view;
        const open = pendingView?.me.pending;
        if (open?.kind !== 'target') return;
        const target = open.targets.find(
          (x) => x.location.zone === opts.target!.zone && x.location.slot === opts.target!.slot,
        );
        if (!target) {
          get().toast('该目标不合法，请选择高亮的目标', 'error');
          return;
        }
        await dispatch(target.action);
      }),

    choose: (option) => runTask(() => dispatch(30 + option)),
    pickHero: (id) => runTask(() => dispatchHero(id)),
    undo: () => (get().mode === 'net' ? Promise.resolve() : run(() => api.undo())),
    finish: () => run(() => api.finish()),

    resolveCombat: () => {
      const after = get().afterCombat;
      set({ combat: null });
      if (after) applyState(after);
    },

    toast: (text, kind = 'info') => {
      const id = toastSeq++;
      set((s) => {
        if (s.toasts.some((t) => t.text === text)) return {};
        return { toasts: [...s.toasts, { id, text, kind }].slice(-3) };
      });
      window.setTimeout(() => {
        set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
      }, 3200);
    },

    dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
    setShowCatalog: (v) => set({ showCatalog: v }),
    setShowMenu: (v) => set({ showMenu: v }),
    clearError: () => set({ error: null }),
  };
});

export type { ActionResult };
