// Drag state lives in its own store so that a 60Hz drag does not re-render the
// whole tavern through `useStore`. Only components that really care about the
// drag subscribe here.
import { create } from 'zustand';

export type DragKind = 'hand' | 'board' | 'shop';

export interface Grab {
  kind: DragKind;
  index: number;
  /** Source card box in viewport coordinates — used for the fly-back animation. */
  rect: { x: number; y: number; w: number; h: number };
  /** Grab point relative to the card's top-left, so the card is held where you grabbed it. */
  dx: number;
  dy: number;
  fromX: number;
  fromY: number;
  moved: boolean;
}

export type Hit =
  | { kind: 'none' }
  /** `slot` = insertion index (0..n), `card` = minion under the pointer (null over the row's empty space). */
  | { kind: 'board'; slot: number; card: number | null }
  | { kind: 'shop'; slot: number }
  | { kind: 'hand' }
  | { kind: 'sell' };

export const NO_HIT: Hit = { kind: 'none' };

interface DragStore {
  grab: Grab | null;
  hit: Hit;
  /** True while the ghost is animating back to its source after a rejected drop. */
  returning: boolean;
  begin: (g: Grab) => void;
  setHit: (h: Hit) => void;
  setReturning: (v: boolean) => void;
  end: () => void;
}

export const useDrag = create<DragStore>((set) => ({
  grab: null,
  hit: NO_HIT,
  returning: false,
  begin: (g) => set({ grab: g, hit: NO_HIT, returning: false }),
  setHit: (h) => set({ hit: h }),
  setReturning: (v) => set({ returning: v }),
  end: () => set({ grab: null, hit: NO_HIT, returning: false }),
}));
