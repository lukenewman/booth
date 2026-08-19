// The queue's load-bearing invariant: listTrackIds must return exactly the ids
// listTracks returns, in the same order, for the same arguments. If these drift,
// "next" plays something other than the row below the one you clicked — which
// presents as randomly wrong track order and is miserable to trace.
import { Database } from 'bun:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listTracks, listTrackIds } from '../src/lib/server/library/queries';

const MIG = 'src/lib/server/db/migrations';

function freshDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const f of readdirSync(MIG).sort()) db.exec(readFileSync(join(MIG, f), 'utf8'));
  return db;
}

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg);
    failures++;
  } else console.log('ok:', msg);
}

const db = freshDb();
db.prepare(`INSERT INTO artist (id, name) VALUES ('ar1','Alpha')`).run();
db.prepare(`INSERT INTO artist (id, name) VALUES ('ar2','Beta')`).run();

/** `source` of 'local' makes a track playable; 'discogs' does not. */
function seed(id: string, title: string, artistId: string, source: string, added: string | null) {
  db.prepare(`INSERT INTO track (id, title, artist_id, album) VALUES (?,?,?,?)`)
    .run(id, title, artistId, 'Album');
  db.prepare(
    `INSERT INTO source_link (entity_kind, entity_id, source, external_id, match_method)
     VALUES ('track', ?, ?, ?, 'file_path')`,
  ).run(id, source, `${source}-${id}`);
  if (added) {
    db.prepare(
      `INSERT INTO source_facets (entity_kind, entity_id, source, key, value)
       VALUES ('track', ?, 'local', 'dateAdded', ?)`,
    ).run(id, JSON.stringify(added));
  }
}

seed('t1', 'Anchor', 'ar1', 'local', '2024-01-01T00:00:00.000Z');
seed('t2', 'Bridge', 'ar2', 'local', '2025-06-15T00:00:00.000Z');
seed('t3', 'Chorus', 'ar1', 'local', '2026-08-11T00:00:00.000Z');
seed('t4', 'Discogs Only', 'ar2', 'discogs', null); // never playable
seed('t5', 'Undated', 'ar1', 'local', null);

const PAGE = { limit: 500, offset: 0 };

// The invariant, across every parameter combination the UI can produce.
const cases: Array<[string, Record<string, unknown>]> = [
  ['default sort', {}],
  ['added-desc', { sort: 'added-desc' }],
  ['added-asc', { sort: 'added-asc' }],
  ['artist sort', { sort: 'artist' }],
  ['with q', { q: 'r' }],
  ['with source filter', { source: 'local' }],
];

for (const [label, args] of cases) {
  const rows = listTracks(db, { ...PAGE, ...args } as never);
  // listTracks includes unplayable tracks; the queue must not.
  const expected = rows.items.filter((r) => r.canPlay).map((r) => r.id);
  const actual = listTrackIds(db, args as never);
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label}: ids match listTracks order (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`,
  );
}

// Explicit check of the playable filter, so a regression names itself.
const all = listTrackIds(db, {} as never);
assert(!all.includes('t4'), 'the Discogs-only track never enters the queue');
assert(all.includes('t1') && all.includes('t5'), 'local tracks do, dated or not');

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
