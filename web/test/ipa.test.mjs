import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { readIpa } from '../src/ipa.js';

const IPA = process.env.TTR_IPA;
const CONVERTED = process.env.TTR_CONVERTED; // assets/tracks produced by tools/ipa_to_assets.py

test('reads tracks from a real IPA and matches the Python converter', { skip: !IPA || !existsSync(IPA) }, async () => {
  const file = new Blob([readFileSync(IPA)]);
  const { songs, background } = await readIpa(file);
  assert.equal(songs.length, 3);
  assert.ok(background && background.length > 1000);
  for (const s of songs) {
    assert.ok(s.audio.length > 100000, 'audio bytes');
    assert.equal(String.fromCharCode(...s.audio.subarray(4, 8)), 'ftyp');
    assert.deepEqual(Object.keys(s.meta.levels).sort(), ['1', '2', '3', '4']);
    if (CONVERTED) {
      const ref = JSON.parse(readFileSync(`${CONVERTED}/${s.meta.id}/track.json`, 'utf8'));
      assert.equal(s.meta.title, ref.title); assert.equal(s.meta.artist, ref.artist);
      assert.equal(s.meta.durationMs, ref.durationMs);
      for (const [lvl, notes] of Object.entries(ref.levels)) {
        const mine = s.meta.levels[lvl];
        assert.equal(mine.length, notes.length, `${s.meta.title} L${lvl} count`);
        notes.forEach(([t, lane, dur], i) => {
          assert.ok(Math.abs(mine[i].timeMs - t) <= 1 && mine[i].lane === lane && Math.abs(mine[i].durMs - dur) <= 1, `${s.meta.title} L${lvl} note ${i}`);
        });
      }
    }
  }
});

test('rejects non-ipa input', async () => {
  await assert.rejects(readIpa(new Blob([new Uint8Array(100)])), /zip|IPA/i);
});
