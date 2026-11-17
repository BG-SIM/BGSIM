export type WarbandSummary =
  | { kind: 'none' }
  | { kind: 'mixed' }
  | { kind: 'race'; race: string; count: number };

/** Count how many minions a board has of each tribe (neutrals and blanks skipped). */
export function countRaces(board: { races?: string[] }[] | null | undefined): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const m of board ?? []) {
    for (const race of m.races ?? []) {
      if (!race) continue;
      counts[race] = (counts[race] ?? 0) + 1;
    }
  }
  return counts;
}

/**
 * The single race worth showing for a warband: the most numerous one.
 *
 * Ties at the top read as "mixed"; no tribes at all (all neutral, or an empty
 * board) reads as nothing. Multi-tribe minions count for every tribe they have,
 * and `ALL` minions count as their own `ALL` tribe.
 */
export function summarizeRaces(counts: Record<string, number> | null | undefined): WarbandSummary {
  const entries = Object.entries(counts ?? {});
  if (entries.length === 0) return { kind: 'none' };
  let best = 0;
  for (const [, n] of entries) if (n > best) best = n;
  const top = entries.filter(([, n]) => n === best);
  if (top.length > 1) return { kind: 'mixed' };
  return { kind: 'race', race: top[0][0], count: best };
}
