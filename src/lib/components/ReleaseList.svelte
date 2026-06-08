<script lang="ts">
  import Listview from './Listview.svelte';
  import SourceGrid from './SourceGrid.svelte';
  import EmptyState from './EmptyState.svelte';

  interface ReleaseItem {
    id: string;
    title: string;
    artist: string;
    year: number | null;
    sources: string[];
    thumbUrl?: string | null;
    country?: string | null;
    label?: string | null;
    catno?: string | null;
    format?: string | null;
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
      <span></span>
      <span>Release</span>
      <span class="right">Year</span>
      <span class="src-label">
        <span>D</span><span>i</span><span>R</span><span>P</span>
      </span>
    </div>
  {/snippet}
  {#snippet row(item)}
    <div class="row">
      {#if item.thumbUrl}
        <img class="cover" src={item.thumbUrl} alt="" loading="lazy">
      {:else}
        <div class="cover"></div>
      {/if}
      <div class="meta">
        <div class="title">{item.title}</div>
        <div class="artist">{item.artist}</div>
        {#if item.label || item.catno || item.country || item.format}
          <div class="detail">
            {[
              [item.label, item.catno].filter(Boolean).join(' – '),
              item.country,
              item.format,
            ].filter(Boolean).join(' · ')}
          </div>
        {/if}
      </div>
      <span class="year">{item.year ?? '—'}</span>
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
    grid-template-columns: 56px 1fr 56px 56px;
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
  .row { padding: 7px 14px; }
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

  .cover {
    width: 56px;
    height: 56px;
    border-radius: 3px;
    background: var(--bg-raised);
    flex-shrink: 0;
  }
  img.cover {
    object-fit: cover;
    display: block;
  }
  div.cover {
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .meta { min-width: 0; }
  .title {
    color: var(--text);
    font-weight: 500;
    font-size: 13px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .artist {
    color: var(--text-muted);
    font-size: 12px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .detail {
    color: var(--text-subtle);
    font-size: 11px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    margin-top: 2px;
  }
  .year {
    color: var(--text-subtle);
    font-variant-numeric: tabular-nums;
    font-size: 12px;
    text-align: right;
  }
</style>
