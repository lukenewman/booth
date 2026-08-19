# Playback Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the player a queue so the transport can offer prev/next and a finished track auto-advances instead of stopping.

**Architecture:** A `PlaybackContext` describing where play came from is captured at play time and resolved once into `ids[] + index` inside the player store, so prev/next/advance have a single code path. Release and playlist contexts carry their ids inline (both already hold their complete ordered list client-side); only the paginated library listview resolves against a new ids endpoint. Pure queue arithmetic lives outside the store so it can be tested without a DOM.

**Tech Stack:** Bun, SvelteKit 2, Svelte 5 runes, TypeScript, `bun:sqlite`. No test runner — verification is `bun verify scripts/<name>.ts` scripts that assert and `process.exit(1)` on failure.

**Spec:** `docs/superpowers/specs/2026-08-18-playback-queue-design.md`

## Global Constraints

- Type-check with `bunx svelte-kit sync && bunx tsc --noEmit`; it must be clean before every commit.
- No new dependencies.
- Verification scripts go in `scripts/`, are run with `bun verify scripts/<name>.ts`, print `ok:`/`FAIL:` lines, and exit non-zero on any failure. Follow the existing style in `scripts/verify-sort.ts`.
- The queue is in-memory only. Nothing is persisted across reloads.
- `PREV_RESTART_THRESHOLD_S = 3` — prev restarts the current track when `currentTime` exceeds it.
- The library queue contains **playable tracks only** (a `source_link` from a source in `playableSources`). The library has 5,671 tracks but 4,343 playable; unfiltered would mean ~1,300 dead ends.
- `listTrackIds` must return exactly the ids `listTracks` returns, in the same order, for the same arguments. Both must build their WHERE/ORDER from one shared helper — never two copies.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/queue.ts` (create) | Pure queue arithmetic + context types. No Svelte, no fetch, no DOM. |
| `src/lib/server/library/queries.ts` (modify) | Extract `buildTrackQuery`; add `listTrackIds`. |
| `src/routes/api/library/tracks/ids/+server.ts` (create) | `GET` returning `{ ids }` for the current filters. |
| `src/lib/stores/player.svelte.ts` (modify) | Queue state, `playFrom`, `next`, `prev`, metadata cache. |
| `src/lib/components/Player.svelte` (modify) | `onended` → `player.next()`. |
| `src/lib/components/PlayerBar.svelte` (modify) | `⏮ ⏭` buttons. |
| `src/lib/components/ReleaseDetail.svelte`, `PlaylistView.svelte`, `TrackList.svelte`, `Explorer.svelte` (modify) | Pass a context at play time. |
| `scripts/verify-queue.ts`, `scripts/verify-track-ids.ts` (create) | Verification. |

---

### Task 1: Pure queue arithmetic

**Files:**
- Create: `src/lib/queue.ts`
- Test: `scripts/verify-queue.ts`

**Interfaces:**
- Consumes: `SortKey` from `$lib/types`.
- Produces: `PlaybackContext`, `LibraryQuery`, `PrevAction`, `PREV_RESTART_THRESHOLD_S`, `nextIndex(index, queueLength): number | null`, `prevTarget(currentTime, index, queueLength): PrevAction`.

- [ ] **Step 1: Write the failing test**

Create `scripts/verify-queue.ts`:

```ts
// Verifies pure queue arithmetic: advancing, the 3s prev rule, and both
// boundaries. Kept free of Svelte/DOM so the rules can be asserted directly.
import {
  nextIndex,
  prevTarget,
  PREV_RESTART_THRESHOLD_S,
} from '../src/lib/queue';

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg);
    failures++;
  } else console.log('ok:', msg);
}

// next
assert(nextIndex(0, 5) === 1, 'next from the start advances');
assert(nextIndex(3, 5) === 4, 'next from the middle advances');
assert(nextIndex(4, 5) === null, 'next at the last index stops (no wrap)');
assert(nextIndex(-1, 0) === null, 'next with no queue is null');
assert(nextIndex(0, 0) === null, 'next over an empty queue is null');

// prev — past the threshold, always restart
assert(
  prevTarget(PREV_RESTART_THRESHOLD_S + 0.1, 3, 5).kind === 'restart',
  'prev past 3s restarts rather than stepping back',
);
assert(prevTarget(30, 0, 5).kind === 'restart', 'prev past 3s at index 0 restarts');

// prev — at or under the threshold, step back
const early = prevTarget(1, 3, 5);
assert(early.kind === 'move' && early.index === 2, 'prev under 3s steps back one');
const boundary = prevTarget(PREV_RESTART_THRESHOLD_S, 3, 5);
assert(
  boundary.kind === 'move' && boundary.index === 2,
  'exactly 3s still steps back (threshold is exclusive)',
);
assert(prevTarget(0, 0, 5).kind === 'restart', 'prev at index 0 restarts, never underflows');

// no queue
assert(prevTarget(10, -1, 0).kind === 'none', 'prev with no queue is a no-op');
assert(prevTarget(0, -1, 0).kind === 'none', 'prev with no queue is a no-op regardless of time');

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun verify scripts/verify-queue.ts`
Expected: FAIL — cannot resolve `../src/lib/queue`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/queue.ts`:

```ts
import type { SortKey } from '$lib/types';

/** The library listview's current filters, enough to rebuild its exact ordering. */
export interface LibraryQuery {
  source?: string;
  q?: string;
  sort: SortKey;
  multiSource?: boolean;
}

/**
 * Where playback was started from. Captured at play time and never rebuilt as
 * the user browses — see the design doc's core principle.
 *
 * Release and playlist carry ids inline because both already hold their full
 * ordered list client-side; only the paginated library listview needs the
 * server to resolve its ids.
 */
export type PlaybackContext =
  | { kind: 'release'; releaseId: string; ids: string[] }
  | { kind: 'playlist'; playlistId: string; ids: string[] }
  | { kind: 'library'; query: LibraryQuery };

export type PrevAction =
  | { kind: 'none' }
  | { kind: 'restart' }
  | { kind: 'move'; index: number };

/** Seconds into a track past which `prev` restarts it instead of stepping back. */
export const PREV_RESTART_THRESHOLD_S = 3;

/** Next position, or null at the end of the queue (playback stops; no wrap). */
export function nextIndex(index: number, queueLength: number): number | null {
  if (index < 0 || queueLength <= 0) return null;
  const candidate = index + 1;
  return candidate < queueLength ? candidate : null;
}

/**
 * What `prev` should do. Past the threshold it restarts — the conventional
 * behaviour, and the reason a single button can serve both "start this over"
 * and "go back one".
 */
export function prevTarget(
  currentTime: number,
  index: number,
  queueLength: number,
): PrevAction {
  if (index < 0 || queueLength <= 0) return { kind: 'none' };
  if (currentTime > PREV_RESTART_THRESHOLD_S) return { kind: 'restart' };
  if (index === 0) return { kind: 'restart' };
  return { kind: 'move', index: index - 1 };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun verify scripts/verify-queue.ts`
Expected: PASS — all 12 checks `ok:`.

- [ ] **Step 5: Type-check**

Run: `bunx tsc --noEmit`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add src/lib/queue.ts scripts/verify-queue.ts
git commit -m "feat(queue): pure queue arithmetic and playback context types"
```

---

### Task 2: Server — shared clause builder and the ids endpoint

**Files:**
- Modify: `src/lib/server/library/queries.ts`
- Create: `src/routes/api/library/tracks/ids/+server.ts`
- Test: `scripts/verify-track-ids.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `listTrackIds(db, args: TrackFilterArgs): string[]` from `$lib/server/library/queries`, where `TrackFilterArgs = { source?: string; q?: string; multiSource?: boolean; sort?: SortKey }`. `GET /api/library/tracks/ids` returning `{ ids: string[] }`.

- [ ] **Step 1: Write the failing test**

Create `scripts/verify-track-ids.ts`:

```ts
// The queue's load-bearing invariant: listTrackIds must return exactly the ids
// listTracks returns, in the same order, for the same arguments. If these drift,
// "next" plays something other than the row below the one you clicked — which
// presents as randomly wrong track order and is miserable to trace.
import { Database } from 'bun:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listTracks, listTrackIds } from '../src/lib/server/library/queries';

const MIG = 'src/lib/server/db/migrations';

function freshDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const f of readdirSync(MIG).sort()) db.exec(readFileSync(join(MIG, f), 'utf8'));
  return db;
}

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg);
    failures++;
  } else console.log('ok:', msg);
}

const db = freshDb();
db.prepare(`INSERT INTO artist (id, name) VALUES ('ar1','Alpha')`).run();
db.prepare(`INSERT INTO artist (id, name) VALUES ('ar2','Beta')`).run();

/** `source` of 'local' makes a track playable; 'discogs' does not. */
function seed(id: string, title: string, artistId: string, source: string, added: string | null) {
  db.prepare(`INSERT INTO track (id, title, artist_id, album) VALUES (?,?,?,?)`)
    .run(id, title, artistId, 'Album');
  db.prepare(
    `INSERT INTO source_link (entity_kind, entity_id, source, external_id, match_method)
     VALUES ('track', ?, ?, ?, 'file_path')`,
  ).run(id, source, `${source}-${id}`);
  if (added) {
    db.prepare(
      `INSERT INTO source_facets (entity_kind, entity_id, source, key, value)
       VALUES ('track', ?, 'local', 'dateAdded', ?)`,
    ).run(id, JSON.stringify(added));
  }
}

seed('t1', 'Anchor', 'ar1', 'local', '2024-01-01T00:00:00.000Z');
seed('t2', 'Bridge', 'ar2', 'local', '2025-06-15T00:00:00.000Z');
seed('t3', 'Chorus', 'ar1', 'local', '2026-08-11T00:00:00.000Z');
seed('t4', 'Discogs Only', 'ar2', 'discogs', null); // never playable
seed('t5', 'Undated', 'ar1', 'local', null);

const PAGE = { limit: 500, offset: 0 };

// The invariant, across every parameter combination the UI can produce.
const cases: Array<[string, Record<string, unknown>]> = [
  ['default sort', {}],
  ['added-desc', { sort: 'added-desc' }],
  ['added-asc', { sort: 'added-asc' }],
  ['artist sort', { sort: 'artist' }],
  ['with q', { q: 'r' }],
  ['with source filter', { source: 'local' }],
];

for (const [label, args] of cases) {
  const rows = listTracks(db, { ...PAGE, ...args } as never);
  // listTracks includes unplayable tracks; the queue must not.
  const expected = rows.items.filter((r) => r.canPlay).map((r) => r.id);
  const actual = listTrackIds(db, args as never);
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label}: ids match listTracks order (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`,
  );
}

// Explicit check of the playable filter, so a regression names itself.
const all = listTrackIds(db, {} as never);
assert(!all.includes('t4'), 'the Discogs-only track never enters the queue');
assert(all.includes('t1') && all.includes('t5'), 'local tracks do, dated or not');

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun verify scripts/verify-track-ids.ts`
Expected: FAIL — `listTrackIds` is not exported.

- [ ] **Step 3: Extract the shared clause builder**

In `src/lib/server/library/queries.ts`, add above `listTracks`:

```ts
export interface TrackFilterArgs {
  source?: string;
  q?: string;
  multiSource?: boolean;
  sort?: SortKey;
}

/**
 * The WHERE/JOIN/ORDER for a track listing. Shared verbatim by `listTracks` and
 * `listTrackIds` — the queue depends on the two producing identical ordering,
 * so this must never be duplicated into two drifting copies.
 */
function buildTrackQuery(args: TrackFilterArgs): {
  whereSql: string;
  params: string[];
  addedJoin: string;
  orderSql: string;
} {
  const where: string[] = [];
  const params: string[] = [];

  if (args.source) {
    where.push(
      `track.id IN (SELECT entity_id FROM source_link WHERE entity_kind='track' AND source=?)`,
    );
    params.push(args.source);
  }
  if (args.multiSource) {
    where.push(
      `track.id IN (
         SELECT entity_id FROM source_link
         WHERE entity_kind='track'
         GROUP BY entity_id
         HAVING COUNT(DISTINCT source) >= 2
       )`,
    );
  }
  if (args.q) {
    where.push(`(track.title LIKE ? OR artist.name LIKE ? OR track.album LIKE ?)`);
    params.push(`%${args.q}%`, `%${args.q}%`, `%${args.q}%`);
  }

  const sort = args.sort ?? DEFAULT_SORT;
  const addedJoin =
    sort === 'artist'
      ? ''
      : `LEFT JOIN source_facets ta
           ON ta.entity_kind='track' AND ta.entity_id = track.id
          AND ta.source='local' AND ta.key='dateAdded'`;
  const orderSql =
    sort === 'artist'
      ? `artist.name COLLATE NOCASE, track.album COLLATE NOCASE, track.title COLLATE NOCASE`
      : addedOrderClause(sort, 'ta.value', 'track.id');

  return {
    whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '',
    params,
    addedJoin,
    orderSql,
  };
}
```

- [ ] **Step 4: Point `listTracks` at the shared builder**

In `listTracks`, delete the inline `where`/`params`/`whereSql` block and the inline `sort`/`addedJoin`/`orderSql` block, replacing both with:

```ts
  const { whereSql, params, addedJoin, orderSql } = buildTrackQuery(args);
```

Leave the rest of `listTracks` (the COUNT query, the row query, the source-list round-trip) untouched — they already read those four names.

- [ ] **Step 5: Add `listTrackIds`**

Append after `listTracks`:

```ts
/**
 * Every track id matching these filters, in listview order, restricted to
 * tracks that can actually play. Unpaginated by design: the queue's whole
 * purpose is to run past the 200 rows the client has loaded.
 */
export function listTrackIds(db: Database, args: TrackFilterArgs): string[] {
  const { whereSql, params, addedJoin, orderSql } = buildTrackQuery(args);

  const playable = [...playableSources];
  if (playable.length === 0) return [];
  const playableClause = `track.id IN (
      SELECT entity_id FROM source_link
       WHERE entity_kind='track' AND source IN (${playable.map(() => '?').join(',')})
    )`;
  const combinedWhere = whereSql
    ? `${whereSql} AND ${playableClause}`
    : `WHERE ${playableClause}`;

  const rows = db
    .prepare(
      `SELECT track.id
         FROM track
         JOIN artist ON artist.id = track.artist_id
         ${addedJoin}
         ${combinedWhere}
         ORDER BY ${orderSql}`,
    )
    .all(...params, ...playable) as { id: string }[];
  return rows.map((r) => r.id);
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `bun verify scripts/verify-track-ids.ts`
Expected: PASS — 8 checks `ok:`.

- [ ] **Step 7: Confirm the sort suite still passes**

Run: `bun verify scripts/verify-sort.ts`
Expected: PASS — the extraction must not have changed `listTracks` behaviour.

- [ ] **Step 8: Add the endpoint**

Create `src/routes/api/library/tracks/ids/+server.ts`:

```ts
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { listTrackIds, parseSort } from '$lib/server/library/queries';

export const GET: RequestHandler = async ({ url }) => {
  const source = url.searchParams.get('source') ?? undefined;
  const q = url.searchParams.get('q') ?? undefined;
  const multiSource = url.searchParams.get('multi_source') === 'true';
  const sort = parseSort(url.searchParams.get('sort'));

  return json({ ids: listTrackIds(getDb(), { source, q, multiSource, sort }) });
};
```

- [ ] **Step 9: Type-check and commit**

Run: `bunx tsc --noEmit`
Expected: no output.

```bash
git add src/lib/server/library/queries.ts src/routes/api/library/tracks/ids/+server.ts scripts/verify-track-ids.ts
git commit -m "feat(queue): shared track-query builder and playable ids endpoint"
```

---

### Task 3: Player store — queue state, playFrom, next/prev

**Files:**
- Modify: `src/lib/stores/player.svelte.ts`

**Interfaces:**
- Consumes: `PlaybackContext`, `PrevAction`, `nextIndex`, `prevTarget` from `$lib/queue`; `GET /api/library/tracks/ids` from Task 2.
- Produces: on `player` — `queue: string[]`, `queueIndex: number`, `hasNext: boolean`, `hasPrev: boolean`, `playFrom(context, trackId, meta, seed?: NowPlaying[]): Promise<void>`, `next(): Promise<void>`, `prev(): Promise<void>`.

- [ ] **Step 1: Add queue state and imports**

At the top of `src/lib/stores/player.svelte.ts`, after the existing imports (the file currently has none — add these as the first lines):

```ts
import { nextIndex, prevTarget, type PlaybackContext } from '$lib/queue';
```

Then alongside the other `$state` declarations:

```ts
let queue = $state<string[]>([]);
let queueIndex = $state(-1);
let context = $state<PlaybackContext | null>(null);
/**
 * Title/artist/artwork for ids we've seen. Seeded by the call site (it is
 * rendering those rows, so it already has them); filled on demand when the
 * queue advances past what was loaded. Audio never waits on this — it only
 * needs the id — so a miss costs a beat of stale text, not silence.
 */
let metaCache = new Map<string, NowPlaying>();
```

- [ ] **Step 2: Expose the new getters**

Add to the `player` object, beside the existing getters:

```ts
  get queue() { return queue; },
  get queueIndex() { return queueIndex; },
  get hasNext() { return nextIndex(queueIndex, queue.length) !== null; },
  get hasPrev() { return queueIndex > 0; },
  get context() { return context; },
```

- [ ] **Step 3: Add the metadata resolver**

Add as a module-level function above `export const player`:

```ts
/** Metadata for a queued id, from cache or a single-track fetch. Null if it's gone. */
async function resolveMeta(trackId: string): Promise<NowPlaying | null> {
  const hit = metaCache.get(trackId);
  if (hit) return hit;
  try {
    const res = await fetch(`/api/library/tracks/${encodeURIComponent(trackId)}`);
    if (!res.ok) return null;
    const data = await res.json();
    const t = data.track;
    const meta: NowPlaying = {
      trackId: t.id,
      title: t.title,
      artist: t.artist,
      thumbUrl: t.thumb_url ?? null,
      releaseId: t.release_id ?? null,
    };
    metaCache.set(trackId, meta);
    return meta;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Add `playFrom`**

Add to the `player` object:

```ts
  /**
   * Start a track and capture the queue it belongs to. Playback starts
   * immediately; queue resolution happens after, so pressing play never waits
   * on a fetch. Release/playlist contexts carry their ids already.
   */
  async playFrom(ctx: PlaybackContext, trackId: string, meta: NowPlaying, seed?: NowPlaying[]) {
    this.play(meta);
    context = ctx;
    metaCache = new Map();
    for (const m of seed ?? []) metaCache.set(m.trackId, m);
    metaCache.set(meta.trackId, meta);

    let ids: string[];
    if (ctx.kind === 'library') {
      const params = new URLSearchParams();
      if (ctx.query.source) params.set('source', ctx.query.source);
      if (ctx.query.q) params.set('q', ctx.query.q);
      if (ctx.query.multiSource) params.set('multi_source', 'true');
      params.set('sort', ctx.query.sort);
      try {
        const res = await fetch(`/api/library/tracks/ids?${params.toString()}`);
        ids = res.ok ? ((await res.json()).ids ?? []) : [];
      } catch {
        ids = [];
      }
    } else {
      ids = ctx.ids;
    }

    // A newer play() may have landed while we were fetching; don't clobber it.
    if (nowPlaying?.trackId !== trackId) return;
    queue = ids;
    queueIndex = ids.indexOf(trackId);
  },
```

- [ ] **Step 5: Add `next` and `prev`**

Add to the `player` object:

```ts
  /**
   * Move to `target`, skipping ids whose metadata no longer resolves (a track
   * deleted since the queue was captured). Bounded by the queue length so a run
   * of stale ids terminates instead of spinning.
   */
  async _goTo(target: number, step: number) {
    let i = target;
    for (let guard = 0; guard < queue.length; guard++) {
      if (i < 0 || i >= queue.length) break;
      const meta = await resolveMeta(queue[i]);
      if (meta) {
        queueIndex = i;
        this.play(meta);
        return;
      }
      i += step;
    }
    // Nothing left in that direction: stop, but keep the track loaded.
    isPlaying = false;
  },

  async next() {
    const target = nextIndex(queueIndex, queue.length);
    if (target === null) {
      isPlaying = false;
      return;
    }
    await this._goTo(target, 1);
  },

  async prev() {
    const action = prevTarget(currentTime, queueIndex, queue.length);
    if (action.kind === 'none') return;
    if (action.kind === 'restart') {
      this.seekTo(0);
      return;
    }
    await this._goTo(action.index, -1);
  },
```

- [ ] **Step 6: Clear the queue on stop**

In the existing `stop()`, add before its closing brace:

```ts
    queue = [];
    queueIndex = -1;
    context = null;
    metaCache = new Map();
```

- [ ] **Step 7: Type-check and commit**

Run: `bunx tsc --noEmit`
Expected: no output.

```bash
git add src/lib/stores/player.svelte.ts
git commit -m "feat(queue): queue state, playFrom, next/prev in the player store"
```

---

### Task 4: Auto-advance and the transport buttons

**Files:**
- Modify: `src/lib/components/Player.svelte:52` (the `onended` handler)
- Modify: `src/lib/components/PlayerBar.svelte`

**Interfaces:**
- Consumes: `player.next`, `player.prev`, `player.hasNext`, `player.hasPrev` from Task 3.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Auto-advance on track end**

In `src/lib/components/Player.svelte`, replace:

```svelte
  onended={() => player.stop()}
```

with:

```svelte
  onended={() => player.next()}
```

`next()` with no queue leaves the track loaded and paused rather than clearing it, which is the intended end-of-queue behaviour.

- [ ] **Step 2: Add prev/next to the transport**

In `src/lib/components/PlayerBar.svelte`, replace the existing `play-pause` button with this three-button row:

```svelte
      <div class="buttons">
        <button
          class="skip"
          onclick={() => player.prev()}
          disabled={!player.hasPrev && player.currentTime <= 3}
          aria-label="Previous track"
        >⏮</button>

        <button
          class="play-pause"
          onclick={() => (player.isPlaying ? player.pause() : player.resume())}
          aria-label={player.isPlaying ? 'Pause' : 'Play'}
        >
          {player.isPlaying ? '⏸' : '▶'}
        </button>

        <button
          class="skip"
          onclick={() => player.next()}
          disabled={!player.hasNext}
          aria-label="Next track"
        >⏭</button>
      </div>
```

Prev stays enabled whenever restarting is meaningful, which is why its `disabled` also consults `currentTime`.

- [ ] **Step 3: Style the row**

In the same file's `<style>`, add after the `.play-pause` rules:

```css
  .buttons {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .skip {
    background: transparent;
    border: 0;
    color: var(--text-muted);
    font-size: 13px;
    padding: 0;
    width: 20px;
    height: 20px;
    line-height: 1;
    cursor: pointer;
  }
  .skip:hover:not(:disabled) { color: var(--text); }
  .skip:disabled { opacity: 0.3; cursor: default; }
```

- [ ] **Step 4: Verify it compiles**

Run in one shell:

```bash
bunx --bun vite dev --port 5199 --strictPort > /tmp/queue-check.log 2>&1 &
sleep 6
curl -s -o /dev/null -w "page %{http_code}\n" http://localhost:5199/
curl -s http://localhost:5199/src/lib/components/PlayerBar.svelte | grep -c "hasNext"
```

Expected: `page 200`, and a non-zero count. Then kill **only that PID** — never `pkill vite`, which would also kill the user's own dev server.

- [ ] **Step 5: Type-check and commit**

Run: `bunx tsc --noEmit`
Expected: no output.

```bash
git add src/lib/components/Player.svelte src/lib/components/PlayerBar.svelte
git commit -m "feat(queue): auto-advance on end, prev/next transport buttons"
```

---

### Task 5: Wire the call sites, then document

**Files:**
- Modify: `src/lib/components/ReleaseDetail.svelte` (the tracklist transport `onclick` and `ondblclick`)
- Modify: `src/lib/components/PlaylistView.svelte:181`
- Modify: `src/lib/components/TrackList.svelte:74,76`
- Modify: `src/lib/components/Explorer.svelte` (pass the library query into `TrackList`)
- Modify: `docs/CONTEXT.md`

**Interfaces:**
- Consumes: `player.playFrom` from Task 3; `PlaybackContext`/`LibraryQuery` from Task 1.
- Produces: nothing.

- [ ] **Step 1: Release tracklist**

In `ReleaseDetail.svelte`, add near the other imports:

```ts
  import type { PlaybackContext } from '$lib/queue';
```

Add to the `<script>` block, after the props. **Not** `{@const}` in markup — Svelte only permits that as an immediate child of a block (`{#each}`/`{#if}`), so a top-level `{@const}` is a compile error:

```ts
  const playableTracks = $derived(tracks.filter((t) => t.canPlay));
  const releaseCtx = $derived({
    kind: 'release',
    releaseId: release.id,
    ids: playableTracks.map((t) => t.id),
  } as PlaybackContext);
  const releaseSeed = $derived(
    playableTracks.map((t) => ({
      trackId: t.id,
      title: t.title,
      artist: release.artist,
      thumbUrl: release.thumb_url,
      releaseId: release.id,
    })),
  );
```

Then replace **both** places that currently call `player.play({ trackId: t.id, … })` — the transport button's idle branch and the row's `ondblclick` — with:

```ts
player.playFrom(releaseCtx, t.id, { trackId: t.id, title: t.title, artist: release.artist, thumbUrl: release.thumb_url, releaseId: release.id }, releaseSeed)
```

- [ ] **Step 2: Playlist view**

In `PlaylistView.svelte`, add to the imports:

```ts
  import type { PlaybackContext } from '$lib/queue';
```

Add to the `<script>` block (again `$derived`, not `{@const}` — see Step 1):

```ts
  const playablePl = $derived(tracks.filter((t) => t.canPlay));
  const playlistCtx = $derived({
    kind: 'playlist',
    playlistId: playlist.id,
    ids: playablePl.map((t) => t.id),
  } as PlaybackContext);
  const playlistSeed = $derived(
    playablePl.map((t) => ({
      trackId: t.id,
      title: t.title,
      artist: t.artist,
      thumbUrl: t.thumb_url,
      releaseId: t.release_id,
    })),
  );
```

Replace the `ondblclick` body with:

```ts
if (t.canPlay) player.playFrom(playlistCtx, t.id, { trackId: t.id, title: t.title, artist: t.artist, thumbUrl: t.thumb_url, releaseId: t.release_id }, playlistSeed)
```

If the local name for the open playlist differs from `playlist`, use whichever name the component already binds — do not introduce a new one.

- [ ] **Step 3: Track list takes a query prop**

In `TrackList.svelte`, add to the props declaration a `query` prop:

```ts
    query,
```

and to its type:

```ts
    query?: LibraryQuery;
```

Add to the `<script>` block (again `$derived`, not `{@const}` — see Step 1), importing the shared default rather than hardcoding it:

```ts
  import { DEFAULT_SORT } from '$lib/types';
  import type { LibraryQuery, PlaybackContext } from '$lib/queue';

  const libraryCtx = $derived({
    kind: 'library',
    query: query ?? { sort: DEFAULT_SORT },
  } as PlaybackContext);
```

Replace **both** `player.play({ trackId: item.id, … })` calls (the `onkeydown` and the `ondblclick`) with:

```ts
player.playFrom(libraryCtx, item.id, { trackId: item.id, title: item.title, artist: item.artist, thumbUrl: item.thumb_url, releaseId: item.release_id })
```

No seed here: the loaded rows are a 200-row window of a much longer queue, so seeding buys little and `resolveMeta` covers the rest.

- [ ] **Step 4: Explorer supplies the query**

`TrackList` does not own the filters — `Explorer` does. In `Explorer.svelte`, add a derived value beside the other `$derived` declarations:

```ts
  const libraryQuery = $derived({
    source: explorerState.nav.section === 'sources' ? explorerState.nav.item : undefined,
    q: explorerState.q || undefined,
    sort: explorerState.sort,
    multiSource:
      explorerState.nav.section === 'library' && explorerState.nav.item === 'in-multiple-sources',
  });
```

These must mirror exactly what `loadList` sends to `/api/library/tracks`; if they diverge, the queue's order won't match the visible list. Then pass it where `<TrackList … />` is rendered:

```svelte
      query={libraryQuery}
```

- [ ] **Step 5: Verify the whole thing compiles and the suites pass**

```bash
bunx tsc --noEmit
bun verify scripts/verify-queue.ts
bun verify scripts/verify-track-ids.ts
bun verify scripts/verify-sort.ts
bun verify scripts/verify-playback-state.ts
```

Expected: no tsc output; all four scripts print `All checks passed.`

- [ ] **Step 6: Update the context docs**

In `docs/CONTEXT.md`:

1. In the **Playback** section, add the queue model (context captured at play time, resolved to `ids[] + index`), the `/api/library/tracks/ids` endpoint, the metadata cache and why it exists, and the prev/next semantics table from the spec.
2. In the **file map**, add `queue.ts` under `lib/` and `tracks/ids/+server.ts` under the library routes.
3. In the **Playlists** section, delete the phrase `no queue/auto-advance yet (fast-follow)` — it is no longer true.
4. In **Known gaps in shipped code**, add: the queue is in-memory and lost on reload; re-sorting mid-playback does not rebuild an in-flight queue (intentional); playlist reordering is not reflected in a captured queue.

- [ ] **Step 7: Commit**

```bash
git add src/lib/components docs/CONTEXT.md
git commit -m "feat(queue): capture playback context at every play site"
```

---

## Manual verification

The verify scripts cover the arithmetic and the ordering invariant, but not the browser. After Task 5, with `bun dev` running:

1. Play a track from a release tracklist. `⏭` should walk the release in order, then stop at the last track (loaded, paused).
2. Play from the library list sorted `Added ↓`, scroll nowhere, press `⏭` repeatedly past 200 tracks — it must keep going, with the bar's text updating a beat behind the audio.
3. Press `⏮` more than 3s into a track: it restarts. Press again immediately: it steps back.
4. Play from a playlist, navigate to a different release, press `⏭` — it must continue the *playlist*, not the release you're looking at.
5. Let a track play to its end — the next one starts automatically.
