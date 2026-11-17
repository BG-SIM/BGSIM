// One-command dev launch: engine bridge on :8787 + Vite dev server on :5173
// (+ the multiplayer relay on :8790, which the Vite dev server proxies /net to).
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const win = process.platform === 'win32';
const npm = win ? 'npm.cmd' : 'npm';

const engine = spawn(process.execPath, [join(root, 'scripts', 'server.mjs')], {
  cwd: root,
  stdio: 'inherit',
});
const viteBin = join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const vite = spawn(process.execPath, [viteBin], { cwd: root, stdio: 'inherit' });
// The relay is local-only and disposable: losing it does not disturb a single
// player game, so it never takes the launcher down with it.
const relay = spawn(process.execPath, [join(root, 'server', 'relay.mjs')], {
  cwd: root,
  stdio: 'inherit',
});

const url = 'http://127.0.0.1:5173';
setTimeout(() => {
  const open = win ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = win ? ['/c', 'start', '', url] : [url];
  spawn(open, args, { stdio: 'ignore', detached: true }).unref();
}, 2200);

const stop = () => {
  try { vite.kill(); } catch {}
  try { engine.kill(); } catch {}
  try { relay.kill(); } catch {}
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
vite.on('exit', stop);
engine.on('exit', stop);
