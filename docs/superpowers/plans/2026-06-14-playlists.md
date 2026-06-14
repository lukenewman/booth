# Playlists (MVP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add manual, in-app playlists — create/rename/delete, a new Rail section, drag tracks in from track lists, drag-to-reorder, remove, and a keyboard add path — over the existing unified library.

**Architecture:** Playlists are a Booth-native layer over the `track` table (two new tables, no `source_link`/`match_key` involvement). A server module + thin `/api/playlists/*` routes expose CRUD; a client `playlists` store mirrors both the rail list and the currently-open playlist so the new `PlaylistView` and global keyboard shortcuts read one reactive source of truth. Playback is unchanged (single-track, double-click).

**Tech Stack:** SvelteKit 2 + Svelte 5 runes, TypeScript, Bun, `bun:sqlite`, native HTML5 drag-and-drop, `ulid` for ids.

**Verification note (Booth has no unit-test runner):** server logic is verified with a `bun verify scripts/*.ts` script (write the script first so it fails, then implement until it passes — the Booth equivalent of TDD). UI tasks are verified with `bun check` (type-check) plus explicit manual browser steps. Commit after every task.

**Type-check command used throughout:** `bun check` (alias for `svelte-kit sync && svelte-check`).

---

## File structure

**Create:**
- `src/lib/server/db/migrations/007_playlists.sql` — `playlist` + `playlist_track` tables.
- `src/lib/server/library/playlists.ts` — all playlist DB queries.
- `scripts/verify-playlists.ts` — server-module verification.
- `src/routes/api/playlists/+server.ts` — GET list / POST create.
- `src/routes/api/playlists/[id]/+server.ts` — GET detail / PATCH rename / DELETE.
- `src/routes/api/playlists/[id]/tracks/+server.ts` — POST add / PATCH reorder.
- `src/routes/api/playlists/[id]/tracks/[trackId]/+server.ts` — DELETE remove.
- `src/lib/stores/playlists.svelte.ts` — client store (rail list + open playlist).
- `src/lib/components/PlaylistView.svelte` — middle-pane playlist view.
- `src/lib/components/PlaylistPicker.svelte` — keyboard add-to-playlist overlay.

**Modify:**
- `src/lib/server/library/queries.ts` — add exported `getTracksByIds` helper (reuses `playableSources`).
- `src/lib/stores/explorerState.svelte.ts` — add `'playlist'` nav section.
- `src/lib/components/Rail.svelte` — Playlists section (list, new-playlist input, drop targets).
- `src/lib/components/Listview.svelte` — add `data-id` to each row button.
- `src/lib/components/TrackList.svelte` — make rows draggable.
- `src/lib/components/ReleaseDetail.svelte` — make tracklist rows draggable.
- `src/lib/components/Explorer.svelte` — load playlists, route `playlist:<id>` to `PlaylistView`, guard `loadList`.
- `src/lib/keyboard.svelte.ts` — `a` (add-to-playlist) and `Delete`/`Backspace` (remove) actions.
- `src/routes/+page.svelte` — wire the two new keyboard actions + mount `PlaylistPicker`.
- `src/lib/components/ShortcutOverlay.svelte` — document the new shortcuts.
- `docs/CONTEXT.md` — Playlists feature section + file map + nav namespace.

---

## Task 1: Database migration

**Files:**
- Create: `src/lib/server/db/migrations/007_playlists.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Playlists: a Booth-native organizational layer over the unified `track`
-- table. Not a source — these tables never touch source_link / match_key /
-- source_facets. A track may appear at most once per playlist (the join's
-- composite PK); membership and entities both cascade-delete.

CREATE TABLE playlist (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE playlist_track (
  playlist_id TEXT NOT NULL REFERENCES playlist(id) ON DELETE CASCADE,
  track_id    TEXT NOT NULL REFERENCES track(id)    ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  added_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (playlist_id, track_id)
);
CREATE INDEX idx_playlist_track_order ON playlist_track(playlist_id, position);
```

- [ ] **Step 2: Apply + verify the migration runs**

Run: `bun run -e "import('./src/lib/server/db/migrate').then(async ({runMigrations}) => { const {Database} = await import('bun:sqlite'); const db = new Database(':memory:'); runMigrations(db); const t = db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name IN ('playlist','playlist_track')\").all(); console.log(JSON.stringify(t)); }) "`

Expected: prints `[{"name":"playlist"},{"name":"playlist_track"}]` and a `[db] applied 007_playlists.sql` line.

- [ ] **Step 3: Type-check**

Run: `bun check`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/server/db/migrations/007_playlists.sql
git commit -m "feat(playlists): playlist + playlist_track tables (migration 007)"
```

---

## Task 2: Server module + verification script

**Files:**
- Modify: `src/lib/server/library/queries.ts` (add `getTracksByIds`)
- Create: `src/lib/server/library/playlists.ts`
- Create: `scripts/verify-playlists.ts`

- [ ] **Step 1: Add `getTracksByIds` to `queries.ts`**

Append this exported function to `src/lib/server/library/queries.ts` (it reuses the module-private `playableSources` set already defined at the top of that file, so `canPlay` is computed identically to `listTracks`):

```ts
/**
 * Fetch tracks by id in the shared list shape (artist joined, canPlay computed).
 * Returned as a Map keyed by track id so callers can re-order as they like
 * (e.g. playlists order by their own `position`). Unknown ids are absent.
 */
export function getTracksByIds(
  db: Database,
  ids: string[],
): Map<string, TrackRow & { sources: string[]; canPlay: boolean }> {
  const out = new Map<string, TrackRow & { sources: string[]; canPlay: boolean }>();
  if (ids.length === 0) return out;
  const placeholders = ids.map(() => '?').join(',');

  const rows = db
    .prepare(
      `SELECT track.id, track.title, artist.name AS artist,
              track.album, track.duration_ms, track.release_id, track.position,
              release.thumb_url
         FROM track
         JOIN artist ON artist.id = track.artist_id
         LEFT JOIN release ON release.id = track.release_id
         WHERE track.id IN (${placeholders})`,
    )
    .all(...ids) as TrackRow[];

  const srcRows = db
    .prepare(
      `SELECT entity_id, source FROM source_link
         WHERE entity_kind='track' AND entity_id IN (${placeholders})`,
    )
    .all(...ids) as { entity_id: string; source: string }[];

  const sourceMap = new Map<string, string[]>();
  for (const { entity_id, source } of srcRows) {
    const list = sourceMap.get(entity_id) ?? [];
    list.push(source);
    sourceMap.set(entity_id, list);
  }

  for (const r of rows) {
    const sources = sourceMap.get(r.id) ?? [];
    out.set(r.id, { ...r, sources, canPlay: sources.some((s) => playableSources.has(s)) });
  }
  return out;
}
```

- [ ] **Step 2: Write the verification script (it will fail — module doesn't exist yet)**

Create `scripts/verify-playlists.ts`:

```ts
import { Database } from 'bun:sqlite';
import { ulid } from 'ulid';
import { runMigrations } from '../src/lib/server/db/migrate';
import {
  listPlaylists,
  createPlaylist,
  renamePlaylist,
  deletePlaylist,
  getPlaylist,
  addTrack,
  removeTrack,
  reorderTracks,
} from '../src/lib/server/library/playlists';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) fail(msg);
}

const db = new Database(':memory:');
db.exec('PRAGMA foreign_keys = ON'); // required for cascade assertions
runMigrations(db);

// Seed: one artist, two tracks. track1 is playable (local source_link),
// track2 is not (no playable link) — exercises canPlay passthrough.
const artistId = ulid();
db.prepare(`INSERT INTO artist (id, name) VALUES (?, ?)`).run(artistId, 'Test Artist');

const t1 = ulid();
const t2 = ulid();
db.prepare(
  `INSERT INTO track (id, title, artist_id, album, duration_ms, release_id, position)
     VALUES (?, ?, ?, ?, ?, NULL, ?)`,
).run(t1, 'Track One', artistId, 'Album', 60000, 'A1');
db.prepare(
  `INSERT INTO track (id, title, artist_id, album, duration_ms, release_id, position)
     VALUES (?, ?, ?, ?, ?, NULL, ?)`,
).run(t2, 'Track Two', artistId, 'Album', 90000, 'A2');
db.prepare(
  `INSERT INTO source_link (entity_kind, entity_id, source, external_id, external_url, match_method)
     VALUES ('track', ?, 'local', '/music/one.wav', NULL, 'file_path')`,
).run(t1);

// create
const p = createPlaylist(db, 'Evening');
assert(p.name === 'Evening', `created name wrong: ${p.name}`);
assert(p.trackCount === 0, `new playlist trackCount should be 0, got ${p.trackCount}`);

// listPlaylists
let list = listPlaylists(db);
assert(list.length === 1, `expected 1 playlist, got ${list.length}`);
assert(list[0].id === p.id, 'list id mismatch');

// addTrack (both), with dedupe no-op on re-add
assert(addTrack(db, p.id, t1).added === true, 't1 add should report added');
assert(addTrack(db, p.id, t2).added === true, 't2 add should report added');
assert(addTrack(db, p.id, t1).added === false, 're-adding t1 should be a no-op');

list = listPlaylists(db);
assert(list[0].trackCount === 2, `trackCount should be 2, got ${list[0].trackCount}`);

// getPlaylist: ordered, canPlay passes through
let detail = getPlaylist(db, p.id);
assert(detail !== null, 'getPlaylist returned null');
assert(detail!.tracks.length === 2, `detail tracks: expected 2, got ${detail!.tracks.length}`);
assert(detail!.tracks[0].id === t1 && detail!.tracks[1].id === t2, 'initial order wrong');
assert(detail!.tracks[0].canPlay === true, 't1 should be playable');
assert(detail!.tracks[1].canPlay === false, 't2 should not be playable');

// reorder
reorderTracks(db, p.id, [t2, t1]);
detail = getPlaylist(db, p.id);
assert(detail!.tracks[0].id === t2 && detail!.tracks[1].id === t1, 'reorder did not take');

// removeTrack renumbers (remaining single track sits at position 0)
removeTrack(db, p.id, t2);
detail = getPlaylist(db, p.id);
assert(detail!.tracks.length === 1 && detail!.tracks[0].id === t1, 'remove failed');
const pos = db.prepare(`SELECT position FROM playlist_track WHERE playlist_id=?`).get(p.id) as { position: number };
assert(pos.position === 0, `remaining track should be renumbered to 0, got ${pos.position}`);

// rename
renamePlaylist(db, p.id, 'Late Night');
assert(listPlaylists(db)[0].name === 'Late Night', 'rename did not take');

// deleting a track cascades the join row
db.prepare(`DELETE FROM track WHERE id=?`).run(t1);
detail = getPlaylist(db, p.id);
assert(detail!.tracks.length === 0, 'track delete should cascade out of the playlist');

// deletePlaylist cascades remaining join rows + removes the playlist.
// Re-add t2 (the track still exists — it was only removed from the playlist
// earlier; t1 is the one we hard-deleted) so there's a join row to cascade.
addTrack(db, p.id, t2);
deletePlaylist(db, p.id);
assert(listPlaylists(db).length === 0, 'playlist should be gone after delete');
const orphans = db.prepare(`SELECT COUNT(*) AS n FROM playlist_track`).get() as { n: number };
assert(orphans.n === 0, `playlist_track rows should be gone after playlist delete, got ${orphans.n}`);

console.log('PASS: playlists — create, list, add/dedupe, reorder, remove, rename, cascade');
```

- [ ] **Step 3: Run the script to confirm it fails**

Run: `bun verify scripts/verify-playlists.ts`
Expected: FAILS — `Cannot find module '../src/lib/server/library/playlists'` (module not written yet).

- [ ] **Step 4: Write the server module**

Create `src/lib/server/library/playlists.ts`:

```ts
import type { Database } from 'bun:sqlite';
import { ulid } from 'ulid';
import { getTracksByIds, type TrackRow } from './queries';

export interface PlaylistSummary {
  id: string;
  name: string;
  trackCount: number;
}

export type PlaylistTrack = TrackRow & { sources: string[]; canPlay: boolean };

export interface PlaylistDetail {
  id: string;
  name: string;
  tracks: PlaylistTrack[];
}

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;

export function listPlaylists(db: Database): PlaylistSummary[] {
  return db
    .prepare(
      `SELECT playlist.id, playlist.name,
              (SELECT COUNT(*) FROM playlist_track WHERE playlist_id = playlist.id) AS trackCount
         FROM playlist
         ORDER BY playlist.name COLLATE NOCASE`,
    )
    .all() as PlaylistSummary[];
}

export function createPlaylist(db: Database, name: string): PlaylistSummary {
  const clean = name.trim();
  if (!clean) throw new Error('playlist name required');
  const id = ulid();
  db.prepare(`INSERT INTO playlist (id, name) VALUES (?, ?)`).run(id, clean);
  return { id, name: clean, trackCount: 0 };
}

export function renamePlaylist(db: Database, id: string, name: string): void {
  const clean = name.trim();
  if (!clean) throw new Error('playlist name required');
  db.prepare(`UPDATE playlist SET name = ?, updated_at = ${NOW} WHERE id = ?`).run(clean, id);
}

export function deletePlaylist(db: Database, id: string): void {
  // playlist_track rows cascade (FK ON DELETE CASCADE; foreign_keys pragma is
  // ON for the app connection — see db/index.ts).
  db.prepare(`DELETE FROM playlist WHERE id = ?`).run(id);
}

export function getPlaylist(db: Database, id: string): PlaylistDetail | null {
  const playlist = db
    .prepare(`SELECT id, name FROM playlist WHERE id = ?`)
    .get(id) as { id: string; name: string } | undefined;
  if (!playlist) return null;

  const orderRows = db
    .prepare(`SELECT track_id FROM playlist_track WHERE playlist_id = ? ORDER BY position`)
    .all(id) as { track_id: string }[];

  const byId = getTracksByIds(db, orderRows.map((r) => r.track_id));
  const tracks: PlaylistTrack[] = [];
  for (const { track_id } of orderRows) {
    const t = byId.get(track_id);
    if (t) tracks.push(t);
  }
  return { id: playlist.id, name: playlist.name, tracks };
}

export function addTrack(db: Database, playlistId: string, trackId: string): { added: boolean } {
  const res = db
    .prepare(
      `INSERT OR IGNORE INTO playlist_track (playlist_id, track_id, position)
         VALUES (?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM playlist_track WHERE playlist_id = ?))`,
    )
    .run(playlistId, trackId, playlistId);
  const added = res.changes > 0;
  if (added) db.prepare(`UPDATE playlist SET updated_at = ${NOW} WHERE id = ?`).run(playlistId);
  return { added };
}

export function removeTrack(db: Database, playlistId: string, trackId: string): void {
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM playlist_track WHERE playlist_id = ? AND track_id = ?`).run(playlistId, trackId);
    renumber(db, playlistId);
    db.prepare(`UPDATE playlist SET updated_at = ${NOW} WHERE id = ?`).run(playlistId);
  });
  tx();
}

export function reorderTracks(db: Database, playlistId: string, orderedTrackIds: string[]): void {
  const tx = db.transaction(() => {
    let pos = 0;
    const stmt = db.prepare(
      `UPDATE playlist_track SET position = ? WHERE playlist_id = ? AND track_id = ?`,
    );
    for (const trackId of orderedTrackIds) {
      stmt.run(pos, playlistId, trackId);
      pos++;
    }
    // Any ids not named in orderedTrackIds keep their (now higher) positions;
    // renumber compacts everything to a clean 0..n by current position.
    renumber(db, playlistId);
    db.prepare(`UPDATE playlist SET updated_at = ${NOW} WHERE id = ?`).run(playlistId);
  });
  tx();
}

/** Rewrite a playlist's positions to a contiguous 0..n by current order. */
function renumber(db: Database, playlistId: string): void {
  const rows = db
    .prepare(`SELECT track_id FROM playlist_track WHERE playlist_id = ? ORDER BY position`)
    .all(playlistId) as { track_id: string }[];
  const stmt = db.prepare(
    `UPDATE playlist_track SET position = ? WHERE playlist_id = ? AND track_id = ?`,
  );
  rows.forEach((r, i) => stmt.run(i, playlistId, r.track_id));
}
```

- [ ] **Step 5: Run the verification script — it should pass**

Run: `bun verify scripts/verify-playlists.ts`
Expected: `PASS: playlists — create, list, add/dedupe, reorder, remove, rename, cascade`

- [ ] **Step 6: Type-check**

Run: `bun check`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/server/library/playlists.ts src/lib/server/library/queries.ts scripts/verify-playlists.ts
git commit -m "feat(playlists): server module + getTracksByIds helper + verify script"
```

---

## Task 3: API routes

**Files:**
- Create: `src/routes/api/playlists/+server.ts`
- Create: `src/routes/api/playlists/[id]/+server.ts`
- Create: `src/routes/api/playlists/[id]/tracks/+server.ts`
- Create: `src/routes/api/playlists/[id]/tracks/[trackId]/+server.ts`

- [ ] **Step 1: List + create route**

Create `src/routes/api/playlists/+server.ts`:

```ts
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { listPlaylists, createPlaylist } from '$lib/server/library/playlists';

export const GET: RequestHandler = async () => {
  return json({ items: listPlaylists(getDb()) });
};

export const POST: RequestHandler = async ({ request }) => {
  const body = await request.json().catch(() => ({}));
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) throw error(400, 'name required');
  return json(createPlaylist(getDb(), name), { status: 201 });
};
```

- [ ] **Step 2: Detail + rename + delete route**

Create `src/routes/api/playlists/[id]/+server.ts`:

```ts
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { getPlaylist, renamePlaylist, deletePlaylist } from '$lib/server/library/playlists';

export const GET: RequestHandler = async ({ params }) => {
  const detail = getPlaylist(getDb(), params.id);
  if (!detail) throw error(404, `playlist not found: ${params.id}`);
  return json(detail);
};

export const PATCH: RequestHandler = async ({ params, request }) => {
  const body = await request.json().catch(() => ({}));
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) throw error(400, 'name required');
  const db = getDb();
  if (!getPlaylist(db, params.id)) throw error(404, `playlist not found: ${params.id}`);
  renamePlaylist(db, params.id, name);
  return json({ id: params.id, name });
};

export const DELETE: RequestHandler = async ({ params }) => {
  deletePlaylist(getDb(), params.id);
  return new Response(null, { status: 204 });
};
```

- [ ] **Step 3: Add + reorder route**

Create `src/routes/api/playlists/[id]/tracks/+server.ts`:

```ts
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { addTrack, reorderTracks, listPlaylists } from '$lib/server/library/playlists';

function trackCount(id: string): number {
  return listPlaylists(getDb()).find((p) => p.id === id)?.trackCount ?? 0;
}

export const POST: RequestHandler = async ({ params, request }) => {
  const body = await request.json().catch(() => ({}));
  const trackId = typeof body.trackId === 'string' ? body.trackId : '';
  if (!trackId) throw error(400, 'trackId required');
  const { added } = addTrack(getDb(), params.id, trackId);
  return json({ added, trackCount: trackCount(params.id) });
};

export const PATCH: RequestHandler = async ({ params, request }) => {
  const body = await request.json().catch(() => ({}));
  const order = Array.isArray(body.order) ? (body.order as unknown[]).filter((x): x is string => typeof x === 'string') : null;
  if (!order) throw error(400, 'order array required');
  reorderTracks(getDb(), params.id, order);
  return new Response(null, { status: 204 });
};
```

- [ ] **Step 4: Remove route**

Create `src/routes/api/playlists/[id]/tracks/[trackId]/+server.ts`:

```ts
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { removeTrack, listPlaylists } from '$lib/server/library/playlists';

export const DELETE: RequestHandler = async ({ params }) => {
  removeTrack(getDb(), params.id, params.trackId);
  const trackCount = listPlaylists(getDb()).find((p) => p.id === params.id)?.trackCount ?? 0;
  return json({ trackCount });
};
```

- [ ] **Step 5: Type-check**

Run: `bun check`
Expected: no errors.

- [ ] **Step 6: Manual smoke test against the dev server**

Start dev server in one shell: `bun dev` (note the port it binds, usually 5173). In another shell:

```bash
PORT=5173
PID=$(curl -s -X POST localhost:$PORT/api/playlists -H 'content-type: application/json' -d '{"name":"Smoke Test"}' | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])')
echo "created $PID"
curl -s localhost:$PORT/api/playlists                                  # → {"items":[{... "Smoke Test" ...}]}
curl -s localhost:$PORT/api/playlists/$PID                             # → {"id":...,"name":"Smoke Test","tracks":[]}
curl -s -X DELETE localhost:$PORT/api/playlists/$PID -o /dev/null -w '%{http_code}\n'  # → 204
```

Expected: create returns 201 JSON with an id; list contains "Smoke Test"; detail has empty tracks; delete returns 204. Stop `bun dev`.

- [ ] **Step 7: Commit**

```bash
git add src/routes/api/playlists
git commit -m "feat(playlists): /api/playlists CRUD + track add/remove/reorder routes"
```

---

## Task 4: Client store

**Files:**
- Create: `src/lib/stores/playlists.svelte.ts`

- [ ] **Step 1: Write the store**

Create `src/lib/stores/playlists.svelte.ts`. It mirrors two things: `items` (rail list) and `openPlaylist` (the currently-viewed playlist). Mutations update both so `PlaylistView` and global keyboard shortcuts read one reactive source.

```ts
export interface PlaylistSummary {
  id: string;
  name: string;
  trackCount: number;
}

export interface PlaylistTrack {
  id: string;
  title: string;
  artist: string;
  album: string | null;
  duration_ms: number | null;
  release_id: string | null;
  position: string | null;
  thumb_url: string | null;
  sources: string[];
  canPlay: boolean;
}

export interface PlaylistDetail {
  id: string;
  name: string;
  tracks: PlaylistTrack[];
}

class PlaylistsStore {
  items = $state<PlaylistSummary[]>([]);
  openPlaylist = $state<PlaylistDetail | null>(null);

  async loadList() {
    try {
      const res = await fetch('/api/playlists');
      if (!res.ok) return;
      const data = (await res.json()) as { items: PlaylistSummary[] };
      this.items = data.items ?? [];
    } catch {
      // silent — rail just won't show playlists
    }
  }

  async loadPlaylist(id: string) {
    try {
      const res = await fetch(`/api/playlists/${id}`);
      if (!res.ok) {
        this.openPlaylist = null;
        return;
      }
      this.openPlaylist = (await res.json()) as PlaylistDetail;
    } catch {
      this.openPlaylist = null;
    }
  }

  async create(name: string): Promise<PlaylistSummary | null> {
    const res = await fetch('/api/playlists', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) return null;
    const created = (await res.json()) as PlaylistSummary;
    this.items = [...this.items, created].sort((a, b) => a.name.localeCompare(b.name));
    return created;
  }

  async rename(id: string, name: string) {
    const res = await fetch(`/api/playlists/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) return;
    this.items = this.items
      .map((p) => (p.id === id ? { ...p, name } : p))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (this.openPlaylist?.id === id) this.openPlaylist = { ...this.openPlaylist, name };
  }

  async remove(id: string) {
    const res = await fetch(`/api/playlists/${id}`, { method: 'DELETE' });
    if (!res.ok) return;
    this.items = this.items.filter((p) => p.id !== id);
    if (this.openPlaylist?.id === id) this.openPlaylist = null;
  }

  async addTrack(playlistId: string, trackId: string): Promise<{ added: boolean }> {
    const res = await fetch(`/api/playlists/${playlistId}/tracks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ trackId }),
    });
    if (!res.ok) return { added: false };
    const data = (await res.json()) as { added: boolean; trackCount: number };
    this.items = this.items.map((p) => (p.id === playlistId ? { ...p, trackCount: data.trackCount } : p));
    if (data.added && this.openPlaylist?.id === playlistId) await this.loadPlaylist(playlistId);
    return { added: data.added };
  }

  async removeTrack(playlistId: string, trackId: string) {
    const res = await fetch(`/api/playlists/${playlistId}/tracks/${trackId}`, { method: 'DELETE' });
    if (!res.ok) return;
    const data = (await res.json()) as { trackCount: number };
    this.items = this.items.map((p) => (p.id === playlistId ? { ...p, trackCount: data.trackCount } : p));
    if (this.openPlaylist?.id === playlistId) {
      this.openPlaylist = {
        ...this.openPlaylist,
        tracks: this.openPlaylist.tracks.filter((t) => t.id !== trackId),
      };
    }
  }

  /** Optimistically reorder the open playlist, then persist. */
  async reorder(playlistId: string, orderedTrackIds: string[]) {
    if (this.openPlaylist?.id === playlistId) {
      const byId = new Map(this.openPlaylist.tracks.map((t) => [t.id, t]));
      const next = orderedTrackIds.map((id) => byId.get(id)).filter((t): t is PlaylistTrack => !!t);
      this.openPlaylist = { ...this.openPlaylist, tracks: next };
    }
    await fetch(`/api/playlists/${playlistId}/tracks`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ order: orderedTrackIds }),
    });
  }
}

export const playlists = new PlaylistsStore();
```

- [ ] **Step 2: Type-check**

Run: `bun check`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/stores/playlists.svelte.ts
git commit -m "feat(playlists): client store (rail list + open playlist mirror)"
```

---

## Task 5: Nav section + Rail section + Explorer wiring

**Files:**
- Modify: `src/lib/stores/explorerState.svelte.ts`
- Modify: `src/lib/components/Rail.svelte`
- Modify: `src/lib/components/Explorer.svelte`

- [ ] **Step 1: Add the `'playlist'` nav section**

In `src/lib/stores/explorerState.svelte.ts`, change the `NavSection` type and the `parseNav` validation.

Change:
```ts
export type NavSection = 'library' | 'sources' | 'add';
```
to:
```ts
export type NavSection = 'library' | 'sources' | 'add' | 'playlist';
```

In `parseNav`, change the guard:
```ts
  if (section !== 'library' && section !== 'sources' && section !== 'add') {
    return { nav: { ...DEFAULT_NAV }, entityHint: null };
  }
```
to:
```ts
  if (section !== 'library' && section !== 'sources' && section !== 'add' && section !== 'playlist') {
    return { nav: { ...DEFAULT_NAV }, entityHint: null };
  }
```

- [ ] **Step 2: Add the Playlists section to the Rail**

In `src/lib/components/Rail.svelte`, add props and a new section. Update the `$props()` block to add `playlists`, `onCreatePlaylist`, and `onAddTrackToPlaylist`:

```ts
  let {
    nav,
    entity,
    sources,
    counts,
    playlists = [],
    onSelect,
    onCreatePlaylist,
    onAddTrackToPlaylist,
  }: {
    nav: NavValue;
    entity: 'releases' | 'tracks' | 'artists';
    sources: SourceWithState[];
    counts: Counts;
    playlists?: { id: string; name: string; trackCount: number }[];
    onSelect?: (nav: NavValue) => void;
    onCreatePlaylist?: (name: string) => void;
    onAddTrackToPlaylist?: (playlistId: string, trackId: string) => void;
  } = $props();
```

Add this local state + helpers inside the `<script>` (after the existing `writableSources` derived):

```ts
  let creating = $state(false);
  let newName = $state('');
  let dropTargetId = $state<string | null>(null);

  function submitNewPlaylist() {
    const name = newName.trim();
    if (name) onCreatePlaylist?.(name);
    newName = '';
    creating = false;
  }

  function onPlaylistDrop(e: DragEvent, playlistId: string) {
    e.preventDefault();
    dropTargetId = null;
    const trackId = e.dataTransfer?.getData('application/x-booth-track');
    if (trackId) onAddTrackToPlaylist?.(playlistId, trackId);
  }
```

Add the new section in the template, immediately after the `Library` section's closing `</div>` (so order is Library → Playlists → Sources → Add):

```svelte
  <div class="section">
    <div class="label">Playlists</div>
    {#each playlists as p (p.id)}
      <button
        class="item"
        class:active={isActive('playlist', p.id)}
        class:drop-target={dropTargetId === p.id}
        onclick={() => onSelect?.({ section: 'playlist', item: p.id })}
        ondragover={(e) => { e.preventDefault(); dropTargetId = p.id; }}
        ondragleave={() => { if (dropTargetId === p.id) dropTargetId = null; }}
        ondrop={(e) => onPlaylistDrop(e, p.id)}
      >
        <span>{p.name}</span>
        <span class="count">{p.trackCount.toLocaleString()}</span>
      </button>
    {/each}
    {#if creating}
      <!-- svelte-ignore a11y_autofocus -->
      <input
        class="new-playlist"
        bind:value={newName}
        placeholder="Playlist name…"
        autofocus
        onkeydown={(e) => {
          if (e.key === 'Enter') submitNewPlaylist();
          else if (e.key === 'Escape') { e.stopPropagation(); newName = ''; creating = false; }
        }}
        onblur={submitNewPlaylist}
      />
    {:else}
      <button class="new-btn" onclick={() => (creating = true)}>＋ New playlist</button>
    {/if}
  </div>
```

Add these styles inside the `<style>` block:

```css
  .item.drop-target {
    background: var(--accent-bg);
    border-left-color: var(--accent);
  }
  .new-btn {
    background: transparent;
    border: 0;
    padding: 5px 16px;
    color: var(--text-subtle);
    cursor: pointer;
    font-family: inherit;
    font-size: 12px;
    width: 100%;
    text-align: left;
  }
  .new-btn:hover { color: var(--text); background: var(--bg-row-hover); }
  .new-playlist {
    margin: 2px 12px;
    width: calc(100% - 24px);
    background: var(--bg-raised);
    border: 1px solid var(--border-strong);
    border-radius: 3px;
    padding: 4px 6px;
    color: var(--text);
    font-family: inherit;
    font-size: 12px;
  }
```

- [ ] **Step 3: Wire the Rail + playlist loading in Explorer**

In `src/lib/components/Explorer.svelte`:

(a) Import the store and component near the other imports:
```ts
  import { playlists } from '$lib/stores/playlists.svelte';
  import PlaylistView from './PlaylistView.svelte';
```
(`PlaylistView` is created in Task 6; this import will not type-check until then — that's why this whole task's `bun check` runs after Task 6. To keep Task 5 independently committable, temporarily route `playlist` nav to an `EmptyState` placeholder instead of `PlaylistView`, as shown in step (d).)

(b) Add a derived flag near the other `$derived` flags (e.g. after `isSourcesView`):
```ts
  const isPlaylistView = $derived(explorerState.nav.section === 'playlist');
```

(c) Guard `loadList` so it never fires library fetches for the playlist section. At the very top of `loadList`, after the `if (!reset && listLoading) return;` line, add:
```ts
    if (explorerState.nav.section === 'playlist') return;
```

(d) Load the open playlist when nav targets one. Add this effect after the existing "Reload detail when id changes" effect:
```ts
  // Load the open playlist when a playlist rail item is selected (or switched).
  $effect(() => {
    if (explorerState.nav.section !== 'playlist') return;
    const id = explorerState.nav.item;
    untrack(() => playlists.loadPlaylist(id));
  });
```

(e) Load the playlist list on mount. In the `onMount` Promise.all, add `playlists.loadList()`:
```ts
    await Promise.all([loadSourcesAndCounts(), collection.load(), playlists.loadList()]);
```

(f) Pass new props to `<Rail>`:
```svelte
  <Rail
    nav={explorerState.nav}
    entity={currentEntity}
    {sources}
    {counts}
    playlists={playlists.items}
    onSelect={(nav) => explorerState.setNav(nav)}
    onCreatePlaylist={async (name) => {
      const created = await playlists.create(name);
      if (created) explorerState.setNav({ section: 'playlist', item: created.id });
    }}
    onAddTrackToPlaylist={async (playlistId, trackId) => {
      const { added } = await playlists.addTrack(playlistId, trackId);
      const name = playlists.items.find((p) => p.id === playlistId)?.name ?? 'playlist';
      toast.show(added ? `Added to ${name}` : 'Already in playlist');
    }}
  />
```

(g) Branch the middle pane. Wrap the existing `<ListviewToolbar ... />` + scanner + lists + `<SessionLog>` block so it only renders when NOT in a playlist view, and render the playlist view otherwise. Replace the opening of the `<section class="middle">` content:

```svelte
  <section class="middle">
    {#if isPlaylistView}
      <PlaylistView
        selectedId={explorerState.id}
        onTrackSelect={(id) => explorerState.setEntity(id)}
        onDeleted={() => explorerState.setNav({ section: 'library', item: 'all' })}
      />
    {:else}
      <ListviewToolbar ... />   <!-- existing toolbar, unchanged -->
      ... existing scanner overlay, list branches, SessionLog ...
    {/if}
  </section>
```

For Task 5's standalone commit, temporarily use this placeholder in place of `<PlaylistView .../>`:
```svelte
      <EmptyState title="Playlist view coming up" detail="Implemented in the next task." />
```
and omit the `PlaylistView` import. Task 6 swaps in the real component.

(h) Add a right-pane empty-state branch for playlist view with nothing selected. In the `<section class="right">` `{#if ...}` chain, add as the first branch:
```svelte
    {#if isPlaylistView && !explorerState.id}
      <EmptyState title="Select a track to see details" />
    {:else if !explorerState.id && isSourcesView && selectedSource}
```
(prepend `isPlaylistView && !explorerState.id` as a new leading branch; the rest of the chain is unchanged).

- [ ] **Step 4: Type-check**

Run: `bun check`
Expected: no errors (with the Task-5 placeholder in place).

- [ ] **Step 5: Manual check**

Run `bun dev`, open the app. Confirm: a **Playlists** section appears in the rail; **＋ New playlist** reveals an input; typing a name + Enter creates a playlist, selects it, and shows the placeholder empty-state; the new playlist persists across reload; `[`/`]` and arrow rail-nav move onto playlist items. Stop `bun dev`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/stores/explorerState.svelte.ts src/lib/components/Rail.svelte src/lib/components/Explorer.svelte
git commit -m "feat(playlists): rail section, playlist nav namespace, create + load wiring"
```

---

## Task 6: PlaylistView component

**Files:**
- Create: `src/lib/components/PlaylistView.svelte`
- Modify: `src/lib/components/Explorer.svelte` (swap placeholder for the real component)

- [ ] **Step 1: Write `PlaylistView.svelte`**

Create `src/lib/components/PlaylistView.svelte`. It reads `playlists.openPlaylist`, renders a header (rename + delete-with-inline-confirm + count) and a track list whose rows mirror the existing `.body button.row-btn[data-id]` shape (so global arrow-nav, `a`, and `Delete` work), with per-row remove (`×`), double-click play, and HTML5 drag-to-reorder.

```svelte
<script lang="ts">
  import { playlists } from '$lib/stores/playlists.svelte';
  import { player } from '$lib/stores/player.svelte';
  import EmptyState from './EmptyState.svelte';

  let {
    selectedId = null,
    onTrackSelect,
    onDeleted,
  }: {
    selectedId?: string | null;
    onTrackSelect?: (id: string) => void;
    onDeleted?: () => void;
  } = $props();

  const open = $derived(playlists.openPlaylist);

  let renaming = $state(false);
  let nameDraft = $state('');
  let confirmingDelete = $state(false);
  let dragId = $state<string | null>(null);
  let overId = $state<string | null>(null);

  function startRename() {
    if (!open) return;
    nameDraft = open.name;
    renaming = true;
  }
  function commitRename() {
    if (open && nameDraft.trim()) playlists.rename(open.id, nameDraft.trim());
    renaming = false;
  }

  async function confirmDelete() {
    if (!open) return;
    await playlists.remove(open.id);
    confirmingDelete = false;
    onDeleted?.();
  }

  function formatDuration(ms: number | null): string {
    if (!ms) return '—';
    const s = Math.round(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  function onDragStart(e: DragEvent, trackId: string) {
    dragId = trackId;
    e.dataTransfer?.setData('application/x-booth-track', trackId);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  }

  function onDrop(e: DragEvent, targetId: string) {
    e.preventDefault();
    overId = null;
    const moved = e.dataTransfer?.getData('application/x-booth-track') || dragId;
    dragId = null;
    if (!open || !moved || moved === targetId) return;
    const ids = open.tracks.map((t) => t.id);
    if (!ids.includes(moved)) return; // dragged in from elsewhere — ignore (add happens via rail)
    const without = ids.filter((id) => id !== moved);
    const at = without.indexOf(targetId);
    without.splice(at, 0, moved);
    playlists.reorder(open.id, without);
  }
</script>

{#if !open}
  <EmptyState title="Loading…" />
{:else}
  <div class="pl-toolbar">
    {#if renaming}
      <!-- svelte-ignore a11y_autofocus -->
      <input
        class="name-input"
        bind:value={nameDraft}
        autofocus
        onkeydown={(e) => {
          if (e.key === 'Enter') commitRename();
          else if (e.key === 'Escape') { e.stopPropagation(); renaming = false; }
        }}
        onblur={commitRename}
      />
    {:else}
      <button class="name" onclick={startRename} title="Rename">{open.name}</button>
    {/if}
    <span class="meta">{open.tracks.length} {open.tracks.length === 1 ? 'track' : 'tracks'}</span>
    {#if confirmingDelete}
      <span class="confirm">
        Delete playlist?
        <button class="danger" onclick={confirmDelete}>Delete</button>
        <button class="ghost" onclick={() => (confirmingDelete = false)}>Cancel</button>
      </span>
    {:else}
      <button class="del" title="Delete playlist" onclick={() => (confirmingDelete = true)}>🗑</button>
    {/if}
  </div>

  <div class="listview">
    <div class="body">
      {#if open.tracks.length === 0}
        <EmptyState title="No tracks yet" detail="Drag tracks here, or press a on a track to add it." />
      {:else}
        {#each open.tracks as t (t.id)}
          {@const isPlaying = player.nowPlaying?.trackId === t.id}
          <button
            class="row-btn"
            class:selected={t.id === selectedId}
            class:playing={isPlaying}
            class:drop-over={overId === t.id}
            data-id={t.id}
            type="button"
            draggable="true"
            ondragstart={(e) => onDragStart(e, t.id)}
            ondragover={(e) => { e.preventDefault(); overId = t.id; }}
            ondragleave={() => { if (overId === t.id) overId = null; }}
            ondrop={(e) => onDrop(e, t.id)}
            onclick={(e) => { if (e.detail > 0) e.stopPropagation(); else onTrackSelect?.(t.id); }}
            ondblclick={() => { if (t.canPlay) player.play({ trackId: t.id, title: t.title, artist: t.artist, thumbUrl: t.thumb_url }); }}
          >
            <span class="row">
              <span class="info-icon" class:playing={isPlaying}>{isPlaying ? '▶' : '⠿'}</span>
              <span class="meta-cell">
                <span class="title" class:dim={!t.canPlay}>{t.title}</span>
                <span class="artist">{t.artist}</span>
              </span>
              <span class="dur">{formatDuration(t.duration_ms)}</span>
              <span
                class="remove"
                role="button"
                tabindex="-1"
                aria-label="Remove {t.title}"
                onclick={(e) => { e.stopPropagation(); if (open) playlists.removeTrack(open.id, t.id); }}
                ondblclick={(e) => e.stopPropagation()}
              >×</span>
            </span>
          </button>
        {/each}
      {/if}
    </div>
  </div>
{/if}

<style>
  .pl-toolbar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .name {
    background: transparent; border: 0; color: var(--text);
    font-family: inherit; font-size: 14px; font-weight: 600;
    cursor: pointer; padding: 0;
  }
  .name:hover { color: var(--accent); }
  .name-input {
    background: var(--bg-raised); border: 1px solid var(--border-strong);
    border-radius: 3px; padding: 3px 6px; color: var(--text);
    font-family: inherit; font-size: 14px; font-weight: 600;
  }
  .meta { color: var(--text-subtle); font-size: 11px; font-variant-numeric: tabular-nums; }
  .del {
    margin-left: auto; background: transparent; border: 0;
    color: var(--text-subtle); cursor: pointer; font-size: 13px;
  }
  .del:hover { color: var(--danger); }
  .confirm { margin-left: auto; display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-muted); }
  .confirm .danger { background: var(--danger); border: 0; color: #fff; border-radius: 3px; padding: 3px 8px; cursor: pointer; font-family: inherit; font-size: 11px; }
  .confirm .ghost { background: transparent; border: 1px solid var(--border-strong); color: var(--text-muted); border-radius: 3px; padding: 3px 8px; cursor: pointer; font-family: inherit; font-size: 11px; }

  .listview { display: flex; flex-direction: column; flex: 1; overflow: hidden; }
  .body { flex: 1; overflow-y: auto; }
  .row-btn {
    display: block; width: 100%; background: transparent; border: 0;
    padding: 0; text-align: left; cursor: pointer; color: inherit; font: inherit;
  }
  .row-btn + .row-btn { border-top: 1px solid rgba(255, 255, 255, 0.025); }
  .row-btn:hover { background: var(--bg-row-hover); }
  .row-btn.selected { background: var(--accent-bg); }
  .row-btn.drop-over { box-shadow: inset 0 2px 0 var(--accent); }
  .row {
    display: grid;
    grid-template-columns: 20px 1fr 60px 20px;
    gap: 14px; padding: 7px 14px; align-items: center;
  }
  .info-icon { color: var(--text-subtle); font-size: 12px; text-align: center; cursor: grab; user-select: none; }
  .info-icon.playing { color: var(--accent); }
  .meta-cell { min-width: 0; }
  .title { color: var(--text); font-weight: 500; font-size: 13px; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .title.dim { color: var(--text-muted); }
  .artist { color: var(--text-muted); font-size: 12px; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row-btn.playing .title { color: var(--accent); }
  .dur { color: var(--text-subtle); font-variant-numeric: tabular-nums; font-family: var(--font-mono); font-size: 11.5px; text-align: right; }
  .remove { color: transparent; text-align: center; cursor: pointer; font-size: 14px; user-select: none; }
  .row-btn:hover .remove { color: var(--text-subtle); }
  .remove:hover { color: var(--danger) !important; }
</style>
```

- [ ] **Step 2: Swap the Explorer placeholder for the real component**

In `src/lib/components/Explorer.svelte`, ensure the import added in Task 5(a) is active:
```ts
  import PlaylistView from './PlaylistView.svelte';
```
and replace the Task-5 placeholder `<EmptyState title="Playlist view coming up" .../>` inside the `{#if isPlaylistView}` branch with the real component:
```svelte
      <PlaylistView
        selectedId={explorerState.id}
        onTrackSelect={(id) => explorerState.setEntity(id)}
        onDeleted={() => explorerState.setNav({ section: 'library', item: 'all' })}
      />
```

- [ ] **Step 3: Type-check**

Run: `bun check`
Expected: no errors.

- [ ] **Step 4: Manual check**

Run `bun dev`. Create a playlist, open it. With the playlist empty you see the "No tracks yet" hint. (You can't add tracks via UI until Task 7; for now seed one via curl: `curl -s -X POST localhost:5173/api/playlists/<id>/tracks -H 'content-type: application/json' -d '{"trackId":"<a-real-track-ulid>"}'`, then reopen the playlist.) Confirm: track row renders; double-click plays a playable track; `×` removes it; the name is editable (click → type → Enter); the 🗑 delete shows an inline confirm, and confirming returns you to Library. Stop `bun dev`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/components/PlaylistView.svelte src/lib/components/Explorer.svelte
git commit -m "feat(playlists): PlaylistView with rename, delete-confirm, remove, drag-reorder"
```

---

## Task 7: Drag-to-add from track lists

**Files:**
- Modify: `src/lib/components/Listview.svelte`
- Modify: `src/lib/components/TrackList.svelte`
- Modify: `src/lib/components/ReleaseDetail.svelte`

- [ ] **Step 1: Add `data-id` to generic Listview rows**

In `src/lib/components/Listview.svelte`, add `data-id={item.id}` to the row button so global keyboard actions can read the focused entity id. Change:
```svelte
        <button
          class="row-btn"
          class:selected={item.id === selectedId}
          onclick={() => onSelect?.(item.id)}
          type="button"
        >
```
to:
```svelte
        <button
          class="row-btn"
          class:selected={item.id === selectedId}
          data-id={item.id}
          onclick={() => onSelect?.(item.id)}
          type="button"
        >
```

- [ ] **Step 2: Make TrackList rows draggable**

In `src/lib/components/TrackList.svelte`, add `draggable` + `ondragstart` to the inner `.row` div. Change the opening of the `<div class="row" ...>` (inside the `{#snippet row(item)}`) to add the two attributes:
```svelte
    <div
      class="row"
      class:playing={isPlaying}
      role="listitem"
      draggable="true"
      ondragstart={(e) => { e.dataTransfer?.setData('application/x-booth-track', item.id); if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy'; }}
      onkeydown={(e) => { if (e.key === 'Enter' && item.canPlay) player.play({ trackId: item.id, title: item.title, artist: item.artist, thumbUrl: item.thumb_url }); }}
      onclick={(e) => { if (e.detail > 0) e.stopPropagation(); }}
      ondblclick={() => { if (item.canPlay) player.play({ trackId: item.id, title: item.title, artist: item.artist, thumbUrl: item.thumb_url }); }}
    >
```

- [ ] **Step 3: Make ReleaseDetail tracklist rows draggable**

In `src/lib/components/ReleaseDetail.svelte`, add `draggable` + `ondragstart` to the `<button class="track-row" ...>`:
```svelte
        <button
          class="track-row"
          class:playing={isPlaying}
          type="button"
          draggable="true"
          ondragstart={(e) => { e.dataTransfer?.setData('application/x-booth-track', t.id); if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy'; }}
          onclick={(e) => { if (e.detail > 0) e.stopPropagation(); else onTrackSelect?.(t.id); }}
          ondblclick={() => { if (t.canPlay) player.play({ trackId: t.id, title: t.title, artist: release.artist, thumbUrl: release.thumb_url }); }}
        >
```

- [ ] **Step 4: Type-check**

Run: `bun check`
Expected: no errors.

- [ ] **Step 5: Manual check**

Run `bun dev`. Switch the lens to Tracks (Tab). Drag a track row onto a playlist in the rail — the playlist highlights on hover, and on drop a toast confirms "Added to <name>". Open that playlist to confirm the track is present. Drag the same track again → "Already in playlist". Open a release with tracks and drag a row from its tracklist onto a playlist — same behavior. Stop `bun dev`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/components/Listview.svelte src/lib/components/TrackList.svelte src/lib/components/ReleaseDetail.svelte
git commit -m "feat(playlists): drag tracks onto rail playlists to add"
```

---

## Task 8: Keyboard add + remove + PlaylistPicker

**Files:**
- Modify: `src/lib/keyboard.svelte.ts`
- Create: `src/lib/components/PlaylistPicker.svelte`
- Modify: `src/routes/+page.svelte`

- [ ] **Step 1: Add the two keyboard actions to the dispatcher**

In `src/lib/keyboard.svelte.ts`, extend `KeyboardActions`:
```ts
export interface KeyboardActions {
  focusSearch: () => void;
  openScanner: () => void;
  moveDown: () => void;
  moveUp: () => void;
  commit: () => void;
  cancel: () => void;
  undoLast: () => void;
  toggleEntity: () => void;
  toggleShortcuts: () => void;
  navRailNext: () => void;
  navRailPrev: () => void;
  togglePlay: () => void;
  addToPlaylist: () => void;
  removeFromPlaylist: () => void;
}
```

Add the two handlers in the non-editable single-key section (after the existing `u`/`U` handler, before `?`):
```ts
    if (e.key === 'a' || e.key === 'A')                     { e.preventDefault(); actions.addToPlaylist();      return; }
    if (e.key === 'Delete' || e.key === 'Backspace')        { e.preventDefault(); actions.removeFromPlaylist(); return; }
```

- [ ] **Step 2: Write the PlaylistPicker overlay**

Create `src/lib/components/PlaylistPicker.svelte`. It filters playlists, supports ↑/↓/Enter/Esc, and has a "＋ New playlist…" create-and-add row. It stops propagation on the keys it handles so the global `Escape`/arrow handlers don't also fire.

```svelte
<script lang="ts">
  import { playlists } from '$lib/stores/playlists.svelte';
  import { toast } from '$lib/stores/toast.svelte';

  let {
    trackId,
    onClose,
  }: {
    trackId: string;
    onClose: () => void;
  } = $props();

  let filter = $state('');
  let highlight = $state(0);

  const matches = $derived(
    playlists.items.filter((p) => p.name.toLowerCase().includes(filter.trim().toLowerCase())),
  );
  // Row 0 is always the "create" row; playlist rows follow.
  const rowCount = $derived(matches.length + 1);

  async function addTo(playlistId: string, name: string) {
    const { added } = await playlists.addTrack(playlistId, trackId);
    toast.show(added ? `Added to ${name}` : 'Already in playlist');
    onClose();
  }

  async function createAndAdd() {
    const name = filter.trim() || 'New playlist';
    const created = await playlists.create(name);
    if (created) {
      await playlists.addTrack(created.id, trackId);
      toast.show(`Added to ${created.name}`);
    }
    onClose();
  }

  function choose(index: number) {
    if (index === 0) createAndAdd();
    else {
      const p = matches[index - 1];
      if (p) addTo(p.id, p.name);
    }
  }

  function onKey(e: KeyboardEvent) {
    e.stopPropagation(); // keep the global dispatcher out of the picker
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); highlight = (highlight + 1) % rowCount; }
    else if (e.key === 'ArrowUp') { e.preventDefault(); highlight = (highlight - 1 + rowCount) % rowCount; }
    else if (e.key === 'Enter') { e.preventDefault(); choose(highlight); }
  }
</script>

<div class="backdrop" onclick={onClose} role="presentation">
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="panel" onclick={(e) => e.stopPropagation()} onkeydown={onKey} role="dialog" aria-modal="true" tabindex={-1}>
    <div class="title">Add to playlist</div>
    <!-- svelte-ignore a11y_autofocus -->
    <input
      class="filter"
      bind:value={filter}
      placeholder="Filter or name a new playlist…"
      autofocus
      oninput={() => (highlight = 0)}
    />
    <div class="rows">
      <button class="opt create" class:active={highlight === 0} onclick={() => choose(0)}>
        ＋ New playlist{filter.trim() ? ` “${filter.trim()}”` : '…'}
      </button>
      {#each matches as p, i (p.id)}
        <button class="opt" class:active={highlight === i + 1} onclick={() => choose(i + 1)}>
          <span>{p.name}</span>
          <span class="count">{p.trackCount}</span>
        </button>
      {/each}
    </div>
  </div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; padding: 24px; z-index: 150; }
  .panel { background: var(--bg-raised); border: 1px solid var(--border-strong); border-radius: var(--radius); padding: 14px; min-width: 320px; max-width: 420px; }
  .title { font-size: 12px; color: var(--text-subtle); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 10px; font-weight: 600; }
  .filter { width: 100%; background: var(--bg); border: 1px solid var(--border-strong); border-radius: 4px; padding: 6px 8px; color: var(--text); font-family: inherit; font-size: 13px; margin-bottom: 8px; }
  .rows { max-height: 260px; overflow-y: auto; display: flex; flex-direction: column; gap: 1px; }
  .opt { display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%; text-align: left; background: transparent; border: 0; padding: 7px 8px; color: var(--text); font-family: inherit; font-size: 13px; cursor: pointer; border-radius: 4px; }
  .opt:hover, .opt.active { background: var(--accent-bg); }
  .opt.create { color: var(--text-muted); }
  .opt .count { color: var(--text-subtle); font-size: 11px; font-variant-numeric: tabular-nums; }
</style>
```

- [ ] **Step 3: Wire actions + mount the picker in `+page.svelte`**

In `src/routes/+page.svelte`:

(a) Add imports + state:
```ts
  import PlaylistPicker from '$lib/components/PlaylistPicker.svelte';
  import { playlists } from '$lib/stores/playlists.svelte';
```
```ts
  let pickerOpen = $state(false);
  let pickerTrackId = $state<string | null>(null);
```

(b) Add the two actions inside the `installKeyboard({ ... })` actions object (alongside the others):
```ts
        addToPlaylist: () => {
          const active = document.activeElement;
          if (!(active instanceof HTMLElement) || !active.classList.contains('row-btn')) return;
          const trackId = active.dataset.id;
          if (!trackId) return;
          // Only meaningful for track rows: the tracks lens, or inside a playlist.
          if (explorerState.entity !== 'tracks' && explorerState.nav.section !== 'playlist') return;
          pickerTrackId = trackId;
          pickerOpen = true;
        },
        removeFromPlaylist: () => {
          if (explorerState.nav.section !== 'playlist') return;
          const active = document.activeElement;
          if (!(active instanceof HTMLElement) || !active.classList.contains('row-btn')) return;
          const trackId = active.dataset.id;
          const pid = playlists.openPlaylist?.id;
          if (trackId && pid) playlists.removeTrack(pid, trackId);
        },
```

(c) Mount the picker next to `<ShortcutOverlay>` in the `{:else}` branch:
```svelte
  <Explorer />
  <ShortcutOverlay open={shortcutOpen} onClose={() => (shortcutOpen = false)} />
  {#if pickerOpen && pickerTrackId}
    <PlaylistPicker trackId={pickerTrackId} onClose={() => { pickerOpen = false; pickerTrackId = null; }} />
  {/if}
```

- [ ] **Step 4: Type-check**

Run: `bun check`
Expected: no errors.

- [ ] **Step 5: Manual check**

Run `bun dev`. In Tracks lens, focus a track row with `↓`, press `a` → the picker opens. Type to filter, `↓`/`↑` to move, `Enter` to add → toast confirms and picker closes. Press `a` again, type a brand-new name, choose the **＋ New playlist** row → it creates the playlist, adds the track, and the rail shows it. Open a playlist, focus a row, press `Delete` → the track is removed live. Confirm Esc closes the picker without also clearing the library search. Stop `bun dev`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/keyboard.svelte.ts src/lib/components/PlaylistPicker.svelte src/routes/+page.svelte
git commit -m "feat(playlists): keyboard add (a) via picker + Delete to remove"
```

---

## Task 9: Docs — ShortcutOverlay + CONTEXT.md

**Files:**
- Modify: `src/lib/components/ShortcutOverlay.svelte`
- Modify: `docs/CONTEXT.md`

- [ ] **Step 1: Document the new shortcuts**

In `src/lib/components/ShortcutOverlay.svelte`, add two entries to the `shortcuts` array (after the `u  •  ⌘Z` row):
```ts
    { key: 'a', label: 'Add focused track to a playlist' },
    { key: 'del', label: 'Remove focused track (in a playlist)' },
```

- [ ] **Step 2: Update CONTEXT.md**

Add a **Playlists** subsection under `## Feature inventory` in `docs/CONTEXT.md`:

```markdown
### Playlists
- **Booth-native organizational layer over the unified `track` table** — not a source. `playlist` + `playlist_track` tables (migration `007`); a track appears at most once per playlist (`PRIMARY KEY (playlist_id, track_id)`), `ON DELETE CASCADE` on both FKs. Playlists never touch `source_link`/`match_key`/`source_facets`.
- **Rail Playlists section** (after Library): lists playlists (name + track count) with a ＋ New playlist inline input. Selecting one sets `?nav=playlist:<id>`. Items are drop targets for drag-to-add.
- **`PlaylistView`** (middle pane) renders the open playlist's tracks (rows mirror the `.body button.row-btn[data-id]` shape so arrow-nav / `a` / `Delete` work), with inline rename, delete-with-confirm, per-row `×` remove, double-click play (single-track — no queue), and HTML5 drag-to-reorder. Non-playable tracks render dimmed.
- **Add paths**: drag a track row (`TrackList` or `ReleaseDetail` tracklist) onto a rail playlist (`application/x-booth-track` dataTransfer), or focus a track row and press `a` to open `PlaylistPicker` (filter + create-and-add). Dedupe surfaces an "Already in playlist" toast.
- **Server**: `library/playlists.ts` (list/create/rename/delete/getPlaylist/addTrack/removeTrack/reorderTracks; `getPlaylist` reuses `queries.getTracksByIds` so `canPlay` matches the rest of the app). Routes: `GET|POST /api/playlists`, `GET|PATCH|DELETE /api/playlists/[id]`, `POST|PATCH /api/playlists/[id]/tracks`, `DELETE /api/playlists/[id]/tracks/[trackId]`.
- **Client store** `stores/playlists.svelte.ts` mirrors `items` (rail) + `openPlaylist` (current view); mutations update both. Reorder is optimistic.
- **Known limitation**: membership keys on track ULID — if a Discogs re-sync ever deletes+recreates a track row, the cascade drops it from playlists (local/vinyl ids are stable). No queue/auto-advance yet (fast-follow). Spec/plan: `docs/superpowers/specs/2026-06-13-playlists-design.md`, `docs/superpowers/plans/2026-06-14-playlists.md`.
```

Add to the migrations list in the file map:
```markdown
          007_playlists.sql                       playlist + playlist_track tables (Booth-native; not a source)
```

Add the new nav namespace to the URL-state section, alongside the other `?nav` values:
```markdown
  - `?nav=playlist:<id>` — a playlist rail item; middle pane shows `PlaylistView`.
```

- [ ] **Step 3: Type-check + full verify pass**

Run: `bun check && bun verify scripts/verify-playlists.ts`
Expected: no type errors; `PASS: playlists …`.

- [ ] **Step 4: Commit**

```bash
git add src/lib/components/ShortcutOverlay.svelte docs/CONTEXT.md
git commit -m "docs(playlists): shortcut overlay entries + CONTEXT.md feature section"
```

---

## Self-review checklist (completed during authoring)

- **Spec coverage:** data model (T1) · server module + dedupe/reorder/cascade (T2) · CRUD + track APIs (T3) · client store (T4) · rail section + nav namespace + create (T5) · playlist view with rename/delete/remove/reorder (T6) · drag-to-add (T7) · keyboard add + remove + picker (T8) · non-playable dimming (T6) · CONTEXT update + future-directions reference (T9). All spec sections map to a task.
- **Type consistency:** `addTrack` returns `{ added }` everywhere (module, route, store); `reorderTracks(db, playlistId, orderedTrackIds)` signature matches its route + store callers; `getTracksByIds` returns a `Map`, consumed by `getPlaylist`; the dataTransfer mime `application/x-booth-track` is identical across `TrackList`, `ReleaseDetail`, `PlaylistView`, and the Rail drop handler; `playlists.openPlaylist` is the single reactive source read by `PlaylistView` and both keyboard actions.
- **No placeholders:** every code step is complete. The only intentional staging is Task 5's temporary `EmptyState` stand-in for `PlaylistView`, explicitly swapped in Task 6.
```
