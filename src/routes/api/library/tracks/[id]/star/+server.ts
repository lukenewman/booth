import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { setTrackStar } from '$lib/server/library/annotations';
import { recordAnnotation } from '$lib/server/backup';

export const PUT: RequestHandler = async ({ params }) => {
  const db = getDb();
  const result = setTrackStar(db, params.id, true);
  recordAnnotation(db, 'track', params.id, 'star', result.starredAt);
  return json(result);
};

export const DELETE: RequestHandler = async ({ params }) => {
  const db = getDb();
  // Journal before the row loses its star, so the event still carries the
  // names needed to replay it onto a rebuilt database.
  recordAnnotation(db, 'track', params.id, 'unstar', null);
  return json(setTrackStar(db, params.id, false));
};
