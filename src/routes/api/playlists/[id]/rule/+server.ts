import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { isSmart, setPlaylistRule } from '$lib/server/library/playlists';
import { recordPlaylistEvent } from '$lib/server/backup';
import { validateRule } from '$lib/smartRule';

/** PUT { rule } → replace a smart playlist's rule. 404 unknown, 409 not smart, 400 invalid. */
export const PUT: RequestHandler = async ({ params, request }) => {
  const db = getDb();
  if (!db.prepare(`SELECT 1 FROM playlist WHERE id = ?`).get(params.id)) throw error(404, `playlist not found: ${params.id}`);
  if (!isSmart(db, params.id)) throw error(409, 'not a smart playlist');
  const body = (await request.json().catch(() => ({}))) as { rule?: unknown };
  const rule = validateRule(body.rule);
  if (!rule) throw error(400, 'invalid rule');
  setPlaylistRule(db, params.id, rule);
  recordPlaylistEvent(db, params.id, { action: 'rule', rule });
  return json({ rule });
};
