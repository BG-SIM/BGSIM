import React, { useEffect, useState } from 'react';
import { useStore } from '../store';
import {
  abandonGame,
  cancelQueue,
  defaultRelayUrl,
  enqueue,
  isPackagedApp,
  normalizeRelayUrl,
  relayUrl,
  resetRelayUrl,
  resumeGame,
  setAutoBot,
  setRelayUrl,
  setName,
  useNet,
} from '../store/net';

/**
 * Multiplayer screens. The lobby is one button (eight people fill a table), the
 * match itself is the normal tavern — these pieces only add the bits that are
 * specific to playing with seven other humans: who is at the table, who has
 * ended their turn, and whether the connection is healthy.
 */

/** 排队中：一个大按钮换成人数进度，满八人自动开局。 */
export function NetLobby() {
  const net = useNet();
  const busy = net.status === 'connecting';
  const [name, setLocalName] = useState(net.name);
  const [relay, setLocalRelay] = useState(net.relay);
  const [editRelay, setEditRelay] = useState(false);
  const [relayError, setRelayError] = useState<string | null>(null);

  useEffect(() => {
    setLocalRelay(net.relay);
  }, [net.relay]);

  const dots = Array.from({ length: net.need }, (_, i) => i < net.queued);

  /** Save the server address; if we were queued, requeue against the new one. */
  const applyRelay = () => {
    const clean = normalizeRelayUrl(relay);
    if (!clean) {
      setRelayError('地址看不懂：填 wss://域名/net、192.168.1.2:8790 或 host:port 都行');
      return;
    }
    const wasQueued = net.inQueue;
    if (wasQueued) cancelQueue();
    setRelayUrl(clean);
    setRelayError(null);
    setEditRelay(false);
    if (wasQueued) void enqueue();
  };

  const resetRelay = () => {
    if (net.inQueue) cancelQueue();
    resetRelayUrl();
    setLocalRelay(defaultRelayUrl());
    setRelayError(null);
    setEditRelay(false);
  };

  return (
    <div className="net-lobby">
      <div className="net-lobby-box">
        <div className="net-lobby-eyebrow">MULTIPLAYER</div>
        <div className="net-lobby-title">联机模式</div>
        <div className="net-lobby-sub">八人满即开局 · 每台机器各自跑同一局 · 中继只排队和排序动作</div>

        <div className="net-lobby-dots">
          {dots.map((on, i) => (
            <span key={i} className={'net-dot' + (on ? ' on' : '')} />
          ))}
        </div>
        <div className="net-lobby-count">
          {net.inQueue
            ? `排队中 ${net.queued}/${net.need}`
            : net.status === 'connecting'
              ? '正在连接中继…'
              : net.status === 'error'
                ? '连接失败'
                : `0/${net.need}`}
        </div>
        {net.otherQueues.length > 0 && (
          <div className="net-lobby-other">
            另有 {net.otherQueues.reduce((n, q) => n + q.n, 0)} 人在别的客户端版本上排队（
            {net.otherQueues.map((q) => q.key.replace('|', ' / ')).join('、')}
            ）——八人必须同版本，更新客户端才能同桌
          </div>
        )}

        <label className="net-field">
          <span>昵称</span>
          <input
            value={name}
            maxLength={16}
            onChange={(e) => setLocalName(e.target.value)}
            onBlur={() => setName(name.trim() || '玩家')}
            placeholder="玩家"
          />
        </label>

        <div className="net-lobby-actions">
          {net.inQueue ? (
            <button className="btn" onClick={() => cancelQueue()} disabled={busy}>
              取消排队
            </button>
          ) : (
            <button className="btn btn-gold net-big-btn" onClick={() => void enqueue()} disabled={busy}>
              {busy ? '连接中…' : '开始排队'}
            </button>
          )}
          {net.resumable && !net.inQueue && (
            <button className="btn" onClick={() => void resumeGame()}>
              回到刚才那局
            </button>
          )}
        </div>

        <div className="net-server">
          <div className="net-server-row">
            <span className="net-server-label">服务器</span>
            {editRelay ? (
              <input
                value={relay}
                onChange={(e) => setLocalRelay(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') applyRelay();
                }}
                placeholder="wss://bg.example.com/net"
                spellCheck={false}
              />
            ) : (
              <span className={'net-server-value' + (net.error ? ' bad' : '')} title={net.relay}>
                {net.relay}
              </span>
            )}
            {editRelay ? (
              <>
                <button className="btn btn-ghost" onClick={applyRelay}>
                  保存并连接
                </button>
                <button className="btn btn-ghost" onClick={resetRelay} title="清掉本机保存的地址，回到打包时内置的默认值">
                  恢复默认
                </button>
              </>
            ) : (
              <button className="btn btn-ghost" onClick={() => setEditRelay(true)}>
                修改
              </button>
            )}
          </div>
          {relayError && <div className="net-server-error">{relayError}</div>}
          <div className="net-server-meta">
            {net.proto !== null ? `协议 v${net.proto}` : '未连接'}
            {net.latency !== null && ` · ${net.latency}ms`}
            {net.localKey && ` · 本机引擎 ${net.localKey.replace('|', ' / ')}`}
          </div>
          {isPackagedApp() && !/^(ws|wss):\/\/(127\.0\.0\.1|localhost|tauri\.localhost)/.test(net.relay) && (
            <div className="net-server-meta dim">打包版：地址会记在这台机器上，换服务器不用重装</div>
          )}
        </div>
        {net.error && <div className="home-error">{net.error}</div>}
        <div className="net-lobby-hint">
          自己开服：<code>cd server &amp;&amp; npm install &amp;&amp; node relay.mjs</code>，再把这里指过去
          （<code>wss://你的域名/net</code>）。服务端与客户端完全独立，详见 <code>server/README.md</code>。
        </div>
      </div>
    </div>
  );
}

/** 匹配成功：一瞬的连接动画，然后直接进桌选英雄。 */
export function NetMatched() {
  const net = useNet();
  const [, force] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => force((n) => n + 1), 300);
    return () => window.clearInterval(t);
  }, []);
  if (!net.matchedAt || Date.now() - net.matchedAt > 2400) return null;
  return (
    <div className="net-matched">
      <div className="net-matched-title">匹配成功</div>
      <div className="net-matched-seats">
        {net.peers.map((p) => (
          <div key={p.seat} className={'net-seat' + (p.seat === net.seat ? ' me' : '') + (p.connected ? '' : ' off')}>
            <span className="net-seat-hero">?</span>
            <span className="net-seat-name">{p.name}</span>
            <span className="net-seat-no">#{p.seat + 1}</span>
          </div>
        ))}
      </div>
      <div className="net-matched-sub">种子 {net.seed} · 正在同步八份引擎…</div>
    </div>
  );
}

/** 牌桌上的联机状态条：座位 / 谁还在 / 托管 / 离开。 */
export function NetHud() {
  const net = useNet();
  const setScreen = useStore((s) => s.setScreen);
  const enterSolo = useStore((s) => s.enterSolo);
  const [confirmLeave, setConfirmLeave] = useState(false);
  if (net.status === 'idle' || net.status === 'online' || net.status === 'queue') return null;
  const endedCount = net.endedSeats.length;
  return (
    <div className="net-hud">
      <span className="net-hud-seat">座位 {net.seat + 1}</span>
      <span className="net-hud-name" title={`房间 ${net.room ?? ''}`}>
        {net.name}
      </span>
      <span className="net-hud-peers" title="其他玩家">
        {net.peers.map((p) => (
          <i
            key={p.seat}
            className={'net-pip' + (p.connected ? ' on' : '') + (p.seat === net.seat ? ' me' : '') + (p.bot ? ' bot' : '')}
            title={`${p.name}${p.seat === net.seat ? '（你）' : p.bot ? ' · 电脑' : p.connected ? '' : ' · 掉线'}`}
          />
        ))}
      </span>
      <span className="net-hud-wait" title="本回合已经结束的玩家">
        {net.needMe ? '你的回合' : net.over ? '已结束' : `等待 ${endedCount}/${net.peers.length || 8}`}
      </span>
      {net.latency !== null && (
        <span className={'net-hud-ping' + (net.latency > 180 ? ' bad' : '')} title="到联机服务器的往返延迟">
          {net.latency}ms
        </span>
      )}
      <button
        className={'net-hud-btn' + (net.autoBot ? ' on' : '')}
        title="托管：让引擎替你操作，掉线/挂机时用"
        onClick={() => setAutoBot(!net.autoBot)}
      >
        托管
      </button>
      <button
        className="net-hud-btn"
        title="离开这局（座位会被系统接管到本回合结束）"
        onClick={() => {
          if (!confirmLeave) {
            setConfirmLeave(true);
            window.setTimeout(() => setConfirmLeave(false), 3000);
            return;
          }
          abandonGame();
          enterSolo();
          setScreen('home');
        }}
      >
        {confirmLeave ? '确认离开？' : '离开'}
      </button>
    </div>
  );
}

/** 断线/重建/不同步：盖在牌桌上的一句话。 */
export function NetOverlay() {
  const net = useNet();
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    setHidden(false);
  }, [net.desync, net.error]);
  const blocked = (net.status === 'connecting' && Boolean(net.room)) || net.rebuilding;
  const warn = !blocked && (net.desync || net.error);
  if (!blocked && !warn) return null;
  if (hidden) return null;
  return (
    <div className={'net-overlay' + (blocked ? ' blocking' : '')}>
      {blocked ? (
        <>
          <div className="net-overlay-title">{net.rebuilding ? '正在同步这一局…' : '重连中…'}</div>
          <div className="net-overlay-sub">所有人必须按同一个动作顺序推进，请稍候</div>
        </>
      ) : (
        <>
          <div className="net-overlay-title warn">{net.desync ? '状态不同步' : net.error}</div>
          {net.desync && <div className="net-overlay-sub">{net.desync}</div>}
          <button className="btn btn-ghost" onClick={() => setHidden(true)}>
            知道了
          </button>
        </>
      )}
    </div>
  );
}
