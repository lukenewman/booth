/**
 * verify-fingerprint.ts — audio identity must survive tag writes.
 *
 * The design replaces Music.app persistent IDs (which churned on the machine
 * move and cascade-deleted 924 tracks) and file paths (which break on retag)
 * with a hash of the audio itself. That only works if writing a tag leaves the
 * hash alone, which is what this asserts — on both container formats in the
 * library, using synthetic audio so the expected answer is knowable.
 *
 * Run: bun verify scripts/verify-fingerprint.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { audioFingerprint, FingerprintError } from '../src/lib/server/library/fingerprint';
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

const tmp = mkdtempSync(join(tmpdir(), 'booth-fp-'));

async function ffmpeg(args: string[]): Promise<void> {
  const proc = Bun.spawn(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', ...args], {
    stdout: 'ignore',
    stderr: 'pipe',
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(await new Response(proc.stderr).text());
}

/** A short sine tone in the given container. Deterministic, so hashes are comparable. */
async function tone(name: string, freq: number, codec: string): Promise<string> {
  const path = join(tmp, name);
  await ffmpeg(['-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=2`, '-c:a', codec, path]);
  return path;
}

/**
 * Rewrite tags without touching the audio. ffmpeg is used purely as a mutator
 * here — it is NOT the eventual tag writer (it mangles comments on MP3 and drops
 * custom fields on MP4; see the plan's slice 2). Any tag mutation proves the point.
 */
async function retag(src: string, name: string): Promise<string> {
  const out = join(tmp, name);
  await ffmpeg(['-i', src, '-map', '0', '-c', 'copy', '-metadata', 'comment=changed', '-metadata', 'artist=Someone Else', out]);
  return out;
}

for (const [label, codec, ext] of [['mp3', 'libmp3lame', 'mp3'], ['m4a', 'aac', 'm4a']] as const) {
  const original = await tone(`a.${ext}`, 440, codec);
  const tagged = await retag(original, `a-tagged.${ext}`);
  check(`${label}: fingerprint survives a tag write`, await audioFingerprint(tagged), await audioFingerprint(original));

  const different = await tone(`b.${ext}`, 880, codec);
  const same = (await audioFingerprint(different)) === (await audioFingerprint(original));
  check(`${label}: different audio fingerprints differently`, same, false);
}

check('fingerprint is 32 hex chars', /^[0-9a-f]{32}$/.test(await audioFingerprint(join(tmp, 'a.mp3'))), true);

let errored: unknown = null;
try {
  await audioFingerprint(join(tmp, 'does-not-exist.mp3'));
} catch (e) {
  errored = e;
}
check('missing file throws FingerprintError', errored instanceof FingerprintError, true);
check('...naming the file', (errored as FingerprintError)?.filePath, join(tmp, 'does-not-exist.mp3'));

rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
