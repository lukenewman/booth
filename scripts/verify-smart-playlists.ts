import { Database } from 'bun:sqlite';
import { runMigrations } from '../src/lib/server/db/migrate';
import {
  createPlaylist, getPlaylist, listPlaylists, addTrack, addRelease, createSection, setTargetMinutes,
  reorderTracks, removeTrack, setPlaylistRule, copySmartPlaylist, SmartPlaylistError,
} from '../src/lib/server/library/playlists';
import { validateRule, ruleSummary } from '../src/lib/smartRule';

function eq(a: unknown, e: unknown, m: string) {
  if (JSON.stringify(a) !== JSON.stringify(e)) { console.error(`FAIL ${m}: got ${JSON.stringify(a)}, want ${JSON.stringify(e)}`); process.exit(1); }
}
const db = new Database(':memory:');
db.exec('PRAGMA foreign_keys = ON');
runMigrations(db);
db.prepare(`INSERT INTO artist (id, name) VALUES ('a', 'A')`).run();
const release = (id: string, genre: string | null, style?: string) => {
  db.prepare(`INSERT INTO release (id, title, artist_id) VALUES (?, ?, 'a')`).run(id, id);
  if (genre) db.prepare(`INSERT INTO release_genre (release_id, kind, name, position, origin) VALUES (?, 'genre', ?, 0, 'discogs')`).run(id, genre);
  if (style) db.prepare(`INSERT INTO release_genre (release_id, kind, name, position, origin) VALUES (?, 'style', ?, 0, 'discogs')`).run(id, style);
};
const track = (id: string, releaseId: string, added: string, starred = false) => {
  db.prepare(`INSERT INTO track (id, title, artist_id, release_id, starred_at) VALUES (?, ?, 'a', ?, ?)`).run(id, id, releaseId, starred ? 'now' : null);
  db.prepare(`INSERT INTO source_facets (entity_kind, entity_id, source, key, value) VALUES ('track', ?, 'local', 'dateAdded', ?)`).run(id, JSON.stringify(added));
};
release('rE', 'Electronic', 'Deep House'); release('rJ', 'Jazz'); release('rU', null);
track('e1', 'rE', '2026-01-01'); track('e2', 'rE', '2026-03-01', true); track('j1', 'rJ', '2026-02-01'); track('u1', 'rU', '2026-04-01');

const ids = (pid: string) => getPlaylist(db, pid)!.tracks.map((t) => t.id);
const electronic = createPlaylist(db, 'All electronic', null, { genres: { include: ['Electronic'], exclude: [] } });
eq(ids(electronic.id), ['e2', 'e1'], 'include genre, newest added first');
const det = getPlaylist(db, electronic.id)!;
eq([det.isGig, det.rule, det.sections.length, det.crate.length], [false, { genres: { include: ['Electronic'], exclude: [] } }, 1, 0], 'smart detail shape');
eq(listPlaylists(db).find((p) => p.id === electronic.id)?.trackCount, 2, 'summary counts evaluated tracks');

const notElectronic = createPlaylist(db, 'Not electronic', null, { genres: { include: [], exclude: ['Electronic'] } });
eq(ids(notElectronic.id), ['j1'], 'exclude leaves out untagged');
const starred = createPlaylist(db, 'Starred deep house', null, { styles: { include: ['Deep House'], exclude: [] }, starred: true });
eq(ids(starred.id), ['e2'], 'style + starred');
const empty = createPlaylist(db, 'Empty', null, {});
eq(ids(empty.id), [], 'empty rule matches nothing');

release('rE2', 'Electronic'); track('e3', 'rE2', '2026-05-01');
eq(ids(electronic.id), ['e3', 'e2', 'e1'], 'evaluated on open');

for (const [name, fn] of [
  ['addTrack', () => addTrack(db, electronic.id, 'j1')],
  ['addRelease', () => addRelease(db, electronic.id, 'rJ')],
  ['createSection', () => createSection(db, electronic.id, 'Openers')],
  ['setTargetMinutes', () => setTargetMinutes(db, electronic.id, 90)],
  ['reorderTracks', () => reorderTracks(db, electronic.id, ['e1', 'e2'])],
  ['removeTrack', () => removeTrack(db, electronic.id, 'e1')],
] as const) {
  let err: unknown = null;
  try { fn(); } catch (e) { err = e; }
  eq(err instanceof SmartPlaylistError, true, `${name} refused`);
}
eq(listPlaylists(db).find((p) => p.id === electronic.id)?.isGig, false, 'never becomes a gig');

setPlaylistRule(db, electronic.id, { genres: { include: ['Jazz'], exclude: [] } });
eq(ids(electronic.id), ['j1'], 'rule updated');

const copy = copySmartPlaylist(db, starred.id);
const copied = getPlaylist(db, copy.id)!;
eq([copied.rule, copied.tracks.map((t) => t.id), copied.name], [null, ['e2'], 'Starred deep house (copy)'], 'copy is a plain playlist');
addTrack(db, copy.id, 'j1');
eq(getPlaylist(db, copy.id)!.tracks.length, 2, 'copy is editable');

eq(validateRule({ genres: { include: ['Techno'], exclude: [] } }), null, 'style is not a genre');
eq(validateRule({ styles: { include: ['Deep House'], exclude: [] } }), { styles: { include: ['Deep House'], exclude: [] } }, 'valid style rule');
eq(validateRule({ starred: 'yes' }), null, 'bad starred');
eq(validateRule('x'), null, 'not an object');
eq(ruleSummary({ genres: { include: ['Electronic'], exclude: ['Jazz'] }, styles: { include: ['Deep House', 'Techno'], exclude: [] }, starred: true }),
  'electronic · not jazz · deep house, techno · starred', 'summary');
// Journal: a rule replays, and a smart playlist's baseline carries no entries —
// replaying it must never turn evaluated tracks into stored membership.
const { replayPlaylistEvents, baselineFromDetail } = await import('../src/lib/server/backup/playlistJournal');
const base = { playlistId: 'p', playlistName: 'S', unsortedId: 'u' };
const replayed = replayPlaylistEvents([
  { at: '1', ...base, action: 'create', targetMinutes: null, rule: { genres: { include: ['Electronic'], exclude: [] } } },
  { at: '2', ...base, action: 'rule', rule: { genres: { include: ['Jazz'], exclude: [] } } },
] as never);
eq(replayed.get('p')?.rule, { genres: { include: ['Jazz'], exclude: [] } }, 'rule replays');
const bl = baselineFromDetail(getPlaylist(db, starred.id)!);
eq([bl.rule, Object.keys(bl.entries).length, bl.sections.map((x) => x.entryIds.length)], [{ styles: { include: ['Deep House'], exclude: [] }, starred: true }, 0, [0]], 'smart baseline has rule, no entries');
console.log('ok verify-smart-playlists');
