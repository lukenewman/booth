import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { BoothFolderError } from '$lib/server/library/boothFolder';
import { chooseBoothFolder } from '$lib/server/takeover/runner';
import { expandHome, tildePath } from '$lib/server/sources/local/music_library';

/** POST { path } → choose where Booth's folder lives. 400 { error } when it won't do. */
export const POST: RequestHandler = async ({ request }) => {
  const body = (await request.json().catch(() => ({}))) as { path?: unknown };
  const given = typeof body.path === 'string' ? body.path.trim() : '';
  if (!given) return json({ error: 'Choose a folder.' }, { status: 400 });
  try {
    return json({ path: tildePath(chooseBoothFolder(getDb(), expandHome(given))) });
  } catch (e) {
    if (e instanceof BoothFolderError) return json({ error: e.message }, { status: 400 });
    throw e;
  }
};
