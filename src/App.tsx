import React, { useEffect, useLayoutEffect, useState } from 'react';
import { useStore } from './store';
import { playFlip } from './lib/flip';
import { Tavern } from './components/Tavern';
import { CombatOverlay } from './components/Combat';
import { PendingModal, Toasts } from './components/Modals';
import { MenuModal } from './components/MenuModal';
import { DragGhost } from './components/DragGhost';
import { LayoutEditor } from './components/LayoutEditor';
import { useUiEditor } from './store/uiEditor';
import { CatalogOverlay, GameOverScreen, HeroSelectScreen, StartScreen } from './components/Screens';
import { HomeScreen } from './components/Home';
import { NetHud, NetLobby, NetMatched, NetOverlay } from './components/Net';
import { useNet } from './store/net';
import { enqueue as netEnqueue, resumeGame as netResume, setAutoBot as netSetAutoBot } from './store/net';
import { TargetArrow } from './components/TargetArrow';

function useStageScale(editMode: boolean) {
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const update = () => {
      const availW = window.innerWidth - (editMode ? 380 : 0);
      const s = Math.min(availW / 1600, window.innerHeight / 900);
      setScale(Math.max(0.3, s));
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [editMode]);
  return scale;
}

export default function App() {
  const boot = useStore((s) => s.boot);
  const booting = useStore((s) => s.booting);
  const screen = useStore((s) => s.screen);
  const mode = useStore((s) => s.mode);
  const view = useStore((s) => s.view);
  const combat = useStore((s) => s.combat);
  const showCatalog = useStore((s) => s.showCatalog);
  const showMenu = useStore((s) => s.showMenu);
  const editMode = useUiEditor((s) => s.editMode);
  const showGrid = useUiEditor((s) => s.showGrid);
  const revision = useStore((s) => s.revision);
  const netStatus = useNet((s) => s.status);
  const netQueued = useNet((s) => s.inQueue);
  const scale = useStageScale(editMode);

  // Cards slid around during the commit above; animate them from their old
  // spot so rows never jump.
  useLayoutEffect(() => {
    playFlip();
  }, [revision]);

  useEffect(() => {
    void boot();
  }, [boot]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has('edit')) {
      useUiEditor.getState().enter();
    }
    // `?mode=single` jumps straight into the game — handy for scripts and for
    // bookmarks, the launcher stays the default.
    if (params.get('mode') === 'single') {
      useStore.getState().setScreen('single');
    }
    // `?mode=net` (and `&bot=1` for a self-playing seat) is how the end-to-end
    // test drives eight browsers without a human.
    if (params.get('mode') === 'net') {
      void (async () => {
        if (useNet.getState().resumable) await netResume();
        else await netEnqueue();
        // Turned on *after* queueing: joining a queue resets the takeover flag.
        if (params.get('bot') === '1') netSetAutoBot(true);
      })();
    }
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState();
      if (s.screen === 'home') return;
      if (s.mode === 'net' && !useNet.getState().needMe) return;
      if (!s.view || s.combat || s.showCatalog || s.busy) return;
      if (s.view.me.pending) return;
      const target = e.target as HTMLElement;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      const a = s.view.actions;
      if (e.code === 'Space') {
        e.preventDefault();
        if (s.view.legal.includes(a.END)) void s.act(a.END);
      } else if (/^[1-9]$/.test(e.key)) {
        // Play the n-th hand card, like clicking it.
        const i = Number(e.key) - 1;
        const card = s.view.me.hand[i];
        if (card) void s.playCard(i, { hid: card.hid });
      } else if (e.key === 'r' || e.key === 'R') {
        if (s.view.legal.includes(a.REFRESH)) void s.act(a.REFRESH);
      } else if (e.key === 'f' || e.key === 'F') {
        if (s.view.legal.includes(a.FREEZE)) void s.act(a.FREEZE);
      } else if (e.key === 'e' || e.key === 'E') {
        if (s.view.legal.includes(a.UPGRADE)) void s.act(a.UPGRADE);
      } else if (e.key === 'z' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void s.undo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  let content: React.ReactNode = null;
  // A live net match owns the game screens; everything else on the net screen is
  // the lobby (queued, connecting, or complaining about the relay).
  const netLive = mode === 'net' && (netStatus === 'playing' || netStatus === 'over');
  if (screen === 'home') {
    content = <HomeScreen />;
  } else if (screen === 'net' && !netLive) {
    content = <NetLobby />;
  } else if (booting && !view) {
    content = (
      <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: '#a48f66', letterSpacing: 4 }}>
        正在连接酒馆引擎…
      </div>
    );
  } else if (!view) {
    content = <StartScreen />;
  } else if (view.phase === 'hero_select') {
    content = <HeroSelectScreen />;
  } else if (view.phase === 'game_over') {
    content = <GameOverScreen />;
  } else if (combat) {
    content = <CombatOverlay combat={combat} />;
  } else {
    content = (
      <>
        <Tavern />
        <PendingModal />
      </>
    );
  }

  return (
    <div className="stage-wrap" style={editMode ? { placeItems: 'start' } : undefined}>
      <div
        className={'stage' + (editMode ? ' editing' : '') + (editMode && showGrid ? ' grid-on' : '')}
        style={{ transform: `scale(${scale})`, transformOrigin: editMode ? 'top left' : 'center center' }}
      >
        {content}
        {mode === 'net' && view && view.phase !== 'game_over' && <NetHud />}
        {mode === 'net' && <NetMatched />}
        <TargetArrow />
        <Toasts />
        {mode === 'net' && <NetOverlay />}
        {showCatalog && <CatalogOverlay />}
        {showMenu && <MenuModal />}
        <DragGhost />
      </div>
      <LayoutEditor />
    </div>
  );
}
