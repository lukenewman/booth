import { Database } from 'bun:sqlite';
import { runMigrations } from '../src/lib/server/db/migrate';
import { assignStyleColors, reassignStyleColors, pinStyleColor, listGenreVocabulary } from '../src/lib/server/genres/colors';

function eq(a: unknown, e: unknown, m: string) {
  if (JSON.stringify(a) !== JSON.stringify(e)) { console.error(`FAIL ${m}: got ${JSON.stringify(a)}, want ${JSON.stringify(e)}`); process.exit(1); }
}
const db = new Database(':memory:');
db.exec('PRAGMA foreign_keys = ON');
runMigrations(db);
db.prepare(`INSERT INTO artist (id, name) VALUES ('a', 'A')`).run();
for (let i = 0; i < 60; i++) db.prepare(`INSERT INTO release (id, title, artist_id) VALUES (?, ?, 'a')`).run(`r${i}`, `r${i}`);
const tag = (style: string, count: number) => {
  for (let i = 0; i < count; i++) db.prepare(`INSERT INTO release_genre (release_id, kind, name, position, origin) VALUES (?, 'style', ?, 0, 'discogs')`).run(`r${i}`, style);
};
const top = ['Deep House', 'Techno', 'House', 'Disco', 'Electro', 'Ambient', 'Downtempo', 'Breaks', 'Dub', 'Jungle', 'Minimal', 'Acid'];
top.forEach((s, i) => tag(s, 30 - i));
tag('Rare One', 1);
tag('Rare Two', 1);

const table = () => db.prepare(`SELECT style, slot, pinned FROM style_color ORDER BY style`).all() as { style: string; slot: number; pinned: number }[];
const slotOf = (s: string) => table().find((r) => r.style === s)?.slot;

eq(assignStyleColors(db), 14, 'first run assigns everything');
eq(new Set(top.map(slotOf)).size, 12, 'top twelve all distinct');
eq(slotOf('Deep House') !== slotOf('Techno'), true, 'deep house vs techno');
eq(typeof slotOf('Rare One'), 'number', 'rare styles get a shared slot');

const before = JSON.stringify(table());
eq(assignStyleColors(db), 0, 'second run assigns nothing');
eq(JSON.stringify(table()), before, 'second run moves nothing');

tag('Footwork', 50);
eq(assignStyleColors(db), 1, 'new style assigned');
eq(JSON.stringify(table().filter((r) => r.style !== 'Footwork')), before, 'existing colours never move');

pinStyleColor(db, 'Techno', 3);
reassignStyleColors(db);
eq(table().find((r) => r.style === 'Techno'), { style: 'Techno', slot: 3, pinned: 1 }, 'pin survives reassign');
const others = table().filter((r) => r.style !== 'Techno');
const topSlots = ['Footwork', 'Deep House', 'House', 'Disco', 'Electro', 'Ambient', 'Downtempo', 'Breaks', 'Dub', 'Jungle', 'Minimal'].map((s) => others.find((r) => r.style === s)!.slot);
eq(topSlots.includes(3), false, 'top unpinned styles avoid the pinned slot');
eq(new Set(topSlots).size, 11, 'top unpinned still distinct');

let threw = false;
try { pinStyleColor(db, 'Techno', 12); } catch { threw = true; }
eq(threw, true, 'slot out of range refused');

const vocab = listGenreVocabulary(db);
eq(vocab.genres.length, 15, 'fifteen genres');
eq(vocab.styles[0].name, 'Footwork', 'most-used first');
eq(vocab.styles.find((s) => s.name === 'Techno')?.pinned, true, 'pinned flag');
eq(vocab.styles.some((s) => s.name === 'Spiritual Jazz' && s.slot === null && s.releases === 0), true, 'unused vocabulary styles listed for typeahead');
console.log('ok verify-style-colors');

// Colour pins are journaled like stars; replay folds them by style name.
const { replayEvents } = await import('../src/lib/server/backup/journal');
const ev = (at: string, id: string, value: string | null) => ({ at, kind: 'style' as const, id, action: 'color' as const, value, artist: '', title: id, album: null });
const replayed = replayEvents([ev('1', 'Techno', '3'), ev('2', 'Techno', '5'), ev('3', 'Disco', '1'), ev('4', 'Disco', null)]);
eq([...replayed.colors], [['Techno', 5]], 'colour replay: latest wins, null clears');
eq([...replayEvents([ev('1', 'Techno', '3'), ev('2', 'Techno', '5')], '1').colors], [['Techno', 3]], 'colour replay as-of');
console.log('ok colour journal');
