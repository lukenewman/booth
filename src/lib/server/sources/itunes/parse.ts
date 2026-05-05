import { readFileSync } from 'node:fs';
import * as plist from 'plist';

export interface ITunesTrack {
  trackId: number;
  name: string;
  artist: string;
  albumArtist?: string;
  album?: string;
  year?: number;
  totalTimeMs?: number;
  trackNumber?: number;
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
}

export function parseITunesLibrary(xmlPath: string): ITunesLibrary {
  const raw = readFileSync(xmlPath, 'utf8');
  const parsed = plist.parse(raw) as { Tracks?: Record<string, Record<string, unknown>> };
  const tracksDict = parsed.Tracks ?? {};

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
      name,
      artist,
      albumArtist: t['Album Artist'] as string | undefined,
      album: t['Album'] as string | undefined,
      year: t['Year'] as number | undefined,
      totalTimeMs: t['Total Time'] as number | undefined,
      trackNumber: t['Track Number'] as number | undefined,
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

  return { tracks, skipped };
}
