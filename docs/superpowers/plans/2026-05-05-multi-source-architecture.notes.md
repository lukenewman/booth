# Multi-Source Architecture (Slice 1) — Verification Notes

> Companion to `2026-05-05-multi-source-architecture.md` Task 13 (cross-source collation manual verification).

## Sync sizes against real data

- **Discogs:** 92 releases, 0 tracks, 0 conflicts.
- **Apple Music.app (iTunes):** 5433 source rows in (4246 tracks + 1187 emergent releases), 14 conflicts.

## Cross-source matches

A `discogs ∩ itunes` SQL probe over the unified store returned 10 release-level matches in the first 20 rows (deterministic `artist|album|year` collation). All 10 looked correct on visual spot-check (electronic / underground catalog — Folamour, Detroit Swindle, Yussef Kamaal, etc.); no obvious false positives.

The deterministic-only matcher is conservative — releases where one source is missing the year, or where artist/album punctuation differs in non-trivial ways (e.g. Discogs's `Daft Punk*` vs Music.app's `Daft Punk` is fine because the normalizer drops both `*` and the trailing space; but `feat.` / `ft.` / `featuring` variations would diverge). Fuzzy matching is a Slice 2 deliverable per spec §9.

## Bugs found and fixed during verification

1. **UQ conflict not pre-checked in `upsertSourceLink`** (commit `4e9225d`).
   - **Symptom:** `POST /api/sources/itunes/sync` → 500 with `SqliteError: UNIQUE constraint failed: source_link.entity_kind, source_link.entity_id, source_link.source`.
   - **Root cause:** when two iTunes Track IDs share the same `Location` (a duplicate file import in Music.app), both normalize to the same `file_path` match-key, both resolve to the same entity, and the second `INSERT INTO source_link` violated `UNIQUE (entity_kind, entity_id, source)`. The collation engine pre-checked the PK constraint but not the UQ.
   - **Fix:** added a symmetric pre-check; second occurrence is now counted as a conflict and silently dropped (matching the spec's "log conflicts, don't auto-resolve in Slice 1" stance). Real-world hit rate: 14 conflicts out of 4246 tracks (~0.3%).
   - **Regression test:** new Run 6 in `scripts/verify-collate.ts`.

## Plan-vs-reality corrections folded into task commits

- **Task 2:** `001_init.sql` no longer contains a `CREATE TABLE _migrations` block — the migration runner's bootstrap is the single source of truth for that table; including it in the migration would conflict on first run.
- **Task 9:** three `instanceId` casts at module boundaries — the `CollectionWritable.instanceId` contract is `string` (Slice 1 sources may have non-numeric IDs), but Discogs's API returns `number` and the existing `AddResponse.instanceId` client type is also `number`. Casts are at the adapter boundary (`String(data.instance_id)`) and the route boundary (`Number(instanceId!)`).
- **Task 11:** `import * as plist from 'plist'` — the package is CJS and doesn't expose a default export under Node ESM interop, so `import plist from 'plist'` throws at runtime.

## Inspection endpoints

`GET /api/library/{tracks,releases}?source=itunes&limit=N` return JSON with full entity rows + source_links + facets. iTunes facets verified present: `bitRate`, `sampleRate`, `dateAdded`, `kind` (track-level); `trackCount` (release-level). No facets dropped.

## Add / undo end-to-end

Verified manually in browser. Search → confirm-add flips the green "✓ in collection" badge on; `u` flips it back off. The membership endpoint count moves +1 / −1 in lockstep, so the SQLite write-through (`ensureDiscogsReleaseEntity` → `discogsSource.addToCollection` → `removeFromCollection` with orphan cleanup) is wired correctly.

## What's NOT covered by Slice 1 verification

- **Re-sync after upstream changes** (e.g. delete an iTunes track in Music.app, re-export XML, re-curl sync): exercised by `verify-collate.ts` Run 4 against synthetic data, not against the real library.
- **Music.app `.musiclibrary` binary format**: explicitly out of scope; users must enable XML export via `File → Library → Export Library…` (the Settings → Advanced toggle has been removed in recent macOS Music.app versions).
- **Rekordbox / Plex sync**: stubs only; throw `NotImplementedError` → HTTP 501.
- **Auto-sync-on-boot for iTunes**: only Discogs auto-syncs on first request after server boot. iTunes is manual-trigger only in Slice 1.
