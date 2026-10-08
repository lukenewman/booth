import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendPlaylistEvent, readPlaylistEvents, replayPlaylistEvents, type PlaylistEvent, type PlaylistEventBody,
} from '../src/lib/server/backup/playlistJournal';

function fail(msg: string): never { console.error(`FAIL: ${msg}`); process.exit(1); }
function assert(cond: unknown, msg: string): asserts cond { if (!cond) fail(msg); }

const log = join(mkdtempSync(join(tmpdir(), 'pljournal-')), 'playlists.log');
let t = 0;
const at = () => new Date(Date.UTC(2026, 9, 7, 12, 0, t++)).toISOString();
const ev = (body: PlaylistEventBody): PlaylistEvent => ({ at: at(), playlistId: 'p1', playlistName: 'Sat', unsortedId: 'u1', ...body });
const add = (entryId: string, sectionId: string, sectionName: string, title: string): PlaylistEventBody =>
  ({ action: 'track-add', entryId, sectionId, sectionName, trackId: `t-${entryId}`, artist: 'A', title, album: 'LP', position: 'A1' });

const events: PlaylistEvent[] = [
  ev({ action: 'create', targetMinutes: 180 }),
  ev({ action: 'section-add', sectionId: 's1', name: 'Openers' }),
  ev(add('e1', 'u1', 'Unsorted', 'One')),
  ev(add('e2', 'u1', 'Unsorted', 'Two')),
  ev(add('e3', 's1', 'Openers', 'Three')),
  ev({ action: 'track-move', entryId: 'e2', sectionId: 's1', sectionName: 'Openers', index: 0 }),
  ev({ action: 'crate-add', entryId: 'c1', releaseId: 'r1', artist: 'A', title: 'LP', year: 2001 }),
];
for (const e of events) appendPlaylistEvent(log, e);
const cut = at(); // everything before this is "before the accident"
appendPlaylistEvent(log, ev({ action: 'section-delete', sectionId: 's1' }));
appendPlaylistEvent(log, ev({ action: 'delete' }));

const read = readPlaylistEvents(log);
assert(read.length === events.length + 2, `read all events, got ${read.length}`);

const now = replayPlaylistEvents(read);
assert(!now.has('p1'), 'deleted playlist absent from replay');

const before = replayPlaylistEvents(read, cut).get('p1')!;
assert(before && before.name === 'Sat' && before.targetMinutes === 180, 'as-of replay restores playlist');
assert(before.sections.map((s) => s.name).join('|') === 'Unsorted|Openers', 'sections');
assert(before.sections[0].entryIds.join() === 'e1', `Unsorted entries: ${before.sections[0].entryIds.join()}`);
assert(before.sections[1].entryIds.join() === 'e2,e3', `Openers entries: ${before.sections[1].entryIds.join()}`);
assert(before.crate.length === 1 && before.crate[0].releaseId === 'r1', 'crate');

// section-delete moves to end of Unsorted, mirroring the server
const midDelete = replayPlaylistEvents(read.slice(0, events.length + 1)).get('p1')!;
assert(midDelete.sections.length === 1 && midDelete.sections[0].entryIds.join() === 'e1,e2,e3', 'section-delete replay');

// A playlist that predates the journal is created lazily from its first event.
const lazy = replayPlaylistEvents([{ at: at(), playlistId: 'old', playlistName: 'Old', unsortedId: 'unsorted-old', ...add('x', 'unsorted-old', 'Unsorted', 'X') }]);
assert(lazy.get('old')!.sections[0].isUnsorted && lazy.get('old')!.sections[0].entryIds[0] === 'x', 'lazy playlist');

// A truncated final line doesn't poison the log.
const { appendFileSync } = await import('node:fs');
appendFileSync(log, '{"at":"2026-10-07T13:00:00.000Z","playlistId":');
assert(readPlaylistEvents(log).length === events.length + 2, 'truncated line skipped');

console.log('PASS: playlist journal');
