import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { addTrack, reorderTracks, listPlaylists } from '$lib/server/library/playlists';

function trackCount(id: string): number {
  return listPlaylists(getDb()).find((p) => p.id === id)?.trackCount ?? 0;
}

export const POST: RequestHandler = async ({ params, request }) => {
  const body = await request.json().catch(() => ({}));
  const trackId = typeof body.trackId === 'string' ? body.trackId : '';
  if (!trackId) throw error(400, 'trackId required');
  const db = getDb();
  // Guard the FK targets so a bad id is a clean 404, not a 500 from the
  // playlist_track foreign keys (INSERT OR IGNORE doesn't suppress FK errors).
  const refs = db
    .prepare(
      `SELECT (SELECT 1 FROM playlist WHERE id = ?) AS p,
              (SELECT 1 FROM track    WHERE id = ?) AS t`,
    )
    .get(params.id, trackId) as { p: number | null; t: number | null };
  if (!refs.p) throw error(404, `playlist not found: ${params.id}`);
  if (!refs.t) throw error(404, `track not found: ${trackId}`);
  const { added } = addTrack(db, params.id, trackId);
  return json({ added, trackCount: trackCount(params.id) });
};

export const PATCH: RequestHandler = async ({ params, request }) => {
  const body = await request.json().catch(() => ({}));
  const order = Array.isArray(body.order)
    ? (body.order as unknown[]).filter((x): x is string => typeof x === 'string')
    : null;
  if (!order) throw error(400, 'order array required');
  reorderTracks(getDb(), params.id, order);
  return new Response(null, { status: 204 });
};
