# Library Explorer (Slice 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** [`docs/superpowers/specs/2026-05-06-library-explorer-design.md`](../specs/2026-05-06-library-explorer-design.md)

**Goal:** Replace today's single-purpose add-record screen with a three-pane library explorer that browses the unified store, with the existing add-from-Discogs flow folded in as a rail section. Tiny `source_state` migration; otherwise reads from the existing Slice 1 schema.

**Architecture:** Single root route `/` becomes the explorer (rail / list / detail). New `src/lib/components/Explorer.svelte` is the top-level shell that owns URL ↔ store sync. Generic `Listview.svelte` carries pagination/sentinel plumbing; thin `ReleaseList`/`TrackList` wrappers define their row snippets. New `Rail.svelte`, `ListviewToolbar.svelte`, `SourceGrid.svelte`, `SourcePanel.svelte`, `SyncChip.svelte`, `EmptyState.svelte`, `ReleaseDetail.svelte`, `TrackDetail.svelte`. `SearchBar.svelte` refactored to a focused debounced input. `mode.svelte.ts`, `ConfirmModal.svelte`, `ResultsList.svelte`, `ResultRow.svelte` deleted. `SessionLog.svelte` and `Scanner.svelte` kept and rewired. New `explorerState.svelte.ts` store mirrors URL params (`nav`, `id`, `q`, `entity`).

**Tech Stack:** SvelteKit 2 + Svelte 5 (runes) + TypeScript. No new runtime deps. Verification matches Slice 1: `pnpm tsc`, `pnpm verify scripts/*.ts`, `curl http://localhost:*`, `sqlite3 ./.booth/booth.db`. Browser checks via `pnpm dev`.

**Verification stance:** booth has no test framework today and the spec preserves that. Each task ends with a verify step that runs the actual surface (`pnpm tsc`, `curl`, `sqlite3`, `pnpm verify scripts/<name>.ts`, or a manual browser check via `pnpm dev`). Verification scripts touching the schema use temporary in-memory DBs.

---

## Phase 0 — Data layer (endpoints + source_state)

### Task 1: Migration `002_source_state.sql` + write inside `collate()`

**Files:**
- Create: `src/lib/server/db/migrations/002_source_state.sql`
- Modify: `src/lib/server/library/collate.ts` (write a `source_state` row inside the existing transaction)
- Create: `scripts/verify-source-state.ts`

- [x] **Step 1: Write the migration**

Create `src/lib/server/db/migrations/002_source_state.sql`:

```sql
CREATE TABLE source_state (
  source          TEXT PRIMARY KEY,
  last_synced_at  TEXT,
  last_summary    TEXT
);
```

- [x] **Step 2: Write the upsert inside `collate()`**

Open `src/lib/server/library/collate.ts`. At the top of the file's imports, add nothing new (we'll use `db` directly). Find the `collate()` function. Inside its existing transaction, immediately *before* the function returns the `summary` object, add:

```ts
db.prepare(
  `INSERT INTO source_state (source, last_synced_at, last_summary)
   VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?)
   ON CONFLICT(source) DO UPDATE SET
     last_synced_at = excluded.last_synced_at,
     last_summary   = excluded.last_summary`,
).run(sourceId, JSON.stringify(summary));
```

The `summary` object is the same one currently returned by `collate()` (`{ rowsIn, releasesUpserted, … }`). The `sourceId` is the function's first parameter. Both are already in scope.

- [x] **Step 3: Write the verification script**

Create `scripts/verify-source-state.ts`:

```ts
import Database from 'better-sqlite3';
import { runMigrations } from '../src/lib/server/db/migrate';
import { collate } from '../src/lib/server/library/collate';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) fail(msg);
}

const db = new Database(':memory:');
runMigrations(db);

// Verify source_state table exists.
const tableRow = db
  .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='source_state'`)
  .get();
assert(tableRow, 'source_state table not created by migration');

// Run a small collate; verify a source_state row appears.
collate(db, 'discogs', {
  releases: [
    {
      externalId: '12721',
      title: 'Homework',
      artist: 'Daft Punk',
      year: 1997,
    },
  ],
  tracks: [],
});

const row = db
  .prepare(`SELECT source, last_synced_at, last_summary FROM source_state WHERE source = 'discogs'`)
  .get() as { source: string; last_synced_at: string; last_summary: string } | undefined;
assert(row, 'no source_state row written by collate');
assert(row.source === 'discogs', `wrong source: ${row.source}`);
assert(row.last_synced_at?.endsWith('Z'), `bad timestamp: ${row.last_synced_at}`);
const parsed = JSON.parse(row.last_summary);
assert(parsed.releasesUpserted === 1, `wrong summary.releasesUpserted: ${parsed.releasesUpserted}`);

// Run a SECOND collate for the same source; verify the row is updated, not inserted.
collate(db, 'discogs', {
  releases: [
    { externalId: '12722', title: 'Discovery', artist: 'Daft Punk', year: 2001 },
  ],
  tracks: [],
});
const all = db.prepare(`SELECT COUNT(*) as n FROM source_state`).all() as { n: number }[];
assert(all[0].n === 1, `expected 1 row in source_state, got ${all[0].n}`);

console.log('PASS: source_state migration + collate write');
```

- [x] **Step 4: Verify**

Run: `pnpm verify scripts/verify-source-state.ts`
Expected: `PASS: source_state migration + collate write`

- [x] **Step 5: Type-check**

Run: `pnpm tsc`
Expected: no errors.

- [x] **Step 6: Commit**

```bash
git add src/lib/server/db/migrations/002_source_state.sql src/lib/server/library/collate.ts scripts/verify-source-state.ts
git commit -m "feat(db): source_state table + write inside collate transaction"
```

---

### Task 2: Library query helpers (pagination, details, sources-with-state)

**Files:**
- Modify: `src/lib/server/library/queries.ts` (add helpers; keep existing `getMembershipExternalIds`)
- Create: `scripts/verify-queries.ts`

- [x] **Step 1: Append query helpers**

Open `src/lib/server/library/queries.ts`. Append the following helpers — do not remove existing exports:

```ts
// Shared row types -------------------------------------------------

export interface ReleaseRow {
  id: string;
  title: string;
  artist: string;
  year: number | null;
  country: string | null;
  label: string | null;
  catno: string | null;
}

export interface TrackRow {
  id: string;
  title: string;
  artist: string;
  album: string | null;
  duration_ms: number | null;
  release_id: string | null;
  position: string | null;
}

export interface SourceLinkRow {
  source: string;
  external_id: string;
  external_url: string | null;
  match_method: string;
}

export interface SourceFacetRow {
  source: string;
  key: string;
  value: string;
}

export interface PagedResult<T> {
  items: T[];
  total: number;
  hasMore: boolean;
}

// Helpers ----------------------------------------------------------

interface ListReleasesArgs {
  source?: string;
  q?: string;
  limit: number;
  offset: number;
  multiSource?: boolean;
}

export function listReleases(
  db: Database.Database,
  args: ListReleasesArgs,
): PagedResult<ReleaseRow & { sources: string[] }> {
  const where: string[] = [];
  const params: unknown[] = [];

  if (args.source) {
    where.push(
      `release.id IN (SELECT entity_id FROM source_link WHERE entity_kind='release' AND source=?)`,
    );
    params.push(args.source);
  }
  if (args.multiSource) {
    where.push(
      `release.id IN (
         SELECT entity_id FROM source_link
         WHERE entity_kind='release'
         GROUP BY entity_id
         HAVING COUNT(DISTINCT source) >= 2
       )`,
    );
  }
  if (args.q) {
    where.push(`(release.title LIKE ? OR release.artist LIKE ?)`);
    params.push(`%${args.q}%`, `%${args.q}%`);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const totalRow = db
    .prepare(`SELECT COUNT(*) as n FROM release ${whereSql}`)
    .get(...params) as { n: number };

  const rows = db
    .prepare(
      `SELECT id, title, artist, year, country, label, catno
         FROM release
         ${whereSql}
         ORDER BY artist COLLATE NOCASE, year, title COLLATE NOCASE
         LIMIT ? OFFSET ?`,
    )
    .all(...params, args.limit, args.offset) as ReleaseRow[];

  // Fetch source lists for the page in one round-trip.
  const ids = rows.map((r) => r.id);
  const sourcesByEntity = ids.length
    ? (db
        .prepare(
          `SELECT entity_id, source FROM source_link
             WHERE entity_kind='release' AND entity_id IN (${ids.map(() => '?').join(',')})`,
        )
        .all(...ids) as { entity_id: string; source: string }[])
    : [];

  const sourceMap = new Map<string, string[]>();
  for (const { entity_id, source } of sourcesByEntity) {
    const list = sourceMap.get(entity_id) ?? [];
    list.push(source);
    sourceMap.set(entity_id, list);
  }

  return {
    items: rows.map((r) => ({ ...r, sources: sourceMap.get(r.id) ?? [] })),
    total: totalRow.n,
    hasMore: args.offset + rows.length < totalRow.n,
  };
}

interface ListTracksArgs {
  source?: string;
  q?: string;
  limit: number;
  offset: number;
}

export function listTracks(
  db: Database.Database,
  args: ListTracksArgs,
): PagedResult<TrackRow & { sources: string[] }> {
  const where: string[] = [];
  const params: unknown[] = [];

  if (args.source) {
    where.push(
      `track.id IN (SELECT entity_id FROM source_link WHERE entity_kind='track' AND source=?)`,
    );
    params.push(args.source);
  }
  if (args.q) {
    where.push(`(track.title LIKE ? OR track.artist LIKE ? OR track.album LIKE ?)`);
    params.push(`%${args.q}%`, `%${args.q}%`, `%${args.q}%`);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const totalRow = db
    .prepare(`SELECT COUNT(*) as n FROM track ${whereSql}`)
    .get(...params) as { n: number };

  const rows = db
    .prepare(
      `SELECT id, title, artist, album, duration_ms, release_id, position
         FROM track
         ${whereSql}
         ORDER BY artist COLLATE NOCASE, album COLLATE NOCASE, title COLLATE NOCASE
         LIMIT ? OFFSET ?`,
    )
    .all(...params, args.limit, args.offset) as TrackRow[];

  const ids = rows.map((r) => r.id);
  const sourcesByEntity = ids.length
    ? (db
        .prepare(
          `SELECT entity_id, source FROM source_link
             WHERE entity_kind='track' AND entity_id IN (${ids.map(() => '?').join(',')})`,
        )
        .all(...ids) as { entity_id: string; source: string }[])
    : [];

  const sourceMap = new Map<string, string[]>();
  for (const { entity_id, source } of sourcesByEntity) {
    const list = sourceMap.get(entity_id) ?? [];
    list.push(source);
    sourceMap.set(entity_id, list);
  }

  return {
    items: rows.map((r) => ({ ...r, sources: sourceMap.get(r.id) ?? [] })),
    total: totalRow.n,
    hasMore: args.offset + rows.length < totalRow.n,
  };
}

export function getReleaseDetail(
  db: Database.Database,
  id: string,
): {
  release: ReleaseRow;
  sources: SourceLinkRow[];
  facets: SourceFacetRow[];
  tracks: Array<TrackRow & { sources: string[] }>;
} | null {
  const release = db
    .prepare(`SELECT id, title, artist, year, country, label, catno FROM release WHERE id = ?`)
    .get(id) as ReleaseRow | undefined;
  if (!release) return null;

  const sources = db
    .prepare(
      `SELECT source, external_id, external_url, match_method
         FROM source_link WHERE entity_kind='release' AND entity_id = ?`,
    )
    .all(id) as SourceLinkRow[];

  const facets = db
    .prepare(
      `SELECT source, key, value
         FROM source_facets WHERE entity_kind='release' AND entity_id = ?`,
    )
    .all(id) as SourceFacetRow[];

  const tracks = db
    .prepare(
      `SELECT id, title, artist, album, duration_ms, release_id, position
         FROM track WHERE release_id = ?
         ORDER BY position COLLATE NOCASE, title COLLATE NOCASE`,
    )
    .all(id) as TrackRow[];

  const trackIds = tracks.map((t) => t.id);
  const trackSources = trackIds.length
    ? (db
        .prepare(
          `SELECT entity_id, source FROM source_link
             WHERE entity_kind='track' AND entity_id IN (${trackIds.map(() => '?').join(',')})`,
        )
        .all(...trackIds) as { entity_id: string; source: string }[])
    : [];

  const trackSourceMap = new Map<string, string[]>();
  for (const { entity_id, source } of trackSources) {
    const list = trackSourceMap.get(entity_id) ?? [];
    list.push(source);
    trackSourceMap.set(entity_id, list);
  }

  return {
    release,
    sources,
    facets,
    tracks: tracks.map((t) => ({ ...t, sources: trackSourceMap.get(t.id) ?? [] })),
  };
}

export function getTrackDetail(
  db: Database.Database,
  id: string,
): {
  track: TrackRow;
  sources: SourceLinkRow[];
  facets: SourceFacetRow[];
  release: ReleaseRow | null;
} | null {
  const track = db
    .prepare(
      `SELECT id, title, artist, album, duration_ms, release_id, position
         FROM track WHERE id = ?`,
    )
    .get(id) as TrackRow | undefined;
  if (!track) return null;

  const sources = db
    .prepare(
      `SELECT source, external_id, external_url, match_method
         FROM source_link WHERE entity_kind='track' AND entity_id = ?`,
    )
    .all(id) as SourceLinkRow[];

  const facets = db
    .prepare(
      `SELECT source, key, value
         FROM source_facets WHERE entity_kind='track' AND entity_id = ?`,
    )
    .all(id) as SourceFacetRow[];

  let release: ReleaseRow | null = null;
  if (track.release_id) {
    release =
      (db
        .prepare(
          `SELECT id, title, artist, year, country, label, catno FROM release WHERE id = ?`,
        )
        .get(track.release_id) as ReleaseRow | undefined) ?? null;
  }

  return { track, sources, facets, release };
}

export interface SourceWithState {
  id: string;
  name: string;
  contributes: ('track' | 'release')[];
  isStub: boolean;
  count: number;
  lastSyncedAt: string | null;
  lastSummary: unknown | null;
}

export function listSourcesWithState(
  db: Database.Database,
  registry: { id: string; name: string; contributes: ('track' | 'release')[]; isStub?: boolean }[],
): SourceWithState[] {
  const counts = db
    .prepare(`SELECT source, COUNT(*) as n FROM source_link GROUP BY source`)
    .all() as { source: string; n: number }[];
  const countMap = new Map(counts.map((c) => [c.source, c.n]));

  const states = db
    .prepare(`SELECT source, last_synced_at, last_summary FROM source_state`)
    .all() as { source: string; last_synced_at: string; last_summary: string }[];
  const stateMap = new Map(states.map((s) => [s.source, s]));

  return registry.map((src) => {
    const state = stateMap.get(src.id);
    return {
      id: src.id,
      name: src.name,
      contributes: src.contributes,
      isStub: !!src.isStub,
      count: countMap.get(src.id) ?? 0,
      lastSyncedAt: state?.last_synced_at ?? null,
      lastSummary: state?.last_summary ? JSON.parse(state.last_summary) : null,
    };
  });
}
```

If `import type Database from 'better-sqlite3'` is not already at the top of the file, add it.

- [x] **Step 2: Write the verification script**

Create `scripts/verify-queries.ts`:

```ts
import Database from 'better-sqlite3';
import { runMigrations } from '../src/lib/server/db/migrate';
import { collate } from '../src/lib/server/library/collate';
import {
  listReleases,
  listTracks,
  getReleaseDetail,
  getTrackDetail,
  listSourcesWithState,
} from '../src/lib/server/library/queries';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) fail(msg);
}

const db = new Database(':memory:');
runMigrations(db);

// Seed: one release in two sources, two tracks under it from itunes.
collate(db, 'discogs', {
  releases: [
    {
      externalId: '12721',
      title: 'Homework',
      artist: 'Daft Punk',
      year: 1997,
      label: 'Virgin',
      catno: 'VIR1',
      externalUrl: 'https://www.discogs.com/release/12721',
    },
  ],
  tracks: [],
});

collate(db, 'itunes', {
  releases: [
    {
      externalId: 'itunes-album:abc',
      title: 'Homework',
      artist: 'Daft Punk',
      year: 1997,
      facets: { trackCount: 2 },
    },
    {
      externalId: 'itunes-album:def',
      title: 'Discovery',
      artist: 'Daft Punk',
      year: 2001,
    },
  ],
  tracks: [
    {
      externalId: 'itunes-1',
      title: 'Around the World',
      artist: 'Daft Punk',
      album: 'Homework',
      releaseExternalId: 'itunes-album:abc',
      filePath: '/Music/AroundTheWorld.m4a',
      facets: { rating: 5, playCount: 47 },
    },
    {
      externalId: 'itunes-2',
      title: 'Da Funk',
      artist: 'Daft Punk',
      album: 'Homework',
      releaseExternalId: 'itunes-album:abc',
      filePath: '/Music/DaFunk.m4a',
    },
  ],
});

// listReleases: no filter
const all = listReleases(db, { limit: 10, offset: 0 });
assert(all.total === 2, `expected 2 releases, got ${all.total}`);
assert(all.items.length === 2, `expected 2 items, got ${all.items.length}`);
assert(all.hasMore === false, 'hasMore should be false');

// listReleases: filter by source
const justDiscogs = listReleases(db, { source: 'discogs', limit: 10, offset: 0 });
assert(justDiscogs.total === 1, `discogs filter: expected 1, got ${justDiscogs.total}`);

// listReleases: multi_source — Homework is in both
const multi = listReleases(db, { multiSource: true, limit: 10, offset: 0 });
assert(multi.total === 1, `multi-source: expected 1, got ${multi.total}`);
assert(multi.items[0].title === 'Homework', `multi-source title wrong: ${multi.items[0].title}`);
assert(
  multi.items[0].sources.length === 2,
  `multi-source: expected 2 sources, got ${multi.items[0].sources.length}`,
);

// listReleases: search
const byQ = listReleases(db, { q: 'discov', limit: 10, offset: 0 });
assert(byQ.total === 1, `search: expected 1, got ${byQ.total}`);
assert(byQ.items[0].title === 'Discovery', `search title wrong: ${byQ.items[0].title}`);

// listReleases: pagination
const page1 = listReleases(db, { limit: 1, offset: 0 });
assert(page1.items.length === 1, `page1 size wrong: ${page1.items.length}`);
assert(page1.hasMore === true, 'page1 hasMore should be true');
const page2 = listReleases(db, { limit: 1, offset: 1 });
assert(page2.hasMore === false, 'page2 hasMore should be false');

// listTracks
const tracks = listTracks(db, { limit: 10, offset: 0 });
assert(tracks.total === 2, `tracks total: expected 2, got ${tracks.total}`);
const trackByQ = listTracks(db, { q: 'around', limit: 10, offset: 0 });
assert(trackByQ.total === 1, `track search: expected 1, got ${trackByQ.total}`);

// getReleaseDetail
const homeworkId = multi.items[0].id;
const detail = getReleaseDetail(db, homeworkId);
assert(detail !== null, 'getReleaseDetail returned null');
assert(detail!.sources.length === 2, `detail sources: expected 2, got ${detail!.sources.length}`);
assert(detail!.tracks.length === 2, `detail tracks: expected 2, got ${detail!.tracks.length}`);
assert(getReleaseDetail(db, 'no-such-id') === null, 'missing detail should be null');

// getTrackDetail
const trackId = tracks.items[0].id;
const trackDetail = getTrackDetail(db, trackId);
assert(trackDetail !== null, 'getTrackDetail returned null');
assert(trackDetail!.release !== null, 'track parent release should be present');

// listSourcesWithState
const registryStub = [
  { id: 'discogs', name: 'Discogs', contributes: ['release' as const] },
  { id: 'itunes', name: 'Apple Music', contributes: ['track' as const, 'release' as const] },
  { id: 'rekordbox', name: 'Rekordbox', contributes: ['track' as const], isStub: true },
];
const sources = listSourcesWithState(db, registryStub);
assert(sources.length === 3, `sources length: expected 3, got ${sources.length}`);
const discogs = sources.find((s) => s.id === 'discogs');
assert(discogs?.count === 1, `discogs count: expected 1, got ${discogs?.count}`);
assert(discogs?.lastSyncedAt !== null, 'discogs lastSyncedAt should be set');
const rb = sources.find((s) => s.id === 'rekordbox');
assert(rb?.isStub === true, 'rekordbox should be marked stub');
assert(rb?.count === 0, 'rekordbox count should be 0');

console.log('PASS: queries — listReleases, listTracks, details, sources-with-state');
```

- [x] **Step 3: Verify**

Run: `pnpm verify scripts/verify-queries.ts`
Expected: `PASS: queries — listReleases, listTracks, details, sources-with-state`

- [x] **Step 4: Type-check**

Run: `pnpm tsc`
Expected: no errors.

- [x] **Step 5: Commit**

```bash
git add src/lib/server/library/queries.ts scripts/verify-queries.ts
git commit -m "feat(library): paginated lists + detail + sources-with-state helpers"
```

---

### Task 3: Add `isStub` flag to stub adapters

**Files:**
- Modify: `src/lib/server/sources/types.ts` (add optional `isStub?: boolean` to `MusicSource`)
- Modify: `src/lib/server/sources/rekordbox/index.ts` (set `isStub: true`)
- Modify: `src/lib/server/sources/plex/index.ts` (set `isStub: true`)

- [x] **Step 1: Extend the `MusicSource` interface**

Open `src/lib/server/sources/types.ts`. Find the `MusicSource` interface and add an optional `isStub` property:

```ts
export interface MusicSource {
  readonly id: string;
  readonly name: string;
  readonly contributes: EntityKind[];
  /** True for adapters whose `sync()` throws `NotImplementedError`. */
  readonly isStub?: boolean;
  sync(): Promise<SyncResult>;
}
```

- [x] **Step 2: Mark the Rekordbox stub**

Open `src/lib/server/sources/rekordbox/index.ts`. The exported source object already has `id`, `name`, `contributes`, `sync()`. Add `isStub: true`:

```ts
export const rekordboxSource: MusicSource = {
  id: 'rekordbox',
  name: 'Rekordbox',
  contributes: ['track'],
  isStub: true,
  async sync(): Promise<SyncResult> {
    throw new NotImplementedError('rekordbox sync not implemented');
  },
};
```

(Keep the existing imports and any surrounding code; the change is the `isStub: true` line.)

- [x] **Step 3: Mark the Plex stub**

Open `src/lib/server/sources/plex/index.ts`. Same change:

```ts
export const plexSource: MusicSource = {
  id: 'plex',
  name: 'Plex',
  contributes: ['track'],
  isStub: true,
  async sync(): Promise<SyncResult> {
    throw new NotImplementedError('plex sync not implemented');
  },
};
```

- [x] **Step 4: Type-check**

Run: `pnpm tsc`
Expected: no errors.

- [x] **Step 5: Commit**

```bash
git add src/lib/server/sources/types.ts src/lib/server/sources/rekordbox/index.ts src/lib/server/sources/plex/index.ts
git commit -m "feat(sources): isStub flag on MusicSource; mark rekordbox + plex"
```

---

### Task 4: Augment `/api/library/releases` and `/api/library/tracks`

**Files:**
- Modify: `src/routes/api/library/releases/+server.ts` (paginate + search + multi_source; new response shape)
- Modify: `src/routes/api/library/tracks/+server.ts` (paginate + search; new response shape)

- [x] **Step 1: Replace the releases endpoint**

Open `src/routes/api/library/releases/+server.ts`. Replace its contents with:

```ts
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { listReleases } from '$lib/server/library/queries';

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 200;

export const GET: RequestHandler = async ({ url }) => {
  const source = url.searchParams.get('source') ?? undefined;
  const q = url.searchParams.get('q') ?? undefined;
  const multiSource = url.searchParams.get('multi_source') === 'true';

  const rawLimit = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT);
  const limit = Math.max(1, Math.min(MAX_LIMIT, Number.isFinite(rawLimit) ? rawLimit : DEFAULT_LIMIT));
  const rawOffset = Number(url.searchParams.get('offset') ?? 0);
  const offset = Math.max(0, Number.isFinite(rawOffset) ? rawOffset : 0);

  const result = listReleases(getDb(), { source, q, limit, offset, multiSource });
  return json(result);
};
```

- [x] **Step 2: Replace the tracks endpoint**

Open `src/routes/api/library/tracks/+server.ts`. Replace its contents with:

```ts
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { listTracks } from '$lib/server/library/queries';

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 200;

export const GET: RequestHandler = async ({ url }) => {
  const source = url.searchParams.get('source') ?? undefined;
  const q = url.searchParams.get('q') ?? undefined;

  const rawLimit = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT);
  const limit = Math.max(1, Math.min(MAX_LIMIT, Number.isFinite(rawLimit) ? rawLimit : DEFAULT_LIMIT));
  const rawOffset = Number(url.searchParams.get('offset') ?? 0);
  const offset = Math.max(0, Number.isFinite(rawOffset) ? rawOffset : 0);

  const result = listTracks(getDb(), { source, q, limit, offset });
  return json(result);
};
```

- [x] **Step 3: Type-check**

Run: `pnpm tsc`
Expected: no errors.

- [x] **Step 4: Smoke test with curl**

Run: `pnpm dev` (one terminal).

In another terminal:

```bash
curl -s 'http://localhost:5173/api/library/releases?limit=2'
```

Expected: JSON shape `{"items":[…],"total":N,"hasMore":true|false}` with at most 2 items.

```bash
curl -s 'http://localhost:5173/api/library/releases?multi_source=true&limit=5'
```

Expected: same shape; items are releases that exist in ≥2 sources.

```bash
curl -s 'http://localhost:5173/api/library/tracks?q=around&limit=5'
```

Expected: same shape; items match `%around%` on title/artist/album.

Stop the dev server.

- [x] **Step 5: Commit**

```bash
git add src/routes/api/library/releases/+server.ts src/routes/api/library/tracks/+server.ts
git commit -m "feat(api): paginate + search on releases/tracks; new {items,total,hasMore} shape"
```

---

### Task 5: New `/api/library/releases/[id]`, `/api/library/tracks/[id]`, `/api/sources`

**Files:**
- Create: `src/routes/api/library/releases/[id]/+server.ts`
- Create: `src/routes/api/library/tracks/[id]/+server.ts`
- Create: `src/routes/api/sources/+server.ts`

- [x] **Step 1: Release detail endpoint**

Create `src/routes/api/library/releases/[id]/+server.ts`:

```ts
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { getReleaseDetail } from '$lib/server/library/queries';

export const GET: RequestHandler = async ({ params }) => {
  const detail = getReleaseDetail(getDb(), params.id);
  if (!detail) throw error(404, `release not found: ${params.id}`);
  return json(detail);
};
```

- [x] **Step 2: Track detail endpoint**

Create `src/routes/api/library/tracks/[id]/+server.ts`:

```ts
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { getTrackDetail } from '$lib/server/library/queries';

export const GET: RequestHandler = async ({ params }) => {
  const detail = getTrackDetail(getDb(), params.id);
  if (!detail) throw error(404, `track not found: ${params.id}`);
  return json(detail);
};
```

- [x] **Step 3: Sources listing endpoint**

Create `src/routes/api/sources/+server.ts`:

```ts
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { listSources } from '$lib/server/sources/registry';
import { listSourcesWithState } from '$lib/server/library/queries';

export const GET: RequestHandler = async () => {
  const registry = listSources().map((s) => ({
    id: s.id,
    name: s.name,
    contributes: s.contributes,
    isStub: !!s.isStub,
  }));
  return json(listSourcesWithState(getDb(), registry));
};
```

- [x] **Step 4: Type-check**

Run: `pnpm tsc`
Expected: no errors.

- [x] **Step 5: Smoke test with curl**

Run: `pnpm dev`.

```bash
curl -s 'http://localhost:5173/api/sources'
```

Expected: JSON array of `{id, name, contributes, isStub, count, lastSyncedAt, lastSummary}` for all four registered sources. Discogs and iTunes should have non-zero counts; Rekordbox and Plex should be `{count: 0, isStub: true, lastSyncedAt: null}`.

Pick a release id from the previous task's release listing and curl its detail:

```bash
curl -s 'http://localhost:5173/api/library/releases?limit=1' | head -c 300
```

Note an `id` value, then:

```bash
curl -s 'http://localhost:5173/api/library/releases/<paste-id-here>' | head -c 600
```

Expected: `{release: {…}, sources: [...], facets: [...], tracks: [...]}` — `tracks` may be empty if no iTunes track was matched to that release.

Stop the dev server.

- [x] **Step 6: Commit**

```bash
git add src/routes/api/library/releases/[id]/+server.ts src/routes/api/library/tracks/[id]/+server.ts src/routes/api/sources/+server.ts
git commit -m "feat(api): single-entity detail endpoints + GET /api/sources"
```

---

## Phase 1 — Tokens + atomic visual components

### Task 6: Token additions in `app.css`

**Files:**
- Modify: `src/app.css`

- [x] **Step 1: Update tokens**

Open `src/app.css`. Inside the `:root { … }` block (alongside the existing `--bg`, `--border`, etc.), add the new tokens. The existing `--bg-raised` value also changes from `#1a1a1a` to `#131313` to support hairline aesthetics.

Replace the `--bg-raised: #1a1a1a;` line with `--bg-raised: #131313;` and add the following new tokens after the existing `--accent-border` line:

```css
  --bg-row-hover: #161616;
  --accent-strong: #6fa3e6;

  --src-discogs:   #c89a5b;
  --src-itunes:    #d36b6b;
  --src-rekordbox: #5b9cd6;
  --src-plex:      #d4a04b;
  --src-empty:     #2a2a2a;
```

- [x] **Step 2: Verify**

Run: `pnpm tsc`
Expected: no errors (CSS doesn't type-check, but ensures the rest of the project still compiles).

Run: `pnpm dev` and load `http://localhost:5173`. The existing search page should still render correctly with no visual regressions in the dark theme. Stop the dev server.

- [x] **Step 3: Commit**

```bash
git add src/app.css
git commit -m "feat(css): explorer tokens — source colors, row hover, darker raised bg"
```

---

### Task 7: `SourceGrid.svelte`

**Files:**
- Create: `src/lib/components/SourceGrid.svelte`

- [x] **Step 1: Implement the component**

Create `src/lib/components/SourceGrid.svelte`:

```svelte
<script lang="ts">
  /**
   * Fixed 4-slot grid: D / i / R / P (Discogs, iTunes, Rekordbox, Plex).
   * `present` is the set of source ids the entity has a source_link for.
   */
  let { present }: { present: string[] } = $props();

  const SLOTS: { id: string; cls: string }[] = [
    { id: 'discogs', cls: 'discogs' },
    { id: 'itunes', cls: 'itunes' },
    { id: 'rekordbox', cls: 'rekordbox' },
    { id: 'plex', cls: 'plex' },
  ];

  const presentSet = $derived(new Set(present));
</script>

<span class="grid">
  {#each SLOTS as slot}
    <span class="slot {slot.cls}" class:on={presentSet.has(slot.id)} title={slot.id}></span>
  {/each}
</span>

<style>
  .grid {
    display: inline-grid;
    grid-template-columns: repeat(4, 8px);
    gap: 4px;
    align-items: center;
  }
  .slot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    border: 1px solid var(--src-empty);
    background: transparent;
  }
  .slot.on.discogs   { background: var(--src-discogs);   border-color: var(--src-discogs); }
  .slot.on.itunes    { background: var(--src-itunes);    border-color: var(--src-itunes); }
  .slot.on.rekordbox { background: var(--src-rekordbox); border-color: var(--src-rekordbox); }
  .slot.on.plex      { background: var(--src-plex);      border-color: var(--src-plex); }
</style>
```

- [x] **Step 2: Type-check**

Run: `pnpm tsc`
Expected: no errors.

- [x] **Step 3: Commit**

```bash
git add src/lib/components/SourceGrid.svelte
git commit -m "feat(ui): SourceGrid component (4-slot D/i/R/P widget)"
```

---

### Task 8: `SourcePanel.svelte`

**Files:**
- Create: `src/lib/components/SourcePanel.svelte`

- [x] **Step 1: Implement the component**

Create `src/lib/components/SourcePanel.svelte`:

```svelte
<script lang="ts">
  /**
   * Per-source detail panel — header (source dot + name + optional open-link),
   * body of key/value rows. Stub sources render dimmed with a placeholder.
   */
  interface Facet { key: string; value: string; mono?: boolean }

  let {
    sourceId,
    sourceName,
    facets = [],
    externalUrl = null,
    isStub = false,
  }: {
    sourceId: string;
    sourceName: string;
    facets?: Facet[];
    externalUrl?: string | null;
    isStub?: boolean;
  } = $props();
</script>

<div class="panel" class:stub={isStub}>
  <div class="header">
    <span class="dot {sourceId}"></span>
    <span class="name">{sourceName}</span>
    {#if externalUrl}
      <a class="open-link" href={externalUrl} target="_blank" rel="noreferrer">open ↗</a>
    {/if}
  </div>
  <div class="body">
    {#if isStub}
      <div class="empty">Source not yet implemented.</div>
    {:else if facets.length === 0}
      <div class="empty">No facets contributed.</div>
    {:else}
      {#each facets as facet}
        <div class="row">
          <span class="key">{facet.key}</span>
          <span class="value" class:mono={facet.mono}>{facet.value}</span>
        </div>
      {/each}
    {/if}
  </div>
</div>

<style>
  .panel {
    border: 1px solid var(--border);
    border-radius: 4px;
    margin-bottom: 10px;
    overflow: hidden;
    background: var(--bg-raised);
  }
  .panel.stub { opacity: 0.45; }

  .header {
    padding: 7px 11px;
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 600;
    color: var(--text-muted);
    display: flex;
    align-items: center;
    gap: 8px;
    border-bottom: 1px solid var(--border);
  }
  .name { flex: 0 0 auto; }
  .open-link {
    margin-left: auto;
    color: var(--text-subtle);
    text-decoration: none;
    font-size: 10px;
    text-transform: none;
    letter-spacing: 0;
  }
  .open-link:hover { color: var(--accent); }

  .dot {
    width: 6px; height: 6px; border-radius: 50%;
    flex-shrink: 0;
  }
  .dot.discogs   { background: var(--src-discogs); }
  .dot.itunes    { background: var(--src-itunes); }
  .dot.rekordbox { background: var(--src-rekordbox); opacity: 0.45; }
  .dot.plex      { background: var(--src-plex);      opacity: 0.45; }

  .body { padding: 8px 11px 10px; font-size: 12px; }
  .row {
    display: grid;
    grid-template-columns: 78px 1fr;
    gap: 12px;
    padding: 2px 0;
  }
  .key { color: var(--text-subtle); font-size: 11px; }
  .value {
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .value.mono {
    font-family: var(--font-mono);
    font-size: 11.5px;
  }
  .empty { color: var(--text-subtle); font-size: 11px; }
</style>
```

- [x] **Step 2: Type-check**

Run: `pnpm tsc`
Expected: no errors.

- [x] **Step 3: Commit**

```bash
git add src/lib/components/SourcePanel.svelte
git commit -m "feat(ui): SourcePanel component (per-source detail block)"
```

---

### Task 9: `SyncChip.svelte`

**Files:**
- Create: `src/lib/components/SyncChip.svelte`

- [ ] **Step 1: Implement the component**

Create `src/lib/components/SyncChip.svelte`:

```svelte
<script lang="ts">
  /**
   * Sync chip surfaced in the listview toolbar when a Sources rail item is
   * selected. Three states:
   *   - real source, has been synced: "Synced 12m ago · ⟳" (clickable)
   *   - real source, never synced:    "Sync"               (clickable)
   *   - stub source:                  "Not implemented"     (disabled)
   * Shows "Syncing…" with spinner while a sync is in flight.
   */
  let {
    isStub = false,
    lastSyncedAt = null,
    syncing = false,
    onSync,
  }: {
    isStub?: boolean;
    lastSyncedAt?: string | null;
    syncing?: boolean;
    onSync?: () => void;
  } = $props();

  function relativeTime(iso: string): string {
    const then = new Date(iso).getTime();
    const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  const label = $derived(
    isStub
      ? 'Not implemented'
      : syncing
        ? 'Syncing…'
        : lastSyncedAt
          ? `Synced ${relativeTime(lastSyncedAt)} · ⟳`
          : 'Sync',
  );

  const disabled = $derived(isStub || syncing);
</script>

<button class="chip" class:stub={isStub} class:syncing {disabled} onclick={() => onSync?.()}>
  {#if syncing}
    <span class="spinner" aria-hidden="true"></span>
  {/if}
  <span class="label">{label}</span>
</button>

<style>
  .chip {
    background: transparent;
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    color: var(--text-muted);
    padding: 4px 9px;
    font-size: 11px;
    font-family: inherit;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .chip:hover:not(:disabled) {
    color: var(--text);
    border-color: var(--text-muted);
  }
  .chip:disabled {
    cursor: default;
    color: var(--text-subtle);
  }
  .chip.stub { color: var(--text-subtle); }

  .spinner {
    display: inline-block;
    width: 9px;
    height: 9px;
    border: 1.5px solid currentColor;
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 0.75s linear infinite;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
</style>
```

- [ ] **Step 2: Type-check**

Run: `pnpm tsc`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/components/SyncChip.svelte
git commit -m "feat(ui): SyncChip — last-synced indicator + sync trigger"
```

---

### Task 10: `EmptyState.svelte`

**Files:**
- Create: `src/lib/components/EmptyState.svelte`

- [ ] **Step 1: Implement the component**

Create `src/lib/components/EmptyState.svelte`:

```svelte
<script lang="ts">
  /**
   * Centered empty state — used in stub sources, never-synced sources,
   * empty search results, no-entity-selected detail, etc.
   */
  let {
    title,
    detail = '',
    cta = null,
    onCta,
  }: {
    title: string;
    detail?: string;
    cta?: string | null;
    onCta?: () => void;
  } = $props();
</script>

<div class="empty">
  <div class="title">{title}</div>
  {#if detail}<div class="detail">{detail}</div>{/if}
  {#if cta}
    <button class="cta" onclick={() => onCta?.()}>{cta}</button>
  {/if}
</div>

<style>
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    min-height: 200px;
    padding: 24px;
    color: var(--text-subtle);
    text-align: center;
  }
  .title {
    color: var(--text-muted);
    font-size: 13px;
    margin-bottom: 6px;
  }
  .detail {
    font-size: 12px;
    max-width: 320px;
    line-height: 1.5;
  }
  .cta {
    margin-top: 12px;
    background: transparent;
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    color: var(--text);
    padding: 6px 12px;
    font-size: 12px;
    font-family: inherit;
    cursor: pointer;
  }
  .cta:hover {
    border-color: var(--text-muted);
  }
</style>
```

- [ ] **Step 2: Type-check**

Run: `pnpm tsc`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/components/EmptyState.svelte
git commit -m "feat(ui): EmptyState component (centered nothing-here pattern)"
```

---

## Phase 2 — Layout + listview

### Task 11: `explorerState.svelte.ts` store

**Files:**
- Create: `src/lib/stores/explorerState.svelte.ts`

- [ ] **Step 1: Implement the store**

Create `src/lib/stores/explorerState.svelte.ts`:

```ts
/**
 * Mirror of the explorer's URL state. The Explorer.svelte shell keeps URL ↔
 * store sync; child components read from this store.
 *
 * URL params: ?nav=<section>:<item>, ?id=<entityId>, ?q=<query>, ?entity=<releases|tracks>
 */

export type NavSection = 'library' | 'sources' | 'add';
export interface NavValue { section: NavSection; item: string; }

export type EntityKind = 'releases' | 'tracks';

const DEFAULT_NAV: NavValue = { section: 'library', item: 'all-releases' };

export function parseNav(raw: string | null): NavValue {
  if (!raw) return { ...DEFAULT_NAV };
  const [section, item] = raw.split(':');
  if (section !== 'library' && section !== 'sources' && section !== 'add') {
    return { ...DEFAULT_NAV };
  }
  if (!item) return { ...DEFAULT_NAV };
  return { section, item };
}

export function navToString(nav: NavValue): string {
  return `${nav.section}:${nav.item}`;
}

class ExplorerState {
  nav = $state<NavValue>({ ...DEFAULT_NAV });
  id = $state<string | null>(null);
  q = $state<string>('');
  entity = $state<EntityKind | null>(null); // null = use rail item's default

  /** Set from URL params on mount, or whenever the URL changes externally. */
  hydrate(params: URLSearchParams) {
    this.nav = parseNav(params.get('nav'));
    this.id = params.get('id');
    this.q = params.get('q') ?? '';
    const entity = params.get('entity');
    this.entity = entity === 'releases' || entity === 'tracks' ? entity : null;
  }

  /** Serialize current state to URLSearchParams. Omits empty/default values. */
  serialize(): URLSearchParams {
    const params = new URLSearchParams();
    if (navToString(this.nav) !== navToString(DEFAULT_NAV)) {
      params.set('nav', navToString(this.nav));
    }
    if (this.id) params.set('id', this.id);
    if (this.q) params.set('q', this.q);
    if (this.entity) params.set('entity', this.entity);
    return params;
  }

  /** Set rail item; clears entity selection (different rail = different list). */
  setNav(nav: NavValue) {
    this.nav = nav;
    this.id = null;
    // Don't clear q — user may want to refine across rails. Reconsider if it feels wrong.
  }

  setEntity(id: string | null) {
    this.id = id;
  }

  setQuery(q: string) {
    this.q = q;
  }

  setEntityKind(entity: EntityKind | null) {
    this.entity = entity;
  }
}

export const explorerState = new ExplorerState();
```

- [ ] **Step 2: Type-check**

Run: `pnpm tsc`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/stores/explorerState.svelte.ts
git commit -m "feat(stores): explorerState — mirrors ?nav, ?id, ?q, ?entity URL params"
```

---

### Task 12: `Listview.svelte` (generic paginated shell)

**Files:**
- Create: `src/lib/components/Listview.svelte`

- [ ] **Step 1: Implement the component**

Create `src/lib/components/Listview.svelte`:

```svelte
<script lang="ts" generics="T extends { id: string }">
  import type { Snippet } from 'svelte';

  /**
   * Generic paginated list shell. Caller provides:
   *  - `items`: the rows to render
   *  - `total`, `hasMore`: pagination state from the server
   *  - `headers` snippet: column-header strip
   *  - `row` snippet: per-row markup, receives the item
   *  - `loadMore` callback: fired when the sentinel scrolls into view
   *  - `selectedId`, `onSelect`: selection state
   */
  let {
    items,
    total,
    hasMore,
    selectedId = null,
    onSelect,
    loadMore,
    headers,
    row,
    empty,
  }: {
    items: T[];
    total: number;
    hasMore: boolean;
    selectedId?: string | null;
    onSelect?: (id: string) => void;
    loadMore?: () => void;
    headers: Snippet;
    row: Snippet<[T, boolean]>;
    empty?: Snippet;
  } = $props();

  let sentinel: HTMLElement | undefined = $state();
  let observer: IntersectionObserver | undefined;

  $effect(() => {
    if (!sentinel) return;
    if (!hasMore) {
      observer?.disconnect();
      return;
    }
    observer?.disconnect();
    observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) loadMore?.();
      },
      { rootMargin: '400px' },
    );
    observer.observe(sentinel);
    return () => observer?.disconnect();
  });
</script>

<div class="listview">
  <div class="headers">{@render headers()}</div>
  <div class="body">
    {#if items.length === 0}
      {#if empty}{@render empty()}{:else}<div class="empty">No items.</div>{/if}
    {:else}
      {#each items as item (item.id)}
        <button
          class="row-btn"
          class:selected={item.id === selectedId}
          onclick={() => onSelect?.(item.id)}
          type="button"
        >
          {@render row(item, item.id === selectedId)}
        </button>
      {/each}
      {#if hasMore}
        <div class="sentinel" bind:this={sentinel}></div>
      {/if}
    {/if}
  </div>
</div>

<style>
  .listview {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }
  .headers {
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .body {
    flex: 1;
    overflow-y: auto;
  }
  .row-btn {
    display: block;
    width: 100%;
    background: transparent;
    border: 0;
    padding: 0;
    text-align: left;
    cursor: pointer;
    color: inherit;
    font: inherit;
  }
  .row-btn + .row-btn { border-top: 1px solid rgba(255, 255, 255, 0.025); }
  .row-btn:hover { background: var(--bg-row-hover); }
  .row-btn.selected { background: var(--accent-bg); }
  .sentinel { height: 1px; }
  .empty { padding: 24px; color: var(--text-subtle); text-align: center; font-size: 12px; }
</style>
```

- [ ] **Step 2: Type-check**

Run: `pnpm tsc`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/components/Listview.svelte
git commit -m "feat(ui): generic Listview component (pagination + sentinel + selection)"
```

---

### Task 13: `ReleaseList.svelte` and `TrackList.svelte`

**Files:**
- Create: `src/lib/components/ReleaseList.svelte`
- Create: `src/lib/components/TrackList.svelte`

- [ ] **Step 1: Implement `ReleaseList.svelte`**

Create `src/lib/components/ReleaseList.svelte`:

```svelte
<script lang="ts">
  import Listview from './Listview.svelte';
  import SourceGrid from './SourceGrid.svelte';
  import EmptyState from './EmptyState.svelte';

  interface ReleaseItem {
    id: string;
    title: string;
    artist: string;
    year: number | null;
    sources: string[];
  }

  let {
    items,
    total,
    hasMore,
    selectedId = null,
    onSelect,
    loadMore,
    emptyTitle = 'No releases',
    emptyDetail = '',
  }: {
    items: ReleaseItem[];
    total: number;
    hasMore: boolean;
    selectedId?: string | null;
    onSelect?: (id: string) => void;
    loadMore?: () => void;
    emptyTitle?: string;
    emptyDetail?: string;
  } = $props();
</script>

<Listview
  {items}
  {total}
  {hasMore}
  {selectedId}
  {onSelect}
  {loadMore}
>
  {#snippet headers()}
    <div class="cols">
      <span></span>
      <span>Release</span>
      <span class="right">Year</span>
      <span class="src-label">
        <span>D</span><span>i</span><span>R</span><span>P</span>
      </span>
    </div>
  {/snippet}
  {#snippet row(item)}
    <div class="row">
      <div class="cover">cov</div>
      <div class="meta">
        <div class="title">{item.title}</div>
        <div class="artist">{item.artist}</div>
      </div>
      <span class="year">{item.year ?? '—'}</span>
      <SourceGrid present={item.sources} />
    </div>
  {/snippet}
  {#snippet empty()}
    <EmptyState title={emptyTitle} detail={emptyDetail} />
  {/snippet}
</Listview>

<style>
  .cols, .row {
    display: grid;
    grid-template-columns: 40px 1fr 56px 56px;
    gap: 14px;
    padding: 6px 14px;
    align-items: center;
  }
  .cols {
    color: var(--text-subtle);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .row { padding: 7px 14px; }
  .right { text-align: right; }
  .src-label {
    display: grid;
    grid-template-columns: repeat(4, 8px);
    gap: 4px;
  }
  .src-label span {
    text-align: center;
    font-family: var(--font-mono);
    font-size: 9px;
    text-transform: none;
    letter-spacing: 0;
  }

  .cover {
    width: 40px; height: 40px;
    border-radius: 3px;
    background: var(--bg-raised);
    display: flex; align-items: center; justify-content: center;
    font-size: 9px; color: var(--text-subtle);
    flex-shrink: 0;
  }
  .meta { min-width: 0; }
  .title {
    color: var(--text);
    font-weight: 500;
    font-size: 13px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .artist {
    color: var(--text-muted);
    font-size: 12px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .year {
    color: var(--text-subtle);
    font-variant-numeric: tabular-nums;
    font-size: 12px;
    text-align: right;
  }
</style>
```

- [ ] **Step 2: Implement `TrackList.svelte`**

Create `src/lib/components/TrackList.svelte`:

```svelte
<script lang="ts">
  import Listview from './Listview.svelte';
  import SourceGrid from './SourceGrid.svelte';
  import EmptyState from './EmptyState.svelte';

  interface TrackItem {
    id: string;
    title: string;
    artist: string;
    album: string | null;
    duration_ms: number | null;
    sources: string[];
  }

  let {
    items,
    total,
    hasMore,
    selectedId = null,
    onSelect,
    loadMore,
    emptyTitle = 'No tracks',
    emptyDetail = '',
  }: {
    items: TrackItem[];
    total: number;
    hasMore: boolean;
    selectedId?: string | null;
    onSelect?: (id: string) => void;
    loadMore?: () => void;
    emptyTitle?: string;
    emptyDetail?: string;
  } = $props();

  function formatDuration(ms: number | null): string {
    if (!ms) return '—';
    const s = Math.round(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
</script>

<Listview
  {items}
  {total}
  {hasMore}
  {selectedId}
  {onSelect}
  {loadMore}
>
  {#snippet headers()}
    <div class="cols">
      <span>Track</span>
      <span>Album</span>
      <span class="right">Length</span>
      <span class="src-label">
        <span>D</span><span>i</span><span>R</span><span>P</span>
      </span>
    </div>
  {/snippet}
  {#snippet row(item)}
    <div class="row">
      <div class="meta">
        <div class="title">{item.title}</div>
        <div class="artist">{item.artist}</div>
      </div>
      <span class="album">{item.album ?? '—'}</span>
      <span class="dur">{formatDuration(item.duration_ms)}</span>
      <SourceGrid present={item.sources} />
    </div>
  {/snippet}
  {#snippet empty()}
    <EmptyState title={emptyTitle} detail={emptyDetail} />
  {/snippet}
</Listview>

<style>
  .cols, .row {
    display: grid;
    grid-template-columns: 1fr 100px 60px 56px;
    gap: 14px;
    padding: 6px 14px;
    align-items: center;
  }
  .cols {
    color: var(--text-subtle);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .row { padding: 7px 14px; }
  .right { text-align: right; }
  .src-label {
    display: grid;
    grid-template-columns: repeat(4, 8px);
    gap: 4px;
  }
  .src-label span {
    text-align: center;
    font-family: var(--font-mono);
    font-size: 9px;
    text-transform: none;
    letter-spacing: 0;
  }

  .meta { min-width: 0; }
  .title {
    color: var(--text);
    font-weight: 500;
    font-size: 13px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .artist {
    color: var(--text-muted);
    font-size: 12px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .album {
    color: var(--text-muted);
    font-size: 12px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .dur {
    color: var(--text-subtle);
    font-variant-numeric: tabular-nums;
    font-family: var(--font-mono);
    font-size: 11.5px;
    text-align: right;
  }
</style>
```

- [ ] **Step 3: Type-check**

Run: `pnpm tsc`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/components/ReleaseList.svelte src/lib/components/TrackList.svelte
git commit -m "feat(ui): ReleaseList + TrackList wrappers around Listview"
```

---

### Task 14: Refactor `SearchBar.svelte` to a debounced input

**Files:**
- Modify: `src/lib/components/SearchBar.svelte` (gut it; debounce + focus + emit only)

- [ ] **Step 1: Replace the file**

Open `src/lib/components/SearchBar.svelte`. Replace its entire contents with:

```svelte
<script lang="ts">
  /**
   * Debounced search input. Caller controls the value via two-way binding;
   * `onChange` fires after `delayMs` of input idleness.
   */
  let {
    value = $bindable(''),
    placeholder = 'Search…',
    delayMs = 250,
    onChange,
  }: {
    value?: string;
    placeholder?: string;
    delayMs?: number;
    onChange?: (v: string) => void;
  } = $props();

  let input: HTMLInputElement | undefined = $state();
  let timer: ReturnType<typeof setTimeout> | null = null;

  function onInput(e: Event) {
    const v = (e.target as HTMLInputElement).value;
    value = v;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => onChange?.(v), delayMs);
  }

  export function focus() {
    input?.focus();
  }

  export function blur() {
    input?.blur();
  }

  export function clear() {
    value = '';
    onChange?.('');
  }
</script>

<input
  bind:this={input}
  class="search"
  type="text"
  {placeholder}
  {value}
  oninput={onInput}
/>

<style>
  .search {
    width: 100%;
    background: var(--bg-input);
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    padding: 5px 9px;
    color: var(--text);
    font-family: inherit;
    font-size: 13px;
    outline: none;
  }
  .search:focus { border-color: var(--accent-border); }
  .search::placeholder { color: var(--text-subtle); }
</style>
```

- [ ] **Step 2: Type-check**

Run: `pnpm tsc`

The existing `+page.svelte` still imports `SearchBar` with the old prop shape; this will introduce TypeScript errors at the call site. That's expected and resolved when `+page.svelte` is rewritten in a later task.

Expected: errors are confined to `src/routes/+page.svelte` (consumer of the old SearchBar API). Do NOT fix them in this task.

- [ ] **Step 3: Commit**

```bash
git add src/lib/components/SearchBar.svelte
git commit -m "refactor(ui): SearchBar — debounced input + focus()/blur()/clear()"
```

---

### Task 15: `ListviewToolbar.svelte`

**Files:**
- Create: `src/lib/components/ListviewToolbar.svelte`

- [ ] **Step 1: Implement the component**

Create `src/lib/components/ListviewToolbar.svelte`:

```svelte
<script lang="ts">
  import SearchBar from './SearchBar.svelte';
  import SyncChip from './SyncChip.svelte';

  /**
   * Top bar of the middle pane. Search input is always present.
   * Contextual right-side controls: scanner button (Add views), entity-type
   * toggle (when source contributes both), sync chip (Sources views).
   */
  let {
    query = $bindable(''),
    placeholder = 'Search…',
    onQueryChange,
    showScanner = false,
    onScan,
    showEntityToggle = false,
    entity = 'releases',
    onEntityChange,
    showSyncChip = false,
    syncIsStub = false,
    syncLastAt = null,
    syncing = false,
    onSync,
    meta = '',
  }: {
    query?: string;
    placeholder?: string;
    onQueryChange?: (v: string) => void;
    showScanner?: boolean;
    onScan?: () => void;
    showEntityToggle?: boolean;
    entity?: 'releases' | 'tracks';
    onEntityChange?: (e: 'releases' | 'tracks') => void;
    showSyncChip?: boolean;
    syncIsStub?: boolean;
    syncLastAt?: string | null;
    syncing?: boolean;
    onSync?: () => void;
    meta?: string;
  } = $props();

  let searchBar: SearchBar | undefined = $state();

  // Re-export focus so the page can wire `/` to focus the input.
  export function focusSearch() {
    searchBar?.focus();
  }
</script>

<div class="bar">
  <div class="search-wrap">
    <SearchBar
      bind:this={searchBar}
      bind:value={query}
      {placeholder}
      onChange={onQueryChange}
    />
  </div>
  {#if showScanner}
    <button class="icon-btn" title="Scan barcode (s)" onclick={() => onScan?.()}>
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
        <path d="M2 2v10M4 2v10M6 2v6M8 2v10M10 2v6M12 2v10" stroke="currentColor" stroke-width="1"/>
      </svg>
    </button>
  {/if}
  {#if showEntityToggle}
    <div class="toggle">
      <button
        class:active={entity === 'tracks'}
        onclick={() => onEntityChange?.('tracks')}
      >Tracks</button>
      <button
        class:active={entity === 'releases'}
        onclick={() => onEntityChange?.('releases')}
      >Releases</button>
    </div>
  {/if}
  {#if showSyncChip}
    <SyncChip isStub={syncIsStub} lastSyncedAt={syncLastAt} {syncing} {onSync} />
  {/if}
  {#if meta}<span class="meta">{meta}</span>{/if}
</div>

<style>
  .bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .search-wrap { flex: 1; min-width: 0; }
  .icon-btn {
    width: 28px; height: 26px;
    background: transparent;
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    color: var(--text-muted);
    display: flex; align-items: center; justify-content: center;
    cursor: pointer;
    padding: 0;
  }
  .icon-btn:hover {
    color: var(--text);
    border-color: var(--text-muted);
  }
  .toggle {
    display: flex;
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    overflow: hidden;
  }
  .toggle button {
    background: transparent;
    border: 0;
    color: var(--text-muted);
    padding: 4px 9px;
    font-family: inherit;
    font-size: 11px;
    cursor: pointer;
  }
  .toggle button.active {
    background: var(--accent-bg);
    color: var(--text);
  }
  .meta {
    color: var(--text-subtle);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
</style>
```

- [ ] **Step 2: Type-check**

Run: `pnpm tsc`

Same caveat as Task 14 — errors confined to `+page.svelte` are expected.

- [ ] **Step 3: Commit**

```bash
git add src/lib/components/ListviewToolbar.svelte
git commit -m "feat(ui): ListviewToolbar — search + contextual right-side controls"
```

---

## Phase 3 — Detail panes

### Task 16: `ReleaseDetail.svelte`

**Files:**
- Create: `src/lib/components/ReleaseDetail.svelte`

- [ ] **Step 1: Implement the component**

Create `src/lib/components/ReleaseDetail.svelte`:

```svelte
<script lang="ts">
  import SourcePanel from './SourcePanel.svelte';
  import SourceGrid from './SourceGrid.svelte';

  interface SourceLink { source: string; external_id: string; external_url: string | null; match_method: string; }
  interface Facet { source: string; key: string; value: string; }
  interface Track {
    id: string;
    title: string;
    position: string | null;
    duration_ms: number | null;
    sources: string[];
  }
  interface Release {
    id: string;
    title: string;
    artist: string;
    year: number | null;
  }
  interface SourceMeta { id: string; name: string; isStub: boolean; }

  let {
    release,
    sources,
    facets,
    tracks,
    sourceMeta,
    addCta = null,
    onTrackSelect,
  }: {
    release: Release;
    sources: SourceLink[];
    facets: Facet[];
    tracks: Track[];
    sourceMeta: SourceMeta[];
    addCta?: { label: string; onClick: () => void; kbdHint?: string } | null;
    onTrackSelect?: (trackId: string) => void;
  } = $props();

  /** Group facets by source id, deciding which keys to show as mono. */
  function facetRowsFor(sourceId: string) {
    const monoKeys = new Set(['catno', 'release id', 'external id', 'file', 'file path']);
    return facets
      .filter((f) => f.source === sourceId)
      .map((f) => ({
        key: f.key.toLowerCase(),
        value: f.value,
        mono: monoKeys.has(f.key.toLowerCase()),
      }));
  }

  function durationLabel(ms: number | null): string {
    if (!ms) return '—';
    const s = Math.round(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  // Sources we want to *always* render a panel for (in registry order),
  // regardless of whether the release has a link. Lets stub sources show
  // their "not implemented" placeholder.
  const ALL_SOURCE_IDS = ['discogs', 'itunes', 'rekordbox', 'plex'];

  const sourcesById = $derived(new Map(sources.map((s) => [s.source, s])));
  const metaById = $derived(new Map(sourceMeta.map((m) => [m.id, m])));
</script>

<div class="detail">
  <div class="cover">600 × 600 cover</div>
  <div class="title">{release.title}</div>
  <div class="artist">{release.artist}{release.year ? ` · ${release.year}` : ''}</div>

  {#if addCta}
    <div class="cta-row">
      <button class="add-btn" onclick={addCta.onClick}>
        {addCta.label}
        {#if addCta.kbdHint}<span class="kbd-hint">{addCta.kbdHint}</span>{/if}
      </button>
    </div>
  {/if}

  {#each ALL_SOURCE_IDS as sid}
    {@const link = sourcesById.get(sid)}
    {@const meta = metaById.get(sid)}
    {#if meta}
      {#if link || meta.isStub}
        <SourcePanel
          sourceId={sid}
          sourceName={meta.name}
          isStub={meta.isStub && !link}
          externalUrl={link?.external_url ?? null}
          facets={link ? facetRowsFor(sid) : []}
        />
      {/if}
    {/if}
  {/each}

  {#if tracks.length > 0}
    <div class="tracklist">
      <div class="tracklist-header">Tracks ({tracks.length})</div>
      {#each tracks as t}
        <button class="track-row" type="button" onclick={() => onTrackSelect?.(t.id)}>
          <span class="position">{t.position ?? ''}</span>
          <span class="track-title">{t.title}</span>
          <span class="track-dur">{durationLabel(t.duration_ms)}</span>
          <SourceGrid present={t.sources} />
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .detail { padding: 18px 20px 24px; overflow-y: auto; height: 100%; }
  .cover {
    width: 100%;
    aspect-ratio: 1;
    background: var(--bg-raised);
    border-radius: 4px;
    margin-bottom: 14px;
    display: flex; align-items: center; justify-content: center;
    color: var(--text-subtle); font-size: 11px;
    border: 1px solid var(--border);
  }
  .title {
    font-size: 15px;
    font-weight: 600;
    color: var(--text);
    margin-bottom: 2px;
    line-height: 1.3;
  }
  .artist {
    color: var(--text-muted);
    font-size: 13px;
    margin-bottom: 14px;
  }

  .cta-row { margin-bottom: 16px; }
  .add-btn {
    width: 100%;
    background: var(--accent);
    border: 1px solid var(--accent);
    color: #fff;
    padding: 7px 12px;
    border-radius: 4px;
    font-size: 13px;
    font-family: inherit;
    font-weight: 500;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
  }
  .add-btn:hover { background: var(--accent-strong); }
  .kbd-hint {
    font-size: 11px;
    color: rgba(255, 255, 255, 0.7);
    font-family: var(--font-mono);
    border: 1px solid rgba(255, 255, 255, 0.3);
    border-radius: 2px;
    padding: 0 4px;
    margin-left: 4px;
  }

  .tracklist {
    margin-top: 18px;
    border-top: 1px solid var(--border);
    padding-top: 12px;
  }
  .tracklist-header {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-subtle);
    font-weight: 600;
    margin-bottom: 6px;
  }
  .track-row {
    display: grid;
    grid-template-columns: 28px 1fr 48px 56px;
    gap: 10px;
    padding: 4px 0;
    align-items: center;
    background: transparent;
    border: 0;
    width: 100%;
    text-align: left;
    cursor: pointer;
    color: inherit;
    font-family: inherit;
    font-size: 12px;
  }
  .track-row:hover { background: var(--bg-row-hover); }
  .position {
    color: var(--text-subtle);
    font-family: var(--font-mono);
    font-size: 11px;
  }
  .track-title {
    color: var(--text);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .track-dur {
    color: var(--text-subtle);
    font-family: var(--font-mono);
    font-size: 11px;
    text-align: right;
  }
</style>
```

- [ ] **Step 2: Type-check**

Run: `pnpm tsc`
Expected: no NEW errors (the existing `+page.svelte` errors from prior tasks remain).

- [ ] **Step 3: Commit**

```bash
git add src/lib/components/ReleaseDetail.svelte
git commit -m "feat(ui): ReleaseDetail with source panels + tracklist section"
```

---

### Task 17: `TrackDetail.svelte`

**Files:**
- Create: `src/lib/components/TrackDetail.svelte`

- [ ] **Step 1: Implement the component**

Create `src/lib/components/TrackDetail.svelte`:

```svelte
<script lang="ts">
  import SourcePanel from './SourcePanel.svelte';

  interface SourceLink { source: string; external_id: string; external_url: string | null; match_method: string; }
  interface Facet { source: string; key: string; value: string; }
  interface ParentRelease { id: string; title: string; artist: string; year: number | null; }
  interface Track { id: string; title: string; artist: string; duration_ms: number | null; }
  interface SourceMeta { id: string; name: string; isStub: boolean; }

  let {
    track,
    sources,
    facets,
    release,
    sourceMeta,
    onReleaseSelect,
  }: {
    track: Track;
    sources: SourceLink[];
    facets: Facet[];
    release: ParentRelease | null;
    sourceMeta: SourceMeta[];
    onReleaseSelect?: (releaseId: string) => void;
  } = $props();

  function facetRowsFor(sourceId: string) {
    const monoKeys = new Set(['file', 'file path', 'external id', 'bitrate', 'samplerate', 'date added', 'added']);
    return facets
      .filter((f) => f.source === sourceId)
      .map((f) => ({
        key: f.key.toLowerCase(),
        value: f.value,
        mono: monoKeys.has(f.key.toLowerCase()),
      }));
  }

  function durationLabel(ms: number | null): string {
    if (!ms) return '—';
    const s = Math.round(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  const ALL_SOURCE_IDS = ['discogs', 'itunes', 'rekordbox', 'plex'];

  const sourcesById = $derived(new Map(sources.map((s) => [s.source, s])));
  const metaById = $derived(new Map(sourceMeta.map((m) => [m.id, m])));
</script>

<div class="detail">
  {#if release}
    <button class="breadcrumb" onclick={() => onReleaseSelect?.(release.id)}>
      ← {release.title}
    </button>
  {/if}

  <div class="title">{track.title}</div>
  <div class="artist">{track.artist} · {durationLabel(track.duration_ms)}</div>

  {#if release}
    <button class="parent-card" onclick={() => onReleaseSelect?.(release.id)}>
      <div class="parent-cover">cov</div>
      <div class="parent-meta">
        <div class="parent-title">{release.title}</div>
        <div class="parent-artist">{release.artist}{release.year ? ` · ${release.year}` : ''}</div>
      </div>
    </button>
  {/if}

  {#each ALL_SOURCE_IDS as sid}
    {@const link = sourcesById.get(sid)}
    {@const meta = metaById.get(sid)}
    {#if meta}
      {#if link || meta.isStub}
        <SourcePanel
          sourceId={sid}
          sourceName={meta.name}
          isStub={meta.isStub && !link}
          externalUrl={link?.external_url ?? null}
          facets={link ? facetRowsFor(sid) : []}
        />
      {/if}
    {/if}
  {/each}
</div>

<style>
  .detail { padding: 18px 20px 24px; overflow-y: auto; height: 100%; }
  .breadcrumb {
    background: transparent; border: 0; color: var(--text-muted);
    padding: 0 0 8px;
    font-family: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .breadcrumb:hover { color: var(--text); }
  .title {
    font-size: 15px; font-weight: 600;
    color: var(--text);
    margin-bottom: 2px;
    line-height: 1.3;
  }
  .artist { color: var(--text-muted); font-size: 13px; margin-bottom: 14px; }
  .parent-card {
    display: flex;
    gap: 10px;
    width: 100%;
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 8px;
    cursor: pointer;
    margin-bottom: 12px;
    align-items: center;
    text-align: left;
    color: inherit;
    font-family: inherit;
  }
  .parent-card:hover { border-color: var(--text-muted); }
  .parent-cover {
    width: 48px; height: 48px;
    background: var(--bg);
    border-radius: 3px;
    display: flex; align-items: center; justify-content: center;
    color: var(--text-subtle);
    font-size: 9px;
    flex-shrink: 0;
  }
  .parent-meta { min-width: 0; }
  .parent-title {
    color: var(--text);
    font-size: 12px;
    font-weight: 500;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .parent-artist {
    color: var(--text-muted);
    font-size: 11px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
</style>
```

- [ ] **Step 2: Type-check**

Run: `pnpm tsc`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/components/TrackDetail.svelte
git commit -m "feat(ui): TrackDetail with parent-release card + source panels"
```

---

## Phase 4 — Rail + Explorer shell

### Task 18: `Rail.svelte`

**Files:**
- Create: `src/lib/components/Rail.svelte`

- [ ] **Step 1: Implement the component**

Create `src/lib/components/Rail.svelte`:

```svelte
<script lang="ts">
  import type { NavValue } from '$lib/stores/explorerState.svelte';

  interface SourceWithState {
    id: string;
    name: string;
    contributes: ('track' | 'release')[];
    isStub: boolean;
    count: number;
    lastSyncedAt: string | null;
  }

  interface Counts {
    allReleases: number;
    allTracks: number;
    inMultipleSources: number;
  }

  let {
    nav,
    sources,
    counts,
    onSelect,
  }: {
    nav: NavValue;
    sources: SourceWithState[];
    counts: Counts;
    onSelect?: (nav: NavValue) => void;
  } = $props();

  function isActive(section: string, item: string): boolean {
    return nav.section === section && nav.item === item;
  }

  function relativeTime(iso: string | null): string {
    if (!iso) return '';
    const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  const writableSources = $derived(sources.filter((s) => s.id === 'discogs')); // TODO: derive via CollectionWritable when more writable adapters land
</script>

<aside class="rail">
  <div class="section">
    <div class="label">Library</div>
    <button
      class="item"
      class:active={isActive('library', 'all-releases')}
      onclick={() => onSelect?.({ section: 'library', item: 'all-releases' })}
    >
      <span>All releases</span>
      <span class="count">{counts.allReleases.toLocaleString()}</span>
    </button>
    <button
      class="item"
      class:active={isActive('library', 'all-tracks')}
      onclick={() => onSelect?.({ section: 'library', item: 'all-tracks' })}
    >
      <span>All tracks</span>
      <span class="count">{counts.allTracks.toLocaleString()}</span>
    </button>
    <button
      class="item"
      class:active={isActive('library', 'in-multiple-sources')}
      onclick={() => onSelect?.({ section: 'library', item: 'in-multiple-sources' })}
    >
      <span>In multiple sources</span>
      <span class="count">{counts.inMultipleSources.toLocaleString()}</span>
    </button>
  </div>

  <div class="section">
    <div class="label">Sources</div>
    {#each sources as src}
      <button
        class="item"
        class:active={isActive('sources', src.id)}
        title={src.lastSyncedAt ? relativeTime(src.lastSyncedAt) : ''}
        onclick={() => onSelect?.({ section: 'sources', item: src.id })}
      >
        <span class="dot {src.id}" class:dim={src.isStub}></span>
        <span>{src.name}</span>
        <span class="count">{src.isStub ? '—' : src.count.toLocaleString()}</span>
      </button>
    {/each}
  </div>

  <div class="section">
    <div class="label">Add</div>
    {#each writableSources as src}
      <button
        class="item"
        class:active={isActive('add', src.id)}
        onclick={() => onSelect?.({ section: 'add', item: src.id })}
      >
        <span class="dot {src.id}"></span>
        <span>{src.name}</span>
      </button>
    {/each}
  </div>
</aside>

<style>
  .rail {
    border-right: 1px solid var(--border);
    padding: 14px 0;
    overflow-y: auto;
    background: var(--bg);
    height: 100%;
  }
  .section { margin-bottom: 18px; }
  .label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-subtle);
    padding: 0 16px 6px;
    font-weight: 600;
  }
  .item {
    background: transparent;
    border: 0;
    padding: 5px 16px;
    color: var(--text);
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 9px;
    font-family: inherit;
    font-size: 13px;
    width: 100%;
    text-align: left;
    border-left: 2px solid transparent;
  }
  .item:hover { background: var(--bg-row-hover); }
  .item.active {
    background: var(--accent-bg);
    border-left-color: var(--accent);
  }
  .item .count {
    color: var(--text-subtle);
    font-size: 11px;
    margin-left: auto;
    font-variant-numeric: tabular-nums;
  }
  .dot {
    width: 6px; height: 6px; border-radius: 50%;
    flex-shrink: 0;
  }
  .dot.discogs   { background: var(--src-discogs); }
  .dot.itunes    { background: var(--src-itunes); }
  .dot.rekordbox { background: var(--src-rekordbox); }
  .dot.plex      { background: var(--src-plex); }
  .dot.dim { opacity: 0.35; }
</style>
```

- [ ] **Step 2: Type-check**

Run: `pnpm tsc`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/components/Rail.svelte
git commit -m "feat(ui): Rail (Library + Sources + Add sections)"
```

---

### Task 19: `Explorer.svelte` shell + URL ↔ store sync + data fetching

**Files:**
- Create: `src/lib/components/Explorer.svelte`

- [ ] **Step 1: Implement the component**

Create `src/lib/components/Explorer.svelte`. This is the shell that wires URL state, fetches data, and composes Rail / ListviewToolbar / List / Detail. It is large; it earns its size by holding all the orchestration in one place.

```svelte
<script lang="ts">
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import Rail from './Rail.svelte';
  import ListviewToolbar from './ListviewToolbar.svelte';
  import ReleaseList from './ReleaseList.svelte';
  import TrackList from './TrackList.svelte';
  import ReleaseDetail from './ReleaseDetail.svelte';
  import TrackDetail from './TrackDetail.svelte';
  import EmptyState from './EmptyState.svelte';
  import Scanner from './Scanner.svelte';
  import SessionLog from './SessionLog.svelte';
  import { explorerState, navToString } from '$lib/stores/explorerState.svelte';
  import { collection } from '$lib/stores/collection.svelte';

  // ----- Source meta + counts ------------------------------------------------

  interface SourceWithState {
    id: string;
    name: string;
    contributes: ('track' | 'release')[];
    isStub: boolean;
    count: number;
    lastSyncedAt: string | null;
    lastSummary: unknown;
  }

  let sources = $state<SourceWithState[]>([]);
  let counts = $state({ allReleases: 0, allTracks: 0, inMultipleSources: 0 });
  let syncing = $state<string | null>(null); // source id being synced

  async function loadSourcesAndCounts() {
    const [srcRes, allRel, allTrk, multi] = await Promise.all([
      fetch('/api/sources').then((r) => r.json()),
      fetch('/api/library/releases?limit=1').then((r) => r.json()),
      fetch('/api/library/tracks?limit=1').then((r) => r.json()),
      fetch('/api/library/releases?multi_source=true&limit=1').then((r) => r.json()),
    ]);
    sources = srcRes;
    counts = {
      allReleases: allRel.total ?? 0,
      allTracks: allTrk.total ?? 0,
      inMultipleSources: multi.total ?? 0,
    };
  }

  // ----- Listview data -------------------------------------------------------

  let listItems = $state<any[]>([]);
  let listTotal = $state(0);
  let listHasMore = $state(false);
  let listLoading = $state(false);

  // Add → Discogs uses the Discogs search API; everything else uses library endpoints.
  async function loadList(reset: boolean) {
    if (listLoading) return;
    listLoading = true;
    const offset = reset ? 0 : listItems.length;

    try {
      if (explorerState.nav.section === 'add' && explorerState.nav.item === 'discogs') {
        const q = explorerState.q.trim();
        if (!q) {
          listItems = [];
          listTotal = 0;
          listHasMore = false;
          return;
        }
        const res = await fetch(`/api/discogs/search?q=${encodeURIComponent(q)}`).then((r) => r.json());
        if (res?.error) {
          listItems = [];
          listTotal = 0;
          listHasMore = false;
          return;
        }
        // Map Discogs search results into the ReleaseItem shape, with an
        // empty-or-Discogs source-grid based on the in-collection set.
        const mapped = (res ?? []).map((r: any) => ({
          id: String(r.id),
          title: r.title,
          artist: r.artist,
          year: r.year ?? null,
          country: r.country ?? null,
          label: r.label ?? null,
          catno: r.catno ?? null,
          coverImage: r.thumb ?? null,
          sources: collection.has(Number(r.id)) ? ['discogs'] : [],
          _isDiscogsSearchHit: true,
        }));
        listItems = mapped;
        listTotal = mapped.length;
        listHasMore = false;
        return;
      }

      const params = new URLSearchParams();
      params.set('limit', '200');
      params.set('offset', String(offset));
      if (explorerState.q) params.set('q', explorerState.q);

      const isTracksView = currentEntity === 'tracks';
      let endpoint = isTracksView ? '/api/library/tracks' : '/api/library/releases';

      if (explorerState.nav.section === 'sources') {
        params.set('source', explorerState.nav.item);
      }
      if (explorerState.nav.section === 'library' && explorerState.nav.item === 'in-multiple-sources') {
        params.set('multi_source', 'true');
      }

      const res = await fetch(`${endpoint}?${params.toString()}`).then((r) => r.json());
      const items = res.items ?? [];
      listItems = reset ? items : [...listItems, ...items];
      listTotal = res.total ?? listItems.length;
      listHasMore = !!res.hasMore;
    } finally {
      listLoading = false;
    }
  }

  // ----- Detail data ---------------------------------------------------------

  let detailKind = $state<'release' | 'track' | null>(null);
  let detailData = $state<any>(null);

  async function loadDetail() {
    if (!explorerState.id) {
      detailKind = null;
      detailData = null;
      return;
    }

    if (explorerState.nav.section === 'add' && explorerState.nav.item === 'discogs') {
      // Detail comes from the in-memory search result, not a library fetch.
      const hit = listItems.find((it) => it.id === explorerState.id);
      if (hit) {
        detailKind = 'release';
        detailData = {
          release: { id: hit.id, title: hit.title, artist: hit.artist, year: hit.year },
          sources: hit.sources.includes('discogs')
            ? [{
                source: 'discogs',
                external_id: hit.id,
                external_url: `https://www.discogs.com/release/${hit.id}`,
                match_method: 'first_seen',
              }]
            : [],
          facets: [
            ...(hit.label ? [{ source: 'discogs', key: 'label', value: hit.label }] : []),
            ...(hit.catno ? [{ source: 'discogs', key: 'catno', value: hit.catno }] : []),
            ...(hit.country ? [{ source: 'discogs', key: 'country', value: hit.country }] : []),
          ],
          tracks: [],
          _isDiscogsSearchHit: true,
        };
      }
      return;
    }

    // Try release first; fall back to track if 404.
    const relRes = await fetch(`/api/library/releases/${encodeURIComponent(explorerState.id)}`);
    if (relRes.ok) {
      detailKind = 'release';
      detailData = await relRes.json();
      return;
    }
    const trkRes = await fetch(`/api/library/tracks/${encodeURIComponent(explorerState.id)}`);
    if (trkRes.ok) {
      detailKind = 'track';
      detailData = await trkRes.json();
      return;
    }
    detailKind = null;
    detailData = null;
  }

  // ----- Computed ------------------------------------------------------------

  const selectedSource = $derived(
    explorerState.nav.section === 'sources'
      ? sources.find((s) => s.id === explorerState.nav.item) ?? null
      : null,
  );

  const currentEntity = $derived.by<'releases' | 'tracks'>(() => {
    if (explorerState.entity) return explorerState.entity;
    if (explorerState.nav.section === 'library' && explorerState.nav.item === 'all-tracks') return 'tracks';
    if (selectedSource) {
      // Default to the source's primary entity type.
      if (selectedSource.contributes.includes('track') && !selectedSource.contributes.includes('release')) return 'tracks';
      if (selectedSource.contributes.includes('release') && !selectedSource.contributes.includes('track')) return 'releases';
      // Both: default to tracks (matches iTunes' primary unit).
      return 'tracks';
    }
    return 'releases';
  });

  const showEntityToggle = $derived(
    selectedSource !== null
      && selectedSource.contributes.includes('track')
      && selectedSource.contributes.includes('release'),
  );

  const isAddView = $derived(explorerState.nav.section === 'add');
  const isSourcesView = $derived(explorerState.nav.section === 'sources');

  const toolbarPlaceholder = $derived(
    isAddView ? 'Search Discogs…' : 'Search library…',
  );

  const toolbarMeta = $derived.by(() => {
    if (isAddView) {
      const q = explorerState.q.trim();
      if (!q) return '';
      return `${listTotal} result${listTotal === 1 ? '' : 's'}`;
    }
    const noun = currentEntity === 'tracks' ? 'tracks' : 'releases';
    return `${listTotal.toLocaleString()} ${noun}`;
  });

  // ----- Reactive triggers ---------------------------------------------------

  // Reload list when the view-defining inputs change.
  $effect(() => {
    explorerState.nav.section;
    explorerState.nav.item;
    explorerState.q;
    currentEntity;
    if (sources.length === 0) return; // wait until source meta is loaded
    loadList(true);
  });

  // Reload detail when id changes.
  $effect(() => {
    explorerState.id;
    loadDetail();
  });

  // ----- URL sync ------------------------------------------------------------

  function syncToUrl() {
    if (typeof window === 'undefined') return;
    const params = explorerState.serialize();
    const search = params.toString() ? `?${params.toString()}` : '';
    history.replaceState(history.state, '', `${location.pathname}${search}`);
  }

  $effect(() => {
    explorerState.nav.section;
    explorerState.nav.item;
    explorerState.id;
    explorerState.q;
    explorerState.entity;
    syncToUrl();
  });

  // ----- Mount ---------------------------------------------------------------

  onMount(async () => {
    explorerState.hydrate(page.url.searchParams);
    await Promise.all([loadSourcesAndCounts(), collection.load()]);
  });

  // ----- Add → Discogs CTA ---------------------------------------------------

  import { session } from '$lib/stores/session.svelte';
  import { toast } from '$lib/stores/toast.svelte';

  let addSubmitting = $state(false);
  async function handleAdd() {
    if (!detailData?._isDiscogsSearchHit) return;
    const hit = listItems.find((it) => it.id === explorerState.id);
    if (!hit) return;
    addSubmitting = true;
    try {
      const res = await fetch('/api/discogs/collection/add', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          releaseId: Number(hit.id),
          title: hit.title,
          artist: hit.artist,
          year: hit.year,
          country: hit.country,
          label: hit.label,
          catno: hit.catno,
          coverImage: hit.coverImage,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        session.add({
          releaseId: Number(hit.id),
          instanceId: data.instanceId,
          title: hit.title,
          artist: hit.artist,
          addedAt: new Date().toISOString(),
        });
        collection.markAdded(Number(hit.id));
        listItems = listItems.map((it) =>
          it.id === hit.id ? { ...it, sources: ['discogs'] } : it,
        );
        detailData = {
          ...detailData,
          sources: [
            {
              source: 'discogs',
              external_id: hit.id,
              external_url: `https://www.discogs.com/release/${hit.id}`,
              match_method: 'first_seen',
            },
          ],
        };
        toast.show('Added');
      } else {
        toast.show('Could not add. Try again.');
      }
    } finally {
      addSubmitting = false;
    }
  }

  async function handleUndo() {
    const last = session.last;
    if (!last) return;
    try {
      const res = await fetch('/api/discogs/collection/remove', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ releaseId: last.releaseId, instanceId: last.instanceId }),
      });
      if (res.ok) {
        session.removeById(last.releaseId, last.instanceId);
        collection.markRemoved(last.releaseId);
        listItems = listItems.map((it) =>
          Number(it.id) === last.releaseId
            ? { ...it, sources: (it.sources as string[]).filter((s) => s !== 'discogs') }
            : it,
        );
        if (detailData?.release && Number(detailData.release.id) === last.releaseId) {
          detailData = {
            ...detailData,
            sources: (detailData.sources as any[]).filter((s) => s.source !== 'discogs'),
          };
        }
        toast.show('Undone');
      } else {
        toast.show('Could not undo. Try again.');
      }
    } catch {
      toast.show('Could not undo. Network error.');
    }
  }

  // ----- Sync chip -----------------------------------------------------------

  async function handleSync() {
    if (!selectedSource || selectedSource.isStub || syncing) return;
    syncing = selectedSource.id;
    try {
      await fetch(`/api/sources/${selectedSource.id}/sync`, { method: 'POST' });
      await loadSourcesAndCounts();
      await loadList(true);
    } finally {
      syncing = null;
    }
  }

  // ----- Scanner popover -----------------------------------------------------

  let scannerOpen = $state(false);

  // ----- Source meta for detail panes ----------------------------------------

  const sourceMetaForDetail = $derived(
    sources.map((s) => ({ id: s.id, name: s.name, isStub: s.isStub })),
  );
</script>

<div class="explorer">
  <Rail
    nav={explorerState.nav}
    {sources}
    {counts}
    onSelect={(nav) => explorerState.setNav(nav)}
  />

  <section class="middle">
    <ListviewToolbar
      bind:query={explorerState.q}
      placeholder={toolbarPlaceholder}
      onQueryChange={() => { /* effect above triggers reload */ }}
      showScanner={isAddView}
      onScan={() => (scannerOpen = true)}
      showEntityToggle={showEntityToggle}
      entity={currentEntity}
      onEntityChange={(e) => explorerState.setEntityKind(e)}
      showSyncChip={isSourcesView}
      syncIsStub={selectedSource?.isStub ?? false}
      syncLastAt={selectedSource?.lastSyncedAt ?? null}
      syncing={syncing === selectedSource?.id}
      onSync={handleSync}
      meta={toolbarMeta}
    />

    {#if scannerOpen}
      <div class="scanner-overlay">
        <Scanner
          onDecode={(code) => {
            explorerState.setQuery(code);
            scannerOpen = false;
          }}
        />
        <button class="scanner-close" onclick={() => (scannerOpen = false)}>Close (Esc)</button>
      </div>
    {/if}

    {#if isSourcesView && selectedSource?.isStub}
      <EmptyState
        title="{selectedSource.name} not yet implemented"
        detail="See docs/BACKLOG.md for status. The source registry knows about this adapter; sync support hasn't been built yet."
      />
    {:else if currentEntity === 'releases'}
      <ReleaseList
        items={listItems}
        total={listTotal}
        hasMore={listHasMore}
        selectedId={explorerState.id}
        onSelect={(id) => explorerState.setEntity(id)}
        loadMore={() => loadList(false)}
        emptyTitle={isAddView && !explorerState.q ? 'Search Discogs to add records' : 'No releases'}
      />
    {:else}
      <TrackList
        items={listItems}
        total={listTotal}
        hasMore={listHasMore}
        selectedId={explorerState.id}
        onSelect={(id) => explorerState.setEntity(id)}
        loadMore={() => loadList(false)}
      />
    {/if}

    {#if isAddView}
      <SessionLog onUndo={handleUndo} />
    {/if}
  </section>

  <section class="right">
    {#if !explorerState.id}
      <EmptyState title="Select a release to see details" />
    {:else if detailKind === 'release' && detailData}
      <ReleaseDetail
        release={detailData.release}
        sources={detailData.sources}
        facets={detailData.facets}
        tracks={detailData.tracks ?? []}
        sourceMeta={sourceMetaForDetail}
        addCta={
          isAddView && detailData._isDiscogsSearchHit
            ? (collection.has(Number(detailData.release.id))
                ? null
                : { label: '+ Add to Discogs collection', kbdHint: '⏎', onClick: handleAdd })
            : null
        }
        onTrackSelect={(id) => explorerState.setEntity(id)}
      />
    {:else if detailKind === 'track' && detailData}
      <TrackDetail
        track={detailData.track}
        sources={detailData.sources}
        facets={detailData.facets}
        release={detailData.release}
        sourceMeta={sourceMetaForDetail}
        onReleaseSelect={(id) => explorerState.setEntity(id)}
      />
    {:else}
      <EmptyState title="Loading…" />
    {/if}
  </section>
</div>

<style>
  .explorer {
    display: grid;
    grid-template-columns: 220px 1fr 360px;
    height: 100vh;
    overflow: hidden;
  }
  .middle {
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border-right: 1px solid var(--border);
    position: relative;
  }
  .right {
    overflow-y: auto;
  }
  .scanner-overlay {
    position: absolute;
    top: 50px;
    left: 14px;
    right: 14px;
    background: var(--bg-raised);
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    padding: 12px;
    z-index: 10;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .scanner-close {
    align-self: flex-end;
    background: transparent;
    border: 1px solid var(--border-strong);
    color: var(--text-muted);
    border-radius: 4px;
    padding: 4px 9px;
    font-family: inherit;
    font-size: 11px;
    cursor: pointer;
  }
</style>
```

Note: the `Scanner.svelte` component currently emits decoded codes via a different prop name. Check `src/lib/components/Scanner.svelte` and adjust the `onCode={...}` line if needed (it may be `onDecode` or use `dispatch('decode', ...)` — match its API).

- [ ] **Step 2: Type-check**

Run: `pnpm tsc`
Expected: errors in this Explorer file are likely (especially around the Scanner prop name; resolve by reading `Scanner.svelte` and matching its API). All other type errors should be confined to the unmodified `+page.svelte`. Fix Explorer-internal errors before committing.

- [ ] **Step 3: Commit**

```bash
git add src/lib/components/Explorer.svelte
git commit -m "feat(ui): Explorer shell — URL sync + data fetching + composition"
```

---

### Task 20: Rewrite `+page.svelte` to mount the Explorer + ShortcutOverlay (setup gate)

**Files:**
- Modify: `src/routes/+page.svelte` (full rewrite)

This task does NOT install the keyboard handler — the existing handler imports `mode.svelte.ts` and assumes the search/scanner mode model. We rip both out together in Task 22 (keyboard rewrite). Until then, the explorer renders without keyboard shortcuts (regression for one task; recovered next task).

- [ ] **Step 1: Replace the file**

Open `src/routes/+page.svelte`. Replace its entire contents with:

```svelte
<script lang="ts">
  import { onMount } from 'svelte';
  import Explorer from '$lib/components/Explorer.svelte';
  import ShortcutOverlay from '$lib/components/ShortcutOverlay.svelte';

  let setupNeeded = $state<null | 'no_token' | 'invalid_token'>(null);
  let probed = $state(false);
  let shortcutOpen = $state(false);

  onMount(async () => {
    // Probe the Discogs API to gate on setup. Same content as the Slice 1 flow.
    try {
      const res = await fetch('/api/discogs/search?q=test');
      const data = await res.json().catch(() => ({}));
      if (data?.error === 'no_token' || data?.error === 'invalid_token') {
        setupNeeded = data.error;
      }
    } catch {
      // Treat as no setup error — endpoint failures surface via toast on use.
    } finally {
      probed = true;
    }
  });
</script>

{#if !probed}
  <!-- Initial blank to avoid setup-flash. -->
{:else if setupNeeded}
  <main class="setup">
    <h1>Setup booth</h1>
    <p>
      booth needs a Discogs personal access token to talk to the Discogs API.
      Generate one at <a href="https://www.discogs.com/settings/developers">discogs.com/settings/developers</a>,
      then add it to <code>.env</code>:
    </p>
    <pre><code>DISCOGS_TOKEN=your-token-here</code></pre>
    <p>Restart <code>pnpm dev</code> after editing.</p>
    {#if setupNeeded === 'invalid_token'}
      <p class="error">The token in <code>.env</code> was rejected by Discogs (401). Double-check it's correct.</p>
    {/if}
  </main>
{:else}
  <Explorer />
  <ShortcutOverlay open={shortcutOpen} onClose={() => (shortcutOpen = false)} />
{/if}

<style>
  .setup {
    max-width: 540px;
    margin: 80px auto;
    padding: 24px;
    color: var(--text);
  }
  .setup h1 { font-size: 18px; font-weight: 600; margin-bottom: 12px; }
  .setup p { margin-bottom: 12px; line-height: 1.5; }
  .setup code {
    background: var(--bg-raised);
    border: 1px solid var(--border);
    padding: 1px 5px;
    border-radius: 3px;
    font-family: var(--font-mono);
    font-size: 12px;
  }
  .setup pre {
    background: var(--bg-raised);
    border: 1px solid var(--border);
    padding: 12px;
    border-radius: 4px;
    overflow-x: auto;
  }
  .setup .error { color: var(--danger); }
</style>
```

`shortcutOpen` is mutable state passed to ShortcutOverlay. The keyboard rewrite in Task 22 will toggle it from the `?` shortcut.

- [ ] **Step 2: Type-check**

Run: `pnpm tsc`
Expected: errors should be limited to TypeScript noise from the still-existing `keyboard.svelte.ts` file (which imports `mode.svelte.ts` — both are removed in later tasks). No errors should originate in the new `+page.svelte` itself.

- [ ] **Step 3: Smoke test in browser**

Run: `pnpm dev`. Open `http://localhost:5173`.

Expected:
- The three-pane explorer renders (rail / list / detail).
- The rail shows `Library`, `Sources`, `Add` sections with counts populated.
- Clicking a Sources rail item filters the middle pane.
- Selecting a release populates the right-pane detail with source panels and (if any) a tracklist section.
- Reloading with state in the URL (e.g., `?nav=sources:itunes`) restores that view.
- Keyboard shortcuts do NOT work yet — that's Task 22.

Stop the dev server.

- [ ] **Step 4: Commit**

```bash
git add src/routes/+page.svelte
git commit -m "feat(ui): rewrite +page.svelte to mount the Explorer (with setup gate)"
```

---

## Phase 5 — Cleanup + keyboard

### Task 21: Refactor `SessionLog.svelte` for the explorer footer placement

**Files:**
- Modify: `src/lib/components/SessionLog.svelte`

The current SessionLog already accepts an `onUndo: () => void` callback, renders only when `session.count > 0`, and uses the `session` store. Only the styling changes — adapting from the original below-results card to a thin footer strip that fits the explorer's middle-pane footer slot.

- [ ] **Step 1: Replace the `<style>` block**

Open `src/lib/components/SessionLog.svelte`. Replace its `<style>` block with:

```svelte
<style>
  .log {
    height: 32px;
    border-top: 1px solid var(--border);
    padding: 0 14px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    color: var(--text-muted);
    font-size: 12px;
    flex-shrink: 0;
  }
  .undo {
    background: transparent;
    border: 0;
    color: var(--accent);
    padding: 0;
    cursor: pointer;
    font-family: inherit;
    font-size: 12px;
  }
  .undo:hover { text-decoration: underline; }
  .kbd {
    display: inline-block;
    background: #222;
    border: 1px solid var(--border-strong);
    border-radius: 3px;
    padding: 1px 5px;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-muted);
    margin-left: 4px;
  }
</style>
```

(Markup stays as-is — the existing component already uses class `log` on the wrapper, class `undo` on the button, class `kbd` on the keyboard hint, and only renders when `session.count > 0`.)

- [ ] **Step 2: Type-check**

Run: `pnpm tsc`
Expected: no new errors.

- [ ] **Step 3: Manual smoke test**

Run: `pnpm dev`. Navigate to `Add → Discogs`. Search → click result → click Add. The session log strip should appear below the listview as a 32px footer with "Added this session: 1" on the left and "undo last `u`" on the right. Clicking undo collapses it.

Stop the dev server.

- [ ] **Step 4: Commit**

```bash
git add src/lib/components/SessionLog.svelte
git commit -m "refactor(ui): SessionLog as 32px footer strip"
```

---

### Task 22: Rewrite `keyboard.svelte.ts` and wire it from `+page.svelte`

**Files:**
- Modify: `src/lib/keyboard.svelte.ts` (full rewrite — new API, drops `mode` import)
- Modify: `src/routes/+page.svelte` (install the new keyboard handler; toggle `shortcutOpen`)

After this task, `mode.svelte.ts` is no longer referenced anywhere (Task 23 deletes it).

- [ ] **Step 1: Replace `keyboard.svelte.ts`**

Open `src/lib/keyboard.svelte.ts`. Replace its entire contents with:

```ts
/**
 * Global keyboard dispatcher for the explorer.
 *
 *   /          focus search
 *   s          open scanner overlay (when in add:discogs)
 *   ↑/↓        move highlight in listview (deferred — see BACKLOG.md)
 *   ⏎          add CTA in detail (when present)
 *   Esc        clear search input / close scanner / blur input
 *   u, ⌘Z      undo last add
 *   ?          toggle shortcut overlay
 */

export interface KeyboardActions {
  focusSearch: () => void;
  openScanner: () => void;
  moveDown: () => void;
  moveUp: () => void;
  commit: () => void;
  cancel: () => void;
  undoLast: () => void;
  toggleShortcuts: () => void;
}

export interface KeyboardGuards {
  isScannerOpen: () => boolean;
}

export function installKeyboard(actions: KeyboardActions, guards: KeyboardGuards): () => void {
  function onKey(e: KeyboardEvent) {
    const target = e.target as HTMLElement | null;
    const inEditable =
      target?.tagName === 'INPUT' ||
      target?.tagName === 'TEXTAREA' ||
      target?.isContentEditable;

    // Esc always (clear search / close scanner / blur input)
    if (e.key === 'Escape') {
      e.preventDefault();
      actions.cancel();
      return;
    }

    // Cmd/Ctrl+Z always (overrides browser undo on body)
    if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) {
      // Browser intercepts when input is focused — known gap, see CONTEXT.md.
      e.preventDefault();
      actions.undoLast();
      return;
    }

    if (inEditable) {
      if (e.key === 'Enter') { e.preventDefault(); actions.commit(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); actions.moveDown(); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); actions.moveUp();   return; }
      return;
    }

    if (e.key === '/')                                     { e.preventDefault(); actions.focusSearch();    return; }
    if ((e.key === 's' || e.key === 'S') && !guards.isScannerOpen())
                                                            { e.preventDefault(); actions.openScanner();    return; }
    if (e.key === 'ArrowDown')                              { e.preventDefault(); actions.moveDown();       return; }
    if (e.key === 'ArrowUp')                                { e.preventDefault(); actions.moveUp();         return; }
    if (e.key === 'Enter')                                  { e.preventDefault(); actions.commit();         return; }
    if (e.key === 'u' || e.key === 'U')                     { e.preventDefault(); actions.undoLast();       return; }
    if (e.key === '?')                                      { e.preventDefault(); actions.toggleShortcuts(); return; }
  }

  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}
```

- [ ] **Step 2: Wire the handler from `+page.svelte`**

Open `src/routes/+page.svelte`. Add `installKeyboard` import and an `onMount` invocation that wires the actions. Replace the entire `<script>` block with:

```svelte
<script lang="ts">
  import { onMount } from 'svelte';
  import Explorer from '$lib/components/Explorer.svelte';
  import ShortcutOverlay from '$lib/components/ShortcutOverlay.svelte';
  import { installKeyboard } from '$lib/keyboard.svelte';
  import { session } from '$lib/stores/session.svelte';
  import { collection } from '$lib/stores/collection.svelte';
  import { toast } from '$lib/stores/toast.svelte';

  let setupNeeded = $state<null | 'no_token' | 'invalid_token'>(null);
  let probed = $state(false);
  let shortcutOpen = $state(false);

  onMount(async () => {
    try {
      const res = await fetch('/api/discogs/search?q=test');
      const data = await res.json().catch(() => ({}));
      if (data?.error === 'no_token' || data?.error === 'invalid_token') {
        setupNeeded = data.error;
      }
    } catch {
      // Treat as no setup error — endpoint failures surface via toast on use.
    } finally {
      probed = true;
    }

    // Listview row navigation (↑/↓ and ⏎-to-open) lives inside Explorer
    // through DOM focus; deeper integration is in BACKLOG.md.
    const teardown = installKeyboard(
      {
        focusSearch: () => {
          document.querySelector<HTMLInputElement>('input.search')?.focus();
        },
        openScanner: () => {
          document.querySelector<HTMLButtonElement>('button[title^="Scan barcode"]')?.click();
        },
        moveDown: () => { /* deferred — see BACKLOG.md */ },
        moveUp:   () => { /* deferred — see BACKLOG.md */ },
        commit: () => {
          // Press the visible Add CTA, if any.
          document.querySelector<HTMLButtonElement>('button.add-btn')?.click();
        },
        cancel: () => {
          // 1. If scanner overlay open, close it.
          const closeBtn = document.querySelector<HTMLButtonElement>('button.scanner-close');
          if (closeBtn) { closeBtn.click(); return; }
          // 2. If search input focused with a value, clear it.
          const input = document.querySelector<HTMLInputElement>('input.search');
          if (input && document.activeElement === input) {
            if (input.value) {
              const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
              setter?.call(input, '');
              input.dispatchEvent(new Event('input', { bubbles: true }));
              return;
            }
            input.blur();
          }
        },
        undoLast: async () => {
          const last = session.last;
          if (!last) return;
          try {
            const res = await fetch('/api/discogs/collection/remove', {
              method: 'DELETE',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ releaseId: last.releaseId, instanceId: last.instanceId }),
            });
            if (res.ok) {
              session.removeById(last.releaseId, last.instanceId);
              collection.markRemoved(last.releaseId);
              toast.show('Undone');
            } else {
              toast.show('Could not undo. Try again.');
            }
          } catch {
            toast.show('Could not undo. Network error.');
          }
        },
        toggleShortcuts: () => { shortcutOpen = !shortcutOpen; },
      },
      {
        isScannerOpen: () => !!document.querySelector('.scanner-overlay'),
      },
    );

    return teardown;
  });
</script>
```

(Leave the markup and `<style>` block from Task 20 unchanged.)

- [ ] **Step 3: Type-check**

Run: `pnpm tsc`
Expected: no errors. (`mode.svelte.ts` is now unreferenced — Task 23 deletes it.)

- [ ] **Step 4: Manual smoke test**

Run: `pnpm dev`.

- Press `/` → search input focuses.
- Type a query in `Add → Discogs` → results update.
- Press `Esc` while focused with a value → input clears.
- Press `Esc` again → input blurs.
- Click a search result, then press `⏎` (with focus on the page body) → Add CTA fires (toast appears, source-grid lights up).
- Press `u` → undo (toast appears, source-grid clears).
- Press `?` → shortcut overlay toggles.
- Press `s` while in `Add → Discogs` → scanner overlay opens.
- Press `Esc` while scanner is open → it closes.

Stop the dev server.

- [ ] **Step 5: Commit**

```bash
git add src/lib/keyboard.svelte.ts src/routes/+page.svelte
git commit -m "feat(keyboard): explorer-aware shortcuts via DOM-driven action wiring"
```

---

### Task 23: Delete dead components and the `mode` store

**Files:**
- Delete: `src/lib/components/ConfirmModal.svelte`
- Delete: `src/lib/components/ResultsList.svelte`
- Delete: `src/lib/components/ResultRow.svelte`
- Delete: `src/lib/stores/mode.svelte.ts`

After Task 22, none of these are referenced anywhere in `src/`.

- [ ] **Step 1: Confirm zero remaining references**

Run:

```bash
pnpm exec grep -rn "ConfirmModal\|ResultsList\|ResultRow\|stores/mode" src/
```

Expected: only the four target files themselves should appear. If any importers remain, fix them before deletion.

- [ ] **Step 2: Delete the files**

```bash
git rm src/lib/components/ConfirmModal.svelte src/lib/components/ResultsList.svelte src/lib/components/ResultRow.svelte src/lib/stores/mode.svelte.ts
```

- [ ] **Step 3: Type-check**

Run: `pnpm tsc`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git commit -m "chore(ui): remove ConfirmModal, ResultsList, ResultRow, mode store"
```

---

## Phase 6 — Verification + finalize

### Task 24: End-to-end manual verification

**Files:** None (verification-only task)

This task is a structured walkthrough you run in the browser. Mark each checkpoint as you confirm it. If anything fails, stop and fix before proceeding. Do not commit at the end of this task.

- [ ] **Step 1: Reset DB to a known state**

```bash
rm -rf .booth/
```

(This forces the boot hook to re-sync Discogs on first request.)

- [ ] **Step 2: Start dev server**

Run: `pnpm dev`. Open `http://localhost:5173`.

- [ ] **Step 3: Setup gate**

If `.env` lacks `DISCOGS_TOKEN`, confirm the setup screen renders inside the new shell. Add the token, restart `pnpm dev`, reload.

- [ ] **Step 4: Verify Library views**

- [ ] `library:all-releases` (default landing) renders the release listview with the right total count in the toolbar.
- [ ] Scrolling near the bottom appends more rows (network call has `?offset=200`).
- [ ] `library:all-tracks` switches to the track row variant.
- [ ] `library:in-multiple-sources` renders only releases with ≥2 source-grid dots filled.

- [ ] **Step 5: Verify Sources views**

- [ ] `sources:discogs` shows only releases with the `D` slot filled.
- [ ] `sources:itunes` shows tracks by default; the entity-type toggle appears on the toolbar; clicking `Releases` switches to its 1,187 emergent releases.
- [ ] `sources:rekordbox` lands on an EmptyState (`Rekordbox not yet implemented`).
- [ ] The sync chip appears for real sources; click it on Discogs → chip says `Syncing…`, then updates to a fresh timestamp. The rail count refreshes.
- [ ] Stub sources show a `Not implemented` (disabled) chip.

- [ ] **Step 6: Verify Add → Discogs view**

- [ ] `add:discogs` renders an empty list with the "Search Discogs to add records" hint.
- [ ] Typing a query (e.g., `folamour`) populates the listview with Discogs API hits.
- [ ] Releases you already own show their `D` slot filled in the source-grid.
- [ ] Selecting a not-yet-owned hit shows the right-pane detail with the `+ Add to Discogs collection ⏎` CTA.
- [ ] Clicking Add (or pressing `⏎` with focus outside the input) fires the add — toast appears, the source-grid in the row updates to `●◌◌◌`, the CTA disappears.
- [ ] Pressing `u` undoes the add — the row's source-grid clears, the CTA returns.
- [ ] Pressing `s` opens the scanner overlay; closing it dismisses cleanly.
- [ ] The session-log footer strip appears below the listview only in `add:discogs`, hidden everywhere else.

- [ ] **Step 7: Verify URL state restore**

- [ ] Navigate to `sources:itunes`, click into a track. Copy the URL.
- [ ] Reload (`Cmd+R`). Confirm: same rail item active, same track in the right pane, same `?id=` and `?nav=` params in the URL.

- [ ] **Step 8: Verify type-check + final state**

Run: `pnpm tsc`
Expected: no errors.

Run: `git status`
Expected: working tree clean.

Stop the dev server.

---

### Task 25: Append Slice 2 deferred items to `BACKLOG.md` + update `CONTEXT.md`

**Files:**
- Modify: `docs/BACKLOG.md` (append Slice 2 deferrals)
- Modify: `docs/CONTEXT.md` (update file map, feature inventory, divergences-from-plan)

- [ ] **Step 1: Append to `BACKLOG.md`**

Open `docs/BACKLOG.md`. Update each section as follows (only add lines; never remove existing items):

**UI / Explorer** — append:

- Sortable column headers (year, date added, artist). _(deferred from 2026-05-06 library-explorer)_
- `[`/`]` rail keyboard navigation. _(deferred from 2026-05-06 library-explorer)_
- Listview arrow-key row navigation (Slice 2 ships only `/`-focus and `⏎`-commit; ↑/↓ are placeholders). _(deferred from 2026-05-06 library-explorer)_
- "Reveal in Finder" link on Apple Music source panels — needs an endpoint with limited shell-out (`open -R <path>` on macOS). _(deferred from 2026-05-06 library-explorer)_
- Detail-pane "✓ In your Discogs collection — undo" row for releases already owned (Slice 2 ships only the source-grid + global `u` for already-owned releases in the Add view). _(deferred from 2026-05-06 library-explorer)_

**Sync** — append:

- "Add to Discogs collection" CTA from a release that's only in iTunes today — cross-source upgrade flow. _(deferred from 2026-05-06 library-explorer)_
- Background-poll sync after first user interaction. _(deferred from 2026-05-06 library-explorer)_

(Move the existing "Auto-sync iTunes on boot" line if needed; it stays where it is.)

- [ ] **Step 2: Update `CONTEXT.md` — file map**

Open `docs/CONTEXT.md`. In the `## File map` section, replace the obsolete entries and add the new ones:

- Remove `SearchBar.svelte`, `ResultsList.svelte`, `ResultRow.svelte`, `ConfirmModal.svelte`, `mode.svelte.ts` lines.
- Update `SearchBar.svelte` description to: `debounced text input + focus()/blur()/clear()` (re-add the line, just with the new description).
- Add new component lines:
  - `Explorer.svelte` — three-pane shell, owns URL ↔ store sync and data fetching
  - `Rail.svelte` — Library / Sources / Add rail
  - `ListviewToolbar.svelte` — search + scanner btn + entity toggle + sync chip + meta
  - `Listview.svelte` — generic paginated list shell
  - `ReleaseList.svelte`, `TrackList.svelte` — thin Listview wrappers
  - `SourceGrid.svelte`, `SourcePanel.svelte`, `SyncChip.svelte`, `EmptyState.svelte`
  - `ReleaseDetail.svelte`, `TrackDetail.svelte`
- Add new server entries:
  - `migrations/002_source_state.sql` — last-synced + last-summary per source
- Add new route entries under `api/library`:
  - `releases/[id]/+server.ts`, `tracks/[id]/+server.ts`
- Add new route entry under `api/`:
  - `sources/+server.ts`
- Add new store: `stores/explorerState.svelte.ts` — mirror of `?nav`/`?id`/`?q`/`?entity`

- [ ] **Step 3: Update `CONTEXT.md` — feature inventory**

In `## Feature inventory`, add a `### Library explorer` subsection summarizing what shipped (rail, list/detail, source-grid, sync chip, source_state, URL state, pagination). Update `### Search`, `### Scanner`, `### Add / undo`, `### URL state`, `### Setup screen`, `### Sources` to reflect the explorer-integrated reality (search input lives in toolbar; scanner is toolbar button popover; add CTA is detail-pane button; URL params are `nav` / `id` / `q` / `entity`; sync triggered via chip).

- [ ] **Step 4: Update `CONTEXT.md` — divergences**

In `## Notable divergences from the original plan`, add a new bullet:

- **Slice 2 (2026-05-06): Library explorer.** Three-pane explorer (rail / list / detail) replaces the single-purpose add screen. Add flow folded into the explorer as `Add → Discogs`; `ConfirmModal` replaced by detail-pane CTA. New `source_state` table + sync chip. URL state in `?nav`/`?id`/`?q`/`?entity`. See `docs/superpowers/specs/2026-05-06-library-explorer-design.md`.

- [ ] **Step 5: Update `CONTEXT.md` — known gaps in shipped code**

If the pre-existing `+page.svelte:134` svelte-check warning is no longer applicable after the rewrite, remove that line from the `## Known gaps in shipped code` section. Verify by running `pnpm exec svelte-check` and confirming output. If it's gone, drop the line; if not (different line, different reason), update the description.

```bash
pnpm exec svelte-kit sync && pnpm exec svelte-check
```

- [ ] **Step 6: Type-check**

Run: `pnpm tsc`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add docs/BACKLOG.md docs/CONTEXT.md
git commit -m "docs: update CONTEXT.md + BACKLOG.md for Slice 2 (library explorer)"
```

---

## Future work

All deferred items from Slice 2 are appended to `docs/BACKLOG.md` (see Task 25). Standing items (auth, LAN, fuzzy matching, Rekordbox/Plex implementations, playlists, etc.) remain as documented there.
