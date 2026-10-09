import { readFileSync } from 'node:fs';
import { parseItemPage, parseCollectionItem, type BandcampPurchase } from '../src/lib/server/genres/bandcampParse';
import { buildMatcher, type MatchRelease } from '../src/lib/server/genres/bandcampMatch';

function eq(a: unknown, e: unknown, m: string) {
  if (JSON.stringify(a) !== JSON.stringify(e)) { console.error(`FAIL ${m}: got ${JSON.stringify(a)}, want ${JSON.stringify(e)}`); process.exit(1); }
}
const page = parseItemPage(readFileSync(new URL('./fixtures/bandcamp/album.html', import.meta.url), 'utf8'));
eq(page.primaryGenre, 'experimental', 'page genre');
const lower = page.tags.map((t) => t.toLowerCase());
eq(lower.includes('detroit') && lower.includes('experimental'), true, 'page tags');
eq(parseItemPage('<html></html>'), { primaryGenre: null, tags: [] }, 'empty page');
eq(parseItemPage('<a class="tag" href="x">drum &amp; bass</a>').tags, ['drum & bass'], 'entities decoded');

const p = parseCollectionItem({
  tralbum_type: 'a', tralbum_id: 1, item_url: 'https://lbl.bandcamp.com/album/x', band_name: 'Various Artists',
  item_title: 'Comp Vol. 1', album_title: 'Comp Vol. 1', genre_id: 10, purchased: '17 Sep 2026 15:12:45 GMT',
});
eq([p.itemId, p.itemType, p.primaryGenre, p.purchasedAt], ['a1', 'album', 'electronic', '2026-09-17T15:12:45.000Z'], 'collection item');
eq(parseCollectionItem({ tralbum_type: 't', tralbum_id: 2, item_url: 'u', band_name: 'B', item_title: 'Song', genre_id: null }).albumTitle, null, 'track without album');

const rel = (id: string, artist: string, title: string, hosts: string[] = []): MatchRelease => ({ id, artist, title, hosts: new Set(hosts) });
const match = buildMatcher(
  [rel('r1', 'Ottagone', 'Ottagone.11'), rel('r2', 'Label Comp', 'Comp Vol. 1', ['lbl.bandcamp.com']), rel('r3', 'Other', 'Comp Vol. 1'),
   rel('r4', 'Twin', 'Same'), rel('r5', 'Twin', 'Same'), rel('r6', 'X', 'Jubiiilæum')],
  [{ releaseId: 'r1', artist: 'Ottagone', title: 'Single' }],
);
const buy = (o: Partial<BandcampPurchase>): BandcampPurchase => ({ ...p, ...o });
eq(match(buy({ artist: 'Ottagone', albumTitle: 'Ottagone.11', url: 'https://ottagone.bandcamp.com/album/o' })), { state: 'matched', releaseId: 'r1' }, 'artist+album');
eq(match(buy({ artist: 'X', albumTitle: 'Jubiiilæum (Reissue)' })), { state: 'matched', releaseId: 'r6' }, 'edition tag stripped');
eq(match(buy({})), { state: 'matched', releaseId: 'r2' }, 'VA: title-only with host agreement');
eq(match(buy({ url: 'https://elsewhere.bandcamp.com/album/x' })), { state: 'unmatched' }, 'VA: title-only without host → unmatched');
eq(match(buy({ artist: 'Twin', albumTitle: 'Same' })), { state: 'ambiguous' }, 'two equal candidates');
eq(match(buy({ itemType: 'track', artist: 'Ottagone', title: 'Single', albumTitle: null })), { state: 'matched', releaseId: 'r1' }, 'track purchase');
console.log('ok verify-bandcamp');

// Pagination: Bandcamp can hand back an overlapping page with more_available
// still true. Purchases are deduplicated by item id, and a page that adds
// nothing new ends the walk.
const { collectPages } = await import('../src/lib/server/genres/bandcamp');
const item = (id: number) => ({ tralbum_type: 'a', tralbum_id: id, item_url: `u${id}`, band_name: 'B', item_title: `T${id}` });
let calls = 0;
const pages = [
  { items: [item(1), item(2)], more_available: true, last_token: 't1' },
  { items: [item(2), item(3)], more_available: true, last_token: 't2' },
  { items: [item(3), item(2)], more_available: true, last_token: 't3' },
];
const got = await collectPages(async () => pages[Math.min(calls++, pages.length - 1)]);
eq(got.map((g) => g.itemId), ['a1', 'a2', 'a3'], 'deduplicated purchases');
eq(calls, 3, 'stops on a page with nothing new');
console.log('ok pagination');
