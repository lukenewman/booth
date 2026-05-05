import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { discogsFetch, DiscogsError } from '$lib/server/discogs';
import { getUsername } from '$lib/server/username';
import { markRemoved } from '$lib/server/collection-cache';
import { env } from '$env/dynamic/private';

const FOLDER_ID = env.DISCOGS_FOLDER_ID ?? '1';

export const DELETE: RequestHandler = async ({ request }) => {
  let body: { releaseId?: number; instanceId?: number };
  try {
    body = await request.json();
  } catch {
    throw error(400, 'Invalid JSON body');
  }
  const { releaseId, instanceId } = body;
  if (typeof releaseId !== 'number' || typeof instanceId !== 'number') {
    throw error(400, 'releaseId and instanceId (numbers) required');
  }

  try {
    const username = await getUsername();
    await discogsFetch(
      `/users/${encodeURIComponent(username)}/collection/folders/${FOLDER_ID}/releases/${releaseId}/instances/${instanceId}`,
      { method: 'DELETE' },
    );
    markRemoved(releaseId);
    return json({ ok: true });
  } catch (e) {
    if (e instanceof DiscogsError) {
      return json(e.payload, { status: e.status });
    }
    throw error(500, { message: 'Unexpected error' });
  }
};
