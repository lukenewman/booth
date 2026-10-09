import { Database } from 'bun:sqlite';
import { runMigrations } from '../src/lib/server/db/migrate';
import { setManualTags, TagValidationError } from '../src/lib/server/genres/manual';
import { resolveGenres } from '../src/lib/server/genres/resolve';

function eq(a: unknown, e: unknown, m: string) {
  if (JSON.stringify(a) !== JSON.stringify(e)) { console.error(`FAIL ${m}: got ${JSON.stringify(a)}, want ${JSON.stringify(e)}`); process.exit(1); }
}
const db = new Database(':memory:');
db.exec('PRAGMA foreign_keys = ON');
runMigrations(db);
db.prepare(`INSERT INTO artist (id, name) VALUES ('a', 'A')`).run();
db.prepare(`INSERT INTO release (id, title, artist_id) VALUES ('r', 'R', 'a')`).run();
db.prepare(`INSERT INTO source_facets (entity_kind, entity_id, source, key, value) VALUES ('release', 'r', 'discogs', 'genres', '["Rock"]')`).run();
resolveGenres(db);

eq(setManualTags(db, 'r', { genres: ['Jazz'], styles: [' Spiritual Jazz ', 'Spiritual Jazz', 'Detroit Deep'] }),
  { genres: ['Jazz'], styles: ['Spiritual Jazz', 'Detroit Deep'], genreOrigin: 'manual' }, 'override; trimmed, deduped, custom style kept');
resolveGenres(db);
eq(db.prepare(`SELECT name FROM release_genre WHERE release_id = 'r' AND kind = 'genre'`).all(), [{ name: 'Jazz' }], 'sync cannot clobber');
eq(db.prepare(`SELECT COUNT(*) AS n FROM style_color WHERE style = 'Detroit Deep'`).get(), { n: 1 }, 'new style coloured');

eq(setManualTags(db, 'r', null), { genres: ['Rock'], styles: [], genreOrigin: 'discogs' }, 'clearing falls back to sources');

let err: unknown = null;
try { setManualTags(db, 'r', { genres: ['Techno'], styles: [] }); } catch (e) { err = e; }
eq(err instanceof TagValidationError, true, 'a style is not a genre');
err = null;
try { setManualTags(db, 'r', { genres: [], styles: [''] }); } catch (e) { err = e; }
eq(err instanceof TagValidationError, true, 'empty style refused');
eq(db.prepare(`SELECT COUNT(*) AS n FROM release_tag_manual`).get(), { n: 0 }, 'invalid input writes nothing');

const { replayEvents } = await import('../src/lib/server/backup/journal');
const ev = (at: string, value: string | null) => ({ at, kind: 'release' as const, id: 'r', action: 'tags' as const, value, artist: 'A', title: 'R', album: null });
eq([...replayEvents([ev('1', '{"genres":["Jazz"],"styles":[]}'), ev('2', null)]).tags], [['r', null]], 'cleared override replays as cleared');
console.log('ok verify-manual-tags');
