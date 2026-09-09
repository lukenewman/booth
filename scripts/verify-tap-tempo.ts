import {
  emptyTapState,
  estimate,
  tap,
  MIN_TAPS,
  RESET_MS,
} from '../src/lib/tapTempo';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) fail(msg);
}

/** Tap out a sequence of inter-tap gaps, starting at t=0. */
function tapAll(gaps: number[]) {
  let state = emptyTapState;
  let t = 0;
  state = tap(state, t);
  for (const g of gaps) {
    t += g;
    state = tap(state, t);
  }
  return state;
}

// --- A clean sequence reads exactly ------------------------------
const clean = tapAll([500, 500, 500, 500, 500, 500, 500]);
assert(estimate(clean)?.bpm === 120, `clean 120 BPM, got ${estimate(clean)?.bpm}`);
assert(estimate(clean)?.taps === 8, `tap count reported, got ${estimate(clean)?.taps}`);

// --- Human jitter rounds to the intended tempo --------------------
const jittery = tapAll([512, 489, 505, 494, 508, 497, 501]);
assert(estimate(jittery)?.bpm === 120, `jitter still reads 120, got ${estimate(jittery)?.bpm}`);

// --- One bad tap must not drag the estimate -----------------------
// A double-fire (two taps almost together) then back on the beat. Without the
// median filter the stray short interval pulls the average well off.
const withOutlier = tapAll([500, 500, 40, 460, 500, 500, 500]);
assert(
  estimate(withOutlier)?.bpm === 120,
  `outlier tap discarded, got ${estimate(withOutlier)?.bpm}`,
);

// --- A missed beat is an outlier too ------------------------------
const missedBeat = tapAll([500, 500, 1000, 500, 500, 500, 500]);
assert(
  estimate(missedBeat)?.bpm === 120,
  `missed beat discarded, got ${estimate(missedBeat)?.bpm}`,
);

// --- Not enough taps yet ------------------------------------------
let few = emptyTapState;
for (let i = 0; i < MIN_TAPS - 1; i++) few = tap(few, i * 500);
assert(estimate(few) === null, 'below the minimum reads as nothing yet');
few = tap(few, (MIN_TAPS - 1) * 500);
assert(estimate(few)?.bpm === 120, `the ${MIN_TAPS}th tap produces a reading`);

// --- Stopping resets, so a stale run can't blend into a new one ----
let stalled = tapAll([500, 500, 500, 500]);
assert(estimate(stalled)?.bpm === 120, 'reading before the stall');
stalled = tap(stalled, 2000 + RESET_MS + 1);
assert(estimate(stalled) === null, 'the stall cleared the run');
let t = 2000 + RESET_MS + 1;
for (let i = 0; i < MIN_TAPS - 1; i++) {
  t += 400;
  stalled = tap(stalled, t);
}
assert(estimate(stalled)?.bpm === 150, `new run reads on its own, got ${estimate(stalled)?.bpm}`);

// --- Only the recent window counts, so speeding up is followed -----
let drifting = emptyTapState;
let dt = 0;
drifting = tap(drifting, dt);
for (let i = 0; i < 8; i++) { dt += 600; drifting = tap(drifting, dt); }
for (let i = 0; i < 8; i++) { dt += 500; drifting = tap(drifting, dt); }
assert(
  estimate(drifting)?.bpm === 120,
  `window follows the current tempo, got ${estimate(drifting)?.bpm}`,
);

// --- Whole numbers only: tapping jitter dwarfs a decimal -----------
const odd = tapAll([468, 468, 468, 468, 468]);
const oddBpm = estimate(odd)?.bpm;
assert(oddBpm !== undefined && Number.isInteger(oddBpm), `whole numbers, got ${oddBpm}`);
assert(oddBpm === 128, `468ms reads as 128, got ${oddBpm}`);

// --- Nonsense is rejected rather than rendered ---------------------
let sameInstant = emptyTapState;
for (let i = 0; i < 6; i++) sameInstant = tap(sameInstant, 1000);
assert(estimate(sameInstant) === null, 'zero-length intervals produce nothing');

const tooSlow = tapAll([5000, 5000, 5000, 5000]);
assert(estimate(tooSlow) === null, 'implausibly slow reads as nothing');

console.log('OK: tap-tempo');
