<script lang="ts">
  import Listview from './Listview.svelte';
  import SourceGrid from './SourceGrid.svelte';
  import EmptyState from './EmptyState.svelte';
  import { player } from '$lib/stores/player.svelte';
  import { translucentDragImage } from '$lib/dnd';

  interface TrackItem {
    id: string;
    title: string;
    artist: string;
    album: string | null;
    duration_ms: number | null;
    sources: string[];
    canPlay: boolean;
    thumb_url: string | null;
  }

  let {
    items,
    total,
    hasMore,
    selectedId = null,
    onSelect,
    loadMore,
    emptyTitle = 'No tracks',
    emptyDetail = '',
  }: {
    items: TrackItem[];
    total: number;
    hasMore: boolean;
    selectedId?: string | null;
    onSelect?: (id: string) => void;
    loadMore?: () => void;
    emptyTitle?: string;
    emptyDetail?: string;
  } = $props();

  function formatDuration(ms: number | null): string {
    if (!ms) return '—';
    const s = Math.round(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
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
      <span>Track</span>
      <span>Album</span>
      <span class="right">Length</span>
      <span class="src-label">
        <span>D</span><span>i</span><span>R</span><span>P</span>
      </span>
    </div>
  {/snippet}
  {#snippet row(item)}
    {@const isPlaying = player.nowPlaying?.trackId === item.id}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="row"
      class:playing={isPlaying}
      role="listitem"
      draggable="true"
      ondragstart={(e) => { e.dataTransfer?.setData('application/x-booth-track', item.id); if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy'; if (e.currentTarget instanceof HTMLElement) translucentDragImage(e, e.currentTarget); }}
      onkeydown={(e) => { if (e.key === 'Enter' && item.canPlay) player.play({ trackId: item.id, title: item.title, artist: item.artist, thumbUrl: item.thumb_url }); }}
      onclick={(e) => { if (e.detail > 0) e.stopPropagation(); }}
      ondblclick={() => { if (item.canPlay) player.play({ trackId: item.id, title: item.title, artist: item.artist, thumbUrl: item.thumb_url }); }}
    >
      <span
        class="info-icon"
        class:playing={isPlaying}
        role="button"
        tabindex="-1"
        aria-label="View details for {item.title}"
        onclick={(e) => { e.stopPropagation(); onSelect?.(item.id); }}
        onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); onSelect?.(item.id); } }}
        ondblclick={(e) => e.stopPropagation()}
      >{isPlaying ? '▶' : '›'}</span>
      <div class="meta">
        <div class="title">{item.title}</div>
        <div class="artist">{item.artist}</div>
      </div>
      <span class="album">{item.album ?? '—'}</span>
      <span class="dur">{formatDuration(item.duration_ms)}</span>
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
    grid-template-columns: 20px 1fr 100px 60px 56px;
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
  .album {
    color: var(--text-muted);
    font-size: 12px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .dur {
    color: var(--text-subtle);
    font-variant-numeric: tabular-nums;
    font-family: var(--font-mono);
    font-size: 11.5px;
    text-align: right;
  }

  .info-icon {
    color: transparent;
    font-size: 13px;
    line-height: 1;
    text-align: center;
    cursor: pointer;
    user-select: none;
  }
  .row:hover .info-icon { color: var(--text-muted); }
  .info-icon.playing { color: var(--accent) !important; }
  .row.playing .title { color: var(--accent); }
</style>
