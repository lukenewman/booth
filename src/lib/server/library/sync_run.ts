import type { Database } from 'bun:sqlite';
import { ulid } from 'ulid';
import { collate, type CollateSummary } from './collate';
import { getSource } from '../sources/registry';
import { NotImplementedError, type SyncInput } from '../sources/types';
import { hydrateDiscogsTracks } from '../sources/discogs/hydrateDiscogsTracks';
import { resolvedRecordingsRoot } from '../recording/env';

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
};

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
    db.exec('ANALYZE');

    db.prepare(
      `UPDATE sync_run
          SET finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              summary     = ?
        WHERE id = ?`,
    ).run(JSON.stringify(summary), id);
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
