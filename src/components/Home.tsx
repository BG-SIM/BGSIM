import React, { useMemo, useState } from 'react';
import { useStore, type StartOptions } from '../store';
import { cancelQueue, enqueue, resumeGame, useNet } from '../store/net';
import type { CardRef } from '../types';
import { HeroPortrait } from './Cards';
import { RACE_CN, cardName, tribeIcon } from '../lib/assets';
import { APP_VERSION } from '../lib/version';

/** The tribes a lobby can be built from, plus the aberration twist. */
const TRIBES = ['BEAST', 'DEMON', 'DRAGON', 'ELEMENTAL', 'MECHANICAL', 'MURLOC', 'NAGA', 'PIRATE', 'QUILBOAR', 'UNDEAD', 'ABERRATION'];
/** A lobby is five tribes: pick up to five, the rest is filled at random. */
const MAX_TRIBES = 5;
const TRIBE_LABEL: Record<string, string> = { ...RACE_CN, ABERRATION: '畸变怪' };

/** The engine's stand-in hero is not a real pick. */
function isPlayableHero(card: CardRef): boolean {
  return card.kind === 'hero' && card.id !== 'TB_BaconShop_HERO_PH' && !/^baconph/i.test(card.name ?? '');
}

/**
 * The unified launcher. Everything the app can do hangs off three lists on the
 * right — single player (playable), multiplayer and resource packs (not yet).
 * The single-player game itself is unchanged: this only decides what to show
 * before it, and gives a way back without throwing the run away (the game lives
 * on the engine, so "返回首页" is free).
 */
export function HomeScreen() {
  const catalog = useStore((s) => s.catalog);
  const screenView = useStore((s) => s.view);
  const soloView = useStore((s) => s.soloView);
  const mode = useStore((s) => s.mode);
  const error = useStore((s) => s.error);
  const busy = useStore((s) => s.busy);
  const start = useStore((s) => s.start);
  const setScreen = useStore((s) => s.setScreen);
  const enterSolo = useStore((s) => s.enterSolo);
  const enterNet = useStore((s) => s.enterNet);
  const setShowCatalog = useStore((s) => s.setShowCatalog);
  const booting = useStore((s) => s.booting);
  const net = useNet();
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  // While a multiplayer match is live the store's `view` is that match; the
  // single-player card must keep showing the single-player run.
  const view = mode === 'net' ? soloView : screenView;

  const heroes: CardRef[] = useMemo(() => {
    if (!catalog) return [];
    return catalog.cards.filter(isPlayableHero).slice(0, 7);
  }, [catalog]);

  // Every hero, for the custom-game picker (the strip above only shows seven).
  const allHeroes: CardRef[] = useMemo(() => {
    if (!catalog) return [];
    return catalog.cards
      .filter(isPlayableHero)
      .sort((a, b) => cardName(a).localeCompare(cardName(b), 'zh-Hans-CN'));
  }, [catalog]);

  const running = Boolean(view && view.phase !== 'game_over');
  const finished = Boolean(view && view.phase === 'game_over');

  const enterSingle = () => {
    // Restore the single-player run before the tavern draws itself.
    enterSolo();
    setScreen('single');
  };

  const startNormal = () => {
    if (running && !confirmRestart) {
      setConfirmRestart(true);
      window.setTimeout(() => setConfirmRestart(false), 4000);
      return;
    }
    setConfirmRestart(false);
    void start(undefined, { timeLimit: true }).then(() => setScreen('single'));
  };

  const startCustom = (opts: StartOptions) => {
    void start(undefined, opts).then(() => {
      setCustomOpen(false);
      setScreen('single');
    });
  };

  return (
    <div className="home">
      <div className="home-left">
        <div className="home-eyebrow">HEARTHSTONE BATTLEGROUNDS</div>
        <div className="home-title">酒馆战棋</div>
        <div className="home-sub">完整八人对局 · 模拟器</div>

        <div className="home-heroes">
          {heroes.map((h) => (
            <div key={h.id} className="home-hero" title={cardName(h)}>
              <HeroPortrait hero={h} size={64} showNumbers={false} bare />
            </div>
          ))}
        </div>

        <div className="home-meta">
          BGSIM v{APP_VERSION} · 引擎 {catalog?.engine ?? '…'} · 游戏版本 {catalog?.version ?? '…'} · 卡牌 {catalog?.cards?.length ?? 0}
          {booting && <span className="home-meta-live"> · 正在连接…</span>}
        </div>
        {error && <div className="home-error">无法连接引擎：{error}</div>}
      </div>

      <div className="home-right">
        {/* ── single player ─────────────────────────────────────── */}
        <section className="home-card" data-mode="single" onClick={enterSingle} role="button" tabIndex={0}>
          <header className="home-card-head">
            <span className="home-card-icon">单</span>
            <span className="home-card-title">单机模式</span>
            <span className="home-card-state live">
              {running ? `进行中 · 第 ${view?.turn ?? 1} 回合` : finished ? `已结束 · 第 ${view?.me.placement ?? 0} 名` : '可进入'}
            </span>
          </header>
          <ul className="home-card-list">
            {running && (
              <li
                className="home-item"
                data-act="continue"
                onClick={(e) => {
                  e.stopPropagation();
                  enterSingle();
                }}
              >
                <span className="home-item-name">继续游戏</span>
                <span className="home-item-note">{`${cardName(view?.me.hero)} · ${view?.me.health ?? 0} 血`}</span>
              </li>
            )}
            {finished && (
              <li
                className="home-item"
                onClick={(e) => {
                  e.stopPropagation();
                  enterSingle();
                }}
              >
                <span className="home-item-name">查看结算</span>
                <span className="home-item-note">{`第 ${view?.me.placement ?? 0} 名`}</span>
              </li>
            )}
            <li
              className={'home-item' + (busy ? ' busy' : '')}
              data-act="start"
              onClick={(e) => {
                e.stopPropagation();
                startNormal();
              }}
            >
              <span className="home-item-name">{confirmRestart ? '确认重开？会放弃当前对局' : '开始对局'}</span>
              <span className="home-item-note">{running ? '会放弃当前对局' : '随机英雄与种族 · 限时'}</span>
            </li>
            <li
              className={'home-item' + (customOpen ? ' active' : '')}
              data-act="custom"
              onClick={(e) => {
                e.stopPropagation();
                setCustomOpen((open) => !open);
              }}
            >
              <span className="home-item-name">自定义游戏</span>
              <span className="home-item-note">{customOpen ? '收起设置' : '指定英雄 / 种族 / 是否限时'}</span>
            </li>
            <li
              className="home-item"
              data-act="catalog"
              onClick={(e) => {
                e.stopPropagation();
                setShowCatalog(true);
              }}
            >
              <span className="home-item-name">卡牌图鉴</span>
              <span className="home-item-note">{catalog?.cards?.length ?? 0} 张可见卡牌</span>
            </li>
          </ul>
          {customOpen && <CustomGamePanel busy={busy} heroes={allHeroes} onStart={startCustom} />}
        </section>

        {/* ── multiplayer ───────────────────────────────────────── */}
        <section className="home-card" data-mode="multi">
          <header className="home-card-head">
            <span className="home-card-icon">联</span>
            <span className="home-card-title">联机模式</span>
            <span
              className={
                'home-card-state' + (net.status === 'playing' || net.status === 'over' ? ' live' : net.status === 'error' ? ' bad' : '')
              }
            >
              {net.status === 'playing'
                ? `进行中 · 座位 ${net.seat + 1}`
                : net.status === 'over'
                  ? '本局已结束'
                  : net.inQueue
                    ? `排队中 ${net.queued}/${net.need}`
                    : net.status === 'error'
                      ? '连接失败'
                      : '可进入'}
            </span>
          </header>
          <ul className="home-card-list">
            {net.status === 'playing' || net.status === 'over' ? (
              <li
                className="home-item"
                data-act="net-return"
                onClick={(e) => {
                  e.stopPropagation();
                  enterNet();
                }}
              >
                <span className="home-item-name">{net.status === 'over' ? '查看结算' : '回到对局'}</span>
                <span className="home-item-note">{`座位 ${net.seat + 1} · ${net.name}`}</span>
              </li>
            ) : net.inQueue ? (
              <li
                className="home-item"
                data-act="net-cancel"
                onClick={(e) => {
                  e.stopPropagation();
                  cancelQueue();
                }}
              >
                <span className="home-item-name">{`排队中 ${net.queued}/${net.need}`}</span>
                <span className="home-item-note">点击取消排队</span>
              </li>
            ) : (
              <li
                className={'home-item' + (net.status === 'connecting' ? ' busy' : '')}
                data-act="net-queue"
                onClick={(e) => {
                  e.stopPropagation();
                  setScreen('net');
                  void enqueue();
                }}
              >
                <span className="home-item-name">{net.status === 'connecting' ? '连接中…' : '开始排队'}</span>
                <span className="home-item-note">八人满即开局 · 每人一台机器各跑同一局</span>
              </li>
            )}
            {net.resumable && net.status !== 'playing' && net.status !== 'over' && (
              <li
                className="home-item"
                data-act="net-resume"
                onClick={(e) => {
                  e.stopPropagation();
                  setScreen('net');
                  void resumeGame();
                }}
              >
                <span className="home-item-name">回到刚才那局</span>
                <span className="home-item-note">页面刷新前的对局还在这台机器上</span>
              </li>
            )}
            <li className="home-item" onClick={(e) => { e.stopPropagation(); setScreen('net'); }}>
              <span className="home-item-name">联机大厅</span>
              <span className="home-item-note">中继 {net.relay}</span>
            </li>
          </ul>
        </section>

        {/* ── resource packs ────────────────────────────────────── */}
        <AssetPackCard />
      </div>
    </div>
  );
}

/**
 * 自定义游戏: pin the hero you start with, the tribes in the lobby, and whether
 * the turn clock runs at all. Everything left empty is random, like a normal
 * game.
 */
function CustomGamePanel({
  busy,
  heroes,
  onStart,
}: {
  busy: boolean;
  heroes: CardRef[];
  onStart: (opts: StartOptions) => void;
}) {
  const [hero, setHero] = useState<string | null>(null);
  const [races, setRaces] = useState<string[]>([]);
  const [timeLimit, setTimeLimit] = useState(true);
  const picked = heroes.find((h) => h.id === hero) ?? null;

  const full = races.length >= MAX_TRIBES;
  const toggleRace = (race: string) =>
    setRaces((cur) => {
      if (cur.includes(race)) return cur.filter((r) => r !== race);
      if (cur.length >= MAX_TRIBES) return cur; // five is the cap
      return [...cur, race];
    });

  return (
    <div className="home-custom" onClick={(e) => e.stopPropagation()}>
      <div className="hc-row">
        <span className="hc-label">英雄</span>
        <div className="hc-hero">
          {picked && <HeroPortrait hero={picked} size={30} showNumbers={false} bare />}
          <select className="hc-select" value={hero ?? ''} onChange={(e) => setHero(e.target.value || null)}>
            <option value="">随机英雄</option>
            {heroes.map((h) => (
              <option key={h.id} value={h.id}>
                {cardName(h)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="hc-row">
        <span className="hc-label">种族</span>
        <div className="hc-chips">
          {TRIBES.map((race) => (
            <button
              key={race}
              data-tribe={race}
              className={'hc-chip' + (races.includes(race) ? ' on' : '') + (!races.includes(race) && full ? ' full' : '')}
              title={!races.includes(race) && full ? `最多选 ${MAX_TRIBES} 个` : undefined}
              onClick={() => toggleRace(race)}
            >
              <img src={tribeIcon(race)} alt="" />
              {TRIBE_LABEL[race] ?? race}
            </button>
          ))}
        </div>
      </div>

      <div className="hc-row">
        <span className="hc-label">时间</span>
        <div className="hc-chips">
          <button className={'hc-chip' + (timeLimit ? ' on' : '')} onClick={() => setTimeLimit(true)}>
            有时间限制
          </button>
          <button className={'hc-chip' + (!timeLimit ? ' on' : '')} onClick={() => setTimeLimit(false)}>
            无时间限制
          </button>
        </div>
      </div>

      <div className="hc-actions">
        <span className="hc-hint">
          {races.length === 0 ? '种族留空 = 随机 5 种' : `已选 ${races.length}/${MAX_TRIBES} 个种族`}
          {races.length > 0 && races.length < MAX_TRIBES ? '（不够的随机补）' : ''}
          {!timeLimit ? ' · 不计时' : ''}
        </span>
        <button className="btn btn-gold" disabled={busy} onClick={() => onStart({ hero, races, timeLimit })}>
          开始自定义对局
        </button>
      </div>
    </div>
  );
}

/** 资源包: download the CDN art once, then the game runs off the local cache. */
function AssetPackCard() {
  const assets = useStore((s) => s.assets);
  const refresh = useStore((s) => s.refreshAssets);
  const download = useStore((s) => s.downloadAssets);
  const clear = useStore((s) => s.clearAssets);
  const toggle = useStore((s) => s.setAssetsEnabled);
  const [confirmClear, setConfirmClear] = useState(false);

  // Poll while a download is running so the bars move.
  React.useEffect(() => {
    if (!assets?.running) return;
    const t = window.setInterval(() => void refresh(), 1000);
    return () => window.clearInterval(t);
  }, [assets?.running, refresh]);

  const kinds = assets?.kinds ?? {};
  const order = ['hero', 'heroSq', 'portrait', 'render'];
  const totalBytes = Object.values(kinds).reduce((n, k) => n + k.diskBytes, 0);
  const estimate = assets?.estimate ?? 0;
  const mb = (n: number) => (n < 1024 * 1024 ? (n / 1024).toFixed(0) + ' KB' : (n / 1024 / 1024).toFixed(n >= 100 * 1024 * 1024 ? 0 : 1) + ' MB');
  const allDone = order.every((k) => kinds[k]?.complete);

  return (
    <section className="home-card" data-mode="packs">
      <header className="home-card-head">
        <span className="home-card-icon">包</span>
        <span className="home-card-title">资源包</span>
        <span className={'home-card-state' + (assets?.enabled ? ' live' : '')}>
          {assets?.running ? '下载中…' : assets?.enabled ? `本地素材 · ${mb(totalBytes)}` : '走 CDN'}
        </span>
      </header>
      <ul className="home-card-list">
        {order.map((key) => {
          const k = kinds[key];
          if (!k) return null;
          const pct = k.total ? Math.min(100, Math.round((k.files / k.total) * 100)) : 0;
          const hasFiles = k.files > 0;
          return (
            <li className="home-item asset-row" key={key} data-kind={key}>
              <span className="home-item-name" title={k.estimate ? `约 ${mb(k.estimate)}` : undefined}>
                {k.label}
              </span>
              <span className="asset-bar">
                <i style={{ width: `${pct}%` }} />
              </span>
              <span className="home-item-note">
                {`${k.files}/${k.total}${k.missing > 0 ? ` · 缺 ${k.missing}` : ''} · ${mb(k.diskBytes)}`}
                {k.errors > 0 ? ` · 网络错误 ${k.errors}` : ''}
              </span>
              <button
                className="btn btn-ghost asset-btn"
                disabled={assets?.running || k.complete}
                onClick={() => void download([key])}
              >
                {k.complete ? '已就绪' : k.running ? '下载中' : '下载'}
              </button>
              {hasFiles && (
                <button
                  className="btn btn-ghost asset-btn asset-clear"
                  disabled={assets?.running}
                  onClick={() => void clear([key])}
                  title={`清空${k.label}`}
                >
                  清空
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <div className="asset-actions">
        <button className="btn btn-gold" disabled={assets?.running || allDone} onClick={() => void download()}>
          {allDone ? '全部已就绪' : `全部下载${estimate ? `（约 ${mb(estimate)}）` : ''}`}
        </button>
        <button
          className={'btn' + (assets?.enabled ? ' btn-gold' : '')}
          disabled={assets?.running}
          onClick={() => void toggle(!assets?.enabled)}
          title="还没下全时，缺的图仍会临时走 CDN"
        >
          {assets?.enabled ? '使用本地素材' : '改用本地素材'}
        </button>
        <button
          className="btn btn-ghost"
          disabled={assets?.running}
          onClick={() => {
            if (!confirmClear) {
              setConfirmClear(true);
              window.setTimeout(() => setConfirmClear(false), 4000);
              return;
            }
            setConfirmClear(false);
            void clear();
          }}
          title={`清空全部（当前 ${mb(totalBytes)}）`}
        >
          {confirmClear ? '确认清空？' : '清空全部'}
        </button>
      </div>
      {assets?.error && <div className="home-error">{assets.error}</div>}
    </section>
  );
}
