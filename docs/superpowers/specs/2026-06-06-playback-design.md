# Playback — design spec

**Date:** 2026-06-06
**Status:** approved

## Goal

Let the user listen to their collection from inside Booth. A persistent bottom player bar plays local audio files from the iTunes source. The playback capability is defined as an optional source interface so future sources (Plex, Spotify, etc.) can implement it independently.

## Decisions

| # | Decision |
|---|----------|
| 1 | iTunes local files only for initial implementation |
| 2 | Extensible `Playable` source interface (mirrors `CollectionWritable`) |
| 3 | Persistent bottom player bar (Spotify/Apple Music model) |
| 4 | Hover play button on track rows — both middle-pane track list and release detail tracklist |
| 5 | Single-track playback only — no queue or auto-advance in this slice |
| 6 | Space bar toggles play/pause (when not in an input) |

---

## Architecture

### 1. Source interface (`src/lib/server/sources/types.ts`)

New types added alongside `CollectionWritable`. `types.ts` is server-only (`src/lib/server/`) so adding `import type { Database } from 'bun:sqlite'` is safe:

```ts
export type TrackStream =
  | { kind: 'file'; path: string; mimeType: string }
  | { kind: 'redirect'; url: string }

export interface Playable {
  resolveTrackStream(entityId: string, db: Database): Promise<TrackStream | null>
}

export function isPlayable(source: MusicSource): source is MusicSource & Playable {
  return typeof (source as any).resolveTrackStream === 'function';
}
```

`resolveTrackStream` receives the internal entity ID (not source external ID) so the implementation can query the DB directly without a source-link lookup.

### 2. iTunes implementation (`src/lib/server/sources/itunes/index.ts`)

`itunesSource` gains `Playable`. The `match_key` table already stores the decoded filesystem path for every iTunes track under `key_type='file_path'` (set during sync via `normalizeFilePath`, which strips `file://` and percent-decodes — no new DB columns needed):

```ts
async resolveTrackStream(entityId, db) {
  const row = db.prepare(
    `SELECT key_value FROM match_key
     WHERE entity_kind='track' AND entity_id=? AND key_type='file_path'`
  ).get(entityId) as { key_value: string } | undefined
  if (!row) return null
  return { kind: 'file', path: row.key_value, mimeType: mimeFromPath(row.key_value) }
}
```

`mimeFromPath` maps common extensions: `.m4a`/`.aac` → `audio/aac`, `.mp3` → `audio/mpeg`, `.flac` → `audio/flac`, `.aiff`/`.aif` → `audio/aiff`, fallback → `audio/octet-stream`.

**Security:** Only paths registered in the DB via `match_key(file_path)` are reachable. The lookup itself is the guard — arbitrary paths cannot be served.

### 3. Stream endpoint (`src/routes/api/stream/[trackId]/+server.ts`)

`GET /api/stream/[trackId]`

1. Look up track entity — 404 if not found.
2. Fetch `source_link` rows for the track.
3. Walk sources in registry order; for each `isPlayable` source, call `resolveTrackStream(entityId, db)`.
4. First non-null result wins.
5. `kind: 'file'` → read file from disk, stream with `Content-Type`, `Accept-Ranges: bytes`, and `Range` header support (required for audio seeking in `<audio>`).
6. `kind: 'redirect'` → `302` to the URL.
7. 404 if no source can provide a stream.

Range handling: parse `Range: bytes=start-end`, respond `206 Partial Content` with `Content-Range`. Full file on a missing/invalid Range header.

### 4. `canPlay` on TrackRow (`src/lib/server/library/queries.ts`)

`TrackRow` gains `canPlay: boolean`. Computed server-side so the client doesn't need to know which sources are Playable:

```ts
const playableSources = new Set(
  listSources().filter(isPlayable).map(s => s.id)
)

// in listTracks() and getTrackDetail():
canPlay: (row.sources as string[]).some(id => playableSources.has(id))
```

Applied to: `listTracks()`, `getTrackDetail()`, and the tracklist array returned by `getReleaseDetail()`.

**No DB migrations required.**

---

## Client-side components

### Player store (`src/lib/stores/player.svelte.ts`)

Svelte 5 runes store following the `explorerState.svelte.ts` pattern:

```ts
interface NowPlaying {
  trackId: string
  title: string
  artist: string
}

let nowPlaying = $state<NowPlaying | null>(null)
let isPlaying  = $state(false)
let currentTime = $state(0)
let duration    = $state(0)
let error       = $state<string | null>(null)

export const player = {
  get nowPlaying() { return nowPlaying },
  get isPlaying()  { return isPlaying },
  get currentTime() { return currentTime },
  get duration()   { return duration },
  get error()      { return error },
  play(track: NowPlaying): void,
  pause(): void,
  resume(): void,
  seek(seconds: number): void,
  stop(): void,
}
```

Stream URL is always derived: `/api/stream/${nowPlaying.trackId}`.

### Player.svelte

Invisible component that owns the `<audio>` element. Mounted unconditionally inside `Explorer.svelte` so it persists across navigation. Uses Svelte `bind:` directives to sync `paused`, `currentTime`, `duration` with the player store, and forwards `store.play()` / `store.seek()` calls to the element. Surfaces `error` on `<audio>` error events.

### PlayerBar.svelte

Visible strip rendered at the bottom of `Explorer.svelte`, only when `player.nowPlaying !== null`. Layout:

```
[ title / artist ]  [ ⏸  1:02 ━━━━━●━━━━━━ 4:17 ]  [ (spacer) ]
```

- Title + artist on the left (truncated with ellipsis).
- Play/pause toggle, scrubber (click-to-seek), elapsed/total times centered.
- Scrubber click → `player.seek(clickFraction × duration)`.
- No skip controls in this slice.

### Hover play buttons

Added to two components:

**`TrackList.svelte`** (middle pane rows): Each row gains a `▶` icon in the left gutter. Visibility rules:
- `canPlay === false`: icon hidden (opacity 0, takes no interaction).
- `canPlay === true`, row not playing: icon shown on `:hover`.
- Row is `nowPlaying`: green accent on title + icon always visible (green).

Click → `player.play({ trackId, title, artist })`.

**`ReleaseDetail.svelte`** (tracklist in detail pane): Same pattern on each track row in the tracklist.

### Keyboard shortcut

Space → `player.isPlaying ? player.pause() : player.resume()`. Guard: not focused in input/textarea, and `player.nowPlaying !== null`. Wired via the existing `installKeyboard` DOM-driven system in `+page.svelte`.

---

## File changes summary

| File | Change |
|------|--------|
| `src/lib/server/sources/types.ts` | Add `TrackStream`, `Playable`, `isPlayable()` |
| `src/lib/server/sources/itunes/index.ts` | Implement `Playable` on `itunesSource` |
| `src/routes/api/stream/[trackId]/+server.ts` | New — stream endpoint |
| `src/lib/server/library/queries.ts` | Add `canPlay` to `TrackRow`, `listTracks`, `getTrackDetail`, `getReleaseDetail` |
| `src/lib/stores/player.svelte.ts` | New — player store |
| `src/lib/components/Player.svelte` | New — `<audio>` owner |
| `src/lib/components/PlayerBar.svelte` | New — bottom bar UI |
| `src/lib/components/TrackList.svelte` | Hover play button + now-playing state |
| `src/lib/components/ReleaseDetail.svelte` | Hover play button on tracklist rows |
| `src/routes/+page.svelte` | Space bar shortcut |
| `src/lib/components/Explorer.svelte` | Mount `<Player>` + `<PlayerBar>` |

---

## Out of scope (this slice)

- Queue / playlist / auto-advance
- Skip forward/back controls
- Volume control
- Any source other than iTunes
- Discogs preview URLs or external streaming links
