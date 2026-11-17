import { create } from 'zustand';
import type { GameView } from '../types';

/** One fight, seen from the seat it happened to. */
export interface CombatEntry {
  /** Combat round the fight happened in. */
  turn: number;
  /** The other seat; `null` when this seat fought a ghost. */
  foe: number | null;
  /** `w` = this seat won, `l` = lost, `d` = draw. */
  result: 'w' | 'l' | 'd';
  /** Damage the loser took (0 on a draw). */
  damage: number;
}

/** How many fights the opponent panel shows. */
export const KEEP = 3;

interface CombatLogState {
  /** Combat rounds already folded in, oldest first — lets us tell a re-read of
   *  the same round (and a replay after undo) from a fresh one. */
  rounds: number[];
  bySeat: Record<number, CombatEntry[]>;
  record: (view: GameView | null) => void;
  reset: () => void;
}

/**
 * The engine only ever keeps the round that just resolved, so the client keeps
 * the last few rounds itself. Everything here is derived from `combatSummaries`
 * (four rows per round), which means no extra engine state and no extra
 * requests — and an undo simply rewinds the log instead of corrupting it.
 */
export const useCombatLog = create<CombatLogState>((set, get) => ({
  rounds: [],
  bySeat: {},

  record: (view) => {
    const matches = view?.combatSummaries;
    if (!view || !matches || matches.length === 0) return;
    const round = matches[0].turn ?? view.turn - 1;
    const { rounds, bySeat } = get();
    // The same round arrives with every state patch — fold it in once.
    if (rounds[rounds.length - 1] === round) return;

    // Undo rewinds past a combat: drop everything newer than the round the
    // game has gone back to, then re-add it from the restored state.
    const next: Record<number, CombatEntry[]> = {};
    for (const [seat, list] of Object.entries(bySeat)) {
      const older = list.filter((e) => e.turn < round);
      if (older.length > 0) next[Number(seat)] = older;
    }

    for (const m of matches) {
      const draw = m.winner !== 0 && m.winner !== 1;
      const push = (seat: number, foe: number | null, result: 'w' | 'l' | 'd') => {
        const list = next[seat] ?? [];
        list.push({ turn: round, foe, result, damage: m.damage ?? 0 });
        next[seat] = list.slice(-KEEP);
      };
      push(m.a, m.b, draw ? 'd' : m.winner === 0 ? 'w' : 'l');
      // A ghost fight is recorded for the living player only: the ghost has no
      // seat, so there is nothing to file it against.
      if (m.b !== null) push(m.b, m.a, draw ? 'd' : m.winner === 1 ? 'w' : 'l');
    }

    set({
      bySeat: next,
      rounds: [...rounds.filter((t) => t < round), round].slice(-32),
    });
  },

  reset: () => set({ rounds: [], bySeat: {} }),
}));
