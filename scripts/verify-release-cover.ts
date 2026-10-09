import { Database } from 'bun:sqlite';
import { runMigrations } from '../src/lib/server/db/migrate';
import { collate } from '../src/lib/server/library/collate';
import { setReleaseCover } from '../src/lib/server/library/releaseCover';
import { backfillArtwork } from '../src/lib/server/library/artworkBackfill';

function eq(a: unknown, e: unknown, m: string) {
  if (JSON.stringify(a) !== JSON.stringify(e)) { console.error(`FAIL ${m}: got ${JSON.stringify(a)}, want ${JSON.stringify(e)}`); process.exit(1); }
}
const db = new Database(':memory:');
db.exec('PRAGMA foreign_keys = ON');
runMigrations(db);
const sync = (thumbUrl?: string) => collate(db, 'local', {
  releases: [{ externalId: 'itunes-album:abc', title: 'Sampler', artist: 'Various Artists', year: 2017, thumbUrl, coverUrl: thumbUrl }],
  tracks: [],
});
sync();
const id = (db.prepare(`SELECT id FROM release`).get() as { id: string }).id;
const cover = () => db.prepare(`SELECT thumb_url, cover_url, cover_override FROM release WHERE id = ?`).get(id);

setReleaseCover(db, id, '/api/artwork/release-x.jpg?v=1');
eq(cover(), { thumb_url: '/api/artwork/release-x.jpg?v=1', cover_url: '/api/artwork/release-x.jpg?v=1', cover_override: '/api/artwork/release-x.jpg?v=1' }, 'hand-set cover shown');
sync('/api/artwork/itunes-abc.jpg');
eq((cover() as { thumb_url: string }).thumb_url, '/api/artwork/release-x.jpg?v=1', 'a sync with embedded art does not replace it');

setReleaseCover(db, id, null);
eq(cover(), { thumb_url: null, cover_url: null, cover_override: null }, 'clearing empties it for the sources to refill');
sync('/api/artwork/itunes-abc.jpg');
eq((cover() as { thumb_url: string }).thumb_url, '/api/artwork/itunes-abc.jpg', 'next sync refills from the file');

// The purchase backfill never touches a hand-set cover either.
setReleaseCover(db, id, '/api/artwork/release-x.jpg?v=2');
db.prepare(`UPDATE release SET thumb_url = NULL WHERE id = ?`).run(id); // even if the display column were emptied
const r = await backfillArtwork(db, { artworkDir: '/tmp', appleAlbumId: async () => null, fetchJson: async () => null, fetchBytes: async () => null });
eq(r, { apple: 0, bandcamp: 0, missing: 0 }, 'override excluded from backfill');
console.log('ok verify-release-cover');
