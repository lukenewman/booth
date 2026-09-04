/**
 * verify-tags.ts — reading a file's own tags into Booth's shape.
 *
 * The design makes files the source of truth, so this reader is what a rebuilt
 * database would be reconstructed from. It must handle both container formats
 * and must surface Booth's custom fields under their bare names regardless of
 * how the container spells them (ID3 `TXXX:BOOTH_X`, MP4 `----:…:BOOTH_X`).
 *
 * Run: bun verify scripts/verify-tags.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

const tmp = mkdtempSync(join(tmpdir(), 'booth-tags-'));

async function ffmpeg(args: string[]): Promise<void> {
  const proc = Bun.spawn(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', ...args], {
    stdout: 'ignore',
    stderr: 'pipe',
  });
  if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text());
}

/** A tagged sine tone. ffmpeg is the mutator of convenience here, not the eventual writer. */
async function tagged(name: string, codec: string): Promise<string> {
  const path = join(tmp, name);
  await ffmpeg([
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:a', codec,
    '-metadata', 'title=Test Title',
    '-metadata', 'artist=Test Artist',
    '-metadata', 'album=Test Album',
    '-metadata', 'album_artist=Test Album Artist',
    '-metadata', 'date=1997',
    '-metadata', 'track=7',
    '-metadata', 'genre=Electronic',
    path,
  ]);
  return path;
}

const mp3 = await tagged('t.mp3', 'libmp3lame');
const t = await readTags(mp3);
check('title', t.title, 'Test Title');
check('artist', t.artist, 'Test Artist');
check('album', t.album, 'Test Album');
check('album artist', t.albumArtist, 'Test Album Artist');
check('year', t.year, 1997);
check('track number', t.trackNumber, 7);
check('genre', t.genre, 'Electronic');
check('duration is about two seconds', Math.abs((t.durationMs ?? 0) - 2000) < 200, true);
check('no Booth fields on a plain file', t.booth, {});

// Booth's own fields, written under the ID3 custom-frame convention.
const withBooth = join(tmp, 'booth.mp3');
await ffmpeg(['-i', mp3, '-map', '0', '-c', 'copy', '-metadata', 'BOOTH_DATE_ADDED=2020-10-05T18:22:00Z', '-metadata', 'BOOTH_STARRED=1', withBooth]);
const b = await readTags(withBooth);
check('Booth field read under its bare name', b.booth.DATE_ADDED, '2020-10-05T18:22:00Z');
check('second Booth field', b.booth.STARRED, '1');
check('standard fields still read alongside', b.title, 'Test Title');

const m4a = await tagged('t.m4a', 'aac');
const m = await readTags(m4a);
check('m4a: title', m.title, 'Test Title');
check('m4a: album artist', m.albumArtist, 'Test Album Artist');
check('m4a: track number', m.trackNumber, 7);

rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
