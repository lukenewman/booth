import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { backupStatus, BackupError, setDestination } from '$lib/server/backup/library';
import { isBackupRunning, libraryRoots, recoverOnce } from '$lib/server/backup/runner';
import { expandHome, tildePath } from '$lib/server/sources/local/music_library';

/** GET → the backup status: destination, last backup, what's not in it, a run in progress. */
export const GET: RequestHandler = () => {
  const db = getDb();
  recoverOnce(db);
  const s = backupStatus(db, { libraryRoots: libraryRoots(db) });
  return json({ ...s, destination: s.destination ? { ...s.destination, path: tildePath(s.destination.path) } : null });
};

/** POST { path } → use that folder as the destination. 400 { error } when it won't do. */
export const POST: RequestHandler = async ({ request }) => {
  const body = (await request.json().catch(() => ({}))) as { path?: unknown };
  const given = typeof body.path === 'string' ? body.path.trim() : '';
  if (!given) return json({ error: 'Type a folder’s path.' }, { status: 400 });
  const db = getDb();
  try {
    const d = setDestination(db, expandHome(given), { libraryRoots: libraryRoots(db), running: isBackupRunning() });
    return json({ ...d, path: tildePath(d.path) });
  } catch (e) {
    if (e instanceof BackupError) return json({ error: e.message }, { status: 400 });
    throw e;
  }
};
