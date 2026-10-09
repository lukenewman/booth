import { json } from '@sveltejs/kit';
import { homedir } from 'node:os';
import type { RequestHandler } from './$types';
import { env, setEnv } from '$lib/server/env';
import { DiscogsError } from '$lib/server/sources/discogs/api';
import { getUsername, identifyToken, resetUsername } from '$lib/server/sources/discogs/username';
import { writeSetting } from '$lib/server/settings';

/**
 * GET → { status: 'ok', username } | { status: 'no_token' } |
 * { status: 'invalid_token' } | { status: 'unreachable' }. The page's setup gate.
 */
export const GET: RequestHandler = async () => {
  if (!env.DISCOGS_TOKEN) return json({ status: 'no_token' });
  try {
    return json({ status: 'ok', username: await getUsername() });
  } catch (e) {
    if (e instanceof DiscogsError && e.status === 401) return json({ status: 'invalid_token' });
    return json({ status: 'unreachable' });
  }
};

/**
 * POST { token } → check it with Discogs, save it to the settings file, and
 * use it from now on, no restart. 400 { error: 'malformed' | 'rejected' },
 * 502 { error: 'unreachable' }.
 */
export const POST: RequestHandler = async ({ request }) => {
  const body = (await request.json().catch(() => ({}))) as { token?: unknown };
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  // Discogs tokens are letters and digits; anything else (a newline above
  // all) must not reach the settings file.
  if (!/^[A-Za-z0-9]{20,100}$/.test(token)) {
    return json({ error: 'malformed' }, { status: 400 });
  }

  let username: string | null;
  try {
    username = await identifyToken(token);
  } catch {
    return json({ error: 'unreachable' }, { status: 502 });
  }
  if (!username) return json({ error: 'rejected' }, { status: 400 });

  const path = writeSetting('DISCOGS_TOKEN', token);
  setEnv('DISCOGS_TOKEN', token);
  resetUsername();
  const home = homedir();
  return json({ username, savedTo: path.startsWith(home) ? `~${path.slice(home.length)}` : path });
};
