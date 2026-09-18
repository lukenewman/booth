import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { sanitizeName } from '../../recording/paths';

/**
 * Pure path and readiness helpers for the drop folder. No `$env`, no fs — the
 * caller resolves roots (see ./ingest_env) and supplies the directory listing,
 * which keeps every rule here testable under plain bun.
 */

/**
 * Extensions Booth will ingest. Deliberately a closed list rather than "not an
 * image": a drop folder collects sidecar files — cue sheets, logs, artwork,
 * Finder droppings — and guessing at the ones we don't know about is how a
 * text file ends up as a track.
 */
const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set([
  '.mp3',
  '.m4a',
  '.aac',
  '.flac',
  '.wav',
  '.aiff',
  '.aif',
  '.ogg',
  '.opus',
]);

export function isAudioFile(path: string): boolean {
  // extname takes the LAST extension, so "song.mp3.part" reads as ".part" and
  // is correctly rejected — a download in progress must not look ingestible.
  return AUDIO_EXTENSIONS.has(extname(path).toLowerCase());
}

/** Where files are dropped. Emptied by ingest; never the library itself. */
export function defaultInboxRoot(): string {
  return join(homedir(), '.booth', 'inbox');
}

/** Where ingested files live afterwards. Booth owns the layout under here. */
export function defaultLibraryRoot(): string {
  return join(homedir(), '.booth', 'library');
}

export interface IngestTags {
  albumArtist?: string;
  artist?: string;
  album?: string;
  title?: string;
  trackNumber?: number;
}

/**
 * A file is ready when two consecutive scans saw it at the same size.
 *
 * The alternative — reacting the moment a file appears — imports whatever has
 * landed so far, which for a large FLAC over a network share is a truncated
 * track that then has to be noticed and re-done by hand. Waiting one scan costs
 * nothing, because nobody is watching the folder for the file to vanish.
 *
 * Empty files are never ready: a zero-byte file is stable in exactly the same
 * way as a finished one, and is never a track.
 */
export function pickStable(
  previous: ReadonlyMap<string, number>,
  current: ReadonlyMap<string, number>,
): string[] {
  const ready: string[] = [];
  for (const [path, size] of current) {
    if (size <= 0) continue;
    if (previous.get(path) === size) ready.push(path);
  }
  return ready.sort();
}

/**
 * Where a file lands: `<root>/<album artist>/<album>/<NN> <title>.<ext>`.
 *
 * Album artist rather than track artist, so a compilation stays in one folder
 * instead of scattering across its guests. Every segment is sanitized — tags
 * are arbitrary user data, and an album tagged "A/B" would otherwise silently
 * create a directory level, while "../.." would escape the root entirely.
 */
export function ingestTargetPath(root: string, tags: IngestTags, sourcePath: string): string {
  const ext = extname(sourcePath);
  const artist = segment(tags.albumArtist ?? tags.artist, 'Unknown Artist');
  const album = segment(tags.album, 'Unknown Album');
  const title = segment(tags.title, basename(sourcePath, ext));
  // No number rather than "00": an untracked single is not track zero.
  const prefix = tags.trackNumber != null ? `${String(tags.trackNumber).padStart(2, '0')} ` : '';
  return join(root, artist, album, `${prefix}${title}${ext}`);
}

/** Sanitize one path segment, falling back when the tag is missing or unusable. */
function segment(value: string | undefined, fallback: string): string {
  const cleaned = sanitizeName((value ?? '').replace(/[/\\]/g, '_'));
  // A name of dots is a traversal, not a name.
  if (!cleaned || /^\.+$/.test(cleaned)) return sanitizeName(fallback) || fallback;
  return cleaned;
}

/**
 * First unused variant of `path`, counting up. Ingest must never overwrite:
 * two different recordings legitimately share artist, album and title (a
 * remaster, a live take), and the loser of a clobber is gone for good.
 */
export function dedupePath(path: string, exists: (p: string) => boolean): string {
  if (!exists(path)) return path;
  const ext = extname(path);
  const stem = path.slice(0, path.length - ext.length);
  for (let n = 2; n < 1000; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!exists(candidate)) return candidate;
  }
  throw new Error(`cannot find a free name for ${path}`);
}
