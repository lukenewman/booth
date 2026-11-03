import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { listDestinations } from '$lib/server/backup/library';
import { startBackup } from '$lib/server/backup/runner';

/** POST { destinationId?, verify? } → back up in the background: to one destination, or every connected one. 409 when backups are already going. */
export const POST: RequestHandler = async ({ request }) => {
  const db = getDb();
  const body = (await request.json().catch(() => ({}))) as { destinationId?: unknown; verify?: unknown };
  const all = listDestinations(db);
  if (!all.length) return json({ error: 'Add a backup folder first.' }, { status: 400 });
  const one = typeof body.destinationId === 'string' ? body.destinationId : null;
  if (one && !all.some((d) => d.id === one)) return json({ error: 'No such backup folder.' }, { status: 404 });
  const started = startBackup(db, { destinationIds: one ? [one] : undefined, verify: body.verify === true });
  return json({ started }, { status: started ? 202 : 409 });
};
