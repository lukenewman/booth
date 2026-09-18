import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  isAudioFile,
  ingestTargetPath,
  pickStable,
  dedupePath,
} from '../src/lib/server/sources/local/ingest_paths';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) fail(msg);
}

// --- Which files count ---------------------------------------------
assert(isAudioFile('/x/song.mp3'), 'mp3 is audio');
assert(isAudioFile('/x/song.FLAC'), 'extension match is case-insensitive');
assert(isAudioFile('/x/rip.wav'), 'wav is audio');
assert(!isAudioFile('/x/cover.jpg'), 'artwork is not audio');
assert(!isAudioFile('/x/notes.txt'), 'text is not audio');
assert(!isAudioFile('/x/.DS_Store'), 'finder droppings are not audio');
// Partial downloads carry the real extension ahead of the suffix; they must not
// be picked up just because ".mp3" appears in the name.
assert(!isAudioFile('/x/song.mp3.part'), 'partial download is not audio');
assert(!isAudioFile('/x/song.mp3.crdownload'), 'chrome partial is not audio');

// --- A file is ready only once it stops growing ---------------------
const first = new Map([['/i/a.mp3', 100], ['/i/b.mp3', 5_000]]);
const second = new Map([['/i/a.mp3', 100], ['/i/b.mp3', 9_000]]);
assert(
  JSON.stringify(pickStable(first, second)) === JSON.stringify(['/i/a.mp3']),
  'only the file whose size held steady is ready',
);
assert(pickStable(new Map(), second).length === 0, 'nothing is ready on the first pass');
// A file that appears and finishes between two passes still has to wait one
// more pass — we cannot tell "finished" from "paused mid-copy".
const third = new Map([['/i/b.mp3', 9_000]]);
assert(
  JSON.stringify(pickStable(second, third)) === JSON.stringify(['/i/b.mp3']),
  'a file that settles becomes ready on the next pass',
);
// Zero-byte files are never ready, however long they sit there.
const emptyTwice = new Map([['/i/c.mp3', 0]]);
assert(pickStable(emptyTwice, emptyTwice).length === 0, 'an empty file is never ready');

// --- Naming ---------------------------------------------------------
assert(
  ingestTargetPath('/lib', {
    albumArtist: 'Ruutu Poiss',
    artist: 'Ruutu Poiss',
    album: 'II',
    trackNumber: 3,
    title: 'Vesi',
  }, '/in/whatever.flac') === '/lib/Ruutu Poiss/II/03 Vesi.flac',
  `standard naming, got ${ingestTargetPath('/lib', { albumArtist: 'Ruutu Poiss', artist: 'Ruutu Poiss', album: 'II', trackNumber: 3, title: 'Vesi' }, '/in/whatever.flac')}`,
);
// Album artist wins over track artist, so a compilation lands in one folder.
assert(
  ingestTargetPath('/lib', {
    albumArtist: 'Various',
    artist: 'Some Guest',
    album: 'Comp',
    trackNumber: 1,
    title: 'T',
  }, '/in/x.mp3').startsWith('/lib/Various/'),
  'album artist decides the folder',
);
// Path separators and colons in tags must not escape the root.
const nasty = ingestTargetPath('/lib', {
  artist: '../../etc',
  album: 'A/B: C',
  title: 'x/y',
  trackNumber: 1,
}, '/in/x.mp3');
assert(nasty.startsWith('/lib/'), `stays under the root, got ${nasty}`);
// The property that matters is that no *segment* is a traversal — a literal
// folder named ".._.._etc" is ugly but harmless, and only three levels deep.
const segs = nasty.slice('/lib/'.length).split('/');
assert(segs.length === 3, `artist/album/file only, got ${segs.length}: ${nasty}`);
assert(!segs.some((s) => s === '.' || s === '..'), `no traversal segment, got ${nasty}`);
// A tag that is nothing but dots falls back rather than naming a directory.
const dots = ingestTargetPath('/lib', { artist: '..', album: '.', title: 'T' }, '/in/x.mp3');
assert(dots === '/lib/Unknown Artist/Unknown Album/T.mp3', `dot-only tags fall back, got ${dots}`);
// Missing tags fall back rather than producing an empty segment.
const bare = ingestTargetPath('/lib', {}, '/in/Some Download.mp3');
assert(bare === '/lib/Unknown Artist/Unknown Album/Some Download.mp3', `bare fallback, got ${bare}`);
// No track number means no number prefix, not "00".
const untracked = ingestTargetPath('/lib', { artist: 'A', album: 'B', title: 'C' }, '/in/x.mp3');
assert(untracked === '/lib/A/B/C.mp3', `no number prefix, got ${untracked}`);
// Track numbers past 99 keep their digits.
const high = ingestTargetPath('/lib', { artist: 'A', album: 'B', title: 'C', trackNumber: 100 }, '/in/x.mp3');
assert(high === '/lib/A/B/100 C.mp3', `three-digit track, got ${high}`);

// --- Collisions never overwrite -------------------------------------
const taken = new Set(['/lib/A/B/01 C.mp3', '/lib/A/B/01 C (2).mp3']);
assert(
  dedupePath('/lib/A/B/01 C.mp3', (p) => taken.has(p)) === '/lib/A/B/01 C (3).mp3',
  'collisions count up past the first suffix',
);
assert(
  dedupePath('/lib/A/B/free.mp3', () => false) === '/lib/A/B/free.mp3',
  'an unused path is returned unchanged',
);

console.log('OK: ingest paths');
