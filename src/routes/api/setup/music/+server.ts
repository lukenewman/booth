import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env, setEnv } from '$lib/server/env';
import { writeSetting } from '$lib/server/settings';
import {
  checkMusicXml,
  expandHome,
  findMusicXml,
  tildePath,
} from '$lib/server/sources/local/music_library';

/**
 * GET → { status: 'connected', path } | { status: 'not_connected',
 * nudgeDismissed, canChooseFile }. Never reads the library file: doing so can
 * raise macOS's Music-folder prompt, which must follow a click, not a page load.
 */
export const GET: RequestHandler = () => {
  if (env.ITUNES_XML_PATH) {
    return json({ status: 'connected', path: tildePath(env.ITUNES_XML_PATH) });
  }
  return json({
    status: 'not_connected',
    nudgeDismissed: env.BOOTH_MUSIC_NUDGE_DISMISSED === '1',
    canChooseFile: !!globalThis.__boothDesktop,
  });
};

/**
 * POST { path? } → check the export (the standard locations when no path is
 * given), save it to the settings file and use it from now on, no restart.
 * 200 { path, trackCount, modifiedAt, savedTo } or
 * 400 { problem: 'missing' | 'no_permission' | 'not_a_library', path }.
 * The caller starts the import itself, so it can show its progress.
 */
export const POST: RequestHandler = async ({ request }) => {
  const body = (await request.json().catch(() => ({}))) as { path?: unknown };
  const given = typeof body.path === 'string' ? body.path.trim() : '';
  // The path becomes one line of the settings file.
  if (/[\r\n]/.test(given)) {
    return json({ problem: 'not_a_library', path: given }, { status: 400 });
  }

  const check = given ? checkMusicXml(expandHome(given)) : findMusicXml();
  if (!check.ok) {
    return json({ problem: check.problem, path: tildePath(check.path) }, { status: 400 });
  }

  const savedTo = writeSetting('ITUNES_XML_PATH', check.path);
  setEnv('ITUNES_XML_PATH', check.path);
  return json({
    path: tildePath(check.path),
    trackCount: check.trackCount,
    modifiedAt: check.modifiedAt,
    savedTo: tildePath(savedTo),
  });
};
