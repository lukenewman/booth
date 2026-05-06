import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { listTracks } from '$lib/server/library/queries';

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 200;

export const GET: RequestHandler = async ({ url }) => {
  const source = url.searchParams.get('source') ?? undefined;
  const q = url.searchParams.get('q') ?? undefined;

  const rawLimit = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT);
  const limit = Math.max(1, Math.min(MAX_LIMIT, Number.isFinite(rawLimit) ? rawLimit : DEFAULT_LIMIT));
  const rawOffset = Number(url.searchParams.get('offset') ?? 0);
  const offset = Math.max(0, Number.isFinite(rawOffset) ? rawOffset : 0);

  const result = listTracks(getDb(), { source, q, limit, offset });
  return json(result);
};
