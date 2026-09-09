import { ulid } from 'ulid';
import type { CollectionWritable, MusicSource } from '../types';
import { syncDiscogsCollection } from './sync';
import { discogsFetch } from './api';
import { getUsername } from './username';
import { env } from '$lib/server/env';
import { getDb } from '../../db';
import { normalizeArtistAlbum, normalizeArtistAlbumYear } from '../../library/normalize';
import { resolveReleaseEntity, upsertArtist, upsertMatchKey } from '../../library/collate';

const FOLDER_ID = env.DISCOGS_FOLDER_ID ?? '1';

interface DiscogsAddResponse {
  instance_id: number;
}

export const discogsSource: MusicSource & CollectionWritable = {
  id: 'discogs',
  name: 'Discogs',
  contributes: ['release', 'track'],
  sync: syncDiscogsCollection,

  async addToCollection({ entityId }) {
    const db = getDb();
    const link = db
      .prepare(
        `SELECT external_id FROM source_link
          WHERE entity_kind='release' AND entity_id=? AND source='discogs'`,
      )
      .get(entityId) as { external_id: string } | undefined;
    if (!link) {
      throw new Error(`no discogs source_link for entity ${entityId}`);
    }

    const username = await getUsername();
    const data = (await discogsFetch(
      `/users/${encodeURIComponent(username)}/collection/folders/${FOLDER_ID}/releases/${link.external_id}`,
      { method: 'POST' },
    )) as DiscogsAddResponse;

    return { externalId: link.external_id, instanceId: String(data.instance_id) };
  },

  async removeFromCollection({ entityId, instanceId }) {
    const db = getDb();
    const link = db
      .prepare(
        `SELECT external_id FROM source_link
          WHERE entity_kind='release' AND entity_id=? AND source='discogs'`,
      )
      .get(entityId) as { external_id: string } | undefined;
    if (!link) {
      throw new Error(`no discogs source_link for entity ${entityId}`);
    }
    if (instanceId == null) {
      throw new Error('instanceId required for discogs.removeFromCollection');
    }

    const username = await getUsername();
    await discogsFetch(
      `/users/${encodeURIComponent(username)}/collection/folders/${FOLDER_ID}/releases/${link.external_id}/instances/${instanceId}`,
      { method: 'DELETE' },
    );

    db.prepare(
      `DELETE FROM source_link
        WHERE entity_kind='release' AND entity_id=? AND source='discogs'`,
    ).run(entityId);
    // Drop orphan release if no other source still references it.
    const stillReferenced = db
      .prepare(`SELECT 1 FROM source_link WHERE entity_kind='release' AND entity_id=? LIMIT 1`)
      .get(entityId);
    if (!stillReferenced) {
      db.prepare('DELETE FROM release WHERE id=?').run(entityId);
      db.prepare(
        `DELETE FROM match_key WHERE entity_kind='release' AND entity_id=?`,
      ).run(entityId);
      db.prepare(
        `DELETE FROM source_facets WHERE entity_kind='release' AND entity_id=?`,
      ).run(entityId);
    }
  },
};

/**
 * Ensure a release entity exists for a Discogs release the user is about to add.
 *
 * Resolution order mirrors a sync (`resolveReleaseEntity`): an existing Discogs
 * link wins, then the artist/album/year match keys. Only when nothing matches is
 * a new entity minted.
 *
 * This path used to skip the match-key step and mint an entity unconditionally,
 * so adding a record already in the local library produced a second release the
 * two sources could never be joined across — and because the duplicate then
 * owned the Discogs link, every later sync hit the source_link conflict path and
 * left it that way. Fields on a matched entity are only backfilled, never
 * overwritten; the next sync applies Discogs' full opinion the usual way.
 *
 * Returns the entity_id.
 */
export function ensureDiscogsReleaseEntity(args: {
  releaseId: number;
  title: string;
  artist: string;
  year: number | null;
  country: string | null;
  label: string | null;
  catno: string | null;
  thumbUrl: string | null;
  coverUrl: string | null;
}): string {
  const db = getDb();
  const externalId = String(args.releaseId);
  const existing = db
    .prepare(
      `SELECT entity_id FROM source_link
        WHERE entity_kind='release' AND source='discogs' AND external_id=?`,
    )
    .get(externalId) as { entity_id: string } | undefined;
  if (existing) return existing.entity_id;

  const writeFacets = (entityId: string) => {
    const facets: Record<string, unknown> = {};
    if (args.thumbUrl) facets.thumb = args.thumbUrl;
    if (args.coverUrl) facets.coverImage = args.coverUrl;
    for (const [k, v] of Object.entries(facets)) {
      db.prepare(
        `INSERT INTO source_facets (entity_kind, entity_id, source, key, value)
         VALUES ('release', ?, 'discogs', ?, ?)
         ON CONFLICT(entity_kind, entity_id, source, key) DO UPDATE SET
           value      = excluded.value,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      ).run(entityId, k, JSON.stringify(v));
    }
  };

  const looseKey = normalizeArtistAlbum({ artist: args.artist, album: args.title });

  const matched = resolveReleaseEntity(db, {
    artist: args.artist,
    album: args.title,
    year: args.year,
  });

  // One entity holds at most one link per source. If the match already carries a
  // *different* Discogs release, this is a second pressing of the same album —
  // something the data model has no way to express — so it gets its own entity
  // rather than silently displacing the pressing already linked.
  const matchTaken =
    matched != null &&
    db
      .prepare(
        `SELECT 1 FROM source_link
          WHERE entity_kind='release' AND entity_id=? AND source='discogs'`,
      )
      .get(matched.entityId) != null;

  if (matched && !matchTaken) {
    const tx = db.transaction(() => {
      db.prepare(
        `INSERT INTO source_link (entity_kind, entity_id, source, external_id, external_url, match_method)
         VALUES ('release', ?, 'discogs', ?, ?, ?)`,
      ).run(
        matched.entityId,
        externalId,
        `https://www.discogs.com/release/${externalId}`,
        matched.method,
      );
      db.prepare(
        `UPDATE release
            SET country   = COALESCE(country, ?),
                label     = COALESCE(label, ?),
                catno     = COALESCE(catno, ?),
                thumb_url = COALESCE(thumb_url, ?),
                cover_url = COALESCE(cover_url, ?)
          WHERE id=?`,
      ).run(args.country, args.label, args.catno, args.thumbUrl, args.coverUrl, matched.entityId);
      // Only the weak key is asserted here. The exact key already describes the
      // matched entity under *its* source's idea of the year; rewriting it with
      // the pressing year would just be undone by the next sync.
      if (looseKey) {
        upsertMatchKey(db, 'release', matched.entityId, 'artist_album', looseKey, {
          steal: false,
        });
      }
      writeFacets(matched.entityId);
    });
    tx();
    return matched.entityId;
  }

  const entityId = ulid();
  const tx = db.transaction(() => {
    const artistId = upsertArtist(db, args.artist);
    db.prepare(
      `INSERT INTO release (id, title, artist_id, year, country, label, catno, thumb_url, cover_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      entityId,
      args.title,
      artistId,
      args.year,
      args.country,
      args.label,
      args.catno,
      args.thumbUrl,
      args.coverUrl,
    );
    db.prepare(
      `INSERT INTO source_link (entity_kind, entity_id, source, external_id, external_url, match_method)
       VALUES ('release', ?, 'discogs', ?, ?, 'first_seen')`,
    ).run(entityId, externalId, `https://www.discogs.com/release/${externalId}`);
    const exactKey = normalizeArtistAlbumYear({
      artist: args.artist,
      album: args.title,
      year: args.year,
    });
    if (exactKey) upsertMatchKey(db, 'release', entityId, 'artist_album_year', exactKey);
    if (looseKey) upsertMatchKey(db, 'release', entityId, 'artist_album', looseKey, { steal: false });
    writeFacets(entityId);
  });
  tx();
  return entityId;
}
