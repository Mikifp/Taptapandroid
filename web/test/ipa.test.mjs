import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { delimiter } from 'node:path';
import { readIpa } from '../src/ipa.js';

// TTR_IPAS: IPA paths separated by ":" (";" on Windows). TTR_CONVERTED: assets/tracks written by tools/ipa_to_assets.py.
const IPAS = (process.env.TTR_IPAS || process.env.TTR_IPA || '').split(delimiter).filter((p) => p && existsSync(p));
const CONVERTED = process.env.TTR_CONVERTED;

test('reads tracks from real IPAs and matches the Python converter', { skip: !IPAS.length }, async () => {
  let tracks = 0, fiveLane = 0;
  for (const path of IPAS) {
    const { songs } = await readIpa(new Blob([readFileSync(path)]));
    assert.ok(songs.length >= 1, path);
    for (const s of songs) {
      tracks++;
      assert.ok(s.audio.length > 100000, 'audio bytes');
      assert.equal(String.fromCharCode(...s.audio.subarray(4, 8)), 'ftyp');
      assert.deepEqual(Object.keys(s.meta.levels).sort(), ['1', '2', '3', '4']);
      assert.ok(s.background && s.background.length > 1000, 'theme background');
      for (const lvl of Object.keys(s.meta.levels)) {
        const maxLane = Math.max(...s.meta.levels[lvl].map((n) => n.lane));
        assert.ok(maxLane < s.meta.lanes[lvl], `${s.meta.title} L${lvl} lane ${maxLane} within ${s.meta.lanes[lvl]}`);
        if (s.meta.lanes[lvl] === 5) fiveLane++;
      }
      if (!CONVERTED) continue;
      const ref = JSON.parse(readFileSync(`${CONVERTED}/${s.meta.id}/track.json`, 'utf8'));
      assert.equal(s.meta.title, ref.title); assert.equal(s.meta.artist, ref.artist);
      assert.equal(s.meta.durationMs, ref.durationMs);
      assert.deepEqual(s.meta.lanes, ref.lanes);
      for (const [lvl, notes] of Object.entries(ref.levels)) {
        const mine = s.meta.levels[lvl];
        assert.equal(mine.length, notes.length, `${s.meta.title} L${lvl} count`);
        notes.forEach(([t, lane, dur], i) => {
          assert.ok(Math.abs(mine[i].timeMs - t) <= 1 && mine[i].lane === lane && Math.abs(mine[i].durMs - dur) <= 1, `${s.meta.title} L${lvl} note ${i}`);
        });
      }
    }
  }
  console.log(`checked ${tracks} tracks from ${IPAS.length} IPAs (${fiveLane} five-lane levels)`);
});

test('rejects non-ipa input', async () => {
  await assert.rejects(readIpa(new Blob([new Uint8Array(100)])), /zip|IPA/i);
});
