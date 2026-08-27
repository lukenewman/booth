import type { Database } from 'bun:sqlite';
import { homedir } from 'os';
import { join } from 'path';
import { env } from '$lib/server/env';
import { appendEvent, type AnnotationEvent } from './journal';
import { snapshotDb, newestSnapshotMtime, shouldSnapshot } from './snapshot';

/**
 * Wiring for the two backup artifacts. Everything here is best-effort: a
 * failed backup logs and returns, it never fails the request that triggered it.
 */

const DEFAULT_ROOT = join(homedir(), '.booth', 'backups');

export function backupRoot(): string {
  return env.BOOTH_BACKUP_PATH ?? DEFAULT_ROOT;
}

export function journalPath(): string {
  return join(backupRoot(), 'annotations.log');
}

export function snapshotDir(): string {
  return join(backupRoot(), 'snapshots');
}

/** Snapshots to retain, and how close together they may be taken. */
const KEEP_SNAPSHOTS = 10;
const MIN_SNAPSHOT_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Record one annotation mutation.
 *
 * Called from the star / vet routes with the row already read, so the log
 * carries the names needed to replay onto a database whose ULIDs have moved.
 */
export function recordAnnotation(
  db: Database,
  kind: 'track' | 'release',
  id: string,
  action: AnnotationEvent['action'],
  value: string | null,
): void {
  try {
    const row =
      kind === 'track'
        ? (db
            .prepare(
              `SELECT a.name AS artist, t.title, t.album
                 FROM track t JOIN artist a ON a.id = t.artist_id
                WHERE t.id = ?`,
            )
            .get(id) as { artist: string; title: string; album: string | null } | undefined)
        : (db
            .prepare(
              `SELECT a.name AS artist, r.title, NULL AS album
                 FROM release r JOIN artist a ON a.id = r.artist_id
                WHERE r.id = ?`,
            )
            .get(id) as { artist: string; title: string; album: string | null } | undefined);

    appendEvent(journalPath(), {
      at: new Date().toISOString(),
      kind,
      id,
      action,
      value,
      artist: row?.artist ?? '(unknown)',
      title: row?.title ?? '(unknown)',
      album: row?.album ?? null,
    });
  } catch (e) {
    console.warn('[backup] journal append failed:', e);
  }
}

/**
 * Take a whole-database snapshot if one is due.
 *
 * Rate-limited rather than unconditional: `bun dev` restarts on every save, so
 * an eager boot snapshot would rotate a week of history out of retention over
 * an afternoon of editing.
 */
export function maybeSnapshot(db: Database, reason: string): void {
  try {
    const dir = snapshotDir();
    if (!shouldSnapshot(newestSnapshotMtime(dir), Date.now(), MIN_SNAPSHOT_INTERVAL_MS)) return;
    const written = snapshotDb(db, { dir, keep: KEEP_SNAPSHOTS });
    if (written) console.log(`[backup] snapshot (${reason}) → ${written}`);
  } catch (e) {
    console.warn('[backup] snapshot failed:', e);
  }
}
