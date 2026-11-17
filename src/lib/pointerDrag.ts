// Pointer-based card dragging.
//
// Replaces the native HTML5 drag & drop: the browser only reports `dragover`
// about 13 times per second, so a ghost driven by it visibly lags (measured
// ~31ms median gap, 60ms p90). Pointer events fire at input rate, so we can
// follow the cursor on every animation frame, anchor the card exactly where it
// was grabbed, animate a rejected drop back to its source, and keep working on
// touch/pen.
import React from 'react';
import { NO_HIT, useDrag, type DragKind, type Grab, type Hit } from '../store/drag';
import { sfx } from './sfx';

/** Movement (px) before a press becomes a drag instead of a click. */
export const DRAG_THRESHOLD = 4;

/** Live pointer position — written every frame, deliberately outside React. */
export const dragPointer = { x: 0, y: 0 };

let suppressUntil = 0;

/**
 * A native `click` still fires after pointer-up even when the pointer travelled
 * across the board, and with pointer capture it lands on the *source* card —
 * that would buy/play a card you just dragged somewhere else. Swallow it once.
 */
export function isDragClick(): boolean {
  if (performance.now() > suppressUntil) return false;
  suppressUntil = 0;
  return true;
}

/** Wrap an onClick so the click trailing a drag is ignored. */
export function tap(fn: () => void) {
  return () => {
    if (isDragClick()) return;
    fn();
  };
}

/** Insertion index for a horizontal card row. */
function rowInsertSlot(row: HTMLElement, x: number): number {
  const cards = Array.from(row.querySelectorAll<HTMLElement>('[data-slot-zone]'));
  for (let i = 0; i < cards.length; i++) {
    const r = cards[i].getBoundingClientRect();
    if (x < r.left + r.width / 2) return i;
  }
  return cards.length;
}

/** Resolve what sits under the pointer for the thing currently being dragged. */
export function hitTest(x: number, y: number, kind: DragKind): Hit {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  if (!el) return NO_HIT;

  const slotEl = el.closest<HTMLElement>('[data-slot-zone]');
  if (slotEl) {
    const zone = slotEl.dataset.slotZone;
    const slot = Number(slotEl.dataset.slotIndex ?? -1);
    if (zone === 'board') {
      const r = slotEl.getBoundingClientRect();
      return { kind: 'board', slot: x < r.left + r.width / 2 ? slot : slot + 1, card: slot };
    }
    if (zone === 'shop') return { kind: 'shop', slot };
    if (zone === 'hand') return { kind: 'hand' };
  }

  // The tavern area doubles as the "sell" drop zone when dragging a board minion.
  if (kind === 'board' && el.closest('[data-drop="sell"]')) return { kind: 'sell' };

  const row = el.closest<HTMLElement>('[data-row]');
  const name = row?.dataset.row;
  if (name === 'board') return { kind: 'board', slot: rowInsertSlot(row!, x), card: null };
  if (name === 'hand') return { kind: 'hand' };
  if (name === 'shop') return kind === 'board' ? { kind: 'sell' } : NO_HIT;
  return NO_HIT;
}

/**
 * Attach the pointer lifecycle for a card. `drop` decides what the gesture
 * means and returns whether it was accepted; rejected drops fly back.
 */
export function startDrag(
  e: React.PointerEvent,
  kind: DragKind,
  index: number,
  drop: (grab: Grab, hit: Hit) => boolean,
  /** The card to drag, when the event did not come from it (geometric hand fan). */
  source?: HTMLElement,
): void {
  if (e.button !== 0 || !e.isPrimary) return;
  const el = source ?? (e.currentTarget as HTMLElement);
  const box = el.getBoundingClientRect();
  // Drag the *natural* card, never an enlarged one — a 1.5x card is hard to
  // slot between two minions. `offsetWidth` is immune to the hover scale.
  const w = el.offsetWidth || box.width;
  const h = el.offsetHeight || box.height;
  // Anchor on the card's centre: a rotated element's bounding-box centre is
  // still its centre, so the grab point stays under the cursor without having
  // to invert the fan transform.
  const body = el.querySelector<HTMLElement>('[data-grab-body]');
  const b = body ? body.getBoundingClientRect() : box;
  const dx = w / 2 + (e.clientX - (b.x + b.width / 2));
  const dy = h / 2 + (e.clientY - (b.y + b.height / 2));
  const grab: Grab = {
    kind,
    index,
    rect: { x: e.clientX - dx, y: e.clientY - dy, w, h },
    dx,
    dy,
    fromX: e.clientX,
    fromY: e.clientY,
    moved: false,
  };
  const pointerId = e.pointerId;

  let raf = 0;
  let last: PointerEvent | null = null;
  let lastKey = '';

  const frame = () => {
    raf = 0;
    if (!last) return;
    dragPointer.x = last.clientX;
    dragPointer.y = last.clientY;
    const h = hitTest(last.clientX, last.clientY, kind);
    const key = JSON.stringify(h);
    if (key !== lastKey) {
      lastKey = key;
      useDrag.getState().setHit(h);
    }
  };

  const onMove = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return;
    if (!grab.moved) {
      if (Math.hypot(ev.clientX - grab.fromX, ev.clientY - grab.fromY) < DRAG_THRESHOLD) return;
      grab.moved = true;
      dragPointer.x = ev.clientX;
      dragPointer.y = ev.clientY;
      useDrag.getState().begin(grab);
      document.body.classList.add('is-dragging');
    }
    last = ev;
    if (!raf) raf = requestAnimationFrame(frame);
  };  const onUp = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return;
    cleanup();
    if (!grab.moved) return; // below the threshold: let the native click do its job
    suppressUntil = performance.now() + 400;
    dragPointer.x = ev.clientX;
    dragPointer.y = ev.clientY;
    const accepted = drop(grab, hitTest(ev.clientX, ev.clientY, kind));
    if (accepted) useDrag.getState().end();
    else {
      sfx('invalid');
      useDrag.getState().setReturning(true);
    }
  };

  const cancel = (fireBack: boolean) => {
    cleanup();
    if (!grab.moved) return;
    suppressUntil = performance.now() + 400;
    if (fireBack) useDrag.getState().setReturning(true);
    else useDrag.getState().end();
  };

  const onCancel = () => cancel(true);
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key !== 'Escape') return;
    ev.preventDefault();
    ev.stopPropagation();
    cancel(true);
  };
  const onContext = (ev: MouseEvent) => {
    if (!grab.moved) return;
    ev.preventDefault();
    ev.stopPropagation();
    cancel(true);
  };
  // Without pointer capture the browser can drop the release if it happens
  // outside the window, so cancel on the way out.
  const onBlur = () => cancel(true);
  const onLeaveDoc = (ev: PointerEvent) => {
    if (ev.pointerType === 'mouse' && !ev.relatedTarget) cancel(true);
  };

  function cleanup() {
    removeEventListener('pointermove', onMove);
    removeEventListener('pointerup', onUp);
    removeEventListener('pointercancel', onCancel);
    removeEventListener('keydown', onKey, true);
    removeEventListener('contextmenu', onContext, true);
    removeEventListener('blur', onBlur);
    removeEventListener('pointerleave', onLeaveDoc);
    document.body.classList.remove('is-dragging');
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  }

  addEventListener('pointermove', onMove, { passive: true });
  addEventListener('pointerup', onUp);
  addEventListener('pointercancel', onCancel);
  addEventListener('keydown', onKey, true);
  addEventListener('contextmenu', onContext, true);
  addEventListener('blur', onBlur);
  addEventListener('pointerleave', onLeaveDoc);
  // NOTE: deliberately no setPointerCapture. Capturing retargets the trailing
  // `click` to the captured element, which silently killed every click handler
  // that lives on a child (e.g. clicking a board minion to 发动, or the
  // "出售 +1" chip).
}
