/**
 * BPM display helpers, shared by client and server.
 *
 * The server-side resolver (`$lib/server/library/bpm`) imports `bun:sqlite`, so
 * anything a Svelte component needs has to live here instead.
 */
import { pitchToRate, type PitchRange } from './pitch';

/** Where a BPM reading came from. Mirrors the server resolver's providers. */
export type BpmProvider = 'rekordbox' | 'analysis' | 'tag';

export interface ResolvedBpm {
  value: number;
  provider: BpmProvider;
}

/**
 * Display form. Analysis produces fractional tempi and DJs read the tenth; tags
 * are whole numbers and a trailing ".0" on them is noise.
 */
export function formatBpm(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** The tempo a track is actually playing at under a given pitch. */
export function pitchedBpm(base: number, pitchPercent: number): number {
  return base * pitchToRate(pitchPercent);
}

/**
 * The tempo range a fader can reach from a resting BPM — the "what can I mix
 * this with" question the readout exists to answer.
 */
export function bpmRange(base: number, range: PitchRange): { min: number; max: number } {
  return { min: base * pitchToRate(-range), max: base * pitchToRate(range) };
}

/** "117.8–138.2", with an en dash because it is a range, not a subtraction. */
export function formatBpmRange(base: number, range: PitchRange): string {
  const { min, max } = bpmRange(base, range);
  return `${min.toFixed(1)}–${max.toFixed(1)}`;
}

/** Human label for provenance, shown where there is room to explain a number. */
export function bpmProviderLabel(provider: BpmProvider): string {
  switch (provider) {
    case 'rekordbox':
      return 'from rekordbox';
    case 'analysis':
      return 'analysed';
    case 'tag':
      return 'from file tag';
  }
}
