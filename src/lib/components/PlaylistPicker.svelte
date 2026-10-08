<script lang="ts">
  import { playlists } from '$lib/stores/playlists.svelte';
  import { toast } from '$lib/stores/toast.svelte';

  let {
    target,
    onClose,
  }: {
    /** A track goes into a playlist's sketch; a release goes into a gig's crate. */
    target: { kind: 'track' | 'release'; id: string };
    onClose: () => void;
  } = $props();

  async function put(playlistId: string, name: string): Promise<string> {
    if (target.kind === 'track') {
      const { added } = await playlists.addTrack(playlistId, target.id);
      return added ? `Added to ${name}` : 'Already in playlist';
    }
    const { added } = await playlists.addRelease(playlistId, target.id);
    return added ? `Crated in ${name}` : 'Already in the crate';
  }

  let filter = $state('');
  let highlight = $state(0);

  const matches = $derived(
    playlists.items.filter((p) => p.name.toLowerCase().includes(filter.trim().toLowerCase())),
  );
  // Row 0 is always the "create" row; playlist rows follow.
  const rowCount = $derived(matches.length + 1);

  async function addTo(playlistId: string, name: string) {
    toast.show(await put(playlistId, name));
    onClose();
  }

  async function createAndAdd() {
    const name = filter.trim() || (target.kind === 'track' ? 'New playlist' : 'New gig');
    const created = await playlists.create(name);
    if (created) toast.show(await put(created.id, created.name));
    onClose();
  }

  function choose(index: number) {
    if (index === 0) createAndAdd();
    else {
      const p = matches[index - 1];
      if (p) addTo(p.id, p.name);
    }
  }

  function onKey(e: KeyboardEvent) {
    e.stopPropagation(); // keep the global dispatcher out of the picker
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); highlight = (highlight + 1) % rowCount; }
    else if (e.key === 'ArrowUp') { e.preventDefault(); highlight = (highlight - 1 + rowCount) % rowCount; }
    else if (e.key === 'Enter') { e.preventDefault(); choose(highlight); }
  }
</script>

<div class="backdrop" onclick={onClose} role="presentation">
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="panel" onclick={(e) => e.stopPropagation()} onkeydown={onKey} role="dialog" aria-modal="true" tabindex={-1}>
    <div class="title">{target.kind === 'track' ? 'Add to playlist' : 'Add to gig crate'}</div>
    <!-- svelte-ignore a11y_autofocus -->
    <input
      class="filter"
      bind:value={filter}
      placeholder="Filter or name a new playlist…"
      autofocus
      oninput={() => (highlight = 0)}
    />
    <div class="rows">
      <button class="opt create" class:active={highlight === 0} onclick={() => choose(0)}>
        ＋ New {target.kind === 'track' ? 'playlist' : 'gig'}{filter.trim() ? ` “${filter.trim()}”` : '…'}
      </button>
      {#each matches as p, i (p.id)}
        <button class="opt" class:active={highlight === i + 1} onclick={() => choose(i + 1)}>
          <span>{p.name}</span>
          <span class="count">{p.trackCount}</span>
        </button>
      {/each}
    </div>
  </div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; padding: 24px; z-index: 150; }
  .panel { background: var(--bg-raised); border: 1px solid var(--border-strong); border-radius: var(--radius); padding: 14px; min-width: 320px; max-width: 420px; }
  .title { font-size: 12px; color: var(--text-subtle); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 10px; font-weight: 600; }
  .filter { width: 100%; background: var(--bg); border: 1px solid var(--border-strong); border-radius: 4px; padding: 6px 8px; color: var(--text); font-family: inherit; font-size: 13px; margin-bottom: 8px; }
  .rows { max-height: 260px; overflow-y: auto; display: flex; flex-direction: column; gap: 1px; }
  .opt { display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%; text-align: left; background: transparent; border: 0; padding: 7px 8px; color: var(--text); font-family: inherit; font-size: 13px; cursor: pointer; border-radius: 4px; }
  .opt:hover, .opt.active { background: var(--accent-bg); }
  .opt.create { color: var(--text-muted); }
  .opt .count { color: var(--text-subtle); font-size: 11px; font-variant-numeric: tabular-nums; }
</style>
