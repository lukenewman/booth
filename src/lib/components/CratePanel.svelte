<script lang="ts">
  import { playlists } from '$lib/stores/playlists.svelte';
  import { toast } from '$lib/stores/toast.svelte';
  import SourceGrid from './SourceGrid.svelte';

  let { onOpenRelease }: { onOpenRelease: (releaseId: string) => void } = $props();

  const open = $derived(playlists.openPlaylist);
  let confirming = $state<string | null>(null);
  let q = $state('');
  let results = $state<{ id: string; title: string; artist: string; year: number | null; thumb_url: string | null; sources: string[] }[]>([]);
  // The highlighted result. Focus stays in the input; Tab / arrows move this
  // and Enter crates it, so records can go in one after another from the keyboard.
  let active = $state(0);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const vinylOnly = $derived(open?.vinylOnly ?? false);

  function search() {
    clearTimeout(timer);
    const term = q.trim();
    if (!term) { results = []; return; }
    const vinyl = vinylOnly;
    timer = setTimeout(async () => {
      const res = await fetch(`/api/library/releases?q=${encodeURIComponent(term)}&limit=8${vinyl ? '&vinyl=1' : ''}`);
      if (res.ok && q.trim() === term && vinylOnly === vinyl) {
        results = (await res.json()).items ?? [];
        active = 0;
      }
    }, 200);
  }

  async function toggleVinyl() {
    if (!open) return;
    await playlists.setVinylOnly(open.id, !vinylOnly);
    search();
  }

  async function add(r: { id: string; title: string }) {
    if (!open) return;
    const { added } = await playlists.addRelease(open.id, r.id);
    toast.show(added ? `Crated ${r.title}` : 'Already in the crate', { kind: added ? 'success' : 'info' });
    q = '';
    results = [];
  }

  function onKey(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.key === 'Escape') { q = ''; results = []; return; }
    if (e.key === 'Enter') { if (results[active]) add(results[active]); return; }
    if (!results.length) return;
    const back = e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey);
    if (back || e.key === 'ArrowDown' || e.key === 'Tab') {
      e.preventDefault();
      active = (active + (back ? -1 : 1) + results.length) % results.length;
    }
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
      <button class="vinyl" class:on={vinylOnly} aria-pressed={vinylOnly} onclick={toggleVinyl}
        title={vinylOnly ? 'Search offers vinyl only — click to include digital' : 'Search offers everything — click for vinyl only'}>
        Vinyl only
      </button>
      <span class="count">{open.crate.length}</span>
    </div>
    <div class="crate-search">
      <input
        placeholder={vinylOnly ? '＋ add record (vinyl)…' : '＋ add record…'}
        bind:value={q}
        oninput={search}
        onkeydown={onKey}
        role="combobox"
        aria-expanded={results.length > 0}
        aria-controls="crate-results"
        aria-activedescendant={results[active] ? `crate-result-${active}` : undefined}
      />
      {#if results.length}
        <div class="results" id="crate-results" role="listbox">
          {#each results as r, i (r.id)}
            <button class="result" class:active={i === active} id="crate-result-{i}" role="option" aria-selected={i === active}
              tabindex="-1" onmouseenter={() => (active = i)} onclick={() => add(r)}>
              {#if r.thumb_url}<img src={r.thumb_url} alt="" />{:else}<span class="sleeve small"></span>{/if}
              <span class="result-text">{r.artist} — {r.title}{r.year ? ` (${r.year})` : ''}</span>
              <SourceGrid present={r.sources} />
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
  .crate-head { display: flex; align-items: center; gap: 8px; padding: 14px 14px 8px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-subtle); }
  .crate-head .label { flex: 1; }
  .vinyl { background: transparent; border: 1px solid var(--border-strong); color: var(--text-subtle); border-radius: 3px; padding: 2px 7px; cursor: pointer; font-family: inherit; font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; }
  .vinyl:hover { color: var(--text-muted); }
  .vinyl.on { color: var(--accent); border-color: var(--accent-border); }
  .crate-search { position: relative; padding: 0 14px 10px; }
  /* Matches the library search bar, so it reads as part of the dark UI. */
  .crate-search input {
    width: 100%;
    background: var(--bg-input);
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    padding: 5px 9px;
    color: var(--text);
    font-family: inherit;
    font-size: 13px;
    outline: none;
  }
  .crate-search input:focus { border-color: var(--accent-border); }
  .crate-search input::placeholder { color: var(--text-subtle); }
  .results { position: absolute; left: 14px; right: 14px; z-index: 5; background: var(--bg-raised); border: 1px solid var(--border); border-radius: 4px; }
  .result { display: flex; gap: 8px; align-items: center; width: 100%; padding: 6px 8px; background: none; border: 0; color: inherit; text-align: left; cursor: pointer; }
  .result { border-left: 3px solid transparent; }
  .result.active { background: var(--accent-bg); border-left-color: var(--accent); color: var(--text); }
  .result:not(.active) .result-text { color: var(--text-muted); }
  .result img, .sleeve.small { width: 28px; height: 28px; object-fit: cover; flex: none; }
  .result-text { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
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
