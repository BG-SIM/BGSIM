// Shared plumbing for the net tests: throwaway engine processes, free ports,
// and a tiny JSON client. Nothing here touches the player's live game (8787).
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PYTHON = process.env.BGSIM_PYTHON || join(ROOT, 'engine', 'runtime', process.platform === 'win32' ? 'python.exe' : 'bin/python3');

/** A port nobody is listening on right now. */
export async function freePort() {
  return new Promise((ok, fail) => {
    const srv = createServer();
    srv.once('error', fail);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => ok(port));
    });
  });
}

export async function get(port, path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${path}: ${text.slice(0, 300)}`);
  }
  if (!res.ok) throw new Error(`${path}: ${data?.error ?? res.status}`);
  return data;
}

export async function post(port, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${path}: ${text.slice(0, 300)}`);
  }
  if (!res.ok) throw new Error(`${path}: ${data?.error ?? res.status}`);
  return data;
}

/** An engine on its own port, with its own throwaway data dir. */
export async function startEngine(port, { quiet = true } = {}) {
  const data = mkdtempSync(join(tmpdir(), 'bgsim-test-'));
  const proc = spawn(PYTHON, [join(ROOT, 'engine', 'server.py'), '--port', String(port)], {
    cwd: ROOT,
    stdio: quiet ? 'ignore' : 'inherit',
    env: { ...process.env, BGSIM_DATA: data, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
  });
  let exited = null;
  proc.on('exit', (code) => {
    exited = code;
  });
  const until = Date.now() + 30000;
  for (;;) {
    if (exited !== null) throw new Error(`engine on ${port} exited with ${exited}`);
    try {
      const health = await get(port, '/api/health');
      if (health.ok) return { port, proc, data, stop: () => stop(proc) };
    } catch {
      /* not up yet */
    }
    if (Date.now() > until) {
      stop(proc);
      throw new Error(`engine on ${port} did not start`);
    }
    await sleep(120);
  }
}

function stop(proc) {
  try {
    proc.kill();
    // On Windows, exiting while the killed child's pipes are still closing can
    // trip a libuv assertion in the parent; unref lets it die quietly.
    proc.unref();
  } catch {
    /* already gone */
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Exit after a beat. On Windows, `process.exit()` while a just-killed child's
 * handle is still closing trips a libuv assertion ("!(handle->flags &
 * UV_HANDLE_CLOSING)"), which turns a clean report into a scary crash dump.
 */
export function exitWith(code) {
  setTimeout(() => process.exit(code), 40);
}

/** Colored-ish pass/fail lines so a long run stays readable. */
export function report(ok, label, detail = '') {
  const mark = ok ? '[ OK ]' : '[FAIL]';
  console.log(`${mark} ${label}${detail ? `  ${detail}` : ''}`);
  return ok;
}

export class Fatal extends Error {}

export function assert(cond, label, detail = '') {
  if (!report(Boolean(cond), label, detail)) throw new Fatal(label);
}

/** Like `assert`, but silent on success — for the tight inner loop. */
export function verify(cond, label, detail = '') {
  if (cond) return true;
  report(false, label, detail);
  throw new Fatal(label);
}
