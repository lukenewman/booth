import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { removeTrack, listPlaylists } from '$lib/server/library/playlists';

export const DELETE: RequestHandler = async ({ params }) => {
  removeTrack(getDb(), params.id, params.trackId);
  const trackCount = listPlaylists(getDb()).find((p) => p.id === params.id)?.trackCount ?? 0;
  return json({ trackCount });
};
