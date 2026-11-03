import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { runMigrations } from '$lib/server/db/migrate';
import { takeoverStatus } from '$lib/server/takeover/status';
import { boothFolder, isTakeoverRunning, resumeOnce, startTakeover } from '$lib/server/takeover/runner';
import { tildePath } from '$lib/server/sources/local/music_library';

/** GET → Booth's folder, a run in progress or the last one, and the releases Booth has taken over. */
export const GET: RequestHandler = () => {
  const db = getDb();
  runMigrations(db); // the dev server reloads code without reopening the database
  resumeOnce(db);
  const f = boothFolder();
  return json({ folder: { ...f, path: tildePath(f.path) }, ...takeoverStatus(db) });
};

/** POST { releaseIds, sample? } → start taking them over in the background. 400 before Booth's folder is chosen; 409 while a run is going. */
export const POST: RequestHandler = async ({ request }) => {
  const body = (await request.json().catch(() => ({}))) as { releaseIds?: unknown; sample?: unknown };
  const ids = Array.isArray(body.releaseIds) ? body.releaseIds.filter((x): x is string => typeof x === 'string') : [];
  if (!ids.length) return json({ error: 'Pick at least one release.' }, { status: 400 });
  if (!boothFolder().chosen) return json({ error: 'Choose where Booth’s folder lives first.' }, { status: 400 });
  const db = getDb();
  runMigrations(db);
  if (isTakeoverRunning()) return json({ error: 'A takeover is already running.' }, { status: 409 });
  const runId = startTakeover(db, ids, { sample: body.sample === true });
  return runId ? json({ runId }, { status: 202 }) : json({ error: 'A takeover is already running.' }, { status: 409 });
};
