// Tiny synthesised sound effects (no audio assets, no network).
type Kind =
  | 'click'
  | 'pickup'
  | 'place'
  | 'invalid'
  | 'buy'
  | 'sell'
  | 'roll'
  | 'upgrade'
  | 'attack'
  | 'hit'
  | 'win'
  | 'lose'
  | 'discover';

let ctx: AudioContext | null = null;
let enabled = true;
try {
  enabled = localStorage.getItem('bgsim.sfx') !== '0';
} catch {
  /* ignore */
}

export function setSfxEnabled(on: boolean) {
  enabled = on;
  try {
    localStorage.setItem('bgsim.sfx', on ? '1' : '0');
  } catch {
    /* ignore */
  }
}

export function sfxEnabled(): boolean {
  try {
    return localStorage.getItem('bgsim.sfx') !== '0';
  } catch {
    return true;
  }
}

function audio(): AudioContext | null {
  if (!enabled) return null;
  if (!ctx) {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

function tone(freq: number, dur: number, type: OscillatorType, gain = 0.05, slide = 0, delay = 0) {
  const ac = audio();
  if (!ac) return;
  const t0 = ac.currentTime + delay;
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

function noise(dur: number, gain = 0.05, delay = 0) {
  const ac = audio();
  if (!ac) return;
  const t0 = ac.currentTime + delay;
  const len = Math.floor(ac.sampleRate * dur);
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
  const src = ac.createBufferSource();
  const g = ac.createGain();
  const filter = ac.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 1400;
  src.buffer = buf;
  g.gain.value = gain;
  src.connect(filter).connect(g).connect(ac.destination);
  src.start(t0);
}

export function sfx(kind: Kind) {
  if (!enabled) return;
  switch (kind) {
    case 'click':
      tone(520, 0.05, 'triangle', 0.03);
      break;
    case 'pickup':
      // Short, soft "lift": fires on pointer-down so the card feels grabbed at once.
      tone(420, 0.045, 'sine', 0.028, 120);
      break;
    case 'place':
      // Wooden tap when a card lands.
      noise(0.05, 0.022);
      tone(196, 0.06, 'triangle', 0.03, -40);
      break;
    case 'invalid':
      tone(150, 0.09, 'square', 0.025, -30);
      break;
    case 'buy':
      tone(880, 0.07, 'triangle', 0.045);
      tone(1320, 0.08, 'triangle', 0.03, 0, 0.06);
      break;
    case 'sell':
      tone(220, 0.12, 'sawtooth', 0.035, -80);
      break;
    case 'roll':
      noise(0.12, 0.03);
      tone(340, 0.06, 'square', 0.02);
      break;
    case 'upgrade':
      tone(523, 0.1, 'triangle', 0.04);
      tone(659, 0.1, 'triangle', 0.04, 0, 0.08);
      tone(784, 0.16, 'triangle', 0.04, 0, 0.16);
      break;
    case 'attack':
      noise(0.1, 0.05);
      tone(160, 0.1, 'sawtooth', 0.03, -60);
      break;
    case 'hit':
      noise(0.08, 0.035);
      break;
    case 'discover':
      tone(660, 0.09, 'sine', 0.04);
      tone(990, 0.12, 'sine', 0.035, 0, 0.07);
      break;
    case 'win':
      [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.18, 'triangle', 0.045, 0, i * 0.11));
      break;
    case 'lose':
      [392, 330, 262].forEach((f, i) => tone(f, 0.22, 'triangle', 0.045, 0, i * 0.14));
      break;
  }
}
