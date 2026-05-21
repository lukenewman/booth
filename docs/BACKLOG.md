# booth — backlog

> Items deferred from past slices, organized by area. Each carries a provenance tag pointing back to the spec that deferred it. When a backlog item is picked up as a slice, strike it through and link the new spec.
>
> See `CONTEXT.md` for what's currently shipped and known gaps in shipped code. Future slices append to this file rather than maintaining their own future-work lists.

## Adapters

- Rekordbox `master.db` adapter implementation — read tracks with `bpm`, `key`, `cuePoints` as facets; file-path match key for local↔local linking. _(deferred from 2026-05-05 multi-source)_
- Plex HTTP adapter implementation — contribute tracks with `streamUrl` facet; file-path match key on `Part.file`; auth via `X-Plex-Token`. _(deferred from 2026-05-05 multi-source)_
- Bandcamp wishlist adapter — release-first. _(deferred from 2026-05-05 multi-source)_
- YouTube adapter — track-first via playlist; streaming via embed. _(deferred from 2026-05-05 multi-source)_

## UI / Explorer

- Filter by source-grid — click `D` in column header → filter to Discogs; click `i` → iTunes; click both → intersection.
- Sortable column headers (year, artist, date added, etc.). _(also re-noted 2026-05-06 library-explorer)_
- Virtualized list rendering — Slice 2 ships pagination instead.
- Sync-run history view.
- Match-overrides UI for manual conflict resolution.
- Settings / preferences UI — currently `.env` only.
- Discogs folder picker — currently always "Uncategorized" / `DISCOGS_FOLDER_ID` env override. _(deferred from 2026-04-29 collection-adder)_
- Light mode / theme toggle. _(deferred from 2026-04-29 collection-adder)_
- `[`/`]` rail keyboard navigation. _(deferred from 2026-05-06 library-explorer)_
- "Reveal in Finder" link on Apple Music source panels — needs an endpoint with limited shell-out (`open -R <path>` on macOS). _(deferred from 2026-05-06 library-explorer)_
- Source-grid in listview rows doesn't refresh after a Discogs-remove for other rows of the same release still on screen — only the currently-detail-open row updates. Likely fine until duplicate-release scenarios surface. _(noted 2026-05-06 library-explorer post-impl)_

## Matching / Collation

- Fuzzy/scored matching — add `confidence` column on `source_link` and a `match_overrides` table; Levenshtein/token-based fallback when deterministic match fails. _(deferred from 2026-05-05 multi-source)_
- Track-level Discogs matching — match individual iTunes tracks to specific tracks in Discogs release tracklists; probably a separate adapter run-mode rather than collate-time. _(deferred from 2026-05-05 multi-source)_
- Catno match-key — promote `catno` to `match_key.key_type='catno'` for distinguishing pressings. _(deferred from 2026-05-05 multi-source)_

## Sync

- Incremental sync with per-source cursor — Discogs `instance_id` order, Plex `updatedAt`. _(deferred from 2026-05-05 multi-source)_
- File watching / scheduled sync — auto-trigger on `Library.xml` mtime changes; periodic Plex polls. _(deferred from 2026-05-05 multi-source)_
- Auto-sync iTunes on boot — currently only Discogs auto-syncs once if DB is empty.
- Full `sync_run` logging table — Slice 2 adds a minimal `source_state` (last-synced timestamps); full per-run history is deferred. _(deferred from 2026-05-05 multi-source)_
- Persistent activity log — currently the session log is in-memory and resets on refresh. _(deferred from 2026-04-29 collection-adder)_

## Data model

- Artist as first-class entity — migration: `artist` table, `track`/`release` get `artist_id` FKs, `source_link`/`facets` extend to `entity_kind='artist'`. _(deferred from 2026-05-05 multi-source)_
- Booth-owned ratings / play counts — `user_track_data` table for ratings/plays not mirrored from a source; UI for editing. _(deferred from 2026-05-05 multi-source)_
- Playlists — `playlist` and `playlist_track` tables, source-attributed; iTunes adapter starts contributing them. _(deferred from 2026-05-05 multi-source)_

## Infra

- Auth / multi-user — currently single-user, dev-only. _(deferred from 2026-05-05 multi-source)_
- LAN / phone access — currently localhost-only; scanner UX is the highest-value phone use case. _(deferred from 2026-04-29 collection-adder, 2026-05-05 multi-source)_
- Move DB from `./.booth/booth.db` to `~/.booth/booth.db` when leaving dev-only. _(deferred from 2026-05-05 multi-source)_
- Automated test framework — currently verification is `pnpm tsc`, `pnpm verify scripts/<name>.ts`, curl, sqlite3, manual browser. _(deferred from 2026-04-29 collection-adder)_
- Migrate from pnpm to bun — package manager + runtime swap; affects `package.json` scripts, `pnpm-lock.yaml` → `bun.lockb`, `tsx` could be replaced by bun's native TS execution, `.claude/settings.json` allowlist updates, CONTEXT.md tooling references.
