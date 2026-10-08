import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { getPlaylist, renamePlaylist, deletePlaylist, setTargetMinutes, parseTarget } from '$lib/server/library/playlists';
import { recordPlaylistEvent, crateEntryIds, recordNewCrateRows } from '$lib/server/backup';

export const GET: RequestHandler = async ({ params }) => {
  const detail = getPlaylist(getDb(), params.id);
  if (!detail) throw error(404, `playlist not found: ${params.id}`);
  return json(detail);
};

export const PATCH: RequestHandler = async ({ params, request }) => {
  const body = await request.json().catch(() => ({}));
  const db = getDb();
  if (!getPlaylist(db, params.id)) throw error(404, `playlist not found: ${params.id}`);
  const name = typeof body.name === 'string' ? body.name.trim() : undefined;
  const target = parseTarget(body.targetMinutes);
  if (target === 'invalid') throw error(400, 'targetMinutes must be a positive integer or null');
  if (name === undefined && target === undefined) throw error(400, 'name or targetMinutes required');
  if (name !== undefined) {
    if (!name) throw error(400, 'name required');
    renamePlaylist(db, params.id, name);
    recordPlaylistEvent(db, params.id, { action: 'rename', name });
  }
  if (target !== undefined) {
    const before = crateEntryIds(db, params.id);
    setTargetMinutes(db, params.id, target);
    recordPlaylistEvent(db, params.id, { action: 'target', minutes: target });
    recordNewCrateRows(db, params.id, before);
  }
  const after = getPlaylist(db, params.id)!;
  return json({ id: after.id, name: after.name, targetMinutes: after.targetMinutes });
};

export const DELETE: RequestHandler = async ({ params }) => {
  const db = getDb();
  recordPlaylistEvent(db, params.id, { action: 'delete' });
  deletePlaylist(db, params.id);
  return new Response(null, { status: 204 });
};
