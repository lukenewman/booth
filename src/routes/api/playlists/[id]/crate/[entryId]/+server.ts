import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { removeCrateEntry, getPlaylist, listPlaylists } from '$lib/server/library/playlists';
import { recordPlaylistEvent } from '$lib/server/backup';

export const DELETE: RequestHandler = async ({ params }) => {
  const db = getDb();
  const before = getPlaylist(db, params.id);
  if (!before) throw error(404, `playlist not found: ${params.id}`);
  const crateRow = before.crate.find((c) => c.entryId === params.entryId);
  if (!crateRow) throw error(404, `crate entry not found: ${params.entryId}`);
  // Journal the sketched tracks that go with the record, so replay needs no
  // release → track knowledge.
  const going = crateRow.releaseId
    ? before.sections.flatMap((s) => s.entries).filter((e) => e.track?.release_id === crateRow.releaseId)
    : [];
  const { removedTracks } = removeCrateEntry(db, params.id, params.entryId);
  for (const e of going) recordPlaylistEvent(db, params.id, { action: 'track-remove', entryId: e.entryId });
  recordPlaylistEvent(db, params.id, { action: 'crate-remove', entryId: params.entryId });
  return json({ removedTracks, trackCount: listPlaylists(db).find((p) => p.id === params.id)?.trackCount ?? 0 });
};
