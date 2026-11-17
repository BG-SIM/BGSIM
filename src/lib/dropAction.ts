// What happens when a dragged card is released. Kept in one place so the three
// rows do not each grow their own copy of the rules (and disagree).
import { useStore } from '../store';
import type { Grab, Hit } from '../store/drag';
import { queueFlightFrom } from './flip';
import { magnetizeAction } from './magnet';
import { sfx } from './sfx';

const N_BOARD = 7;

/** Returns true when the drop was accepted (otherwise the ghost flies back). */
export function resolveDrop(grab: Grab, hit: Hit): boolean {
  const st = useStore.getState();
  const view = st.view;
  if (!view || !hit) return false;
  const me = view.me;
  const A = view.actions;

  /* ── 从战场拖出 ─────────────────────────────────────────────── */
  if (grab.kind === 'board') {
    const minion = me.board[grab.index];
    if (!minion) return false;

    if (hit.kind === 'sell' || hit.kind === 'shop') {
      if (!view.legal.includes(A.SELL + grab.index)) {
        st.toast('现在无法出售', 'error');
        return false;
      }
      sfx('sell');
      void st.sell(minion.eid);
      return true;
    }

    if (hit.kind === 'board') {
      // Dropped back roughly where it started: nothing to do.
      if (hit.slot === grab.index || hit.slot === grab.index + 1) return true;
      // The insertion slot counts the dragged minion itself, so shift it out.
      const to = Math.max(0, Math.min(N_BOARD - 1, hit.slot > grab.index ? hit.slot - 1 : hit.slot));
      sfx('place');
      void st.move(minion.eid, to);
      return true;
    }
    return false;
  }

  /* ── 从手牌拖出 ─────────────────────────────────────────────── */
  if (grab.kind === 'hand') {
    const item = me.hand[grab.index];
    if (!item) return false;

    if (item.type === 'spell') {
      if (hit.kind === 'board' && hit.card !== null) {
        sfx('discover');
        void st.playCard(grab.index, { hid: item.hid, target: { zone: 'board', slot: hit.card } });
        return true;
      }
      if (hit.kind === 'shop') {
        sfx('discover');
        void st.playCard(grab.index, { hid: item.hid, target: { zone: 'shop', slot: hit.slot } });
        return true;
      }
      if (hit.kind === 'board') {
        // Dropped on the empty part of the board: no target, just cast it.
        void st.playCard(grab.index, { hid: item.hid });
        return true;
      }
      return false;
    }

    if (hit.kind === 'board') {
      // Attach to the Mech on the right of the landing slot, if there is one —
      // same rule as the real game, whatever part of the board you aim at.
      const magnetize = magnetizeAction(view, grab.index, hit.slot);
      if (magnetize !== null) {
        sfx('upgrade');
        void st.act(magnetize);
        return true;
      }
      sfx('place');
      queueFlightFrom(grab.rect);
      void st.playCard(grab.index, { hid: item.hid, pos: Math.max(0, Math.min(N_BOARD - 1, hit.slot)) });
      return true;
    }
    return false;
  }

  /* ── 从酒馆拖出 ─────────────────────────────────────────────── */
  if (grab.kind === 'shop') {
    const item = me.shop[grab.index];
    if (!item) return false;
    // Dropping anywhere on the hand or the board buys it.
    if (hit.kind === 'hand' || hit.kind === 'board') {
      if (!view.legal.includes(A.BUY + grab.index)) {
        st.toast((item.price ?? 99) > me.gold ? '金币不足' : '现在无法购买这张牌', 'error');
        return false;
      }
      sfx('buy');
      queueFlightFrom(grab.rect);
      void st.buy(item.sid);
      return true;
    }
    return false;
  }

  return false;
}
