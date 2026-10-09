import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { listGenreVocabulary, reassignStyleColors } from '$lib/server/genres/colors';

/** POST → re-rank unpinned styles by current use; returns the vocabulary. */
export const POST: RequestHandler = async () => {
  const db = getDb();
  reassignStyleColors(db);
  return json(listGenreVocabulary(db));
};
