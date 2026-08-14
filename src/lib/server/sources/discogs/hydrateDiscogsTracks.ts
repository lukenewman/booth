import { ulid } from 'ulid';
import type { Database } from 'bun:sqlite';
import { discogsFetch, DiscogsError } from './api';
import { upsertArtist, upsertSourceLink, upsertMatchKey, upsertFacets } from '../../library/collate';
import type { CollateSummary } from '../../library/collate';

export interface HydrationResult {
  releasesProcessed: number;
  tracksAdded: number;
}

interface DiscogsTracklistItem {
  position: string;
  type_: string;
  title: string;
  duration?: string;
}

interface DiscogsReleaseDetail {
  tracklist?: DiscogsTracklistItem[];
  artists?: { name: string }[];
  title?: string;
}

function parseDurationMs(s: string | undefined): number | null {
  if (!s) return null;
  const parts = s.split(':').map(Number);
  if (parts.some(isNaN)) return null;
  if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
  if (parts.length === 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
  return null;
}

/**
 * Fetch and store Discogs tracklists for releases that don't yet have Discogs
 * track rows.  When `releases` is provided, only those releases are processed
 * (used by the add flow to hydrate a single newly-added release immediately).
 * When omitted, all Discogs releases without tracks are processed.
 *
 * Tracks are merged with existing iTunes entities where possible:
 *   1. release_position match_key — found after an iTunes sync has run
 *   2. direct iTunes entity lookup — handles initial migration where iTunes
 *      entities predate release_position keys
 *   3. new entity — Discogs-only release, or no matching iTunes track found
 *
 * Writes ~1 Discogs API request per release; respects the 60 req/min rate
 * limit by sleeping 1.1 s between fetches.
 */
export async function hydrateDiscogsTracks(
  db: Database,
  releases?: Array<{ discogsReleaseId: string; releaseEntityId: string }>,
): Promise<HydrationResult> {
  const result: HydrationResult = { releasesProcessed: 0, tracksAdded: 0 };

  const targets =
    releases ??
    (db
      .prepare(
        `SELECT sl.external_id AS discogs_release_id, sl.entity_id AS release_entity_id
           FROM source_link sl
           WHERE sl.entity_kind = 'release' AND sl.source = 'discogs'
             AND NOT EXISTS (
               SELECT 1 FROM track t
               INNER JOIN source_link sl2
                 ON sl2.entity_kind = 'track' AND sl2.entity_id = t.id AND sl2.source = 'discogs'
               WHERE t.release_id = sl.entity_id
             )`,
      )
      .all() as Array<{ discogs_release_id: string; release_entity_id: string }>).map((r) => ({
      discogsReleaseId: r.discogs_release_id,
      releaseEntityId: r.release_entity_id,
    }));

  for (const { discogsReleaseId, releaseEntityId } of targets) {
    let detail: DiscogsReleaseDetail;
    try {
      detail = (await discogsFetch(`/releases/${discogsReleaseId}`)) as DiscogsReleaseDetail;
    } catch (err) {
      if (err instanceof DiscogsError && err.payload.error === 'rate_limited') {
        const wait = ((err.payload as { retryAfter?: number }).retryAfter ?? 60) * 1000;
        await sleep(wait);
        try {
          detail = (await discogsFetch(`/releases/${discogsReleaseId}`)) as DiscogsReleaseDetail;
        } catch {
          continue;
        }
      } else {
        continue;
      }
    }

    const tracklist = (detail.tracklist ?? []).filter((t) => t.type_ === 'track');
    if (tracklist.length === 0) continue;

    // Resolve artist name from the release row for tracks that need a new entity.
    const releaseRow = db
      .prepare(`SELECT r.title, a.name AS artist FROM release r JOIN artist a ON a.id = r.artist_id WHERE r.id = ?`)
      .get(releaseEntityId) as { title: string; artist: string } | undefined;
    const releaseArtist = releaseRow?.artist ?? '(unknown)';
    const releaseTitle = releaseRow?.title ?? '';

    const artistCache = new Map<string, string>();
    const miniSummary: CollateSummary = {
      rowsIn: 0,
      releasesUpserted: 0,
      tracksUpserted: 0,
      releasesDeleted: 0,
      tracksDeleted: 0,
      conflicts: 0,
      relinked: 0,
    };

    const tx = db.transaction(() => {
      for (let idx = 0; idx < tracklist.length; idx++) {
        const item = tracklist[idx];
        const sequentialPos = idx + 1; // 1-based, matches iTunes trackNumber
        const externalId = `${discogsReleaseId}-t${sequentialPos}`;
        const externalUrl = `https://www.discogs.com/release/${discogsReleaseId}`;

        // Skip if this external_id is already linked.
        const alreadyLinked = db
          .prepare(
            `SELECT 1 FROM source_link WHERE entity_kind='track' AND source='discogs' AND external_id=?`,
          )
          .get(externalId);
        if (alreadyLinked) continue;

        const posKey = `${releaseEntityId}:${sequentialPos}`;

        // 1. release_position match_key (set by collate after an iTunes sync).
        let entityId: string | undefined;
        const byPosKey = db
          .prepare(
            `SELECT entity_id FROM match_key
               WHERE entity_kind='track' AND key_type='release_position' AND key_value=?`,
          )
          .get(posKey) as { entity_id: string } | undefined;
        if (byPosKey) entityId = byPosKey.entity_id;

        // 2. Direct local (Apple-origin) entity lookup — handles pre-feature
        //    entities that have numeric positions but no release_position
        //    match_key yet.
        if (!entityId) {
          const direct = db
            .prepare(
              `SELECT t.id FROM track t
                 INNER JOIN source_link sl
                   ON sl.entity_kind='track' AND sl.entity_id=t.id AND sl.source='local'
                 WHERE t.release_id = ? AND CAST(t.position AS INTEGER) = ?
                 LIMIT 1`,
            )
            .get(releaseEntityId, sequentialPos) as { id: string } | undefined;
          if (direct) entityId = direct.id;
        }

        if (entityId) {
          // Merge: add Discogs source_link to the existing entity and write the
          // release_position key so subsequent syncs skip the direct lookup.
          upsertSourceLink(db, 'track', entityId, 'discogs', externalId, externalUrl, 'release_position', miniSummary);
          upsertMatchKey(db, 'track', entityId, 'release_position', posKey);
          upsertFacets(db, 'track', entityId, 'discogs', { discogsPosition: item.position });
        } else {
          // New entity: this track has no iTunes counterpart yet.
          const artistId = upsertArtist(db, releaseArtist, artistCache);
          const newId = ulid();
          db.prepare(
            `INSERT INTO track (id, title, artist_id, album, duration_ms, release_id, position)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            newId,
            item.title,
            artistId,
            releaseTitle,
            parseDurationMs(item.duration),
            releaseEntityId,
            String(sequentialPos),
          );
          upsertSourceLink(db, 'track', newId, 'discogs', externalId, externalUrl, 'release_position', miniSummary);
          upsertMatchKey(db, 'track', newId, 'release_position', posKey);
          upsertFacets(db, 'track', newId, 'discogs', { discogsPosition: item.position });
        }

        result.tracksAdded++;
      }
    });

    tx();
    result.releasesProcessed++;

    if (targets.length > 1) {
      // Rate limit only when processing multiple releases; single-release
      // add-flow calls don't need the delay.
      await sleep(1100);
    }
  }

  return result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
