# booth — multi-source architecture (Slice 1) design

> **Status:** Draft for review · 2026-05-05
> **Successor to:** `2026-04-29-discogs-collection-adder-design.md`
> **Scope:** Replace booth's hardcoded-Discogs data layer with a generic source-adapter architecture backed by local SQLite, with two adapters wired up (Discogs, Apple Music.app) and two stubbed (Rekordbox, Plex). Headless — no new UI surface.

## 1. Goals & Scope

### Goal

Booth currently treats Discogs as the only "source of truth" and stores collection-membership in an in-memory cache. The endgame is an iTunes-style library explorer that unifies multiple music sources (Apple Music.app local library, Discogs collection, Rekordbox-analyzed tracks, Plex-streamable files, eventually Bandcamp / YouTube). Slice 1 lays the foundation: a generic source-adapter contract, a persistent collated store, and the two most foundational sources (Discogs + Apple Music.app) ported onto it. The existing add-record UX must keep working unchanged from the user's perspective.

### Naming note

In conversation, "iTunes" is shorthand for the modern macOS **Apple Music.app** library (the successor to legacy iTunes). Throughout this spec and the resulting code, the adapter `id` is the short-and-stable string `itunes`, but display strings, comments, and docs say "Apple Music.app" so future contributors aren't misled.

### In scope (Slice 1)

- Source-adapter contract (`MusicSource` + capability mixins like `CollectionWritable`).
- Source registry (a single statically-populated module that knows which sources exist).
- SQLite persistence layer (`./.booth/booth.db`) with hand-rolled migrations.
- Core entities (`Track`, `Release`) as separate tables with a `source_link` table unifying them across sources.
- Source-facet storage (`source_facets` table) for source-specific data (iTunes ratings/playlists, Rekordbox BPM/key, Plex stream URL, Discogs catno, etc.).
- Deterministic collation only:
  - Local-to-local matching by absolute file path.
  - Local-to-Discogs release matching by normalized `artist + album + year`.
- Discogs adapter conforming to the new contract; existing endpoints rewired; `collection-cache.ts` deleted.
- Apple Music.app adapter (reads `Library.xml`, contributes tracks + emergent releases).
- Rekordbox + Plex adapter stubs (interface-only, `sync()` throws `NotImplementedError`).
- Manual `POST /api/sources/:id/sync` endpoint per adapter; full re-pull each time.
- Auto-trigger Discogs sync on app boot iff the DB has zero Discogs source-links (preserves today's "it just works" feel).
- Inspection endpoints for verification (`GET /api/library/tracks`, `GET /api/library/releases`, `GET /api/library/membership`).

### Explicitly out of scope (Slice 2+)

These items are deferred but **must be carried forward** in the implementation plan's "Future work" section so they aren't lost:

- Library explorer UI (Slice 2).
- Fuzzy/scored matching (deterministic-only in Slice 1).
- Track-level Discogs matching (release-level only in Slice 1).
- Incremental sync, background sync, file-watching.
- Auto-sync on every boot (Slice 1 does it once, only if Discogs DB is empty).
- Artist as a first-class entity (string field for now).
- Booth owning its own ratings/play counts (still a read-only mirror in Slice 1).
- Rekordbox `sync()` implementation (stub only in Slice 1).
- Plex `sync()` implementation (stub only in Slice 1).
- Auth / multi-user (booth stays single-user, dev-only).
- Phone/LAN access (still localhost-only).
- Sync-run logging table.
- Promoting `catno` to a release match-key.

### Operational defaults

- **DB path:** `./.booth/booth.db`. Project-local, gitignored. Move to `~/.booth/` later if booth ever leaves dev-only.
- **Apple Music.app library path:** `ITUNES_XML_PATH` in `.env`. No auto-detect. `.env.example` documents both legacy and modern locations (`~/Music/iTunes/iTunes Music Library.xml` for older setups, `~/Music/Music/Music Library.musiclibrary/Library.xml` for newer Music.app).
- **Verification surface:** inspection endpoints + the existing add-record flow continuing to work end-to-end. No CLI, no admin dashboard.

## 2. Architecture & module layout

```
src/lib/server/
  db/
    index.ts               singleton better-sqlite3 connection; reads path from env
    migrate.ts             reads migrations/*.sql, applies in order, tracks in _migrations
    migrations/
      001_init.sql          core tables (release, track, source_link, source_facets, match_key, _migrations)
  sources/
    types.ts               MusicSource, CollectionWritable, SourceTrack, SourceRelease, SyncResult
    registry.ts            statically-populated list of sources; getSource(id), listSources()
    discogs/
      index.ts             the adapter (MusicSource & CollectionWritable)
      sync.ts              full collection re-pull → SyncResult
      api.ts               (the existing discogs.ts moved/renamed; HTTP client + DiscogsError)
      username.ts          (unchanged, moved here)
    itunes/
      index.ts             adapter (MusicSource)
      sync.ts              parses Library.xml → SyncResult
      parse.ts             plist/XML → typed iTunes records
    rekordbox/
      index.ts             stub: id, name, contributes, sync() throws NotImplemented
    plex/
      index.ts             stub
  library/
    collate.ts             post-sync step: maps SyncResult rows → entity + source_link upserts using deterministic match rules
    queries.ts             generic reads (getTrack, getRelease, getMembership, search-by-source-link)

src/routes/api/
  sources/
    [id]/sync/+server.ts                POST → registry.get(id).sync() → collate → return summary
  library/
    tracks/+server.ts                   GET ?source=&limit=  inspection
    releases/+server.ts                 GET ?source=&limit=  inspection
    membership/+server.ts               GET ?source=discogs  → set of external_ids (replaces old collection/ids)
  discogs/
    search/+server.ts                   unchanged behavior (live API); now uses sources/discogs/api.ts under the hood
    collection/
      add/+server.ts                    delegates to discogsSource.addToCollection() + writes through to DB
      remove/+server.ts                 same shape
      ids/+server.ts                    DELETED (replaced by /api/library/membership)
```

### Why these boundaries

- **`db/`** owns the connection and migrations. Nothing else opens SQLite directly.
- **`sources/<id>/`** is self-contained per adapter. Each adapter's HTTP client / parser / sync logic is co-located. Adding Bandcamp later is one new directory under `sources/`.
- **`sources/registry.ts`** is the single seam between adapters and the rest of the app. Routes never import an adapter directly; they go through `registry.get(id)`. This is what makes adapters swappable.
- **`library/`** owns generic read/write logic against the unified store. The `collate.ts` module is where matching rules live — one place to change them, easy to upgrade to fuzzy later.
- **Capability checks at the route layer**: `add/+server.ts` does `if (!('addToCollection' in source)) throw 405` — keeps adapter-specific assumptions out of generic code.

### Migration of existing code

- `src/lib/server/discogs.ts` → `src/lib/server/sources/discogs/api.ts`. File rename + import-path updates only; no logic change.
- `src/lib/server/username.ts` → `src/lib/server/sources/discogs/username.ts`.
- `src/lib/server/collection-cache.ts` → **deleted**. Its responsibilities split:
  - Read (membership lookup) → `library/queries.ts` + `/api/library/membership`.
  - Write (markAdded/markRemoved) → directly inside `discogsSource.addToCollection`/`removeFromCollection`, which write through to the `source_link` table.
- `src/lib/stores/collection.svelte.ts` (client) → switches its fetch URL from `/api/discogs/collection/ids` to `/api/library/membership?source=discogs`. The store's `Set<string>` shape (Discogs release-id strings) is preserved so `ResultRow.svelte` doesn't change.

## 3. Data model

ULIDs (`Crockford base32`, 26 chars, time-prefixed, K-sortable) for entity IDs. Generated in code; no SQLite extension required.

### `migrations/001_init.sql`

```sql
CREATE TABLE _migrations (
  id          TEXT PRIMARY KEY,
  applied_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Core entities ---------------------------------------------------

CREATE TABLE release (
  id          TEXT PRIMARY KEY,    -- ULID
  title       TEXT NOT NULL,
  artist      TEXT NOT NULL,       -- string for now (Slice 1)
  year        INTEGER,             -- nullable
  country     TEXT,
  label       TEXT,
  catno       TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE track (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  artist       TEXT NOT NULL,
  album        TEXT,                -- denormalized; release_id is the real link
  duration_ms  INTEGER,
  release_id   TEXT REFERENCES release(id) ON DELETE SET NULL,
  position     TEXT,                -- e.g. "A1", "3"; null if standalone
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Source links (entity ↔ source-specific id) ---------------------

CREATE TABLE source_link (
  entity_kind   TEXT NOT NULL CHECK (entity_kind IN ('track','release')),
  entity_id     TEXT NOT NULL,
  source        TEXT NOT NULL,       -- 'discogs' | 'itunes' | …
  external_id   TEXT NOT NULL,       -- whatever the source calls it
  external_url  TEXT,                -- optional, for "open in source" links
  match_method  TEXT NOT NULL,       -- 'file_path' | 'artist_album_year' | 'external_id_carryover' | 'first_seen'
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (entity_kind, source, external_id),
  UNIQUE      (entity_kind, entity_id, source)   -- one source contributes ≤1 link per entity
);
CREATE INDEX idx_source_link_entity ON source_link(entity_kind, entity_id);

-- Per-source facet data -------------------------------------------

CREATE TABLE source_facets (
  entity_kind  TEXT NOT NULL CHECK (entity_kind IN ('track','release')),
  entity_id    TEXT NOT NULL,
  source       TEXT NOT NULL,
  key          TEXT NOT NULL,         -- 'rating', 'playCount', 'bpm', 'streamUrl', …
  value        TEXT NOT NULL,         -- JSON-encoded
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (entity_kind, entity_id, source, key)
);

-- Match-key lookup (used by collate.ts) ---------------------------

CREATE TABLE match_key (
  entity_kind  TEXT NOT NULL CHECK (entity_kind IN ('track','release')),
  entity_id    TEXT NOT NULL,
  key_type     TEXT NOT NULL,         -- 'file_path' | 'artist_album_year'
  key_value    TEXT NOT NULL,         -- pre-normalized value
  PRIMARY KEY (entity_kind, key_type, key_value),
  UNIQUE      (entity_kind, entity_id, key_type)
);
CREATE INDEX idx_match_key_entity ON match_key(entity_kind, entity_id);
```

### Notes

- **No artist table.** Artist is a string column on track + release. Promoting to a real table is a future migration.
- **`release.artist` and `track.artist` are duplicated** intentionally — a track's display artist may differ from its release's (compilations, features). Cheap.
- **Track→release is a single nullable FK**, not many-to-many. A track on multiple pressings of the same album → multiple track rows, one per release. Simpler than modeling pressings as variants of one canonical track. Revisit if the explorer pages ever need canonical-track grouping.
- **`source_facets.value` is JSON** — keeps the "list of playlists", "rekordbox cue points blob", etc. flexible. Querying `value` will use SQLite's `json_extract` when needed.
- **`match_key` is a separate table**, not columns on entity. Makes collation a single indexed lookup, and lets one entity have multiple match keys (e.g. a release matched by both `artist_album_year` and a future `catno` key type).
- **`match_method` lives on `source_link`**, not `match_key` — it records *how this particular link was made*, separately from the keys themselves.
- **No `entity` parent table.** Two separate root tables keeps SQL straightforward; the `entity_kind` discriminator on `source_link`/`source_facets`/`match_key` does the unification work.
- **`updated_at` on entities** is bumped during sync so we can spot stale rows, but the diff logic in collate decides what to remove (we don't auto-delete on absence).

### Worked example: one track, four sources

A single Daft Punk "Around the World" track ends up represented as:

```
track(id=01HXAB..., title="Around the World", artist="Daft Punk", release_id=01HXBC...)

source_link rows (one per source):
  (track, 01HXAB..., itunes,    12345,   match_method='file_path')
  (track, 01HXAB..., rekordbox, 67890,   match_method='file_path')
  (track, 01HXAB..., plex,      11111,   match_method='file_path')
  (track, 01HXAB..., discogs,   12721:1, match_method='artist_album_year')

source_facets rows:
  (track, 01HXAB..., itunes,    rating,    "5")
  (track, 01HXAB..., itunes,    playCount, "47")
  (track, 01HXAB..., rekordbox, bpm,       "121")
  (track, 01HXAB..., rekordbox, key,       "Am")
  (track, 01HXAB..., plex,      streamUrl, "\"https://plex.local/...\"")
```

The unique constraint `(entity_kind, entity_id, source)` enforces one source ≤ one link per entity.

## 4. Adapter contract & registry

```ts
// src/lib/server/sources/types.ts

export type EntityKind = 'track' | 'release';

export interface SourceTrack {
  externalId: string;
  title: string;
  artist: string;
  album?: string;
  durationMs?: number;
  position?: string;
  filePath?: string;                  // when present, drives file_path match key
  releaseExternalId?: string;         // links this track to a release the same source contributed
  facets?: Record<string, unknown>;   // namespaced under this source automatically
  externalUrl?: string;
}

export interface SourceRelease {
  externalId: string;
  title: string;
  artist: string;
  year?: number;
  country?: string;
  label?: string;
  catno?: string;
  facets?: Record<string, unknown>;
  externalUrl?: string;
}

export interface SyncResult {
  tracks: SourceTrack[];
  releases: SourceRelease[];
}

export interface MusicSource {
  readonly id: string;            // 'discogs' | 'itunes' | 'rekordbox' | 'plex'
  readonly name: string;          // human display name (e.g. "Apple Music.app")
  readonly contributes: EntityKind[];
  sync(): Promise<SyncResult>;
}

// Capability mixins ----------------------------------------------

export interface CollectionWritable {
  addToCollection(args: { entityId: string }): Promise<{ externalId: string; instanceId?: string }>;
  removeFromCollection(args: { entityId: string; instanceId?: string }): Promise<void>;
}

// Future capability mixins (NOT in Slice 1): RatingWritable, PlaylistWritable, …
```

### Registry

```ts
// src/lib/server/sources/registry.ts
import { discogsSource } from './discogs';
import { itunesSource } from './itunes';
import { rekordboxSource } from './rekordbox';
import { plexSource } from './plex';

const sources = [discogsSource, itunesSource, rekordboxSource, plexSource];

export function getSource(id: string): MusicSource | undefined { ... }
export function listSources(): MusicSource[] { ... }
```

Static — no dynamic plugin loading. Adding a source is a code change (one new directory + one entry in this list).

### Stub adapters

Rekordbox and Plex export `MusicSource`s whose `sync()` throws `NotImplementedError`. They exist in Slice 1 to:
1. Prove the contract generalizes without ballooning scope.
2. Reserve their `id`s in the registry.
3. Give `/api/sources/:id/sync` something coherent to 501 against.

## 5. Sync + collation flow

`POST /api/sources/:id/sync` runs:

```ts
const source = registry.getSource(params.id);
if (!source) throw error(404);
try {
  const result = await source.sync();
  const summary = await collate(source.id, result);
  return json(summary);
} catch (e) {
  if (e instanceof NotImplementedError) throw error(501, e.message);
  throw e;
}
```

The Rekordbox + Plex stubs throw `NotImplementedError` from `sync()`; the route translates that to HTTP 501.

`collate(sourceId, result)` runs in a single SQLite transaction:

```
For each release in result.releases:
  matchKey = (year != null) ? normalize(artist + album + year) : null
  entityId = (matchKey && lookupMatchKey('release', 'artist_album_year', matchKey))
           ?? lookupSourceLink('release', sourceId, externalId)?.entity_id
           ?? mintNewReleaseEntity()
  upsert source_link  (release, entityId, sourceId, externalId, match_method)
  upsert match_key    (release, entityId, 'artist_album_year', matchKey)  if matchKey
  upsert source_facets per (sourceId, key) entry from facets

For each track in result.tracks:
  matchKey = filePath ? ('file_path', normalizePath(filePath)) : null
  entityId = (matchKey && lookupMatchKey('track', 'file_path', matchKey.value))
           ?? lookupSourceLink('track', sourceId, externalId)?.entity_id
           ?? mintNewTrackEntity()
  if track.releaseExternalId:
    resolve to release.entity_id via source_link → set track.release_id
  upsert source_link / match_key / source_facets

Diff for deletion (per sourceId):
  any source_link rows with this sourceId whose externalId is NOT in this sync's result get deleted.
  After deletion, any track/release with zero remaining source_links → entity row deleted.
```

The `lookupSourceLink` fallback after match-key lookup is what makes re-sync idempotent for sources without a usable match key (e.g. Discogs releases with missing year — fall back to "I've seen this externalId before, here's its entity"). Each upsert path sets `match_method` accordingly:

- `file_path` — track was looked up via the `file_path` match-key table.
- `artist_album_year` — release was looked up via the `artist_album_year` match-key table.
- `external_id_carryover` — neither match-key worked, but a `source_link` already existed for `(sourceId, externalId)`; we re-used the prior entity.
- `first_seen` — no match-key, no prior source_link; we minted a fresh entity.

`collate` returns `{ rowsIn, releasesUpserted, tracksUpserted, releasesDeleted, tracksDeleted, conflicts }`. `conflicts` counts cases where a match_key already pointed at a different entity for the same source — logged but not auto-resolved in Slice 1.

### Normalization rules

- **`normalize(artist + album + year)`:** lowercase, NFD-strip diacritics, collapse whitespace, drop non-alphanumerics, concat as `artist|album|year`.
- **`normalizePath(filePath)`:** absolute path, decoded if URL-encoded (Apple Music.app's `Library.xml` `Location` is `file:///...` percent-encoded), no trailing slash. Case-sensitivity follows the underlying filesystem (macOS HFS+ defaults case-insensitive but case-preserving — we preserve case but compare case-insensitively only if a future need emerges; Slice 1 is exact-match).

### Conflicts

When a release sync hits a `match_key` row for `(release, artist_album_year, X)` that points at entity A, but the current source already has a `source_link` pointing at entity B, we have a conflict (same key, two different entities). Slice 1 logs this in the summary's `conflicts` count and leaves the existing data alone — does not auto-merge. Resolving conflicts is a Slice 1.5/2 concern (probably with a manual merge UI).

## 6. Discogs adapter migration plan

1. **Move + rename** `src/lib/server/discogs.ts` → `src/lib/server/sources/discogs/api.ts`. Update all importers. No logic change.
2. **Move + rename** `src/lib/server/username.ts` → `src/lib/server/sources/discogs/username.ts`.
3. **New `sources/discogs/sync.ts`:** paginated pull of `/users/:user/collection/folders/:folder/releases` using existing `discogsFetch`, mapping each release into a `SourceRelease`:
   - `externalId`: Discogs `release.id` as string.
   - `title`, `artist`, `year`, `country`, `label`, `catno`: as today.
   - `facets`: `{ thumb, coverImage, formats, instanceIds: [...] }` — anything Discogs-specific worth keeping for future UI.
   - `externalUrl`: `https://www.discogs.com/release/<id>`.
4. **New `sources/discogs/index.ts`:** exports `discogsSource: MusicSource & CollectionWritable`.
   - `addToCollection({entityId})`:
     1. Resolve entity → Discogs `external_id` via `source_link` (or 404 if no link exists yet — should be impossible in normal flow; user adds from search results which feed the entity).
     2. Hit Discogs API to add (same call as today).
     3. Write through: ensure the `source_link` exists (idempotent upsert).
   - `removeFromCollection({entityId, instanceId})`:
     1. Same resolution.
     2. Hit Discogs API.
     3. Delete the matching `source_link` row.
5. **Rewire routes:**
   - `src/routes/api/discogs/search/+server.ts`: import from new location; behavior unchanged (live API, same response shape).
   - `src/routes/api/discogs/collection/add/+server.ts`: thin wrapper around `discogsSource.addToCollection`. The route is responsible for resolving the incoming `releaseId` (Discogs's external id, since that's what the existing client sends) to an `entityId`, creating a placeholder entity if no `source_link` exists yet — which happens when the user adds something they searched for (search results are not in the DB yet).
   - `src/routes/api/discogs/collection/remove/+server.ts`: same pattern.
6. **Add `/api/library/membership/+server.ts`:** `GET ?source=discogs` returns `{ externalIds: string[] }` from `source_link WHERE source='discogs' AND entity_kind='release'`. Returns the same shape the existing client store expects.
7. **Delete `src/lib/server/collection-cache.ts`.**
8. **Delete `src/routes/api/discogs/collection/ids/+server.ts`.**
9. **Update client:** `src/lib/stores/collection.svelte.ts` switches its fetch URL to `/api/library/membership?source=discogs`. The `Set<string>` shape is preserved.
10. **Auto-sync-once-if-empty:** in `src/hooks.server.ts` (or a `+layout.server.ts` if hooks add too much complexity), on the first request after server boot, check if `SELECT 1 FROM source_link WHERE source='discogs' LIMIT 1` returns nothing — if so, fire-and-forget a Discogs sync. Errors during this background sync surface in the existing toast-error path the next time the user does something Discogs-related.

### Subtleties

- **Search results are not in the DB.** When the user searches Discogs and clicks a row to add, the release likely has no `source_link` row yet. The `add` route must handle this: insert a `release` row + `source_link` row at add time, even though no formal "sync" pulled it in. This is the only place where adapter writes also create entities outside of `collate`. It's bounded and explicit. Mechanically: the existing search response already includes title/artist/year/country/label/catno (everything needed to populate a `release` row). The client passes those through to `add` along with `releaseId`, OR the `add` route fetches release details from Discogs API. Picking the former (client-provides) for Slice 1 — avoids an extra round-trip to Discogs and the search response already has the data. The `add` route's request body grows from `{releaseId}` to `{releaseId, title, artist, year, country, label, catno, coverImage}`.
- **Removal flow.** Today's "undo last add" passes `(releaseId, instanceId)` from the session log. Slice 1 keeps the session log as today (in-memory client-side) and resolves Discogs `releaseId` → entityId via `source_link` at the route layer. If for any reason the `source_link` is missing (e.g. user manually nuked the DB), fall back to calling Discogs's API directly with the `releaseId` and treat the local DB as not knowing.

## 7. Apple Music.app adapter

### Source data

`Library.xml` is a property-list (Apple plist) XML file. Structure:

```xml
<plist>
  <dict>
    <key>Tracks</key>
    <dict>
      <key>12345</key>
      <dict>
        <key>Track ID</key><integer>12345</integer>
        <key>Name</key><string>Around the World</string>
        <key>Artist</key><string>Daft Punk</string>
        <key>Album</key><string>Homework</string>
        <key>Album Artist</key><string>Daft Punk</string>
        <key>Year</key><integer>1997</integer>
        <key>Total Time</key><integer>429000</integer>
        <key>Track Number</key><integer>7</integer>
        <key>Rating</key><integer>100</integer>
        <key>Play Count</key><integer>47</integer>
        <key>Location</key><string>file:///Users/luke/.../Around%20the%20World.m4a</string>
      </dict>
      ... more tracks ...
    </dict>
    <key>Playlists</key>
    <array> ... </array>
  </dict>
</plist>
```

### Approach

- **Parser:** use `plist` (the npm package) — small, dependency-light, returns plain JS objects from plist XML.
- **What we contribute in Slice 1:**
  - One `SourceTrack` per `Tracks` entry that has both `Name` and `Location`. Skip iCloud-only / DRM-broken entries that lack `Location`.
  - **Emergent releases:** group tracks by `(Album Artist || Artist, Album, Year)` (skip groups where Album is empty). One `SourceRelease` per group. Each track in the group gets `releaseExternalId = <synthetic id derived from group key>`.
  - Track facets: `{ rating, playCount, dateAdded, kind, bitRate, sampleRate, genre }`.
  - Release facets: `{ trackCount }`.
- **Synthetic release externalIds:** since iTunes doesn't have its own album-id concept, we mint deterministic synthetic ids by hashing the normalized group key. Stable across syncs as long as the metadata is unchanged. Format: `itunes-album:<sha1(normalized_group_key)[:12]>`.

### What we explicitly drop in Slice 1

- Playlists. They're contributed via the XML but Slice 1 doesn't model playlists yet — it would need a third entity type. Punted to Slice 2 (likely as a `playlist` table + `playlist_track` join, source-attributed).
- DRM/cloud-only entries without `Location`. Logged-and-skipped.
- Cover art. The XML doesn't include it inline; we'd need to read the file's tags or a separate cover cache. Punted.

### `sync()` flow

```
1. Read ITUNES_XML_PATH; throw clear error if missing or unreadable.
2. Parse plist → JS object.
3. Walk Tracks dict:
   - filter to entries with Name + Location
   - decode Location URL → absolute path
   - emit SourceTrack
4. Group by (Album Artist || Artist, Album, Year); emit SourceRelease per group with synthetic externalId.
5. Return SyncResult { tracks, releases }.
```

### Out-of-scope for Slice 1 itunes adapter

- Watching the file for changes (mtime poll / fs.watch).
- The `.musiclibrary` binary format (only XML export is supported in Slice 1; users with the modern Music.app must enable "Share iTunes Library XML with other applications" in Preferences → Advanced).
- Writing back to iTunes (rating sync, etc.).

## 8. Verification

Slice 1 is "headless" — no new UI. Verification surface:

1. **Existing add-record flow keeps working.** Search → click → confirm → add. "In collection" badge appears for already-owned releases. Undo works. This proves the Discogs migration didn't break user-facing behavior.
2. **Inspection endpoints:**
   - `GET /api/library/tracks?source=itunes&limit=20` returns recent tracks contributed by Apple Music.app, with their facets.
   - `GET /api/library/releases?source=discogs&limit=20` returns recent Discogs releases.
   - `GET /api/library/membership?source=discogs` returns the set of Discogs `external_id`s currently linked.
3. **Sync endpoints:**
   - `POST /api/sources/itunes/sync` — runs the Apple Music.app adapter, returns the collation summary.
   - `POST /api/sources/discogs/sync` — runs the Discogs adapter.
   - `POST /api/sources/rekordbox/sync` and `POST /api/sources/plex/sync` — return 501 (NotImplemented).
4. **Cross-source collation spot-check:** after both syncs, manually pick one album you own physically + on Discogs (e.g. `Homework`) and curl `/api/library/releases?...` filtered to find the entity. Confirm it has both an `itunes` and `discogs` source_link row. (This is the actual proof that collation works.)
5. **Manual DB inspection:** `sqlite3 ./.booth/booth.db` and run a few sanity queries.

No automated tests in Slice 1 (matches today's "no tests" stance per CLAUDE/CONTEXT). Type-check (`pnpm exec tsc --noEmit`) is the only static gate.

## 9. Future work (carried forward to the implementation plan)

These items are deferred from Slice 1 and must remain visible in the plan's tail so we know to schedule them:

- **Slice 2: Library explorer UI.** iTunes-style three-pane (sources/playlists, content list, detail). Reads from the unified store; surfaces source-aware panels (Discogs metadata, Rekordbox BPM/key, Plex play button).
- **Rekordbox adapter implementation.** Read `master.db` (SQLite), contribute tracks with `bpm`, `key`, `cuePoints`, etc. as facets. File-path match key for local↔local linking.
- **Plex adapter implementation.** HTTP API client; contribute tracks with `streamUrl` facet. File-path match key on `Part.file`. Auth via `X-Plex-Token` in `.env`.
- **Fuzzy matching upgrade.** Levenshtein/token-based scoring fallback when deterministic match fails. Add `confidence` column to `source_link` and a `match_overrides` table.
- **Track-level Discogs matching.** Match individual iTunes tracks to specific tracks in Discogs release tracklists. Probably a separate adapter run-mode rather than collate-time.
- **Catno match-key.** Promote `catno` to a `match_key.key_type='catno'`. Useful for distinguishing pressings.
- **Incremental sync.** Per-source cursor (Discogs `instance_id` order, Plex `updatedAt`). Sync gets faster, file watching becomes possible.
- **File watching / scheduled sync.** Auto-trigger sync on `Library.xml` mtime changes; periodic Plex polls.
- **Artist as first-class entity.** Migration: add `artist` table, `track`/`release` get `artist_id` FKs, `source_link`/`facets` extend to `entity_kind='artist'`.
- **Booth-owned ratings/play counts.** A `user_track_data` table for ratings/plays not mirrored from a source. UI for editing.
- **Playlists.** New entity type (`playlist`, `playlist_track`), source-attributed. iTunes adapter starts contributing them.
- **Sync-run logging.** `sync_run` table for debugging — currently the summary is only returned in the response.
- **Auth / multi-user.** Currently single-user, dev-only.
- **LAN / phone access.** Dev binds to localhost only.
- **Bandcamp wishlist adapter** (eventual; release-first).
- **YouTube adapter** (eventual; track-first via playlist; streaming via embed).

## 10. Open questions

None — all decisions made. If anything in the spec turns out underspecified during planning, it gets resolved in the implementation plan.
