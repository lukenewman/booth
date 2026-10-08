import type { Database } from 'bun:sqlite';
import { homedir } from 'os';
import { join } from 'path';
import { env } from '$lib/server/env';
import { appendEvent, type AnnotationEvent } from './journal';
import { snapshotDb, newestSnapshotMtime, shouldSnapshot } from './snapshot';
import { appendPlaylistEvent, baselineFromDetail, type PlaylistEventBody } from './playlistJournal';
import { getPlaylist, listPlaylists, unsortedSectionId } from '$lib/server/library/playlists';
import { existsSync } from 'fs';

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

export function playlistJournalPath(): string {
  return join(backupRoot(), 'playlists.log');
}

/**
 * Record one playlist mutation. Called from the playlist routes after the
 * write succeeds (for `delete`, before it — the name is gone afterwards).
 * Best-effort like recordAnnotation: a failed append never fails the request.
 */
export function recordPlaylistEvent(db: Database, playlistId: string, body: PlaylistEventBody): void {
  try {
    const row = db.prepare(`SELECT name FROM playlist WHERE id = ?`).get(playlistId) as { name: string } | undefined;
    appendPlaylistEvent(playlistJournalPath(), {
      at: new Date().toISOString(),
      playlistId,
      playlistName: row?.name ?? '(unknown)',
      unsortedId: row ? unsortedSectionId(db, playlistId) : '',
      ...body,
    });
  } catch (e) {
    console.warn('[backup] playlist journal append failed:', e);
  }
}

/** Crate entry ids now on a playlist — take before a write, pass to recordNewCrateRows after. */
export function crateEntryIds(db: Database, playlistId: string): Set<string> {
  return new Set(getPlaylist(db, playlistId)?.crate.map((c) => c.entryId) ?? []);
}

/**
 * Journal every crate row a write added, including the ones it added as a side
 * effect (a sketched track's record, or the backfill when a playlist becomes a
 * gig), so replay never has to re-derive them.
 */
export function recordNewCrateRows(db: Database, playlistId: string, before: Set<string>): void {
  for (const c of getPlaylist(db, playlistId)?.crate ?? []) {
    if (before.has(c.entryId) || !c.releaseId) continue;
    recordPlaylistEvent(db, playlistId, { action: 'crate-add', entryId: c.entryId, releaseId: c.releaseId, artist: c.artist, title: c.title, year: c.year });
  }
}

/**
 * First boot with the journal: write one baseline per existing playlist so the
 * log can rebuild playlists that predate it. Runs only when the file is absent.
 */
export function seedPlaylistJournal(db: Database): void {
  try {
    if (existsSync(playlistJournalPath())) return;
    for (const p of listPlaylists(db)) {
      const d = getPlaylist(db, p.id);
      if (d) recordPlaylistEvent(db, p.id, { action: 'baseline', state: baselineFromDetail(d) });
    }
  } catch (e) {
    console.warn('[backup] playlist journal seed failed:', e);
  }
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
