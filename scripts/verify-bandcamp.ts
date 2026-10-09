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

// Loose titles: only within the purchase's own Bandcamp host, only on an exact
// loose-key match (never containment), and only when exactly one release fits.
const { looseTitleKey } = await import('../src/lib/server/genres/bandcampMatch');
eq(looseTitleKey('Tidal Waves EP', 'Bob Bonádis'), looseTitleKey('Tidal Waves', 'Bob Bonádis'), 'EP suffix');
eq(looseTitleKey('[PHONICA030] Escape Artist - Energy Breakthrough EP', 'Escape Artist'), 'energybreakthrough', 'catalogue + artist in title');
eq(looseTitleKey('MPC Dreams - FTC03', 'Kyle Hall'), 'mpcdreams', 'trailing catalogue number');
eq(looseTitleKey('Lighten You Up *BC Exclusive*', 'Aleqs Notal'), 'lightenyouup', 'starred note');
eq(looseTitleKey('On A Nimbus Remixes', 'Priori') === looseTitleKey('On A Nimbus', 'Priori'), false, 'remixes stay distinct');
eq(looseTitleKey('TEK-88', 'Tenderlonious'), '', 'title that is only a catalogue number has no loose key');

const loose = buildMatcher(
  [rel('b1', 'Bob Bonádis', 'Tidal Waves EP', ['ace.bandcamp.com']), rel('b2', 'Escape Artist', '[PHONICA030] Escape Artist - Energy Breakthrough EP', ['phonica.bandcamp.com']),
   rel('b3', 'Priori', 'On A Nimbus Remixes', ['priori.bandcamp.com']), rel('b4', 'Same', 'Twin EP', ['twin.bandcamp.com']), rel('b5', 'Same', 'Twin LP', ['twin.bandcamp.com']),
   rel('b6', 'Max Graef', 'Natural Element', ['maxgraef.bandcamp.com'])],
  [{ releaseId: 'b6', artist: 'Max Graef', title: 'Zan' }],
);
eq(loose(buy({ artist: 'Bob Bonádis', albumTitle: 'Tidal Waves', url: 'https://ace.bandcamp.com/album/tidal-waves' })), { state: 'matched', releaseId: 'b1' }, 'loose: EP');
eq(loose(buy({ artist: 'Bob Bonádis', albumTitle: 'Tidal Waves', url: 'https://other.bandcamp.com/album/tidal-waves' })), { state: 'unmatched' }, 'loose: wrong host');
eq(loose(buy({ artist: 'Escape Artist', albumTitle: 'Energy Breakthrough EP', url: 'https://phonica.bandcamp.com/album/e' })), { state: 'matched', releaseId: 'b2' }, 'loose: catalogue prefix');
eq(loose(buy({ artist: 'Priori', albumTitle: 'On A Nimbus', url: 'https://priori.bandcamp.com/album/n' })), { state: 'unmatched' }, 'loose: remixes not matched');
eq(loose(buy({ artist: 'Same', albumTitle: 'Twin', url: 'https://twin.bandcamp.com/album/t' })), { state: 'ambiguous' }, 'loose: two fits');
eq(loose(buy({ itemType: 'track', artist: 'Various Artists', title: 'Zan', albumTitle: 'Something Else', url: 'https://maxgraef.bandcamp.com/track/zan' })), { state: 'matched', releaseId: 'b6' }, 'track title on a release under the same host, artist differs');
console.log('ok loose titles');

// Removing an artist's name from both titles can leave a generic word that
// matches across artists ("RNT030 // Al-Tone Edits" vs "RNT016 // Al Kent
// Edits" both become "edits"). When a key needed the artist stripped, the
// artists must agree.
const edits = buildMatcher(
  [rel('e1', 'Al Kent', 'RNT016 // Al Kent Edits', ['rnt.bandcamp.com']), rel('e2', 'ALEQS NOTAL', 'Lighten You Up *BC Exclusive*', ['rnt.bandcamp.com']),
   rel('e3', 'Lone', 'Lone - Abraxas EP', ['rnt.bandcamp.com'])],
  [],
);
eq(edits(buy({ artist: 'Al-Tone', albumTitle: 'RNT030 // Al-Tone Edits', url: 'https://rnt.bandcamp.com/album/a' })), { state: 'unmatched' }, 'different artists, stripped keys');
eq(edits(buy({ artist: 'Aleqs Notal', albumTitle: 'Lighten You Up', url: 'https://rnt.bandcamp.com/album/l' })), { state: 'matched', releaseId: 'e2' }, 'no artist stripped, case-different artist fine');
eq(edits(buy({ artist: 'Lone', albumTitle: 'Abraxas EP', url: 'https://rnt.bandcamp.com/album/x' })), { state: 'matched', releaseId: 'e3' }, 'stripped, same artist');
console.log('ok stripped-artist guard');
