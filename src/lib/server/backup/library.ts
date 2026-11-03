import type { Database } from 'bun:sqlite';
import { accessSync, constants, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { Database as SqliteDatabase } from 'bun:sqlite';
import { ulid } from 'ulid';

/**
 * Booth's own backups of the library (BOO-103): every present library file
 * and a database snapshot, copied to a folder the user picked, with a record
 * of what that folder holds.
 *
 * Copies mirror absolute paths under `<destination>/Booth Backup/files`, so a
 * backup is usable without Booth. A copy is written under a temporary name,
 * checked (same size, same audio fingerprint, or same bytes when there is no
 * fingerprint) and only then renamed into place, so an interrupted copy never
 * looks complete. Runs are incremental: a file whose size and modified time
 * match what the destination recorded is skipped. Nothing is ever deleted
 * from a destination.
 */

export const BACKUP_DIR = 'Booth Backup';
const SNAPSHOTS_KEPT = 10;
const DAY_MS = 86_400_000;

export interface BackupDeps {
  /** The audio fingerprint, as the file list computes it. */
  fingerprint(path: string): Promise<string>;
  /** Write a consistent copy of the database to `to` (VACUUM INTO). */
  snapshotDb(to: string): void;
  /** Bytes free where `dir` lives. */
  freeBytes(dir: string): number;
  copyFile?(from: string, to: string): Promise<void>;
}

export class BackupError extends Error {}

export interface Destination { id: string; path: string; sameDisk: boolean }

const inside = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/**
 * Use `path` as the backup destination. Refused when it doesn't exist, can't
 * be written, or sits inside the library (a folder walk would read the
 * copies back in). `sameDisk` says it's on the same disk as the music, where
 * it won't survive that disk failing.
 */
export function setDestination(db: Database, path: string, opts: { libraryRoots: string[] }): Destination {
  const dest = resolve(path);
  try {
    if (!statSync(dest).isDirectory()) throw new Error();
    accessSync(dest, constants.W_OK);
  } catch {
    throw new BackupError('That folder doesn’t exist, or Booth can’t write to it.');
  }
  const roots = opts.libraryRoots.map((r) => resolve(r));
  if (roots.some((r) => inside(dest, r))) throw new BackupError('That folder is inside your music library. Pick one outside it, ideally on another drive.');
  db.transaction(() => {
    db.prepare(`DELETE FROM backup_destination WHERE path <> ?`).run(dest);
    db.prepare(`INSERT OR IGNORE INTO backup_destination (id, path) VALUES (?, ?)`).run(ulid(), dest);
  })();
  return getDestination(db, opts)!;
}

export function getDestination(db: Database, opts: { libraryRoots: string[] } = { libraryRoots: [] }): Destination | null {
  const row = db.prepare(`SELECT id, path FROM backup_destination ORDER BY added_at DESC LIMIT 1`).get() as { id: string; path: string } | null;
  if (!row) return null;
  let sameDisk = false;
  try {
    const dev = statSync(row.path).dev;
    sameDisk = opts.libraryRoots.some((r) => { try { return statSync(r).dev === dev; } catch { return false; } });
  } catch { /* destination offline */ }
  return { ...row, sameDisk };
}

interface LibraryFile { id: string; path: string; fingerprint: string | null; size: number | null; mtime_ms: number | null; release_id: string | null }

/** The files a backup protects: present, in the library, not taken out of it. */
function libraryFiles(db: Database): LibraryFile[] {
  return db
    .prepare(
      `SELECT f.id, f.path, f.fingerprint, f.size, f.mtime_ms, t.release_id
         FROM audio_file f
         JOIN source_link sl ON sl.source = 'local' AND sl.entity_kind = 'track' AND sl.external_id = f.id
         JOIN track t ON t.id = sl.entity_id
        WHERE f.present = 1 AND f.excluded = 0
        GROUP BY f.id`,
    )
    .all() as LibraryFile[];
}

async function hashFile(path: string): Promise<string> {
  const h = new Bun.CryptoHasher('sha256');
  for await (const chunk of Bun.file(path).stream()) h.update(chunk);
  return h.digest('hex');
}

export interface BackupResult {
  state: 'done' | 'failed' | 'stopped';
  filesCopied: number;
  filesSkipped: number;
  bytesCopied: number;
  failed: { path: string; error: string }[];
  error?: string;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const gb = (n: number) => `${(n / 1e9).toFixed(1)} GB`;

export async function runLibraryBackup(
  db: Database,
  deps: BackupDeps,
  opts: { verify?: boolean; shouldStop?: () => boolean; onProgress?: () => void } = {},
): Promise<BackupResult> {
  const dest = getDestination(db);
  if (!dest) throw new BackupError('No backup destination set.');
  const runId = ulid();
  db.prepare(`INSERT INTO backup_run (id, destination_id) VALUES (?, ?)`).run(runId, dest.id);
  const result: BackupResult = { state: 'done', filesCopied: 0, filesSkipped: 0, bytesCopied: 0, failed: [] };
  const finish = (state: BackupResult['state'], error?: string) => {
    result.state = state;
    if (error) result.error = error;
    db.prepare(
      `UPDATE backup_run SET state = ?, finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), files_done = ?, bytes_done = ?, failed = ?, error = ? WHERE id = ?`,
    ).run(state, result.filesCopied + result.filesSkipped, result.bytesCopied, result.failed.length ? JSON.stringify(result.failed.slice(0, 50)) : null, error ?? null, runId);
    return result;
  };

  const base = join(dest.path, BACKUP_DIR);
  try {
    mkdirSync(join(base, 'files'), { recursive: true });
    mkdirSync(join(base, 'database'), { recursive: true });
  } catch (e) {
    return finish('failed', `Can’t write to the backup folder: ${message(e)}`);
  }

  const heldStmt = db.prepare(`SELECT size, mtime_ms FROM backup_item WHERE destination_id = ? AND file_id = ?`);
  const todo: { file: LibraryFile; size: number; mtimeMs: number; to: string }[] = [];
  for (const file of libraryFiles(db)) {
    let st;
    try { st = statSync(file.path); } catch (e) { result.failed.push({ path: file.path, error: message(e) }); continue; }
    const size = st.size;
    const mtimeMs = Math.floor(st.mtimeMs);
    const to = join(base, 'files', file.path.replace(/^\/+/, ''));
    const held = heldStmt.get(dest.id, file.id) as { size: number; mtime_ms: number } | null;
    let copyHeld = false;
    try { copyHeld = statSync(to).size === size; } catch { copyHeld = false; }
    let fresh = !!held && held.size === size && held.mtime_ms === mtimeMs && copyHeld;
    if (fresh && opts.verify) fresh = await sameContent(file, file.path, to, deps);
    if (fresh) result.filesSkipped++;
    else todo.push({ file, size, mtimeMs, to });
  }
  const bytesNeeded = todo.reduce((n, t) => n + t.size, 0);
  db.prepare(`UPDATE backup_run SET files_total = ?, bytes_total = ? WHERE id = ?`).run(todo.length + result.filesSkipped, bytesNeeded, runId);
  const free = deps.freeBytes(dest.path);
  if (bytesNeeded > free) return finish('failed', `Not enough space on the backup drive: needs ${gb(bytesNeeded)}, has ${gb(free)}.`);

  const copy = deps.copyFile ?? ((from: string, to: string) => copyFile(from, to));
  const record = db.prepare(
    `INSERT INTO backup_item (destination_id, file_id, fingerprint, size, mtime_ms, dest_path, backed_at)
     VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT (destination_id, file_id) DO UPDATE SET fingerprint = excluded.fingerprint, size = excluded.size,
       mtime_ms = excluded.mtime_ms, dest_path = excluded.dest_path, backed_at = excluded.backed_at`,
  );
  const progress = db.prepare(`UPDATE backup_run SET files_done = ?, bytes_done = ? WHERE id = ?`);
  for (const t of todo) {
    if (opts.shouldStop?.()) return finish('stopped');
    const part = `${t.to}.booth-part`;
    try {
      mkdirSync(dirname(t.to), { recursive: true });
      await copy(t.file.path, part);
      if (statSync(part).size !== t.size || !(await sameContent(t.file, t.file.path, part, deps))) {
        throw new Error('the copy doesn’t match the original');
      }
      renameSync(part, t.to);
      record.run(dest.id, t.file.id, t.file.fingerprint, t.size, t.mtimeMs, t.to);
      result.filesCopied++;
      result.bytesCopied += t.size;
    } catch (e) {
      try { if (existsSync(part)) unlinkSync(part); } catch { /* best effort */ }
      result.failed.push({ path: t.file.path, error: message(e) });
    }
    progress.run(result.filesCopied + result.filesSkipped, result.bytesCopied, runId);
    opts.onProgress?.();
  }

  // The database last, so it describes everything copied above.
  try {
    writeSnapshot(join(base, 'database'), deps);
  } catch (e) {
    return finish('failed', `Couldn’t back up the database: ${message(e)}`);
  }
  return finish('done');
}

/** The copy holds the same audio (by fingerprint) or, with no fingerprint, the same bytes. */
async function sameContent(file: LibraryFile, original: string, copyPath: string, deps: BackupDeps): Promise<boolean> {
  if (file.fingerprint) {
    try { return (await deps.fingerprint(copyPath)) === file.fingerprint; } catch { /* fall back to bytes */ }
  }
  return (await hashFile(copyPath)) === (await hashFile(original));
}

function writeSnapshot(dir: string, deps: BackupDeps): void {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const name = `booth-${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}-${ulid().slice(-6)}.db`;
  const part = join(dir, `${name}.booth-part`);
  deps.snapshotDb(part);
  // The first restore test: the snapshot opens and SQLite vouches for it.
  const check = new SqliteDatabase(part, { readonly: true });
  try {
    const ok = (check.prepare(`PRAGMA integrity_check`).get() as Record<string, string>)?.integrity_check;
    if (ok !== 'ok') throw new Error(`integrity check: ${ok}`);
  } finally {
    check.close();
  }
  renameSync(part, join(dir, name));
  const snaps = readdirSync(dir).filter((n) => n.startsWith('booth-') && n.endsWith('.db')).sort();
  for (const old of snaps.slice(0, Math.max(0, snaps.length - SNAPSHOTS_KEPT))) unlinkSync(join(dir, old));
}

export interface BackupStatus {
  destination: Destination | null;
  lastBackupAt: string | null;
  daysSince: number | null;
  releasesNotBackedUp: number;
  filesToCopy: number;
  bytesToCopy: number;
  running: { startedAt: string; filesTotal: number; filesDone: number; bytesTotal: number; bytesDone: number } | null;
  lastRun: { state: string; finishedAt: string | null; error: string | null; failed: number } | null;
}

/** What the nudge and the panel say. Compares the file list with what the destination recorded. */
export function backupStatus(db: Database, opts: { libraryRoots?: string[]; now?: Date } = {}): BackupStatus {
  const destination = getDestination(db, { libraryRoots: opts.libraryRoots ?? [] });
  const status: BackupStatus = {
    destination, lastBackupAt: null, daysSince: null, releasesNotBackedUp: 0, filesToCopy: 0, bytesToCopy: 0, running: null, lastRun: null,
  };
  const items = new Map<string, { size: number; mtime_ms: number }>();
  if (destination) {
    for (const r of db.prepare(`SELECT file_id, size, mtime_ms FROM backup_item WHERE destination_id = ?`).all(destination.id) as { file_id: string; size: number; mtime_ms: number }[]) {
      items.set(r.file_id, r);
    }
    const done = db.prepare(`SELECT finished_at FROM backup_run WHERE destination_id = ? AND state = 'done' ORDER BY started_at DESC LIMIT 1`).get(destination.id) as { finished_at: string } | null;
    if (done) {
      status.lastBackupAt = done.finished_at;
      status.daysSince = Math.floor(((opts.now ?? new Date()).getTime() - Date.parse(done.finished_at)) / DAY_MS);
    }
    const run = db.prepare(`SELECT * FROM backup_run WHERE destination_id = ? ORDER BY started_at DESC LIMIT 1`).get(destination.id) as
      | { state: string; started_at: string; finished_at: string | null; files_total: number; files_done: number; bytes_total: number; bytes_done: number; error: string | null; failed: string | null }
      | null;
    if (run?.state === 'running') {
      status.running = { startedAt: run.started_at, filesTotal: run.files_total, filesDone: run.files_done, bytesTotal: run.bytes_total, bytesDone: run.bytes_done };
    } else if (run) {
      status.lastRun = { state: run.state, finishedAt: run.finished_at, error: run.error, failed: run.failed ? (JSON.parse(run.failed) as unknown[]).length : 0 };
    }
  }
  const outstanding = new Set<string>();
  for (const f of libraryFiles(db)) {
    const held = items.get(f.id);
    if (held && held.size === f.size && held.mtime_ms === f.mtime_ms) continue;
    status.filesToCopy++;
    status.bytesToCopy += f.size ?? 0;
    if (f.release_id) outstanding.add(f.release_id);
  }
  status.releasesNotBackedUp = outstanding.size;
  return status;
}

/** A run interrupted by a restart can't still be running. */
export function markInterruptedRuns(db: Database): void {
  db.prepare(`UPDATE backup_run SET state = 'stopped', finished_at = COALESCE(finished_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE state = 'running'`).run();
}
