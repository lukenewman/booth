import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { setReleaseVetted } from '$lib/server/library/annotations';
import { recordAnnotation } from '$lib/server/backup';

export const PUT: RequestHandler = async ({ params }) => {
  const db = getDb();
  const result = setReleaseVetted(db, params.id, true);
  recordAnnotation(db, 'release', params.id, 'vet', result.vettedAt);
  return json(result);
};

export const DELETE: RequestHandler = async ({ params }) => {
  const db = getDb();
  recordAnnotation(db, 'release', params.id, 'unvet', null);
  return json(setReleaseVetted(db, params.id, false));
};
