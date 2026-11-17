import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../store';
import type { CardRef, HeroPower, Item, Me, Minion, Opponent } from '../types';
import { HeroPortrait, MinionCard, RenderCard, useCardTooltip } from './Cards';
import { art, cardName, plainText, RACE_CN, richText, textOf, tierIcon, tribeIcon } from '../lib/assets';
import { usePeek } from '../store/peek';
import { TrinketSlots } from '../features/trinkets';
import { DarkGiftButton } from '../features/darkGift';
import { useCapability } from '../features/registry';
import { formatLog } from '../lib/log';
import { startDrag, tap, isDragClick } from '../lib/pointerDrag';
import { queueFlightFrom } from '../lib/flip';
import { resolveDrop } from '../lib/dropAction';
import { useDrag } from '../store/drag';
import { useCombatLog } from '../store/combatLog';
import { useTargeting } from '../store/targeting';
import { useTargetAim } from '../lib/targetAim';
import { summarizeRaces } from '../lib/warband';
import { sortStandings, type StandingsEntry } from '../lib/standings';
import { sfx } from '../lib/sfx';
import { EditableBox } from './EditableBox';
import { useUiEditor } from '../store/uiEditor';
import { useFx } from '../store/fx';
import { ROPE_SECONDS, clockText } from '../lib/turnClock';
import { startTurnClock, useTurnClock } from '../store/turnClock';
import { useNet } from '../store/net';

/** Hand cards keep the flat card face (unlike the board's composited frame). */
const HAND_W = 112;
const HAND_H = 170;

/**
 * The rope laid across the strip between the tavern row and the warband. It
 * only shows up for the last ROPE_SECONDS of the turn, and is eaten away from
 * the left so the burning head travels right as the clock runs down.
 */
function BurnRope({ box }: { box: { left: number; top: number; width: number; height: number } }) {
  const left = useTurnClock((s) => s.left);
  const off = useTurnClock((s) => s.off);
  if (off || left > ROPE_SECONDS) return null;
  return (
    <div className="burn-rope" style={box} aria-hidden="true">
      <div className="burn-rope-tail" style={{ width: `${Math.max(0, Math.min(100, (left / ROPE_SECONDS) * 100))}%` }} />
    </div>
  );
}

export function Tavern() {
  const view = useStore((s) => s.view)!;
  const me = view.me;
  const grab = useDrag((s) => s.grab);
  const editMode = useUiEditor((s) => s.editMode);
  // One aiming controller for the whole board: the hero power and targeted hand
  // spells share it, so the window listeners are only attached once.
  const aim = useTargetAim();
  // The sell target is one continuous strip: bartender area + tavern row,
  // no gap in between. Derived from the editable layout so it follows the
  // UI editor instead of drifting from hard-coded numbers.
  const bartBox = useUiEditor((s) => s.boxes.bartender);
  const shopBox = useUiEditor((s) => s.boxes.shopRow);
  const handBox = useUiEditor((s) => s.boxes.handRow);
  const heroBox = useUiEditor((s) => s.boxes.playerHero);
  const boardBox = useUiEditor((s) => s.boxes.boardRow);
  const endTurnBox = useUiEditor((s) => s.boxes.endTurn);
  // The countdown lives outside this tree (see store/turnClock.ts) so the board
  // does not re-render five times a second just because time passes.
  useEffect(() => startTurnClock(), []);
  // The rope burns along the strip between the tavern row and the warband,
  // stopping short of the end-turn button on the right.
  const rope = {
    left: boardBox.x + 6,
    // The rope's centre line is the turn plaque's centre line: the burning rope
    // has to run straight into the clock on the right rail.
    top: endTurnBox.y + endTurnBox.h / 2 - 8,
    width: Math.max(0, endTurnBox.x - 12 - (boardBox.x + 6)),
    height: 16,
  };
  // Buying a tavern card: the "drop here" area covers the bottom 2/3 of the
  // hero portrait, so you do not have to aim at the thin hand strip.
  const buyTop = Math.round(heroBox.y + heroBox.h / 3);
  const [turnBanner, setTurnBanner] = useState<number | null>(null);

  useEffect(() => {
    setTurnBanner(view.turn);
    const t = window.setTimeout(() => setTurnBanner(null), 1500);
    return () => window.clearTimeout(t);
  }, [view.turn]);

  useEffect(() => {
    const onCtx = (e: MouseEvent) => {
      const s = useStore.getState();
      const p = s.view?.me.pending;
      if (!p) return;
      if (p.kind === 'discover') {
        e.preventDefault();
        return;
      }
      if ((p.kind === 'target' || p.kind === 'choose_one') && s.view?.me.cancellable) {
        e.preventDefault();
        void s.act(7);
      }
    };
    window.addEventListener('contextmenu', onCtx);
    return () => window.removeEventListener('contextmenu', onCtx);
  }, []);

  return (
    <div className="tavern">
      <img className="board-bg" src="/img/ui/board-darkwood.png" alt="" draggable={false} />

      <BurnRope box={rope} />

      <HudChrome />

      {grab?.kind === 'shop' && (
        <div
          className="hand-drop-zone"
          data-row="hand"
          style={{
            left: handBox.x,
            width: handBox.w,
            top: buyTop,
            height: handBox.y + handBox.h - buyTop,
          }}
        >
          松手购买 · 放入手牌
        </div>
      )}

      {grab?.kind === 'board' && (
        <div
          className="sell-zone"
          data-drop="sell"
          style={{
            left: Math.min(bartBox.x, shopBox.x),
            top: Math.min(bartBox.y, shopBox.y),
            width: Math.max(bartBox.x + bartBox.w, shopBox.x + shopBox.w) - Math.min(bartBox.x, shopBox.x),
            height: shopBox.y + shopBox.h - Math.min(bartBox.y, shopBox.y),
          }}
        >
          松手出售 · 返还 1 枚铸币
        </div>
      )}

      <OpponentsRail />
      <WarbandPeek />
      <TavernHead />
      <ShopRow />
      <BoardRow />
      <HandRow />
      <PlayerHero />
      <SideButtons aim={aim.begin} />
      <GoldPanel />
      <RightRail />
      <TurnPlaque />
      <CastFx />

      {(me.pending?.kind === 'target' || editMode) && (
        <EditableBox id="targetPrompt" className="target-prompt">
          {me.pending?.kind === 'target' ? '拖到目标上松手施放（Esc 取消）' : '目标提示'}
          {me.cancellable && me.pending?.kind === 'target' && (
            <button className="btn" style={{ padding: '2px 10px', fontSize: 12 }} onClick={() => useStore.getState().act(7)}>
              取消
            </button>
          )}
        </EditableBox>
      )}

      {turnBanner !== null && (
        <div className="turn-banner" key={turnBanner}>
          <div className="tb-round">第 {turnBanner} 回合</div>
          <div className="tb-sub">招募阶段</div>
        </div>
      )}
    </div>
  );
}

/**
 * The real Battlegrounds table has no toolbar. What the old bar carried now
 * lives where the game puts it: the opponent's name in the top-left corner, the
 * player's name and the match clock in the bottom-left, the collection and
 * settings buttons in the bottom-right, and round / tribes / survivors inside
 * the tavern-tier tooltip.
 */
export function HudChrome({ opponentName }: { opponentName?: string }) {
  return (
    <>
      <OpponentNameplate name={opponentName} />
      <PlayerPlate />
      <LobbyRaces />
      <CornerIcons />
    </>
  );
}

/**
 * The lobby's tribes, pinned to the top-right corner. The aberration is not
 * just a tribe here: the deity's name (and, during a game, its stats) is shown
 * underneath, because that is the number that actually changes fights.
 */
function LobbyRaces() {
  const view = useStore((s) => s.view)!;
  const deity = view.me.deity;
  // The picker shows the lobby's own races in its banner; here the deity is
  // announced by name only, without the stat line.
  const inPick = view.phase === 'hero_select';
  const races = view.lobbyRaces.filter((r) => r !== 'ABERRATION');
  return (
    <EditableBox id="races" className="lobby-races" title="本局种族">
      <div className="lobby-races-plate">
        <div className="lr-icons">
          {races.map((r) => (
            <span key={r} className="lr-icon" title={RACE_CN[r] ?? r}>
              <img src={tribeIcon(r)} alt="" />
            </span>
          ))}
          {view.hasAberrations && (
            <span
              className="lr-icon aberration"
              title={deity ? `畸变怪 · ${cardName(deity.card)}` : '畸变怪'}
            >
              <img src={tribeIcon('ABERRATION')} alt="" />
            </span>
          )}
        </div>
        {view.hasAberrations && (
          <span className="lr-deity" title={deity ? `${cardName(deity.card)} ${deity.atk}/${deity.hp}` : '畸变怪'}>
            {deity ? (
              <>
                {cardName(deity.card)}
                {!inPick && (
                  <b>
                    {deity.atk}/{deity.hp}
                  </b>
                )}
              </>
            ) : (
              '畸变怪'
            )}
          </span>
        )}
      </div>
    </EditableBox>
  );
}

function OpponentNameplate({ name }: { name?: string }) {
  // The real table names the tavern keeper while you shop ("调酒师鲍勃") and the
  // player you are fighting during combat; callers pass that name in.
  return (
    <EditableBox id="nameplate" className="nameplate">
      <span className="nameplate-text">{name ?? '调酒师鲍勃'}</span>
    </EditableBox>
  );
}

/** How long this match has been running, ticking once a second. */
function MatchClock() {
  const startedAt = useStore((s) => s.startedAt);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  return <>{clockText((now - startedAt) / 1000)}</>;
}

function PlayerPlate() {
  const view = useStore((s) => s.view)!;
  const netMode = useStore((s) => s.mode === 'net');
  const net = useNet();
  return (
    <EditableBox id="playerPlate" className="player-plate">
      <div className="pp-line">
        <span className="pp-name">{netMode ? net.name : '你'}</span>
        <span className="pp-sep">|</span>
        <span className="pp-title">{netMode ? `座位 ${net.seat + 1}` : '酒馆战棋'}</span>
      </div>
      <div className="pp-line pp-foot">
        <span className="pp-badge" title={`第 ${view.turn} 回合`}>
          {view.turn}
        </span>
        <span className="pp-clock" title="本局用时">
          <MatchClock />
        </span>
      </div>
    </EditableBox>
  );
}

function CornerIcons() {
  return (
    <EditableBox id="corner" className="corner-icons">
      <button
        className="hud-btn"
        title="卡牌图鉴"
        aria-label="图鉴"
        onClick={() => useStore.getState().setShowCatalog(true)}
      >
        <CollectionGlyph />
      </button>
      <button
        className="hud-btn"
        title="菜单（音效 / 撤销 / 回首页）"
        aria-label="菜单"
        onClick={() => useStore.getState().setShowMenu(true)}
      >
        <GearGlyph />
      </button>
    </EditableBox>
  );
}

/** The little open-book icon the real table uses for the collection. */
function CollectionGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 5.4C10 3.9 7.4 3.4 4.6 3.6v13.6c2.8-.2 5.4.3 7.4 1.8 2-1.5 4.6-2 7.4-1.8V3.6c-2.8-.2-5.4.3-7.4 1.8z" />
      <path className="line" d="M12 5.4v13.6M7 7.2c1 .1 1.9.4 2.7.8M7 10.4c1 .1 1.9.4 2.7.8M17 7.2c-1 .1-1.9.4-2.7.8M17 10.4c-1 .1-1.9.4-2.7.8" />
    </svg>
  );
}

/** The gear the real table uses for settings; our menu lives behind it. */
function GearGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2.6l1.5 2.3 2.7-.5 1 2.6 2.6.8-.4 2.8 2 1.9-1.8 2.1.9 2.7-2.5 1.2-.6 2.7h-2.9L12 23.4l-2.1-1.9H7l-.6-2.7-2.5-1.2.9-2.7-1.8-2.1 2-1.9-.4-2.8 2.6-.8 1-2.6 2.7.5L12 2.6z" />
      <circle className="hole" cx="12" cy="13" r="3.4" />
    </svg>
  );
}

/** A crown on your own avatar, like the real rail. */
function CrownGlyph() {
  return (
    <svg className="opp-crown" viewBox="0 0 34 24" aria-hidden="true">
      <path d="M3 6l6.5 5L17 3l7.5 8L31 6l-2.6 14H5.6L3 6z" />
      <path className="glint" d="M6 20h22" />
    </svg>
  );
}

/** A skull over a knocked-out opponent. */
function SkullGlyph() {
  return (
    <svg className="opp-skull" viewBox="0 0 32 32" aria-hidden="true">
      <path d="M16 3c-7 0-11 4.6-11 11 0 3.5 1.4 5.2 2.6 6.6.8.9 1.4 1.7 1.4 3.2v1.6c0 1.9 1.4 3.6 3.4 3.6h7.2c2 0 3.4-1.7 3.4-3.6v-1.6c0-1.5.6-2.3 1.4-3.2C25.6 19.2 27 17.5 27 14c0-6.4-4-11-11-11z" />
      <circle className="hole" cx="11.4" cy="14.2" r="2.9" />
      <circle className="hole" cx="20.6" cy="14.2" r="2.9" />
      <path className="hole" d="M14.2 20.6l1.8 2.6 1.8-2.6z" />
    </svg>
  );
}

/* ───────────────────────────── top: bartender / tier / shop buttons ───────────────────────────── */
function TavernHead() {
  const view = useStore((s) => s.view)!;
  const me = view.me;
  const act = useStore((s) => s.act);
  const editMode = useUiEditor((s) => s.editMode);
  const [bobFailed, setBobFailed] = useState(false);

  return (
    <>
      <EditableBox id="bartender" className="bartender">
        {!bobFailed ? (
          <img className="bob-img" src={art.hero('TB_BaconShopBob')} alt="酒馆老板" draggable={false} onError={() => setBobFailed(true)} />
        ) : (
          <div className="bartender-fallback">🍺</div>
        )}
        {/* Bob never stops talking — the little "…" bubble in the corner. */}
        <div className="bob-bubble" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
      </EditableBox>

      <EditableBox id="tier" className="tavern-tier">
        <img src={tierIcon(me.tier)} alt="" className="tavern-tier-shield" />
        {/* The real table keeps the lobby races and the round count off the
            play surface; hovering the tier shield is where they surface. */}
        <div className="tier-pop" role="tooltip">
          <div className="tier-pop-head">
            <span>第 {view.turn} 回合</span>
            <span className="tier-pop-alive">存活 {view.alive}/8</span>
          </div>
          <div className="tier-pop-label">本局种族</div>
          <div className="tier-pop-races topbar-races">
            {/* ABERRATION arrives inside lobbyRaces too; it gets its own chip
                below so the list never shows "畸变" twice. */}
            {view.lobbyRaces.filter((r) => r !== 'ABERRATION').map((r) => (
              <span key={r} className="race-chip" title={RACE_CN[r] ?? r}>
                <img src={tribeIcon(r)} alt="" />
                {RACE_CN[r] ?? r}
              </span>
            ))}
            {view.hasAberrations && (
              <span
                className="race-chip deity-chip"
                title={view.me.deity ? `${cardName(view.me.deity.card)} ${view.me.deity.atk}/${view.me.deity.hp}` : '畸变怪'}
              >
                <img src={tribeIcon('ABERRATION')} alt="" />
                畸变怪{view.me.deity ? `（${cardName(view.me.deity.card)} ${view.me.deity.atk}/${view.me.deity.hp}）` : ''}
              </span>
            )}
          </div>
        </div>
      </EditableBox>

      <DarkGiftButton />
      <EditableBox id="shopButtons" className="shop-buttons">
        <FaithfulButton
          kind="refresh"
          width={92}
          cost={me.freeRefreshes > 0 ? 0 : me.refreshPrice}
          onClick={() => {
            sfx('roll');
            act(view.actions.REFRESH);
          }}
          disabled={!view.legal.includes(view.actions.REFRESH)}
          title="刷新酒馆"
          tip={me.freeRefreshes > 0 ? `还有 ${me.freeRefreshes} 次免费刷新` : null}
        />
        <FaithfulButton
          kind="freeze"
          width={92}
          cost={0}
          onClick={() => act(view.actions.FREEZE)}
          disabled={!view.legal.includes(view.actions.FREEZE)}
          title={me.frozen ? '已冻结' : '冻结酒馆'}
          active={me.frozen}
        />
      </EditableBox>
    </>
  );
}

/** The faithful refresh / freeze / upgrade plaque buttons. The coin holds the cost. */
function FaithfulButton({
  kind,
  cost,
  width,
  onClick,
  disabled,
  title,
  active,
  tip,
}: {
  kind: 'refresh' | 'freeze' | 'upgrade';
  cost?: number | string | null;
  width: number;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  active?: boolean;
  /** Small hover chip, e.g. how many free refreshes are left. */
  tip?: string | null;
}) {
  const height = Math.round(width / 0.7);
  return (
    <button
      className={'faithful-btn' + (active ? ' active' : '')}
      style={{ width, height }}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      <img src={`/img/ui/${kind}_faithful.png`} alt="" draggable={false} />
      {cost !== null && cost !== undefined && (
        <span className="faithful-cost" style={{ fontSize: Math.round(width * 0.22) }}>
          {cost}
        </span>
      )}
      {tip && <span className="btn-tip">{tip}</span>}
    </button>
  );
}

/* ───────────────────────────── shop ───────────────────────────── */
function ShopRow() {
  const view = useStore((s) => s.view)!;
  const me = view.me;
  const act = useStore((s) => s.act);
  const buyCard = useStore((s) => s.buy);
  const toast = useStore((s) => s.toast);
  const grab = useDrag((s) => s.grab);
  const aimHover = useTargeting((s) => s.hover);
  const castAt = useTargeting((s) => s.castAt);
  const pending = me.pending;
  const grabHand = grab?.kind === 'hand' ? me.hand[grab.index] : null;
  const grabIsSpell = grabHand?.type === 'spell';
  const grabIsBoard = grab?.kind === 'board';
  const scale = useUiEditor((s) => s.scales.shop);
  const gaps = useUiEditor((s) => s.gaps);

  const targetShop = (i: number) =>
    pending?.kind === 'target' ? pending.targets.find((t) => t.location.zone === 'shop' && t.location.slot === i) : undefined;

  const buy = (i: number, item: Item) => {
    const t = targetShop(i);
    if (t) {
      act(t.action);
      return;
    }
    if (!view.legal.includes(view.actions.BUY + i)) {
      sfx('invalid');
      toast((item.price ?? 99) > me.gold ? '金币不足' : '现在无法购买这张牌', 'error');
      return;
    }
    sfx('buy');
    void buyCard(item.sid);
  };

  return (
    <EditableBox
      id="shopRow"
      className={'shop-row' + (grabIsSpell ? ' cast-target' : '')}
      data-row="shop"
      data-drop="sell"
      style={{ '--card-gap': `${gaps.shop}px` } as React.CSSProperties}
    >
      {me.shop.map((s, i) => {
        return (
          <div
            key={`${s.id}-${s.sid ?? i}`}
            data-slot-zone="shop"
            data-slot-index={i}
            data-flip-key={`s${s.sid ?? i}`}
            style={{ width: 168 * scale }}
            className={
              'shop-slot grabbable ' + (s.type === 'spell' ? 'spell-slot ' : '') +
              (targetShop(i) || grabIsSpell ? 'target-valid ' : '') +
              (aimHover === `shop:${i}` ? 'target-hover ' : '') +
              (castAt === `shop:${i}` ? 'target-cast ' : '') +
              (grab?.kind === 'shop' && grab.index === i ? 'shop-dragging' : '')
            }
            onPointerDown={(e) => startDrag(e, 'shop', i, resolveDrop)}
            onClick={(e) => {
              if (isDragClick()) return;
              // A tavern card is bought by dragging it out — a plain click never
              // spends gold. It still picks the card as a target while an
              // ability (发动) is waiting for one.
              if (pending?.kind !== 'target') return;
              const t = targetShop(i);
              if (!t) {
                toast('该随从不是合法目标', 'error');
                return;
              }
              act(t.action);
            }}
          >
            {s.type === 'minion' ? (
              <MinionCard card={s} scale={scale} owned={s.owned} tripleNeed={s.tripleNeed} frozen={s.frozen} />
            ) : (
              <RenderCard card={s} width={132 * scale} height={200 * scale} fit="cover" className="spell-render" frozen={s.frozen} />
            )}          </div>
        );
      })}
    </EditableBox>
  );
}

/* ───────────────────────────── board ───────────────────────────── */
function BoardRow() {
  const view = useStore((s) => s.view)!;
  const me = view.me;
  const act = useStore((s) => s.act);
  const sellCard = useStore((s) => s.sell);
  const toast = useStore((s) => s.toast);
  const grab = useDrag((s) => s.grab);
  const hit = useDrag((s) => s.hit);
  const aimHover = useTargeting((s) => s.hover);
  const castAt = useTargeting((s) => s.castAt);
  const [hover, setHover] = useState<number | null>(null);
  const pending = me.pending;
  const targeting = pending?.kind === 'target';
  const grabHand = grab?.kind === 'hand' ? me.hand[grab.index] : null;
  const grabIsSpell = grabHand?.type === 'spell';
  const scale = useUiEditor((s) => s.scales.board);
  const gaps = useUiEditor((s) => s.gaps);

  // Where a dragged hand minion would land. Cards to the right slide over by
  // exactly one slot (transform only — no flex reflow, no layout jump).
  const insertAt = grab && grab.kind === 'hand' && !grabIsSpell && hit.kind === 'board' ? hit.slot : null;
  const shift = 168 * scale + gaps.board;
  const markBefore = insertAt !== null && insertAt < me.board.length ? insertAt : -1;
  const markAfter = insertAt !== null && insertAt === me.board.length ? me.board.length - 1 : -1;

  const sell = (i: number) => {
    const m = me.board[i];
    if (!m) return;
    if (!view.legal.includes(view.actions.SELL + i)) return;
    sfx('sell');
    void sellCard(m.eid);
  };

  const targetClick = (i: number) => {
    if (!targeting || pending?.kind !== 'target') {
      const a = view.actions.ACTIVATE + i;
      if (view.legal.includes(a)) {
        useFx.getState().show(cardName(me.board[i]), '发动');
        act(a);
      }
      return;
    }
    const t = pending.targets.find((x) => x.location.zone === 'board' && x.location.slot === i);
    if (!t) {
      toast('该随从不是合法目标', 'error');
      return;
    }
    act(t.action);
  };

  return (
    <EditableBox
      id="boardRow"
      className={'board-row' + (grab ? ' dragging' : '')}
      data-row="board"
      style={{ '--card-gap': `${gaps.board}px` } as React.CSSProperties}
    >
      {me.board.length === 0 && grab?.kind === 'hand' && <div className="board-empty">放在这里</div>}
      {me.board.map((m, i) => {
        const isTarget =
          targeting && pending?.kind === 'target' && pending.targets.some((t) => t.location.zone === 'board' && t.location.slot === i);
        const spellAim = grabIsSpell && hit.kind === 'board' && hit.card === i;
        const shifted = insertAt !== null && i >= insertAt;
        return (
          <div
            key={`${m.id}-${m.eid}`}
            data-slot-zone="board"
            data-slot-index={i}
            data-flip-key={`b${m.eid}`}
            className={
              'board-slot' +
              (isTarget || spellAim ? ' target-valid' : '') +
              (aimHover === `board:${i}` ? ' target-hover' : '') +
              (castAt === `board:${i}` ? ' target-cast' : '') +
              (grab?.kind === 'board' && grab.index === i ? ' dragging' : '')
            }
            style={{
              transform: shifted ? `translateX(${shift}px)` : undefined,
              transition: 'transform .14s cubic-bezier(.2,.8,.2,1)',
            }}
            onPointerDown={targeting ? undefined : (e) => startDrag(e, 'board', i, resolveDrop)}
          >
            {i === markBefore && <div className="insert-mark before" />}
            {i === markAfter && <div className="insert-mark after" />}
            <MinionCard
              card={m}
              scale={scale}
              showTier={false}
              selected={hover === i}
              showSell={hover === i && !targeting && !grab}
              onSell={() => sell(i)}
              onClick={tap(() => targetClick(i))}
              onContextMenu={(e) => {
                if (me.pending) return;
                e.preventDefault();
                sell(i);
              }}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover((h) => (h === i ? null : h))}
              dropTarget={grab?.kind === 'board' && hit.kind === 'board' && hit.card === i}
            />
            {view.legal.includes(view.actions.ACTIVATE + i) && hover === i && !targeting && !grab && (
              <div className="activate-hint">发动</div>
            )}
          </div>
        );
      })}
    </EditableBox>
  );
}

/* ───────────────────────────── hand ───────────────────────────── */
function HandRow() {
  const view = useStore((s) => s.view)!;
  const me = view.me;
  const act = useStore((s) => s.act);
  const toast = useStore((s) => s.toast);
  const playCard = useStore((s) => s.playCard);
  const grab = useDrag((s) => s.grab);
  const tip = useCardTooltip();
  const aimHover = useTargeting((s) => s.hover);
  const castAt = useTargeting((s) => s.castAt);
  const gaps = useUiEditor((s) => s.gaps);
  const handArc = useUiEditor((s) => s.handArc);
  const pending = me.pending;
  const targeting = pending?.kind === 'target';
  const handFactor = Math.min(1, Math.max(0, (me.hand.length - 1) / 9));
  // Hand cards are drawn with the same composited card as the board, so live
  // stats and golden art come for free. The gap is scaled with the card width
  // so a layout saved against the old 112px card still fans out correctly.
  // A minimum advance keeps a grab-width sliver on every card, which is what
  // makes sweeping the fan with the mouse work in both directions.
  const baseAdvance = HAND_W + gaps.hand * handFactor * (HAND_W / 112);
  const handGap = Math.max(baseAdvance, 34) - HAND_W;
  // The fan was tuned against 170px-tall cards; the composite card is shorter,
  // so scale the angle to keep the same visual spread (and the same hit gaps).
  // Cap the outermost angle: past ~20° a card's bottom swings over its left
  // neighbour, which makes sweeping the fan left-to-right skip cards.
  const arcRaw = handArc * handFactor * (170 / HAND_H);
  const arcSpan = Math.max(1, (me.hand.length - 1) / 2);
  const handArcEff = Math.max(-20 / arcSpan, Math.min(20 / arcSpan, arcRaw));
  // Hover is geometric, not DOM-based: the fan overlaps itself, and a raised
  // card would otherwise sit on top of its neighbours' click strips. We pick
  // the card whose strip the cursor is in, then lift exactly that one.
  const [zoomIdx, setZoomIdx] = useState<number | null>(null);
  // Which card the current press grabbed (the press decisions are geometric).
  const pressIdx = useRef<number | null>(null);
  const targetList = targeting && pending?.kind === 'target' ? pending.targets : [];
  const handTargets = targetList.filter((t) => t.location.zone === 'hand');
  const unknownTargets = targetList.filter((t) => t.location.zone === 'unknown');
  const usedSlots = new Set(handTargets.map((t) => t.location.slot));
  const fallbackTargets = new Map<number, (typeof targetList)[number]>();
  for (const t of unknownTargets) {
    const slot = me.hand.findIndex((_, idx) => !usedSlots.has(idx));
    if (slot >= 0) {
      usedSlots.add(slot);
      fallbackTargets.set(slot, t);
    }
  }

  return (
    <EditableBox
      id="handRow"
      className={'hand-row' + (grab?.kind === 'shop' ? ' buy-target' : '')}
      data-row="hand"
      style={{ '--card-gap': `${handGap}px` } as React.CSSProperties}
      onPointerMove={(e) => {
        const row = e.currentTarget as HTMLElement;
        const cards = [...row.querySelectorAll<HTMLElement>(':scope > .hand-card')];
        if (cards.length === 0) return;
        // The card whose strip the cursor is over: the fan overlaps, so hit
        // testing by DOM order would jump straight over the next few cards.
        let idx = 0;
        for (let k = 0; k < cards.length; k++) {
          if (e.clientX >= cards[k].getBoundingClientRect().left) idx = k;
        }
        if (idx !== zoomIdx) {
          setZoomIdx(idx);
          const h = me.hand[idx];
          if (h) tip.show(e, h);
        }
      }}
      onPointerLeave={() => {
        setZoomIdx(null);
        tip.hide();
      }}
      onPointerDownCapture={(e: React.PointerEvent) => {
        // The enlarged card is whichever strip the cursor is in; the press must
        // select THAT card, not whatever the DOM hit test lands on.
        const row = e.currentTarget as HTMLElement;
        const cards = [...row.querySelectorAll<HTMLElement>(':scope > .hand-card')];
        if (cards.length === 0) return;
        let idx = 0;
        for (let k = 0; k < cards.length; k++) {
          if (e.clientX >= cards[k].getBoundingClientRect().left) idx = k;
        }
        pressIdx.current = idx;
        e.stopPropagation();
        if (targeting) return;
        const h = me.hand[idx];
        const card = cards[idx];
        if (!h || !card) return;
        if (h.type === 'spell') {
          const r = card.getBoundingClientRect();
          useTargeting.getState().start({ x: r.left + r.width / 2, y: r.top + 20 }, 'drag');
        }
        startDrag(e, 'hand', idx, resolveDrop, card);
      }}
      onClickCapture={(e: React.MouseEvent) => {
        const idx = pressIdx.current;
        pressIdx.current = null;
        if (idx === null) return;
        e.stopPropagation();
        if (isDragClick() || !targeting) return;
        const target = handTargets.find((t) => t.location.slot === idx) ?? fallbackTargets.get(idx);
        if (target) act(target.action);
        else toast('该手牌不是合法目标', 'error');
      }}
    >
      {tip.node}
      {me.hand.map((h, i) => {
        const d = i - (me.hand.length - 1) / 2;
        const target = handTargets.find((t) => t.location.slot === i) ?? fallbackTargets.get(i);
        return (
          <div
            key={`${h.id}-${h.hid ?? i}`}
            data-slot-zone="hand"
            data-slot-index={i}
            data-flip-key={`h${h.hid ?? i}`}
            className={
              'hand-card' +
              (target ? ' target-valid' : '') +
              (aimHover === `hand:${i}` ? ' target-hover' : '') +
              (castAt === `hand:${i}` ? ' target-cast' : '') +
              (grab?.kind === 'hand' && grab.index === i ? ' dragging' : '') +
              (h.golden ? ' golden' : '') +
              (h.temporary ? ' temporary' : '') +
              (h.unplayable || (h.locked ?? 0) > 0 ? ' locked' : '') +
              (zoomIdx === i ? ' zoomed' : '') +
              (targeting ? '' : ' grabbable')
            }
            style={
              {
                '--arc-r': `${d * handArcEff}deg`,
                '--arc-y': `${d * d * 0.55 * handFactor}px`,
                width: HAND_W,
                height: HAND_H,
                zIndex: 10 + i,
              } as React.CSSProperties
            }
          >
            {/* Three layers, and which one listens to the pointer matters:
                .hand-card      fixed layout cell, ignores the pointer
                .hand-card-frame rotated into the fan — the real hit area, so
                                what you see is exactly what you can click
                .hand-card-inner hover zoom — draws only, never steals a hit */}
            <div className="hand-card-frame" data-grab-body>
              <div className="hand-card-inner">
                <RenderCard card={h} width={HAND_W} height={HAND_H} fit="cover" liveStats />
              </div>
              {(h.unplayable || (h.locked ?? 0) > 0) && (
                <span className="hand-lock" aria-label="现在不能使用">
                  <svg viewBox="0 0 24 28" aria-hidden="true">
                    <path d="M7 12V8a5 5 0 0 1 10 0v4" fill="none" stroke="currentColor" strokeWidth="2.4" />
                    <rect x="4" y="12" width="16" height="12" rx="2.5" fill="currentColor" />
                  </svg>
                </span>
              )}
            </div>
          </div>
        );
      })}
    </EditableBox>
  );
}

/* ───────────────────────────── player hero / buttons ───────────────────────────── */
export function PlayerHero() {
  const view = useStore((s) => s.view)!;
  const me = view.me;
  const box = useUiEditor((s) => s.boxes.playerHero);
  const size = Math.max(40, Math.min(box.w, box.h - 18));
  return (
    <EditableBox id="playerHero" className="player-hero">
      <div className="hero-portrait-wrap">
        {/* Bare portrait, then the game's own stat pair: armour on the white
            shield, health on the red drop, both pinned to the right edge. */}
        <HeroPortrait hero={me.hero} size={size} bare showNumbers={false} />
        <div className="hero-stats">
          {me.armor > 0 && (
            <span className="hs-armor" title={`护甲 ${me.armor}`}>
              {me.armor}
            </span>
          )}
          <span className="hs-health" title={`生命 ${me.health}`}>
            {me.health}
          </span>
        </div>
      </div>
    </EditableBox>
  );
}

function HeroPowerButton({ onAim }: { onAim: (e: React.PointerEvent, action: number) => void }) {
  const me = useStore((s) => s.view!.me);
  // A few heroes carry two powers; the second one sits above the primary.
  const powers = me.heroPowers.slice(0, 2);
  if (powers.length === 0) return null;
  const dual = powers.length > 1;
  const ordered = dual ? [powers[1], powers[0]] : powers;
  return (
    <div className={'hero-power-wrap' + (dual ? ' dual' : '')}>
      {ordered.map((p, i) => (
        <PowerSlot key={`${p.id}-${i}`} power={p} onAim={onAim} />
      ))}
    </div>
  );
}

function PowerSlot({ power, onAim }: { power: HeroPower; onAim: (e: React.PointerEvent, action: number) => void }) {
  const me = useStore((s) => s.view!.me);
  const aiming = useTargeting((s) => s.active);
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);
  const affordable = power.passive || (power.price ?? 0) <= me.gold;
  const unavailable = !power.usable || !affordable;
  return (
    <>
      {/* Not a real `disabled` button: disabled buttons swallow hover, so you
          could not read the skill's state. It just looks unavailable and
          ignores clicks. */}
      <button
        className={`round-btn power-btn ${power.usable ? 'ready' : ''} ${unavailable ? 'unavailable' : ''} ${aiming ? 'aiming' : ''}`}
        aria-disabled={unavailable}
        onPointerDown={(e) => {
          if (unavailable || e.button !== 0) return;
          // Press-and-drag aims (Slay the Spire style): the arrow appears as soon
          // as the engine opens the target picker, and releasing on a target casts.
          onAim(e, power.action);
        }}
        onMouseEnter={(e) => setTip({ x: e.clientX, y: e.clientY })}
        onMouseLeave={() => setTip(null)}
        title="英雄技能"
      >
        <img src={art.portrait(power.id)} alt="" draggable={false} />
        <span className="round-cost">{power.passive ? '被动' : power.price}</span>
      </button>
      <div className="round-label" style={{ display: 'none' }}>{cardName(power)}</div>
      {tip &&
        createPortal(
          // The real game pops the power up as a card above the button: art,
          // name banner, then the rules text, with the cost on the top gem.
          <div
            className="power-card"
            style={{
              left: Math.max(12, Math.min(tip.x - 96, window.innerWidth - 208)),
              top: Math.max(12, tip.y - 300),
            }}
          >
            <div className="pc-art">
              <img src={art.render(power.id)} alt="" draggable={false} onError={(e) => ((e.target as HTMLImageElement).style.opacity = '0')} />
            </div>
            <span className="pc-cost">{power.passive ? '被动' : power.price}</span>
            <div className="pc-name">{cardName(power)}</div>
            <div className="pc-text">
              {richText(textOf(power)).map((s, i) => (s.bold ? <b key={i}>{s.text}</b> : <span key={i}>{s.text}</span>))}
            </div>
            <div className="pc-state">
              {power.usable ? (affordable ? '可使用' : '铸币不足') : '本回合已使用'}
            </div>
          </div>,
          // Portal to <body>: the tavern lives inside a scaled `.stage`, so a
          // fixed-position card rendered in-tree would be offset by it.
          document.body,
        )}
    </>
  );
}

function SideButtons({ aim }: { aim: (e: React.PointerEvent, action: number) => void }) {
  return (
    <EditableBox id="heroPower" className="hero-power-slot">
      <HeroPowerButton onAim={aim} />
    </EditableBox>
  );
}

export function GoldPanel() {
  const view = useStore((s) => s.view)!;
  const me = view.me;
  // The real bottom-right corner is a small stone plate with the current/max
  // gold, followed by one coin per gold slot — bright for the gold you hold.
  const slots = Math.min(12, Math.max(me.maxGold, 1));
  return (
    <EditableBox id="gold" className="gold-panel">
      <span className="gold-plate">
        <b>{me.gold}</b>/{me.maxGold}
      </span>
      {me.goldNextTurn > 0 && <span className="gold-next">+{me.goldNextTurn}</span>}
      <span className="gold-pips" aria-hidden="true">
        {Array.from({ length: slots }).map((_, i) => (
          <i key={i} className={'gold-pip' + (i < me.gold ? ' on' : '')} />
        ))}
      </span>
    </EditableBox>
  );
}

/**
 * The turn clock as the real table shows it: a wooden plaque bolted to the
 * right rail. It counts the seconds left; clicking it ends the turn early (the
 * real game waits the clock out, but a simulator should not force that).
 */
function TurnPlaque() {
  const left = useTurnClock((s) => s.left);
  const limit = useTurnClock((s) => s.limit);
  const off = useTurnClock((s) => s.off);
  const view = useStore((s) => s.view)!;
  const act = useStore((s) => s.act);
  const busy = useStore((s) => s.busy);
  const netMode = useStore((s) => s.mode === 'net');
  const net = useNet();
  const canEnd = view.legal.includes(view.actions.END);
  const waiting = netMode && !net.needMe && !net.over;
  const urgent = !off && left <= ROPE_SECONDS;
  const seconds = Math.max(0, Math.ceil(left));
  return (
    <EditableBox id="endTurn" className="end-turn-slot">
      <button
        className={'turn-plaque end-turn-btn' + (urgent ? ' urgent' : '') + (waiting ? ' waiting' : '')}
        disabled={busy || !canEnd || waiting}
        onClick={() => act(view.actions.END)}
        title={
          waiting
            ? '等待其他玩家结束回合'
            : off
              ? '自定义对局：不计时 · 点击结束本回合'
              : `本回合剩余 ${seconds} 秒（共 ${limit} 秒）· 点击提前结束`
        }
      >
        <span className="plaque-rivet left" />
        <span className="plaque-rivet right" />
        <span className="turn-clock topbar-time">
          {waiting ? `等待 ${net.endedSeats.length}/${net.peers.length || 8}` : off ? '∞' : `${seconds}秒`}
        </span>
        {off && <span className="turn-clock-sub">不计时</span>}
      </button>
    </EditableBox>
  );
}

/* ───────────────────────────── left: opponents ───────────────────────────── */
interface RailEntry extends StandingsEntry {
  self?: boolean;
  opp?: Opponent;
}

/** The warband we last saw of the hovered opponent, drawn above Bob's head. */
function WarbandPeek() {
  const cards = usePeek((s) => s.cards);
  const hero = usePeek((s) => s.hero);
  if (!cards || cards.length === 0) return null;
  return (
    <div className="warband-peek">
      <div className="warband-peek-row">
        {cards.map((m) => (
          <MinionCard key={m.eid} card={m} scale={0.42} interactive={false} />
        ))}
      </div>
      <span className="warband-peek-label">{hero} · 上场阵容</span>
    </div>
  );
}

export function OpponentsRail() {
  const view = useStore((s) => s.view)!;
  const me = view.me;

  // Live leaderboard: health + armour descending, eliminated players at the
  // bottom (8th last). Re-sorted automatically whenever a combat changes HP.
  const rows = useMemo(() => {
    const entries: RailEntry[] = [
      { self: true, id: 0, health: me.health, armor: me.armor, alive: me.alive, placement: me.placement },
      ...view.opponents.map((o) => ({
        id: o.id,
        health: o.health,
        armor: o.armor,
        alive: o.alive,
        placement: o.placement,
        opp: o,
      })),
    ];
    return sortStandings(entries);
  }, [view.opponents, me.health, me.armor, me.alive, me.placement]);

  return (
    <EditableBox id="opponents" className="opponents-rail">
      {rows.map((r, i) =>
        r.self ? (
          <SelfRow key="self" me={me} rank={i + 1} />
        ) : (
          <OpponentRow key={r.id} opp={r.opp!} rank={i + 1} />
        ),
      )}
    </EditableBox>
  );
}

function OpponentRow({ opp, rank }: { opp: Opponent; rank: number }) {
  const turn = useStore((s) => s.view!.turn);
  // How many turns ago we last ran into this opponent (nothing if never).
  const seenAgo = opp.seenBoard.length > 0 && opp.seenTurn > 0 ? Math.max(0, turn - opp.seenTurn) : null;
  return (
    <AvatarPop
      flipKey={`o${opp.id}`}
      seat={opp.id}
      hero={opp.hero}
      health={opp.health}
      armor={opp.armor}
      tier={opp.tier}
      dead={!opp.alive}
      isNext={opp.isNext}
      seenAgo={seenAgo}
      seenBoard={opp.seenBoard}
      races={opp.lastRaces}
      triples={opp.triples}
      streak={opp.streak}
      rank={rank}
      trinkets={opp.trinkets}
      heroPowers={opp.heroPowers}
    />
  );
}

/** Our own avatar in the rail: same panel, minus the warband and the sighting label. */
function SelfRow({ me, rank }: { me: Me; rank: number }) {
  return (
    <AvatarPop
      flipKey="o-self"
      seat={0}
      hero={me.hero}
      health={me.health}
      armor={me.armor}
      tier={me.tier}
      self
      seenAgo={null}
      seenBoard={null}
      races={me.lastRaces}
      triples={me.triples}
      streak={me.streak}
      rank={rank}
      trinkets={me.trinkets}
      heroPowers={me.heroPowers}
    />
  );
}

interface AvatarPopProps {
  flipKey: string;
  seat: number;
  hero: CardRef | null;
  health?: number;
  armor?: number;
  tier: number;
  self?: boolean;
  dead?: boolean;
  isNext?: boolean;
  /** 1-based standing this round: drives the 1-3 badge and the crown. */
  rank: number;
  trinkets?: CardRef[];
  heroPowers?: CardRef[];
  /** `null` = we have not met them: no label, no warband cards. */
  seenAgo: number | null;
  seenBoard: Minion[] | null;
  races: Record<string, number>;
  triples: number;
  streak: number;
}

function AvatarPop(props: AvatarPopProps) {
  const [open, setOpen] = useState(false);
  const { seenAgo, seenBoard } = props;
  const warband = useMemo(() => summarizeRaces(props.races), [props.races]);
  const catalog = useStore((s) => s.catalog);
  // Live power first (if the engine exposes it); otherwise the static one that
  // ships with the hero in the catalog.
  const power = props.heroPowers?.[0] ?? (props.hero ? catalog?.byId[props.hero.id]?.heroPower ?? null : null);
  // A ruleset without trinkets hides the opponent's trinket row too.
  const trinketsOn = useCapability('trinkets');
  const trinkets = trinketsOn ? props.trinkets ?? [] : [];
  const wrapRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  // The panel is tall; for the avatars near the bottom of the rail it has to
  // slide up so it never runs off the stage. Measured after mount, because the
  // height depends on the power/trinkets/log it happens to show.
  const [panelTop, setPanelTop] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!open) {
      setPanelTop(null);
      return;
    }
    const wrap = wrapRef.current;
    const pop = popRef.current;
    if (!wrap || !pop) return;
    const stage = wrap.closest('.stage') as HTMLElement | null;
    const stageRect = stage?.getBoundingClientRect();
    const stageH = stageRect ? stageRect.height / (stageRect.width / 1600) : 900;
    const scale = stageRect ? stageRect.width / 1600 : 1;
    const relTop = stageRect ? (wrap.getBoundingClientRect().top - stageRect.top) / scale : 0;
    const h = pop.offsetHeight;
    const want = Math.max(4, Math.min(relTop - 8, stageH - h - 4));
    setPanelTop(want - relTop);
  }, [open, trinkets.length, Boolean(power), props.health, props.tier]);
  const showPeek = () => {
    setOpen(true);
    // The warband lives above Bob while the cursor is on an avatar.
    if (seenBoard && seenBoard.length > 0) usePeek.getState().show(seenBoard, cardName(props.hero));
  };
  const hidePeek = () => {
    setOpen(false);
    usePeek.getState().hide();
  };
  return (
    <div
      className="opp-wrap"
      ref={wrapRef}
      data-flip-key={props.flipKey}
      onMouseEnter={showPeek}
      onMouseLeave={hidePeek}
    >
      <div
        className={
          'opp-avatar' + (props.self ? ' self' : '') + (props.isNext ? ' next' : '') + (props.dead ? ' dead' : '')
        }
        title={`${cardName(props.hero)} · ${props.health ?? 30} 血${props.armor ? ` ${props.armor} 甲` : ''} · 酒馆 ${props.tier} 级`}
      >
        {/* The real rail shows a portrait, a tier pip and a crown — never the
            health numbers. Those live in the hover panel. */}
        <div className="opp-face">
          <HeroPortrait hero={props.hero} size={60} bare square showNumbers={false} showTooltip={false} />
          {props.dead && <SkullGlyph />}
          <div className="opp-bars" aria-hidden="true">
            {Boolean(props.armor) && (
              <span className="opp-bar armor">
                <i style={{ width: `${Math.min(100, ((props.armor ?? 0) / 30) * 100)}%` }} />
              </span>
            )}
            <span className="opp-bar health">
              <i style={{ width: `${Math.min(100, ((props.health ?? 30) / 30) * 100)}%` }} />
            </span>
          </div>
        </div>
        {props.rank === 1 && <CrownGlyph />}
        {/* The number is the live standing this round, not the tavern tier. */}
        {props.rank <= 3 && (
          <span className="opp-rank-badge" aria-label={`第 ${props.rank} 名`}>
            {props.rank}
          </span>
        )}
      </div>
      {open && (
        <div className="opp-pop" ref={popRef} style={panelTop === null ? undefined : { top: panelTop }}>
          {/* The real hover panel is a parchment card: big portrait with the
              name across the bottom and the health on its right edge, then the
              title line, tribe row and fight history. */}
          <div className="oph-portrait">
            <div className="oph-art">
              <HeroPortrait hero={props.hero} size={186} bare square showNumbers={false} showTooltip={false} />
            </div>
            <span className="oph-name">{cardName(props.hero)}</span>
            {props.health !== undefined && (
              <span className="oph-health" title={`生命 ${props.health}`}>
                {props.health}
              </span>
            )}
            {Boolean(props.armor) && (
              <span className="oph-armor" title={`护甲 ${props.armor}`}>
                {props.armor}
              </span>
            )}
          </div>
          <div className="oph-title">
            扮演…
            <span>
              酒馆等级 {props.tier} ·{' '}
              {props.self
                ? '你自己'
                : props.dead
                  ? '已淘汰'
                  : seenAgo === null
                    ? '尚未交手'
                    : seenAgo === 0
                      ? '本回合交手'
                      : `${seenAgo} 回合前交手`}
            </span>
          </div>
          {/* One line: the dominant tribe of last round's board (public, so it
              shows even if we never met them), their triples and win streak. */}
          <div className="oph-tribes">
            {warband.kind === 'race' ? (
              <>
                <img src={tribeIcon(warband.race)} alt="" />
                <span className="oph-race-name">{RACE_CN[warband.race] ?? warband.race}</span>
                <b className="oph-race-count">{warband.count}</b>
              </>
            ) : (
              <span className="oph-race-name">{warband.kind === 'mixed' ? '混合随从' : '阵容未知'}</span>
            )}
            <span className="oph-spacer" />
            <OppStat kind="triples" value={props.triples} />
            <OppStat kind="streak" value={props.streak} />
          </div>
          {/* Just the power's icon — the rule text lives in the card tooltip,
              not in this panel. */}
          {power && (
            <div className="oph-power">
              <span className="oph-power-icon" title={`${cardName(power)}：${plainText(textOf(power))}`}>
                <img src={art.portrait(power.id)} alt="" draggable={false} />
              </span>
              {trinkets.map((t, i) => (
                <span key={`${t.id}-${i}`} className="oph-trinket" title={cardName(t)}>
                  <img src={art.portrait(t.id)} alt="" draggable={false} />
                </span>
              ))}
            </div>
          )}
          {!power && trinkets.length > 0 && (
            <div className="oph-power">
              {trinkets.map((t, i) => (
                <span key={`${t.id}-${i}`} className="oph-trinket" title={cardName(t)}>
                  <img src={art.portrait(t.id)} alt="" draggable={false} />
                </span>
              ))}
            </div>
          )}
          <CombatLog seat={props.seat} hero={props.hero} />
        </div>
      )}
    </div>
  );
}

/** A card (triples) or flame (win streak) pip with the count drawn inside it. */
function OppStat({ kind, value }: { kind: 'triples' | 'streak'; value: number }) {
  return (
    <span
      className={`opp-stat ${kind}`}
      data-stat={kind}
      data-value={value}
      title={kind === 'triples' ? `三连 ${value}` : `连胜 ${value}`}
    >
      <svg viewBox="0 0 22 26" aria-hidden="true">
        {kind === 'triples' ? (
          <>
            <rect x="1.4" y="1.4" width="19.2" height="23.2" rx="3.2" />
            <rect className="inner" x="4.2" y="4.2" width="13.6" height="17.6" rx="1.8" />
          </>
        ) : (
          <>
            <path
              className="flame"
              d="M11 1.2c1.2 4 6.4 6 6.4 12.2 0 5.4-2.8 10-6.4 10s-6.4-4.6-6.4-10c0-3.8 1.8-5.8 3-8.8.6 3 1.6 4.4 2.8 5.2.4-3 .6-5.8.6-8.6z"
            />
            <path
              className="core"
              d="M11 11.4c1 2 2.4 3.2 2.4 5.6 0 2.8-1.1 5-2.4 5s-2.4-2.2-2.4-5c0-2.4 1.4-3.6 2.4-5.6z"
            />
          </>
        )}
        <text
          x="11"
          y={kind === 'triples' ? 16.4 : 17.4}
          textAnchor="middle"
          fontSize="10.5"
          fontWeight="900"
          stroke="rgba(0,0,0,0.9)"
          strokeWidth="2.6"
          paintOrder="stroke"
          fill="#fff"
        >
          {value}
        </text>
      </svg>
    </span>
  );
}

/**
 * A player's last three fights, newest first: this hero on the left, the hero
 * they fought on the right. The damage badge always sits on the side that took
 * it, so a row reads "I lost 6" or "I hit them for 6" without any text.
 */
function CombatLog({ seat, hero }: { seat: number; hero: CardRef | null }) {
  const history = useCombatLog((s) => s.bySeat[seat]);
  const view = useStore((s) => s.view)!;
  const heroOf = (id: number | null): CardRef | null => {
    if (id === null) return null;
    if (id === view.seat) return view.me.hero;
    return view.opponents.find((o) => o.id === id)?.hero ?? null;
  };
  const rows = history ? [...history].reverse() : [];

  return (
    <div className="opp-log">
      <div className="rail-title">战斗记录</div>
      {rows.length === 0 ? (
        <div className="opp-pop-empty">暂无战斗记录</div>
      ) : (
        <div className="combat-log">
          {rows.map((e) => {
            const foe = heroOf(e.foe);
            return (
              <div className="combat-log-row" key={e.turn}>
                <div className="cl-side self">
                  <HeroPortrait hero={hero} size={46} bare showNumbers={false} showTooltip={false} />
                  {e.result !== 'w' && <DamageBurst dmg={e.result === 'l' ? e.damage : 0} side="left" />}
                </div>
                <CrossedSwords />
                <div className={'cl-side foe' + (foe ? '' : ' ghost')}>
                  {foe ? (
                    <HeroPortrait hero={foe} size={46} bare showNumbers={false} showTooltip={false} />
                  ) : (
                    <span className="cl-ghost-label">幽灵</span>
                  )}
                  {e.result !== 'l' && (
                    <DamageBurst dmg={e.result === 'w' ? e.damage : 0} side="right" ghost={!foe} />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** A starburst damage pip, the way the game floats combat damage. */
function DamageBurst({ dmg, side, ghost = false }: { dmg: number; side: 'left' | 'right'; ghost?: boolean }) {
  const zero = dmg <= 0;
  return (
    <span
      className={`cl-dmg ${side}` + (zero ? ' zero' : '') + (ghost ? ' ghost' : '')}
      data-dmg={dmg}
      aria-label={`伤害 ${dmg}`}
    >
      <span className="cl-dmg-burst" aria-hidden="true" />
      <span className="cl-dmg-text">{zero ? '0' : `-${dmg}`}</span>
    </span>
  );
}

function CrossedSwords() {
  return (
    <svg className="cl-swords" viewBox="0 0 64 64" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="3" strokeLinecap="round" fill="none">
        <path d="M13 13 L47 47" />
        <path d="M51 13 L17 47" />
        <path d="M10 27 L26 43" />
        <path d="M54 27 L38 43" />
      </g>
    </svg>
  );
}

function CastFx() {
  const fx = useFx((s) => s.fx);
  if (!fx) return null;
  return (
    <div className="cast-fx" key={fx.id}>
      <div className="cast-ring" />
      <div className="cast-text">
        {fx.text}
        <span>{fx.sub}</span>
      </div>
    </div>
  );
}

/* ───────────────────────────── right: upgrade / trinkets / quests ───────────────────────────── */
function RightRail() {
  const view = useStore((s) => s.view)!;
  const me = view.me;
  const act = useStore((s) => s.act);
  const editMode = useUiEditor((s) => s.editMode);
  const upgradeBox = useUiEditor((s) => s.boxes.upgrade);
  const hasRail = me.quests.length > 0 || me.rewards.length > 0 || me.effects.length > 0;
  // Slots follow acquisition order (lesser first, then greater), NOT the card's
  // own `kind`: a trinket that transforms in place — 纪念品货架 copying a greater
  // trinket — must stay in the ring it was bought for, showing its new form.
  const [lesserTrinket, greaterTrinket] = me.trinkets;
  return (
    <>
      <TrinketSlots />
      <EditableBox id="upgrade" className="upgrade-slot">
        <FaithfulButton
          kind="upgrade"
          width={upgradeBox.w}
          cost={me.canUpgrade ? me.upgradePrice : 'MAX'}
          disabled={!me.canUpgrade || me.upgradePrice > me.gold}
          onClick={() => {
            sfx('upgrade');
            act(view.actions.UPGRADE);
          }}
          title="升级酒馆"
        />
      </EditableBox>

      {(hasRail || editMode) && (
      <EditableBox id="trinketRail" className="trinket-rail-slot trinket-slot">
      <div className="trinket-rail">
        {!hasRail && <div className="rail-empty">暂无任务 / 奖励</div>}
        {me.quests.length > 0 && (
          <div className="trinket-group">
            <div className="rail-title">任务</div>
            {me.quests.map((q, i) => (
              <div key={`q${i}`} className="quest-row">
                <RenderCard card={q.quest} width={38} height={58} />
                <div className="quest-main">
                  <div className="quest-name">{cardName(q.quest)}</div>
                  <div className="hp-bar quest-bar">
                    <i style={{ width: `${Math.min(100, (q.progress / Math.max(1, q.goal)) * 100)}%` }} />
                  </div>
                  <div className="quest-progress">
                    {q.progress}/{q.goal}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
        {me.rewards.length > 0 && (
          <div className="trinket-group">
            <div className="rail-title">奖励</div>
            <div className="trinket-cards">
              {me.rewards.map((r, i) => (
                <RenderCard key={`r${i}`} card={r} width={44} height={67} />
              ))}
            </div>
          </div>
        )}
        {me.effects.length > 0 && (
          <div className="trinket-group">
            <div className="rail-title">效果</div>
            <div className="effect-chips">
              {me.effects.map((e, i) => (
                <span key={i} className="kw-chip">
                  {cardName(e.card)} ×{e.stacks}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
      </EditableBox>
      )}
    </>
  );
}
