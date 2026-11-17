import React, { useEffect, useState } from 'react';
import { useStore } from '../store';
import type { CardRef } from '../types';
import { art, cardName } from '../lib/assets';
import { useCardTooltip } from '../components/Cards';
import { EditableBox } from '../components/EditableBox';
import { featureEnabled, registerFeature, useCapabilities } from './registry';

/**
 * Trinkets: the two rings next to the hero (lesser then greater).
 *
 * The feature is registered with `capability: 'trinkets'`; when a future
 * profile switches trinkets out, this module stops rendering and its two layout
 * boxes disappear from the table *and* from the layout editor, without touching
 * the rest of the HUD.
 */
export const TRINKETS = registerFeature({
  id: 'trinkets',
  label: '饰品',
  capability: 'trinkets',
  boxes: ['trinketGreater', 'trinketLesser'],
  pendingKinds: ['trinket'],
});

function TrinketIcon({ card }: { card: CardRef }) {
  const { show, hide, node } = useCardTooltip();
  // A transformed trinket changes id under us; if its art is not in the pack
  // fall back to the full card render rather than showing a bare ring.
  const [fallback, setFallback] = useState(false);
  useEffect(() => setFallback(false), [card.id]);
  const src = fallback ? art.render(card.id) : art.portrait(card.id);
  return (
    <div className="trinket-icon" onMouseEnter={(e) => show(e, card)} onMouseLeave={hide}>
      {node}
      {/* Plain art disc like the hero power, not the whole trinket card face. */}
      <img src={src} alt={cardName(card)} draggable={false} onError={() => setFallback(true)} />
    </div>
  );
}

/**
 * One trinket ring next to the hero. Before the trinket is taken the real table
 * shows the empty socket, so we do too instead of nothing at all.
 */
function TrinketSlot({ card, kind }: { card?: CardRef; kind: 'greater' | 'lesser' }) {
  if (!card) {
    return (
      <div className={`trinket-empty ${kind}`} title={kind === 'greater' ? '大饰品槽（未解锁）' : '小饰品槽（未解锁）'}>
        <span className="trinket-star" aria-hidden="true">
          ✦
        </span>
      </div>
    );
  }
  return (
    <div className="trinket-icons">
      <TrinketIcon card={card} />
    </div>
  );
}

export function TrinketSlots() {
  const me = useStore((s) => s.view?.me);
  const caps = useCapabilities();
  if (!me || !featureEnabled(TRINKETS, caps)) return null;
  // Slots follow acquisition order (lesser first, then greater), NOT the card's
  // own `kind`: a trinket that transforms in place keeps the ring it was bought
  // for and shows its new form.
  const [lesserTrinket, greaterTrinket] = me.trinkets ?? [];
  return (
    <>
      <EditableBox id="trinketGreater" className="trinket-greater trinket-slot">
        <TrinketSlot card={greaterTrinket} kind="greater" />
      </EditableBox>
      <EditableBox id="trinketLesser" className="trinket-lesser trinket-slot">
        <TrinketSlot card={lesserTrinket} kind="lesser" />
      </EditableBox>
    </>
  );
}
