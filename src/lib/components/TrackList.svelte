<script lang="ts">
  import { DEFAULT_SORT } from '$lib/types';
  import type { LibraryQuery, PlaybackContext } from '$lib/queue';
  import Listview from './Listview.svelte';
  import SourceGrid from './SourceGrid.svelte';
  import StarButton from './StarButton.svelte';
  import TrackNote from './TrackNote.svelte';
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
    release_id: string | null;
    starred_at?: string | null;
    note?: string | null;
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
    query,
  }: {
    items: TrackItem[];
    total: number;
    hasMore: boolean;
    selectedId?: string | null;
    onSelect?: (id: string) => void;
    loadMore?: () => void;
    query?: LibraryQuery;
    emptyTitle?: string;
    emptyDetail?: string;
  } = $props();

  // The library queue is resolved server-side from these filters, because the
  // loaded rows are only a 200-row window of a much longer list.
  const libraryCtx = $derived({
    kind: 'library',
    query: query ?? { sort: DEFAULT_SORT },
  } as PlaybackContext);

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
      <span></span>
      <span>Track</span>
      <span>Note</span>
      <span class="right">Length</span>
      <span></span>
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
      onkeydown={(e) => { if (e.key === 'Enter' && item.canPlay) player.playFrom(libraryCtx, item.id, { trackId: item.id, title: item.title, artist: item.artist, thumbUrl: item.thumb_url, releaseId: item.release_id }); }}
      onclick={(e) => { if (e.detail > 0) e.stopPropagation(); }}
      ondblclick={() => { if (item.canPlay) player.playFrom(libraryCtx, item.id, { trackId: item.id, title: item.title, artist: item.artist, thumbUrl: item.thumb_url, releaseId: item.release_id }); }}
    >
      <span
        class="info-icon"
        role="button"
        tabindex="-1"
        aria-label="View details for {item.title}"
        onclick={(e) => { e.stopPropagation(); onSelect?.(item.id); }}
        onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); onSelect?.(item.id); } }}
        ondblclick={(e) => e.stopPropagation()}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="9.25" stroke="currentColor" stroke-width="1.6"/>
          <path d="M12 10.6v6.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
          <circle cx="12" cy="7.4" r="1.1" fill="currentColor"/>
        </svg>
      </span>
      <!-- The ▶ used to ride on the info icon, which meant that slot changed
           meaning depending on player state. Now that rows have art, the
           playing badge lives on the cover — the same pattern PlaylistView
           already uses — and the info icon only ever means "open details". -->
      <div class="cover" class:playing={isPlaying}>
        {#if item.thumb_url}
          <img src={item.thumb_url} alt="" loading="lazy">
        {/if}
        {#if isPlaying}<span class="playing-badge">▶</span>{/if}
      </div>
      <div class="meta">
        <div class="title">{item.title}</div>
        <div class="artist">{item.artist}</div>
        <div class="album">{item.album ?? '—'}</div>
      </div>
      <div class="note-cell"><TrackNote trackId={item.id} readonly /></div>
      <span class="dur">{formatDuration(item.duration_ms)}</span>
      <StarButton trackId={item.id} />
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
    /* Cover column is sized to the meta v-stack's natural height (title 18 +
       artist 17 + album 17), and the cover itself stretches to the row, so the
       two stay square against each other. If the stack ever grows, the cover
       grows with it and object-fit crops rather than distorting. */
    grid-template-columns: 20px 52px minmax(0, 1fr) minmax(0, 1.2fr) 60px 20px 56px;
    gap: 12px;
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

  /* An SVG rather than a glyph: `color: transparent` hid the old › until
     hover, which cannot work for a stroked icon, so visibility is opacity. */
  .info-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-muted);
    opacity: 0;
    cursor: pointer;
    user-select: none;
    transition: opacity 0.12s, color 0.12s;
  }
  .row:hover .info-icon,
  .info-icon:focus-visible { opacity: 1; }
  .info-icon:hover { color: var(--text); }

  .cover {
    position: relative;
    width: 100%;
    align-self: stretch;
    border-radius: 3px;
    overflow: hidden;
    background: var(--bg-raised);
    flex-shrink: 0;
  }
  .cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .playing-badge {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.55);
    color: var(--accent-strong);
    font-size: 11px;
  }

  /* Two lines then ellipsis: a long note must not make row heights ragged. */
  .note-cell {
    min-width: 0;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .row.playing .title { color: var(--accent); }
</style>
