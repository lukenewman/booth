# booth — project context

> **Purpose:** Source-of-truth for what's currently shipped. Update at the end of each plan implementation; treat plans/specs in `docs/superpowers/` as historical blueprints, not current state.

## What it is

Single-user, local-only SvelteKit app for adding records to a personal Discogs collection. Two ways in: text search and webcam barcode scan. Keyboard-first, dark theme, no auth UI (token lives in `.env`). Data layer is a generic source-adapter system backed by local SQLite, with Discogs + Apple Music.app adapters wired up and Rekordbox + Plex stubbed.

## Tech

- **Runtime:** Node + pnpm. SvelteKit 2 + Svelte 5 (runes), TypeScript, Vite.
- **Camera:** `@zxing/browser` (`BrowserMultiFormatReader`).
- **DB:** SQLite at `./.booth/booth.db`, hand-rolled migrations in `src/lib/server/db/migrations/`. Managed via `better-sqlite3`.
- **New deps:** `better-sqlite3`, `plist` (Apple plist parser), `ulid` (entity ID generator). Dev: `tsx` (runs verification scripts under TS).
- **No tests, no UI framework.** Session log is in-memory client-side.
- **Dev:** `pnpm dev` (binds 5173, falls back upward).

## Environment

`.env` (gitignored; example in `.env.example`):

```
DISCOGS_TOKEN=<personal access token from discogs.com/settings/developers>
DISCOGS_FOLDER_ID=1   # optional; defaults to "Uncategorized"

# Path to Apple Music.app's Library.xml export.
# Modern Music.app: enable "Share Library XML with other applications" in
#   Settings → Advanced; default location is ~/Music/Music/Library.xml
# Legacy iTunes: ~/Music/iTunes/iTunes Music Library.xml
ITUNES_XML_PATH=

# Optional: override default DB location (defaults to ./.booth/booth.db)
# BOOTH_DB_PATH=
```

Server reads via `$env/dynamic/private` (NOT `process.env` — Vite doesn't auto-populate that).

## File map

```
src/
  app.css                                     dark-theme tokens + globals
  app.html                                    <title>booth</title>
  hooks.server.ts                             auto-sync-on-boot: triggers Discogs sync once if DB has zero Discogs source_links
  lib/
    types.ts                                  DiscogsRelease, SessionEntry, ApiError, AddResponse
    keyboard.svelte.ts                        installKeyboard(actions, state) — global keydown handler
    components/
      SearchBar.svelte                        input + scan button; exports focus()
      ResultsList.svelte                      renders ResultRow per result
      ResultRow.svelte                        row UI; reads collection store for "in collection" badge
      ConfirmModal.svelte                     add confirmation; supports submitting + error states
      Scanner.svelte                          ZXing camera viewfinder; retries NotReadableError up to 3×
      Toast.svelte                            bottom-center toast container
      SessionLog.svelte                       "Added this session: N — undo last"
      ShortcutOverlay.svelte                  ? overlay listing shortcuts
    server/
      db/
        index.ts                              singleton better-sqlite3 connection; reads path from env
        migrate.ts                            reads migrations/*.sql, applies in order, tracks in _migrations
        migrations/
          001_init.sql                        core tables: release, track, source_link, source_facets, match_key, _migrations
      sources/
        types.ts                              MusicSource, CollectionWritable, SourceTrack, SourceRelease, SyncResult
        registry.ts                           statically-populated source list; getSource(id), listSources()
        discogs/
          api.ts                              discogsFetch + DiscogsError; reads token via $env/dynamic/private
          username.ts                         lazy /oauth/identity username cache
          sync.ts                             full collection re-pull → SyncResult
          index.ts                            discogsSource: MusicSource & CollectionWritable
        itunes/
          parse.ts                            plist/XML → typed iTunes records
          sync.ts                             parses Library.xml → SyncResult; emits emergent releases
          index.ts                            itunesSource: MusicSource (read-only)
        rekordbox/
          index.ts                            stub: sync() throws NotImplementedError
        plex/
          index.ts                            stub: sync() throws NotImplementedError
      library/
        normalize.ts                          normalization helpers for match keys (artist_album_year, file_path)
        collate.ts                            post-sync: maps SyncResult → entity + source_link upserts
        queries.ts                            generic reads: getTrack, getRelease, getMembership
    stores/
      mode.svelte.ts                          'search' | 'scanner'
      session.svelte.ts                       in-memory session log (entries, count, last)
      toast.svelte.ts                         toast queue with auto-dismiss + retry actions
      collection.svelte.ts                    client mirror of Discogs membership (Set<releaseId>); fetches /api/library/membership?source=discogs
  routes/
    +layout.svelte                            imports app.css; mounts <Toast />
    +page.svelte                              the entire app (search/scanner/setup screens)
    api/
      sources/
        [id]/sync/+server.ts                  POST → registry.getSource(id).sync() → collate → return summary; 404 unknown, 501 stub
      library/
        tracks/+server.ts                     GET ?source=&limit=  inspection: tracks from unified store
        releases/+server.ts                   GET ?source=&limit=  inspection: releases from unified store
        membership/+server.ts                 GET ?source=discogs  → set of external_ids (Discogs release-id strings)
      discogs/
        search/+server.ts                     GET ?q= — live text search, returns trimmed releases sorted by year asc
        collection/
          add/+server.ts                      POST {releaseId, …} — adds to Discogs; writes through to source_link table
          remove/+server.ts                   DELETE {releaseId, instanceId} — removes from Discogs; deletes source_link row
docs/
  CONTEXT.md                                  ← this file
  superpowers/
    specs/2026-04-29-discogs-collection-adder-design.md   original product spec
    specs/2026-05-05-multi-source-architecture-design.md  multi-source architecture design (Slice 1)
    plans/2026-04-29-discogs-collection-adder.md          original implementation plan (all checked off)
    plans/2026-05-05-multi-source-architecture.md         Slice 1 implementation plan
```

## Feature inventory

### Search
- Live-debounced (250ms) text search via `/api/discogs/search?q=`.
- Results sorted ascending by year, nulls last (sorted in the SvelteKit endpoint, not at Discogs).
- Each row: 80×80 cover, artist — title, sub-line `format · year · country · label · catno`.
- "✓ in collection" green badge + dimmed title + green outline on cover for releases the user already owns.
- Single "Open this search in Discogs ↗" link below the list (opens `discogs.com/search/?q=…&type=all`).
- Click row OR press Enter on highlighted row → opens confirm modal.

### Scanner
- `s` enters scanner mode; `s` or `Esc` exits.
- Camera viewfinder with centered crosshair frame.
- On decode: beep, dispatches the decoded code into the search bar, mode flips to `search`. Search runs against `/api/discogs/search?q=<code>` (Discogs's text search indexes barcodes).
- On `NotReadableError` (camera still releasing from a previous mount), retries up to 3× with 250ms backoff.
- Camera errors include the underlying error name in the on-page message and `console.warn` the full error.

### Add / undo
- Confirm modal: cover, artist · year, format/country/label rows, Add (Enter) / Cancel (Esc).
- On add: `POST /api/discogs/collection/add` → session log gets the new entry; collection store marks added; toast appears. The route also writes a `release` row + `source_link` row to SQLite if this release hasn't been seen before.
- Session log shows count + "undo last (u)" button when count > 0.
- `u` or Cmd/Ctrl+Z → `DELETE /api/discogs/collection/remove` for the most-recent entry; source_link row removed; toast appears.
- Add/undo errors surface inline (modal) or via toast (with retry action for undo).

### URL state
- `?q=<query>` is the single source of truth for the search bar. Typing updates URL (via `history.replaceState`); reload restores the same query (read at component init via `$app/state`'s `page.url.searchParams`).
- Scanner-decoded codes flow through the same `?q=` path.

### Setup screen
- On mount, the page probes `/api/discogs/search?q=test`. If the response says `no_token` or `invalid_token`, shows a setup screen with instructions instead of the app shell.

### Rate-limit handling
- Discogs 429 → toast "Rate limited. Try again in Xs." (uses `Retry-After`). Surfaces for both search and add/remove paths.

### Keyboard shortcuts (`?` to view)
- `/` focus search · `s` toggle scanner · `↑/↓` move highlight · `Enter` open confirm or confirm add
- `Esc` close modal / exit scanner / blur search input
- `u` or `Cmd/Ctrl+Z` undo last add · `?` toggle overlay
- Auto-focus on search bar on initial page load.

### Sources
- **Manual sync:** `POST /api/sources/:id/sync` runs the named adapter's `sync()`, collates the result into SQLite, and returns a summary `{ rowsIn, releasesUpserted, tracksUpserted, releasesDeleted, tracksDeleted, conflicts }`. Returns 404 for an unknown id, 501 if the adapter's `sync()` throws `NotImplementedError`.
- **Auto-sync on boot:** `src/hooks.server.ts` fires once on the first request after server start. It checks `SELECT 1 FROM source_link WHERE source='discogs' LIMIT 1`; if the DB is empty, it fires a Discogs sync in the background (fire-and-forget). This preserves the "it just works" feel without blocking page load.
- **Inspection endpoints:**
  - `GET /api/library/tracks?source=&limit=` — tracks from the unified store, optionally filtered by source.
  - `GET /api/library/releases?source=&limit=` — releases from the unified store.
  - `GET /api/library/membership?source=discogs` — set of Discogs `external_id` strings for releases currently in the collection. This is what `collection.svelte.ts` fetches to populate the "in collection" badge.
- **Adapters:**
  - **Discogs** (`id: 'discogs'`) — real, full read+write via `CollectionWritable`. Syncs the entire collection folder via paginated Discogs API. Writes (add/remove) go through to both Discogs and the SQLite `source_link` table.
  - **Apple Music.app** (`id: 'itunes'`) — real, read-only. Parses `ITUNES_XML_PATH` Library.xml via the `plist` package. Contributes tracks with file-path match keys and emergent releases grouped by `(Album Artist || Artist, Album, Year)`. Synthetic release `external_id`s are deterministic hashes of the normalized group key. Track facets include `rating`, `playCount`, `dateAdded`, `kind`, `bitRate`, `sampleRate`, `genre`.
  - **Rekordbox** (`id: 'rekordbox'`) and **Plex** (`id: 'plex'`) — stubs. Registered in the source registry with correct `id`/`name`/`contributes` but `sync()` throws `NotImplementedError`, which the route translates to HTTP 501.

## Notable divergences from the original plan

- **Multi-source architecture (Slice 1, 2026-05-05).** Replaced the hardcoded-Discogs data layer with a generic source-adapter contract + SQLite-backed unified store. See `docs/superpowers/specs/2026-05-05-multi-source-architecture-design.md` and `docs/superpowers/plans/2026-05-05-multi-source-architecture.md`.
- **Token loading.** Plan used `process.env.DISCOGS_TOKEN`; switched to `$env/dynamic/private` so `.env` actually loads in dev.
- **Barcode lookup endpoint.** Plan added `/api/discogs/barcode/[code]` (Task 23). Built, tested, then **deleted** when scanner flow was unified onto `/api/discogs/search?q=`. The Discogs text search already indexes barcodes well enough.
- **No "in collection" feature in the plan.** Built post-MVP: SQLite `source_link` table + `collection.svelte.ts` store + `/api/library/membership?source=discogs` endpoint + ResultRow badge.
- **No URL persistence in the plan.** Added `?q=` round-trip post-MVP.
- **No master/release deep-links in the plan.** Added a single "Open this search in Discogs" link below results (replaced an earlier per-row link).
- **Cover thumbnails 80×80.** Plan said 40×40.
- **Catalog number** added to row metadata (plan didn't include `catno`).
- **Result sort by year ascending.** Plan returned Discogs's default ordering.
- **Scanner robustness.** Plan didn't anticipate `NotReadableError` from rapid camera re-acquire; retry-with-backoff was added.
- **Auto-focus search on load + Esc-to-blur** added (plan only had `/` to focus).
- **`normalize.ts` in `library/`.** The spec put normalization inline in `collate.ts`; extracted to `src/lib/server/library/normalize.ts` in the actual implementation.

## Known gaps / future work

- **No automated tests.** Verification is via `pnpm verify scripts/<name>.ts`, curl, sqlite3, and manual browser testing.
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
- **Sync-run logging.** `sync_run` table for debugging — currently the summary is only returned in the HTTP response.
- **Auth / multi-user.** Currently single-user, dev-only.
- **LAN / phone access.** Currently dev-only on localhost.
- **Bandcamp wishlist adapter** (eventual; release-first).
- **YouTube adapter** (eventual; track-first via playlist; streaming via embed).
- **`Cmd+Z` is intercepted by the browser** when the search input is focused (it'll undo typed text first). The on-screen button and `u` key still work.

## Local development

```bash
cp .env.example .env
# paste DISCOGS_TOKEN (and optionally ITUNES_XML_PATH)
pnpm install
pnpm dev
# open http://localhost:5173
```

The DB is auto-initialized on first server boot — it creates `./.booth/booth.db` and runs migrations automatically. An empty DB triggers an initial Discogs sync via the boot hook in `src/hooks.server.ts` (fire-and-forget; happens in the background).

Run a verification script: `pnpm verify scripts/<name>.ts` (uses `tsx` to run TypeScript directly).

Type-check (no test runner): `pnpm exec svelte-kit sync && pnpm exec tsc --noEmit`.
