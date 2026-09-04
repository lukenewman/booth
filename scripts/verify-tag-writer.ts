/**
 * verify-tag-writer.ts — writing Booth's facts into a file without touching its audio.
 *
 * The safety property slice 3 depends on: a tagged file must carry the same
 * audio as its source, byte for byte in the coded stream. The writer asserts it
 * and this pins the assertion down, along with the round trip through the
 * slice-1 reader on both container formats.
 *
 * Run: bun verify scripts/verify-tag-writer.ts
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeTags, TagWriteError } from '../src/lib/server/library/tag_writer';
import { audioFingerprint } from '../src/lib/server/library/fingerprint';
import { readTags } from '../src/lib/server/library/tags';
import { hasFfmpeg } from '../src/lib/server/analysis/decode';

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(
    `${ok ? '✓' : '✗'} ${label}` +
      (ok ? '' : `\n    expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`),
  );
}

if (!(await hasFfmpeg())) {
  console.error('ffmpeg not on PATH — install it (brew install ffmpeg)');
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), 'booth-writer-'));

async function tone(name: string, codec: string): Promise<string> {
  const path = join(tmp, name);
  const proc = Bun.spawn(
    ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
     '-c:a', codec, '-metadata', 'title=Original Title', '-metadata', 'artist=Original Artist', path],
    { stdout: 'ignore', stderr: 'pipe' },
  );
  if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text());
  return path;
}

const FACTS = {
  dateAdded: '2020-10-05T18:22:00Z',
  dateAddedOrigin: 'recovered',
  starred: true,
  note: 'peak time',
  bpm: 124,
  fingerprint: 'placeholder',
};

for (const [label, codec, ext] of [['mp3', 'libmp3lame', 'mp3'], ['m4a', 'aac', 'm4a']] as const) {
  const src = await tone(`s.${ext}`, codec);
  const before = await audioFingerprint(src);
  const dest = join(tmp, `d.${ext}`);

  const returned = await writeTags(src, FACTS, dest);
  check(`${label}: audio is untouched`, await audioFingerprint(dest), before);
  check(`${label}: returns the written file's fingerprint`, returned, before);

  const back = await readTags(dest);
  check(`${label}: acquisition date round-trips`, back.booth.DATE_ADDED, '2020-10-05T18:22:00Z');
  check(`${label}: date provenance round-trips`, back.booth.DATE_ADDED_ORIGIN, 'recovered');
  check(`${label}: star round-trips as a Booth field`, back.booth.STARRED, '1');
  check(`${label}: note lands in the standard comment`, back.comment, 'peak time');
  check(`${label}: tempo lands in the standard field`, back.bpm, 124);
  check(`${label}: existing tags are preserved`, back.title, 'Original Title');
}

// The standard rating is the rekordbox-visible carrier, and only MP3 gets it.
const mp3Rating = (await readTags(join(tmp, 'd.mp3'))).rating;
check('mp3: a star writes full marks to the standard rating', mp3Rating, 100);

// Writing in place is the same operation with the destination defaulted.
const inPlace = await tone('inplace.mp3', 'libmp3lame');
const inPlaceBefore = await audioFingerprint(inPlace);
await writeTags(inPlace, { dateAdded: '2019-01-01T00:00:00Z' });
check('in-place write leaves audio alone', await audioFingerprint(inPlace), inPlaceBefore);
check('in-place write applied the tag', (await readTags(inPlace)).booth.DATE_ADDED, '2019-01-01T00:00:00Z');

// No temp files may survive a successful write.
const strays = readdirSync(tmp).filter((f) => f.includes('booth-tmp'));
check('no temp files left behind', strays, []);

let errored: unknown = null;
try {
  await writeTags(join(tmp, 'missing.mp3'), FACTS);
} catch (e) {
  errored = e;
}
check('a missing source throws TagWriteError', errored instanceof TagWriteError, true);
check('...and writes no destination', existsSync(join(tmp, 'missing.mp3')), false);

rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
