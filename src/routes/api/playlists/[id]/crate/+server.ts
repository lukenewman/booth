import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { addRelease, getPlaylist } from '$lib/server/library/playlists';
import { crateEntryIds, recordNewCrateRows } from '$lib/server/backup';

export const POST: RequestHandler = async ({ params, request }) => {
  const body = await request.json().catch(() => ({}));
  const releaseId = typeof body.releaseId === 'string' ? body.releaseId : '';
  if (!releaseId) throw error(400, 'releaseId required');
  const db = getDb();
  if (!getPlaylist(db, params.id)) throw error(404, `playlist not found: ${params.id}`);
  if (!db.prepare(`SELECT 1 FROM release WHERE id = ?`).get(releaseId)) throw error(404, `release not found: ${releaseId}`);
  const before = crateEntryIds(db, params.id);
  const res = addRelease(db, params.id, releaseId);
  recordNewCrateRows(db, params.id, before);
  return json({ added: res.added });
};
