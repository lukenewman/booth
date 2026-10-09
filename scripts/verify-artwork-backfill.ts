import { Database } from 'bun:sqlite';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../src/lib/server/db/migrate';
import { backfillArtwork, bandcampArtUrl } from '../src/lib/server/library/artworkBackfill';
import { parseCollectionItem } from '../src/lib/server/genres/bandcampParse';

function eq(a: unknown, e: unknown, m: string) {
  if (JSON.stringify(a) !== JSON.stringify(e)) { console.error(`FAIL ${m}: got ${JSON.stringify(a)}, want ${JSON.stringify(e)}`); process.exit(1); }
}
const db = new Database(':memory:');
db.exec('PRAGMA foreign_keys = ON');
runMigrations(db);
db.prepare(`INSERT INTO artist (id, name) VALUES ('a', 'A')`).run();
const release = (id: string, ext: string, thumb: string | null = null) => {
  db.prepare(`INSERT INTO release (id, title, artist_id, thumb_url) VALUES (?, ?, 'a', ?)`).run(id, id, thumb);
  db.prepare(`INSERT INTO source_link (entity_kind, entity_id, source, external_id, match_method) VALUES ('release', ?, 'local', ?, 'test')`).run(id, ext);
};
const track = (id: string, rel: string, path: string, kind: string) => {
  db.prepare(`INSERT INTO track (id, title, artist_id, release_id) VALUES (?, ?, 'a', ?)`).run(id, id, rel);
  db.prepare(`INSERT INTO match_key (entity_kind, entity_id, key_type, key_value) VALUES ('track', ?, 'file_path', ?)`).run(id, path);
  db.prepare(`INSERT INTO source_facets (entity_kind, entity_id, source, key, value) VALUES ('track', ?, 'local', 'kind', ?)`).run(id, JSON.stringify(kind));
};
release('rApple', 'itunes-album:aaaaaaaaaaaa'); track('t1', 'rApple', '/m/finally.m4a', 'Purchased AAC audio file');
release('rBc', 'itunes-album:bbbbbbbbbbbb'); track('t2', 'rBc', '/m/bale.mp3', 'MPEG audio file');
db.prepare(`INSERT INTO bandcamp_item (item_id, url, item_type, artist, title, release_id, match_state, art_id) VALUES ('a1', 'u', 'album', 'A', 't', 'rBc', 'matched', '658331929')`).run();
release('rNone', 'itunes-album:cccccccccccc'); track('t3', 'rNone', '/m/x.m4a', 'AAC audio file');
release('rHas', 'itunes-album:dddddddddddd', '/api/artwork/itunes-dddddddddddd.jpg'); track('t4', 'rHas', '/m/y.m4a', 'Purchased AAC audio file');
release('rDiscogsOnly', '12345');

const dir = mkdtempSync(join(tmpdir(), 'booth-art-'));
const fetched: string[] = [];
const deps = {
  artworkDir: dir,
  appleAlbumId: async (path: string) => (path === '/m/finally.m4a' ? '1443769599' : null),
  fetchJson: async (url: string) => {
    fetched.push(url);
    return { resultCount: 1, results: [{ artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/x/y.jpg/100x100bb.jpg' }] };
  },
  fetchBytes: async (url: string) => { fetched.push(url); return { bytes: new Uint8Array([0xff, 0xd8, 1, 2]), type: 'image/jpeg' }; },
  delayMs: 0,
};
eq(await backfillArtwork(db, deps), { apple: 1, bandcamp: 1, missing: 1 }, 'counts');
eq(fetched, [
  'https://itunes.apple.com/lookup?id=1443769599',
  'https://is1-ssl.mzstatic.com/image/thumb/x/y.jpg/1000x1000bb.jpg',
  'https://f4.bcbits.com/img/a0658331929_10.jpg',
], 'apple lookup, large apple art, large bandcamp art; nothing for releases that have art or no local link');
const thumb = (id: string) => (db.prepare(`SELECT thumb_url, cover_url FROM release WHERE id = ?`).get(id) as { thumb_url: string | null; cover_url: string | null });
eq(thumb('rApple'), { thumb_url: '/api/artwork/itunes-aaaaaaaaaaaa.jpg', cover_url: '/api/artwork/itunes-aaaaaaaaaaaa.jpg' }, 'apple cover set');
eq(existsSync(join(dir, 'itunes-aaaaaaaaaaaa.jpg')) && readFileSync(join(dir, 'itunes-aaaaaaaaaaaa.jpg')).length === 4, true, 'cached under the sync cache name');
eq(thumb('rBc').thumb_url, '/api/artwork/itunes-bbbbbbbbbbbb.jpg', 'bandcamp cover set');
eq(thumb('rNone').thumb_url, null, 'no source, no cover');
eq(thumb('rHas').thumb_url, '/api/artwork/itunes-dddddddddddd.jpg', 'existing cover untouched');

// A second run has nothing left to do but the one with no source.
fetched.length = 0;
eq(await backfillArtwork(db, deps), { apple: 0, bandcamp: 0, missing: 1 }, 'second run');
eq(fetched, [], 'no refetch');

// Apple lookup failing falls through to "missing", never throws.
db.prepare(`UPDATE release SET thumb_url = NULL, cover_url = NULL WHERE id = 'rApple'`).run();
eq(await backfillArtwork(db, { ...deps, artworkDir: mkdtempSync(join(tmpdir(), 'booth-art-')), fetchJson: async () => null }), { apple: 0, bandcamp: 0, missing: 2 }, 'lookup failure');

eq(bandcampArtUrl('42'), 'https://f4.bcbits.com/img/a0000000042_10.jpg', 'art id padded');
eq(parseCollectionItem({ tralbum_type: 'a', tralbum_id: 1, item_url: 'u', band_name: 'B', item_title: 'T', item_art_id: 658331929 }).artId, '658331929', 'collection art id');
console.log('ok verify-artwork-backfill');
