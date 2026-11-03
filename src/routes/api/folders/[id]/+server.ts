import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { folderRemovalImpact, removeFolderSource, FolderError } from '$lib/server/library/folders';
import { runFreshSync } from '$lib/server/library/sync_run';

/**
 * DELETE ?preview=1 → what removing it takes out of the library;
 * DELETE → remove it, and wait for the sync that removes its tracks.
 */
export const DELETE: RequestHandler = async ({ params, url }) => {
  const db = getDb();
  try {
    const impact = folderRemovalImpact(db, params.id);
    if (url.searchParams.get('preview') === '1') return json(impact);
    removeFolderSource(db, params.id);
    await runFreshSync(db, 'local');
    return json({ removed: true, ...impact });
  } catch (e) {
    if (e instanceof FolderError) return json({ error: e.message }, { status: 404 });
    throw e;
  }
};
