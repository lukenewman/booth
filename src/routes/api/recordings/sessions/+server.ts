import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { resolvedRecordingsRoot } from '$lib/server/recording/env';
import { createSession, loadExpectedTracks } from '$lib/server/recording/session';
import { hydrateDiscogsTracks } from '$lib/server/sources/discogs/hydrateDiscogsTracks';

export const POST: RequestHandler = async ({ request }) => {
  const { releaseId } = (await request.json()) as { releaseId?: string };
  if (!releaseId) throw error(400, 'releaseId required');
  const db = getDb();

  const link = db
    .prepare(
      `SELECT external_id FROM source_link WHERE entity_kind='release' AND entity_id=? AND source='discogs'`,
    )
    .get(releaseId) as { external_id: string } | undefined;
  if (!link) throw error(400, 'release has no Discogs source link');

  let { tracks, blocks } = loadExpectedTracks(db, releaseId);
  if (tracks.length === 0) {
    // Tracklist not hydrated yet — hydrate just this release, then retry.
    await hydrateDiscogsTracks(db, [{ discogsReleaseId: link.external_id, releaseEntityId: releaseId }]);
    ({ tracks, blocks } = loadExpectedTracks(db, releaseId));
  }
  if (tracks.length === 0) throw error(422, 'Discogs has no tracklist for this release');

  const session = createSession(resolvedRecordingsRoot(), releaseId);
  return json({ sessionId: session.id, tracks, sides: blocks.map((b) => b[0].side) });
};
