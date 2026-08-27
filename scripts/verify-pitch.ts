// Verifies the pitch fader's maths: clamping, the centre detent, rate mapping,
// the readout, and the range toggle.
import {
  PITCH_RANGES,
  clampPitch,
  formatPitch,
  nextPitchRange,
  pitchToRate,
} from '../src/lib/pitch';

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg);
    failures++;
  } else console.log('ok:', msg);
}

// --- Clamping to fader travel ---
assert(clampPitch(0, 8) === 0, 'centre stays centre');
assert(clampPitch(4.2, 8) === 4.2, 'in-range value passes through');
assert(clampPitch(-4.2, 8) === -4.2, 'negative in-range value passes through');
assert(clampPitch(12, 8) === 8, 'over-travel clamps to +range');
assert(clampPitch(-12, 8) === -8, 'under-travel clamps to -range');
assert(clampPitch(12, 16) === 12, 'the same value fits inside the wide range');

// --- Centre detent ---
assert(clampPitch(0.04, 8) === 0, 'just above zero detents to zero');
assert(clampPitch(-0.04, 8) === 0, 'just below zero detents to zero');
assert(clampPitch(0.06, 8) === 0.1, 'outside the detent quantises to a tenth');

// --- Quantisation ---
assert(clampPitch(3.14159, 8) === 3.1, 'quantises to one decimal');
assert(clampPitch(3.16, 8) === 3.2, 'quantisation rounds, not truncates');

// --- Junk in ---
assert(clampPitch(NaN, 8) === 0, 'NaN falls back to centre');
assert(clampPitch(Infinity, 8) === 0, 'Infinity falls back to centre');

// --- Rate mapping ---
// The turntable relationship: +8% pitch is 1.08x speed.
assert(pitchToRate(0) === 1, 'centre is unity rate');
assert(Math.abs(pitchToRate(8) - 1.08) < 1e-9, '+8% is 1.08x');
assert(Math.abs(pitchToRate(-8) - 0.92) < 1e-9, '-8% is 0.92x');
assert(pitchToRate(100) === 2, '+100% would be double speed');

// --- Readout ---
assert(formatPitch(0) === '0.0%', 'centre reads unsigned');
assert(formatPitch(2.4) === '+2.4%', 'positive carries a plus');
assert(formatPitch(-2.4) === '−2.4%', 'negative carries a real minus sign');
assert(formatPitch(8) === '+8.0%', 'whole numbers still show the decimal');
// Constant width matters: the readout sits next to the fader and must not jitter.
assert(
  formatPitch(2.4).length === formatPitch(-2.4).length,
  'positive and negative labels are the same length',
);

// --- Range toggle ---
assert(nextPitchRange(8) === 16, '8 widens to 16');
assert(nextPitchRange(16) === 8, '16 wraps back to 8');
assert(PITCH_RANGES[0] === 8, 'default range is the Technics ±8');

// Narrowing the range must re-clamp a pitch that no longer fits, or the audio
// sits at a rate the fader can no longer express.
const wide = clampPitch(14, 16);
assert(wide === 14, 'wide range holds 14%');
assert(clampPitch(wide, 8) === 8, 'narrowing re-clamps into the narrow range');

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
