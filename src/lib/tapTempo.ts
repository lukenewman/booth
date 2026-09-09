/**
 * Tap tempo: a BPM you measure yourself by tapping along to a record.
 *
 * Exists for the ~1,200 tracks in the library with no audio file behind them —
 * vinyl the app can see through Discogs but cannot analyse. A tap is the only
 * reading of those that comes from the pressing actually on the deck.
 *
 * Pure and time-injected: the caller supplies each tap's timestamp, so the
 * whole thing is testable without a clock.
 */

/** Taps needed before a reading is offered. Three intervals is the fewest that a median can meaningfully filter. */
export const MIN_TAPS = 4;

/** Silence after which the next tap starts a fresh run rather than extending the last. */
export const RESET_MS = 3000;

/** Intervals kept. Long enough to average out jitter, short enough to follow a record that drifts. */
export const WINDOW = 8;

/** Same sanity range the BPM resolver applies to stored values. */
const MIN_BPM = 20;
const MAX_BPM = 400;

/**
 * How far an interval may sit from the median and still count. A missed beat
 * lands near double, a double-fire near zero; ordinary human jitter is a few
 * percent. A quarter separates those cleanly without discarding real drift.
 */
const OUTLIER_TOLERANCE = 0.25;

export interface TapState {
  /** Tap timestamps in ms, oldest first. */
  taps: number[];
}

export const emptyTapState: TapState = { taps: [] };

export interface TapEstimate {
  /** Whole BPM. Tapping jitter is far wider than a decimal, so a decimal would be false precision. */
  bpm: number;
  /** Taps in the current run, for the "keep going" affordance. */
  taps: number;
}

/** Record a tap. Returns a new state; never mutates. */
export function tap(state: TapState, atMs: number): TapState {
  const last = state.taps[state.taps.length - 1];
  if (last !== undefined && atMs - last > RESET_MS) {
    return { taps: [atMs] };
  }
  const taps = [...state.taps, atMs];
  // WINDOW intervals needs WINDOW + 1 taps.
  return { taps: taps.slice(-(WINDOW + 1)) };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * The current reading, or null while there isn't one worth showing.
 *
 * Median-filtered rather than averaged outright: one fumbled tap in eight would
 * otherwise move the answer by several BPM, and a fumbled tap is the normal
 * case, not the exceptional one.
 */
export function estimate(state: TapState): TapEstimate | null {
  if (state.taps.length < MIN_TAPS) return null;

  const intervals: number[] = [];
  for (let i = 1; i < state.taps.length; i++) {
    intervals.push(state.taps[i] - state.taps[i - 1]);
  }

  const mid = median(intervals);
  if (mid <= 0) return null;

  // A double-fire is one beat recorded twice, not a fast beat: the stray short
  // interval and the shortened one after it sum to a real beat. Put them back
  // together before filtering, or the survivor of the pair drags the average
  // down while looking perfectly plausible to an outlier test.
  const merged: number[] = [];
  let carry = 0;
  for (const v of intervals) {
    if (v < mid / 2) {
      carry += v;
      continue;
    }
    merged.push(v + carry);
    carry = 0;
  }
  // A trailing short interval has no beat to rejoin; drop it.

  const kept = merged.filter((v) => Math.abs(v - mid) / mid <= OUTLIER_TOLERANCE);
  if (kept.length === 0) return null;

  const mean = kept.reduce((a, b) => a + b, 0) / kept.length;
  if (mean <= 0) return null;

  const bpm = Math.round(60000 / mean);
  if (bpm < MIN_BPM || bpm > MAX_BPM) return null;

  return { bpm, taps: state.taps.length };
}
