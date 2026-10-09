<script lang="ts">
  import { playlists, type PlaylistSection, type PlaylistEntry } from '$lib/stores/playlists.svelte';
  import { player } from '$lib/stores/player.svelte';
  import { toast } from '$lib/stores/toast.svelte';
  import type { PlaybackContext } from '$lib/queue';
  import { formatBpm } from '$lib/bpm';
  import { translucentDragImage } from '$lib/dnd';
  import { summarize, formatRunTime, formatTarget, parseLength } from '$lib/gig';
  import StarButton from './StarButton.svelte';
  import TrackNote from './TrackNote.svelte';
  import RemoveConfirm from './RemoveConfirm.svelte';
  import EmptyState from './EmptyState.svelte';

  let {
    selectedId = null,
    onTrackSelect,
    onArtistSelect,
    onReleaseSelect,
    onDeleted,
    compact = false,
  }: {
    selectedId?: string | null;
    onTrackSelect?: (id: string) => void;
    onArtistSelect?: (id: string) => void;
    onReleaseSelect?: (id: string) => void;
    onDeleted?: () => void;
    compact?: boolean;
  } = $props();

  const ENTRY = 'application/x-booth-entry';
  const TRACK = 'application/x-booth-track';
  const SECTION = 'application/x-booth-section';

  const open = $derived(playlists.openPlaylist);
  const total = $derived(summarize(open?.tracks ?? []));

  // Playback queues the whole sketch in section order; missing and
  // unplayable tracks are skipped, as the playlist queue always has.
  const playable = $derived((open?.tracks ?? []).filter((t) => t.canPlay));
  const ctx = $derived({ kind: 'playlist', playlistId: open?.id ?? '', ids: playable.map((t) => t.id) } as PlaybackContext);
  const seed = $derived(playable.map((t) => ({ trackId: t.id, title: t.title, artist: t.artist, thumbUrl: t.thumb_url, releaseId: t.release_id })));

  let collapsed = $state<Set<string>>(new Set());
  let renamingSection = $state<string | null>(null);
  let sectionDraft = $state('');
  let addingSection = $state(false);
  let newSection = $state('');
  let editingTarget = $state(false);
  let targetDraft = $state('');
  let renaming = $state(false);
  let nameDraft = $state('');
  let confirmingDelete = $state(false);
  let overSection = $state<string | null>(null);
  let overEntry = $state<string | null>(null);

  function toggle(id: string) {
    const next = new Set(collapsed);
    next.has(id) ? next.delete(id) : next.add(id);
    collapsed = next;
  }

  function sectionTracks(s: PlaylistSection) {
    return s.entries.flatMap((e) => (e.track ? [e.track] : []));
  }

  async function commitNewSection() {
    const name = newSection.trim();
    addingSection = false;
    newSection = '';
    if (open && name) await playlists.addSection(open.id, name);
  }

  async function commitSectionRename(id: string) {
    const name = sectionDraft.trim();
    renamingSection = null;
    if (open && name) await playlists.renameSection(open.id, id, name);
  }

  async function commitTarget() {
    editingTarget = false;
    if (!open) return;
    if (!targetDraft.trim()) return playlists.setTarget(open.id, null);
    const m = parseLength(targetDraft);
    if (m == null) toast.show('Length not understood — try 3:00 or 180');
    else await playlists.setTarget(open.id, m);
  }

  function onRowDragStart(e: DragEvent, entry: PlaylistEntry) {
    if (!e.dataTransfer) return;
    e.dataTransfer.setData(ENTRY, entry.entryId);
    if (entry.track) e.dataTransfer.setData(TRACK, entry.track.id);
    e.dataTransfer.effectAllowed = 'move';
    if (e.currentTarget instanceof HTMLElement) translucentDragImage(e, e.currentTarget);
  }

  /** Drop on a band (append) or on a row in it (take that row's slot). */
  async function onDrop(e: DragEvent, section: PlaylistSection, index: number) {
    e.preventDefault();
    e.stopPropagation();
    overSection = null;
    overEntry = null;
    const dt = e.dataTransfer;
    if (!open || !dt) return;
    const draggedSection = dt.getData(SECTION);
    if (draggedSection) {
      if (draggedSection === section.id || section.isUnsorted) return;
      const ids = open.sections.filter((s) => !s.isUnsorted && s.id !== draggedSection).map((s) => s.id);
      ids.splice(ids.indexOf(section.id), 0, draggedSection);
      return playlists.reorderSections(open.id, ids);
    }
    const entryId = dt.getData(ENTRY);
    if (entryId) return playlists.moveEntry(open.id, entryId, section.id, index);
    const trackId = dt.getData(TRACK);
    if (trackId) {
      const { moved, added } = await playlists.placeTrack(open.id, trackId, section.id);
      if (added) toast.show(`Added to ${section.name}`);
      else if (moved) toast.show(`Moved to ${section.name}`);
    }
  }

  function allowDrop(e: DragEvent, sectionId: string, entryId: string | null = null) {
    e.preventDefault();
    overSection = sectionId;
    overEntry = entryId;
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
</script>

{#if !open}
  <EmptyState title="Loading…" />
{:else}
  <div class="gig-view" class:compact>
    <header class="gig-head">
      {#if renaming}
        <!-- svelte-ignore a11y_autofocus -->
        <input class="name-input" bind:value={nameDraft} autofocus
          onkeydown={(e) => { e.stopPropagation(); if (e.key === 'Enter') { if (nameDraft.trim()) playlists.rename(open.id, nameDraft.trim()); renaming = false; } if (e.key === 'Escape') renaming = false; }}
          onblur={() => { if (nameDraft.trim()) playlists.rename(open.id, nameDraft.trim()); renaming = false; }} />
      {:else}
        <button class="name" onclick={() => { nameDraft = open.name; renaming = true; }}>{open.name}</button>
      {/if}
      <span class="meta">
        {#if editingTarget}
          <!-- svelte-ignore a11y_autofocus -->
          <input class="target-input" bind:value={targetDraft} placeholder="3:00" autofocus
            onkeydown={(e) => { e.stopPropagation(); if (e.key === 'Enter') commitTarget(); if (e.key === 'Escape') editingTarget = false; }}
            onblur={commitTarget} />
        {:else}
          <button class="link" onclick={() => { targetDraft = open.targetMinutes ? formatTarget(open.targetMinutes) : ''; editingTarget = true; }}>
            {open.targetMinutes ? `target ${formatTarget(open.targetMinutes)}` : 'set length'}
          </button>
        {/if}
        <span class="sep">·</span>sketched {formatRunTime(total.ms, total.partial)}
        <span class="sep">·</span>{open.crate.length} {open.crate.length === 1 ? 'record' : 'records'}
      </span>
      <span class="actions">
        {#if confirmingDelete}
          Delete gig? <button class="danger" onclick={confirmDelete}>Delete</button>
          <button class="ghost" onclick={() => (confirmingDelete = false)}>Cancel</button>
        {:else}
          <button class="del" title="Delete gig" onclick={() => (confirmingDelete = true)}>🗑</button>
        {/if}
      </span>
    </header>

    <!-- `body` is what the global ↑/↓ handler scopes row navigation to. -->
    <div class="sketch body">
      {#each open.sections as s (s.id)}
        {@const sum = summarize(sectionTracks(s))}
        <section
          role="list"
          aria-label={s.name}
          class="band"
          class:drop-over={overSection === s.id && !overEntry}
          data-section-id={s.id}
          ondragover={(e) => allowDrop(e, s.id)}
          ondragleave={() => { if (overSection === s.id) overSection = null; }}
          ondrop={(e) => onDrop(e, s, s.entries.length)}
        >
          <div
            role="group"
            class="band-head"
            draggable={!s.isUnsorted && !compact}
            ondragstart={(e) => { e.dataTransfer?.setData(SECTION, s.id); }}
          >
            <button class="caret" aria-label="Collapse {s.name}" onclick={() => toggle(s.id)}>{collapsed.has(s.id) ? '▸' : '▾'}</button>
            {#if renamingSection === s.id}
              <!-- svelte-ignore a11y_autofocus -->
              <input class="band-input" bind:value={sectionDraft} autofocus
                onkeydown={(e) => { e.stopPropagation(); if (e.key === 'Enter') commitSectionRename(s.id); if (e.key === 'Escape') renamingSection = null; }}
                onblur={() => commitSectionRename(s.id)} />
            {:else if s.isUnsorted}
              <span class="band-name">Unsorted</span>
            {:else}
              <button class="band-name" onclick={() => { sectionDraft = s.name; renamingSection = s.id; }}>{s.name}</button>
            {/if}
            <span class="band-summary">
              {sum.count} · {formatRunTime(sum.ms, sum.partial)}{#if sum.bpmMin != null}{' · '}{sum.bpmMin === sum.bpmMax ? sum.bpmMin : `${sum.bpmMin}–${sum.bpmMax}`} bpm{/if}
            </span>
            {#if !s.isUnsorted}
              <button class="band-del" title="Delete section — its tracks move to Unsorted" onclick={() => playlists.deleteSection(open.id, s.id)}>×</button>
            {/if}
          </div>

          {#if !collapsed.has(s.id)}
            {#if s.entries.length === 0}
              <div class="band-empty">{s.isUnsorted ? 'Tracks you add land here.' : 'Drag tracks here.'}</div>
            {/if}
            {#each s.entries as entry, i (entry.entryId)}
              {#if entry.track}
                {@const t = entry.track}
                <button
                  type="button"
                  class="row-btn gig-row"
                  class:selected={t.id === selectedId}
                  class:playing={player.nowPlaying?.trackId === t.id}
                  class:drop-over={overEntry === entry.entryId}
                  data-id={t.id}
                  data-entry-id={entry.entryId}
                  draggable={!compact}
                  ondragstart={(e) => onRowDragStart(e, entry)}
                  ondragover={(e) => { e.stopPropagation(); allowDrop(e, s.id, entry.entryId); }}
                  ondrop={(e) => onDrop(e, s, i)}
                  onclick={(e) => { if (e.detail === 0) onTrackSelect?.(t.id); }}
                  ondblclick={() => { if (t.canPlay) player.playFrom(ctx, t.id, { trackId: t.id, title: t.title, artist: t.artist, thumbUrl: t.thumb_url, releaseId: t.release_id, bpm: t.bpm ?? null }, seed); }}
                >
                  <span class="thumb">{#if t.thumb_url}<img src={t.thumb_url} alt="" loading="lazy" />{/if}</span>
                  <span class="cell title" class:dim={!t.canPlay}>{t.title}<TrackNote trackId={t.id} readonly /></span>
                  <span class="cell artist link" role="link" tabindex="-1"
                    onclick={(e) => { e.stopPropagation(); onArtistSelect?.(t.artist_id); }}
                    onkeydown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onArtistSelect?.(t.artist_id); } }}>{t.artist}</span>
                  {#if !compact}
                    <span class="cell release link" role="link" tabindex="-1"
                      onclick={(e) => { e.stopPropagation(); if (t.release_id) onReleaseSelect?.(t.release_id); }}
                      onkeydown={(e) => { if (e.key === 'Enter' && t.release_id) { e.stopPropagation(); onReleaseSelect?.(t.release_id); } }}>{t.album ?? '—'}{t.position ? ` · ${t.position}` : ''}</span>
                  {/if}
                  <span class="bpm">{t.bpm ? formatBpm(t.bpm.value) : ''}</span>
                  <span class="dur">{formatDuration(t.duration_ms)}</span>
                  <StarButton trackId={t.id} />
                  <span class="remove" role="button" tabindex="-1" aria-label="Remove {t.title}"
                    onclick={(e) => { e.stopPropagation(); playlists.requestRemove(open.id, t.id, t.title); }}
                    onkeydown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); playlists.requestRemove(open.id, t.id, t.title); } }}>×</span>
                </button>
              {:else}
                <!-- Not a .row-btn on purpose: the global a / Delete keys act on
                     library track ids, which a missing entry no longer has. -->
                <div class="gig-row missing" data-entry-id={entry.entryId}
                  draggable={!compact}
                  ondragstart={(e) => onRowDragStart(e, entry)}
                  ondragover={(e) => { e.stopPropagation(); allowDrop(e, s.id, entry.entryId); }}
                  ondrop={(e) => onDrop(e, s, i)}
                  role="listitem">
                  <span class="thumb"></span>
                  <span class="cell title">{entry.snapshot.title}<span class="missing-tag">missing</span></span>
                  <span class="cell artist">{entry.snapshot.artist}</span>
                  {#if !compact}<span class="cell release">{entry.snapshot.album ?? '—'}{entry.snapshot.position ? ` · ${entry.snapshot.position}` : ''}</span>{/if}
                  <span class="bpm"></span><span class="dur">—</span><span></span>
                  <button class="remove" aria-label="Remove {entry.snapshot.title}" onclick={() => playlists.removeEntry(open.id, entry.entryId)}>×</button>
                </div>
              {/if}
            {/each}
          {/if}
        </section>
      {/each}

      {#if addingSection}
        <!-- svelte-ignore a11y_autofocus -->
        <input class="band-input new" bind:value={newSection} placeholder="Section name — e.g. openers / ambient" autofocus
          onkeydown={(e) => { e.stopPropagation(); if (e.key === 'Enter') commitNewSection(); if (e.key === 'Escape') { addingSection = false; newSection = ''; } }}
          onblur={commitNewSection} />
      {:else}
        <button class="add-section" onclick={() => (addingSection = true)}>＋ section</button>
      {/if}
    </div>
  </div>
  <RemoveConfirm />
{/if}

<style>
  .gig-view { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .gig-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 14px; padding: 14px; border-bottom: 1px solid var(--border); }
  .name { font-size: 20px; font-weight: 600; background: none; border: 0; color: inherit; padding: 0; cursor: text; }
  .meta { color: var(--text-subtle); font-size: 13px; }
  .sep { margin: 0 6px; }
  .actions { margin-left: auto; font-size: 13px; }
  .meta .link { background: none; border: 0; color: inherit; padding: 0; cursor: pointer; font: inherit; text-decoration: underline dotted; }
  .target-input, .band-input {
    background: var(--bg-input);
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    padding: 5px 9px;
    color: var(--text);
    font-family: inherit;
    font-size: 13px;
    outline: none;
  }
  .target-input { width: 64px; padding: 2px 6px; font-size: 12px; }
  .band-input { padding: 2px 6px; font-size: 14px; font-weight: 600; }
  .band-input.new { font-weight: 400; font-size: 13px; padding: 5px 9px; }
  .target-input:focus, .band-input:focus { border-color: var(--accent-border); }
  .target-input::placeholder, .band-input::placeholder { color: var(--text-subtle); }
  .sketch { overflow-y: auto; flex: 1; padding-bottom: 40px; }
  .band { border-bottom: 1px solid var(--border); }
  .band.drop-over { outline: 1px solid var(--accent); outline-offset: -1px; }
  .band-head { display: flex; align-items: center; gap: 8px; padding: 10px 14px 6px; position: sticky; top: 0; background: var(--bg); z-index: 1; }
  .band-head[draggable='true'] { cursor: grab; }
  .caret, .band-del { background: none; border: 0; color: var(--text-subtle); cursor: pointer; padding: 0 4px; }
  .band-name { font-weight: 600; background: none; border: 0; color: inherit; padding: 0; cursor: text; font-size: 14px; }
  .band-summary { color: var(--text-subtle); font-size: 12px; font-variant-numeric: tabular-nums; }
  .band-del { margin-left: auto; }
  .band-empty { padding: 6px 14px 12px 38px; color: var(--text-subtle); font-size: 13px; }
  .gig-row { display: grid; grid-template-columns: 40px minmax(0, 2fr) minmax(0, 1.3fr) minmax(0, 1.5fr) 44px 48px 20px 24px; gap: 10px; align-items: center; width: 100%; padding: 4px 14px 4px 38px; background: none; border: 0; color: inherit; text-align: left; }
  .compact .gig-row { grid-template-columns: 36px minmax(0, 2fr) minmax(0, 1fr) 40px 44px 20px 24px; padding-left: 14px; }
  .gig-row:hover { background: var(--bg-row-hover); }
  .gig-row.selected { background: var(--accent-bg); }
  .gig-row.drop-over { box-shadow: inset 0 2px 0 var(--accent); }
  .gig-row.missing { opacity: 0.45; }
  .missing-tag { margin-left: 8px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--warn); }
  .thumb img, .thumb { width: 40px; height: 40px; object-fit: cover; border-radius: 2px; }
  .cell { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .cell.dim { color: var(--text-subtle); }
  .meta .link:hover, .cell.link:hover { color: var(--accent); cursor: pointer; }
  .bpm, .dur { text-align: right; color: var(--text-subtle); font-variant-numeric: tabular-nums; font-size: 12px; }
  .remove { color: var(--text-subtle); cursor: pointer; text-align: center; background: none; border: 0; }
  .add-section { margin: 12px 14px; background: none; border: 1px dashed var(--border); color: var(--text-subtle); padding: 6px 12px; border-radius: 4px; cursor: pointer; }
  .band-input.new { margin: 12px 14px; width: calc(100% - 28px); }
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
  .del { background: transparent; border: 0; color: var(--text-subtle); cursor: pointer; font-size: 13px; }
  .del:hover { color: var(--danger); }
  .danger { background: var(--danger); border: 0; color: #fff; border-radius: 3px; padding: 3px 8px; cursor: pointer; font-family: inherit; font-size: 11px; }
  .ghost { background: transparent; border: 1px solid var(--border-strong); color: var(--text-muted); border-radius: 3px; padding: 3px 8px; cursor: pointer; font-family: inherit; font-size: 11px; }
</style>
