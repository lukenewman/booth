import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { stopTakeover } from '$lib/server/takeover/runner';

/** POST → stop after the release being copied; the rest stay pending for the next run. */
export const POST: RequestHandler = () => {
  stopTakeover();
  return json({ stopping: true });
};
