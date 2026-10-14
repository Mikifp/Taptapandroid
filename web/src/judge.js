// Scoring engine, a port of core/.../Judge.kt. Independent of rendering and audio.
export const GRADES = ['PERFECT', 'GREAT', 'GOOD', 'MISS'];
export const POINTS = { PERFECT: 100, GREAT: 75, GOOD: 50, MISS: 0 };

export const PERFECT_MS = 55, GREAT_MS = 110, GOOD_MS = 170;
export const STREAK_PER_MULT = 10, MAX_MULT = 4;
export const HOLD_TICK_MS = 100, HOLD_TICK_POINTS = 10, RELEASE_SLACK_MS = 120;

export class Judge {
  /** @param {{timeMs:number, lane:number, durMs:number}[]} notes */
  constructor(notes) {
    this.states = [...notes].sort((a, b) => a.timeMs - b.timeMs)
      .map((note) => ({ note, resolved: false, holding: false, lastTick: 0 }));
    this.score = 0; this.streak = 0; this.bestStreak = 0;
    this.counts = { PERFECT: 0, GREAT: 0, GOOD: 0, MISS: 0 };
  }

  get multiplier() { return Math.min(MAX_MULT, 1 + Math.floor(this.streak / STREAK_PER_MULT)); }
  get totalNotes() { return this.states.length; }
  get resolvedAll() { return this.states.every((s) => s.resolved); }

  /** Share of notes hit weighted by grade, 0..1. */
  get accuracy() {
    const done = GRADES.reduce((a, g) => a + this.counts[g], 0);
    if (!done) return 1;
    return GRADES.reduce((a, g) => a + this.counts[g] * POINTS[g], 0) / (done * 100);
  }

  onPress(lane, tMs) {
    let best = null, bd = Infinity;
    for (const s of this.states) {
      if (s.resolved || s.holding || s.note.lane !== lane) continue;
      const d = Math.abs(s.note.timeMs - tMs);
      if (d <= GOOD_MS && d < bd) { best = s; bd = d; }
    }
    if (!best) return null;
    const grade = bd <= PERFECT_MS ? 'PERFECT' : bd <= GREAT_MS ? 'GREAT' : 'GOOD';
    this.score += POINTS[grade] * this.multiplier;
    this.streak++; this.bestStreak = Math.max(this.bestStreak, this.streak);
    this.counts[grade]++;
    if (best.note.durMs > 0) { best.holding = true; best.lastTick = Math.max(tMs, best.note.timeMs); } else best.resolved = true;
    return { note: best.note, grade };
  }

  onRelease(lane, tMs) {
    const s = this.states.find((x) => x.holding && x.note.lane === lane);
    if (!s) return null;
    s.holding = false; s.resolved = true;
    if (tMs < s.note.timeMs + s.note.durMs - RELEASE_SLACK_MS) {
      this.streak = 0; this.counts.MISS++;
      return { note: s.note, grade: 'MISS' };
    }
    return null;
  }

  /** Resolves missed notes and pays out held notes. Returns the events produced. */
  update(tMs) {
    const out = [];
    for (const s of this.states) {
      if (s.resolved) continue;
      const end = s.note.timeMs + s.note.durMs;
      if (s.holding) {
        while (s.lastTick + HOLD_TICK_MS <= Math.min(tMs, end)) {
          s.lastTick += HOLD_TICK_MS; this.score += HOLD_TICK_POINTS * this.multiplier;
        }
        if (tMs >= end) { s.holding = false; s.resolved = true; }
      } else if (tMs - s.note.timeMs > GOOD_MS) {
        s.resolved = true; this.streak = 0; this.counts.MISS++;
        out.push({ note: s.note, grade: 'MISS' });
      }
    }
    return out;
  }

  isHolding(lane) { return this.states.some((s) => s.holding && s.note.lane === lane); }
  isResolved(note) { const s = this.states.find((x) => x.note === note); return s ? s.resolved : true; }

  stars() {
    const a = this.accuracy;
    return a >= 0.95 ? 5 : a >= 0.88 ? 4 : a >= 0.78 ? 3 : a >= 0.62 ? 2 : a >= 0.40 ? 1 : 0;
  }
}
