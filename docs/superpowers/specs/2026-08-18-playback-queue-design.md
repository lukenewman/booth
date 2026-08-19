# Playback queue (prev/next + auto-advance) — design

> Status: approved, not yet implemented. Slice: queue model + prev/next + auto-advance. A visible up-next panel and shuffle/repeat are explicitly out of scope (see Future directions).

## Goal

Give the player a notion of *what is playing next*, so the transport can offer prev/next and a finished track can advance instead of stopping.

Today `player.nowPlaying` is a single track with no idea where it came from, and `Player.svelte`'s `onended` calls `player.stop()`. "Next" therefore has no defined answer. This slice defines one.

## Core principle: the queue is a snapshot of where you pressed play

The queue is captured **at play time** and does not follow the UI afterwards. Browsing to another release, re-sorting the library, or opening a playlist does not alter a queue already in flight. Only pressing play again replaces it.

This is the Spotify model, and it is the only one that stays predictable when playback and navigation are independent — which they are here, because the player bar persists across every rail item.

## Playback context

```ts
export type PlaybackContext =
  | { kind: 'release';  releaseId: string;  ids: string[] }
  | { kind: 'playlist'; playlistId: string; ids: string[] }
  | { kind: 'library';  query: LibraryQuery };

export interface LibraryQuery {
  source?: string;
  q?: string;
  sort: SortKey;
  multiSource?: boolean;
}
```

Release and playlist contexts carry their ids inline because **both already hold their complete ordered list client-side**: playlists are not paginated (`playlists.ts` has no limit/offset on track loading — its only `limit` is the cover mosaic), and `ReleaseDetail` receives a full `tracks` array. Only the library/source listview is paginated (200 rows, lazily extended), so only `kind: 'library'` needs resolving against the server.

All three converge inside the store on `ids[] + index`, so prev/next/advance have exactly one code path regardless of origin.

## Store changes (`src/lib/stores/player.svelte.ts`)

New state:

- `queue: string[]` — resolved, ordered track ids
- `queueIndex: number` — position within `queue`; `-1` when there is no queue
- `context: PlaybackContext | null` — the captured context, retained so a later up-next panel can name its origin and so the queue's provenance is inspectable while debugging. No UI reads it this slice.

New entry point, replacing direct `play()` calls from list UIs:

```ts
playFrom(context: PlaybackContext, trackId: string, meta: NowPlaying): Promise<void>
```

It sets `nowPlaying` from `meta` and starts audio **immediately**, then resolves the queue. Resolution must never gate playback — pressing play is not allowed to wait on a 113KB fetch.

`play(track)` remains as the low-level primitive `playFrom` delegates to once it has resolved a queue. It also stays available to any caller with no list context, which leaves `queueIndex` at `-1` and prev/next disabled. After this slice every list UI calls `playFrom`; `play` is not called directly from components.

### Metadata cache

The queue holds ids, but the player bar renders title/artist/artwork. Advancing beyond the loaded 200 rows yields an id with no metadata attached.

Resolution: the store keeps `Map<trackId, NowPlaying>`, seeded with whatever rows the call site already had (it is rendering them, so it has them). On advancing to an id absent from the cache, fetch that single track and fill it in.

Audio is unaffected either way — `/api/stream/{trackId}` needs only the id — so the cost is the bar's text arriving a beat after the sound. The alternative (returning full rows from the ids endpoint) inflates ~113KB to roughly a megabyte to optimise a case that only arises past row 200.

Cache is cleared whenever the queue is replaced, so it cannot grow unbounded across a session.

## Server

### `GET /api/library/tracks/ids`

Accepts the same parameters as `/api/library/tracks`: `source`, `q`, `sort`, `multi_source`. Returns:

```json
{ "ids": ["01K…", "01K…"] }
```

Two hard requirements:

1. **Identical ordering to `listTracks` under identical parameters.** If the two ever disagree, "next" plays something other than the row below the one you clicked — a bug that would present as random-seeming track order and be miserable to trace. The endpoint must therefore reuse the WHERE/ORDER construction rather than re-implement it: extract the shared clause-building out of `listTracks` into a helper both call. This is the single most important invariant in the slice.
2. **Playable tracks only.** The library holds 5,671 tracks but only 4,343 with local files; an unfiltered queue would contain ~1,300 Discogs-only dead ends. Filter to tracks having a `source_link` from a playable source — the same `playableSources` set `queries.ts` already computes for `canPlay`.

No pagination: the whole point is completeness. At current library size the response is ~113KB.

## Semantics

| Action | Behaviour |
|---|---|
| `next()` | advance one index; at the last item, stop and keep it loaded+paused (no wrap) |
| `prev()` when `currentTime > 3` | restart the current track (seek to 0) |
| `prev()` when `currentTime <= 3` | step back one index; at index 0, restart instead |
| track ends | `next()` — replaces the current `onended → player.stop()` |
| queue exhausted | stop; last track stays loaded and paused, not cleared |
| no queue (`queueIndex === -1`) | prev/next are no-ops and render disabled |

The 3s threshold is the conventional one and applies to `prev()` only.

## Client wiring

- `Player.svelte`: `onended` calls `player.next()` instead of `player.stop()`.
- `PlayerBar.svelte`: `⏮ ⏯ ⏭` in the transport row above the scrubber; prev/next disabled when there is no queue or no neighbour in that direction.
- Call sites pass a context:
  - `ReleaseDetail` → `{ kind: 'release', releaseId, ids: tracks.filter(canPlay).map(id) }`
  - `PlaylistView` → `{ kind: 'playlist', playlistId, ids: … }`
  - `TrackList` → `{ kind: 'library', query }`. `TrackList` does not own the filter/sort state — `Explorer` does — so `Explorer` passes the query down as a prop.

Ids supplied inline must be filtered to playable tracks by the call site, matching the endpoint's guarantee, so that no context can produce a dead end.

## Verification

`scripts/verify-queue.ts`:

- advance from the middle, from the last index (stops, no wrap), and with an empty queue
- `prev` at `currentTime > 3` restarts; at `<= 3` steps back; at index 0 restarts rather than underflowing
- auto-advance at the end of the queue leaves the last track loaded and paused, not cleared

`scripts/verify-track-ids.ts`:

- `listTrackIds` returns exactly the ids of `listTracks`, in the same order, over a seeded DB across several parameter combinations (default sort, `added-asc`, `added-desc`, with `q`, with `source`) — the ordering invariant above
- unplayable (no local file) tracks appear in `listTracks` but never in `listTrackIds`

## Edge cases & known limitations

- **A track removed from the library mid-queue** leaves a stale id. Advancing to it 404s on the metadata fetch; skip it and keep moving in the same direction until a track resolves or the queue ends. The scan must be bounded by the queue length so a run of stale ids terminates rather than spinning.
- **Re-sorting while playing does not rebuild the queue.** Intentional (see core principle), but worth knowing: the queue can hold an order no longer visible on screen.
- **The queue is in-memory only.** A page reload loses it, exactly as the loaded track is lost today.
- **Playlist reordering mid-playback** is not reflected in an already-captured queue.

## Context docs

On completion, update `docs/CONTEXT.md`: the Playback section gains the queue model, the ids endpoint, and the prev/next semantics table; the file map gains `tracks/ids/+server.ts`; and the playlists "no queue/auto-advance yet (fast-follow)" note is removed.

## Future directions (tracked, not in this slice)

- Visible up-next panel (popover from the player bar; jump to item, reorder, remove)
- Shuffle (stable shuffled order, not re-rolled per advance) and repeat one/all
- Persisting the queue across reloads
