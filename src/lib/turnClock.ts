/** Length of a player's turn, in seconds, by round. */
export function turnLimit(turn: number): number {
  // Tavern brawls are quick at the start (three buys, nothing to think about)
  // and grow once the boards — and the decisions — get big.
  if (turn <= 4) return 45;
  if (turn <= 9) return 120;
  return 180;
}

/** Seconds of warning before the turn ends on its own: the burning rope. */
export const ROPE_SECONDS = 20;

/** `mm:ss` for a number of seconds, rounded up so "45" reads 00:45 at the start. */
export function clockText(seconds: number): string {
  const t = Math.max(0, Math.ceil(seconds));
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}
