import { Database } from 'bun:sqlite';
import { runMigrations } from '../src/lib/server/db/migrate';
import { listReleases, listTracks, getReleaseDetail } from '../src/lib/server/library/queries';
import { parseGenreFilter, genreFilterToParams, type GenreFilter } from '../src/lib/genreFilter';

function eq(a: unknown, e: unknown, m: string) {
  if (JSON.stringify(a) !== JSON.stringify(e)) { console.error(`FAIL ${m}: got ${JSON.stringify(a)}, want ${JSON.stringify(e)}`); process.exit(1); }
}
const db = new Database(':memory:');
db.exec('PRAGMA foreign_keys = ON');
runMigrations(db);
db.prepare(`INSERT INTO artist (id, name) VALUES ('a', 'A')`).run();
const FOLK = 'Folk, World, & Country';
for (const id of ['E', 'F', 'J', 'U']) {
  db.prepare(`INSERT INTO release (id, title, artist_id) VALUES (?, ?, 'a')`).run(id, id);
  db.prepare(`INSERT INTO track (id, title, artist_id, release_id) VALUES (?, ?, 'a', ?)`).run(`t${id}`, `t${id}`, id);
}
db.prepare(`INSERT INTO track (id, title, artist_id) VALUES ('tLoose', 'tLoose', 'a')`).run();
const rg = db.prepare(`INSERT INTO release_genre (release_id, kind, name, position, origin) VALUES (?, ?, ?, ?, 'discogs')`);
rg.run('E', 'genre', 'Electronic', 0); rg.run('E', 'style', 'Deep House', 0); rg.run('E', 'style', 'Techno', 1);
rg.run('J', 'genre', 'Jazz', 0);
rg.run('F', 'genre', FOLK, 0);

const rel = (genre: GenreFilter) => listReleases(db, { limit: 50, offset: 0, sort: 'artist', genre }).items.map((r) => r.id).sort();
const trk = (genre: GenreFilter) => listTracks(db, { limit: 50, offset: 0, sort: 'artist', genre }).items.map((r) => r.id).sort();
const sel = (include: string[], exclude: string[] = []) => ({ include, exclude });

eq(rel({ genres: sel(['Electronic']) }), ['E'], 'include genre');
eq(rel({ genres: sel([], ['Electronic']) }), ['F', 'J'], 'exclude never matches untagged');
eq(rel({ styles: sel(['Deep House']) }), ['E'], 'include style');
eq(rel({ styles: sel([], ['Deep House']) }), ['F', 'J'], 'style exclude also needs a tagged release');
eq(rel({ untagged: true }), ['U'], 'untagged');
eq(rel({ genres: sel([FOLK]) }), ['F'], 'genre with commas');
eq(rel({ genres: sel(['Electronic', 'Jazz']) }), ['E', 'J'], 'includes are any-of');
eq(rel({}), ['E', 'F', 'J', 'U'], 'empty filter');
eq(trk({ genres: sel([], ['Electronic']) }), ['tF', 'tJ'], 'tracks inherit; loose track excluded');
eq(trk({ untagged: true }), ['tU'], 'untagged tracks need a release');

const page = listReleases(db, { limit: 50, offset: 0, sort: 'artist' }).items;
eq(page.find((r) => r.id === 'E')?.styles, ['Deep House', 'Techno'], 'release row styles in order');
eq(page.find((r) => r.id === 'U')?.styles, [], 'untagged row has no styles');
eq(listTracks(db, { limit: 50, offset: 0, sort: 'artist' }).items.find((t) => t.id === 'tE')?.styles, ['Deep House', 'Techno'], 'track row styles');
const d = getReleaseDetail(db, 'E')!;
eq([d.genres, d.styles, d.genreOrigin], [['Electronic'], ['Deep House', 'Techno'], 'discogs'], 'detail genres');
eq(getReleaseDetail(db, 'U')!.genreOrigin, null, 'detail untagged');

const f: GenreFilter = { genres: sel([FOLK], ['Jazz']), styles: sel(['Deep House'], ['Techno']), untagged: true };
const params = new URLSearchParams();
genreFilterToParams(f, params);
eq(parseGenreFilter(new URLSearchParams(params.toString())), f, 'url round trip with commas');
console.log('ok verify-genre-filters');
