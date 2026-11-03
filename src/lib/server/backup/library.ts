import type { Database } from 'bun:sqlite';
import { Database as SqliteDatabase } from 'bun:sqlite';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, sep } from 'node:path';
import { ulid } from 'ulid';

/**
 * Booth's own backups of the library (BOO-103): every present library file
 * and a database snapshot, copied to a folder the user picked, with a record
 * of what that folder holds.
 *
 * The record is only trusted while the destination is provably the same
 * backup: Booth writes a marker with the destination's id into its "Booth
 * Backup" folder, and an unplugged drive, an empty mount point or a different
 * drive at the same path has no marker (or another one). Such a destination
 * is offline: status says so, and a run refuses rather than writing a backup
 * onto whatever disk is under the path.
 *
 * Copies mirror absolute paths under `Booth Backup/files`, so a backup is
 * usable without Booth. A copy is written under a temporary name and renamed
 * into place only once its bytes match the original's (sha256) and the
 * original didn't change while it was copied. Runs are incremental; "check
 * every copy" re-hashes copies against what was recorded. Booth adds and
 * updates copies but never removes a file from the backup; it keeps the
 * newest database snapshots. One run per destination at a time, across
 * processes, through a lock file.
 */

export const BACKUP_DIR = 'Booth Backup';
const MARKER = '.booth-destination';
const LOCK = '.booth-backup.lock';
const LOCK_STALE_MS = 10 * 60_000;
const SNAPSHOTS_KEPT = 10;
const DAY_MS = 86_400_000;
const PART = '.booth-part';

export interface BackupDeps {
  /** The audio fingerprint, as the file list computes it (checks copies recorded before byte hashes existed). */
  fingerprint(path: string): Promise<string>;
  /** Write a consistent copy of the database to `to` (VACUUM INTO). */
  snapshotDb(to: string): void;
  /** Bytes free where `dir` lives. */
  freeBytes(dir: string): number;
  copyFile?(from: string, to: string): Promise<void>;
}

export class BackupError extends Error {}

export interface Destination { id: string; path: string; sameDisk: boolean; online: boolean }

const inside = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };

function readMarker(path: string): string | null {
  try { return readFileSync(join(path, BACKUP_DIR, MARKER), 'utf8').trim() || null; } catch { return null; }
}

function sameDiskAs(path: string, roots: string[]): boolean {
  try {
    const dev = statSync(path).dev;
    return roots.some((r) => { try { return statSync(r).dev === dev; } catch { return false; } });
  } catch {
    return false;
  }
}

/**
 * Use `path` as the backup destination. Refused when it doesn't exist, can't
 * be written, or sits inside the library (symlinks resolved), and while a
 * backup is running. A folder that already holds a Booth backup is adopted
 * with its record; otherwise a new destination and marker are made. Other
 * destinations are kept, inactive, with their records.
 */
export function setDestination(db: Database, path: string, opts: { libraryRoots: string[]; running?: boolean }): Destination {
  if (opts.running) throw new BackupError('A backup is running. Stop it before changing the backup folder.');
  if (!isAbsolute(path)) throw new BackupError('Give the folder’s full path.');
  let dest: string;
  try {
    dest = realpathSync(path);
    if (!statSync(dest).isDirectory()) throw new Error();
    accessSync(dest, constants.W_OK);
  } catch {
    throw new BackupError('That folder doesn’t exist, or Booth can’t write to it.');
  }
  if (opts.libraryRoots.map(real).some((r) => inside(dest, r))) {
    throw new BackupError('That folder is inside your music library. Pick one outside it, ideally on another drive.');
  }
  const marked = readMarker(dest);
  const known = marked ? (db.prepare(`SELECT id FROM backup_destination WHERE id = ?`).get(marked) as { id: string } | null) : null;
  const id = known?.id ?? marked ?? ulid();
  mkdirSync(join(dest, BACKUP_DIR), { recursive: true });
  if (!marked) writeFileSync(join(dest, BACKUP_DIR, MARKER), id + '\n');
  const sameDisk = sameDiskAs(dest, opts.libraryRoots) ? 1 : 0;
  db.transaction(() => {
    db.prepare(`UPDATE backup_destination SET active = 0`).run();
    if (known) db.prepare(`UPDATE backup_destination SET active = 1, path = ?, same_disk = ? WHERE id = ?`).run(dest, sameDisk, id);
    else db.prepare(`INSERT INTO backup_destination (id, path, active, same_disk) VALUES (?, ?, 1, ?)`).run(id, dest, sameDisk);
  })();
  return getDestination(db, opts)!;
}

/** The active destination; `online` only when its marker is there and names it. */
export function getDestination(db: Database, opts: { libraryRoots: string[] } = { libraryRoots: [] }): Destination | null {
  const row = db.prepare(`SELECT id, path, same_disk FROM backup_destination WHERE active = 1 ORDER BY added_at DESC LIMIT 1`).get() as
    | { id: string; path: string; same_disk: number }
    | null;
  if (!row) return null;
  const online = readMarker(row.path) === row.id;
  // Recorded when it was set; refreshed while the drive is here.
  const sameDisk = online && opts.libraryRoots.length ? sameDiskAs(row.path, opts.libraryRoots) : row.same_disk === 1;
  return { id: row.id, path: row.path, sameDisk, online };
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
const pidAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Take the destination's lock, or say who holds it. A lock from a dead process or without a recent heartbeat is stale. */
function takeLock(base: string): (() => void) | string {
  const path = join(base, LOCK);
  try {
    const held = JSON.parse(readFileSync(path, 'utf8')) as { pid: number; at: number };
    if (pidAlive(held.pid) && Date.now() - held.at < LOCK_STALE_MS) return 'A backup to this folder is already running.';
  } catch { /* no lock, or unreadable: take it */ }
  const write = () => writeFileSync(path, JSON.stringify({ pid: process.pid, at: Date.now() }));
  write();
  return () => { try { unlinkSync(path); } catch { /* gone already */ } };
}

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
    ).run(
      state, result.filesCopied + result.filesSkipped, result.bytesCopied,
      result.failed.length ? JSON.stringify({ count: result.failed.length, first: result.failed.slice(0, 50) }) : null,
      error ?? null, runId,
    );
    return result;
  };

  // Never create the destination itself: a missing one is an unplugged drive,
  // and creating it would put the backup on whatever disk is underneath.
  if (!dest.online) return finish('failed', 'The backup drive isn’t connected, or this isn’t the same backup folder.');
  const base = join(dest.path, BACKUP_DIR);
  const lock = takeLock(base);
  if (typeof lock === 'string') return finish('failed', lock);
  const heartbeat = () => { try { writeFileSync(join(base, LOCK), JSON.stringify({ pid: process.pid, at: Date.now() })); } catch { /* best effort */ } };

  try {
    mkdirSync(join(base, 'files'), { recursive: true });
    mkdirSync(join(base, 'database'), { recursive: true });

    const heldStmt = db.prepare(`SELECT size, mtime_ms, sha256 FROM backup_item WHERE destination_id = ? AND file_id = ?`);
    type Job = { file: LibraryFile; size: number; mtimeMs: number; to: string; check?: { sha256: string | null } };
    const jobs: Job[] = [];
    for (const file of libraryFiles(db)) {
      let st;
      try { st = statSync(file.path); } catch (e) { result.failed.push({ path: file.path, error: message(e) }); continue; }
      const size = st.size;
      const mtimeMs = Math.floor(st.mtimeMs);
      const to = join(base, 'files', file.path.replace(/^\/+/, ''));
      const held = heldStmt.get(dest.id, file.id) as { size: number; mtime_ms: number; sha256: string | null } | null;
      let copyHeld = false;
      try { copyHeld = statSync(to).size === size; } catch { copyHeld = false; }
      const fresh = !!held && held.size === size && held.mtime_ms === mtimeMs && copyHeld;
      if (!fresh) jobs.push({ file, size, mtimeMs, to });
      else if (opts.verify) jobs.push({ file, size, mtimeMs, to, check: { sha256: held!.sha256 } });
      else result.filesSkipped++;
    }
    const toCopy = jobs.filter((j) => !j.check);
    const bytesNeeded = toCopy.reduce((n, j) => n + j.size, 0);
    db.prepare(`UPDATE backup_run SET files_total = ?, bytes_total = ? WHERE id = ?`).run(jobs.length + result.filesSkipped, jobs.reduce((n, j) => n + j.size, 0), runId);
    const free = deps.freeBytes(dest.path);
    if (bytesNeeded > free) return finish('failed', `Not enough space on the backup drive: needs ${gb(bytesNeeded)}, has ${gb(free)}.`);

    const copy = deps.copyFile ?? ((from: string, to: string) => copyFile(from, to));
    const record = db.prepare(
      `INSERT INTO backup_item (destination_id, file_id, fingerprint, sha256, size, mtime_ms, dest_path, backed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT (destination_id, file_id) DO UPDATE SET fingerprint = excluded.fingerprint, sha256 = excluded.sha256,
         size = excluded.size, mtime_ms = excluded.mtime_ms, dest_path = excluded.dest_path, backed_at = excluded.backed_at`,
    );
    const progress = db.prepare(`UPDATE backup_run SET files_done = ?, bytes_done = ? WHERE id = ?`);
    let bytesDone = 0;
    for (const j of jobs) {
      if (opts.shouldStop?.()) return finish('stopped');
      if (j.check) {
        let intact = false;
        try {
          intact = j.check.sha256
            ? (await hashFile(j.to)) === j.check.sha256
            : !!j.file.fingerprint && (await deps.fingerprint(j.to)) === j.file.fingerprint;
        } catch { intact = false; }
        if (intact) {
          result.filesSkipped++;
          bytesDone += j.size;
          progress.run(result.filesCopied + result.filesSkipped, bytesDone, runId);
          continue;
        }
      }
      const part = `${j.to}${PART}`;
      try {
        mkdirSync(dirname(j.to), { recursive: true });
        await copy(j.file.path, part);
        const after = statSync(j.file.path);
        if (after.size !== j.size || Math.floor(after.mtimeMs) !== j.mtimeMs) throw new Error('the file changed while it was being copied');
        const sha256 = await hashFile(part);
        if (statSync(part).size !== j.size || sha256 !== (await hashFile(j.file.path))) throw new Error('the copy doesn’t match the original');
        renameSync(part, j.to);
        record.run(dest.id, j.file.id, j.file.fingerprint, sha256, j.size, j.mtimeMs, j.to);
        result.filesCopied++;
        result.bytesCopied += j.size;
      } catch (e) {
        try { if (existsSync(part)) unlinkSync(part); } catch { /* best effort */ }
        result.failed.push({ path: j.file.path, error: message(e) });
      }
      bytesDone += j.size;
      progress.run(result.filesCopied + result.filesSkipped, bytesDone, runId);
      heartbeat();
      opts.onProgress?.();
    }

    // The database last, so it describes everything copied above.
    try {
      writeSnapshot(join(base, 'database'), deps);
    } catch (e) {
      return finish('failed', `Couldn’t back up the database: ${message(e)}`);
    }
    return finish('done');
  } catch (e) {
    return finish('failed', message(e));
  } finally {
    lock();
  }
}

function writeSnapshot(dir: string, deps: BackupDeps): void {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const name = `booth-${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}-${ulid().slice(-6)}.db`;
  const part = join(dir, `${name}${PART}`);
  try {
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
  } finally {
    try { if (existsSync(part)) unlinkSync(part); } catch { /* best effort */ }
  }
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
  /** Files the destination holds. */
  filesHeld: number;
  running: { startedAt: string; filesTotal: number; filesDone: number; bytesTotal: number; bytesDone: number } | null;
  lastRun: { state: string; finishedAt: string | null; error: string | null; failed: number } | null;
}

/** What the nudge and the panel say. Compares the file list with what the destination recorded. */
export function backupStatus(db: Database, opts: { libraryRoots?: string[]; now?: Date } = {}): BackupStatus {
  const destination = getDestination(db, { libraryRoots: opts.libraryRoots ?? [] });
  const status: BackupStatus = {
    destination, lastBackupAt: null, daysSince: null, releasesNotBackedUp: 0, filesToCopy: 0, bytesToCopy: 0, filesHeld: 0, running: null, lastRun: null,
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
      let failed = 0;
      try { failed = run.failed ? (JSON.parse(run.failed) as { count: number }).count : 0; } catch { failed = 0; }
      status.lastRun = { state: run.state, finishedAt: run.finished_at, error: run.error, failed };
    }
  }
  const outstanding = new Set<string>();
  for (const f of libraryFiles(db)) {
    const held = items.get(f.id);
    if (held && held.size === f.size && held.mtime_ms === f.mtime_ms) { status.filesHeld++; continue; }
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
