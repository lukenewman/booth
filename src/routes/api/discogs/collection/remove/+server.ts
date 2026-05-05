import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { DiscogsError } from '$lib/server/sources/discogs/api';
import { discogsSource } from '$lib/server/sources/discogs';
import { getDb } from '$lib/server/db';

export const DELETE: RequestHandler = async ({ request }) => {
  let body: { releaseId?: number; instanceId?: number };
  try {
    body = await request.json();
  } catch {
    throw error(400, 'Invalid JSON body');
  }
  const { releaseId, instanceId } = body;
  if (typeof releaseId !== 'number' || typeof instanceId !== 'number') {
    throw error(400, 'releaseId and instanceId (numbers) required');
  }

  const link = getDb()
    .prepare(
      `SELECT entity_id FROM source_link
        WHERE entity_kind='release' AND source='discogs' AND external_id=?`,
    )
    .get(String(releaseId)) as { entity_id: string } | undefined;
  if (!link) throw error(404, 'release not in local DB');

  try {
    await discogsSource.removeFromCollection({ entityId: link.entity_id, instanceId: String(instanceId) });
    return json({ ok: true });
  } catch (e) {
    if (e instanceof DiscogsError) {
      return json(e.payload, { status: e.status });
    }
    throw error(500, { message: 'Unexpected error' });
  }
};
