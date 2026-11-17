import { create } from 'zustand';
import {
  DEFAULT_GAPS,
  DEFAULT_HAND_ARC,
  DEFAULT_LAYOUT,
  DEFAULT_SCALES,
  LAYOUT_STORAGE_KEY,
  type Box,
  type CardScales,
  type Gaps,
  type Layout,
} from '../lib/layout';

interface Persisted {
  boxes?: Layout;
  scales?: CardScales;
  gaps?: Gaps;
}

function loadSaved(): Persisted {
  try {
    const raw = localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Persisted;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function persist(boxes: Layout, scales: CardScales, gaps: Gaps) {
  try {
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify({ boxes, scales, gaps }));
  } catch {
    /* ignore */
  }
}

const saved = loadSaved();

function mergeBoxes(partial?: Layout): Layout {
  const boxes: Layout = { ...DEFAULT_LAYOUT };
  if (partial) {
    for (const key of Object.keys(DEFAULT_LAYOUT)) {
      if (partial[key]) boxes[key] = partial[key];
    }
  }
  return boxes;
}

interface UiEditorStore {
  editMode: boolean;
  boxes: Layout;
  scales: CardScales;
  gaps: Gaps;
  selected: string | null;
  showGrid: boolean;
  stageScale: number;
  handArc: number;
  enter: () => void;
  exit: () => void;
  select: (id: string | null) => void;
  setBox: (id: string, box: Box) => void;
  setScale: (key: keyof CardScales, value: number) => void;
  setGap: (key: keyof Gaps, value: number) => void;
  resetBox: (id: string) => void;
  resetAll: () => void;
  load: (data: { boxes?: Layout; scales?: CardScales; gaps?: Gaps }) => void;
  toggleGrid: () => void;
  setStageScale: (s: number) => void;
  setHandArc: (v: number) => void;
  exportJson: () => string;
}

export const useUiEditor = create<UiEditorStore>((set, get) => ({
  editMode: false,
  boxes: mergeBoxes(saved.boxes),
  scales: { ...DEFAULT_SCALES, ...(saved.scales ?? {}) },
  gaps: { ...DEFAULT_GAPS, ...(saved.gaps ?? {}) },
  selected: 'shopRow',
  showGrid: true,
  stageScale: 1,
  handArc: Number(localStorage.getItem('bgsim.handArc.v2') ?? String(DEFAULT_HAND_ARC)) || DEFAULT_HAND_ARC,

  enter: () => set({ editMode: true }),
  exit: () => set({ editMode: false }),
  select: (id) => set({ selected: id }),
  setBox: (id, box) => {
    const boxes = { ...get().boxes, [id]: box };
    set({ boxes });
    persist(boxes, get().scales, get().gaps);
  },
  setScale: (key, value) => {
    const scales = { ...get().scales, [key]: value };
    set({ scales });
    persist(get().boxes, scales, get().gaps);
  },
  setGap: (key, value) => {
    const gaps = { ...get().gaps, [key]: value };
    set({ gaps });
    persist(get().boxes, get().scales, gaps);
  },
  resetBox: (id) => {
    const boxes = { ...get().boxes, [id]: DEFAULT_LAYOUT[id] };
    set({ boxes });
    persist(boxes, get().scales, get().gaps);
  },
  resetAll: () => {
    set({ boxes: { ...DEFAULT_LAYOUT }, scales: { ...DEFAULT_SCALES }, gaps: { ...DEFAULT_GAPS }, handArc: DEFAULT_HAND_ARC });
    persist(DEFAULT_LAYOUT, DEFAULT_SCALES, DEFAULT_GAPS);
  },
  load: (data) => {
    const boxes = mergeBoxes(data.boxes);
    const scales = { ...DEFAULT_SCALES, ...(data.scales ?? {}) };
    const gaps = { ...DEFAULT_GAPS, ...(data.gaps ?? {}) };
    set({ boxes, scales, gaps });
    persist(boxes, scales, gaps);
  },
  toggleGrid: () => set({ showGrid: !get().showGrid }),
  setStageScale: (s) => set({ stageScale: s }),
  setHandArc: (v) => {
    set({ handArc: v });
    try { localStorage.setItem('bgsim.handArc.v2', String(v)); } catch { /* ignore */ }
  },
  exportJson: () => JSON.stringify({ boxes: get().boxes, scales: get().scales, gaps: get().gaps, handArc: get().handArc }, null, 2),
}));
