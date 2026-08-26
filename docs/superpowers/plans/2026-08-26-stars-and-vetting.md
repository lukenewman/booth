# Stars + Vetting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user work through the collection release-by-release, starring the tracks that earn it and marking each release vetted, with a queue view that shows how much is left.

**Architecture:** Two nullable timestamp columns on existing entity tables (`track.starred_at`, `release.vetted_at`), a small server module wrapping them, two filter flags threaded through the existing list queries, two REST routes, and star/vet affordances across the existing list and detail components. No new tables, no source-adapter involvement — these are Booth-native annotations like playlists.

**Tech Stack:** Bun + `bun:sqlite`, SvelteKit 2, Svelte 5 runes, TypeScript.

**Spec:** `docs/superpowers/specs/2026-08-26-stars-and-vetting-design.md`

## Global Constraints

- **Bun runtime is mandatory.** The DB layer is `bun:sqlite`. Verification scripts run as `bun verify scripts/<name>.ts` (the `verify` package script is literally `bun`).
- **No test framework exists.** The house pattern is a standalone `scripts/verify-*.ts` that builds an in-memory DB, runs migrations, seeds fixtures, and `process.exit(1)`s on a failed assertion. Model new scripts on `scripts/verify-playlists.ts`.
- **Type-check with `bun check`** after every task that touches TypeScript or Svelte.
- **Vocabulary is "vetted"**, in both the schema and the UI. Never "reviewed", "ingested", or "processed".
- **Keys:** `s` = toggle star on selected row (opens the scanner in Add → Discogs only); `v` = mark vetted + advance. Never `f`.
- **Annotations must not touch** `source_link` / `source_facets` / `match_key`, and must not bump `updated_at` on the entity — that column tracks source-data freshness, not user judgment.
- **Work directly on `main`.** Commit at the end of each task. No worktrees, no PRs.
- **Migration number is `009`.** The highest existing is `008_playlist_cover.sql`.

---

### Task 1: Schema + annotations module

**Files:**
- Create: `src/lib/server/db/migrations/009_stars.sql`
- Create: `src/lib/server/library/annotations.ts`
- Test: `scripts/verify-stars.ts`

**Interfaces:**
- Consumes: `runMigrations` from `src/lib/server/db/migrate.ts`.
- Produces:
  - `setTrackStar(db: Database, trackId: string, starred: boolean): { starredAt: string | null }`
  - `setReleaseVetted(db: Database, releaseId: string, vetted: boolean): { vettedAt: string | null }`
  - `countStarredByRelease(db: Database, releaseIds: string[]): Map<string, number>`

- [ ] **Step 1: Write the migration**

Create `src/lib/server/db/migrations/009_stars.sql`:

```sql
-- Booth-native annotations: the user's own judgments about their collection.
-- Like playlists, these never touch source_link / source_facets / match_key.
-- Unlike playlists they need no join table — a star is strictly 1:1 with its
-- track, and vetted-ness 1:1 with its release — so they are columns here.
--
-- Timestamps rather than booleans: truthiness is `IS NOT NULL` (identical cost
-- to a 0/1 check) but the column also answers "what did I star recently" and
-- "when did I go through this record". A boolean discards that for no saving.
--
-- `vetted_at` records that the user listened through a release and made their
-- calls. It cannot be derived from "has starred tracks": that would conflate
-- "not listened to yet" with "listened to and nothing made the cut", and would
-- permanently re-surface every record already dismissed.

ALTER TABLE track   ADD COLUMN starred_at TEXT;  -- ISO8601; NULL = not starred
ALTER TABLE release ADD COLUMN vetted_at  TEXT;  -- ISO8601; NULL = not vetted

-- Partial: the starred set stays small against ~5,700 tracks and the vetted set
-- grows from zero, so each index stays proportional to the data that exists
-- rather than to the table it hangs off.
CREATE INDEX idx_track_starred  ON track(starred_at)   WHERE starred_at IS NOT NULL;
CREATE INDEX idx_release_vetted ON release(vetted_at)  WHERE vetted_at  IS NOT NULL;
```

- [ ] **Step 2: Write the failing verification script**

Create `scripts/verify-stars.ts`:

```ts
import { Database } from 'bun:sqlite';
import { ulid } from 'ulid';
import { runMigrations } from '../src/lib/server/db/migrate';
import {
  setTrackStar,
  setReleaseVetted,
  countStarredByRelease,
} from '../src/lib/server/library/annotations';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) fail(msg);
}

const db = new Database(':memory:');
db.exec('PRAGMA foreign_keys = ON');
runMigrations(db);

const artistId = ulid();
db.prepare(`INSERT INTO artist (id, name) VALUES (?, ?)`).run(artistId, 'Test Artist');

const relId = ulid();
db.prepare(
  `INSERT INTO release (id, title, artist_id, year) VALUES (?, ?, ?, ?)`,
).run(relId, 'Test Release', artistId, 1994);

const t1 = ulid();
const t2 = ulid();
for (const [id, title, pos] of [[t1, 'Track One', 'A1'], [t2, 'Track Two', 'A2']] as const) {
  db.prepare(
    `INSERT INTO track (id, title, artist_id, album, duration_ms, release_id, position)
       VALUES (?, ?, ?, 'Test Release', 60000, ?, ?)`,
  ).run(id, title, artistId, relId, pos);
}

// --- columns exist and default to NULL -------------------------------------
const fresh = db.prepare(`SELECT starred_at FROM track WHERE id = ?`).get(t1) as {
  starred_at: string | null;
};
assert(fresh.starred_at === null, 'new track should start unstarred');

// --- star / unstar ----------------------------------------------------------
const starred = setTrackStar(db, t1, true);
assert(typeof starred.starredAt === 'string', 'starring should return a timestamp');
assert(
  /^\d{4}-\d{2}-\d{2}T/.test(starred.starredAt!),
  `starredAt should be ISO8601, got ${starred.starredAt}`,
);

const unstarred = setTrackStar(db, t1, false);
assert(unstarred.starredAt === null, 'unstarring should return null');

// --- re-starring preserves the original timestamp ---------------------------
// "When did I first star this" must stay honest if the UI ever double-fires.
const first = setTrackStar(db, t1, true).starredAt;
const second = setTrackStar(db, t1, true).starredAt;
assert(first === second, `re-star should preserve timestamp: ${first} vs ${second}`);

// --- annotations must not bump updated_at -----------------------------------
// updated_at tracks source-data freshness, not user judgment.
const beforeUpd = (
  db.prepare(`SELECT updated_at FROM track WHERE id = ?`).get(t2) as { updated_at: string }
).updated_at;
setTrackStar(db, t2, true);
const afterUpd = (
  db.prepare(`SELECT updated_at FROM track WHERE id = ?`).get(t2) as { updated_at: string }
).updated_at;
assert(beforeUpd === afterUpd, 'starring must not bump track.updated_at');

// --- vetting ----------------------------------------------------------------
const vetted = setReleaseVetted(db, relId, true);
assert(typeof vetted.vettedAt === 'string', 'vetting should return a timestamp');
assert(setReleaseVetted(db, relId, false).vettedAt === null, 'unvetting should return null');

// A release with zero starred tracks can still be vetted — the whole point of
// storing the flag rather than deriving it.
setTrackStar(db, t1, false);
setTrackStar(db, t2, false);
setReleaseVetted(db, relId, true);
const vettedNoStars = db
  .prepare(`SELECT vetted_at FROM release WHERE id = ?`)
  .get(relId) as { vetted_at: string | null };
assert(vettedNoStars.vetted_at !== null, 'a release with no starred tracks must stay vettable');

// --- countStarredByRelease --------------------------------------------------
setTrackStar(db, t1, true);
const counts = countStarredByRelease(db, [relId]);
assert(counts.get(relId) === 1, `expected 1 starred track, got ${counts.get(relId)}`);

setTrackStar(db, t2, true);
assert(countStarredByRelease(db, [relId]).get(relId) === 2, 'expected 2 starred tracks');

assert(countStarredByRelease(db, []).size === 0, 'empty id list should return an empty map');

const unknown = countStarredByRelease(db, [ulid()]);
assert(unknown.size === 0, 'unknown release id should not appear in the map');

// --- star follows the track row on delete -----------------------------------
db.prepare(`DELETE FROM track WHERE id = ?`).run(t2);
assert(countStarredByRelease(db, [relId]).get(relId) === 1, 'deleting a track drops its star');

console.log('OK: verify-stars');
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `bun verify scripts/verify-stars.ts`
Expected: FAIL — the module does not exist yet, so the import throws `Cannot find module '../src/lib/server/library/annotations'`.

- [ ] **Step 4: Write the annotations module**

Create `src/lib/server/library/annotations.ts`:

```ts
import type { Database } from 'bun:sqlite';

/**
 * Booth-native annotations: the user's own judgments about their collection.
 *
 * These deliberately do NOT bump `updated_at` on the entity — that column
 * tracks how fresh the source-derived data is, and starring a track tells you
 * nothing about that. Nor do they touch source_link / source_facets /
 * match_key, which are for external-source ingestion only.
 */

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;

export function setTrackStar(
  db: Database,
  trackId: string,
  starred: boolean,
): { starredAt: string | null } {
  // COALESCE on the set path so a double-fire from the UI can't rewrite the
  // original timestamp — "when did I first star this" stays answerable.
  db.prepare(
    starred
      ? `UPDATE track SET starred_at = COALESCE(starred_at, ${NOW}) WHERE id = ?`
      : `UPDATE track SET starred_at = NULL WHERE id = ?`,
  ).run(trackId);

  const row = db.prepare(`SELECT starred_at FROM track WHERE id = ?`).get(trackId) as
    | { starred_at: string | null }
    | undefined;
  return { starredAt: row?.starred_at ?? null };
}

export function setReleaseVetted(
  db: Database,
  releaseId: string,
  vetted: boolean,
): { vettedAt: string | null } {
  db.prepare(
    vetted
      ? `UPDATE release SET vetted_at = COALESCE(vetted_at, ${NOW}) WHERE id = ?`
      : `UPDATE release SET vetted_at = NULL WHERE id = ?`,
  ).run(releaseId);

  const row = db.prepare(`SELECT vetted_at FROM release WHERE id = ?`).get(releaseId) as
    | { vetted_at: string | null }
    | undefined;
  return { vettedAt: row?.vetted_at ?? null };
}

/**
 * Starred-track counts for a page of releases, in one round-trip.
 *
 * This is what replaces a stored release star: a release-level star would be
 * ambiguous between "front-to-back keeper" and "contains starred tracks", and
 * the second is derivable — so we derive it and don't store either.
 *
 * Releases with no starred tracks are absent from the map, not zero-valued.
 */
export function countStarredByRelease(
  db: Database,
  releaseIds: string[],
): Map<string, number> {
  const out = new Map<string, number>();
  if (releaseIds.length === 0) return out;

  const placeholders = releaseIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT release_id, COUNT(*) AS n
         FROM track
        WHERE starred_at IS NOT NULL
          AND release_id IN (${placeholders})
        GROUP BY release_id`,
    )
    .all(...releaseIds) as { release_id: string; n: number }[];

  for (const r of rows) out.set(r.release_id, r.n);
  return out;
}
```

- [ ] **Step 5: Run the verification to confirm it passes**

Run: `bun verify scripts/verify-stars.ts`
Expected: `OK: verify-stars`

- [ ] **Step 6: Type-check**

Run: `bun check`
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/server/db/migrations/009_stars.sql src/lib/server/library/annotations.ts scripts/verify-stars.ts
git commit -m "feat(db): starred_at on track, vetted_at on release"
```

---

### Task 2: Query filters and row fields

**Files:**
- Modify: `src/lib/server/library/queries.ts`
- Test: `scripts/verify-stars.ts` (extend)

**Interfaces:**
- Consumes: `countStarredByRelease` from Task 1.
- Produces:
  - `TrackFilterArgs` gains `starred?: boolean`
  - `ListReleasesArgs` gains `vetted?: boolean`
  - `TrackRow` gains `starred_at: string | null`
  - `ReleaseRow` gains `vetted_at: string | null`; release list items gain `starredCount: number`

- [ ] **Step 1: Extend the verification script**

Append to `scripts/verify-stars.ts`, immediately before the final `console.log`:

```ts
// --- query filters ----------------------------------------------------------
const { listReleases, listTracks, listTrackIds } = await import(
  '../src/lib/server/library/queries'
);

// Seed a second release so the filters have something to exclude.
const rel2 = ulid();
db.prepare(`INSERT INTO release (id, title, artist_id, year) VALUES (?, ?, ?, ?)`).run(
  rel2,
  'Second Release',
  artistId,
  2001,
);
const t3 = ulid();
db.prepare(
  `INSERT INTO track (id, title, artist_id, album, duration_ms, release_id, position)
     VALUES (?, 'Track Three', ?, 'Second Release', 60000, ?, 'A1')`,
).run(t3, artistId, rel2);

// Both releases need a playable link, or listTrackIds filters them out.
for (const [tid, path] of [[t1, '/music/one.wav'], [t3, '/music/three.wav']] as const) {
  db.prepare(
    `INSERT INTO source_link (entity_kind, entity_id, source, external_id, external_url, match_method)
       VALUES ('track', ?, 'local', ?, NULL, 'file_path')`,
  ).run(tid, path);
}

// starred filter on tracks: t1 is starred, t3 is not.
const starredTracks = listTracks(db, { starred: true, limit: 50, offset: 0 });
assert(starredTracks.total === 1, `expected 1 starred track, got ${starredTracks.total}`);
assert(starredTracks.items[0].id === t1, 'starred filter returned the wrong track');
assert(
  starredTracks.items[0].starred_at !== null,
  'starred track row should carry starred_at',
);

const allTracks = listTracks(db, { limit: 50, offset: 0 });
assert(allTracks.total === 2, `unfiltered should see 2 tracks, got ${allTracks.total}`);

// listTrackIds must agree with listTracks under the same filter — the playback
// queue depends on the two producing identical ordering and membership.
const starredIds = listTrackIds(db, { starred: true });
assert(starredIds.length === 1, `expected 1 starred id, got ${starredIds.length}`);
assert(starredIds[0] === t1, 'listTrackIds disagrees with listTracks on the starred filter');

// vetted filter on releases: relId is vetted, rel2 is not.
const unvetted = listReleases(db, { vetted: false, limit: 50, offset: 0 });
assert(unvetted.total === 1, `expected 1 unvetted release, got ${unvetted.total}`);
assert(unvetted.items[0].id === rel2, 'unvetted filter returned the wrong release');

const vettedOnly = listReleases(db, { vetted: true, limit: 50, offset: 0 });
assert(vettedOnly.total === 1, `expected 1 vetted release, got ${vettedOnly.total}`);
assert(vettedOnly.items[0].id === relId, 'vetted filter returned the wrong release');

// starredCount rides along on release rows.
const allRels = listReleases(db, { limit: 50, offset: 0 });
const byId = new Map(allRels.items.map((r) => [r.id, r]));
assert(byId.get(relId)!.starredCount === 1, 'relId should report 1 starred track');
assert(byId.get(rel2)!.starredCount === 0, 'rel2 should report 0 starred tracks');
assert(byId.get(relId)!.vetted_at !== null, 'release row should carry vetted_at');
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `bun verify scripts/verify-stars.ts`
Expected: FAIL — `expected 1 starred track, got 2` (the `starred` arg is ignored today).

- [ ] **Step 3: Add `starred` to the track query**

In `src/lib/server/library/queries.ts`, extend the interface:

```ts
export interface TrackFilterArgs {
  source?: string;
  q?: string;
  multiSource?: boolean;
  sort?: SortKey;
  starred?: boolean;
}
```

Inside `buildTrackQuery`, after the `multiSource` block and before the `q` block, add:

```ts
  if (args.starred !== undefined) {
    where.push(args.starred ? `track.starred_at IS NOT NULL` : `track.starred_at IS NULL`);
  }
```

Add `track.starred_at` to the `SELECT` column list in `listTracks` (it selects explicit columns, not `track.*`), and to the `TrackRow` interface:

```ts
export interface TrackRow {
  id: string;
  title: string;
  artist: string;
  album: string | null;
  duration_ms: number | null;
  release_id: string | null;
  position: string | null;
  thumb_url: string | null;
  starred_at: string | null;
}
```

Because `listTrackIds` shares `buildTrackQuery`, it inherits the filter with no further change — that is what makes "play all starred tracks" work through the existing queue.

- [ ] **Step 4: Add `vetted` and `starredCount` to the release query**

Extend `ListReleasesArgs` with `vetted?: boolean`, and add to the `where` array in `listReleases`, after the `multiSource` block:

```ts
  if (args.vetted !== undefined) {
    where.push(args.vetted ? `release.vetted_at IS NOT NULL` : `release.vetted_at IS NULL`);
  }
```

Add `release.vetted_at` to the `SELECT` list and to `ReleaseRow`:

```ts
export interface ReleaseRow {
  id: string;
  title: string;
  artist: string;
  year: number | null;
  country: string | null;
  label: string | null;
  catno: string | null;
  thumb_url: string | null;
  cover_url: string | null;
  vetted_at: string | null;
}
```

For the count, follow the batching the function already uses for `sourcesByEntity` rather than a correlated subquery — one extra round-trip per page instead of one per row, and it leaves the `ORDER BY … LIMIT` query untouched. Import at the top of the file:

```ts
import { countStarredByRelease } from './annotations';
```

Then, next to the existing `sourceMap` construction:

```ts
  const starCounts = countStarredByRelease(db, ids);
```

and change the return to:

```ts
  return {
    items: rows.map((r) => ({
      ...r,
      sources: sourceMap.get(r.id) ?? [],
      starredCount: starCounts.get(r.id) ?? 0,
    })),
    total: totalRow.n,
    hasMore: args.offset + rows.length < totalRow.n,
  };
```

Update the function's return type to `PagedResult<ReleaseRow & { sources: string[]; starredCount: number }>`.

- [ ] **Step 5: Run the verification to confirm it passes**

Run: `bun verify scripts/verify-stars.ts`
Expected: `OK: verify-stars`

- [ ] **Step 6: Confirm nothing else regressed**

Run: `bun verify scripts/verify-queries.ts && bun verify scripts/verify-sort.ts && bun verify scripts/verify-track-ids.ts && bun check`
Expected: all pass, no new type errors. These three cover the queries this task edited; a broken `SELECT` list or a stray `WHERE` shows up here.

- [ ] **Step 7: Commit**

```bash
git add src/lib/server/library/queries.ts scripts/verify-stars.ts
git commit -m "feat(queries): starred and vetted filters, starredCount on release rows"
```

---

### Task 3: API routes

**Files:**
- Create: `src/routes/api/library/tracks/[id]/star/+server.ts`
- Create: `src/routes/api/library/releases/[id]/vet/+server.ts`
- Modify: `src/routes/api/library/tracks/+server.ts`
- Modify: `src/routes/api/library/tracks/ids/+server.ts`
- Modify: `src/routes/api/library/releases/+server.ts`

**Interfaces:**
- Consumes: `setTrackStar`, `setReleaseVetted` from Task 1; the `starred` / `vetted` filter args from Task 2.
- Produces:
  - `PUT /api/library/tracks/[id]/star` → `{ starredAt: string | null }`
  - `DELETE /api/library/tracks/[id]/star` → `{ starredAt: null }`
  - `PUT /api/library/releases/[id]/vet` → `{ vettedAt: string | null }`
  - `DELETE /api/library/releases/[id]/vet` → `{ vettedAt: null }`
  - List endpoints accept `?starred=1` (tracks, and `tracks/ids`) and `?vetted=0` (releases).

- [ ] **Step 1: Write the star route**

Create `src/routes/api/library/tracks/[id]/star/+server.ts`:

```ts
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { setTrackStar } from '$lib/server/library/annotations';

export const PUT: RequestHandler = async ({ params }) => {
  return json(setTrackStar(getDb(), params.id, true));
};

export const DELETE: RequestHandler = async ({ params }) => {
  return json(setTrackStar(getDb(), params.id, false));
};
```

- [ ] **Step 2: Write the vet route**

Create `src/routes/api/library/releases/[id]/vet/+server.ts`:

```ts
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { setReleaseVetted } from '$lib/server/library/annotations';

export const PUT: RequestHandler = async ({ params }) => {
  return json(setReleaseVetted(getDb(), params.id, true));
};

export const DELETE: RequestHandler = async ({ params }) => {
  return json(setReleaseVetted(getDb(), params.id, false));
};
```

- [ ] **Step 3: Thread the filters through the list endpoints**

In `src/routes/api/library/tracks/+server.ts` and `src/routes/api/library/tracks/ids/+server.ts`, read the param and pass it through. Both already parse `source` / `q` / `multiSource` from `url.searchParams` — add alongside:

```ts
  const starredParam = url.searchParams.get('starred');
  const starred = starredParam === null ? undefined : starredParam === '1';
```

and include `starred` in the args object passed to `listTracks` / `listTrackIds`.

In `src/routes/api/library/releases/+server.ts`, the same shape:

```ts
  const vettedParam = url.searchParams.get('vetted');
  const vetted = vettedParam === null ? undefined : vettedParam === '1';
```

and include `vetted` in the args passed to `listReleases`.

The tri-state matters: absent means "no filter", `0` means "unvetted only", `1` means "vetted only". A plain `=== '1'` boolean would turn the absent case into "vetted: false" and silently filter every list in the app.

- [ ] **Step 4: Type-check**

Run: `bun check`
Expected: no new errors.

- [ ] **Step 5: Verify against a running server**

Start the dev server if it isn't up (`bun dev`), then pick a real track and release id from the DB and exercise the routes:

```bash
TRACK=$(sqlite3 ~/.booth/booth.db "SELECT id FROM track WHERE release_id IS NOT NULL LIMIT 1;")
REL=$(sqlite3 ~/.booth/booth.db "SELECT release_id FROM track WHERE id='$TRACK';")

curl -s -X PUT    "http://localhost:5173/api/library/tracks/$TRACK/star"
curl -s           "http://localhost:5173/api/library/tracks?starred=1&limit=5"
curl -s           "http://localhost:5173/api/library/releases?vetted=0&limit=1"
curl -s -X PUT    "http://localhost:5173/api/library/releases/$REL/vet"
curl -s           "http://localhost:5173/api/library/releases?vetted=1&limit=5"
curl -s -X DELETE "http://localhost:5173/api/library/tracks/$TRACK/star"
curl -s -X DELETE "http://localhost:5173/api/library/releases/$REL/vet"
```

Expected: the PUT returns a timestamp; the starred list contains exactly that track; the `vetted=0` total drops by one after the release is vetted; the DELETEs return `null`. Confirm the unfiltered totals are unchanged afterward:

```bash
curl -s "http://localhost:5173/api/library/releases?limit=1" | grep -o '"total":[0-9]*'
```

Expected: 1426 (or whatever the pre-task total was) — proof the tri-state param didn't leak a filter into unfiltered calls.

- [ ] **Step 6: Commit**

```bash
git add src/routes/api/library/tracks/\[id\]/star src/routes/api/library/releases/\[id\]/vet src/routes/api/library/tracks/+server.ts src/routes/api/library/tracks/ids/+server.ts src/routes/api/library/releases/+server.ts
git commit -m "feat(api): star and vet routes, starred/vetted list filters"
```

---

### Task 4: Client store, rail items, and counts

**Files:**
- Create: `src/lib/stores/annotations.svelte.ts`
- Modify: `src/lib/stores/explorerController.svelte.ts`
- Modify: `src/lib/components/Rail.svelte`

**Interfaces:**
- Consumes: the routes from Task 3.
- Produces:
  - `annotations.toggleStar(trackId: string, next: boolean): Promise<void>`
  - `annotations.toggleVetted(releaseId: string, next: boolean): Promise<void>`
  - `annotations.isStarred(trackId: string): boolean`
  - `annotations.isVetted(releaseId: string): boolean`
  - `annotations.hydrateTracks(rows)` / `annotations.hydrateReleases(rows)` — seed from list payloads
  - Controller exposes `counts.starredTracks` and `counts.unvettedReleases`
  - Nav items `library:starred` and `library:unvetted`

- [ ] **Step 1: Write the store**

Create `src/lib/stores/annotations.svelte.ts`, modelled on `collection.svelte.ts`:

```ts
/**
 * Client mirror of the user's stars and vetted flags.
 *
 * Toggles are optimistic — the grind involves thousands of these, and waiting
 * a round-trip for the glyph to fill would make the whole feature feel sticky.
 * A failed request rolls the local state back.
 */
class AnnotationStore {
  starred = $state<Set<string>>(new Set());
  vetted = $state<Set<string>>(new Set());

  isStarred(trackId: string): boolean {
    return this.starred.has(trackId);
  }
  isVetted(releaseId: string): boolean {
    return this.vetted.has(releaseId);
  }

  /** Seed from a track list payload; rows carry `starred_at`. */
  hydrateTracks(rows: { id: string; starred_at?: string | null }[]) {
    const next = new Set(this.starred);
    for (const r of rows) {
      if (r.starred_at) next.add(r.id);
      else next.delete(r.id);
    }
    this.starred = next;
  }

  /** Seed from a release list payload; rows carry `vetted_at`. */
  hydrateReleases(rows: { id: string; vetted_at?: string | null }[]) {
    const next = new Set(this.vetted);
    for (const r of rows) {
      if (r.vetted_at) next.add(r.id);
      else next.delete(r.id);
    }
    this.vetted = next;
  }

  async toggleStar(trackId: string, next: boolean) {
    const prev = new Set(this.starred);
    const optimistic = new Set(this.starred);
    if (next) optimistic.add(trackId);
    else optimistic.delete(trackId);
    this.starred = optimistic;

    try {
      const res = await fetch(`/api/library/tracks/${trackId}/star`, {
        method: next ? 'PUT' : 'DELETE',
      });
      if (!res.ok) this.starred = prev;
    } catch {
      this.starred = prev;
    }
  }

  async toggleVetted(releaseId: string, next: boolean) {
    const prev = new Set(this.vetted);
    const optimistic = new Set(this.vetted);
    if (next) optimistic.add(releaseId);
    else optimistic.delete(releaseId);
    this.vetted = optimistic;

    try {
      const res = await fetch(`/api/library/releases/${releaseId}/vet`, {
        method: next ? 'PUT' : 'DELETE',
      });
      if (!res.ok) this.vetted = prev;
    } catch {
      this.vetted = prev;
    }
  }
}

export const annotations = new AnnotationStore();
```

- [ ] **Step 2: Add the counts to the controller**

In `src/lib/stores/explorerController.svelte.ts`, extend the `counts` state:

```ts
  let counts = $state({
    allReleases: 0,
    allTracks: 0,
    allArtists: 0,
    starredTracks: 0,
    unvettedReleases: 0,
  });
```

and extend `loadSourcesAndCounts` to fetch them alongside the existing three:

```ts
  async function loadSourcesAndCounts() {
    const [srcRes, allRel, allTrk, allArt, starTrk, unvetRel] = await Promise.all([
      fetch('/api/sources').then((r) => r.json()),
      fetch('/api/library/releases?limit=1').then((r) => r.json()),
      fetch('/api/library/tracks?limit=1').then((r) => r.json()),
      fetch('/api/library/artists?limit=1').then((r) => r.json()),
      fetch('/api/library/tracks?starred=1&limit=1').then((r) => r.json()),
      fetch('/api/library/releases?vetted=0&limit=1').then((r) => r.json()),
    ]);
    sources = srcRes;
    counts = {
      allReleases: allRel.total ?? 0,
      allTracks: allTrk.total ?? 0,
      allArtists: allArt.total ?? 0,
      starredTracks: starTrk.total ?? 0,
      unvettedReleases: unvetRel.total ?? 0,
    };
  }
```

Export `loadSourcesAndCounts` from the controller's return object if it isn't already, so the vet action can refresh the progress number.

- [ ] **Step 3: Send the filters when the new nav items are active**

In `loadList`, after the `if (explorerState.nav.section === 'sources')` block, add:

```ts
      if (explorerState.nav.section === 'library') {
        if (explorerState.nav.item === 'starred') params.set('starred', '1');
        else if (explorerState.nav.item === 'unvetted') params.set('vetted', '0');
      }
```

Then seed the store from every page that arrives. Where `listItems` is assigned, add:

```ts
      if (currentEntity === 'tracks') annotations.hydrateTracks(items);
      if (currentEntity === 'releases') annotations.hydrateReleases(items);
```

Import the store at the top: `import { annotations } from './annotations.svelte';`

- [ ] **Step 4: Force the right entity lens for the new items**

`library:starred` is a tracks concept and `library:unvetted` is a releases concept, so landing on either with the wrong lens active shows an empty or nonsensical list. In `explorerState.svelte.ts`, `parseNav` already returns an `entityHint` for legacy nav strings — reuse that mechanism:

```ts
  if (raw === 'library:starred') {
    return { nav: { section: 'library', item: 'starred' }, entityHint: 'tracks' };
  }
  if (raw === 'library:unvetted') {
    return { nav: { section: 'library', item: 'unvetted' }, entityHint: 'releases' };
  }
```

The lens stays user-switchable afterward — this only sets the landing state.

- [ ] **Step 5: Add the rail items**

In `src/lib/components/Rail.svelte`, extend the props to accept the two new counts, then add two buttons inside the existing Library `.section`, after the `All` button:

```svelte
    <button
      class="item"
      class:active={isActive('library', 'starred')}
      onclick={() => onSelect?.({ section: 'library', item: 'starred' })}
    >
      <span>Starred</span>
      <span class="count">{starredCount.toLocaleString()}</span>
    </button>
    <button
      class="item"
      class:active={isActive('library', 'unvetted')}
      onclick={() => onSelect?.({ section: 'library', item: 'unvetted' })}
    >
      <span>Unvetted</span>
      <span class="count">{unvettedCount.toLocaleString()}</span>
    </button>
```

Wire `starredCount` / `unvettedCount` from the controller's `counts` in `DesktopShell.svelte` where `Rail` is mounted.

- [ ] **Step 6: Verify in the app**

Run `bun check`, then load the app and confirm: both rail items appear with counts; Unvetted shows the full release total on first run; clicking Starred lands on the tracks lens and shows an empty list; clicking Unvetted lands on the releases lens and shows every release. `[` and `]` should cycle through the new items with no extra wiring, since they carry the existing `.rail button.item` class.

- [ ] **Step 7: Commit**

```bash
git add src/lib/stores/annotations.svelte.ts src/lib/stores/explorerController.svelte.ts src/lib/stores/explorerState.svelte.ts src/lib/components/Rail.svelte src/lib/components/DesktopShell.svelte
git commit -m "feat(explorer): annotations store, Starred and Unvetted rail items"
```

---

### Task 5: Star affordance on track rows

**Files:**
- Modify: `src/app.css` (add the `--star` token)
- Create: `src/lib/components/StarButton.svelte`
- Modify: `src/lib/components/TrackList.svelte`
- Modify: `src/lib/components/PlaylistView.svelte`
- Modify: `src/lib/components/ReleaseDetail.svelte`
- Modify: `src/lib/components/PlayerBar.svelte`

**Interfaces:**
- Consumes: `annotations` store from Task 4.
- Produces: `<StarButton trackId={string} size?={number} />` — self-contained, reads and writes the store directly.

- [ ] **Step 1: Add a star colour token**

In `src/app.css`, next to the existing semantic colours, add:

```css
  --star: #d6a52c;
```

Do not reuse `--warn` (`#d69a2c`). The hue is nearly identical, but a star is
not a warning, and the next person to restyle warnings would silently restyle
every star in the app.

- [ ] **Step 2: Write the shared button**

Create `src/lib/components/StarButton.svelte`:

```svelte
<script lang="ts">
  import { annotations } from '$lib/stores/annotations.svelte';

  let { trackId, size = 14 }: { trackId: string; size?: number } = $props();

  const starred = $derived(annotations.isStarred(trackId));

  function toggle(e: MouseEvent) {
    // Rows are buttons that select/play; the star must not trigger that.
    e.stopPropagation();
    e.preventDefault();
    annotations.toggleStar(trackId, !starred);
  }
</script>

<button
  class="star"
  class:on={starred}
  onclick={toggle}
  ondblclick={(e) => e.stopPropagation()}
  aria-pressed={starred}
  aria-label={starred ? 'Remove star' : 'Star track'}
  title={starred ? 'Remove star (s)' : 'Star track (s)'}
>
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <path
      d="M12 2.5l2.9 6.1 6.6.9-4.8 4.6 1.2 6.6L12 17.6 6.1 20.7l1.2-6.6L2.5 9.5l6.6-.9z"
      fill={starred ? 'currentColor' : 'none'}
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linejoin="round"
    />
  </svg>
</button>

<style>
  .star {
    background: none;
    border: 0;
    padding: 2px;
    cursor: pointer;
    color: var(--text-muted);
    opacity: 0;
    display: flex;
    align-items: center;
    transition: opacity 0.12s, color 0.12s;
  }
  /* Hidden until hover keeps 5,000 hollow stars from becoming visual noise —
     but a set star must always be visible, hover or not. */
  :global(.row-btn:hover) .star,
  :global(.row-btn:focus-visible) .star,
  .star.on,
  .star:focus-visible {
    opacity: 1;
  }
  .star.on { color: var(--star); }
  .star:hover { color: var(--text); }
</style>
```

- [ ] **Step 3: Add it to the track listview rows**

In `src/lib/components/TrackList.svelte`, add `starred_at?: string | null` to the `TrackItem` interface, import the button, and place it in the row markup as the first cell after the thumbnail:

```svelte
<StarButton trackId={item.id} />
```

- [ ] **Step 4: Add it to the playlist rows and the release tracklist**

Same insertion in `PlaylistView.svelte` (the tabular row) and in the `ReleaseDetail.svelte` tracklist. In `ReleaseDetail`, seed the store from the detail payload so stars render before any list page has loaded — in the effect that receives detail data:

```ts
  annotations.hydrateTracks(data.tracks ?? []);
```

This requires `getTrackDetail` / `getReleaseDetail` to return `starred_at` on their track rows. Confirm the tracklist select in `queries.ts` includes `track.starred_at`; add it if Task 2 only covered `listTracks`.

- [ ] **Step 5: Add it to the player bar**

In `src/lib/components/PlayerBar.svelte`, place a `<StarButton trackId={player.trackId} size={16} />` next to the title/artist block, guarded on `player.trackId` being non-null. Override the opacity so it is always visible here — there is no row hover to reveal it:

```css
  .transport :global(.star) { opacity: 1; }
```

This is the affordance that covers playback drifting ahead of the selection, so it must not be hover-gated.

- [ ] **Step 6: Verify in the app**

Run `bun check`, then: hover a track row and confirm the hollow star appears; click it and confirm it fills immediately; reload and confirm it is still filled; confirm the Starred rail count rises; confirm clicking a star does not select or play the row; confirm the same star renders in the playlist view, the release detail tracklist, and the player bar for the same track.

- [ ] **Step 7: Commit**

```bash
git add src/app.css src/lib/components/StarButton.svelte src/lib/components/TrackList.svelte src/lib/components/PlaylistView.svelte src/lib/components/ReleaseDetail.svelte src/lib/components/PlayerBar.svelte
git commit -m "feat(ui): star affordance on track rows and the player bar"
```

---

### Task 6: Release indicators, Mark vetted, and auto-advance

**Files:**
- Modify: `src/lib/components/ReleaseList.svelte`
- Modify: `src/lib/components/ReleaseGrid.svelte`
- Modify: `src/lib/components/ReleaseDetail.svelte`
- Modify: `src/lib/stores/explorerController.svelte.ts`

**Interfaces:**
- Consumes: `annotations` store (Task 4), `starredCount` on release rows (Task 2).
- Produces: `controller.vetAndAdvance(releaseId: string, next?: boolean): Promise<void>` — `next` defaults to `true`; pass `false` to un-vet.

- [ ] **Step 1: Add the two release indicators**

In `ReleaseList.svelte`, add `vetted_at?: string | null` and `starredCount?: number` to the item interface, and render both in the row:

```svelte
{#if item.starredCount}
  <span class="star-count" title="{item.starredCount} starred tracks">
    ★ {item.starredCount}
  </span>
{/if}
{#if annotations.isVetted(item.id)}
  <span class="vetted" title="Vetted">✓</span>
{/if}
```

The two must not read alike. A release with starred tracks but no vetted flag stays in the Unvetted queue — correct behaviour, since it means "you started this and stopped", but it looks like a bug if a gold star and a gold check sit side by side. Give the star count `--star` (gold) and the vetted check `--text-muted` (neutral grey), and keep the glyphs distinct — a gold ★ against a grey ✓ reads as two different kinds of fact at a glance.

Mirror the same two indicators as a corner overlay in `ReleaseGrid.svelte`.

- [ ] **Step 2: Add the vetted CTA to release detail**

In `ReleaseDetail.svelte`, add a control near the existing CTA row:

```svelte
{#if isVetted}
  <button class="cta secondary" onclick={() => onVet?.(release.id, false)}>
    Vetted ✓ &middot; undo
  </button>
{:else}
  <button class="cta" onclick={() => onVet?.(release.id, true)}>
    Mark vetted (v)
  </button>
{/if}
```

with `const isVetted = $derived(annotations.isVetted(release.id));` and an `onVet?: (releaseId: string, next: boolean) => void` prop. It toggles rather than being one-way — mis-vetting a release must be undoable without a database edit.

- [ ] **Step 3: Implement vet-and-advance in the controller**

Add to `explorerController.svelte.ts`:

```ts
  /**
   * Mark a release vetted (or un-vetted) and, when working the Unvetted queue,
   * open the next release automatically.
   *
   * The advance is scoped to the queue on purpose: doing it everywhere would
   * hijack navigation mid-browse. Inside the queue it is what makes a
   * ~1,400-release grind survivable — without it the user pays an extra
   * navigation gesture a thousand-odd times.
   */
  async function vetAndAdvance(releaseId: string, next = true) {
    const inQueue =
      explorerState.nav.section === 'library' && explorerState.nav.item === 'unvetted';

    // Capture the successor before the row leaves the list.
    const idx = listItems.findIndex((it) => it.id === releaseId);
    const successor = idx >= 0 ? listItems[idx + 1] ?? listItems[idx - 1] ?? null : null;

    await annotations.toggleVetted(releaseId, next);
    void loadSourcesAndCounts(); // refresh the Unvetted progress number

    if (!inQueue || !next) return;

    // Drop it from the queue in place rather than refetching — a refetch would
    // reset scroll position after every single release.
    listItems = listItems.filter((it) => it.id !== releaseId);
    listTotal = Math.max(0, listTotal - 1);

    if (successor) explorerState.setEntity(successor.id);
    else explorerState.setEntity(null);

    // Top up if removals have drained the buffer below a screenful.
    if (listItems.length < 20 && listHasMore) void loadList(false);
  }
```

Return `vetAndAdvance` from the controller and pass it into `ReleaseDetail` as `onVet` from `DesktopShell.svelte`.

Confirm `explorerState.setEntity(null)` is the correct call for clearing `?id`; if the store exposes a different clear method, use that instead.

- [ ] **Step 4: Verify the loop end to end**

Run `bun check`, then: open Unvetted, select the first release, click **Mark vetted**. Confirm the release disappears from the list, the next one opens in the detail pane, the rail count drops by one, and the scroll position does not jump. Click **Vetted ✓ · undo** on a release opened from All and confirm the flag clears and the Unvetted count rises again. Scroll deep into the queue and vet several in a row to confirm the top-up keeps the list populated.

- [ ] **Step 5: Commit**

```bash
git add src/lib/components/ReleaseList.svelte src/lib/components/ReleaseGrid.svelte src/lib/components/ReleaseDetail.svelte src/lib/stores/explorerController.svelte.ts src/lib/components/DesktopShell.svelte
git commit -m "feat(ui): vetted indicators, Mark vetted CTA, queue auto-advance"
```

---

### Task 7: Keyboard bindings

**Files:**
- Modify: `src/lib/keyboard.svelte.ts`
- Modify: `src/routes/+page.svelte`
- Modify: `src/lib/components/ShortcutOverlay.svelte`

**Interfaces:**
- Consumes: `annotations` store (Task 4), `vetAndAdvance` (Task 6).
- Produces: `KeyboardActions` gains `toggleStar()` and `markVetted()`; `KeyboardGuards` gains `isScannerAvailable()`.

- [ ] **Step 1: Extend the action and guard types**

In `src/lib/keyboard.svelte.ts`, add to `KeyboardActions`:

```ts
  toggleStar: () => void;
  markVetted: () => void;
```

and to `KeyboardGuards`:

```ts
  /**
   * True when a scan button is mounted — i.e. we are in Add → Discogs, the
   * only view that renders one. Element presence is the signal, the same way
   * `isEntityToggleSuppressed` reads the toolbar toggle.
   */
  isScannerAvailable: () => boolean;
```

- [ ] **Step 2: Rewrite the `s` handler and add `v`**

Replace the existing `s` line:

```ts
    if ((e.key === 's' || e.key === 'S') && !guards.isScannerOpen())
                                                            { e.preventDefault(); actions.openScanner();    return; }
```

with:

```ts
    // `s` is context-split: the scanner in Add → Discogs, starring everywhere
    // else. Nothing is taken away — openScanner is DOM-driven (it clicks the
    // scan button) and that button only renders in the add view, so `s` was
    // already inert outside it. The split is keyed to which page you are on:
    // a stable, visually unmistakable context, unlike player state. And it is
    // total, not overlapping — Add → Discogs lists search hits, which are not
    // library entities and cannot be starred.
    if (e.key === 's' || e.key === 'S') {
      e.preventDefault();
      if (guards.isScannerAvailable()) {
        // Already open: stay inert rather than falling through to starring.
        if (!guards.isScannerOpen()) actions.openScanner();
      } else {
        actions.toggleStar();
      }
      return;
    }
    if (e.key === 'v' || e.key === 'V')                     { e.preventDefault(); actions.markVetted();     return; }
```

Update the docstring at the top of the file:

```
 *   s          star selected track (opens the scanner in add:discogs)
 *   v          mark open release vetted, advance in the Unvetted queue
```

- [ ] **Step 3: Wire the actions**

In `src/routes/+page.svelte`, add to the actions object, following the DOM-driven convention used by the neighbouring actions:

```ts
        toggleStar: () => {
          const row = document.activeElement?.closest<HTMLElement>('.row-btn[data-id]');
          const trackId = row?.dataset.id;
          if (!trackId) return;
          annotations.toggleStar(trackId, !annotations.isStarred(trackId));
        },
        markVetted: () => {
          const releaseId = c.detailKind === 'release' ? c.detailData?.release?.id : null;
          if (!releaseId) return;
          c.vetAndAdvance(releaseId, !annotations.isVetted(releaseId));
        },
```

and to the guards object:

```ts
        isScannerAvailable: () => !!document.querySelector('button[title^="Scan barcode"]'),
```

Import the store. Verify the actual controller accessor names for `detailKind` / `detailData` before using them, and check that track rows expose `data-id` — if they do not, add it, since the existing arrow-nav already relies on the `.row-btn[data-id]` shape.

`toggleStar` deliberately targets the selected row, not the now-playing track: playback advances on its own as tracks end, so a now-playing target would silently retarget between keypresses. The player bar's star covers that case explicitly.

- [ ] **Step 4: Update the shortcut overlay**

In `ShortcutOverlay.svelte`, add both keys, documenting the context-split rather than leaving it as folklore:

```
s    star selected track  ·  scan barcode in Add → Discogs
v    mark release vetted
```

- [ ] **Step 5: Verify**

Run `bun check`, then: arrow to a track row and press `s`; confirm it stars and that the star matches what a mouse click produces. Open Add → Discogs and press `s`; confirm the scanner opens and nothing gets starred. Press `s` again while the scanner is open; confirm nothing happens. Open a release and press `v`; confirm it vets and, in the Unvetted queue, advances. Press `?` and confirm both keys are listed.

- [ ] **Step 6: Commit**

```bash
git add src/lib/keyboard.svelte.ts src/routes/+page.svelte src/lib/components/ShortcutOverlay.svelte
git commit -m "feat(keyboard): s stars the selected row, v marks vetted"
```

---

### Task 8: Mobile shell

**Files:**
- Modify: `src/lib/components/MobileShell.svelte`

**Interfaces:**
- Consumes: everything from Tasks 4–6. No new interfaces.

- [ ] **Step 1: Surface the two library views**

`MobileShell` flattens the rail into four tabs, so Starred and Unvetted need a home inside the Library tab rather than tabs of their own. Add a segmented filter strip under the Library tab's toolbar with three options — All / Starred / Unvetted — writing the same `?nav=library:*` values the desktop rail does. The controller work from Task 4 already sends the right query params, so no data wiring is needed.

- [ ] **Step 2: Confirm the shared components carried over**

`TrackList`, `ReleaseList`, `ReleaseGrid`, `ReleaseDetail`, and `PlayerBar` are shared between shells, so stars and the vetted CTA appear on mobile automatically. The one thing that does not carry is the hover-reveal: there is no hover on touch, so stars would be invisible until set. Override in the mobile shell:

```css
  :global(.row-btn .star) { opacity: 1; }
```

- [ ] **Step 3: Verify touch targets**

Run `bun check`, then load the app below 768px (or in a narrow window) and confirm: the three-way filter switches the list; stars are visible without hover; the star hit area is at least 44×44px — pad `StarButton` from the mobile side rather than growing the glyph, so the desktop rows keep their density; tapping a star does not select or play the row; the Mark vetted CTA is reachable in the pushed detail view.

- [ ] **Step 4: Commit**

```bash
git add src/lib/components/MobileShell.svelte src/lib/components/StarButton.svelte
git commit -m "feat(mobile): Starred/Unvetted filter, always-visible stars"
```

---

### Task 9: Backup script

**Files:**
- Create: `scripts/export-stars.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks except the schema from Task 1.
- Produces: a CLI taking `export <path>` or `import <path>`.

- [ ] **Step 1: Write the script**

Create `scripts/export-stars.ts`:

```ts
/**
 * Dump and restore stars + vetted flags, keyed on artist/title/album rather
 * than entity ULIDs.
 *
 * Why this exists: collate's prune deletes entities that no longer resolve to
 * any source. Move or rename a local file and it re-keys on its path, so a NEW
 * track row appears and the old one is pruned — taking its star with it,
 * silently. Keying stars on match keys instead of ids would be a large change
 * to serve a rare event; this is the proportionate answer.
 *
 * Every other entity in the database is reconstructible from a source. This
 * data is not: it is tens of hours of listening, entered by hand.
 *
 *   bun verify scripts/export-stars.ts export ~/booth-stars.json
 *   bun verify scripts/export-stars.ts import ~/booth-stars.json
 */
import { Database } from 'bun:sqlite';
import { homedir } from 'os';
import { join } from 'path';

const dbPath = process.env.BOOTH_DB_PATH ?? join(homedir(), '.booth', 'booth.db');
const [, , mode, file] = process.argv;

if (mode !== 'export' && mode !== 'import') {
  console.error('usage: export-stars.ts <export|import> <file.json>');
  process.exit(1);
}
if (!file) {
  console.error('missing file path');
  process.exit(1);
}

const db = new Database(dbPath);

interface Payload {
  exportedAt: string;
  stars: { artist: string; title: string; album: string | null; starredAt: string }[];
  vetted: { artist: string; title: string; year: number | null; vettedAt: string }[];
}

if (mode === 'export') {
  const stars = db
    .prepare(
      `SELECT a.name AS artist, t.title, t.album, t.starred_at AS starredAt
         FROM track t JOIN artist a ON a.id = t.artist_id
        WHERE t.starred_at IS NOT NULL
        ORDER BY a.name, t.album, t.title`,
    )
    .all() as Payload['stars'];

  const vetted = db
    .prepare(
      `SELECT a.name AS artist, r.title, r.year, r.vetted_at AS vettedAt
         FROM release r JOIN artist a ON a.id = r.artist_id
        WHERE r.vetted_at IS NOT NULL
        ORDER BY a.name, r.title`,
    )
    .all() as Payload['vetted'];

  const payload: Payload = { exportedAt: new Date().toISOString(), stars, vetted };
  await Bun.write(file, JSON.stringify(payload, null, 2));
  console.log(`exported ${stars.length} stars, ${vetted.length} vetted releases → ${file}`);
} else {
  const payload = (await Bun.file(file).json()) as Payload;

  const findTrack = db.prepare(
    `SELECT t.id FROM track t JOIN artist a ON a.id = t.artist_id
      WHERE a.name = ? AND t.title = ? AND (t.album IS ? OR t.album = ?)`,
  );
  const findRelease = db.prepare(
    `SELECT r.id FROM release r JOIN artist a ON a.id = r.artist_id
      WHERE a.name = ? AND r.title = ?`,
  );
  const setStar = db.prepare(`UPDATE track SET starred_at = ? WHERE id = ?`);
  const setVet = db.prepare(`UPDATE release SET vetted_at = ? WHERE id = ?`);

  let starred = 0;
  let missedStars = 0;
  let vetted = 0;
  let missedVetted = 0;

  db.transaction(() => {
    for (const s of payload.stars) {
      const row = findTrack.get(s.artist, s.title, s.album, s.album) as { id: string } | undefined;
      if (row) {
        setStar.run(s.starredAt, row.id);
        starred++;
      } else {
        missedStars++;
        console.warn(`no match: ${s.artist} — ${s.title}`);
      }
    }
    for (const v of payload.vetted) {
      const row = findRelease.get(v.artist, v.title) as { id: string } | undefined;
      if (row) {
        setVet.run(v.vettedAt, row.id);
        vetted++;
      } else {
        missedVetted++;
        console.warn(`no match: ${v.artist} — ${v.title}`);
      }
    }
  })();

  console.log(`restored ${starred} stars (${missedStars} unmatched), ${vetted} vetted (${missedVetted} unmatched)`);
}
```

- [ ] **Step 2: Verify round-trip against the real database**

```bash
bun verify scripts/export-stars.ts export /tmp/booth-stars.json
cat /tmp/booth-stars.json | head -20
sqlite3 ~/.booth/booth.db "SELECT COUNT(*) FROM track WHERE starred_at IS NOT NULL;"
```

Expected: the JSON star count matches the SQL count. Then clear one star through the UI, re-run `import`, and confirm it comes back with its original timestamp.

- [ ] **Step 3: Commit**

```bash
git add scripts/export-stars.ts
git commit -m "feat(scripts): export/import stars and vetted flags by name"
```

---

### Task 10: Context doc

**Files:**
- Modify: `docs/CONTEXT.md`

- [ ] **Step 1: Add a feature-inventory section**

Add a `### Stars + vetting` section to the Feature inventory, covering: the two columns and why they are timestamps; why vetted-ness is stored rather than derived from "has starred tracks"; why release stars are derived-only; the two rail items and the Unvetted count as progress meter; the flat queue including releases with no local files; the `s`/`v` bindings and the context-split on `s`; and the backup script with the entity-churn limitation it guards against. Link the spec and this plan, matching how the playlists and vinyl-recording sections do it.

- [ ] **Step 2: Update the file map**

Add `009_stars.sql`, `annotations.ts`, `StarButton.svelte`, `annotations.svelte.ts`, the two route directories, and `scripts/export-stars.ts` to the file-map block. Do not re-add a spec/plan enumeration — that list was deliberately removed for rotting.

- [ ] **Step 3: Add a dated changelog entry**

Add to the changelog list near the bottom, matching the existing entries' shape (date, what changed, the load-bearing rationale).

- [ ] **Step 4: Commit**

```bash
git add docs/CONTEXT.md
git commit -m "docs(context): stars + vetting"
```

---

## Post-implementation

Move BOO-42 to Done in Linear once Task 10 is committed.
