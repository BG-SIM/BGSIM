import React, { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useStore } from '../store';
import { useUiEditor } from '../store/uiEditor';
import type { Combat, CombatMinion } from '../types';
import { MinionCard, HeroPortrait } from './Cards';
import { GoldPanel, HudChrome, OpponentsRail, PlayerHero } from './Tavern';
import { art, cardName } from '../lib/assets';
import { sfx } from '../lib/sfx';
import { formatCombatLog } from '../lib/log';

type MetaMinion = CombatMinion & { nameZh: string; textZh: string; tier: number | null };

function withMeta(m: CombatMinion, catalog: ReturnType<typeof useStore.getState>['catalog']): MetaMinion {
  const meta = catalog?.byId[m.id] ?? catalog?.byId[m.id.replace(/_G$/, '')];
  return {
    ...m,
    tier: m.tier ?? meta?.tier ?? 1,
    races: m.races?.length ? m.races : meta?.races ?? [],
    nameZh: meta?.nameZh ?? '',
    textZh: meta?.textZh ?? '',
  };
}

export function CombatOverlay({ combat }: { combat: Combat }) {
  const view = useStore((s) => s.view)!;
  const catalog = useStore((s) => s.catalog);
  const resolve = useStore((s) => s.resolveCombat);
  const playerSide = combat.a === 0 ? 0 : 1;
  const enemySide = 1 - playerSide;
  const enemyId = playerSide === 0 ? combat.b : combat.a;
  const enemy = view.opponents.find((o) => o.id === enemyId) ?? null;
  // The fight reuses the table's own boxes: the opponent stands where the shop
  // sits, our warband where our board sits, at the same card scales.
  const shopBox = useUiEditor((s) => s.boxes.shopRow);
  const boardBox = useUiEditor((s) => s.boxes.boardRow);
  const boardScale = useUiEditor((s) => s.scales.board);
  // Same negative gap trick the recruit rows use, so the cards sit exactly
  // where they do outside combat.
  const boardGap = useUiEditor((s) => s.gaps.board);
  // The opponent's portrait sits exactly where the tavern keeper's does.
  const bartBox = useUiEditor((s) => s.boxes.bartender);

  const [idx, setIdx] = useState(0);
  const [attacking, setAttacking] = useState<number[]>([]);
  const [hits, setHits] = useState<number[]>([]);
  const [floats, setFloats] = useState<{ eid: number; value: number; side: number; key: number }[]>([]);
  const [done, setDone] = useState(false);
  const timers = useRef<number[]>([]);
  const floatKey = useRef(1);

  const frames = combat.frames;
  const boards = frames[idx]?.boards ?? [[], []];

  useEffect(() => {
    // Keep the replay brisk: ~180ms per beat, never more than 260ms. Long
    // combats used to crawl at 560ms per frame.
    const per = frames.length <= 3 ? 620 : Math.max(130, Math.min(260, 720 - frames.length * 14));
    let cancelled = false;
    const later = (fn: () => void, ms: number) => {
      const t = window.setTimeout(() => {
        if (!cancelled) fn();
      }, ms);
      timers.current.push(t);
    };
    let t = 0;
    for (let i = 1; i < frames.length; i++) {
      const prev = frames[i - 1].boards;
      const cur = frames[i].boards;
      const atk = frames[i].attacks ?? [];
      t += atk.length ? per : Math.min(per, 240);
      const targetIdx = i;
      later(() => {
        setIdx(targetIdx);
        if (!atk.length) return;
        sfx('attack');
        setAttacking(atk.map((a) => a[0]));
        setHits(atk.map((a) => a[1]));
        const list: { eid: number; value: number; side: number; key: number }[] = [];
        const seen = new Set<string>();
        for (const side of [0, 1]) {
          for (const before of prev[side]) {
            const after = cur[side].find((m) => m.eid === before.eid);
            const value = after ? Math.max(0, before.hp - after.hp) : before.hp;
            if (value > 0 && !seen.has(`${side}-${before.eid}`)) {
              seen.add(`${side}-${before.eid}`);
              list.push({ eid: before.eid, value, side, key: floatKey.current++ });
            }
          }
        }
        if (list.length) sfx('hit');
        setFloats(list);
        later(() => {
          setAttacking([]);
          setHits([]);
          setFloats([]);
        }, Math.min(340, per * 0.65));
      }, t);
    }
    later(() => setDone(true), t + 620);
    return () => {
      cancelled = true;
      timers.current.forEach((x) => window.clearTimeout(x));
      timers.current = [];
    };
  }, [frames]);

  useEffect(() => {
    if (!done) return;
    sfx(combat.winner === playerSide ? 'win' : combat.winner === 2 || combat.winner === null || combat.winner === undefined ? 'hit' : 'lose');
    const t = window.setTimeout(() => resolve(), 1600);
    return () => window.clearTimeout(t);
  }, [done, resolve]);

  /** Click anywhere during the replay to jump to the result. */
  const fastForward = () => {
    timers.current.forEach((x) => window.clearTimeout(x));
    timers.current = [];
    setIdx(Math.max(0, frames.length - 1));
    setAttacking([]);
    setHits([]);
    setFloats([]);
    setDone(true);
  };

  const combatLog = (frames[idx]?.log ?? []).map(formatCombatLog).filter(Boolean) as string[];
  const won = combat.winner === playerSide;
  const tied = combat.winner === 2 || combat.winner === null || combat.winner === undefined;
  const resultColor = tied ? '#c9c9c9' : won ? '#ffd75e' : '#ff6b5a';
  const resultText = tied ? '平局' : won ? '胜利' : '失败';

  const renderSide = (
    side: number,
    kind: 'enemy' | 'player',
    box: { x: number; y: number; w: number; h: number },
    scale: number,
  ) => (
    <div
      className={`combat-row ${kind}`}
      style={
        {
          left: box.x,
          top: box.y,
          width: box.w,
          height: box.h,
          '--card-gap': `${boardGap}px`,
        } as React.CSSProperties
      }
    >
      <AnimatePresence>
        {boards[side].map((raw) => {
          const m = withMeta(raw, catalog);
          const isAttacking = attacking.includes(m.eid);
          const isHit = hits.includes(m.eid);
          const float = floats.filter((f) => f.eid === m.eid && f.side === side);
          return (
            <motion.div
              key={m.eid}
              initial={{ opacity: 0, y: kind === 'enemy' ? -26 : 26, scale: 0.85 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, scale: 0.55, filter: 'grayscale(1)' }}
              transition={{ duration: 0.2 }}
              style={{ position: 'relative', zIndex: isAttacking ? 5 : 1 }}
            >
              <div
                className={`combat-card ${isHit ? 'hit' : ''}`}
                style={{
                  transform: isAttacking ? `translateY(${kind === 'enemy' ? 34 : -34}px) scale(1.06)` : undefined,
                  transition: 'transform .16s ease',
                }}
              >
                <MinionCard card={m} scale={scale} interactive={false} />
              </div>
              {float.map((f) => (
                <div key={f.key} className="damage-float" style={{ left: '50%', top: kind === 'enemy' ? 70 : 26 }}>
                  -{f.value}
                </div>
              ))}
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );

  return (
    <div className="combat-layer fade-in" onClick={() => (done ? resolve() : fastForward())}>
      <img className="board-bg" src="/img/ui/board-darkwood.png" alt="" draggable={false} />
      <div className="combat-dim" />
      <HudChrome opponentName={enemy ? cardName(enemy.hero) : '幽灵对手'} />
      <OpponentsRail />
      <PlayerHero />
      <GoldPanel />

      {/* The opponent takes Bob's window during the fight, with their own
          health/armour on the right edge, like the real table. */}
      {/* The opponent takes Bob's window: same slot, same size, and the same
          bare cut-out portrait — no frame of our own. */}
      <div className="combat-enemy-head" style={{ left: bartBox.x, top: bartBox.y, width: bartBox.w, height: bartBox.h }}>
        {enemy ? (
          <>
            <div className="ceh-portrait">
              <img
                className="bob-img ceh-bob"
                src={art.hero(enemy.hero?.id ?? '')}
                alt={cardName(enemy.hero)}
                draggable={false}
                onError={(e) => ((e.target as HTMLImageElement).style.visibility = 'hidden')}
              />
              <div className="hero-stats ceh-stats">
                {enemy.armor > 0 && <span className="hs-armor">{enemy.armor}</span>}
                <span className="hs-health">{enemy.health}</span>
              </div>
            </div>
          </>
        ) : null}
      </div>

      <div className="combat-rows">
        {/* Both warbands use OUR board's geometry; the opponent's row is simply
            parked where the tavern row sits during the recruit phase. */}
        {renderSide(enemySide, 'enemy', { x: shopBox.x, y: shopBox.y, w: boardBox.w, h: boardBox.h }, boardScale)}
        {renderSide(playerSide, 'player', boardBox, boardScale)}
      </div>

      <div className="combat-plaque" title="战斗进行中">
        <span>开始战斗</span>
      </div>

      {combatLog.length > 0 && <div className="combat-ticker">{combatLog.slice(-3).join(' · ')}</div>}

      {!done && (
        <button
          className="btn btn-ghost skip-btn"
          onClick={(e) => {
            e.stopPropagation();
            resolve();
          }}
        >
          跳过
        </button>
      )}

      {done && (
        <div className="combat-banner" onClick={(e) => e.stopPropagation()}>
          <div className="big" style={{ color: resultColor }}>
            {resultText}
          </div>
          {!won && !tied && combat.damage > 0 && (
            <div style={{ fontSize: 18, color: '#ff9d8a', marginTop: 6 }}>受到 {combat.damage} 点伤害</div>
          )}
          {won && <div style={{ fontSize: 18, color: '#ffe1a0', marginTop: 6 }}>对手受到 {combat.damage} 点伤害</div>}
          <button className="btn btn-gold" style={{ marginTop: 18 }} onClick={() => resolve()}>
            继续
          </button>
        </div>
      )}
    </div>
  );
}
