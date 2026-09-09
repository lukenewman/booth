import { Database } from 'bun:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { collate, upsertArtist } from '../src/lib/server/library/collate';
import { listReleases, listTracks, getReleaseDetail } from '../src/lib/server/library/queries';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) fail(msg);
}

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(here, '../src/lib/server/db/migrations');

/**
 * Apply every migration that sorts after `file`.
 *
 * The 003 assertions below deliberately run against a 002-shaped database —
 * that is the situation the migration has to survive. But the query functions
 * this script also exercises are current code against the current schema, and
 * they drifted past 003 (cover art in 005, annotations in 009/010/012). Bringing
 * the database up to date at that seam keeps both halves honest, and reading the
 * directory rather than a hardcoded list means the next migration needs no edit
 * here.
 */
function applyMigrationsAfter(db: Database, file: string): void {
  for (const f of readdirSync(MIGRATIONS).sort()) {
    if (f.endsWith('.sql') && f > file) applyMigration(db, f);
  }
}

function applyMigration(db: Database, file: string): void {
  const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
  // Match production migrate.ts: wrap in a tx so PRAGMA defer_foreign_keys
  // actually defers (the pragma is a no-op in autocommit mode).
  const tx = db.transaction(() => db.exec(sql));
  tx();
}

// ---- Backfill semantics ---------------------------------------------------
// Set up a DB at the 002 schema, seed it with denormalized data that includes
// case variants + a release with no artist string, then run 003 and verify
// that backfill produced the right artist rows and FKs.

const db = new Database(':memory:');
db.exec('PRAGMA foreign_keys = ON');
applyMigration(db, '001_init.sql');
applyMigration(db, '002_source_state.sql');

// Seed with old-shape rows (artist is a TEXT column on release/track).
db.prepare(
  `INSERT INTO release (id, title, artist, year) VALUES (?, ?, ?, ?)`,
).run('rel-1', 'Homework', 'Daft Punk', 1997);
db.prepare(
  `INSERT INTO release (id, title, artist, year) VALUES (?, ?, ?, ?)`,
).run('rel-2', 'Discovery', 'DAFT PUNK', 2001); // case variant — should collapse
db.prepare(
  `INSERT INTO release (id, title, artist, year) VALUES (?, ?, ?, ?)`,
).run('rel-3', 'Unknown Album', '', null); // empty string → "(unknown)"

db.prepare(
  `INSERT INTO track (id, title, artist, album, release_id) VALUES (?, ?, ?, ?, ?)`,
).run('trk-1', 'Around the World', 'Daft Punk', 'Homework', 'rel-1');
db.prepare(
  `INSERT INTO track (id, title, artist, album, release_id) VALUES (?, ?, ?, ?, ?)`,
).run('trk-2', 'Solo Track', 'Aphex Twin', null, null);

// Apply 003.
applyMigration(db, '003_artist_entity.sql');

const artists = db
  .prepare(`SELECT id, name FROM artist ORDER BY name COLLATE NOCASE`)
  .all() as { id: string; name: string }[];

// Expect: Daft Punk (one row for both casings) + Aphex Twin + (unknown).
const names = artists.map((a) => a.name.toLowerCase());
assert(names.includes('(unknown)'), 'sentinel "(unknown)" artist missing');
assert(names.includes('aphex twin'), 'aphex twin missing');
assert(
  artists.filter((a) => a.name.toLowerCase() === 'daft punk').length === 1,
  'case variants of Daft Punk did not collapse',
);

// FKs populated.
const rel1 = db.prepare(`SELECT artist_id FROM release WHERE id='rel-1'`).get() as { artist_id: string };
const rel2 = db.prepare(`SELECT artist_id FROM release WHERE id='rel-2'`).get() as { artist_id: string };
const rel3 = db.prepare(`SELECT artist_id FROM release WHERE id='rel-3'`).get() as { artist_id: string };
assert(rel1.artist_id === rel2.artist_id, 'case variants must share an artist_id');
const daftId = rel1.artist_id;
const unknownId = (
  db.prepare(`SELECT id FROM artist WHERE name='(unknown)'`).get() as { id: string }
).id;
assert(rel3.artist_id === unknownId, 'empty-artist release must FK to (unknown) sentinel');

// release.artist column should be gone.
const releaseCols = db.prepare(`PRAGMA table_info(release)`).all() as { name: string }[];
assert(
  !releaseCols.some((c) => c.name === 'artist'),
  'release.artist column should have been dropped',
);
assert(releaseCols.some((c) => c.name === 'artist_id'), 'release.artist_id column missing');

// Same for track.
const trackCols = db.prepare(`PRAGMA table_info(track)`).all() as { name: string }[];
assert(
  !trackCols.some((c) => c.name === 'artist'),
  'track.artist column should have been dropped',
);
assert(trackCols.some((c) => c.name === 'artist_id'), 'track.artist_id column missing');

// CHECK constraints widened: a source_link with entity_kind='artist' must be writable.
db.prepare(
  `INSERT INTO source_link (entity_kind, entity_id, source, external_id, match_method)
     VALUES ('artist', ?, 'discogs', 'd:71', 'first_seen')`,
).run(daftId);
db.prepare(
  `INSERT INTO source_facets (entity_kind, entity_id, source, key, value)
     VALUES ('artist', ?, 'discogs', 'profile', ?)`,
).run(daftId, JSON.stringify({ url: 'https://discogs.com/artist/71' }));
db.prepare(
  `INSERT INTO match_key (entity_kind, entity_id, key_type, key_value)
     VALUES ('artist', ?, 'name_normalized', 'daftpunk')`,
).run(daftId);

// Everything past 003, so the current query functions meet the schema they
// were written against.
applyMigrationsAfter(db, '003_artist_entity.sql');

// Queries return artist via JOIN — wire shape unchanged.
const pageDetail = getReleaseDetail(db, 'rel-1');
assert(
  pageDetail?.release.artist?.toLowerCase() === 'daft punk',
  `release detail must return artist name, got ${pageDetail?.release.artist}`,
);
const list = listReleases(db, { limit: 10, offset: 0 });
assert(list.total === 3, `expected 3 releases, got ${list.total}`);
const search = listReleases(db, { q: 'daft', limit: 10, offset: 0 });
assert(search.total === 2, `q=daft should hit both releases, got ${search.total}`);

// ---- upsertArtist on a freshly-migrated DB --------------------------------
// Migrated artist row has no match_key (migration doesn't backfill them due to
// diacritic-normalization mismatch with squashAlphanumLower). upsertArtist
// should still resolve it via the LOWER(name) fallback and write a match_key.
const resolved = upsertArtist(db, 'daft punk'); // lower-cased input
assert(resolved === daftId, 'upsertArtist must reuse migrated artist row');
const mk = db
  .prepare(
    `SELECT key_value FROM match_key
       WHERE entity_kind='artist' AND entity_id=? AND key_type='name_normalized'`,
  )
  .get(daftId) as { key_value: string };
assert(mk.key_value === 'daftpunk', `match_key key_value: got ${mk.key_value}`);

// Second call should be a no-op (cache hit / match_key hit).
const resolved2 = upsertArtist(db, 'Daft  Punk!');
assert(resolved2 === daftId, 'upsertArtist must dedupe via squashed key');

// ---- collate on a fresh DB also writes artist_id properly ------------------
const db2 = new Database(':memory:');
db2.exec('PRAGMA foreign_keys = ON');
applyMigration(db2, '001_init.sql');
applyMigration(db2, '002_source_state.sql');
applyMigration(db2, '003_artist_entity.sql');
applyMigrationsAfter(db2, '003_artist_entity.sql');
collate(db2, 'itunes', {
  releases: [
    { externalId: 'a', title: 'Album', artist: 'Björk', year: 2007 },
    { externalId: 'b', title: 'Other', artist: 'björk', year: 2011 }, // diacritic-aware lowercase
  ],
  tracks: [
    { externalId: 't1', title: 'Song', artist: 'Aphex Twin', releaseExternalId: 'a' },
  ],
});
const bjorkCount = db2
  .prepare(`SELECT COUNT(*) AS n FROM artist WHERE LOWER(name) LIKE '%j%rk'`)
  .get() as { n: number };
assert(bjorkCount.n === 1, `Björk variants must dedupe via squashAlphanumLower, got ${bjorkCount.n}`);
const t = listTracks(db2, { limit: 10, offset: 0 });
assert(t.items[0].artist === 'Aphex Twin', 'collate-produced track must surface artist name');

console.log('OK: artist migration + upsertArtist');
