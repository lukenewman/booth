<script lang="ts">
  import SearchBar from '$lib/components/SearchBar.svelte';
  import ResultsList from '$lib/components/ResultsList.svelte';
  import { mode } from '$lib/stores/mode.svelte';
  import type { DiscogsRelease } from '$lib/types';

  let query = $state('');
  let results = $state<DiscogsRelease[]>([]);
  let highlightedIndex = $state(0);
  let loading = $state(false);
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  $effect(() => {
    const q = query.trim();
    clearTimeout(debounceTimer);
    if (!q) {
      results = [];
      return;
    }
    debounceTimer = setTimeout(() => runSearch(q), 250);
  });

  async function runSearch(q: string) {
    loading = true;
    try {
      const res = await fetch(`/api/discogs/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      results = data.results ?? [];
      highlightedIndex = 0;
    } finally {
      loading = false;
    }
  }

  function handleSelect(release: DiscogsRelease) {
    console.log('selected', release);
  }
</script>

<div class="app">
  <header>
    <span class="logo">booth</span>
    <span class="hint"><span class="kbd">?</span> shortcuts</span>
  </header>

  {#if mode.current === 'search'}
    <SearchBar bind:value={query} onScan={() => mode.setScanner()} />

    {#if loading}
      <div class="loading">Searching…</div>
    {:else if query.trim()}
      <ResultsList {results} {highlightedIndex} onSelect={handleSelect} />
    {/if}
  {:else}
    <div class="placeholder">Scanner mode (coming soon)</div>
  {/if}
</div>

<style>
  .app {
    max-width: 640px;
    margin: 0 auto;
    padding: 32px 20px;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16px;
    font-size: 12px;
    color: var(--text-muted);
  }
  .logo {
    color: var(--text);
    font-weight: 600;
    font-size: 14px;
  }
  .loading,
  .placeholder {
    padding: 20px;
    text-align: center;
    color: var(--text-muted);
    font-size: 13px;
  }
</style>
