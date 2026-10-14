// Original built-in song "Neon Pulse": synthesized loop plus charts generated from its melody.
export const BPM = 124, BARS = 32, SAMPLE_RATE = 22050, LEAD_IN_BEATS = 4;
const beatMs = 60000 / BPM;
const bassRoots = [45, 45, 41, 43];
const melody = [0, 3, 5, 3, 7, 5, 3, 0];
export const durationMs = Math.floor((LEAD_IN_BEATS + BARS * 4) * beatMs) + 2000;

function rng(seed) { // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function chart(level) {
  const rnd = rng(1000 + level);
  const density = { 1: 0.55, 2: 0.75, 3: 0.9, 4: 1.0 }[level] ?? 1;
  const notes = [];
  let last = 1;
  for (let bar = 1; bar < BARS; bar++) {
    for (let e = 0; e < 8; e++) {
      if (level === 1 && e % 2 !== 0) continue;
      if (rnd() > density) continue;
      const timeMs = Math.floor((LEAD_IN_BEATS + bar * 4 + e * 0.5) * beatMs);
      const base = (melody[e] + bar) % 3;
      const lane = base === last && rnd() < 0.5 ? (base + 1) % 3 : base;
      last = lane;
      const hold = level >= 3 && e === 0 && bar % 4 === 3;
      notes.push({ timeMs, lane, durMs: hold ? Math.floor(beatMs * 1.5) : 0 });
      if (level === 4 && e % 4 === 2 && rnd() < 0.35) notes.push({ timeMs, lane: (lane + 1 + Math.floor(rnd() * 2)) % 3, durMs: 0 });
    }
  }
  return notes.sort((a, b) => a.timeMs - b.timeMs);
}

export function track() {
  return { id: 'demo', title: 'Neon Pulse', artist: 'Built-in demo', durationMs, levels: { 1: chart(1), 2: chart(2), 3: chart(3), 4: chart(4) } };
}

/** Renders the loop to mono float samples at SAMPLE_RATE. */
export function samples() {
  const total = Math.floor(durationMs / 1000 * SAMPLE_RATE);
  const mix = new Float32Array(total);
  const beat = beatMs / 1000;
  const scale = [0, 2, 3, 5, 7, 8, 10, 12];
  const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const rnd = rng(7);
  const add = (start, len, gain, f) => {
    const s0 = Math.floor(start * SAMPLE_RATE), n = Math.floor(len * SAMPLE_RATE);
    for (let i = 0; i < n; i++) { const k = s0 + i; if (k >= 0 && k < total) mix[k] += f(i / SAMPLE_RATE) * gain; }
  };
  const totalBeats = LEAD_IN_BEATS + BARS * 4;
  for (let b = 0; b < totalBeats; b++) {
    const t = b * beat;
    add(t, 0.18, 0.5, (x) => Math.sin(2 * Math.PI * (110 * Math.exp(-x * 30) + 45) * x) * Math.exp(-x * 14));
    add(t + beat / 2, 0.05, 0.12, () => rnd() * 2 - 1);
    if (b >= LEAD_IN_BEATS && (b - LEAD_IN_BEATS) % 2 === 1) add(t, 0.12, 0.2, (x) => (rnd() * 2 - 1) * Math.exp(-x * 25));
  }
  for (let bar = 0; bar < BARS; bar++) {
    const barStart = (LEAD_IN_BEATS + bar * 4) * beat;
    const root = bassRoots[bar % 4];
    for (let e = 0; e < 8; e++) {
      const ts = barStart + e * beat / 2;
      add(ts, beat / 2, 0.18, (x) => (2 * ((hz(root) * x) % 1) - 1) * Math.exp(-x * 4));
      if (bar >= 1) {
        const f = hz(57 + scale[melody[e] % scale.length] + (bar % 4 === 3 ? 2 : 0));
        add(ts, beat / 2, 0.14, (x) => (Math.sin(2 * Math.PI * f * x) > 0 ? 1 : -1) * Math.exp(-x * 6));
      }
    }
  }
  for (let i = 0; i < total; i++) mix[i] = Math.max(-1, Math.min(1, mix[i]));
  return mix;
}
