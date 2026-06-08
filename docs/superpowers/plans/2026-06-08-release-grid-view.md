# Release Grid View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a card grid view for releases with a list/grid toggle in the toolbar.

**Architecture:** A new `ReleaseGrid.svelte` component mirrors `ReleaseList.svelte`'s props interface and renders an `auto-fill` CSS grid of album art cards. `ListviewToolbar.svelte` gains optional list/grid icon toggle props. `Explorer.svelte` holds a `releaseView` `$state` variable and switches between the two components. No API changes, no new stores.

**Tech Stack:** SvelteKit, Svelte 5 (`$state`, `$effect`, `$props`), TypeScript, CSS custom properties from `app.css`.

---

## File Map

| Action | Path |
|--------|------|
| Create | `src/lib/components/ReleaseGrid.svelte` |
| Modify | `src/lib/components/ListviewToolbar.svelte` |
| Modify | `src/lib/components/Explorer.svelte` |

---

## Task 1: Create ReleaseGrid.svelte

**Files:**
- Create: `src/lib/components/ReleaseGrid.svelte`

This component is structurally similar to `ReleaseList.svelte` but renders a CSS grid of cards instead of rows. It reuses `SourceGrid.svelte` (which already exists) for the source dots. It does **not** use `Listview.svelte` — that shell is built around row layout and doesn't suit a grid.

- [ ] **Step 1: Create the file**

Write `src/lib/components/ReleaseGrid.svelte` with the following content:

```svelte
<script lang="ts">
  import SourceGrid from './SourceGrid.svelte';
  import EmptyState from './EmptyState.svelte';

  interface ReleaseItem {
    id: string;
    title: string;
    artist: string;
    year: number | null;
    sources: string[];
    thumbUrl?: string | null;
  }

  let {
    items,
    total,
    hasMore,
    selectedId = null,
    onSelect,
    loadMore,
    emptyTitle = 'No releases',
    emptyDetail = '',
  }: {
    items: ReleaseItem[];
    total: number;
    hasMore: boolean;
    selectedId?: string | null;
    onSelect?: (id: string) => void;
    loadMore?: () => void;
    emptyTitle?: string;
    emptyDetail?: string;
  } = $props();

  let sentinel: HTMLElement | undefined = $state();
  let observer: IntersectionObserver | undefined;

  $effect(() => {
    if (!sentinel) return;
    if (!hasMore) {
      observer?.disconnect();
      return;
    }
    observer?.disconnect();
    observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) loadMore?.();
      },
      { root: sentinel.parentElement, rootMargin: '400px' },
    );
    observer.observe(sentinel);
    return () => observer?.disconnect();
  });
</script>

<div class="release-grid">
  <div class="grid-body">
    {#if items.length === 0}
      <EmptyState title={emptyTitle} detail={emptyDetail} />
    {:else}
      <div class="grid">
        {#each items as item (item.id)}
          <button
            class="card-btn"
            class:selected={item.id === selectedId}
            onclick={() => onSelect?.(item.id)}
            type="button"
          >
            {#if item.thumbUrl}
              <img class="art" src={item.thumbUrl} alt="" loading="lazy">
            {:else}
              <div class="art placeholder"></div>
            {/if}
            <div class="caption">
              <div class="title">{item.title}</div>
              <div class="artist">{item.artist}</div>
              <div class="bottom">
                <span class="year">{item.year ?? '—'}</span>
                <SourceGrid present={item.sources} />
              </div>
            </div>
          </button>
        {/each}
      </div>
      {#if hasMore}
        <div class="sentinel" bind:this={sentinel}></div>
      {/if}
    {/if}
  </div>
</div>

<style>
  .release-grid {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }
  .grid-body {
    flex: 1;
    overflow-y: auto;
    padding: 14px;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
    gap: 12px;
  }
  .card-btn {
    display: flex;
    flex-direction: column;
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0;
    text-align: left;
    cursor: pointer;
    color: inherit;
    font: inherit;
    overflow: hidden;
    transition: border-color 0.1s;
    width: 100%;
  }
  .card-btn:hover { border-color: var(--border-strong); }
  .card-btn.selected { border-color: var(--accent-border); background: var(--accent-bg); }
  .art {
    width: 100%;
    aspect-ratio: 1;
    display: block;
    object-fit: cover;
  }
  .placeholder {
    background: var(--bg-raised);
    filter: brightness(0.7);
  }
  .caption {
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .title {
    color: var(--text);
    font-weight: 500;
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .artist {
    color: var(--text-muted);
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .bottom {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 4px;
  }
  .year {
    color: var(--text-subtle);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }
  .sentinel { height: 1px; }
</style>
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /Users/luke/code/booth && npx tsc --noEmit
```

Expected: no errors. If errors appear, fix them before continuing.

- [ ] **Step 3: Commit**

```bash
git add src/lib/components/ReleaseGrid.svelte
git commit -m "feat: add ReleaseGrid component for card grid view"
```

---

## Task 2: Add view toggle to ListviewToolbar

**Files:**
- Modify: `src/lib/components/ListviewToolbar.svelte`

Add three new optional props and a pair of icon buttons that appear when `showViewToggle` is true. The buttons use the existing `icon-btn` class; add an `active` variant for the currently-selected view.

- [ ] **Step 1: Add the new props to the props destructure**

In `ListviewToolbar.svelte`, find this exact text (the last two lines of the destructure value and the closing of the type annotation):

```ts
  externalSearchUrl = null,
}: {
```

Replace it with:

```ts
  externalSearchUrl = null,
  showViewToggle = false,
  view = 'list' as 'list' | 'grid',
  onViewChange,
}: {
```

Then find this exact text (the last two lines of the type annotation, just before `} = $props()`):

```ts
  meta?: string;
  externalSearchUrl?: string | null;
} = $props();
```

Replace it with:

```ts
  meta?: string;
  externalSearchUrl?: string | null;
  showViewToggle?: boolean;
  view?: 'list' | 'grid';
  onViewChange?: (v: 'list' | 'grid') => void;
} = $props();
```

- [ ] **Step 2: Add the toggle markup to the template**

In the `<div class="bar">` template block, the current order is:
1. `{#if showEntityToggle}` entity toggle
2. `<div class="search-wrap">`
3. `{#if showScanner}` scanner button
4. `{#if externalSearchUrl}` external link
5. `{#if showSyncChip}` sync chip
6. `{#if meta}` meta span

Insert a new block **between the entity toggle and the search-wrap**:

```svelte
  {#if showViewToggle}
    <div class="view-toggle">
      <button
        class="icon-btn"
        class:active={view === 'list'}
        title="List view"
        onclick={() => onViewChange?.('list')}
        type="button"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <rect x="1" y="2" width="3" height="3" rx="0.5" fill="currentColor"/>
          <line x1="6" y1="3.5" x2="13" y2="3.5" stroke="currentColor" stroke-width="1.2"/>
          <rect x="1" y="5.5" width="3" height="3" rx="0.5" fill="currentColor"/>
          <line x1="6" y1="7" x2="13" y2="7" stroke="currentColor" stroke-width="1.2"/>
          <rect x="1" y="9" width="3" height="3" rx="0.5" fill="currentColor"/>
          <line x1="6" y1="10.5" x2="13" y2="10.5" stroke="currentColor" stroke-width="1.2"/>
        </svg>
      </button>
      <button
        class="icon-btn"
        class:active={view === 'grid'}
        title="Grid view"
        onclick={() => onViewChange?.('grid')}
        type="button"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <rect x="1" y="1" width="5" height="5" rx="0.5" fill="currentColor"/>
          <rect x="8" y="1" width="5" height="5" rx="0.5" fill="currentColor"/>
          <rect x="1" y="8" width="5" height="5" rx="0.5" fill="currentColor"/>
          <rect x="8" y="8" width="5" height="5" rx="0.5" fill="currentColor"/>
        </svg>
      </button>
    </div>
  {/if}
```

- [ ] **Step 3: Add styles for .view-toggle and .icon-btn.active**

In the `<style>` block, after the existing `.icon-btn:hover` rule, add:

```css
  .icon-btn.active {
    color: var(--text);
    border-color: var(--accent-border);
    background: var(--accent-bg);
  }
  .view-toggle {
    display: flex;
    gap: 4px;
  }
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
cd /Users/luke/code/booth && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/components/ListviewToolbar.svelte
git commit -m "feat: add list/grid view toggle to ListviewToolbar"
```

---

## Task 3: Wire up in Explorer

**Files:**
- Modify: `src/lib/components/Explorer.svelte`

Add the `releaseView` state variable, pass the new toolbar props, import `ReleaseGrid`, and conditionally render it.

- [ ] **Step 1: Import ReleaseGrid**

At the top of the `<script>` block, after the existing `import ReleaseList from './ReleaseList.svelte';` line, add:

```ts
  import ReleaseGrid from './ReleaseGrid.svelte';
```

- [ ] **Step 2: Add releaseView state**

After the `let scannerOpen = $state(false);` line near the bottom of the script block, add:

```ts
  let releaseView = $state<'list' | 'grid'>('list');
```

- [ ] **Step 3: Pass view toggle props to ListviewToolbar**

Find the `<ListviewToolbar` block in the template. It currently ends with:

```svelte
      externalSearchUrl={discogsSearchUrl}
    />
```

Replace those last two lines with:

```svelte
      externalSearchUrl={discogsSearchUrl}
      showViewToggle={!isAddView && currentEntity === 'releases'}
      view={releaseView}
      onViewChange={(v) => (releaseView = v)}
    />
```

- [ ] **Step 4: Conditionally render ReleaseGrid or ReleaseList**

Find the `{:else if currentEntity === 'releases'}` block:

```svelte
    {:else if currentEntity === 'releases'}
      <ReleaseList
        items={listItems}
        total={listTotal}
        hasMore={listHasMore}
        selectedId={explorerState.id}
        onSelect={(id) => explorerState.setEntity(id)}
        loadMore={() => loadList(false)}
        emptyTitle={isAddView && !explorerState.q ? 'Search Discogs to add records' : 'No releases'}
      />
```

Replace it with:

```svelte
    {:else if currentEntity === 'releases'}
      {#if releaseView === 'grid'}
        <ReleaseGrid
          items={listItems}
          total={listTotal}
          hasMore={listHasMore}
          selectedId={explorerState.id}
          onSelect={(id) => explorerState.setEntity(id)}
          loadMore={() => loadList(false)}
          emptyTitle={isAddView && !explorerState.q ? 'Search Discogs to add records' : 'No releases'}
        />
      {:else}
        <ReleaseList
          items={listItems}
          total={listTotal}
          hasMore={listHasMore}
          selectedId={explorerState.id}
          onSelect={(id) => explorerState.setEntity(id)}
          loadMore={() => loadList(false)}
          emptyTitle={isAddView && !explorerState.q ? 'Search Discogs to add records' : 'No releases'}
        />
      {/if}
```

- [ ] **Step 5: Verify TypeScript compiles**

```bash
cd /Users/luke/code/booth && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Run the dev server and verify**

```bash
cd /Users/luke/code/booth && bun dev
```

Open `http://localhost:5173`. Check:
1. The toolbar shows list/grid icon buttons next to the entity toggle when in Releases mode.
2. Clicking the grid icon switches the middle pane to a card grid with album art, title, artist, year, and source dots.
3. Clicking a card opens the detail pane on the right.
4. Clicking the list icon switches back to the row list.
5. Switching to Tracks or Artists hides the toggle.
6. The toggle is hidden in the Add → Discogs view.
7. Releases without a thumbnail show a placeholder tile.

- [ ] **Step 7: Commit**

```bash
git add src/lib/components/Explorer.svelte
git commit -m "feat: wire up release grid view in Explorer"
```
