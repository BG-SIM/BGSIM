import React, { useEffect, useState } from 'react';
import { useStore } from '../store';
import type { Pending } from '../types';
import { MinionCard, RenderCard } from './Cards';
import { cardName, richText, plainText, textOf } from '../lib/assets';
import { useCapability } from '../features/registry';

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

  // Discover is not a dialog on the real table: the three cards float over the
  // dimmed board under a charged banner, with a lone 隐藏 pill bottom-left.
  if (pending.kind === 'discover') {
    return (
      <div className={'discover-layer' + (hidden ? ' hidden' : '')}>
        <div className="discover-dim" />
        <div className="discover-banner">
          <span>进行选择</span>
        </div>
        {pending.source && <div className="discover-source">来自：{cardName(pending.source)}</div>}
        <div className="discover-row">
          {pending.options.map((o, i) => (
            <div key={o.id + i} className="discover-card" onClick={() => choose(i)} data-option={i}>
              <div className="discover-art">
                {o.type === 'minion' ? (
                  <MinionCard card={o} scale={1.45} interactive={false} />
                ) : (
                  <RenderCard card={o} width={220} height={320} />
                )}
              </div>
              <div className="discover-scroll">
                <div className="discover-name">{cardName(o)}</div>
                <div className="discover-text">
                  {richText(textOf(o)).map((s, k) => (s.bold ? <b key={k}>{s.text}</b> : <span key={k}>{s.text}</span>))}
                </div>
                {o.attached && o.attached.length > 0 && (
                  <div className="discover-attached">
                    {o.attached.map((g) => (
                      <div key={g.id}>
                        <span className="da-name">{g.nameZh}</span>
                        <span className="da-text">：{plainText(g.textZh || g.text)}</span>
                      </div>
                    ))}
                  </div>
                )}
                <span className="discover-key">{i + 1}</span>
              </div>
            </div>
          ))}
        </div>
        <button className="discover-hide" onClick={() => setHidden(!hidden)}>
          {hidden ? '显示' : '隐藏'}
        </button>
      </div>
    );
  }

  const title = (p: Pending): string => {
    switch (p.kind) {
      case 'discover':
        return '发现';
      case 'choose_one':
        return '抉择';
      case 'trinket':
        return p.free ? '免费饰品' : '选择饰品';
      case 'quest':
        return '选择任务';
      case 'timewarp':
        return '时空扭曲酒馆';
      case 'hero_power':
        return '选择英雄技能';
      case 'hero':
        return '选择英雄';
      default:
        return '选择';
    }
  };

  const subtitle = (p: Pending): string => {
    if (p.kind === 'discover' && p.source) return `来自：${cardName(p.source)}`;
    if (p.kind === 'trinket' && p.replace) return `替换：${cardName(p.replace)}`;
    if (p.kind === 'timewarp') return `时空币：${p.chronum}`;
    return '';
  };

  return (
    <div
      className={'modal-backdrop' + (hidden ? ' hidden' : '')}
      style={hidden ? ({ backdropFilter: 'none', WebkitBackdropFilter: 'none', background: 'transparent' } as React.CSSProperties) : undefined}
    >
      <div className={'modal pop-in' + (hidden ? ' modal-hidden' : '')} style={{ maxWidth: 980 }}>
        <div className="modal-head">
          <h2>{title(pending)}</h2>
          <button className="btn modal-hide" onClick={() => setHidden(!hidden)}>
            {hidden ? '显示' : '隐藏'}
          </button>
        </div>
        <div className="modal-body" style={{ visibility: hidden ? 'hidden' : 'visible' }}>
        <div className="sub">{subtitle(pending)}</div>

        {pending.kind === 'choose_one' && (
          <div style={{ display: 'flex', gap: 18, justifyContent: 'center' }}>
            {pending.options.map((o, i) => (
              <div key={i} className="panel" style={{ width: 260, padding: 16, cursor: 'pointer' }} onClick={() => choose(i)} data-option={i}>
                <div style={{ color: '#ffe1a0', fontSize: 16, fontWeight: 700 }}>{cardName(o)}</div>
                <div style={{ marginTop: 8, fontSize: 13, color: '#cdbb95' }}>模式 {i + 1}</div>
                <div style={{ marginTop: 8, fontSize: 12, color: '#a48f66' }}>{textOf(o)}</div>
              </div>
            ))}
          </div>
        )}

        {pending.kind === 'trinket' && (
          <div style={{ display: 'flex', gap: 18, justifyContent: 'center' }}>
            {pending.options.map((o, i) => {
              const price = pending.free ? 0 : o.cost;
              const disabled = !pending.free && price > gold;
              return (
                <div
                  key={o.id + i}
                  style={{ position: 'relative', cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1 }}
                  onClick={() => !disabled && choose(i)} data-option={i}
                >
                  <RenderCard card={o} width={168} height={255} />
                  <div className="price-badge">
                    <span className="coin" /> {price}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {pending.kind === 'quest' && (
          <div style={{ display: 'flex', gap: 18, justifyContent: 'center' }}>
            {pending.options.map((o, i) => (
              <div key={o.id + i} style={{ cursor: 'pointer', width: 240 }} onClick={() => choose(i)} data-option={i}>
                <RenderCard card={o} width={168} height={255} />
                <div className="panel" style={{ marginTop: 6, padding: 8, fontSize: 11 }}>
                  <div style={{ color: '#ffe1a0' }}>任务目标：{o.goal}</div>
                  <div style={{ color: '#a48f66', marginTop: 4 }}>奖励：{cardName(o.reward)}</div>
                  <div style={{ color: '#cdbb95', marginTop: 4 }}>{textOf(o.reward)}</div>
                </div>
              </div>
            ))}
          </div>
        )}

        {pending.kind === 'timewarp' && (
          <div>
            <div style={{ display: 'flex', gap: 14, justifyContent: 'center', flexWrap: 'wrap' }}>
              {pending.options.map((o, i) => (
                <div key={o.id + i} style={{ position: 'relative', cursor: 'pointer' }} onClick={() => choose(i)} data-option={i}>
                  {o.type === 'minion' ? <MinionCard card={o} scale={0.95} /> : <RenderCard card={o} width={150} height={227} />}
                  <div className="price-badge">
                    <span className="coin" /> {o.chronumCost}
                  </div>
                </div>
              ))}
            </div>
            <div style={{ textAlign: 'center', marginTop: 16 }}>
              <button className="btn" onClick={() => choose(pending.leave)} data-option={pending.leave}>
                离开时空扭曲酒馆
              </button>
            </div>
          </div>
        )}

        {pending.kind === 'hero_power' && (
          <div style={{ display: 'flex', gap: 16, justifyContent: 'center' }}>
            {pending.options.map((o, i) => (
              <div key={o.id + i} style={{ cursor: 'pointer' }} onClick={() => choose(i)} data-option={i}>
                <RenderCard card={o} width={150} height={227} />
              </div>
            ))}
          </div>
        )}

        {view.me.cancellable && (
          <div style={{ textAlign: 'center', marginTop: 16 }}>
            <button className="btn btn-ghost" onClick={() => act(7)}>
              返回
            </button>
          </div>
        )}
        </div>
      </div>
    </div>
  );
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
