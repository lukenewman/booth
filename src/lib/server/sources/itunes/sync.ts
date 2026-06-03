import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseFile as parseAudioFile } from 'music-metadata';
import { env } from '$env/dynamic/private';
import { parseITunesLibrary, type ITunesTrack } from './parse';
import type { SourceRelease, SourceTrack, SyncResult } from '../types';

const artworkDir = join(homedir(), '.booth', 'artwork');

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
  // Process in parallel batches to keep sync fast without overwhelming the FS.
  const groupEntries = [...groups.entries()];
  const BATCH = 20;
  for (let i = 0; i < groupEntries.length; i += BATCH) {
    await Promise.all(
      groupEntries.slice(i, i + BATCH).map(async ([id, g]) => {
        const rep = g.tracks[0];
        const release: SourceRelease = {
          externalId: id,
          title: rep.album!,
          artist: (rep.albumArtist ?? rep.artist).trim(),
          year: rep.year,
          facets: { trackCount: g.tracks.length },
        };
        // Extract the sha1 hash portion from "itunes-album:{hash}" for the cache filename.
        const hash = id.replace('itunes-album:', '');
        const artworkUrls = await extractArtwork(rep.location, hash);
        if (artworkUrls) {
          release.thumbUrl = artworkUrls.thumbUrl;
          release.coverUrl = artworkUrls.coverUrl;
        }
        releases.push(release);
      }),
    );
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

/**
 * Read embedded cover art from an audio file and cache it to ~/.booth/artwork/.
 * Returns the local API URLs for the cached image, or null if no artwork found.
 * Skips file I/O on subsequent calls when the cache file already exists.
 */
async function extractArtwork(
  location: string,
  hash: string,
): Promise<{ thumbUrl: string; coverUrl: string } | null> {
  try {
    const ext = cachedArtworkExt(hash);
    if (ext) {
      const url = `/api/artwork/itunes-${hash}.${ext}`;
      return { thumbUrl: url, coverUrl: url };
    }

    const filePath = decodeURIComponent(new URL(location).pathname);
    const metadata = await parseAudioFile(filePath, { duration: false, skipCovers: false });
    const picture = metadata.common.picture?.[0];
    if (!picture) return null;

    const imgExt = picture.format === 'image/png' ? 'png' : 'jpg';
    mkdirSync(artworkDir, { recursive: true });
    writeFileSync(join(artworkDir, `itunes-${hash}.${imgExt}`), picture.data);

    const url = `/api/artwork/itunes-${hash}.${imgExt}`;
    return { thumbUrl: url, coverUrl: url };
  } catch {
    return null;
  }
}

/** Returns the extension of an already-cached artwork file, or null if not cached. */
function cachedArtworkExt(hash: string): string | null {
  for (const ext of ['jpg', 'png']) {
    if (existsSync(join(artworkDir, `itunes-${hash}.${ext}`))) return ext;
  }
  return null;
}
