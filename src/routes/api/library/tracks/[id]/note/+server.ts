import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { setTrackNote, MAX_NOTE_LENGTH } from '$lib/server/library/annotations';
import { recordAnnotation } from '$lib/server/backup';

/**
 * PUT with { note } sets it; an empty or whitespace-only note clears it, so
 * there is no separate DELETE. Journalled either way — a cleared note is a
 * `note` event with a null value, which is what makes it rewindable.
 */
export const PUT: RequestHandler = async ({ params, request }) => {
  const body = (await request.json().catch(() => null)) as { note?: unknown } | null;
  if (body === null || (body.note !== null && typeof body.note !== 'string')) {
    error(400, 'note must be a string or null');
  }
  if (typeof body.note === 'string' && body.note.length > MAX_NOTE_LENGTH * 4) {
    error(413, 'note too long');
  }

  const db = getDb();
  const result = setTrackNote(db, params.id, (body.note as string | null) ?? null);
  recordAnnotation(db, 'track', params.id, 'note', result.note);
  return json(result);
};
