# booth — project context

> **Purpose:** Source-of-truth for what's currently shipped. Update at the end of each plan implementation; treat plans/specs in `docs/superpowers/` as historical blueprints, not current state.

## What it is

Single-user, local-only SvelteKit app for adding records to a personal Discogs collection, browsing the unified library, playing tracks, and **recording vinyl into the library**. Ways in: text search, webcam barcode scan, and recording a release from an audio interface. Keyboard-first, dark theme, no auth UI (token lives in `.env`). Data layer is a generic source-adapter system backed by local SQLite, with Discogs + a unified **`local`** file source (Apple Music.app import + vinyl rips) wired up and Rekordbox + Plex stubbed. Tracks backed by a local file play in-app through a built-in `<audio>` player.

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
# MUST be the auto-maintained export, NOT a one-off File → Library → Export
# Library… dump — Music.app never rewrites a manual export, so the local source
# silently re-imports a frozen snapshot forever (see stale-input detection under
# ## Sources). Music.app rewrites the shared XML on quit.
ITUNES_XML_PATH=

# Optional: override default DB location (defaults to ~/.booth/booth.db)
# BOOTH_DB_PATH=

# Optional: where vinyl rips are written (defaults to ~/.booth/recordings)
# BOOTH_RECORDINGS_PATH=
```

`ITUNES_XML_PATH` feeds the Apple-Music import path of the **`local`** source; it gates whether the `local` source auto-syncs on boot. Server env is read through `src/lib/server/env.ts` — a small accessor that prefers `$env/dynamic/private` but falls back to `process.env`. This matters because the dev server runs `bunx --bun vite dev` (the `--bun` flag is mandatory for `bun:sqlite`), and **under the Bun runtime SvelteKit's `$env/dynamic/private` comes back empty** (its dev-time injection only runs under Node); Bun instead loads `.env` straight into `process.env`. So `$lib/server/env` is the one place that imports the real `$env`; everything else (`api.ts`, `hooks.server.ts`, `db/index.ts`, the source syncs, `recording/env.ts`) imports `env` from it. Recording modules stay pure: `recording/env.ts` is the only recording module that reads env; it resolves `BOOTH_RECORDINGS_PATH` and passes the root into the pure `recording/*` modules.

## File map

```
src/
  app.css                                     dark-theme tokens + globals
  app.html                                    <title>booth</title>
  hooks.server.ts                             auto-sync-on-boot: iterates registry on the first request after server start and fires runSync() once per non-stub source (the `local` source is also gated on ITUNES_XML_PATH being set)
  lib/
    types.ts                                  DiscogsRelease, SessionEntry, ApiError, AddResponse
    keyboard.svelte.ts                        installKeyboard(actions, guards) — global keydown handler dispatching DOM-driven actions
    discogs/group.ts                          groupByMaster(hits) — pure: collapse Add → Discogs search hits into master groups (multi-version) + singletons (no-master / single-version); SearchHit = DiscogsRelease & {masterId}
    components/
      Explorer.svelte                         three-pane shell (rail / listview / detail); owns URL ↔ store sync, data fetching, add/remove handlers; mounts <Player /> + <PlayerBar />
      Rail.svelte                             left rail: Library / Sources / Add → Discogs sections
      Listview.svelte                         generic paginated row container; IntersectionObserver sentinel + selection state
      ListviewToolbar.svelte                  list header: search input + scanner btn + entity toggle (releases/tracks/artists) + sync chip + meta
      ReleaseList.svelte                      Listview wrapper bound to release rows
      TrackList.svelte                        Listview wrapper bound to track rows
      ArtistList.svelte                       Listview wrapper bound to artist rows (name + release/track counts + SourceGrid)
      ReleaseDetail.svelte                    right pane for a release; tracklist + per-source panels; optional add/remove CTA with variant; "⏺ Record from vinyl" CTA (onRecord prop) for Discogs-linked library releases (disabled via recordDisabled while a session is active)
      RecordSession.svelte                    full-pane capture overlay: device picker, live L/R meters + clip light + sample-rate readout (input preview), ⏺ record / ⏹ stop per side, "another side?" loop, hands off to ReviewSplits; minimizable during capture phases (onMinimize) → RecordingPill. `started` is derived from recorder.phase (not local) so a mid-capture remount restores the live UI instead of the picker. Closing with unsaved capture (mid-record or already-recorded takes) shows an inline discard-confirmation bar under the header; closing during setup or after a successful commit skips it. Device picker is a radio-style selection list (role=radiogroup), not a dropdown.
      RecordingPill.svelte                    floating bottom-left pill shown while a capture session is minimized; reads recorder phase/elapsed/takes for status (live timer / "side N ready" / "Splitting…"), click to expand; lifts above the PlayerBar when a track is loaded
      ReviewSplits.svelte                     per-take canvas waveform with draggable in/out region handles + synced editable track rows (assign, retitle, add-split, merge, ▶ region preview, ⎌ seam preview, ±nudge); "Save N tracks" commit + replace prompt
      TrackDetail.svelte                      right pane for a track; parent-release card + per-source panels
      ArtistDetail.svelte                     right pane for an artist; per-source panels + list of releases (click-through to release detail)
      SourceGrid.svelte                       4-dot "D/L/R/P" indicator (Discogs / Local / Rekordbox / Plex)
      SourcePanel.svelte                      per-source detail block (facets + external link or stub placeholder)
      SyncChip.svelte                         last-synced timestamp + click-to-sync; disabled for stub sources
      SyncRunHistory.svelte                   right-pane sync_run list shown when a Sources rail item is selected with no entity; one row per run (relative time, duration, summary or error)
      EmptyState.svelte                       centered "nothing here" placeholder
      SearchBar.svelte                        debounced text input; exports focus() / blur() / clear()
      Scanner.svelte                          ZXing camera viewfinder; retries NotReadableError up to 3×
      Toast.svelte                            bottom-center toast container
      SessionLog.svelte                       32px footer strip; only shown in Add → Discogs
      ShortcutOverlay.svelte                  `?` overlay listing shortcuts
      Player.svelte                           invisible <audio> element bound to /api/stream/{trackId}; bridges element events ↔ player store
      PlayerBar.svelte                        48px bottom transport bar (thumb, title/artist, play-pause, elapsed/total, seek scrubber); shown only while a track is loaded
    server/
      db/
        index.ts                              singleton bun:sqlite connection; reads BOOTH_DB_PATH or falls back to ~/.booth/booth.db
        migrate.ts                            reads migrations/*.sql, applies in order, tracks in _migrations
        migrations/
          001_init.sql                        core tables: release, track, source_link, source_facets, match_key, _migrations
          002_source_state.sql                source_state (source PRIMARY KEY, last_synced_at, last_summary)
          003_artist_entity.sql               artist table; release/track gain artist_id FK (denormalized artist text dropped); source_link/source_facets/match_key CHECK widened to include 'artist'
          004_sync_run.sql                    sync_run table (id, source, started_at, finished_at, summary JSON, error); indexed by (source, started_at DESC) for history queries
          005_cover_art.sql                   adds thumb_url TEXT and cover_url TEXT to release (nullable; NULL for local-only releases)
          006_local_source.sql                renames source='itunes' rows to 'local' across source_link/source_facets/source_state/sync_run (itunes→local merge)
          007_playlists.sql                   playlist + playlist_track tables (Booth-native organizational layer; not a source)
          008_playlist_cover.sql              adds playlist.cover_url (custom cover; NULL → UI-built mosaic)
      recording/                              vinyl capture → split → commit (all pure except env.ts)
        env.ts                                resolvedRecordingsRoot() — only recording module importing $env; reads BOOTH_RECORDINGS_PATH
        paths.ts                              pure path helpers: defaultRecordingsRoot, sessionTmpDir, sanitizeName, releaseDir
        wav.ts                                24-bit PCM WAV: createWav/appendFloat32/finalizeWav (chunked capture), readWavMeta, scanWav (RMS+peak envelope), extractRegionToFile (sample-exact slice)
        splitter.ts                           RMS envelope → noiseThreshold (median-of-lowest-k, "no-silence" guard) → findGaps / audioExtent; tunable constants (MIN_GAP_MS, PAD_MS, …)
        matcher.ts                            proposeRegions(rms, hop, sideBlocks) — contiguous in-order alignment: duration-snap when durations exist, count-constrained gap pick when missing, single-region fallback for beat-mixed; regions carry in/out + confidence
        session.ts                            in-memory session registry, take WAV paths under <root>/.tmp, stale-tmp sweep, loadExpectedTracks (groups tracks into side blocks via discogsPosition facet)
        commit.ts                             commitRegions: extract each region → .part → rename into place; one DB tx writing local source_link + file_path match_key + facets (origin:'vinyl', recordedAt, sampleRate, bitDepth, takeId, sourceDiscogsReleaseId) + duration backfill; conflict (replace) flow
      sources/
        types.ts                              MusicSource (with isStub), CollectionWritable, Playable + TrackStream (file|redirect) + isPlayable(), SourceTrack, SourceRelease, SyncResult
        registry.ts                           statically-populated source list; getSource(id), listSources()
        discogs/
          api.ts                              discogsFetch + DiscogsError; reads token via $env/dynamic/private
          username.ts                         lazy /oauth/identity username cache
          sync.ts                             full collection re-pull → SyncResult; populates instanceIds facet
          hydrateDiscogsTracks.ts             post-sync: fetch /releases/{id}.tracklist for Discogs releases lacking track rows → insert track rows (title, duration_ms when present, sequential position) + discogsPosition facet ("A1","B2"); merges onto existing local tracks via release_position. Called from sync_run after each discogs collate, and fire-and-forget on add.
          videos.ts                           fetchReleaseVideos(externalId) → release .videos[] (deduped by uri, YouTube ids parsed)
          youtube.ts                          parseYouTubeId(uri) — pure URL → video-id helper (youtube.com / youtu.be / music. / m.)
          format.ts                           buildFormatLabel(formats[]) — pure: rich "Vinyl, LP, Album, Clear, 180g" string from a search result's formats[] (name + descriptions + text)
          index.ts                            discogsSource: MusicSource & CollectionWritable
        local/                                (formerly itunes/) the unified local-files source
          parse.ts                            plist/XML → typed Apple Music records
          sync.ts                             parses Library.xml → SyncResult; emits emergent releases (Apple-Music ingest path of the local source)
          index.ts                            localSource (id:'local', name:'Local'): MusicSource & Playable; resolveTrackStream → {kind:'file'} via the track's file_path match key (serves both Apple-import and vinyl-rip files; .wav mime added)
        rekordbox/
          index.ts                            stub: isStub=true; sync() throws NotImplementedError
        plex/
          index.ts                            stub: isStub=true; sync() throws NotImplementedError
      library/
        normalize.ts                          normalization helpers for match keys (artist_album_year, file_path, artist_name)
        collate.ts                            post-sync: maps SyncResult → entity + source_link upserts; writes source_state. Exports upsertArtist(db, name) for callers outside collate (e.g. Discogs add path) that need to resolve an artist string to an artist row id.
        queries.ts                            listReleases / listTracks (paginated), getReleaseDetail / getTrackDetail, listSourcesWithState, getMembershipExternalIds. All release/track selects JOIN the artist table and alias artist.name AS artist so the wire shape is unchanged. Computes `playableSources` once from listSources().filter(isPlayable) and tags every track row with canPlay.
        sync_run.ts                           runSync(db, sourceId) wraps adapter.sync + collate, writes a sync_run row (start row up front, summary or error on completion); listSyncRuns(db, source, limit) reads recent runs. Used by /api/sources/[id]/sync, the boot hook, and the runs endpoint.
    stores/
      session.svelte.ts                       in-memory session log (entries, count, last)
      toast.svelte.ts                         toast queue with auto-dismiss + retry actions
      collection.svelte.ts                    client mirror of Discogs membership (Set<releaseId>); fetches /api/library/membership?source=discogs
      explorerState.svelte.ts                 singleton mirror of URL params ?nav / ?id / ?q / ?entity; hydrate() + serialize()
      player.svelte.ts                        in-memory now-playing state (trackId/title/artist/thumbUrl, isPlaying, currentTime, duration); play/pause/resume/seekTo/stop; _-prefixed bridge methods set by Player.svelte
      recorder.svelte.ts                      recording session state machine (idle→arming→preview→recording→analyzing→reviewing→committing→done); owns getUserMedia + AudioWorklet capture, chunked PCM upload, live L/R meters, per-take split proposals, commit
  static/
    pcm-recorder-worklet.js                   AudioWorklet processor: emits interleaved-stereo Float32 PCM frames off the audio thread during recording
  routes/
    +layout.svelte                            imports app.css; mounts <Toast />
    +page.svelte                              mounts <Explorer> + <ShortcutOverlay>; setup gate; installKeyboard with DOM-driven actions
    api/
      sources/
        +server.ts                            GET → [{ id, name, isStub, lastSyncedAt, lastSummary }] for the rail Sources section
        [id]/sync/+server.ts                  POST → runSync(getDb(), id) → return summary; 404 unknown, 501 stub
        [id]/runs/+server.ts                  GET ?limit= → { items: SyncRunRow[] } recent sync_run rows for the given source (default 20, max 200)
        discogs/releases/[id]/videos/+server.ts  GET → { videos: [{url,title,youtubeId}] } for a release ULID; resolves ULID→Discogs external_id, fetches /releases/{id}.videos[]; empty when no discogs link/videos
      library/
        tracks/+server.ts                     GET ?source=&q=&multiSource=&limit=&offset=  paginated tracks
        tracks/[id]/+server.ts                GET → { track, sources, facets, release, sourceMeta } for TrackDetail
        releases/+server.ts                   GET ?source=&q=&multiSource=&limit=&offset=  paginated releases
        releases/[id]/+server.ts              GET → { release, sources, facets, tracks, sourceMeta } for ReleaseDetail
        artists/+server.ts                    GET ?source=&q=&multi_source=&limit=&offset=  paginated artists (each row: name + releaseCount + trackCount + sources[])
        artists/[id]/+server.ts               GET → { artist, sources, facets, releases, trackCount } for ArtistDetail
        membership/+server.ts                 GET ?source=discogs  → set of external_ids (Discogs release-id strings)
      recordings/
        sessions/+server.ts                   POST {releaseId} → create capture session; hydrates tracklist if missing; returns { sessionId, tracks, sides }
        sessions/[id]/+server.ts              DELETE → cancel session + clean temp takes
        sessions/[id]/takes/+server.ts        POST {sampleRate,channels} → start a take (creates the growing WAV); returns { takeId }
        sessions/[id]/takes/[takeId]/chunk/+server.ts     POST (raw float32 body) → append PCM to the take WAV
        sessions/[id]/takes/[takeId]/finalize/+server.ts  POST → finalize WAV, scan envelope, run matcher → { durationMs, sampleRate, peaks, regions, sideGuess }
        sessions/[id]/takes/[takeId]/audio/+server.ts     GET ?startMs=&endMs= → audio/wav slice for region/seam preview
        sessions/[id]/commit/+server.ts       POST {regions, replace} → commitRegions; 409 {conflicts} when already ripped and replace=false
      discogs/
        search/+server.ts                     GET ?q= — live text search (per_page 100, vinyl-only: keeps results whose format includes "Vinyl"); returns { results: […] } each with a rich format string built from formats[] (color/weight via formats[].text, e.g. "Vinyl, LP, Album, Clear, 180g") + masterId for client-side master grouping; sorted by year asc
        releases/[id]/+server.ts              GET → { formatText, notes, identifiers[] } from the full /releases/{id} endpoint; background-fetched by the add-flow detail pane to enrich a search hit (format text + pressing notes + the "Barcode and Other Identifiers" list)
        collection/
          add/+server.ts                      POST {releaseId,…} — adds to Discogs; writes source_link + appends instance_id to source_facets.instanceIds
          remove/+server.ts                   DELETE {releaseId, instanceId?} — removes from Discogs; instanceId optional (falls back to source_facets.instanceIds[0])
      stream/
        [trackId]/+server.ts                  GET → resolves a track's playable source via resolveTrackStream; 302 for {kind:'redirect'}, HTTP-range file stream (206/416) for {kind:'file'}; 404 when no source resolves
      artwork/
        [filename]/+server.ts                 GET → serves cached cover art from ~/.booth/artwork/ (path-traversal-guarded, immutable cache)
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
- **Sources rail items**: one per registered source (`discogs`, `local`, `rekordbox`, `plex`); stubs render `EmptyState`. (Discogs *does* index tracks — `hydrateDiscogsTracks` pulls tracklists post-sync — so the tracks lens is populated for Discogs releases.)
- **Add rail item**: `add:discogs` — Discogs live search, release-only by nature (the search API doesn't return tracks); toolbar omits the entity toggle here. Results are **vinyl-only** and **master-grouped** (see Search below).
- **Entity lens (releases ↔ tracks ↔ artists)**: app-wide viewing toggle, lives in the listview toolbar and is bound to `Tab` (cycles forward 3-way). Persists across rail switches (it's a lens, not a per-rail attribute). Detail pane keeps its open entity when the lens flips — the listview switches independently. URL: `?entity=releases|tracks|artists` (omitted when equal to the default `releases`).
- **Listview**: lazy pagination via `IntersectionObserver` sentinel rooted on the scroll container (`?limit=200&offset=…`); row click selects + opens detail.
- **Detail**: cover image (or grey placeholder for releases with no URL), title/artist/year, optional CTA, then per-source panels (`SourcePanel`) for all registered sources, then tracklist (releases only). Stub sources still render a "not implemented" panel.
- **SourceGrid**: 4-dot indicator (D / L / R / P) shown on every row and in detail context to communicate which sources contribute to a given entity.
- **SyncChip** (in toolbar when a Sources rail item is selected): "last synced Nm ago" → click triggers `POST /api/sources/:id/sync` and flips to "Syncing…"; updates timestamp on completion. Stubs render as a disabled "Not implemented" chip.

### Search
- **Library / Sources searches** (Library, Sources rail items): the toolbar search input filters the current listview via `?q=` on `/api/library/releases` or `/api/library/tracks`. Server-side `LIKE` over title + artist; pagination resets.
- **Add → Discogs search**: same toolbar input, but query goes to `/api/discogs/search?q=` (returns `{ results: [...] }` sorted ascending by year, nulls last). **Vinyl-only** (the server keeps results whose format includes "Vinyl", dropping CD/Cassette/File). Each result carries a rich format string assembled from `formats[]` (color/weight, e.g. "Vinyl, LP, Album, Clear, 180g") so the **list rows** show the same detail as the detail pane — no per-release fetch needed.
- **Master grouping + drill-in** (Add → Discogs, `ReleaseList`/`Explorer`): results are grouped client-side by `masterId` (`$lib/discogs/group.ts`). A master with ≥2 surfaced pressings collapses to one "N versions ›" row; clicking it (or `Enter`) drills the list into that master's versions under a `← N versions of "…"` breadcrumb (`Esc` or the breadcrumb pops back). No-master releases and single-version masters render as normal rows you click straight to detail/add. Drill state (`drillMasterId`) is ephemeral client state — a new search resets it; the versions come from the in-memory hits (no extra API calls), so each keeps its color/weight. `per_page` is 100 so a focused album search surfaces every vinyl version of the relevant masters. A master row's owned dot fills when any of its versions is in the collection.
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

### Playback
- **In-app audio player** for tracks backed by a `Playable` source. Today only the **`local`** source is `Playable` (local files — Apple-Music imports + vinyl rips); Discogs is not.
- **`Playable` interface** (`sources/types.ts`): `resolveTrackStream(entityId, db): Promise<TrackStream | null>`, where `TrackStream = { kind: 'file', path, mimeType } | { kind: 'redirect', url }`. `isPlayable(source)` narrows a source. The `local` source resolves via the track's `file_path` match key → `{ kind: 'file' }`, MIME inferred from the file extension (incl. `.wav` for rips).
- **`canPlay` flag**: `queries.ts` computes `playableSources` once from `listSources().filter(isPlayable)`; every track row carries `canPlay = sources.some((s) => playableSources.has(s))`. Gates whether a row's play affordance is live.
- **Stream endpoint** `GET /api/stream/[trackId]`: looks up the track's source links, filters to playable sources, calls `resolveTrackStream` until one returns non-null. `file` → byte-range-capable response (206/416 honoured for seeking); `redirect` → 302 to the URL. 404 when nothing resolves.
- **Client**: `stores/player.svelte.ts` holds now-playing state. `Player.svelte` is an invisible `<audio>` bound to `/api/stream/{trackId}` that bridges element events back to the store. `PlayerBar.svelte` is a 48px bottom transport bar (thumb, title/artist, play-pause, elapsed/total, seek scrubber) shown only while a track is loaded. Both mounted in `Explorer.svelte`.
- **Affordance**: double-click a track row (in `TrackList` or the `ReleaseDetail` tracklist) plays it when `canPlay`; the playing row shows ▶. `Space` toggles play/pause. `TrackDetail` has no play control today.
- **`{ kind: 'redirect' }` caveat**: only suits direct-audio URLs the `<audio>` element can load — not YouTube watch pages, which need an iframe. No source emits redirect streams yet.

### Release videos
- **Discogs release detail lazy-loads YouTube videos.** `ReleaseDetail.svelte` fetches `/api/sources/discogs/releases/{id}/videos` when a release with a Discogs `source_link` opens, and renders a list of `<iframe>` embeds (`loading="lazy"`, `youtube-nocookie.com`), each captioned with the Discogs video title. A `$effect` keyed on `release.id` cancels stale fetches when the user switches releases.
- **Server**: `fetchReleaseVideos(externalId)` (`discogs/videos.ts`) calls the full `/releases/{id}` Discogs endpoint and returns its `.videos[]`, deduped by uri (Discogs sometimes repeats one); `parseYouTubeId` (`discogs/youtube.ts`, pure) resolves the embeddable id. A non-YouTube uri renders as a plain link instead of an embed.
- **Endpoint** returns `{ videos: [] }` (not 404) when the release has no Discogs link or no videos; a Discogs 429 surfaces as HTTP 429.
- **Release-level only** — no tracklist matching. Discogs `.videos[]` aren't mapped to specific tracks, so there are no per-track play buttons here (this is the deliberately-scoped version of the Discogs "Playable" idea).

### Pressing notes & identifiers (Add → Discogs)
- **The add-flow release detail surfaces Discogs `notes` + the "Barcode and Other Identifiers" list** so a record can be identified (matrix/runout, barcode, label code) without opening discogs.com. Shown only on Add → Discogs search-hit detail panes — the data rides on the background `/api/discogs/releases/{id}` fetch the add flow makes, so it costs no extra Discogs request. (Format/color is **not** sourced here anymore — it rides on the search hit via `formats[].text`; the background fetch now supplies only `notes` + `identifiers`.)
- `ReleaseDetail.svelte` renders a "Barcode & identifiers" block (one `type` / `value` / optional `description` row each, value in mono) and a pre-wrapped "Notes" block, gated on the data being present (`notes` / `identifiers` props default empty, so library/non-Discogs releases show nothing). `Explorer.loadDetail` merges `notes`/`identifiers` from the endpoint into `detailData`. Notes render as-is (no BBCode parsing). The `.identify` block has bottom margin so Notes doesn't butt against the next panel.
- **"View on Discogs ↗" link** in the release-header (`ReleaseDetail.svelte`), gated on a discogs `source_link` with an `external_url` — present for both add-flow hits and library releases. (Distinct from the per-source `SourcePanel` "open in Discogs" link lower in the pane; this is the discoverable one up top.)

### Vinyl recording
- **Goal**: record a vinyl release from an audio interface into the library, smart-split each side into per-track regions, review/adjust, save as lossless local files. Entry: "⏺ Record from vinyl" CTA on a Discogs-linked library release's detail pane → full-pane `RecordSession` overlay. Spec/plan: `docs/superpowers/specs/2026-06-10-vinyl-recording-design.md`, `docs/superpowers/plans/2026-06-10-vinyl-recording.md`.
- **Capture**: in-browser `getUserMedia` (DSP disabled: echoCancellation/noiseSuppression/autoGainControl false) → `AudioWorklet` (`static/pcm-recorder-worklet.js`) emits Float32 PCM → streamed in ~1s chunks to the server, appended to a growing 24-bit WAV under `<recordings>/.tmp/<session>/take-N.wav`. **Setup state** shows a live input preview with no disk writes: dB-scaled L/R meters over a −60→0 dBFS scale, a green target band (peak −12…−6 dBFS, the "Safe" profile in `src/lib/loudness.ts`), a non-decaying peak-hold marker + readout per channel (Reset-peak button), and a status light (TOO LOW / LOW / GOOD ✓ / HOT / CLIP) classified on the held peak. Clicking "⏺ Record side N" while the held peak is low/too-low/clipping shows a soft, non-blocking "level looks low — record anyway?" confirm so a too-quiet input is caught before a long side is captured. Gain itself is physical (interface/preamp); `autoGainControl` stays false and no software make-up gain is applied.
- **Session model**: one recording (take) per side, with an "another side?" loop (handles 7″ → 2×LP). The user does not declare which side a take is — the matcher proposes.
- **Splitting (server-side)**: on finalize, `scanWav` builds an RMS envelope; `splitter.ts` finds candidate gaps relative to the take's own noise floor; `matcher.ts` aligns regions to the release's expected tracks (read locally from the `track` table + `discogsPosition` facet, grouped into side blocks). Durations present → snap predicted boundaries to gaps; durations missing → count-constrained gap pick; beat-mixed/no gaps → single region for manual splitting. Each track is a region with independent in/out points (PAD_MS into the silence); inter-track silence, lead-in, run-out are trimmed.
- **Minimize while capturing**: during the capture phases (`preview`/`recording`/`analyzing`) the overlay can be minimized to a floating `RecordingPill` (bottom-left) so the user can keep browsing while a long side records. This works for free because the entire capture pipeline (AudioContext, worklet, chunked upload, meter loop, `livePeaks`) lives in the module-level `recorder` store, not in `RecordSession` — minimizing just unmounts the view; capture keeps running and the pill restores it. The session is a single global one, so the "⏺ Record from vinyl" CTA is disabled on all releases while one is active (`recorder.start()` also guards double-start). Split review/commit are not minimizable. A hard page reload still loses an in-progress take (kills the AudioContext) — same as before.
- **Review** (`ReviewSplits.svelte`): canvas waveform per take with draggable in/out handles + synced editable rows (assign track, retitle, add-split, merge, ▶ region preview, ⎌ seam preview, ±10ms/±1s nudge). Confidence dots flag low-confidence boundaries. Region/seam preview streams a WAV slice from the take via `…/audio?startMs=&endMs=`.
- **Commit** (`commitRegions`): extracts each region to a final 24-bit WAV at `<recordings>/<Artist> — <Album> [<catno>]/<NN Title>.wav` (written to `.part` then renamed), and in one DB transaction attaches a `local` source_link (`external_id` = path) + `file_path` match key + facets (`origin:'vinyl'`, …) onto the existing Discogs track entity, backfilling `duration_ms`. On failure, moved files are removed (no half-saved release). Re-ripping returns 409 `{conflicts}` unless `replace:true`. Playback is immediate via the existing `Playable` stream path — no new playback code.
- **Verify scripts**: `verify-wav.ts` (round-trip + region extraction), `verify-splitter.ts` (gap/region/matcher cases), `verify-local-merge.ts` (migration + prune scoping), `verify-commit.ts` (commit path: files + DB rows + conflict/replace).

### Playlists
- **Booth-native organizational layer over the unified `track` table** — *not* a source. `playlist` + `playlist_track` tables (migration `007`); a track appears at most once per playlist (`PRIMARY KEY (playlist_id, track_id)`), `ON DELETE CASCADE` on both FKs. Playlists never touch `source_link`/`match_key`/`source_facets`. Playback is unchanged — double-click plays a single track; no queue/auto-advance yet (fast-follow).
- **Rail Playlists section** (after Library): lists playlists (name + track count) with a ＋ New playlist inline input. Selecting one sets `?nav=playlist:<id>`. Items are drop targets for drag-to-add (`application/x-booth-track` dataTransfer).
- **`PlaylistView`** (middle pane) renders the open playlist's tracks as a tabular list — `cover · Track · Artist · Release · Length · ×` with a column-header strip. Rows mirror the `.body button.row-btn[data-id]` shape so the global arrow-nav / `a` / `Delete` keyboard wiring works unchanged. Cover thumbnail (grey placeholder + ▶ badge when playing), inline rename, playlist delete-with-confirm, double-click play, native HTML5 drag-to-reorder. Non-playable (e.g. Discogs-only) tracks render dimmed. The entity lens (`Tab`) is irrelevant here — playlists are tracks-only.
- **Detail in playlist view.** Track-row clicks show no detail — only highlight, for arrow-key nav (`loadDetail` early-returns for the `playlist` section). The track list fills the width (`.explorer.no-detail` → `220px 1fr`) **until** you click the **Artist** or **Release** column, which opens a dedicated right pane reusing `ReleaseDetail`/`ArtistDetail`. State is `plDetail` + `openPlaylistEntity(kind, id)` in Explorer (separate from the main `detailKind`/`detailData`); the two link-details cross-link to each other, `← Close` dismisses, and it clears on rail change. `getTracksByIds` returns `artist_id` (added) so the artist column can link; the release column links via the existing `release_id`.
- **Removing a track** (the row `×` or the `Delete` key) routes through a centered confirm modal, coordinated by `playlists.pendingRemove` so both triggers share one dialog (`requestRemove` → `confirmRemove`/`cancelRemove`).
- **Cover art**: each playlist has a cover — a custom uploaded image (`playlist.cover_url`, migration 008) or, when null, a client-built **mosaic** of up to 4 distinct track covers (≥4 → 2×2 grid; 1–3 → first cover; 0 → ♪ placeholder). `PlaylistCover.svelte` renders it (small in the rail, ~112px in the header). Upload by clicking or dropping an image on the header cover → `POST /api/playlists/[id]/cover` validates type/size and writes `~/.booth/artwork/playlist-<id>.<ext>` (served by the existing `/api/artwork` endpoint; the returned URL carries `?v=<ts>` to bust the immutable cache on replace); `DELETE` removes the file and reverts to the mosaic. `listPlaylists`/`getPlaylist` return `coverUrl` + `mosaic` (the latter built by `mosaicFor`, distinct by release thumb so a one-album playlist shows a single cover). No server-side image processing or new deps.
- **Add paths**: drag a track row (`TrackList` or the `ReleaseDetail` tracklist) onto a rail playlist, or focus a track row and press `a` to open `PlaylistPicker` (filter + create-and-add). Dedupe surfaces an "Already in playlist" toast. Dragging uses a translucent drag image (`src/lib/dnd.ts`'s `translucentDragImage`) so the rail drop target — outlined in accent while hovered — stays visible behind the dragged row.
- **Server**: `library/playlists.ts` (list/create/rename/delete/getPlaylist/addTrack/removeTrack/reorderTracks). `getPlaylist` reuses `queries.getTracksByIds` so `canPlay` matches the rest of the app. Add/remove/reorder renumber positions to a contiguous `0..n` in a transaction. Routes: `GET|POST /api/playlists`, `GET|PATCH|DELETE /api/playlists/[id]`, `POST|PATCH /api/playlists/[id]/tracks`, `DELETE /api/playlists/[id]/tracks/[trackId]`. The add route guards the FK targets so a bad playlist/track id returns 404 (not a 500 from the join's foreign keys).
- **Client store** `stores/playlists.svelte.ts` mirrors `items` (rail) + `openPlaylist` (current view); mutations update both, so `PlaylistView` and the global keyboard actions read one reactive source. Reorder is optimistic.
- **Known limitation**: membership keys on track ULID — if a Discogs re-sync ever deletes+recreates a track row, the cascade drops it from playlists (local/vinyl ids are stable). Spec/plan: `docs/superpowers/specs/2026-06-13-playlists-design.md`, `docs/superpowers/plans/2026-06-14-playlists.md`. Future directions tracked there: playback queue (nearest fast-follow), DJ/crate prep, export/sync to external systems, broader library organization.

### URL state
- Four params, mirrored by `explorerState.svelte.ts` singleton:
  - `?nav=<rail-item>` — e.g., `library:all`, `sources:discogs`, `add:discogs`, `playlist:<id>` (a playlist rail item; middle pane shows `PlaylistView`). Source of truth for which rail item is selected. Legacy `library:all-releases` / `library:all-tracks` URLs are redirected to `library:all` on hydrate, carrying their entity-kind through as `?entity=`.
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
- `[` / `]` select the previous / next rail item (DOM-driven: clicks the adjacent `.rail button.item`).
- `Space` toggles play/pause for the loaded track (no-op when nothing is playing; suppressed when focus is in an input/textarea).
- `Enter` — context-aware: on a focused row, opens its detail (same as clicking); otherwise clicks the visible primary Add CTA.
- `Esc` closes scanner overlay; otherwise clears search-input value, then blurs it.
- `u` or `Cmd/Ctrl+Z` — prefer visible detail-pane Remove (handles persistent removal via facet); else undoes most-recent session add.
- Auto-focus on search bar on initial page load.
- Keyboard wiring is DOM-driven: `installKeyboard(actions, guards)` in `+page.svelte` looks up elements by class (`input.search`, `.body button.row-btn`, `button.add-btn`, `button.remove-btn`, `.scanner-overlay`, `.bar .toggle`) at event time rather than holding component refs.

### Sources
- **Manual sync:** `POST /api/sources/:id/sync` invokes `runSync()` — the named adapter's `sync()`, collated into SQLite, with a row written to `sync_run` (start row up front, summary or error captured on completion). Returns the summary `{ rowsIn, releasesUpserted, tracksUpserted, releasesDeleted, tracksDeleted, conflicts }`. Returns 404 for an unknown id, 501 if the adapter's `sync()` throws `NotImplementedError`.
- **Auto-sync on boot:** `src/hooks.server.ts` fires `runSync()` once per non-stub source on the first request after server start (fire-and-forget; the `local` source additionally requires `ITUNES_XML_PATH` to be set, since its `sync()` is the Apple-Music XML parse). Runs are written to `sync_run` like any other invocation. This means every server restart refreshes the library — so data stays current without the user touching the chip, at the cost of one Discogs API pull + Apple-Music XML parse per restart.
- **Sync history:** `GET /api/sources/:id/runs?limit=` returns recent `sync_run` rows for a source. The `SyncRunHistory` component renders this in the right pane whenever a Sources rail item is selected without an entity highlighted; an in-flight sync from the toolbar chip shows a "Running…" row on top and the history refetches on completion.
- **Stale-input detection (file-backed sources):** an adapter may return `input: { path, mtime, generatedAt? }` on its `SyncResult` describing the file it parsed (`SyncInput` in `sources/types.ts`). `runSync` persists that into `sync_run.summary` and compares `mtime` against the most recent prior run of the same source; an unchanged file sets `summary.stale = true`. `SyncRunHistory` renders those runs with a ⚠ and an amber "<file> Nd old — unchanged since the previous sync" line. **Why this exists:** the `local` adapter re-parses whatever `ITUNES_XML_PATH` points at, so a frozen export produces a byte-identical clean summary forever — indistinguishable from a healthy no-op. That failure mode hid a three-month import gap (2026-05-05 → 2026-08-13) behind a green sync history. The flag is a warning, not an error: the run genuinely succeeded, it just can't have imported anything new. Verified by `scripts/verify-stale-input.ts`.
- **Inspection endpoints:**
  - `GET /api/library/tracks?source=&limit=` — tracks from the unified store, optionally filtered by source.
  - `GET /api/library/releases?source=&limit=` — releases from the unified store.
  - `GET /api/library/membership?source=discogs` — set of Discogs `external_id` strings for releases currently in the collection. This is what `collection.svelte.ts` fetches to populate the "in collection" badge.
- **Adapters:**
  - **Discogs** (`id: 'discogs'`) — real, full read+write via `CollectionWritable`. Syncs the entire collection folder via paginated Discogs API. Writes (add/remove) go through to both Discogs and the SQLite `source_link` table. Not `Playable` (release-only; no local audio).
  - **Local** (`id: 'local'`, formerly `itunes`) — real, file-backed, the unified home for on-disk audio. Track `external_id` is the XML's **`Persistent ID`**, never its `Track ID`: Music.app renumbers Track IDs when the library is purged or re-exported, and a changed `external_id` used to prune the link and cascade-delete the entity behind it (924 tracks lost on 2026-08-14 — see stale-input/relink notes). `parse.ts` surfaces both; `trackId` is diagnostics-only. Two ingest paths: (1) **Apple Music.app import** — `sync()` parses `ITUNES_XML_PATH` Library.xml via the `plist` package, contributing tracks with file-path match keys and emergent releases grouped by `(Album Artist || Artist, Album, Year)` (synthetic release `external_id`s are deterministic hashes of the normalized group key; track facets `rating`, `playCount`, `dateAdded`, `kind`, `bitRate`, `sampleRate`, `genre`); (2) **vinyl rips** — written by the recording feature (`commitRegions`), attaching a `local` source_link (`external_id` = absolute WAV path) + `file_path` match key + `origin:'vinyl'` facets onto the existing Discogs track entity. Implements `Playable` — `resolveTrackStream` returns `{ kind: 'file' }` from the `file_path` match key (serves both ingest paths). **Origin is inferred from the path** (under the recordings root → vinyl rip), and `collate`'s prune is scoped so an Apple-Music re-sync never deletes vinyl rips (which are absent from the XML).
  - **Rekordbox** (`id: 'rekordbox'`) and **Plex** (`id: 'plex'`) — stubs. Registered in the source registry with correct `id`/`name`/`contributes` but `sync()` throws `NotImplementedError`, which the route translates to HTTP 501.

## Data model

- **Entities**: `artist` (id, name), `release` (id, title, artist_id FK NOT NULL, year, country, label, catno, thumb_url, cover_url), `track` (id, title, artist_id FK NOT NULL, album, duration_ms, release_id FK nullable, position). All FKs are real SQLite foreign keys with `PRAGMA foreign_keys = ON`.
- **Per-source plumbing**: `source_link`, `source_facets`, and `match_key` all carry an `entity_kind` discriminator that supports `'track' | 'release' | 'artist'`. Today, the adapters emit `release` + `track` rows; the `'artist'` entity kind is schema-level only — no adapter currently emits per-source artist records, but the constraints allow it.
- **Moved external_ids relink, they don't delete**: when `upsertSourceLink` finds the entity already holds a *different* `external_id` for the same source, the outcome depends on how the entity was matched. A `file_path` match is authoritative — the same bytes on disk — so the link's `external_id` is rewritten in place and counted in `summary.relinked`. Weaker matches (`release_position`, `artist_album_year`) are genuinely ambiguous (two source records competing for one entity), so the existing link is left alone and counted in `summary.conflicts`. **Why:** these used to share the skip path. A renumbered Apple-Music Track ID was therefore never re-linked, the following `pruneSource` deleted the now-stale link, the entity lost its last `source_link` and was deleted along with its match_keys, facets and **playlist membership** (`ON DELETE CASCADE`). Covered by `scripts/verify-id-churn.ts`, which asserts the entity id and playlist rows survive a renumber while a genuine removal still prunes.
- **Artist dedup**: at sync time, `upsertArtist(name)` normalizes via `squashAlphanumLower` and stores a `match_key` (entity_kind='artist', key_type='name_normalized'). On a freshly-migrated DB, artists have no match_keys yet — `upsertArtist` falls back to a case-insensitive `artist.name` lookup and backfills the match_key on first touch.
- **"(unknown)" sentinel artist**: guaranteed by migration 003. Any release/track without an artist string (e.g. iTunes track with no Artist tag) FKs to this row, so `artist_id NOT NULL` holds without nullable columns.

## Notable divergences from the original plan

- **Vinyl recording + `itunes`→`local` merge (2026-06-10).** Added vinyl capture→split→commit (`recording/*`, `/api/recordings/*`, `RecordSession`/`ReviewSplits`, `recorder` store, PCM worklet). Renamed the `itunes` source to a unified **`local`** file source (migration 006) whose `sync()` is the Apple-Music XML import and whose second ingest path is vinyl rips; `collate`'s prune is now origin-scoped (a re-sync can't delete rips). The splitter's noise floor is the median-of-lowest-k (not a percentile) with a "no-silence" guard, because inter-track silence is a tiny fraction of a side. See `docs/superpowers/specs/2026-06-10-vinyl-recording-design.md` + plan.
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
- **Token loading.** Plan used `process.env.DISCOGS_TOKEN`; switched to `$env/dynamic/private`, then (2026-06-14) routed all server env reads through `src/lib/server/env.ts`, which prefers `$env/dynamic/private` but falls back to `process.env`. Under the Bun dev runtime (`bunx --bun vite dev`, required for `bun:sqlite`) SvelteKit's `$env/dynamic/private` is empty; Bun populates `process.env` from `.env`, so the fallback is what actually resolves `DISCOGS_TOKEN` / `ITUNES_XML_PATH` / etc. in dev.
- **Barcode lookup endpoint.** Plan added `/api/discogs/barcode/[code]` (Task 23). Built, tested, then **deleted** when scanner flow was unified onto `/api/discogs/search?q=`. The Discogs text search already indexes barcodes well enough.
- **No "in collection" feature in the plan.** Built post-MVP: SQLite `source_link` table + `collection.svelte.ts` store + `/api/library/membership?source=discogs` endpoint + row indicator via `SourceGrid`.
- **No URL persistence in the original plan.** Slice 2 expanded this into the full `?nav`/`?id`/`?q`/`?entity` URL-state contract.
- **No master/release deep-links in the plan.** External links are surfaced via per-source `SourcePanel` "open in <source>" links.
- **Cover thumbnails 80×80.** Plan said 40×40.
- **Cover art (2026-06-02).** `thumb_url` and `cover_url` columns added to `release`; Discogs sync populates both; `upsertRelease` UPDATE uses `COALESCE(?, col)` so iTunes syncs don't wipe Discogs-sourced URLs. `ReleaseList` renders 40×40 thumbnails; `ReleaseDetail` renders full-width cover. iTunes-only releases show grey placeholder. Explorer.svelte maps snake_case API fields (`thumb_url`) to camelCase (`thumbUrl`) for search hits; library items are mapped at load time.
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
- **Playback affordance is on list/tracklist rows only.** `TrackDetail` (the track right-pane) has no play control; only `TrackList` rows and the `ReleaseDetail` tracklist support double-click-to-play.
- **Only `local`-backed tracks are playable.** A track with no `file_path` match key (e.g. a Discogs release with no Apple-import or vinyl-rip file) has `canPlay = false` and no play affordance.

## Local development

```bash
cp .env.example .env
# paste DISCOGS_TOKEN (and optionally ITUNES_XML_PATH)
bun install
bun dev
# open http://localhost:5173
```

The DB is auto-initialized on first server boot — it creates `~/.booth/booth.db` (or `$BOOTH_DB_PATH`) and runs migrations automatically. Every server boot triggers a fresh sync for every non-stub source via the boot hook in `src/hooks.server.ts` (fire-and-forget; the `local` source's Apple-Music parse only runs if `ITUNES_XML_PATH` is set). Vinyl rips are written to `$BOOTH_RECORDINGS_PATH` (default `~/.booth/recordings`).

Run a verification script: `bun verify scripts/<name>.ts` (bun runs TypeScript natively — no separate transpile step).

Type-check (no test runner): `bunx svelte-kit sync && bunx tsc --noEmit`.
