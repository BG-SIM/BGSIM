// FLIP ("first, last, invert, play") for the board rows.
//
// Every layout change on the table used to be a hard jump: buying removed a
// tavern card and re-centred the row, playing a card re-centred the board. We
// snapshot the card positions right before the store swaps in the new view and
// then animate each surviving card from where it was to where it is now.
//
// Cards that did not exist before are flown in from the place the player last
// touched (the tavern slot they bought from, the hand card they played), so a
// purchase reads as "this card went from there to here" instead of blinking.
//
// Implemented with the Web Animations API so nothing re-renders and no extra
// dependency is needed.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

let prev = new Map<string, DOMRect>();

/** Where the card that is about to appear should fly in from (FIFO, one per action). */
let flights: { rect: Rect; at: number }[] = [];

/** Forget a queued flight if the action it belonged to never landed. */
const FLIGHT_TTL = 1200;

type Root = Document | HTMLElement;

function cards(root: Root): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('[data-flip-key]'));
}

/** Call immediately BEFORE the state (and therefore the DOM) changes. */
export function captureRects(root: Root = document): void {
  prev = new Map();
  for (const el of cards(root)) {
    const key = el.dataset.flipKey;
    if (key) prev.set(key, el.getBoundingClientRect());
  }
}

/**
 * Remember where the next brand-new card should come from. Call it right before
 * dispatching the buy/play action.
 */
export function queueFlightFrom(rect: Rect | DOMRect): void {
  const r = 'width' in rect ? { x: rect.x, y: rect.y, w: rect.width, h: rect.height } : rect;
  const now = performance.now();
  flights = flights.filter((f) => now - f.at < FLIGHT_TTL);
  flights.push({ rect: r, at: now });
}

function takeFlightFrom(): Rect | null {
  const now = performance.now();
  const next = flights.shift();
  if (!next) return null;
  return now - next.at > FLIGHT_TTL ? null : next.rect;
}

/** Call right after the DOM updated (a layout effect). */
export function playFlip(root: Root = document): void {
  const from = takeFlightFrom();
  let flighted = false;

  for (const el of cards(root)) {
    const key = el.dataset.flipKey;
    if (!key) continue;
    const now = el.getBoundingClientRect();

    if (!prev.has(key)) {
      // Brand new card.
      if (from && !flighted) {
        flighted = true;
        el.animate(
          [
            {
              transformOrigin: '0 0',
              transform: `translate(${from.x - now.left}px, ${from.y - now.top}px) scale(${from.w / Math.max(1, now.width)}, ${from.h / Math.max(1, now.height)})`,
              opacity: 0.9,
            },
            { transformOrigin: '0 0', transform: 'none', opacity: 1 },
          ],
          { duration: 300, easing: 'cubic-bezier(.2,.8,.2,1)' },
        );
      } else {
        el.animate(
          [
            { opacity: 0, transform: 'translateY(12px) scale(0.9)' },
            { opacity: 1, transform: 'none' },
          ],
          { duration: 190, easing: 'cubic-bezier(.2,.8,.2,1)' },
        );
      }
      continue;
    }

    const before = prev.get(key)!;
    const dx = before.left - now.left;
    const dy = before.top - now.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], {
      duration: 190,
      easing: 'cubic-bezier(.2,.8,.2,1)',
    });
  }
}

/** Rect of a card that appeared in the latest update. */
export function newcomerRect(root: Root = document): DOMRect | null {
  for (const el of cards(root)) {
    const key = el.dataset.flipKey;
    if (key && !prev.has(key)) return el.getBoundingClientRect();
  }
  return null;
}
