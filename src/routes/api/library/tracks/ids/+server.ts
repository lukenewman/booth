import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { listTrackIds, parseSort } from '$lib/server/library/queries';

export const GET: RequestHandler = async ({ url }) => {
  const source = url.searchParams.get('source') ?? undefined;
  const q = url.searchParams.get('q') ?? undefined;
  const multiSource = url.searchParams.get('multi_source') === 'true';
  const sort = parseSort(url.searchParams.get('sort'));

  return json({ ids: listTrackIds(getDb(), { source, q, multiSource, sort }) });
};
