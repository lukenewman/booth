/**
 * verify-stale-input.ts — staleness detection for file-backed syncs.
 *
 * Regression cover for the Apple-Music XML that sat frozen from 2026-05-05 to
 * 2026-08-13 while every sync_run reported an identical clean summary. A run
 * that re-reads an unchanged input must be flagged, not reported as success.
 *
 * Run: bun verify scripts/verify-stale-input.ts
 */
import { Database } from 'bun:sqlite';
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : `\n    expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
}

// --- minimal sync_run table + the two helpers under test -------------------

const db = new Database(':memory:');
db.exec(`CREATE TABLE sync_run (
  id TEXT PRIMARY KEY, source TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT, summary TEXT, error TEXT
)`);

interface SyncInput { path: string; mtime: string; generatedAt?: string }

/** Mirror of previousInput() in src/lib/server/library/sync_run.ts. */
function previousInput(sourceId: string, exceptId: string): SyncInput | null {
  const row = db
    .prepare(
      `SELECT json_extract(summary, '$.input') AS input
         FROM sync_run
        WHERE source = ? AND id <> ? AND summary IS NOT NULL
        ORDER BY started_at DESC LIMIT 1`,
    )
    .get(sourceId, exceptId) as { input: string | null } | undefined;
  if (!row?.input) return null;
  return JSON.parse(row.input) as SyncInput;
}

function recordRun(id: string, source: string, startedAt: string, input: SyncInput | null) {
  const previous = input ? previousInput(source, id) : null;
  const summary: Record<string, unknown> = { rowsIn: 5433, releasesUpserted: 1187 };
  if (input) {
    summary.input = input;
    if (previous && previous.mtime === input.mtime) summary.stale = true;
  }
  db.prepare(
    `INSERT INTO sync_run (id, source, started_at, finished_at, summary)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, source, startedAt, startedAt, JSON.stringify(summary));
  return summary;
}

// --- cases -----------------------------------------------------------------

const MAY = { path: '/Users/luke/Music/Library.xml', mtime: '2026-05-05T22:46:24.000Z' };

// First run of a source has nothing to compare against.
check('first run is never stale', recordRun('r1', 'local', '2026-05-06T00:00:00Z', MAY).stale, undefined);

// Second run over the same untouched file — the three-month bug.
check('unchanged mtime flags stale', recordRun('r2', 'local', '2026-06-15T00:00:00Z', MAY).stale, true);
check('still stale many runs later', recordRun('r3', 'local', '2026-08-13T00:00:00Z', MAY).stale, true);

// A genuinely refreshed export clears the flag.
const FRESH = { path: MAY.path, mtime: '2026-08-14T06:12:00.000Z' };
check('refreshed mtime clears stale', recordRun('r4', 'local', '2026-08-14T07:00:00Z', FRESH).stale, undefined);

// A re-parse of that same fresh file goes stale again.
check('re-reading the fresh file is stale', recordRun('r5', 'local', '2026-08-14T08:00:00Z', FRESH).stale, true);

// Sources without file input (Discogs) are never flagged.
check('adapter with no input is never stale', recordRun('d1', 'discogs', '2026-08-14T07:00:00Z', null).stale, undefined);
check('second no-input run still not stale', recordRun('d2', 'discogs', '2026-08-14T08:00:00Z', null).stale, undefined);

// Cross-source isolation: local's frozen file must not taint discogs.
check('previousInput scopes to its own source', previousInput('discogs', 'x'), null);

// --- real statSync round-trip ---------------------------------------------

const dir = mkdtempSync(join(tmpdir(), 'booth-stale-'));
const xml = join(dir, 'Library.xml');
writeFileSync(xml, '<plist></plist>');
const fixed = new Date('2026-05-05T22:46:24.000Z');
utimesSync(xml, fixed, fixed);
check('statSync mtime matches what we compare on', Bun.file(xml).size > 0 && (await import('node:fs')).statSync(xml).mtime.toISOString(), '2026-05-05T22:46:24.000Z');

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
