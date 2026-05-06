import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { listTracks } from '$lib/server/library/queries';

export const GET: RequestHandler = async ({ url }) => {
  const source = url.searchParams.get('source') ?? undefined;
  const limit = Math.min(Number(url.searchParams.get('limit') ?? '50'), 500);
  const offset = Number(url.searchParams.get('offset') ?? '0');
  return json(listTracks(getDb(), { source, limit, offset }));
};
