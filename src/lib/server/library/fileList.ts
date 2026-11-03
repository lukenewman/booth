import type { Database } from 'bun:sqlite';
import { existsSync, statSync } from 'node:fs';
import { ulid } from 'ulid';
import { FfmpegMissingError } from '../analysis/decode';
import type { FileTags } from './tags';

/**
 * The file list: every audio file Booth knows about, wherever it lives.
 *
 * A track is one of these files (its local source_link's external_id is the
 * row id), so the row's id must survive everything that happens to a file:
 * retags, renames, moves. Two things carry identity across a move: a catalog's
 * own id for the file (see catalogs.ts) and the audio fingerprint here. A new
 * path whose fingerprint matches exactly one known file that is no longer
 * where it was, and whose old path nobody still asks for, is that file moved.
 *
 * Reads are cached on size + mtime. A file whose size and mtime still match is
 * not touched, which is what keeps a 4,400-file sync to a round of stat calls.
 * Rows are written as each batch finishes, so an interrupted first scan picks
 * up where it stopped.
 *
 * This module only reads audio files. It never writes one.
 */

export type Ownership = 'in_place' | 'booth';

export interface FileRow {
  id: string;
  path: string;
  fingerprint: string | null;
  tags: FileTags | null;
  ownership: Ownership;
  present: boolean;
  /** Taken out of the library from the needs-attention list. */
  excluded: boolean;
}

export interface FileListDeps {
  fingerprint(path: string): Promise<string>;
  readTags(path: string): Promise<FileTags>;
}

export interface FileScanSummary {
  /** Distinct paths asked for. */
  known: number;
  /** Files whose tags or fingerprint were read this scan. */
  read: number;
  /** Files recognised at a new path. */
  moved: number;
  /** Paths asked for with no file behind them. */
  missing: number;
  /** ffmpeg was not available, so nothing was fingerprinted. */
  fingerprintsUnavailable: boolean;
  unreadable: { path: string; error: string }[];
}

interface DbRow {
  id: string;
  path: string;
  fingerprint: string | null;
  fingerprint_tried: number;
  size: number | null;
  mtime_ms: number | null;
  tags: string | null;
  ownership: Ownership;
  present: number;
  excluded: number;
}

interface Job {
  path: string;
  ownership: Ownership;
  size: number;
  mtimeMs: number;
  row: DbRow | null;
  /** Tags are still good; only the fingerprint is owed. */
  fingerprintOnly: boolean;
}

interface ReadResult extends Job {
  tags: string | null;
  fingerprint: string | null;
  fingerprintTried: number;
}

const BATCH = 4;
const now = () => new Date().toISOString();
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function toFileRow(r: DbRow): FileRow {
  return {
    id: r.id,
    path: r.path,
    fingerprint: r.fingerprint,
    tags: r.tags ? (JSON.parse(r.tags) as FileTags) : null,
    ownership: r.ownership,
    present: r.present === 1,
    excluded: r.excluded !== 0,
  };
}

export function fileByPath(db: Database, path: string): FileRow | null {
  const r = db.prepare(`SELECT * FROM audio_file WHERE path = ?`).get(path) as DbRow | null;
  return r ? toFileRow(r) : null;
}

export async function scanFiles(
  db: Database,
  wanted: { path: string; ownership: Ownership }[],
  deps: FileListDeps,
): Promise<{ files: Map<string, FileRow>; summary: FileScanSummary }> {
  const summary: FileScanSummary = { known: 0, read: 0, moved: 0, missing: 0, fingerprintsUnavailable: false, unreadable: [] };

  // A path wanted as Booth-owned anywhere is Booth-owned.
  const ownershipOf = new Map<string, Ownership>();
  for (const w of wanted) {
    if (ownershipOf.get(w.path) !== 'booth') ownershipOf.set(w.path, w.ownership);
  }
  summary.known = ownershipOf.size;

  const byPath = db.prepare(`SELECT * FROM audio_file WHERE path = ?`);
  const jobs: Job[] = [];

  for (const [path, ownership] of ownershipOf) {
    const row = byPath.get(path) as DbRow | null;
    let st: { size: number; mtimeMs: number } | null = null;
    try {
      const s = statSync(path);
      if (s.isFile()) st = { size: s.size, mtimeMs: Math.floor(s.mtimeMs) };
    } catch {
      st = null;
    }

    if (!st) {
      summary.missing++;
      if (row) {
        db.prepare(`UPDATE audio_file SET present = 0, missing_since = COALESCE(missing_since, ?), ownership = ? WHERE id = ?`)
          .run(now(), ownership, row.id);
      } else {
        db.prepare(`INSERT INTO audio_file (id, path, ownership, present, missing_since) VALUES (?, ?, ?, 0, ?)`)
          .run(ulid(), path, ownership, now());
      }
      continue;
    }

    const unchanged = !!row && row.size === st.size && row.mtime_ms === st.mtimeMs;
    if (unchanged && (row!.fingerprint !== null || row!.fingerprint_tried === 1)) {
      db.prepare(`UPDATE audio_file SET present = 1, missing_since = NULL, ownership = ?, last_seen_at = ? WHERE id = ?`)
        .run(ownership, now(), row!.id);
      continue;
    }
    jobs.push({ path, ownership, size: st.size, mtimeMs: st.mtimeMs, row, fingerprintOnly: unchanged });
  }

  for (let i = 0; i < jobs.length; i += BATCH) {
    const done = await Promise.all(jobs.slice(i, i + BATCH).map((job) => readJob(job, deps, summary)));
    db.transaction(() => {
      for (const d of done) writeJob(db, d, ownershipOf, summary);
    })();
  }

  const files = new Map<string, FileRow>();
  for (const path of ownershipOf.keys()) {
    const r = byPath.get(path) as DbRow | null;
    if (r) files.set(path, toFileRow(r));
  }
  return { files, summary };
}

async function readJob(job: Job, deps: FileListDeps, summary: FileScanSummary): Promise<ReadResult> {
  let tags: string | null = job.fingerprintOnly ? job.row!.tags : null;
  if (!job.fingerprintOnly) {
    try {
      tags = JSON.stringify(await deps.readTags(job.path));
    } catch (e) {
      summary.unreadable.push({ path: job.path, error: message(e) });
    }
  }

  let fingerprint: string | null = null;
  let fingerprintTried = 0;
  if (!summary.fingerprintsUnavailable) {
    try {
      fingerprint = await deps.fingerprint(job.path);
      fingerprintTried = 1;
    } catch (e) {
      if (e instanceof FfmpegMissingError) {
        summary.fingerprintsUnavailable = true;
      } else {
        fingerprintTried = 1;
        if (tags !== null) summary.unreadable.push({ path: job.path, error: message(e) });
      }
    }
  }
  summary.read++;
  return { ...job, tags, fingerprint, fingerprintTried };
}

function writeJob(db: Database, d: ReadResult, wanted: Map<string, Ownership>, summary: FileScanSummary): void {
  const stamp = now();
  // A file whose tags couldn't be read is not cached: the cause may be
  // passing (macOS refusing the Music folder until access is granted), so the
  // next scan tries again. A genuinely corrupt file costs one retry per sync.
  const cached = d.tags !== null;
  const size = cached ? d.size : null;
  const mtimeMs = cached ? d.mtimeMs : null;
  const fingerprintTried = cached ? d.fingerprintTried : 0;
  if (d.row) {
    db.prepare(
      `UPDATE audio_file SET size = ?, mtime_ms = ?, tags = ?, fingerprint = ?, fingerprint_tried = ?,
              ownership = ?, present = 1, missing_since = NULL, last_seen_at = ? WHERE id = ?`,
    ).run(size, mtimeMs, d.tags, d.fingerprint, fingerprintTried, d.ownership, stamp, d.row.id);
    return;
  }

  // A new path. Is it a file we already know, moved? Only if exactly one
  // known file has this audio, nobody still asks for its old path, and
  // nothing is there any more. A copy turning up beside a present original
  // is a duplicate, never a move. A file the user took out of the library is
  // never the candidate: a new copy of its audio would silently inherit that
  // decision and vanish (catalog moves still carry it, by catalog id).
  if (d.fingerprint) {
    const candidates = (db
      .prepare(`SELECT id, path FROM audio_file WHERE fingerprint = ? AND excluded = 0`)
      .all(d.fingerprint) as { id: string; path: string }[]).filter((c) => !wanted.has(c.path) && !existsSync(c.path));
    if (candidates.length === 1) {
      db.prepare(
        `UPDATE audio_file SET path = ?, size = ?, mtime_ms = ?, tags = ?, fingerprint_tried = ?,
                ownership = ?, present = 1, missing_since = NULL, last_seen_at = ? WHERE id = ?`,
      ).run(d.path, size, mtimeMs, d.tags, fingerprintTried, d.ownership, stamp, candidates[0].id);
      summary.moved++;
      return;
    }
  }

  db.prepare(
    `INSERT INTO audio_file (id, path, fingerprint, fingerprint_tried, size, mtime_ms, tags, ownership, present, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
  ).run(ulid(), d.path, d.fingerprint, fingerprintTried, size, mtimeMs, d.tags, d.ownership, stamp);
}
