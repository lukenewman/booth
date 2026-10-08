import type { Database } from 'bun:sqlite';
import { ulid } from 'ulid';
import { collate, type CollateSummary } from './collate';
import { relinkMissing, type RelinkSummary } from './relink';
import { getSource } from '../sources/registry';
import { NotImplementedError, type IngestReport, type SyncInput } from '../sources/types';
import { hydrateDiscogsTracks } from '../sources/discogs/hydrateDiscogsTracks';
import { resolvedRecordingsRoot } from '../recording/env';
import {
  hasFfmpeg,
  isAnalysisRunning,
  pendingAnalysis,
  startBackgroundAnalysis,
  type AnalysisCounts,
} from '../analysis/run';

/**
 * What lands in `sync_run.summary`: the collate counts plus, for file-backed
 * adapters, the provenance of the input and whether it was unchanged since the
 * previous run.
 */
export type SyncRunSummary = CollateSummary & {
  input?: SyncInput;
  /**
   * True when this run parsed an input file byte-identical in mtime to the
   * previous run's. The run still succeeded — it just cannot have imported
   * anything new, which is otherwise indistinguishable from a clean no-op.
   */
  stale?: boolean;
  /**
   * Tempo analysis for tracks this run left without a BPM. Absent when there
   * was nothing to analyse, so an ordinary no-op run stays uncluttered.
   *
   * `running` is replaced with `done` by the background pass after the run row
   * has already been marked finished. The row's timestamps therefore predate
   * its final text — accepted deliberately, because the alternative is either
   * never reporting the outcome or giving analysis its own history rows.
   */
  analysis?: AnalysisState;
  /**
   * Drop-folder activity, present only when the inbox had something in it or
   * the library tree holds ingested files. Absent on an ordinary run so a
   * no-op summary stays uncluttered, which is the same rule `analysis` follows.
   */
  ingest?: IngestReport;
  /**
   * Playlist entries / crate records re-attached by name after this run.
   * Absent when nothing was re-linked, like `analysis` and `ingest`.
   */
  playlistsRelinked?: RelinkSummary;
};

export type AnalysisState =
  /** ffmpeg is not installed, so these tracks cannot be analysed at all. */
  | { state: 'unavailable'; pending: number }
  | { state: 'running'; pending: number }
  | ({ state: 'done' } & AnalysisCounts);

export interface SyncRunRow {
  id: string;
  source: string;
  started_at: string;
  finished_at: string | null;
  summary: SyncRunSummary | null;
  error: string | null;
}

/**
 * Run one source's sync end-to-end (adapter.sync → collate) and log the
 * outcome to sync_run. Returns the run row. NotImplementedError is rethrown
 * so the caller can map it to HTTP 501.
 */
export async function runSync(db: Database, sourceId: string): Promise<SyncRunRow> {
  const source = getSource(sourceId);
  if (!source) throw new Error(`unknown source: ${sourceId}`);

  const id = ulid();
  db.prepare(`INSERT INTO sync_run (id, source) VALUES (?, ?)`).run(id, sourceId);

  try {
    const result = await source.sync();
    const summary: SyncRunSummary = collate(db, sourceId, result, {
      recordingsRoot: resolvedRecordingsRoot(),
    });

    // Flag a run whose input file hasn't been rewritten since the previous run.
    // Without this an adapter re-parsing a frozen export reports the same clean
    // counts forever, which reads as a healthy sync (see the Apple-Music XML
    // going stale for three months, 2026-05 → 2026-08).
    if (result.ingest && (result.ingest.tracked > 0 || result.ingest.waiting > 0 || result.ingest.failed.length > 0)) {
      summary.ingest = result.ingest;
    }

    if (result.input) {
      summary.input = result.input;
      const previous = previousInput(db, sourceId, id);
      if (previous && previous.mtime === result.input.mtime) summary.stale = true;
    }

    // After collating Discogs releases, fetch tracklists for any that don't
    // have track rows yet.  Results are folded into the summary so the
    // sync_run row reflects the full work done this run.
    if (sourceId === 'discogs') {
      const hydration = await hydrateDiscogsTracks(db);
      summary.tracksUpserted += hydration.tracksAdded;
      summary.rowsIn += hydration.tracksAdded;
    }

    // Refresh query-planner statistics now that this run has changed the data.
    // Without stats SQLite mis-plans the correlated EXISTS subqueries behind the
    // source-filtered artist list (driving from source_link instead of the
    // artist's releases/tracks), turning a ~1ms query into ~500ms. ANALYZE is
    // <10ms on this DB and sync is exactly when the row counts shift.
    // A moved or renamed file comes back as a new track row within this run;
    // re-attach any playlist entries that lost theirs (see relink.ts).
    const relinked = relinkMissing(db);
    if (relinked.tracks || relinked.releases) summary.playlistsRelinked = relinked;

    db.exec('ANALYZE');

    // Tempo analysis runs *behind* the sync: a run that ingests a few hundred
    // tracks would otherwise sit there for half a minute finishing something
    // nobody is waiting on. The ffmpeg check is cached and costs ~10ms, so
    // whether it can run at all is decided here and lands on the row
    // immediately rather than surfacing later.
    const candidates = pendingAnalysis(db);
    if (candidates.length > 0) {
      if (!(await hasFfmpeg())) {
        summary.analysis = { state: 'unavailable', pending: candidates.length };
      } else if (!isAnalysisRunning()) {
        summary.analysis = { state: 'running', pending: candidates.length };
      }
      // Otherwise a pass is already in flight and will cover these tracks. It
      // reports against the run that started it, so this row claims nothing —
      // the field is decided *before* the write, because a row that says
      // "analysing…" with no pass of its own has no callback coming to correct
      // it and stays that way forever.
    }

    db.prepare(
      `UPDATE sync_run
          SET finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              summary     = ?
        WHERE id = ?`,
    ).run(JSON.stringify(summary), id);

    // Started after the row is written, so the completion callback cannot race
    // the initial write and lose its own result. Nothing has awaited since the
    // isAnalysisRunning() check above, so this cannot lose the race for the
    // guard either — but if it somehow does, clear the claim rather than
    // stranding the row.
    if (summary.analysis?.state === 'running') {
      const started = startBackgroundAnalysis(db, candidates, (counts) =>
        recordAnalysisOutcome(db, id, counts),
      );
      if (!started) {
        delete summary.analysis;
        db.prepare(`UPDATE sync_run SET summary = ? WHERE id = ?`).run(
          JSON.stringify(summary),
          id,
        );
      }
    }

    return loadSyncRun(db, id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    db.prepare(
      `UPDATE sync_run
          SET finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              error       = ?
        WHERE id = ?`,
    ).run(message, id);
    if (err instanceof NotImplementedError) throw err;
    throw err;
  }
}

/**
 * Fold the finished pass's counts into a run row that is already marked done.
 * Re-reads the stored summary rather than reusing the in-memory object, because
 * minutes may have passed and this must not clobber anything written since.
 */
function recordAnalysisOutcome(db: Database, runId: string, counts: AnalysisCounts): void {
  const row = db.prepare(`SELECT summary FROM sync_run WHERE id = ?`).get(runId) as
    | { summary: string | null }
    | undefined;
  if (!row?.summary) return;

  let summary: SyncRunSummary;
  try {
    summary = JSON.parse(row.summary) as SyncRunSummary;
  } catch {
    return;
  }
  summary.analysis = { state: 'done', ...counts };
  db.prepare(`UPDATE sync_run SET summary = ? WHERE id = ?`).run(JSON.stringify(summary), runId);
}

export function listSyncRuns(
  db: Database,
  sourceId: string,
  limit = 20,
): SyncRunRow[] {
  const rows = db
    .prepare(
      `SELECT id, source, started_at, finished_at, summary, error
         FROM sync_run
        WHERE source = ?
        ORDER BY started_at DESC
        LIMIT ?`,
    )
    .all(sourceId, limit) as Array<{
      id: string;
      source: string;
      started_at: string;
      finished_at: string | null;
      summary: string | null;
      error: string | null;
    }>;
  return rows.map(parseRow);
}

/**
 * The input provenance recorded by the most recent prior run of this source
 * that got far enough to write a summary. Excludes `exceptId` so the in-flight
 * run doesn't compare against itself.
 */
function previousInput(db: Database, sourceId: string, exceptId: string): SyncInput | null {
  const row = db
    .prepare(
      `SELECT json_extract(summary, '$.input') AS input
         FROM sync_run
        WHERE source = ? AND id <> ? AND summary IS NOT NULL
        ORDER BY started_at DESC
        LIMIT 1`,
    )
    .get(sourceId, exceptId) as { input: string | null } | undefined;
  if (!row?.input) return null;
  return JSON.parse(row.input) as SyncInput;
}

function loadSyncRun(db: Database, id: string): SyncRunRow {
  const row = db
    .prepare(
      `SELECT id, source, started_at, finished_at, summary, error
         FROM sync_run WHERE id = ?`,
    )
    .get(id) as {
      id: string;
      source: string;
      started_at: string;
      finished_at: string | null;
      summary: string | null;
      error: string | null;
    };
  return parseRow(row);
}

function parseRow(row: {
  id: string;
  source: string;
  started_at: string;
  finished_at: string | null;
  summary: string | null;
  error: string | null;
}): SyncRunRow {
  return {
    id: row.id,
    source: row.source,
    started_at: row.started_at,
    finished_at: row.finished_at,
    summary: row.summary ? (JSON.parse(row.summary) as SyncRunSummary) : null,
    error: row.error,
  };
}
