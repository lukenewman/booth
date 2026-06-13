# Playlists (MVP) — design

> **Status:** approved design, pre-implementation.
> **Scope:** manual, in-app listening-set playlists. No queue/auto-advance, no export/sync (those are future directions, see end).

## Goal

Let the user curate ordered sets of tracks across sources and revisit them in a new Rail section. MVP delivers manual playlists end to end: create, rename, delete, add tracks (drag or keyboard), reorder, and remove. Playback stays exactly as today — double-clicking a track plays that single track through the existing player. No queue or auto-advance in this slice.

## Core principle: playlists are a Booth-native layer, not a source

A playlist is an organizational layer over the unified `track` table. It references `track` ids directly and **never touches** the `source_link` / `source_facets` / `match_key` machinery — that system is for external-source ingestion, and a playlist is neither ingested nor owned by a source.

Consequences:
- Playability is resolved the existing way (`canPlay` from playable source links). Playable and non-playable (e.g. Discogs-only) tracks can both sit in a playlist; non-playable ones render greyed with no play affordance, identical to everywhere else in the UI.
- No source adapter, no `sync()`, no `collate` involvement.

## Data model (migration `007_playlists.sql`)

```sql
CREATE TABLE playlist (
  id         TEXT PRIMARY KEY,   -- ULID
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL,      -- ISO8601
  updated_at TEXT NOT NULL
);

CREATE TABLE playlist_track (
  playlist_id TEXT NOT NULL REFERENCES playlist(id) ON DELETE CASCADE,
  track_id    TEXT NOT NULL REFERENCES track(id)    ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  added_at    TEXT NOT NULL,     -- ISO8601
  PRIMARY KEY (playlist_id, track_id)
);
CREATE INDEX idx_playlist_track_order ON playlist_track(playlist_id, position);
```

- **Dedupe:** `PRIMARY KEY (playlist_id, track_id)` guarantees a track appears at most once per playlist. Adding a present track is an `INSERT OR IGNORE` → no row change → quiet "already in playlist" toast.
- **Ordering:** `position` is a clean `0..n` sequence. Add appends at `max(position)+1`. Reorder and remove rewrite the affected playlist's positions to `0..n` in one transaction. Playlists are small, so a full renumber is simpler than fractional ranks and has no practical cost.
- **`updated_at`** bumps on every mutation (rename, add, remove, reorder). The rail sorts playlists alphabetically by `name` for findability; switching to recently-updated later is a one-line change.
- **Cascade:** deleting a playlist or a track removes the join rows automatically (`ON DELETE CASCADE`, with `PRAGMA foreign_keys = ON` already set project-wide).

## Rail + navigation

- New **Playlists** section in `Rail.svelte`, placed after Library (before Sources). Each playlist is a rail item showing name + track count, carrying the existing `.rail button.item` class so `[` / `]` rail-nav and `↑`/`↓` pick it up with no extra wiring.
- A **＋ New playlist** affordance at the bottom of the section → inline text input → `Enter` creates the playlist (and selects the new item), `Esc` cancels.
- Selecting a playlist sets `?nav=playlist:<id>` and clears `?id`. `explorerState.svelte.ts` already mirrors arbitrary `?nav` strings, so this is a new namespace alongside `library:` / `sources:` / `add:`.
- Rail playlist items double as **drop targets** for drag-to-add: they highlight on `dragover` and accept a dropped track payload.

## Playlist view (middle pane)

When `nav=playlist:<id>`, the middle pane renders a new `PlaylistView.svelte` (Listview-backed track list specialized for playlists):

- **Entity lens suppressed.** Playlists are tracks-only, so the toolbar omits the `.toggle` element — the same mechanism `add:discogs` uses, which makes `Tab` a no-op there.
- **Toolbar:** playlist name (click to rename inline → `PATCH`) + track count + a delete control. Delete uses an inline confirm bar, reusing the discard-confirmation pattern from `RecordSession.svelte`.
- **Rows** reuse the existing track-row rendering (artist / title / `canPlay` / ▶ playing indicator), plus per-row affordances:
  - double-click plays the track (existing single-track behavior, unchanged),
  - an `×` remove control on hover,
  - a drag handle for reorder.
- **Keyboard:** a selected/focused row + `Delete` or `Backspace` removes it from the playlist.
- **Empty state:** an empty playlist renders `EmptyState` with a "drag tracks here" hint.
- **Detail pane:** clicking a row opens `TrackDetail.svelte` in the right pane (reused, unchanged).

## Drag-and-drop

Native HTML5 DnD throughout — no new dependency (consistent with Booth's no-UI-library stance). A shared payload shape disambiguates both flows:

```
dataTransfer: { kind: 'track', trackId }
```

- **Add:** rows in `TrackList.svelte` and the `ReleaseDetail.svelte` tracklist become `draggable`; `dragstart` sets the payload. Rail playlist items are drop zones; `drop` → `POST /api/playlists/[id]/tracks`. Success bumps the rail track count; a duplicate yields the quiet "already in playlist" toast.
- **Reorder:** inside `PlaylistView`, rows are `draggable`; dragover between rows shows an insertion indicator; `drop` recomputes the order and calls `PATCH /api/playlists/[id]/tracks`.

If native reorder ergonomics prove poor in practice, revisit `svelte-dnd-action` — explicitly out of scope for the MVP.

## Keyboard add-to-playlist

- New global shortcut **`a`** ("add to playlist"), currently unused. Acts on the focused track row → opens a small centered `PlaylistPicker.svelte` overlay (same component family as `ShortcutOverlay` / `Scanner`):
  - lists playlists with type-to-filter,
  - `↑`/`↓` + `Enter` adds the track to the chosen playlist,
  - a **＋ New playlist…** row at the top creates a playlist and adds the track in one step,
  - `Esc` cancels.
- Suppressed when focus is in an input/textarea (consistent with other shortcuts).
- Works wherever a track row has DOM focus — `TrackList` and `PlaylistView`. Drag-add additionally covers the `ReleaseDetail` tracklist (its rows aren't focusable today; giving them focus for keyboard-add there is a small optional extension, not MVP).
- Wiring stays DOM-driven via `installKeyboard(actions, guards)`: `a` resolves the focused row's track id by class lookup at event time, matching the existing keyboard architecture.

## Server

`src/lib/server/library/playlists.ts` — all playlist queries, isolated from `queries.ts`:

- `listPlaylists(db)` → `[{ id, name, trackCount }]`
- `createPlaylist(db, name)` → `{ id, name, trackCount: 0 }`
- `renamePlaylist(db, id, name)`
- `deletePlaylist(db, id)`
- `getPlaylist(db, id)` → `{ playlist, tracks }`, tracks ordered by `position`, in the **existing track-row shape** (JOIN `artist`, alias `artist.name AS artist`, `canPlay` computed) so `PlaylistView` renders them through the same row code. Reuse / extract the track-row select from `queries.ts` rather than duplicating it.
- `addTrack(db, playlistId, trackId)` → `INSERT OR IGNORE` at `max(position)+1`; returns `{ added: boolean }`.
- `removeTrack(db, playlistId, trackId)` → delete + renumber.
- `reorderTracks(db, playlistId, orderedTrackIds)` → rewrite positions `0..n` in one transaction.

### API routes (`src/routes/api/playlists/`)

| Method + path | Body | Returns |
|---|---|---|
| `GET /api/playlists` | — | `[{ id, name, trackCount }]` |
| `POST /api/playlists` | `{ name }` | `{ id, name, trackCount: 0 }` |
| `GET /api/playlists/[id]` | — | `{ playlist, tracks: [trackRow…] }` |
| `PATCH /api/playlists/[id]` | `{ name }` | `{ id, name }` |
| `DELETE /api/playlists/[id]` | — | `204` |
| `POST /api/playlists/[id]/tracks` | `{ trackId }` | `{ added: boolean, trackCount }` |
| `DELETE /api/playlists/[id]/tracks/[trackId]` | — | `{ trackCount }` |
| `PATCH /api/playlists/[id]/tracks` | `{ order: [trackId…] }` | `204` |

`404` for unknown playlist ids; `400` for malformed bodies.

## Client

- **`stores/playlists.svelte.ts`** — client mirror modeled on `collection.svelte.ts`: holds `playlists: [{ id, name, trackCount }]` and exposes `load()`, `create(name)`, `rename(id, name)`, `remove(id)`, `addTrack(id, trackId)`, `removeTrack(id, trackId)`, `reorder(id, order)`. Each calls the API and updates local state (including `trackCount`) so the rail stays live without a refetch.
- **`PlaylistView.svelte`** (new, middle pane) — rows with remove + drag-reorder; toolbar with rename + delete.
- **`PlaylistPicker.svelte`** (new overlay) — keyboard add picker.
- **`Rail.svelte`** — render the Playlists section from the store; the new-playlist input; drop-target handlers.
- **`Explorer.svelte`** — route `nav=playlist:<id>` to `PlaylistView`; fetch playlist detail; wire add/remove/reorder/rename/delete handlers through the store.
- **`+page.svelte` / `keyboard.svelte.ts`** — add `a` (open picker for focused track) and `Delete`/`Backspace` (remove focused row in `PlaylistView`) to `installKeyboard`.

## Edge cases & known limitations

- **Track-id churn (known limitation).** Membership keys on track ULID. Local and vinyl-rip track ids are stable, so listening-set tracks (the playable ones the user actually adds) are safe. If a Discogs re-sync ever deletes and recreates a track row with a new id, the `ON DELETE CASCADE` silently drops it from playlists. Confirm Discogs sync churn behavior during planning; durable re-keying is out of MVP scope.
- **Non-playable tracks** are allowed in playlists and render greyed (no play affordance), matching `canPlay` handling elsewhere.
- **No queue / auto-advance.** Double-click still plays exactly one track. Queue semantics are a fast-follow.
- **Reorder is a full renumber** per playlist — fine at this scale.

## Verification

- **`scripts/verify-playlists.ts`** (run via `bun verify`): create → add (incl. dedupe no-op) → reorder → remove → delete; assert `position` sequence is contiguous after each mutation and that cascade removes join rows on playlist delete and on track delete.
- **`bun check`** for types.
- **Manual browser pass**: drag-to-add from both `TrackList` and `ReleaseDetail`; drag-to-reorder; `a` keyboard picker incl. create-and-add; rename; delete with confirm; non-playable track renders greyed.

## Context docs

Update `docs/CONTEXT.md` in the implementation commit(s):
- New **Playlists** feature-inventory section.
- Migration `007_playlists.sql` in the migrations list.
- New files (`PlaylistView`, `PlaylistPicker`, `playlists.svelte.ts`, `library/playlists.ts`, `/api/playlists/*`) in the file map.
- The `?nav=playlist:<id>` namespace in the URL-state section.
- The "playlists are a native layer, not a source" principle.
- The new `a` and `Delete` keyboard shortcuts.

## Future directions (tracked, not in MVP)

The originating brainstorm identified three follow-on directions to preserve:
1. **DJ set / crate prep** — sequencing and performance prep (key/BPM-aware ordering, crates).
2. **Export / sync out** — push playlists to external systems (Rekordbox crates, Apple Music playlists).
3. **Flexible library organization** — playlists/tags as a broader grouping layer over the library.

Nearest fast-follow to this MVP: **playback queue** (auto-advance + next/prev in the `PlayerBar`), which turns saved lists into true in-app listening sets.
