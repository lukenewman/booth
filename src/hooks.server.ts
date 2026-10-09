import type { Handle } from '@sveltejs/kit';
import { env } from '$lib/server/env';
import { getDb } from '$lib/server/db';
import { runSync } from '$lib/server/library/sync_run';
import { listSources } from '$lib/server/sources/registry';
import { createScheduler, parseIntervalMinutes } from '$lib/server/library/scheduler';
import { maybeSnapshot, seedPlaylistJournal } from '$lib/server/backup';

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
 * Sources worth syncing: skip stubs, and skip `local` unless ITUNES_XML_PATH
 * is set, since its sync (Apple Music XML parse) would just throw.
 */
function eligibleSourceIds(): string[] {
  return listSources()
    .filter((s) => !s.isStub)
    .filter((s) => !(s.id === 'local' && !env.ITUNES_XML_PATH))
    .map((s) => s.id);
}

/**
 * On the first request after server start, kick off a background sync for
 * every eligible source. Each source fires at most once per process.
 */
function autoSyncAll() {
  for (const id of eligibleSourceIds()) autoSyncOnce(id);
}

/**
 * The boot hook above fires once per process, which is invisible under
 * `bun dev` (it restarts constantly) but means an always-on production server
 * stops syncing forever. This adds the recurring pass, alongside the boot
 * hook rather than replacing it, so a restart still syncs immediately.
 */
let schedulerStarted = false;
function startScheduledSync() {
  if (schedulerStarted) return;
  schedulerStarted = true;

  const minutes = parseIntervalMinutes(env.BOOTH_SYNC_INTERVAL_MINUTES);
  if (minutes === 0) {
    console.log('[sync] scheduler disabled (BOOTH_SYNC_INTERVAL_MINUTES=0)');
    return;
  }

  const scheduler = createScheduler({
    sourceIds: eligibleSourceIds,
    // Log successes too: runSync is silent on success, so without this a
    // scheduled tick leaves no trace and an always-on server gives you no way
    // to tell "syncing fine" from "scheduler died months ago".
    sync: async (id) => {
      const run = await runSync(getDb(), id);
      console.log(`[sync] ${id}`, run.summary);
      // A sync is when the bulk of the database changes, so it is the moment a
      // whole-DB snapshot is worth taking. Rate-limited inside maybeSnapshot.
      maybeSnapshot(getDb(), `after ${id} sync`);
      return run;
    },
    onError: (id, err) => console.warn(`[sync] ${id} scheduled sync failed:`, err),
  });

  const timer = setInterval(() => void scheduler.tick(), minutes * 60_000);
  // Cast rather than call directly: `setInterval` resolves to the DOM overload
  // (returning `number`) in some type configurations, and `unref` is Bun/Node
  // only. The timer must not be what keeps the process alive.
  (timer as unknown as { unref?: () => void }).unref?.();
  console.log(`[sync] scheduler running every ${minutes}m`);
}

let snapshotChecked = false;
function snapshotOnBoot() {
  if (snapshotChecked) return;
  snapshotChecked = true;
  maybeSnapshot(getDb(), 'boot');
  seedPlaylistJournal(getDb());
}

export const handle: Handle = async ({ event, resolve }) => {
  autoSyncAll();
  startScheduledSync();
  snapshotOnBoot();
  // Inside the desktop app, mark the page before any script runs so its own
  // title bar takes the space up front instead of shifting the layout later.
  if (!globalThis.__boothDesktop) return resolve(event);
  return resolve(event, {
    transformPageChunk: ({ html }) => html.replace('<html lang="en">', '<html lang="en" data-desktop>'),
  });
};
