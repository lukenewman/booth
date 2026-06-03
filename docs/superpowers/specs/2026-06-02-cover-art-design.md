# Cover Art — Design Spec

**Date:** 2026-06-02

## Goal

Populate the square cover-art placeholders in the release list and detail views with real images. Cover art flows in via the Discogs sync and the direct-add path. iTunes-only releases have no accessible image URL and retain the styled placeholder.

## Scope

- Release list rows (40×40 thumbnail)
- Release detail pane (full-width cover image)
- Add → Discogs search results (same two views; data is already fetched, just not rendered)

Out of scope: artist/track cover art, fetching artwork from audio file tags, any external image proxy.

## Schema

New migration `005_cover_art.sql`:

```sql
ALTER TABLE release ADD COLUMN thumb_url TEXT;
ALTER TABLE release ADD COLUMN cover_url TEXT;
```

`thumb_url` — small thumbnail (~90px); used in list rows.
`cover_url` — full-size image (~600px); used in the detail pane.

Both columns are nullable. Releases with no cover art (iTunes-only releases, releases predating this migration) have `NULL` in both columns and continue to show the existing styled placeholder div.

The `source_facets` rows (`thumb`, `coverImage` keyed under `discogs`) are left untouched — they are source-specific storage; the new columns are the canonical cross-source cache.

## Data flow: sync path

### `SourceRelease` type (`src/lib/server/sources/types.ts`)

Add two optional fields:

```ts
thumbUrl?: string;
coverUrl?: string;
```

### Discogs sync (`src/lib/server/sources/discogs/sync.ts`)

Both URLs are already in `basic_information`. Set them on each `SourceRelease` in addition to the existing facet writes:

```ts
thumbUrl: bi.thumb ?? undefined,
coverUrl:  bi.cover_image ?? undefined,
```

### `upsertRelease` in `collate.ts`

Add both columns to the `INSERT` and `UPDATE` statements. Update rule: **always overwrite when the incoming value is non-null**. This keeps URLs fresh as Discogs CDN paths rotate. A source that provides no URL (e.g. iTunes) emits `undefined` for both fields; the collate layer writes `null` only when the value is explicitly provided as null — undefined means "skip this column."

Concretely: if `r.coverUrl` is `undefined`, the UPDATE leaves the existing `cover_url` value unchanged. If `r.coverUrl` is a string, it overwrites.

## Data flow: direct-add path

When a user adds a release from the Discogs search view:

**`Explorer.svelte`** — expand the search-hit item mapping from the current single `coverImage: r.thumb` to:

```ts
thumbUrl: r.thumb ?? null,
coverUrl:  r.cover_image ?? null,
```

**Add POST body** — `AddRequestBody` in the add route already accepts `thumb` and `coverImage`; rename to `thumbUrl` and `coverUrl` to match.

**`ensureDiscogsReleaseEntity`** (`src/lib/server/sources/discogs/index.ts`) — add `thumbUrl` and `coverUrl` to the args interface and write both to the release `INSERT`. (The function currently writes them only to `source_facets`.)

**Detail pane for search hits** — `Explorer.svelte` builds `detailData.release` inline for search hits. Add `cover_url: hit.coverUrl` so `ReleaseDetail` renders consistently whether the release comes from the library or from a live search.

## Query layer

### `ReleaseRow` (`src/lib/server/library/queries.ts`)

```ts
thumb_url: string | null;
cover_url: string | null;
```

### SELECTs to update

All four already join `release`; add both columns with no new joins:

| Function | Used by |
|---|---|
| `listReleases` | release list view |
| `getReleaseDetail` | release detail pane |
| `getTrackDetail` | parent-release card in track detail |
| `getArtistDetail` | releases list in artist detail |

## UI

### `ReleaseList.svelte`

- Add `thumbUrl?: string | null` to the `ReleaseItem` interface.
- Replace `<div class="cover">cov</div>` with a conditional: `<img>` when `thumbUrl` is present, otherwise the same styled div (no text). Add `loading="lazy"` to every `<img>`.

### `ReleaseDetail.svelte`

- Replace `<div class="cover">600 × 600 cover</div>` with `<img src={release.cover_url}>` when `cover_url` is present, otherwise the styled placeholder div (no text).

### Fallback styling

When `thumb_url` / `cover_url` is null the placeholder div keeps its current appearance (`var(--bg-raised)` background, `border-radius`, border) — just without the "cov" / "600 × 600 cover" text. No icon or additional treatment.

## What doesn't get cover art

- **iTunes-only releases** — the iTunes Library XML exposes no image URLs. These releases will always show the placeholder unless covered by a Discogs sync match.
- **Rekordbox / Plex** — stubs; no sync.
- **Tracks and artists** — out of scope for this slice.
