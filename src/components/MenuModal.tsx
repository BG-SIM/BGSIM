import React, { useState } from 'react';
import { useStore } from '../store';
import { sfx, sfxEnabled, setSfxEnabled } from '../lib/sfx';
import { api } from '../api';
import { useUiEditor } from '../store/uiEditor';

export function MenuModal() {
  const view = useStore((s) => s.view);
  const catalog = useStore((s) => s.catalog);
  const setShowMenu = useStore((s) => s.setShowMenu);
  const setShowCatalog = useStore((s) => s.setShowCatalog);
  const start = useStore((s) => s.start);
  const canUndo = useStore((s) => s.canUndo);
  const netMode = useStore((s) => s.mode === 'net');
  const [muted, setMuted] = useState(!sfxEnabled());

  return (
    <div className="modal-backdrop" style={{ zIndex: 180 }} onClick={() => setShowMenu(false)}>
      <div className="modal pop-in" style={{ width: 430, padding: 24 }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ marginBottom: 2 }}>菜单</h2>
        <div className="sub">
          {catalog ? `引擎 ${catalog.engine} · 版本 ${catalog.version}` : ''}
          {view ? ` · 第 ${view.turn} 回合` : ''}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 6 }}>
          <button className="btn btn-gold" style={{ padding: '11px 0', fontSize: 15, letterSpacing: 2 }} onClick={() => setShowMenu(false)}>
            继续游戏
          </button>
          <button
            className="btn"
            style={{ padding: '9px 0' }}
            onClick={() => {
              setShowMenu(false);
              useStore.getState().setScreen('home');
            }}
          >
            返回首页（对局保留）
          </button>
          <button
            className="btn"
            style={{ padding: '9px 0' }}
            onClick={() => {
              setShowMenu(false);
              void start();
            }}
          >
            重新开局（新种子）
          </button>
          <button
            className="btn"
            style={{ padding: '9px 0' }}
            onClick={() => {
              setShowMenu(false);
              setShowCatalog(true);
            }}
          >
            卡牌图鉴
          </button>
          <button
            className="btn"
            style={{ padding: '9px 0' }}
            onClick={() => {
              setShowMenu(false);
              useUiEditor.getState().enter();
            }}
          >
            UI 调整器（拖拽排版）
          </button>
          <div style={{ display: 'flex', gap: 10 }}>
            <button
              className="btn"
              style={{ flex: 1, padding: '8px 0' }}
              disabled={!canUndo || netMode}
              onClick={async () => {
                setShowMenu(false);
                await useStore.getState().undo();
              }}
            >
              撤销上一步
            </button>
            <button
              className="btn"
              style={{ flex: 1, padding: '8px 0' }}
              onClick={async () => {
                try {
                  await api.save();
                  useStore.getState().toast('已保存当前进度', 'success');
                } catch (e) {
                  useStore.getState().toast(e instanceof Error ? e.message : '保存失败', 'error');
                }
              }}
            >
              保存进度
            </button>
          </div>
          <button
            className="btn"
            style={{ padding: '8px 0' }}
            onClick={async () => {
              try {
                const res = await api.load();
                useStore.setState({ view: res.game, canUndo: false, showMenu: false });
                useStore.getState().toast('已读取存档', 'success');
              } catch (e) {
                useStore.getState().toast(e instanceof Error ? e.message : '读取失败', 'error');
              }
            }}
          >
            读取存档
          </button>
          <button
            className="btn"
            style={{ padding: '9px 0' }}
            onClick={() => {
              const on = !sfxEnabled();
              setSfxEnabled(on);
              setMuted(!on);
              if (on) sfx('click');
            }}
          >
            音效：{muted ? '关闭' : '开启'}
          </button>
        </div>

        <div style={{ marginTop: 18, fontSize: 11, color: '#8d7a55', lineHeight: 1.8 }}>
          <div>操作：点击购买 · 点击手牌打出 · 拖拽调整站位 · 右键出售</div>
          <div>快捷键：空格结束回合 · R 刷新 · F 冻结 · E 升级 · Ctrl+Z 撤销</div>
        </div>
      </div>
    </div>
  );
}
