import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { getTrackDetail } from '$lib/server/library/queries';

export const GET: RequestHandler = async ({ params }) => {
  const detail = getTrackDetail(getDb(), params.id);
  if (!detail) throw error(404, `track not found: ${params.id}`);
  return json(detail);
};
