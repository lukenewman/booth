import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { AddResponse } from '$lib/types';
import { discogsFetch, DiscogsError } from '$lib/server/discogs';
import { getUsername } from '$lib/server/username';
import { markAdded } from '$lib/server/collection-cache';
import { env } from '$env/dynamic/private';

interface AddDiscogsResponse {
  instance_id: number;
  resource_url: string;
}

const FOLDER_ID = env.DISCOGS_FOLDER_ID ?? '1';

export const POST: RequestHandler = async ({ request }) => {
  let body: { releaseId?: number };
  try {
    body = await request.json();
  } catch {
    throw error(400, 'Invalid JSON body');
  }
  const releaseId = body.releaseId;
  if (typeof releaseId !== 'number') {
    throw error(400, 'releaseId (number) required');
  }

  try {
    const username = await getUsername();
    const data = (await discogsFetch(
      `/users/${encodeURIComponent(username)}/collection/folders/${FOLDER_ID}/releases/${releaseId}`,
      { method: 'POST' },
    )) as AddDiscogsResponse;
    markAdded(releaseId);
    const response: AddResponse = { releaseId, instanceId: data.instance_id };
    return json(response);
  } catch (e) {
    if (e instanceof DiscogsError) {
      return json(e.payload, { status: e.status });
    }
    throw error(500, { message: 'Unexpected error' });
  }
};
