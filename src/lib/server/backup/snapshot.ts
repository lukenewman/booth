import type { Database } from 'bun:sqlite';
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';

/**
 * Whole-database snapshots via `VACUUM INTO`.
 *
 * This is the coarse half of the backup story. It captures everything —
 * library metadata, source links, playlists, annotations — but restoring one
 * rewinds all of it, which is rarely what you want after losing just
 * annotations. The journal (see ./journal.ts) is the surgical half.
 *
 * `VACUUM INTO` is used rather than copying the file because it takes a
 * consistent snapshot of a live database without a read lock on the caller,
 * and it writes a compacted copy with no WAL to reason about.
 */

export interface SnapshotFile {
  name: string;
  mtimeMs: number;
}

export interface SnapshotOptions {
  dir: string;
  /** How many snapshots to retain, newest first. */
  keep: number;
  /** Injected for tests and for deterministic filenames. */
  now?: Date;
}

/** Oldest-first list of files beyond the retention cap. */
export function snapshotsToPrune(files: SnapshotFile[], keep: number): SnapshotFile[] {
  const sorted = [...files].sort((a, b) => a.mtimeMs - b.mtimeMs);
  const excess = sorted.length - keep;
  return excess > 0 ? sorted.slice(0, excess) : [];
}

/**
 * Whether enough time has passed since the newest snapshot.
 *
 * Load-bearing under `bun dev`, which restarts the server on every file save.
 * Without this a boot-triggered snapshot would fire dozens of times an hour and
 * rotate every genuinely old backup out of retention — turning the backup
 * system into an elaborate way to keep ten copies of the last five minutes.
 */
export function shouldSnapshot(
  newestMtimeMs: number | null,
  nowMs: number,
  minIntervalMs: number,
): boolean {
  if (newestMtimeMs === null) return true;
  return nowMs - newestMtimeMs >= minIntervalMs;
}

function stamp(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  );
}

export function listSnapshots(dir: string): SnapshotFile[] {
  try {
    return readdirSync(dir)
      .filter((n) => n.startsWith('booth-') && n.endsWith('.db'))
      .map((name) => ({ name, mtimeMs: statSync(join(dir, name)).mtimeMs }));
  } catch {
    return [];
  }
}

export function newestSnapshotMtime(dir: string): number | null {
  const files = listSnapshots(dir);
  if (files.length === 0) return null;
  return Math.max(...files.map((f) => f.mtimeMs));
}

/**
 * Write a snapshot and apply retention. Returns the path written, or null if
 * the write failed (backups must never take the app down).
 */
export function snapshotDb(db: Database, opts: SnapshotOptions): string | null {
  const now = opts.now ?? new Date();
  const dir = opts.dir;
  const target = join(dir, `booth-${stamp(now)}.db`);

  try {
    mkdirSync(dir, { recursive: true });
    // Bun's sqlite has no parameter binding for VACUUM INTO; the path is
    // process-controlled (never user input), and quotes are escaped anyway.
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } catch (e) {
    console.warn('[backup] snapshot failed:', e);
    return null;
  }

  for (const f of snapshotsToPrune(listSnapshots(dir), opts.keep)) {
    try {
      unlinkSync(join(dir, f.name));
    } catch {
      // a snapshot we cannot delete is not worth failing over
    }
  }

  return target;
}
