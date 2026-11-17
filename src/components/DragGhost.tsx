import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../store';
import { useDrag } from '../store/drag';
import { MinionCard, RenderCard } from './Cards';
import { dragPointer } from '../lib/pointerDrag';
import type { Item } from '../types';

/**
 * The card under the cursor while dragging.
 *
 * Rendered as the real card (not a little chip) and positioned imperatively on
 * every animation frame — putting the pointer coordinates in React state would
 * re-render the whole tavern 60 times a second.
 */
export function DragGhost() {
  const grab = useDrag((s) => s.grab);
  const returning = useDrag((s) => s.returning);
  const view = useStore((s) => s.view);
  const ref = useRef<HTMLDivElement>(null);

  // Follow the pointer.
  useEffect(() => {
    if (!grab || returning) return;
    let raf = 0;
    const place = () => {
      const el = ref.current;
      if (el) {
        el.style.transform =
          `translate3d(${dragPointer.x - grab.dx}px, ${dragPointer.y - grab.dy}px, 0) rotate(-2.4deg) scale(1.04)`;
      }
      raf = requestAnimationFrame(place);
    };
    place();
    return () => cancelAnimationFrame(raf);
  }, [grab, returning]);

  // Rejected drop: fly home instead of blinking out of existence.
  useEffect(() => {
    if (!grab || !returning) return;
    const el = ref.current;
    if (!el) {
      useDrag.getState().end();
      return;
    }
    const anim = el.animate(
      [
        { transform: el.style.transform || 'none', opacity: 1 },
        { transform: `translate3d(${grab.rect.x}px, ${grab.rect.y}px, 0) rotate(0deg) scale(1)`, opacity: 0.15 },
      ],
      { duration: 170, easing: 'cubic-bezier(.2,.8,.2,1)' },
    );
    anim.onfinish = () => useDrag.getState().end();
    return () => {
      anim.onfinish = null;
      anim.cancel();
    };
  }, [grab, returning]);

  if (!grab || !view) return null;

  const card =
    grab.kind === 'hand'
      ? view.me.hand[grab.index]
      : grab.kind === 'board'
        ? view.me.board[grab.index]
        : view.me.shop[grab.index];
  if (!card) return null;

  // Hand cards are flat card renders, board/shop minions are the composited
  // frame — keep the ghost identical to what was grabbed so nothing "changes
  // shape" the moment you pick it up.
  const flat = grab.kind === 'hand' || (card as Item).type === 'spell';
  const scale = grab.rect.w / 168;

  return createPortal(
    <div className="drag-card" ref={ref}>
      {flat ? (
        <RenderCard card={card as Item} width={grab.rect.w} height={grab.rect.h} fit="cover" />
      ) : (
        <MinionCard card={card} scale={scale} interactive={false} />
      )}
    </div>,
    document.body,
  );
}
