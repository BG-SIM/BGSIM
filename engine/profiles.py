"""Ruleset profiles: which mechanics a match runs.

A profile is the single source of truth for a game version.  It carries two
things:

* ``config`` — the engine config overrides that actually switch the mechanic on
  or off (the engine's ``default_config_json`` already exposes knobs such as
  ``timewarp_enabled``, ``lesser_trinket_turn`` and ``dark_gift_unlock_turn``);
* ``capabilities`` — what the client is allowed to show.

Rotating a mechanic out of the game means flipping it off here.  No feature code
is deleted, so an older profile can turn it back on and a future build can drop
the mechanic without the UI exploding.
"""

from __future__ import annotations

SHIPPING = "shipping"
LAB = "lab"
VANILLA = "vanilla"

CAPABILITIES = ("trinkets", "darkGift", "aberration", "timewarp", "quests")

PROFILES: dict[str, dict] = {
    SHIPPING: {
        "id": SHIPPING,
        "label": "当前正式版本",
        "capabilities": {
            "trinkets": True,
            "darkGift": True,
            "aberration": True,
            "timewarp": False,
            "quests": True,
        },
        # The engine still ships the mechanic, the live ruleset just never opens
        # the timewarp tavern.
        "config": {"timewarp_enabled": False},
    },
    LAB: {
        "id": LAB,
        "label": "实验场（全部机制打开）",
        "capabilities": {key: True for key in CAPABILITIES},
        # Used by the profile tests: proves a disabled mechanic can be switched
        # back on without touching any feature code.
        "config": {"timewarp_enabled": True},
    },
    VANILLA: {
        "id": VANILLA,
        "label": "基础版本（无饰品 / 黑赐 / 时空）",
        "capabilities": {
            "trinkets": False,
            "darkGift": False,
            "aberration": True,
            "timewarp": False,
            "quests": True,
        },
        # Turns are pushed past ``max_turns`` so the engine never offers them.
        # Aberrations need a proper engine knob before they can be disabled the
        # same way; keep them on for now instead of silently half-disabling.
        "config": {
            "timewarp_enabled": False,
            "lesser_trinket_turn": 999,
            "greater_trinket_turn": 999,
            "dark_gift_unlock_turn": 999,
        },
    },
}

DEFAULT = SHIPPING


def get(profile_id: str | None) -> dict:
    """The requested profile, or the shipping one when unknown/missing."""
    if profile_id:
        found = PROFILES.get(str(profile_id))
        if found:
            return found
    return PROFILES[DEFAULT]


def apply_config(config: dict, profile: dict | None = None) -> dict:
    """Merge a profile's engine overrides into a config dict (in place)."""
    if profile:
        config.update(profile.get("config") or {})
    return config


def public_list() -> list[dict]:
    """What ``GET /api/profiles`` returns: id, label and capabilities."""
    return [
        {
            "id": p["id"],
            "label": p["label"],
            "capabilities": dict(p.get("capabilities") or {}),
        }
        for p in PROFILES.values()
    ]
