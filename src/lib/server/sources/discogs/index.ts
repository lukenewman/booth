import { ulid } from 'ulid';
import type { CollectionWritable, MusicSource } from '../types';
import { syncDiscogsCollection } from './sync';
import { discogsFetch } from './api';
import { getUsername } from './username';
import { env } from '$env/dynamic/private';
import { getDb } from '../../db';
import { normalizeArtistAlbumYear } from '../../library/normalize';
import { upsertArtist } from '../../library/collate';

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
 * Ensure a release entity exists for a Discogs release the user is about to add,
 * creating one if no source_link points at this Discogs id yet (typical when the
 * user is adding a record they searched for).
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
    const matchKey = normalizeArtistAlbumYear({
      artist: args.artist,
      album: args.title,
      year: args.year,
    });
    if (matchKey) {
      db.prepare(
        `INSERT INTO match_key (entity_kind, entity_id, key_type, key_value)
         VALUES ('release', ?, 'artist_album_year', ?)
         ON CONFLICT(entity_kind, key_type, key_value) DO NOTHING`,
      ).run(entityId, matchKey);
    }
    const facets: Record<string, unknown> = {};
    if (args.thumbUrl) facets.thumb = args.thumbUrl;
    if (args.coverUrl) facets.coverImage = args.coverUrl;
    for (const [k, v] of Object.entries(facets)) {
      db.prepare(
        `INSERT INTO source_facets (entity_kind, entity_id, source, key, value)
         VALUES ('release', ?, 'discogs', ?, ?)`,
      ).run(entityId, k, JSON.stringify(v));
    }
  });
  tx();
  return entityId;
}
