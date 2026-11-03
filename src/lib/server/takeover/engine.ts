import type { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { dirname, extname, join, relative } from 'node:path';
import { ulid } from 'ulid';
import { WRITABLE } from '../library/migration';
import type { BoothTrackFacts } from '../library/tag_schema';
import type { FileTags } from '../library/tags';
import { dedupePath, ingestTargetPath } from '../sources/local/ingest_paths';
import { tagDifferences } from './rebuild';

/**
 * Takeover (BOO-102 step 6a): copy a release's files into Booth's folder,
 * write what Booth knows into the copies' tags, check them, and switch the
 * release's tracks to the copies.
 *
 * The originals are only ever read. Copies are written under a dotted staging
 * folder inside Booth's folder (every folder walk skips it), checked, and only
 * when every file of the release passed does one transaction record the
 * copies and re-point the tracks; the copies are then renamed into place. A
 * release that fails anywhere leaves nothing: its staged files are deleted
 * and a takeover finding says why. A crash mid-release leaves the release
 * pending and its staging behind; the next run clears the staging and does
 * the release again. Each copy's place (album artist / album / NN title) is
 * fixed from then on.
 */

export interface TakeoverDeps {
  /** Write `facts` into a copy of `source` at `dest`; returns the copy's audio fingerprint. Must refuse to change the audio. */
  writeTags(source: string, facts: BoothTrackFacts, dest: string): Promise<string>;
  readTags(path: string): Promise<FileTags>;
  fingerprint(path: string): Promise<string>;
  freeBytes(dir: string): number;
  copyFile?(from: string, to: string): Promise<void>;
}

export const STAGING = '.booth-takeover';

export interface TakeoverRunResult {
  state: 'done' | 'failed' | 'stopped';
  done: number;
  failed: number;
  error?: string;
}

interface FileJob {
  fileId: string;
  trackId: string;
  source: string;
  size: number;
  mtimeMs: number;
  fingerprint: string | null;
  facts: BoothTrackFacts;
  writable: boolean;
}

export class TakeoverError extends Error {}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const nowIso = () => new Date().toISOString();

/** A new takeover of `releaseIds`, every release pending. */
export function createTakeoverRun(db: Database, releaseIds: string[], opts: { sample?: boolean } = {}): string {
  const id = ulid();
  const ids = [...new Set(releaseIds)];
  db.transaction(() => {
    db.prepare(`INSERT INTO takeover_run (id, sample, releases_total) VALUES (?, ?, ?)`).run(id, opts.sample ? 1 : 0, ids.length);
    const ins = db.prepare(`INSERT INTO takeover_release (run_id, release_id) VALUES (?, ?)`);
    for (const r of ids) ins.run(id, r);
  })();
  return id;
}

/** What Booth knows about a track, as it goes into the copy's tags. */
export function factsForTrack(db: Database, trackId: string): BoothTrackFacts {
  const t = db
    .prepare(
      `SELECT t.title, ta.name AS artist, t.album, t.position, t.starred_at, t.note, t.release_id,
              r.title AS releaseTitle, ra.name AS albumArtist, r.year, r.vetted_at
         FROM track t JOIN artist ta ON ta.id = t.artist_id
         LEFT JOIN release r ON r.id = t.release_id
         LEFT JOIN artist ra ON ra.id = r.artist_id
        WHERE t.id = ?`,
    )
    .get(trackId) as {
      title: string; artist: string; album: string | null; position: string | null; starred_at: string | null; note: string | null;
      release_id: string | null; releaseTitle: string | null; albumArtist: string | null; year: number | null; vetted_at: string | null;
    };
  const facet: Record<string, unknown> = {};
  for (const f of db.prepare(`SELECT key, value FROM source_facets WHERE source = 'local' AND entity_kind = 'track' AND entity_id = ?`).all(trackId) as { key: string; value: string }[]) {
    try { facet[f.key] = JSON.parse(f.value); } catch { facet[f.key] = f.value; }
  }
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const discogs = t.release_id
    ? (db.prepare(`SELECT external_id FROM source_link WHERE source = 'discogs' AND entity_kind = 'release' AND entity_id = ?`).get(t.release_id) as { external_id: string } | null)
    : null;
  const no = t.position != null ? Number.parseInt(t.position, 10) : NaN;
  return {
    names: {
      title: t.title,
      artist: t.artist,
      album: t.album ?? t.releaseTitle ?? undefined,
      albumArtist: t.albumArtist ?? undefined,
      year: t.year ?? undefined,
      trackNumber: Number.isFinite(no) && no > 0 ? no : undefined,
    },
    dateAdded: str(facet.dateAdded),
    dateAddedReported: str(facet.dateAddedReported),
    dateAddedOrigin: str(facet.dateAddedOrigin),
    starred: t.starred_at != null,
    note: t.note ?? undefined,
    vetted: t.vetted_at != null,
    bpm: typeof facet.bpmAnalyzed === 'number' ? facet.bpmAnalyzed : undefined,
    origin: str(facet.origin),
    discogsReleaseId: discogs?.external_id,
  };
}

/** The files of a release still read in place, or why it can't be taken over. */
function jobsFor(db: Database, releaseId: string): { jobs: FileJob[] } | { problem: string } {
  const rows = db
    .prepare(
      `SELECT t.id AS trackId, f.id AS fileId, f.path, f.present, f.excluded, f.ownership, f.fingerprint,
              (SELECT 1 FROM audio_file c WHERE c.copy_of = f.id) AS hasCopy
         FROM track t
         JOIN source_link sl ON sl.source = 'local' AND sl.entity_kind = 'track' AND sl.entity_id = t.id
         JOIN audio_file f ON f.id = sl.external_id
        WHERE t.release_id = ?
        ORDER BY t.position, t.title`,
    )
    .all(releaseId) as { trackId: string; fileId: string; path: string; present: number; excluded: number; ownership: string; fingerprint: string | null; hasCopy: number | null }[];
  if (!rows.length) return { problem: 'This release has no files Booth can read.' };
  const jobs: FileJob[] = [];
  for (const r of rows) {
    if (r.ownership === 'booth' || r.hasCopy) continue; // already Booth's
    if (!r.present || !existsSync(r.path)) return { problem: `A file is missing: ${r.path}` };
    const st = statSync(r.path);
    jobs.push({
      fileId: r.fileId, trackId: r.trackId, source: r.path, size: st.size, mtimeMs: Math.floor(st.mtimeMs),
      fingerprint: r.fingerprint, facts: factsForTrack(db, r.trackId), writable: WRITABLE.has(extname(r.path).toLowerCase()),
    });
  }
  return { jobs };
}

async function sha256(path: string): Promise<string> {
  const h = new Bun.CryptoHasher('sha256');
  for await (const chunk of Bun.file(path).stream()) h.update(chunk);
  return h.digest('hex');
}

/**
 * Clear what a crash left in the staging folder. A staged file whose copy is
 * already recorded (the crash fell between the flip and the rename) is put in
 * place; anything else staged is an unfinished release and is deleted.
 */
export function recoverStaging(db: Database, root: string): void {
  const base = join(root, STAGING);
  if (!existsSync(base)) return;
  const recorded = db.prepare(`SELECT 1 FROM audio_file WHERE path = ? AND ownership = 'booth'`);
  for (const run of readdirSync(base)) {
    const runDir = join(base, run);
    for (const rel of readdirSync(runDir, { recursive: true }) as string[]) {
      const staged = join(runDir, rel);
      try { if (!statSync(staged).isFile()) continue; } catch { continue; }
      const final = join(root, rel);
      if (recorded.get(final) && !existsSync(final)) {
        mkdirSync(dirname(final), { recursive: true });
        renameSync(staged, final);
      } else {
        unlinkSync(staged);
      }
    }
    rmSync(runDir, { recursive: true, force: true });
  }
  try { if (!readdirSync(base).length) rmSync(base, { recursive: true }); } catch { /* best effort */ }
}

function raiseFinding(db: Database, releaseId: string, fileIds: string[], detail: string, runId: string): void {
  const key = `release:${releaseId}`;
  const row = db.prepare(`SELECT id, state FROM finding WHERE kind = 'takeover' AND subject_key = ?`).get(key) as { id: string; state: string } | null;
  if (!row) {
    db.prepare(`INSERT INTO finding (id, kind, subject_key, file_ids, raised_run_id, detail) VALUES (?, 'takeover', ?, ?, ?, ?)`).run(ulid(), key, JSON.stringify(fileIds), runId, detail);
  } else if (row.state !== 'settled') {
    db.prepare(`UPDATE finding SET state = 'open', file_ids = ?, raised_run_id = ?, raised_at = ?, cleared_at = NULL, detail = ? WHERE id = ?`).run(JSON.stringify(fileIds), runId, nowIso(), detail, row.id);
  }
}

/**
 * Take over one release. Returns the bytes copied, or throws a TakeoverError
 * whose message is the reason the release stays in place.
 */
async function takeOverRelease(db: Database, deps: TakeoverDeps, runId: string, releaseId: string, root: string): Promise<number> {
  const planned = jobsFor(db, releaseId);
  if ('problem' in planned) throw new TakeoverError(planned.problem);
  const { jobs } = planned;
  if (!jobs.length) return 0;

  const bytes = jobs.reduce((n, j) => n + j.size, 0);
  const free = deps.freeBytes(root);
  // Tags add a little to each file; leave headroom.
  if (bytes * 1.05 + 1e6 > free) throw new TakeoverError(`Not enough space in Booth’s folder: needs ${(bytes / 1e9).toFixed(1)} GB, has ${(free / 1e9).toFixed(1)} GB.`);

  const staging = join(root, STAGING, runId);
  const claimed = new Set<string>();
  const done: { job: FileJob; final: string; staged: string; fingerprint: string; tags: FileTags | null }[] = [];
  try {
    for (const job of jobs) {
      const target = ingestTargetPath(root, {
        albumArtist: job.facts.names?.albumArtist, artist: job.facts.names?.artist, album: job.facts.names?.album,
        title: job.facts.names?.title, trackNumber: job.facts.names?.trackNumber,
      }, job.source);
      const final = dedupePath(target, (x) => claimed.has(x) || existsSync(x));
      claimed.add(final);
      const staged = join(staging, relative(root, final));
      mkdirSync(dirname(staged), { recursive: true });

      const expected = job.fingerprint ?? (await deps.fingerprint(job.source));
      let fingerprint: string;
      let tags: FileTags | null = null;
      if (job.writable) {
        fingerprint = await deps.writeTags(job.source, job.facts, staged);
        if (fingerprint !== expected) throw new TakeoverError(`The copy’s audio didn’t match the original: ${job.source}`);
        tags = await deps.readTags(staged);
        const diffs = tagDifferences(job.facts, tags);
        if (diffs.length) throw new TakeoverError(`The copy’s tags didn’t take (${diffs.map((d) => d.field).join(', ')}): ${job.source}`);
      } else {
        await (deps.copyFile ?? ((a: string, b: string) => copyFile(a, b)))(job.source, staged);
        if ((await sha256(staged)) !== (await sha256(job.source))) throw new TakeoverError(`The copy didn’t match the original: ${job.source}`);
        fingerprint = expected;
        tags = await deps.readTags(staged).catch(() => null);
      }
      const after = statSync(job.source);
      if (after.size !== job.size || Math.floor(after.mtimeMs) !== job.mtimeMs) throw new TakeoverError(`The original changed while it was being copied: ${job.source}`);
      done.push({ job, final, staged, fingerprint, tags });
    }
  } catch (e) {
    rmSync(staging, { recursive: true, force: true });
    throw e instanceof TakeoverError ? e : new TakeoverError(message(e));
  }

  // Every file passed: record the copies and switch the tracks in one go,
  // then put the copies in place.
  const insert = db.prepare(
    `INSERT INTO audio_file (id, path, fingerprint, fingerprint_tried, size, mtime_ms, tags, ownership, present, copy_of, last_seen_at)
     VALUES (?, ?, ?, 1, ?, ?, ?, 'booth', 1, ?, ?)`,
  );
  const repoint = db.prepare(`UPDATE source_link SET external_id = ? WHERE source = 'local' AND entity_kind = 'track' AND external_id = ?`);
  db.transaction(() => {
    for (const d of done) {
      const st = statSync(d.staged);
      const id = ulid();
      insert.run(id, d.final, d.fingerprint, st.size, Math.floor(st.mtimeMs), d.tags ? JSON.stringify(d.tags) : null, d.job.fileId, nowIso());
      repoint.run(id, d.job.fileId);
    }
  })();
  for (const d of done) {
    mkdirSync(dirname(d.final), { recursive: true });
    renameSync(d.staged, d.final);
  }
  rmSync(staging, { recursive: true, force: true });
  return bytes;
}

/**
 * Work through a run's pending releases, one at a time. `shouldStop` is
 * honoured between releases, never in the middle of one. Not enough space
 * stops the run (every later release would fail the same way).
 */
export async function runTakeover(
  db: Database,
  deps: TakeoverDeps,
  runId: string,
  opts: { root: string; shouldStop?: () => boolean; onProgress?: () => void },
): Promise<TakeoverRunResult> {
  const result: TakeoverRunResult = { state: 'done', done: 0, failed: 0 };
  const finish = (state: TakeoverRunResult['state'], error?: string) => {
    result.state = state;
    if (error) result.error = error;
    db.prepare(`UPDATE takeover_run SET state = ?, finished_at = ?, error = ? WHERE id = ?`).run(state, nowIso(), error ?? null, runId);
    return result;
  };
  mkdirSync(opts.root, { recursive: true });
  recoverStaging(db, opts.root);
  db.prepare(`UPDATE takeover_run SET state = 'running', finished_at = NULL, error = NULL WHERE id = ?`).run(runId);

  const pending = (db.prepare(`SELECT release_id FROM takeover_release WHERE run_id = ? AND state = 'pending' ORDER BY rowid`).all(runId) as { release_id: string }[]).map((r) => r.release_id);
  const setState = db.prepare(`UPDATE takeover_release SET state = ?, error = ?, finished_at = ? WHERE run_id = ? AND release_id = ?`);
  const progress = db.prepare(`UPDATE takeover_run SET releases_done = releases_done + 1, bytes_done = bytes_done + ? WHERE id = ?`);
  for (const releaseId of pending) {
    if (opts.shouldStop?.()) return finish('stopped');
    try {
      const bytes = await takeOverRelease(db, deps, runId, releaseId, opts.root);
      db.transaction(() => {
        setState.run('done', null, nowIso(), runId, releaseId);
        progress.run(bytes, runId);
        db.prepare(`UPDATE finding SET state = 'cleared', cleared_at = ? WHERE kind = 'takeover' AND subject_key = ? AND state = 'open'`).run(nowIso(), `release:${releaseId}`);
      })();
      result.done++;
    } catch (e) {
      const reason = message(e);
      const fileIds = (db.prepare(`SELECT sl.external_id AS id FROM track t JOIN source_link sl ON sl.source = 'local' AND sl.entity_kind = 'track' AND sl.entity_id = t.id WHERE t.release_id = ?`).all(releaseId) as { id: string }[]).map((r) => r.id);
      db.transaction(() => {
        setState.run('failed', reason, nowIso(), runId, releaseId);
        progress.run(0, runId);
        raiseFinding(db, releaseId, fileIds, reason, runId);
      })();
      result.failed++;
      if (/not enough space/i.test(reason)) return finish('failed', reason);
    }
    opts.onProgress?.();
  }
  return finish('done');
}
