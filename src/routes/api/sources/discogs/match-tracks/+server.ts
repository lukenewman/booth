import { json, error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { matchDiscogsTracks } from '$lib/server/sources/discogs/matchTracks';
import { DiscogsError } from '$lib/server/sources/discogs/api';

export async function POST() {
  try {
    const result = await matchDiscogsTracks(getDb());
    return json(result);
  } catch (err) {
    if (err instanceof DiscogsError) {
      error(err.status, { message: err.message });
    }
    throw err;
  }
}
