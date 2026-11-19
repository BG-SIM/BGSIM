import React, { useEffect, useState } from 'react';
import { useStore } from '../store';
import type { CardRef, Item, Pending } from '../types';
import { MinionCard, RenderCard } from './Cards';
import { cardName, richText, plainText, textOf } from '../lib/assets';
import { useCapability } from '../features/registry';

/** One card in a full-table choice layer (discover, trinket, quest, ...). */
interface ChoiceCard {
  key: string;
  art: React.ReactNode;
  name: string;
  text: string;
  extra?: React.ReactNode;
  /** Card-face art already prints name/text: keep the sheet to its extra line. */
  compact?: boolean;
  disabled?: boolean;
  disabledHint?: string;
  onPick: () => void;
}

function RichText({ text }: { text: string }) {
  return (
    <>
      {richText(text).map((s, k) => (s.bold ? <b key={k}>{s.text}</b> : <span key={k}>{s.text}</span>))}
    </>
  );
}

/**
 * The real table never opens a dialog for these choices: the cards float over
 * the dimmed board under a banner, with a lone 隐藏 pill in the corner. Every
 * pending kind that asks the player to pick something uses this same layer so
 * the interaction reads the same whether it is a discover, a quest, a trinket
 * or the timewarp tavern.
 */
function ChoiceLayer(props: {
  title: string;
  subtitle?: string;
  cards: ChoiceCard[];
  actions?: React.ReactNode;
  hidden: boolean;
  onToggle: () => void;
}) {
  const { title, subtitle, cards, actions, hidden, onToggle } = props;
  return (
    <div className={'discover-layer' + (hidden ? ' hidden' : '')}>
      <div className="discover-dim" />
      <div className="discover-banner">
        <span>{title}</span>
      </div>
      {subtitle && <div className="discover-source">{subtitle}</div>}
      <div className={'discover-row' + (cards.length > 4 ? ' many' : '')}>
        {cards.map((c, i) => (
          <div
            key={c.key}
            className={'discover-card' + (c.disabled ? ' disabled' : '')}
            data-option={i}
            title={c.disabled ? c.disabledHint : undefined}
            onClick={() => {
              if (!c.disabled) c.onPick();
            }}
          >
            <div className="discover-art">{c.art}</div>
            {(!c.compact || c.extra) && (
              <div className={'discover-scroll' + (c.compact ? ' compact' : '')}>
                {!c.compact && (
                  <>
                    <div className="discover-name">{c.name}</div>
                    <div className="discover-text">
                      <RichText text={c.text} />
                    </div>
                  </>
                )}
                {c.extra}
                <span className="discover-key">{i + 1}</span>
              </div>
            )}
          </div>
        ))}
      </div>
      {actions && <div className="discover-actions">{actions}</div>}
      <button className="discover-hide" onClick={onToggle}>
        {hidden ? '显示' : '隐藏'}
      </button>
    </div>
  );
}

function artFor(o: CardRef | Item, minionScale = 1.45) {
  const isMinion = 'type' in o ? o.type === 'minion' : o.kind === 'minion';
  return {
    minion: isMinion,
    node: isMinion ? (
      <MinionCard card={o as never} scale={minionScale} interactive={false} />
    ) : (
      <RenderCard card={o as never} width={220} height={320} />
    ),
  };
}

/** Shared extras, styled like the small print on a discover card. */
function CostLine({ price, icon = 'coin' }: { price: number; icon?: 'coin' | 'chronum' }) {
  return (
    <div className="choice-cost">
      <span className={icon} /> {price}
    </div>
  );
}

export function PendingModal() {
  const view = useStore((s) => s.view)!;
  const pending = view.me.pending;
  const choose = useStore((s) => s.choose);
  const act = useStore((s) => s.act);
  const gold = view.me.gold;
  // Ruleset gating: a version without trinkets never shows the trinket picker.
  const trinketsOn = useCapability('trinkets');
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    setHidden(false);
  }, [pending?.kind]);
  if (!pending) return null;
  if (pending.kind === 'target') return null;
  if (pending.kind === 'trinket' && !trinketsOn) return null;

  const toggle = () => setHidden((v) => !v);
  const back = view.me.cancellable ? (
    <button className="btn btn-ghost" onClick={() => act(7)}>
      返回
    </button>
  ) : null;

  if (pending.kind === 'discover') {
    return (
      <ChoiceLayer
        title="进行选择"
        subtitle={pending.source ? `来自：${cardName(pending.source)}` : undefined}
        hidden={hidden}
        onToggle={toggle}
        cards={pending.options.map((o, i) => {
          const a = artFor(o);
          return {
          key: o.id + i,
          art: a.node,
          compact: !a.minion,
          name: cardName(o),
          text: textOf(o),
          extra:
            o.attached && o.attached.length > 0 ? (
              <div className="discover-attached">
                {o.attached.map((g) => (
                  <div key={g.id}>
                    <span className="da-name">{g.nameZh}</span>
                    <span className="da-text">：{plainText(g.textZh || g.text)}</span>
                  </div>
                ))}
              </div>
            ) : undefined,
          onPick: () => choose(i),
          };
        })}
      />
    );
  }

  if (pending.kind === 'choose_one') {
    return (
      <ChoiceLayer
        title="抉择"
        subtitle={pending.source ? `来自：${cardName(pending.source)}` : undefined}
        hidden={hidden}
        onToggle={toggle}
        actions={back}
        cards={pending.options.map((o, i) => {
          const a = artFor(o);
          return {
            key: o.id + i,
            art: a.node,
            compact: !a.minion,
            name: cardName(o),
            text: textOf(o),
            extra: <div className="choice-mode">模式 {i + 1}</div>,
            onPick: () => choose(i),
          };
        })}
      />
    );
  }

  if (pending.kind === 'trinket') {
    return (
      <ChoiceLayer
        title={pending.free ? '免费饰品' : '选择饰品'}
        subtitle={pending.replace ? `替换：${cardName(pending.replace)}` : undefined}
        hidden={hidden}
        onToggle={toggle}
        actions={back}
        cards={pending.options.map((o, i) => {
          const price = pending.free ? 0 : o.cost ?? 0;
          const disabled = !pending.free && price > gold;
          return {
            key: o.id + i,
            art: <RenderCard card={o} width={220} height={320} />,
            compact: true,
            name: cardName(o),
            text: textOf(o),
            extra: pending.free ? <div className="choice-mode">免费</div> : <CostLine price={price} />,
            disabled,
            disabledHint: '铸币不足',
            onPick: () => choose(i),
          };
        })}
      />
    );
  }

  if (pending.kind === 'quest') {
    return (
      <ChoiceLayer
        title="选择任务"
        hidden={hidden}
        onToggle={toggle}
        actions={back}
        cards={pending.options.map((o, i) => ({
          key: o.id + i,
          art: <RenderCard card={o} width={220} height={320} />,
          compact: true,
          name: cardName(o),
          text: textOf(o),
          extra: (
            <div className="choice-extra">
              <div>任务目标：{o.goal}</div>
              <div>奖励：{cardName(o.reward)}</div>
              <div className="dim">{plainText(textOf(o.reward))}</div>
            </div>
          ),
          onPick: () => choose(i),
        }))}
      />
    );
  }

  if (pending.kind === 'timewarp') {
    return (
      <ChoiceLayer
        title="时空扭曲酒馆"
        subtitle={`时空币：${pending.chronum}`}
        hidden={hidden}
        onToggle={toggle}
        actions={
          <>
            {back}
            <button className="btn" onClick={() => choose(pending.leave)} data-option={pending.leave}>
              离开时空扭曲酒馆
            </button>
          </>
        }
        cards={pending.options.map((o, i) => {
          const a = artFor(o, 1.1);
          return {
            key: o.id + i,
            art: a.node,
            compact: !a.minion,
            name: cardName(o),
            text: textOf(o),
            extra: <CostLine price={o.chronumCost} icon="chronum" />,
            onPick: () => choose(i),
          };
        })}
      />
    );
  }

  if (pending.kind === 'hero_power') {
    return (
      <ChoiceLayer
        title="选择英雄技能"
        hidden={hidden}
        onToggle={toggle}
        actions={back}
        cards={pending.options.map((o, i) => ({
          key: o.id + i,
          art: <RenderCard card={o} width={220} height={320} />,
          compact: true,
          name: cardName(o),
          text: textOf(o),
          onPick: () => choose(i),
        }))}
      />
    );
  }

  return null;
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  return (
    <div style={{ position: 'absolute', top: 66, left: '50%', transform: 'translateX(-50%)', zIndex: 120, display: 'flex', flexDirection: 'column', gap: 6 }}>
      {toasts.map((t) => (
        <div
          key={t.id}
          className="pop-in"
          onClick={() => dismiss(t.id)}
          style={{
            padding: '7px 18px',
            borderRadius: 6,
            fontSize: 13,
            border: '1px solid',
            borderColor: t.kind === 'error' ? '#c0553c' : t.kind === 'success' ? '#c9a83c' : '#7d5a2c',
            background: t.kind === 'error' ? 'rgba(70, 18, 12, .95)' : 'rgba(32, 22, 10, .95)',
            color: t.kind === 'error' ? '#ffb4a2' : '#ffe1a0',
            boxShadow: '0 6px 18px rgba(0,0,0,.5)',
            cursor: 'pointer',
          }}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}
