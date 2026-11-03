import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { addFolderSource, folderStatus, FolderError } from '$lib/server/library/folders';
import { expandHome, tildePath } from '$lib/server/sources/local/music_library';
import { runFreshSync } from '$lib/server/library/sync_run';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolvedInboxRoot, resolvedLibraryRoot } from '$lib/server/sources/local/ingest_env';

/** GET → { folders: [{ id, path, addedAt, files, online }] }; files/online are from the last sync (null before one). */
export const GET: RequestHandler = () =>
  json({ folders: folderStatus(getDb()).map((f) => ({ ...f, path: tildePath(f.path) })) });

/** POST { path } → add the folder and start a fresh local sync to read it. 400 { error } when it can't be read. */
export const POST: RequestHandler = async ({ request }) => {
  const body = (await request.json().catch(() => ({}))) as { path?: unknown };
  const given = typeof body.path === 'string' ? body.path.trim() : '';
  if (!given) return json({ error: 'Type a folder’s path.' }, { status: 400 });
  const db = getDb();
  try {
    const folder = addFolderSource(db, expandHome(given), {
      forbidden: [resolvedLibraryRoot(), resolvedInboxRoot(), join(homedir(), '.booth')],
    });
    void runFreshSync(db, 'local').catch((e) => console.warn('[folders] sync after add failed:', e));
    return json({ ...folder, path: tildePath(folder.path) });
  } catch (e) {
    if (e instanceof FolderError) return json({ error: e.message }, { status: 400 });
    throw e;
  }
};
