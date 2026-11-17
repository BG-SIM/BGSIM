// Editable table layout. The UI editor writes these boxes; the game renders them.
export type Box = { x: number; y: number; w: number; h: number };
export type Layout = Record<string, Box>;
export type CardScales = { shop: number; board: number; hand: number };
export type Gaps = { shop: number; board: number; hand: number };

export const DEFAULT_LAYOUT: Layout = {
  nameplate: { x: 0, y: 22, w: 230, h: 34 },
  playerPlate: { x: 0, y: 800, w: 268, h: 66 },
  corner: { x: 1446, y: 840, w: 148, h: 46 },
  races: { x: 1300, y: 14, w: 286, h: 68 },
  opponents: { x: 236, y: 148, w: 72, h: 616 },
  bartender: { x: 725, y: 90, w: 150, h: 180 },
  tier: { x: 703, y: 177, w: 61, h: 80 },
  shopButtons: { x: 890, y: 92, w: 196, h: 132 },
  giftButton: { x: 1278, y: 270, w: 50, h: 50 },
  shopRow: { x: 317, y: 258, w: 1015, h: 169 },
  boardRow: { x: 305, y: 430, w: 977, h: 140 },
  handRow: { x: 291, y: 726, w: 1008, h: 170 },
  playerHero: { x: 720, y: 585, w: 152, h: 180 },
  heroPower: { x: 890, y: 612, w: 96, h: 100 },
  gold: { x: 1003, y: 785, w: 226, h: 40 },
  upgrade: { x: 607, y: 132, w: 78, h: 128 },
  trinketGreater: { x: 585, y: 618, w: 78, h: 78 },
  trinketLesser: { x: 642, y: 686, w: 78, h: 78 },
  trinketRail: { x: 1367, y: 602, w: 156, h: 146 },
  endTurn: { x: 1186, y: 387, w: 140, h: 62 },
  targetPrompt: { x: 462, y: 21, w: 200, h: 36 },
};

export const DEFAULT_SCALES: CardScales = { shop: 0.78, board: 0.72, hand: 0.6 };
export const DEFAULT_GAPS: Gaps = { shop: -18.5, board: -18, hand: -96.5 };
export const DEFAULT_HAND_ARC = 7.5;

export const ELEMENT_NAMES: Record<string, string> = {
  nameplate: '对手名牌',
  playerPlate: '玩家名牌（左下）',
  corner: '图鉴 / 菜单（右下）',
  races: '本局种族（右上）',
  opponents: '对手列表',
  bartender: '鲍勃（酒馆老板）',
  tier: '酒馆等级',
  shopButtons: '刷新 / 冻结',
  giftButton: '黑暗之赐',
  shopRow: '酒馆随从区',
  boardRow: '我方战场',
  handRow: '手牌区',
  playerHero: '我方英雄',
  heroPower: '英雄技能',
  gold: '金币',
  upgrade: '升级酒馆',
  trinketGreater: '大饰品',
  trinketLesser: '小饰品',
  trinketRail: '任务 / 奖励栏',
  endTurn: '结束回合',
  targetPrompt: '目标提示',
};

export const LAYOUT_STORAGE_KEY = 'bgsim.layout.v5';
