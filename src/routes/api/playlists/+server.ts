import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { listPlaylists, createPlaylist } from '$lib/server/library/playlists';

export const GET: RequestHandler = async () => {
  return json({ items: listPlaylists(getDb()) });
};

export const POST: RequestHandler = async ({ request }) => {
  const body = await request.json().catch(() => ({}));
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) throw error(400, 'name required');
  return json(createPlaylist(getDb(), name), { status: 201 });
};
