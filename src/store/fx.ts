import { create } from 'zustand';

interface FxState {
  fx: { id: number; text: string; sub: string } | null;
  show: (text: string, sub?: string) => void;
  clear: () => void;
}

let timer: number | undefined;

export const useFx = create<FxState>((set) => ({
  fx: null,
  show: (text, sub = '发动') => {
    const id = Date.now();
    set({ fx: { id, text, sub } });
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(() => set({ fx: null }), 1200);
  },
  clear: () => set({ fx: null }),
}));
