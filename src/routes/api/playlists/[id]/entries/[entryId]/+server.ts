import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { moveEntry, removeEntry, sectionOf, listPlaylists } from '$lib/server/library/playlists';
import { recordPlaylistEvent } from '$lib/server/backup';

function entryExists(playlistId: string, entryId: string): boolean {
  return !!getDb().prepare(`SELECT 1 FROM playlist_track WHERE id = ? AND playlist_id = ?`).get(entryId, playlistId);
}

export const PATCH: RequestHandler = async ({ params, request }) => {
  const body = await request.json().catch(() => ({}));
  const sectionId = typeof body.sectionId === 'string' ? body.sectionId : '';
  const index = typeof body.index === 'number' && Number.isInteger(body.index) ? body.index : -1;
  if (!sectionId || index < 0) throw error(400, 'sectionId and a non-negative integer index required');
  const db = getDb();
  if (!entryExists(params.id, params.entryId)) throw error(404, `entry not found: ${params.entryId}`);
  const section = sectionOf(db, params.id, sectionId);
  if (!section) throw error(404, `section not found: ${sectionId}`);
  moveEntry(db, params.id, params.entryId, sectionId, index);
  recordPlaylistEvent(db, params.id, { action: 'track-move', entryId: params.entryId, sectionId, sectionName: section.name, index });
  return new Response(null, { status: 204 });
};

export const DELETE: RequestHandler = async ({ params }) => {
  const db = getDb();
  if (!entryExists(params.id, params.entryId)) throw error(404, `entry not found: ${params.entryId}`);
  removeEntry(db, params.id, params.entryId);
  recordPlaylistEvent(db, params.id, { action: 'track-remove', entryId: params.entryId });
  return json({ trackCount: listPlaylists(db).find((p) => p.id === params.id)?.trackCount ?? 0 });
};
