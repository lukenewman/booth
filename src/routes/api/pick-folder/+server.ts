import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { existsSync } from 'node:fs';
import { pickFolder, PickError } from '$lib/server/pickFolder';
import { expandHome } from '$lib/server/sources/local/music_library';

/** POST { prompt?, startIn? } → { path } (null when cancelled), via the Mac's folder chooser. */
export const POST: RequestHandler = async ({ request }) => {
  const body = (await request.json().catch(() => ({}))) as { prompt?: unknown; startIn?: unknown };
  const prompt = typeof body.prompt === 'string' && body.prompt ? body.prompt.slice(0, 200) : 'Choose a folder';
  const start = typeof body.startIn === 'string' ? expandHome(body.startIn) : undefined;
  try {
    return json({ path: await pickFolder(prompt, start && existsSync(start) ? start : undefined) });
  } catch (e) {
    if (e instanceof PickError) return json({ error: e.message }, { status: 400 });
    throw e;
  }
};
