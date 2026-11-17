"""Local art pack: keep every asset the game actually shows on disk.

The UI points at `art.hearthstonejson.com` for card portraits, card faces and
hero portraits. Once the pack is downloaded nothing waits on the network again —
which is the whole point. Three kinds, matching `src/lib/assets.ts`:

    hero      142  hero portraits         256px png   ~14 MB
    portrait  2063 card portraits         256px jpg   ~26 MB
    render    1096 full card faces        256px png   ~160 MB

Two decisions keep the pack at ~200 MB instead of ~1 GB:

* **256px renders, not 512px.** A card face is drawn at 168x200 CSS px; at 2x
  that is 336x400 device pixels, so the 256px art is already enough. The 512px
  original is 465 KB a piece, the 256px one is 149 KB.
* **Base cards only.** Golden ids (`*_G`) are the same art with a CSS gild on
  top (`RenderCard` asks for `baseId` first), so the 1109 `_G` twins would have
  been a duplicate 165 MB.

Files live in `data/assets/<kind>/<id>.<ext>`. `GET /art/<kind>/<id>` serves the
cached file, or fetches it once and stores it, so the client can always point at
us: pre-downloaded packs make it instant, a cold cache still works online.
"""
from __future__ import annotations

import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "data" / "assets"
STATE = ROOT / "data" / "assets.json"

CDN = "https://art.hearthstonejson.com"
KINDS = {
    "hero": (f"{CDN}/v1/heroes/latest/256x/{{id}}.png", "png", "英雄头像", 100 * 1024),
    # Square card-art crop of a hero, no arch frame: used by the opponent rail
    # and the hero picker, where the real table shows a plain square portrait.
    "heroSq": (f"{CDN}/v1/256x/{{id}}.jpg", "jpg", "方形英雄头像", 15 * 1024),
    "portrait": (f"{CDN}/v1/256x/{{id}}.jpg", "jpg", "卡牌肖像", 14 * 1024),
    # 512px costs 3x the bytes and is not visible at the sizes the UI draws.
    "render": (f"{CDN}/v1/bgs/latest/zhCN/256x/{{id}}.png", "png", "卡面渲染", 149 * 1024),
}
ORDER = ["hero", "heroSq", "portrait", "render"]

# v2 switched `render` from 512px to 256px; old files are the same name with a
# different size, so they have to go rather than silently mix.
CACHE_VERSION = 2


def _system_proxy() -> dict[str, str] | None:
    """The Windows (WinINET) proxy, if one is set.

    `urllib` only honours `HTTP(S)_PROXY` env vars, but on Windows the proxy is
    usually configured system-wide — without this, downloads fail with a bare
    "connection refused" while the browser loads the same URL fine.
    """
    if os.name != "nt":
        return None
    try:
        import winreg

        key = r"Software\Microsoft\Windows\CurrentVersion\Internet Settings"
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key) as k:
            enabled = winreg.QueryValueEx(k, "ProxyEnable")[0]
            server = winreg.QueryValueEx(k, "ProxyServer")[0]
    except Exception:  # noqa: BLE001 - no registry access / no proxy
        return None
    if not enabled or not server:
        return None
    if "=" in server:  # "http=host:port;https=host:port"
        out = {}
        for part in server.split(";"):
            if "=" in part:
                proto, host = part.split("=", 1)
                host = host.strip()
                out[proto.strip()] = host if host.startswith("http") else f"http://{host}"
        return out or None
    url = server if server.startswith("http") else f"http://{server}"
    return {"http": url, "https": url}


class AssetPack:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.enabled = False
        self.job: threading.Thread | None = None
        self.kinds = {
            k: {"total": 0, "done": 0, "missing": 0, "errors": 0, "bytes": 0, "running": False}
            for k in KINDS
        }
        self.error = ""
        self.started = 0.0
        self._manifest: dict[str, list[str]] = {}
        # Direct first (fast on TUN/transparent setups), system proxy second.
        self._openers: list = [None]
        proxy = _system_proxy()
        if proxy:
            self._openers.append(urllib.request.build_opener(urllib.request.ProxyHandler(proxy)))
        self._load_state()
        self._migrate()

    # -- state ------------------------------------------------------------
    def _read_state(self) -> dict:
        try:
            if STATE.is_file():
                return json.loads(STATE.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001 - a broken state file is not fatal
            pass
        return {}

    def _load_state(self) -> None:
        raw = self._read_state()
        self.enabled = bool(raw.get("enabled"))
        # Remember which ids the CDN does not have, so a finished pack does not
        # look "incomplete" after a restart just because it retried the 404s.
        for k, n in (raw.get("missing") or {}).items():
            if k in self.kinds:
                self.kinds[k]["missing"] = int(n)

    def _save_state(self) -> None:
        try:
            STATE.parent.mkdir(parents=True, exist_ok=True)
            STATE.write_text(
                json.dumps(
                    {
                        "enabled": self.enabled,
                        "cache_version": CACHE_VERSION,
                        "missing": {k: v["missing"] for k, v in self.kinds.items()},
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
        except Exception:  # noqa: BLE001
            pass

    def _migrate(self) -> None:
        """Drop caches written by an older layout (here: 512px card faces)."""
        if int(self._read_state().get("cache_version", 1)) >= CACHE_VERSION:
            return
        folder = CACHE / "render"
        if folder.is_dir():
            for f in folder.iterdir():
                try:
                    f.unlink()
                except OSError:
                    pass
        self._save_state()

    def set_enabled(self, enabled: bool) -> None:
        with self.lock:
            self.enabled = bool(enabled)
        self._save_state()

    def status(self) -> dict:
        with self.lock:
            kinds = {k: dict(v) for k, v in self.kinds.items()}
            running = bool(self.job and self.job.is_alive())
        for k, info in kinds.items():
            files, size = self._disk(k)
            info["files"] = files
            info["diskBytes"] = size
            info["label"] = KINDS[k][2]
            info["complete"] = info["total"] > 0 and (files >= info["total"] or files + info["missing"] >= info["total"])
            # Rough number for the UI before the download starts.
            info["estimate"] = info["total"] * KINDS[k][3]
        return {
            "enabled": self.enabled,
            "running": running,
            "kinds": kinds,
            "error": self.error or None,
            "startedAt": self.started or None,
            "cdn": CDN,
            "prefetch": list(ORDER),
            "estimate": sum(kinds[k]["estimate"] for k in ORDER),
        }

    def _disk(self, kind: str) -> tuple[int, int]:
        folder = CACHE / kind
        if not folder.is_dir():
            return 0, 0
        files = 0
        size = 0
        for f in folder.iterdir():
            if f.is_file():
                files += 1
                size += f.stat().st_size
        return files, size

    # -- manifests --------------------------------------------------------
    def set_catalog(self, cards: list[dict]) -> None:
        """Build the per-kind id lists once the catalog is known."""
        heroes = [c["id"] for c in cards if c.get("kind") == "hero" and c.get("id")]
        cards_all = [c["id"] for c in cards if c.get("kind") != "hero" and c.get("id")]
        # Golden twins (`*_G`) share the art of their base card: `RenderCard` asks
        # for `baseId` first, so pre-loading 1109 `_G` faces would be a duplicate
        # 165 MB. Portraits are 14 KB each, so those are fetched for both (a
        # golden portrait does exist and looks better than the base one).
        cards_base = [cid for cid in cards_all if not cid.endswith("_G")]
        with self.lock:
            self._manifest = {"hero": heroes, "heroSq": heroes, "portrait": cards_all, "render": cards_base}
            for k, ids in self._manifest.items():
                files, size = self._disk(k)
                self.kinds[k].update(total=len(ids), done=files, bytes=size)

    # -- download ---------------------------------------------------------
    def start(self, kinds: list[str] | None = None) -> dict:
        wanted = [k for k in (kinds or ORDER) if k in KINDS]
        if not wanted:
            return {"ok": False, "error": "没有要下载的类别"}
        with self.lock:
            if self.job and self.job.is_alive():
                return {"ok": True, "already": True}
            if not self._manifest:
                return {"ok": False, "error": "目录还没有准备好"}
            for k in wanted:
                self.kinds[k]["running"] = True
            self.error = ""
            self.started = time.time()
            self.job = threading.Thread(target=self._run, args=(wanted,), daemon=True)
            self.job.start()
        return {"ok": True, "kinds": wanted}

    def _run(self, kinds: list[str]) -> None:
        try:
            from concurrent.futures import ThreadPoolExecutor

            # Serial requests take ~1.5 s each here, which is an hour for the
            # whole pack; 8 workers bring it down to a few minutes.
            with ThreadPoolExecutor(max_workers=8) as pool:
                for kind in kinds:
                    ids = self._manifest.get(kind, [])
                    list(pool.map(lambda cid, k=kind: self._fetch_one(k, cid, count=True), ids))
                    with self.lock:
                        self.kinds[kind]["running"] = False
        except Exception as exc:  # noqa: BLE001
            self.error = f"{type(exc).__name__}: {exc}"
        finally:
            with self.lock:
                for k in kinds:
                    self.kinds[k]["running"] = False
            self._save_state()

    def _path(self, kind: str, cid: str) -> Path:
        return CACHE / kind / f"{cid}.{KINDS[kind][1]}"

    def _fetch_one(self, kind: str, cid: str, count: bool = False) -> bytes | None:
        """Cache-first fetch used by both the downloader and the HTTP route."""
        path = self._path(kind, cid)
        if path.is_file():
            try:
                return path.read_bytes()
            except OSError:
                pass
        url = KINDS[kind][0].format(id=urllib.parse.quote(cid))
        req = urllib.request.Request(url, headers={"User-Agent": "BGSIM/0.1"})
        data = None
        missing = False
        failed = False
        for i, opener in enumerate(self._openers):
            try:
                if opener is None:
                    resp = urllib.request.urlopen(req, timeout=15)
                else:
                    resp = opener.open(req, timeout=20)
                with resp:
                    data = resp.read()
                if i > 0:  # remember whichever route worked for the rest of the batch
                    with self.lock:
                        if opener in self._openers:
                            self._openers.insert(0, self._openers.pop(self._openers.index(opener)))
                break
            except urllib.error.HTTPError:
                missing = True
                break  # 404 is an answer, not a transport problem
            except Exception:  # noqa: BLE001 - try the next route (proxy / direct)
                failed = True
                continue
        if data is None:
            if count:
                with self.lock:
                    if missing:
                        self.kinds[kind]["missing"] += 1
                    elif failed:
                        self.kinds[kind]["errors"] += 1
            return None
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(path.suffix + ".part")
            tmp.write_bytes(data)
            tmp.replace(path)
        except OSError:
            return data
        if count:
            with self.lock:
                self.kinds[kind]["done"] += 1
                self.kinds[kind]["bytes"] += len(data)
        return data

    def get(self, kind: str, cid: str) -> tuple[bytes, str] | None:
        if kind not in KINDS or not cid:
            return None
        data = self._fetch_one(kind, cid)
        if data is None:
            return None
        return data, "image/png" if KINDS[kind][1] == "png" else "image/jpeg"

    def clear(self, kinds: list[str] | None = None) -> None:
        with self.lock:
            if self.job and self.job.is_alive():
                return
            for kind in (kinds or list(KINDS)):
                if kind not in KINDS:
                    continue
                folder = CACHE / kind
                if folder.is_dir():
                    for f in folder.iterdir():
                        try:
                            f.unlink()
                        except OSError:
                            pass
                self.kinds[kind].update(done=0, missing=0, errors=0, bytes=0, running=False)


PACK = AssetPack()
