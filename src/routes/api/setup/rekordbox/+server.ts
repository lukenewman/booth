import { json } from '@sveltejs/kit';
import { homedir } from 'node:os';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { setEnv } from '$lib/server/env';
import { writeSetting } from '$lib/server/settings';
import { expandHome, tildePath } from '$lib/server/sources/local/music_library';
import { checkRekordboxXml, defaultRekordboxXmlPath, lastRekordboxImport } from '$lib/server/library/rekordbox';
import { rekordboxXmlPath } from '$lib/server/library/rekordbox_env';
import { runFreshSync } from '$lib/server/library/sync_run';

/**
 * GET → { path, last, suggested }: the connected export (or null), the last
 * import's counts, and the standard location when a file is there.
 */
export const GET: RequestHandler = () => {
  const path = rekordboxXmlPath();
  const fallback = defaultRekordboxXmlPath(homedir());
  const suggested = !path && checkRekordboxXml(fallback).ok ? tildePath(fallback) : null;
  const last = path ? lastRekordboxImport(getDb()) : null;
  return json({
    path: path ? tildePath(path) : null,
    modifiedAt: path ? (checkRekordboxXml(path) as { modifiedAt?: string }).modifiedAt ?? null : null,
    last: last ? { ...last, path: tildePath(last.path) } : null,
    suggested,
  });
};

/**
 * POST { path? } → check the export (the standard location when no path is
 * given), save it, and start a fresh local sync to read it.
 * 200 { path, trackCount } or 400 { problem, path }.
 */
export const POST: RequestHandler = async ({ request }) => {
  const body = (await request.json().catch(() => ({}))) as { path?: unknown };
  const given = typeof body.path === 'string' ? body.path.trim() : '';
  if (/[\r\n]/.test(given)) return json({ problem: 'not_an_export', path: given }, { status: 400 });
  const check = checkRekordboxXml(given ? expandHome(given) : defaultRekordboxXmlPath(homedir()));
  if (!check.ok) return json({ problem: check.problem, path: tildePath(check.path) }, { status: 400 });

  writeSetting('REKORDBOX_XML_PATH', check.path);
  setEnv('REKORDBOX_XML_PATH', check.path);
  void runFreshSync(getDb(), 'local').catch((e) => console.warn('[rekordbox] sync after connect failed:', e));
  return json({ path: tildePath(check.path), trackCount: check.trackCount });
};
