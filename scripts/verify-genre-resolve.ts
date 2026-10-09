import { Database } from 'bun:sqlite';
import { runMigrations } from '../src/lib/server/db/migrate';
import { resolveGenres } from '../src/lib/server/genres/resolve';

function eq(a: unknown, e: unknown, m: string) {
  if (JSON.stringify(a) !== JSON.stringify(e)) { console.error(`FAIL ${m}: got ${JSON.stringify(a)}, want ${JSON.stringify(e)}`); process.exit(1); }
}
const db = new Database(':memory:');
db.exec('PRAGMA foreign_keys = ON');
runMigrations(db);
db.prepare(`INSERT INTO artist (id, name) VALUES ('a', 'A')`).run();
for (const id of ['rDisc', 'rBc', 'rFile', 'rNone', 'rManual']) {
  db.prepare(`INSERT INTO release (id, title, artist_id) VALUES (?, ?, 'a')`).run(id, id);
}
const facet = db.prepare(`INSERT INTO source_facets (entity_kind, entity_id, source, key, value) VALUES (?, ?, ?, ?, ?)`);
// Discogs: explicit genre + style; a Bandcamp item on the same release must lose.
facet.run('release', 'rDisc', 'discogs', 'genres', JSON.stringify(['Funk / Soul']));
facet.run('release', 'rDisc', 'discogs', 'styles', JSON.stringify(['Disco']));
db.prepare(`INSERT INTO bandcamp_item (item_id, url, item_type, artist, title, primary_genre, tags, release_id, match_state)
            VALUES ('a1', 'u', 'album', 'A', 't', 'electronic', '["deep house"]', 'rDisc', 'matched')`).run();
// Bandcamp only: tags map to styles; 'experimental' has no Discogs genre, so the genre is inferred.
db.prepare(`INSERT INTO bandcamp_item (item_id, url, item_type, artist, title, primary_genre, tags, release_id, match_state)
            VALUES ('a2', 'u', 'album', 'A', 't', 'experimental', '["Detroit","deep house","moodymann"]', 'rBc', 'matched')`).run();
// File tags only.
db.prepare(`INSERT INTO track (id, title, artist_id, release_id) VALUES ('t1', 'x', 'a', 'rFile')`).run();
facet.run('track', 't1', 'local', 'genre', JSON.stringify('Techno (Peak Time / Driving)'));
// Manual beats Discogs.
facet.run('release', 'rManual', 'discogs', 'genres', JSON.stringify(['Rock']));
db.prepare(`INSERT INTO release_tag_manual (release_id, genres, styles, set_at) VALUES ('rManual', '["Jazz"]', '["Spiritual Jazz"]', 'now')`).run();

const r = resolveGenres(db);
const rows = (id: string) => db.prepare(`SELECT kind, name, origin FROM release_genre WHERE release_id = ? ORDER BY kind, position`).all(id);
eq(rows('rDisc'), [{ kind: 'genre', name: 'Funk / Soul', origin: 'discogs' }, { kind: 'style', name: 'Disco', origin: 'discogs' }], 'discogs wins, no parent inference');
eq(rows('rBc'), [{ kind: 'genre', name: 'Electronic', origin: 'bandcamp' }, { kind: 'style', name: 'Deep House', origin: 'bandcamp' }], 'bandcamp: experimental unmapped, genre inferred');
eq(rows('rFile'), [{ kind: 'genre', name: 'Electronic', origin: 'file' }, { kind: 'style', name: 'Techno', origin: 'file' }], 'file tags');
eq(rows('rNone'), [], 'untagged');
eq(rows('rManual'), [{ kind: 'genre', name: 'Jazz', origin: 'manual' }, { kind: 'style', name: 'Spiritual Jazz', origin: 'manual' }], 'manual wins');
eq(r, { tagged: 4, untagged: 1 }, 'counts');
resolveGenres(db);
eq(rows('rManual').length, 2, 'second run stable');
resolveGenres(db, ['rFile']);
eq(rows('rDisc').length, 2, 'subset run leaves others alone');
// A Discogs release carrying a style this vocabulary has never seen teaches it;
// a Bandcamp tag naming it then maps, parented by the Discogs release's genre.
db.prepare(`INSERT INTO release (id, title, artist_id) VALUES ('rNewStyle', 'n', 'a'), ('rBc2', 'b', 'a')`).run();
facet.run('release', 'rNewStyle', 'discogs', 'genres', JSON.stringify(['Electronic']));
facet.run('release', 'rNewStyle', 'discogs', 'styles', JSON.stringify(['Lo-Fi House']));
db.prepare(`INSERT INTO bandcamp_item (item_id, url, item_type, artist, title, tags, release_id, match_state)
            VALUES ('a3', 'u', 'album', 'A', 't', '["lo-fi house"]', 'rBc2', 'matched')`).run();
resolveGenres(db);
eq(rows('rBc2'), [{ kind: 'genre', name: 'Electronic', origin: 'bandcamp' }, { kind: 'style', name: 'Lo-Fi House', origin: 'bandcamp' }], 'learned style');
// Bandcamp's own primary genre is the genre. Tags that name a genre ("hip hop"
// on an Ilian Tape record means hip-hop-influenced) only count when the
// primary genre is missing or maps to nothing.
db.prepare(`INSERT INTO release (id, title, artist_id) VALUES ('rIss', 'ISS010', 'a'), ('rExp', 'x', 'a'), ('rNone2', 'y', 'a')`).run();
const bc = db.prepare(`INSERT INTO bandcamp_item (item_id, url, item_type, artist, title, primary_genre, tags, release_id, match_state) VALUES (?, 'u', 'album', 'A', 't', ?, ?, ?, 'matched')`);
bc.run('b1', 'electronic', '["ambient","breakbeat","drum & bass","electronic","hip hop","techno","Munich"]', 'rIss');
bc.run('b2', 'experimental', '["jazz","spiritual jazz"]', 'rExp');
bc.run('b3', null, '["hip hop","boom bap"]', 'rNone2');
resolveGenres(db);
const genresOf = (id: string) => (db.prepare(`SELECT name FROM release_genre WHERE release_id = ? AND kind = 'genre' ORDER BY position`).all(id) as { name: string }[]).map((r) => r.name);
eq(genresOf('rIss'), ['Electronic'], 'primary genre wins over genre-named tags');
eq((db.prepare(`SELECT COUNT(*) AS n FROM release_genre WHERE release_id = 'rIss' AND kind = 'style'`).get() as { n: number }).n, 4, 'tags still give styles');
eq(genresOf('rExp'), ['Jazz'], 'unmapped primary falls back to tag genres');
eq(genresOf('rNone2'), ['Hip Hop'], 'missing primary falls back to tag genres');
console.log('ok verify-genre-resolve');
