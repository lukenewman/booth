import { readFileSync } from 'node:fs';
import * as plist from 'plist';

export interface ITunesTrack {
  /**
   * Library-local sequence number. NOT stable — Music.app renumbers these when
   * the library is purged or re-exported, so it must never key a source_link.
   * Kept only for diagnostics.
   */
  trackId: number;
  /**
   * Stable per-track identifier that survives re-export, purges and renames.
   * This is what `source_link.external_id` keys on for the local source.
   */
  persistentId?: string;
  name: string;
  artist: string;
  albumArtist?: string;
  album?: string;
  year?: number;
  totalTimeMs?: number;
  trackNumber?: number;
  /** Music.app's own BPM field. Sparse — only ~15% of a typical library carries one. */
  bpm?: number;
  rating?: number;       // 0..100 in iTunes; 100 = 5 stars
  playCount?: number;
  genre?: string;
  kind?: string;
  bitRate?: number;
  sampleRate?: number;
  dateAdded?: string;
  location: string;      // file:// URL — only present for tracks with files on disk
}

export interface ITunesLibrary {
  tracks: ITunesTrack[];
  /** count of entries skipped because they had no Location (cloud-only / DRM-broken) */
  skipped: number;
  /**
   * The `Date` key Music.app stamps into the plist when it writes the export.
   * This is the export's own idea of when it was generated — the honest signal
   * for whether the file is a live export or a frozen snapshot.
   */
  generatedAt?: string;
}

export function parseITunesLibrary(xmlPath: string): ITunesLibrary {
  const raw = readFileSync(xmlPath, 'utf8');
  const parsed = plist.parse(raw) as {
    Tracks?: Record<string, Record<string, unknown>>;
    Date?: Date;
  };
  const tracksDict = parsed.Tracks ?? {};
  const generatedAt = parsed.Date instanceof Date ? parsed.Date.toISOString() : undefined;

  const tracks: ITunesTrack[] = [];
  let skipped = 0;

  for (const id of Object.keys(tracksDict)) {
    const t = tracksDict[id];
    const name = t['Name'] as string | undefined;
    const artist = t['Artist'] as string | undefined;
    const location = t['Location'] as string | undefined;
    if (!name || !artist || !location) {
      skipped++;
      continue;
    }
    tracks.push({
      trackId: Number(id),
      persistentId: t['Persistent ID'] as string | undefined,
      name,
      artist,
      albumArtist: t['Album Artist'] as string | undefined,
      album: t['Album'] as string | undefined,
      year: t['Year'] as number | undefined,
      totalTimeMs: t['Total Time'] as number | undefined,
      trackNumber: t['Track Number'] as number | undefined,
      bpm: t['BPM'] as number | undefined,
      rating: t['Rating'] as number | undefined,
      playCount: t['Play Count'] as number | undefined,
      genre: t['Genre'] as string | undefined,
      kind: t['Kind'] as string | undefined,
      bitRate: t['Bit Rate'] as number | undefined,
      sampleRate: t['Sample Rate'] as number | undefined,
      dateAdded: (t['Date Added'] as Date | undefined)?.toISOString(),
      location,
    });
  }

  return { tracks, skipped, generatedAt };
}
