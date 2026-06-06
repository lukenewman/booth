<script lang="ts">
  import Listview from './Listview.svelte';
  import SourceGrid from './SourceGrid.svelte';
  import EmptyState from './EmptyState.svelte';

  interface ArtistItem {
    id: string;
    name: string;
    releaseCount: number;
    trackCount: number;
    sources: string[];
    albums: { title: string; thumbUrl: string | null }[];
  }

  let {
    items,
    total,
    hasMore,
    selectedId = null,
    onSelect,
    loadMore,
    emptyTitle = 'No artists',
    emptyDetail = '',
  }: {
    items: ArtistItem[];
    total: number;
    hasMore: boolean;
    selectedId?: string | null;
    onSelect?: (id: string) => void;
    loadMore?: () => void;
    emptyTitle?: string;
    emptyDetail?: string;
  } = $props();
</script>

<Listview
  {items}
  {total}
  {hasMore}
  {selectedId}
  {onSelect}
  {loadMore}
>
  {#snippet headers()}
    <div class="cols">
      <span>Artist</span>
      <span>Albums</span>
      <span class="right">Rel.</span>
      <span class="right">Trk.</span>
      <span class="src-label">
        <span>D</span><span>i</span><span>R</span><span>P</span>
      </span>
    </div>
  {/snippet}
  {#snippet row(item)}
    <div class="row">
      <div class="meta">
        <div class="name">{item.name}</div>
      </div>
      <div class="album-strip">
        {#each item.albums as album}
          {#if album.thumbUrl}
            <img src={album.thumbUrl} alt={album.title} class="cover" />
          {:else}
            <div class="cover placeholder"></div>
          {/if}
        {/each}
      </div>
      <span class="count">{(item.releaseCount ?? 0).toLocaleString()}</span>
      <span class="count">{(item.trackCount ?? 0).toLocaleString()}</span>
      <SourceGrid present={item.sources} />
    </div>
  {/snippet}
  {#snippet empty()}
    <EmptyState title={emptyTitle} detail={emptyDetail} />
  {/snippet}
</Listview>

<style>
  .cols, .row {
    display: grid;
    grid-template-columns: 1fr 160px 44px 44px 56px;
    gap: 14px;
    padding: 6px 14px;
    align-items: center;
  }
  .cols {
    color: var(--text-subtle);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .row { padding: 9px 14px; }
  .right { text-align: right; }
  .src-label {
    display: grid;
    grid-template-columns: repeat(4, 8px);
    gap: 4px;
  }
  .src-label span {
    text-align: center;
    font-family: var(--font-mono);
    font-size: 9px;
    text-transform: none;
    letter-spacing: 0;
  }
  .meta { min-width: 0; }
  .name {
    color: var(--text);
    font-weight: 500;
    font-size: 13px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .count {
    color: var(--text-subtle);
    font-variant-numeric: tabular-nums;
    font-size: 12px;
    text-align: right;
  }
  .album-strip {
    display: flex;
    gap: 4px;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .album-strip::-webkit-scrollbar { display: none; }
  .cover {
    width: 44px;
    height: 44px;
    border-radius: 3px;
    object-fit: cover;
    display: block;
    flex-shrink: 0;
  }
  .placeholder { background: #252525; }
</style>
