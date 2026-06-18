// Verifies the pure dBFS metering helpers: linear→dBFS conversion, Safe-profile
// zone classification (incl. the clip-flag override), and meter scaling.
import {
  toDbfs,
  classifyPeak,
  meterFraction,
  METER_FLOOR_DBFS,
} from '../src/lib/loudness';

let failures = 0;
const assert = (c: boolean, m: string) => {
  if (!c) {
    console.error('FAIL:', m);
    failures++;
  } else console.log('ok:', m);
};
const near = (a: number, b: number, eps = 0.05) => Math.abs(a - b) <= eps;

// --- toDbfs ---
assert(toDbfs(1) === 0, 'toDbfs(1) = 0 dBFS');
assert(near(toDbfs(0.5), -6.02), 'toDbfs(0.5) ≈ -6.02 dBFS');
assert(toDbfs(0) === -Infinity, 'toDbfs(0) = -Infinity');
assert(near(toDbfs(0.0959), -20.4, 0.1), 'toDbfs(0.0959) ≈ -20.4 (the captured take-1 peak)');

// --- classifyPeak zone boundaries ---
assert(classifyPeak(-30) === 'too-low', '-30 → too-low');
assert(classifyPeak(-19) === 'too-low', '-19 → too-low');
assert(classifyPeak(-18) === 'low', '-18 → low (boundary)');
assert(classifyPeak(-13) === 'low', '-13 → low');
assert(classifyPeak(-12) === 'good', '-12 → good (boundary)');
assert(classifyPeak(-9) === 'good', '-9 → good');
assert(classifyPeak(-6) === 'good', '-6 → good (boundary)');
assert(classifyPeak(-5) === 'hot', '-5 → hot');
assert(classifyPeak(-2) === 'hot', '-2 → hot');
assert(classifyPeak(-1) === 'clip', '-1 → clip (boundary)');
assert(classifyPeak(0) === 'clip', '0 → clip');
assert(classifyPeak(-9, true) === 'clip', 'clipped flag overrides good → clip');

// --- meterFraction ---
assert(meterFraction(0) === 1, 'meterFraction(0) = 1');
assert(meterFraction(METER_FLOOR_DBFS) === 0, 'meterFraction(floor) = 0');
assert(meterFraction(-120) === 0, 'meterFraction below floor clamps to 0');
assert(near(meterFraction(-30), 0.5, 0.001), 'meterFraction(-30) = 0.5 over a -60 floor');
assert(meterFraction(-6) > meterFraction(-12), 'meterFraction is monotonic');

if (failures > 0) process.exit(1);
console.log('verify-loudness: all passed');
