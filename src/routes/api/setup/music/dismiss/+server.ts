import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { setEnv } from '$lib/server/env';
import { writeSetting } from '$lib/server/settings';

/** POST → stop suggesting the Apple Music library in the library view. */
export const POST: RequestHandler = () => {
  writeSetting('BOOTH_MUSIC_NUDGE_DISMISSED', '1');
  setEnv('BOOTH_MUSIC_NUDGE_DISMISSED', '1');
  return json({ ok: true });
};
