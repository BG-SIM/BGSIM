import React from 'react';
import { useStore } from '../store';
import { useUiEditor } from '../store/uiEditor';
import { EditableBox } from '../components/EditableBox';
import { featureEnabled, registerFeature, useCapabilities } from './registry';

/**
 * Dark Gift: the round button in the tavern corner and its use counter.
 *
 * Gated by `capability: 'darkGift'`; when a profile rotates the mechanic out,
 * the button, its layout box and its editor entry all disappear while the
 * engine keeps the code (the profile just raises `dark_gift_unlock_turn`).
 */
export const DARK_GIFT = registerFeature({
  id: 'darkGift',
  label: '黑暗之赐',
  capability: 'darkGift',
  boxes: ['giftButton'],
});

export function DarkGiftButton() {
  const me = useStore((s) => s.view?.me);
  const actions = useStore((s) => s.view?.actions);
  const act = useStore((s) => s.act);
  const editMode = useUiEditor((s) => s.editMode);
  const caps = useCapabilities();
  const gift = me?.darkGift;
  if (!me || !actions || !gift || !featureEnabled(DARK_GIFT, caps)) return null;
  // Unlock turn / uses left / layout editing are the three reasons to draw it.
  if (!gift.available && gift.uses <= 0 && !editMode) return null;
  return (
    <EditableBox id="giftButton" className="gift-slot">
      <button
        className="round-btn gift-btn"
        onClick={() => act(actions.DARK_GIFT)}
        disabled={!gift.available}
        title="黑暗之赐"
      >
        <span className="round-icon">✦</span>
        <span className="round-cost gift-progress">{`${gift.uses}/${gift.max_uses}`}</span>
        <span className="round-label">黑暗之赐</span>
      </button>
    </EditableBox>
  );
}
