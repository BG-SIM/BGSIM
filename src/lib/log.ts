const COMBAT = /^\[t(\d+)\] combat p(\d+) vs (?:Some\((\d+)\)|None): winner (\d+) dmg (\d+)/;
const TURN = /^\[t(\d+)\] === turn (\d+) ===/;
const PAIR = /^\[t(\d+)\] pairings: (.*)$/;
const ACTION = /^\[t(\d+)\] p(\d+) (buys|sells|plays|gets|summons|discards|freezes|refreshes|upgrades|rerolls) (.+?)(?: for (\d+))?(?: at (\d+))?$/;
const ATTACK = /^\[t(\d+)\] p(\d+)'s (.+?) attacks (.+)$/;
const DIES = /^\[t(\d+)\] p(\d+)'s (.+?) dies/;
const HERO = /^\[t(\d+)\] p(\d+) (picks|gets Hero Power) (.+)$/;
const START = /^\[t(\d+)\] (?:p(\d+) )?(?:Start of Combat|Start of Turn): (.+)$/;

function who(seat: string): string {
  return seat === '0' ? '你' : `P${seat}`;
}

/** Translate one engine log line; null hides it. Only the human's lines and combats are kept. */
export function formatLog(line: string): string | null {
  let m = TURN.exec(line);
  if (m) return `第 ${m[2]} 回合开始`;
  m = PAIR.exec(line);
  if (m) return `配对：${m[2].replace(/p(\d+)-p(\d+)/g, 'P$1 vs P$2')}`;
  m = COMBAT.exec(line);
  if (m) {
    const a = m[2];
    const b = m[3] ?? '幽灵';
    const winner = m[4];
    const dmg = Number(m[5]);
    if (a !== '0' && b !== '0') return null;
    const mine = a === '0' ? '0' : b;
    const opp = a === '0' ? b : a;
    if (String(winner) === mine) return `对战 P${opp}：胜利${dmg ? `，造成 ${dmg} 点伤害` : ''}`;
    if (String(winner) === opp) return `对战 P${opp}：失败${dmg ? `，受到 ${dmg} 点伤害` : ''}`;
    return `对战 P${opp}：平局`;
  }
  m = HERO.exec(line);
  if (m && m[2] !== '0') return null;
  if (m) return `${who(m[2])} ${m[3] === 'picks' ? '选择英雄' : '获得英雄技能'} ${m[4]}`;
  m = ATTACK.exec(line);
  if (m) return m[2] === '0' ? `${m[3]} 攻击 ${m[4]}` : null;
  m = DIES.exec(line);
  if (m) return m[2] === '0' ? `${m[3]} 阵亡` : null;
  m = ACTION.exec(line);
  if (m) {
    if (m[2] !== '0') return null;
    const verb: Record<string, string> = {
      buys: '购买',
      sells: '出售',
      plays: '打出',
      gets: '获得',
      summons: '召唤',
      discards: '弃掉',
      freezes: '冻结',
      refreshes: '刷新',
      upgrades: '升级',
      rerolls: '重掷',
    };
    return `${verb[m[3]] ?? m[3]} ${m[4]}${m[5] ? `（${m[5]} 铸币）` : ''}`;
  }
  m = START.exec(line);
  if (m) return m[2] === '0' ? `触发：${m[4]}` : null;
  return null;
}

/** Combat-frame log line for the battle overlay (keeps both sides). */
export function formatCombatLog(line: string): string | null {
  let m = /^\[t(\d+)\] (?:p(\d+)'s )?(.+?) attacks (.+)$/.exec(line);
  if (m) return `${m[3]} 攻击 ${m[4]}`;
  m = /^\[t(\d+)\] p(\d+)'s (.+?) dies/.exec(line);
  if (m) return `${m[3]} 阵亡`;
  m = /^\[t(\d+)\] p(\d+) Start of Combat: (.+)$/.exec(line);
  if (m) return `战斗开始：${m[3]}`;
  m = /^\[t(\d+)\] p(\d+) summons (.+?)(?: at (\d+))?$/.exec(line);
  if (m) return `召唤 ${m[3]}`;
  m = /^\[t(\d+)\] p(\d+) gains (.+)$/.exec(line);
  if (m) return `获得 ${m[3]}`;
  return null;
}
