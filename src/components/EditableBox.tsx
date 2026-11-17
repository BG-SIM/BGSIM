import React, { useRef } from 'react';
import { useUiEditor } from '../store/uiEditor';
import { ELEMENT_NAMES } from '../lib/layout';

type Props = React.HTMLAttributes<HTMLDivElement> & {
  id: string;
  className?: string;
  children: React.ReactNode;
};

/** An absolutely positioned, editor-movable box. Outside edit mode it is just a positioned div. */
export function EditableBox({ id, className = '', children, style, ...rest }: Props) {
  const box = useUiEditor((s) => s.boxes[id]);
  const editMode = useUiEditor((s) => s.editMode);
  const selected = useUiEditor((s) => s.selected === id);
  const select = useUiEditor((s) => s.select);
  const setBox = useUiEditor((s) => s.setBox);
  const ref = useRef<HTMLDivElement>(null);

  const stageScale = () => {
    const stage = ref.current?.closest('.stage') as HTMLElement | null;
    if (!stage) return 1;
    const r = stage.getBoundingClientRect();
    return r.width / 1600 || 1;
  };

  const startDrag = (e: React.PointerEvent, mode: 'move' | 'resize') => {
    if (!editMode) return;
    e.preventDefault();
    e.stopPropagation();
    select(id);
    const scale = stageScale();
    const sx = e.clientX;
    const sy = e.clientY;
    const b0 = { ...box };
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - sx) / scale;
      const dy = (ev.clientY - sy) / scale;
      if (mode === 'move') {
        setBox(id, { x: Math.round(b0.x + dx), y: Math.round(b0.y + dy), w: b0.w, h: b0.h });
      } else {
        setBox(id, { x: b0.x, y: b0.y, w: Math.max(24, Math.round(b0.w + dx)), h: Math.max(18, Math.round(b0.h + dy)) });
      }
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  if (!box) return null;

  return (
    <div
      ref={ref}
      className={`${className}${editMode ? ' edit-box' : ''}${editMode && selected ? ' selected' : ''}`}
      style={{
        position: 'absolute',
        left: box.x,
        top: box.y,
        width: box.w,
        height: box.h,
        right: 'auto',
        bottom: 'auto',
        ...style,
      }}
      onPointerDown={editMode ? (e) => startDrag(e, 'move') : undefined}
      {...rest}
    >
      {children}
      {editMode && (
        <>
          <div className="edit-label">
            {ELEMENT_NAMES[id] ?? id} · {box.x},{box.y} · {box.w}×{box.h}
          </div>
          <div className="edit-handle" onPointerDown={(e) => startDrag(e, 'resize')} />
        </>
      )}
    </div>
  );
}
