import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { copySmartPlaylist, getPlaylist, isSmart } from '$lib/server/library/playlists';
import { recordPlaylistEvent } from '$lib/server/backup';

/**
 * POST → freeze a smart playlist into a plain, editable copy. Journaled as an
 * ordinary create plus one track-add per track, so restore needs nothing new.
 */
export const POST: RequestHandler = async ({ params }) => {
  const db = getDb();
  if (!db.prepare(`SELECT 1 FROM playlist WHERE id = ?`).get(params.id)) throw error(404, `playlist not found: ${params.id}`);
  if (!isSmart(db, params.id)) throw error(409, 'not a smart playlist');
  const created = copySmartPlaylist(db, params.id);
  recordPlaylistEvent(db, created.id, { action: 'create', targetMinutes: null });
  const copy = getPlaylist(db, created.id)!;
  for (const s of copy.sections) for (const e of s.entries) {
    if (!e.track) continue;
    recordPlaylistEvent(db, created.id, {
      action: 'track-add', entryId: e.entryId, sectionId: s.id, sectionName: s.name, trackId: e.track.id, ...e.snapshot,
    });
  }
  return json(created, { status: 201 });
};
