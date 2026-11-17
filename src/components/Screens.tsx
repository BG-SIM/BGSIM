import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { abandonGame, enqueue, useNet } from '../store/net';
import type { CardRef } from '../types';
import { HeroPortrait, MinionCard, RenderCard, useCardTooltip } from './Cards';
import { HudChrome } from './Tavern';
import { art, cardName, RACE_CN, richText, textOf, tierIcon, tribeIcon } from '../lib/assets';

export function StartScreen() {
  const start = useStore((s) => s.start);
  const catalog = useStore((s) => s.catalog);
  const error = useStore((s) => s.error);
  const setShowCatalog = useStore((s) => s.setShowCatalog);
  const busy = useStore((s) => s.busy);
  const [seed, setSeed] = useState('');
  const heroes: CardRef[] = useMemo(() => {
    if (!catalog) return [];
    return catalog.cards.filter((c) => c.kind === 'hero').slice(0, 7);
  }, [catalog]);

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'grid',
        placeItems: 'center',
        background:
          'radial-gradient(ellipse at 50% 38%, rgba(120, 80, 30, .28), transparent 60%), radial-gradient(ellipse at 50% 120%, #2a1a0c, #060403 70%)',
      }}
    >
      <div style={{ textAlign: 'center', transform: 'translateY(-40px)' }}>
        <div style={{ fontSize: 13, letterSpacing: 8, color: '#a48f66' }}>HEARTHSTONE BATTLEGROUNDS</div>
        <div
          style={{
            fontSize: 76,
            fontWeight: 900,
            letterSpacing: 14,
            color: '#f0d089',
            textShadow: '0 0 40px rgba(255, 190, 80, .35), 0 6px 0 #2a1a08, 0 10px 24px #000',
            lineHeight: 1.15,
          }}
        >
          酒馆战棋
        </div>
        <div style={{ fontSize: 15, letterSpacing: 5, color: '#8d7a55' }}>完 整 八 人 对 局 · 模 拟 器</div>

        <div style={{ display: 'flex', justifyContent: 'center', gap: 14, marginTop: 34, opacity: 0.95 }}>
          {heroes.map((h) => (
            <div key={h.id} style={{ filter: 'drop-shadow(0 10px 18px rgba(0,0,0,.7))' }}>
              <HeroPortrait hero={h} size={72} showNumbers={false} bare />
            </div>
          ))}
        </div>

        <div className="panel" style={{ marginTop: 30, padding: '22px 34px', display: 'inline-flex', flexDirection: 'column', gap: 14, alignItems: 'center' }}>
          <button
            className="btn btn-gold"
            style={{ fontSize: 22, padding: '14px 64px' }}
            disabled={busy}
            onClick={() => start(seed ? Number(seed) : undefined)}
          >
            {busy ? '正在开局…' : '开始对局'}
          </button>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 12, color: '#9f8a60' }}>
            <span>种子</span>
            <input
              value={seed}
              onChange={(e) => setSeed(e.target.value.replace(/[^0-9]/g, ''))}
              placeholder="随机"
              style={{
                width: 120,
                background: 'rgba(0,0,0,.45)',
                border: '1px solid #6d4d25',
                borderRadius: 5,
                padding: '4px 8px',
                color: '#e8dcc0',
                outline: 'none',
              }}
            />
            <button className="btn btn-ghost" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => setShowCatalog(true)}>
              卡牌图鉴
            </button>
          </div>
        </div>

        <div style={{ marginTop: 26, fontSize: 12, color: '#6f5f42', lineHeight: 1.9 }}>
          8 名玩家 · 7 名 AI · 完整酒馆规则与卡池 · 鼠标操作
          <br />
          引擎 {catalog?.engine ?? '…'} · 游戏版本 {catalog?.version ?? '…'} · 卡牌 {catalog?.cards.length ?? 0}
        </div>
        {error && (
          <div style={{ marginTop: 14, fontSize: 12, color: '#ff9d8a', maxWidth: 620 }}>
            无法连接引擎：{error}
            <br />
            请用 <code>npm run start</code> 同时启动引擎与前端，或先运行 <code>npm run server</code>。
          </div>
        )}
      </div>
    </div>
  );
}

/** Pick-phase clock: 45 seconds to decide, the countdown shows for the last 20. */
const PICK_LIMIT = 45;
const PICK_SHOW = 20;

export function HeroSelectScreen() {
  const view = useStore((s) => s.view)!;
  const pending = view.me.pending;
  const pickHero = useStore((s) => s.pickHero);
  const busy = useStore((s) => s.busy);
  const options = pending?.kind === 'hero' ? pending.options : [];
  // The real table asks you to pick, then confirm — it never commits on the
  // first click, so a misclick is not a lost hero.
  const [chosen, setChosen] = useState<string | null>(null);
  const [left, setLeft] = useState(PICK_LIMIT);
  // Refs so the ticking interval always sees the current selection without
  // being torn down and rebuilt every time the player clicks a hero.
  const chosenRef = useRef<string | null>(null);
  const optionsRef = useRef(options);
  const pickRef = useRef(pickHero);
  chosenRef.current = chosen;
  optionsRef.current = options;
  pickRef.current = pickHero;
  const fired = useRef(false);
  useEffect(() => {
    const started = Date.now();
    const t = window.setInterval(() => {
      const l = Math.max(0, PICK_LIMIT - (Date.now() - started) / 1000);
      setLeft(l);
      if (l > 0 || fired.current) return;
      // Time is up: take the highlighted hero, otherwise the first one offered.
      fired.current = true;
      window.clearInterval(t);
      const id = chosenRef.current ?? optionsRef.current[0]?.id;
      if (id) pickRef.current(id);
    }, 200);
    return () => window.clearInterval(t);
  }, []);
  return (
    <div className="hero-pick-screen">
      <img className="board-bg" src="/img/ui/board-darkwood.png" alt="" draggable={false} />
      <div className="hs-dim" />
      <HudChrome />
      <div className="hs-banner">
        <div className="hs-banner-title">选择一个英雄</div>
        <div className="hs-banner-races">
          {/* ABERRATION comes inside lobbyRaces too — show it once, with the deity. */}
          {view.lobbyRaces.filter((r) => r !== 'ABERRATION').map((r) => (
            <span key={r} className="hs-banner-race">
              <img src={tribeIcon(r)} alt="" />
              {RACE_CN[r] ?? r}
            </span>
          ))}
          {view.hasAberrations && (
            <span className="hs-banner-race" title={view.me.deity ? cardName(view.me.deity.card) : '畸变怪'}>
              <img src={tribeIcon('ABERRATION')} alt="" />
              畸变怪
            </span>
          )}
        </div>
      </div>

      <div className="hs-row">
        {options.map((h) => (
          <button
            key={h.id}
            type="button"
            className={'hs-hero' + (chosen === h.id ? ' chosen' : '')}
            disabled={busy}
            onClick={() => setChosen(h.id)}
          >
            <span className="hs-portrait">
              <HeroPortrait hero={h} size={186} bare square showNumbers={false} showTooltip={false} />
            </span>
            <span className="hs-armor" title={`护甲 ${h.armor ?? 0}`}>
              {h.armor ?? 0}
            </span>
            <span className="hs-plinth">{cardName(h)}</span>
            {h.heroPower && <HeroPowerBadge power={h.heroPower} />}
          </button>
        ))}
      </div>

      {left <= PICK_SHOW && (
        <div className={'hs-timer turn-plaque' + (left <= 10 ? ' urgent' : '')}>
          <span className="turn-clock topbar-time">{Math.max(1, Math.ceil(left))}秒</span>
        </div>
      )}

      <div className="hs-actions">
        <button
          type="button"
          className="hs-confirm"
          disabled={!chosen || busy}
          onClick={() => chosen && pickHero(chosen)}
        >
          {busy ? '开始中…' : '确认'}
        </button>
        <span className="hs-hint">点击头像挑选 · 护甲可以抵挡伤害</span>
      </div>
    </div>
  );
}

/**
 * The hero-power badge on the picker: hovering it pops the same card tooltip
 * the table uses, so the rule text is readable before committing to a hero.
 */
type PowerBadge = CardRef & { passive?: boolean; price?: number | null };

function HeroPowerBadge({ power }: { power: PowerBadge }) {
  const { show, hide, node } = useCardTooltip();
  const cost = power.passive ? '被动技能' : power.price != null ? `消耗 ${power.price} 枚铸币` : '英雄技能';
  return (
    <span
      className="hs-power"
      onMouseEnter={(e) => show(e, power, <span className="hs-power-tip">{cost}</span>)}
      onMouseLeave={hide}
      onClick={(e) => e.stopPropagation()}
    >
      {node}
      <img src={art.portrait(power.id)} alt="" draggable={false} onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')} />
      <span className="hs-power-cost">{power.passive ? '被动' : power.price}</span>
    </span>
  );
}

export function GameOverScreen() {
  const view = useStore((s) => s.view)!;
  const start = useStore((s) => s.start);
  const mode = useStore((s) => s.mode);
  const enterSolo = useStore((s) => s.enterSolo);
  const setScreen = useStore((s) => s.setScreen);
  const net = useNet();
  const placement = view.me.placement || 8;
  const title = placement === 1 ? '吃鸡！' : placement <= 4 ? '进入前四' : '再接再厉';
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'grid',
        placeItems: 'center',
        background: 'radial-gradient(ellipse at 50% 40%, rgba(80,50,20,.5), #050302 72%)',
      }}
    >
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 14, letterSpacing: 6, color: '#a48f66' }}>对局结束</div>
        <div style={{ fontSize: 88, fontWeight: 900, color: '#f0d089', textShadow: '0 0 40px rgba(255,190,80,.4), 0 6px 0 #2a1a08' }}>
          第 {placement} 名
        </div>
        <div style={{ fontSize: 22, color: '#e6d4ab', letterSpacing: 4 }}>{title}</div>

        <div style={{ display: 'flex', justifyContent: 'center', gap: 6, marginTop: 26 }}>
          {view.me.board.map((m) => (
            <MinionCard key={m.eid} card={m} scale={0.62} interactive={false} />
          ))}
        </div>

        <div className="panel" style={{ display: 'inline-flex', gap: 26, padding: '14px 28px', marginTop: 22, fontSize: 13, color: '#cdbb95' }}>
          <span>回合数 <b style={{ color: '#ffe1a0' }}>{view.turn}</b></span>
          <span>生命 <b style={{ color: '#ff8d7a' }}>{view.me.health}</b></span>
          <span>等级 <b style={{ color: '#ffe1a0' }}>{view.me.tier}</b></span>
          <span>存活 <b style={{ color: '#ffe1a0' }}>{view.alive}</b></span>
        </div>

        <div style={{ marginTop: 26, display: 'flex', gap: 14, justifyContent: 'center' }}>
          {mode === 'net' ? (
            <>
              <button
                className="btn btn-gold"
                style={{ fontSize: 18, padding: '12px 42px', letterSpacing: 3 }}
                onClick={() => {
                  abandonGame();
                  setScreen('net');
                  void enqueue();
                }}
              >
                再 排 一 局
              </button>
              <button
                className="btn"
                style={{ fontSize: 16, padding: '12px 30px', letterSpacing: 2 }}
                onClick={() => {
                  abandonGame();
                  enterSolo();
                  setScreen('home');
                }}
              >
                返回大厅
              </button>
            </>
          ) : (
            <>
              <button className="btn btn-gold" style={{ fontSize: 18, padding: '12px 42px', letterSpacing: 3 }} onClick={() => start()}>
                再 来 一 局
              </button>
              <button
                className="btn"
                style={{ fontSize: 16, padding: '12px 30px', letterSpacing: 2 }}
                onClick={() => {
                  enterSolo();
                  setScreen('home');
                }}
              >
                返回首页
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function CatalogOverlay() {
  const catalog = useStore((s) => s.catalog);
  const setShow = useStore((s) => s.setShowCatalog);
  const [tier, setTier] = useState<number | null>(1);
  const [race, setRace] = useState<string | null>(null);
  const [q, setQ] = useState('');

  const races = useMemo(() => {
    const set = new Set<string>();
    for (const c of catalog?.cards ?? []) for (const r of c.races ?? []) if (r !== 'ALL') set.add(r);
    return Array.from(set).sort();
  }, [catalog]);

  const list = useMemo(() => {
    // Tier 7 minions never enter the shop pool, so `inPool` is false for them —
    // include them explicitly (base card only, the `_G` twin is the same art).
    const cards = (catalog?.cards ?? []).filter(
      (c) => c.kind === 'minion' && (c.inPool || (c.tier === 7 && !c.id.endsWith('_G'))),
    );
    return cards.filter(
      (c) =>
        (tier === null || c.tier === tier) &&
        (!race || (c.races ?? []).includes(race)) &&
        (!q || c.nameZh.includes(q) || c.name.toLowerCase().includes(q.toLowerCase())),
    );
  }, [catalog, tier, race, q]);

  if (!catalog) return null;

  return (
    <div className="modal-backdrop" style={{ zIndex: 200 }}>
      <div className="modal" style={{ width: 1240, maxHeight: 760, minHeight: 420, display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <h2 style={{ margin: 0 }}>卡牌图鉴</h2>
          <div className="sub" style={{ margin: 0 }}>
            共 {list.length} 张 · 版本 {catalog.version}
          </div>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索名称…"
            style={{
              marginLeft: 'auto',
              width: 200,
              background: 'rgba(0,0,0,.45)',
              border: '1px solid #6d4d25',
              borderRadius: 5,
              padding: '6px 10px',
              color: '#e8dcc0',
              outline: 'none',
            }}
          />
          <button className="btn btn-ghost" onClick={() => setShow(false)}>
            关闭
          </button>
        </div>

        <div style={{ display: 'flex', gap: 6, marginTop: 12, flexWrap: 'wrap' }}>
          <button className={`btn ${tier === null ? 'btn-gold' : 'btn-ghost'}`} style={{ padding: '3px 10px', fontSize: 12 }} onClick={() => setTier(null)}>
            全部星级
          </button>
          {[1, 2, 3, 4, 5, 6, 7].map((t) => (
            <button
              key={t}
              className={`btn ${tier === t ? 'btn-gold' : 'btn-ghost'}`}
              style={{ padding: '3px 8px', fontSize: 12 }}
              onClick={() => setTier(t)}
            >
              <img src={tierIcon(t)} alt="" style={{ width: 18 }} /> {t}
            </button>
          ))}
          <span style={{ width: 12 }} />
          <button className={`btn ${!race ? 'btn-gold' : 'btn-ghost'}`} style={{ padding: '3px 10px', fontSize: 12 }} onClick={() => setRace(null)}>
            全部种族
          </button>
          {races.map((r) => (
            <button
              key={r}
              className={`btn ${race === r ? 'btn-gold' : 'btn-ghost'}`}
              style={{ padding: '3px 8px', fontSize: 12 }}
              onClick={() => setRace(r)}
            >
              <img src={tribeIcon(r)} alt="" style={{ width: 16, height: 16, borderRadius: '50%' }} /> {RACE_CN[r] ?? r}
            </button>
          ))}
        </div>

        <div className="scroll-y" style={{ flex: 1, marginTop: 12, display: 'flex', flexWrap: 'wrap', gap: 8, alignContent: 'flex-start' }}>
          {list.map((c) => (
            <MinionCard key={c.id} card={c} scale={0.7} interactive={false} />
          ))}
        </div>
      </div>
    </div>
  );
}
