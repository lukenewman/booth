import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getCollectionIds } from '$lib/server/collection-cache';
import { DiscogsError } from '$lib/server/discogs';

export const GET: RequestHandler = async () => {
  try {
    const ids = await getCollectionIds();
    return json({ ids });
  } catch (e) {
    if (e instanceof DiscogsError) {
      return json(e.payload, { status: e.status });
    }
    return json({ error: 'discogs_error' }, { status: 500 });
  }
};
