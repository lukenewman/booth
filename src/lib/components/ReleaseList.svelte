<script lang="ts">
  import Listview from './Listview.svelte';
  import { annotations } from '$lib/stores/annotations.svelte';
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
    // Add → Discogs master rows: collapse several pressings into one row that
    // drills into its versions.
    isMaster?: boolean;
    versionCount?: number;
    yearLabel?: string | null;
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
    /** Library rows can be dropped on a gig in the rail; Add-view search hits can't. */
    draggableToGig?: boolean;
  } = $props();
</script>

<Listview
  {items}
  {total}
  {hasMore}
  {selectedId}
  {onSelect}
  {loadMore}
  dragMime={draggableToGig ? 'application/x-booth-release' : undefined}
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
      {#if item.isMaster}
        <div class="meta">
          <div class="title">{item.title}</div>
          <div class="artist">{item.artist}{item.yearLabel ? ` · ${item.yearLabel}` : ''}</div>
          <div class="detail">{item.versionCount} versions</div>
        </div>
        <span class="chevron" aria-label="View versions">›</span>
      {:else}
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
      {/if}
      <!-- Two facts that must not read alike: a gold star count is "this
           release has keepers", a grey check is "you have been through it".
           Starred-but-unvetted is a real, correct state (you started and
           stopped), and it appears in the Unvetted queue — it only looks like
           a bug if the two indicators share a colour. -->
      {#if item.starredCount}
        <span class="star-count" title="{item.starredCount} starred track{item.starredCount === 1 ? '' : 's'}">★ {item.starredCount}</span>
      {/if}
      {#if annotations.isVetted(item.id)}
        <span class="vetted" title="Vetted">✓</span>
      {/if}
      <SourceGrid present={item.sources} />
    </div>
  {/snippet}
  {#snippet empty()}
    <EmptyState title={emptyTitle} detail={emptyDetail} />
  {/snippet}
</Listview>

<style>
  .star-count {
    color: var(--star);
    font-size: 10px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .vetted { color: var(--text-muted); font-size: 11px; }

  .cols, .row {
    display: grid;
    grid-template-columns: 56px 1fr 56px auto auto 56px;
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
  .chevron {
    color: var(--text-subtle);
    font-size: 18px;
    line-height: 1;
    text-align: right;
  }
</style>
