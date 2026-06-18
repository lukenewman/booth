/**
 * Pure dBFS metering helpers for the vinyl-capture preview meter. No DOM,
 * $env, or $app deps — so this is importable from the browser recorder store
 * AND runnable directly by a bun verify script. Lives in $lib (not
 * $lib/server) because the meter runs client-side.
 */

export type LevelStatus = 'too-low' | 'low' | 'good' | 'hot' | 'clip';

/** Bottom of the meter scale; values at/below this map to position 0. */
export const METER_FLOOR_DBFS = -60;

// Safe-profile zone boundaries (dBFS), classified on the held peak.
export const LOW_DBFS = -18; // below this → too-low
export const GOOD_LO_DBFS = -12; // green band start
export const GOOD_HI_DBFS = -6; // green band end
export const HOT_DBFS = -1; // at/above this → clip

/** Linear amplitude (0..1) → dBFS. 0 maps to -Infinity. */
export function toDbfs(linear: number): number {
  if (linear <= 0) return -Infinity;
  return 20 * Math.log10(linear);
}

/** Classify a held-peak dBFS value into a meter status (Safe profile). */
export function classifyPeak(dbfs: number, clipped = false): LevelStatus {
  if (clipped || dbfs >= HOT_DBFS) return 'clip';
  if (dbfs < LOW_DBFS) return 'too-low';
  if (dbfs < GOOD_LO_DBFS) return 'low';
  if (dbfs <= GOOD_HI_DBFS) return 'good';
  return 'hot';
}

/** dBFS → 0..1 position along the meter (METER_FLOOR_DBFS..0 dBFS), clamped. */
export function meterFraction(dbfs: number): number {
  if (dbfs <= METER_FLOOR_DBFS) return 0;
  if (dbfs >= 0) return 1;
  return (dbfs - METER_FLOOR_DBFS) / -METER_FLOOR_DBFS;
}
