import type { Database } from 'bun:sqlite';
import { statfsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { audioFingerprint } from '../library/fingerprint';
import { listFolderSources } from '../library/folders';
import { resolvedInboxRoot, resolvedLibraryRoot } from '../sources/local/ingest_env';
import { listDestinations, markInterruptedRuns, MUSIC_APP_PLACE, namePlaces, runLibraryBackup, type BackupDeps, type BackupResult, type Place } from './library';

/**
 * The server's backups, one destination at a time, in the background, with
 * the real copy, fingerprint and snapshot. "Back up all" queues every
 * connected destination. The API starts, stops and polls it.
 */

// On globalThis, not module variables: the dev server reloads this module
// when code changes, and a reloaded copy must still see the run in flight
// (and reach it with Stop) rather than start a second one.
type RunnerState = { running: Promise<BackupResult> | null; stopRequested: boolean; recovered: boolean };
const g = globalThis as typeof globalThis & { __boothBackup?: RunnerState };
const state: RunnerState = (g.__boothBackup ??= { running: null, stopRequested: false, recovered: false });

/** Places the music lives: a destination inside one is refused, one on the same disk is flagged. */
export function libraryRoots(db: Database): string[] {
  return [join(homedir(), 'Music'), resolvedLibraryRoot(), resolvedInboxRoot(), join(homedir(), '.booth'), ...listFolderSources(db).map((f) => f.path)];
}

/**
 * The places copies are kept under, most specific first: Booth's own folders,
 * Music.app's media folder (as "Apple Music"), then folder sources in the order they were added
 * (so adding a folder never renames an earlier one's copies).
 */
export function backupPlaces(db: Database): Place[] {
  const fixed: Place[] = [{ name: 'Booth', path: resolvedLibraryRoot() }, { name: 'Booth Inbox', path: resolvedInboxRoot() }, MUSIC_APP_PLACE];
  return [...fixed, ...namePlaces(listFolderSources(db), [...fixed.map((f) => f.name), 'Other'])];
}

/** Once per server: a run the last process didn't finish is marked stopped, not left running. */
export function recoverOnce(db: Database): void {
  if (state.recovered) return;
  state.recovered = true;
  if (!state.running) markInterruptedRuns(db);
}

function realDeps(db: Database): BackupDeps {
  return {
    fingerprint: audioFingerprint,
    snapshotDb: (to) => db.exec(`VACUUM INTO '${to.replaceAll("'", "''")}'`),
    freeBytes: (dir) => {
      const s = statfsSync(dir);
      return Number(s.bavail) * Number(s.bsize);
    },
  };
}

export function isBackupRunning(): boolean {
  return state.running !== null;
}

/**
 * Back up to `destinationIds` in turn (every connected one when omitted),
 * unless backups are already going. Returns false when they were. Stop ends
 * the current one and skips the rest.
 */
export function startBackup(db: Database, opts: { destinationIds?: string[]; verify?: boolean } = {}): boolean {
  recoverOnce(db);
  if (state.running) return false;
  state.stopRequested = false;
  const ids = opts.destinationIds ?? listDestinations(db).filter((d) => d.online).map((d) => d.id);
  state.running = (async () => {
    let last: BackupResult = { state: 'done', filesCopied: 0, filesSkipped: 0, filesMoved: 0, filesChecked: 0, bytesCopied: 0, failed: [] };
    for (const destinationId of ids) {
      if (state.stopRequested) break;
      last = await runLibraryBackup(db, realDeps(db), { destinationId, places: backupPlaces(db), verify: opts.verify, shouldStop: () => state.stopRequested });
      console.log(`[backup] ${destinationId} ${last.state}: ${last.filesCopied} copied, ${last.filesMoved} moved, ${last.filesChecked} checked, ${last.filesSkipped} already there, ${last.failed.length} failed${last.error ? ` — ${last.error}` : ''}`);
    }
    return last;
  })()
    .catch((e) => {
      console.warn('[backup] run failed:', e);
      throw e;
    })
    .finally(() => { state.running = null; });
  state.running.catch(() => {});
  return true;
}

export function stopBackup(): void {
  state.stopRequested = true;
}
