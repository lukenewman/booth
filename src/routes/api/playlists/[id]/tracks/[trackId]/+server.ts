import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { removeTrack, listPlaylists } from '$lib/server/library/playlists';
import { recordPlaylistEvent } from '$lib/server/backup';

export const DELETE: RequestHandler = async ({ params }) => {
  const db = getDb();
  const row = db
    .prepare(`SELECT id FROM playlist_track WHERE playlist_id = ? AND track_id = ?`)
    .get(params.id, params.trackId) as { id: string } | undefined;
  removeTrack(db, params.id, params.trackId);
  if (row) recordPlaylistEvent(db, params.id, { action: 'track-remove', entryId: row.id });
  const trackCount = listPlaylists(db).find((p) => p.id === params.id)?.trackCount ?? 0;
  return json({ trackCount });
};
