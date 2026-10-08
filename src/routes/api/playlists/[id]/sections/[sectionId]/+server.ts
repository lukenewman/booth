import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { renameSection, deleteSection, sectionOf } from '$lib/server/library/playlists';
import { recordPlaylistEvent } from '$lib/server/backup';

export const PATCH: RequestHandler = async ({ params, request }) => {
  const body = await request.json().catch(() => ({}));
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) throw error(400, 'name required');
  const db = getDb();
  if (!sectionOf(db, params.id, params.sectionId)) throw error(404, `section not found: ${params.sectionId}`);
  renameSection(db, params.id, params.sectionId, name);
  recordPlaylistEvent(db, params.id, { action: 'section-rename', sectionId: params.sectionId, name });
  return new Response(null, { status: 204 });
};

export const DELETE: RequestHandler = async ({ params }) => {
  const db = getDb();
  const s = sectionOf(db, params.id, params.sectionId);
  if (!s) throw error(404, `section not found: ${params.sectionId}`);
  if (s.isUnsorted) throw error(400, 'Unsorted cannot be deleted');
  deleteSection(db, params.id, params.sectionId);
  recordPlaylistEvent(db, params.id, { action: 'section-delete', sectionId: params.sectionId });
  return new Response(null, { status: 204 });
};
