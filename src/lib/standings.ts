// The side rail is a live leaderboard, exactly like the real game: whoever has
// the most health + armour is on top, and it re-sorts the moment a combat
// changes anyone's health. Eliminated players drop to the bottom, with 8th
// place last and 7th place just above it.

export interface StandingsEntry {
  id: number;
  health: number;
  armor: number;
  alive: boolean;
  /** Final placement once eliminated (1 = winner, 8 = out first); 0 while alive. */
  placement: number;
}

const total = (e: StandingsEntry) => (e.health ?? 0) + (e.armor ?? 0);

export function sortStandings<T extends StandingsEntry>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => {
    if (a.alive !== b.alive) return a.alive ? -1 : 1; // survivors first
    if (!a.alive) {
      // 5, 6, 7, 8 — so 8th sits at the very bottom.
      const pa = a.placement || 99;
      const pb = b.placement || 99;
      if (pa !== pb) return pa - pb;
    } else {
      const d = total(b) - total(a);
      if (d !== 0) return d;
    }
    return a.id - b.id; // stable for equal scores
  });
}
