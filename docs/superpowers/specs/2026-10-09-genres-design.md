# Genres, styles and smart playlists — design

Status: approved in brainstorm 2026-10-09.

## Why

Booth has no idea what kind of music a record is. The questions that need it
are coarse ("all electronic", "everything that isn't electronic") and fine
("deep house, not techno"), and both should be answerable by a filter or a
playlist that keeps itself up to date.

## Vocabulary: Discogs' two levels

- **Genre** — Discogs' fixed list of 15 (Electronic, Jazz, Funk / Soul, Hip Hop,
  Rock, Latin, Reggae, Pop, Classical, Blues, Folk World & Country, Stage &
  Screen, Non-Music, Children's, Brass & Military). This is the short list the
  coarse questions run on. Not user-extensible.
- **Style** — Discogs' style list (several hundred: Deep House, Techno, Disco…).
  Each style has one or more parent genres (Disco sits under both Electronic and
  Funk / Soul). Booth ships the list with parents as a static vocabulary file;
  Discogs has no endpoint for it. A manually entered style outside the
  vocabulary is allowed and has no parent.

Using Discogs' vocabulary for everything means every other source is *mapped
into* it, and anything that doesn't map is dropped. That is what turns
Bandcamp's free-form tags (artist names, cities, "max respect 2 all the freaks")
into clean data without a curated blocklist.

**Display:** both are always lowercase in the UI (`deep house`, `funk / soul`).
Stored in Discogs' casing so matching against Discogs stays exact.

## Genres attach to releases

Discogs and Bandcamp both classify releases, not tracks, and a per-track genre
would make "all electronic" depend on how consistently a single file was tagged.
Tracks inherit their release's genres and styles. A track with no release has
none (it can still be found by the library's untagged view through its file's
own tag — see sources).

## Sources of evidence

Each is stored raw; a resolve step turns them into one answer per release.

### Discogs (records)

The collection sync already receives `genres` and `styles` on every release in
the same response it uses today. Keep them as release facets. No extra requests.

### Bandcamp (digital purchases)

There is no usable Bandcamp API: the public one closed to new developers in
2013, and the current official API covers only a seller's own sales. Two
unofficial routes, used in this order:

1. **The fan collection list.** One request returns the whole purchase history
   for a public fan profile (verified: 1,045 items for `lucasnewman`, no more
   pages), each with its exact album or track URL, artist, title, Bandcamp's
   primary genre id and the purchase date. Fetched once per sync — it is cheap.
2. **The album (or track) page**, once per purchase, for its tags. The page also
   carries the primary genre by name. Pages are fetched slowly (one every couple
   of seconds, backing off on 429), resumable, and cached permanently — a
   release's tags don't change, and re-fetching a thousand pages every six hours
   would be both rude and the likeliest way to get blocked. A "refetch" action
   per release covers the rare correction.

**Matching a purchase to a release.** Normalized artist + album title (edition
tags stripped, the same key the relink step uses), against local releases. Ties
are broken by the file's comment: Bandcamp downloads say "Visit
https://<subdomain>.bandcamp.com", and 3,810 of ~4,400 tracks carry one. The
local import doesn't read comments today; it needs to, as a track facet. A
single-track purchase matches by artist + track title and classifies that
track's release. Anything ambiguous stays unmatched — a wrong match puts a
record in the wrong genre silently, an unmatched one shows up in Untagged — and
the count goes in the sync summary.

**Mapping into the vocabulary.** Tags that equal a Discogs style (case- and
punctuation-insensitive, with a small alias table for Bandcamp's spellings —
`drum & bass` → `Drum n Bass`, `hip-hop` → `Hip Hop`) become styles. The
primary genre maps to a Discogs genre where one exists (`electronic` →
Electronic, `hip-hop-rap` → Hip Hop, `r-b-soul` → Funk / Soul, …). Bandcamp
genres with no Discogs equivalent (`experimental`, `ambient`, `soundtrack`…)
map to nothing directly; the release still gets a genre if its styles have
parents.

**Files not among the purchases** (gifts, other stores) fall back to the
comment's subdomain: fetch that artist/label's `/music` page, match the album by
title, then read its page as above. Lower priority; implement after the
collection route is working and measured.

### File tags (fallback)

The genre tag already imported for 470 tracks. Messy ("Dance & House",
"Techno (Peak Time / Driving)"), so it is split on `,` `/` `&` and each part goes
through the same vocabulary mapping as Bandcamp tags. A release takes the union
of its tracks' mapped values.

### Manual

Set by hand in the release detail pane. Stored separately, never touched by a
sync, and journaled to `annotations.log` like stars and notes — it is hand-made
data that exists nowhere else.

## Resolving

Per release, the first source that yields anything wins, **as a whole set**:
manual → Discogs → Bandcamp → file tags. Sources are not merged; mixing
Discogs' styles with a Bandcamp label's tags for the same record produces a
noisier answer than either.

- Genres are the source's genres plus the parents of its styles (so a Bandcamp
  release tagged only `deep house` is Electronic).
- A release with no genre after resolving is **untagged**.
- Resolved rows are rebuilt for affected releases after every sync and after
  every manual edit. Filters read only the resolved rows. The resolved row
  records which source it came from, so the detail pane can say so.

## Data model (migration 014)

- **Discogs facets**: `genres`, `styles` (JSON arrays) on the release, written
  by the collection sync.
- **`bandcamp_item`** — the cache: Bandcamp item id, URL, type (album/track),
  artist, title, primary genre, tags (JSON), purchased_at, page_fetched_at,
  matched `release_id` (nullable, `ON DELETE SET NULL`). Keyed by Bandcamp's
  id so a re-match never re-fetches.
- **`release_tag_manual`** — release id, genres (JSON), styles (JSON), set_at.
  `ON DELETE` must not lose hand-made data silently: the journal carries
  artist/title/year so it can be restored by name, like playlists.
- **`release_genre`** — resolved: release id, kind (`genre` | `style`), name,
  origin. Indexed on (kind, name).
- **`style_color`** — style name, palette slot, pinned flag.
- **`playlist.rule`** — nullable JSON; non-null makes the playlist smart.

Settings gains the Bandcamp username (onboarding/setup screen, optional — leave
it blank and Bandcamp is skipped).

## Style colours

Pills for styles only; the genre is plain lowercase text. Every style gets a
hue; the point is telling `deep house` from `techno` at a glance, not encoding
the genre.

- **Palette** of ~12 hues tuned for the dark theme (pill background + text that
  pass contrast). More than that stop reading as distinct.
- **Assignment by use**: on first run, styles are ranked by how many releases
  carry them and the top 12 each get a distinct slot. Every later style takes
  the least-used slot at the moment it first appears. So the styles that
  dominate the library never collide, and rare ones share.
- **Colours never move on their own.** A new record doesn't reshuffle what
  you've learned. A style that becomes common later keeps its shared slot until
  you recolour it.
- **Manual recolour**: click a pill's colour in the detail pane → pick a slot →
  pinned, journaled. A "reassign by current use" action re-runs the ranking for
  unpinned styles.

## UI

- **Rows and grid cards** show style pills (first two or three, `+n` for the
  rest). **Release detail** shows genre(s) as text, all style pills, the source
  ("from discogs", "from bandcamp", "set by hand"), and the edit control.
- **Clicking a pill** filters the current list to that style.
- **Filters**: genre and style in the listview toolbar, include and exclude,
  composing with source / starred / vetted / search like the existing filters.
  URL-backed (`?genre=`, `?style=`, `-` prefix to exclude). Untagged releases
  never match an exclude ("not electronic" means "known to be something else").
- **Untagged** rail item under Library, releases lens, with a count — the same
  shape as Unvetted, and its count is the same kind of progress meter. Opening a
  release there focuses the tag editor; saving drops it from the list and opens
  the next.
- **Tag editor**: genre checkboxes (15) and a style typeahead over the
  vocabulary; picking a style ticks its parent genres. Keyboard: `g` opens it on
  the selected release.

## Smart playlists

A playlist whose `rule` is set. It lives in the Playlists rail with a distinct
icon and is created from "＋ New smart playlist" or "save current filters as
smart playlist" from the toolbar.

- **Rule (v1)**: genres include/exclude, styles include (any of)/exclude,
  optionally starred-only and a BPM range. Evaluated against tracks.
- **Evaluated on open**, never stored as membership — so it can't go stale and
  needs no relink. Order: date added, newest first.
- **Read-only list**: no manual reorder, no add/remove, no sections or crate —
  so it can never become a gig. Plays through the shared queue like any
  playlist. "Copy to playlist" freezes it into a normal one when you want to
  edit.
- Rule changes are journaled in `playlists.log`.

## Out of scope

- **Bandcamp purchase dates as "date added".** The collection list carries them
  and they'd give digital files their real acquisition dates, but that touches
  the date-added provenance model and deserves its own design.
- **Writing genres/styles into the files' tags** (file-owned library). The
  resolved data is ready for it when that slice comes.
- Track-level genres; musical key.

## Verification

No test suite. A `scripts/verify-genres.ts` covering: vocabulary mapping and
aliases, resolve precedence, style-parent genre inference, untagged exclusion
in exclude filters, colour assignment stability across a second run. A dry-run
script reporting Bandcamp match rates (matched / ambiguous / unmatched) against
the real library before anything is written. UI via the CDP harness.
