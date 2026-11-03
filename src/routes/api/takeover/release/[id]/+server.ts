import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { audioFingerprint } from '$lib/server/library/fingerprint';
import { TakeoverError } from '$lib/server/takeover/engine';
import { releaseTakeoverState } from '$lib/server/takeover/status';
import { isTakeoverRunning } from '$lib/server/takeover/runner';
import { undoPreview, undoRelease } from '$lib/server/takeover/undo';
import { tildePath } from '$lib/server/sources/local/music_library';

/** GET → whether Booth has taken this release over, and what undoing would do. */
export const GET: RequestHandler = ({ params }) => {
  const db = getDb();
  const s = releaseTakeoverState(db, params.id);
  const p = s.owned ? undoPreview(db, params.id) : null;
  return json({ ...s, undo: p ? { files: p.files.map((f) => ({ copy: tildePath(f.copy), original: tildePath(f.original) })), lost: p.lost } : null });
};

/** DELETE → undo: the tracks go back to the originals and Booth's copies are deleted. 409 while a takeover runs; 400 when an original is gone. */
export const DELETE: RequestHandler = async ({ params }) => {
  if (isTakeoverRunning()) return json({ error: 'Wait for the takeover to finish, or stop it.' }, { status: 409 });
  try {
    await undoRelease(getDb(), { fingerprint: audioFingerprint }, params.id);
    return json({ undone: true });
  } catch (e) {
    if (e instanceof TakeoverError) return json({ error: e.message }, { status: 400 });
    throw e;
  }
};
