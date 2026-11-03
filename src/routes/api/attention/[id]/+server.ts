import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { FindingError, settleFinding, type SettleAction } from '$lib/server/library/findings';
import { runSync } from '$lib/server/library/sync_run';

export const POST: RequestHandler = async ({ params, request }) => {
  const db = getDb();
  const action = (await request.json()) as SettleAction;
  let needsSync: boolean;
  try {
    ({ needsSync } = settleFinding(db, params.id, action));
  } catch (e) {
    if (e instanceof FindingError) throw error(400, e.message);
    throw e;
  }
  // Keep-one and forget take effect through the sync's prune (~1s).
  if (needsSync) await runSync(db, 'local');
  return json({ ok: true, synced: needsSync });
};
