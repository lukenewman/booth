import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { getReleaseDetail } from '$lib/server/library/queries';

export const GET: RequestHandler = async ({ params }) => {
  const detail = getReleaseDetail(getDb(), params.id);
  if (!detail) throw error(404, `release not found: ${params.id}`);
  return json(detail);
};
