// Binary property list (bplist00) reader and NSKeyedArchiver decoder.
const td = new TextDecoder('utf-8');

export class Uid { constructor(v) { this.v = v; } }

export function parseBplist(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (td.decode(bytes.subarray(0, 8)) !== 'bplist00') throw new Error('not a binary plist');
  const tr = bytes.length - 32;
  const offSize = bytes[tr + 6], refSize = bytes[tr + 7];
  const numObjects = Number(dv.getBigUint64(tr + 8)), top = Number(dv.getBigUint64(tr + 16)), tableOff = Number(dv.getBigUint64(tr + 24));
  const uint = (pos, n) => { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + bytes[pos + i]; return v; };
  const offsets = Array.from({ length: numObjects }, (_, i) => uint(tableOff + i * offSize, offSize));
  const cache = new Map();

  function len(pos, nib) { // returns [length, dataStart]
    if (nib !== 0xF) return [nib, pos + 1];
    const n = 1 << (bytes[pos + 1] & 0xF);
    return [uint(pos + 2, n), pos + 2 + n];
  }
  function obj(i) {
    if (cache.has(i)) return cache.get(i);
    const pos = offsets[i], t = bytes[pos], hi = t >> 4, lo = t & 0xF;
    let v;
    switch (hi) {
      case 0x0: v = lo === 8 ? false : lo === 9 ? true : null; break;
      case 0x1: v = uint(pos + 1, 1 << lo); break;
      case 0x2: v = lo === 2 ? dv.getFloat32(pos + 1) : dv.getFloat64(pos + 1); break;
      case 0x3: v = dv.getFloat64(pos + 1); break;
      case 0x4: { const [n, s] = len(pos, lo); v = bytes.slice(s, s + n); break; }
      case 0x5: { const [n, s] = len(pos, lo); v = td.decode(bytes.subarray(s, s + n)); break; }
      case 0x6: { const [n, s] = len(pos, lo); let str = ''; for (let k = 0; k < n; k++) str += String.fromCharCode((bytes[s + 2 * k] << 8) | bytes[s + 2 * k + 1]); v = str; break; }
      case 0x8: v = new Uid(uint(pos + 1, lo + 1)); break;
      case 0xA: case 0xC: { const [n, s] = len(pos, lo); v = []; cache.set(i, v); for (let k = 0; k < n; k++) v.push(obj(uint(s + k * refSize, refSize))); return v; }
      case 0xD: {
        const [n, s] = len(pos, lo); v = {}; cache.set(i, v);
        for (let k = 0; k < n; k++) v[obj(uint(s + k * refSize, refSize))] = obj(uint(s + (n + k) * refSize, refSize));
        return v;
      }
      default: throw new Error('unsupported bplist type 0x' + t.toString(16));
    }
    cache.set(i, v);
    return v;
  }
  return obj(top);
}

/** Decodes an NSKeyedArchiver plist into plain JS values. NSDictionary becomes an object keyed by its keys. */
export function unarchive(bytes) {
  const root = parseBplist(bytes);
  const objs = root.$objects;
  const memo = new Map();
  function dec(v) {
    if (v instanceof Uid) {
      if (memo.has(v.v)) return memo.get(v.v);
      const r = dec(objs[v.v]); memo.set(v.v, r); return r;
    }
    if (v && typeof v === 'object' && !(v instanceof Uint8Array) && !Array.isArray(v) && '$class' in v) {
      if ('NS.keys' in v) { const o = {}; v['NS.keys'].forEach((k, i) => { o[dec(k)] = dec(v['NS.objects'][i]); }); return o; }
      if ('NS.objects' in v) return v['NS.objects'].map(dec);
      if ('NS.data' in v) return v['NS.data'];
      const o = {}; for (const k of Object.keys(v)) if (k !== '$class') o[k] = dec(v[k]); return o;
    }
    return v;
  }
  return dec(root.$top.root);
}

const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** Parses an XML property list into plain JS values (dict -> object, array -> array). */
export function parseXmlPlist(text) {
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z]+)[^>]*?(\/?)>|([^<]+)/g;
  const tokens = [];
  for (const m of text.matchAll(re)) {
    if (m[2]) tokens.push({ tag: m[2], close: m[1] === '/', self: m[3] === '/' });
    else if (m[4] !== undefined && m[4].trim() !== '') tokens.push({ text: unesc(m[4].trim()) });
  }
  let i = 0;
  const scalar = (tag) => {
    const t = tokens[i + 1];
    const text = t && t.text !== undefined ? t.text : '';
    i += t && t.text !== undefined ? 3 : 2; // open, text, close
    if (tag === 'integer' || tag === 'real') return Number(text);
    return text; // string, key, date, data
  };
  function value() {
    const t = tokens[i];
    if (t.tag === 'true') { i++; return true; }
    if (t.tag === 'false') { i++; return false; }
    if (t.tag === 'dict' || t.tag === 'array') {
      const isDict = t.tag === 'dict';
      i++;
      const out = isDict ? {} : [];
      if (t.self) return out;
      while (!(tokens[i].close && tokens[i].tag === t.tag)) {
        if (isDict) { const k = scalar('key'); out[k] = value(); } else out.push(value());
      }
      i++;
      return out;
    }
    if (t.self) { i++; return ''; }
    return scalar(t.tag);
  }
  while (tokens[i] && tokens[i].tag !== 'dict' && tokens[i].tag !== 'array') i++;
  return value();
}

/** Reads an Info.plist in either XML or binary form. */
export function readInfo(bytes) {
  if (td.decode(bytes.subarray(0, 6)) === 'bplist') return parseBplist(bytes);
  return parseXmlPlist(td.decode(bytes));
}
