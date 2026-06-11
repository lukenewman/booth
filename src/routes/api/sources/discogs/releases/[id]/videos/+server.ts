import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { fetchReleaseVideos } from '$lib/server/sources/discogs/videos';
import { DiscogsError } from '$lib/server/sources/discogs/api';

export const GET: RequestHandler = async ({ params }) => {
  const db = getDb();
  const link = db
    .prepare(
      `SELECT external_id FROM source_link
        WHERE entity_kind='release' AND entity_id=? AND source='discogs'`,
    )
    .get(params.id) as { external_id: string } | undefined;

  // No Discogs link → nothing to show. Empty, not 404, so the UI just renders no section.
  if (!link) return json({ videos: [] });

  try {
    return json({ videos: await fetchReleaseVideos(link.external_id) });
  } catch (e) {
    if (e instanceof DiscogsError) {
      if (e.status === 404) return json({ videos: [] });
      if (e.status === 429) throw error(429, `Rate limited. Try again in ${e.payload.retryAfter ?? 60}s.`);
      throw error(e.status >= 400 && e.status < 600 ? e.status : 502, e.message);
    }
    throw e;
  }
};
