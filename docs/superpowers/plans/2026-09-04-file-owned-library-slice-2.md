# File-owned library, slice 2: tag schema + writer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and verify the machinery that writes Booth's facts into audio files — the schema saying what goes where, and a writer that is atomic and proves it did not touch the audio — without applying it to the real library.

**Architecture:** A pure schema module maps Booth's facts onto tag fields (standard frames for anything another tool reads, custom `BOOTH_*` fields for the rest). A writer composes `taglib-wasm`'s bulk tag write with its rating API, writes to a temp file, verifies the audio fingerprint is unchanged, and only then renames into place. Two probes exercise it against copies of real library files and report what a full pass would write.

**Tech Stack:** Bun, TypeScript, `taglib-wasm` (new dependency — the writer), `music-metadata` (existing, reader), `ffmpeg` (existing, fingerprints).

**Spec:** `docs/superpowers/specs/2026-09-01-file-owned-library-design.md`
**Previous slice:** `docs/superpowers/plans/2026-09-04-file-owned-library-slice-1.md`

## Global Constraints

- **This slice does not modify the library.** Every write in these tasks targets a temp directory or an explicit destination path. The migration that writes real files is slice 3. A step that writes into `~/Music` is a plan violation.
- **Never write a file whose audio fingerprint differs from its source.** The writer verifies this itself and throws; do not add a bypass.
- **Booth has no test framework.** `scripts/verify-*.ts` files *are* the tests: a local `check(label, actual, expected)` helper, a failure count, `process.exit(1)` on any failure. Run as `bun verify scripts/<name>.ts`.
- **Runtime is Bun only.** Scripts import app modules by relative path (`../src/lib/server/...`).
- **Type-check with `bun check`** before every commit; it must report 0 errors.
- **Fixtures are generated, not committed** — synthetic audio via ffmpeg's `lavfi` sine source into a temp dir, deleted after.
- **Never delete or modify rows in the real database.** All DB access in this slice opens `readonly: true`.

## Findings this plan is built on

Established by direct test during planning; the code below depends on them.

- **`taglib-wasm` is the writer.** On MP3 it writes a proper `COMM` frame, `TBPM`, and `TXXX:BOOTH_*` custom fields; on M4A a proper comment atom, `tmpo`, and `----:com.apple.iTunes:BOOTH_*` freeform atoms. The audio fingerprint is unchanged in every case, including on a real 15MB library file with embedded artwork, whose existing title/artist/art all survived.
- **ffmpeg is ruled out** — wrong frame for comments on MP3, custom fields silently dropped on MP4.
- **Ratings need the file API, not the bulk write.** A `rating` key passed to `applyTags` is ignored. Opening the resulting buffer and calling `setRating` writes `POPM` correctly, and chaining the two works.
- **`RatingUtils.toPopm()` is broken** — it returns 255 for 1 star and 0 for 2–5. The library's own `RatingUtils.POPM_STAR_VALUES` table (`[0, 1, 64, 128, 196, 255]`, indexed by stars) is correct. **Use the table, never the helper.**
- **M4A ratings do not write at all** through this library. 175 of 4,355 files (4%) are M4A, so their stars will not be visible to rekordbox; Booth's own custom field still carries them, so nothing is lost to a rebuild. Recorded, not solved, in this slice.

---

### Task 1: Tag schema

One place that says what Booth fact goes into which tag field. Pure mapping, no I/O, so it is cheap to test and impossible to get subtly wrong in two places later.

**Files:**
- Modify: `package.json` (add `taglib-wasm`)
- Create: `src/lib/server/library/tag_schema.ts`
- Create: `scripts/verify-tag-schema.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface BoothTrackFacts`; `interface TagWrite { comment?: string; bpm?: number; ratingStars?: number; custom: Record<string, string> }`; `function toTagWrite(facts: BoothTrackFacts): TagWrite`; `const BOOTH_KEYS`; `const POPM_STAR_VALUES`.

- [ ] **Step 1: Add the dependency**

```bash
bun add taglib-wasm
```

- [ ] **Step 2: Write the failing test**

Create `scripts/verify-tag-schema.ts`:

```ts
/**
 * verify-tag-schema.ts — what Booth fact goes into which tag field.
 *
 * Pure mapping, so this is the cheapest place to pin the decisions down: which
 * facts get a standard frame (because another tool reads them) and which get a
 * BOOTH_ custom field (because nothing standard expresses them).
 *
 * Run: bun verify scripts/verify-tag-schema.ts
 */
import { toTagWrite, BOOTH_KEYS, POPM_STAR_VALUES } from '../src/lib/server/library/tag_schema';

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(
    `${ok ? '✓' : '✗'} ${label}` +
      (ok ? '' : `\n    expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`),
  );
}

// Facts other tools read go to standard fields.
const analysed = toTagWrite({ bpm: 124, note: 'peak time' });
check('analysed tempo goes to the standard field', analysed.bpm, 124);
check('a note goes to the standard comment', analysed.comment, 'peak time');

// A star is a keeper flag, not a rating — it maps to the top of the scale so
// other software shows five stars rather than "1 out of 255".
const starred = toTagWrite({ starred: true });
check('a star writes full marks', starred.ratingStars, 5);
check('POPM value for five stars', POPM_STAR_VALUES[5], 255);
check('unstarred writes no rating at all', toTagWrite({ starred: false }).ratingStars, undefined);

// Facts nothing standard expresses go to Booth's own fields.
const facts = toTagWrite({
  dateAdded: '2020-10-05T18:22:00Z',
  dateAddedReported: '2025-08-25T13:37:11Z',
  dateAddedOrigin: 'recovered',
  starred: true,
  vetted: true,
  fingerprint: 'abc123',
  discogsReleaseId: '98765',
  origin: 'vinyl',
});
check('acquisition date', facts.custom[BOOTH_KEYS.dateAdded], '2020-10-05T18:22:00Z');
check('what Music.app reported', facts.custom[BOOTH_KEYS.dateAddedReported], '2025-08-25T13:37:11Z');
check('date provenance', facts.custom[BOOTH_KEYS.dateAddedOrigin], 'recovered');
check('star also carried as a Booth field', facts.custom[BOOTH_KEYS.starred], '1');
check('vetted, denormalised from the release', facts.custom[BOOTH_KEYS.vetted], '1');
check('fingerprint', facts.custom[BOOTH_KEYS.fingerprint], 'abc123');
check('discogs linkage', facts.custom[BOOTH_KEYS.discogsReleaseId], '98765');
check('rip provenance', facts.custom[BOOTH_KEYS.origin], 'vinyl');

// Absent facts must not write empty fields — an empty tag is worse than none.
check('nothing set writes nothing', toTagWrite({}), { custom: {} });
check('false flags write nothing', toTagWrite({ starred: false, vetted: false }), { custom: {} });

// The star is carried twice on purpose: the standard field is what rekordbox
// reads, the Booth field is what survives a rebuild on M4A (where the standard
// rating does not write at all).
check('both carriers present for a star', Object.keys(starred.custom), [BOOTH_KEYS.starred]);

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 3: Run it to verify it fails**

Run: `bun verify scripts/verify-tag-schema.ts`
Expected: FAIL — module `src/lib/server/library/tag_schema` does not exist.

- [ ] **Step 4: Write the implementation**

Create `src/lib/server/library/tag_schema.ts`:

```ts
/**
 * What Booth fact goes into which tag field.
 *
 * Two carriers, chosen by whether anything else can read the field:
 *
 * - **Standard frames** for facts other software consumes — tempo and comment
 *   are what rekordbox reads, so an analysed BPM belongs in the tempo field and
 *   a note in the comment, not in a Booth-private field nothing will look at.
 * - **`BOOTH_*` custom fields** for everything standard tags cannot express:
 *   acquisition date, its provenance, vetted-ness, the fingerprint, Discogs
 *   linkage, rip origin.
 *
 * A star is carried in *both*. The standard rating is what makes it visible in
 * rekordbox; the Booth field is what survives a rebuild, and is the only carrier
 * on M4A, where the rating does not write at all.
 */

/** Custom field names. Containers spell the prefix differently; the reader strips it. */
export const BOOTH_KEYS = {
  dateAdded: 'BOOTH_DATE_ADDED',
  dateAddedReported: 'BOOTH_DATE_ADDED_REPORTED',
  dateAddedOrigin: 'BOOTH_DATE_ADDED_ORIGIN',
  starred: 'BOOTH_STARRED',
  vetted: 'BOOTH_VETTED',
  fingerprint: 'BOOTH_FINGERPRINT',
  discogsReleaseId: 'BOOTH_DISCOGS_RELEASE_ID',
  origin: 'BOOTH_ORIGIN',
} as const;

/**
 * POPM byte values by star count, from taglib-wasm's own table.
 *
 * Copied deliberately rather than imported: the library ships a `RatingUtils.toPopm()`
 * helper that returns 255 for one star and 0 for two through five. The table is
 * right and the helper is not, so the table is what Booth uses.
 */
export const POPM_STAR_VALUES = [0, 1, 64, 128, 196, 255] as const;

export interface BoothTrackFacts {
  /** Effective acquisition date — recovered where the overlay supplied one. */
  dateAdded?: string;
  /** What Music.app reported, kept so a grafted date stays distinguishable. */
  dateAddedReported?: string;
  /** 'recovered' | 'reported'. */
  dateAddedOrigin?: string;
  starred?: boolean;
  /** Free-text note. Goes to the standard comment field, which rekordbox displays. */
  note?: string;
  /** Release-level flag, denormalised onto each of the release's tracks. */
  vetted?: boolean;
  /** Analysed tempo. Goes to the standard tempo field. */
  bpm?: number;
  fingerprint?: string;
  discogsReleaseId?: string;
  /** 'vinyl' for rips written by the recording feature. */
  origin?: string;
}

export interface TagWrite {
  comment?: string;
  bpm?: number;
  /** 0..5; undefined means "write no rating", which is not the same as zero stars. */
  ratingStars?: number;
  custom: Record<string, string>;
}

export function toTagWrite(facts: BoothTrackFacts): TagWrite {
  const custom: Record<string, string> = {};
  const put = (key: string, value: string | undefined) => {
    if (value !== undefined && value !== '') custom[key] = value;
  };

  put(BOOTH_KEYS.dateAdded, facts.dateAdded);
  put(BOOTH_KEYS.dateAddedReported, facts.dateAddedReported);
  put(BOOTH_KEYS.dateAddedOrigin, facts.dateAddedOrigin);
  put(BOOTH_KEYS.fingerprint, facts.fingerprint);
  put(BOOTH_KEYS.discogsReleaseId, facts.discogsReleaseId);
  put(BOOTH_KEYS.origin, facts.origin);
  // Flags are written only when true. A "0" would claim the user actively
  // un-starred something, which is a different fact from never having starred it.
  if (facts.starred) put(BOOTH_KEYS.starred, '1');
  if (facts.vetted) put(BOOTH_KEYS.vetted, '1');

  const write: TagWrite = { custom };
  if (facts.note) write.comment = facts.note;
  if (facts.bpm !== undefined) write.bpm = facts.bpm;
  if (facts.starred) write.ratingStars = 5;
  return write;
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `bun verify scripts/verify-tag-schema.ts`
Expected: PASS — 16 checks, "all checks passed".

- [ ] **Step 6: Type-check**

Run: `bun check`
Expected: `0 ERRORS 0 WARNINGS`.

- [ ] **Step 7: Commit**

```bash
git add package.json bun.lock src/lib/server/library/tag_schema.ts scripts/verify-tag-schema.ts
git commit -m "feat(library): tag schema mapping Booth facts to tag fields

Standard frames for anything another tool reads (tempo, comment,
rating), BOOTH_ custom fields for what standard tags cannot express.
Stars are carried twice: the standard rating for rekordbox, the Booth
field because M4A ratings do not write."
```

---

### Task 2: Tag writer

Composes the bulk tag write with the rating API, and refuses to produce a file whose audio has changed. The fingerprint check is the safety property that makes slice 3's pass over 50GB of irreplaceable files defensible.

**Files:**
- Create: `src/lib/server/library/tag_writer.ts`
- Create: `scripts/verify-tag-writer.ts`

**Interfaces:**
- Consumes: `toTagWrite`, `BoothTrackFacts`, `POPM_STAR_VALUES` from Task 1; `audioFingerprint` from `src/lib/server/library/fingerprint.ts`.
- Produces: `writeTags(sourcePath: string, facts: BoothTrackFacts, destPath?: string): Promise<string>` returning the fingerprint of the written file; `class TagWriteError extends Error` with `filePath: string`.

- [ ] **Step 1: Write the failing test**

Create `scripts/verify-tag-writer.ts`:

```ts
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun verify scripts/verify-tag-writer.ts`
Expected: FAIL — module `src/lib/server/library/tag_writer` does not exist.

- [ ] **Step 3: Write the implementation**

Create `src/lib/server/library/tag_writer.ts`:

```ts
/**
 * Writing Booth's facts into an audio file.
 *
 * Two passes over the buffer because the library needs both: `applyTags` handles
 * standard frames and custom fields but silently ignores a rating, while the
 * file API's `setRating` writes POPM correctly. Opening the buffer `applyTags`
 * returns chains them without a second round trip through disk.
 *
 * **The audio must not change.** The writer fingerprints the temp file against
 * its source and refuses to publish a mismatch — that assertion is what makes
 * the migration's pass over 50GB of irreplaceable files defensible. Writing to a
 * temp file and renaming means a crash mid-write leaves the original intact.
 */
import { rename, unlink } from 'node:fs/promises';
import { TagLib, applyTags } from 'taglib-wasm';
import { audioFingerprint } from './fingerprint';
import { POPM_STAR_VALUES, toTagWrite, type BoothTrackFacts } from './tag_schema';

export class TagWriteError extends Error {
  constructor(
    readonly filePath: string,
    detail: string,
  ) {
    super(`could not tag ${filePath}: ${detail}`);
    this.name = 'TagWriteError';
  }
}

let taglib: Awaited<ReturnType<typeof TagLib.initialize>> | null = null;
async function lib() {
  taglib ??= await TagLib.initialize();
  return taglib;
}

/**
 * Write `facts` into `sourcePath`, producing `destPath` (the source itself by
 * default). Returns the written file's audio fingerprint, which equals the
 * source's — that is the point.
 */
export async function writeTags(
  sourcePath: string,
  facts: BoothTrackFacts,
  destPath: string = sourcePath,
): Promise<string> {
  const before = await audioFingerprint(sourcePath).catch((e) => {
    throw new TagWriteError(sourcePath, e instanceof Error ? e.message : String(e));
  });

  const write = toTagWrite(facts);
  const tmpPath = `${destPath}.booth-tmp`;

  try {
    // Custom BOOTH_* keys sit alongside the standard ones in the same object;
    // the library routes unknown keys to TXXX / freeform atoms by container.
    const tagInput: Record<string, unknown> = { ...write.custom };
    if (write.comment !== undefined) tagInput.comment = write.comment;
    if (write.bpm !== undefined) tagInput.bpm = write.bpm;
    const tagged = await applyTags(sourcePath, tagInput as Parameters<typeof applyTags>[1]);

    let bytes = new Uint8Array(tagged);
    if (write.ratingStars !== undefined) {
      const file = await (await lib()).open(bytes);
      try {
        // POPM_STAR_VALUES, not the library's toPopm(), which returns 255 for one
        // star and 0 for the rest.
        file.setRating(POPM_STAR_VALUES[write.ratingStars]);
        file.save();
        bytes = new Uint8Array(file.getFileBuffer());
      } finally {
        file.dispose();
      }
    }

    await Bun.write(tmpPath, bytes);

    const after = await audioFingerprint(tmpPath);
    if (after !== before) {
      throw new TagWriteError(sourcePath, `audio changed during tagging (${before} → ${after})`);
    }

    await rename(tmpPath, destPath);
    return after;
  } catch (e) {
    await unlink(tmpPath).catch(() => {});
    if (e instanceof TagWriteError) throw e;
    throw new TagWriteError(sourcePath, e instanceof Error ? e.message : String(e));
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun verify scripts/verify-tag-writer.ts`
Expected: PASS — 22 checks, "all checks passed".

If `m4a: star round-trips as a Booth field` passes but the MP3 rating check fails, the star mapping is wrong — re-check that `POPM_STAR_VALUES[5]` is 255 and that `readTags` scales POPM's 0–255 to 0–100.

- [ ] **Step 5: Type-check**

Run: `bun check`
Expected: `0 ERRORS 0 WARNINGS`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/server/library/tag_writer.ts scripts/verify-tag-writer.ts
git commit -m "feat(library): atomic tag writer that cannot alter audio

Chains the bulk tag write with the rating API, writes to a temp file,
verifies the audio fingerprint against the source, and only then renames
into place. That assertion is what makes slice 3's pass over 50GB of
irreplaceable files defensible."
```

---

### Task 3: Round-trip on real library files

Synthetic tones are one encoder. This runs the writer over copies of a deterministic spread of real files — many encoders, VBR headers, embedded art — and checks every fact survives and no audio moved.

**Files:**
- Create: `scripts/probe-tag-roundtrip.ts`

**Interfaces:**
- Consumes: `writeTags` from Task 2; `readTags` from slice 1; `audioFingerprint` from slice 1.
- Produces: console report plus `$SCRATCH/tag-roundtrip.json`.

- [ ] **Step 1: Write the probe**

Create `scripts/probe-tag-roundtrip.ts`:

```ts
/**
 * probe-tag-roundtrip.ts — does the writer hold up on real files?
 *
 * verify-tag-writer proves the round trip on synthetic tones from one encoder.
 * This library is 4,355 files from many encoders, with VBR headers and embedded
 * artwork — the variety that breaks tagging libraries. Every fact written must
 * come back, and no audio may move.
 *
 * READ-ONLY against the library: each file is copied to a temp directory and
 * only the copy is tagged. Originals are opened for reading and nothing else.
 *
 * Run: bun verify scripts/probe-tag-roundtrip.ts [--limit 200] [--seed 1]
 */
import { Database } from 'bun:sqlite';
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { audioFingerprint } from '../src/lib/server/library/fingerprint';
import { parseFile } from 'music-metadata';
import { readTags } from '../src/lib/server/library/tags';
import { writeTags } from '../src/lib/server/library/tag_writer';
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

const step = Math.max(1, Math.floor(all.length / limit));
const sample = all.filter((_, i) => i % step === seed % step).slice(0, limit);

const tmp = mkdtempSync(join(tmpdir(), 'booth-roundtrip-'));

const FACTS = {
  dateAdded: '2020-10-05T18:22:00Z',
  dateAddedReported: '2025-08-25T13:37:11Z',
  dateAddedOrigin: 'recovered',
  starred: true,
  note: 'booth round-trip probe',
  bpm: 124,
};

interface Failure { path: string; reason: string }
const failures: Failure[] = [];
let ok = 0;
let missing = 0;
let ratingVisible = 0;
let artworkKept = 0;
let artworkHad = 0;

for (const [i, row] of sample.entries()) {
  if (!existsSync(row.path)) {
    missing++;
    continue;
  }
  const ext = extname(row.path) || '.bin';
  const copy = join(tmp, `c${i}${ext}`);
  const dest = join(tmp, `d${i}${ext}`);
  try {
    copyFileSync(row.path, copy);
    const before = await audioFingerprint(copy);
    const hadArt = await hasArtwork(copy).catch(() => false);
    if (hadArt) artworkHad++;

    await writeTags(copy, FACTS, dest);

    const after = await audioFingerprint(dest);
    if (after !== before) {
      failures.push({ path: row.path, reason: `audio moved ${before} → ${after}` });
      continue;
    }
    const back = await readTags(dest);
    if (back.booth.DATE_ADDED !== FACTS.dateAdded) {
      failures.push({ path: row.path, reason: 'acquisition date did not round-trip' });
      continue;
    }
    if (back.booth.STARRED !== '1') {
      failures.push({ path: row.path, reason: 'star did not round-trip' });
      continue;
    }
    if (back.comment !== FACTS.note) {
      failures.push({ path: row.path, reason: `comment did not round-trip (got ${back.comment})` });
      continue;
    }
    if (back.bpm !== FACTS.bpm) {
      failures.push({ path: row.path, reason: `tempo did not round-trip (got ${back.bpm})` });
      continue;
    }
    if (back.rating === 100) ratingVisible++;
    if (hadArt && (await hasArtwork(dest))) artworkKept++;
    ok++;
  } catch (e) {
    failures.push({ path: row.path, reason: e instanceof Error ? e.message : String(e) });
  } finally {
    rmSync(copy, { force: true });
    rmSync(dest, { force: true });
  }
  if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${sample.length}…`);
}

/** Artwork is the thing most easily lost by a careless tag rewrite. */
async function hasArtwork(path: string): Promise<boolean> {
  const m = await parseFile(path, { duration: false, skipCovers: false });
  return (m.common.picture?.length ?? 0) > 0;
}

const scratch = process.env.SCRATCH ?? tmpdir();
const report = { sampled: sample.length, ok, failures, missing, ratingVisible, artworkHad, artworkKept };
writeFileSync(join(scratch, 'tag-roundtrip.json'), JSON.stringify(report, null, 2));

console.log(`\nsampled          ${sample.length} of ${all.length}`);
console.log(`round-tripped    ${ok}`);
console.log(`FAILED           ${failures.length}`);
console.log(`missing          ${missing}`);
console.log(`rating visible   ${ratingVisible}  (standard rating survived — MP3 only, expected)`);
console.log(`artwork kept     ${artworkKept} of ${artworkHad} that had any`);
for (const f of failures.slice(0, 20)) console.log(`  ${f.reason}\n    ${f.path}`);
console.log(`\nreport: ${join(scratch, 'tag-roundtrip.json')}`);

rmSync(tmp, { recursive: true, force: true });
```

- [ ] **Step 2: Run it against real files**

Run: `SCRATCH=<scratchpad> bun verify scripts/probe-tag-roundtrip.ts --limit 200`
Expected: `FAILED 0`. Artwork kept should equal artwork had. Rating visible should be roughly the MP3 share of the sample (~96%), and the shortfall should be exactly the M4A files.

Then a second spread: `--limit 300 --seed 3`.

**`FAILED 0` is the gate for slice 3.** Any failure must be understood before a real file is written.

- [ ] **Step 3: Type-check**

Run: `bun check`
Expected: `0 ERRORS 0 WARNINGS`.

- [ ] **Step 4: Commit**

```bash
git add scripts/probe-tag-roundtrip.ts
git commit -m "feat(scripts): probe the tag writer against real library files

Copies a spread of real files, tags the copies, and checks every fact
round-trips with the audio and artwork intact. FAILED 0 is the gate for
the migration slice."
```

---

### Task 4: Dry-run report of a full tagging pass

Shows exactly what would be written to every file in the library, without writing anything. This is what gets reviewed before slice 3 touches a real file.

**Files:**
- Create: `scripts/probe-tag-plan.ts`

**Interfaces:**
- Consumes: `toTagWrite`, `BoothTrackFacts` from Task 1.
- Produces: console summary plus `$SCRATCH/tag-plan.json` — one entry per track with its path and the fields that would be written.

- [ ] **Step 1: Write the probe**

Create `scripts/probe-tag-plan.ts`:

```ts
/**
 * probe-tag-plan.ts — what a full tagging pass would write, without writing it.
 *
 * The artefact reviewed before slice 3 touches a real file. It reads every
 * Booth fact currently in the database, maps it through the tag schema, and
 * reports the shape of the write: how many files get each field, and how many
 * get nothing at all.
 *
 * READ-ONLY: opens the database read-only and touches no audio file.
 *
 * Run: bun verify scripts/probe-tag-plan.ts [--limit N]
 */
import { Database } from 'bun:sqlite';
import { writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { toTagWrite, type BoothTrackFacts } from '../src/lib/server/library/tag_schema';

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
  releaseId: string | null;
  starred: string | null;
  note: string | null;
  vetted: string | null;
}

const rows = (
  db
    .prepare(
      `SELECT t.id AS trackId, mk.key_value AS path, t.release_id AS releaseId,
              t.starred_at AS starred, t.note AS note, r.vetted_at AS vetted
         FROM match_key mk
         JOIN track t        ON t.id = mk.entity_id
         LEFT JOIN release r ON r.id = t.release_id
        WHERE mk.entity_kind='track' AND mk.key_type='file_path'`,
    )
    .all() as Row[]
).slice(0, limit === Infinity ? undefined : limit);

const facetRows = db
  .prepare(`SELECT entity_id, key, value FROM source_facets WHERE source='local' AND entity_kind='track'`)
  .all() as { entity_id: string; key: string; value: string }[];
const facets = new Map<string, Record<string, unknown>>();
for (const f of facetRows) {
  const rec = facets.get(f.entity_id) ?? {};
  rec[f.key] = JSON.parse(f.value);
  facets.set(f.entity_id, rec);
}

const discogs = new Map<string, string>();
for (const d of db
  .prepare(`SELECT entity_id, external_id FROM source_link WHERE source='discogs' AND entity_kind='release'`)
  .all() as { entity_id: string; external_id: string }[]) {
  discogs.set(d.entity_id, d.external_id);
}

const fieldCounts: Record<string, number> = {};
const plan: { path: string; fields: string[] }[] = [];
let empty = 0;

for (const row of rows) {
  const f = facets.get(row.trackId) ?? {};
  const facts: BoothTrackFacts = {
    dateAdded: typeof f.dateAdded === 'string' ? f.dateAdded : undefined,
    dateAddedReported: typeof f.dateAddedReported === 'string' ? f.dateAddedReported : undefined,
    dateAddedOrigin: typeof f.dateAddedOrigin === 'string' ? f.dateAddedOrigin : undefined,
    starred: row.starred != null,
    note: row.note ?? undefined,
    vetted: row.vetted != null,
    bpm: typeof f.bpmAnalyzed === 'number' ? f.bpmAnalyzed : undefined,
    origin: typeof f.origin === 'string' ? f.origin : undefined,
    discogsReleaseId: row.releaseId ? discogs.get(row.releaseId) : undefined,
  };
  const write = toTagWrite(facts);
  const fields = [
    ...Object.keys(write.custom),
    ...(write.comment !== undefined ? ['comment'] : []),
    ...(write.bpm !== undefined ? ['bpm'] : []),
    ...(write.ratingStars !== undefined ? ['rating'] : []),
  ];
  for (const field of fields) fieldCounts[field] = (fieldCounts[field] ?? 0) + 1;
  if (fields.length === 0) empty++;
  plan.push({ path: row.path, fields });
}

const scratch = process.env.SCRATCH ?? tmpdir();
writeFileSync(join(scratch, 'tag-plan.json'), JSON.stringify({ fieldCounts, empty, plan }, null, 2));

console.log(`\ntracks considered  ${rows.length}`);
console.log(`nothing to write   ${empty}\n`);
console.log('Fields a full pass would write:');
for (const [k, n] of Object.entries(fieldCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(28)} ${n}`);
}
console.log(`\nreport: ${join(scratch, 'tag-plan.json')}`);
```

- [ ] **Step 2: Run it**

Run: `SCRATCH=<scratchpad> bun verify scripts/probe-tag-plan.ts`
Expected: every track gets an acquisition date and its provenance; ~2,900 get a tempo; ~36 get a rating and star field; ~5 get a comment. `nothing to write` should be close to zero — a non-trivial count means facts are not reaching the schema.

- [ ] **Step 3: Type-check**

Run: `bun check`
Expected: `0 ERRORS 0 WARNINGS`.

- [ ] **Step 4: Commit**

```bash
git add scripts/probe-tag-plan.ts
git commit -m "feat(scripts): dry-run report of a full tagging pass

Reads every Booth fact, maps it through the tag schema, and reports what
would be written per field — the artefact reviewed before the migration
writes a real file."
```

---

### Task 5: Confirm what rekordbox actually reads

The premise is that tags make Booth's annotations visible in rekordbox. That cannot be asserted from code; it needs rekordbox to import a file and be looked at. This task produces the file and the procedure.

**Files:**
- Create: `scripts/make-rekordbox-sample.ts`

**Interfaces:**
- Consumes: `writeTags` from Task 2.
- Produces: a tagged sample file in the scratch directory for manual import.

- [ ] **Step 1: Write the sample generator**

Create `scripts/make-rekordbox-sample.ts`:

```ts
/**
 * make-rekordbox-sample.ts — a tagged file to import into rekordbox by hand.
 *
 * Whether rekordbox shows Booth's tempo, comment and rating cannot be asserted
 * from code — its library is SQLCipher-encrypted and it is a GUI. So this writes
 * a sample with known values and the operator looks.
 *
 * Copies a real library file; the original is never modified.
 *
 * Run: bun verify scripts/make-rekordbox-sample.ts [--out <dir>]
 */
import { Database } from 'bun:sqlite';
import { copyFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { writeTags } from '../src/lib/server/library/tag_writer';

function argStr(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const outDir = argStr('out', process.env.SCRATCH ?? tmpdir());

const dbPath = process.env.BOOTH_DB_PATH ?? join(homedir(), '.booth', 'booth.db');
const db = new Database(dbPath, { readonly: true });

for (const ext of ['.mp3', '.m4a']) {
  const row = db
    .prepare(
      `SELECT key_value AS path FROM match_key
        WHERE entity_kind='track' AND key_type='file_path' AND key_value LIKE ?
        LIMIT 1`,
    )
    .get(`%Media.localized%${ext}`) as { path: string } | undefined;
  if (!row) {
    console.log(`no ${ext} file found in the library — skipping`);
    continue;
  }
  const copy = join(outDir, `rekordbox-sample${ext}`);
  copyFileSync(row.path, copy);
  await writeTags(copy, {
    dateAdded: '2020-10-05T18:22:00Z',
    dateAddedOrigin: 'recovered',
    starred: true,
    note: 'BOOTH TEST COMMENT',
    bpm: 123,
  });
  console.log(`wrote ${copy}`);
  console.log(`  from ${row.path}`);
}

console.log(`
Import these into rekordbox (File → Import → Import Track, or drag them in) and
check, for each:

  1. Comment column shows "BOOTH TEST COMMENT"
  2. BPM shows 123 BEFORE you run rekordbox's own analysis (it overwrites it)
  3. Rating shows five stars  — expected on the MP3 only
  4. Nothing else about the track looks wrong (title, artist, artwork)

Record the answers in docs/CONTEXT.md. Point 3 failing on the M4A is the known
gap, not a bug. Point 2 failing on BOTH would mean the tempo field is not a
usable channel and the schema needs revisiting.

Delete the samples from rekordbox afterwards — they are copies, not your library.
`);
```

- [ ] **Step 2: Generate the samples and check them by hand**

Run: `SCRATCH=<scratchpad> bun verify scripts/make-rekordbox-sample.ts`

Then follow the printed instructions in rekordbox. This step is complete when the four questions have answers.

- [ ] **Step 3: Type-check and commit**

Run: `bun check`

```bash
git add scripts/make-rekordbox-sample.ts
git commit -m "feat(scripts): generate a tagged sample for manual rekordbox checks

Whether rekordbox reads Booth's tempo, comment and rating cannot be
asserted from code — its library is encrypted and it is a GUI. This
produces the file and the procedure."
```

---

### Task 6: Record the findings

**Files:**
- Modify: `docs/CONTEXT.md` (after the slice 1 fingerprints section)

- [ ] **Step 1: Write the findings into the context doc**

Add a subsection covering, with real numbers from the runs:

- The tag schema: which facts take standard frames and which take `BOOTH_*` fields, and *why* the split is "can anything else read it".
- Why a star is carried twice, and that the standard rating does not write on M4A (175 files, 4% of the library) — so those stars are invisible to rekordbox but survive a Booth rebuild.
- That `taglib-wasm` is the writer, and that `RatingUtils.toPopm()` is broken (255 for one star, 0 for two through five) so the `POPM_STAR_VALUES` table is used directly.
- That ratings need the file API and are ignored by the bulk write, hence the two-pass writer.
- The round-trip results from Task 3: sample size, failures, artwork retention.
- The dry-run shape from Task 4: how many files get each field.
- The answers to the four rekordbox questions from Task 5.

- [ ] **Step 2: Commit**

```bash
git add docs/CONTEXT.md
git commit -m "docs: record slice 2 findings on the tag schema and writer"
```

---

## Done when

- `verify-tag-schema`, `verify-tag-writer` pass; `verify-fingerprint` and `verify-tags` from slice 1 still pass.
- `probe-tag-roundtrip` reports **FAILED 0** across at least two spreads of real files, with artwork retention at 100%.
- `probe-tag-plan` has been run and its output reviewed — this is the artefact that authorises slice 3.
- The four rekordbox questions have answers recorded in `docs/CONTEXT.md`.
- `bun check` reports 0 errors.
- No file under `~/Music` has been modified.
