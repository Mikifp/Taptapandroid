// Some apps ship artwork as uncompressed TIFF, which browsers cannot show. Convert those to PNG.
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 7: 1 };

const isTiff = (d) => d.length > 8 && ((d[0] === 0x49 && d[1] === 0x49 && d[2] === 42) || (d[0] === 0x4D && d[1] === 0x4D && d[3] === 42));

/** Returns browser-friendly image bytes: PNG/JPEG pass through, baseline TIFF becomes PNG. */
export function toWebImage(d) {
  return isTiff(d) ? tiffToPng(d) : d;
}

export function tiffToPng(d) {
  const le = d[0] === 0x49, dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const u16 = (o) => dv.getUint16(o, le), u32 = (o) => dv.getUint32(o, le);
  const ifd = u32(4), tags = {};
  for (let i = 0, n = u16(ifd); i < n; i++) {
    const o = ifd + 2 + i * 12, tag = u16(o), type = u16(o + 2), count = u32(o + 4), size = TYPE_SIZE[type] || 1;
    let p = size * count <= 4 ? o + 8 : u32(o + 8);
    tags[tag] = Array.from({ length: Math.min(count, 4096) }, (_, k) => (size === 2 ? u16(p + 2 * k) : size === 4 ? u32(p + 4 * k) : d[p + k]));
  }
  const w = tags[256][0], h = tags[257][0], spp = tags[277]?.[0] ?? 1, photo = tags[262]?.[0] ?? 1;
  if ((tags[259]?.[0] ?? 1) !== 1 || (tags[258]?.[0] ?? 1) !== 8 || (tags[284]?.[0] ?? 1) !== 1) throw new Error('Unsupported TIFF (need uncompressed 8-bit)');
  const raw = new Uint8Array(w * h * spp);
  let at = 0;
  tags[273].forEach((off, i) => { const len = Math.min(tags[279][i], raw.length - at); raw.set(d.subarray(off, off + len), at); at += len; });
  const premultiplied = tags[338]?.[0] === 1;
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const s = i * spp;
    let r, g, b, a = 255;
    if (photo === 2 && spp >= 3) { r = raw[s]; g = raw[s + 1]; b = raw[s + 2]; if (spp >= 4) a = raw[s + 3]; }
    else if (spp >= 1) { r = g = b = photo === 0 ? 255 - raw[s] : raw[s]; if (spp >= 2) a = raw[s + 1]; }
    else throw new Error('Unsupported TIFF layout');
    if (premultiplied && a > 0 && a < 255) { r = Math.min(255, Math.round(r * 255 / a)); g = Math.min(255, Math.round(g * 255 / a)); b = Math.min(255, Math.round(b * 255 / a)); }
    rgba.set([r, g, b, a], i * 4);
  }
  return encodePng(w, h, rgba);
}

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b) => { let c = 0xFFFFFFFF; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };

/** RGBA8 -> PNG using uncompressed (stored) deflate blocks: no dependencies, fine for small artwork. */
export function encodePng(w, h, rgba) {
  const scan = new Uint8Array((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) scan.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1);
  let a = 1, b = 0;
  for (const x of scan) { a = (a + x) % 65521; b = (b + a) % 65521; }
  const blocks = Math.ceil(scan.length / 65535);
  const z = new Uint8Array(2 + scan.length + blocks * 5 + 4);
  z[0] = 0x78; z[1] = 0x01;
  let o = 2;
  for (let i = 0; i < blocks; i++) {
    const chunk = scan.subarray(i * 65535, (i + 1) * 65535);
    z[o++] = i === blocks - 1 ? 1 : 0;
    z[o++] = chunk.length & 255; z[o++] = chunk.length >> 8; z[o++] = ~chunk.length & 255; z[o++] = (~chunk.length >> 8) & 255;
    z.set(chunk, o); o += chunk.length;
  }
  new DataView(z.buffer).setUint32(o, ((b << 16) | a) >>> 0);
  const chunks = [];
  const chunk = (type, data) => {
    const out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer);
    dv.setUint32(0, data.length); out.set([...type].map((c) => c.charCodeAt(0)), 4); out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    chunks.push(out);
  };
  const ihdr = new Uint8Array(13), idv = new DataView(ihdr.buffer);
  idv.setUint32(0, w); idv.setUint32(4, h); ihdr.set([8, 6, 0, 0, 0], 8);
  chunk('IHDR', ihdr); chunk('IDAT', z); chunk('IEND', new Uint8Array(0));
  const png = new Uint8Array(8 + chunks.reduce((n, c) => n + c.length, 0));
  png.set([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  let p = 8; for (const c of chunks) { png.set(c, p); p += c.length; }
  return png;
}
