import type { CardRef, CombatMinion, Minion } from '../types';

export const CDN = 'https://art.hearthstonejson.com';

/**
 * When the local art pack is on, art comes from our own `/art/<kind>/<id>` route
 * (server cache, downloaded once) instead of the CDN — that is what makes the
 * game work offline. `setLocalArt` is fed from `/api/assets`.
 */
let localArt = false;

export function setLocalArt(on: boolean): void {
  localArt = on;
}

export function localArtEnabled(): boolean {
  return localArt;
}

export const art = {
  portrait: (id: string) => (localArt ? `/art/portrait/${id}` : `${CDN}/v1/256x/${encodeURIComponent(id)}.jpg`),
  render: (id: string) => (localArt ? `/art/render/${id}` : `${CDN}/v1/bgs/latest/zhCN/512x/${encodeURIComponent(id)}.png`),
  renderGold: (id: string) => (localArt ? `/art/render/${id}` : `${CDN}/v1/render/latest/zhCN/512x/${encodeURIComponent(id)}.png`),
  hero: (id: string) => (localArt ? `/art/hero/${id}` : `${CDN}/v1/heroes/latest/256x/${encodeURIComponent(id)}.png`),
  /** Square card-art crop of a hero, no arch frame (the CDN's 512px jpg). */
  heroSquare: (id: string) => (localArt ? `/art/heroSq/${id}` : `${CDN}/v1/256x/${encodeURIComponent(id)}.jpg`),
};

export const RACE_CN: Record<string, string> = {
  DEMON: '恶魔',
  DRAGON: '龙',
  ELEMENTAL: '元素',
  MECHANICAL: '机械',
  MURLOC: '鱼人',
  NAGA: '纳迦',
  PIRATE: '海盗',
  QUILBOAR: '野猪人',
  UNDEAD: '亡灵',
  BEAST: '野兽',
  ALL: '全部',
  ABERRATION: '畸变',
  PET: '宠物',
  LOCUST: '虫群',
};

const TRIBE_ICON: Record<string, string> = {
  DEMON: 'demon',
  DRAGON: 'dragon',
  ELEMENTAL: 'elemental',
  MECHANICAL: 'mech',
  MURLOC: 'murloc',
  NAGA: 'naga',
  PIRATE: 'pirate',
  QUILBOAR: 'quilboar',
  UNDEAD: 'undead',
  BEAST: 'beast',
  ABERRATION: 'aberration',
  PET: 'pet',
  ALL: 'other',
};

/** Icon files that actually ship in public/img/tribes. */
const TRIBE_FILES = new Set([
  'demon', 'dragon', 'elemental', 'mech', 'murloc', 'naga', 'pirate',
  'quilboar', 'undead', 'beast', 'aberration', 'pet', 'buddy', 'other',
]);

export function tribeIcon(race: string): string {
  const name = TRIBE_ICON[race] ?? 'other';
  // Never point at a file that does not exist — a missing icon used to render
  // as a broken image instead of falling back.
  return `/img/tribes/${TRIBE_FILES.has(name) ? name : 'other'}.jpg`;
}

export function tierIcon(tier: number): string {
  const t = Math.max(1, Math.min(7, tier || 1));
  return `/img/tiers/tier-${t}.png`;
}

export const KEYWORD_CN: Record<string, string> = {
  TAUNT: '嘲讽',
  DIVINE_SHIELD: '圣盾',
  POISONOUS: '剧毒',
  VENOMOUS: '烈毒',
  WINDFURY: '风怒',
  MEGA_WINDFURY: '超级风怒',
  REBORN: '复生',
  DEATHRATTLE: '亡语',
  BATTLECRY: '战吼',
  AURA: '光环',
  SPELLCRAFT: '塑造法术',
  AVENGE: '复仇',
  MAGNETIC: '磁力',
  RALLY: '发动',
  ACTIVATE: '发动',
  STEALTH: '潜行',
  ELUSIVE: '无法成为目标',
};

export function keywordLabel(kw: string): string {
  return KEYWORD_CN[kw] ?? kw;
}

export function hasKw(m: { kw?: string[]; keywords?: string[] }, kw: string): boolean {
  return (m.kw ?? m.keywords ?? []).includes(kw);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function cardName(c: any): string {
  if (!c) return '';
  return c.nameZh || c.name || '';
}

export function textOf(c: CardRef | Minion | { textZh?: string } | null | undefined): string {
  if (!c) return '';
  return (c as { textZh?: string }).textZh || '';
}

/** Split Hearthstone markup into plain segments and bold keywords. */
export function richText(raw: string): { text: string; bold: boolean }[] {
  if (!raw) return [];
  const cleaned = raw
    .replace(/<i>/g, '')
    .replace(/<\/i>/g, '')
    .replace(/<color=[^>]*>/g, '')
    .replace(/<\/color>/g, '')
    .replace(/<br\/?>/g, '\n')
    .replace(/\[x\]/g, '');
  const out: { text: string; bold: boolean }[] = [];
  const re = /<b>(.*?)<\/b>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned))) {
    if (m.index > last) out.push({ text: cleaned.slice(last, m.index), bold: false });
    out.push({ text: m[1], bold: true });
    last = m.index + m[0].length;
  }
  if (last < cleaned.length) out.push({ text: cleaned.slice(last), bold: false });
  return out;
}

export function plainText(raw: string): string {
  return (raw || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

export function shortText(raw: string, max = 90): string {
  const plain = raw.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  return plain.length > max ? `${plain.slice(0, max)}…` : plain;
}

export function num(v: number | null | undefined): string {
  return v === null || v === undefined ? '' : String(v);
}

export function isCombatMinion(m: CombatMinion | Minion): m is CombatMinion {
  return (m as Minion).eid !== undefined;
}
