/**
 * Silence/gap detection over an RMS envelope (from wav.ts scanWav). Pure
 * functions — no fs, no DB, no $env — so verify scripts run under plain bun.
 *
 * Tunables are named constants per the design spec.
 */

/** A gap must persist at least this long to count as an inter-track gap. */
export const MIN_GAP_MS = 500;
/** Noise floor = median of the quietest this-fraction of hops (robust to a
 * single near-zero hop). Silence is a SMALL fraction of a side — lead-in,
 * run-out, and a few inter-track gaps — so a plain low percentile lands in
 * music. The lowest-k median targets the genuinely-quiet hops instead. */
export const NOISE_LOWEST_FRACTION = 0.005;
/** Gap threshold = noise floor × this ratio. */
export const GAP_THRESHOLD_RATIO = 4;
/** Keep-margin around region edges — protects soft attacks and fades. */
export const PAD_MS = 150;
/** Duration-predicted boundaries snap to gaps within this window. */
export const SNAP_WINDOW_MS = 45000;

export interface Gap {
  startMs: number;
  endMs: number;
  /** Strength: duration × quietness; higher = more likely a real gap. */
  score: number;
}

/**
 * Threshold separating silence from signal. Returns 0 (nothing is below it)
 * when the take has no clear silence — e.g. a fully beat-mixed side — so the
 * whole take reads as one signal region with no gaps.
 */
export function noiseThreshold(rms: Float32Array): number {
  if (rms.length === 0) return 0.0005;
  const sorted = Array.from(rms).sort((a, b) => a - b);
  const k = Math.max(10, Math.floor(sorted.length * NOISE_LOWEST_FRACTION));
  const lowest = sorted.slice(0, Math.min(k, sorted.length));
  const noiseFloor = lowest[Math.floor(lowest.length / 2)] ?? 0; // median of lowest k
  const musicLevel = sorted[Math.floor(sorted.length * 0.5)] ?? 0; // median overall
  const threshold = Math.max(noiseFloor * GAP_THRESHOLD_RATIO, 0.0005);
  // If the noise floor isn't clearly below the music level, there's no real
  // silence in this take — return 0 so nothing classifies as a gap.
  if (threshold >= musicLevel * 0.5) return 0;
  return threshold;
}

/** Maximal runs of RMS below the relative noise threshold, ≥ MIN_GAP_MS. */
export function findGaps(rms: Float32Array, hopMs: number): Gap[] {
  const threshold = noiseThreshold(rms);
  const gaps: Gap[] = [];
  let runStart = -1;
  let runSum = 0;
  const flush = (endIdx: number) => {
    if (runStart < 0) return;
    const durMs = (endIdx - runStart) * hopMs;
    if (durMs >= MIN_GAP_MS) {
      const avg = runSum / (endIdx - runStart);
      gaps.push({
        startMs: runStart * hopMs,
        endMs: endIdx * hopMs,
        score: durMs * (threshold / Math.max(avg, 1e-6)),
      });
    }
    runStart = -1;
    runSum = 0;
  };
  for (let i = 0; i < rms.length; i++) {
    if (rms[i] < threshold) {
      if (runStart < 0) runStart = i;
      runSum += rms[i];
    } else flush(i);
  }
  flush(rms.length);
  return gaps;
}

/** First/last hop where the signal is above threshold → audio extent of the take. */
export function audioExtent(rms: Float32Array, hopMs: number): { startMs: number; endMs: number } {
  const threshold = noiseThreshold(rms);
  let first = 0;
  let last = rms.length - 1;
  while (first < rms.length && rms[first] < threshold) first++;
  while (last > first && rms[last] < threshold) last--;
  return { startMs: first * hopMs, endMs: (last + 1) * hopMs };
}
