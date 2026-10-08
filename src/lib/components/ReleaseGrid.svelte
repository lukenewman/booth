<script lang="ts">
  import SourceGrid from './SourceGrid.svelte';
  import { annotations } from '$lib/stores/annotations.svelte';
  import EmptyState from './EmptyState.svelte';
  import { translucentDragImage } from '$lib/dnd';

  interface ReleaseItem {
    id: string;
    title: string;
    artist: string;
    year: number | null;
    sources: string[];
    thumbUrl?: string | null;
    starredCount?: number;
    vetted_at?: string | null;
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
    draggableToGig = false,
  }: {
    items: ReleaseItem[];
    total: number;
    hasMore: boolean;
    selectedId?: string | null;
    onSelect?: (id: string) => void;
    loadMore?: () => void;
    emptyTitle?: string;
    emptyDetail?: string;
    draggableToGig?: boolean;
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
            data-id={item.id}
            class:selected={item.id === selectedId}
            onclick={() => onSelect?.(item.id)}
            draggable={draggableToGig}
            ondragstart={(e) => { if (!draggableToGig || !e.dataTransfer) return; e.dataTransfer.setData('application/x-booth-release', item.id); e.dataTransfer.effectAllowed = 'copy'; if (e.currentTarget instanceof HTMLElement) translucentDragImage(e, e.currentTarget); }}
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
                <!-- Gold star count vs grey check: see ReleaseList. -->
                {#if item.starredCount}
                  <span class="star-count" title="{item.starredCount} starred">★ {item.starredCount}</span>
                {/if}
                {#if annotations.isVetted(item.id)}
                  <span class="vetted" title="Vetted">✓</span>
                {/if}
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
  .star-count {
    color: var(--star);
    font-size: 10px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .vetted { color: var(--text-muted); font-size: 11px; }

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
