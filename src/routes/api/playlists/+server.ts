import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { listPlaylists, createPlaylist, parseTarget } from '$lib/server/library/playlists';
import { recordPlaylistEvent } from '$lib/server/backup';
import { validateRule, type SmartRule } from '$lib/smartRule';

export const GET: RequestHandler = async () => {
  return json({ items: listPlaylists(getDb()) });
};

export const POST: RequestHandler = async ({ request }) => {
  const body = await request.json().catch(() => ({}));
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) throw error(400, 'name required');
  const target = parseTarget(body.targetMinutes);
  if (target === 'invalid') throw error(400, 'targetMinutes must be a positive integer or null');
  let rule: SmartRule | null = null;
  if (body.rule !== undefined && body.rule !== null) {
    rule = validateRule(body.rule);
    if (!rule) throw error(400, 'invalid rule');
  }
  const db = getDb();
  const created = createPlaylist(db, name, target ?? null, rule);
  recordPlaylistEvent(db, created.id, { action: 'create', targetMinutes: created.targetMinutes, rule });
  return json(created, { status: 201 });
};
