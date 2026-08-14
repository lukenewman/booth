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
 * Listview ordering. `default` keeps each list's natural order; `added-*` sorts
 * by the local source's `dateAdded` facet. Shared so the client store and the
 * server queries agree on the wire value.
 */
export type SortKey = 'default' | 'added-desc' | 'added-asc';

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
