/**
 * Reading a file's own tags into Booth's shape.
 *
 * Under the file-owned design the audio files are the record and this database
 * is a rebuildable index, so this reader is what a rebuild reconstructs from.
 * Read-only by design in this slice; the writer arrives with the tag schema.
 */
import { parseFile } from 'music-metadata';

/**
 * Prefix for Booth's own fields — things no standard frame expresses
 * (acquisition date, vetted, Discogs linkage, rip provenance). Containers spell
 * custom fields differently (`TXXX:BOOTH_X` in ID3, `----:com.apple.iTunes:BOOTH_X`
 * in MP4), so lookup is by suffix and callers see the bare name.
 */
export const BOOTH_TAG_PREFIX = 'BOOTH_';

export interface FileTags {
  title?: string;
  artist?: string;
  albumArtist?: string;
  album?: string;
  year?: number;
  trackNumber?: number;
  genre?: string;
  durationMs?: number;
  bpm?: number;
  comment?: string;
  /** 0..100, matching the scale Music.app and Booth's facets already use. */
  rating?: number;
  /** Booth's custom fields, prefix stripped. Empty for a file Booth has not tagged. */
  booth: Record<string, string>;
}

export async function readTags(filePath: string): Promise<FileTags> {
  const meta = await parseFile(filePath, { duration: true, skipCovers: true });
  const c = meta.common;

  const booth: Record<string, string> = {};
  for (const tags of Object.values(meta.native)) {
    for (const tag of tags) {
      const key = boothKey(tag.id);
      if (key && typeof tag.value === 'string') booth[key] = tag.value;
    }
  }

  return {
    title: c.title,
    artist: c.artist,
    albumArtist: c.albumartist,
    album: c.album,
    year: c.year,
    trackNumber: c.track?.no ?? undefined,
    genre: c.genre?.[0],
    durationMs: meta.format.duration != null ? Math.round(meta.format.duration * 1000) : undefined,
    bpm: c.bpm,
    comment: firstComment(c.comment),
    rating: firstRating(c.rating),
    booth,
  };
}

function boothKey(id: string): string | null {
  const i = id.indexOf(BOOTH_TAG_PREFIX);
  return i >= 0 ? id.slice(i + BOOTH_TAG_PREFIX.length) : null;
}

/** music-metadata returns comments as a list of `{ text }`; Booth wants one string. */
function firstComment(comments: { text?: string }[] | undefined): string | undefined {
  return comments?.find((c) => c.text)?.text;
}

/** music-metadata normalises ratings to 0..1; Booth's facets are 0..100 like Music.app's. */
function firstRating(ratings: { rating?: number }[] | undefined): number | undefined {
  const r = ratings?.find((x) => x.rating != null)?.rating;
  return r == null ? undefined : Math.round(r * 100);
}
