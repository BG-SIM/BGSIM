import { useStore } from '../store';

/**
 * Feature registry — the UI half of a ruleset profile.
 *
 * A rotating mechanic (trinkets, dark gifts, timewarp, aberrations...) is a
 * feature that declares what it owns: the layout boxes it draws, the pending
 * kinds it handles, the cards/actions it introduces. A profile switches the
 * capability off, the registry stops mounting the feature, and nothing has to
 * be deleted when the mechanic leaves the game.
 *
 * Nothing is registered yet: this commit only lays the plumbing down so the
 * first feature can be extracted without touching the rest of the tree.
 */

export type Capabilities = Record<string, boolean>;

export interface Feature {
  /** Stable id, also used by tests and the layout editor. */
  id: string;
  /** Human label (Chinese) for the layout editor / feature list. */
  label: string;
  /**
   * Capability key this feature needs. A missing key means "no gating"; a
   * `false` capability hides the feature.
   */
  capability?: string;
  /** Editable layout boxes the feature owns, in `ELEMENT_NAMES` keys. */
  boxes?: string[];
  /** Pending kinds this feature knows how to render/handle. */
  pendingKinds?: string[];
}

const REGISTRY: Feature[] = [];

export function registerFeature(feature: Feature): Feature {
  if (!REGISTRY.some((f) => f.id === feature.id)) REGISTRY.push(feature);
  return feature;
}

export function allFeatures(): readonly Feature[] {
  return REGISTRY;
}

/** Is this feature allowed to mount under the given capabilities? */
export function featureEnabled(feature: Feature, caps: Capabilities | undefined): boolean {
  if (!feature.capability) return true;
  return caps?.[feature.capability] !== false;
}

export function activeFeatures(caps: Capabilities | undefined): Feature[] {
  return REGISTRY.filter((f) => featureEnabled(f, caps));
}

/** Layout boxes owned by features the current profile switched off. */
export function hiddenBoxes(caps: Capabilities | undefined): Set<string> {
  const hidden = new Set<string>();
  for (const f of REGISTRY) {
    if (f.boxes && !featureEnabled(f, caps)) for (const b of f.boxes) hidden.add(b);
  }
  return hidden;
}

/** The capabilities the current match advertises (`undefined` = all on). */
export function useCapabilities(): Capabilities {
  return useStore((s) => s.view?.caps) ?? {};
}

/** Convenience: `useCapability('trinkets')` -> false only when explicitly off. */
export function useCapability(key: string): boolean {
  const caps = useCapabilities();
  return caps[key] !== false;
}
