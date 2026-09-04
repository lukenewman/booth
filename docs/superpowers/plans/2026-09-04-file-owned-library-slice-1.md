# File-owned library, slice 1: fingerprint + rebuild proof — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove, without writing a single byte to any audio file or to the real database, that audio fingerprints can serve as track identity and that Booth's library can be reconstructed from file tags alone.

**Architecture:** Two small read-only modules (a fingerprinter that hashes the coded audio stream via ffmpeg, and a tag reader that maps file tags into a Booth-shaped record), plus three probe scripts that run them across the real 50GB library and report findings. Nothing here mutates originals; the one script that writes tags does so only to throwaway copies in a temp directory.

**Tech Stack:** Bun, TypeScript, `bun:sqlite`, `music-metadata` (read-only tag parsing, already a dependency), `ffmpeg` (already a required external binary).

**Spec:** `docs/superpowers/specs/2026-09-01-file-owned-library-design.md`

## Global Constraints

- **This slice is read-only against the user's data.** No writes to files under `~/Music`, no writes to `~/.booth/booth.db`. Probe scripts write reports to a scratch directory only. A step that would mutate an original is a plan violation.
- **Booth has no test framework.** `scripts/verify-*.ts` files *are* the tests: they use a local `check(label, actual, expected)` helper, count failures, and `process.exit(1)` on any failure. Run as `bun verify scripts/<name>.ts`. Follow that pattern exactly; do not introduce a test runner.
- **Runtime is Bun only** (`bun:sqlite` is load-bearing). Scripts import app modules by relative path, e.g. `../src/lib/server/...`.
- **ffmpeg is required** and already declared. Reuse `hasFfmpeg()` and `FfmpegMissingError` from `src/lib/server/analysis/decode.ts` rather than reimplementing the check.
- **Type-check with `bun check`** before every commit. It must report 0 errors.
- **Fixtures are generated, not committed.** Synthetic audio is produced at runtime with ffmpeg's `lavfi` sine source into a temp dir and deleted after. Do not add binary audio to the repo.
- **Never delete or modify rows in the real database.** Two prior incidents (29 stars, 924 tracks) came from scripts that assumed they could clean up broadly.

---

### Task 1: Audio fingerprint module

Hashes the coded audio stream only, so tag writes don't change identity. This is the claim the whole design rests on, so it is tested first and on synthetic audio where the expected answer is knowable.

**Files:**
- Create: `src/lib/server/library/fingerprint.ts`
- Create: `scripts/verify-fingerprint.ts`

**Interfaces:**
- Consumes: `FfmpegMissingError` from `src/lib/server/analysis/decode.ts`.
- Produces: `audioFingerprint(filePath: string): Promise<string>` returning a 32-char lowercase hex digest; `class FingerprintError extends Error` with `filePath: string`.

- [ ] **Step 1: Write the failing test**

Create `scripts/verify-fingerprint.ts`:

```ts
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun verify scripts/verify-fingerprint.ts`
Expected: FAIL — module `src/lib/server/library/fingerprint` does not exist (resolution error).

- [ ] **Step 3: Write the implementation**

Create `src/lib/server/library/fingerprint.ts`:

```ts
/**
 * Content-addressed identity for audio files.
 *
 * Hashes the *coded audio stream* and nothing else, so the fingerprint is
 * unchanged by tag writes, renames and moves — the operations that actually
 * happen to a music file, and the ones that broke every identity scheme this
 * library has used. Music.app persistent IDs shared zero overlap across the
 * 2025-08-25 machine move; file paths (what the date-added overlay had to
 * settle for) break silently on retag.
 *
 * `-c copy` rather than a decode: an order of magnitude faster across 50GB, and
 * the coded stream is what stays constant. The container and its tag blocks are
 * excluded by `-map 0:a`.
 */
import { FfmpegMissingError } from '../analysis/decode';

export class FingerprintError extends Error {
  constructor(
    readonly filePath: string,
    detail: string,
  ) {
    super(`could not fingerprint ${filePath}: ${detail}`);
    this.name = 'FingerprintError';
  }
}

export async function audioFingerprint(filePath: string): Promise<string> {
  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-i', filePath,
    '-map', '0:a',
    '-c', 'copy',
    '-f', 'md5',
    '-',
  ];

  let proc;
  try {
    proc = Bun.spawn(['ffmpeg', ...args], { stdout: 'pipe', stderr: 'pipe' });
  } catch {
    throw new FfmpegMissingError();
  }

  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new FingerprintError(filePath, err.trim().split('\n').slice(-2).join(' ') || `ffmpeg exited ${code}`);
  }

  const match = out.match(/MD5=([0-9a-f]{32})/);
  if (!match) throw new FingerprintError(filePath, `unexpected ffmpeg output: ${out.trim().slice(0, 80)}`);
  return match[1];
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun verify scripts/verify-fingerprint.ts`
Expected: PASS — 7 checks, "all checks passed".

- [ ] **Step 5: Type-check**

Run: `bun check`
Expected: `0 ERRORS 0 WARNINGS`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/server/library/fingerprint.ts scripts/verify-fingerprint.ts
git commit -m "feat(library): content-addressed audio fingerprint

Hashes the coded audio stream only, so identity survives tag writes,
renames and moves — the operations that broke persistent IDs on the
machine move and break paths on retag."
```

---

### Task 2: Tag reader module

Maps a file's own tags into a Booth-shaped record. Read-only; the writer is slice 2. Custom Booth fields are read here so that later slices' round-trips are testable with code that already exists.

**Files:**
- Create: `src/lib/server/library/tags.ts`
- Create: `scripts/verify-tags.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `readTags(filePath: string): Promise<FileTags>`; `interface FileTags` with fields `title?, artist?, albumArtist?, album?, year?, trackNumber?, genre?, durationMs?, bpm?, comment?, rating?` and `booth: Record<string, string>`; `const BOOTH_TAG_PREFIX = 'BOOTH_'`.

- [ ] **Step 1: Write the failing test**

Create `scripts/verify-tags.ts`:

```ts
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun verify scripts/verify-tags.ts`
Expected: FAIL — module `src/lib/server/library/tags` does not exist.

- [ ] **Step 3: Write the implementation**

Create `src/lib/server/library/tags.ts`:

```ts
/**
 * Reading a file's own tags into Booth's shape.
 *
 * Under the file-owned design the audio files are the record and this database
 * is a rebuildable index, so this reader is what a rebuild reconstructs from.
 * Read-only by design in this slice; the writer arrives with the tag schema.
 */
import { parseFile } from 'music-metadata';

/**
 * Prefix for Booth's own fields — things no standard frame expresses
 * (acquisition date, vetted, Discogs linkage, rip provenance). Containers spell
 * custom fields differently (`TXXX:BOOTH_X` in ID3, `----:com.apple.iTunes:BOOTH_X`
 * in MP4), so lookup is by suffix and callers see the bare name.
 */
export const BOOTH_TAG_PREFIX = 'BOOTH_';

export interface FileTags {
  title?: string;
  artist?: string;
  albumArtist?: string;
  album?: string;
  year?: number;
  trackNumber?: number;
  genre?: string;
  durationMs?: number;
  bpm?: number;
  comment?: string;
  /** 0..100, matching the scale Music.app and Booth's facets already use. */
  rating?: number;
  /** Booth's custom fields, prefix stripped. Empty for a file Booth has not tagged. */
  booth: Record<string, string>;
}

export async function readTags(filePath: string): Promise<FileTags> {
  const meta = await parseFile(filePath, { duration: true, skipCovers: true });
  const c = meta.common;

  const booth: Record<string, string> = {};
  for (const tags of Object.values(meta.native)) {
    for (const tag of tags) {
      const key = boothKey(tag.id);
      if (key && typeof tag.value === 'string') booth[key] = tag.value;
    }
  }

  return {
    title: c.title,
    artist: c.artist,
    albumArtist: c.albumartist,
    album: c.album,
    year: c.year,
    trackNumber: c.track?.no ?? undefined,
    genre: c.genre?.[0],
    durationMs: meta.format.duration != null ? Math.round(meta.format.duration * 1000) : undefined,
    bpm: c.bpm,
    comment: firstComment(c.comment),
    rating: firstRating(c.rating),
    booth,
  };
}

function boothKey(id: string): string | null {
  const i = id.indexOf(BOOTH_TAG_PREFIX);
  return i >= 0 ? id.slice(i + BOOTH_TAG_PREFIX.length) : null;
}

/** music-metadata returns comments as a list of `{ text }`; Booth wants one string. */
function firstComment(comments: { text?: string }[] | undefined): string | undefined {
  return comments?.find((c) => c.text)?.text;
}

/** music-metadata normalises ratings to 0..1; Booth's facets are 0..100 like Music.app's. */
function firstRating(ratings: { rating?: number }[] | undefined): number | undefined {
  const r = ratings?.find((x) => x.rating != null)?.rating;
  return r == null ? undefined : Math.round(r * 100);
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun verify scripts/verify-tags.ts`
Expected: PASS — 15 checks, "all checks passed".

If the two m4a Booth-field expectations were included and fail, that is a *finding*, not a bug in this module: ffmpeg does not write custom atoms to MP4. The test above deliberately asserts Booth fields on MP3 only for that reason. Record the MP4 gap in Task 5's report.

- [ ] **Step 5: Type-check**

Run: `bun check`
Expected: `0 ERRORS 0 WARNINGS`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/server/library/tags.ts scripts/verify-tags.ts
git commit -m "feat(library): read a file's own tags into Booth's shape

Read-only. Under the file-owned design this is what a rebuilt database
gets reconstructed from, so it handles both containers and surfaces
Booth's custom fields under bare names."
```

---

### Task 3: Fingerprint stability across real library files

Task 1 proves stability on synthetic tones from one encoder. The library is 4,355 files from many encoders, with VBR headers and cover art of varying sizes — the cases where a "stream copy" can quietly differ. This is the load-bearing risk in the whole design, so it is measured on real files.

**Files:**
- Create: `scripts/probe-fingerprint-stability.ts`

**Interfaces:**
- Consumes: `audioFingerprint` from Task 1.
- Produces: a console report and a JSON report at `$SCRATCH/fingerprint-stability.json`. Nothing later depends on its exports.

- [ ] **Step 1: Write the probe**

Create `scripts/probe-fingerprint-stability.ts`:

```ts
/**
 * probe-fingerprint-stability.ts — does the audio fingerprint hold across a tag
 * write on REAL library files?
 *
 * Task 1 proves it on synthetic tones from one encoder. This library has 4,355
 * files from many encoders, with VBR headers and embedded art — the cases where
 * a coded-stream copy can quietly differ. If a meaningful share of real files
 * move their fingerprint when tagged, content-addressed identity is not viable
 * and the design changes before anything is written.
 *
 * READ-ONLY against the library: every file is copied to a temp directory and
 * only the copy is ever tagged. Originals are opened for reading and nothing else.
 *
 * Run: bun verify scripts/probe-fingerprint-stability.ts [--limit 200] [--seed 1]
 */
import { Database } from 'bun:sqlite';
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { audioFingerprint } from '../src/lib/server/library/fingerprint';
import { hasFfmpeg } from '../src/lib/server/analysis/decode';

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback;
}
const limit = arg('limit', 200);
const seed = arg('seed', 1);

if (!(await hasFfmpeg())) {
  console.error('ffmpeg not on PATH — install it (brew install ffmpeg)');
  process.exit(1);
}

const dbPath = process.env.BOOTH_DB_PATH ?? join(homedir(), '.booth', 'booth.db');
const db = new Database(dbPath, { readonly: true });
const all = db
  .prepare(`SELECT key_value AS path FROM match_key WHERE entity_kind='track' AND key_type='file_path'`)
  .all() as { path: string }[];

// Deterministic spread across the library rather than the first N, which would
// be one artist's folder and one encoder.
const step = Math.max(1, Math.floor(all.length / limit));
const sample = all.filter((_, i) => i % step === (seed % step)).slice(0, limit);

const tmp = mkdtempSync(join(tmpdir(), 'booth-stability-'));

async function ffmpeg(args: string[]): Promise<boolean> {
  const proc = Bun.spawn(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', ...args], {
    stdout: 'ignore',
    stderr: 'ignore',
  });
  return (await proc.exited) === 0;
}

interface Moved { path: string; before: string; after: string }
const moved: Moved[] = [];
let stable = 0;
let missing = 0;
let unreadable = 0;

for (const [i, row] of sample.entries()) {
  if (!existsSync(row.path)) {
    missing++;
    continue;
  }
  const ext = extname(row.path) || '.bin';
  const copy = join(tmp, `c${i}${ext}`);
  const out = join(tmp, `t${i}${ext}`);
  try {
    copyFileSync(row.path, copy);
    const before = await audioFingerprint(copy);
    const ok = await ffmpeg(['-i', copy, '-map', '0', '-c', 'copy', '-metadata', 'comment=booth-probe', out]);
    if (!ok) {
      unreadable++;
      continue;
    }
    const after = await audioFingerprint(out);
    if (before === after) stable++;
    else moved.push({ path: row.path, before, after });
  } catch {
    unreadable++;
  } finally {
    rmSync(copy, { force: true });
    rmSync(out, { force: true });
  }
  if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${sample.length}…`);
}

const scratch = process.env.SCRATCH ?? tmpdir();
const report = { sampled: sample.length, stable, moved, missing, unreadable, libraryTotal: all.length };
writeFileSync(join(scratch, 'fingerprint-stability.json'), JSON.stringify(report, null, 2));

console.log(`\nsampled     ${sample.length} of ${all.length} library files`);
console.log(`stable      ${stable}`);
console.log(`MOVED       ${moved.length}${moved.length ? '  ← content-addressed identity is not safe for these' : ''}`);
console.log(`missing     ${missing}  (row points at a file that is not there)`);
console.log(`unreadable  ${unreadable}`);
for (const m of moved.slice(0, 20)) console.log(`  moved: ${m.path}`);
console.log(`\nreport: ${join(scratch, 'fingerprint-stability.json')}`);

rmSync(tmp, { recursive: true, force: true });
// A probe reports; it does not gate. The verdict is the operator's.
```

- [ ] **Step 2: Run it against the real library**

Run: `bun verify scripts/probe-fingerprint-stability.ts --limit 200`
Expected: completes without error; prints a `MOVED` count. **`MOVED 0` is the result the design needs.** Any non-zero count must be listed in Task 5's report with the offending files, because it means some files need a fallback identity.

- [ ] **Step 3: Type-check**

Run: `bun check`
Expected: `0 ERRORS 0 WARNINGS`.

- [ ] **Step 4: Commit**

```bash
git add scripts/probe-fingerprint-stability.ts
git commit -m "feat(scripts): probe fingerprint stability on real library files

Copies a deterministic spread of real files to a temp dir, tags the
copies, and checks the audio fingerprint holds. Originals are only ever
read. Answers the load-bearing risk before anything is written."
```

---

### Task 4: Library-wide fingerprint cost and collisions

Answers the spec's open question about hashing cost across 50GB, and checks that fingerprints actually discriminate — two different tracks must not collide, and genuine duplicates should surface as a useful by-product.

**Files:**
- Create: `scripts/probe-fingerprints.ts`

**Interfaces:**
- Consumes: `audioFingerprint` from Task 1.
- Produces: console report plus `$SCRATCH/fingerprints.json` mapping fingerprint → paths. Task 5 reads that file if present.

- [ ] **Step 1: Write the probe**

Create `scripts/probe-fingerprints.ts`:

```ts
/**
 * probe-fingerprints.ts — fingerprint the whole local library.
 *
 * Answers two questions the design left open: what it costs to hash 50GB (which
 * decides whether the migration is one pass or batched), and whether fingerprints
 * discriminate across a real collection. Collisions are reported rather than
 * assumed away — two files sharing a fingerprint are either genuine duplicates
 * (useful) or a hashing flaw (fatal), and only the paths tell you which.
 *
 * READ-ONLY: opens files for reading, writes only a report.
 *
 * Run: bun verify scripts/probe-fingerprints.ts [--limit N] [--concurrency 4]
 */
import { Database } from 'bun:sqlite';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { audioFingerprint } from '../src/lib/server/library/fingerprint';
import { hasFfmpeg } from '../src/lib/server/analysis/decode';

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback;
}
const limit = arg('limit', Infinity);
const concurrency = Math.max(1, arg('concurrency', 4));

if (!(await hasFfmpeg())) {
  console.error('ffmpeg not on PATH — install it (brew install ffmpeg)');
  process.exit(1);
}

const dbPath = process.env.BOOTH_DB_PATH ?? join(homedir(), '.booth', 'booth.db');
const db = new Database(dbPath, { readonly: true });
const rows = (
  db
    .prepare(`SELECT key_value AS path FROM match_key WHERE entity_kind='track' AND key_type='file_path'`)
    .all() as { path: string }[]
).slice(0, limit === Infinity ? undefined : limit);

const byFingerprint = new Map<string, string[]>();
let bytes = 0;
let missing = 0;
let failed = 0;
const started = Date.now();

async function one(path: string): Promise<void> {
  if (!existsSync(path)) {
    missing++;
    return;
  }
  try {
    bytes += statSync(path).size;
    const fp = await audioFingerprint(path);
    const list = byFingerprint.get(fp);
    if (list) list.push(path);
    else byFingerprint.set(fp, [path]);
  } catch {
    failed++;
  }
}

for (let i = 0; i < rows.length; i += concurrency) {
  await Promise.all(rows.slice(i, i + concurrency).map((r) => one(r.path)));
  if ((i + concurrency) % 400 < concurrency) {
    const done = Math.min(i + concurrency, rows.length);
    const rate = done / ((Date.now() - started) / 1000);
    console.log(`  ${done}/${rows.length}  ${rate.toFixed(1)} files/s`);
  }
}

const elapsedS = (Date.now() - started) / 1000;
const gb = bytes / 1e9;
const collisions = [...byFingerprint.entries()].filter(([, paths]) => paths.length > 1);

const scratch = process.env.SCRATCH ?? tmpdir();
writeFileSync(
  join(scratch, 'fingerprints.json'),
  JSON.stringify(Object.fromEntries(byFingerprint), null, 2),
);

console.log(`\nfingerprinted  ${byFingerprint.size} distinct across ${rows.length - missing - failed} files`);
console.log(`elapsed        ${elapsedS.toFixed(1)}s for ${gb.toFixed(1)}GB  (${(gb / elapsedS * 60).toFixed(1)} GB/min)`);
console.log(`missing        ${missing}`);
console.log(`failed         ${failed}`);
console.log(`collisions     ${collisions.length}  (same audio, more than one file)`);
for (const [fp, paths] of collisions.slice(0, 15)) {
  console.log(`  ${fp}`);
  for (const p of paths) console.log(`    ${p}`);
}
console.log(`\nreport: ${join(scratch, 'fingerprints.json')}`);
```

- [ ] **Step 2: Run it on a sample first, then the whole library**

Run: `bun verify scripts/probe-fingerprints.ts --limit 200`
Expected: completes, prints a files/s rate.

Then run the full pass: `bun verify scripts/probe-fingerprints.ts`
Expected: completes across ~4,344 files. Record the GB/min figure and the collision list for Task 5.

- [ ] **Step 3: Type-check**

Run: `bun check`
Expected: `0 ERRORS 0 WARNINGS`.

- [ ] **Step 4: Commit**

```bash
git add scripts/probe-fingerprints.ts
git commit -m "feat(scripts): fingerprint the whole local library

Measures hashing cost across 50GB and reports collisions, answering
whether the migration is one pass or batched and whether fingerprints
discriminate on a real collection."
```

---

### Task 5: Rebuild-from-tags prover

The spec's central claim is that Booth's database can be reconstructed from the files. This reconstructs a library model from tags alone and diffs it against the real database. Today the files carry no Booth tags, so **the diff is the specification for slice 2**: everything it reports as unrecoverable is a field the tag schema must carry.

**Files:**
- Create: `scripts/probe-rebuild.ts`

**Interfaces:**
- Consumes: `readTags` and `FileTags` from Task 2; `audioFingerprint` from Task 1.
- Produces: console report plus `$SCRATCH/rebuild-gap.json` listing recoverable and unrecoverable fields with counts.

- [ ] **Step 1: Write the prover**

Create `scripts/probe-rebuild.ts`:

```ts
/**
 * probe-rebuild.ts — could the database be rebuilt from the files alone?
 *
 * The file-owned design claims the database is a rebuildable index rather than
 * the original. This reconstructs what a rebuild would produce from tags alone
 * and diffs it against the real database.
 *
 * Today no Booth tags have been written, so the gap this reports IS the
 * specification for the tag schema: every field listed as unrecoverable is one
 * slice 2 must write into files, or one Booth would lose forever.
 *
 * READ-ONLY: reads files and the database, writes only a report.
 *
 * Run: bun verify scripts/probe-rebuild.ts [--limit N]
 */
import { Database } from 'bun:sqlite';
import { existsSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTags } from '../src/lib/server/library/tags';

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback;
}
const limit = arg('limit', Infinity);

const dbPath = process.env.BOOTH_DB_PATH ?? join(homedir(), '.booth', 'booth.db');
const db = new Database(dbPath, { readonly: true });

interface Row {
  trackId: string;
  path: string;
  title: string;
  album: string | null;
  artist: string;
  starred: string | null;
  note: string | null;
}

const rows = (
  db
    .prepare(
      `SELECT t.id AS trackId, mk.key_value AS path, t.title, t.album, a.name AS artist,
              t.starred_at AS starred, t.note AS note
         FROM match_key mk
         JOIN track t   ON t.id = mk.entity_id
         JOIN artist a  ON a.id = t.artist_id
        WHERE mk.entity_kind='track' AND mk.key_type='file_path'`,
    )
    .all() as Row[]
).slice(0, limit === Infinity ? undefined : limit);

/** Per-track local facets, keyed by track id then facet key. Values are whatever
 *  the facet stored — strings for dates, numbers for tempo — so `unknown`, not `string`. */
const facets = new Map<string, Record<string, unknown>>();
for (const f of db
  .prepare(`SELECT entity_id, key, value FROM source_facets WHERE source='local' AND entity_kind='track'`)
  .all() as { entity_id: string; key: string; value: string }[]) {
  const rec = facets.get(f.entity_id) ?? {};
  rec[f.key] = JSON.parse(f.value);
  facets.set(f.entity_id, rec);
}

const norm = (s?: string | null) =>
  (s ?? '').normalize('NFD').replace(/\p{Diacritic}+/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Fields a rebuild would get right today, and fields it would lose. */
const recoverable: Record<string, number> = {};
const lost: Record<string, number> = {};
function tally(bucket: Record<string, number>, key: string) {
  bucket[key] = (bucket[key] ?? 0) + 1;
}

let read = 0;
let missing = 0;
let unreadable = 0;

for (const [i, row] of rows.entries()) {
  if (!existsSync(row.path)) {
    missing++;
    continue;
  }
  let tags;
  try {
    tags = await readTags(row.path);
  } catch {
    unreadable++;
    continue;
  }
  read++;

  // Identity and naming — what the files already carry.
  tally(norm(tags.title) === norm(row.title) ? recoverable : lost, 'title');
  tally(norm(tags.artist) === norm(row.artist) ? recoverable : lost, 'artist');
  tally(norm(tags.album) === norm(row.album) ? recoverable : lost, 'album');

  // Booth-native facts — present in the DB, and only recoverable if a Booth tag carries them.
  const f = facets.get(row.trackId) ?? {};
  if (row.starred) tally(tags.booth.STARRED ? recoverable : lost, 'starred');
  if (row.note) tally(tags.booth.NOTE ? recoverable : lost, 'note');
  if (f.dateAdded) tally(tags.booth.DATE_ADDED ? recoverable : lost, 'dateAdded');
  if (f.dateAddedOrigin) tally(tags.booth.DATE_ADDED_ORIGIN ? recoverable : lost, 'dateAddedOrigin');
  if (f.bpmAnalyzed) tally(tags.bpm != null ? recoverable : lost, 'bpmAnalyzed');
  if (f.genre) tally(tags.genre ? recoverable : lost, 'genre');

  if ((i + 1) % 500 === 0) console.log(`  ${i + 1}/${rows.length}…`);
}

// Release-level facts have no per-file home and must be denormalised onto tracks.
const vetted = db.prepare(`SELECT COUNT(*) AS n FROM release WHERE vetted_at IS NOT NULL`).get() as { n: number };
const playlists = db.prepare(`SELECT COUNT(*) AS n FROM playlist`).get() as { n: number };

const scratch = process.env.SCRATCH ?? tmpdir();
const report = { read, missing, unreadable, recoverable, lost, vettedReleases: vetted.n, playlists: playlists.n };
writeFileSync(join(scratch, 'rebuild-gap.json'), JSON.stringify(report, null, 2));

console.log(`\nread ${read} files (${missing} missing, ${unreadable} unreadable)\n`);
console.log('Recoverable from tags as they stand today:');
for (const [k, n] of Object.entries(recoverable).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(18)} ${n}`);
console.log('\nLOST on a rebuild today — the tag schema slice 2 must carry:');
for (const [k, n] of Object.entries(lost).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(18)} ${n}`);
console.log(`\nNo per-file home, need denormalising or sidecar files:`);
console.log(`  vetted releases    ${vetted.n}  (stamp on every track of the release)`);
console.log(`  playlists          ${playlists.n}  (write as playlist files alongside the tree)`);
console.log(`\nreport: ${join(scratch, 'rebuild-gap.json')}`);
```

- [ ] **Step 2: Run it against the real library**

Run: `bun verify scripts/probe-rebuild.ts --limit 300`
Expected: completes and prints both lists. Then run without `--limit` for the full picture.

The expected shape of the result: title/artist/album mostly recoverable; stars, notes, acquisition dates and analysed tempo entirely lost. **That is the point** — it is the evidence that the tag schema is necessary and the list of what it must carry.

- [ ] **Step 3: Type-check**

Run: `bun check`
Expected: `0 ERRORS 0 WARNINGS`.

- [ ] **Step 4: Commit**

```bash
git add scripts/probe-rebuild.ts
git commit -m "feat(scripts): prove what a rebuild from tags would recover

Reconstructs from tags alone and diffs against the database. The gap it
reports is the specification for the tag schema: every lost field is one
slice 2 must write, or one Booth would lose forever."
```

---

### Task 6: Record the findings in the context doc

The slice exists to produce evidence. Evidence that lives only in a terminal is lost by the next session.

**Files:**
- Modify: `docs/CONTEXT.md` (the local-source section, after the date-added overlay entry)

**Interfaces:**
- Consumes: the reports from Tasks 3, 4, 5.
- Produces: nothing code depends on.

- [ ] **Step 1: Write the findings into the context doc**

Add a subsection under the local source covering, with the real numbers from the probe runs:

- The fingerprint's definition (coded audio stream, `-map 0:a -c copy -f md5`) and *why* it replaces persistent IDs and paths.
- The measured stability result from Task 3: sample size and how many fingerprints moved. If any moved, name the pattern.
- The measured cost from Task 4: GB/min, and what that implies for the migration pass.
- Any collisions found, and whether they were genuine duplicates.
- The rebuild gap from Task 5: what tags already carry, and the list of fields the tag schema must add.
- The ffmpeg tag-writing limitation established during design: comments land in the wrong frame on MP3 and custom fields are dropped entirely on MP4, so **ffmpeg cannot be the tag writer** — slice 2 needs a real tagging library.

- [ ] **Step 2: Commit**

```bash
git add docs/CONTEXT.md
git commit -m "docs: record slice 1 findings on fingerprints and rebuild gap"
```

---

## Done when

- `bun verify scripts/verify-fingerprint.ts` and `bun verify scripts/verify-tags.ts` both pass.
- The three probes have been run against the real library and their numbers recorded in `docs/CONTEXT.md`.
- `bun check` reports 0 errors.
- No file under `~/Music` has been modified, and `~/.booth/booth.db` is unchanged apart from ordinary app use.
- The decision for slice 2 is evidence-backed: either fingerprints are stable enough to be identity (proceed), or they are not (the design changes before anything is written).
