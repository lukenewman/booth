import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { stopBackup } from '$lib/server/backup/runner';

/** POST → stop after the file being copied; the next run picks up from there. */
export const POST: RequestHandler = () => {
  stopBackup();
  return json({ stopping: true });
};
