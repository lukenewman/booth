import { Database } from 'bun:sqlite';
import { ulid } from 'ulid';
import { runMigrations } from '../src/lib/server/db/migrate';
import { pruneDiscogsTracks } from '../src/lib/server/sources/discogs/hydrateDiscogsTracks';

function fail(msg: string): never { console.error(`FAIL: ${msg}`); process.exit(1); }
function assert(cond: unknown, msg: string): asserts cond { if (!cond) fail(msg); }

const db = new Database(process.argv[2] ?? ':memory:');
db.exec('PRAGMA foreign_keys = ON');

if (process.argv[2]) {
  // Dry run against a copy of a real library: report what would go.
  const before = (db.prepare(`SELECT count(*) n FROM track`).get() as { n: number }).n;
  const deleted = pruneDiscogsTracks(db);
  const after = (db.prepare(`SELECT count(*) n FROM track`).get() as { n: number }).n;
  console.log(`deleted ${deleted} tracks (${before} → ${after})`);
  process.exit(0);
}

runMigrations(db);
const a = ulid();
db.prepare(`INSERT INTO artist (id, name) VALUES (?, 'Officer John')`).run(a);
const rel = (dg: string) => {
  const id = ulid();
  db.prepare(`INSERT INTO release (id, title, artist_id) VALUES (?, 'R', ?)`).run(id, a);
  db.prepare(`INSERT INTO source_link (entity_kind, entity_id, source, external_id, match_method) VALUES ('release', ?, 'discogs', ?, 'x')`).run(id, dg);
  return id;
};
const trk = (releaseId: string | null, dg: string, n: number, local = false) => {
  const id = ulid();
  db.prepare(`INSERT INTO track (id, title, artist_id, release_id, position) VALUES (?, 'T', ?, ?, ?)`).run(id, a, releaseId, String(n));
  db.prepare(`INSERT INTO source_link (entity_kind, entity_id, source, external_id, match_method) VALUES ('track', ?, 'discogs', ?, 'x')`).run(id, `${dg}-t${n}`);
  db.prepare(`INSERT INTO source_facets (entity_kind, entity_id, source, key, value) VALUES ('track', ?, 'discogs', 'discogsPosition', '"A1"')`).run(id);
  if (local) db.prepare(`INSERT INTO source_link (entity_kind, entity_id, source, external_id, match_method) VALUES ('track', ?, 'local', ?, 'x')`).run(id, `/f/${id}`);
  return id;
};
const exists = (id: string) => !!db.prepare(`SELECT 1 FROM track WHERE id=?`).get(id);
const discogsLinked = (id: string) => !!db.prepare(`SELECT 1 FROM source_link WHERE entity_kind='track' AND entity_id=? AND source='discogs'`).get(id);

// 1. record still in the collection → untouched
const kept = rel('100');
const k1 = trk(kept, '100', 1);

// 2. record removed (release link gone, tracks stranded) → Discogs-only tracks deleted
const s1 = trk(null, '200', 1);
const s2 = trk(null, '200', 2);

// 3. local track merged onto a removed record → kept, loses only the Discogs link
const localRel = ulid();
db.prepare(`INSERT INTO release (id, title, artist_id) VALUES (?, 'R', ?)`).run(localRel, a);
const m1 = trk(localRel, '300', 1, true);

// 4. Discogs release id that is a prefix of another must not shield it ('10' vs '100')
const p1 = trk(null, '10', 1);

// 5. record removed then re-added: release link is back, old tracks still stranded
rel('400');
const r1 = trk(null, '400', 1);

assert(pruneDiscogsTracks(db) === 4, 'expected 4 deletions');
assert(!exists(r1), 'stranded tracks of a re-added record survived');
assert(exists(k1) && discogsLinked(k1), 'kept record lost its track');
assert(!exists(s1) && !exists(s2), 'stranded tracks survived');
assert(!exists(p1), 'prefix id shielded a stranded track');
assert(exists(m1) && !discogsLinked(m1), 'merged local track handled wrong');
assert(!db.prepare(`SELECT 1 FROM source_facets WHERE entity_id=? AND source='discogs'`).get(m1), 'merged track kept Discogs facets');
assert((db.prepare(`SELECT release_id FROM track WHERE id=?`).get(m1) as { release_id: string }).release_id === localRel, 'merged track lost its release');
assert(pruneDiscogsTracks(db) === 0, 'second run should be a no-op');

console.log('OK');
