// Verifies 24-bit WAV write/read round-trip, scan pass, and region extraction.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createWav,
  appendFloat32,
  finalizeWav,
  readWavMeta,
  extractRegionToFile,
  scanWav,
} from '../src/lib/server/recording/wav';

let failures = 0;
const assert = (c: boolean, m: string) => {
  if (!c) {
    console.error('FAIL:', m);
    failures++;
  } else console.log('ok:', m);
};

const dir = mkdtempSync(join(tmpdir(), 'booth-wav-'));
const p = join(dir, 'take.wav');
const SR = 48000;

// 1s of 440Hz sine at 0.5 amplitude, stereo interleaved float32.
const frames = SR;
const inter = new Float32Array(frames * 2);
for (let i = 0; i < frames; i++) {
  const v = Math.sin((2 * Math.PI * 440 * i) / SR) * 0.5;
  inter[2 * i] = v;
  inter[2 * i + 1] = v;
}

createWav(p, SR, 2);
appendFloat32(p, inter.subarray(0, frames)); // first half (frames/2 frames of stereo)
appendFloat32(p, inter.subarray(frames)); // second half
finalizeWav(p);

const meta = readWavMeta(p);
assert(meta.sampleRate === SR, 'sample rate preserved');
assert(meta.channels === 2, 'channels preserved');
assert(meta.bitDepth === 24, '24-bit depth');
assert(meta.frames === frames, `frame count exact (${meta.frames} vs ${frames})`);
assert(Math.abs(meta.durationMs - 1000) < 1, 'duration ~1000ms');

// scanWav: envelope + peaks in one pass (50ms hops).
const scan = scanWav(p, 50);
assert(scan.rms.length === Math.ceil(1000 / 50), `one rms bucket per hop (${scan.rms.length})`);
// sine at 0.5 amplitude → rms ≈ 0.3535
assert(Math.abs(scan.rms[5] - 0.3535) < 0.02, `mid-take rms ≈ 0.3535 (got ${scan.rms[5].toFixed(4)})`);
assert(scan.peaks[5] > 0.45 && scan.peaks[5] <= 0.51, `peak ≈ 0.5 (got ${scan.peaks[5].toFixed(4)})`);

// Region extraction: 250ms..750ms → 500ms file, sample-exact.
const rp = join(dir, 'region.wav');
extractRegionToFile(p, rp, 250, 750);
const rmeta = readWavMeta(rp);
assert(rmeta.frames === SR / 2, `region frame count exact (${rmeta.frames} vs ${SR / 2})`);
assert(rmeta.sampleRate === SR, 'region keeps sample rate');
assert(rmeta.bitDepth === 24, 'region keeps bit depth');

// Round-trip amplitude integrity: region rms should match source rms.
const rscan = scanWav(rp, 50);
assert(Math.abs(rscan.rms[3] - 0.3535) < 0.02, `region audio intact (rms ${rscan.rms[3].toFixed(4)})`);

rmSync(dir, { recursive: true, force: true });
if (failures > 0) process.exit(1);
console.log('verify-wav: all passed');
