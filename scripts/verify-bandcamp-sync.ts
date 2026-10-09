import { Database } from 'bun:sqlite';
import { runMigrations } from '../src/lib/server/db/migrate';
import { storePurchases, fetchPendingPages, bandcampStatus } from '../src/lib/server/genres/bandcampSync';
import type { BandcampPurchase } from '../src/lib/server/genres/bandcampParse';

function eq(a: unknown, e: unknown, m: string) {
  if (JSON.stringify(a) !== JSON.stringify(e)) { console.error(`FAIL ${m}: got ${JSON.stringify(a)}, want ${JSON.stringify(e)}`); process.exit(1); }
}
const db = new Database(':memory:');
db.exec('PRAGMA foreign_keys = ON');
runMigrations(db);
db.prepare(`INSERT INTO artist (id, name) VALUES ('a', 'Ottagone')`).run();
for (const [id, title] of [['r1', 'Ottagone.11'], ['r2', 'Ottagone.12']]) {
  db.prepare(`INSERT INTO release (id, title, artist_id) VALUES (?, ?, 'a')`).run(id, title);
  db.prepare(`INSERT INTO source_link (entity_kind, entity_id, source, external_id, match_method) VALUES ('release', ?, 'local', ?, 'test')`).run(id, `x-${id}`);
}
const buy = (itemId: string, albumTitle: string): BandcampPurchase => ({
  itemId, url: `https://ottagone.bandcamp.com/album/${itemId}`, itemType: 'album', artist: 'Ottagone',
  title: albumTitle, albumTitle, primaryGenre: 'electronic', purchasedAt: null,
});
const purchases = [buy('a1', 'Ottagone.11'), buy('a2', 'Not In Library'), buy('a3', 'Ottagone.12')];

eq(storePurchases(db, purchases), { purchases: 3, matched: 2, ambiguous: 0, unmatched: 1 }, 'first store');
db.prepare(`UPDATE bandcamp_item SET tags = '["kept"]', page_fetched_at = 'then' WHERE item_id = 'a1'`).run();
storePurchases(db, purchases);
eq(db.prepare(`SELECT tags, page_fetched_at FROM bandcamp_item WHERE item_id = 'a1'`).get(), { tags: '["kept"]', page_fetched_at: 'then' }, 'restore keeps fetched tags');

// Only a3 is still pending (matched, never fetched). Its page tags reach release_genre.
eq(bandcampStatus(db, 'me'), { username: 'me', purchases: 3, matched: 2, ambiguous: 0, unmatched: 1, pagesPending: 1 }, 'status before');
const urls: string[] = [];
const r = await fetchPendingPages(db, { delayMs: 0, fetcher: async (url) => { urls.push(url); return { status: 200, html: '<a class="tag" href="x">deep house</a>' }; } });
eq(r, { fetched: 1, failed: 0 }, 'one page fetched');
eq(urls, ['https://ottagone.bandcamp.com/album/a3'], 'only the pending item');
eq(db.prepare(`SELECT kind, name, origin FROM release_genre WHERE release_id = 'r2' ORDER BY kind`).all(),
  [{ kind: 'genre', name: 'Electronic', origin: 'bandcamp' }, { kind: 'style', name: 'Deep House', origin: 'bandcamp' }], 'resolved after fetch');

// A failed page is recorded and not retried.
db.prepare(`UPDATE bandcamp_item SET page_fetched_at = NULL, tags = NULL WHERE item_id = 'a1'`).run();
eq(await fetchPendingPages(db, { delayMs: 0, fetcher: async () => ({ status: 404, html: '' }) }), { fetched: 0, failed: 1 }, '404 recorded');
eq(await fetchPendingPages(db, { delayMs: 0, fetcher: async () => { throw new Error('should not fetch'); } }), { fetched: 0, failed: 0 }, 'not retried');
eq(db.prepare(`SELECT page_error FROM bandcamp_item WHERE item_id = 'a1'`).get(), { page_error: 'http 404' }, 'error stored');

// A 429 retries the same row after backing off, without counting it.
db.prepare(`UPDATE bandcamp_item SET page_error = NULL WHERE item_id = 'a1'`).run();
let n = 0;
eq(await fetchPendingPages(db, { delayMs: 0, backoffMs: 1, fetcher: async () => (n++ === 0 ? { status: 429, html: '' } : { status: 200, html: '' }) }), { fetched: 1, failed: 0 }, '429 then ok');
console.log('ok verify-bandcamp-sync');

// A server error or block is transient: stop the run, record nothing, leave the
// row pending for the next sync. Only 404/410 are permanent.
db.prepare(`UPDATE bandcamp_item SET page_fetched_at = NULL, page_error = NULL, tags = NULL WHERE item_id = 'a1'`).run();
let calls = 0;
eq(await fetchPendingPages(db, { delayMs: 0, fetcher: async () => { calls++; return { status: 503, html: '' }; } }), { fetched: 0, failed: 0 }, '503 counts as nothing');
eq(calls, 1, '503 stops the run');
eq(db.prepare(`SELECT page_error, page_fetched_at FROM bandcamp_item WHERE item_id = 'a1'`).get(), { page_error: null, page_fetched_at: null }, '503 leaves the row pending');
eq(await fetchPendingPages(db, { delayMs: 0, fetcher: async () => ({ status: 410, html: '' }) }), { fetched: 0, failed: 1 }, '410 is permanent');
console.log('ok transient errors');
