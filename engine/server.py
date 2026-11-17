"""BGSIM server: a thin, fast bridge between the taverngym engine and the React UI.

The engine (`taverngym`) is a compiled Rust extension; one `Game` is a complete
eight-player Battlegrounds game. This process keeps a single game in memory and
serves a compact, UI-oriented projection of the player view. No per-action disk
writes, keep-alive HTTP/1.1, gzip, and one engine call per user action.

Run with the bundled interpreter:
    engine\\runtime\\python.exe engine\\server.py --port 8787
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import mimetypes
import os
import re
import secrets
import tempfile
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

import taverngym

from assets import PACK
from profiles import DEFAULT as DEFAULT_PROFILE
from profiles import apply_config as apply_profile_config
from profiles import get as get_profile
from profiles import public_list as profile_list

ROOT = Path(__file__).resolve().parent
PROJECT = ROOT.parent
DIST = PROJECT / "dist"
# The bundled desktop app keeps its resources read-only (Program Files), so the
# launcher hands us a writable folder for saves through BGSIM_DATA.
DATA = Path(os.environ.get("BGSIM_DATA") or (PROJECT / "data"))
try:
    DATA.mkdir(parents=True, exist_ok=True)
except OSError:
    DATA = Path(tempfile.gettempdir()) / "bgsim"
    DATA.mkdir(parents=True, exist_ok=True)

MAX_HISTORY = 12
BOT_GUARD = 4000
# How many multiplayer slots one engine process keeps. A shipped desktop app has
# exactly one tab; more than one only happens when testing several players on
# the same machine (or a browser left with stale tabs).
NET_SLOTS = 8

RACE_CN = {
    "DEMON": "恶魔", "DRAGON": "龙", "ELEMENTAL": "元素", "MECHANICAL": "机械",
    "MURLOC": "鱼人", "NAGA": "纳迦", "PIRATE": "海盗", "QUILBOAR": "野猪人",
    "UNDEAD": "亡灵", "BEAST": "野兽", "ALL": "全部", "ABERRATION": "畸变",
    "PET": "宠物", "LOCUST": "虫群",
}


# ---------------------------------------------------------------- projections
def card_brief(c: dict | None) -> dict | None:
    """Static-ish card identity plus its current live text (for tooltips)."""
    if not c:
        return None
    out = {
        "id": c.get("id"),
        "name": c.get("name"),
        "nameZh": c.get("name_zh") or c.get("name"),
        "text": c.get("text") or "",
        "textZh": c.get("text_zh") or c.get("text") or "",
        "tier": c.get("tier"),
        "kind": c.get("kind"),
        "races": c.get("races") or [],
        "goldenId": c.get("golden_id"),
        "atk": c.get("atk"),
        "hp": c.get("hp"),
        "cost": c.get("cost"),
        "armor": c.get("armor"),
        "scripted": c.get("scripted"),
    }
    hp = c.get("hero_power")
    if hp:
        out["heroPower"] = card_brief(hp)
    return out


def race_counts(board: list[dict]) -> dict[str, int]:
    """How many minions of each tribe a board carries (neutrals and blanks skipped)."""
    out: dict[str, int] = {}
    for m in board:
        for race in m.get("races") or []:
            if race:
                out[race] = out.get(race, 0) + 1
    return out


def mini(m: dict | None) -> dict | None:
    if not m:
        return None
    return {
        "id": m.get("id"),
        "eid": m.get("eid"),
        "name": m.get("name"),
        "nameZh": m.get("name_zh") or m.get("name"),
        "textZh": m.get("text_zh") or "",
        "tier": m.get("tier"),
        "races": m.get("races") or [],
        "atk": m.get("atk", 0),
        "hp": m.get("hp", 1),
        "maxHp": m.get("max_hp", m.get("hp", 1)),
        "kw": m.get("keywords") or [],
        "golden": bool(m.get("golden")),
        "shield": m.get("shield_hits") or 0,
        "shieldMax": m.get("shield_max") or 1,
        "act": m.get("activate_cost"),
        "actN": m.get("activations") or 0,
        "counter": m.get("counter") or 0,
        "gems": m.get("gems") or 0,
        "triple": bool(m.get("triple_reward")),
        "attached": [card_brief(a) for a in (m.get("attached") or [])],
    }


def item(it: dict | None) -> dict | None:
    """A Tavern slot or hand card (minion or Tavern spell)."""
    if not it:
        return None
    out = {
        "id": it.get("id"),
        "eid": it.get("eid"),
        "name": it.get("name"),
        "nameZh": it.get("name_zh") or it.get("name"),
        "textZh": it.get("text_zh") or "",
        "tier": it.get("tier"),
        "races": it.get("races") or [],
        "type": it.get("type") or ("minion" if it.get("eid") is not None else "spell"),
        "cost": it.get("cost"),
        "atk": it.get("atk"),
        "hp": it.get("hp"),
        "kw": it.get("keywords") or [],
        "golden": bool(it.get("golden")),
        "goldenId": it.get("golden_id"),
        "unplayable": bool(it.get("unplayable")),
        "price": it.get("price"),
        "sid": it.get("sid"),
        "hid": it.get("hid"),
        "frozen": bool(it.get("frozen")),
        "kept": bool(it.get("kept")),
        "ticket": bool(it.get("ticket")),
        "owned": it.get("owned"),
        "tripleNeed": it.get("triple_need"),
        "costsHealth": bool(it.get("costs_health")),
        "locked": it.get("locked"),
        "temporary": bool(it.get("temporary")),
        "combined": bool(it.get("combined")),
        "data": it.get("data"),
    }
    if "attached" in it:
        out["attached"] = [card_brief(a) for a in (it.get("attached") or [])]
    return out


def compact_pending(p: dict | None, me: dict | None = None) -> dict | None:
    if not p:
        return None
    kind = p.get("kind")
    if kind == "discover":
        return {
            "kind": kind,
            "source": card_brief(p.get("source")),
            "options": [item(o) for o in p.get("options") or []],
        }
    if kind == "hero":
        return {
            "kind": kind,
            "options": [card_brief(o) for o in p.get("options") or []],
        }
    if kind == "choose_one":
        return {
            "kind": kind,
            "source": card_brief(p.get("source")),
            "options": [card_brief(o) for o in p.get("options") or []],
        }
    if kind == "target":
        raw = p.get("targets") or []
        if raw and isinstance(raw[0], dict):
            # Older engines already send {action, choice, location} objects.
            return {"kind": kind, "targets": raw}
        # 37.0.2 sends raw EntityIds; map them back to board/shop/hand slots so
        # the UI can highlight and click the actual cards.
        where: dict[int, tuple[str, int]] = {}
        if me:
            for zone in ("board", "shop", "hand"):
                for i, x in enumerate(me.get(zone) or []):
                    for key in ("eid", "hid", "sid"):
                        v = x.get(key)
                        if v is not None:
                            where[v] = (zone, i)
        out = []
        for i, eid in enumerate(raw):
            loc = where.get(eid)
            out.append(
                {
                    "action": 30 + i,
                    "choice": i,
                    "location": {"zone": loc[0] if loc else "unknown", "slot": loc[1] if loc else -1},
                }
            )
        return {"kind": kind, "targets": out}
    if kind == "hero_power":
        return {
            "kind": kind,
            "slot": p.get("slot", 0),
            "options": [card_brief(o) for o in p.get("options") or []],
        }
    if kind == "trinket":
        return {
            "kind": kind,
            "free": bool(p.get("free")),
            "replace": card_brief(p.get("replace")),
            "options": [
                {
                    **card_brief(o),
                    "cost": o.get("cost"),
                    "baseCost": o.get("base_cost"),
                    "weight": o.get("weight"),
                }
                for o in p.get("options") or []
            ],
        }
    if kind == "timewarp":
        # The engine hands the options over as card dicts carrying
        # `chronum_cost`; an older shape was a (card, cost) pair. Accept both so
        # the projection does not depend on which build is running.
        opts = []
        for o in p.get("options") or []:
            if isinstance(o, dict):
                cost = o.get("chronum_cost", o.get("chronumCost"))
                opts.append({**item(o), "chronumCost": cost})
            elif isinstance(o, (list, tuple)) and len(o) >= 2:
                opts.append({**item(o[0]), "chronumCost": o[1]})
        return {
            "kind": kind,
            "chronum": p.get("chronum"),
            "major": bool(p.get("major")),
            "leave": p.get("leave"),
            "options": opts,
        }
    if kind == "quest":
        return {
            "kind": kind,
            "options": [
                {
                    **card_brief(o.get("quest") if "quest" in o else o),
                    "goal": o.get("goal"),
                    "reward": card_brief(o.get("reward")),
                }
                for o in p.get("options") or []
            ],
        }
    return p


def compact_combat(c: dict, brief_minions: bool = True) -> dict:
    conv = (lambda m: mini_combat(m)) if brief_minions else mini
    return {
        "turn": c.get("turn"),
        "a": c.get("a"),
        "b": c.get("b"),
        "winner": c.get("winner"),
        "damage": c.get("damage"),
        "truncated": bool(c.get("truncated")),
        "frames": [
            {
                "attacks": f.get("attacks") or [],
                "log": f.get("log") or [],
                "boards": [
                    [conv(m) for m in (f.get("boards") or [[], []])[0]],
                    [conv(m) for m in (f.get("boards") or [[], []])[1]],
                ],
            }
            for f in c.get("frames") or []
        ],
    }


def mini_combat(m: dict) -> dict:
    return {
        "id": m.get("id"),
        "eid": m.get("eid"),
        "atk": m.get("atk", 0),
        "hp": m.get("hp", 1),
        "maxHp": m.get("max_hp", m.get("hp", 1)),
        "kw": m.get("keywords") or [],
        "golden": bool(m.get("golden")),
        "shield": m.get("shield_hits") or 0,
        "shieldMax": m.get("shield_max") or 1,
        "tier": m.get("tier"),
        "races": m.get("races") or [],
    }


# ``[t6] p7 triples into golden Flighty Scout``
TRIPLE_RE = re.compile(r"\] p(\d+) triples into golden ")
# ``[t6] combat p5 vs Some(0): winner 0 dmg 8`` (``None`` = ghost fight)
COMBAT_RE = re.compile(r"\] combat p(\d+) vs (?:Some\((\d+)\)|None): winner (\d+) dmg (\d+)")


def seat_stats(log: list[str]) -> dict[int, dict[str, int]]:
    """Triples made and the current win streak, read straight off the game log.

    The engine's own ``win_streak`` resets on a draw, but a draw should keep the
    streak alive without adding to it, so the running total is rebuilt here:
    win +1, draw unchanged, loss 0.
    """
    out: dict[int, dict[str, int]] = {}

    def slot(seat: int) -> dict[str, int]:
        return out.setdefault(seat, {"triples": 0, "streak": 0})

    for line in log:
        if "triples into golden" in line:
            m = TRIPLE_RE.search(line)
            if m:
                slot(int(m.group(1)))["triples"] += 1
        elif "combat p" in line:
            m = COMBAT_RE.search(line)
            if not m:
                continue
            a = int(m.group(1))
            b = int(m.group(2)) if m.group(2) is not None else None
            winner = int(m.group(3))
            if winner == 2:  # a draw moves nobody's streak
                continue
            winner_seat = a if winner == 0 else b
            loser = b if winner == 0 else a
            if winner_seat is not None:
                slot(winner_seat)["streak"] += 1
            if loser is not None:
                slot(loser)["streak"] = 0
    return out


def public_warbands(combats: list[dict]) -> dict[int, dict[str, int]]:
    """Tribe counts of every warband that actually fought the last round.

    The live board of an opponent is already their *next* turn's shopping by the
    time we look (the bots buy as soon as our turn ends), so the only honest
    source is the board each side started the last combat with.
    """
    out: dict[int, dict[str, int]] = {}
    for c in combats:
        frames = c.get("frames") or []
        if not frames:
            continue
        boards = (frames[0].get("boards") or [[], []])[:2]
        for seat, board in ((c.get("a"), boards[0]), (c.get("b"), boards[1] if len(boards) > 1 else [])):
            if seat is None:
                continue
            out[int(seat)] = race_counts(board or [])
    return out


def compact_view(
    v: dict,
    with_combats: bool,
    stats: dict[int, dict[str, int]] | None = None,
    seat: int | None = None,
    profile: dict | None = None,
) -> dict:
    me = v.get("me") or {}
    combats = v.get("combats") or []
    # Public information only exists once a combat round has resolved: during the
    # first recruit nobody has fought, so no warband is known.
    public = public_warbands(combats)
    # `seat` overrides the view's own seat for the parts that are addressed by
    # seat number (the combat replay); single player is always seat 0.
    my_seat = int(seat if seat is not None else (v.get("seat") or 0))
    me_out = {
        "hero": card_brief(me.get("hero")),
        "heroPowers": [
            {
                **card_brief(h),
                "slot": h.get("slot", 0),
                "action": h.get("action"),
                "price": h.get("price"),
                "usable": bool(h.get("usable")),
                "passive": bool(h.get("passive")),
                "usesTurn": h.get("uses_turn", 0),
                "usesGame": h.get("uses_game", 0),
                "counter": h.get("counter", 0),
            }
            for h in me.get("hero_powers") or []
        ],
        "health": me.get("health"),
        "armor": me.get("armor"),
        "alive": me.get("alive"),
        "placement": me.get("placement"),
        "tier": me.get("tier"),
        "gold": me.get("gold"),
        "maxGold": me.get("max_gold"),
        "maxGoldBonus": me.get("max_gold_bonus", 0),
        "goldNextTurn": me.get("gold_next_turn", 0),
        "upgradePrice": me.get("upgrade_price"),
        "canUpgrade": bool(me.get("can_upgrade_tier")),
        "refreshPrice": me.get("refresh_price"),
        "minionPrice": me.get("minion_price"),
        "freeRefreshes": me.get("free_refreshes", 0),
        "frozen": bool(me.get("frozen")),
        "endedTurn": bool(me.get("ended_turn")),
        "board": [mini(m) for m in me.get("board") or []],
        "hand": [item(h) for h in me.get("hand") or []],
        "shop": [item(s) for s in me.get("shop") or []],
        "trinkets": [card_brief(t) for t in me.get("trinkets") or []],
        "quests": [
            {
                "quest": card_brief(q.get("quest")),
                "reward": card_brief(q.get("reward")),
                "progress": q.get("progress"),
                "goal": q.get("goal"),
            }
            for q in me.get("quests") or []
        ],
        "rewards": [card_brief(r) for r in me.get("rewards") or []],
        "secrets": [card_brief(r) for r in me.get("secrets") or []],
        "effects": [
            {"card": card_brief(e.get("card")), "stacks": e.get("stacks")}
            for e in me.get("effects") or []
        ],
        "scheduled": [
            {
                "card": card_brief(s.get("card")),
                "turnsLeft": s.get("turns_left"),
                "ifWon": bool(s.get("if_won")),
            }
            for s in me.get("scheduled") or []
        ],
        "pending": compact_pending(me.get("pending"), me),
        "cancellable": bool(me.get("cancellable")),
        "casting": me.get("casting"),
        "darkGift": me.get("dark_gift"),
        "deity": (
            {
                "card": card_brief((me.get("deity") or {}).get("card")),
                "atk": (me.get("deity") or {}).get("atk"),
                "hp": (me.get("deity") or {}).get("hp"),
                "golden": (me.get("deity") or {}).get("golden"),
                "reborn": (me.get("deity") or {}).get("reborn"),
            }
            if me.get("deity")
            else None
        ),
        "buddy": card_brief(me.get("buddy")),
        "buddyButton": (
            {
                "card": card_brief((me.get("buddy_button") or {}).get("card")),
                "claims": (me.get("buddy_button") or {}).get("claims"),
                "price": (me.get("buddy_button") or {}).get("price"),
                "discount": (me.get("buddy_button") or {}).get("discount"),
                "available": bool((me.get("buddy_button") or {}).get("available")),
                "quantity": (me.get("buddy_button") or {}).get("quantity"),
            }
            if me.get("buddy_button")
            else None
        ),
        "nextOpponent": me.get("next_opponent"),
        "nextIsGhost": bool(me.get("next_is_ghost")),
        "lastOpponent": me.get("last_opponent"),
        "lastDamage": me.get("last_damage", 0),
        "winStreak": me.get("win_streak", 0),
        # Public counters, same rules as the opponents' (own avatar is not special).
        "lastRaces": public.get(my_seat, {}),
        "triples": ((stats or {}).get(v.get("seat", 0)) or {}).get("triples", 0),
        "streak": ((stats or {}).get(v.get("seat", 0)) or {}).get("streak", 0),
        "handLimit": me.get("hand_limit", 10),
        "chronum": me.get("chronum_balance", 0),
        "stats": me.get("stats") or {},
    }

    opps = []
    for o in v.get("opponents") or []:
        extra = (stats or {}).get(o.get("id")) or {}
        opps.append(
            {
                "id": o.get("id"),
                "hero": card_brief(o.get("hero")),
                "health": o.get("health"),
                "armor": o.get("armor"),
                "tier": o.get("tier"),
                "alive": o.get("alive"),
                "placement": o.get("placement"),
                # The warband as it looked the last time we ran into them, plus
                # the turn that snapshot was taken (drives "N 回合前").
                "seenBoard": [mini(m) for m in o.get("seen_board") or []],
                "seenTurn": o.get("seen_turn"),
                # Tribe counts of the warband they fought last round — public
                # information, shown even for opponents we have never met.
                "lastRaces": public.get(int(o.get("id", -1)), {}),
                "triples": extra.get("triples", 0),
                "streak": extra.get("streak", 0),
                "isNext": bool(o.get("is_next_opponent")),
                "wasLast": bool(o.get("was_last_opponent")),
                "trinkets": [card_brief(t) for t in o.get("trinkets") or []],
                # Their live hero powers (the real table shows them on hover).
                "heroPowers": [card_brief(p) for p in o.get("hero_powers") or []],
                "quests": [
                    {
                        "quest": card_brief(q.get("quest")),
                        "reward": card_brief(q.get("reward")),
                        "progress": q.get("progress"),
                        "goal": q.get("goal"),
                    }
                    for q in o.get("quests") or []
                ],
            }
        )

    out = {
        "seat": v.get("seat", 0),
        "turn": v.get("turn"),
        "phase": v.get("phase"),
        "version": v.get("version"),
        "alive": v.get("alive"),
        "lobbyRaces": v.get("lobby_races") or [],
        "hasAberrations": bool(v.get("has_aberrations")),
        "deity": card_brief(v.get("deity")),
        "paradox": card_brief(v.get("paradox")),
        "me": me_out,
        "opponents": opps,
        "actions": v.get("actions") or {},
        "legal": [i for i, ok in enumerate(v.get("mask") or []) if ok],
        # Which mechanics this match runs (see engine/profiles.py). The UI
        # mounts a feature only when its capability is not false.
        "profile": (profile or {}).get("id") or DEFAULT_PROFILE,
        "caps": dict((profile or {}).get("capabilities") or {}),
    }
    # Who fought whom last round, and who took the damage. Tiny payload (four
    # rows) but it lets the client keep a per-opponent fight log without the
    # engine having to store history.
    out["combatSummaries"] = [
        {
            "a": c.get("a"),
            "b": c.get("b"),
            "winner": c.get("winner"),
            "damage": c.get("damage"),
            "turn": c.get("turn"),
        }
        for c in combats
    ]
    if with_combats:
        player_combat = next((c for c in combats if c.get("a") == my_seat or c.get("b") == my_seat), None)
        out["combat"] = compact_combat(player_combat) if player_combat else None
    return out


# -------------------------------------------------------------------- session
def build_config(
    hero_choices: int = 4,
    hero: str | None = None,
    races: list[str] | None = None,
    overrides: dict | None = None,
    profile: dict | None = None,
) -> dict:
    """The config a game is created with. Shared by solo and net so a match is
    reproducible: every client gets the same dict and the same seed."""
    config = {
        "record_log": True,
        "hero_choices": max(3, min(4, hero_choices)),
        "start_gold": 3,
        "gold_refill_cap": 10,
        "turn_action_caps": [],
        "max_turns": 60,
    }
    # Custom game: pin the tribes that must show up. The engine keeps the
    # lobby at five tribes and fills the rest at random, so two picks means
    # "these two, plus three surprises".
    tribes = [r for r in (races or []) if r]
    if tribes:
        config["lobby_types"] = tribes
        config["lobby_races"] = 5
    if hero:
        config["hero_pool"] = [hero]
        config["guaranteed_heroes"] = [hero]
        config["hero_choices"] = 1
    if overrides:
        config.update(overrides)
    # The ruleset profile has the final say: it is what switches a rotating
    # mechanic off without deleting its code.
    apply_profile_config(config, profile)
    return config


class NetSlot:
    """One client's copy of the shared eight-player game.

    The engine process can serve several, because a browser with two tabs is
    two players as far as the relay is concerned; a shipped desktop build only
    ever has one.
    """

    __slots__ = ("game", "seat", "revision", "config", "stats", "last_mismatch", "boundary", "last_used")

    def __init__(self) -> None:
        self.game = None
        self.seat = 0
        self.revision = 0
        self.config: dict = {}
        self.stats = {"applied": 0, "skipped": 0, "illegal": 0}
        self.last_mismatch: dict | None = None
        self.boundary: dict | None = None
        self.last_used = time.time()


class Session:
    def __init__(self) -> None:
        self.game = None
        # Net play runs in its own slots: one seat of an eight-player game that
        # every client simulates locally. Keyed by a client id so two pages on
        # the same machine never overwrite each other's seat.
        self.net_slots: dict[str, NetSlot] = {}
        self.revision = 0
        # Which ruleset the current solo game runs (engine/profiles.py).
        self.profile = get_profile(DEFAULT_PROFILE)
        self.history: deque = deque(maxlen=MAX_HISTORY)
        self.lock = threading.RLock()
        self.catalog_raw = json.loads(taverngym.catalog_json())
        self.catalog = self._compact_catalog()
        # The art pack needs the id list to pre-warm / count downloads.
        try:
            PACK.set_catalog(self.catalog["cards"])
        except Exception:  # noqa: BLE001
            pass
        self.last_error = ""
        self.started = time.time()

    def _compact_catalog(self) -> dict:
        cards = []
        raw_by_id = {c.get("id"): c for c in self.catalog_raw}
        for c in self.catalog_raw:
            if not (c.get("reachable") or c.get("in_pool") or c.get("implemented")):
                continue
            cards.append(
                {
                    "id": c.get("id"),
                    "name": c.get("name"),
                    "nameZh": c.get("name_zh") or c.get("name"),
                    "text": c.get("text") or "",
                    "textZh": c.get("text_zh") or c.get("text") or "",
                    "tier": c.get("tier"),
                    "kind": c.get("kind"),
                    "races": c.get("races") or [],
                    "atk": c.get("atk"),
                    "hp": c.get("hp"),
                    "cost": c.get("cost"),
                    "goldenId": c.get("golden_id"),
                    "normalId": c.get("normal_id"),
                    "inPool": bool(c.get("in_pool")),
                    "implemented": bool(c.get("implemented")),
                    "scripted": bool(c.get("scripted")),
                    "tier7": bool(c.get("tier7")),
                    # Heroes carry the id of their power; hand the UI the power
                    # card too, so hovering an opponent can show what it does.
                    "heroPower": card_brief(raw_by_id.get(c.get("hero_power_id"))) if c.get("hero_power_id") else None,
                }
            )
        return {
            "version": taverngym.game_version(),
            "engine": taverngym.version(),
            "races": RACE_CN,
            "cards": cards,
            "byId": {c["id"]: c for c in cards},
        }

    # -- game lifecycle -----------------------------------------------------
    def new_game(
        self,
        seed: int | None = None,
        hero_choices: int = 4,
        hero: str | None = None,
        races: list[str] | None = None,
        profile_id: str | None = None,
    ) -> None:
        if seed is None:
            seed = secrets.randbelow(2**31)
        self.profile = get_profile(profile_id or DEFAULT_PROFILE)
        config = build_config(hero_choices, hero, races, profile=self.profile)
        self.game = taverngym.Game(seed=int(seed), config_json=json.dumps(config))
        self.game.set_record_log(True)
        self.history.clear()
        self.revision = 0
        self.run_bots()
        if hero:
            # The player already told us who they want: skip hero select.
            raw = json.loads(self.game.view(0))
            pending = (raw.get("me") or {}).get("pending") or {}
            ids = [o.get("id") for o in (pending.get("options") or [])]
            if pending.get("kind") == "hero" and hero in ids:
                self.game.step(0, 30 + ids.index(hero))
                self.run_bots()

    def run_bots(self) -> None:
        """Let every bot seat act until the game needs the human again or the round ends."""
        g = self.game
        if g is None:
            return
        turn = g.turn
        for _ in range(BOT_GUARD):
            acted = False
            for p in range(1, g.num_players):
                if g.is_over():
                    return
                if g.needs_action(p):
                    a = int(g.bot_action(p))
                    mask = g.legal_mask(p)
                    if not (0 <= a < len(mask)) or not mask[a]:
                        a = next((i for i, ok in enumerate(mask) if ok), 0)
                    g.step(p, a)
                    acted = True
            if not acted:
                return
            if g.turn != turn and not any(g.needs_action(p) for p in range(1, g.num_players)):
                return

    def finish_game(self) -> None:
        g = self.game
        if g is None:
            return
        for _ in range(BOT_GUARD):
            if g.is_over():
                return
            if g.needs_action(0):
                a = int(g.bot_action(0))
                g.step(0, a)
            else:
                self.run_bots()
                if not g.is_over() and not g.needs_action(0):
                    # Round advanced; keep the game moving on autopilot.
                    if g.turn is not None:
                        a = int(g.bot_action(0)) if g.needs_action(0) else 0
                        if g.needs_action(0):
                            g.step(0, a)

    # -- net play -----------------------------------------------------------
    # Every client runs the whole eight-player game and applies one global,
    # relay-ordered action stream. A slot therefore owns the game, the seat this
    # client plays, and nothing else: no bots, no undo, no local aliasing.
    #
    # Slots are keyed by a client id because *one engine process can serve more
    # than one page*: two tabs on one machine are two players in the eyes of the
    # relay, and they must not overwrite each other's seat. The packaged app has
    # exactly one tab, so it uses exactly one slot.
    def net_slot(self, client: str = "", create: bool = False) -> "NetSlot | None":
        key = (client or "").strip()[:64]
        slot = self.net_slots.get(key)
        if slot is None:
            if not create:
                return None
            # Drop the least recently used slot when the cap is hit: a long
            # browser session with many tabs should not grow without bound.
            if len(self.net_slots) >= NET_SLOTS:
                oldest = min(self.net_slots.items(), key=lambda kv: kv[1].last_used)
                if oldest[0] != key:
                    self.net_slots.pop(oldest[0], None)
            slot = NetSlot()
            self.net_slots[key] = slot
        slot.last_used = time.time()
        return slot

    def new_net(
        self,
        client: str,
        seed: int,
        seat: int,
        hero_choices: int = 4,
        races: list[str] | None = None,
        config: dict | None = None,
    ) -> dict:
        if seed is None:
            raise ValueError("联机开局需要 seed")
        seat = int(seat)
        if not (0 <= seat < 8):
            raise ValueError("座位号必须在 0..7 之间")
        cfg = build_config(hero_choices, None, races, config)
        slot = self.net_slot(client, create=True)
        # Same seed + same config + same action order => identical state. Every
        # client builds the game from exactly this dict.
        slot.game = taverngym.Game(seed=int(seed), config_json=json.dumps(cfg, sort_keys=True))
        slot.game.set_record_log(True)
        slot.seat = seat
        slot.config = cfg
        slot.revision = 0
        slot.stats = {"applied": 0, "skipped": 0, "illegal": 0}
        slot.last_mismatch = None
        slot.boundary = None
        return self.net_status(client)

    def net_status(self, client: str = "") -> dict:
        slot = self.net_slot(client)
        if slot is None or slot.game is None:
            return {"game": False, "revision": 0, "seat": 0, "slots": len(self.net_slots)}
        g = slot.game
        over = bool(g.is_over())
        turn = g.turn
        try:
            needs = [bool(g.needs_action(p)) for p in range(g.num_players)]
        except Exception:  # noqa: BLE001 - a finished game has no pending seats
            needs = [False] * 8
        return {
            "game": True,
            "revision": slot.revision,
            "seat": slot.seat,
            "turn": turn,
            "phase": "game_over" if over else ("hero_select" if turn == 0 else "recruit"),
            "needs": needs,
            "over": over,
            "boundary": slot.boundary,
            "stats": dict(slot.stats),
            "slots": len(self.net_slots),
        }

    def net_view(self, client: str = "", with_combats: bool = False, log_lines: int = 0) -> dict:
        slot = self.net_slot(client)
        if slot is None or slot.game is None:
            return {"game": None, "revision": 0, "canUndo": False}
        g = slot.game
        raw = json.loads(g.view(slot.seat))
        try:
            log = g.log()
        except Exception:  # noqa: BLE001
            log = []
        out = {
            "game": compact_view(raw, with_combats, seat_stats(log), seat=slot.seat, profile=get_profile((slot.config or {}).get("profile"))),
            "revision": slot.revision,
            "canUndo": False,
            "catalogVersion": self.catalog["version"],
            "net": self.net_status(client),
        }
        if log_lines:
            out["log"] = log[-log_lines:]
        return out

    def net_apply(self, client: str = "", steps: list | None = None) -> dict:
        """Apply relay-ordered actions. Every seat is fair game — that is the
        whole point: the local engine is the shared simulation, not a player."""
        slot = self.net_slot(client)
        if slot is None or slot.game is None:
            raise ValueError("还没有联机对局")
        g = slot.game
        results = []
        for step in steps or []:
            try:
                seat, action = int(step[0]), int(step[1])
            except (TypeError, ValueError, IndexError):
                results.append({"ok": False, "reason": "bad-step"})
                continue
            rec: dict = {"seat": seat, "action": action}
            if not (0 <= seat < g.num_players):
                rec.update(ok=False, reason="seat")
                results.append(rec)
                continue
            if g.is_over():
                slot.stats["skipped"] += 1
                rec.update(ok=True, skipped="over")
                results.append(rec)
                continue
            # Seats the engine is not waiting on (already ended, eliminated,
            # waiting for the round) swallow their action: the relay fires END
            # at every seat on a timeout, most of them harmlessly.
            if not g.needs_action(seat):
                slot.stats["skipped"] += 1
                rec.update(ok=True, skipped="not-needed")
                results.append(rec)
                continue
            mask = g.legal_mask(seat)
            if not (0 <= action < len(mask)) or not mask[action]:
                # Stale order (an action computed a moment before the state
                # moved on) or a genuinely diverging client. Every client sees
                # the same stream, so every client skips it identically; the
                # round digests below are what actually proves agreement.
                slot.stats["illegal"] += 1
                if slot.last_mismatch is None:
                    slot.last_mismatch = {"seat": seat, "action": action, "turn": g.turn}
                rec.update(ok=False, skipped="illegal")
                results.append(rec)
                continue
            before_turn = g.turn
            g.step(seat, action)
            slot.revision += 1
            slot.stats["applied"] += 1
            if g.turn != before_turn:
                slot.boundary = {
                    "turn": g.turn,
                    "hash": hashlib.sha256(g.state_json().encode("utf-8")).hexdigest()[:16],
                    "rev": slot.revision,
                }
            rec.update(ok=True)
            results.append(rec)
        out = self.net_status(client)
        out["results"] = results
        out["mismatch"] = slot.last_mismatch
        return out

    def net_bot_action(self, client: str, seat: int) -> dict:
        """A legal action for a seat the local engine is waiting on (drop-in
        takeover). Only used when a player has been gone long enough."""
        slot = self.net_slot(client)
        if slot is None or slot.game is None:
            raise ValueError("还没有联机对局")
        g = slot.game
        seat = int(seat)
        if not (0 <= seat < g.num_players) or g.is_over() or not g.needs_action(seat):
            return {"ok": False, "reason": "not-needed"}
        action = int(g.bot_action(seat))
        mask = g.legal_mask(seat)
        if not (0 <= action < len(mask)) or not mask[action]:
            action = next((i for i, ok in enumerate(mask) if ok), 0)
        return {"ok": True, "seat": seat, "action": action, "turn": g.turn}

    def net_hash(self, client: str = "") -> dict:
        slot = self.net_slot(client)
        if slot is None or slot.game is None:
            return {"game": False}
        raw = slot.game.state_json()
        return {
            "game": True,
            "turn": slot.game.turn,
            "revision": slot.revision,
            "hash": hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16],
            "bytes": len(raw),
        }

    # -- views --------------------------------------------------------------
    def view(self, with_combats: bool = False, log_lines: int = 0) -> dict:
        g = self.game
        if g is None:
            return {"game": None, "revision": self.revision}
        raw = json.loads(g.view(0))
        try:
            log = g.log()
        except Exception:  # noqa: BLE001
            log = []
        out = {
            "game": compact_view(raw, with_combats, seat_stats(log), profile=self.profile),
            "revision": self.revision,
            "canUndo": bool(self.history),
            "catalogVersion": self.catalog["version"],
            "elapsed": round(time.time() - self.started, 1),
        }
        if log_lines:
            try:
                out["log"] = log[-log_lines:]
            except Exception:
                out["log"] = []
        return out

    def _snapshot(self) -> None:
        try:
            self.history.append(self.game.copy())
        except Exception:
            pass

    # -- actions ------------------------------------------------------------
    def act(self, action: int, expect_turn_end: bool | None = None) -> dict:
        g = self.game
        if g is None:
            raise ValueError("请先开始新对局")
        mask = g.legal_mask(0)
        if not (0 <= action < len(mask)) or not mask[action]:
            raise ValueError("当前不能执行这个动作")
        self._snapshot()
        before_turn = g.turn
        g.step(0, int(action))
        if before_turn == 0:
            self.run_bots()
        if action == 0 or g.turn != before_turn:
            self.run_bots()
        self.revision += 1
        ended = action == 0 or g.turn != before_turn

        # Build the seat view exactly once. `g.view(0)` serialises 400-600 KB of
        # JSON, so calling it twice (once just to read `me.alive`) used to cost
        # an extra ~20 ms on every single action.
        raw = json.loads(g.view(0))
        try:
            if not bool(raw.get("me", {}).get("alive")) and not g.is_over():
                self.run_to_end()
                raw = json.loads(g.view(0))
        except Exception:
            pass

        try:
            log = g.log()
        except Exception:  # noqa: BLE001
            log = []
        out = {
            "game": compact_view(raw, ended, seat_stats(log), profile=self.profile),
            "revision": self.revision,
            "canUndo": bool(self.history),
            "catalogVersion": self.catalog["version"],
            "elapsed": round(time.time() - self.started, 1),
            "ok": True,
        }
        if ended:
            out["log"] = log[-60:]
        return out

    def run_to_end(self) -> None:
        g = self.game
        for _ in range(400):
            if g.is_over():
                return
            if g.needs_action(0):
                g.step(0, int(g.bot_action(0)))
            else:
                self.run_bots()
                if not g.is_over() and not g.needs_action(0) and not any(
                    g.needs_action(p) for p in range(1, g.num_players)
                ):
                    return

    def undo(self) -> dict:
        if not self.history:
            raise ValueError("没有可以撤销的操作")
        self.game = self.history.pop()
        self.revision += 1
        return self.view()

    def save(self) -> None:
        if self.game is None:
            raise ValueError("没有进行中的对局")
        (DATA / "save.json").write_text(self.game.state_json(), encoding="utf-8")

    def load(self) -> None:
        path = DATA / "save.json"
        if not path.exists():
            raise ValueError("没有存档")
        self.game = taverngym.Game.from_json(path.read_text(encoding="utf-8"))
        self.game.set_record_log(True)
        self.history.clear()
        self.revision += 1


SESSION = Session()


# --------------------------------------------------------------------- server
MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".otf": "font/otf",
    ".woff2": "font/woff2",
    ".ico": "image/x-icon",
}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "BGSIM/0.1"

    def log_message(self, fmt: str, *args) -> None:  # keep the console quiet
        if os.environ.get("BGSIM_VERBOSE"):
            print(fmt % args, flush=True)

    def _send(self, status: int, body: bytes, mime: str) -> None:
        accept = self.headers.get("Accept-Encoding") or ""
        if len(body) > 1024 and "gzip" in accept:
            body = gzip.compress(body, 5)
            encoding = "gzip"
        else:
            encoding = ""
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        if encoding:
            self.send_header("Content-Encoding", encoding)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def json(self, data, status: int = 200) -> None:
        raw = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self._send(status, raw, "application/json; charset=utf-8")

    def error(self, message: str, status: int = 400) -> None:
        self.json({"error": message}, status)

    def do_GET(self) -> None:
        parts = urlsplit(self.path)
        path = parts.path
        query = parse_qs(parts.query)
        client = (query.get("client", [""])[0] or "").strip()[:64]
        try:
            if path == "/api/state":
                with SESSION.lock:
                    return self.json(SESSION.view(with_combats=False))
            # ---- net play (one seat of a shared eight-player simulation) ----
            if path == "/api/net/state":
                with SESSION.lock:
                    with_combats = query.get("combats", ["0"])[0] not in ("0", "", "false")
                    log_lines = int(query.get("log", ["0"])[0] or 0)
                    return self.json(SESSION.net_view(client, with_combats, log_lines))
            if path == "/api/net/status":
                with SESSION.lock:
                    return self.json(SESSION.net_status(client))
            if path == "/api/net/hash":
                with SESSION.lock:
                    return self.json(SESSION.net_hash(client))
            if path == "/api/net/bot":
                with SESSION.lock:
                    slot = SESSION.net_slot(client)
                    default_seat = slot.seat if slot else 0
                    seat = int(query.get("seat", [str(default_seat)])[0])
                    return self.json(SESSION.net_bot_action(client, seat))
            if path == "/api/net/debug":
                with SESSION.lock:
                    slot = SESSION.net_slot(client)
                    return self.json(
                        {
                            "status": SESSION.net_status(client),
                            "hash": SESSION.net_hash(client),
                            "mismatch": slot.last_mismatch if slot else None,
                            "config": slot.config if slot else {},
                            "slots": len(SESSION.net_slots),
                        }
                    )
            if path == "/api/catalog":
                return self.json(SESSION.catalog)
            if path == "/api/profiles":
                return self.json({"profiles": profile_list(), "default": DEFAULT_PROFILE})
            if path == "/api/health":
                return self.json(
                    {
                        "ok": True,
                        "engine": taverngym.version(),
                        "game": taverngym.game_version(),
                        "catalog": len(SESSION.catalog["cards"]),
                        "hasGame": SESSION.game is not None,
                        "hasNet": len(SESSION.net_slots) > 0,
                        "netSlots": len(SESSION.net_slots),
                    }
                )
            if path == "/api/log":
                with SESSION.lock:
                    g = SESSION.game
                    return self.json({"log": g.log()[-300:] if g else []})
            if path == "/api/assets":
                return self.json(PACK.status())
            if path.startswith("/art/"):
                return self.art(path[5:])
            return self.static(path)
        except Exception as exc:  # noqa: BLE001
            return self.error(f"{type(exc).__name__}: {exc}", 500)

    def do_POST(self) -> None:
        path = urlsplit(self.path).path
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if n > 2_000_000:
                return self.error("请求过大", 413)
            body = json.loads(self.rfile.read(n) or b"{}") if n else {}
            with SESSION.lock:
                if path == "/api/new":
                    races = body.get("races")
                    SESSION.new_game(
                        body.get("seed"),
                        int(body.get("heroChoices", 4)),
                        hero=body.get("hero") or None,
                        races=[str(r) for r in races] if isinstance(races, list) else None,
                        profile_id=body.get("profile") or None,
                    )
                    return self.json(SESSION.view(log_lines=30))
                if path == "/api/action":
                    return self.json(SESSION.act(int(body["action"])))
                # ---- net play ----------------------------------------
                if path == "/api/net/new":
                    client = str(body.get("client") or "")[:64]
                    SESSION.new_net(
                        client,
                        int(body["seed"]),
                        int(body.get("seat", 0)),
                        int(body.get("heroChoices", 4)),
                        races=[str(r) for r in (body.get("races") or [])] or None,
                        config=body.get("config") or None,
                    )
                    # A client that reloaded (or reconnected after a long drop)
                    # rebuilds its engine by replaying the relay's action log.
                    replay = body.get("replay") or []
                    if replay:
                        SESSION.net_apply(client, replay)
                    out = SESSION.net_view(client, with_combats=bool(body.get("combats")))
                    out["replayed"] = len(replay)
                    return self.json(out)
                if path == "/api/net/steps":
                    client = str(body.get("client") or "")[:64]
                    return self.json(SESSION.net_apply(client, body.get("steps") or []))
                if path == "/api/choose":
                    return self.json(SESSION.act(30 + int(body["option"])))
                if path == "/api/undo":
                    return self.json(SESSION.undo())
                if path == "/api/save":
                    SESSION.save()
                    return self.json({"ok": True})
                if path == "/api/load":
                    SESSION.load()
                    return self.json(SESSION.view())
                if path == "/api/finish":
                    SESSION.run_to_end()
                    return self.json(SESSION.view(with_combats=True, log_lines=200))
                if path == "/api/debug":
                    if SESSION.game is None:
                        raise ValueError("请先开始新对局")
                    cmd = dict(body)
                    cmd["p"] = 0
                    allowed = {
                        "set_player", "set_turn", "add_minion", "add_spell", "remove",
                        "edit_minion", "clear_zone", "refresh_shop", "reset_limits",
                        "set_hero", "give_trinket", "offer_trinkets",
                    }
                    if cmd.get("cmd") not in allowed:
                        raise ValueError("该调试命令未开放")
                    SESSION.game.debug(json.dumps(cmd, ensure_ascii=False))
                    SESSION.revision += 1
                    return self.json(SESSION.view(with_combats=False, log_lines=40))
                if path == "/api/assets/download":
                    return self.json(PACK.start(body.get("kinds")))
                if path == "/api/assets/clear":
                    PACK.clear(body.get("kinds"))
                    return self.json(PACK.status())
                if path == "/api/assets/enabled":
                    PACK.set_enabled(bool(body.get("enabled")))
                    return self.json(PACK.status())
                if path == "/api/hero":
                    # Pick a hero by card id (hero select uses the CHOOSE action range).
                    g = SESSION.game
                    raw = json.loads(g.view(0))
                    pending = raw["me"].get("pending") or {}
                    if pending.get("kind") != "hero":
                        raise ValueError("当前不在英雄选择阶段")
                    ids = [o["id"] for o in pending["options"]]
                    if body.get("id") not in ids:
                        raise ValueError("该英雄不在候选中")
                    return self.json(SESSION.act(30 + ids.index(body["id"])))
                return self.error("未知操作", 404)
        except ValueError as exc:
            return self.error(str(exc), 400)
        except KeyError as exc:
            return self.error(f"缺少参数 {exc}", 400)
        except Exception as exc:  # noqa: BLE001
            return self.error(f"{type(exc).__name__}: {exc}", 500)

    def art(self, rest: str) -> None:
        """`/art/<kind>/<card id>` — local art cache, filled from the CDN on demand."""
        parts = rest.split("/")
        if len(parts) != 2:
            return self.error("bad art path", 404)
        kind = parts[0]
        cid = unquote(parts[1]).rsplit(".", 1)[0]
        got = PACK.get(kind, cid)
        if got is None:
            return self.error("not found", 404)
        data, mime = got
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        # Art for a given card id never changes: let the browser keep it.
        self.send_header("Cache-Control", "public, max-age=2592000, immutable")
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def static(self, path: str) -> None:
        if path in ("/", ""):
            path = "/index.html"
        target = (DIST / path.lstrip("/")).resolve()
        if not str(target).startswith(str(DIST.resolve())) or not target.is_file():
            if (DIST / "index.html").is_file():
                target = DIST / "index.html"
            else:
                return self.error(
                    "前端尚未构建：请运行 npm run dev（开发）或 npm run build 后再访问。",
                    404,
                )
        data = target.read_bytes()
        mime = MIME.get(target.suffix.lower()) or mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        self._send(200, data, mime)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8787)))
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.daemon_threads = True
    print(f"BGSIM engine ready: http://{args.host}:{args.port}  (engine {taverngym.version()} / game {taverngym.game_version()})", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
