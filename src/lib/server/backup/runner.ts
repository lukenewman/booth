import type { Database } from 'bun:sqlite';
import { statfsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { audioFingerprint } from '../library/fingerprint';
import { listFolderSources } from '../library/folders';
import { resolvedInboxRoot, resolvedLibraryRoot } from '../sources/local/ingest_env';
import { markInterruptedRuns, runLibraryBackup, type BackupDeps, type BackupResult } from './library';

/**
 * The one backup run the server allows at a time, in the background, with
 * the real copy, fingerprint and snapshot. The API starts, stops and polls it.
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

/** Start a run unless one is going. Returns false when one already was. */
export function startBackup(db: Database, opts: { verify?: boolean } = {}): boolean {
  recoverOnce(db);
  if (state.running) return false;
  state.stopRequested = false;
  state.running = runLibraryBackup(db, realDeps(db), { verify: opts.verify, shouldStop: () => state.stopRequested })
    .then((r) => {
      console.log(`[backup] ${r.state}: ${r.filesCopied} copied, ${r.filesSkipped} already there, ${r.failed.length} failed${r.error ? ` — ${r.error}` : ''}`);
      return r;
    })
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
