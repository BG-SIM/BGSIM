// Resolves a Chromium/Chrome executable for the Playwright scripts.
//
// Order: BGSIM_CHROME env -> a locally installed Chrome/Edge -> Playwright's
// browser cache. Returns undefined when nothing is found, which lets
// playwright-core fall back to its own resolution.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const isWin = process.platform === 'win32';

export function chromePath() {
  const env = process.env.BGSIM_CHROME;
  if (env && existsSync(env)) return env;

  const candidates = isWin
    ? [
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
      ]
    : [
        '/usr/bin/google-chrome',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      ];
  for (const p of candidates) if (existsSync(p)) return p;

  // Playwright's cache: %LOCALAPPDATA%/ms-playwright/chromium-<rev>/chrome-win64/chrome.exe
  const local = process.env.LOCALAPPDATA || process.env.HOME || '';
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    local ? join(local, 'ms-playwright') : '',
    local ? join(local, '.cache', 'ms-playwright') : '',
  ].filter(Boolean);
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const dir of readdirSync(root)) {
      if (!dir.startsWith('chromium-')) continue;
      const exe = isWin
        ? join(root, dir, 'chrome-win64', 'chrome.exe')
        : join(root, dir, 'chrome-linux', 'chrome');
      if (existsSync(exe)) return exe;
    }
  }
  return undefined;
}
