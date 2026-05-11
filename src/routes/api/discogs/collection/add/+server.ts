import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { AddResponse } from '$lib/types';
import { DiscogsError } from '$lib/server/sources/discogs/api';
import { discogsSource, ensureDiscogsReleaseEntity } from '$lib/server/sources/discogs';
import { getDb } from '$lib/server/db';

interface AddRequestBody {
  releaseId: number;
  title: string;
  artist: string;
  year: number | null;
  country: string | null;
  label: string | null;
  catno: string | null;
  thumb: string | null;
  coverImage: string | null;
}

export const POST: RequestHandler = async ({ request }) => {
  let body: Partial<AddRequestBody>;
  try {
    body = await request.json();
  } catch {
    throw error(400, 'Invalid JSON body');
  }
  const releaseId = body.releaseId;
  if (typeof releaseId !== 'number') throw error(400, 'releaseId (number) required');
  if (typeof body.title !== 'string' || typeof body.artist !== 'string') {
    throw error(400, 'title and artist (strings) required');
  }

  const entityId = ensureDiscogsReleaseEntity({
    releaseId,
    title: body.title,
    artist: body.artist,
    year: body.year ?? null,
    country: body.country ?? null,
    label: body.label ?? null,
    catno: body.catno ?? null,
    thumb: body.thumb ?? null,
    coverImage: body.coverImage ?? null,
  });

  try {
    const { externalId, instanceId } = await discogsSource.addToCollection({ entityId });
    // Persist the new instance_id alongside any existing ones, so removal still
    // works after a reload (the session-only undo path doesn't survive page refresh).
    appendInstanceIdFacet(entityId, Number(instanceId!));
    const response: AddResponse = {
      releaseId: Number(externalId),
      instanceId: Number(instanceId!),
    };
    return json(response);
  } catch (e) {
    if (e instanceof DiscogsError) {
      return json(e.payload, { status: e.status });
    }
    throw error(500, { message: 'Unexpected error' });
  }
};

function appendInstanceIdFacet(entityId: string, newInstanceId: number): void {
  const db = getDb();
  const existing = db
    .prepare(
      `SELECT value FROM source_facets
        WHERE entity_kind='release' AND entity_id=? AND source='discogs' AND key='instanceIds'`,
    )
    .get(entityId) as { value: string } | undefined;
  const ids: number[] = existing ? (JSON.parse(existing.value) as number[]) : [];
  if (!ids.includes(newInstanceId)) ids.push(newInstanceId);
  db.prepare(
    `INSERT INTO source_facets (entity_kind, entity_id, source, key, value)
     VALUES ('release', ?, 'discogs', 'instanceIds', ?)
     ON CONFLICT(entity_kind, entity_id, source, key) DO UPDATE SET
       value      = excluded.value,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  ).run(entityId, JSON.stringify(ids));
}
