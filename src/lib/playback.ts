/**
 * How a given track relates to the player right now.
 *
 * Kept pure and separate because the tracklist previously conflated "is the
 * loaded track" with "is playing" — a paused track rendered the same ▶ as a
 * playing one, so the transport button would have shown the wrong action.
 */
export type TrackPlayState = 'playing' | 'paused' | 'idle';

export function trackPlayState(
  trackId: string,
  loadedTrackId: string | null | undefined,
  isPlaying: boolean,
): TrackPlayState {
  if (!loadedTrackId || loadedTrackId !== trackId) return 'idle';
  return isPlaying ? 'playing' : 'paused';
}

/** Glyph for a transport button in the given state. */
export function transportGlyph(state: TrackPlayState): string {
  return state === 'playing' ? '⏸' : '▶';
}

/** Accessible label for a transport button in the given state. */
export function transportLabel(state: TrackPlayState, title: string): string {
  if (state === 'playing') return `Pause ${title}`;
  if (state === 'paused') return `Resume ${title}`;
  return `Play ${title}`;
}
