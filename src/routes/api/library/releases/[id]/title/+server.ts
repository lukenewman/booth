import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { setReleaseTitle, TitleMergeBlocked } from '$lib/server/library/releaseTitle';
import { resolveGenres } from '$lib/server/genres/resolve';
import { recordAnnotation } from '$lib/server/backup';

/**
 * PUT { title } sets a hand-set title; { title: null } hands it back to the
 * sources. Returns { releaseId, mergedId } — after a merge the release lives
 * on under the other copy's id, so the client follows releaseId.
 */
export const PUT: RequestHandler = async ({ params, request }) => {
  const body = await request.json().catch(() => ({}));
  if (body.title !== null && typeof body.title !== 'string') throw error(400, 'title must be a string or null');
  const db = getDb();
  if (!db.prepare(`SELECT 1 FROM release WHERE id = ?`).get(params.id)) throw error(404, `release not found: ${params.id}`);
  try {
    const result = setReleaseTitle(db, params.id, body.title);
    const title = (db.prepare(`SELECT title_override FROM release WHERE id = ?`).get(result.releaseId) as { title_override: string | null }).title_override;
    recordAnnotation(db, 'release', result.releaseId, 'title', title);
    if (result.mergedId) {
      // Discogs genres came across with the merged copy.
      resolveGenres(db, [result.releaseId]);
      for (const c of result.carried) {
        const t = db.prepare(`SELECT starred_at, note FROM track WHERE id = ?`).get(c.trackId) as { starred_at: string | null; note: string | null };
        if (c.star) recordAnnotation(db, 'track', c.trackId, 'star', t.starred_at);
        if (c.note) recordAnnotation(db, 'track', c.trackId, 'note', t.note);
      }
    }
    return json({ releaseId: result.releaseId, mergedId: result.mergedId });
  } catch (e) {
    if (e instanceof TitleMergeBlocked) throw error(409, e.message);
    throw e;
  }
};
