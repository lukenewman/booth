# Vinyl Recording & Track Splitting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record a vinyl release from an audio interface into Booth, split per-side takes into per-track regions (hybrid silence+duration matcher), review/adjust, and save trimmed 24-bit WAVs that play through the existing `Playable` path.

**Architecture:** Three slices. (A) Merge the `itunes` source into a renamed `local` source with an origin-scoped prune so Apple re-syncs never delete vinyl rips. (B) Server recording stack: WAV writer/reader, RMS-envelope splitter, in-order matcher, session lifecycle, REST endpoints. (C) Client: AudioWorklet capture with live input preview, recorder store, RecordSession + ReviewSplits UI, entry button on ReleaseDetail.

**Tech Stack:** SvelteKit 2 + Svelte 5 runes, bun:sqlite, AudioWorklet/WebAudio, no new dependencies. Spec: `docs/superpowers/specs/2026-06-10-vinyl-recording-design.md`.

**Verification:** `bun verify scripts/<name>.ts` (bun runs TS natively), `bun run check` for types. No test framework — verify scripts assert with non-zero exit on failure.

---

## Slice A — `itunes` → `local` source merge

### Task 1: DB migration renaming the source id

**Files:**
- Create: `src/lib/server/db/migrations/006_local_source.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Merge the iTunes source into the renamed 'local' source. Apple Music
-- imports and vinyl rips are two ingest paths of one local-files source.
UPDATE source_link   SET source='local' WHERE source='itunes';
UPDATE source_facets SET source='local' WHERE source='itunes';
UPDATE source_state  SET source='local' WHERE source='itunes';
UPDATE sync_run      SET source='local' WHERE source='itunes';
```

- [ ] **Step 2: Verify migration applies on a scratch DB**

Run: `BOOTH_DB_PATH=/tmp/booth-mig-test.db bun -e "import { getDb } from './src/lib/server/db/index.ts'; getDb(); console.log('migrated ok')"` — but `$env/dynamic/private` only resolves inside Vite. Instead verify via the dev server in Task 4's script (which uses a scratch DB through `bun:sqlite` directly). For now just confirm the file is picked up by reading `migrate.ts` ordering (lexicographic, `006_` sorts after `005_`).

- [ ] **Step 3: Commit**

```bash
git add src/lib/server/db/migrations/006_local_source.sql
git commit -m "feat(local): migration renaming itunes source rows to local"
```

### Task 2: Rename the adapter and every `'itunes'` reference

**Files:**
- Rename dir: `src/lib/server/sources/itunes/` → `src/lib/server/sources/local/`
- Modify: `src/lib/server/sources/local/index.ts`, `src/lib/server/sources/registry.ts`, `src/hooks.server.ts`, `src/lib/server/sources/discogs/hydrateDiscogsTracks.ts`, `src/lib/components/SourceGrid.svelte`, `src/app.css`, plus every component matching `grep -rln "itunes" src/lib/components src/lib/stores src/routes`

- [ ] **Step 1: Move the directory**

```bash
git mv src/lib/server/sources/itunes src/lib/server/sources/local
```

- [ ] **Step 2: Update the adapter identity** (`src/lib/server/sources/local/index.ts`)

```ts
// rename export itunesSource → localSource; id/name change; add wav/aiff mime
export const localSource: MusicSource & Playable = {
  id: 'local',
  name: 'Local',
  contributes: ['track', 'release'],
  sync: syncITunesLibrary, // Apple Music XML remains the only *sync* ingest path
  async resolveTrackStream(entityId: string, db: Database) {
    /* unchanged body */
  },
};
```

In `mimeFromPath`, add a case before `default`: `case 'wav': return 'audio/wav';` (rips are WAV — without this they stream as octet-stream).

- [ ] **Step 3: Update registry** (`src/lib/server/sources/registry.ts`)

```ts
import { localSource } from './local';
registerSource(localSource);
```

(replacing the `itunesSource` import/registration; keep registration order: discogs, local, rekordbox, plex).

- [ ] **Step 4: Update boot gating** (`src/hooks.server.ts`)

```ts
if (source.id === 'local' && !env.ITUNES_XML_PATH) continue;
```

(`ITUNES_XML_PATH` keeps its name — it genuinely points at Apple's XML.)

- [ ] **Step 5: Update hydration merge lookup** (`hydrateDiscogsTracks.ts`)

The "direct iTunes entity lookup" queries `sl.source='itunes'` — change to `sl.source='local'`. Update the comment to say "local (Apple-origin)".

- [ ] **Step 6: Mechanical rename in UI**

`grep -rn "itunes" src/lib/components src/lib/stores src/routes src/app.css` and replace the string `itunes` → `local` (slot ids, facet-source comparisons, CSS classes) and visible labels `iTunes` → `Local`. In `SourceGrid.svelte` the slot becomes `{ id: 'local', cls: 'local' }` and the style rule `.slot.on.local { background: var(--src-local); … }`. In `app.css` rename the token `--src-itunes` → `--src-local` (same color value). The grid stays 4 dots — the `i` slot becomes `L` per the spec.

- [ ] **Step 7: Type-check and grep clean**

Run: `bun run check` → 0 errors. Run: `grep -rn "'itunes'" src/` → only allowed remnants are none; `ITUNES_XML_PATH` and the `syncITunesLibrary`/`parseITunesLibrary` function names may remain (they describe Apple's format, not the source id).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(local): rename itunes source to local across adapter, registry, UI"
```

### Task 3: Recordings root + origin-scoped prune safety

**Files:**
- Create: `src/lib/server/recording/paths.ts`
- Modify: `src/lib/server/library/collate.ts` (pruneSource call sites)

- [ ] **Step 1: Write `paths.ts`**

```ts
import { homedir } from 'node:os';
import { join } from 'node:path';
import { env } from '$env/dynamic/private';

export function recordingsRoot(): string {
  return env.BOOTH_RECORDINGS_PATH || join(homedir(), '.booth', 'recordings');
}

export function sessionTmpDir(sessionId: string): string {
  return join(recordingsRoot(), '.tmp', sessionId);
}

/** Strip characters that are unsafe in filenames; collapse whitespace. */
export function sanitizeName(s: string): string {
  return s.replace(/[/\\:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
}

export function releaseDir(artist: string, album: string, catno: string | null): string {
  const label = catno ? `${album} [${catno}]` : album;
  return join(recordingsRoot(), sanitizeName(`${artist} — ${label}`));
}
```

- [ ] **Step 2: Scope the local prune in `collate.ts`**

The Apple XML re-sync must never delete vinyl rips (they're absent from the XML; their `external_id` is an absolute path under the recordings root). In `collate()`, where `pruneSource` is called, pass an exclusion predicate; add the parameter to `pruneSource`:

```ts
import { recordingsRoot } from '../recording/paths';

// in collate(), replace the two prune calls:
const isVinylRip = (externalId: string) =>
  sourceId === 'local' && externalId.startsWith(recordingsRoot());
if (result.releases.length > 0) {
  summary.releasesDeleted = pruneSource(db, 'release', sourceId, externalIds, isVinylRip);
}
if (result.tracks.length > 0) {
  summary.tracksDeleted = pruneSource(db, 'track', sourceId, externalIds, isVinylRip);
}

// pruneSource signature + loop guard:
function pruneSource(
  db: Database,
  kind: EntityKind,
  sourceId: string,
  keepExternalIds: Set<string>,
  keepPredicate?: (externalId: string) => boolean,
): number {
  // ... inside the loop, first line becomes:
  //   if (keepExternalIds.has(row.external_id)) continue;
  //   if (keepPredicate?.(row.external_id)) continue;
}
```

- [ ] **Step 3: Type-check** — `bun run check` → 0 errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/server/recording/paths.ts src/lib/server/library/collate.ts
git commit -m "feat(local): recordings root + origin-scoped prune (re-sync never deletes rips)"
```

### Task 4: verify-local-merge script

**Files:**
- Create: `scripts/verify-local-merge.ts`

- [ ] **Step 1: Write the script** (scratch DB via `bun:sqlite` directly; mirrors `scripts/verify-collate.ts` style — check that file for the schema-bootstrap helper it uses and reuse the same approach)

```ts
// scripts/verify-local-merge.ts
// 1. Bootstrap scratch DB with migrations 001–005, insert itunes-sourced rows,
//    apply 006, assert all four tables now say 'local'.
// 2. Simulate an Apple re-sync prune: a vinyl-origin source_link
//    (external_id under a fake recordings root) must survive a collate()
//    whose SyncResult omits it; an Apple-origin row absent from the sync
//    must be pruned.
import { Database } from 'bun:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIG = 'src/lib/server/db/migrations';
function freshDb(throughMigration: string): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const f of readdirSync(MIG).sort()) {
    if (f > throughMigration) break;
    db.exec(readFileSync(join(MIG, f), 'utf8'));
  }
  return db;
}

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error('FAIL:', msg); failures++; }
  else console.log('ok:', msg);
}

// --- migration rename ---
{
  const db = freshDb('005_cover_art.sql');
  db.prepare(`INSERT INTO artist (id, name) VALUES ('a1','X')`).run();
  db.prepare(`INSERT INTO track (id, title, artist_id) VALUES ('t1','T','a1')`).run();
  db.prepare(`INSERT INTO source_link (entity_kind, entity_id, source, external_id, match_method)
              VALUES ('track','t1','itunes','123','file_path')`).run();
  db.prepare(`INSERT INTO source_facets (entity_kind, entity_id, source, key, value)
              VALUES ('track','t1','itunes','rating','"5"')`).run();
  db.prepare(`INSERT INTO source_state (source, last_synced_at) VALUES ('itunes','now')`).run();
  db.prepare(`INSERT INTO sync_run (id, source) VALUES ('r1','itunes')`).run();
  db.exec(readFileSync(join(MIG, '006_local_source.sql'), 'utf8'));
  for (const t of ['source_link', 'source_facets', 'source_state', 'sync_run']) {
    const n = (db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE source='itunes'`).get() as { n: number }).n;
    assert(n === 0, `${t} has no itunes rows after 006`);
    const m = (db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE source='local'`).get() as { n: number }).n;
    assert(m >= 1, `${t} has local rows after 006`);
  }
}

// --- prune scoping ---
// collate imports $env/dynamic/private via paths.ts, which doesn't resolve
// under plain bun. Set the env var FIRST and import dynamically after
// stubbing: paths.ts reads env at call time, so process.env works when run
// through bun only if $env/dynamic/private maps to process.env — it does NOT
// outside Vite. So this script tests pruneSource indirectly: replicate the
// predicate inline and assert collate's behavior through a thin wrapper is
// NOT possible outside Vite. Instead, assert the predicate logic itself:
{
  const ROOT = '/fake/recordings';
  const isVinylRip = (sourceId: string, externalId: string) =>
    sourceId === 'local' && externalId.startsWith(ROOT);
  assert(isVinylRip('local', `${ROOT}/A — B/01 t.wav`), 'rip path excluded from prune');
  assert(!isVinylRip('local', '/Users/x/Music/Music/Media/song.m4a'), 'apple path prunable');
  assert(!isVinylRip('discogs', `${ROOT}/A — B/01 t.wav`), 'other sources unaffected');
}

if (failures > 0) process.exit(1);
console.log('verify-local-merge: all passed');
```

> **Note for implementer:** `collate.ts` cannot be imported under plain `bun` because `paths.ts` imports `$env/dynamic/private`. Fix: make `paths.ts` tolerate it — `import { env } from '$env/dynamic/private'` breaks; instead use a lazy try/catch fallback to `process.env`:
>
> ```ts
> // paths.ts — replace the $env import with:
> function privateEnv(): Record<string, string | undefined> {
>   try {
>     // eslint-disable-next-line @typescript-eslint/no-require-imports
>     return process.env;
>   } catch { return {}; }
> }
> export function recordingsRoot(): string {
>   return privateEnv().BOOTH_RECORDINGS_PATH || join(homedir(), '.booth', 'recordings');
> }
> ```
>
> SvelteKit populates `process.env` from `.env` in dev via Vite's loadEnv only for `$env`; **but** `recording/paths.ts` is also imported by server routes. Booth's CONTEXT.md warns `process.env` isn't auto-populated by Vite. Resolution: read `BOOTH_RECORDINGS_PATH` via `$env/dynamic/private` **in the route/session layer** and pass it down, keeping `paths.ts` pure: `recordingsRoot(envOverride?: string)`. Implement it that way: every function takes the resolved root as its first argument, and a tiny `src/lib/server/recording/env.ts` (which CAN import `$env/dynamic/private`) exposes `resolvedRecordingsRoot()` for routes. Verify scripts then test `paths.ts` purely. Apply the same shape to the `collate.ts` predicate: `collate(db, sourceId, result, opts?: { recordingsRoot?: string })`, with the one route-facing caller (`sync_run.ts`) passing `resolvedRecordingsRoot()`.

- [ ] **Step 2: Run it**

Run: `bun verify scripts/verify-local-merge.ts`
Expected: `verify-local-merge: all passed`, exit 0.

- [ ] **Step 3: Manual end-to-end sanity on the real DB**

Start `bun dev`, let boot sync run, then: `sqlite3 ~/.booth/booth.db "SELECT source, COUNT(*) FROM source_link GROUP BY source"` → `local` rows present, zero `itunes`. Confirm a local track still plays in the UI (streaming regression check).

- [ ] **Step 4: Commit**

```bash
git add scripts/verify-local-merge.ts src/lib/server/recording src/lib/server/library/collate.ts src/lib/server/library/sync_run.ts
git commit -m "test(local): verify migration + origin-scoped prune; pure paths module"
```

---

## Slice B — Recording backend

### Task 5: WAV writer/reader/extractor

**Files:**
- Create: `src/lib/server/recording/wav.ts`
- Create: `scripts/verify-wav.ts`

- [ ] **Step 1: Write the failing verify script** (round-trip + region extraction)

```ts
// scripts/verify-wav.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createWav, appendFloat32, finalizeWav, readWavMeta,
  extractRegionToFile, scanWav,
} from '../src/lib/server/recording/wav';

let failures = 0;
const assert = (c: boolean, m: string) => { if (!c) { console.error('FAIL:', m); failures++; } else console.log('ok:', m); };

const dir = mkdtempSync(join(tmpdir(), 'booth-wav-'));
const p = join(dir, 'take.wav');
const SR = 48000;

// 1s of 440Hz sine, stereo interleaved float32
const frames = SR;
const inter = new Float32Array(frames * 2);
for (let i = 0; i < frames; i++) {
  const v = Math.sin((2 * Math.PI * 440 * i) / SR) * 0.5;
  inter[2 * i] = v; inter[2 * i + 1] = v;
}

createWav(p, SR, 2);
appendFloat32(p, inter.subarray(0, frames));        // first half-second (frames/2 frames)
appendFloat32(p, inter.subarray(frames));           // second half
finalizeWav(p);

const meta = readWavMeta(p);
assert(meta.sampleRate === SR, 'sample rate preserved');
assert(meta.channels === 2, 'channels preserved');
assert(meta.bitDepth === 24, '24-bit');
assert(meta.frames === frames, `frame count exact (${meta.frames} vs ${frames})`);

// scanWav: envelope + peaks in one pass
const scan = scanWav(p, 50);
assert(Math.abs(scan.durationMs - 1000) < 2, 'duration ~1000ms');
assert(scan.rms.length === Math.ceil(1000 / 50), 'one rms bucket per hop');
// sine at 0.5 amplitude → rms ≈ 0.3535
assert(Math.abs(scan.rms[5] - 0.3535) < 0.02, `mid-take rms ≈ 0.3535 (got ${scan.rms[5]})`);
assert(scan.peaks[5] > 0.45 && scan.peaks[5] <= 0.51, 'peak ≈ 0.5');

// region extraction: 250ms..750ms → 500ms file, sample-exact
const rp = join(dir, 'region.wav');
extractRegionToFile(p, rp, 250, 750);
const rmeta = readWavMeta(rp);
assert(rmeta.frames === SR / 2, `region frame count exact (${rmeta.frames})`);
assert(rmeta.sampleRate === SR, 'region keeps sample rate');

rmSync(dir, { recursive: true, force: true });
if (failures > 0) process.exit(1);
console.log('verify-wav: all passed');
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun verify scripts/verify-wav.ts`
Expected: FAIL — module `wav.ts` not found.

- [ ] **Step 3: Implement `wav.ts`**

```ts
import { openSync, writeSync, closeSync, readSync, statSync, fstatSync } from 'node:fs';

const HEADER_BYTES = 44;
const BYTES_PER_SAMPLE = 3; // 24-bit

export interface WavMeta {
  sampleRate: number;
  channels: number;
  bitDepth: number;
  dataOffset: number;
  dataBytes: number;
  frames: number;
  durationMs: number;
}

/** Write a 44-byte canonical PCM WAV header with zeroed sizes (patched on finalize). */
export function createWav(path: string, sampleRate: number, channels: number): void {
  const h = Buffer.alloc(HEADER_BYTES);
  h.write('RIFF', 0); h.writeUInt32LE(0, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);                         // PCM
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * channels * BYTES_PER_SAMPLE, 28); // byte rate
  h.writeUInt16LE(channels * BYTES_PER_SAMPLE, 32);              // block align
  h.writeUInt16LE(24, 34);                        // bits per sample
  h.write('data', 36); h.writeUInt32LE(0, 40);
  const fd = openSync(path, 'w');
  writeSync(fd, h);
  closeSync(fd);
}

/** Append interleaved float32 samples as 24-bit LE PCM. */
export function appendFloat32(path: string, samples: Float32Array): void {
  const out = Buffer.alloc(samples.length * BYTES_PER_SAMPLE);
  for (let i = 0; i < samples.length; i++) {
    let v = samples[i];
    if (v > 1) v = 1; else if (v < -1) v = -1;
    let n = Math.round(v * 8388607);
    if (n < 0) n += 0x1000000; // two's complement in 24 bits
    out[i * 3] = n & 0xff;
    out[i * 3 + 1] = (n >> 8) & 0xff;
    out[i * 3 + 2] = (n >> 16) & 0xff;
  }
  const fd = openSync(path, 'a');
  writeSync(fd, out);
  closeSync(fd);
}

/** Patch RIFF/data sizes from the actual file size. */
export function finalizeWav(path: string): void {
  const size = statSync(path).size;
  const fd = openSync(path, 'r+');
  const b4 = Buffer.alloc(4);
  b4.writeUInt32LE(size - 8, 0); writeSync(fd, b4, 0, 4, 4);
  b4.writeUInt32LE(size - HEADER_BYTES, 0); writeSync(fd, b4, 0, 4, 40);
  closeSync(fd);
}

export function readWavMeta(path: string): WavMeta {
  const fd = openSync(path, 'r');
  const h = Buffer.alloc(HEADER_BYTES);
  readSync(fd, h, 0, HEADER_BYTES, 0);
  const fileSize = fstatSync(fd).size;
  closeSync(fd);
  if (h.toString('ascii', 0, 4) !== 'RIFF' || h.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`not a WAV file: ${path}`);
  }
  const channels = h.readUInt16LE(22);
  const sampleRate = h.readUInt32LE(24);
  const bitDepth = h.readUInt16LE(34);
  // Trust actual file size over the header field (robust to unfinalized files).
  const dataBytes = fileSize - HEADER_BYTES;
  const frames = Math.floor(dataBytes / (channels * (bitDepth / 8)));
  return {
    sampleRate, channels, bitDepth,
    dataOffset: HEADER_BYTES, dataBytes, frames,
    durationMs: (frames / sampleRate) * 1000,
  };
}

export interface WavScan {
  rms: Float32Array;    // mono-mixed RMS per hop, 0..1
  peaks: Float32Array;  // max |sample| per hop, 0..1
  hopMs: number;
  durationMs: number;
}

/** One chunked pass over the data: per-hop RMS + peak. ~1MB read buffer. */
export function scanWav(path: string, hopMs: number): WavScan {
  const meta = readWavMeta(path);
  const framesPerHop = Math.max(1, Math.round((meta.sampleRate * hopMs) / 1000));
  const hopCount = Math.ceil(meta.frames / framesPerHop);
  const rms = new Float32Array(hopCount);
  const peaks = new Float32Array(hopCount);

  const fd = openSync(path, 'r');
  const CHUNK_FRAMES = 65536;
  const buf = Buffer.alloc(CHUNK_FRAMES * meta.channels * BYTES_PER_SAMPLE);
  let frame = 0, offset = meta.dataOffset;
  let acc = 0, accN = 0, peak = 0, hop = 0;
  while (frame < meta.frames) {
    const want = Math.min(CHUNK_FRAMES, meta.frames - frame) * meta.channels * BYTES_PER_SAMPLE;
    const got = readSync(fd, buf, 0, want, offset);
    if (got <= 0) break;
    offset += got;
    const gotFrames = Math.floor(got / (meta.channels * BYTES_PER_SAMPLE));
    for (let f = 0; f < gotFrames; f++) {
      let mono = 0;
      for (let c = 0; c < meta.channels; c++) {
        const o = (f * meta.channels + c) * 3;
        let n = buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16);
        if (n & 0x800000) n -= 0x1000000;
        mono += n / 8388607;
      }
      mono /= meta.channels;
      acc += mono * mono; accN++;
      const a = Math.abs(mono);
      if (a > peak) peak = a;
      if (accN === framesPerHop) {
        rms[hop] = Math.sqrt(acc / accN); peaks[hop] = peak;
        hop++; acc = 0; accN = 0; peak = 0;
      }
    }
    frame += gotFrames;
  }
  if (accN > 0 && hop < hopCount) { rms[hop] = Math.sqrt(acc / accN); peaks[hop] = peak; }
  closeSync(fd);
  return { rms, peaks, hopMs, durationMs: meta.durationMs };
}

/** Copy a [startMs, endMs) region into a new standalone WAV, sample-exact. */
export function extractRegionToFile(srcPath: string, destPath: string, startMs: number, endMs: number): void {
  const meta = readWavMeta(srcPath);
  const startFrame = Math.max(0, Math.round((startMs / 1000) * meta.sampleRate));
  const endFrame = Math.min(meta.frames, Math.round((endMs / 1000) * meta.sampleRate));
  const bytesPerFrame = meta.channels * BYTES_PER_SAMPLE;

  createWav(destPath, meta.sampleRate, meta.channels);
  const src = openSync(srcPath, 'r');
  const dst = openSync(destPath, 'a');
  const CHUNK = 1 << 20;
  let pos = meta.dataOffset + startFrame * bytesPerFrame;
  let remaining = (endFrame - startFrame) * bytesPerFrame;
  const buf = Buffer.alloc(CHUNK);
  while (remaining > 0) {
    const got = readSync(src, buf, 0, Math.min(CHUNK, remaining), pos);
    if (got <= 0) break;
    writeSync(dst, buf, 0, got);
    pos += got; remaining -= got;
  }
  closeSync(src); closeSync(dst);
  finalizeWav(destPath);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun verify scripts/verify-wav.ts`
Expected: `verify-wav: all passed`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/recording/wav.ts scripts/verify-wav.ts
git commit -m "feat(recording): 24-bit WAV writer/reader, scan pass, region extraction"
```

### Task 6: Splitter + matcher

**Files:**
- Create: `src/lib/server/recording/splitter.ts`
- Create: `src/lib/server/recording/matcher.ts`
- Create: `scripts/verify-splitter.ts`

Pure functions only — no fs, no DB, no `$env`. Shared types live in `matcher.ts`.

- [ ] **Step 1: Write the failing verify script**

```ts
// scripts/verify-splitter.ts
import { findGaps, type Gap } from '../src/lib/server/recording/splitter';
import { proposeRegions, type ExpectedTrack } from '../src/lib/server/recording/matcher';

let failures = 0;
const assert = (c: boolean, m: string) => { if (!c) { console.error('FAIL:', m); failures++; } else console.log('ok:', m); };

const HOP = 50;
/** Build an envelope: segments of [durationMs, level] pairs. */
function env(segments: [number, number][]): Float32Array {
  const out: number[] = [];
  for (const [ms, level] of segments) for (let i = 0; i < ms / HOP; i++) out.push(level);
  return new Float32Array(out);
}
const t = (id: string, title: string, durationMs: number | null, pos: string, dpos: string | null): ExpectedTrack =>
  ({ trackId: id, title, durationMs, position: pos, discogsPosition: dpos, side: dpos ? dpos.replace(/[0-9.\- ]+$/, '') : null });

// --- Case 1: clean gaps, durations present → snap, all confident ---
{
  // lead-in 1s, A1 3:54, gap 2s, A2 5:30, run-out 2s   (level 0.3 music, 0.004 noise)
  const e = env([[1000, .004], [234000, .3], [2000, .004], [330000, .3], [2000, .004]]);
  const gaps = findGaps(e, HOP);
  assert(gaps.length >= 1, `interior gap found (got ${gaps.length})`);
  const expected = [t('a1', 'Can You Feel It', 234000, '1', 'A1'), t('a2', 'Washing Machine', 330000, '2', 'A2')];
  const prop = proposeRegions(e, HOP, [expected]);
  const assigned = prop.regions.filter(r => r.trackId);
  assert(assigned.length === 2, `2 assigned regions (got ${assigned.length})`);
  assert(assigned[0].trackId === 'a1' && assigned[1].trackId === 'a2', 'in-order assignment');
  assert(Math.abs((assigned[0].endMs - assigned[0].startMs) - 234000) < 3000, 'A1 duration within 3s');
  assert(assigned[0].startMs <= 1000 && assigned[0].startMs >= 0, 'lead-in trimmed');
  assert(assigned.every(r => r.confidence > 0.7), 'high confidence with duration snap');
}

// --- Case 2: durations missing → count-constrained gap pick ---
{
  const e = env([[500, .004], [180000, .3], [1500, .004], [240000, .3], [1000, .004], [200000, .3], [500, .004]]);
  const expected = [t('b1', 'B1', null, '1', 'B1'), t('b2', 'B2', null, '2', 'B2'), t('b3', 'B3', null, '3', 'B3')];
  const prop = proposeRegions(e, HOP, [expected]);
  const assigned = prop.regions.filter(r => r.trackId);
  assert(assigned.length === 3, `3 regions from 2 strongest gaps (got ${assigned.length})`);
  assert(assigned.every(r => r.confidence <= 0.7), 'durations-missing flagged lower confidence');
}

// --- Case 3: gapless / beat-mixed, no durations → single region, low confidence ---
{
  const e = env([[600000, .3]]);
  const expected = [t('c1', 'C1', null, '1', null), t('c2', 'C2', null, '2', null)];
  const prop = proposeRegions(e, HOP, [expected]);
  assert(prop.regions.length === 1, 'one region spanning the take');
  assert(prop.regions[0].confidence < 0.3, 'flagged for manual splitting');
}

// --- Case 4: side choice — take matches side B block better than A ---
{
  const sideA = [t('a1', 'A1', 234000, '1', 'A1'), t('a2', 'A2', 330000, '2', 'A2')];
  const sideB = [t('b1', 'B1', 180000, '3', 'B1'), t('b2', 'B2', 200000, '4', 'B2')];
  const e = env([[500, .004], [180000, .3], [1500, .004], [200000, .3], [500, .004]]);
  const prop = proposeRegions(e, HOP, [sideA, sideB]);
  assert(prop.regions.filter(r => r.trackId)[0]?.trackId === 'b1', `side B chosen (got ${prop.regions[0]?.trackId})`);
}

// --- Case 5: more gaps than needed (quiet passage) → duration snap survives ---
{
  // A1 3:54 with a fake 600ms quiet dip in the middle, real 2s gap, A2 5:30
  const e = env([[100000, .3], [600, .004], [133400, .3], [2000, .004], [330000, .3]]);
  const expected = [t('a1', 'A1', 234000, '1', 'A1'), t('a2', 'A2', 330000, '2', 'A2')];
  const prop = proposeRegions(e, HOP, [expected]);
  const assigned = prop.regions.filter(r => r.trackId);
  assert(assigned.length === 2, 'quiet dip not chosen as boundary');
  assert(Math.abs(assigned[0].endMs - 236000) < 4000, `boundary at the real gap (got ${assigned[0].endMs})`);
}

if (failures > 0) process.exit(1);
console.log('verify-splitter: all passed');
```

- [ ] **Step 2: Run to verify failure** — `bun verify scripts/verify-splitter.ts` → module not found.

- [ ] **Step 3: Implement `splitter.ts`**

```ts
/** Tunables (spec §Splitter): all named constants here. */
export const MIN_GAP_MS = 500;        // a gap must persist at least this long
export const NOISE_PERCENTILE = 0.06; // take's own noise level = 6th percentile RMS
export const GAP_THRESHOLD_RATIO = 4; // gap = RMS below noise*ratio
export const PAD_MS = 150;            // keep-margin around region edges
export const SNAP_WINDOW_MS = 45000;  // duration-predicted boundary searches ±45s

export interface Gap {
  startMs: number;
  endMs: number;
  /** Strength: duration × quietness; higher = more likely a real inter-track gap. */
  score: number;
}

export function noiseThreshold(rms: Float32Array): number {
  const sorted = Array.from(rms).sort((a, b) => a - b);
  const noise = sorted[Math.floor(sorted.length * NOISE_PERCENTILE)] ?? 0;
  // Floor at a tiny absolute value so digital silence doesn't make threshold 0.
  return Math.max(noise * GAP_THRESHOLD_RATIO, 0.0005);
}

/** Maximal runs of RMS below the relative noise threshold, ≥ MIN_GAP_MS. */
export function findGaps(rms: Float32Array, hopMs: number): Gap[] {
  const threshold = noiseThreshold(rms);
  const gaps: Gap[] = [];
  let runStart = -1, runSum = 0;
  const flush = (endIdx: number) => {
    if (runStart < 0) return;
    const durMs = (endIdx - runStart) * hopMs;
    if (durMs >= MIN_GAP_MS) {
      const avg = runSum / (endIdx - runStart);
      gaps.push({
        startMs: runStart * hopMs,
        endMs: endIdx * hopMs,
        score: durMs * (threshold / Math.max(avg, 1e-6)),
      });
    }
    runStart = -1; runSum = 0;
  };
  for (let i = 0; i < rms.length; i++) {
    if (rms[i] < threshold) {
      if (runStart < 0) runStart = i;
      runSum += rms[i];
    } else flush(i);
  }
  flush(rms.length);
  return gaps;
}

/** First/last hop where the signal is above threshold → audio extent of the take. */
export function audioExtent(rms: Float32Array, hopMs: number): { startMs: number; endMs: number } {
  const threshold = noiseThreshold(rms);
  let first = 0, last = rms.length - 1;
  while (first < rms.length && rms[first] < threshold) first++;
  while (last > first && rms[last] < threshold) last--;
  return { startMs: first * hopMs, endMs: (last + 1) * hopMs };
}
```

- [ ] **Step 4: Implement `matcher.ts`**

```ts
import {
  findGaps, audioExtent, PAD_MS, SNAP_WINDOW_MS, type Gap,
} from './splitter';

export interface ExpectedTrack {
  trackId: string;
  title: string;
  durationMs: number | null;
  position: string;               // sequential "1","2",…
  discogsPosition: string | null; // "A1","B2",… (facet)
  side: string | null;            // "A","B",… parsed from discogsPosition
}

export interface Region {
  startMs: number;
  endMs: number;
  trackId: string | null; // null = leftover/unassigned
  confidence: number;     // 0..1
}

export interface TakeProposal {
  regions: Region[];
  sideGuess: string | null;
}

/**
 * Propose regions for a take against candidate track blocks (one block per
 * side; a single block when positions carry no side letters). Picks the
 * best-fitting block (vinyl plays a side in order).
 */
export function proposeRegions(
  rms: Float32Array,
  hopMs: number,
  candidateBlocks: ExpectedTrack[][],
): TakeProposal {
  const gaps = findGaps(rms, hopMs);
  const extent = audioExtent(rms, hopMs);
  let best: { cost: number; proposal: TakeProposal } | null = null;
  for (const block of candidateBlocks) {
    if (block.length === 0) continue;
    const { cost, regions } = alignBlock(extent, gaps, block);
    if (!best || cost < best.cost) {
      best = { cost, proposal: { regions, sideGuess: block[0].side } };
    }
  }
  return best?.proposal ?? { regions: [{ ...extent, trackId: null, confidence: 0 }], sideGuess: null };
}

function alignBlock(
  extent: { startMs: number; endMs: number },
  gaps: Gap[],
  tracks: ExpectedTrack[],
): { cost: number; regions: Region[] } {
  const N = tracks.length;
  const takeMs = extent.endMs - extent.startMs;
  // Interior gaps only (within the audio extent).
  const interior = gaps.filter((g) => g.startMs > extent.startMs && g.endMs < extent.endMs);

  if (N === 1) {
    return {
      cost: durCost(takeMs, tracks[0].durationMs),
      regions: [{ startMs: pad(extent.startMs, -1, extent), endMs: pad(extent.endMs, 1, extent), trackId: tracks[0].trackId, confidence: tracks[0].durationMs ? snapConf(takeMs, tracks[0].durationMs) : 0.5 }],
    };
  }

  const haveDurations = tracks.every((t) => t.durationMs != null);

  let boundaries: { gap: Gap | null; atMs: number; confidence: number }[];

  if (haveDurations) {
    // DP over (gap choice × boundary index) minimizing Σ|clipDur − expectedDur|.
    boundaries = dpSnap(extent, interior, tracks as (ExpectedTrack & { durationMs: number })[]);
  } else if (interior.length >= N - 1) {
    // Count-constrained: N−1 strongest gaps, in time order. Lower confidence.
    const chosen = [...interior].sort((a, b) => b.score - a.score).slice(0, N - 1)
      .sort((a, b) => a.startMs - b.startMs);
    const maxScore = Math.max(...chosen.map((g) => g.score));
    boundaries = chosen.map((g) => ({ gap: g, atMs: (g.startMs + g.endMs) / 2, confidence: Math.min(0.7, 0.4 + 0.3 * (g.score / maxScore)) }));
  } else if (interior.length > 0) {
    // Fewer gaps than needed: use them all; remaining splits left to the user.
    boundaries = interior.map((g) => ({ gap: g, atMs: (g.startMs + g.endMs) / 2, confidence: 0.3 }));
  } else {
    // Beat-mixed, nothing inferable → one region spanning the side.
    return {
      cost: Number.MAX_SAFE_INTEGER / 2,
      regions: [{ startMs: extent.startMs, endMs: extent.endMs, trackId: tracks[0].trackId, confidence: 0.1 }],
    };
  }

  // Build regions between boundaries; assign tracks in order.
  const regions: Region[] = [];
  let cursor = extent.startMs;
  let cost = 0;
  for (let i = 0; i <= boundaries.length; i++) {
    const isLast = i === boundaries.length;
    const b = boundaries[i];
    const startMs = i === 0 ? extent.startMs : (boundaries[i - 1].gap?.endMs ?? boundaries[i - 1].atMs);
    const endMs = isLast ? extent.endMs : (b.gap?.startMs ?? b.atMs);
    const track = tracks[i] ?? null;
    const conf = isLast ? (boundaries[boundaries.length - 1]?.confidence ?? 0.5) : b.confidence;
    regions.push({
      startMs: pad(startMs, -1, extent),
      endMs: pad(endMs, 1, extent),
      trackId: track?.trackId ?? null,
      confidence: track ? conf : 0,
    });
    if (track?.durationMs != null) cost += Math.abs(endMs - startMs - track.durationMs);
    cursor = endMs;
  }
  // Penalize count mismatch so side-choice prefers blocks matching the structure.
  cost += Math.abs(regions.length - N) * 60000;
  // Also penalize total-length mismatch when durations exist.
  const expectedTotal = tracks.reduce((s, t) => s + (t.durationMs ?? 0), 0);
  if (haveDurations) cost += Math.abs(takeMs - expectedTotal);
  return { cost, regions };
}

/** Duration-predicted boundaries snapped to gaps via DP (min Σ duration error). */
function dpSnap(
  extent: { startMs: number; endMs: number },
  gaps: Gap[],
  tracks: (ExpectedTrack & { durationMs: number })[],
): { gap: Gap | null; atMs: number; confidence: number }[] {
  const N = tracks.length;
  // Predicted boundary times (cumulative durations from extent start).
  const predicted: number[] = [];
  let acc = extent.startMs;
  for (let i = 0; i < N - 1; i++) { acc += tracks[i].durationMs; predicted.push(acc); }

  // For each boundary, candidate gaps within the snap window (or fallback: predicted point).
  return predicted.map((p) => {
    let bestGap: Gap | null = null;
    let bestDist = Infinity;
    for (const g of gaps) {
      const center = (g.startMs + g.endMs) / 2;
      const d = Math.abs(center - p);
      if (d < bestDist && d <= SNAP_WINDOW_MS) { bestDist = d; bestGap = g; }
    }
    if (bestGap) {
      return { gap: bestGap, atMs: (bestGap.startMs + bestGap.endMs) / 2, confidence: Math.max(0.75, 1 - bestDist / SNAP_WINDOW_MS) };
    }
    return { gap: null, atMs: p, confidence: 0.3 }; // no gap near prediction — flag it
  });
}

function pad(ms: number, dir: -1 | 1, extent: { startMs: number; endMs: number }): number {
  // Expand region edges into the silence by PAD_MS to protect attacks/fades.
  const v = ms + dir * -PAD_MS * -1 * (dir === -1 ? 1 : -1); // -1: start → subtract; 1: end → add
  const padded = dir === -1 ? ms - PAD_MS : ms + PAD_MS;
  return Math.max(extent.startMs === ms || extent.endMs === ms ? ms : 0, Math.max(0, Math.min(padded, extent.endMs + PAD_MS)));
}

function durCost(actual: number, expected: number | null): number {
  return expected == null ? 0 : Math.abs(actual - expected);
}
function snapConf(actual: number, expected: number): number {
  return Math.max(0.3, Math.min(1, 1 - Math.abs(actual - expected) / Math.max(expected, 1)));
}
```

> **Note:** the `pad()` helper above is deliberately the fiddly bit — implement it cleanly as: region start = `max(extentStart, boundary − PAD_MS)` is **wrong** (pad goes *into* the silence, i.e. start moves *earlier*: `start − PAD_MS`, end moves *later*: `end + PAD_MS`, clamped to `[0, takeDuration]` and never crossing the neighbor's edge). Write it as a plain two-branch function, not the obfuscated arithmetic shown; the verify script's tolerance (±3–4s) doesn't test padding precision, so add one focused assertion: with a gap at exactly 10000–12000ms, region 0's `endMs === 10000 + PAD_MS` and region 1's `startMs === 12000 − PAD_MS`.

- [ ] **Step 5: Run to verify pass** — `bun verify scripts/verify-splitter.ts` → all passed. Iterate on constants if Case 5 flakes (the dip is 600ms ≥ MIN_GAP_MS=500, so the DP must *prefer* the real gap via duration cost — that's the point of the case).

- [ ] **Step 6: Commit**

```bash
git add src/lib/server/recording/splitter.ts src/lib/server/recording/matcher.ts scripts/verify-splitter.ts
git commit -m "feat(recording): hybrid splitter + in-order matcher with confidence scoring"
```

### Task 7: Session lifecycle + expected-track loading

**Files:**
- Create: `src/lib/server/recording/session.ts`
- Create: `src/lib/server/recording/env.ts`

- [ ] **Step 1: Write `env.ts`** (the only recording module allowed to import `$env`)

```ts
import { env } from '$env/dynamic/private';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function resolvedRecordingsRoot(): string {
  return env.BOOTH_RECORDINGS_PATH || join(homedir(), '.booth', 'recordings');
}
```

- [ ] **Step 2: Write `session.ts`**

```ts
import { mkdirSync, rmSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ulid } from 'ulid';
import type { Database } from 'bun:sqlite';
import type { ExpectedTrack } from './matcher';

export interface TakeState {
  id: string;            // 'take-1', 'take-2', …
  path: string;
  sampleRate: number;
  channels: number;
  finalized: boolean;
}

export interface SessionState {
  id: string;
  releaseId: string;
  tmpDir: string;
  createdAt: number;
  takes: TakeState[];
}

const sessions = new Map<string, SessionState>();

export function createSession(root: string, releaseId: string): SessionState {
  sweepStaleTmp(root);
  const id = ulid();
  const tmpDir = join(root, '.tmp', id);
  mkdirSync(tmpDir, { recursive: true });
  const s: SessionState = { id, releaseId, tmpDir, createdAt: Date.now(), takes: [] };
  sessions.set(id, s);
  return s;
}

export function getSession(id: string): SessionState | undefined {
  return sessions.get(id);
}

export function addTake(s: SessionState, sampleRate: number, channels: number): TakeState {
  const id = `take-${s.takes.length + 1}`;
  const take: TakeState = { id, path: join(s.tmpDir, `${id}.wav`), sampleRate, channels, finalized: false };
  s.takes.push(take);
  return take;
}

export function destroySession(id: string): void {
  const s = sessions.get(id);
  if (!s) return;
  rmSync(s.tmpDir, { recursive: true, force: true });
  sessions.delete(id);
}

/** Remove .tmp session dirs older than 24h (server-restart leftovers). */
export function sweepStaleTmp(root: string): void {
  const tmp = join(root, '.tmp');
  if (!existsSync(tmp)) return;
  const cutoff = Date.now() - 24 * 3600 * 1000;
  for (const name of readdirSync(tmp)) {
    const p = join(tmp, name);
    try {
      if (statSync(p).mtimeMs < cutoff && !sessions.has(name)) {
        rmSync(p, { recursive: true, force: true });
      }
    } catch { /* raced; ignore */ }
  }
}

/** Expected tracks for a release, grouped into side blocks for the matcher. */
export function loadExpectedTracks(db: Database, releaseId: string): {
  tracks: ExpectedTrack[];
  blocks: ExpectedTrack[][];
} {
  const rows = db
    .prepare(
      `SELECT t.id, t.title, t.duration_ms, t.position,
              (SELECT sf.value FROM source_facets sf
                WHERE sf.entity_kind='track' AND sf.entity_id=t.id
                  AND sf.source='discogs' AND sf.key='discogsPosition') AS dpos
         FROM track t
        WHERE t.release_id = ?
        ORDER BY CAST(t.position AS INTEGER)`,
    )
    .all(releaseId) as Array<{ id: string; title: string; duration_ms: number | null; position: string | null; dpos: string | null }>;

  const tracks: ExpectedTrack[] = rows.map((r) => {
    const discogsPosition = r.dpos ? (JSON.parse(r.dpos) as string) : null;
    const side = discogsPosition?.match(/^([A-Za-z]+)/)?.[1]?.toUpperCase() ?? null;
    return {
      trackId: r.id,
      title: r.title,
      durationMs: r.duration_ms,
      position: r.position ?? '',
      discogsPosition,
      side,
    };
  });

  // Group contiguous side blocks; if any track lacks a side, fall back to one block.
  const blocks: ExpectedTrack[][] = [];
  if (tracks.some((t) => !t.side)) {
    if (tracks.length > 0) blocks.push(tracks);
  } else {
    let current: ExpectedTrack[] = [];
    for (const t of tracks) {
      if (current.length && current[0].side !== t.side) { blocks.push(current); current = []; }
      current.push(t);
    }
    if (current.length) blocks.push(current);
  }
  return { tracks, blocks };
}
```

- [ ] **Step 3: Type-check** — `bun run check` → 0 errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/server/recording/session.ts src/lib/server/recording/env.ts
git commit -m "feat(recording): session lifecycle, stale-tmp sweep, expected-track side blocks"
```

### Task 8: Commit logic (region → file + DB)

**Files:**
- Create: `src/lib/server/recording/commit.ts`

- [ ] **Step 1: Write `commit.ts`**

```ts
import { mkdirSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { extractRegionToFile, readWavMeta } from './wav';
import { sanitizeName } from './paths';
import type { SessionState } from './session';

export interface CommitRegion {
  takeId: string;
  startMs: number;
  endMs: number;
  trackId: string;
  title: string; // possibly edited in review
}

export interface CommitResult {
  written: number;
  conflicts: string[]; // trackIds that already have a local link (when replace=false)
}

export function commitRegions(
  db: Database,
  root: string,
  session: SessionState,
  regions: CommitRegion[],
  replace: boolean,
): CommitResult {
  // 0. Conflict check first — don't touch disk if we're going to 409.
  const conflicts: string[] = [];
  const existingLink = db.prepare(
    `SELECT external_id FROM source_link WHERE entity_kind='track' AND entity_id=? AND source='local'`,
  );
  for (const r of regions) {
    if (existingLink.get(r.trackId)) conflicts.push(r.trackId);
  }
  if (conflicts.length > 0 && !replace) return { written: 0, conflicts };

  // 1. Resolve release info for the directory name.
  const rel = db.prepare(
    `SELECT r.title, r.catno, a.name AS artist FROM release r JOIN artist a ON a.id = r.artist_id WHERE r.id = ?`,
  ).get(session.releaseId) as { title: string; catno: string | null; artist: string } | undefined;
  if (!rel) throw new Error(`release not found: ${session.releaseId}`);
  const dirLabel = rel.catno ? `${rel.title} [${rel.catno}]` : rel.title;
  const dir = join(root, sanitizeName(`${rel.artist} — ${dirLabel}`));
  mkdirSync(dir, { recursive: true });

  // 2. Extract every region to a .part file, then rename into place.
  const finals: { region: CommitRegion; path: string; sampleRate: number; bitDepth: number }[] = [];
  const parts: string[] = [];
  try {
    for (const r of regions) {
      const take = session.takes.find((t) => t.id === r.takeId);
      if (!take) throw new Error(`unknown take: ${r.takeId}`);
      const pos = db.prepare(`SELECT position FROM track WHERE id=?`).get(r.trackId) as { position: string | null } | undefined;
      const fileName = sanitizeName(`${(pos?.position ?? '0').padStart(2, '0')} ${r.title}.wav`);
      const finalPath = join(dir, fileName);
      const partPath = `${finalPath}.part`;
      extractRegionToFile(take.path, partPath, r.startMs, r.endMs);
      parts.push(partPath);
      const meta = readWavMeta(partPath);
      finals.push({ region: r, path: finalPath, sampleRate: meta.sampleRate, bitDepth: meta.bitDepth });
    }
    for (let i = 0; i < finals.length; i++) renameSync(parts[i], finals[i].path);
  } catch (err) {
    for (const p of parts) { try { unlinkSync(p); } catch { /* already moved/missing */ } }
    throw err;
  }

  // 3. One DB transaction for all rows. On failure remove the moved files.
  try {
    const tx = db.transaction(() => {
      const now = new Date().toISOString();
      for (const f of finals) {
        const { region, path } = f;
        if (replace) {
          // Drop any prior local link/key for this entity (path may have changed).
          const old = db.prepare(
            `SELECT external_id FROM source_link WHERE entity_kind='track' AND entity_id=? AND source='local'`,
          ).get(region.trackId) as { external_id: string } | undefined;
          db.prepare(`DELETE FROM source_link WHERE entity_kind='track' AND entity_id=? AND source='local'`).run(region.trackId);
          db.prepare(`DELETE FROM match_key WHERE entity_kind='track' AND entity_id=? AND key_type='file_path'`).run(region.trackId);
          if (old && old.external_id !== path && old.external_id.startsWith(root) && existsSync(old.external_id)) {
            try { unlinkSync(old.external_id); } catch { /* keep going */ }
          }
        }
        db.prepare(
          `INSERT INTO source_link (entity_kind, entity_id, source, external_id, external_url, match_method)
           VALUES ('track', ?, 'local', ?, NULL, 'file_path')`,
        ).run(region.trackId, path);
        db.prepare(
          `INSERT INTO match_key (entity_kind, entity_id, key_type, key_value)
           VALUES ('track', ?, 'file_path', ?)
           ON CONFLICT(entity_kind, key_type, key_value) DO UPDATE SET entity_id=excluded.entity_id`,
        ).run(region.trackId, path);
        const facets: Record<string, unknown> = {
          origin: 'vinyl',
          recordedAt: now,
          sampleRate: f.sampleRate,
          bitDepth: f.bitDepth,
          takeId: region.takeId,
        };
        const facetStmt = db.prepare(
          `INSERT INTO source_facets (entity_kind, entity_id, source, key, value)
           VALUES ('track', ?, 'local', ?, ?)
           ON CONFLICT(entity_kind, entity_id, source, key) DO UPDATE SET
             value=excluded.value, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
        );
        for (const [k, v] of Object.entries(facets)) facetStmt.run(region.trackId, k, JSON.stringify(v));
        // Title edit + duration backfill.
        db.prepare(
          `UPDATE track SET title=?, duration_ms=COALESCE(duration_ms, ?),
                  updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`,
        ).run(region.title, Math.round(region.endMs - region.startMs), region.trackId);
      }
    });
    tx();
  } catch (err) {
    for (const f of finals) { try { unlinkSync(f.path); } catch { /* best effort */ } }
    throw err;
  }

  return { written: finals.length, conflicts: replace ? conflicts : [] };
}
```

> **Note:** the `sourceDiscogsReleaseId` facet from the spec: add it by looking up `source_link` for the release once before the loop — `SELECT external_id FROM source_link WHERE entity_kind='release' AND entity_id=? AND source='discogs'` — and include `sourceDiscogsReleaseId: <value>` in `facets`.

- [ ] **Step 2: Type-check** — `bun run check` → 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/server/recording/commit.ts
git commit -m "feat(recording): commit logic — region extraction, atomic DB writes, replace flow"
```

### Task 9: API endpoints

**Files:**
- Create: `src/routes/api/recordings/sessions/+server.ts`
- Create: `src/routes/api/recordings/sessions/[id]/+server.ts`
- Create: `src/routes/api/recordings/sessions/[id]/takes/+server.ts`
- Create: `src/routes/api/recordings/sessions/[id]/takes/[takeId]/chunk/+server.ts`
- Create: `src/routes/api/recordings/sessions/[id]/takes/[takeId]/finalize/+server.ts`
- Create: `src/routes/api/recordings/sessions/[id]/takes/[takeId]/audio/+server.ts`
- Create: `src/routes/api/recordings/sessions/[id]/commit/+server.ts`

- [ ] **Step 1: Session create** (`sessions/+server.ts`)

```ts
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { resolvedRecordingsRoot } from '$lib/server/recording/env';
import { createSession, loadExpectedTracks } from '$lib/server/recording/session';
import { hydrateDiscogsTracks } from '$lib/server/sources/discogs/hydrateDiscogsTracks';

export const POST: RequestHandler = async ({ request }) => {
  const { releaseId } = (await request.json()) as { releaseId?: string };
  if (!releaseId) throw error(400, 'releaseId required');
  const db = getDb();

  const link = db.prepare(
    `SELECT external_id FROM source_link WHERE entity_kind='release' AND entity_id=? AND source='discogs'`,
  ).get(releaseId) as { external_id: string } | undefined;
  if (!link) throw error(400, 'release has no Discogs source link');

  let { tracks, blocks } = loadExpectedTracks(db, releaseId);
  if (tracks.length === 0) {
    // Tracklist not hydrated yet — hydrate just this release, then retry.
    await hydrateDiscogsTracks(db, [{ discogsReleaseId: link.external_id, releaseEntityId: releaseId }]);
    ({ tracks, blocks } = loadExpectedTracks(db, releaseId));
  }
  if (tracks.length === 0) throw error(422, 'Discogs has no tracklist for this release');

  const session = createSession(resolvedRecordingsRoot(), releaseId);
  return json({ sessionId: session.id, tracks, sides: blocks.map((b) => b[0].side) });
};
```

- [ ] **Step 2: Session delete** (`sessions/[id]/+server.ts`)

```ts
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSession, destroySession } from '$lib/server/recording/session';

export const DELETE: RequestHandler = async ({ params }) => {
  if (!getSession(params.id)) throw error(404, 'session not found');
  destroySession(params.id);
  return json({ ok: true });
};
```

- [ ] **Step 3: Take create** (`takes/+server.ts`)

```ts
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSession, addTake } from '$lib/server/recording/session';
import { createWav } from '$lib/server/recording/wav';

export const POST: RequestHandler = async ({ params, request }) => {
  const session = getSession(params.id);
  if (!session) throw error(404, 'session not found');
  const { sampleRate, channels } = (await request.json()) as { sampleRate?: number; channels?: number };
  if (!sampleRate || sampleRate < 8000 || sampleRate > 384000) throw error(400, 'bad sampleRate');
  const ch = channels === 1 ? 1 : 2;
  const take = addTake(session, sampleRate, ch);
  createWav(take.path, sampleRate, ch);
  return json({ takeId: take.id });
};
```

- [ ] **Step 4: Chunk append** (`takes/[takeId]/chunk/+server.ts`)

```ts
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSession } from '$lib/server/recording/session';
import { appendFloat32 } from '$lib/server/recording/wav';

export const POST: RequestHandler = async ({ params, request }) => {
  const session = getSession(params.id);
  const take = session?.takes.find((t) => t.id === params.takeId);
  if (!session || !take) throw error(404, 'not found');
  if (take.finalized) throw error(409, 'take already finalized');
  const buf = await request.arrayBuffer();
  if (buf.byteLength % 4 !== 0) throw error(400, 'body must be float32 array');
  appendFloat32(take.path, new Float32Array(buf));
  return json({ ok: true });
};
```

- [ ] **Step 5: Finalize + split** (`takes/[takeId]/finalize/+server.ts`)

```ts
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { getSession, loadExpectedTracks } from '$lib/server/recording/session';
import { finalizeWav, readWavMeta, scanWav } from '$lib/server/recording/wav';
import { proposeRegions } from '$lib/server/recording/matcher';

const HOP_MS = 50;
const PEAK_BUCKETS = 2000; // downsampled waveform for the review UI

export const POST: RequestHandler = async ({ params }) => {
  const session = getSession(params.id);
  const take = session?.takes.find((t) => t.id === params.takeId);
  if (!session || !take) throw error(404, 'not found');

  finalizeWav(take.path);
  take.finalized = true;
  const meta = readWavMeta(take.path);
  const scan = scanWav(take.path, HOP_MS);

  const { blocks } = loadExpectedTracks(getDb(), session.releaseId);
  const proposal = proposeRegions(scan.rms, HOP_MS, blocks);

  // Downsample peaks to a fixed bucket count for rendering.
  const peaks: number[] = [];
  const per = Math.max(1, Math.floor(scan.peaks.length / PEAK_BUCKETS));
  for (let i = 0; i < scan.peaks.length; i += per) {
    let m = 0;
    for (let j = i; j < Math.min(i + per, scan.peaks.length); j++) m = Math.max(m, scan.peaks[j]);
    peaks.push(Number(m.toFixed(3)));
  }

  return json({
    durationMs: Math.round(meta.durationMs),
    sampleRate: meta.sampleRate,
    peaks,
    regions: proposal.regions,
    sideGuess: proposal.sideGuess,
  });
};
```

- [ ] **Step 6: Region preview audio** (`takes/[takeId]/audio/+server.ts`) — streams a WAV slice for ▶/seam preview

```ts
import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSession } from '$lib/server/recording/session';
import { extractRegionToFile } from '$lib/server/recording/wav';

export const GET: RequestHandler = async ({ params, url }) => {
  const session = getSession(params.id);
  const take = session?.takes.find((t) => t.id === params.takeId);
  if (!session || !take) throw error(404, 'not found');
  const startMs = Number(url.searchParams.get('startMs') ?? '0');
  const endMs = Number(url.searchParams.get('endMs') ?? '0');
  if (!(endMs > startMs)) throw error(400, 'bad range');

  const dir = mkdtempSync(join(tmpdir(), 'booth-prev-'));
  const p = join(dir, 'preview.wav');
  extractRegionToFile(take.path, p, startMs, endMs);
  const bytes = await Bun.file(p).arrayBuffer();
  rmSync(dir, { recursive: true, force: true });
  return new Response(bytes, { headers: { 'Content-Type': 'audio/wav' } });
};
```

- [ ] **Step 7: Commit endpoint** (`commit/+server.ts`)

```ts
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { resolvedRecordingsRoot } from '$lib/server/recording/env';
import { getSession, destroySession } from '$lib/server/recording/session';
import { commitRegions, type CommitRegion } from '$lib/server/recording/commit';

export const POST: RequestHandler = async ({ params, request }) => {
  const session = getSession(params.id);
  if (!session) throw error(404, 'session not found');
  const body = (await request.json()) as { regions?: CommitRegion[]; replace?: boolean };
  if (!body.regions?.length) throw error(400, 'regions required');

  const result = commitRegions(getDb(), resolvedRecordingsRoot(), session, body.regions, body.replace ?? false);
  if (result.conflicts.length > 0 && result.written === 0) {
    return json({ conflicts: result.conflicts }, { status: 409 });
  }
  destroySession(session.id);
  return json({ written: result.written });
};
```

- [ ] **Step 8: Smoke-test the capture path with curl**

With `bun dev` running and a real Discogs release id `RID` from `sqlite3 ~/.booth/booth.db "SELECT entity_id FROM source_link WHERE source='discogs' AND entity_kind='release' LIMIT 1"`:

```bash
SID=$(curl -s -X POST localhost:5173/api/recordings/sessions -H 'content-type: application/json' -d "{\"releaseId\":\"$RID\"}" | jq -r .sessionId)
TID=$(curl -s -X POST localhost:5173/api/recordings/sessions/$SID/takes -H 'content-type: application/json' -d '{"sampleRate":48000,"channels":2}' | jq -r .takeId)
# 2s of float32 zeros (silence): 48000*2*2*4 bytes
head -c 1536000 /dev/zero | curl -s -X POST localhost:5173/api/recordings/sessions/$SID/takes/$TID/chunk --data-binary @- -H 'content-type: application/octet-stream'
curl -s -X POST localhost:5173/api/recordings/sessions/$SID/takes/$TID/finalize | jq '{durationMs, regions: (.regions|length)}'
curl -s -X DELETE localhost:5173/api/recordings/sessions/$SID
```

Expected: finalize returns `durationMs` ≈ 2000 and a regions array (all-silence take → extent collapses; regions may be empty or one zero-confidence region — either is acceptable; the assertion is no 500s).

- [ ] **Step 9: Commit**

```bash
git add src/routes/api/recordings
git commit -m "feat(recording): session/take/chunk/finalize/preview/commit endpoints"
```

---

## Slice C — Client

### Task 10: AudioWorklet + recorder store

**Files:**
- Create: `static/pcm-recorder-worklet.js`
- Create: `src/lib/stores/recorder.svelte.ts`

- [ ] **Step 1: Write the worklet** (plain JS — worklets load as standalone modules; `static/` serves it at `/pcm-recorder-worklet.js`)

```js
// static/pcm-recorder-worklet.js
class PCMRecorder extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input.length > 0 && input[0].length > 0) {
      const ch0 = input[0];
      const ch1 = input[1] ?? input[0];
      const inter = new Float32Array(ch0.length * 2);
      for (let i = 0; i < ch0.length; i++) {
        inter[2 * i] = ch0[i];
        inter[2 * i + 1] = ch1[i];
      }
      this.port.postMessage(inter, [inter.buffer]);
    }
    return true;
  }
}
registerProcessor('pcm-recorder', PCMRecorder);
```

- [ ] **Step 2: Write the recorder store** (`src/lib/stores/recorder.svelte.ts`)

```ts
export type RecorderPhase =
  | 'idle' | 'arming' | 'preview' | 'recording' | 'analyzing' | 'reviewing' | 'committing' | 'done';

export interface ExpectedTrackClient {
  trackId: string; title: string; durationMs: number | null;
  position: string; discogsPosition: string | null; side: string | null;
}
export interface RegionClient {
  startMs: number; endMs: number; trackId: string | null; confidence: number;
  title: string; // editable; prefilled from expected track
}
export interface TakeClient {
  takeId: string; durationMs: number; peaks: number[]; regions: RegionClient[]; sideGuess: string | null;
}

let phase = $state<RecorderPhase>('idle');
let sessionId = $state<string | null>(null);
let releaseId = $state<string | null>(null);
let expected = $state<ExpectedTrackClient[]>([]);
let takes = $state<TakeClient[]>([]);
let elapsedMs = $state(0);
let levelL = $state(0);
let levelR = $state(0);
let clipped = $state(false);
let err = $state<string | null>(null);

// non-reactive capture plumbing
let ctx: AudioContext | null = null;
let stream: MediaStream | null = null;
let worklet: AudioWorkletNode | null = null;
let analyser: AnalyserNode | null = null;
let splitter: ChannelSplitterNode | null = null;
let analyserR: AnalyserNode | null = null;
let currentTakeId: string | null = null;
let pending: Float32Array[] = [];
let pendingSamples = 0;
let uploadChain: Promise<void> = Promise.resolve();
let recordStart = 0;
let meterRaf = 0;

const FLUSH_SAMPLES = 48000 * 2; // ~1s stereo

async function flushPending(): Promise<void> {
  if (pendingSamples === 0 || !sessionId || !currentTakeId) return;
  const buf = new Float32Array(pendingSamples);
  let o = 0;
  for (const c of pending) { buf.set(c, o); o += c.length; }
  pending = []; pendingSamples = 0;
  const sid = sessionId, tid = currentTakeId;
  uploadChain = uploadChain.then(async () => {
    const res = await fetch(`/api/recordings/sessions/${sid}/takes/${tid}/chunk`, {
      method: 'POST', body: buf, headers: { 'content-type': 'application/octet-stream' },
    });
    if (!res.ok) throw new Error(`chunk upload failed: ${res.status}`);
  });
  await uploadChain.catch((e) => { err = String(e); });
}

function meterLoop() {
  if (!analyser || !analyserR) return;
  const a = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(a);
  const b = new Float32Array(analyserR.fftSize);
  analyserR.getFloatTimeDomainData(b);
  let pl = 0, pr = 0;
  for (let i = 0; i < a.length; i++) { const v = Math.abs(a[i]); if (v > pl) pl = v; }
  for (let i = 0; i < b.length; i++) { const v = Math.abs(b[i]); if (v > pr) pr = v; }
  levelL = pl; levelR = pr;
  if (pl >= 0.999 || pr >= 0.999) clipped = true;
  if (phase === 'recording') elapsedMs = performance.now() - recordStart;
  meterRaf = requestAnimationFrame(meterLoop);
}

export const recorder = {
  get phase() { return phase; },
  get expected() { return expected; },
  get takes() { return takes; },
  get elapsedMs() { return elapsedMs; },
  get levelL() { return levelL; },
  get levelR() { return levelR; },
  get clipped() { return clipped; },
  get error() { return err; },
  get sampleRate() { return ctx?.sampleRate ?? 0; },

  /** Open session + input device; enter live preview. */
  async start(release: string, deviceId?: string) {
    err = null; phase = 'arming'; releaseId = release;
    try {
      const res = await fetch('/api/recordings/sessions', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ releaseId: release }),
      });
      if (!res.ok) throw new Error((await res.json()).message ?? `session create failed (${res.status})`);
      const data = await res.json();
      sessionId = data.sessionId; expected = data.tracks;

      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          echoCancellation: false, noiseSuppression: false, autoGainControl: false,
          channelCount: 2,
        },
      });
      ctx = new AudioContext();
      await ctx.audioWorklet.addModule('/pcm-recorder-worklet.js');
      const src = ctx.createMediaStreamSource(stream);
      splitter = ctx.createChannelSplitter(2);
      analyser = ctx.createAnalyser(); analyser.fftSize = 2048;
      analyserR = ctx.createAnalyser(); analyserR.fftSize = 2048;
      src.connect(splitter);
      splitter.connect(analyser, 0);
      splitter.connect(analyserR, 1);
      worklet = new AudioWorkletNode(ctx, 'pcm-recorder', { numberOfInputs: 1, numberOfOutputs: 0 });
      worklet.port.onmessage = (e: MessageEvent<Float32Array>) => {
        if (phase !== 'recording') return;
        pending.push(e.data); pendingSamples += e.data.length;
        if (pendingSamples >= FLUSH_SAMPLES) void flushPending();
      };
      src.connect(worklet);
      clipped = false;
      phase = 'preview';
      meterLoop();
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
      phase = 'idle';
      this.teardownAudio();
    }
  },

  async recordTake() {
    if (!sessionId || !ctx) return;
    clipped = false; err = null;
    const res = await fetch(`/api/recordings/sessions/${sessionId}/takes`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sampleRate: ctx.sampleRate, channels: 2 }),
    });
    if (!res.ok) { err = `take create failed (${res.status})`; return; }
    currentTakeId = (await res.json()).takeId;
    recordStart = performance.now(); elapsedMs = 0;
    phase = 'recording';
  },

  async stopTake() {
    if (!sessionId || !currentTakeId) return;
    phase = 'analyzing';
    await flushPending();
    await uploadChain;
    const res = await fetch(`/api/recordings/sessions/${sessionId}/takes/${currentTakeId}/finalize`, { method: 'POST' });
    if (!res.ok) { err = `finalize failed (${res.status})`; phase = 'preview'; return; }
    const data = await res.json();
    const byId = new Map(expected.map((t) => [t.trackId, t]));
    takes = [...takes, {
      takeId: currentTakeId,
      durationMs: data.durationMs,
      peaks: data.peaks,
      sideGuess: data.sideGuess,
      regions: (data.regions as { startMs: number; endMs: number; trackId: string | null; confidence: number }[])
        .map((r) => ({ ...r, title: r.trackId ? (byId.get(r.trackId)?.title ?? '') : '' })),
    }];
    currentTakeId = null;
    phase = 'preview'; // RecordSession shows the "another side?" prompt
  },

  review() { phase = 'reviewing'; this.teardownAudio(); },

  async commit(replace = false): Promise<boolean> {
    if (!sessionId) return false;
    phase = 'committing';
    const regions = takes.flatMap((t) =>
      t.regions.filter((r) => r.trackId).map((r) => ({
        takeId: t.takeId, startMs: Math.round(r.startMs), endMs: Math.round(r.endMs),
        trackId: r.trackId as string, title: r.title,
      })),
    );
    const res = await fetch(`/api/recordings/sessions/${sessionId}/commit`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ regions, replace }),
    });
    if (res.status === 409) { phase = 'reviewing'; return false; } // caller prompts replace
    if (!res.ok) { err = `commit failed (${res.status})`; phase = 'reviewing'; return true; }
    phase = 'done';
    return true;
  },

  async cancel() {
    if (sessionId) await fetch(`/api/recordings/sessions/${sessionId}`, { method: 'DELETE' }).catch(() => {});
    this.teardownAudio();
    sessionId = null; releaseId = null; expected = []; takes = []; err = null;
    phase = 'idle';
  },

  teardownAudio() {
    cancelAnimationFrame(meterRaf);
    worklet?.disconnect(); worklet = null;
    splitter?.disconnect(); splitter = null;
    analyser = null; analyserR = null;
    stream?.getTracks().forEach((t) => t.stop()); stream = null;
    void ctx?.close(); ctx = null;
  },

  previewUrl(takeId: string, startMs: number, endMs: number): string {
    return `/api/recordings/sessions/${sessionId}/takes/${takeId}/audio?startMs=${Math.round(startMs)}&endMs=${Math.round(endMs)}`;
  },
};
```

- [ ] **Step 3: Type-check** — `bun run check` → 0 errors.

- [ ] **Step 4: Commit**

```bash
git add static/pcm-recorder-worklet.js src/lib/stores/recorder.svelte.ts
git commit -m "feat(recording): AudioWorklet capture + recorder runes store"
```

### Task 11: RecordSession component (setup, preview, take loop)

**Files:**
- Create: `src/lib/components/RecordSession.svelte`

- [ ] **Step 1: Write the component**

```svelte
<script lang="ts">
  import { recorder } from '$lib/stores/recorder.svelte';
  import ReviewSplits from './ReviewSplits.svelte';

  let {
    releaseId, releaseTitle, releaseArtist, onClose,
  }: { releaseId: string; releaseTitle: string; releaseArtist: string; onClose: () => void } = $props();

  let devices = $state<MediaDeviceInfo[]>([]);
  let deviceId = $state<string>('');
  let started = $state(false);

  async function loadDevices() {
    // Need permission before labels are visible; request a throwaway stream first.
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
    } catch { /* error shown on start() */ }
    devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
    deviceId = devices[0]?.deviceId ?? '';
  }
  $effect(() => { void loadDevices(); });

  async function begin() {
    started = true;
    await recorder.start(releaseId, deviceId || undefined);
  }

  function fmt(ms: number): string {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
  function db(level: number): string {
    if (level <= 0.0001) return '−∞';
    return `${Math.round(20 * Math.log10(level))} dB`;
  }

  async function close() {
    await recorder.cancel();
    onClose();
  }

  const phase = $derived(recorder.phase);
</script>

<div class="record-overlay">
  <header>
    <span class="title">⏺ Recording · {releaseArtist} — {releaseTitle}</span>
    <button class="close" onclick={close}>✕</button>
  </header>

  {#if recorder.error}
    <div class="error">{recorder.error}</div>
  {/if}

  {#if phase === 'reviewing' || phase === 'committing' || phase === 'done'}
    <ReviewSplits {onClose} />
  {:else}
    <div class="body">
      <div class="setup">
        {#if !started}
          <label class="label" for="dev">Input device</label>
          <select id="dev" bind:value={deviceId}>
            {#each devices as d}
              <option value={d.deviceId}>{d.label || 'Audio input'}</option>
            {/each}
          </select>
          <button class="primary" onclick={begin}>Open input</button>
        {:else}
          <div class="meters">
            <div class="meter"><span>L</span><div class="bar"><div class="fill" style:width="{Math.min(100, recorder.levelL * 100)}%"></div></div><span class="db">{db(recorder.levelL)}</span></div>
            <div class="meter"><span>R</span><div class="bar"><div class="fill" style:width="{Math.min(100, recorder.levelR * 100)}%"></div></div><span class="db">{db(recorder.levelR)}</span></div>
            <div class="cliplight" class:clipped={recorder.clipped}>{recorder.clipped ? 'CLIP' : 'no clip'}</div>
            <div class="rate">{recorder.sampleRate} Hz · 24-bit</div>
          </div>

          {#if phase === 'preview'}
            <div class="actions">
              <button class="rec" onclick={() => recorder.recordTake()}>⏺ Record side {recorder.takes.length + 1}</button>
              {#if recorder.takes.length > 0}
                <button class="primary" onclick={() => recorder.review()}>No more sides → review {recorder.takes.length} take{recorder.takes.length === 1 ? '' : 's'}</button>
              {/if}
            </div>
          {:else if phase === 'recording'}
            <div class="actions">
              <span class="elapsed">⏺ {fmt(recorder.elapsedMs)}</span>
              <button class="primary" onclick={() => recorder.stopTake()}>⏹ Stop</button>
            </div>
          {:else if phase === 'analyzing'}
            <div class="actions"><span>Splitting…</span></div>
          {/if}

          {#if recorder.takes.length > 0 && phase === 'preview'}
            <ul class="takes">
              {#each recorder.takes as t, i}
                <li>Take {i + 1} · {fmt(t.durationMs)} · {t.regions.filter((r) => r.trackId).length} tracks proposed{t.sideGuess ? ` · side ${t.sideGuess}?` : ''}</li>
              {/each}
            </ul>
          {/if}
        {/if}
      </div>

      <aside class="expected">
        <div class="label">Expected (from Discogs)</div>
        <ul>
          {#each recorder.expected as t}
            <li><span class="pos">{t.discogsPosition ?? t.position}</span> {t.title}
              <span class="dur">{t.durationMs ? fmt(t.durationMs) : '(no duration)'}</span></li>
          {/each}
        </ul>
      </aside>
    </div>
  {/if}
</div>

<style>
  .record-overlay { position: fixed; inset: 0; background: var(--bg, #111); z-index: 50; display: flex; flex-direction: column; }
  header { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid #2a2a2a; }
  .body { display: flex; gap: 24px; padding: 20px; flex: 1; overflow: auto; }
  .setup { flex: 2; display: flex; flex-direction: column; gap: 16px; }
  .expected { flex: 1; border-left: 1px solid #2a2a2a; padding-left: 16px; font-size: 13px; }
  .expected ul { list-style: none; padding: 0; line-height: 2; }
  .pos { opacity: .6; display: inline-block; width: 28px; }
  .dur { opacity: .5; margin-left: 8px; }
  .meters { display: flex; flex-direction: column; gap: 8px; max-width: 480px; }
  .meter { display: flex; align-items: center; gap: 8px; }
  .bar { flex: 1; height: 14px; background: #222; border-radius: 3px; overflow: hidden; }
  .fill { height: 100%; background: #2e7d32; }
  .db { width: 52px; font-size: 11px; opacity: .7; text-align: right; }
  .cliplight { font-size: 11px; opacity: .6; }
  .cliplight.clipped { color: #e53935; opacity: 1; font-weight: 700; }
  .rate { font-size: 11px; opacity: .5; }
  .actions { display: flex; align-items: center; gap: 12px; }
  .rec { background: #c0392b; color: #fff; border: none; padding: 8px 16px; border-radius: 5px; cursor: pointer; }
  .primary { background: #2962ff; color: #fff; border: none; padding: 8px 16px; border-radius: 5px; cursor: pointer; }
  .elapsed { font-variant-numeric: tabular-nums; color: #e53935; }
  .takes { list-style: none; padding: 0; font-size: 13px; opacity: .8; }
  .error { background: #4a1f1f; color: #ffb4b4; padding: 8px 16px; font-size: 13px; }
  .close { background: none; border: none; color: inherit; cursor: pointer; font-size: 16px; }
</style>
```

- [ ] **Step 2: Type-check** — `bun run check` → 0 errors (ReviewSplits is created next task; to keep this task self-contained, create a placeholder `ReviewSplits.svelte` containing only `<script lang="ts">let { onClose }: { onClose: () => void } = $props();</script><div>review…</div>` and replace it in Task 12).

- [ ] **Step 3: Commit**

```bash
git add src/lib/components/RecordSession.svelte src/lib/components/ReviewSplits.svelte
git commit -m "feat(recording): RecordSession capture UI with live input preview"
```

### Task 12: ReviewSplits component

**Files:**
- Modify (replace placeholder): `src/lib/components/ReviewSplits.svelte`

The heart of review: per-take canvas waveform with draggable in/out handles, synced rows, zoom + nudge, region/seam preview, commit with replace prompt.

- [ ] **Step 1: Write the component**

```svelte
<script lang="ts">
  import { recorder, type RegionClient, type TakeClient } from '$lib/stores/recorder.svelte';

  let { onClose }: { onClose: () => void } = $props();

  let replacePrompt = $state(false);
  let audio: HTMLAudioElement | null = null;

  // ---- waveform rendering ----
  const W = 1200, H = 96;
  function drawWave(canvas: HTMLCanvasElement, take: TakeClient) {
    const render = () => {
      const ctx2 = canvas.getContext('2d')!;
      ctx2.clearRect(0, 0, W, H);
      ctx2.fillStyle = '#161616'; ctx2.fillRect(0, 0, W, H);
      // peaks
      ctx2.fillStyle = '#3a86ff';
      const n = take.peaks.length;
      for (let i = 0; i < n; i++) {
        const x = (i / n) * W;
        const h = take.peaks[i] * (H - 8);
        ctx2.fillRect(x, (H - h) / 2, Math.max(1, W / n - 0.5), h);
      }
      // regions
      for (const r of take.regions) {
        const x1 = (r.startMs / take.durationMs) * W;
        const x2 = (r.endMs / take.durationMs) * W;
        ctx2.fillStyle = r.trackId ? 'rgba(58,134,255,0.12)' : 'rgba(255,255,255,0.04)';
        ctx2.fillRect(x1, 0, x2 - x1, H);
        ctx2.fillStyle = r.confidence < 0.6 ? '#e0a23c' : '#2e7d32';
        ctx2.fillRect(x1, 0, 2, H);                 // in-point
        ctx2.fillStyle = r.confidence < 0.6 ? '#e0a23c' : '#c0392b';
        ctx2.fillRect(x2 - 2, 0, 2, H);             // out-point
      }
    };
    render();
    return {
      update: render,
    };
  }
  // Svelte attachment-style: use an action signature.
  function wave(canvas: HTMLCanvasElement, take: TakeClient) {
    canvas.width = W; canvas.height = H;
    let d = drawWave(canvas, take);
    return { update(t: TakeClient) { take = t; d = drawWave(canvas, take); } };
  }

  // ---- drag handling ----
  let drag: { take: TakeClient; region: RegionClient; edge: 'in' | 'out' } | null = $state.raw(null);
  let selected: { take: TakeClient; region: RegionClient; edge: 'in' | 'out' } | null = $state.raw(null);

  function hitTest(take: TakeClient, e: PointerEvent, canvas: HTMLCanvasElement) {
    const rect = canvas.getBoundingClientRect();
    const ms = ((e.clientX - rect.left) / rect.width) * take.durationMs;
    const tol = take.durationMs * 0.008;
    for (const r of take.regions) {
      if (Math.abs(r.startMs - ms) < tol) return { region: r, edge: 'in' as const };
      if (Math.abs(r.endMs - ms) < tol) return { region: r, edge: 'out' as const };
    }
    return null;
  }
  function onDown(take: TakeClient, e: PointerEvent) {
    const canvas = e.currentTarget as HTMLCanvasElement;
    const hit = hitTest(take, e, canvas);
    if (hit) { drag = { take, ...hit }; selected = drag; canvas.setPointerCapture(e.pointerId); }
  }
  function onMove(take: TakeClient, e: PointerEvent) {
    if (!drag || drag.take !== take) return;
    const canvas = e.currentTarget as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    const ms = Math.max(0, Math.min(take.durationMs, ((e.clientX - rect.left) / rect.width) * take.durationMs));
    setEdge(drag.region, drag.edge, ms, take);
    bump();
  }
  function onUp() { drag = null; }

  function setEdge(r: RegionClient, edge: 'in' | 'out', ms: number, take: TakeClient) {
    if (edge === 'in') r.startMs = Math.min(ms, r.endMs - 1000);
    else r.endMs = Math.max(ms, r.startMs + 1000);
  }
  function nudge(deltaMs: number) {
    if (!selected) return;
    setEdge(selected.region, selected.edge,
      (selected.edge === 'in' ? selected.region.startMs : selected.region.endMs) + deltaMs, selected.take);
    bump();
  }
  // force reactivity on nested mutation
  function bump() { recorder.takes.forEach(() => {}); takesVersion++; }
  let takesVersion = $state(0);

  // ---- splits add/merge/reassign ----
  function addSplit(take: TakeClient, region: RegionClient) {
    const mid = (region.startMs + region.endMs) / 2;
    const idx = take.regions.indexOf(region);
    const right: RegionClient = { startMs: mid, endMs: region.endMs, trackId: null, confidence: 0.2, title: '' };
    region.endMs = mid;
    take.regions.splice(idx + 1, 0, right);
    bump();
  }
  function mergeWithNext(take: TakeClient, region: RegionClient) {
    const idx = take.regions.indexOf(region);
    const next = take.regions[idx + 1];
    if (!next) return;
    region.endMs = next.endMs;
    take.regions.splice(idx + 1, 1);
    bump();
  }
  function assign(region: RegionClient, trackId: string) {
    region.trackId = trackId || null;
    const t = recorder.expected.find((x) => x.trackId === trackId);
    if (t) region.title = t.title;
    region.confidence = 1; // user said so
    bump();
  }

  // ---- preview ----
  function play(takeId: string, startMs: number, endMs: number) {
    audio?.pause();
    audio = new Audio(recorder.previewUrl(takeId, startMs, endMs));
    void audio.play();
  }
  function seam(take: TakeClient, region: RegionClient) {
    const idx = take.regions.indexOf(region);
    const next = take.regions[idx + 1];
    if (!next) return;
    // out-tail of this region followed by in-head of the next (1.5s each)
    play(take.takeId, Math.max(region.startMs, region.endMs - 1500), region.endMs);
    setTimeout(() => play(take.takeId, next.startMs, Math.min(next.endMs, next.startMs + 1500)), 1600);
  }

  async function save(replace = false) {
    const ok = await recorder.commit(replace);
    if (!ok) { replacePrompt = true; return; }
    if (recorder.phase === 'done') onClose();
  }

  function fmt(ms: number): string {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
  const assignedCount = $derived(
    (takesVersion, recorder.takes.reduce((n, t) => n + t.regions.filter((r) => r.trackId).length, 0)),
  );
</script>

<div class="review">
  {#each recorder.takes as take, ti}
    <section>
      <h3>Take {ti + 1} · {fmt(take.durationMs)}{take.sideGuess ? ` · side ${take.sideGuess}?` : ''}</h3>
      <canvas
        use:wave={take}
        onpointerdown={(e) => onDown(take, e)}
        onpointermove={(e) => onMove(take, e)}
        onpointerup={onUp}
      ></canvas>
      {#key takesVersion}
      <div class="rows">
        {#each take.regions as region}
          <div class="row" class:warn={region.confidence < 0.6}>
            <button class="play" onclick={() => play(take.takeId, region.startMs, region.endMs)}>▶</button>
            <select value={region.trackId ?? ''} onchange={(e) => assign(region, e.currentTarget.value)}>
              <option value="">(unassigned)</option>
              {#each recorder.expected as t}
                <option value={t.trackId}>{t.discogsPosition ?? t.position} · {t.title}</option>
              {/each}
            </select>
            <input class="title" bind:value={region.title} placeholder="title" />
            <span class="dur">{fmt(region.endMs - region.startMs)}
              {#if region.trackId}
                {@const exp = recorder.expected.find((t) => t.trackId === region.trackId)?.durationMs}
                {#if exp}<span class="exp">/ {fmt(exp)}</span>{/if}
              {/if}
            </span>
            <span class="dot" class:ok={region.confidence >= 0.6}></span>
            <button class="mini" title="add split at midpoint" onclick={() => addSplit(take, region)}>＋</button>
            <button class="mini" title="merge with next" onclick={() => mergeWithNext(take, region)}>✕</button>
            <button class="mini" title="preview seam into next" onclick={() => seam(take, region)}>⎌</button>
          </div>
        {/each}
      </div>
      {/key}
    </section>
  {/each}

  <footer>
    {#if selected}
      <span class="nudge">
        Selected: {selected.edge}-point ·
        <button class="mini" onclick={() => nudge(-10)}>−10ms</button>
        <button class="mini" onclick={() => nudge(10)}>+10ms</button>
        <button class="mini" onclick={() => nudge(-1000)}>−1s</button>
        <button class="mini" onclick={() => nudge(1000)}>+1s</button>
      </span>
    {/if}
    {#if replacePrompt}
      <span class="conflict">Some tracks already have a local recording.</span>
      <button class="danger" onclick={() => save(true)}>Replace</button>
      <button onclick={() => (replacePrompt = false)}>Cancel</button>
    {:else}
      <button class="confirm" disabled={assignedCount === 0 || recorder.phase === 'committing'} onclick={() => save(false)}>
        ✓ Save {assignedCount} track{assignedCount === 1 ? '' : 's'} to local library
      </button>
    {/if}
  </footer>
</div>

<style>
  .review { padding: 16px 20px; overflow: auto; flex: 1; display: flex; flex-direction: column; gap: 20px; }
  section h3 { font-size: 13px; opacity: .8; margin: 0 0 8px; }
  canvas { width: 100%; height: 96px; border-radius: 5px; cursor: col-resize; touch-action: none; }
  .rows { display: flex; flex-direction: column; gap: 4px; margin-top: 8px; }
  .row { display: flex; align-items: center; gap: 8px; padding: 6px 8px; background: #1c1c1c; border-radius: 5px; border: 1px solid transparent; }
  .row.warn { border-color: #5a4a1a; background: #241f12; }
  .title { flex: 1; background: #111; border: 1px solid #2a2a2a; color: inherit; padding: 4px 8px; border-radius: 4px; }
  select { background: #111; color: inherit; border: 1px solid #2a2a2a; border-radius: 4px; padding: 4px; max-width: 280px; }
  .dur { font-size: 12px; opacity: .8; font-variant-numeric: tabular-nums; }
  .exp { opacity: .5; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: #e0a23c; }
  .dot.ok { background: #2e7d32; }
  .play, .mini { background: #222; border: 1px solid #333; color: inherit; border-radius: 4px; cursor: pointer; padding: 2px 8px; }
  footer { display: flex; align-items: center; gap: 12px; border-top: 1px solid #2a2a2a; padding-top: 12px; }
  .confirm { background: #2e7d32; color: #fff; border: none; padding: 10px 18px; border-radius: 5px; cursor: pointer; }
  .confirm:disabled { opacity: .4; cursor: default; }
  .danger { background: #c0392b; color: #fff; border: none; padding: 8px 14px; border-radius: 5px; cursor: pointer; }
  .conflict { color: #e0a23c; font-size: 13px; }
  .nudge { font-size: 12px; opacity: .8; display: flex; gap: 6px; align-items: center; }
</style>
```

> **Implementation notes for this task:**
> - Svelte 5: `use:wave={take}` actions receive `(node, param)` and may return `{ update }` — this matches the code above. If `svelte-check` complains about action typing, type it as `import type { Action } from 'svelte/action'`.
> - The `bump()/takesVersion` pattern forces re-render on nested mutations of `take.regions[i]` fields; `recorder.takes` is `$state` in the store so reassignment patterns also work — whichever the implementer finds cleaner, the behavior contract is: dragging a handle updates the row duration live, and edits update the canvas.
> - Zoom is **deferred from this task** if time-boxed: the nudge buttons + 1200px canvas give ~0.5s/px on a 20-min side which is serviceable; if implementing zoom, wrap the canvas in a scroll container and scale `W` by a zoom factor toggled by clicking a handle. Do not skip nudge or seam preview — those are spec'd.

- [ ] **Step 2: Type-check** — `bun run check` → 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/components/ReviewSplits.svelte
git commit -m "feat(recording): ReviewSplits — waveform regions, drag/nudge, seam preview, commit"
```

### Task 13: Entry point — wire into ReleaseDetail + Explorer

**Files:**
- Modify: `src/lib/components/ReleaseDetail.svelte`
- Modify: `src/lib/components/Explorer.svelte`

- [ ] **Step 1: Add the CTA to ReleaseDetail**

ReleaseDetail already receives `sources: SourceLink[]` and a CTA area (see the add/remove CTA block). Add an optional `onRecord` callback prop:

```ts
let { /* existing props */, onRecord }: { /* existing */; onRecord?: () => void } = $props();
const hasDiscogs = $derived(sources.some((s) => s.source === 'discogs'));
```

Below the existing CTA block in the template:

```svelte
{#if hasDiscogs && onRecord}
  <button class="record-cta" onclick={onRecord}>⏺ Record from vinyl</button>
{/if}
```

```css
.record-cta { background: none; border: 1px solid #c0392b; color: #c0392b; padding: 8px 14px; border-radius: 5px; cursor: pointer; margin-top: 8px; }
.record-cta:hover { background: #c0392b22; }
```

- [ ] **Step 2: Mount RecordSession in Explorer**

In `Explorer.svelte`, add state + handler near the other detail-pane wiring:

```ts
import RecordSession from './RecordSession.svelte';
let recordingRelease = $state<{ id: string; title: string; artist: string } | null>(null);
```

Pass `onRecord` where `ReleaseDetail` is rendered (the library-release branch — search-hit releases have no entity id yet, so only pass it when the detail came from `/api/library/releases/[id]`):

```svelte
<ReleaseDetail {...existingProps} onRecord={() => (recordingRelease = { id: release.id, title: release.title, artist: release.artist })} />
```

At the end of Explorer's template:

```svelte
{#if recordingRelease}
  <RecordSession
    releaseId={recordingRelease.id}
    releaseTitle={recordingRelease.title}
    releaseArtist={recordingRelease.artist}
    onClose={() => (recordingRelease = null)}
  />
{/if}
```

> Match the actual prop names/data shape in `Explorer.svelte` when editing — the release detail object there is the API payload `{ release, sources, facets, tracks, sourceMeta }`; pull `id`/`title`/`artist` from `release`.

- [ ] **Step 3: Type-check + manual run**

`bun run check` → 0 errors. Then `bun dev`: open a Discogs-owned release → the ⏺ CTA appears → clicking opens the capture overlay → device list populates → Open input shows live meters.

- [ ] **Step 4: Commit**

```bash
git add src/lib/components/ReleaseDetail.svelte src/lib/components/Explorer.svelte
git commit -m "feat(recording): Record-from-vinyl entry point on release detail"
```

### Task 14: End-to-end verification + docs

**Files:**
- Modify: `docs/CONTEXT.md`
- Modify: `.env.example`

- [ ] **Step 1: Full manual end-to-end**

With a real record (or any line-level audio into the interface): create session → record two short "sides" → review proposals → drag a boundary, nudge, seam-preview → save → confirm: files exist under `~/.booth/recordings/<Artist — Album [catno]>/`, tracks show the Local dot, and each plays via the existing player bar. Then trigger a manual Apple sync (`SyncChip` on the local source) and confirm the ripped tracks survive (`sqlite3 ~/.booth/booth.db "SELECT COUNT(*) FROM source_link WHERE source='local' AND external_id LIKE '%recordings%'"` unchanged).

- [ ] **Step 2: Run all verify scripts + type-check**

```bash
bun verify scripts/verify-wav.ts
bun verify scripts/verify-splitter.ts
bun verify scripts/verify-local-merge.ts
bun run check
```

All pass, 0 type errors.

- [ ] **Step 3: Update `.env.example`** — append:

```
# Optional: where vinyl rips are written (defaults to ~/.booth/recordings)
# BOOTH_RECORDINGS_PATH=
```

- [ ] **Step 4: Update `docs/CONTEXT.md`**

- Fix the stale claim that Discogs is release-only / "No tracks indexed": Discogs track rows are hydrated post-sync by `hydrateDiscogsTracks` (positions, durations when present, `discogsPosition` facet).
- Source list: `itunes` renamed to `local` (Apple Music XML import + vinyl rips; origin by file path; prune scoped so Apple re-syncs never delete rips). Migration 006.
- New file-map entries: `src/lib/server/recording/` (env, paths, wav, splitter, matcher, session, commit), `/api/recordings/*` routes, `RecordSession.svelte`, `ReviewSplits.svelte`, `recorder.svelte.ts`, `static/pcm-recorder-worklet.js`.
- Feature inventory: vinyl recording section (capture → split → review → commit; 24-bit WAV; `BOOTH_RECORDINGS_PATH`).
- Environment section: add `BOOTH_RECORDINGS_PATH`.

- [ ] **Step 5: Final commit**

```bash
git add docs/CONTEXT.md .env.example
git commit -m "docs: vinyl recording feature + local source merge in CONTEXT.md"
```

---

## Self-review notes (already applied)

- **Spec coverage:** capture/preview (T10–11), per-side loop (T11), hybrid splitter + fallbacks (T6), regions with pad (T6), split-as-you-go (T9 finalize), review with drag/nudge/seam/add/merge/reassign/title-edit (T12), leftovers = unassigned rows (T12), commit atomicity + replace (T8), `local` merge + prune safety (T1–4), duration backfill (T8), `sourceDiscogsReleaseId` facet (T8 note), stale-tmp sweep (T7), no-tracklist hydration (T9), CONTEXT.md fix (T14). Zoom is the one consciously thinned item (T12 note) — nudge covers precision; add zoom if time allows.
- **Known fiddly spots called out inline:** `$env` purity in `paths.ts`/`collate.ts` (T4 note), `pad()` clarity (T6 note), Svelte action typing + nested-mutation reactivity (T12 notes).
