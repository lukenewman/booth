import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { FindingError, settleFinding, type SettleAction } from '$lib/server/library/findings';
import { runFreshSync } from '$lib/server/library/sync_run';

export const POST: RequestHandler = async ({ params, request }) => {
  const db = getDb();
  const action = (await request.json()) as SettleAction;
  let result: ReturnType<typeof settleFinding>;
  try {
    result = settleFinding(db, params.id, action);
  } catch (e) {
    if (e instanceof FindingError) throw error(400, e.message);
    throw e;
  }
  // Keep-one and forget take effect through the sync's prune (~1s). A sync
  // already running read the file list before this change, so wait for a
  // fresh one rather than joining it.
  if (result.needsSync) await runFreshSync(db, 'local');
  result.afterSync?.();
  return json({ ok: true, synced: result.needsSync });
};
