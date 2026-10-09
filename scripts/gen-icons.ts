/**
 * gen-icons.ts — generate the PWA install icons.
 *
 * Written as a script rather than committing opaque binaries: the icons are
 * derived from `--bg`, `--text` and `--accent` in app.css and can be
 * regenerated if the palette moves.
 * Hand-rolled PNG encoding keeps it dependency-free — Bun supplies the zlib.
 *
 * Run: bun verify scripts/gen-icons.ts
 *      bun scripts/gen-icons.ts --mac <dir>.iconset   (desktop app icon set)
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

/** A record on the app's ground: fine grooves out to the edge, accent label, spindle hole. */
function drawIcon(size: number, scale = 1): Uint8Array {
  const px = new Uint8Array(size * size * 4);
  const c = size / 2;
  const bg = [0x26, 0x26, 0x24];
  const ring = [0xe6, 0xe3, 0xdc];
  const label = [0xa5, 0x8c, 0xf0];

  const rOuter = size * scale * 0.47;
  const rLabel = size * scale * 0.155;
  const rHole = size * scale * 0.035;

  // Evenly spaced grooves from just outside the label to the rim. Small sizes
  // get fewer so each groove keeps ~3px of ground either side instead of
  // smearing into a flat grey disc.
  const grooveW = Math.max(1, size * scale * 0.007);
  const firstGroove = rLabel + size * scale * 0.045;
  const span = rOuter - firstGroove;
  const grooves = Math.max(2, Math.min(9, Math.floor(span / (grooveW + 3)) + 1));
  const grooveRadii = Array.from({ length: grooves }, (_, k) => firstGroove + (span * k) / (grooves - 1));
  const grooveAlpha = 0.6;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - c, y + 0.5 - c);
      // Coverage-based antialiasing: how far inside the shape edge this pixel sits.
      const edge = (dist: number, r: number) => Math.max(0, Math.min(1, r - dist + 0.5));

      let aRing = 0;
      for (const r of grooveRadii) {
        aRing = Math.max(aRing, Math.min(edge(d, r + grooveW / 2), 1 - edge(d, r - grooveW / 2)));
      }
      aRing *= grooveAlpha;
      const aLabel = Math.min(edge(d, rLabel), 1 - edge(d, rHole));

      const i = (y * size + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        px[i + ch] = Math.round(bg[ch] + (ring[ch] - bg[ch]) * aRing + (label[ch] - bg[ch]) * aLabel);
      }
      px[i + 3] = 255;
    }
  }
  return px;
}

/**
 * The same record on a macOS app tile: transparent canvas, the dark ground
 * shrunk to Apple's 824/1024 rounded square so it sits in the Dock at the
 * same visual size as other apps (a full-bleed square looks oversized there).
 */
function drawMacIcon(size: number): Uint8Array {
  const tile = 824 / 1024;
  const px = drawIcon(size, tile);
  const c = size / 2;
  const half = (size * tile) / 2;
  const radius = (size * 185) / 1024;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Signed distance to the rounded square, for an antialiased edge.
      const qx = Math.abs(x + 0.5 - c) - (half - radius);
      const qy = Math.abs(y + 0.5 - c) - (half - radius);
      const dist = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
      px[(y * size + x) * 4 + 3] = Math.round(255 * Math.max(0, Math.min(1, 0.5 - dist)));
    }
  }
  return px;
}

const macFlag = process.argv.indexOf('--mac');
if (macFlag !== -1) {
  const dir = process.argv[macFlag + 1];
  for (const base of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const size = base * scale;
      const name = `icon_${base}x${base}${scale === 2 ? '@2x' : ''}.png`;
      await Bun.write(`${dir}/${name}`, encodePng(size, size, drawMacIcon(size)));
    }
  }
  console.log(`✓ ${dir}`);
} else {
  for (const size of [192, 512]) {
    const png = encodePng(size, size, drawIcon(size));
    await Bun.write(`static/icon-${size}.png`, png);
    console.log(`✓ static/icon-${size}.png (${png.length} bytes)`);
  }
}
