# booth — project context

> **Purpose:** Source-of-truth for what's currently shipped. Update at the end of each plan implementation; treat plans/specs in `docs/superpowers/` as historical blueprints, not current state.

## What it is

Single-user, local-only SvelteKit app for adding records to a personal Discogs collection. Two ways in: text search and webcam barcode scan. Keyboard-first, dark theme, no auth UI (token lives in `.env`). Data layer is a generic source-adapter system backed by local SQLite, with Discogs + Apple Music.app adapters wired up and Rekordbox + Plex stubbed.

## Tech

- **Runtime:** Bun (package manager + TS runner) on top of Node-compatible APIs. SvelteKit 2 + Svelte 5 (runes), TypeScript, Vite.
- **Camera:** `@zxing/browser` (`BrowserMultiFormatReader`).
- **DB:** SQLite at `~/.booth/booth.db` (user-scoped, not repo-relative), hand-rolled migrations in `src/lib/server/db/migrations/`. Managed via bun's built-in `bun:sqlite` (sync, prepared-statement API). Project is bun-only as a result — no Node fallback.
- **New deps:** `better-sqlite3`, `plist` (Apple plist parser), `ulid` (entity ID generator). Verification scripts run on bun's native TS execution — no separate runner dep.
- **No tests, no UI framework.** Session log is in-memory client-side.
- **Dev:** `bun dev` (binds 5173, falls back upward).

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

# Optional: override default DB location (defaults to ~/.booth/booth.db)
# BOOTH_DB_PATH=
```

Server reads via `$env/dynamic/private` (NOT `process.env` — Vite doesn't auto-populate that).

## File map

```
src/
  app.css                                     dark-theme tokens + globals
  app.html                                    <title>booth</title>
  hooks.server.ts                             auto-sync-on-boot: for each of Discogs + iTunes (when ITUNES_XML_PATH set), fires runSync() once if the DB has zero source_links for that source
  lib/
    types.ts                                  DiscogsRelease, SessionEntry, ApiError, AddResponse
    keyboard.svelte.ts                        installKeyboard(actions, guards) — global keydown handler dispatching DOM-driven actions
    components/
      Explorer.svelte                         three-pane shell (rail / listview / detail); owns URL ↔ store sync, data fetching, add/remove handlers
      Rail.svelte                             left rail: Library / Sources / Add → Discogs sections
      Listview.svelte                         generic paginated row container; IntersectionObserver sentinel + selection state
      ListviewToolbar.svelte                  list header: search input + scanner btn + entity toggle (releases/tracks/artists) + sync chip + meta
      ReleaseList.svelte                      Listview wrapper bound to release rows
      TrackList.svelte                        Listview wrapper bound to track rows
      ArtistList.svelte                       Listview wrapper bound to artist rows (name + release/track counts + SourceGrid)
      ReleaseDetail.svelte                    right pane for a release; tracklist + per-source panels; optional add/remove CTA with variant
      TrackDetail.svelte                      right pane for a track; parent-release card + per-source panels
      ArtistDetail.svelte                     right pane for an artist; per-source panels + list of releases (click-through to release detail)
      SourceGrid.svelte                       4-dot "DiRP" indicator (Discogs / iTunes / Rekordbox / Plex)
      SourcePanel.svelte                      per-source detail block (facets + external link or stub placeholder)
      SyncChip.svelte                         last-synced timestamp + click-to-sync; disabled for stub sources
      SyncRunHistory.svelte                   right-pane sync_run list shown when a Sources rail item is selected with no entity; one row per run (relative time, duration, summary or error)
      EmptyState.svelte                       centered "nothing here" placeholder
      SearchBar.svelte                        debounced text input; exports focus() / blur() / clear()
      Scanner.svelte                          ZXing camera viewfinder; retries NotReadableError up to 3×
      Toast.svelte                            bottom-center toast container
      SessionLog.svelte                       32px footer strip; only shown in Add → Discogs
      ShortcutOverlay.svelte                  `?` overlay listing shortcuts
    server/
      db/
        index.ts                              singleton bun:sqlite connection; reads BOOTH_DB_PATH or falls back to ~/.booth/booth.db
        migrate.ts                            reads migrations/*.sql, applies in order, tracks in _migrations
        migrations/
          001_init.sql                        core tables: release, track, source_link, source_facets, match_key, _migrations
          002_source_state.sql                source_state (source PRIMARY KEY, last_synced_at, last_summary)
          003_artist_entity.sql               artist table; release/track gain artist_id FK (denormalized artist text dropped); source_link/source_facets/match_key CHECK widened to include 'artist'
          004_sync_run.sql                    sync_run table (id, source, started_at, finished_at, summary JSON, error); indexed by (source, started_at DESC) for history queries
      sources/
        types.ts                              MusicSource (with isStub), CollectionWritable, SourceTrack, SourceRelease, SyncResult
        registry.ts                           statically-populated source list; getSource(id), listSources()
        discogs/
          api.ts                              discogsFetch + DiscogsError; reads token via $env/dynamic/private
          username.ts                         lazy /oauth/identity username cache
          sync.ts                             full collection re-pull → SyncResult; populates instanceIds facet
          index.ts                            discogsSource: MusicSource & CollectionWritable
        itunes/
          parse.ts                            plist/XML → typed iTunes records
          sync.ts                             parses Library.xml → SyncResult; emits emergent releases
          index.ts                            itunesSource: MusicSource (read-only)
        rekordbox/
          index.ts                            stub: isStub=true; sync() throws NotImplementedError
        plex/
          index.ts                            stub: isStub=true; sync() throws NotImplementedError
      library/
        normalize.ts                          normalization helpers for match keys (artist_album_year, file_path, artist_name)
        collate.ts                            post-sync: maps SyncResult → entity + source_link upserts; writes source_state. Exports upsertArtist(db, name) for callers outside collate (e.g. Discogs add path) that need to resolve an artist string to an artist row id.
        queries.ts                            listReleases / listTracks (paginated), getReleaseDetail / getTrackDetail, listSourcesWithState, getMembershipExternalIds. All release/track selects JOIN the artist table and alias artist.name AS artist so the wire shape is unchanged.
        sync_run.ts                           runSync(db, sourceId) wraps adapter.sync + collate, writes a sync_run row (start row up front, summary or error on completion); listSyncRuns(db, source, limit) reads recent runs. Used by /api/sources/[id]/sync, the boot hook, and the runs endpoint.
    stores/
      session.svelte.ts                       in-memory session log (entries, count, last)
      toast.svelte.ts                         toast queue with auto-dismiss + retry actions
      collection.svelte.ts                    client mirror of Discogs membership (Set<releaseId>); fetches /api/library/membership?source=discogs
      explorerState.svelte.ts                 singleton mirror of URL params ?nav / ?id / ?q / ?entity; hydrate() + serialize()
  routes/
    +layout.svelte                            imports app.css; mounts <Toast />
    +page.svelte                              mounts <Explorer> + <ShortcutOverlay>; setup gate; installKeyboard with DOM-driven actions
    api/
      sources/
        +server.ts                            GET → [{ id, name, isStub, lastSyncedAt, lastSummary }] for the rail Sources section
        [id]/sync/+server.ts                  POST → runSync(getDb(), id) → return summary; 404 unknown, 501 stub
        [id]/runs/+server.ts                  GET ?limit= → { items: SyncRunRow[] } recent sync_run rows for the given source (default 20, max 200)
      library/
        tracks/+server.ts                     GET ?source=&q=&multiSource=&limit=&offset=  paginated tracks
        tracks/[id]/+server.ts                GET → { track, sources, facets, release, sourceMeta } for TrackDetail
        releases/+server.ts                   GET ?source=&q=&multiSource=&limit=&offset=  paginated releases
        releases/[id]/+server.ts              GET → { release, sources, facets, tracks, sourceMeta } for ReleaseDetail
        artists/+server.ts                    GET ?source=&q=&multi_source=&limit=&offset=  paginated artists (each row: name + releaseCount + trackCount + sources[])
        artists/[id]/+server.ts               GET → { artist, sources, facets, releases, trackCount } for ArtistDetail
        membership/+server.ts                 GET ?source=discogs  → set of external_ids (Discogs release-id strings)
      discogs/
        search/+server.ts                     GET ?q= — live text search; returns { results: […] } sorted by year asc
        collection/
          add/+server.ts                      POST {releaseId,…} — adds to Discogs; writes source_link + appends instance_id to source_facets.instanceIds
          remove/+server.ts                   DELETE {releaseId, instanceId?} — removes from Discogs; instanceId optional (falls back to source_facets.instanceIds[0])
docs/
  CONTEXT.md                                  ← this file (deferred work lives in Linear; see ## Backlog below)
  superpowers/
    specs/2026-04-29-discogs-collection-adder-design.md   original product spec
    specs/2026-05-05-multi-source-architecture-design.md  multi-source architecture design (Slice 1)
    specs/2026-05-06-library-explorer-design.md           library explorer design (Slice 2)
    plans/2026-04-29-discogs-collection-adder.md          original implementation plan (all checked off)
    plans/2026-05-05-multi-source-architecture.md         Slice 1 implementation plan
    plans/2026-05-06-library-explorer.md                  Slice 2 implementation plan
```

## Feature inventory

### Library explorer (Slice 2 shell)
- **Three panes**: left rail (Library / Sources / Add → Discogs sections), middle listview (paginated rows + toolbar), right detail (release or track).
- **Library rail items**: `all` (label flips between "All tracks" / "All releases" based on the app-wide entity lens) and `in-multiple-sources` (entities contributed by ≥2 sources, supports both kinds).
- **Sources rail items**: one per registered source (`discogs`, `itunes`, `rekordbox`, `plex`); stubs render `EmptyState`. Release-only sources (Discogs) render a dedicated "No tracks indexed" empty state when the entity lens is set to tracks.
- **Add rail item**: `add:discogs` — Discogs live search, release-only by nature (the search API doesn't return tracks); toolbar omits the entity toggle here.
- **Entity lens (releases ↔ tracks ↔ artists)**: app-wide viewing toggle, lives in the listview toolbar and is bound to `Tab` (cycles forward 3-way). Persists across rail switches (it's a lens, not a per-rail attribute). Detail pane keeps its open entity when the lens flips — the listview switches independently. URL: `?entity=releases|tracks|artists` (omitted when equal to the default `releases`).
- **Listview**: lazy pagination via `IntersectionObserver` sentinel rooted on the scroll container (`?limit=200&offset=…`); row click selects + opens detail.
- **Detail**: cover placeholder, title/artist/year, optional CTA, then per-source panels (`SourcePanel`) for all registered sources, then tracklist (releases only). Stub sources still render a "not implemented" panel.
- **SourceGrid**: 4-dot indicator (D / i / R / P) shown on every row and in detail context to communicate which sources contribute to a given entity.
- **SyncChip** (in toolbar when a Sources rail item is selected): "last synced Nm ago" → click triggers `POST /api/sources/:id/sync` and flips to "Syncing…"; updates timestamp on completion. Stubs render as a disabled "Not implemented" chip.

### Search
- **Library / Sources searches** (Library, Sources rail items): the toolbar search input filters the current listview via `?q=` on `/api/library/releases` or `/api/library/tracks`. Server-side `LIKE` over title + artist; pagination resets.
- **Add → Discogs search**: same toolbar input, but query goes to `/api/discogs/search?q=` (returns `{ results: [...] }` sorted ascending by year, nulls last).
- Both modes are live-debounced (250ms) through the shared `SearchBar` component (`focus()` / `blur()` / `clear()` exposed).
- Owned-by-Discogs releases show the D dot filled in the row's `SourceGrid` — same indicator everywhere in the UI.

### Scanner
- Scanner button lives in the listview toolbar (the `s` shortcut still toggles it).
- Camera viewfinder with centered crosshair frame in a popover/overlay.
- On decode: beep, dispatches the decoded code into the toolbar search input, scanner closes. The search runs against whichever endpoint matches the current rail item (Library/Sources hits the local DB; Add → Discogs hits the Discogs API — barcode strings index well in Discogs text search).
- On `NotReadableError` (camera still releasing from a previous mount), retries up to 3× with 250ms backoff.
- Camera errors include the underlying error name in the on-page message and `console.warn` the full error.

### Add / undo
- The old `ConfirmModal` is gone. Add is a detail-pane CTA on a Discogs search-hit that isn't already owned: blue `+ Add to Discogs collection ⏎` button.
- On add: `POST /api/discogs/collection/add` → Discogs API call → on success, the route writes the `release` row, the `source_link` row (so the D dot fills in the grid), AND appends the returned `instance_id` to the release's `source_facets.instanceIds` JSON array. Session log gets the entry; toast confirms; collection store marks added.
- On a release already in the user's Discogs collection (whether reached via the Library rail or as an owned hit in Add → Discogs search), the detail CTA flips to a quiet `✓ In your Discogs collection — undo u` row. Clicking or pressing `u` calls `DELETE /api/discogs/collection/remove`.
- `DELETE` body accepts `{releaseId, instanceId?}`. If `instanceId` is omitted, the server falls back to `source_facets.instanceIds[0]` — so removal still works for adds made before the facet-persistence change, after a Discogs sync repopulates the facet.
- Session log (32px footer strip, only visible in `Add → Discogs`) shows count + "undo last (u)" button.
- Keyboard `u` / `Cmd|Ctrl+Z`: prefer the visible detail-pane Remove button; fall back to undoing the most-recent session-log entry if no Remove is on screen.
- Add/undo errors surface via toast.

### URL state
- Four params, mirrored by `explorerState.svelte.ts` singleton:
  - `?nav=<rail-item>` — e.g., `library:all`, `sources:discogs`, `add:discogs`. Source of truth for which rail item is selected. Legacy `library:all-releases` / `library:all-tracks` URLs are redirected to `library:all` on hydrate, carrying their entity-kind through as `?entity=`.
  - `?id=<entity-id>` — currently-selected list row (release-ULID or track-ULID; for Add-Discogs search-hits, the bare Discogs release id). Null = nothing selected; detail pane shows EmptyState.
  - `?q=<query>` — toolbar search text. Targets vary by rail item (library DB vs. Discogs API).
  - `?entity=<releases|tracks>` — **app-wide** entity lens (defaults to `releases` and is omitted from the URL when it equals the default). Toggled by `Tab`; persists across rail switches.
- `setNav()` clears `id` (different rail = different list) but deliberately does NOT clear `entity` — the lens is app-wide, so the user's preference carries across rails.
- Updates use `history.replaceState`; reload restores the full view.

### Setup screen
- On mount, `+page.svelte` probes `/api/discogs/search?q=test`. If the response says `no_token` or `invalid_token`, it renders a setup screen with instructions in place of the Explorer.

### Rate-limit handling
- Discogs 429 → toast "Rate limited. Try again in Xs." (uses `Retry-After`). Surfaces for search and add/remove paths.

### Keyboard shortcuts (`?` to view)
- `/` focus search · `s` toggle scanner · `?` toggle overlay
- `Tab` toggles the app-wide tracks/releases lens. Suppressed when focus is inside an input/textarea (preserves standard form-field tabbing) and when the current rail item has no tracks-side concept (the toolbar's `.toggle` element is the DOM-driven probe — its absence makes Tab a no-op).
- `↑/↓` walk listview rows via DOM focus; `↑` from row 1 returns focus to the search input; `↓` from the search input jumps to row 1.
- `Enter` — context-aware: on a focused row, opens its detail (same as clicking); otherwise clicks the visible primary Add CTA.
- `Esc` closes scanner overlay; otherwise clears search-input value, then blurs it.
- `u` or `Cmd/Ctrl+Z` — prefer visible detail-pane Remove (handles persistent removal via facet); else undoes most-recent session add.
- Auto-focus on search bar on initial page load.
- Keyboard wiring is DOM-driven: `installKeyboard(actions, guards)` in `+page.svelte` looks up elements by class (`input.search`, `.body button.row-btn`, `button.add-btn`, `button.remove-btn`, `.scanner-overlay`, `.bar .toggle`) at event time rather than holding component refs.

### Sources
- **Manual sync:** `POST /api/sources/:id/sync` invokes `runSync()` — the named adapter's `sync()`, collated into SQLite, with a row written to `sync_run` (start row up front, summary or error captured on completion). Returns the summary `{ rowsIn, releasesUpserted, tracksUpserted, releasesDeleted, tracksDeleted, conflicts }`. Returns 404 for an unknown id, 501 if the adapter's `sync()` throws `NotImplementedError`.
- **Auto-sync on boot:** `src/hooks.server.ts` fires once per source on the first request after server start. For each of Discogs and iTunes (the latter only if `ITUNES_XML_PATH` is set), it checks `SELECT 1 FROM source_link WHERE source=? LIMIT 1`; if the DB has no rows for that source, it fires `runSync()` in the background (fire-and-forget). Both backfills also write to `sync_run`. This preserves the "it just works" feel without blocking page load.
- **Sync history:** `GET /api/sources/:id/runs?limit=` returns recent `sync_run` rows for a source. The `SyncRunHistory` component renders this in the right pane whenever a Sources rail item is selected without an entity highlighted; an in-flight sync from the toolbar chip shows a "Running…" row on top and the history refetches on completion.
- **Inspection endpoints:**
  - `GET /api/library/tracks?source=&limit=` — tracks from the unified store, optionally filtered by source.
  - `GET /api/library/releases?source=&limit=` — releases from the unified store.
  - `GET /api/library/membership?source=discogs` — set of Discogs `external_id` strings for releases currently in the collection. This is what `collection.svelte.ts` fetches to populate the "in collection" badge.
- **Adapters:**
  - **Discogs** (`id: 'discogs'`) — real, full read+write via `CollectionWritable`. Syncs the entire collection folder via paginated Discogs API. Writes (add/remove) go through to both Discogs and the SQLite `source_link` table.
  - **Apple Music.app** (`id: 'itunes'`) — real, read-only. Parses `ITUNES_XML_PATH` Library.xml via the `plist` package. Contributes tracks with file-path match keys and emergent releases grouped by `(Album Artist || Artist, Album, Year)`. Synthetic release `external_id`s are deterministic hashes of the normalized group key. Track facets include `rating`, `playCount`, `dateAdded`, `kind`, `bitRate`, `sampleRate`, `genre`.
  - **Rekordbox** (`id: 'rekordbox'`) and **Plex** (`id: 'plex'`) — stubs. Registered in the source registry with correct `id`/`name`/`contributes` but `sync()` throws `NotImplementedError`, which the route translates to HTTP 501.

## Data model

- **Entities**: `artist` (id, name), `release` (id, title, artist_id FK NOT NULL, year, country, label, catno), `track` (id, title, artist_id FK NOT NULL, album, duration_ms, release_id FK nullable, position). All FKs are real SQLite foreign keys with `PRAGMA foreign_keys = ON`.
- **Per-source plumbing**: `source_link`, `source_facets`, and `match_key` all carry an `entity_kind` discriminator that supports `'track' | 'release' | 'artist'`. Today, the adapters emit `release` + `track` rows; the `'artist'` entity kind is schema-level only — no adapter currently emits per-source artist records, but the constraints allow it.
- **Artist dedup**: at sync time, `upsertArtist(name)` normalizes via `squashAlphanumLower` and stores a `match_key` (entity_kind='artist', key_type='name_normalized'). On a freshly-migrated DB, artists have no match_keys yet — `upsertArtist` falls back to a case-insensitive `artist.name` lookup and backfills the match_key on first touch.
- **"(unknown)" sentinel artist**: guaranteed by migration 003. Any release/track without an artist string (e.g. iTunes track with no Artist tag) FKs to this row, so `artist_id NOT NULL` holds without nullable columns.

## Notable divergences from the original plan

- **Multi-source architecture (Slice 1, 2026-05-05).** Replaced the hardcoded-Discogs data layer with a generic source-adapter contract + SQLite-backed unified store. See `docs/superpowers/specs/2026-05-05-multi-source-architecture-design.md` and `docs/superpowers/plans/2026-05-05-multi-source-architecture.md`.
- **Library explorer (Slice 2, 2026-05-06).** Three-pane explorer (rail / list / detail) replaces the single-purpose add screen. Add flow folded into the explorer as `Add → Discogs`; `ConfirmModal` deleted in favor of a detail-pane CTA. New `source_state` table + `SyncChip`. URL state in `?nav`/`?id`/`?q`/`?entity`. Keyboard wiring rewritten to be DOM-driven (`installKeyboard(actions, guards)`). See `docs/superpowers/specs/2026-05-06-library-explorer-design.md` and `docs/superpowers/plans/2026-05-06-library-explorer.md`.
- **Slice 2 post-spec fixes** (folded in at the end of the slice):
  - **Sticky entity bug**: `explorerState.setNav()` now clears `entity` as well as `id` so switching from a tracks-mode rail item to a releases-mode item doesn't leave `currentEntity` stuck on tracks.
  - **Pagination root**: `Listview`'s `IntersectionObserver` is rooted on the sentinel's parent (`.body` scroller), not the viewport — pages now load past the first 200 rows.
  - **Effect cycle**: `listLoading` in `Explorer` demoted from `$state(false)` to plain `let` (read+write in the same effect was tripping `effect_update_depth_exceeded`).
  - **Search response shape**: `/api/discogs/search` returns `{ results: [...] }`, not a bare array; Explorer unwraps `res.results`.
  - **Persistent removal**: instance_id is now appended to `source_facets.instanceIds` on every successful add (in `/api/discogs/collection/add`); `/api/discogs/collection/remove` falls back to the facet when the body omits `instanceId`, so removal survives reloads.
  - **Detail-pane owned CTA**: was originally Slice-2 deferred. Shipped at session end — `ReleaseDetail` got a `variant: 'primary' | 'quiet'` prop and `Explorer` derives `releaseDetailCta` (quiet/Remove when owned, primary/Add for unowned hits).
  - **Arrow-key listview navigation**: was originally Slice-2 deferred. Shipped at session end — `moveDown`/`moveUp` focus row buttons via DOM, with search-input ↔ first-row transitions; `Enter` is context-aware (focused row → open, else → press Add CTA).
- **Token loading.** Plan used `process.env.DISCOGS_TOKEN`; switched to `$env/dynamic/private` so `.env` actually loads in dev.
- **Barcode lookup endpoint.** Plan added `/api/discogs/barcode/[code]` (Task 23). Built, tested, then **deleted** when scanner flow was unified onto `/api/discogs/search?q=`. The Discogs text search already indexes barcodes well enough.
- **No "in collection" feature in the plan.** Built post-MVP: SQLite `source_link` table + `collection.svelte.ts` store + `/api/library/membership?source=discogs` endpoint + row indicator via `SourceGrid`.
- **No URL persistence in the original plan.** Slice 2 expanded this into the full `?nav`/`?id`/`?q`/`?entity` URL-state contract.
- **No master/release deep-links in the plan.** External links are surfaced via per-source `SourcePanel` "open in <source>" links.
- **Cover thumbnails 80×80.** Plan said 40×40.
- **Catalog number** added to row metadata (plan didn't include `catno`).
- **Result sort by year ascending.** Plan returned Discogs's default ordering.
- **Scanner robustness.** Plan didn't anticipate `NotReadableError` from rapid camera re-acquire; retry-with-backoff was added.
- **Auto-focus search on load + Esc-to-blur** added (plan only had `/` to focus).
- **`normalize.ts` in `library/`.** The spec put normalization inline in `collate.ts`; extracted to `src/lib/server/library/normalize.ts` in the actual implementation.

## Backlog

Deferred features and not-yet-implemented work lives in the **Booth** Linear workspace: <https://linear.app/boothapp/team/BOO/backlog>. Issues are tagged by area (`adapters`, `ui`, `sync`, `matching`, `data-model`, `infra`) and kind (`feature`, `improvement`, `bug`).

## Known gaps in shipped code

Limitations of code that's currently in production. For deferred features and not-yet-implemented work, see the Linear backlog above.

- **No automated tests.** Verification is via `bun verify scripts/<name>.ts`, curl, sqlite3, and manual browser testing.
- **`Cmd+Z` is intercepted by the browser** when the search input is focused (it'll undo typed text first). The on-screen button and `u` key still work.
- **Source-grid on listview rows doesn't refresh after a Discogs-remove** for other rows of the same release still on screen. Only the currently-detail-open row updates. Likely benign until duplicate-release scenarios appear.

## Local development

```bash
cp .env.example .env
# paste DISCOGS_TOKEN (and optionally ITUNES_XML_PATH)
bun install
bun dev
# open http://localhost:5173
```

The DB is auto-initialized on first server boot — it creates `~/.booth/booth.db` (or `$BOOTH_DB_PATH`) and runs migrations automatically. An empty DB triggers initial Discogs and iTunes syncs via the boot hook in `src/hooks.server.ts` (fire-and-forget; happens in the background; iTunes only if `ITUNES_XML_PATH` is set).

Run a verification script: `bun verify scripts/<name>.ts` (bun runs TypeScript natively — no separate transpile step).

Type-check (no test runner): `bunx svelte-kit sync && bunx tsc --noEmit`.
