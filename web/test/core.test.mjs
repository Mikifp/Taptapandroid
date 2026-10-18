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

import { laneMap, midiToNotes } from '../src/midi.js';
import { parseXmlPlist } from '../src/plist.js';

test('hold state is per note, not per lane (back-to-back holds)', () => {
  const a = n(1000, 1, 1000), b = n(2000, 1, 1000), c = n(4000, 1, 500);
  const j = new Judge([a, b, c]);
  assert.deepEqual([a, b, c].map((x) => j.noteState(x)), ['pending', 'pending', 'pending']);
  j.onPress(1, 1000);
  assert.deepEqual([a, b, c].map((x) => j.noteState(x)), ['holding', 'pending', 'pending']); // b is NOT held
  assert.equal(j.onRelease(1, 2000), null); j.update(2000);
  assert.equal(j.noteState(a), 'hit');
  j.onPress(1, 2010); // re-press straight away for the next hold
  assert.deepEqual([a, b, c].map((x) => j.noteState(x)), ['hit', 'holding', 'pending']);
  j.onRelease(1, 2400); // lifted early
  assert.equal(j.noteState(b), 'broken');
  j.update(4000 + 171);
  assert.equal(j.noteState(c), 'missed');
});

test('a note being held cannot be pressed again', () => {
  const j = new Judge([n(1000, 0, 1000)]);
  assert.ok(j.onPress(0, 1000)); assert.equal(j.onPress(0, 1010), null);
});

test('lane maps per column count', () => {
  assert.deepEqual(laneMap(3), { 60: 0, 61: 0, 62: 1, 65: 1, 63: 2, 64: 2 });
  assert.deepEqual(laneMap(4), { 60: 0, 61: 1, 62: 2, 63: 3 });
  assert.deepEqual(laneMap(5), { 60: 0, 61: 1, 62: 2, 63: 3, 64: 4 });
});

function midi(events, div = 480, tempoUs = 500000) { // events: [tick, pitch, on?]
  const bytes = [0, 0xFF, 0x51, 3, (tempoUs >> 16) & 255, (tempoUs >> 8) & 255, tempoUs & 255];
  let last = 0;
  for (const [tick, pitch, on] of events) {
    let d = tick - last; last = tick; const v = [d & 127]; d >>= 7; while (d) { v.unshift((d & 127) | 128); d >>= 7; }
    bytes.push(...v, 0x90, pitch, on ? 100 : 0);
  }
  bytes.push(0, 0xFF, 0x2F, 0);
  const len = bytes.length;
  return Uint8Array.from([0x4D, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, div >> 8, div & 255, 0x4D, 0x54, 0x72, 0x6B, 0, 0, len >> 8, len & 255, ...bytes]);
}

test('midiToNotes: lanes by column count, hold threshold, tempo', () => {
  // 480 ticks/beat at 500000us = 500ms/beat. Tap 0.25 beat, hold 4 beats.
  const d = midi([[0, 60, 1], [120, 60, 0], [480, 63, 1], [600, 63, 0], [960, 64, 1], [960 + 1920, 64, 0]]);
  assert.deepEqual(midiToNotes(d, 3), [{ timeMs: 0, lane: 0, durMs: 0 }, { timeMs: 500, lane: 2, durMs: 0 }, { timeMs: 1000, lane: 2, durMs: 2000 }]);
  assert.deepEqual(midiToNotes(d, 4).map((x) => x.lane), [0, 3]); // 64 does not exist in 4 columns
  assert.deepEqual(midiToNotes(d, 5).map((x) => x.lane), [0, 3, 4]);
  assert.equal(midiToNotes(d, 3, 3000)[2].durMs, 0); // threshold override
});

test('XML plist parser handles nested dicts, arrays, booleans, entities', () => {
  const x = `<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "x"><plist version="1.0"><dict>
    <key>title</key><string>Rock &amp; Roll</string><key>dur</key><real>12.5</real><key>n</key><integer>7</integer>
    <key>ok</key><true/><key>no</key><false/><key>empty</key><string></string>
    <key>columnCountPerLevel</key><dict><key>1</key><integer>3</integer><key>4</key><integer>5</integer></dict>
    <key>levels</key><array><integer>1</integer><integer>2</integer></array><key>none</key><array/></dict></plist>`;
  assert.deepEqual(parseXmlPlist(x), { title: 'Rock & Roll', dur: 12.5, n: 7, ok: true, no: false, empty: '', columnCountPerLevel: { 1: 3, 4: 5 }, levels: [1, 2], none: [] });
});

import { tiffToPng, toWebImage } from '../src/image.js';
import { inflateSync } from 'node:zlib';

test('TIFF artwork converts to a valid PNG with the same pixels', () => {
  const w = 3, h = 2, px = [255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255];
  const hdr = [0x4D, 0x4D, 0, 42, 0, 0, 0, 8 + px.length];
  const e = (tag, type, count, val) => [tag >> 8, tag & 255, 0, type, 0, 0, 0, count, ...(type === 3 ? [val >> 8, val & 255, 0, 0] : [val >> 24, (val >> 16) & 255, (val >> 8) & 255, val & 255])];
  const entries = [e(256, 3, 1, w), e(257, 3, 1, h), e(258, 3, 1, 8), e(259, 3, 1, 1), e(262, 3, 1, 2), e(273, 4, 1, 8), e(277, 3, 1, 4), e(278, 3, 1, h), e(279, 4, 1, px.length)];
  const tiff = Uint8Array.from([...hdr.slice(0, 4), 0, 0, 0, 8, ...px, ...[0, entries.length], ...entries.flat(), 0, 0, 0, 0]);
  new DataView(tiff.buffer).setUint32(4, 8 + px.length); // IFD sits after the pixel data
  const png = tiffToPng(Uint8Array.from(tiff));
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  // find IDAT and inflate
  let o = 8, idat = null;
  while (o < png.length) { const len = new DataView(png.buffer, png.byteOffset).getUint32(o); const type = String.fromCharCode(...png.subarray(o + 4, o + 8)); if (type === 'IDAT') idat = png.subarray(o + 8, o + 8 + len); o += 12 + len; }
  const rows = inflateSync(Buffer.from(idat));
  assert.equal(rows.length, (w * 4 + 1) * h);
  assert.deepEqual([...rows.subarray(1, 1 + w * 4)], px.slice(0, w * 4));
  assert.deepEqual([...rows.subarray(2 + w * 4)], px.slice(w * 4));
  assert.equal(toWebImage(png), png); // PNG passes through untouched
});
