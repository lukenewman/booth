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
- **Dev:** `bun dev` (binds 5173, falls back upward). **Production:** `bun run build && bun start` — `adapter-node` output run under Bun (port 3000, override with `PORT`). The Bun runtime is not optional in either mode: the DB layer is `bun:sqlite`.

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
    queue.ts                                  pure queue arithmetic + PlaybackContext/LibraryQuery types (nextIndex, prevTarget, PREV_RESTART_THRESHOLD_S)
    playback.ts                               pure track-vs-player state (trackPlayState / transportGlyph / transportLabel)
    discogs/group.ts                          groupByMaster(hits) — pure: collapse Add → Discogs search hits into master groups (multi-version) + singletons (no-master / single-version); SearchHit = DiscogsRelease & {masterId}
    components/
      DesktopShell.svelte                     three-pane view (rail / listview / detail); mounts <Player /> + <PlayerBar />. Thin: all logic lives in explorerController, which it reads through $derived aliases so the markup stays shell-agnostic. Owns only desktop view state (scanner popover, grid/list toggle, record session)
      ReleaseGrid.svelte                      cover-art grid for the releases lens; the default release view (see Release grid view below)
      MobileShell.svelte                      bottom-tab view over the same explorerController, mounted below 768px; push navigation instead of a detail pane
      mobile/TabBar.svelte                    fixed bottom tab bar (Library / Playlists / Add / Search)
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
      StarButton.svelte                       shared ★ toggle bound to the annotations store; hover-revealed in rows (always visible once set, and always visible in PlayerBar), 44×44 target below 768px
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
          009_stars.sql                       adds track.starred_at + release.vetted_at (nullable ISO8601) + partial indexes; Booth-native annotations, not source data
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
        annotations.ts                        setTrackStar / setReleaseVetted / countStarredByRelease — the star + vetted layer. Never touches source_link/facets/match_key, never bumps updated_at (that tracks source freshness, not user judgment). Re-star COALESCEs so a double-fire can't rewrite the original timestamp.
        sync_run.ts                           runSync(db, sourceId) wraps adapter.sync + collate, writes a sync_run row (start row up front, summary or error on completion); listSyncRuns(db, source, limit) reads recent runs. Used by /api/sources/[id]/sync, the boot hook, and the runs endpoint.
    stores/
      session.svelte.ts                       in-memory session log (entries, count, last)
      toast.svelte.ts                         toast queue with auto-dismiss + retry actions
      collection.svelte.ts                    client mirror of Discogs membership (Set<releaseId>); fetches /api/library/membership?source=discogs
      explorerState.svelte.ts                 singleton mirror of URL params ?nav / ?id / ?q / ?entity; hydrate() + serialize()
      annotations.svelte.ts                   client mirror of stars + vetted flags (Sets); optimistic toggles with rollback; hydrate* bail out when unchanged (an unconditional reassign starves the effect scheduler)
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
        tracks/ids/+server.ts                 GET ?source=&q=&sort= → { ids } — every matching playable track id in listview order, unpaginated; the library playback queue
        tracks/[id]/+server.ts                GET → { track, sources, facets, release, sourceMeta } for TrackDetail
        releases/+server.ts                   GET ?source=&q=&multiSource=&limit=&offset=  paginated releases
        releases/[id]/+server.ts              GET → { release, sources, facets, tracks, sourceMeta } for ReleaseDetail
        artists/+server.ts                    GET ?source=&q=&multi_source=&limit=&offset=  paginated artists (each row: name + releaseCount + trackCount + sources[])
        artists/[id]/+server.ts               GET → { artist, sources, facets, releases, trackCount } for ArtistDetail
        tracks/[id]/star/+server.ts           PUT/DELETE → toggle a track's star; returns { starredAt }
        releases/[id]/vet/+server.ts          PUT/DELETE → toggle a release's vetted flag; returns { vettedAt }
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
    specs/YYYY-MM-DD-<topic>-design.md         approved design per feature slice (14 as of 2026-08-26)
    plans/YYYY-MM-DD-<topic>.md                implementation plan per slice (14). Mostly pairs 1:1 with a
                                               spec, but not always: remote-access-and-mobile split into two
                                               plans (project-a / project-b), artist-album-strip has a spec
                                               and no plan, stars-and-vetting is spec-only until planned.
                                               Deliberately NOT enumerated file-by-file — this list rotted
                                               once (it named 3 of the 13 specs that existed, making features
                                               that shipped fully specced read as undocumented). Each shipped
                                               feature links its own spec + plan from its section below; `ls`
                                               the dirs for the authoritative set.
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
- **Sort by date added** (toolbar `Added ↓ / Added ↑ / Artist`, **`Added ↓` is the app default**, shown for releases + tracks, hidden in Add → Discogs and for artists): orders by the local source's `dateAdded` facet. A **release has no date of its own** — `dateAdded` is per track — so it takes the `MIN` over its tracks: when the record first entered the library, so a later top-up doesn't drag an old record into "recently added". Entities with no local file (Discogs-only) sort **last in both directions**. Every clause ends in the entity ULID: the library averages ~9 tracks per distinct timestamp (one bucket holds 66) and the listview pages with `LIMIT/OFFSET`, so without a unique final key tied rows reorder between page requests and rows visibly duplicate or vanish while scrolling. The facet join is only added when actually sorting by it. Verified by `scripts/verify-sort.ts`.
- **Two shells, one controller (2026-08-19).** `+page.svelte` mounts `MobileShell` below 768px and `DesktopShell` above, chosen from `matchMedia` and kept live via a `change` listener. **SSR is disabled for the route** (`src/routes/+page.ts`) because the shell depends on viewport, which the server cannot know — it would render one and hydrate into the other. That costs nothing here: the route has no load functions and all data arrives via client-side `/api` fetches, so SSR was already emitting data-less markup. Mobile flattens the rail to four tabs (Library / Playlists / Add / **Search**, which replaces Sources — two of four sources are stubs, so Sources became a header button). Detail is a *pushed* view derived from the same `?id=` the desktop pane uses, so deep links and back/forward behave identically. `Tab`-only entity cycling is unreachable on a phone, so the mobile toolbar carries a visible segmented control writing the same `?entity=`. Vinyl recording is absent below the breakpoint (it needs the attached audio interface); the scanner stays, since pointing a phone beats holding a record up to a webcam. `installKeyboard` still installs but no-ops — its probe elements don't exist in the mobile shell (verified: zero console errors at a 390×844 viewport).

- **Explorer controller (2026-08-19).** `stores/explorerController.svelte.ts` owns everything the explorer does — URL ↔ `explorerState` sync, list/detail fetching, add/remove handlers, playlist-detail state, and the derived toolbar/CTA values. `DesktopShell.svelte` is a view over it, and a future `MobileShell` will be another. **Why:** the old `Explorer.svelte` was 1011 lines (686 script) and already owned all of this; adding a second navigation mode inline would have made it unmaintainable. Components consume the controller through `$derived` aliases rather than destructuring, because it exposes getters — a plain `const` would snapshot the value once and never update. Two reactivity landmines are preserved verbatim inside it: `listLoading` is a plain `let` (as `$state` it trips `effect_update_depth_exceeded`, since `loadList` writes it from inside the load-list effect), and the URL-sync effect reads each `explorerState` field into a local because `serialize()` and intermediate `$derived` both have tracking gaps with class-state singletons.

- **Release grid view is the default** (`releaseView` in `DesktopShell.svelte`) — cover art is the fastest way to find a record. In-memory only, so it resets to grid on reload.
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
- **Client**: `stores/player.svelte.ts` holds now-playing state (`trackId/title/artist/thumbUrl/releaseId`). `Player.svelte` is an invisible `<audio>` bound to `/api/stream/{trackId}` that bridges element events back to the store. `PlayerBar.svelte` is the bottom transport bar shown only while a track is loaded: 56px artwork, title/artist, then a stacked transport (play-pause centred **above** a `[elapsed] [scrubber] [duration]` row). Both mounted in `DesktopShell.svelte`.
- **Artwork size is the one number to tune**: `--player-art` (72px) in `app.css`. `--player-bar-h` derives from it (`calc(var(--player-art) + 16px)`) and `RecordingPill`'s lifted offset derives from *that* (`calc(var(--player-bar-h) + 16px)`). Resizing the art therefore moves the bar and the pill in step. Previously all three were independent magic numbers (48px bar / 64px pill) coupled only by a comment, so growing the bar left the pill overlapping it.
- **Clicking the PlayerBar artwork opens that release's detail** in the right-hand pane, via `openReleaseFromPlayer` in `Explorer`. It branches because the two surfaces reach their pane differently: the playlist view uses its own `plDetail`/`openPlaylistEntity` (playlist track rows deliberately open no detail), everything else goes through normal `?id` selection. No-op when that release is already open. The artwork is only a `<button>` when there is somewhere to go — a track with no `releaseId` renders a plain image. This is why `NowPlaying` carries `releaseId`, threaded through all four `player.play(...)` call sites (`ReleaseDetail`, `TrackList` ×2, `PlaylistView`).
- **Affordance**: double-click a track row (in `TrackList` or the `ReleaseDetail` tracklist) plays it when `canPlay`. `Space` toggles play/pause. `TrackDetail` has no play control today.
- **`ReleaseDetail` tracklist has a real transport control** on `canPlay` rows: ⏸ when that track is loaded *and* playing, ▶ when loaded-and-paused (resume) or not loaded (play). Non-playable rows keep the `›` detail chevron; row click still opens track detail either way. **Why this changed:** that slot used to be `.info-icon` — the detail chevron — which merely swapped its glyph to ▶ whenever the track was loaded. So the icon read as a play button but opened track detail, and because the check was `player.nowPlaying?.trackId === t.id` ("is loaded", not "is playing") a **paused** track was indistinguishable from a playing one. The three-state resolution lives in `src/lib/playback.ts` (`trackPlayState` / `transportGlyph` / `transportLabel`) as pure functions, covered by `scripts/verify-playback-state.ts`.
- **`{ kind: 'redirect' }` caveat**: only suits direct-audio URLs the `<audio>` element can load — not YouTube watch pages, which need an iframe. No source emits redirect streams yet.

### Playback queue

- **The queue is a snapshot of where you pressed play.** `player.playFrom(context, trackId, meta, seed?)` captures a `PlaybackContext` (`src/lib/queue.ts`) and resolves it to `ids[] + index`. It is **not** rebuilt as you browse: playing from a playlist then navigating to a release keeps the playlist queue, and re-sorting the library doesn't reshuffle something already in flight. Only pressing play again replaces it.
- **Three contexts.** `release` and `playlist` carry their ids inline because both already hold their complete ordered list client-side (playlists aren't paginated; `ReleaseDetail` gets a full `tracks` array). Only `library` resolves server-side, because that listview pages at 200 rows. All three converge on `ids[] + index` so prev/next/advance have one code path.
- **`GET /api/library/tracks/ids`** takes the same params as `/api/library/tracks` and returns `{ ids }` in identical order, **playable tracks only** (5,671 tracks in the library, 4,343 playable — an unfiltered queue would be ~1,300 dead ends). Both it and `listTracks` build their WHERE/JOIN/ORDER from the shared `buildTrackQuery` helper; **they must never become two copies**, because if the ordering diverges `next` plays something other than the row below the one you clicked. `scripts/verify-track-ids.ts` asserts they agree across six parameter combinations.
- **Explorer's `libraryQuery`** must likewise mirror exactly what `loadList` sends to `/api/library/tracks`. It deliberately omits `multi_source`: `loadList` never sends it (the rail has no multi-source item today), so including it would be that same divergence. Nothing automated catches this one — it's a client-side duplication.
- **Metadata cache.** The queue holds ids, but the bar renders title/artist/artwork, and advancing past the loaded 200 rows yields an id with no metadata. The store keeps a `Map` seeded by the call site (it's rendering those rows anyway) and fetches a single track on a miss. Audio never waits — `/api/stream/{id}` needs only the id — so the cost is the bar's text arriving a beat late, versus ~1MB instead of ~113KB to prefetch it all.
- **Semantics:**

| Action | Behaviour |
|---|---|
| `next()` | advance one; at the last item stop, keeping it loaded+paused (no wrap) |
| `prev()`, `currentTime > 3s` | restart the current track |
| `prev()`, `<= 3s` | step back one; at index 0, restart instead |
| track ends | `next()` — `Player.svelte`'s `onended`, which used to call `stop()` |
| no queue | prev/next are no-ops and render disabled |

- **Stale ids** (a track deleted since capture) are skipped in the direction of travel, bounded by queue length so a run of them terminates rather than spinning.
- Spec/plan: `docs/superpowers/specs/2026-08-18-playback-queue-design.md`, `docs/superpowers/plans/2026-08-18-playback-queue.md`.

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

### Stars + vetting
- **Two Booth-native annotations, columns on the entity tables** (migration `009`): `track.starred_at` and `release.vetted_at`, both nullable ISO8601, both partially indexed (`WHERE … IS NOT NULL`). Unlike playlists these need no join table — a star is strictly 1:1 with its track. Like playlists they never touch `source_link` / `source_facets` / `match_key`, and they deliberately do **not** bump `updated_at`, which tracks source-data freshness rather than user judgment. `collate`'s entity upserts are targeted column-list `UPDATE`s, so a re-sync leaves both columns alone.
- **Timestamps, not booleans.** Truthiness is `IS NOT NULL` at identical cost, but the column also answers "what did I star recently" and "when did I go through this record". Re-starring uses `COALESCE(starred_at, now)` so a double-fire can't rewrite the original.
- **Vetted-ness is stored, never derived.** "Does this release have starred tracks?" conflates *not listened to yet* with *listened to and nothing made the cut* — opposite states in this workflow. Deriving it would permanently re-surface every record already dismissed. A release with zero starred tracks and `vetted_at` set is a legitimate terminal state.
- **Release stars deliberately omitted.** The affordance is ambiguous between "front-to-back keeper" and "contains starred tracks", and the second is derivable — so releases carry a derived `starredCount` (batched per page in `countStarredByRelease`, alongside the existing source-list lookup) and no stored flag.
- **Filters**: `starred` on `TrackFilterArgs`, `vetted` on `ListReleasesArgs`, both plain WHERE clauses that compose with the existing source/`q`/multiSource filters. `listTrackIds` inherits `starred` through the shared track-query builder, so **"play all starred tracks" works through the existing playback queue with no queue-side code**. API params are **tri-state** — absent means no filter; collapsing to `=== '1'` would make every unfiltered list request an implicit `starred: false`.
- **Rail**: Library gains `Starred` and `Unvetted`. The **Unvetted count is the progress meter** — the single number saying how much collection is left. The queue is **flat**: all releases, including the ~200 with no local files, since those are vetted at the turntable and that work counts toward the same goal.
- **`navEntityHint`** is consulted by both `parseNav` and `setNav`: Starred is a tracks concept and Unvetted a releases concept, so arriving under the wrong lens shows an empty list. It sets the lens on arrival only — `Tab` still switches it.
- **Auto-advance**: marking vetted inside `nav=library:unvetted` drops the release from the list in place (not a refetch — that would reset scroll after every record) and opens the next. Inert everywhere else, so it can't hijack navigation mid-browse. All reactive mutations happen synchronously before the `await`, and the Unvetted count is adjusted exactly rather than refetched.
- **Indicators must not read alike**: gold `★ n` (`--star`, its own token — *not* `--warn`, whose hue is near-identical but whose meaning isn't) vs neutral grey `✓`. Starred-but-unvetted is a real state that appears in the queue ("you started and stopped") and reads as a bug if the two share a colour.
- **Hydration must never read the store it writes.** `annotations.hydrateTracks/hydrateReleases` diff against the current Sets, so calling them from a tracked context makes the effect depend on its own output. This bit twice, with two different symptoms:
  - Unconditional `Set` reassignment → the effect retriggers forever and **starves every other effect in the app**. Symptom appears somewhere unrelated: the URL-sync effect stops running, freezing `?id` and the rendered rows while internal state moves on. Fixed by making `seed()` return `null` when nothing changed.
  - Still tracking the store after that fix → one optimistic star retriggers the effect, the **stale payload** (whose `starred_at` is still `null`) is re-applied, and the toggle silently reverts. Symptom: stars in `ReleaseDetail` only appeared after a page reload, while list rows worked fine — because the controller hydrates from `loadList`, outside any effect. Fixed by reading the payload into locals and wrapping the hydrate calls in `untrack`.
  - **The rule:** hydrate from a fetch callback, or from an `$effect` that depends on the payload and nothing else.
- **Keys**: `s` stars the selected row, `v` marks vetted + advances. `s` is context-split by element presence (the same idiom as the entity-lens toggle): the scan button only renders in Add → Discogs, so its presence picks the meaning. Nothing was taken away — `openScanner` is DOM-driven and that button never existed elsewhere, so `s` was already inert outside the add view. Both actions click the real controls rather than reimplementing them.
- **Mobile**: the two rail items become a filter strip under the Library toolbar. Star touch targets are 44×44 behind the 768px breakpoint, sized in `StarButton` itself — the target grows, the glyph doesn't, so desktop row density is unchanged.
- **`scripts/export-stars.ts`** dumps/restores both flags keyed on artist+title+album rather than ULIDs. `collate`'s prune deletes entities that no longer resolve to any source, so moving or renaming a local file re-keys it, creates a new track row, and takes the star with it silently. Every other entity here is reconstructible from a source; this data is tens of hours of listening entered by hand.
- Spec/plan: `docs/superpowers/specs/2026-08-26-stars-and-vetting-design.md`, `docs/superpowers/plans/2026-08-26-stars-and-vetting.md`.

### Playlists
- **Booth-native organizational layer over the unified `track` table** — *not* a source. `playlist` + `playlist_track` tables (migration `007`); a track appears at most once per playlist (`PRIMARY KEY (playlist_id, track_id)`), `ON DELETE CASCADE` on both FKs. Playlists never touch `source_link`/`match_key`/`source_facets`. Playback runs through the shared queue (see **Playback queue**): playing a playlist track queues that playlist and auto-advances.
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
  - `?sort=<added-desc|added-asc|artist>` — **app-wide** listview ordering, omitted when it equals `DEFAULT_SORT`. Like `entity` it's a lens, not a per-rail attribute. `SortKey` and `DEFAULT_SORT` (`added-desc`) live in `src/lib/types.ts` so the store's hydrate/serialize, the query layer and `parseSort` at the HTTP boundary can't disagree about what an absent `?sort=` means — a mismatch there would serve a different order than the toolbar shows as selected. `queries.ts` re-exports `SortKey`; the store can't import from `server/`. Explorer always sends `sort` explicitly for releases/tracks rather than relying on the server default.
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

- **Scheduled sync:** `src/hooks.server.ts` also starts an interval timer (`BOOTH_SYNC_INTERVAL_MINUTES`, default `360`, `0` disables) re-running `runSync()` for every eligible source, via the pure scheduler core in `src/lib/server/library/scheduler.ts`. **Why this exists:** the boot hook fires once per process, which is invisible under `bun dev` (it restarts constantly) but means an always-on production server stops syncing forever. Runs never stack — a source still in flight is skipped for that tick, not queued — and the scheduler runs *alongside* the boot hook, so a restart still syncs immediately. Scheduled runs log their summary (`[sync] discogs {...}`); `runSync` is otherwise silent on success, which would make a dead scheduler indistinguishable from a healthy one. In practice this benefits `discogs`; `local` re-reads a manual export and is correctly flagged `stale`. Verified by `scripts/verify-scheduler.ts`.

- **Connection pragmas** (`src/lib/server/db/pragmas.ts`, applied by `getDb()`): WAL, `foreign_keys = ON`, and `busy_timeout = 5000`. The timeout matters now that scheduled sync in an always-on server plus a `bun dev` session alongside it makes two writers; without it SQLite fails the contended write immediately with `SQLITE_BUSY` instead of waiting. Kept in its own module so verify scripts can exercise it without importing `$lib/server/env`, which does not resolve outside SvelteKit.
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

- **Entities**: `artist` (id, name), `release` (id, title, artist_id FK NOT NULL, year, country, label, catno, thumb_url, cover_url, vetted_at), `track` (id, title, artist_id FK NOT NULL, album, duration_ms, release_id FK nullable, position, starred_at). All FKs are real SQLite foreign keys with `PRAGMA foreign_keys = ON`.
- **Per-source plumbing**: `source_link`, `source_facets`, and `match_key` all carry an `entity_kind` discriminator that supports `'track' | 'release' | 'artist'`. Today, the adapters emit `release` + `track` rows; the `'artist'` entity kind is schema-level only — no adapter currently emits per-source artist records, but the constraints allow it.
- **Moved external_ids relink, they don't delete**: when `upsertSourceLink` finds the entity already holds a *different* `external_id` for the same source, the outcome depends on how the entity was matched. A `file_path` match is authoritative — the same bytes on disk — so the link's `external_id` is rewritten in place and counted in `summary.relinked`. Weaker matches (`release_position`, `artist_album_year`) are genuinely ambiguous (two source records competing for one entity), so the existing link is left alone and counted in `summary.conflicts`. **Why:** these used to share the skip path. A renumbered Apple-Music Track ID was therefore never re-linked, the following `pruneSource` deleted the now-stale link, the entity lost its last `source_link` and was deleted along with its match_keys, facets and **playlist membership** (`ON DELETE CASCADE`). Covered by `scripts/verify-id-churn.ts`, which asserts the entity id and playlist rows survive a renumber while a genuine removal still prunes.
- **Artist dedup**: at sync time, `upsertArtist(name)` normalizes via `squashAlphanumLower` and stores a `match_key` (entity_kind='artist', key_type='name_normalized'). On a freshly-migrated DB, artists have no match_keys yet — `upsertArtist` falls back to a case-insensitive `artist.name` lookup and backfills the match_key on first touch.
- **"(unknown)" sentinel artist**: guaranteed by migration 003. Any release/track without an artist string (e.g. iTunes track with no Artist tag) FKs to this row, so `artist_id NOT NULL` holds without nullable columns.

## Notable divergences from the original plan

- **Stars + vetting (2026-08-26).** Binary track stars plus a release-level vetted flag (migration 009), two Library rail items, `s`/`v` bindings, and a name-keyed backup script. The load-bearing decision is that vetted-ness is *stored*, not derived from "has starred tracks" — that check conflates "not listened to yet" with "listened to and nothing made the cut". Release stars were dropped as ambiguous; releases carry a derived starred-count instead. Shipping it surfaced a latent hazard: hydrating a store from inside an `$effect` while components read that store back loops and starves Svelte's whole effect scheduler, and the symptom shows up somewhere unrelated (the URL-sync effect silently stopping). See `docs/superpowers/specs/2026-08-26-stars-and-vetting-design.md` + plan.
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
- **Cover art (2026-06-02).** `thumb_url` and `cover_url` columns added to `release`; Discogs sync populates both; `upsertRelease` UPDATE uses `COALESCE(?, col)` so iTunes syncs don't wipe Discogs-sourced URLs. `ReleaseList` renders 40×40 thumbnails; `ReleaseDetail` renders full-width cover. iTunes-only releases show grey placeholder. `explorerController` maps snake_case API fields (`thumb_url`) to camelCase (`thumbUrl`) for search hits; library items are mapped at load time.
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
- **The playback queue is in-memory only** — a reload loses it, exactly as the loaded track is already lost.
- **Re-sorting or re-filtering mid-playback does not rebuild an in-flight queue.** Intentional (the queue is a snapshot), but it means the queue can hold an order no longer visible on screen.
- **Playlist reordering isn't reflected in an already-captured queue.**
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

Run the production build (this is what a phone talks to):

```bash
bun run build
bun start          # http://localhost:3000, override with PORT
```

`bun start` is `bun ./build/index.js`. It must be Bun, not Node — `adapter-node` emits a Node-shaped server, but the DB layer imports `bun:sqlite`, which only the Bun runtime provides. Verified end-to-end by `scripts/verify-prod-server.ts`, which boots the built server and asserts `/api/sources` reaches the DB.

**Start it from the repository root.** `runMigrations` resolves `migrations/` next to its own module in dev, but Rollup relocates that module in the build, so the built server falls back to `<cwd>/src/lib/server/db/migrations`. Started from elsewhere it throws a named error on first DB access rather than failing silently.

Unlike `bun dev`, the production server does not restart on file changes — which is exactly why sync has to be scheduled rather than boot-triggered (see **Scheduled sync**).

Run a verification script: `bun verify scripts/<name>.ts` (bun runs TypeScript natively — no separate transpile step).

Type-check (no test runner): `bunx svelte-kit sync && bunx tsc --noEmit`.
