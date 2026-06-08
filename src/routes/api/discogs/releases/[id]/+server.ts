import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { discogsFetch, DiscogsError } from '$lib/server/sources/discogs/api';

export const GET: RequestHandler = async ({ params }) => {
  try {
    const data = (await discogsFetch(`/releases/${params.id}`)) as any;
    const formatText =
      (data.formats ?? [])
        .map((f: any) => f.text as string | undefined)
        .filter(Boolean)
        .join(', ') || null;
    return json({ formatText });
  } catch (e) {
    if (e instanceof DiscogsError) {
      return json(e.payload, { status: e.status });
    }
    throw error(500, { message: 'Unexpected error' });
  }
};
