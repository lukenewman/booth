<script lang="ts">
  import type { DiscogsRelease } from '$lib/types';
  import ResultRow from './ResultRow.svelte';

  let {
    results,
    highlightedIndex,
    onSelect,
  }: {
    results: DiscogsRelease[];
    highlightedIndex: number;
    onSelect: (release: DiscogsRelease) => void;
  } = $props();
</script>

{#if results.length === 0}
  <div class="empty">No results.</div>
{:else}
  <div class="list">
    {#each results as release, i (release.id)}
      <ResultRow
        {release}
        highlighted={i === highlightedIndex}
        onclick={() => onSelect(release)}
      />
    {/each}
  </div>
{/if}

<style>
  .list {
    display: flex;
    flex-direction: column;
  }
  .empty {
    padding: 20px;
    text-align: center;
    color: var(--text-muted);
    font-size: 13px;
  }
</style>
