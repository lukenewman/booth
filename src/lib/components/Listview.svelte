<script lang="ts" generics="T extends { id: string }">
  import type { Snippet } from 'svelte';

  /**
   * Generic paginated list shell. Caller provides:
   *  - `items`: the rows to render
   *  - `total`, `hasMore`: pagination state from the server
   *  - `headers` snippet: column-header strip
   *  - `row` snippet: per-row markup, receives the item
   *  - `loadMore` callback: fired when the sentinel scrolls into view
   *  - `selectedId`, `onSelect`: selection state
   */
  let {
    items,
    total,
    hasMore,
    selectedId = null,
    onSelect,
    loadMore,
    headers,
    row,
    empty,
  }: {
    items: T[];
    total: number;
    hasMore: boolean;
    selectedId?: string | null;
    onSelect?: (id: string) => void;
    loadMore?: () => void;
    headers: Snippet;
    row: Snippet<[T, boolean]>;
    empty?: Snippet;
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
    // The scrollable ancestor is `.body` (overflow-y: auto), not the viewport.
    // Without an explicit root, the sentinel never intersects on inner scroll.
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

<div class="listview">
  <div class="headers">{@render headers()}</div>
  <div class="body">
    {#if items.length === 0}
      {#if empty}{@render empty()}{:else}<div class="empty">No items.</div>{/if}
    {:else}
      {#each items as item (item.id)}
        <button
          class="row-btn"
          class:selected={item.id === selectedId}
          onclick={() => onSelect?.(item.id)}
          type="button"
        >
          {@render row(item, item.id === selectedId)}
        </button>
      {/each}
      {#if hasMore}
        <div class="sentinel" bind:this={sentinel}></div>
      {/if}
    {/if}
  </div>
</div>

<style>
  .listview {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }
  .headers {
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .body {
    flex: 1;
    overflow-y: auto;
  }
  .row-btn {
    display: block;
    width: 100%;
    background: transparent;
    border: 0;
    padding: 0;
    text-align: left;
    cursor: pointer;
    color: inherit;
    font: inherit;
  }
  .row-btn + .row-btn { border-top: 1px solid rgba(255, 255, 255, 0.025); }
  .row-btn:hover { background: var(--bg-row-hover); }
  .row-btn.selected { background: var(--accent-bg); }
  .sentinel { height: 1px; }
  .empty { padding: 24px; color: var(--text-subtle); text-align: center; font-size: 12px; }
</style>
