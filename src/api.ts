import type { AssetStatus, Catalog, GameView, NetHash, NetStateResponse, NetStepResponse, StateResponse } from './types';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(text.slice(0, 200) || `HTTP ${res.status}`);
  }
  if (!res.ok) {
    const msg = (data as { error?: string } | null)?.error;
    throw new Error(msg || `HTTP ${res.status}`);
  }
  return data as T;
}

export interface ActionResult extends StateResponse {
  ok?: boolean;
}

export const api = {
  catalog: () => request<Catalog>('/api/catalog'),
  state: () => request<StateResponse>('/api/state'),
  health: () => request<{ ok: boolean; engine: string; game: string; catalog: number; hasGame: boolean; hasNet: boolean }>('/api/health'),
  // ---- net play: this engine is one seat of the shared simulation ----------
  // `client` identifies *this page*: one engine process can hold several seats
  // (two tabs on one machine are two players), and without it they overwrite
  // each other's seat.
  /** Build (or rebuild, with `replay`) the local copy of the shared game. */
  netNew: (body: {
    client: string;
    seed: number;
    seat: number;
    config?: Record<string, unknown> | null;
    replay?: [number, number][];
    combats?: boolean;
  }) =>
    request<NetStateResponse>('/api/net/new', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    }),
  /** Apply a batch of relay-ordered actions (any seat). */
  netSteps: (client: string, steps: [number, number][]) =>
    request<NetStepResponse>('/api/net/steps', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ client, steps }),
    }),
  netState: (client: string, combats = false) =>
    request<NetStateResponse>(`/api/net/state?client=${encodeURIComponent(client)}&combats=${combats ? 1 : 0}`),
  netStatus: (client: string) => request<Omit<NetStepResponse, 'results' | 'mismatch'>>(`/api/net/status?client=${encodeURIComponent(client)}`),
  netHash: (client: string) => request<NetHash>(`/api/net/hash?client=${encodeURIComponent(client)}`),
  netBot: (client: string, seat: number) =>
    request<{ ok: boolean; action: number; turn?: number }>(`/api/net/bot?client=${encodeURIComponent(client)}&seat=${seat}`),
  newGame: (seed?: number, opts?: { hero?: string | null; races?: string[] }) =>
    request<StateResponse>('/api/new', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        seed: seed ?? null,
        hero: opts?.hero ?? null,
        races: opts?.races && opts.races.length > 0 ? opts.races : null,
      }),
    }),
  action: (action: number) =>
    request<ActionResult>('/api/action', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ action }),
    }),
  choose: (option: number) =>
    request<ActionResult>('/api/choose', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ option }),
    }),
  pickHero: (id: string) =>
    request<ActionResult>('/api/hero', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ id }),
    }),
  undo: () => request<StateResponse>('/api/undo', { method: 'POST', headers: JSON_HEADERS, body: '{}' }),
  finish: () => request<StateResponse>('/api/finish', { method: 'POST', headers: JSON_HEADERS, body: '{}' }),
  save: () => request<{ ok: boolean }>('/api/save', { method: 'POST', headers: JSON_HEADERS, body: '{}' }),
  load: () => request<StateResponse>('/api/load', { method: 'POST', headers: JSON_HEADERS, body: '{}' }),
  log: () => request<{ log: string[] }>('/api/log'),
  assets: () => request<AssetStatus>('/api/assets'),
  assetsDownload: (kinds?: string[]) =>
    request<{ ok: boolean; kinds?: string[]; already?: boolean; error?: string }>('/api/assets/download', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ kinds: kinds ?? null }),
    }),
  assetsClear: (kinds?: string[]) =>
    request<AssetStatus>('/api/assets/clear', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ kinds: kinds ?? null }),
    }),
  assetsEnabled: (enabled: boolean) =>
    request<AssetStatus>('/api/assets/enabled', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ enabled }) }),
  debug: (cmd: Record<string, unknown>) =>
    request<StateResponse>('/api/debug', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(cmd),
    }),
};

export type { GameView };
