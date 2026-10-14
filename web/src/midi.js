// Standard MIDI file -> TTR notes. Pitches 60/61, 62/63, 64/65 are the left, centre and right lane.
const LANE_OF_PITCH = { 60: 0, 61: 0, 62: 1, 63: 1, 64: 2, 65: 2 };
export const HOLD_MIN_MS = 450;

function vlq(d, i) { let v = 0; for (;;) { const b = d[i++]; v = v * 128 + (b & 0x7F); if (!(b & 0x80)) return [v, i]; } }

export function parseMidi(d) {
  if (String.fromCharCode(d[0], d[1], d[2], d[3]) !== 'MThd') throw new Error('not a MIDI file');
  const u16 = (i) => (d[i] << 8) | d[i + 1], u32 = (i) => ((d[i] << 24) | (d[i + 1] << 16) | (d[i + 2] << 8) | d[i + 3]) >>> 0;
  const ntracks = u16(10), division = u16(12);
  let i = 14; const events = [];
  for (let tr = 0; tr < ntracks; tr++) {
    const end = i + 8 + u32(i + 4); i += 8;
    let t = 0, run = 0;
    while (i < end) {
      let dt; [dt, i] = vlq(d, i); t += dt;
      const s = d[i];
      if (s === 0xFF) {
        const typ = d[i + 1]; const [l, j] = vlq(d, i + 2);
        if (typ === 0x51) { let us = 0; for (let k = 0; k < l; k++) us = us * 256 + d[j + k]; events.push({ t, kind: 'tempo', a: us }); }
        i = j + l;
      } else if (s === 0xF0 || s === 0xF7) { const [l, j] = vlq(d, i + 1); i = j + l; }
      else {
        if (s & 0x80) { run = s; i++; }
        const k = run & 0xF0;
        if (k === 0xC0 || k === 0xD0) i += 1;
        else {
          const a = d[i], b = d[i + 1]; i += 2;
          if (k === 0x90 && b > 0) events.push({ t, kind: 'on', a });
          else if (k === 0x80 || (k === 0x90 && b === 0)) events.push({ t, kind: 'off', a });
        }
      }
    }
  }
  events.sort((x, y) => x.t - y.t);
  return { division, events };
}

export function midiToNotes(d) {
  const { division, events } = parseMidi(d);
  const tempos = events.filter((e) => e.kind === 'tempo').map((e) => [e.t, e.a]).sort((a, b) => a[0] - b[0]);
  if (!tempos.length || tempos[0][0] > 0) tempos.unshift([0, 500000]);
  const ms = (tick) => {
    let total = 0, lastT = 0, lastUs = tempos[0][1];
    for (let k = 1; k < tempos.length; k++) {
      const [t, us] = tempos[k];
      if (t >= tick) break;
      total += (t - lastT) * lastUs / division / 1000; lastT = t; lastUs = us;
    }
    return total + (tick - lastT) * lastUs / division / 1000;
  };
  const open = new Map(), notes = [];
  for (const e of events) {
    if (!(e.a in LANE_OF_PITCH)) continue;
    if (e.kind === 'on') open.set(e.a, e.t);
    else if (e.kind === 'off' && open.has(e.a)) {
      const start = ms(open.get(e.a)); open.delete(e.a);
      const dur = ms(e.t) - start;
      notes.push({ timeMs: Math.round(start), lane: LANE_OF_PITCH[e.a], durMs: dur >= HOLD_MIN_MS ? Math.round(dur) : 0 });
    }
  }
  return notes.sort((a, b) => a.timeMs - b.timeMs || a.lane - b.lane);
}
