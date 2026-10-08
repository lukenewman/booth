import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { listPlaylists, createPlaylist, parseTarget } from '$lib/server/library/playlists';
import { recordPlaylistEvent } from '$lib/server/backup';

export const GET: RequestHandler = async () => {
  return json({ items: listPlaylists(getDb()) });
};

export const POST: RequestHandler = async ({ request }) => {
  const body = await request.json().catch(() => ({}));
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) throw error(400, 'name required');
  const target = parseTarget(body.targetMinutes);
  if (target === 'invalid') throw error(400, 'targetMinutes must be a positive integer or null');
  const db = getDb();
  const created = createPlaylist(db, name, target ?? null);
  recordPlaylistEvent(db, created.id, { action: 'create', targetMinutes: created.targetMinutes });
  return json(created, { status: 201 });
};
