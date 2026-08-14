<script lang="ts">
  import SearchBar from './SearchBar.svelte';
  import SyncChip from './SyncChip.svelte';
  import type { SortKey } from '$lib/types';

  /**
   * Top bar of the middle pane. Search input is always present.
   * Contextual right-side controls:
   *   - scanner button (Add views)
   *   - app-wide tracks/releases toggle (always visible unless the rail item
   *     is release-only by nature, e.g. Add → Discogs; Tab cycles it)
   *   - sync chip (Sources views)
   */
  let {
    query = $bindable(''),
    placeholder = 'Search…',
    onQueryChange,
    showScanner = false,
    onScan,
    showEntityToggle = true,
    entity = 'releases',
    onEntityChange,
    entityChoices = ['releases', 'tracks', 'artists'] as const,
    showSyncChip = false,
    syncIsStub = false,
    syncLastAt = null,
    syncing = false,
    onSync,
    meta = '',
    externalSearchUrl = null,
    showViewToggle = false,
    view = 'list' as 'list' | 'grid',
    onViewChange,
    showSort = false,
    sort = 'default' as SortKey,
    onSortChange,
  }: {
    query?: string;
    placeholder?: string;
    onQueryChange?: (v: string) => void;
    showScanner?: boolean;
    onScan?: () => void;
    showEntityToggle?: boolean;
    entity?: 'releases' | 'tracks' | 'artists';
    onEntityChange?: (e: 'releases' | 'tracks' | 'artists') => void;
    entityChoices?: readonly ('releases' | 'tracks' | 'artists')[];
    showSyncChip?: boolean;
    syncIsStub?: boolean;
    syncLastAt?: string | null;
    syncing?: boolean;
    onSync?: () => void;
    meta?: string;
    externalSearchUrl?: string | null;
    showViewToggle?: boolean;
    view?: 'list' | 'grid';
    onViewChange?: (v: 'list' | 'grid') => void;
    showSort?: boolean;
    sort?: SortKey;
    onSortChange?: (s: SortKey) => void;
  } = $props();

  const SORT_LABELS: Record<SortKey, string> = {
    default: 'Default',
    'added-desc': 'Added ↓',
    'added-asc': 'Added ↑',
  };

  let searchBar: SearchBar | undefined = $state();

  // Re-export focus so the page can wire `/` to focus the input.
  export function focusSearch() {
    searchBar?.focus();
  }
</script>

<div class="bar">
  {#if showEntityToggle}
    <div class="toggle" title="Cycle releases / tracks / artists (Tab)">
      {#each entityChoices as choice}
        <button
          class:active={entity === choice}
          onclick={() => onEntityChange?.(choice)}
        >{choice === 'releases' ? 'Releases' : choice === 'tracks' ? 'Tracks' : 'Artists'}</button>
      {/each}
    </div>
  {/if}
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
  {#if showSort}
    <div class="toggle sort" title="Sort by date added to your library">
      {#each Object.keys(SORT_LABELS) as SortKey[] as choice}
        <button
          class:active={sort === choice}
          onclick={() => onSortChange?.(choice)}
          type="button"
        >{SORT_LABELS[choice]}</button>
      {/each}
    </div>
  {/if}
  <div class="search-wrap">
    <SearchBar
      bind:this={searchBar}
      bind:value={query}
      {placeholder}
      onChange={onQueryChange}
    />
  </div>
  {#if showScanner}
    <button class="icon-btn" title="Scan barcode (s)" onclick={() => onScan?.()}>
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
        <path d="M2 2v10M4 2v10M6 2v6M8 2v10M10 2v6M12 2v10" stroke="currentColor" stroke-width="1"/>
      </svg>
    </button>
  {/if}
  {#if externalSearchUrl}
    <a class="open-link" href={externalSearchUrl} target="_blank" rel="noreferrer" title="Open search in Discogs">discogs ↗</a>
  {/if}
  {#if showSyncChip}
    <SyncChip isStub={syncIsStub} lastSyncedAt={syncLastAt} {syncing} {onSync} />
  {/if}
  {#if meta}<span class="meta">{meta}</span>{/if}
</div>

<style>
  .bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .search-wrap { flex: 1; min-width: 0; }
  .icon-btn {
    width: 28px; height: 26px;
    background: transparent;
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    color: var(--text-muted);
    display: flex; align-items: center; justify-content: center;
    cursor: pointer;
    padding: 0;
  }
  .icon-btn:hover {
    color: var(--text);
    border-color: var(--text-muted);
  }
  .icon-btn.active {
    color: var(--text);
    border-color: var(--accent-border);
    background: var(--accent-bg);
  }
  .view-toggle {
    display: flex;
    gap: 4px;
  }
  .toggle {
    display: flex;
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    overflow: hidden;
  }
  .toggle button {
    background: transparent;
    border: 0;
    color: var(--text-muted);
    padding: 4px 9px;
    font-family: inherit;
    font-size: 11px;
    cursor: pointer;
  }
  .toggle button.active {
    background: var(--accent-bg);
    color: var(--text);
  }
  .meta {
    color: var(--text-subtle);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .open-link {
    color: var(--text-subtle);
    font-size: 11px;
    text-decoration: none;
    white-space: nowrap;
  }
  .open-link:hover { color: var(--accent); }
</style>
