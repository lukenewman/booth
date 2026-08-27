/**
 * Turntable pitch maths. Kept out of the store so it can be verified directly —
 * the store holds state, this decides what the state is allowed to be.
 */

export type PitchRange = 8 | 16;

/** Ranges the fader's range toggle cycles through, in order. ±8 is the Technics 1200 default. */
export const PITCH_RANGES: PitchRange[] = [8, 16];

/**
 * Anything this close to centre is centre. A fader that reads "+0.1%" when it
 * looks centred is worse than one that detents, and pointer input on a 44px
 * track cannot reliably hit an exact zero.
 */
const DETENT = 0.05;

/** Clamp to the fader's travel, snap the neighbourhood of zero to zero, quantise to 0.1%. */
export function clampPitch(percent: number, range: PitchRange): number {
  if (!Number.isFinite(percent)) return 0;
  const clamped = Math.max(-range, Math.min(range, percent));
  if (Math.abs(clamped) < DETENT) return 0;
  return Math.round(clamped * 10) / 10;
}

/** The audio element's playbackRate for a given pitch. */
export function pitchToRate(percent: number): number {
  return 1 + percent / 100;
}

/**
 * Signed display label, always one decimal so the readout never changes width
 * as the fader moves. Uses a real minus sign rather than a hyphen.
 */
export function formatPitch(percent: number): string {
  const sign = percent > 0 ? '+' : percent < 0 ? '−' : '';
  return `${sign}${Math.abs(percent).toFixed(1)}%`;
}

/** Next range in the cycle, wrapping. */
export function nextPitchRange(range: PitchRange): PitchRange {
  const i = PITCH_RANGES.indexOf(range);
  return PITCH_RANGES[(i + 1) % PITCH_RANGES.length];
}
