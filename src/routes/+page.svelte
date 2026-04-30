<script lang="ts">
  import SearchBar from '$lib/components/SearchBar.svelte';
  import ResultsList from '$lib/components/ResultsList.svelte';
  import ConfirmModal from '$lib/components/ConfirmModal.svelte';
  import SessionLog from '$lib/components/SessionLog.svelte';
  import { mode } from '$lib/stores/mode.svelte';
  import { session } from '$lib/stores/session.svelte';
  import { toast } from '$lib/stores/toast.svelte';
  import type { DiscogsRelease, AddResponse, ApiError } from '$lib/types';

  let query = $state('');
  let results = $state<DiscogsRelease[]>([]);
  let highlightedIndex = $state(0);
  let loading = $state(false);
  let pending = $state<DiscogsRelease | null>(null);
  let submitting = $state(false);
  let modalError = $state<string | null>(null);
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  $effect(() => {
    const q = query.trim();
    clearTimeout(debounceTimer);
    if (!q) {
      results = [];
      return;
    }
    debounceTimer = setTimeout(() => runSearch(q), 250);
  });

  async function runSearch(q: string) {
    loading = true;
    try {
      const res = await fetch(`/api/discogs/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      results = data.results ?? [];
      highlightedIndex = 0;
    } finally {
      loading = false;
    }
  }

  function handleSelect(release: DiscogsRelease) {
    pending = release;
    modalError = null;
  }

  async function confirmAdd() {
    if (!pending) return;
    submitting = true;
    modalError = null;
    try {
      const res = await fetch('/api/discogs/collection/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ releaseId: pending.id }),
      });
      const data: AddResponse | ApiError = await res.json();
      if (!res.ok) {
        modalError = (data as ApiError).message ?? 'Add failed';
        return;
      }
      const ok = data as AddResponse;
      session.add({
        releaseId: ok.releaseId,
        instanceId: ok.instanceId,
        title: pending.title,
        artist: pending.artist,
        addedAt: Date.now(),
      });
      toast.show(`Added: ${pending.artist} — ${pending.title}`);
      pending = null;
    } catch (e) {
      modalError = e instanceof Error ? e.message : 'Network error';
    } finally {
      submitting = false;
    }
  }

  function cancelAdd() {
    if (submitting) return;
    pending = null;
    modalError = null;
  }

  async function undoLast() {
    const last = session.last;
    if (!last) return;
    try {
      const res = await fetch('/api/discogs/collection/remove', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ releaseId: last.releaseId, instanceId: last.instanceId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.show(data.message ?? 'Undo failed', {
          kind: 'error',
          action: { label: 'retry', onClick: () => undoLast() },
        });
        return;
      }
      session.removeById(last.releaseId, last.instanceId);
      toast.show(`Undone: ${last.artist} — ${last.title}`);
    } catch (e) {
      toast.show(e instanceof Error ? e.message : 'Network error', {
        kind: 'error',
        action: { label: 'retry', onClick: () => undoLast() },
      });
    }
  }
</script>

<div class="app">
  <header>
    <span class="logo">booth</span>
    <span class="hint"><span class="kbd">?</span> shortcuts</span>
  </header>

  {#if mode.current === 'search'}
    <SearchBar bind:value={query} onScan={() => mode.setScanner()} />

    {#if loading}
      <div class="loading">Searching…</div>
    {:else if query.trim()}
      <ResultsList {results} {highlightedIndex} onSelect={handleSelect} />
    {/if}
  {:else}
    <div class="placeholder">Scanner mode (coming soon)</div>
  {/if}
  <SessionLog onUndo={undoLast} />
</div>

{#if pending}
  <ConfirmModal
    release={pending}
    onConfirm={confirmAdd}
    onCancel={cancelAdd}
    {submitting}
    error={modalError}
  />
{/if}

<style>
  .app {
    max-width: 640px;
    margin: 0 auto;
    padding: 32px 20px;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16px;
    font-size: 12px;
    color: var(--text-muted);
  }
  .logo {
    color: var(--text);
    font-weight: 600;
    font-size: 14px;
  }
  .loading,
  .placeholder {
    padding: 20px;
    text-align: center;
    color: var(--text-muted);
    font-size: 13px;
  }
</style>
