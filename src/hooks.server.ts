import type { Handle } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { discogsSource } from '$lib/server/sources/discogs';
import { collate } from '$lib/server/library/collate';

let triggered = false;

async function maybeBackfillDiscogs() {
  if (triggered) return;
  triggered = true;
  const db = getDb();
  const has = db
    .prepare(`SELECT 1 FROM source_link WHERE source='discogs' LIMIT 1`)
    .get();
  if (has) return;
  // Fire and forget — errors logged but don't fail requests.
  discogsSource
    .sync()
    .then((result) => collate(db, 'discogs', result))
    .then((s) => console.log('[boot] discogs initial sync', s))
    .catch((e) => {
      console.warn('[boot] discogs initial sync failed:', e);
      triggered = false; // allow retry on next request
    });
}

export const handle: Handle = async ({ event, resolve }) => {
  void maybeBackfillDiscogs();
  return resolve(event);
};
