import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { addRelease, getPlaylist } from '$lib/server/library/playlists';
import { recordPlaylistEvent } from '$lib/server/backup';

export const POST: RequestHandler = async ({ params, request }) => {
  const body = await request.json().catch(() => ({}));
  const releaseId = typeof body.releaseId === 'string' ? body.releaseId : '';
  if (!releaseId) throw error(400, 'releaseId required');
  const db = getDb();
  if (!getPlaylist(db, params.id)) throw error(404, `playlist not found: ${params.id}`);
  if (!db.prepare(`SELECT 1 FROM release WHERE id = ?`).get(releaseId)) throw error(404, `release not found: ${releaseId}`);
  const res = addRelease(db, params.id, releaseId);
  if (res.added) {
    const c = getPlaylist(db, params.id)!.crate.find((x) => x.entryId === res.entryId)!;
    recordPlaylistEvent(db, params.id, { action: 'crate-add', entryId: c.entryId, releaseId, artist: c.artist, title: c.title, year: c.year });
  }
  return json({ added: res.added });
};
