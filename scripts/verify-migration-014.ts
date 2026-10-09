import { Database } from 'bun:sqlite';
import { runMigrations } from '../src/lib/server/db/migrate';
import { bandcampHostFrom } from '../src/lib/server/genres/bandcampHost';

function assert(c: unknown, m: string): asserts c { if (!c) { console.error(`FAIL: ${m}`); process.exit(1); } }
const db = new Database(':memory:');
db.exec('PRAGMA foreign_keys = ON');
runMigrations(db);
for (const t of ['bandcamp_item', 'release_tag_manual', 'release_genre', 'style_color']) {
  assert(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(t), `table ${t}`);
}
assert((db.prepare(`PRAGMA table_info(playlist)`).all() as { name: string }[]).some((c) => c.name === 'rule'), 'playlist.rule');
assert(bandcampHostFrom('Visit https://3ChairsDetroit.bandcamp.com ') === '3chairsdetroit.bandcamp.com', 'host');
assert(bandcampHostFrom('Visit http://aslsinglesclub.bandcamp.com') === 'aslsinglesclub.bandcamp.com', 'http host');
assert(bandcampHostFrom('nice record') === undefined, 'no host');
assert(bandcampHostFrom(undefined) === undefined, 'undefined');
console.log('ok verify-migration-014');

// The local import must carry the comment so the host facet can be derived.
const { parseITunesLibrary } = await import('../src/lib/server/sources/local/parse');
const lib = parseITunesLibrary(new URL('./fixtures/itunes-tiny.xml', import.meta.url).pathname);
const aroundTheWorld = lib.tracks.find((t) => t.name === 'Around the World');
assert(aroundTheWorld?.comment === 'Visit https://daftpunk.bandcamp.com', `parsed comment: ${aroundTheWorld?.comment}`);
console.log('ok parse comment');
