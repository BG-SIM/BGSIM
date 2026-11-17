import React, { useCallback, useEffect, useRef } from 'react';
import { useStore } from '../store';
import { useTargeting } from '../store/targeting';

/** `${zone}:${slot}` for the highlighted slot under the pointer. */
function slotKeyAt(el: Element | null): string | null {
  const slot = el?.closest('[data-slot-zone]');
  if (!slot) return null;
  const zone = slot.getAttribute('data-slot-zone');
  const index = slot.getAttribute('data-slot-index');
  return zone && index !== null ? `${zone}:${index}` : null;
}

/**
 * Slay-the-Spire-style aiming for targeted hero powers (and any card that opens
 * a target picker): press the source, drag, release on a highlighted target.
 *
 * A quick click without dragging still works — the aim stays live in
 * "hover mode" until the player clicks a target, cancels, or the power turns out
 * not to need one.
 */
export function useTargetAim() {
  const active = useTargeting((s) => s.active);
  const mode = useTargeting((s) => s.mode);
  const pending = useStore((s) => s.view?.me.pending);
  const targets = pending?.kind === 'target' ? pending.targets : null;
  const targetsRef = useRef(targets);
  targetsRef.current = targets;

  /** Guards against the trailing `click` after a drag-release casting twice. */
  const consumed = useRef(false);

  const cast = useCallback(
    (key: string | null) => {
      const list = targetsRef.current;
      if (!list || !key) return false;
      const hit = list.find((t) => `${t.location.zone}:${t.location.slot}` === key);
      if (!hit) return false;
      consumed.current = true;
      useTargeting.getState().stop();
      useTargeting.getState().flash(key);
      void useStore.getState().act(hit.action);
      return true;
    },
    [],
  );

  const cancel = useCallback(() => {
    useTargeting.getState().stop();
    const view = useStore.getState().view;
    if (view && targetsRef.current && view.legal.includes(view.actions.CANCEL)) {
      void useStore.getState().act(view.actions.CANCEL);
    }
  }, []);

  useEffect(() => {
    if (!active) {
      consumed.current = false;
      return;
    }
    const onMove = (e: PointerEvent) => {
      const key = slotKeyAt(document.elementFromPoint(e.clientX, e.clientY));
      // `aim` mode only counts slots the engine actually offers; while dragging a
      // hand spell the drop rules decide, so any slot is a candidate.
      const legal =
        key !== null &&
        (mode === 'drag' ||
          (targetsRef.current?.some((t) => `${t.location.zone}:${t.location.slot}` === key) ?? false));
      useTargeting.getState().move({ x: e.clientX, y: e.clientY }, legal ? key : null);
    };
    const onUp = () => {
      const state = useTargeting.getState();
      if (!state.pressed) return;
      state.release();
      if (state.mode === 'drag') {
        // The drop handler plays the card; the arrow just goes away.
        state.stop();
        return;
      }
      if (consumed.current) return;
      // Released before the engine even answered: keep the aim alive so the
      // player can just click a target. Otherwise: target → cast, elsewhere → cancel.
      if (!targetsRef.current) return;
      if (!cast(state.hover)) cancel();
    };
    const onClick = (e: MouseEvent) => {
      // Hover mode only (button already released) — a drag-release lands here too,
      // which `consumed` filters out.
      if (useTargeting.getState().pressed || consumed.current) return;
      const key = slotKeyAt(e.target as Element | null);
      if (!key) return;
      e.preventDefault();
      e.stopPropagation();
      cast(key);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancel();
    };
    const onBlur = () => cancel();

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('click', onClick, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('click', onClick, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', onBlur);
    };
  }, [active, cast, cancel]);

  // The power answered without asking for a target (buff self, refresh, …):
  // end the aim as soon as the action has come back. Only `aim` mode fired an
  // action on press — a dragged hand spell has no pending until it is dropped.
  const busy = useStore((s) => s.busy);
  useEffect(() => {
    if (!active || busy) return;
    if (mode !== 'aim') return;
    if (!pending || pending.kind !== 'target') useTargeting.getState().stop();
  }, [active, busy, pending, mode]);

  /** Start aiming from an element's centre, firing the action that opens the picker. */
  const begin = useCallback((e: React.PointerEvent, action: number) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    consumed.current = false;
    useTargeting.getState().start({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    void useStore.getState().act(action);
  }, []);

  return { begin };
}

/** True when this slot is a legal target right now (drives the glow). */
export function useTargetHighlights(): Set<string> {
  const pending = useStore((s) => s.view?.me.pending);
  const set = new Set<string>();
  if (pending?.kind === 'target') {
    for (const t of pending.targets) set.add(`${t.location.zone}:${t.location.slot}`);
  }
  return set;
}
