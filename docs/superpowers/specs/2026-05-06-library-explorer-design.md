# booth — library explorer (Slice 2) design

> **Status:** Draft for review · 2026-05-06
> **Successor to:** `2026-05-05-multi-source-architecture-design.md`
> **Scope:** Replace today's single-purpose add-record screen with a three-pane library explorer that browses the unified store, with the existing add-from-Discogs flow folded into it as a rail section. Adds a tiny `source_state` table for last-synced timestamps; otherwise reads from the existing Slice 1 schema.

## 1. Goals & Scope

### Goal

Slice 1 built a unified, source-attributed store but exposed it only through inspection endpoints — there's no UI to actually browse it. Slice 2 turns that store into the home page: an iTunes-lineage three-pane explorer (rail / list / detail) with booth-specific cross-source visualization (a 4-slot D/i/R/P grid in every row showing which sources contribute the entity). The existing add-from-Discogs flow is folded in as a rail section rather than living on a separate page; the modal-based confirm step is replaced by a detail-pane CTA.

The design is anchored on a series of mockups built during brainstorming — the visual vocabulary (hairline 1px borders, restrained accent, mono font for technical content, source-dot color encoding) is captured in §10.

### In scope (Slice 2)

- Rewrite `src/routes/+page.svelte` as the explorer shell. Today's search/scanner/modal page is fully absorbed.
- Three-pane layout: left rail (~220px), middle listview (flex), right detail (~360px). Hairline `--border` separators between panes.
- Rail with three sections: **Library** (`All releases`, `All tracks`, `In multiple sources`), **Sources** (one item per registered source), **Add** (writable sources only — just Discogs in Slice 2).
- Two listview row variants — release rows and track rows — driven by which rail item is selected. Same height and styling vocabulary; different columns.
- 4-slot source-grid (D / i / R / P, fixed order) in every list row. Filled = entity has a source_link for that source; hairline ring = it doesn't. The grid header shows tiny mono `D i R P` labels.
- Two detail-pane shapes — release detail (with cover, title, source panels, and a tracklist section at the bottom) and track detail (with parent-release link and per-source track-level facets).
- `Add → Discogs` view: middle pane is the live Discogs search results (existing `/api/discogs/search`); scanner is a toolbar icon button (not a mode flip); right-pane detail has an `Add to Discogs collection ⏎` CTA replacing the confirm modal.
- Per-source sync trigger UX: a sync chip in the middle pane toolbar when a Sources view is selected, showing `Synced 12m ago · ⟳`. Clicking POSTs the existing `/api/sources/:id/sync`. Stub sources show a disabled `Not implemented` chip.
- New `source_state` table (single migration `002_source_state.sql`) for last-synced timestamps and the latest summary per source. Written from inside `collate()` in the same transaction.
- URL state in query params for reload-restore: `?nav=<section>:<item>`, `?id=<entityId>`, `?q=<query>`.
- Pagination over virtualization for listviews — 200 rows per page, load-more on scroll via an intersection-observer sentinel.
- Augmented existing endpoints (pagination + search) and three new endpoints: `GET /api/library/releases/:id`, `GET /api/library/tracks/:id`, `GET /api/sources` (rail metadata).
- Setup screen behavior preserved: missing/invalid Discogs token still gates the explorer with the existing setup instructions.
- Toast, scanner, and shortcut-overlay components reused.

### Explicitly out of scope (deferred to BACKLOG.md)

- Sortable column headers (year, date added, artist).
- Filter by source-grid (click `D` in the column header → filter to Discogs).
- Virtualized list rendering (pagination is enough for Slice 2's 1k–4k rows).
- Sync-run history view (we record only `last_synced_at`; full per-run history stays deferred).
- Settings / preferences UI (still env-only).
- Rail keyboard navigation (`[`/`]` cycle items) — codified as future work.
- Auto-sync iTunes on boot (Discogs-only auto-sync stays as Slice 1 had it).
- "Add to Discogs collection" CTA from a release that's *only* in iTunes today (cross-source upgrade flow).
- Track-level Discogs matching surfaces — track detail will have an empty Discogs panel until track-level matching lands later.
- Real Rekordbox / Plex implementations — still 501.
- Playlists, fuzzy matching, artist as first-class entity, auth, LAN, automated tests — all already in BACKLOG.md.

## 2. Architecture & module layout

```
src/
  app.css                                              minor token additions (see §10)
  routes/
    +page.svelte                                       REWRITE — the explorer shell (rail + middle + detail)
    api/
      library/
        releases/+server.ts                            EXTEND — adds ?q=, ?limit=, ?offset=, ?multi_source=
        releases/[id]/+server.ts                       NEW — GET single release with sources, facets, tracklist
        tracks/+server.ts                              EXTEND — adds ?q=, ?limit=, ?offset=
        tracks/[id]/+server.ts                         NEW — GET single track with sources, facets, parent release
        membership/+server.ts                          UNCHANGED (still used by Add → Discogs source-grid)
      sources/
        +server.ts                                     NEW — GET array of {id, name, contributes, isStub, count, lastSyncedAt, lastSummary}
        [id]/sync/+server.ts                           UNCHANGED — sync chip POSTs here
      discogs/
        search/+server.ts                              UNCHANGED — drives Add → Discogs middle pane
        collection/add/+server.ts                      UNCHANGED — detail-pane CTA calls this
        collection/remove/+server.ts                   UNCHANGED — undo path
  lib/
    server/
      db/migrations/002_source_state.sql               NEW — single-table migration
      library/
        collate.ts                                     EXTEND — write source_state row in same transaction
        queries.ts                                     EXTEND — getReleaseDetail, getTrackDetail, listSources, paginated listing helpers
    components/
      Explorer.svelte                                  NEW — top-level shell, owns URL ↔ store sync, composes rail + middle + detail
      Rail.svelte                                      NEW — left rail (Library / Sources / Add sections)
      ListviewToolbar.svelte                           NEW — middle-pane top bar (search input, scanner btn, sync chip, entity-type toggle)
      Listview.svelte                                  NEW — generic paginated listview shell (column-header strip, scrollable body, sentinel/intersection-observer, selection plumbing). Takes row snippet + headers from caller.
      ReleaseList.svelte                               NEW — thin wrapper around Listview; defines release-row snippet + column headers
      TrackList.svelte                                 NEW — thin wrapper around Listview; defines track-row snippet + column headers
      SourceGrid.svelte                                NEW — the 4-slot D/i/R/P widget (used in row + rail + header)
      ReleaseDetail.svelte                             NEW — right-pane release detail with tracklist section
      TrackDetail.svelte                               NEW — right-pane track detail with parent-release link
      SourcePanel.svelte                               NEW — generic per-source detail panel (header + key/value rows)
      SyncChip.svelte                                  NEW — last-synced indicator + sync trigger
      EmptyState.svelte                                NEW — centered "nothing here" pattern with optional CTA (stubs, never-synced, no-results, no-selection)
      SearchBar.svelte                                 REFACTORED — shrinks to a debounced input + focus(); URL sync moves to Explorer.svelte; scan button moves to ListviewToolbar. Used inside ListviewToolbar.
      ResultsList.svelte                               REMOVED — replaced by ReleaseList in Add → Discogs context
      ResultRow.svelte                                 REMOVED — replaced by inline row snippet in ReleaseList
      ConfirmModal.svelte                              REMOVED — detail-pane CTA replaces it
      SessionLog.svelte                                KEPT, refactored — surfaces inside Add → Discogs view (footer of middle pane)
      Scanner.svelte                                   KEPT — invoked from ListviewToolbar's scanner button (popover) rather than mode flip
      Toast.svelte                                     KEPT — unchanged
      ShortcutOverlay.svelte                           KEPT — content updated for new shortcuts
    stores/
      mode.svelte.ts                                   REMOVED — search/scanner is no longer a global mode
      session.svelte.ts                                KEPT — still backs SessionLog in Add → Discogs view
      collection.svelte.ts                             KEPT — still backs in-collection check in Add → Discogs source-grid
      toast.svelte.ts                                  KEPT — unchanged
      explorerState.svelte.ts                          NEW — current rail item, selected entity id, search query (mirrors URL params)
    keyboard.svelte.ts                                 EXTEND — same handler, dispatches based on rail context
```

### Why these boundaries

- **`Explorer.svelte`** owns URL ↔ store synchronization (parses `?nav=`, `?id=`, `?q=` on mount; replace-state writes on change). Children are pure renderers driven by `explorerState`.
- **`Rail.svelte`** is dumb — receives the source list (from `/api/sources`) and the current `nav` value, emits selection events.
- **The middle pane is split** into `ListviewToolbar` + a list component (`ReleaseList` or `TrackList`). The toolbar's controls (sync chip, entity-type toggle) are shown/hidden by the parent based on the current rail context, not by the toolbar inspecting state — keeps the toolbar contextless.
- **Pagination plumbing is generic** in `Listview.svelte` — column-header strip, scrollable body, sentinel + intersection observer, selection-by-index, scroll-position preservation. `ReleaseList`/`TrackList` are thin wrappers that pass row snippet + column headers in. Saves duplicating the scroll/load logic; row markup lives next to its column-header definition (good co-location).
- **`SourceGrid.svelte`** is reused in three places: list rows, the column header, and (faded) the rail's per-source items. One component, one source-of-truth for the visual vocabulary.
- **`SourcePanel.svelte`** is the right-pane atomic unit. Both `ReleaseDetail` and `TrackDetail` compose source panels from a `sources[]` array on the entity payload — no per-source-id branching at the detail level.
- **`SearchBar.svelte` is refactored, not removed** — its current concerns (debounce + focus + URL sync) shrink to debounce + focus once URL sync moves to `Explorer.svelte`. Used inside `ListviewToolbar`. Debounced-input is a pattern likely to recur (filter inputs, etc.) so the encapsulation pays off.
- **`mode.svelte.ts` is removed**. Search and scanner are no longer "modes"; the rail is the navigation, and the scanner is a toolbar button that opens a popover (Scanner component mounted into a popover, dismissed on decode).
- **`KeyHint` is intentionally not a component** — the existing `.kbd` CSS class in `app.css` is sufficient for inline keyboard hints. Don't componentize one CSS rule.
- **Row components (`ReleaseRow`/`TrackRow`) are intentionally inlined** as snippets within their parent List component, not extracted into separate files. Row markup is short (~15 lines) and lives best next to its column-header definition.

## 3. Routing & app shell

Single root route — `/` is the explorer. There is no `/library` split, no `/add` split, no tabs. The existing `+page.svelte` is replaced; the existing components are reused where they earn their keep (see §2's KEPT list).

### 3.1 URL state

All explorer state lives in query params, written via `history.replaceState` so reloads restore but back/forward isn't polluted by every keystroke:

| Param | Values | Behavior |
|---|---|---|
| `nav` | `library:all-releases` (default) · `library:all-tracks` · `library:in-multiple-sources` · `sources:<id>` (e.g., `sources:itunes`) · `add:<id>` (e.g., `add:discogs`) | Selects rail item; drives middle pane shape. |
| `id` | ULID of a release or track | Selected entity in the right pane. Cleared when `nav` changes. |
| `q` | search query | Toolbar search input; semantics depend on `nav` (see §5.4). |
| `entity` | `releases` (default) · `tracks` | Only relevant when the rail item allows both (e.g., `sources:itunes`). |

`Explorer.svelte` is the single owner of this round-trip — children take props and emit events; URL sync happens at the shell level.

### 3.2 Setup screen

Behavior preserved verbatim from Slice 1: on mount, `Explorer.svelte` probes `/api/discogs/search?q=test`. If the response carries `no_token` or `invalid_token`, the shell renders the existing setup-instructions content instead of the rail/list/detail layout. Same content, same gate, just rendered inside the new shell's frame.

### 3.3 Keyboard model

Existing global handler in `lib/keyboard.svelte.ts` is extended; no per-component listeners introduced.

| Key | Action |
|---|---|
| `/` | Focus search input in the middle-pane toolbar. |
| `s` | Open scanner overlay (only meaningful when in `add:discogs`; no-op otherwise). |
| `↑` / `↓` | Move selection in the middle-pane listview. |
| `⏎` | Open detail for highlighted row, or — when an `add:discogs` detail is selected — confirm the add. |
| `Esc` | Close popovers / clear search input / blur input. |
| `u` or `Cmd/Ctrl+Z` | Undo the most recent add (only in `add:discogs`; uses the existing session log). |
| `?` | Toggle shortcut overlay. |

`[` / `]` for rail navigation is **deferred** to BACKLOG.md — flagged so we don't forget.

## 4. Rail structure

Three sections. Each section has a small uppercase label (`--text-subtle`, 10px, 0.06em letter-spacing) above its items. Selected item: `--accent-bg` background + 2px left-border in `--accent`. Hover: `--bg-row-hover`. Counts right-aligned in `--text-subtle` with tabular-nums.

### Library
- `All releases` — count from `SELECT COUNT(*) FROM release`. Default landing.
- `All tracks` — count from `SELECT COUNT(*) FROM track`.
- `In multiple sources` — releases with ≥2 distinct source_link entries (`HAVING COUNT(DISTINCT source) >= 2`).

### Sources
One item per source from `registry.listSources()`, in registry order. Each item:
- Source dot (the source-color, dimmed for stubs).
- Source name (from registry).
- Count (`SELECT COUNT(*) FROM source_link WHERE source = ?`).
- Last-synced timestamp on hover (`12m ago` in `--text-subtle`, 10.5px); not always-visible to avoid rail clutter.

Stubs (Rekordbox, Plex) show `—` for count, are dimmed, but are clickable — clicking lands on a middle-pane empty state explaining the source isn't yet implemented and pointing at BACKLOG.md.

### Add
Writable sources only — items where the registered adapter implements `CollectionWritable`. Slice 2 has just `Discogs`. Future writable sources (Bandcamp wishlist, etc.) slot in here automatically.

## 5. Middle pane

A vertical column under three regions: **toolbar** (top, ~40px) → **column headers** (single 22px row) → **listview body** (flex). All separated by 1px `--border` hairlines.

### 5.1 Toolbar

- Left: search input (`flex: 1`), `--bg-input` background, 1px `--border-strong`, 4px radius. Focus state: border switches to `--accent-border` (8% accent rgba). Placeholder text varies: `Search library…` for Library/Sources, `Search Discogs…` for Add → Discogs.
- Right (contextual, in this order):
  - **Scanner button** — only visible in `add:discogs`. Square 28×26 icon button, transparent background, 1px `--border-strong`, simple barcode glyph in `--text-muted`. Hover lifts text to `--text` and border to `--text-muted`. Click (or `s`) opens the Scanner component in a popover.
  - **Entity-type toggle** — only visible when the selected rail item allows both (currently `sources:itunes`). Two tabs: `Tracks` / `Releases`. Persists to `?entity=`.
  - **Sync chip** — only visible in `sources:<id>`. Real source: `Synced 12m ago · ⟳` (clickable). Stub source: `Not implemented` (disabled). Never-synced: `Sync` (full-width inviting).
  - **Result-count meta** — `1,242 releases` in `--text-subtle`, 11px, tabular-nums. Always last.

### 5.2 Column headers + row variants

Same grid template within a rail context; the header just shows column labels in 10px caps `--text-subtle`.

**Release row:**
- Grid: `40px | 1fr | 56px | 56px` with 14px gap.
- Cover (40×40, 3px radius).
- Meta column: title (13px, 500 weight, `--text`) + artist (12px, `--text-muted`). Both single-line, ellipsized.
- Year (right-aligned, `--text-subtle`, tabular-nums).
- Source-grid (4 slots, see §10).

**Track row:**
- Grid: `1fr | 100px | 60px | 56px` with 14px gap.
- Title (13px, 500) + artist (12px, muted) — single-line ellipsized.
- Album (single-line ellipsized, `--text-muted`).
- Duration (`--text-subtle`, tabular-nums, mm:ss).
- Source-grid.

Rows are 46px tall with 7px padding. `border-top: 1px solid rgba(255,255,255,0.025)` between rows (barely visible). Hover: `--bg-row-hover`. Selected: `--accent-bg`.

### 5.3 Pagination

200 rows per page. The bottom of the rendered list places a sentinel; an intersection observer (with rootMargin `400px`) triggers a fetch for `?offset=<n+1>&limit=200`. New rows are appended; the sentinel moves to the new bottom. No virtualization, no library — just append.

When `?q=` changes or rail item changes, the listview resets to the first page.

### 5.4 Search semantics

- **Library / Sources views:** `?q=` is sent to the corresponding library endpoint (`/api/library/releases?q=…` or `…/tracks?q=…`). Server-side filter via `WHERE title LIKE ? OR artist LIKE ?` (with `%`-wrapping). Debounced 250ms client-side. Pagination resets on each new query.
- **Add → Discogs view:** `?q=` drives the existing `/api/discogs/search` (live API, debounced 250ms). The resulting list of search hits renders in the same release-row layout — the source-grid in each result row reflects current cross-source ownership (so a release you already have shows `●●◌◌`).
- **Empty query in Add → Discogs:** results list is empty with a centered hint: scanner glyph + `s` key + `Search by artist, title, catalog number, or barcode`.

## 6. Right pane (detail)

Two shapes — release detail and track detail. Both share the source-panel vocabulary.

### 6.1 Release detail

- Cover (full-width, square, 4px radius, 1px `--border` outline) with a 600×600 placeholder when imagery is unavailable (Slice 2 doesn't fetch high-res cover imagery for iTunes-emergent releases — that's BACKLOG).
- Title (15px, 600 weight, `--text`).
- Artist · Year (13px, `--text-muted`).
- **In `add:discogs` only:** CTA bar with `+ Add to Discogs collection ⏎` button (full-width, `--accent` fill, white text, 4px radius). For releases already in Discogs, the CTA degrades to a quiet `✓ In your Discogs collection — undo (u)` row.
- Stack of source panels (see §6.4), one per source contributing.
- **Tracks (N) section** at the bottom — compact table:
  - Position (left-aligned, mono, 11px, `--text-subtle`).
  - Track title (single-line ellipsized).
  - Duration (right-aligned, mono, 11px, `--text-subtle`).
  - Source-grid (4 slots, same as listview).
  - Click row → updates `?id=` to the track and the right pane swaps to track detail (with breadcrumb back to release).

### 6.2 Track detail

- Breadcrumb back to parent release: `← The Power of Self-Belief` (clickable; `--text-muted` hover `--text`).
- Track title (15px / 600).
- Track artist · duration (13px / muted).
- Parent-release card: 64×64 cover thumb + release title + artist · year, all clickable to switch `?id=`.
- Stack of source panels with track-level facets:
  - Discogs: position on the release (when track-level matching lands; for now the panel is empty / "no track-level match"). 
  - Apple Music: file path (mono), rating (stars), play count, date added, kind, bitRate, sampleRate, genre.
  - Rekordbox / Plex: empty placeholder until those adapters land.
- No add CTA on track detail (track-level Discogs matching is in BACKLOG).

### 6.3 Add CTA

When the right pane is showing a release in `add:discogs`:
- **Not yet in your Discogs collection:** `+ Add to Discogs collection` button with a subtle `⏎` kbd hint inside. `⏎` from anywhere on the page (when no input is focused) fires it. POSTs `/api/discogs/collection/add` with the release info — same payload shape as today (`{releaseId, title, artist, year, country, label, catno, coverImage}`), since the search hit isn't in the local DB until added.
- **Already added (this session or persistent):** quiet `✓ In your Discogs collection — undo (u)` row replaces the button. `u` or `Cmd/Ctrl+Z` undoes via the existing `/api/discogs/collection/remove`. The session log (now in the middle-pane footer; see §10.4) is the source of truth for what "this session" means.

The confirm modal (`ConfirmModal.svelte`) is removed — the detail pane *is* the confirmation surface, since you can see the full release info before pressing Add. Saves a layer of UI.

### 6.4 Source panels (`SourcePanel.svelte`)

Generic per-source detail panel, one per source contributing to the entity:

- 1px `--border` outline, 4px radius, `--bg-raised` background.
- Header row (28px tall, 7×11 padding, bottom 1px `--border`):
  - Source dot.
  - Source name in 10.5px caps, 0.06em letter-spacing, 600 weight, `--text-muted`.
  - Right-aligned `open ↗` link in 10px (lowercase), `--text-subtle`, only present when the source has a stable external URL we can navigate to:
    - Discogs: `open in Discogs ↗` → `external_url` from `source_link` (already populated as `https://www.discogs.com/release/<id>`).
    - Apple Music, Rekordbox, Plex: no link in Slice 2. The file path renders inline in the panel body as a mono value; `reveal in Finder` is a Slice 3+ concern (added to BACKLOG.md) since it requires a new endpoint with shell-out behavior.
- Body: `key / value` rows in a `78px | 1fr` grid. Keys lowercase 11px `--text-subtle`. Values 12px `--text`. Mono font for technical values (catalog numbers, file paths, external IDs, dates, bitrates).
- Stub sources: panel renders dimmed (`opacity: 0.45`) with a single `Source not yet implemented` line in `--text-subtle`.

## 7. Sync UX

### 7.1 Sync chip

When the selected rail item is a `sources:<id>`, the middle-pane toolbar surfaces a sync chip on the right (after entity-type toggle, before result count):

- **Real source, has been synced:** `Synced 12m ago · ⟳` — clickable. Click → POST `/api/sources/:id/sync`. Chip transitions to `Syncing…` with a spinner glyph; existing toast system surfaces success/error. On success the chip's count and timestamp update.
- **Real source, never synced:** `Sync` (no timestamp). Same click behavior.
- **Stub source:** `Not implemented` — disabled, `--text-subtle`.

The auto-sync-on-boot hook (`hooks.server.ts`) stays as-is for first-run convenience; this chip is the manual trigger that's always available.

### 7.2 `source_state` table

Tiny single-table migration `002_source_state.sql`:

```sql
CREATE TABLE source_state (
  source          TEXT PRIMARY KEY,
  last_synced_at  TEXT,
  last_summary    TEXT
);
```

Written from inside `collate()` in the same SQLite transaction as the source_link upserts:

```ts
db.prepare(`
  INSERT INTO source_state (source, last_synced_at, last_summary)
  VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?)
  ON CONFLICT(source) DO UPDATE SET
    last_synced_at = excluded.last_synced_at,
    last_summary   = excluded.last_summary
`).run(sourceId, JSON.stringify(summary));
```

Rationale for embedding the write inside `collate()` rather than at the route layer: keeps the timestamp atomic with the data it describes — never possible to have updated entity rows without an updated `last_synced_at`.

This is **not** the full `sync_run` history (deferred to BACKLOG.md). It's the latest-snapshot-per-source only; full per-run logging needs a separate table and lifecycle.

## 8. Data model additions

Just `migrations/002_source_state.sql` from §7.2. No changes to existing tables. No new entity types. No new match-key types.

## 9. Endpoints

### Augmented

`GET /api/library/releases`
- New params: `?q=`, `?limit=` (default 200, max 500), `?offset=` (default 0), `?multi_source=true`.
- Existing `?source=` preserved.
- **Breaking response shape change** from a bare array to `{ items: Release[], total: number, hasMore: boolean }`. `total` lets the toolbar show `1,242 releases` correctly even when paginated; `hasMore` lets the sentinel decide whether to keep loading. These are inspection endpoints in Slice 1 (used only by curl in verification scripts), so the new explorer is the only programmatic consumer of the new shape.

`GET /api/library/tracks`
- New params: `?q=`, `?limit=` (default 200, max 500), `?offset=` (default 0).
- Existing `?source=` preserved.
- Same breaking response shape change.

### New

`GET /api/library/releases/:id`
- 404 if not found.
- Returns: `{ release, sources: SourceLink[], facets: SourceFacet[], tracks: Track[] }` where `tracks` is joined from `track WHERE release_id = ? ORDER BY position`. Each `Track` carries its own `sources` and `facets` so the tracklist source-grid renders without an N+1 fetch.

`GET /api/library/tracks/:id`
- 404 if not found.
- Returns: `{ track, sources: SourceLink[], facets: SourceFacet[], release: ReleaseSummary | null }` where `release` is the parent (joined via `track.release_id`), or `null` for orphan tracks.

`GET /api/sources`
- Returns: `Array<{ id, name, contributes, isStub, count, lastSyncedAt, lastSummary }>` for the rail.
- `id`, `name`, `contributes` come from `registry.listSources()`.
- `isStub` is true if the adapter's `sync()` throws `NotImplementedError`. Detection: try-catch on a no-op probe, or a static `isStub: true` flag added to stub adapters in `sources/types.ts` — picking the static flag (deterministic, no side effects).
- `count` from `SELECT COUNT(*) FROM source_link WHERE source = ?`.
- `lastSyncedAt`, `lastSummary` from `source_state`.

### Unchanged

`POST /api/sources/:id/sync` — sync chip POSTs here; existing 404/501 behavior preserved.
`GET /api/library/membership?source=discogs` — still used by the Add → Discogs source-grid for the in-collection check (cheaper than `/api/library/releases/:id` for the "is this externalId in the collection?" lookup during live search).
`GET /api/discogs/search` — drives Add → Discogs middle pane.
`POST /api/discogs/collection/add` and `DELETE /api/discogs/collection/remove` — detail-pane CTA + undo path.

## 10. Visual vocabulary

### 10.1 Tokens (additions to `app.css`)

The Slice 1 tokens carry over. Slice 2 adds source colors + a few derived shades:

```css
--bg-row-hover: #161616;
--accent-bg:    rgba(90, 142, 219, 0.08);
--accent-border:rgba(90, 142, 219, 0.35);

--src-discogs:   #c89a5b;   /* warm amber */
--src-itunes:    #d36b6b;   /* rust */
--src-rekordbox: #5b9cd6;   /* cool blue (sibling of --accent) */
--src-plex:      #d4a04b;   /* warm gold */
--src-empty:     #2a2a2a;   /* hairline ring for absent slots */
```

`--bg-raised` is darkened from Slice 1's `#1a1a1a` to `#131313` so panel surfaces sit barely above the page background — supports the hairline-border aesthetic.

### 10.2 The source-grid

A 4-slot widget rendered as `display: grid; grid-template-columns: repeat(4, 8px); gap: 4px`. Each slot is an 8×8 circle (`border-radius: 50%`).

- **Filled** (entity has a source_link for that source): slot's background = source color, border = source color.
- **Empty** (no source_link): slot's background = transparent, border = 1px `--src-empty`.

Order is fixed: D · i · R · P (Discogs, iTunes/Apple Music, Rekordbox, Plex). The order matches the registry ordering and is locked. The column header in the listview shows the same letters in tiny mono (9px), one per slot, for learnability.

### 10.3 Hairline rhythm

All inter-pane and intra-section separators are `1px solid var(--border)`. No box shadows, no double borders, no gradients. Row separators inside listviews use `1px solid rgba(255,255,255,0.025)` — barely-there, only enough to give scanned eyes a horizontal rhythm.

### 10.4 Session log placement

The existing `SessionLog.svelte` is preserved and surfaces as a thin footer strip below the middle-pane listview when `nav=add:discogs`:

- 32px tall, 1px top `--border`, padded 0 14px.
- Text: `Added this session: 3 — undo last (u)`.
- Hidden in all other rail contexts.

Keeps the keyboard-first add flow's primary feedback visible without bleeding into the explorer's other surfaces.

## 11. Verification

Slice 2's verification surface is the explorer itself — no headless verification scripts beyond what already exists.

1. **Add-record flow regression check.** `add:discogs` → search → click → press `⏎`. Toast appears. Source-grid in the result row lights `●●◌◌`. `u` undoes. Cmd+Z undoes (still subject to the existing browser-intercept gap). Confirms the modal removal didn't break the keyboard contract.
2. **Cross-source overlap visualization.** Land on `library:in-multiple-sources`. Visually confirm rows show two filled slots in the source-grid. Click a row; confirm right-pane shows two source panels with their facets.
3. **Sync chip end-to-end.** `sources:discogs` → click sync chip. Chip flips to `Syncing…`, network call lands at `/api/sources/discogs/sync`, summary returns, chip flips back to `Synced just now · ⟳`. Repeat for `sources:itunes`. For `sources:rekordbox`, confirm the chip is disabled and reads `Not implemented`.
4. **Pagination.** `library:all-tracks` → scroll. Confirm new pages append (network call shows `?offset=200`, then `?offset=400`, etc.); scroll position is preserved.
5. **URL state restore.** Navigate to a track inside `sources:itunes`, copy the URL, reload. Confirm same rail item is selected, same track is in the right pane.
6. **Setup gate.** Empty `DISCOGS_TOKEN`; reload. Confirm the setup screen renders inside the new shell.
7. **Type-check.** `pnpm exec svelte-kit sync && pnpm exec tsc --noEmit` passes.
8. **Manual SQL spot-check.** `sqlite3 ./.booth/booth.db 'SELECT * FROM source_state'` shows one row per real source with recent timestamps.

## 12. Future work

Items deferred from Slice 2 are appended to `docs/BACKLOG.md` when this spec lands. The new entries are:

- Sortable column headers (year, date added, artist).
- `[`/`]` rail keyboard navigation.
- Auto-sync-on-boot for iTunes (currently Discogs-only).
- Background-poll sync after first user interaction.
- "Add to Discogs collection" CTA from a release that's only in iTunes today.
- Track-level Discogs matching surface in track detail (depends on track-level matching landing first).
- "Reveal in Finder" link on Apple Music source panels — needs a new endpoint with limited shell-out (`open -R <path>` on macOS).

The standing items already in `BACKLOG.md` are unchanged by this spec.

## 13. Open questions

None — all scope, structure, and visual decisions resolved during brainstorming on 2026-05-06. If anything turns out underspecified during implementation planning, it gets resolved in the implementation plan rather than reopening the spec.
