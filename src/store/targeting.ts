import { create } from 'zustand';

export interface AimPoint {
  x: number;
  y: number;
}

/**
 * Aiming state for a targeted hero power / spell, drawn like Slay the Spire:
 * press the source, drag a curve to the target, release on it to cast.
 *
 * Coordinates are viewport (client) pixels; the arrow layer is a fixed overlay,
 * so it does not care about the scaled `.stage`.
 */
interface TargetingState {
  active: boolean;
  /**
   * `aim` — a targeted power: it already fired, releasing casts or cancels.
   * `drag` — a hand spell being dragged: the drop itself plays the card, the
   *          arrow is only the visual guide.
   */
  mode: 'aim' | 'drag';
  origin: AimPoint | null;
  cursor: AimPoint | null;
  /** The `data-target="board:3"` key under the pointer, if any. */
  hover: string | null;
  /** True while the mouse button is still held (drag mode). */
  pressed: boolean;
  /** Slot that was just cast on — drives a short flash. */
  castAt: string | null;
  start: (origin: AimPoint, mode?: 'aim' | 'drag') => void;
  move: (cursor: AimPoint, hover: string | null) => void;
  release: () => void;
  flash: (key: string) => void;
  stop: () => void;
}

export const useTargeting = create<TargetingState>((set) => ({
  active: false,
  mode: 'aim',
  origin: null,
  cursor: null,
  hover: null,
  pressed: false,
  castAt: null,
  start: (origin, mode = 'aim') => set({ active: true, mode, origin, cursor: origin, hover: null, pressed: true }),
  move: (cursor, hover) => set((s) => (s.active ? { cursor, hover } : {})),
  release: () => set({ pressed: false }),
  flash: (key) => {
    set({ castAt: key });
    window.setTimeout(() => set((s) => (s.castAt === key ? { castAt: null } : {})), 620);
  },
  stop: () => set({ active: false, origin: null, cursor: null, hover: null, pressed: false }),
}));
