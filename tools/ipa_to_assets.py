#!/usr/bin/env python3
"""Convert the tracks and theme art of a Tap Tap Revenge 3 .ipa into app assets.

    python3 tools/ipa_to_assets.py path/to/game.ipa [--out app/src/main/assets]

Reads (never modifies) the IPA and writes, per bundled track:
    tracks/<id>/track.json    note charts decoded from the NSKeyedArchiver/MIDI .ttr2_track
    tracks/<id>/audio.m4a     copied as-is
    tracks/<id>/artwork.png   copied as-is
    tracks/index.json         list of track ids
    theme/background.jpg      DJ theme backdrop (if present)
The output folder is git-ignored: those files are the original game's copyrighted
content and must not be committed or redistributed.
"""
import argparse, json, plistlib, struct, sys, zipfile
from plistlib import UID

LANE_OF_PITCH = {60: 0, 61: 0, 62: 1, 63: 1, 64: 2, 65: 2}
HOLD_MIN_MS = 450


def unarchive(data):
    p = plistlib.loads(data)
    objs = p['$objects']

    def dec(v):
        if isinstance(v, UID):
            return dec(objs[v.data])
        if isinstance(v, dict) and '$class' in v:
            if 'NS.keys' in v:
                return {dec(k): dec(x) for k, x in zip(v['NS.keys'], v['NS.objects'])}
            if 'NS.objects' in v:
                return [dec(x) for x in v['NS.objects']]
            if 'NS.data' in v:
                return v['NS.data']
            return {k: dec(x) for k, x in v.items() if k != '$class'}
        return v

    return dec(p['$top']['root'])


def vlq(d, i):
    v = 0
    while True:
        b = d[i]
        i += 1
        v = (v << 7) | (b & 0x7F)
        if not b & 0x80:
            return v, i


def parse_midi(d):
    """Return (division, [(tick, kind, a, b)]) merged over all tracks. kind: 'on','off','tempo'."""
    if d[:4] != b'MThd':
        raise ValueError('not a MIDI file')
    _, ntracks, div = struct.unpack('>HHH', d[8:14])
    i, out = 14, []
    for _ in range(ntracks):
        ln = struct.unpack('>I', d[i + 4:i + 8])[0]
        i += 8
        end, t, run = i + ln, 0, 0
        while i < end:
            dt, i = vlq(d, i)
            t += dt
            s = d[i]
            if s == 0xFF:
                typ = d[i + 1]
                l, j = vlq(d, i + 2)
                if typ == 0x51:
                    out.append((t, 'tempo', int.from_bytes(d[j:j + l], 'big'), 0))
                i = j + l
            elif s in (0xF0, 0xF7):
                l, j = vlq(d, i + 1)
                i = j + l
            else:
                if s & 0x80:
                    run = s
                    i += 1
                k = run & 0xF0
                if k in (0xC0, 0xD0):
                    i += 1
                else:
                    a, b = d[i], d[i + 1]
                    i += 2
                    if k == 0x90 and b > 0:
                        out.append((t, 'on', a, b))
                    elif k == 0x80 or (k == 0x90 and b == 0):
                        out.append((t, 'off', a, 0))
    out.sort(key=lambda e: e[0])
    return div, out


def midi_to_notes(d):
    div, events = parse_midi(d)
    tempos = sorted((t, a) for t, k, a, _ in events if k == 'tempo')
    if not tempos or tempos[0][0] > 0:
        tempos.insert(0, (0, 500000))

    def ms(tick):
        total, last_t, last_us = 0.0, 0, tempos[0][1]
        for t, us in tempos[1:]:
            if t >= tick:
                break
            total += (t - last_t) * last_us / div / 1000.0
            last_t, last_us = t, us
        return total + (tick - last_t) * last_us / div / 1000.0

    open_notes, notes = {}, []
    for t, k, a, _ in events:
        if a not in LANE_OF_PITCH:
            continue
        if k == 'on':
            open_notes[a] = t
        elif k == 'off' and a in open_notes:
            start = ms(open_notes.pop(a))
            dur = ms(t) - start
            notes.append([round(start), LANE_OF_PITCH[a], round(dur) if dur >= HOLD_MIN_MS else 0])
    notes.sort()
    return notes


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('ipa')
    ap.add_argument('--out', default='app/src/main/assets')
    a = ap.parse_args()
    import os
    z = zipfile.ZipFile(a.ipa)
    names = z.namelist()
    app = next(n for n in names if n.endswith('.app/Info.plist')).rsplit('/', 1)[0] + '/'
    ids = sorted({n[len(app):].split('/')[1].removesuffix('.track')
                  for n in names if n.startswith(app + 'Tracks/') and n.endswith('.track/info.plist')})
    index = []
    for tid in ids:
        base = f'{app}Tracks/{tid}.track/'
        info = plistlib.loads(z.read(base + 'info.plist'))
        charts = unarchive(z.read(base + 'taptrack.ttr2_track'))
        levels = {}
        for lvl, c in charts.items():
            levels[str(lvl)] = midi_to_notes(c['rawData'])
        track = {
            'id': tid,
            'title': info.get('kTTRDownloadableItemTitleKey', tid),
            'artist': info.get('kTTRDownloadableItemSubtitleKey', ''),
            'durationMs': round(info.get('audioFileDuration', 0) * 1000),
            'audio': 'audio.m4a', 'artwork': 'artwork.png',
            'levels': levels,
        }
        d = os.path.join(a.out, 'tracks', tid)
        os.makedirs(d, exist_ok=True)
        json.dump(track, open(os.path.join(d, 'track.json'), 'w'), separators=(',', ':'))
        for f in ('audio.m4a', 'artwork.png'):
            open(os.path.join(d, f), 'wb').write(z.read(base + f))
        index.append(tid)
        print(f"{track['title']!r} by {track['artist']!r}: " +
              ', '.join(f'L{k}={len(v)}' for k, v in sorted(levels.items())))
    json.dump(index, open(os.path.join(a.out, 'tracks', 'index.json'), 'w'))
    bg = app + 'Themes/TTRDJ.ttrTheme/background.jpg'
    if bg in names:
        os.makedirs(os.path.join(a.out, 'theme'), exist_ok=True)
        open(os.path.join(a.out, 'theme', 'background.jpg'), 'wb').write(z.read(bg))
    print(f'wrote {len(index)} tracks to {a.out}')


if __name__ == '__main__':
    sys.exit(main())
