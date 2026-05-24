import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { getArtistDetail } from '$lib/server/library/queries';

export const GET: RequestHandler = async ({ params }) => {
  const detail = getArtistDetail(getDb(), params.id);
  if (!detail) throw error(404, `artist not found: ${params.id}`);
  return json(detail);
};
