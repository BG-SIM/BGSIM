// Magnetic minions attach to the Mech immediately to their RIGHT.
//
// The engine already exposes that as `MAGNETIZE + handIndex * 7 + boardIndex`,
// but the UI used to only send it when you dropped *directly onto* a minion.
// In the real game the rule is positional: wherever the magnetic minion lands,
// if a Mech ends up on its right it attaches — including when you drop it in
// the gap to the left of that Mech, or when the board is full.
import type { GameView } from '../types';

const N_BOARD = 7;

/**
 * @param pos insertion slot the minion is about to be played into
 * @returns the MAGNETIZE action to send instead of PLAY, or null to play normally
 */
export function magnetizeAction(view: GameView, handIndex: number, pos: number): number | null {
  const item = view.me.hand[handIndex];
  if (!item || !(item.kw ?? []).includes('MAGNETIC')) return null;
  // `board[pos]` is the minion that will sit on the new card's right.
  const host = view.me.board[pos];
  if (!host) return null;
  const action = view.actions.MAGNETIZE + handIndex * N_BOARD + Math.min(pos, N_BOARD - 1);
  return view.legal.includes(action) ? action : null;
}
