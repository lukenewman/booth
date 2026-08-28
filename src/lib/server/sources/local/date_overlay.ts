import type { Database } from 'bun:sqlite';

/**
 * Effective acquisition date — recovered when the overlay has one, otherwise
 * whatever Music.app reported. Everything that sorts or displays "date added"
 * reads this key, so the graft is invisible to consumers.
 */
export const DATE_ADDED_KEY = 'dateAdded';
/** What Music.app itself reported this run. Always written, recovered or not. */
export const DATE_ADDED_REPORTED_KEY = 'dateAddedReported';
/** 'recovered' when the overlay supplied the date, else 'reported'. */
export const DATE_ADDED_ORIGIN_KEY = 'dateAddedOrigin';

export interface OverlayEntry {
  dateAdded: string;
  matchMethod: string;
}

const MEDIA_ROOT = '/Media.localized/';

/**
 * The stable identity of a track file across machines: its path below the
 * media root, with the extra `Music/` level the current library adds removed.
 *
 * Old library:  file:///Users/lucas/Music/Music/Media.localized/Artist/Album/01 Track.m4a
 * New library:  file:///Users/luke/Music/Music/Media.localized/Music/Artist/Album/01 Track.m4a
 * Both key as:  Artist/Album/01 Track.m4a
 *
 * NFC-normalized because the two exports disagree on how they encode accented
 * characters, which is otherwise a silent miss on a few hundred tracks.
 */
export function mediaPathKey(location: string): string {
  const decoded = decodeURIComponent(location).replace(/^file:\/\//, '');
  const i = decoded.indexOf(MEDIA_ROOT);
  const below = i >= 0 ? decoded.slice(i + MEDIA_ROOT.length) : decoded;
  return below.replace(/^Music\//, '').normalize('NFC');
}

/** Whole overlay as a lookup. Small enough (a few thousand rows) to hold. */
export function loadDateOverlay(db: Database): Map<string, OverlayEntry> {
  const rows = db
    .prepare('SELECT media_path, date_added, match_method FROM date_added_overlay')
    .all() as { media_path: string; date_added: string; match_method: string }[];
  return new Map(
    rows.map((r) => [r.media_path, { dateAdded: r.date_added, matchMethod: r.match_method }]),
  );
}
