# Stars + vetting — design

> **Status:** approved design, pre-implementation.
> **Scope:** binary track stars, a release-level "vetted" flag, and the two library views that consume them. No ratings, no release stars, no dedicated review mode (see Future directions).
> **Ticket:** BOO-42.

## Goal

Let the user work through a ~1,400-release collection and come out the other side with the undeniably good tracks flagged. The workflow is: open a release, listen, star the tracks that earn it, mark the release done, move to the next. The feature has to make that loop cheap enough to repeat a thousand times, and has to show how much of the collection is left.

## Two flags, and why the second one can't be derived

**A star is a binary keeper flag on a track**, not a rating. A track is either undeniably good or it isn't; there is no 3-out-of-5.

**A release is "vetted" once the user has been through it and made their calls.** This is a separate stored flag, and the temptation to replace it with "does this release have starred tracks?" is the main trap in the design. That check conflates two opposite states:

- *I haven't listened to this yet* — work remaining.
- *I listened and none of it made the cut* — work done.

Deriving vetted-ness would permanently re-surface every mediocre record the user already dismissed, which is exactly the pile the feature exists to shrink. A release with zero starred tracks and `vetted_at` set is a legitimate terminal state, and only a stored flag can express it.

**Release stars are deliberately not stored.** A release-level star could mean either "this whole record is a front-to-back keeper" or "this release contains starred tracks" — and the second is derivable. Rather than ship an ambiguous affordance, releases carry a derived count of their starred tracks and nothing else. If a genuine front-to-back keeper flag is wanted later, it can be added without disturbing anything here.

## Core principle: annotations are a Booth-native layer

Stars and vetting are the user's own judgments, not facts any source reported. Like playlists, they never touch `source_link` / `source_facets` / `match_key`.

Unlike playlists, they need no join table: a star is strictly one-to-one with its track, and vetted-ness one-to-one with its release. They are columns on the entity tables.

## Data model (migration `009_stars.sql`)

```sql
ALTER TABLE track   ADD COLUMN starred_at TEXT;  -- ISO8601; NULL = not starred
ALTER TABLE release ADD COLUMN vetted_at  TEXT;  -- ISO8601; NULL = not vetted

CREATE INDEX idx_track_starred  ON track(starred_at)   WHERE starred_at IS NOT NULL;
CREATE INDEX idx_release_vetted ON release(vetted_at)  WHERE vetted_at  IS NOT NULL;
```

- **Timestamps, not booleans.** Truthiness is `IS NOT NULL`, identical in cost to a `0/1` check, but the column also answers "what did I star recently" and "when did I go through this record". A boolean throws that away permanently for no saving.
- **Partial indexes.** The starred set stays small against ~5,700 tracks and the vetted set grows from zero, so an index restricted to non-NULL rows stays proportional to the data that exists rather than the table it hangs off.
- **Column naming matches the UI vocabulary.** The UI says "vetted"; the column says `vetted_at`. Single-user app, no reason to maintain a translation layer.

### Survivability across sync

Verified against the collate path: entity upserts use targeted column-list `UPDATE` statements, never a whole-row replace, so a re-sync leaves both new columns untouched. No change to collate is required.

**Known limitation — entity identity churn.** The prune step deletes entities that no longer resolve to any source. If a local file is moved or renamed, it re-keys on its file path, producing a *new* track row while the old one is pruned — and the star goes with it, silently. This is mitigated rather than solved (see below), because keying stars on match keys instead of entity ids would be a large change to serve a rare event.

## Safeguard: `scripts/export-stars.ts`

A dump/restore pair keyed on **artist + title + album**, not entity ULIDs, so the data survives identity churn and can be replayed into a rebuilt database. Roughly forty lines, and the justification is proportionality: the user is investing on the order of sixty hours creating this data by hand, and every other entity in the database is reconstructible from a source while this one is not.

## Queries

- `TrackFilterArgs` gains `starred?: boolean` → `track.starred_at IS NOT NULL`.
- `ListReleasesArgs` gains `vetted?: boolean` → `release.vetted_at IS NULL` for the queue view.
- `TrackRow` gains `starred_at`. `ReleaseRow` gains `vetted_at` plus a derived `starred_count` over its tracks — the badge that replaces a stored release star.
- Both are plain `WHERE` clauses, so they compose with the existing source / `q` / multi-source filters at no cost.
- **`listTrackIds` inherits `starred` for free** because it shares the track-query builder with `listTracks`. The moment the filter exists, "play all my starred tracks" works through the existing playback queue with no queue-side work. This is the payoff for the two having been deduplicated earlier.

## Routes

```
PUT    /api/library/tracks/[id]/star     DELETE /api/library/tracks/[id]/star
PUT    /api/library/releases/[id]/vet    DELETE /api/library/releases/[id]/vet
```

Following the playlist route shape. Each returns the updated row so the client can patch in place rather than refetch a list mid-scroll.

## Rail + navigation

The Library section grows from one item to three:

```
Library
  All        1,426
  Starred        —
  Unvetted   1,426
```

`?nav=library:starred` and `?nav=library:unvetted` slot into the existing `section:item` namespace with no parser changes.

**The Unvetted count is the feature's progress meter** — the single number that tells the user how much collection is left. It is the reason the count belongs in the rail rather than only in the view.

### The queue is flat

All releases appear in Unvetted, including the ~200 with no local files. The user owns those records and vets them at the turntable; that is real work and it counts toward the same goal. The alternative — hiding unplayable releases, or sinking them to the bottom — was considered and rejected as making the progress number dishonest about the collection.

## UI surfaces

| Surface | Change |
|---|---|
| `TrackList`, `PlaylistView` | star glyph per row, filled/hollow, click to toggle |
| `ReleaseList`, `ReleaseGrid` | vetted check + starred-count badge |
| `ReleaseDetail` | stars on tracklist rows + a **Mark vetted** CTA that toggles back to **Vetted ✓ / undo** once set |
| `PlayerBar` | star for the now-playing track |
| `MobileShell` | same two rail items; star targets already meet the 44px minimum |

**Star target is the selected row**, matching how add-to-playlist and remove already behave. Targeting the now-playing track instead was rejected: playback state changes on its own as tracks end and advance, so the key would silently retarget between presses. The `PlayerBar` star covers the case where playback has drifted ahead of the selection — an explicit second control rather than an invisible mode switch.

**Auto-advance.** Marking a release vetted while in the Unvetted queue drops it from the list and opens the next one. Everywhere else the control only sets the flag. Scoping the advance to the queue keeps it from hijacking navigation mid-browse, and it is what makes a 1,400-item grind survivable — without it the user pays an extra navigation gesture a thousand-odd times.

**The badge and the check must read differently.** Releases with starred tracks but no vetted flag will appear in the Unvetted queue. That is correct — it is a "you started this and stopped" signal — but it looks like a bug if the two indicators are visually similar.

## Keyboard

| Key | Action |
|---|---|
| `s` | toggle star on selected row — opens the scanner in Add → Discogs |
| `v` | mark vetted + advance |

`s` is context-dependent, resolved by element presence in the same idiom the entity-lens toggle already uses:

```js
if (e.key === 's' || e.key === 'S') {
  e.preventDefault();
  if (guards.isScannerAvailable()) {
    if (!guards.isScannerOpen()) actions.openScanner();
  } else {
    actions.toggleStar();
  }
  return;
}
```

with `isScannerAvailable` querying for the scan button, which only renders in the add view in both shells.

**Nothing is taken away.** The scanner action is already DOM-driven — it clicks the scan button — and that button only exists in the add view, so `s` is already inert everywhere else. The handler's docstring claims add-view scoping that no guard currently enforces; this change makes the claim true.

**Why this context-dependence is acceptable when the now-playing star target was not.** The split is keyed to which page the user is on: a large, visually unmistakable context that only changes on deliberate navigation. And it is total rather than overlapping — Add → Discogs shows search hits, which are not library entities and cannot be starred, so no page has both meanings live at once. The rejected alternative flipped on transient playback state that changes without the user touching anything.

The shortcut overlay lists `s` with both readings, so the context-dependence is documented rather than folklore.

## Out of scope

- **Release stars** — derived count only.
- **Per-source vetting** — vetting is a property of the record, not of a copy of it.
- **Star-implies-vetted automation** — starring one track mid-listen does not mean the release is done; the flag stays explicit.
- **A dedicated review mode** — a separate focused screen would duplicate release detail and have to be kept in sync with it. The primitives plus auto-advance cover the same ground.

## Future directions

- Front-to-back release keeper flag, if the derived count proves insufficient.
- Sorting by `starred_at` ("recently starred"), already possible from the stored data.
- Starred tracks as an export target for DJ prep.
