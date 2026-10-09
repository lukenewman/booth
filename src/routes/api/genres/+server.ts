import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { listGenreVocabulary } from '$lib/server/genres/colors';

/** GET → { genres, styles: [{ name, parents, slot, pinned, releases }] }, most-used style first. */
export const GET: RequestHandler = async () => json(listGenreVocabulary(getDb()));
