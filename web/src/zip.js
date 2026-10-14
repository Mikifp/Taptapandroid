// Minimal random-access zip reader: reads only the entries asked for, from a Blob/File.
const u16 = (d, i) => d[i] | (d[i + 1] << 8);
const u32 = (d, i) => (d[i] | (d[i + 1] << 8) | (d[i + 2] << 16) | (d[i + 3] << 24)) >>> 0;

export class ZipReader {
  constructor(blob) { this.blob = blob; this.entries = new Map(); }

  async open() {
    const size = this.blob.size;
    const tailLen = Math.min(size, 65557);
    const tail = new Uint8Array(await this.blob.slice(size - tailLen).arrayBuffer());
    let e = tail.length - 22;
    while (e >= 0 && u32(tail, e) !== 0x06054b50) e--;
    if (e < 0) throw new Error('Not a zip/IPA file');
    const count = u16(tail, e + 10), cdSize = u32(tail, e + 12), cdOff = u32(tail, e + 16);
    const cd = new Uint8Array(await this.blob.slice(cdOff, cdOff + cdSize).arrayBuffer());
    const dec = new TextDecoder();
    let p = 0;
    for (let n = 0; n < count && p + 46 <= cd.length; n++) {
      if (u32(cd, p) !== 0x02014b50) break;
      const nameLen = u16(cd, p + 28), extraLen = u16(cd, p + 30), commentLen = u16(cd, p + 32);
      this.entries.set(dec.decode(cd.subarray(p + 46, p + 46 + nameLen)), {
        method: u16(cd, p + 10), compSize: u32(cd, p + 20), size: u32(cd, p + 24), offset: u32(cd, p + 42),
      });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return this;
  }

  names() { return [...this.entries.keys()]; }
  has(name) { return this.entries.has(name); }

  async read(name) {
    const en = this.entries.get(name);
    if (!en) throw new Error('Missing in archive: ' + name);
    const head = new Uint8Array(await this.blob.slice(en.offset, en.offset + 30).arrayBuffer());
    const start = en.offset + 30 + u16(head, 26) + u16(head, 28);
    const raw = this.blob.slice(start, start + en.compSize);
    if (en.method === 0) return new Uint8Array(await raw.arrayBuffer());
    if (en.method !== 8) throw new Error('Unsupported zip compression ' + en.method);
    const stream = raw.stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
}
