import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { setEnv } from '$lib/server/env';
import { writeSetting } from '$lib/server/settings';
import { BandcampFanNotFound, fetchFanCollection } from '$lib/server/genres/bandcamp';
import { bandcampStatus, fetchPendingPages, storePurchases } from '$lib/server/genres/bandcampSync';
import { bandcampUsername } from '$lib/server/genres/bandcamp_env';
import { resolveGenres } from '$lib/server/genres/resolve';

/** GET → { username, purchases, matched, ambiguous, unmatched, pagesPending }. */
export const GET: RequestHandler = async () => json(bandcampStatus(getDb(), bandcampUsername()));

/**
 * POST { username } → prove the fan profile is public, save it to the settings
 * file, match the purchases now and start fetching page tags behind the
 * response. 400 { error: 'malformed' | 'not_found' }, 502 { error: 'unreachable' }.
 */
export const POST: RequestHandler = async ({ request }) => {
  const body = (await request.json().catch(() => ({}))) as { username?: unknown };
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  // Bandcamp usernames are letters, digits, - and _; anything else (a newline
  // above all) must not reach the settings file.
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(username)) return json({ error: 'malformed' }, { status: 400 });

  let purchases;
  try {
    purchases = await fetchFanCollection(username);
  } catch (e) {
    if (e instanceof BandcampFanNotFound) return json({ error: 'not_found' }, { status: 400 });
    return json({ error: 'unreachable' }, { status: 502 });
  }

  writeSetting('BANDCAMP_USERNAME', username);
  setEnv('BANDCAMP_USERNAME', username);
  const db = getDb();
  storePurchases(db, purchases);
  resolveGenres(db);
  void fetchPendingPages(db).catch((e) => console.warn('[bandcamp] page fetch failed:', e));
  return json(bandcampStatus(db, username));
};
