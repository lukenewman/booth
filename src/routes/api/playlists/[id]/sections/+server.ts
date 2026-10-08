import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { createSection, reorderSections, getPlaylist } from '$lib/server/library/playlists';
import { recordPlaylistEvent } from '$lib/server/backup';

export const POST: RequestHandler = async ({ params, request }) => {
  const body = await request.json().catch(() => ({}));
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) throw error(400, 'name required');
  const db = getDb();
  if (!getPlaylist(db, params.id)) throw error(404, `playlist not found: ${params.id}`);
  const s = createSection(db, params.id, name);
  recordPlaylistEvent(db, params.id, { action: 'section-add', sectionId: s.id, name: s.name });
  return json(s, { status: 201 });
};

export const PATCH: RequestHandler = async ({ params, request }) => {
  const body = await request.json().catch(() => ({}));
  const order = Array.isArray(body.order) ? (body.order as unknown[]).filter((x): x is string => typeof x === 'string') : null;
  if (!order) throw error(400, 'order array required');
  const db = getDb();
  if (!getPlaylist(db, params.id)) throw error(404, `playlist not found: ${params.id}`);
  reorderSections(db, params.id, order);
  recordPlaylistEvent(db, params.id, { action: 'section-order', sectionIds: order });
  return new Response(null, { status: 204 });
};
