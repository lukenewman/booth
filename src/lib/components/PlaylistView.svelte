<script lang="ts">
  import { playlists } from '$lib/stores/playlists.svelte';
  import { player } from '$lib/stores/player.svelte';
  import { translucentDragImage } from '$lib/dnd';
  import EmptyState from './EmptyState.svelte';
  import PlaylistCover from './PlaylistCover.svelte';

  let {
    selectedId = null,
    onTrackSelect,
    onDeleted,
  }: {
    selectedId?: string | null;
    onTrackSelect?: (id: string) => void;
    onDeleted?: () => void;
  } = $props();

  const open = $derived(playlists.openPlaylist);

  let renaming = $state(false);
  let nameDraft = $state('');
  let confirmingDelete = $state(false);
  let dragId = $state<string | null>(null);
  let overId = $state<string | null>(null);
  let confirmPanel = $state<HTMLDivElement>();

  // Focus the confirm modal when it opens so Enter/Esc work immediately.
  $effect(() => {
    if (playlists.pendingRemove) confirmPanel?.focus();
  });

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

  function onDrop(e: DragEvent, targetId: string) {
    e.preventDefault();
    overId = null;
    const moved = e.dataTransfer?.getData('application/x-booth-track') || dragId;
    dragId = null;
    if (!open || !moved || moved === targetId) return;
    const ids = open.tracks.map((t) => t.id);
    if (!ids.includes(moved)) return; // dragged in from elsewhere — ignore (add happens via rail)
    const without = ids.filter((id) => id !== moved);
    const at = without.indexOf(targetId);
    without.splice(at, 0, moved);
    playlists.reorder(open.id, without);
  }
</script>

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
      <span class="meta">{open.tracks.length} {open.tracks.length === 1 ? 'track' : 'tracks'}</span>
      <div class="header-actions">
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
    <div class="body">
      {#if open.tracks.length === 0}
        <EmptyState title="No tracks yet" detail="Drag tracks here, or press a on a track to add it." />
      {:else}
        {#each open.tracks as t (t.id)}
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
            ondragover={(e) => { e.preventDefault(); overId = t.id; }}
            ondragleave={() => { if (overId === t.id) overId = null; }}
            ondrop={(e) => onDrop(e, t.id)}
            onclick={(e) => { if (e.detail > 0) e.stopPropagation(); else onTrackSelect?.(t.id); }}
            ondblclick={() => { if (t.canPlay) player.play({ trackId: t.id, title: t.title, artist: t.artist, thumbUrl: t.thumb_url }); }}
          >
            <span class="row">
              <span class="thumb" class:playing={isPlaying}>
                {#if t.thumb_url}<img src={t.thumb_url} alt="" loading="lazy" />{/if}
                {#if isPlaying}<span class="play-badge">▶</span>{/if}
              </span>
              <span class="meta-cell">
                <span class="title" class:dim={!t.canPlay}>{t.title}</span>
                <span class="artist">{t.artist}</span>
              </span>
              <span class="dur">{formatDuration(t.duration_ms)}</span>
              <span
                class="remove"
                role="button"
                tabindex="-1"
                aria-label="Remove {t.title}"
                onclick={(e) => { e.stopPropagation(); if (open) playlists.requestRemove(open.id, t.id, t.title); }}
                onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); if (open) playlists.requestRemove(open.id, t.id, t.title); } }}
                ondblclick={(e) => e.stopPropagation()}
              >×</span>
            </span>
          </button>
        {/each}
      {/if}
    </div>
  </div>

  {#if playlists.pendingRemove}
    {@const pr = playlists.pendingRemove}
    <div class="backdrop" onclick={() => playlists.cancelRemove()} role="presentation">
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="confirm-modal"
        bind:this={confirmPanel}
        tabindex={-1}
        role="dialog"
        aria-modal="true"
        onclick={(e) => e.stopPropagation()}
        onkeydown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') { e.preventDefault(); playlists.cancelRemove(); }
          else if (e.key === 'Enter') { e.preventDefault(); playlists.confirmRemove(); }
        }}
      >
        <div class="modal-title">Remove from playlist?</div>
        <div class="modal-body">
          <span class="track-name">{pr.trackTitle}</span>
          <span class="from">from {open.name}</span>
        </div>
        <div class="modal-actions">
          <button class="ghost" onclick={() => playlists.cancelRemove()}>Cancel</button>
          <button class="danger" onclick={() => playlists.confirmRemove()}>Remove</button>
        </div>
      </div>
    </div>
  {/if}
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
  .link {
    background: transparent;
    border: 0;
    color: var(--text-subtle);
    font-family: inherit;
    font-size: 11px;
    cursor: pointer;
    padding: 0;
    text-decoration: underline;
  }
  .link:hover { color: var(--text-muted); }
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
  .row {
    display: grid;
    grid-template-columns: 28px 1fr 60px 20px;
    gap: 12px; padding: 6px 14px; align-items: center;
  }
  .thumb {
    width: 28px; height: 28px; border-radius: 3px;
    background: var(--bg-raised); border: 1px solid var(--border);
    position: relative; overflow: hidden; cursor: grab; flex-shrink: 0;
  }
  .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .play-badge {
    position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    background: rgba(0, 0, 0, 0.45); color: var(--accent); font-size: 11px;
  }
  .meta-cell { min-width: 0; }
  .title { color: var(--text); font-weight: 500; font-size: 13px; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .title.dim { color: var(--text-muted); }
  .artist { color: var(--text-muted); font-size: 12px; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row-btn.playing .title { color: var(--accent); }
  .dur { color: var(--text-subtle); font-variant-numeric: tabular-nums; font-family: var(--font-mono); font-size: 11.5px; text-align: right; }
  .remove { color: transparent; text-align: center; cursor: pointer; font-size: 14px; user-select: none; }
  .row-btn:hover .remove { color: var(--text-subtle); }
  .remove:hover { color: var(--danger) !important; }

  .backdrop {
    position: fixed; inset: 0; background: rgba(0, 0, 0, 0.6);
    display: flex; align-items: center; justify-content: center; padding: 24px; z-index: 160;
  }
  .confirm-modal {
    background: var(--bg-raised); border: 1px solid var(--border-strong);
    border-radius: var(--radius); padding: 18px 20px; min-width: 300px; max-width: 380px;
    outline: none;
  }
  .modal-title { font-size: 14px; font-weight: 600; color: var(--text); margin-bottom: 10px; }
  .modal-body { font-size: 13px; color: var(--text-muted); margin-bottom: 18px; line-height: 1.5; }
  .modal-body .track-name { color: var(--text); font-weight: 500; }
  .modal-body .from { color: var(--text-subtle); }
  .modal-actions { display: flex; justify-content: flex-end; gap: 8px; }
  .modal-actions button {
    border-radius: 4px; padding: 6px 14px; font-family: inherit; font-size: 12px; cursor: pointer;
  }
  .modal-actions .ghost {
    background: transparent; border: 1px solid var(--border-strong); color: var(--text-muted);
  }
  .modal-actions .ghost:hover { border-color: var(--text-muted); color: var(--text); }
  .modal-actions .danger { background: var(--danger); border: 1px solid var(--danger); color: #fff; }
  .modal-actions .danger:hover { filter: brightness(1.1); }
</style>
