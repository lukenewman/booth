import type { SortKey } from '$lib/types';

/** The library listview's current filters, enough to rebuild its exact ordering. */
export interface LibraryQuery {
  source?: string;
  q?: string;
  sort: SortKey;
  multiSource?: boolean;
}

/**
 * Where playback was started from. Captured at play time and never rebuilt as
 * the user browses — see the design doc's core principle.
 *
 * Release and playlist carry ids inline because both already hold their full
 * ordered list client-side; only the paginated library listview needs the
 * server to resolve its ids.
 */
export type PlaybackContext =
  | { kind: 'release'; releaseId: string; ids: string[] }
  | { kind: 'playlist'; playlistId: string; ids: string[] }
  | { kind: 'library'; query: LibraryQuery };

export type PrevAction =
  | { kind: 'none' }
  | { kind: 'restart' }
  | { kind: 'move'; index: number };

/** Seconds into a track past which `prev` restarts it instead of stepping back. */
export const PREV_RESTART_THRESHOLD_S = 3;

/** Next position, or null at the end of the queue (playback stops; no wrap). */
export function nextIndex(index: number, queueLength: number): number | null {
  if (index < 0 || queueLength <= 0) return null;
  const candidate = index + 1;
  return candidate < queueLength ? candidate : null;
}

/**
 * What `prev` should do. Past the threshold it restarts — the conventional
 * behaviour, and the reason a single button can serve both "start this over"
 * and "go back one".
 */
export function prevTarget(
  currentTime: number,
  index: number,
  queueLength: number,
): PrevAction {
  if (index < 0 || queueLength <= 0) return { kind: 'none' };
  if (currentTime > PREV_RESTART_THRESHOLD_S) return { kind: 'restart' };
  if (index === 0) return { kind: 'restart' };
  return { kind: 'move', index: index - 1 };
}
