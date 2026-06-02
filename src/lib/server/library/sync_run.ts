import type { Database } from 'bun:sqlite';
import { ulid } from 'ulid';
import { collate, type CollateSummary } from './collate';
import { getSource } from '../sources/registry';
import { NotImplementedError } from '../sources/types';
import { hydrateDiscogsTracks } from '../sources/discogs/hydrateDiscogsTracks';

export interface SyncRunRow {
  id: string;
  source: string;
  started_at: string;
  finished_at: string | null;
  summary: CollateSummary | null;
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
    const summary = collate(db, sourceId, result);

    // After collating Discogs releases, fetch tracklists for any that don't
    // have track rows yet.  Results are folded into the summary so the
    // sync_run row reflects the full work done this run.
    if (sourceId === 'discogs') {
      const hydration = await hydrateDiscogsTracks(db);
      summary.tracksUpserted += hydration.tracksAdded;
      summary.rowsIn += hydration.tracksAdded;
    }

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
    summary: row.summary ? (JSON.parse(row.summary) as CollateSummary) : null,
    error: row.error,
  };
}
