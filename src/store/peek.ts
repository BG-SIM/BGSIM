import { create } from 'zustand';
import type { Minion } from '../types';

interface PeekState {
  /** Warband drawn above Bob while the cursor rests on a rail avatar. */
  cards: Minion[] | null;
  hero: string;
  show: (cards: Minion[] | null, hero: string) => void;
  hide: () => void;
}

/**
 * The hover panel no longer carries the warband cards — they are pulled out of
 * the panel and shown above the tavern keeper, so the panel stays short enough
 * to fit on screen. One small store keeps the rail and the table in sync.
 */
export const usePeek = create<PeekState>((set) => ({
  cards: null,
  hero: '',
  show: (cards, hero) => set({ cards, hero }),
  hide: () => set({ cards: null, hero: '' }),
}));
