<script lang="ts">
  import { formatBpm } from '$lib/bpm';
  import { playlists } from '$lib/stores/playlists.svelte';
  import StarButton from './StarButton.svelte';
  import TrackNote from './TrackNote.svelte';
  import type { PlaybackContext } from '$lib/queue';
  import { player } from '$lib/stores/player.svelte';
  import { translucentDragImage, startPointerDrag } from '$lib/dnd';
  import { reorderTo, moveByDelta } from '$lib/playlistOrder';
  import EmptyState from './EmptyState.svelte';
  import PlaylistCover from './PlaylistCover.svelte';
  import RemoveConfirm from './RemoveConfirm.svelte';

  let {
    selectedId = null,
    onTrackSelect,
    onArtistSelect,
    onReleaseSelect,
    onDeleted,
  }: {
    selectedId?: string | null;
    onTrackSelect?: (id: string) => void;
    onArtistSelect?: (artistId: string) => void;
    onReleaseSelect?: (releaseId: string) => void;
    onDeleted?: () => void;
  } = $props();

  const open = $derived(playlists.openPlaylist);
  // A plain playlist is exactly its Unsorted section; rendering entries (not
  // just present tracks) is what keeps a missing row visible here.
  const entries = $derived(open?.sections[0]?.entries ?? []);

  // Playing from a playlist queues that playlist, and keeps queueing it even
  // after you navigate away — the context is captured at play time.
  const playablePl = $derived((open?.tracks ?? []).filter((t: { canPlay?: boolean }) => t.canPlay));
  /**
   * Set prep is the case BPM matters most for, but only ~15% of the library has
   * one today, so the column earns its width only when something in this
   * playlist can fill it.
   */
  const NARROW = 768;
  let innerWidth = $state(0);
  const anyBpm = $derived(innerWidth > NARROW && (open?.tracks ?? []).some((t) => t.bpm != null));
  const gridTemplate = $derived(
    [
      '52px',
      'minmax(0, 2.2fr)',
      'minmax(0, 1.5fr)',
      'minmax(0, 1.5fr)',
      anyBpm ? '46px' : null,
      '56px',
      '20px',
      '20px',
      '28px',
    ]
      .filter(Boolean)
      .join(' '),
  );

  /**
   * Total runtime. Discogs-only tracks often carry no duration, so a sum can
   * silently undercount — the `+` says the real total is at least this.
   */
  const totalMs = $derived(
    (open?.tracks ?? []).reduce((n: number, t: { duration_ms: number | null }) => n + (t.duration_ms ?? 0), 0),
  );
  const partialDuration = $derived(
    (open?.tracks ?? []).some((t: { duration_ms: number | null }) => !t.duration_ms),
  );

  const playlistCtx = $derived({
    kind: 'playlist',
    playlistId: open?.id ?? '',
    ids: playablePl.map((t: { id: string }) => t.id),
  } as PlaybackContext);
  const playlistSeed = $derived(
    playablePl.map((t: any) => ({
      trackId: t.id,
      title: t.title,
      artist: t.artist,
      thumbUrl: t.thumb_url,
      releaseId: t.release_id,
    })),
  );

  let renaming = $state(false);
  let nameDraft = $state('');
  let confirmingDelete = $state(false);
  let dragId = $state<string | null>(null);
  let overId = $state<string | null>(null);
  let listEl = $state<HTMLElement | null>(null);


  function startRename() {
    if (!open) return;
    nameDraft = open.name;
    renaming = true;
  }
  function commitRename() {
    if (open && nameDraft.trim()) playlists.rename(open.id, nameDraft.trim());
    renaming = false;
  }

  async function confirmDelete() {
    if (!open) return;
    await playlists.remove(open.id);
    confirmingDelete = false;
    onDeleted?.();
  }

  function formatDuration(ms: number | null): string {
    if (!ms) return '—';
    const s = Math.round(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  /** Playlist totals: hours matter for a set, seconds don't. */
  function formatTotal(ms: number, partial: boolean): string {
    const min = Math.round(ms / 60000);
    const h = Math.floor(min / 60);
    const label = h ? `${h} hr ${min % 60} min` : `${min} min`;
    return partial ? `${label}+` : label;
  }

  let fileInput = $state<HTMLInputElement>();
  function pickCover() {
    fileInput?.click();
  }
  function onCoverFile(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (open && file) playlists.uploadCover(open.id, file);
    input.value = '';
  }
  function onCoverDrop(e: DragEvent) {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (open && file && file.type.startsWith('image/')) playlists.uploadCover(open.id, file);
  }

  function onDragStart(e: DragEvent, trackId: string) {
    dragId = trackId;
    e.dataTransfer?.setData('application/x-booth-track', trackId);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    if (e.currentTarget instanceof HTMLElement) translucentDragImage(e, e.currentTarget);
  }

  /**
   * Move `dragId` to sit where `targetId` currently is, then persist.
   * Shared by every reorder path so the arithmetic cannot drift.
   */
  function applyReorder(targetId: string) {
    const moved = dragId;
    dragId = null;
    if (!open || !moved) return;
    // reorderTo declines a no-op move, and declines ids that aren't both in
    // this playlist — a track dragged in from elsewhere is added via the rail,
    // not reordered here.
    const next = reorderTo(open.tracks.map((t) => t.id), moved, targetId);
    if (next) playlists.reorder(open.id, next);
  }

  /**
   * Reorder is driven from the grab handle via pointer events rather than
   * HTML5 DnD, because `dragstart` never fires from a finger. Mouse and touch
   * therefore share one path instead of needing two implementations.
   *
   * The row keeps `draggable` + `ondragstart` for a different gesture: dragging
   * a track OUT onto a rail playlist, which is desktop-only and unchanged.
   */
  /** Keyboard equivalent of the drag: nudge a track one slot up or down. */
  function moveBy(trackId: string, delta: number) {
    if (!open) return;
    const next = moveByDelta(open.tracks.map((t) => t.id), trackId, delta);
    if (next) playlists.reorder(open.id, next);
  }

  function onGripPointerDown(e: PointerEvent, trackId: string) {
    const rowEl = (e.currentTarget as HTMLElement).closest('[data-id]');
    if (!(rowEl instanceof HTMLElement) || !listEl) return;
    dragId = trackId;
    startPointerDrag({
      event: e,
      row: rowEl,
      list: listEl,
      onOver: (id) => (overId = id),
      onDrop: (id) => { if (id) applyReorder(id); else dragId = null; },
    });
  }
</script>

<svelte:window bind:innerWidth />

{#if !open}
  <EmptyState title="Loading…" />
{:else}
  <div class="pl-header">
    <button
      class="cover-btn"
      title="Upload a cover image"
      onclick={pickCover}
      ondragover={(e) => e.preventDefault()}
      ondrop={onCoverDrop}
    >
      <PlaylistCover coverUrl={open.coverUrl} mosaic={open.mosaic} size={112} />
      <span class="cover-edit">Change</span>
    </button>
    <input
      class="file-input"
      type="file"
      accept="image/png,image/jpeg,image/webp"
      bind:this={fileInput}
      onchange={onCoverFile}
    />

    <div class="header-meta">
      {#if renaming}
        <!-- svelte-ignore a11y_autofocus -->
        <input
          class="name-input"
          bind:value={nameDraft}
          autofocus
          onkeydown={(e) => {
            if (e.key === 'Enter') commitRename();
            else if (e.key === 'Escape') { e.stopPropagation(); renaming = false; }
          }}
          onblur={commitRename}
        />
      {:else}
        <button class="name" onclick={startRename} title="Rename">{open.name}</button>
      {/if}
      <span class="meta">
        {open.tracks.length} {open.tracks.length === 1 ? 'track' : 'tracks'}
        {#if open.tracks.length > 0}<span class="sep">·</span>{formatTotal(totalMs, partialDuration)}{/if}
      </span>
      <div class="header-actions">
        <button class="link" title="Split this playlist into sections — turns it into a gig" onclick={() => open && playlists.addSection(open.id, 'New section')}>＋ Section</button>
        {#if open.coverUrl}
          <button class="link" onclick={() => open && playlists.removeCover(open.id)}>Remove custom cover</button>
        {/if}
        {#if confirmingDelete}
          <span class="confirm">
            Delete playlist?
            <button class="danger" onclick={confirmDelete}>Delete</button>
            <button class="ghost" onclick={() => (confirmingDelete = false)}>Cancel</button>
          </span>
        {:else}
          <button class="del" title="Delete playlist" onclick={() => (confirmingDelete = true)}>🗑</button>
        {/if}
      </div>
    </div>
  </div>

  <div class="listview">
    <div class="cols" style="grid-template-columns: {gridTemplate}">
      <span></span>
      <span>Track</span>
      <span>Artist</span>
      <span>Release</span>
      {#if anyBpm}<span class="right">BPM</span>{/if}
      <span class="right">Length</span>
      <span></span>
      <span></span>
    </div>
    <div class="body" bind:this={listEl}>
      {#if entries.length === 0}
        <EmptyState title="No tracks yet" detail="Drag tracks here, or press a on a track to add it." />
      {:else}
        {#each entries as entry (entry.entryId)}
          {#if !entry.track}
            <!-- A track the library no longer has. Kept, greyed, from its
                 snapshot; not a .row-btn because the a / Delete keys act on
                 library track ids. Relinks itself after a sync if it returns. -->
            <div class="missing" role="listitem" data-entry-id={entry.entryId}>
              <span class="row" style="grid-template-columns: {gridTemplate}">
                <span class="thumb"></span>
                <span class="cell title">{entry.snapshot.title}<span class="missing-tag">missing</span></span>
                <span class="cell artist">{entry.snapshot.artist}</span>
                <span class="cell release">{entry.snapshot.album ?? '—'}</span>
                {#if anyBpm}<span class="bpm"></span>{/if}
                <span class="dur">—</span>
                <span></span>
                <button class="remove" aria-label="Remove {entry.snapshot.title}" onclick={() => open && playlists.removeEntry(open.id, entry.entryId)}>×</button>
                <span></span>
              </span>
            </div>
          {:else}
          {@const t = entry.track}
          {@const isPlaying = player.nowPlaying?.trackId === t.id}
          <button
            class="row-btn"
            class:selected={t.id === selectedId}
            class:playing={isPlaying}
            class:drop-over={overId === t.id}
            data-id={t.id}
            type="button"
            draggable="true"
            ondragstart={(e) => onDragStart(e, t.id)}
            ondragover={(e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'; if (dragId && dragId !== t.id) overId = t.id; }}
            ondragleave={() => { if (overId === t.id) overId = null; }}
            ondrop={(e) => { e.preventDefault(); overId = null; applyReorder(t.id); }}
            ondragend={() => { dragId = null; overId = null; }}
            onclick={(e) => { if (e.detail > 0) e.stopPropagation(); else onTrackSelect?.(t.id); }}
            ondblclick={() => { if (t.canPlay) player.playFrom(playlistCtx, t.id, { trackId: t.id, title: t.title, artist: t.artist, thumbUrl: t.thumb_url, releaseId: t.release_id, bpm: t.bpm ?? null }, playlistSeed); }}
          >
            <span class="row" style="grid-template-columns: {gridTemplate}">
              <span class="thumb" class:playing={isPlaying}>
                {#if t.thumb_url}<img src={t.thumb_url} alt="" loading="lazy" />{/if}
                {#if isPlaying}<span class="play-badge">▶</span>{/if}
              </span>
              <span class="cell title" class:dim={!t.canPlay}>
                {t.title}
                <TrackNote trackId={t.id} readonly />
              </span>
              <span
                class="cell artist link"
                role="link"
                tabindex="-1"
                onclick={(e) => { e.stopPropagation(); onArtistSelect?.(t.artist_id); }}
                onkeydown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onArtistSelect?.(t.artist_id); } }}
              >{t.artist}</span>
              {#if t.release_id}
                <span
                  class="cell release link"
                  role="link"
                  tabindex="-1"
                  onclick={(e) => { e.stopPropagation(); onReleaseSelect?.(t.release_id!); }}
                  onkeydown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onReleaseSelect?.(t.release_id!); } }}
                >{t.album ?? '—'}</span>
              {:else}
                <span class="cell release">{t.album ?? '—'}</span>
              {/if}
              {#if anyBpm}
                <span class="bpm">{t.bpm ? formatBpm(t.bpm.value) : ''}</span>
              {/if}
              <span class="dur">{formatDuration(t.duration_ms)}</span>
              <StarButton trackId={t.id} />
              <span
                class="remove"
                role="button"
                tabindex="-1"
                aria-label="Remove {t.title}"
                onclick={(e) => { e.stopPropagation(); if (open) playlists.requestRemove(open.id, t.id, t.title); }}
                onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); if (open) playlists.requestRemove(open.id, t.id, t.title); } }}
                ondblclick={(e) => e.stopPropagation()}
              >×</span>
              <span
                class="grip"
                role="button"
                tabindex="-1"
                aria-label="Reorder {t.title}"
                onpointerdown={(e) => onGripPointerDown(e, t.id)}
                onclick={(e) => e.stopPropagation()}
                ondblclick={(e) => e.stopPropagation()}
                onkeydown={(e) => {
                  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
                  e.preventDefault();
                  e.stopPropagation();
                  moveBy(t.id, e.key === 'ArrowUp' ? -1 : 1);
                }}
              >⠿</span>
            </span>
          </button>
          {/if}
        {/each}
      {/if}
    </div>
  </div>

  <RemoveConfirm />
{/if}

<style>
  .pl-header {
    display: flex;
    align-items: flex-start;
    gap: 14px;
    padding: 14px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .cover-btn {
    position: relative;
    background: transparent;
    border: 0;
    padding: 0;
    cursor: pointer;
    line-height: 0;
    border-radius: 4px;
    overflow: hidden;
    flex-shrink: 0;
  }
  .cover-btn .cover-edit {
    position: absolute;
    inset: auto 0 0 0;
    background: rgba(0, 0, 0, 0.6);
    color: #fff;
    font-size: 10px;
    text-align: center;
    padding: 3px 0;
    opacity: 0;
    transition: opacity 0.12s;
  }
  .cover-btn:hover .cover-edit { opacity: 1; }
  .file-input { display: none; }
  .header-meta {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
    min-width: 0;
    flex: 1;
    padding-top: 2px;
  }
  .header-actions {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    margin-top: 4px;
  }
  .header-actions .link {
    background: transparent;
    border: 0;
    color: var(--text-subtle);
    font-family: inherit;
    font-size: 11px;
    cursor: pointer;
    padding: 0;
    text-decoration: underline;
  }
  .header-actions .link:hover { color: var(--text-muted); }
  .name {
    background: transparent; border: 0; color: var(--text);
    font-family: inherit; font-size: 14px; font-weight: 600;
    cursor: pointer; padding: 0;
  }
  .name:hover { color: var(--accent); }
  .name-input {
    background: var(--bg-raised); border: 1px solid var(--border-strong);
    border-radius: 3px; padding: 3px 6px; color: var(--text);
    font-family: inherit; font-size: 14px; font-weight: 600;
  }
  .meta { color: var(--text-subtle); font-size: 11px; font-variant-numeric: tabular-nums; }
  .meta .sep { margin: 0 5px; opacity: 0.6; }
  .del {
    margin-left: auto; background: transparent; border: 0;
    color: var(--text-subtle); cursor: pointer; font-size: 13px;
  }
  .del:hover { color: var(--danger); }
  .confirm { margin-left: auto; display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-muted); }
  .confirm .danger { background: var(--danger); border: 0; color: #fff; border-radius: 3px; padding: 3px 8px; cursor: pointer; font-family: inherit; font-size: 11px; }
  .confirm .ghost { background: transparent; border: 1px solid var(--border-strong); color: var(--text-muted); border-radius: 3px; padding: 3px 8px; cursor: pointer; font-family: inherit; font-size: 11px; }

  .listview { display: flex; flex-direction: column; flex: 1; overflow: hidden; }
  .body { flex: 1; overflow-y: auto; }
  .row-btn {
    display: block; width: 100%; background: transparent; border: 0;
    padding: 0; text-align: left; cursor: pointer; color: inherit; font: inherit;
  }
  .row-btn + .row-btn { border-top: 1px solid rgba(255, 255, 255, 0.025); }
  .row-btn:hover { background: var(--bg-row-hover); }
  .row-btn.selected { background: var(--accent-bg); }
  .row-btn.drop-over { box-shadow: inset 0 2px 0 var(--accent); }
  /* Columns come from `gridTemplate` inline: whether BPM is present depends on
     what this playlist's tracks actually carry. */
  .cols, .row {
    display: grid;
    gap: 12px;
    align-items: center;
  }
  .cols {
    padding: 6px 14px;
    color: var(--text-subtle);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .cols .right { text-align: right; }
  .row { padding: 6px 14px; }
  .thumb {
    width: 52px; height: 52px; border-radius: 3px;
    background: var(--bg-raised); border: 1px solid var(--border);
    position: relative; overflow: hidden; cursor: grab; flex-shrink: 0;
  }
  .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .play-badge {
    position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    background: rgba(0, 0, 0, 0.45); color: var(--accent); font-size: 11px;
  }
  .cell { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .title { color: var(--text); font-weight: 500; font-size: 13px; }
  .title.dim { color: var(--text-muted); }
  .artist { color: var(--text-muted); font-size: 12px; }
  .release { color: var(--text-muted); font-size: 12px; }
  .cell.link { cursor: pointer; }
  .cell.link:hover { color: var(--text); text-decoration: underline; }
  .row-btn.playing .title { color: var(--accent); }
  .bpm { color: var(--text-muted); font-variant-numeric: tabular-nums; font-family: var(--font-mono); font-size: 11.5px; text-align: right; }
  .dur { color: var(--text-subtle); font-variant-numeric: tabular-nums; font-family: var(--font-mono); font-size: 11.5px; text-align: right; }
  .missing { opacity: 0.45; border-top: 1px solid rgba(255, 255, 255, 0.025); }
  .missing .remove { background: none; border: 0; cursor: pointer; }
  .missing-tag { margin-left: 8px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--warn); }
  .remove { color: transparent; text-align: center; cursor: pointer; font-size: 14px; user-select: none; }

  .grip {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    /* 44px is the touch-target floor; the grid cell stays 28px wide and the
       extra height is absorbed by the row, so desktop density is unchanged. */
    min-width: 28px;
    min-height: 44px;
    cursor: grab;
    color: var(--text-dim);
    /* Load-bearing: without this the browser claims the gesture for scrolling
       and no pointermove ever reaches the drag handler. */
    touch-action: none;
    user-select: none;
  }
  .grip:hover { color: var(--text); }
  .grip:active { cursor: grabbing; }
  .row-btn:hover .remove { color: var(--text-subtle); }
  .remove:hover { color: var(--danger) !important; }

</style>
