# Release Grid View

**Date:** 2026-06-08
**Status:** Approved

## Summary

Add a grid view for releases in the middle pane of Explorer. The user can toggle between the existing list view and a new card grid. The grid shows album art prominently, with title, artist, year, and source dots on each card.

## Architecture

Three files modified, one file created. No API changes, no store changes, no route changes.

| File | Change |
|------|--------|
| `src/lib/components/ReleaseGrid.svelte` | **New.** Self-contained card grid component. |
| `src/lib/components/ListviewToolbar.svelte` | Add optional list/grid icon toggle. |
| `src/lib/components/Explorer.svelte` | Add `releaseView` state; render `ReleaseGrid` or `ReleaseList` based on it. |
| `src/lib/components/ReleaseList.svelte` | No changes. |

## Components

### ReleaseGrid.svelte

Props mirror `ReleaseList.svelte` exactly so it is a drop-in parallel:

```ts
{
  items: ReleaseItem[];
  total: number;
  hasMore: boolean;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  loadMore?: () => void;
  emptyTitle?: string;
  emptyDetail?: string;
}
```

**Layout:** `grid-template-columns: repeat(auto-fill, minmax(160px, 1fr))` — responsive, fills the middle pane without a hardcoded column count.

**Card anatomy:**
- Cover art square (`width: 100%; aspect-ratio: 1`). If `thumbUrl` is present renders an `<img>`; otherwise a placeholder `<div>` with `background: var(--bg-raised)`.
- Below the art: title (bold, 13px, truncated), artist (muted, 12px, truncated), year (subtle, 12px).
- Bottom of the caption: four source dots (7px circles) using `--src-discogs`, `--src-itunes`, `--src-rekordbox`, `--src-plex` / `--src-empty` — one dot per source slot in D/i/R/P order, filled or empty.

**Each card** is a `<button class="card-btn">` with `class:selected` when `item.id === selectedId`. Clicking calls `onSelect(item.id)`.

**Infinite scroll:** Same `IntersectionObserver` sentinel pattern as `Listview.svelte` — a 1px `.sentinel` div at the bottom of the grid body, watched against the scrollable `.grid-body` ancestor.

**Empty state:** When `items.length === 0`, renders `<EmptyState title={emptyTitle} detail={emptyDetail} />`.

### ListviewToolbar.svelte — new props

```ts
showViewToggle?: boolean;     // default false
view?: 'list' | 'grid';       // default 'list'
onViewChange?: (v: 'list' | 'grid') => void;
```

The toggle renders as two small icon buttons (list-lines and grid icons) using the existing `icon-btn` style. Placement: between the entity toggle and the search bar.

### Explorer.svelte — changes

```svelte
let releaseView = $state<'list' | 'grid'>('list');
```

- Passes `showViewToggle={!isAddView}`, `view={releaseView}`, `onViewChange={(v) => (releaseView = v)}` to `ListviewToolbar`.
- In the `{:else if currentEntity === 'releases'}` block, renders `<ReleaseGrid>` when `releaseView === 'grid'` and `<ReleaseList>` otherwise.
- The Add → Discogs view (`isAddView`) does not show the toggle — search results are transient and don't benefit from a grid.

## Data Flow

```
ListviewToolbar → onViewChange → releaseView ($state in Explorer)
                                      ↓
                    ReleaseList  ←  branch  →  ReleaseGrid
                                      ↓
                         onSelect → explorerState.setEntity(id)
                                      ↓
                                 ReleaseDetail (right pane, unchanged)
```

`releaseView` is not persisted to the URL, localStorage, or any store. It resets to `'list'` on page reload. Persistence can be added later.

## Edge Cases

| Case | Behaviour |
|------|-----------|
| Release has no thumbnail | Placeholder `<div>` with `background: var(--bg-raised)`, same as list view. |
| Release has no year | Shows `—` (em dash), same as list view. |
| Empty library / search | `<EmptyState>` with `emptyTitle` / `emptyDetail` props. |
| Keyboard nav (↑/↓) | Does **not** work in grid mode. The page-level keyboard handler queries `.body button.row-btn` which is list-specific. Grid is a visual browsing mode; keyboard nav is out of scope for this slice. |
| Tracks / Artists entity | No grid toggle — only the releases lens gets one. |
| Add → Discogs view | No grid toggle — `showViewToggle` is false. |

## Out of Scope

- Persisting view preference to localStorage or URL
- Keyboard navigation in grid mode
- Grid view for tracks or artists
