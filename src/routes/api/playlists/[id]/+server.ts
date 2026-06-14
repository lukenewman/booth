import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { getPlaylist, renamePlaylist, deletePlaylist } from '$lib/server/library/playlists';

export const GET: RequestHandler = async ({ params }) => {
  const detail = getPlaylist(getDb(), params.id);
  if (!detail) throw error(404, `playlist not found: ${params.id}`);
  return json(detail);
};

export const PATCH: RequestHandler = async ({ params, request }) => {
  const body = await request.json().catch(() => ({}));
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) throw error(400, 'name required');
  const db = getDb();
  if (!getPlaylist(db, params.id)) throw error(404, `playlist not found: ${params.id}`);
  renamePlaylist(db, params.id, name);
  return json({ id: params.id, name });
};

export const DELETE: RequestHandler = async ({ params }) => {
  deletePlaylist(getDb(), params.id);
  return new Response(null, { status: 204 });
};
