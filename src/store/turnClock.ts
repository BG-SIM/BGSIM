import { create } from 'zustand';
import { useStore } from '../store';
import { useNet } from './net';
import { turnLimit } from '../lib/turnClock';

/**
 * Turn countdown, kept outside React's tree on purpose: the clock ticks five
 * times a second and only two tiny components (the HUD number and the rope)
 * subscribe to it, so the board never re-renders because of time passing.
 *
 * Single player owns the clock (it ends the turn when the rope burns out).
 * In a net match the *relay* owns it: this only displays what the relay said,
 * because a client that ends its own turn locally would leave the other seven
 * behind.
 */
interface TurnClockState {
  /** Seconds left in this turn (seconds elapsed when `off`). */
  left: number;
  /** Total length of this turn, for the tooltip (0 when unlimited). */
  limit: number;
  /** True for a custom game with no time limit: count up, never end the turn. */
  off: boolean;
}

export const useTurnClock = create<TurnClockState>(() => ({ left: 0, limit: 0, off: false }));

let timer: number | null = null;
/** Turn this rope has already ended, so timeout fires once per turn. */
let endedFor = -1;
/** Time the player could not act (combat replay, launcher screen). */
let pausedMs = 0;
let pausedSince: number | null = null;
let lastTurn = -1;

function tick() {
  const s = useStore.getState();
  const view = s.view;
  if (!view) return;
  const now = Date.now();

  if (view.turn !== lastTurn) {
    lastTurn = view.turn;
    pausedMs = 0;
    pausedSince = null;
  }

  // ---- multiplayer: the relay's deadline is the only clock ----------------
  if (s.mode === 'net') {
    const net = useNet.getState();
    const deadline = net.deadline;
    const prev = useTurnClock.getState();
    if (!deadline || deadline.turn !== view.turn) {
      // Between rounds (or before the relay has spoken): hold the last known
      // limit instead of inventing one.
      const limit = prev.limit || turnLimit(Math.max(1, view.turn));
      const left = deadline && deadline.turn < view.turn ? 0 : Math.max(0, prev.left);
      if (prev.off || Math.abs(prev.left - left) > 0.02 || prev.limit !== limit) {
        useTurnClock.setState({ left, limit, off: false });
      }
      return;
    }
    const limit = Math.max(1, deadline.ms / 1000);
    const left = deadline.at > 0 ? Math.max(0, (deadline.at - now) / 1000) : 0;
    if (prev.off || prev.limit !== limit || Math.abs(prev.left - left) > 0.02) {
      useTurnClock.setState({ left, limit, off: false });
    }
    // Never end the turn here — the relay does that, through the action stream.
    return;
  }

  const away = s.screen !== 'single' || Boolean(s.combat);
  if (away) {
    if (pausedSince === null) pausedSince = now;
  } else if (pausedSince !== null) {
    pausedMs += now - pausedSince;
    pausedSince = null;
  }

  const frozen = pausedSince === null ? 0 : now - pausedSince;
  const elapsed = (now - s.turnStartedAt - pausedMs - frozen) / 1000;
  const prev = useTurnClock.getState();

  // Unlimited custom game: the HUD counts up instead of down, and nothing ever
  // ends the turn for the player.
  if (!s.timeLimitOn) {
    const left = Math.max(0, elapsed);
    if (!prev.off || Math.abs(prev.left - left) > 0.02) useTurnClock.setState({ left, limit: 0, off: true });
    return;
  }

  const limit = turnLimit(view.turn);
  const left = Math.max(0, limit - elapsed);
  if (prev.off || prev.limit !== limit || Math.abs(prev.left - left) > 0.02) {
    useTurnClock.setState({ left, limit, off: false });
  }

  // Rope burnt out: end the turn for the player. An open picker would swallow
  // the end-of-turn action, so wait until it has been answered.
  if (left > 0 || away || view.phase === 'game_over') return;
  if (endedFor === view.turn) return;
  if (view.me.pending) return;
  if (!view.legal.includes(view.actions.END)) return;
  endedFor = view.turn;
  void s.act(view.actions.END);
}

/** Idempotent: the tavern calls this on mount. */
export function startTurnClock(): void {
  if (timer !== null) return;
  tick();
  timer = window.setInterval(tick, 200);
}
