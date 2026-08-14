// Verifies date-added sorting for the release and track listviews.
//
// The library has ~9 tracks per distinct dateAdded (one bucket holds 66), so
// ties are the norm, not the exception. A sort without a unique tiebreaker
// would let LIMIT/OFFSET pagination repeat or drop rows across page
// boundaries — which surfaces as "scrolling duplicates records". These checks
// pin the ordering AND the paging behaviour over a tie bucket.
import { Database } from 'bun:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listReleases, listTracks } from '../src/lib/server/library/queries';

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
db.prepare(`INSERT INTO artist (id, name) VALUES ('ar1','Artist One')`).run();

/** Adds a release with one track, optionally stamped with a local dateAdded. */
function seed(relId: string, trackId: string, title: string, added: string | null) {
  db.prepare(`INSERT INTO release (id, title, artist_id) VALUES (?,?, 'ar1')`).run(relId, title);
  db.prepare(
    `INSERT INTO track (id, title, artist_id, release_id) VALUES (?,?, 'ar1', ?)`,
  ).run(trackId, title, relId);
  for (const [kind, id] of [
    ['release', relId],
    ['track', trackId],
  ] as const) {
    db.prepare(
      `INSERT INTO source_link (entity_kind, entity_id, source, external_id, match_method)
       VALUES (?,?, 'local', ?, 'file_path')`,
    ).run(kind, id, `${kind}-${id}`);
  }
  if (added) {
    db.prepare(
      `INSERT INTO source_facets (entity_kind, entity_id, source, key, value)
       VALUES ('track', ?, 'local', 'dateAdded', ?)`,
    ).run(trackId, JSON.stringify(added));
  }
}

seed('r_old', 't_old', 'Oldest', '2024-01-01T00:00:00.000Z');
seed('r_mid', 't_mid', 'Middle', '2025-06-15T12:00:00.000Z');
seed('r_new', 't_new', 'Newest', '2026-08-11T15:01:07.000Z');
seed('r_none', 't_none', 'Undated', null); // Discogs-only shape: no local date

const page = { limit: 50, offset: 0 };
const titles = (rows: { title: string }[]) => rows.map((r) => r.title);

// --- releases -------------------------------------------------------------
{
  const desc = listReleases(db, { ...page, sort: 'added-desc' });
  assert(
    JSON.stringify(titles(desc.items)) === JSON.stringify(['Newest', 'Middle', 'Oldest', 'Undated']),
    `releases newest-first, undated last (got ${JSON.stringify(titles(desc.items))})`,
  );

  const asc = listReleases(db, { ...page, sort: 'added-asc' });
  assert(
    JSON.stringify(titles(asc.items)) === JSON.stringify(['Oldest', 'Middle', 'Newest', 'Undated']),
    `releases oldest-first, undated STILL last (got ${JSON.stringify(titles(asc.items))})`,
  );

  const def = listReleases(db, { ...page });
  assert(def.items.length === 4, 'default sort unchanged and still returns everything');
}

// --- tracks ---------------------------------------------------------------
{
  const desc = listTracks(db, { ...page, sort: 'added-desc' });
  assert(
    JSON.stringify(titles(desc.items)) === JSON.stringify(['Newest', 'Middle', 'Oldest', 'Undated']),
    `tracks newest-first, undated last (got ${JSON.stringify(titles(desc.items))})`,
  );
}

// --- release date is the EARLIEST of its tracks ---------------------------
{
  // A release topped up later must still sort by when it first arrived.
  db.prepare(
    `INSERT INTO track (id, title, artist_id, release_id) VALUES ('t_late','Bonus','ar1','r_old')`,
  ).run();
  db.prepare(
    `INSERT INTO source_link (entity_kind, entity_id, source, external_id, match_method)
     VALUES ('track','t_late','local','track-t_late','file_path')`,
  ).run();
  db.prepare(
    `INSERT INTO source_facets (entity_kind, entity_id, source, key, value)
     VALUES ('track','t_late','local','dateAdded', ?)`,
  ).run(JSON.stringify('2026-12-31T00:00:00.000Z'));

  const asc = listReleases(db, { ...page, sort: 'added-asc' });
  assert(
    titles(asc.items)[0] === 'Oldest',
    `release keeps its earliest track's date after a top-up (got ${titles(asc.items)[0]})`,
  );
}

// --- pagination across a tie bucket ---------------------------------------
{
  const tie = freshDb();
  tie.prepare(`INSERT INTO artist (id, name) VALUES ('ar1','A')`).run();
  const SAME = '2025-08-25T13:43:26.000Z'; // the real 66-row bucket's timestamp
  for (let i = 0; i < 20; i++) {
    const id = `t${String(i).padStart(2, '0')}`;
    tie.prepare(`INSERT INTO track (id, title, artist_id) VALUES (?,?, 'ar1')`).run(id, `Track ${i}`);
    tie
      .prepare(
        `INSERT INTO source_link (entity_kind, entity_id, source, external_id, match_method)
         VALUES ('track', ?, 'local', ?, 'file_path')`,
      )
      .run(id, id);
    tie
      .prepare(
        `INSERT INTO source_facets (entity_kind, entity_id, source, key, value)
         VALUES ('track', ?, 'local', 'dateAdded', ?)`,
      )
      .run(id, JSON.stringify(SAME));
  }

  const p1 = listTracks(tie, { limit: 10, offset: 0, sort: 'added-desc' });
  const p2 = listTracks(tie, { limit: 10, offset: 10, sort: 'added-desc' });
  const seen = [...p1.items.map((r) => r.id), ...p2.items.map((r) => r.id)];
  assert(new Set(seen).size === 20, `paging a 20-row tie bucket yields 20 distinct rows (got ${new Set(seen).size})`);

  // Repeating the same page must be stable across calls.
  const p1again = listTracks(tie, { limit: 10, offset: 0, sort: 'added-desc' });
  assert(
    JSON.stringify(p1.items.map((r) => r.id)) === JSON.stringify(p1again.items.map((r) => r.id)),
    'the same page returns the same rows in the same order',
  );
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
