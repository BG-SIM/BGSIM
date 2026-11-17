// Starts the Python engine bridge.
//
// By default it uses the bundled interpreter in `engine/runtime` (that folder is
// not shipped in the source tree — see README "引擎运行时"). Point
// `BGSIM_PYTHON` at any Python 3.10+ interpreter that has taverngym installed
// to run straight from a checkout.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const win = process.platform === 'win32';
const bundled = join(root, 'engine', 'runtime', win ? 'python.exe' : 'bin/python3');
const python = process.env.BGSIM_PYTHON || bundled;
const server = join(root, 'engine', 'server.py');

if (!existsSync(python)) {
  console.error(`[bgsim] python interpreter not found: ${python}`);
  console.error('[bgsim] put the runtime in engine/runtime, or set BGSIM_PYTHON to a');
  console.error('[bgsim] Python 3.10+ that has taverngym installed (see README).');
  process.exit(1);
}

const args = [server, ...process.argv.slice(2)];
const child = spawn(python, args, {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
});

child.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => child.kill(sig));
}
