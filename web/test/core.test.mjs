import test from 'node:test';
import assert from 'node:assert/strict';
import { Judge } from '../src/judge.js';
import * as demo from '../src/demo.js';

const n = (timeMs, lane, durMs = 0) => ({ timeMs, lane, durMs });

test('grades by timing window', () => {
  const j = new Judge([n(1000, 0), n(2000, 1), n(3000, 2)]);
  assert.equal(j.onPress(0, 1030).grade, 'PERFECT');
  assert.equal(j.onPress(1, 2090).grade, 'GREAT');
  assert.equal(j.onPress(2, 2850).grade, 'GOOD');
  assert.equal(j.onPress(2, 3000), null);
});

test('misses and streak multiplier', () => {
  const notes = Array.from({ length: 25 }, (_, i) => n(1000 + i * 500, 0));
  const j = new Judge(notes);
  notes.slice(0, 10).forEach((x) => j.onPress(0, x.timeMs));
  assert.equal(j.multiplier, 2);
  notes.slice(10, 20).forEach((x) => j.onPress(0, x.timeMs));
  assert.equal(j.multiplier, 3);
  const ev = j.update(notes[20].timeMs + 171);
  assert.deepEqual(ev.map((e) => e.grade), ['MISS']);
  assert.equal(j.streak, 0); assert.equal(j.bestStreak, 20); assert.equal(j.multiplier, 1);
});

test('wrong lane / too early does nothing', () => {
  const j = new Judge([n(1000, 1)]);
  assert.equal(j.onPress(0, 1000), null); assert.equal(j.onPress(1, 500), null);
});

test('hold pays out; early release breaks streak', () => {
  const j = new Judge([n(1000, 0, 1000), n(3000, 1, 1000)]);
  j.onPress(0, 1000); j.update(1500);
  assert.ok(j.score > 100 && j.isHolding(0));
  assert.equal(j.onRelease(0, 2000), null); j.update(2100);
  assert.ok(!j.isHolding(0)); assert.equal(j.streak, 1);
  j.onPress(1, 3000); j.update(3200);
  assert.equal(j.onRelease(1, 3300).grade, 'MISS'); assert.equal(j.streak, 0);
  assert.equal(j.update(10000).length, 0); assert.ok(j.resolvedAll);
});

test('accuracy and stars', () => {
  const j = new Judge([n(100, 0), n(200, 0)]);
  j.onPress(0, 100); j.onPress(0, 200);
  assert.equal(j.accuracy, 1); assert.equal(j.stars(), 5);
  const m = new Judge([n(1, 0)]); m.update(5000); assert.equal(m.stars(), 0);
});

test('demo charts valid, ordered, denser by level, deterministic', () => {
  const sizes = [1, 2, 3, 4].map((l) => demo.chart(l).length);
  for (let i = 1; i < 4; i++) assert.ok(sizes[i] > sizes[i - 1], sizes.join());
  for (const l of [1, 2, 3, 4]) {
    const c = demo.chart(l);
    assert.ok(c.every((x, i) => x.lane >= 0 && x.lane <= 2 && x.timeMs <= demo.durationMs && (i === 0 || c[i - 1].timeMs <= x.timeMs)));
  }
  assert.deepEqual(demo.chart(3), demo.chart(3));
  const s = demo.samples();
  assert.equal(s.length, Math.floor(demo.durationMs / 1000 * demo.SAMPLE_RATE));
  assert.ok(s.some((v) => v !== 0));
});
