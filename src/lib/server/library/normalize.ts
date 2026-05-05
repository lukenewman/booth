function stripDiacritics(s: string): string {
  return s.normalize('NFD').replace(/\p{Diacritic}+/gu, '');
}

function squashAlphanumLower(s: string): string {
  return stripDiacritics(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
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
  const b = squashAlphanumLower(args.album);
  if (!a || !b) return null;
  return `${a}|${b}|${args.year}`;
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
