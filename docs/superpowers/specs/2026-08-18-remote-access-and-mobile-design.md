# Booth: remote access + mobile — design

> **Status:** approved design, pending implementation plan.
> **Goal:** use Booth away from the desk — primarily from a phone — for $0/month, without exposing anything to the public internet.

## Why

Booth today is single-user and local-only: `bun dev` on a laptop, SQLite at `~/.booth/booth.db`, audio read straight off the local filesystem. Everything it is good at (is this in my collection? play this rip) is unavailable the moment you close the lid or leave the house.

The obvious framing — "deploy it to a cloud provider" — is wrong for this app, and the measurements say why.

## What the investigation found

| Finding | Evidence | Consequence |
|---|---|---|
| The library is 130 GB | `du -sh ~/Music/Music` | Cloud hosting means shipping and storing 130 GB, plus refactoring `resolveTrackStream`, which returns a local filesystem path. Home-hosting is the *cheap* option here, not the compromise. |
| The metadata is tiny | `booth.db` = 11 MB; 1426 releases / 4768 tracks | Everything except audio moves over any link, instantly. |
| Booth has no auth of any kind | no session/user/password anywhere; `DISCOGS_TOKEN` in `.env` | Anything internet-facing needs auth built first. Avoided entirely by never being internet-facing. |
| `bun:sqlite` forces the Bun runtime | `src/lib/server/db/index.ts` | Rules out Vercel / Netlify / Cloudflare regardless of cost. `adapter-auto` cannot produce a self-hostable server. |
| Camera + mic need a secure context | `Scanner.svelte`, `recorder.svelte.ts` (`getUserMedia`) | Works today only via `localhost`. Over a plain LAN IP the scanner *and* the vinyl recorder both break. HTTPS is mandatory, not polish. |
| Auto-sync is boot-triggered, once per process | `hooks.server.ts:7` — module-level `triggered` Set | Invisible today because `bun dev` restarts constantly. On an always-on server the library silently stops syncing forever. **Always-on hosting breaks sync.** |
| Zero responsive CSS | no `@media` anywhere in `src/`; `Explorer.svelte:931` is `220px 1fr 360px` | Mobile is a from-scratch layout, not a tweak. |
| `height: 100vh` | `Explorer.svelte:928` | iOS Safari's dynamic URL bar pushes the PlayerBar under browser chrome. Needs `100dvh`. |
| No PWA manifest | `static/` holds only the worklet and `robots.txt` | "Add to Home Screen" is cheap and is most of what makes this feel like an app. |
| Playlist reorder is HTML5 drag-and-drop | `PlaylistView.svelte` | DnD does not fire on touch. Reorder is not degraded on mobile — it is dead. |
| `Explorer.svelte` is 1011 lines (686 script) | largest component by 1.4x | It already owns URL↔store sync, fetching, and add/remove handlers. Adding a second navigation mode inline makes it unmaintainable. |

### Ownership lookup is already solved

The record-shop question — *do I already own this?* — needs no new code. `Explorer.svelte:365` rolls owned state up across a master group:

```js
sources: g.versions.some((v) => collection.has(v.id)) ? ['discogs'] : [],
```

A title search surfaces many pressings of a master, so the filled D dot already answers "you own some pressing of this." An earlier draft of this design proposed persisting Discogs barcodes as `match_key` rows with a ~15-minute backfill; **that project was cut** once the existing rollup was verified.

## Scope: which tier

Three tiers were costed. **All three are $0/month in hosting** — the variable is engineering effort, not money, because Tailscale removes any need for paid transport or a cloud host.

| Tier | Means | Marginal cost over the previous tier |
|---|---|---|
| 1 | Browse and search the library from anywhere; no audio away from home | The mobile layout — which every tier needs anyway |
| 2 | **Tier 1 + play audio while on home wifi** | ~zero: `/api/stream/[trackId]` already serves HTTP range requests (206/416) |
| 3 | Tier 2 + play anything over cellular | ffmpeg transcode pipeline + cache with eviction |

**Tier 2 is the target (D3).** Tier 1 and Tier 2 are effectively the same project — you would have to actively disable playback to stop at Tier 1 — and Tier 3 is cleanly additive later.

## Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | Home-host; do not cloud-host | 130 GB of audio and a physically-attached audio interface both live at home. |
| D2 | Tailscale as transport, HTTPS via `tailscale serve` | Solves remote access, TLS/secure-context, and authentication in one move, free. Nothing is publicly exposed. |
| D3 | Target Tier 2: browse anywhere, stream on home wifi | The streaming endpoint already does range requests, so Tier 2 costs ~nothing over Tier 1. Tier 3 (cellular streaming) stays cleanly deferrable. |
| D4 | Defer the Mac mini | Everything here is hardware-independent. Build on the laptop, live with it, and let "annoyed the lid is closed" be the buy signal. Nothing built now is thrown away. |
| D5 | Bottom-tab navigation on mobile | The rail flattens to four top-level sections with nothing lost, and keeps a persistent sense of place that drill-down and drawer patterns both hide. |
| D6 | Extract the explorer shell *before* building mobile | Avoids a second nav mode inside a 1011-line component, and fixes a file that is already doing too much. |
| D7 | Fourth tab is **Search**, not Sources | "Do I already own this?" is the primary mobile job and text search is the stated path to it. Two of four sources are stubs. Sources moves behind a header button. |
| D8 | Disable SSR (`export const ssr = false`) | Shell choice depends on viewport, which the server cannot know; SSR would render one shell and hydrate into the other. Booth is local and single-user — SSR buys no SEO and no cold-load win. Reversible. Verified 2026-08-18: `src/routes/` holds only `+layout.svelte` and `+page.svelte` — no load functions anywhere, all data arrives via client-side `/api/*` fetches — so SSR already renders data-less markup. Turning it off costs one blank frame on cold load and nothing else, and does not affect the boot sync hook, which fires on API requests too. |
| D9 | No barcode backfill | Superseded by the master-group rollup above. |

## Non-goals

- Public internet exposure, port forwarding, or a reverse proxy.
- App-level auth, login UI, or user accounts. Tailscale is the authentication boundary.
- Streaming over cellular (Tier 3: transcoding + cache). Deferred, not designed here.
- Vinyl recording on mobile — it needs the audio interface. Hidden below the breakpoint rather than shipped broken.
- Mac mini migration, LaunchDaemon, FileVault policy. Later phase, sketched at the end.
- Multi-user / friends. Later phase, sketched at the end.

## Project A — Remote access

Booth reachable and secure from the phone. No UI work.

### A1. Bun-compatible adapter

Replace `@sveltejs/adapter-auto` with `@sveltejs/adapter-node`; run the build output under Bun (`bun ./build/index.js`) so `bun:sqlite` resolves.

**This is the project's only real technical risk and must be spiked first.** `adapter-node` emits a Node server, and `bun:sqlite` importing cleanly from *built* output (as opposed to dev, where it is known to work) is an assumption, not a verified fact. Fallback is the community `svelte-adapter-bun`, accepted reluctantly on maintenance grounds.

The expected failure mode is Rollup trying to *bundle* `bun:sqlite` at build time, not Bun refusing to run the output. If the spike fails that way, the fix is to pin `bun:sqlite` as external in the Vite/Rollup config. Rule that out before concluding `adapter-node` is unworkable — reaching for the fallback adapter on a bundler-config error would be a false negative.

Also verify under the production build: `$lib/server/env` still resolves `.env` (CONTEXT.md documents `$env/dynamic/private` coming back empty under Bun, with `process.env` as the working fallback).

### A2. Tailscale + HTTPS

Tailscale on the host Mac and the phone. `tailscale serve` fronts Booth's port with a Let's Encrypt cert on `<host>.<tailnet>.ts.net`. Yields a genuine secure context, so `Scanner.svelte` and the recorder keep working off `localhost`.

### A3. Scheduled sync

Fixes the always-on defect. In-process scheduler calling the existing `runSync`, alongside (not replacing) the boot hook.

- `BOOTH_SYNC_INTERVAL_MINUTES`, default `360`, `0` disables.
- In-process rather than a launchd plist: identical behaviour on the laptop now and the mini later, no external config, and `sync_run` already records history and errors.
- Must not stack runs — skip a tick if the previous run for that source is still in flight.
- Set a SQLite `busy_timeout`. WAL is on (`src/lib/server/db/index.ts:17`) but no busy timeout is configured, so it defaults to 0. This is invisible today because exactly one process ever touches the DB. A scheduled sync inside an always-on server changes that: a `bun dev` session running alongside the production server makes two writers, and under WAL the loser of a write collision gets an immediate `SQLITE_BUSY` instead of waiting.

Note: because `ITUNES_XML_PATH` points at a **manual** export, scheduling `local` re-reads a frozen file — correctly flagged `stale = true` by the stale-input detection shipped 2026-08-13. Scheduled sync therefore benefits `discogs`, which is the source that actually drifts. That is expected, not a bug.

## Project B — Mobile Booth

### B1. Shell extraction (prerequisite)

Lift out of `Explorer.svelte` into a shared controller module:

- URL ↔ `explorerState` sync
- list/detail fetching (`loadList`, `loadDetail`, `loadSourcesAndCounts`)
- add/remove handlers and `releaseDetailCta` derivation
- playlist-detail state (`plDetail`, `openPlaylistEntity`)

Leaving `DesktopShell.svelte` (today's three-pane grid) and `MobileShell.svelte` as thin views over one controller. Leaf components — `ReleaseList`, `TrackList`, `ArtistList`, `ReleaseDetail`, `TrackDetail`, `ArtistDetail`, `PlaylistView` — are reused unchanged by both.

**Verification:** desktop behaviour must be observably identical before any mobile work starts. No test suite exists, so this is manual: rail navigation, entity lens, search in both modes, add/undo, playlists, playback, sync chip.

### B2. Mobile shell

- Breakpoint 768px; below it `+page.svelte` mounts `MobileShell`.
- Tabs: **Library · Playlists · Add · Search**. Sources moves to a header button in Library (sync chip + `SyncRunHistory`, so a ⚠ stale warning stays visible away from the desk).
- Within a tab: list → detail pushes with a back chevron.
- Search tab is a global library search over the existing `/api/library/{releases,tracks,artists}?q=` — no server work. The Library tab drops its own search input; searching is the Search tab's job.
- Keyboard wiring (`installKeyboard`) stays desktop-only. It is DOM-driven and its probe elements simply will not exist in the mobile shell, so it no-ops safely — but confirm rather than assume.

### B3. Entity lens

`Tab` cycles releases/tracks/artists and is keyboard-only, making the lens unreachable on a phone. Needs a visible segmented control in the mobile toolbar, writing the same `?entity=` param.

### B4. PWA + playback

- `static/manifest.webmanifest` + icons; `display: standalone`, theme colour `#0a0a0a` to match `--bg`.
- `100vh` → `100dvh` (`Explorer.svelte:928`).
- MediaSession API for lock-screen / AirPods transport, wired to the existing `player` store.
- Mini-player taps up to a full now-playing screen.
- Touch targets: list rows are currently mouse-sized; raise to a 44px minimum.

### B5. Playlist touch reorder

Replace HTML5 DnD with a pointer-events drag from an explicit grab handle. Pointer events cover mouse and touch, so desktop reorder keeps working through the same path rather than needing two implementations. `translucentDragImage` (`src/lib/dnd.ts`) is DnD-specific and will need a replacement drag affordance.

Drag-a-track-onto-a-rail-playlist has no mobile equivalent (no rail); the existing `a` → `PlaylistPicker` flow becomes the mobile add path via a row button.

### B6. Excluded on mobile

"⏺ Record from vinyl" hides below the breakpoint. The scanner stays — on a phone the ergonomics invert from bad to good, since you point the device instead of holding a record in front of the webcam.

## Accepted limitations

- **Barcode search does not roll up across pressings.** A barcode is pressing-specific and typically returns a single hit, so no master group forms and the owned dot reflects only that exact pressing — a scan can report "not owned" when a different pressing is owned. Text search is the reliable path. Not worth fixing now.
- **Scanner value is capped by barcode coverage.** Many records in the collection (electronic EPs, white labels, promos) have no barcode at all. Mobile fixes the ergonomics, not the coverage.
- **Vinyl rips are 24-bit WAV** (~17 MB/min). Fine on wifi; a Tier 3 blocker, not a Tier 2 one.
- **A hard reload still loses an in-progress take.** Unchanged by this work.

## Delivery

Sequenced; each row is a candidate Linear issue under one project.

| # | Issue | Depends on | Notes |
|---|---|---|---|
| 1 | Spike: `bun:sqlite` under `adapter-node` production build | — | **Do first.** Invalidates A1 if it fails — but rule out Rollup bundling `bun:sqlite` before concluding that. |
| 2 | Swap adapter; document the production start command | 1 | |
| 3 | Serve Booth over Tailscale with HTTPS | 2 | Verify scanner + recorder still work off-localhost. |
| 4 | Scheduled sync via `BOOTH_SYNC_INTERVAL_MINUTES` | — | Independent; can run in parallel. Carries the `busy_timeout` fix. |
| 5 | Extract explorer controller; reduce `Explorer` to `DesktopShell` | — | Pure refactor. Desktop must be observably unchanged. |
| 6 | `MobileShell`: bottom tabs, push nav, Search tab, entity control | 5 | The bulk of the work. |
| 7 | PWA manifest, `100dvh`, MediaSession, touch targets | 5 | |
| 8 | Playlist reorder on pointer events | 5 | |

Issues 1–4 are Project A; 5–8 are Project B. A is useless without B, but 5 can start immediately since it depends on nothing.

## Later phases (not designed here)

- **Mac mini migration.** Move the 130 GB library and `ITUNES_XML_PATH` to the host; run Booth as a LaunchDaemon; settle FileVault (with it on, a power cut leaves the disk locked and no daemon runs until someone physically types a password). Storage, not CPU, is the spec that matters — a 256 GB model does not fit the library.
- **Tier 3, streaming on cellular.** ffmpeg transcode to AAC/Opus plus a cache with eviction. Tailscale already reaches the host over cellular, so this is purely a bitrate problem.
- **Friends.** Almost certainly "Booth is software they install," not "Booth is a service Luke runs" — their audio is on their disks, and streaming personal rips to other people is distribution rather than personal use. Booth is already scoped by `BOOTH_DB_PATH`, so per-user instances need no schema change; true multi-tenancy would mean an owner column across `release`, `track`, `artist`, `source_link`, `source_facets`, `match_key`, `playlist`, `source_state`, and `sync_run`.

## Follow-up

`docs/CONTEXT.md`'s file map omits `ReleaseGrid.svelte` (168 lines). Fold the correction into whichever issue touches the component tree.
