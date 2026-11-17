import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../store';
import type { CardRef, CatalogCard, CombatMinion, Item, Minion } from '../types';
import { useDrag } from '../store/drag';
import { useTargeting } from '../store/targeting';
import {
  art,
  cardName,
  hasKw,
  keywordLabel,
  localArtEnabled,
  RACE_CN,
  richText,
  plainText,
  textOf,
  tierIcon,
  tribeIcon,
} from '../lib/assets';

const OVERLAY = (name: string) => `/img/minions/${name}.png`;

/* ───────────────────────────── tooltip ───────────────────────────── */
interface TipState {
  x: number;
  y: number;
  card: Minion | Item | CombatMinion | CatalogCard | CardRef;
  extra?: React.ReactNode;
}

export function useCardTooltip() {
  const [tip, setTip] = useState<TipState | null>(null);
  const timer = useRef<number | null>(null);
  const dragging = useDrag((s) => s.grab !== null);
  const aiming = useTargeting((s) => s.active);

  useEffect(() => {
    if (dragging) setTip(null);
  }, [dragging]);

  // While aiming at a target the tooltip would sit right on top of the card you
  // are pointing at.
  useEffect(() => {
    if (aiming) setTip(null);
  }, [aiming]);

  const show = useCallback(
    (e: React.MouseEvent, card: TipState['card'], extra?: React.ReactNode) => {
      if (useDrag.getState().grab) return;
      if (useTargeting.getState().active) return;
      if (timer.current) window.clearTimeout(timer.current);
      const x = e.clientX;
      const y = e.clientY;
      timer.current = window.setTimeout(() => setTip({ x, y, card, extra }), 90);
    },
    [],
  );
  const hide = useCallback(() => {
    if (timer.current) window.clearTimeout(timer.current);
    setTip(null);
  }, []);

  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  const node = tip ? createPortal(<Tooltip tip={tip} />, document.body) : null;
  return { show, hide, node };
}

function Tooltip({ tip }: { tip: TipState }) {
  const { catalog } = useStore();
  const card = tip.card as (Minion | Item | CardRef) & { tier?: number | null; races?: string[]; atk?: number | null; hp?: number | null };
  const name = cardName(card) || (card as CardRef).name || '';
  const text = textOf(card) || (card as CardRef).textZh || (card as CardRef).text || '';
  const races = (card.races ?? []).filter((r) => r !== 'ALL');
  const tier = (card as Minion).tier ?? (card as CardRef).tier;
  const atk = (card as Minion).atk ?? (card as CardRef).atk;
  const hp = (card as Minion).hp ?? (card as CardRef).hp;
  const kw = (card as Minion).kw ?? [];
  const gifts = ((card as Minion).attached ?? (card as Item).attached ?? []) as CardRef[];
  const isMinion =
    (card as Item).type === 'minion'
      ? true
      : (card as Item).type
        ? false
        : (card as Minion).maxHp !== undefined || (card as Minion).eid !== undefined;

  const width = 330;
  const left = Math.min(tip.x + 18, window.innerWidth - width - 12);
  // Near the bottom of the screen (the hand row) the tooltip would cover the
  // cards you are aiming at, so flip it above the cursor instead.
  const above = tip.y > window.innerHeight * 0.6;
  const pos: React.CSSProperties = above
    ? { left, bottom: window.innerHeight - tip.y + 14 }
    : { left, top: Math.min(tip.y + 14, window.innerHeight - 260) };
  const base = catalog?.byId[(card as Minion).id] as { atk?: number; hp?: number } | undefined;
  const goldenId = (card as Minion).id?.replace(/_G$/, '') ?? '';
  const baseCard = base ?? catalog?.byId[goldenId];

  return (
    <div className="tooltip" style={{ width, ...pos }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <div className="tt-name">{name}</div>
        {tier ? <img src={tierIcon(tier)} alt="" style={{ width: 22, marginLeft: 'auto' }} /> : null}
      </div>
      {races.length > 0 && (
        <div className="tt-meta">
          {races.map((r) => (
            <span key={r} className="race-chip">
              <img src={tribeIcon(r)} alt="" /> {RACE_CN[r] ?? r}
            </span>
          ))}
          {tip.extra}
        </div>
      )}
      {isMinion && (
        <div className="tt-stats">
          <span className="tt-atk">
            {atk ?? 0}
            {(card as Minion).maxHp !== undefined && (card as Minion).hp !== undefined && (card as Minion).hp < (card as Minion).maxHp ? '' : ''}
          </span>
          <span className="tt-hp">{hp ?? 0}</span>
          {baseCard && (atk ?? 0) > (baseCard.atk ?? 0) ? <span style={{ fontSize: 12, color: '#7dff7a' }}>+{(atk ?? 0) - (baseCard.atk ?? 0)}</span> : null}
          {baseCard && (hp ?? 0) > (baseCard.hp ?? 0) ? <span style={{ fontSize: 12, color: '#7dff7a' }}>+{(hp ?? 0) - (baseCard.hp ?? 0)}</span> : null}
        </div>
      )}
      {text ? (
        <div className="tt-text">
          {richText(text).map((seg, i) => (seg.bold ? <b key={i}>{seg.text}</b> : <span key={i}>{seg.text}</span>))}
        </div>
      ) : null}
      {kw.length > 0 && (
        <div className="kw-row">
          {kw.map((k) => (
            <span key={k} className="kw-chip">
              {keywordLabel(k)}
            </span>
          ))}
        </div>
      )}
      {gifts.length > 0 && (
        <div className="tt-gifts">
          {gifts.map((g) => (
            <div key={g.id} className="tt-gift">
              <span className="tt-gift-name">{g.nameZh}</span>
              <span className="tt-gift-text">{plainText(g.textZh || g.text)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ───────────────────────────── minion card ───────────────────────────── */
export interface MinionCardProps {
  card: Minion | Item | CombatMinion | CatalogCard | CardRef;
  scale?: number;
  interactive?: boolean;
  disabled?: boolean;
  selected?: boolean;
  frozen?: boolean;
  price?: number | null;
  owned?: number | null;
  tripleNeed?: number | null;
  showSell?: boolean;
  onClick?: (e: React.MouseEvent) => void;
  onSell?: (e: React.MouseEvent) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  onMouseEnter?: (e: React.MouseEvent) => void;
  onMouseLeave?: (e: React.MouseEvent) => void;
  dropTarget?: boolean;
  dragging?: boolean;
  style?: React.CSSProperties;
  className?: string;
  animate?: boolean;
  showTier?: boolean;
}

export function MinionCard({
  card,
  scale = 1,
  interactive = true,
  disabled = false,
  selected = false,
  frozen = false,
  price = null,
  owned = null,
  tripleNeed = null,
  showSell = false,
  onClick,
  onSell,
  onContextMenu,
  onMouseEnter,
  onMouseLeave,
  dropTarget,
  dragging,
  style,
  className = '',
  showTier = true,
}: MinionCardProps) {
  const { show, hide, node } = useCardTooltip();
  const minion = card as Minion;
  const item = card as Item;
  const catalog = useStore((s) => s.catalog);
  const golden = Boolean(minion.golden ?? item.golden);
  const kw = minion.kw ?? item.kw ?? [];
  const id = minion.id ?? item.id;
  const tier = (minion.tier ?? item.tier ?? 1) as number;
  const atk = minion.atk ?? item.atk ?? 0;
  const hp = minion.hp ?? item.hp ?? 0;
  const maxHp = minion.maxHp ?? hp;
  const shield = minion.shield ?? 0;
  const attached = (minion as Minion).attached ?? [];

  const baseId = id?.replace(/_G$/, '') ?? '';
  const base = catalog?.byId[id] ?? catalog?.byId[baseId];
  const fullText =
    ((minion as unknown as { textZh?: string }).textZh ?? '') +
    ((minion as unknown as { text?: string }).text ?? '') +
    ((item as unknown as { textZh?: string }).textZh ?? '') +
    ((item as unknown as { text?: string }).text ?? '') +
    ((base as unknown as { textZh?: string })?.textZh ?? '') +
    ((base as unknown as { text?: string })?.text ?? '');
  const hasDeathrattle = hasKw({ kw }, 'DEATHRATTLE') || /亡语\s*[:：]|Deathrattle\s*:/i.test(fullText);
  const baseAtk = base?.atk ?? atk;
  const baseHp = base?.hp ?? maxHp;

  const [imgFailed, setImgFailed] = useState(false);
  const goldenArt = golden ? minion.goldenId ?? item.goldenId : null;
  const portraitSources = Array.from(new Set([art.portrait(goldenArt ?? id), art.portrait(baseId)]));
  const [imgIdx, setImgIdx] = useState(0);
  const imgSrc = imgFailed ? '' : portraitSources[Math.min(imgIdx, portraitSources.length - 1)];

  const w = 168 * scale;
  const h = 200 * scale;

  const flags = {
    taunt: hasKw({ kw }, 'TAUNT'),
    reborn: hasKw({ kw }, 'REBORN'),
    deathrattle: hasDeathrattle,
    poisonous: hasKw({ kw }, 'POISONOUS'),
    venomous: hasKw({ kw }, 'VENOMOUS'),
    // The server's shop/hand projection drops `shield_hits`, so tavern minions
    // only report the keyword — keep both signals, but draw a single bubble.
    divineShield: hasKw({ kw }, 'DIVINE_SHIELD'),
    windfury: hasKw({ kw }, 'WINDFURY') || hasKw({ kw }, 'MEGA_WINDFURY'),
    // The engine does not expose these as keywords, so read them off the text:
    // rally is always written "进击：", and the trigger pip marks effects that
    // keep firing (start/end of turn, whenever, auras).
    rally: /进击\s*[：:]/.test(fullText),
    trigger: /(在你的回合结束时|在你的回合开始时|在战斗开始时|每当|光环)/.test(fullText),
  };

  return (
    <div
      className={`card-wrap ${interactive ? 'interactive' : ''} ${disabled ? 'disabled' : ''} ${selected ? 'selected' : ''} ${dragging ? 'dragging' : ''} ${dropTarget ? 'drop-target' : ''} ${className}`}
      style={{ width: w, height: h, ...style }}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onMouseEnter={(e) => {
        onMouseEnter?.(e);
        show(e, card);
      }}
      onMouseLeave={(e) => {
        onMouseLeave?.(e);
        hide();
      }}
    >
      {node}
      <CardFrame
        sources={portraitSources}
        name={cardName(card)}
        scale={scale}
        tier={tier}
        showTier={showTier}
        golden={golden}
        atk={atk}
        hp={hp}
        maxHp={maxHp}
        baseAtk={baseAtk}
        baseHp={baseHp}
        shield={shield}
        frozen={frozen}
        price={price}
        showSell={showSell}
        flags={flags}
        onSell={onSell}
      />
      {/* Outside the scaled frame so the snowflake sits on the card's real
          bottom-left corner instead of drifting below it. */}
      {frozen && <div className="freeze-mark">❄</div>}
    </div>
  );
}

interface CardFrameProps {
  sources: string[];
  name: string;
  scale: number;
  tier: number;
  showTier: boolean;
  golden: boolean;
  atk: number;
  hp: number;
  maxHp: number;
  baseAtk: number;
  baseHp: number;
  shield: number;
  frozen: boolean;
  price: number | null;
  showSell: boolean;
  flags: {
    taunt: boolean;
    reborn: boolean;
    deathrattle: boolean;
    poisonous: boolean;
    venomous: boolean;
    divineShield: boolean;
    windfury: boolean;
    rally: boolean;
    trigger: boolean;
  };
  onSell?: (e: React.MouseEvent) => void;
}

/**
 * The card art itself. Memoised on its primitive props: a tavern refresh or a
 * board buff only re-renders the cards that actually changed, not all thirty.
 */
const CardFrame = React.memo(function CardFrame(p: CardFrameProps) {
  const [failed, setFailed] = useState(false);
  const [idx, setIdx] = useState(0);
  const src = failed ? '' : p.sources[Math.min(idx, p.sources.length - 1)];
  const overlay = { left: -24, top: -36, width: 300, height: 350 };
  const f = p.flags;

  return (
    <div className="card-scale" style={{ width: 168, height: 200, transform: `scale(${p.scale})`, transformOrigin: 'top left' }}>
      <div className={`card-inner ${p.golden ? 'golden-frame' : ''}`}>
        {p.golden && <div className="golden-glow" />}
        {p.showTier && <img className="tier-badge" src={tierIcon(p.tier)} alt="" />}
        <div style={{ position: 'absolute', bottom: 0, left: 2, width: 164, height: 164 }}>
          <div className="canvas-256">
            {/* Taunt is a shield behind the portrait, like the real card frame. */}
            {f.taunt && <img className="overlay-img taunt-frame" src={OVERLAY('taunt')} alt="" style={overlay} />}
            {src ? (
              <img
                className="portrait"
                src={src}
                alt={p.name}
                loading="lazy"
                draggable={false}
                onError={() => {
                  if (idx + 1 < p.sources.length) setIdx(idx + 1);
                  else setFailed(true);
                }}
              />
            ) : (
              <div
                className="portrait"
                style={{
                  display: 'grid',
                  placeItems: 'center',
                  background: 'radial-gradient(circle at 50% 40%, #4a3a24, #1a1208)',
                  fontSize: 40,
                }}
              >
                ?
              </div>
            )}
            {f.windfury && <img className="overlay-img windfury-frame" src={OVERLAY('windfury')} alt="" style={overlay} />}
            <img className="overlay-img border-img" src={OVERLAY('border')} alt="" style={overlay} />
            {f.reborn && <img className="overlay-img" src={OVERLAY('reborn')} alt="" style={overlay} />}
            {f.deathrattle && <img className="overlay-img" src={OVERLAY('deathrattle')} alt="" style={overlay} />}
            {f.poisonous && <img className="overlay-img" src={OVERLAY('poisonous')} alt="" style={overlay} />}
            {f.venomous && <img className="overlay-img" src={OVERLAY('venomous')} alt="" style={overlay} />}
            {f.rally && <img className="overlay-img" src={OVERLAY('rally')} alt="" style={overlay} />}
            {f.trigger && <img className="overlay-img" src={OVERLAY('trigger')} alt="" style={overlay} />}
            <img className="overlay-img" src={OVERLAY('stats')} alt="" style={overlay} />
            {p.shield > 0 || f.divineShield ? (
              <img className="overlay-img shield-frame" src={OVERLAY('divine-shield')} alt="" style={overlay} />
            ) : null}
            <div className={`stat-num ${p.atk > p.baseAtk ? 'buff' : ''}`} style={{ left: 29, top: 185 }}>
              {p.atk}
            </div>
            <div className={`stat-num ${p.hp < p.maxHp ? 'hurt' : p.hp > p.baseHp ? 'buff' : ''}`} style={{ left: 151, top: 185 }}>
              {p.hp}
            </div>
          </div>
        </div>

        {p.price !== null && p.price !== undefined && (
          <div className="price-badge">
            <span className="coin" /> {p.price}
          </div>
        )}
        {p.showSell && (
          <div
            className="sell-hint"
            onMouseDown={(e) => {
              e.stopPropagation();
              p.onSell?.(e);
            }}
          >
            出售 +1
          </div>
        )}
      </div>
    </div>
  );
}, areFramesEqual);

/** Compare everything that is actually painted; `onSell` identity does not matter. */
function areFramesEqual(a: CardFrameProps, b: CardFrameProps): boolean {
  if (a === b) return true;
  if (
    a.name !== b.name ||
    a.scale !== b.scale ||
    a.tier !== b.tier ||
    a.showTier !== b.showTier ||
    a.golden !== b.golden ||
    a.atk !== b.atk ||
    a.hp !== b.hp ||
    a.maxHp !== b.maxHp ||
    a.baseAtk !== b.baseAtk ||
    a.baseHp !== b.baseHp ||
    a.shield !== b.shield ||
    a.frozen !== b.frozen ||
    a.price !== b.price ||
    a.showSell !== b.showSell
  ) {
    return false;
  }
  const fa = a.flags;
  const fb = b.flags;
  if (
    fa.taunt !== fb.taunt ||
    fa.reborn !== fb.reborn ||
    fa.deathrattle !== fb.deathrattle ||
    fa.poisonous !== fb.poisonous ||
    fa.venomous !== fb.venomous ||
    fa.divineShield !== fb.divineShield ||
    fa.windfury !== fb.windfury ||
    fa.rally !== fb.rally ||
    fa.trigger !== fb.trigger
  ) {
    return false;
  }
  if (a.sources.length !== b.sources.length) return false;
  for (let i = 0; i < a.sources.length; i++) if (a.sources[i] !== b.sources[i]) return false;
  return true;
}

/* ───────────────────────────── spell / render card ───────────────────────────── */
export function RenderCard({
  card,
  scale = 1,
  width,
  height,
  onClick,
  disabled,
  badge,
  style,
  className = '',
  fit = 'contain',
  frozen = false,
  liveStats = false,
}: {
  card: CardRef | Item;
  scale?: number;
  width?: number;
  height?: number;
  onClick?: (e: React.MouseEvent) => void;
  disabled?: boolean;
  badge?: React.ReactNode;
  style?: React.CSSProperties;
  className?: string;
  fit?: 'contain' | 'cover';
  frozen?: boolean;
  /** Paint the live atk/hp over the printed ones — hand cards only. */
  liveStats?: boolean;
}) {
  const { show, hide, node } = useCardTooltip();
  const [failed, setFailed] = useState(false);
  const w = width ?? 150 * scale;
  const h = height ?? 227 * scale;
  const golden = Boolean((card as unknown as Minion).golden ?? (card as Item).golden);
  const baseId = card.id.replace(/_G$/, '');
  // The art CDN has no golden *Battlegrounds* hand-card render: /v1/render
  // only carries the constructed frame (mana gem, class border) and for newer
  // cards it is missing entirely — which is why golden cards in hand used to
  // alternate between a constructed card and plain art. Always draw the BG
  // card and let the `.golden` class gild it, so every golden card matches.
  const sources = Array.from(
    new Set([art.render(baseId), art.render(card.id), art.portrait(baseId)].filter(Boolean)),
  );
  const [srcIdx, setSrcIdx] = useState(0);
  const renderSrc = sources[Math.min(srcIdx, sources.length - 1)];

  // A hand card is a flat card face with its stats printed into the artwork, so
  // buffed / golden cards would show stale numbers. Paint the live values over
  // the printed gems — but only where the caller asks (the hand): shop spells
  // and trinkets have no stats of their own and used to render a bogus 0/0.
  const liveAtk = (card as Item).atk;
  const liveHp = (card as Item).hp;
  // Only real minions carry stats. `eid` is not a reliable test — tavern spells
  // in hand can carry one too, which painted a bogus 0/0 on them.
  const isMinion = (card as Item).type === 'minion';
  const showStats = liveStats && isMinion && typeof liveAtk === 'number' && typeof liveHp === 'number';

  return (
    <div
      className={`${disabled ? 'disabled' : ''} ${golden ? 'is-golden' : ''} ${className}`}
      style={{ position: 'relative', width: w, height: h, cursor: onClick ? 'pointer' : 'default', ...style }}
      onClick={onClick}
      onMouseEnter={(e) => show(e, card)}
      onMouseLeave={hide}
    >
      {node}
      {!failed ? (
        <img
          src={renderSrc}
          alt={cardName(card)}
          style={{
            position: 'relative',
            zIndex: 1,
            width: '100%',
            height: '100%',
            objectFit: fit,
            filter: 'drop-shadow(0 6px 10px rgba(0,0,0,.55))',
          }}
          onError={() => {
            if (srcIdx + 1 < sources.length) setSrcIdx(srcIdx + 1);
            else setFailed(true);
          }}
          draggable={false}
        />
      ) : (
        <div className="panel" style={{ width: '100%', height: '100%', padding: 10, fontSize: 12 }}>
          <div style={{ color: '#ffe1a0', fontWeight: 700 }}>{cardName(card)}</div>
          <div style={{ color: '#bfa87c', marginTop: 6 }}>{textOf(card)}</div>
        </div>
      )}
      {showStats && (
        <>
          <span className="card-stat atk">{liveAtk}</span>
          <span className="card-stat hp">{liveHp}</span>
        </>
      )}
      {badge}
      {frozen && <div className="freeze-mark">❄</div>}
    </div>
  );
}

/* ───────────────────────────── hero portrait ───────────────────────────── */
export function HeroPortrait({
  hero,
  size = 96,
  health,
  armor,
  dim,
  onClick,
  showNumbers = true,
  bare = false,
  showTooltip = true,
  square = false,
}: {
  hero: CardRef | null;
  size?: number;
  health?: number;
  armor?: number;
  dim?: boolean;
  onClick?: (e: React.MouseEvent) => void;
  showNumbers?: boolean;
  bare?: boolean;
  showTooltip?: boolean;
  /** Square card-art crop (no arch frame), as the real table uses in lists. */
  square?: boolean;
}) {
  const { show, hide, node } = useCardTooltip();
  const [failed, setFailed] = useState(false);
  const [srcIdx, setSrcIdx] = useState(0);
  // The square crop is a separate CDN file. With the local pack on, only ask
  // for it when the engine actually knows that kind (an older engine would 404
  // on every avatar), and fall back to the framed art if the file is missing.
  const assets = useStore((s) => s.assets);
  const squareOk = !localArtEnabled() || Boolean(assets?.kinds?.heroSq);
  const sources = square && squareOk ? [art.heroSquare(hero?.id ?? ''), art.hero(hero?.id ?? '')] : [art.hero(hero?.id ?? '')];
  useEffect(() => setSrcIdx(0), [hero?.id, square]);
  if (!hero) return null;
  const img = !failed ? (
    <img
      src={sources[Math.min(srcIdx, sources.length - 1)]}
      alt={cardName(hero)}
      style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: square ? '50% 30%' : '50% 50%' }}
      onError={() => {
        if (srcIdx + 1 < sources.length) setSrcIdx(srcIdx + 1);
        else setFailed(true);
      }}
      draggable={false}
    />
  ) : (
    <div style={{ display: 'grid', placeItems: 'center', height: '100%', fontSize: 24 }}>?</div>
  );
  return (
    <div
      style={{ position: 'relative', width: size, height: size, flex: '0 0 auto', opacity: dim ? 0.45 : 1, cursor: onClick ? 'pointer' : 'default' }}
      onClick={onClick}
      onMouseEnter={showTooltip ? (e) => show(e, hero) : undefined}
      onMouseLeave={showTooltip ? hide : undefined}
    >
      {showTooltip && node}
      {bare ? (
        <div style={{ width: '100%', height: '100%', display: 'grid', placeItems: 'center', background: square ? `center / cover url(${art.hero(hero.id)})` : undefined }}>{img}</div>
      ) : (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: '50%',
            padding: 3,
            background: 'conic-gradient(from 210deg, #f6dd9a, #8a6428, #e8c877, #6b4a1c, #f6dd9a)',
            boxShadow: '0 4px 12px rgba(0,0,0,.65)',
          }}
        >
          <div style={{ width: '100%', height: '100%', borderRadius: '50%', overflow: 'hidden', background: '#1a1208' }}>{img}</div>
        </div>
      )}
      {showNumbers && (
        <>
          <div
            className="gem gem-health"
            style={{
              position: 'absolute',
              right: -6,
              bottom: -8,
              minWidth: size * 0.36,
              height: size * 0.36,
              fontSize: Math.max(13, size * 0.2),
            }}
          >
            {health ?? 30}
          </div>
          {armor !== undefined && armor > 0 && (
            <div
              className="gem gem-armor"
              style={{
                position: 'absolute',
                left: -6,
                bottom: -8,
                minWidth: size * 0.32,
                height: size * 0.32,
                fontSize: Math.max(11, size * 0.17),
              }}
            >
              {armor}
            </div>
          )}
        </>
      )}
    </div>
  );
}
