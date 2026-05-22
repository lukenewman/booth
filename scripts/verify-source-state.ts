import { Database } from 'bun:sqlite';
import { runMigrations } from '../src/lib/server/db/migrate';
import { collate } from '../src/lib/server/library/collate';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) fail(msg);
}

const db = new Database(':memory:');
runMigrations(db);

// Verify source_state table exists.
const tableRow = db
  .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='source_state'`)
  .get();
assert(tableRow, 'source_state table not created by migration');

// Run a small collate; verify a source_state row appears.
collate(db, 'discogs', {
  releases: [
    {
      externalId: '12721',
      title: 'Homework',
      artist: 'Daft Punk',
      year: 1997,
    },
  ],
  tracks: [],
});

const row = db
  .prepare(`SELECT source, last_synced_at, last_summary FROM source_state WHERE source = 'discogs'`)
  .get() as { source: string; last_synced_at: string; last_summary: string } | undefined;
assert(row, 'no source_state row written by collate');
assert(row.source === 'discogs', `wrong source: ${row.source}`);
assert(row.last_synced_at?.endsWith('Z'), `bad timestamp: ${row.last_synced_at}`);
const parsed = JSON.parse(row.last_summary);
assert(parsed.releasesUpserted === 1, `wrong summary.releasesUpserted: ${parsed.releasesUpserted}`);

// Run a SECOND collate for the same source; verify the row is updated, not inserted.
collate(db, 'discogs', {
  releases: [
    { externalId: '12722', title: 'Discovery', artist: 'Daft Punk', year: 2001 },
  ],
  tracks: [],
});
const all = db.prepare(`SELECT COUNT(*) as n FROM source_state`).all() as { n: number }[];
assert(all[0].n === 1, `expected 1 row in source_state, got ${all[0].n}`);

console.log('PASS: source_state migration + collate write');
