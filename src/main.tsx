import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { useStore } from './store';
import { localHash, useNet } from './store/net';
import './styles.css';

// Test seam. The whole game is a local single-page app that already hands the
// player the engine on a plate (it runs on their machine), so exposing the two
// stores costs nothing and lets scripts assert on the real client state instead
// of scraping pixels.
(window as unknown as Record<string, unknown>).__bgsim = {
  store: useStore,
  net: useNet,
  hash: localHash,
};

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
