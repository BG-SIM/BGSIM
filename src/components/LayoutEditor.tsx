import React, { useEffect, useMemo, useState } from 'react';
import { useUiEditor } from '../store/uiEditor';
import { ELEMENT_NAMES, DEFAULT_LAYOUT } from '../lib/layout';
import { useStore } from '../store';
import { api } from '../api';
import { hiddenBoxes, useCapabilities } from '../features/registry';

/** Floating control panel for the table layout editor. */
export function LayoutEditor() {
  const editMode = useUiEditor((s) => s.editMode);
  const boxes = useUiEditor((s) => s.boxes);
  const scales = useUiEditor((s) => s.scales);
  const gaps = useUiEditor((s) => s.gaps);
  const handArc = useUiEditor((s) => s.handArc);
  const selected = useUiEditor((s) => s.selected);
  const showGrid = useUiEditor((s) => s.showGrid);
  const exit = useUiEditor((s) => s.exit);
  const select = useUiEditor((s) => s.select);
  const setBox = useUiEditor((s) => s.setBox);
  const setScale = useUiEditor((s) => s.setScale);
  const setGap = useUiEditor((s) => s.setGap);
  const setHandArc = useUiEditor((s) => s.setHandArc);
  const resetAll = useUiEditor((s) => s.resetAll);
  const resetBox = useUiEditor((s) => s.resetBox);
  const load = useUiEditor((s) => s.load);
  const toggleGrid = useUiEditor((s) => s.toggleGrid);
  const exportJson = useUiEditor((s) => s.exportJson);

  const [collapsed, setCollapsed] = useState(false);
  const [json, setJson] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  useEffect(() => {
    if (!editMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (!selected) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      const b = boxes[selected];
      if (!b) return;
      const step = e.shiftKey ? 10 : 1;
      const map: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      };
      const d = map[e.key];
      if (!d) return;
      e.preventDefault();
      setBox(selected, { x: b.x + d[0], y: b.y + d[1], w: b.w, h: b.h });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editMode, selected, boxes, setBox]);

  // Boxes owned by a feature the current ruleset switched off are hidden here
  // too, so the editor never lists a control that is not on the table.
  const caps = useCapabilities();
  const hidden = useMemo(() => hiddenBoxes(caps), [caps]);
  const ids = useMemo(() => Object.keys(boxes).filter((id) => !hidden.has(id)), [boxes, hidden]);

  if (!editMode) return null;

  const box = selected ? boxes[selected] : null;

  const setupDemo = async () => {
    setBusy(true);
    setNote('正在生成演示局面…');
    try {
      const store = useStore.getState();
      const catalog = store.catalog;
      await store.start(20261111);
      const v = useStore.getState().view;
      if (v?.me.pending?.kind === 'hero') {
        await useStore.getState().pickHero(v.me.pending.options[0].id);
      }
      const minions = (catalog?.cards ?? []).filter((c) => c.kind === 'minion' && c.inPool && (c.tier ?? 0) >= 3 && (c.tier ?? 0) <= 5);
      const spells = (catalog?.cards ?? []).filter((c) => c.kind === 'tavern_spell');
      await api.debug({ cmd: 'set_player', gold: 10, tier: 4, health: 22, armor: 5 });
      await api.debug({ cmd: 'clear_zone', zone: 'shop' });
      await api.debug({ cmd: 'clear_zone', zone: 'board' });
      for (let i = 0; i < 7; i++) {
        const c = minions[(i * 7 + 3) % Math.max(1, minions.length)];
        if (c) await api.debug({ cmd: 'add_minion', zone: 'board', card: c.id });
      }
      for (let i = 0; i < 6; i++) {
        const c = minions[(i * 11 + 5) % Math.max(1, minions.length)];
        if (c) await api.debug({ cmd: 'add_minion', zone: 'shop', card: c.id });
      }
      if (spells[0]) await api.debug({ cmd: 'add_spell', zone: 'shop', card: spells[0].id });
      if (spells[1]) await api.debug({ cmd: 'add_spell', zone: 'hand', card: spells[1].id });
      if (minions[0]) await api.debug({ cmd: 'add_minion', zone: 'hand', card: minions[0].id });
      const trinkets = (catalog?.cards ?? []).filter((c) => c.kind && c.kind.startsWith('trinket'));
      for (let i = 0; i < 2 && i < trinkets.length; i++) {
        await api.debug({ cmd: 'give_trinket', card: trinkets[i].id });
      }
      const res = await api.state();
      useStore.setState({ view: res.game, log: res.log ?? [], busy: false });
      setNote('演示局面已生成');
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    const text = exportJson();
    setJson(text);
    try {
      await navigator.clipboard.writeText(text);
      setNote('已复制布局 JSON');
    } catch {
      setNote('复制失败，请从下方文本框手动复制');
    }
  };

  const download = () => {
    const blob = new Blob([exportJson()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'bgsim-layout.json';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const applyJson = () => {
    try {
      const data = JSON.parse(json);
      load(data);
      setNote('布局已应用');
    } catch {
      setNote('JSON 解析失败');
    }
  };

  const num = (key: 'x' | 'y' | 'w' | 'h') => (
    <input
      type="number"
      value={box ? box[key] : 0}
      onChange={(e) => {
        if (!selected || !box) return;
        setBox(selected, { ...box, [key]: Number(e.target.value) });
      }}
      style={{ width: 64 }}
    />
  );

  return (
    <>
      <div className={`layout-panel ${collapsed ? 'collapsed' : ''}`}>
        <div className="lp-head">
          <b>UI 调整器</b>
          <span className="lp-sub">拖动元素移动 · 右下角缩放 · 方向键微调</span>
          <button className="topbar-btn" onClick={() => setCollapsed((v) => !v)}>
            {collapsed ? '展开' : '收起'}
          </button>
          <button className="topbar-btn" onClick={exit}>
            退出
          </button>
        </div>

        {!collapsed && (
          <>
            <div className="lp-actions">
              <button className="btn" disabled={busy} onClick={setupDemo}>
                生成演示局面
              </button>
              <button className="btn" onClick={resetAll}>
                重置全部
              </button>
              <button className={'btn ' + (showGrid ? 'btn-gold' : '')} onClick={toggleGrid}>
                网格
              </button>
            </div>
            {note && <div className="lp-note">{note}</div>}

            <div className="lp-list">
              {ids.map((id) => {
                const b = boxes[id];
                return (
                  <div key={id} className={'lp-item' + (selected === id ? ' on' : '')} onClick={() => select(id)}>
                    <span className="lp-name">{ELEMENT_NAMES[id] ?? id}</span>
                    <span className="lp-pos">
                      {b.x},{b.y} · {b.w}×{b.h}
                    </span>
                  </div>
                );
              })}
            </div>

            {box && selected && (
              <div className="lp-selected">
                <div className="lp-selected-title">{ELEMENT_NAMES[selected] ?? selected}</div>
                <div className="lp-fields">
                  <label>
                    X {num('x')}
                  </label>
                  <label>
                    Y {num('y')}
                  </label>
                  <label>
                    W {num('w')}
                  </label>
                  <label>
                    H {num('h')}
                  </label>
                </div>
                <button className="btn" style={{ padding: '3px 10px', fontSize: 11 }} onClick={() => resetBox(selected)}>
                  重置此元素
                </button>
              </div>
            )}

            <div className="lp-scales">
              {(
                [
                  ['shop', '酒馆卡尺寸'],
                  ['board', '战场卡尺寸'],
                  ['hand', '手牌尺寸'],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="lp-scale">
                  <span>
                    {label} {scales[key].toFixed(2)}
                  </span>
                  <input
                    type="range"
                    min={0.4}
                    max={1.2}
                    step={0.01}
                    value={scales[key]}
                    onChange={(e) => setScale(key, Number(e.target.value))}
                  />
                </label>
              ))}
            </div>

            <div className="lp-scales">
              {(
                [
                  ['shop', '酒馆卡间距'],
                  ['board', '战场卡间距'],
                  ['hand', '手牌间距（10张）'],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="lp-scale">
                  <span>
                    {label} {gaps[key]}
                  </span>
                  <input
                    type="range"
                    min={-110}
                    max={12}
                    step={0.5}
                    value={gaps[key]}
                    onChange={(e) => setGap(key, Number(e.target.value))}
                  />
                </label>
              ))}
            </div>

            <div className="lp-scales">
              <label className="lp-scale">
                <span>手牌弧度（10张） {handArc.toFixed(1)}°</span>
                <input
                  type="range"
                  min={0}
                  max={8}
                  step={0.1}
                  value={handArc}
                  onChange={(e) => setHandArc(Number(e.target.value))}
                />
              </label>
            </div>

            <div className="lp-json">
              <div className="lp-json-actions">
                <button className="btn" onClick={copy}>
                  复制 JSON
                </button>
                <button className="btn" onClick={download}>
                  下载
                </button>
                <button className="btn" onClick={applyJson}>
                  应用
                </button>
              </div>
            <textarea value={json} onChange={(e) => setJson(e.target.value)} placeholder="导出后把 JSON 提交到 src/lib/layout.ts，或粘贴 JSON 后点应用" />
            </div>

            <div className="lp-hint">
          默认值备份：{Object.keys(DEFAULT_LAYOUT).length} 个元素。调整完成后点「复制 JSON」，把它提交进 src/lib/layout.ts 的 DEFAULT_LAYOUT。
            </div>
          </>
        )}
      </div>
    </>
  );
}
