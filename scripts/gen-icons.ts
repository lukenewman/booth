/**
 * gen-icons.ts — generate the PWA install icons.
 *
 * Written as a script rather than committing opaque binaries: the icons are
 * derived from `--bg` (#0a0a0a) and can be regenerated if the palette moves.
 * Hand-rolled PNG encoding keeps it dependency-free — Bun supplies the zlib.
 *
 * Run: bun verify scripts/gen-icons.ts
 */
import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes, 0);
  body.set(data, typeBytes.length);

  const out = new Uint8Array(8 + data.length + 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(body, 4);
  view.setUint32(4 + body.length, crc32(body));
  return out;
}

/** Encode RGBA pixel data as a PNG. */
function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdrData = new Uint8Array(13);
  const ihdrView = new DataView(ihdrData.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // colour type: RGBA
  // 10..12 = compression, filter, interlace — all 0

  // Each scanline is prefixed with filter type 0 (None).
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }

  const idat = new Uint8Array(deflateSync(raw));
  const ihdr = chunk('IHDR', ihdrData);
  const idatChunk = chunk('IDAT', idat);
  const iend = chunk('IEND', new Uint8Array(0));

  const out = new Uint8Array(sig.length + ihdr.length + idatChunk.length + iend.length);
  let o = 0;
  for (const part of [sig, ihdr, idatChunk, iend]) { out.set(part, o); o += part.length; }
  return out;
}

/** A record on a dark ground: outer ring, label ring, spindle hole. */
function drawIcon(size: number): Uint8Array {
  const px = new Uint8Array(size * size * 4);
  const c = size / 2;
  const bg = [0x0a, 0x0a, 0x0a];
  const fg = [0xe8, 0xe8, 0xe8];

  const rOuter = size * 0.40;
  const ringW = size * 0.045;
  const rLabel = size * 0.155;
  const rHole = size * 0.035;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - c, y + 0.5 - c);
      // Coverage-based antialiasing: how far inside the shape edge this pixel sits.
      const edge = (dist: number, r: number) => Math.max(0, Math.min(1, r - dist + 0.5));

      let a = 0;
      a = Math.max(a, Math.min(edge(d, rOuter), 1 - edge(d, rOuter - ringW)));
      a = Math.max(a, Math.min(edge(d, rLabel), 1 - edge(d, rHole)));

      const i = (y * size + x) * 4;
      px[i] = Math.round(bg[0] + (fg[0] - bg[0]) * a);
      px[i + 1] = Math.round(bg[1] + (fg[1] - bg[1]) * a);
      px[i + 2] = Math.round(bg[2] + (fg[2] - bg[2]) * a);
      px[i + 3] = 255;
    }
  }
  return px;
}

for (const size of [192, 512]) {
  const png = encodePng(size, size, drawIcon(size));
  await Bun.write(`static/icon-${size}.png`, png);
  console.log(`✓ static/icon-${size}.png (${png.length} bytes)`);
}
