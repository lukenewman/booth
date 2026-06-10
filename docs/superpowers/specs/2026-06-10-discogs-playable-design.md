# Discogs `Playable` source capability

**Date:** 2026-06-10
**Status:** Approved

## Overview

Add a `Playable` source capability interface, implemented by the Discogs adapter using YouTube videos from the Discogs release API. The UI exposes all videos on the release detail page and uses best-effort title matching to surface per-track play buttons where possible.

This is distinct from BOO-21 (iTunes→Discogs track matching), which would unlock a separate playback path (local iTunes file via cross-source match). Both would eventually implement `Playable` but through different mechanisms.

## Interface

New types and interface in `src/lib/server/sources/types.ts`, alongside the existing `CollectionWritable`:

```typescript
export type Video = {
  url: string                    // YouTube URL (from Discogs .videos[].uri)
  title: string                  // as returned by Discogs API
  matchedTrackPosition?: string  // e.g. "A1", "1" — best-effort, absent when no confident match
}

export interface Playable {
  getVideos(releaseExternalId: string): Promise<Video[]>
}

export function isPlayable(source: MusicSource): source is MusicSource & Playable {
  return 'getVideos' in source
}
```

`releaseExternalId` is the Discogs release ID stored in `source_link.external_id`. The interface is release-scoped; track-level resolution is emergent via `matchedTrackPosition`.

## Discogs implementation

### `src/lib/server/sources/discogs/videos.ts`

Two responsibilities:

**Fetching:** calls `GET /releases/{id}` via `discogsFetch` (the full release endpoint, not the collection endpoint). Returns `.videos[]` where each entry has `{ uri, title, description, duration }`. This call is on-demand only — not done at sync time.

**Matching:** exports `matchVideosToTracks(videos, tracks)` where `tracks` is `Array<{ position: string, title: string }>` passed in by the route handler (which has DB access; the adapter does not). Uses the existing `squashAlphanumLower` from `normalize.ts`. Two heuristics applied in order of confidence:

1. **Position prefix** — video title starts with a string matching a known track position (`"A1"`, `"1."`, `"B2 -"`, etc.)
2. **Title substring** — normalized track title is a substring of the normalized video title

First confident match wins per video. Unmatched videos are included with `matchedTrackPosition` absent.

`getVideos` on the Discogs source fetches raw videos and returns them without `matchedTrackPosition` — that field is populated by the route after calling `matchVideosToTracks`.

### `src/lib/server/sources/discogs/index.ts`

`discogsSource` gains `getVideos` and declares `Playable` in its type.

## API endpoint

**`GET /api/sources/discogs/releases/[id]/videos`**

- `[id]` is the release's internal ULID
- Looks up Discogs `external_id` from `source_link` for that release
- Calls `discogsSource.getVideos(externalId)`
- Fetches the stored tracklist (track `position` + `title`) from SQLite
- Runs `matchVideosToTracks` and returns `Video[]`
- Returns `[]` if the release has no Discogs source link or the release has no videos
- Returns `501` if the source doesn't implement `Playable` (guarded via `isPlayable`)

## UI

### `ReleaseDetail.svelte`

**Videos section** — lazy-loaded on mount when the release has a Discogs source link:

- Fetches `/api/sources/discogs/releases/{id}/videos`
- Renders a scrollable list of video titles below the tracklist
- Clicking a title mounts a `<iframe src="https://www.youtube-nocookie.com/embed/{videoId}" ...>` in place
- No autoplay — the embed only mounts on explicit selection

**Track play buttons** — the component builds a reverse index `Map<position, Video>` from the fetched video list. Each track row checks if its `position` is in the map; if so, a small play icon appears. Clicking it selects that video and opens the embed (same behavior as clicking the video title in the Videos section).

Tracks with no matched video get no icon. The full video list remains accessible in the Videos section regardless.

## Data flow summary

```
ReleaseDetail mounts
  → GET /api/sources/discogs/releases/{id}/videos
      → source_link lookup (ULID → Discogs external_id)
      → discogsFetch GET /releases/{external_id}  (.videos[])
      → SELECT tracks WHERE release_id = {id}
      → matchVideosToTracks(videos, tracks)
      → Video[]
  → build Map<position, Video>
  → render Videos section + per-track play icons
  → user clicks video/icon → YouTube embed mounts
```

## Out of scope

- BOO-21 (iTunes→Discogs track matching) — a separate playback path that would also implement `Playable` but via local file inheritance rather than YouTube
- iTunes `Playable` implementation — natural extension once the interface exists; out of scope for this slice
- Autoplay, play queue, or any persistent playback state
- Caching the Discogs video fetch (Discogs rate limits apply; the on-demand call is infrequent enough that caching is not needed now)
