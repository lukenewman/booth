import type { Database } from 'bun:sqlite';
import { discogsFetch, DiscogsError } from './api';

export interface MatchTracksResult {
  releasesProcessed: number;
  tracksMatched: number;
  tracksSkipped: number;
  tracksUnmatched: number;
}

interface DiscogsTrackItem {
  position: string;
  type_: string;
  title: string;
  duration?: string;
}

interface DiscogsReleaseDetail {
  tracklist?: DiscogsTrackItem[];
}

function parseDurationMs(s: string | undefined): number | null {
  if (!s) return null;
  const parts = s.split(':').map(Number);
  if (parts.some(isNaN)) return null;
  if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
  if (parts.length === 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
  return null;
}

function squash(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{Diacritic}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function titlesMatch(a: string, b: string): boolean {
  const sa = squash(a);
  const sb = squash(b);
  if (sa === sb) return true;
  if (sa.length > 3 && sb.includes(sa)) return true;
  if (sb.length > 3 && sa.includes(sb)) return true;
  return false;
}

function durationClose(msA: number | null, msB: number | null): boolean {
  if (msA == null || msB == null) return false;
  return Math.abs(msA - msB) <= 5000;
}

/**
 * For each release that has both a Discogs source_link and at least one iTunes
 * track, fetch the Discogs tracklist and add a Discogs source_link to each
 * iTunes track entity we can confidently match.
 *
 * Match strategy (in order of confidence):
 *   1. Sequential tracklist position — the 1-based index among type_='track'
 *      items in the Discogs tracklist equals the iTunes track number. Covers
 *      vinyl (A1/B2/…) and numeric positions equally.
 *   2. Title similarity — squash-alphanum comparison, allowing one string to
 *      contain the other (handles "(feat. …)" suffixes etc.), boosted by
 *      duration match (±5 s).
 *
 * Respects the Discogs rate limit (~60 req/min) by sleeping 1.1 s between
 * release-level fetches.
 */
export async function matchDiscogsTracks(db: Database): Promise<MatchTracksResult> {
  const result: MatchTracksResult = {
    releasesProcessed: 0,
    tracksMatched: 0,
    tracksSkipped: 0,
    tracksUnmatched: 0,
  };

  // Releases that have a Discogs entry AND at least one iTunes track.
  const candidates = db
    .prepare(
      `SELECT r.id AS release_id, sl.external_id AS discogs_release_id
         FROM release r
         INNER JOIN source_link sl
           ON sl.entity_kind = 'release' AND sl.entity_id = r.id AND sl.source = 'discogs'
         WHERE EXISTS (
           SELECT 1 FROM track t
           INNER JOIN source_link sl2
             ON sl2.entity_kind = 'track' AND sl2.entity_id = t.id AND sl2.source = 'itunes'
           WHERE t.release_id = r.id
         )`,
    )
    .all() as Array<{ release_id: string; discogs_release_id: string }>;

  for (const { release_id, discogs_release_id } of candidates) {
    // iTunes tracks for this release, ordered by track number.
    const itunesTracks = db
      .prepare(
        `SELECT t.id, t.title, t.position, t.duration_ms
           FROM track t
           INNER JOIN source_link sl
             ON sl.entity_kind = 'track' AND sl.entity_id = t.id AND sl.source = 'itunes'
           WHERE t.release_id = ?
           ORDER BY CAST(t.position AS INTEGER) ASC`,
      )
      .all(release_id) as Array<{
      id: string;
      title: string;
      position: string | null;
      duration_ms: number | null;
    }>;

    if (itunesTracks.length === 0) continue;

    // Partition into already-linked (skip) and unlinked (need matching).
    const alreadyLinked = new Set<string>(
      (
        db
          .prepare(
            `SELECT t.id FROM track t
               INNER JOIN source_link sl
                 ON sl.entity_kind = 'track' AND sl.entity_id = t.id AND sl.source = 'discogs'
               WHERE t.release_id = ?`,
          )
          .all(release_id) as Array<{ id: string }>
      ).map((r) => r.id),
    );

    result.tracksSkipped += alreadyLinked.size;
    const unlinked = itunesTracks.filter((t) => !alreadyLinked.has(t.id));
    if (unlinked.length === 0) continue;

    // Fetch Discogs tracklist.
    let detail: DiscogsReleaseDetail;
    try {
      detail = (await discogsFetch(`/releases/${discogs_release_id}`)) as DiscogsReleaseDetail;
    } catch (err) {
      if (err instanceof DiscogsError && err.payload.error === 'rate_limited') {
        const wait = ((err.payload as { retryAfter?: number }).retryAfter ?? 60) * 1000;
        await sleep(wait);
        try {
          detail = (await discogsFetch(`/releases/${discogs_release_id}`)) as DiscogsReleaseDetail;
        } catch {
          result.tracksUnmatched += unlinked.length;
          continue;
        }
      } else {
        result.tracksUnmatched += unlinked.length;
        continue;
      }
    }

    const tracklist = (detail.tracklist ?? []).filter((t) => t.type_ === 'track');
    if (tracklist.length === 0) {
      result.tracksUnmatched += unlinked.length;
      continue;
    }

    result.releasesProcessed++;

    // Set of 0-based Discogs tracklist indices already claimed this release.
    const discogsUsed = new Set<number>();
    // Set of iTunes track IDs matched in pass 1 (so pass 2 can skip them).
    const matchedInPass1 = new Set<string>();

    // --- Pass 1: sequential-position match ---
    for (const it of unlinked) {
      const trackNum = it.position ? parseInt(it.position, 10) : NaN;
      if (isNaN(trackNum) || trackNum < 1 || trackNum > tracklist.length) continue;

      const idx = trackNum - 1;
      if (discogsUsed.has(idx)) continue;

      writeLink(db, it.id, discogs_release_id, idx, tracklist[idx]);
      discogsUsed.add(idx);
      matchedInPass1.add(it.id);
      result.tracksMatched++;
    }

    // --- Pass 2: title-similarity fallback for tracks not matched by position ---
    for (const it of unlinked) {
      if (matchedInPass1.has(it.id)) continue;

      let bestIdx = -1;
      let bestScore = 0;

      for (let i = 0; i < tracklist.length; i++) {
        if (discogsUsed.has(i)) continue;
        const dt = tracklist[i];
        let score = 0;
        if (titlesMatch(it.title, dt.title)) score += 2;
        if (score > 0 && durationClose(it.duration_ms, parseDurationMs(dt.duration))) score += 1;
        if (score > bestScore) {
          bestScore = score;
          bestIdx = i;
        }
      }

      if (bestIdx === -1 || bestScore < 2) {
        result.tracksUnmatched++;
        continue;
      }

      writeLink(db, it.id, discogs_release_id, bestIdx, tracklist[bestIdx]);
      discogsUsed.add(bestIdx);
      result.tracksMatched++;
    }

    // Respect rate limit: ~1 req/s.
    await sleep(1100);
  }

  return result;
}

function writeLink(
  db: Database,
  itunesTrackId: string,
  discogsReleaseId: string,
  idx: number,
  discogsTrack: DiscogsTrackItem,
): void {
  const externalId = `${discogsReleaseId}-t${idx + 1}`;
  const externalUrl = `https://www.discogs.com/release/${discogsReleaseId}`;

  // Conflict: a different iTunes track entity already owns this Discogs external_id.
  const conflict = db
    .prepare(
      `SELECT entity_id FROM source_link
         WHERE entity_kind='track' AND source='discogs' AND external_id=?`,
    )
    .get(externalId) as { entity_id: string } | undefined;
  if (conflict && conflict.entity_id !== itunesTrackId) return;

  // Conflict: this iTunes track entity already has a different Discogs external_id.
  const existingForEntity = db
    .prepare(
      `SELECT external_id FROM source_link
         WHERE entity_kind='track' AND entity_id=? AND source='discogs'`,
    )
    .get(itunesTrackId) as { external_id: string } | undefined;
  if (existingForEntity && existingForEntity.external_id !== externalId) return;

  db.prepare(
    `INSERT INTO source_link (entity_kind, entity_id, source, external_id, external_url, match_method)
     VALUES ('track', ?, 'discogs', ?, ?, 'release_position')
     ON CONFLICT(entity_kind, source, external_id) DO UPDATE SET
       entity_id    = excluded.entity_id,
       external_url = excluded.external_url,
       match_method = excluded.match_method`,
  ).run(itunesTrackId, externalId, externalUrl);

  // Store the Discogs position string as a facet so the UI can show it.
  db.prepare(
    `INSERT INTO source_facets (entity_kind, entity_id, source, key, value)
     VALUES ('track', ?, 'discogs', 'position', ?)
     ON CONFLICT(entity_kind, entity_id, source, key) DO UPDATE SET
       value      = excluded.value,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  ).run(itunesTrackId, JSON.stringify(discogsTrack.position));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
