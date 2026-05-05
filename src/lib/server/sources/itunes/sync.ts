import { createHash } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { parseITunesLibrary, type ITunesTrack } from './parse';
import type { SourceRelease, SourceTrack, SyncResult } from '../types';

function squashAlphanumLower(s: string): string {
  return s.normalize('NFD').replace(/\p{Diacritic}+/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function albumGroupKey(t: ITunesTrack): string | null {
  const album = t.album?.trim();
  if (!album) return null;
  const artist = (t.albumArtist ?? t.artist).trim();
  if (!artist) return null;
  const year = t.year ?? 0;
  return `${squashAlphanumLower(artist)}|${squashAlphanumLower(album)}|${year}`;
}

function syntheticReleaseId(groupKey: string): string {
  const h = createHash('sha1').update(groupKey).digest('hex').slice(0, 12);
  return `itunes-album:${h}`;
}

export async function syncITunesLibrary(): Promise<SyncResult> {
  const xmlPath = env.ITUNES_XML_PATH;
  if (!xmlPath) {
    throw new Error(
      'ITUNES_XML_PATH not set in .env — point at your Music.app Library.xml export',
    );
  }

  const lib = parseITunesLibrary(xmlPath);

  // Group tracks by album.
  const groups = new Map<string, { groupKey: string; tracks: ITunesTrack[] }>();
  for (const t of lib.tracks) {
    const groupKey = albumGroupKey(t);
    if (!groupKey) continue;
    const id = syntheticReleaseId(groupKey);
    let g = groups.get(id);
    if (!g) {
      g = { groupKey, tracks: [] };
      groups.set(id, g);
    }
    g.tracks.push(t);
  }

  const releases: SourceRelease[] = [];
  for (const [id, g] of groups) {
    // Use the first track in the group as the representative for release-level fields.
    const rep = g.tracks[0];
    releases.push({
      externalId: id,
      title: rep.album!,
      artist: (rep.albumArtist ?? rep.artist).trim(),
      year: rep.year,
      facets: { trackCount: g.tracks.length },
    });
  }

  const tracks: SourceTrack[] = lib.tracks.map((t) => {
    const groupKey = albumGroupKey(t);
    return {
      externalId: String(t.trackId),
      title: t.name,
      artist: t.artist,
      album: t.album,
      durationMs: t.totalTimeMs,
      position: t.trackNumber != null ? String(t.trackNumber) : undefined,
      filePath: t.location,
      releaseExternalId: groupKey ? syntheticReleaseId(groupKey) : undefined,
      facets: pickDefined({
        rating: t.rating,
        playCount: t.playCount,
        dateAdded: t.dateAdded,
        kind: t.kind,
        bitRate: t.bitRate,
        sampleRate: t.sampleRate,
        genre: t.genre,
      }),
    };
  });

  return { tracks, releases };
}

function pickDefined<T extends Record<string, unknown>>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(o) as (keyof T)[]) {
    if (o[k] !== undefined) out[k] = o[k];
  }
  return out;
}
