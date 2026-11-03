import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { getDestination } from '$lib/server/backup/library';
import { startBackup } from '$lib/server/backup/runner';

/** POST { verify? } → start a backup in the background. 409 when one is already running. */
export const POST: RequestHandler = async ({ request }) => {
  const db = getDb();
  if (!getDestination(db)) return json({ error: 'Pick a backup folder first.' }, { status: 400 });
  const body = (await request.json().catch(() => ({}))) as { verify?: unknown };
  const started = startBackup(db, { verify: body.verify === true });
  return json({ started }, { status: started ? 202 : 409 });
};
