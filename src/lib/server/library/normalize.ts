function stripDiacritics(s: string): string {
  return s.normalize('NFD').replace(/\p{Diacritic}+/gu, '');
}

function squashAlphanumLower(s: string): string {
  return stripDiacritics(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * A trailing "(Reissue)", "(Full Album)", "(2009 Remaster)" or
 * "(25th Anniversary Edition)" is how Bandcamp and Apple tag an edition — it is
 * not part of the album name and never reaches the Discogs side, so left in
 * the key it split Jubiiilæum, both Felbm tapes and Homework from their Discogs
 * copies. Only groups *ending* in one of those words go; "(Remixes)", "(Edit)"
 * and a catalogue number name a different record and stay. A title that is
 * nothing but the tag is left alone.
 */
const EDITION_TAG = /\s*[([][^()[\]]*\b(?:re-?issue|re-?master(?:ed)?|full album|edition)[)\]]\s*$/i;

export function stripEditionTags(album: string): string {
  let out = album;
  for (;;) {
    const next = out.replace(EDITION_TAG, '');
    if (next === out || next.trim() === '') return out;
    out = next;
  }
}

/**
 * Match-key for cross-source release matching.
 * Returns null when year is missing — we do not match year-less releases.
 */
export function normalizeArtistAlbumYear(args: {
  artist: string;
  album: string;
  year?: number | null;
}): string | null {
  if (args.year == null) return null;
  const a = squashAlphanumLower(args.artist);
  const b = squashAlphanumLower(stripEditionTags(args.album));
  if (!a || !b) return null;
  return `${a}|${b}|${args.year}`;
}

/**
 * Match-key for cross-source artist matching.
 * Returns null for empty / whitespace-only names (caller falls back to the
 * "(unknown)" sentinel artist).
 */
export function normalizeArtistName(name: string): string | null {
  const n = squashAlphanumLower(name);
  return n || null;
}

/**
 * Match-key for cross-source track matching via filesystem path.
 * Decodes file:// URLs (Apple Music.app's Library.xml uses them).
 */
export function normalizeFilePath(input: string): string {
  let p = input;
  if (p.startsWith('file://')) {
    p = decodeURIComponent(p.slice('file://'.length));
  } else {
    try {
      p = decodeURIComponent(p);
    } catch {
      // already decoded
    }
  }
  return p.replace(/\/$/, '');
}

/**
 * Weaker match-key for cross-source release matching, consulted only after
 * `artist_album_year` misses.
 *
 * The two sources disagree about what "year" means: a local file carries the
 * album's original release year (from its tags), while Discogs carries the year
 * of the *pressing* sitting in the collection. Any repress therefore splits one
 * album into two entities under the year-bearing key alone.
 *
 * Returns null when artist or album normalizes to empty.
 */
export function normalizeArtistAlbum(args: { artist: string; album: string }): string | null {
  const a = squashAlphanumLower(args.artist);
  const b = squashAlphanumLower(stripEditionTags(args.album));
  if (!a || !b) return null;
  return `${a}|${b}`;
}
