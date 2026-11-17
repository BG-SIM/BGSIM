import React from 'react';
import { createPortal } from 'react-dom';
import { useTargeting } from '../store/targeting';

/**
 * The aiming curve: a quadratic arc from the pressed hero power (or card) to
 * the pointer, with an arrow head on the tip. Gold when it is over a legal
 * target, pale otherwise. Rendered in a fixed overlay above the board.
 */
export function TargetArrow() {
  const { active, origin, cursor, hover, pressed } = useTargeting();
  if (!active || !origin || !cursor) return null;

  const dx = cursor.x - origin.x;
  const dy = cursor.y - origin.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 8) return null;

  // Bow the curve to the right of the travel direction, the way a hand-drawn
  // pointer arc reads better than a straight line.
  const nx = -dy / dist;
  const ny = dx / dist;
  const bow = Math.min(90, dist * 0.28);
  const cx = (origin.x + cursor.x) / 2 + nx * bow;
  const cy = (origin.y + cursor.y) / 2 + ny * bow;

  // Arrow head along the tangent at the end point.
  let tx = cursor.x - cx;
  let ty = cursor.y - cy;
  const tl = Math.hypot(tx, ty) || 1;
  tx /= tl;
  ty /= tl;
  const size = 15;
  const ax = cursor.x - tx * size;
  const ay = cursor.y - ty * size;
  const spread = 9;
  const p1 = `${ax + ty * spread},${ay - tx * spread}`;
  const p2 = `${ax - ty * spread},${ay + tx * spread}`;

  const valid = Boolean(hover);

  return createPortal(
    <svg className={'target-arrow' + (valid ? ' valid' : '') + (pressed ? '' : ' released')} xmlns="http://www.w3.org/2000/svg">
      <path className="target-arrow-path" d={`M ${origin.x} ${origin.y} Q ${cx} ${cy} ${cursor.x} ${cursor.y}`} />
      <circle className="target-arrow-root" cx={origin.x} cy={origin.y} r={7} />
      <polygon className="target-arrow-head" points={`${cursor.x},${cursor.y} ${p1} ${p2}`} />
    </svg>,
    document.body,
  );
}
