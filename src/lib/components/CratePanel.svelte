<script lang="ts">
  import { playlists } from '$lib/stores/playlists.svelte';
  import { toast } from '$lib/stores/toast.svelte';

  let { onOpenRelease }: { onOpenRelease: (releaseId: string) => void } = $props();

  const open = $derived(playlists.openPlaylist);
  let confirming = $state<string | null>(null);
  let q = $state('');
  let results = $state<{ id: string; title: string; artist: string; year: number | null; thumb_url: string | null }[]>([]);
  let timer: ReturnType<typeof setTimeout> | undefined;

  function search() {
    clearTimeout(timer);
    const term = q.trim();
    if (!term) { results = []; return; }
    timer = setTimeout(async () => {
      const res = await fetch(`/api/library/releases?q=${encodeURIComponent(term)}&limit=8`);
      if (res.ok && q.trim() === term) results = (await res.json()).items ?? [];
    }, 200);
  }

  async function add(r: { id: string; title: string }) {
    if (!open) return;
    const { added } = await playlists.addRelease(open.id, r.id);
    toast.show(added ? `Crated ${r.title}` : 'Already in the crate');
    q = '';
    results = [];
  }

  async function remove(entryId: string, sketched: number) {
    if (!open) return;
    if (sketched > 0 && confirming !== entryId) { confirming = entryId; return; }
    confirming = null;
    await playlists.removeCrateEntry(open.id, entryId);
  }
</script>

{#if open}
  <div class="crate-panel">
    <div class="crate-head">
      <span class="label">Crate</span>
      <span class="count">{open.crate.length}</span>
    </div>
    <div class="crate-search">
      <input
        placeholder="＋ add record…"
        bind:value={q}
        oninput={search}
        onkeydown={(e) => { e.stopPropagation(); if (e.key === 'Escape') { q = ''; results = []; } if (e.key === 'Enter' && results[0]) add(results[0]); }}
      />
      {#if results.length}
        <div class="results">
          {#each results as r (r.id)}
            <button class="result" onclick={() => add(r)}>
              {#if r.thumb_url}<img src={r.thumb_url} alt="" />{/if}
              <span>{r.artist} — {r.title}{r.year ? ` (${r.year})` : ''}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
    <div class="crate-list">
      {#if open.crate.length === 0}
        <div class="empty">No records yet. Search above, drag a release onto this gig in the rail, or press <kbd>c</kbd> on a release.</div>
      {/if}
      {#each open.crate as c (c.entryId)}
        <div class="crate-row" class:missing={!c.releaseId} data-entry-id={c.entryId}>
          <button class="crate-main" disabled={!c.releaseId} onclick={() => c.releaseId && onOpenRelease(c.releaseId)}>
            {#if c.thumbUrl}<img src={c.thumbUrl} alt="" loading="lazy" />{:else}<span class="sleeve"></span>{/if}
            <span class="crate-text">
              <span class="crate-title">{c.title}</span>
              <span class="crate-artist">{c.artist}{c.year ? ` · ${c.year}` : ''}{!c.releaseId ? ' · missing' : ''}</span>
            </span>
            <span class="crate-count" title={c.sketchedCount ? `${c.sketchedCount} sketched` : 'bringing it, no ideas yet'}>
              {c.sketchedCount || '—'}
            </span>
          </button>
          {#if confirming === c.entryId}
            <span class="confirm">
              Remove and its {c.sketchedCount} sketched track{c.sketchedCount === 1 ? '' : 's'}?
              <button class="danger" onclick={() => remove(c.entryId, c.sketchedCount)}>Remove</button>
              <button class="ghost" onclick={() => (confirming = null)}>Cancel</button>
            </span>
          {:else}
            <button class="x" aria-label="Remove {c.title} from the crate" onclick={() => remove(c.entryId, c.sketchedCount)}>×</button>
          {/if}
        </div>
      {/each}
    </div>
  </div>
{/if}

<style>
  .crate-panel { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .crate-head { display: flex; justify-content: space-between; padding: 14px 14px 8px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-subtle); }
  .crate-search { position: relative; padding: 0 14px 10px; }
  .crate-search input { width: 100%; }
  .results { position: absolute; left: 14px; right: 14px; z-index: 5; background: var(--bg-raised); border: 1px solid var(--border); border-radius: 4px; }
  .result { display: flex; gap: 8px; align-items: center; width: 100%; padding: 6px 8px; background: none; border: 0; color: inherit; text-align: left; cursor: pointer; }
  .result:hover { background: var(--bg-row-hover); }
  .result img { width: 28px; height: 28px; object-fit: cover; }
  .crate-list { overflow-y: auto; flex: 1; }
  .crate-row { display: flex; align-items: center; border-top: 1px solid var(--border); }
  .crate-row.missing { opacity: 0.45; }
  .crate-main { flex: 1; display: grid; grid-template-columns: 40px minmax(0, 1fr) 28px; gap: 10px; align-items: center; padding: 8px 14px; background: none; border: 0; color: inherit; text-align: left; cursor: pointer; }
  .crate-main:hover:not(:disabled) { background: var(--bg-row-hover); }
  .crate-main img, .sleeve { width: 40px; height: 40px; object-fit: cover; border-radius: 2px; background: var(--bg-raised); }
  .crate-text { display: flex; flex-direction: column; min-width: 0; }
  .crate-title, .crate-artist { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .crate-artist { color: var(--text-subtle); font-size: 12px; }
  .crate-count { text-align: right; color: var(--text-subtle); font-variant-numeric: tabular-nums; }
  .x { background: none; border: 0; color: var(--text-subtle); padding: 0 12px; cursor: pointer; }
  .x:hover { color: var(--danger); }
  .confirm { font-size: 12px; padding-right: 10px; display: flex; gap: 6px; align-items: center; }
  .empty { padding: 14px; color: var(--text-subtle); font-size: 13px; }
  .danger { background: var(--danger); border: 0; color: #fff; border-radius: 3px; padding: 3px 8px; cursor: pointer; font-family: inherit; font-size: 11px; }
  .ghost { background: transparent; border: 1px solid var(--border-strong); color: var(--text-muted); border-radius: 3px; padding: 3px 8px; cursor: pointer; font-family: inherit; font-size: 11px; }
</style>
