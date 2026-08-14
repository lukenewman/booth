// The trimmed Discogs release shape we use throughout the app.
export interface DiscogsRelease {
  id: number;
  title: string;
  artist: string;
  year: number | null;
  country: string | null;
  label: string | null;
  catno: string | null;
  format: string | null;
  thumb: string | null;
  coverImage: string | null;
}

// One entry in the in-memory session log.
export interface SessionEntry {
  releaseId: number;
  instanceId: number;
  title: string;
  artist: string;
  addedAt: number; // Date.now()
}

// The current visual mode of the app.
export type AppMode = 'search' | 'scanner';

/**
 * Listview ordering. `artist` is the artist-led alphabetical order (artist →
 * year → title for releases, artist → album → title for tracks); `added-*`
 * sorts by the local source's `dateAdded` facet. Shared so the client store and
 * the server queries agree on the wire value.
 */
export type SortKey = 'artist' | 'added-desc' | 'added-asc';

/**
 * The app-wide default ordering. Defined once so the store's hydrate/serialize,
 * the query layer and the HTTP boundary can't disagree about what an absent
 * `?sort=` means — a mismatch there would silently serve a different order than
 * the toolbar shows as selected.
 */
export const DEFAULT_SORT: SortKey = 'added-desc';

// API error response envelope. Server endpoints return this on failure.
export interface ApiError {
  error:
    | 'no_token'
    | 'invalid_token'
    | 'rate_limited'
    | 'not_found'
    | 'discogs_error'
    | 'network_error';
  message?: string;
  retryAfter?: number; // seconds, only present for rate_limited
}

// Successful add response — Discogs returns instance_id we need for undo.
export interface AddResponse {
  releaseId: number;
  instanceId: number;
}
