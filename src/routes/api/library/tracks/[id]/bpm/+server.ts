import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import {
  setTrackTappedBpm,
  MIN_TAPPED_BPM,
  MAX_TAPPED_BPM,
} from '$lib/server/library/annotations';
import { recordAnnotation } from '$lib/server/backup';

/**
 * PUT with { bpm } records a tapped tempo; a null bpm clears it, so there is no
 * separate DELETE — same shape as the note endpoint. Journalled either way,
 * because a tap is hand-made data with no source that could re-derive it.
 */
export const PUT: RequestHandler = async ({ params, request }) => {
  const body = (await request.json().catch(() => null)) as { bpm?: unknown } | null;
  if (body === null || (body.bpm !== null && typeof body.bpm !== 'number')) {
    error(400, 'bpm must be a number or null');
  }
  if (
    typeof body.bpm === 'number' &&
    (!Number.isFinite(body.bpm) || body.bpm < MIN_TAPPED_BPM || body.bpm > MAX_TAPPED_BPM)
  ) {
    error(400, `bpm must be between ${MIN_TAPPED_BPM} and ${MAX_TAPPED_BPM}`);
  }

  const db = getDb();
  const result = setTrackTappedBpm(db, params.id, (body.bpm as number | null) ?? null);
  recordAnnotation(
    db,
    'track',
    params.id,
    'bpm',
    result.tappedBpm === null ? null : String(result.tappedBpm),
  );
  return json(result);
};
