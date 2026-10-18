#!/usr/bin/env python3
"""Convert the tracks and theme art of a Tap Tap Revenge 3 .ipa into app assets.

    python3 tools/ipa_to_assets.py a.ipa [b.ipa ...] [--out app/src/main/assets]

Works with Tap Tap Revenge 3 and the artist apps built on it (Metallica, Linkin Park, ...).
Reads (never modifies) the IPAs and writes, per bundled track:
    tracks/<id>/track.json    note charts decoded from the NSKeyedArchiver/MIDI .ttr2_track
    tracks/<id>/audio.m4a     copied as-is
    tracks/<id>/artwork.png   copied as-is
    tracks/<id>/background.jpg  the track's theme backdrop (if present)
    tracks/index.json         list of track ids
    theme/background.jpg      fallback backdrop (if present)
The output folder is git-ignored: those files are the original game's copyrighted
content and must not be committed or redistributed.
"""
import argparse, json, plistlib, struct, sys, zipfile
from plistlib import UID

# MIDI pitch -> lane, by the number of columns of the level (info.plist columnCountPerLevel).
# From the themes' Lua: 3 columns claim 60/62/64, and the "shake" pitches 61/65/63 fall back to
# left/middle/right when shakes are disabled. 4 and 5 columns use consecutive pitches from 60.
DEFAULT_COLUMNS = 3
DEFAULT_HOLD_MIN_MS = 750  # theme.cfg may override with game.tapAndHoldThresholdDuration (seconds)


def lane_map(cols):
    if cols == 4:
        return {60: 0, 61: 1, 62: 2, 63: 3}
    if cols == 5:
        return {60: 0, 61: 1, 62: 2, 63: 3, 64: 4}
    return {60: 0, 61: 0, 62: 1, 65: 1, 63: 2, 64: 2}


def to_web_image(d):
    """PNG/JPEG pass through; an uncompressed baseline TIFF (some apps ship artwork that way) becomes PNG."""
    import zlib
    if not (d[:4] in (b'MM\x00*', b'II*\x00')):
        return d
    e = '>' if d[:2] == b'MM' else '<'
    ifd = struct.unpack(e + 'I', d[4:8])[0]
    tags = {}
    for i in range(struct.unpack(e + 'H', d[ifd:ifd + 2])[0]):
        tag, typ, cnt = struct.unpack(e + 'HHI', d[ifd + 2 + i * 12:ifd + 10 + i * 12])
        size = {1: 1, 2: 1, 3: 2, 4: 4, 7: 1}.get(typ, 1)
        pos = ifd + 10 + i * 12 if size * cnt <= 4 else struct.unpack(e + 'I', d[ifd + 10 + i * 12:ifd + 14 + i * 12])[0]
        fmt = {1: 'B', 2: 'B', 3: 'H', 4: 'I', 7: 'B'}.get(typ, 'B')
        tags[tag] = struct.unpack(e + fmt * min(cnt, 4096), d[pos:pos + size * min(cnt, 4096)])
    w, h = tags[256][0], tags[257][0]
    spp, photo = tags.get(277, (1,))[0], tags.get(262, (1,))[0]
    if tags.get(259, (1,))[0] != 1 or tags.get(258, (8,))[0] != 8 or tags.get(284, (1,))[0] != 1:
        raise ValueError('unsupported TIFF')
    raw = b''.join(d[o:o + n] for o, n in zip(tags[273], tags[279]))
    premult = tags.get(338, (0,))[0] == 1
    rows = bytearray()
    for y in range(h):
        rows.append(0)
        for x in range(w):
            s = (y * w + x) * spp
            if photo == 2 and spp >= 3:
                r, g, b = raw[s], raw[s + 1], raw[s + 2]
                a = raw[s + 3] if spp >= 4 else 255
            else:
                r = g = b = 255 - raw[s] if photo == 0 else raw[s]
                a = raw[s + 1] if spp >= 2 else 255
            if premult and 0 < a < 255:
                r, g, b = (min(255, round(c * 255 / a)) for c in (r, g, b))
            rows += bytes((r, g, b, a))

    def chunk(t, data):
        return struct.pack('>I', len(data)) + t + data + struct.pack('>I', zlib.crc32(t + data) & 0xFFFFFFFF)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(bytes(rows))) + chunk(b'IEND', b''))


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


def midi_to_notes(d, cols=DEFAULT_COLUMNS, hold_min_ms=DEFAULT_HOLD_MIN_MS):
    lanes = lane_map(cols)
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
        if a not in lanes:
            continue
        if k == 'on':
            open_notes[a] = t
        elif k == 'off' and a in open_notes:
            start = ms(open_notes.pop(a))
            dur = ms(t) - start
            notes.append([round(start), lanes[a], round(dur) if dur >= hold_min_ms else 0])
    notes.sort()
    return notes


def theme_path(app, info, level=None):
    theme = None
    if level is not None:
        theme = (info.get('levelThemes') or {}).get(str(level))
    return f"{app}Themes/{theme or info.get('themeName') or ''}.ttrTheme/"


def convert_ipa(path, out, index):
    import os, re
    z = zipfile.ZipFile(path)
    names = set(z.namelist())
    app = next(n for n in sorted(names) if re.fullmatch(r'Payload/[^/]+\.app/Info\.plist', n))[:-len('Info.plist')]
    ids = sorted({n[len(app):].split('/')[1].removesuffix('.track')
                  for n in names if n.startswith(app + 'Tracks/') and n.endswith('.track/info.plist')})
    print(f'{path}: {app[8:-1]}')
    for tid in ids:
        base = f'{app}Tracks/{tid}.track/'
        info = plistlib.loads(z.read(base + 'info.plist'))
        charts = unarchive(z.read(base + 'taptrack.ttr2_track'))
        columns = {str(k): v for k, v in (info.get('columnCountPerLevel') or {}).items()}
        levels, lanes = {}, {}
        for lvl, c in charts.items():
            tp = theme_path(app, info, lvl)
            hold_ms = DEFAULT_HOLD_MIN_MS
            if tp + 'theme.cfg' in names:
                m = re.search(r'game\.tapAndHoldThresholdDuration\s*=\s*([0-9.]+)', z.read(tp + 'theme.cfg').decode('utf-8', 'replace'))
                if m:
                    hold_ms = round(float(m.group(1)) * 1000)
            cols = int(columns.get(str(lvl), DEFAULT_COLUMNS))
            levels[str(lvl)] = midi_to_notes(c['rawData'], cols, hold_ms)
            lanes[str(lvl)] = max(3, cols)
        track = {
            'id': tid,
            'title': info.get('kTTRDownloadableItemTitleKey', tid),
            'artist': info.get('kTTRDownloadableItemSubtitleKey', ''),
            'durationMs': round(info.get('audioFileDuration', 0) * 1000),
            'audio': 'audio.m4a', 'artwork': 'artwork.png',
            'lanes': lanes,
            'levels': levels,
        }
        bg = theme_path(app, info) + 'background.jpg'
        d = os.path.join(out, 'tracks', tid)
        os.makedirs(d, exist_ok=True)
        if bg in names:
            track['background'] = 'background.jpg'
            open(os.path.join(d, 'background.jpg'), 'wb').write(z.read(bg))
        json.dump(track, open(os.path.join(d, 'track.json'), 'w'), separators=(',', ':'))
        open(os.path.join(d, 'audio.m4a'), 'wb').write(z.read(base + 'audio.m4a'))
        art = to_web_image(z.read(base + 'artwork.png')) if base + 'artwork.png' in names else None
        if art:
            open(os.path.join(d, 'artwork.png'), 'wb').write(art)
        if tid not in index:
            index.append(tid)
        print(f"  {track['title']!r} by {track['artist']!r}: " +
              ', '.join(f'L{k}={len(v)}/{lanes[k]}lanes' for k, v in sorted(levels.items())))
    fallback = app + 'Themes/TTRDJ.ttrTheme/background.jpg'
    if fallback in names:
        os.makedirs(os.path.join(out, 'theme'), exist_ok=True)
        open(os.path.join(out, 'theme', 'background.jpg'), 'wb').write(z.read(fallback))


def main():
    import os
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('ipa', nargs='+')
    ap.add_argument('--out', default='app/src/main/assets')
    a = ap.parse_args()
    index = []
    for path in a.ipa:
        convert_ipa(path, a.out, index)
    os.makedirs(os.path.join(a.out, 'tracks'), exist_ok=True)
    json.dump(index, open(os.path.join(a.out, 'tracks', 'index.json'), 'w'))
    print(f'wrote {len(index)} tracks to {a.out}')


if __name__ == '__main__':
    sys.exit(main())
