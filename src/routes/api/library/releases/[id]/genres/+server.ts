import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { setManualTags, TagValidationError } from '$lib/server/genres/manual';
import { recordAnnotation } from '$lib/server/backup';

function exists(id: string): boolean {
  return !!getDb().prepare(`SELECT 1 FROM release WHERE id = ?`).get(id);
}

/**
 * PUT { genres, styles } → set a hand-made override; returns the resolved
 * { genres, styles, genreOrigin }. 404 unknown release, 400 invalid tags.
 */
export const PUT: RequestHandler = async ({ params, request }) => {
  if (!exists(params.id)) return json({ error: 'not_found' }, { status: 404 });
  const body = (await request.json().catch(() => ({}))) as { genres?: unknown; styles?: unknown };
  if (!Array.isArray(body.genres) || !Array.isArray(body.styles)) return json({ error: 'bad body' }, { status: 400 });
  const db = getDb();
  let result;
  try {
    result = setManualTags(db, params.id, { genres: body.genres as string[], styles: body.styles as string[] });
  } catch (e) {
    if (e instanceof TagValidationError) return json({ error: e.message }, { status: 400 });
    throw e;
  }
  recordAnnotation(db, 'release', params.id, 'tags', JSON.stringify({ genres: result.genres, styles: result.styles }));
  return json(result);
};

/** DELETE → drop the override; the sources' answer (or untagged) comes back. */
export const DELETE: RequestHandler = async ({ params }) => {
  if (!exists(params.id)) return json({ error: 'not_found' }, { status: 404 });
  const db = getDb();
  recordAnnotation(db, 'release', params.id, 'tags', null);
  return json(setManualTags(db, params.id, null));
};
