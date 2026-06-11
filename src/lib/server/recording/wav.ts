import { openSync, writeSync, closeSync, readSync, statSync } from 'node:fs';

/**
 * Minimal 24-bit PCM WAV I/O for vinyl capture. Pure node:fs — no $env, no
 * DB — so verify scripts run under plain bun.
 *
 * Write path: createWav (header with zeroed sizes) → appendFloat32 (chunked,
 * during capture) → finalizeWav (patch sizes). Read path: readWavMeta /
 * scanWav / extractRegionToFile.
 */

const HEADER_BYTES = 44;
const BYTES_PER_SAMPLE = 3; // 24-bit

export interface WavMeta {
  sampleRate: number;
  channels: number;
  bitDepth: number;
  dataOffset: number;
  dataBytes: number;
  frames: number;
  durationMs: number;
}

/** Write a 44-byte canonical PCM WAV header with zeroed sizes (patched on finalize). */
export function createWav(path: string, sampleRate: number, channels: number): void {
  const h = Buffer.alloc(HEADER_BYTES);
  h.write('RIFF', 0);
  h.writeUInt32LE(0, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * channels * BYTES_PER_SAMPLE, 28); // byte rate
  h.writeUInt16LE(channels * BYTES_PER_SAMPLE, 32); // block align
  h.writeUInt16LE(24, 34); // bits per sample
  h.write('data', 36);
  h.writeUInt32LE(0, 40);
  const fd = openSync(path, 'w');
  writeSync(fd, h);
  closeSync(fd);
}

/** Append interleaved float32 samples as 24-bit LE PCM. */
export function appendFloat32(path: string, samples: Float32Array): void {
  const out = Buffer.alloc(samples.length * BYTES_PER_SAMPLE);
  for (let i = 0; i < samples.length; i++) {
    let v = samples[i];
    if (v > 1) v = 1;
    else if (v < -1) v = -1;
    let n = Math.round(v * 8388607);
    if (n < 0) n += 0x1000000; // two's complement in 24 bits
    out[i * 3] = n & 0xff;
    out[i * 3 + 1] = (n >> 8) & 0xff;
    out[i * 3 + 2] = (n >> 16) & 0xff;
  }
  const fd = openSync(path, 'a');
  writeSync(fd, out);
  closeSync(fd);
}

/** Patch RIFF/data sizes from the actual file size. */
export function finalizeWav(path: string): void {
  const size = statSync(path).size;
  const fd = openSync(path, 'r+');
  const b4 = Buffer.alloc(4);
  b4.writeUInt32LE(size - 8, 0);
  writeSync(fd, b4, 0, 4, 4);
  b4.writeUInt32LE(size - HEADER_BYTES, 0);
  writeSync(fd, b4, 0, 4, 40);
  closeSync(fd);
}

export function readWavMeta(path: string): WavMeta {
  const fd = openSync(path, 'r');
  const h = Buffer.alloc(HEADER_BYTES);
  readSync(fd, h, 0, HEADER_BYTES, 0);
  const fileSize = statSync(path).size;
  closeSync(fd);
  if (h.toString('ascii', 0, 4) !== 'RIFF' || h.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`not a WAV file: ${path}`);
  }
  const channels = h.readUInt16LE(22);
  const sampleRate = h.readUInt32LE(24);
  const bitDepth = h.readUInt16LE(34);
  // Trust actual file size over the header field (robust to unfinalized files).
  const dataBytes = fileSize - HEADER_BYTES;
  const frames = Math.floor(dataBytes / (channels * (bitDepth / 8)));
  return {
    sampleRate,
    channels,
    bitDepth,
    dataOffset: HEADER_BYTES,
    dataBytes,
    frames,
    durationMs: (frames / sampleRate) * 1000,
  };
}

export interface WavScan {
  rms: Float32Array; // mono-mixed RMS per hop, 0..1
  peaks: Float32Array; // max |sample| per hop, 0..1
  hopMs: number;
  durationMs: number;
}

/** One chunked pass over the data: per-hop RMS + peak. ~1.5MB read buffer. */
export function scanWav(path: string, hopMs: number): WavScan {
  const meta = readWavMeta(path);
  if (meta.bitDepth !== 24) throw new Error(`scanWav expects 24-bit, got ${meta.bitDepth}`);
  const framesPerHop = Math.max(1, Math.round((meta.sampleRate * hopMs) / 1000));
  const hopCount = Math.ceil(meta.frames / framesPerHop);
  const rms = new Float32Array(hopCount);
  const peaks = new Float32Array(hopCount);

  const fd = openSync(path, 'r');
  const CHUNK_FRAMES = 65536;
  const bytesPerFrame = meta.channels * BYTES_PER_SAMPLE;
  const buf = Buffer.alloc(CHUNK_FRAMES * bytesPerFrame);
  let frame = 0;
  let offset = meta.dataOffset;
  let acc = 0;
  let accN = 0;
  let peak = 0;
  let hop = 0;
  while (frame < meta.frames) {
    const want = Math.min(CHUNK_FRAMES, meta.frames - frame) * bytesPerFrame;
    const got = readSync(fd, buf, 0, want, offset);
    if (got <= 0) break;
    offset += got;
    const gotFrames = Math.floor(got / bytesPerFrame);
    for (let f = 0; f < gotFrames; f++) {
      let mono = 0;
      for (let c = 0; c < meta.channels; c++) {
        const o = (f * meta.channels + c) * 3;
        let n = buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16);
        if (n & 0x800000) n -= 0x1000000;
        mono += n / 8388607;
      }
      mono /= meta.channels;
      acc += mono * mono;
      accN++;
      const a = Math.abs(mono);
      if (a > peak) peak = a;
      if (accN === framesPerHop) {
        rms[hop] = Math.sqrt(acc / accN);
        peaks[hop] = peak;
        hop++;
        acc = 0;
        accN = 0;
        peak = 0;
      }
    }
    frame += gotFrames;
  }
  if (accN > 0 && hop < hopCount) {
    rms[hop] = Math.sqrt(acc / accN);
    peaks[hop] = peak;
  }
  closeSync(fd);
  return { rms, peaks, hopMs, durationMs: meta.durationMs };
}

/** Copy a [startMs, endMs) region into a new standalone WAV, sample-exact. */
export function extractRegionToFile(
  srcPath: string,
  destPath: string,
  startMs: number,
  endMs: number,
): void {
  const meta = readWavMeta(srcPath);
  const startFrame = Math.max(0, Math.round((startMs / 1000) * meta.sampleRate));
  const endFrame = Math.min(meta.frames, Math.round((endMs / 1000) * meta.sampleRate));
  if (endFrame <= startFrame) throw new Error(`empty region: ${startMs}..${endMs}ms`);
  const bytesPerFrame = meta.channels * BYTES_PER_SAMPLE;

  createWav(destPath, meta.sampleRate, meta.channels);
  const src = openSync(srcPath, 'r');
  const dst = openSync(destPath, 'a');
  const CHUNK = 1 << 20;
  let pos = meta.dataOffset + startFrame * bytesPerFrame;
  let remaining = (endFrame - startFrame) * bytesPerFrame;
  const buf = Buffer.alloc(CHUNK);
  while (remaining > 0) {
    const got = readSync(src, buf, 0, Math.min(CHUNK, remaining), pos);
    if (got <= 0) break;
    writeSync(dst, buf, 0, got);
    pos += got;
    remaining -= got;
  }
  closeSync(src);
  closeSync(dst);
  finalizeWav(destPath);
}
