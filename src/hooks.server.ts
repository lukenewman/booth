import type { Handle } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { getDb } from '$lib/server/db';
import { runSync } from '$lib/server/library/sync_run';

const triggered = new Set<string>();

function maybeBackfill(
  sourceId: string,
  shouldRun: (db: ReturnType<typeof getDb>) => boolean,
) {
  if (triggered.has(sourceId)) return;
  triggered.add(sourceId);
  const db = getDb();
  if (!shouldRun(db)) return;
  // Fire and forget — errors logged but don't fail requests.
  runSync(db, sourceId)
    .then((run) => {
      if (run.error) {
        console.warn(`[boot] ${sourceId} initial sync failed:`, run.error);
      } else {
        console.log(`[boot] ${sourceId} initial sync`, run.summary);
      }
    })
    .catch((e) => {
      console.warn(`[boot] ${sourceId} initial sync failed:`, e);
      triggered.delete(sourceId); // allow retry on next request
    });
}

function maybeBackfillDiscogs() {
  maybeBackfill('discogs', (db) => {
    const has = db
      .prepare(`SELECT 1 FROM source_link WHERE source='discogs' LIMIT 1`)
      .get();
    return !has;
  });
}

function maybeBackfillITunes() {
  if (!env.ITUNES_XML_PATH) return;
  maybeBackfill('itunes', (db) => {
    const has = db
      .prepare(`SELECT 1 FROM source_link WHERE source='itunes' LIMIT 1`)
      .get();
    return !has;
  });
}

export const handle: Handle = async ({ event, resolve }) => {
  maybeBackfillDiscogs();
  maybeBackfillITunes();
  return resolve(event);
};
