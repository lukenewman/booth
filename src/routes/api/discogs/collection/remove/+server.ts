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
  const { releaseId } = body;
  if (typeof releaseId !== 'number') {
    throw error(400, 'releaseId (number) required');
  }

  const link = getDb()
    .prepare(
      `SELECT entity_id FROM source_link
        WHERE entity_kind='release' AND source='discogs' AND external_id=?`,
    )
    .get(String(releaseId)) as { entity_id: string } | undefined;
  if (!link) throw error(404, 'release not in local DB');

  // Prefer instanceId from the request body (session-undo path). Fall back to
  // the instanceIds facet, which sync.ts populates for every release and
  // /collection/add appends to on every add. If both are missing, the row was
  // adopted from an older add before facet persistence; ask the user to sync.
  let instanceId: number | undefined =
    typeof body.instanceId === 'number' ? body.instanceId : undefined;
  if (instanceId == null) {
    const facet = getDb()
      .prepare(
        `SELECT value FROM source_facets
          WHERE entity_kind='release' AND entity_id=? AND source='discogs' AND key='instanceIds'`,
      )
      .get(link.entity_id) as { value: string } | undefined;
    if (facet) {
      const ids = JSON.parse(facet.value) as number[];
      if (ids.length > 0) instanceId = ids[0];
    }
  }
  if (typeof instanceId !== 'number') {
    throw error(
      409,
      'no Discogs instance_id known for this release; trigger a Discogs sync to refresh and try again',
    );
  }

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
