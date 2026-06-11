import type { Handle } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { getDb } from '$lib/server/db';
import { runSync } from '$lib/server/library/sync_run';
import { listSources } from '$lib/server/sources/registry';

const triggered = new Set<string>();

function autoSyncOnce(sourceId: string) {
  if (triggered.has(sourceId)) return;
  triggered.add(sourceId);
  // Fire and forget — errors logged but don't fail requests.
  runSync(getDb(), sourceId)
    .then((run) => {
      if (run.error) {
        console.warn(`[boot] ${sourceId} sync failed:`, run.error);
      } else {
        console.log(`[boot] ${sourceId} sync`, run.summary);
      }
    })
    .catch((e) => {
      console.warn(`[boot] ${sourceId} sync failed:`, e);
      triggered.delete(sourceId); // allow retry on next request
    });
}

/**
 * On the first request after server start, kick off a background sync for
 * every non-stub source. Skips the local source if ITUNES_XML_PATH isn't set,
 * since its sync (Apple Music XML parse) would just throw. Each source fires
 * at most once per process.
 */
function autoSyncAll() {
  for (const source of listSources()) {
    if (source.isStub) continue;
    if (source.id === 'local' && !env.ITUNES_XML_PATH) continue;
    autoSyncOnce(source.id);
  }
}

export const handle: Handle = async ({ event, resolve }) => {
  autoSyncAll();
  return resolve(event);
};
