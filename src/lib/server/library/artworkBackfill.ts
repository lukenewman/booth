import type { Database } from 'bun:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { matchKey } from './relink';

/**
 * Covers for releases whose files carry none. The local sync only reads art
 * embedded in a file, and two common sources ship without it:
 *
 *  - iTunes Store purchases: Music.app shows a cover from its own cache, which
 *    no export exposes. But each purchased file carries Apple's album id
 *    (`plID`), and Apple's public lookup returns that exact album's artwork —
 *    an exact match, no searching.
 *  - Bandcamp purchases: the fan collection list carries the cover's image id.
 *
 * The image is written under the same cache name the sync's own extractor uses
 * (`itunes-<hash>`), so every later sync finds it there and never refetches.
 * Only releases with no cover are touched; a cover set any other way wins.
 */

export interface ArtworkDeps {
  artworkDir: string;
  /** Apple's album id from a purchased file's tags, or null. */
  appleAlbumId: (filePath: string) => Promise<string | null>;
  fetchJson: (url: string) => Promise<unknown | null>;
  fetchBytes: (url: string) => Promise<{ bytes: Uint8Array; type: string } | null>;
  /** Pause between network requests. */
  delayMs?: number;
}

export function bandcampArtUrl(artId: string): string {
  // _10 is Bandcamp's ~1200px rendition; ids are zero-padded to 10 digits.
  return `https://f4.bcbits.com/img/a${artId.padStart(10, '0')}_10.jpg`;
}

async function appleArtUrl(db: Database, releaseId: string, deps: ArtworkDeps): Promise<string | null> {
  const paths = db.prepare(
    `SELECT m.key_value AS path FROM track t
       JOIN source_facets k ON k.entity_kind = 'track' AND k.entity_id = t.id AND k.source = 'local' AND k.key = 'kind'
       JOIN match_key m ON m.entity_kind = 'track' AND m.entity_id = t.id AND m.key_type = 'file_path'
      WHERE t.release_id = ? AND k.value LIKE '%Purchased%'`,
  ).all(releaseId) as { path: string }[];
  for (const { path } of paths) {
    const id = await deps.appleAlbumId(path);
    if (!id) continue;
    const res = (await deps.fetchJson(`https://itunes.apple.com/lookup?id=${encodeURIComponent(id)}`)) as
      | { results?: { artworkUrl100?: string }[] }
      | null;
    const small = res?.results?.[0]?.artworkUrl100;
    if (small) return large(small);
    // Withdrawn under its original id (Apple often reissues under a new one).
    return appleSearchArtUrl(db, releaseId, deps);
  }
  return null;
}

// Apple serves any size from the same path; 1000px matches what the store shows.
const large = (url: string) => url.replace(/\/\d+x\d+bb\.(jpg|png)$/, '/1000x1000bb.$1');

const SINGLE_OR_EP = /\s+-\s+(Single|EP)$/i;
const titleKey = (s: string) => matchKey(s.replace(SINGLE_OR_EP, ''));

/**
 * Name search for a purchase Apple withdrew. Accepts only a single result
 * whose artist and title match exactly (case and punctuation aside, a trailing
 * " - Single"/" - EP" ignored). Edition tags are NOT stripped: a "2022
 * Remastered" or "20th Anniversary Edition" reissue is a different record and
 * often a different cover — searching "LOVEBEAT" finds both the original and a
 * 2021 remaster.
 */
async function appleSearchArtUrl(db: Database, releaseId: string, deps: ArtworkDeps): Promise<string | null> {
  const rel = db.prepare(
    `SELECT a.name AS artist, r.title FROM release r JOIN artist a ON a.id = r.artist_id WHERE r.id = ?`,
  ).get(releaseId) as { artist: string; title: string } | null;
  if (!rel) return null;
  const various = /^various( artists)?$/i.test(rel.artist.trim());
  const term = `${various ? '' : rel.artist} ${rel.title.replace(SINGLE_OR_EP, '')}`.trim();
  const res = (await deps.fetchJson(
    `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=album&limit=25`,
  )) as { results?: { artistName?: string; collectionName?: string; artworkUrl100?: string }[] } | null;
  const hits = (res?.results ?? []).filter(
    (x) =>
      x.collectionName && x.artistName && x.artworkUrl100 &&
      titleKey(x.collectionName) === titleKey(rel.title) &&
      (various ? /various/i.test(x.artistName) : matchKey(x.artistName) === matchKey(rel.artist)),
  );
  return hits.length === 1 ? large(hits[0].artworkUrl100!) : null;
}

export async function backfillArtwork(
  db: Database,
  deps: ArtworkDeps,
): Promise<{ apple: number; bandcamp: number; missing: number }> {
  const candidates = db.prepare(
    `SELECT r.id, l.external_id AS ext FROM release r
       JOIN source_link l ON l.entity_kind = 'release' AND l.entity_id = r.id AND l.source = 'local'
      WHERE r.thumb_url IS NULL AND r.cover_override IS NULL AND l.external_id LIKE 'itunes-album:%'`,
  ).all() as { id: string; ext: string }[];
  const set = db.prepare(`UPDATE release SET thumb_url = ?, cover_url = ? WHERE id = ? AND thumb_url IS NULL`);
  const bcArt = db.prepare(`SELECT art_id FROM bandcamp_item WHERE release_id = ? AND art_id IS NOT NULL LIMIT 1`);
  const out = { apple: 0, bandcamp: 0, missing: 0 };

  for (const c of candidates) {
    let url: string | null = null;
    let from: 'apple' | 'bandcamp' | null = null;
    try {
      url = await appleArtUrl(db, c.id, deps);
      if (url) from = 'apple';
      else {
        const bc = bcArt.get(c.id) as { art_id: string } | null;
        if (bc) { url = bandcampArtUrl(bc.art_id); from = 'bandcamp'; }
      }
      const img = url ? await deps.fetchBytes(url) : null;
      if (!img || !from) { out.missing++; continue; }
      const ext = img.type === 'image/png' ? 'png' : 'jpg';
      const name = `itunes-${c.ext.replace('itunes-album:', '')}.${ext}`;
      mkdirSync(deps.artworkDir, { recursive: true });
      writeFileSync(join(deps.artworkDir, name), img.bytes);
      set.run(`/api/artwork/${name}`, `/api/artwork/${name}`, c.id);
      out[from]++;
    } catch (e) {
      console.warn('[artwork] backfill failed for', c.id, e instanceof Error ? e.message : e);
      out.missing++;
    }
    if (url && deps.delayMs) await Bun.sleep(deps.delayMs);
  }
  return out;
}
