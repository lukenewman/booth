# Needs Attention List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A standing "Needs attention" list, fed by every local sync, that raises missing-file, duplicate and unsupported-file findings, clears them when the problem goes away, remembers what the user settled, and stops missing files from offering a play button (BOO-67).

**Architecture:** One `finding` table keyed by (kind, subject). After each local sync, `refreshFindings` compares the problems in the file list against the table: new problems open, gone problems clear, settled ones stay settled. Settling a finding that removes a track (keep one duplicate, forget a missing track) marks the file *excluded* in the file list, so the local result stops emitting it and the ordinary prune removes the track; annotations move or are dropped first, as the user confirmed. A Library rail item opens a view of the open findings.

**Tech Stack:** SvelteKit + Bun, bun:sqlite, Svelte 5 runes.

**Spec:** `docs/superpowers/specs/2026-11-02-migration-and-sources-design.md`, section 2 and build-order step 2.

## Global Constraints

- Nothing on this list deletes audio. Booth never writes to or moves a file it does not own.
- Booth never deletes, merges or picks a winner on its own. Only self-clearing findings change without the user.
- Settled stays settled: a decision is remembered against the files involved; a new circumstance (a third copy) is a new finding.
- Bulk settling shows how many it will affect first.
- Verification: a verify script per behaviour against an in-memory database (`bun verify scripts/<name>.ts`), then a probe on a `sqlite3 .backup` copy of the real database. Never bulk-delete real rows. Never run against the real library directly.
- Work on main, commit per task with the ticket reference, trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Don't push.

## Scope decisions (from the spec, made concrete here)

- **Findings are about files that back the local library**: the files the local sync asked about this run (catalog-listed and Booth-folder files), minus excluded ones.
- **Missing** = such a file is not on disk. **Duplicate** = two or more present such files share a fingerprint. **Unsupported** = a present such file whose tags can't be read. (A file that reads but can't be fingerprinted is not user-visible and raises nothing.)
- **Actions:** duplicate → *keep both* or *keep one* (the others leave the library; their stars, notes and playlist entries move to the kept track; files stay on disk). Missing → *leave it* (stays, unplayable) or *forget the track* (after seeing its stars, notes and playlists). Unsupported → *acknowledge*.
- **Deferred:** "point Booth at it" for a missing file. While Music.app still lists the old location, a Booth-side pointer fights the catalog on every sync; it belongs with folder sources (step 4) or takeover (step 6). Fixing the file in Music.app, or putting it back, clears the finding on its own.
- **Bulk** offers only the non-destructive action per kind (keep both, leave, acknowledge). Destructive actions are one finding at a time.
- **Desktop only.** The mobile shell gets nothing in this step.

## Review Focus

1. A file that leaves the library through *keep one* or *forget* must not come back as a track on the next sync, and must not raise a missing or duplicate finding again.
2. Settling must never take stars, notes or playlist entries the user wasn't shown: *keep one* moves them, *forget* lists them before confirming.
3. A finding whose files are all fine again clears on the next sync, and the same problem returning reopens the same row rather than adding a second.
4. A third copy of a settled duplicate raises a new finding; the settled pair stays settled.
5. A track whose file is missing shows as not playable in track lists, release detail and playlists, and becomes playable again when the file returns.

---

### Task 1: Exclusion in the file list

**Files:**
- Create: `src/lib/server/db/migrations/019_findings.sql`
- Modify: `src/lib/server/library/fileList.ts` (FileRow, DbRow, toFileRow)
- Modify: `src/lib/server/sources/local/localResult.ts`
- Modify: `src/lib/server/sources/types.ts` (SyncResult.fileIds)
- Modify: `src/lib/server/sources/local/sync.ts` (pass fileIds)
- Test: `scripts/verify-findings.ts` (new; Task 1 writes its first section)

**Interfaces:**
- Produces: `audio_file.excluded` column; `FileRow.excluded: boolean`; `LocalResult.fileIds: string[]`; `SyncResult.fileIds?: string[]`; the `finding` table.

- [ ] **Step 1: Write the failing test**

Create `scripts/verify-findings.ts`:

```ts
/**
 * The "needs attention" list. Load-bearing claims:
 *  - an excluded file stops being a track and stays out on later syncs;
 *  - missing, duplicate and unsupported files raise findings that clear
 *    themselves when the problem goes away and reopen when it returns;
 *  - a settled finding stays settled, and a third copy is a new finding;
 *  - keep-one moves stars, notes and playlist entries; forget drops them;
 *  - a track whose file is missing is not playable.
 * Temp dirs and an in-memory database only.
 *
 * Run: bun verify scripts/verify-findings.ts
 */
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runMigrations } from '../src/lib/server/db/migrate';
import { collate } from '../src/lib/server/library/collate';
import type { FileListDeps } from '../src/lib/server/library/fileList';
import type { FileTags } from '../src/lib/server/library/tags';
import { buildLocalResult, type Catalog } from '../src/lib/server/sources/local/localResult';
import { releaseIdForTags } from '../src/lib/server/sources/local/sync';

function fail(msg: string): never { console.error(`FAIL: ${msg}`); process.exit(1); }
function assert(cond: unknown, msg: string): asserts cond { if (!cond) fail(msg); }

const root = mkdtempSync(join(tmpdir(), 'booth-findings-'));
const p = (name: string) => join(root, name);
/** A fake audio file: line 1 is the audio (fingerprinted), line 2 the title tag. "UNREADABLE" refuses tag reads. */
function write(name: string, audio: string, title: string) {
  mkdirSync(dirname(p(name)), { recursive: true });
  writeFileSync(p(name), `${audio}\n${title}\n`);
}
const deps: FileListDeps = {
  async fingerprint(path) { return createHash('md5').update(readFileSync(path, 'utf8').split('\n')[0]).digest('hex'); },
  async readTags(path): Promise<FileTags> {
    const [, title] = readFileSync(path, 'utf8').split('\n');
    if (title === 'UNREADABLE') throw new Error('unsupported format');
    return { title, artist: 'Artist', album: 'Album', year: 2020, trackNumber: 1, booth: {} };
  },
};

const db = new Database(':memory:');
db.exec('PRAGMA foreign_keys = ON');
runMigrations(db);

const RELEASE = 'itunes-album:abc';
type Listed = { pid: string; name: string; pos: number; title: string };
function catalog(listed: Listed[]): Catalog {
  return {
    id: 'music',
    releases: [{ externalId: RELEASE, title: 'Album', artist: 'Artist', year: 2021 }],
    tracks: listed.map((t) => ({
      catalogId: t.pid,
      path: p(t.name),
      track: { title: t.title, artist: 'Artist', album: 'Album', position: String(t.pos), releaseExternalId: RELEASE, facets: {} },
    })),
  };
}
/** One local sync: build from the file list, collate. Returns the result for refreshFindings. */
async function sync(listed: Listed[]) {
  const built = await buildLocalResult(db, { catalogs: [catalog(listed)], boothFiles: [], groupIdFor: releaseIdForTags }, deps);
  collate(db, 'local', { tracks: built.tracks, releases: built.releases });
  return built;
}
const trackTitles = () => (db.prepare(`SELECT title FROM track ORDER BY title`).all() as { title: string }[]).map((r) => r.title);
const fileId = (name: string) => (db.prepare(`SELECT id FROM audio_file WHERE path = ?`).get(p(name)) as { id: string }).id;

// --- Task 1: an excluded file leaves the library and stays out ------------
write('A/01.mp3', 'AUDIO-1', 'One');
write('A/02.mp3', 'AUDIO-2', 'Two');
const two: Listed[] = [
  { pid: 'P1', name: 'A/01.mp3', pos: 1, title: 'One' },
  { pid: 'P2', name: 'A/02.mp3', pos: 2, title: 'Two' },
];
{
  const built = await sync(two);
  assert(trackTitles().join() === 'One,Two', `two tracks before exclusion, got ${trackTitles()}`);
  assert(built.fileIds.length === 2, `fileIds lists the files this sync asked about, got ${built.fileIds.length}`);
  db.prepare(`UPDATE audio_file SET excluded = 1 WHERE id = ?`).run(fileId('A/02.mp3'));
  await sync(two);
  assert(trackTitles().join() === 'One', `excluded file's track pruned, got ${trackTitles()}`);
  await sync(two);
  assert(trackTitles().join() === 'One', `excluded file stays out on a later sync, got ${trackTitles()}`);
  assert(db.prepare(`SELECT 1 FROM audio_file WHERE path = ?`).get(p('A/02.mp3')), 'the file row itself stays');
  db.prepare(`UPDATE audio_file SET excluded = 0 WHERE id = ?`).run(fileId('A/02.mp3'));
  await sync(two);
  assert(trackTitles().join() === 'One,Two', `un-excluding brings the track back, got ${trackTitles()}`);
  console.log('ok exclusion');
}

console.log('PASS verify-findings');
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun verify scripts/verify-findings.ts`
Expected: FAIL at type level or runtime: `fileIds` undefined (`built.fileIds.length`) or `no such column: excluded`.

- [ ] **Step 3: Write the migration**

Create `src/lib/server/db/migrations/019_findings.sql`:

```sql
-- A file the user took out of the library from the "needs attention" list
-- (kept another copy, or forgot a missing track). The local result skips it,
-- so the ordinary prune removes its track; the row stays so the decision
-- survives every later sync, and findings ignore it.
ALTER TABLE audio_file ADD COLUMN excluded INTEGER NOT NULL DEFAULT 0;

-- The "needs attention" list. One row per (kind, subject): the subject is a
-- file id for missing and unsupported, and fingerprint + the sorted file ids
-- for a duplicate, so a third copy is a new subject and a new finding.
--   open     raised and waiting for the user
--   settled  the user decided; never reopened for the same subject
--   cleared  the problem went away on its own; reopens if it returns
CREATE TABLE finding (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('missing', 'duplicate', 'unsupported')),
  subject_key   TEXT NOT NULL,
  file_ids      TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'settled', 'cleared')),
  resolution    TEXT,
  raised_run_id TEXT,
  raised_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  settled_at    TEXT,
  cleared_at    TEXT,
  UNIQUE (kind, subject_key)
);
CREATE INDEX finding_state ON finding(state);
```

- [ ] **Step 4: Carry `excluded` through the file list and skip it in the local result**

In `src/lib/server/library/fileList.ts`: add `excluded: boolean;` to `FileRow`, `excluded: number;` to `DbRow`, and `excluded: r.excluded === 1,` to `toFileRow`.

In `src/lib/server/sources/local/localResult.ts`:
- add to `LocalResult`: `/** Every file this sync asked about, excluded ones included (findings filter them). */ fileIds: string[];`
- in the catalog loop: `if (!file || file.excluded || emitted.has(file.id)) continue;`
- in `unlisted`: `.filter((f): f is NonNullable<typeof f> => !!f && !f.excluded && !emitted.has(f.id));`
- return `fileIds: [...new Set([...files.values()].map((f) => f.id))]`.
- add to the doc comment: "A file the user excluded from the needs-attention list is never emitted, so the prune removes its track."

In `src/lib/server/sources/types.ts` add to `SyncResult`: `/** Local source: the file-list ids this sync asked about, for findings. */ fileIds?: string[];`

In `src/lib/server/sources/local/sync.ts`, in the returned result next to `files: built.files,` add `fileIds: built.fileIds,`.

- [ ] **Step 5: Run the test and the neighbours**

Run: `bun verify scripts/verify-findings.ts && bun verify scripts/verify-local-result.ts && bun verify scripts/verify-file-list.ts && bun verify scripts/verify-ingest-run.ts && bun check`
Expected: `ok exclusion`, `PASS verify-findings`, the other three PASS, `bun check` 0 errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/server/db/migrations/019_findings.sql src/lib/server/library/fileList.ts src/lib/server/sources/local/localResult.ts src/lib/server/sources/types.ts src/lib/server/sources/local/sync.ts scripts/verify-findings.ts
git commit -m "feat(library): files can be excluded from the library; findings table (BOO-102)"
```

---

### Task 2: Raising and clearing findings

**Files:**
- Create: `src/lib/server/library/findings.ts`
- Modify: `src/lib/server/library/sync_run.ts` (call after collate for results with fileIds; `SyncRunSummary.findings`)
- Test: `scripts/verify-findings.ts` (append)

**Interfaces:**
- Consumes: `finding` table, `audio_file.excluded`, `SyncResult.fileIds`.
- Produces: `refreshFindings(db: Database, runId: string | null, fileIds: string[]): FindingsSummary`, `FindingsSummary { new: number; cleared: number; open: number }`, `FindingKind`, `FindingState`.

- [ ] **Step 1: Append the failing tests** (before the final `console.log('PASS …')`)

```ts
// --- Task 2: raise, clear, reopen, settled stays settled -------------------
const { refreshFindings } = await import('../src/lib/server/library/findings');
const findings = () => db.prepare(`SELECT kind, state, file_ids FROM finding ORDER BY kind, raised_at`).all() as { kind: string; state: string; file_ids: string }[];
const openOf = (kind: string) => findings().filter((f) => f.kind === kind && f.state === 'open');
{
  // Clean library: nothing to report.
  let built = await sync(two);
  let s = refreshFindings(db, 'run-1', built.fileIds);
  assert(s.new === 0 && s.open === 0, `clean library raises nothing, got ${JSON.stringify(s)}`);

  // A missing file is raised once, not again on the next sync.
  renameSync(p('A/02.mp3'), p('elsewhere-02.mp3'));
  built = await sync(two);
  s = refreshFindings(db, 'run-2', built.fileIds);
  assert(s.new === 1 && openOf('missing').length === 1, `missing raised, got ${JSON.stringify(s)}`);
  built = await sync(two);
  s = refreshFindings(db, 'run-3', built.fileIds);
  assert(s.new === 0 && s.open === 1, `missing not raised twice, got ${JSON.stringify(s)}`);

  // It comes back: clears itself. It goes again: the same row reopens.
  renameSync(p('elsewhere-02.mp3'), p('A/02.mp3'));
  built = await sync(two);
  s = refreshFindings(db, 'run-4', built.fileIds);
  assert(s.cleared === 1 && s.open === 0, `returning file clears, got ${JSON.stringify(s)}`);
  renameSync(p('A/02.mp3'), p('elsewhere-02.mp3'));
  built = await sync(two);
  s = refreshFindings(db, 'run-5', built.fileIds);
  assert(s.new === 1 && findings().filter((f) => f.kind === 'missing').length === 1, `same problem reopens the same row, got ${JSON.stringify(findings())}`);
  renameSync(p('elsewhere-02.mp3'), p('A/02.mp3'));
  refreshFindings(db, 'run-6', (await sync(two)).fileIds);
  console.log('ok missing raise/clear/reopen');

  // Duplicates: a copy of One listed as a third track.
  write('B/01 copy.mp3', 'AUDIO-1', 'One copy');
  const three: Listed[] = [...two, { pid: 'P3', name: 'B/01 copy.mp3', pos: 3, title: 'One copy' }];
  built = await sync(three);
  s = refreshFindings(db, 'run-7', built.fileIds);
  assert(openOf('duplicate').length === 1, `duplicate raised, got ${JSON.stringify(findings())}`);
  const dupId = (db.prepare(`SELECT id FROM finding WHERE kind='duplicate'`).get() as { id: string }).id;

  // Settled stays settled across syncs.
  db.prepare(`UPDATE finding SET state='settled', resolution='keep_both' WHERE id = ?`).run(dupId);
  built = await sync(three);
  s = refreshFindings(db, 'run-8', built.fileIds);
  assert(s.new === 0 && openOf('duplicate').length === 0, `settled duplicate stays settled, got ${JSON.stringify(findings())}`);

  // A third copy is a new circumstance: a new finding; the settled pair stays settled.
  write('C/01 again.mp3', 'AUDIO-1', 'One again');
  const four: Listed[] = [...three, { pid: 'P4', name: 'C/01 again.mp3', pos: 4, title: 'One again' }];
  built = await sync(four);
  s = refreshFindings(db, 'run-9', built.fileIds);
  assert(s.new === 1 && openOf('duplicate').length === 1, `third copy raises a new finding, got ${JSON.stringify(findings())}`);
  assert((db.prepare(`SELECT state FROM finding WHERE id = ?`).get(dupId) as { state: string }).state === 'settled', 'the settled pair stays settled');
  assert((JSON.parse(openOf('duplicate')[0].file_ids) as string[]).length === 3, 'the new finding names all three files');
  console.log('ok duplicate settled/third copy');

  // Unsupported: a file whose tags can't be read.
  write('D/broken.mp3', 'AUDIO-9', 'UNREADABLE');
  const five: Listed[] = [...four, { pid: 'P5', name: 'D/broken.mp3', pos: 5, title: 'Broken' }];
  built = await sync(five);
  s = refreshFindings(db, 'run-10', built.fileIds);
  assert(openOf('unsupported').length === 1, `unsupported raised, got ${JSON.stringify(findings())}`);

  // Excluded files raise nothing: exclude the broken one.
  db.prepare(`UPDATE audio_file SET excluded = 1 WHERE path = ?`).run(p('D/broken.mp3'));
  built = await sync(five);
  s = refreshFindings(db, 'run-11', built.fileIds);
  assert(openOf('unsupported').length === 0, `excluded file's finding clears, got ${JSON.stringify(findings())}`);
  db.prepare(`UPDATE audio_file SET excluded = 0 WHERE path = ?`).run(p('D/broken.mp3'));
  console.log('ok unsupported, excluded ignored');

  // Leave the library as five-listed for Task 3.
  refreshFindings(db, 'run-12', (await sync(five)).fileIds);
}
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun verify scripts/verify-findings.ts`
Expected: FAIL: `Cannot find module '../src/lib/server/library/findings'`.

- [ ] **Step 3: Write `src/lib/server/library/findings.ts`**

```ts
import type { Database } from 'bun:sqlite';
import { ulid } from 'ulid';

/**
 * The "needs attention" list: problems in the local library that need a
 * person. Raised by every local sync, about the files that sync asked about.
 *
 * Booth only ever changes a finding on its own when the problem itself went
 * away (the file came back, the duplicate is gone): that's "cleared", and the
 * same problem returning reopens the same row. What the user settled stays
 * settled for that exact subject. A duplicate's subject includes every file
 * in it, so a third copy is a new finding rather than a reopened one.
 */

export type FindingKind = 'missing' | 'duplicate' | 'unsupported';
export type FindingState = 'open' | 'settled' | 'cleared';

export interface FindingsSummary {
  /** Findings opened (or reopened) by this run. */
  new: number;
  /** Open findings whose problem went away. */
  cleared: number;
  /** Open findings after this run. */
  open: number;
}

interface Problem { kind: FindingKind; key: string; fileIds: string[] }

const now = () => new Date().toISOString();

function currentProblems(db: Database, fileIds: string[]): Problem[] {
  if (fileIds.length === 0) return [];
  db.exec(`CREATE TEMP TABLE IF NOT EXISTS finding_scope (id TEXT PRIMARY KEY)`);
  db.exec(`DELETE FROM finding_scope`);
  const ins = db.prepare(`INSERT OR IGNORE INTO finding_scope (id) VALUES (?)`);
  db.transaction(() => { for (const id of fileIds) ins.run(id); })();

  const rows = db
    .prepare(
      `SELECT f.id, f.present, f.tags IS NULL AS untagged, f.fingerprint
         FROM audio_file f JOIN finding_scope s ON s.id = f.id
        WHERE f.excluded = 0`,
    )
    .all() as { id: string; present: number; untagged: number; fingerprint: string | null }[];

  const problems: Problem[] = [];
  const byPrint = new Map<string, string[]>();
  for (const r of rows) {
    if (r.present === 0) { problems.push({ kind: 'missing', key: r.id, fileIds: [r.id] }); continue; }
    if (r.untagged === 1) problems.push({ kind: 'unsupported', key: r.id, fileIds: [r.id] });
    if (r.fingerprint) byPrint.set(r.fingerprint, [...(byPrint.get(r.fingerprint) ?? []), r.id]);
  }
  for (const [print, ids] of byPrint) {
    if (ids.length < 2) continue;
    const sorted = [...ids].sort();
    problems.push({ kind: 'duplicate', key: `${print}:${sorted.join(',')}`, fileIds: sorted });
  }
  return problems;
}

export function refreshFindings(db: Database, runId: string | null, fileIds: string[]): FindingsSummary {
  const summary: FindingsSummary = { new: 0, cleared: 0, open: 0 };
  const problems = currentProblems(db, fileIds);
  const current = new Set(problems.map((p) => `${p.kind}\u0000${p.key}`));

  const existing = db.prepare(`SELECT id, state FROM finding WHERE kind = ? AND subject_key = ?`);
  const insert = db.prepare(`INSERT INTO finding (id, kind, subject_key, file_ids, raised_run_id) VALUES (?, ?, ?, ?, ?)`);
  const reopen = db.prepare(
    `UPDATE finding SET state = 'open', file_ids = ?, raised_run_id = ?, raised_at = ?, cleared_at = NULL WHERE id = ?`,
  );
  const clear = db.prepare(`UPDATE finding SET state = 'cleared', cleared_at = ? WHERE id = ?`);

  db.transaction(() => {
    for (const p of problems) {
      const row = existing.get(p.kind, p.key) as { id: string; state: FindingState } | null;
      if (!row) {
        insert.run(ulid(), p.kind, p.key, JSON.stringify(p.fileIds), runId);
        summary.new++;
      } else if (row.state === 'cleared') {
        reopen.run(JSON.stringify(p.fileIds), runId, now(), row.id);
        summary.new++;
      }
    }
    const open = db.prepare(`SELECT id, kind, subject_key FROM finding WHERE state = 'open'`).all() as { id: string; kind: string; subject_key: string }[];
    for (const f of open) {
      if (!current.has(`${f.kind}\u0000${f.subject_key}`)) { clear.run(now(), f.id); summary.cleared++; }
    }
  })();

  summary.open = (db.prepare(`SELECT COUNT(*) AS n FROM finding WHERE state = 'open'`).get() as { n: number }).n;
  return summary;
}
```

- [ ] **Step 4: Run the test**

Run: `bun verify scripts/verify-findings.ts`
Expected: `ok exclusion`, `ok missing raise/clear/reopen`, `ok duplicate settled/third copy`, `ok unsupported, excluded ignored`, `PASS verify-findings`.

- [ ] **Step 5: Wire it into the sync run**

In `src/lib/server/library/sync_run.ts`:
- import `refreshFindings, type FindingsSummary` from `./findings`;
- add to `SyncRunSummary`: `/** Needs-attention findings after this run (local source only). */ findings?: FindingsSummary;`
- directly after `if (result.files) summary.files = result.files;` add:

```ts
    // After collate, so a file the user excluded has already lost its track.
    if (result.fileIds) summary.findings = refreshFindings(db, id, result.fileIds);
```

- [ ] **Step 6: Run the suite and commit**

Run: `bun verify scripts/verify-findings.ts && bun verify scripts/verify-local-result.ts && bun verify scripts/verify-stale-input.ts && bun check`
Expected: all PASS, 0 errors.

```bash
git add src/lib/server/library/findings.ts src/lib/server/library/sync_run.ts scripts/verify-findings.ts
git commit -m "feat(library): needs-attention findings raised and cleared by each local sync (BOO-102)"
```

---

### Task 3: Settling findings

**Files:**
- Modify: `src/lib/server/library/findings.ts`
- Test: `scripts/verify-findings.ts` (append)

**Interfaces:**
- Consumes: Task 2's table state; `track.starred_at`, `track.note`; `playlist_track(id, playlist_id, section_id, track_id, …)` with the unique (playlist_id, track_id) member index; `playlist.name`.
- Produces:
  - `type SettleAction = { type: 'keep_both' } | { type: 'keep_one'; fileId: string } | { type: 'leave' } | { type: 'forget' } | { type: 'acknowledge' }`
  - `interface FindingFile { fileId: string; path: string; present: boolean; track: { id: string; title: string; artist: string; album: string | null } | null; starred: boolean; note: string | null; playlists: string[] }`
  - `interface FindingView { id: string; kind: FindingKind; raisedAt: string; files: FindingFile[] }`
  - `listOpenFindings(db): FindingView[]`, `openFindingCount(db): number`
  - `settleFinding(db, id, action): { needsSync: boolean }` (throws `FindingError` with a message on a bad id/action)
  - `settleAllOfKind(db, kind): number` (non-destructive action for that kind)

- [ ] **Step 1: Append the failing tests**

```ts
// --- Task 3: settling --------------------------------------------------------
const { listOpenFindings, settleFinding, settleAllOfKind, openFindingCount } = await import('../src/lib/server/library/findings');
const { createPlaylist, addTrack } = await import('../src/lib/server/library/playlists');
const trackOfPath = (name: string) => (db.prepare(
  `SELECT sl.entity_id AS id FROM source_link sl JOIN audio_file f ON f.id = sl.external_id
    WHERE sl.source = 'local' AND sl.entity_kind = 'track' AND f.path = ?`,
).get(p(name)) as { id: string } | null)?.id ?? null;
{
  const five: Listed[] = [
    ...two,
    { pid: 'P3', name: 'B/01 copy.mp3', pos: 3, title: 'One copy' },
    { pid: 'P4', name: 'C/01 again.mp3', pos: 4, title: 'One again' },
    { pid: 'P5', name: 'D/broken.mp3', pos: 5, title: 'Broken' },
  ];

  // The view names each file and what hangs off its track.
  const original = trackOfPath('A/01.mp3')!;
  const copy = trackOfPath('B/01 copy.mp3')!;
  db.prepare(`UPDATE track SET starred_at = '2026-01-01', note = 'copy note' WHERE id = ?`).run(copy);
  const pl = createPlaylist(db, 'Warmup');
  addTrack(db, pl.id, copy);
  const dup = listOpenFindings(db).find((f) => f.kind === 'duplicate')!;
  const copyFile = dup.files.find((f) => f.path === p('B/01 copy.mp3'))!;
  assert(copyFile.starred && copyFile.note === 'copy note' && copyFile.playlists.join() === 'Warmup', `view shows the copy's annotations, got ${JSON.stringify(copyFile)}`);

  // Keep one: the others leave the library; their star, note and playlist entry move to the kept track.
  const keep = dup.files.find((f) => f.path === p('A/01.mp3'))!.fileId;
  const r = settleFinding(db, dup.id, { type: 'keep_one', fileId: keep });
  assert(r.needsSync, 'keep one asks for a sync so the others leave');
  await sync(five);
  assert(!trackOfPath('B/01 copy.mp3') && !trackOfPath('C/01 again.mp3'), 'the other copies are no longer tracks');
  const kept = db.prepare(`SELECT starred_at, note FROM track WHERE id = ?`).get(original) as { starred_at: string | null; note: string | null };
  assert(kept.starred_at && kept.note === 'copy note', `star and note moved to the kept track, got ${JSON.stringify(kept)}`);
  assert(db.prepare(`SELECT 1 FROM playlist_track WHERE playlist_id = ? AND track_id = ?`).get(pl.id, original), 'playlist entry moved to the kept track');
  let s = refreshFindings(db, 'run-13', (await sync(five)).fileIds);
  assert(s.new === 0 && listOpenFindings(db).every((f) => f.kind !== 'duplicate'), `no duplicate comes back, got ${JSON.stringify(listOpenFindings(db))}`);
  assert(readFileSync(p('B/01 copy.mp3'), 'utf8').startsWith('AUDIO-1'), 'the file itself is untouched');
  console.log('ok keep one');

  // Forget a missing track: it and its playlist entries go; the decision holds.
  renameSync(p('A/02.mp3'), p('gone-02.mp3'));
  refreshFindings(db, 'run-14', (await sync(five)).fileIds);
  const two2 = trackOfPath('A/02.mp3')!;
  addTrack(db, pl.id, two2);
  const missing = listOpenFindings(db).find((f) => f.kind === 'missing')!;
  assert(missing.files[0].playlists.join() === 'Warmup', 'forget shows the playlists first');
  settleFinding(db, missing.id, { type: 'forget' });
  await sync(five);
  assert(!trackOfPath('A/02.mp3'), 'forgotten track is gone');
  assert(!db.prepare(`SELECT 1 FROM playlist_track WHERE playlist_id = ? AND snap_title = 'Two'`).get(pl.id), 'forget removed the playlist entry rather than leaving it for relink');
  s = refreshFindings(db, 'run-15', (await sync(five)).fileIds);
  assert(s.new === 0 && openFindingCount(db) === 1, `forgotten file raises nothing; only unsupported remains, got ${JSON.stringify(listOpenFindings(db))}`);
  console.log('ok forget');

  // Wrong action for the kind is refused.
  const uns = listOpenFindings(db).find((f) => f.kind === 'unsupported')!;
  let refused = false;
  try { settleFinding(db, uns.id, { type: 'forget' }); } catch { refused = true; }
  assert(refused, 'forget is not an action for an unsupported file');

  // Bulk: the non-destructive action, and it says how many.
  assert(settleAllOfKind(db, 'unsupported') === 1, 'bulk acknowledge settles one');
  assert(openFindingCount(db) === 0, 'nothing open after bulk');
  refreshFindings(db, 'run-16', (await sync(five)).fileIds);
  assert(openFindingCount(db) === 0, 'acknowledged stays settled');
  console.log('ok bulk, refusals');
}
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun verify scripts/verify-findings.ts`
Expected: FAIL: `listOpenFindings` is not exported.

- [ ] **Step 3: Implement settling in `findings.ts`**

```ts
export class FindingError extends Error {}

export type SettleAction =
  | { type: 'keep_both' }
  | { type: 'keep_one'; fileId: string }
  | { type: 'leave' }
  | { type: 'forget' }
  | { type: 'acknowledge' };

const ACTIONS: Record<FindingKind, SettleAction['type'][]> = {
  duplicate: ['keep_both', 'keep_one'],
  missing: ['leave', 'forget'],
  unsupported: ['acknowledge'],
};
/** What "settle all like this" does per kind: never anything that removes a track. */
const BULK: Record<FindingKind, SettleAction['type']> = { duplicate: 'keep_both', missing: 'leave', unsupported: 'acknowledge' };

export interface FindingFile {
  fileId: string;
  path: string;
  present: boolean;
  track: { id: string; title: string; artist: string; album: string | null } | null;
  starred: boolean;
  note: string | null;
  playlists: string[];
}
export interface FindingView { id: string; kind: FindingKind; raisedAt: string; files: FindingFile[] }

function trackIdOf(db: Database, fileId: string): string | null {
  const r = db.prepare(`SELECT entity_id FROM source_link WHERE source = 'local' AND entity_kind = 'track' AND external_id = ?`).get(fileId) as { entity_id: string } | null;
  return r?.entity_id ?? null;
}

function fileView(db: Database, fileId: string): FindingFile | null {
  const f = db.prepare(`SELECT id, path, present FROM audio_file WHERE id = ?`).get(fileId) as { id: string; path: string; present: number } | null;
  if (!f) return null;
  const tid = trackIdOf(db, fileId);
  const t = tid
    ? (db.prepare(
        `SELECT track.id, track.title, artist.name AS artist, track.album, track.starred_at, track.note
           FROM track JOIN artist ON artist.id = track.artist_id WHERE track.id = ?`,
      ).get(tid) as { id: string; title: string; artist: string; album: string | null; starred_at: string | null; note: string | null } | null)
    : null;
  const playlists = t
    ? (db.prepare(
        `SELECT DISTINCT pl.name FROM playlist_track pt JOIN playlist pl ON pl.id = pt.playlist_id WHERE pt.track_id = ? ORDER BY pl.name`,
      ).all(t.id) as { name: string }[]).map((r) => r.name)
    : [];
  return {
    fileId: f.id,
    path: f.path,
    present: f.present === 1,
    track: t ? { id: t.id, title: t.title, artist: t.artist, album: t.album } : null,
    starred: !!t?.starred_at,
    note: t?.note ?? null,
    playlists,
  };
}

export function listOpenFindings(db: Database): FindingView[] {
  const rows = db
    .prepare(`SELECT id, kind, raised_at, file_ids FROM finding WHERE state = 'open' ORDER BY kind, raised_at`)
    .all() as { id: string; kind: FindingKind; raised_at: string; file_ids: string }[];
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    raisedAt: r.raised_at,
    files: (JSON.parse(r.file_ids) as string[]).map((id) => fileView(db, id)).filter((f): f is FindingFile => !!f),
  }));
}

export function openFindingCount(db: Database): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM finding WHERE state = 'open'`).get() as { n: number }).n;
}

/** Move what the user put on `from` onto `to`: starred anywhere counts, notes are kept side by side, playlist entries follow. */
function moveAnnotations(db: Database, from: string, to: string): void {
  const a = db.prepare(`SELECT starred_at, note FROM track WHERE id = ?`).get(from) as { starred_at: string | null; note: string | null } | null;
  const b = db.prepare(`SELECT starred_at, note FROM track WHERE id = ?`).get(to) as { starred_at: string | null; note: string | null } | null;
  if (!a || !b) return;
  const note = !a.note ? b.note : !b.note || b.note === a.note ? a.note : `${b.note}\n\n${a.note}`;
  db.prepare(`UPDATE track SET starred_at = COALESCE(starred_at, ?), note = ? WHERE id = ?`).run(a.starred_at, note, to);
  // One entry per track per playlist: where the kept track is already there, the moved entry goes.
  db.prepare(
    `DELETE FROM playlist_track WHERE track_id = ? AND playlist_id IN (SELECT playlist_id FROM playlist_track WHERE track_id = ?)`,
  ).run(from, to);
  db.prepare(`UPDATE playlist_track SET track_id = ? WHERE track_id = ?`).run(to, from);
}

function settle(db: Database, id: string, resolution: string): void {
  db.prepare(`UPDATE finding SET state = 'settled', resolution = ?, settled_at = ? WHERE id = ?`).run(resolution, now(), id);
}

export function settleFinding(db: Database, id: string, action: SettleAction): { needsSync: boolean } {
  const f = db.prepare(`SELECT kind, state, file_ids FROM finding WHERE id = ?`).get(id) as { kind: FindingKind; state: FindingState; file_ids: string } | null;
  if (!f) throw new FindingError(`no such finding: ${id}`);
  if (f.state !== 'open') throw new FindingError('this finding is no longer open');
  if (!ACTIONS[f.kind].includes(action.type)) throw new FindingError(`${action.type} doesn't apply to a ${f.kind} finding`);
  const fileIds = JSON.parse(f.file_ids) as string[];
  const exclude = db.prepare(`UPDATE audio_file SET excluded = 1 WHERE id = ?`);

  let needsSync = false;
  db.transaction(() => {
    if (action.type === 'keep_one') {
      if (!fileIds.includes(action.fileId)) throw new FindingError('that file is not part of this finding');
      const keptTrack = trackIdOf(db, action.fileId);
      for (const other of fileIds) {
        if (other === action.fileId) continue;
        const from = trackIdOf(db, other);
        if (from && keptTrack && from !== keptTrack) moveAnnotations(db, from, keptTrack);
        exclude.run(other);
      }
      settle(db, id, `keep_one:${action.fileId}`);
      needsSync = true;
    } else if (action.type === 'forget') {
      const tid = trackIdOf(db, fileIds[0]);
      // The user saw these entries before confirming; left in place, the
      // relinker would re-attach them by name to some other track.
      if (tid) db.prepare(`DELETE FROM playlist_track WHERE track_id = ?`).run(tid);
      exclude.run(fileIds[0]);
      settle(db, id, 'forget');
      needsSync = true;
    } else {
      settle(db, id, action.type);
    }
  })();
  return { needsSync };
}

/** "Settle all like this": the kind's non-destructive action on every open finding of that kind. Returns how many. */
export function settleAllOfKind(db: Database, kind: FindingKind): number {
  const res = db
    .prepare(`UPDATE finding SET state = 'settled', resolution = ?, settled_at = ? WHERE kind = ? AND state = 'open'`)
    .run(BULK[kind], now(), kind);
  return res.changes;
}
```

- [ ] **Step 4: Run the test**

Run: `bun verify scripts/verify-findings.ts`
Expected: all `ok …` lines including `ok keep one`, `ok forget`, `ok bulk, refusals`, then `PASS verify-findings`. If the relinker re-attaches a forgotten entry, the forget check fails: fix in `settleFinding`, not the test.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/library/findings.ts scripts/verify-findings.ts
git commit -m "feat(library): settle findings: keep both/one, leave, forget, acknowledge, bulk (BOO-102)"
```

---

### Task 4: Missing files aren't playable (BOO-67)

**Files:**
- Modify: `src/lib/server/library/queries.ts` (three `canPlay` sites: `listTracks`, release detail, `getTracksByIds`)
- Test: `scripts/verify-findings.ts` (append)

**Interfaces:**
- Produces: `missingFileTrackIds(db: Database, trackIds: string[]): Set<string>` exported from `queries.ts`.

- [ ] **Step 1: Append the failing test**

```ts
// --- Task 4: a missing file isn't playable ----------------------------------
const { getTracksByIds, listTracks } = await import('../src/lib/server/library/queries');
{
  const five: Listed[] = [
    ...two,
    { pid: 'P3', name: 'B/01 copy.mp3', pos: 3, title: 'One copy' },
    { pid: 'P4', name: 'C/01 again.mp3', pos: 4, title: 'One again' },
    { pid: 'P5', name: 'D/broken.mp3', pos: 5, title: 'Broken' },
  ];
  const one = trackOfPath('A/01.mp3')!;
  assert(getTracksByIds(db, [one]).get(one)!.canPlay, 'present file plays');
  renameSync(p('A/01.mp3'), p('gone-01.mp3'));
  await sync(five);
  assert(!getTracksByIds(db, [one]).get(one)!.canPlay, 'missing file: not playable (by id)');
  const listed = listTracks(db, { limit: 50, offset: 0 } as Parameters<typeof listTracks>[1]).items.find((t) => t.id === one)!;
  assert(!listed.canPlay, 'missing file: not playable (track list)');
  renameSync(p('gone-01.mp3'), p('A/01.mp3'));
  await sync(five);
  assert(getTracksByIds(db, [one]).get(one)!.canPlay, 'file back: playable again');
  console.log('ok missing not playable');
}
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun verify scripts/verify-findings.ts`
Expected: FAIL `missing file: not playable (by id)`.

- [ ] **Step 3: Implement**

In `queries.ts`, below `playableSources`:

```ts
/**
 * Tracks whose local file is known to be missing. canPlay used to come only
 * from having a playable source, so a deleted file kept a play button that
 * failed on click (BOO-67). The file list already knows; this asks it.
 */
export function missingFileTrackIds(db: Database, trackIds: string[]): Set<string> {
  if (trackIds.length === 0) return new Set();
  const rows = db
    .prepare(
      `SELECT sl.entity_id AS id FROM source_link sl JOIN audio_file f ON f.id = sl.external_id
        WHERE sl.source = 'local' AND sl.entity_kind = 'track' AND f.present = 0
          AND sl.entity_id IN (${trackIds.map(() => '?').join(',')})`,
    )
    .all(...trackIds) as { id: string }[];
  return new Set(rows.map((r) => r.id));
}
```

At each of the three sites, compute `const missing = missingFileTrackIds(db, <the ids in scope>);` next to the bpm map, and change `canPlay: sources.some((s) => playableSources.has(s)),` to `canPlay: sources.some((s) => playableSources.has(s)) && !missing.has(<row id>),`.

- [ ] **Step 4: Run tests and commit**

Run: `bun verify scripts/verify-findings.ts && bun verify scripts/verify-queries.ts && bun verify scripts/verify-playlists.ts && bun check`
Expected: all PASS, 0 errors.

```bash
git add src/lib/server/library/queries.ts scripts/verify-findings.ts
git commit -m "fix(library): tracks whose file is missing aren't playable (BOO-67)"
```

---

### Task 5: API and the Needs attention view

**Files:**
- Create: `src/routes/api/attention/+server.ts`, `src/routes/api/attention/[id]/+server.ts`, `src/routes/api/attention/bulk/+server.ts`
- Create: `src/lib/components/AttentionView.svelte`
- Modify: `src/lib/components/Rail.svelte`, `src/lib/components/DesktopShell.svelte`, `src/lib/stores/explorerController.svelte.ts`, `src/lib/components/SyncRunHistory.svelte`

**Interfaces:**
- Consumes: Task 3's `listOpenFindings`, `openFindingCount`, `settleFinding`, `settleAllOfKind`, `FindingError`; `runSync(db, 'local')`.
- Produces: `GET /api/attention` → `{ open: number; findings: FindingView[] }`; `POST /api/attention/[id]` body `SettleAction` → `{ ok: true; synced: boolean }` (400 with message on `FindingError`); `POST /api/attention/bulk` body `{ kind }` → `{ settled: number }`. Nav value `{ section: 'library', item: 'attention' }`.

- [ ] **Step 1: The routes**

`src/routes/api/attention/+server.ts`:

```ts
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { listOpenFindings, openFindingCount } from '$lib/server/library/findings';

export const GET: RequestHandler = async ({ url }) => {
  const db = getDb();
  if (url.searchParams.get('count') === '1') return json({ open: openFindingCount(db) });
  const findings = listOpenFindings(db);
  return json({ open: findings.length, findings });
};
```

`src/routes/api/attention/[id]/+server.ts`:

```ts
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { FindingError, settleFinding, type SettleAction } from '$lib/server/library/findings';
import { runSync } from '$lib/server/library/sync_run';

export const POST: RequestHandler = async ({ params, request }) => {
  const db = getDb();
  const action = (await request.json()) as SettleAction;
  let needsSync: boolean;
  try {
    ({ needsSync } = settleFinding(db, params.id, action));
  } catch (e) {
    if (e instanceof FindingError) throw error(400, e.message);
    throw e;
  }
  // Keep-one and forget take effect through the sync's prune (~1s).
  if (needsSync) await runSync(db, 'local');
  return json({ ok: true, synced: needsSync });
};
```

`src/routes/api/attention/bulk/+server.ts`:

```ts
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { settleAllOfKind, type FindingKind } from '$lib/server/library/findings';

const KINDS: FindingKind[] = ['missing', 'duplicate', 'unsupported'];

export const POST: RequestHandler = async ({ request }) => {
  const { kind } = (await request.json()) as { kind: FindingKind };
  if (!KINDS.includes(kind)) throw error(400, `unknown kind: ${kind}`);
  return json({ settled: settleAllOfKind(getDb(), kind) });
};
```

- [ ] **Step 2: The view** — `src/lib/components/AttentionView.svelte`

```svelte
<script lang="ts">
  import { onMount } from 'svelte';
  import { toast } from '$lib/stores/toast.svelte';

  type Kind = 'missing' | 'duplicate' | 'unsupported';
  interface FFile {
    fileId: string; path: string; present: boolean;
    track: { id: string; title: string; artist: string; album: string | null } | null;
    starred: boolean; note: string | null; playlists: string[];
  }
  interface Finding { id: string; kind: Kind; raisedAt: string; files: FFile[] }

  let { onChanged }: { onChanged?: () => void } = $props();

  let findings = $state<Finding[]>([]);
  let loaded = $state(false);
  let busy = $state<string | null>(null);
  /** The destructive action waiting for a second click: finding id + action. */
  let confirming = $state<{ id: string; type: 'keep_one' | 'forget'; fileId?: string } | null>(null);
  let confirmingBulk = $state<Kind | null>(null);

  const KINDS: { kind: Kind; title: string; detail: string; bulk: string }[] = [
    { kind: 'missing', title: 'Missing files', detail: 'Music.app lists these, but the file isn’t on disk. Putting the file back, or fixing it in Music.app, clears it.', bulk: 'Leave all as they are' },
    { kind: 'duplicate', title: 'Duplicates', detail: 'The same audio in more than one file. Same recording on an album and a compilation can be fine.', bulk: 'Keep all copies' },
    { kind: 'unsupported', title: 'Unsupported files', detail: 'Booth can’t read these files’ tags. They stay listed in their source.', bulk: 'Acknowledge all' },
  ];
  const groups = $derived(KINDS.map((k) => ({ ...k, items: findings.filter((f) => f.kind === k.kind) })).filter((g) => g.items.length));

  async function load() {
    const res = await fetch('/api/attention');
    findings = (await res.json()).findings;
    loaded = true;
  }
  onMount(load);

  async function settle(id: string, body: Record<string, unknown>) {
    busy = id;
    confirming = null;
    try {
      const res = await fetch(`/api/attention/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) { toast.show((await res.text()) || 'Couldn’t settle that', { kind: 'error' }); return; }
      await load();
      onChanged?.();
    } finally {
      busy = null;
    }
  }

  async function settleAll(kind: Kind) {
    confirmingBulk = null;
    const res = await fetch('/api/attention/bulk', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind }) });
    if (!res.ok) { toast.show('Couldn’t settle those', { kind: 'error' }); return; }
    const { settled } = await res.json();
    toast.show(`Settled ${settled}`, { kind: 'success' });
    await load();
    onChanged?.();
  }

  /** What leaves with a track, in words, for the confirmation. */
  function losses(f: FFile): string {
    const parts: string[] = [];
    if (f.starred) parts.push('its star');
    if (f.note) parts.push('its note');
    if (f.playlists.length) parts.push(`its place in ${f.playlists.join(', ')}`);
    return parts.length ? parts.join(', ') : 'nothing you added';
  }
  function fileName(path: string): string { return path.split('/').slice(-3).join('/'); }
</script>

<div class="attention">
  {#if loaded && groups.length === 0}
    <div class="empty">Nothing needs attention.</div>
  {/if}
  {#each groups as g (g.kind)}
    <section class="group">
      <header>
        <h2>{g.title} <span class="n">{g.items.length}</span></h2>
        {#if confirmingBulk === g.kind}
          <span class="confirm">{g.bulk}: {g.items.length} {g.items.length === 1 ? 'item' : 'items'}?
            <button class="primary" onclick={() => settleAll(g.kind)}>Yes</button>
            <button onclick={() => (confirmingBulk = null)}>Cancel</button></span>
        {:else}
          <button onclick={() => (confirmingBulk = g.kind)}>{g.bulk}</button>
        {/if}
      </header>
      <p class="detail">{g.detail}</p>
      {#each g.items as f (f.id)}
        <div class="finding" class:busy={busy === f.id}>
          {#each f.files as file (file.fileId)}
            <div class="file">
              <div class="what">
                {#if file.track}<span class="title">{file.track.title}</span> <span class="sub">— {file.track.artist}{file.track.album ? ` · ${file.track.album}` : ''}</span>{/if}
                {#if file.starred}<span class="tag">★</span>{/if}
                {#if file.note}<span class="tag" title={file.note}>note</span>{/if}
                {#if file.playlists.length}<span class="tag" title={file.playlists.join(', ')}>{file.playlists.length} playlist{file.playlists.length === 1 ? '' : 's'}</span>{/if}
                <div class="path" title={file.path}>{fileName(file.path)}</div>
              </div>
              {#if f.kind === 'duplicate'}
                {#if confirming?.id === f.id && confirming.fileId === file.fileId}
                  <span class="confirm">Keep only this one? The others leave the library (their files stay on disk); their stars, notes and playlist places move here.
                    <button class="primary" onclick={() => settle(f.id, { type: 'keep_one', fileId: file.fileId })}>Keep this one</button>
                    <button onclick={() => (confirming = null)}>Cancel</button></span>
                {:else}
                  <button onclick={() => (confirming = { id: f.id, type: 'keep_one', fileId: file.fileId })}>Keep only this</button>
                {/if}
              {/if}
            </div>
          {/each}
          <div class="actions">
            {#if f.kind === 'duplicate'}
              <button onclick={() => settle(f.id, { type: 'keep_both' })}>Keep all</button>
            {:else if f.kind === 'missing'}
              <button onclick={() => settle(f.id, { type: 'leave' })}>Leave it</button>
              {#if confirming?.id === f.id && confirming.type === 'forget'}
                <span class="confirm">Forget this track? It goes with {losses(f.files[0])}.
                  <button class="danger" onclick={() => settle(f.id, { type: 'forget' })}>Forget</button>
                  <button onclick={() => (confirming = null)}>Cancel</button></span>
              {:else}
                <button onclick={() => (confirming = { id: f.id, type: 'forget' })}>Forget the track…</button>
              {/if}
            {:else}
              <button onclick={() => settle(f.id, { type: 'acknowledge' })}>Acknowledge</button>
            {/if}
          </div>
        </div>
      {/each}
    </section>
  {/each}
</div>

<style>
  .attention { padding: 16px 20px; overflow-y: auto; height: 100%; }
  .empty { color: var(--text-subtle); padding: 40px 0; text-align: center; }
  .group { margin-bottom: 28px; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  h2 { font-size: 14px; font-weight: 600; margin: 0; }
  .n { color: var(--text-subtle); font-weight: 400; margin-left: 4px; }
  .detail { color: var(--text-subtle); font-size: 12px; margin: 4px 0 10px; }
  .finding { border: 1px solid var(--border); border-radius: 4px; padding: 8px 10px; margin-bottom: 8px; }
  .finding.busy { opacity: 0.5; pointer-events: none; }
  .file { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 4px 0; }
  .file + .file { border-top: 1px dashed var(--border); }
  .what { min-width: 0; font-size: 13px; }
  .title { font-weight: 500; }
  .sub { color: var(--text-subtle); }
  .tag { font-size: 11px; color: var(--accent); margin-left: 6px; }
  .path { font-size: 11px; color: var(--text-subtle); font-family: ui-monospace, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .actions { display: flex; gap: 8px; align-items: center; margin-top: 6px; flex-wrap: wrap; }
  .confirm { font-size: 12px; display: inline-flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  button { background: var(--bg-raised); border: 1px solid var(--border-strong); color: var(--text); border-radius: 3px; padding: 3px 8px; font: inherit; font-size: 12px; cursor: pointer; white-space: nowrap; }
  button:hover { background: var(--bg-row-hover); }
  button.primary { border-color: var(--accent); color: var(--accent); }
  button.danger { border-color: var(--danger); color: var(--danger); }
</style>
```

- [ ] **Step 3: Rail, shell, controller**

- `explorerController.svelte.ts`: add `attention: 0` to `counts`; in `loadSourcesAndCounts`, add `fetch('/api/attention?count=1').then((r) => r.json())` to the `Promise.all` and set `attention: att.open ?? 0`. Expose a `reloadCounts` (or reuse the existing function name if one is exported) for the view's `onChanged`. In `loadList`, return early when `explorerState.nav.section === 'library' && explorerState.nav.item === 'attention'` (the view loads its own data).
- `Rail.svelte`: add `attention?: number` to `Counts`; after the Untagged button, render a "Needs attention" item with the count when `(counts.attention ?? 0) > 0 || isActive('library', 'attention')`, selecting `{ section: 'library', item: 'attention' }`.
- `DesktopShell.svelte`: in `<section class="middle">`, add a branch before the toolbar: `{:else if explorerState.nav.section === 'library' && explorerState.nav.item === 'attention'} <AttentionView onChanged={c.reloadCounts} />`, and import it. The right-hand detail pane shows nothing for this view (same as the no-detail playlist layout: add `|| isAttention` to the `no-detail` class condition).
- `SyncRunHistory.svelte`: add `findings?: { new: number; cleared: number; open: number }` to the summary type and render a muted line `"{n} new to review"` (warn styling when `new > 0`) alongside the ingest line; nothing when `new === 0 && cleared === 0`.

- [ ] **Step 4: Check and drive it**

Run: `bun check`
Expected: 0 errors.

On a throwaway server against a copy (never the real DB):

```bash
sqlite3 ~/.booth/booth.db ".backup '$SCRATCH/attention.db'"
BOOTH_DB_PATH=$SCRATCH/attention.db BOOTH_INBOX_PATH=$SCRATCH/inbox bunx --bun vite dev --port 5197
```

Trigger a local sync on it (`POST /api/sources/local/sync` or the Sync button), then check by API and in the browser (CDP harness or Claude in Chrome):
- `GET /api/attention?count=1` returns the open count (expected on the current library: 4 missing + 22 duplicates = 26).
- The rail shows "Needs attention 26"; the view lists both groups with paths and annotations.
- "Keep all" on one duplicate drops the count to 25 and it stays settled after another sync.
- A missing track shows dimmed / unplayable in its release detail.
Kill only the 5197 PID afterwards.

- [ ] **Step 5: Commit**

```bash
git add src/routes/api/attention src/lib/components/AttentionView.svelte src/lib/components/Rail.svelte src/lib/components/DesktopShell.svelte src/lib/stores/explorerController.svelte.ts src/lib/components/SyncRunHistory.svelte
git commit -m "feat(ui): Needs attention view, rail count, sync history line (BOO-102)"
```

---

### Task 6: Real-library probe and context

**Files:**
- Create: `scripts/probe-findings.ts`
- Modify: `docs/CONTEXT.md`

- [ ] **Step 1: Write the probe**

```ts
/**
 * probe-findings.ts: what the needs-attention list says about the real
 * library, on a backup copy. Never writes the real database or any file.
 *
 * Run: bun verify scripts/probe-findings.ts
 * Exit 1 if: a track was deleted, the second sync raised anything new, or the
 * counts are far from what's known (missing and duplicate counts printed).
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'booth-findings-'));
const copy = join(scratch, 'booth.db');
const proc = Bun.spawnSync(['sqlite3', join(homedir(), '.booth', 'booth.db'), `.backup '${copy}'`]);
if (proc.exitCode !== 0) throw new Error(`backup failed: ${proc.stderr.toString()}`);
process.env.BOOTH_DB_PATH = copy;
process.env.BOOTH_INBOX_PATH = join(scratch, 'inbox');
mkdirSync(process.env.BOOTH_INBOX_PATH);

const { getDb } = await import('../src/lib/server/db');
const { collate } = await import('../src/lib/server/library/collate');
const { syncITunesLibrary } = await import('../src/lib/server/sources/local/sync');
const { refreshFindings, listOpenFindings } = await import('../src/lib/server/library/findings');

const db = getDb();
const recordingsRoot = join(homedir(), '.booth', 'recordings');
const tracks = () => (db.prepare(`SELECT COUNT(*) AS n FROM track`).get() as { n: number }).n;

const before = tracks();
let bad = 0;
for (const run of ['first', 'second']) {
  const r = await syncITunesLibrary();
  const c = collate(db, 'local', r, { recordingsRoot });
  const s = refreshFindings(db, `probe-${run}`, r.fileIds ?? []);
  console.log(`${run}: ${JSON.stringify(s)} tracksDeleted=${c.tracksDeleted}`);
  if (c.tracksDeleted) bad++;
  if (run === 'second' && s.new) { console.log('✗ second sync raised new findings'); bad++; }
}
const open = listOpenFindings(db);
const byKind = Object.groupBy(open, (f) => f.kind);
for (const [kind, items] of Object.entries(byKind)) {
  console.log(`${kind}: ${items!.length}`);
  for (const f of items!.slice(0, 3)) console.log(`   ${f.files.map((x) => x.path.split('/').slice(-2).join('/')).join('  |  ')}`);
}
if (tracks() !== before) { console.log(`✗ track count ${before} → ${tracks()}`); bad++; }
console.log(`copy kept at ${copy}`);
process.exit(bad ? 1 : 0);
```

- [ ] **Step 2: Run it**

Run: `bun verify scripts/probe-findings.ts`
Expected: first run `new` = 26 (4 missing, 22 duplicate, 0 unsupported, as counted on 2026-11-02; the spec's "9 missing" predates Music.app dropping the Bale Defoe album), second run `new` 0, tracksDeleted 0, exit 0. Different counts are not a failure by themselves: compare against `sqlite3 -readonly ~/.booth/booth.db` counts of `present=0` linked files and fingerprint groups, and explain any gap before continuing.

- [ ] **Step 3: Context doc**

In `docs/CONTEXT.md`, after "The file list" bullet, add a bullet "The needs-attention list (migration step 2, 2026-11)": findings table and its three states; raised by each local sync over the files that sync asked about; settled stays settled per subject, a third copy is a new subject; keep-one/forget work by excluding the file so the prune removes the track; bulk is non-destructive only; missing files make a track unplayable (BOO-67); "point Booth at it" deferred to folder sources / takeover.

- [ ] **Step 4: Full suite and commit**

Run every verify script touched by this plan plus `bun check`:
`bun verify scripts/verify-findings.ts && bun verify scripts/verify-local-result.ts && bun verify scripts/verify-file-list.ts && bun verify scripts/verify-ingest-run.ts && bun verify scripts/verify-queries.ts && bun verify scripts/verify-playlists.ts && bun verify scripts/verify-relink.ts && bun check`
Expected: all PASS, 0 errors.

```bash
git add scripts/probe-findings.ts docs/CONTEXT.md
git commit -m "test(library): real-library probe for the needs-attention list (BOO-102)"
```
