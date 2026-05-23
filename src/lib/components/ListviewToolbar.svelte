<script lang="ts">
  import SearchBar from './SearchBar.svelte';
  import SyncChip from './SyncChip.svelte';

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
    showSyncChip = false,
    syncIsStub = false,
    syncLastAt = null,
    syncing = false,
    onSync,
    meta = '',
  }: {
    query?: string;
    placeholder?: string;
    onQueryChange?: (v: string) => void;
    showScanner?: boolean;
    onScan?: () => void;
    showEntityToggle?: boolean;
    entity?: 'releases' | 'tracks';
    onEntityChange?: (e: 'releases' | 'tracks') => void;
    showSyncChip?: boolean;
    syncIsStub?: boolean;
    syncLastAt?: string | null;
    syncing?: boolean;
    onSync?: () => void;
    meta?: string;
  } = $props();

  let searchBar: SearchBar | undefined = $state();

  // Re-export focus so the page can wire `/` to focus the input.
  export function focusSearch() {
    searchBar?.focus();
  }
</script>

<div class="bar">
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
  {#if showEntityToggle}
    <div class="toggle" title="Toggle tracks / releases (Tab)">
      <button
        class:active={entity === 'tracks'}
        onclick={() => onEntityChange?.('tracks')}
      >Tracks</button>
      <button
        class:active={entity === 'releases'}
        onclick={() => onEntityChange?.('releases')}
      >Releases</button>
    </div>
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
</style>
