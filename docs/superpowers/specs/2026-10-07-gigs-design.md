# Gigs: crate + sketch — design

Status: approved in brainstorm 2026-10-07. Milestone 1 (prep) only.

## Why

Preparing a set happens in two loose stages: pulling the records to bring, then
sketching ideas of what might get played and roughly when. Neither is a
commitment — the night decides. Booth has playlists (a committed ordered list)
and vetting (a permanent judgment on a record), but nothing for "these are the
records in the bag for *this* gig" or "these tracks feel like openers".

## Milestones

1. **Prep (this spec).** Laptop. Build the crate, sketch tracks into sections.
2. **At the gig.** Phone in the booth as a cheat sheet: current section, which
   records hold its ideas, BPM/key at a glance.
3. **After.** Mark what was actually played; the gig becomes a record of the night.

Milestone 1's data model must not need redesigning for 2 or 3 (a played mark is
one nullable column on a sketched track).

## Concepts

- **Gig** — not a separate entity. A playlist that has a crate or more than one
  section renders with the gig layout. No flag to keep in sync.
- **Crate** — the records being brought. Does not empty as tracks are sketched;
  it *is* the bag. A crate record with no sketched tracks is a legitimate state
  ("bringing it, no plan yet").
- **Sketch** — the playlist's tracks, grouped into ordered, user-named
  **sections** (e.g. "openers / ambient", "funkier", "closers"). Nothing
  hard-coded. Section order is the arc of the night; order within a section is
  a loose pool, reorderable but not meaningful.
- **Unsorted** — every playlist has exactly one, undeletable, always first. In a
  plain playlist it is the only section and is not shown, so existing playlists
  look and behave exactly as today.
- Independent of vetting: crating a record doesn't vet it, and vetting doesn't
  require crating.

## Data model (migration 013)

- `playlist.target_minutes INTEGER NULL` — optional set length. No date.
- `playlist_section (id, playlist_id → playlist ON DELETE CASCADE, name,
  position, is_unsorted)`. Migration backfills one Unsorted section per existing
  playlist; `createPlaylist` creates one.
- `playlist_track` rebuilt:
  - surrogate `id` primary key (the composite `(playlist_id, track_id)` key
    can't survive `track_id` becoming nullable);
  - `track_id → track ON DELETE SET NULL` (was CASCADE);
  - `section_id → playlist_section`; `position` is within the section;
  - snapshot columns: `snap_artist`, `snap_title`, `snap_album`,
    `snap_position` (release track position);
  - partial unique index on `(playlist_id, track_id) WHERE track_id IS NOT NULL`
    — a track appears at most once per playlist, as now.
  - Existing rows migrate into their playlist's Unsorted section in current order.
- `playlist_release (id, playlist_id → playlist ON DELETE CASCADE,
  release_id → release ON DELETE SET NULL, position, added_at, snap_artist,
  snap_title, snap_year)`; partial unique index on
  `(playlist_id, release_id) WHERE release_id IS NOT NULL`.

## Rules

- Sketching a track adds its release to the crate if absent.
- Removing a crate record that still has sketched tracks asks first; confirming
  removes the record and those tracks.
- Deleting a section moves its tracks to the end of Unsorted. It never removes
  tracks.
- Adding a track already in the gig is a no-op with an "Already in <section>"
  toast.

## Not losing ideas

Tracks and records disappear from the library when their last source drops
them: a local file moved or renamed (re-keyed as a new track), a record removed
from the Discogs collection, a Discogs tracklist edit. Today that cascade
silently deletes playlist membership. This applies to all playlists, not just
gigs, and closes the existing "known limitation" in CONTEXT.md.

- **Missing, not deleted.** `ON DELETE SET NULL` keeps the row in place; the UI
  renders it greyed from its snapshot with a "missing" label. Missing rows are
  skipped by playback and excluded from runtime/BPM summaries. They can be
  removed by hand.
- **Re-link after sync.** After each `runSync`, missing rows are matched against
  the library on their snapshot (normalised artist + title + album for tracks;
  artist + title for releases), using the existing normalisers. Only a single
  unambiguous match re-links; anything ambiguous stays missing. A re-link that
  would collide with the partial unique index (the track is already in the
  playlist) leaves the missing row as is.
- **Journal.** Playlist mutations (create/rename/delete playlist, section
  add/rename/move/delete, track add/move/remove, crate add/remove, target length)
  append to a new `playlists.log` JSONL beside `annotations.log`, each event
  carrying name snapshots. `scripts/restore-playlists.ts` replays it, optionally
  `--as-of`, dry run unless `--apply`, additive by default — the same contract
  as `restore-annotations.ts`.

## UI

**Gig layout** (in place of `PlaylistView` when the playlist is a gig):

- Header: name, target length vs sketched runtime (`+` suffix when durations are
  unknown, as now), crate count.
- **Sketch** (main column): sections as collapsible bands in order. Band header
  shows name, track count, runtime, BPM range. Rows show the existing playlist
  columns plus BPM and key where known, and notes read-only.
  - "＋ section" at the bottom; rename inline; drag band header to reorder.
  - Drag tracks within and between bands.
  - Playing a track queues the whole sketch in section order (missing and
    unplayable tracks skipped, matching the queue's existing behaviour).
- **Crate** (right panel, replacing the empty detail pane): one row per record —
  sleeve, artist — title, sketched-track count, or "—" for none. Missing records
  greyed.
  - Clicking a record swaps the panel to its tracklist (`ReleaseDetail`) with a
    back control. Tracks there can be added to Unsorted or dragged onto a band.
  - "＋ add record": library search for releases.

**Entry points**

- "＋ New gig" in the rail's Playlists section: name + optional target length.
- An existing playlist becomes a gig by adding a section or a crate record.
- Tracks: existing `a` key / `PlaylistPicker` and drag-to-rail add to Unsorted;
  dragging onto a band places it in that section.
- Records: `c` on a release row opens a picker to add it to a gig's crate;
  release rows can be dragged onto a gig in the rail.

**Mobile**: functional only — sketch bands stacked, crate as a second segment.
The proper booth view is milestone 2.

## Out of scope (milestone 1)

Phone cheat-sheet view, played marks, barcode-scanner crate entry (many records
lack barcodes; revisit if library search is slow at the shelf), export to
Rekordbox or other DJ software, gig dates.

## Verification

No test suite. Verify against a copy of the database made with
`sqlite3 .backup` (never `cp`):

- `bun verify scripts/verify-gigs.ts`: migration preserves every existing
  playlist's tracks and order; section delete moves tracks to Unsorted; crate
  auto-add; deleting a track/release leaves a missing row with snapshot;
  re-link after a simulated rename; ambiguous match stays missing; journal
  replay reproduces the state. Cleanup deletes only ids the script created.
- UI via the CDP harness: create gig, add sections, drag between bands, add a
  record and pull a track from its tracklist, playback order, existing plain
  playlist renders unchanged.
- `bun check`.

CONTEXT.md: update Playlists (sections, crate, missing rows, journal), remove
the known limitation, add the gig layout to the feature inventory.
