import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Engine bridge to proxy /api to. Override with BGSIM_ENGINE when running a
// second engine instance (e.g. a throwaway test game on another port).
const engine = process.env.BGSIM_ENGINE || 'http://127.0.0.1:8787';
// Net relay (scripts/relay.mjs) — the lobby/lockstep server for multiplayer.
// Each player runs their own engine; they all meet at one relay.
const relay = process.env.BGSIM_RELAY || 'http://127.0.0.1:8790';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: Number(process.env.BGSIM_PORT || 5173),
    strictPort: true,
    proxy: {
      '/api': {
        target: engine,
        changeOrigin: false,
      },
      // Local art pack cache (engine/assets.py) — same origin as the engine.
      '/art': {
        target: engine,
        changeOrigin: false,
      },
      // Multiplayer relay (WebSocket). Only used in dev; a built app points at
      // the relay with ?relay=ws://host:8790/net.
      '/net': {
        target: relay,
        ws: true,
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    assetsInlineLimit: 0,
  },
});
