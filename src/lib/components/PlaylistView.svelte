<script lang="ts">
  import { playlists } from '$lib/stores/playlists.svelte';
  import { player } from '$lib/stores/player.svelte';
  import EmptyState from './EmptyState.svelte';

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

  function onDragStart(e: DragEvent, trackId: string) {
    dragId = trackId;
    e.dataTransfer?.setData('application/x-booth-track', trackId);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
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
  <div class="pl-toolbar">
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
              <span class="info-icon" class:playing={isPlaying}>{isPlaying ? '▶' : '⠿'}</span>
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
                onclick={(e) => { e.stopPropagation(); if (open) playlists.removeTrack(open.id, t.id); }}
                onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); if (open) playlists.removeTrack(open.id, t.id); } }}
                ondblclick={(e) => e.stopPropagation()}
              >×</span>
            </span>
          </button>
        {/each}
      {/if}
    </div>
  </div>
{/if}

<style>
  .pl-toolbar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
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
    grid-template-columns: 20px 1fr 60px 20px;
    gap: 14px; padding: 7px 14px; align-items: center;
  }
  .info-icon { color: var(--text-subtle); font-size: 12px; text-align: center; cursor: grab; user-select: none; }
  .info-icon.playing { color: var(--accent); }
  .meta-cell { min-width: 0; }
  .title { color: var(--text); font-weight: 500; font-size: 13px; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .title.dim { color: var(--text-muted); }
  .artist { color: var(--text-muted); font-size: 12px; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row-btn.playing .title { color: var(--accent); }
  .dur { color: var(--text-subtle); font-variant-numeric: tabular-nums; font-family: var(--font-mono); font-size: 11.5px; text-align: right; }
  .remove { color: transparent; text-align: center; cursor: pointer; font-size: 14px; user-select: none; }
  .row-btn:hover .remove { color: var(--text-subtle); }
  .remove:hover { color: var(--danger) !important; }
</style>
