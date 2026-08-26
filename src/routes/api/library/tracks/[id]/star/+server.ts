import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { setTrackStar } from '$lib/server/library/annotations';

export const PUT: RequestHandler = async ({ params }) => {
  return json(setTrackStar(getDb(), params.id, true));
};

export const DELETE: RequestHandler = async ({ params }) => {
  return json(setTrackStar(getDb(), params.id, false));
};
