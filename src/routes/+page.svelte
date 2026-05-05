<script lang="ts">
  import SearchBar from '$lib/components/SearchBar.svelte';
  import ResultsList from '$lib/components/ResultsList.svelte';
  import ConfirmModal from '$lib/components/ConfirmModal.svelte';
  import SessionLog from '$lib/components/SessionLog.svelte';
  import ShortcutOverlay from '$lib/components/ShortcutOverlay.svelte';
  import Scanner from '$lib/components/Scanner.svelte';
  import { installKeyboard } from '$lib/keyboard.svelte';
  import { onMount, tick } from 'svelte';
  import { page } from '$app/state';
  import { mode } from '$lib/stores/mode.svelte';
  import { session } from '$lib/stores/session.svelte';
  import { toast } from '$lib/stores/toast.svelte';
  import { collection } from '$lib/stores/collection.svelte';
  import type { DiscogsRelease, AddResponse, ApiError } from '$lib/types';

  let query = $state(page.url.searchParams.get('q') ?? '');
  let results = $state<DiscogsRelease[]>([]);
  let highlightedIndex = $state(0);
  let loading = $state(false);
  let pending = $state<DiscogsRelease | null>(null);
  let submitting = $state(false);
  let modalError = $state<string | null>(null);
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let shortcutsOpen = $state(false);
  let searchBar: { focus: () => void } | undefined = $state();
  let tokenStatus = $state<'checking' | 'ok' | 'missing' | 'invalid'>('checking');

  $effect(() => {
    const q = query.trim();
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      if (q) url.searchParams.set('q', q);
      else url.searchParams.delete('q');
      history.replaceState(null, '', url);
    }
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
      if (!res.ok) {
        if (data?.error === 'rate_limited') {
          toast.show(`Rate limited. Try again in ${data.retryAfter ?? 60}s.`, { kind: 'error' });
        } else {
          toast.show(data?.message ?? 'Search failed', { kind: 'error' });
        }
        return;
      }
      results = data.results ?? [];
      highlightedIndex = 0;
    } catch (e) {
      toast.show(e instanceof Error ? e.message : 'Network error', {
        kind: 'error',
        action: { label: 'retry', onClick: () => runSearch(q) },
      });
    } finally {
      loading = false;
    }
  }

  function handleBarcode(code: string) {
    query = code;
    mode.setSearch();
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
      collection.markAdded(ok.releaseId);
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

  function selectHighlighted() {
    const r = results[highlightedIndex];
    if (r) handleSelect(r);
  }

  function highlightUp() {
    if (results.length === 0) return;
    highlightedIndex = (highlightedIndex - 1 + results.length) % results.length;
  }

  function highlightDown() {
    if (results.length === 0) return;
    highlightedIndex = (highlightedIndex + 1) % results.length;
  }

  onMount(async () => {
    const probe = await fetch('/api/discogs/search?q=test');
    const probeData = await probe.json().catch(() => ({}));
    if (probeData?.error === 'no_token') tokenStatus = 'missing';
    else if (probeData?.error === 'invalid_token') tokenStatus = 'invalid';
    else {
      tokenStatus = 'ok';
      collection.load();
      await tick();
      searchBar?.focus();
    }

    return installKeyboard(
      {
        focusSearch: () => searchBar?.focus(),
        highlightUp,
        highlightDown,
        selectHighlighted,
        confirmModal: () => confirmAdd(),
        cancelModal: () => cancelAdd(),
        undoLast,
        toggleShortcuts: () => (shortcutsOpen = !shortcutsOpen),
      },
      { modalOpen: () => pending !== null },
    );
  });

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
      collection.markRemoved(last.releaseId);
      toast.show(`Undone: ${last.artist} — ${last.title}`);
    } catch (e) {
      toast.show(e instanceof Error ? e.message : 'Network error', {
        kind: 'error',
        action: { label: 'retry', onClick: () => undoLast() },
      });
    }
  }
</script>

{#if tokenStatus === 'checking'}
  <div class="app"><div class="loading">Loading…</div></div>
{:else if tokenStatus === 'missing' || tokenStatus === 'invalid'}
  <div class="app">
    <header><span class="logo">booth</span></header>
    <div class="setup">
      <h2>{tokenStatus === 'missing' ? 'Setup needed' : 'Token rejected'}</h2>
      <p>
        {#if tokenStatus === 'missing'}
          The <code>DISCOGS_TOKEN</code> environment variable isn't set.
        {:else}
          Your Discogs token was rejected (401). It may be expired or mistyped.
        {/if}
      </p>
      <ol>
        <li>Get a personal access token at <code>discogs.com/settings/developers</code>.</li>
        <li>Add it to <code>.env</code> as <code>DISCOGS_TOKEN=&lt;token&gt;</code>.</li>
        <li>Restart <code>pnpm dev</code>.</li>
      </ol>
    </div>
  </div>
{:else}
  <div class="app">
    <header>
      <span class="logo">booth</span>
      <button type="button" class="hint" onclick={() => (shortcutsOpen = true)}>
        <span class="kbd">?</span> shortcuts
      </button>
    </header>

    {#if mode.current === 'search'}
      <SearchBar bind:this={searchBar} bind:value={query} onScan={() => mode.setScanner()} />

      {#if loading}
        <div class="loading">Searching…</div>
      {:else if query.trim() || results.length > 0}
        <ResultsList {results} {highlightedIndex} onSelect={handleSelect} />
        {#if query.trim()}
          <a
            class="open-discogs"
            href={`https://www.discogs.com/search/?q=${encodeURIComponent(query.trim())}&type=all`}
            target="_blank"
            rel="noopener noreferrer"
          >Open this search in Discogs ↗</a>
        {/if}
      {/if}
    {:else}
      <Scanner onDecode={handleBarcode} onError={() => {}} />
      <div class="exit-hint"><span class="kbd">esc</span> to exit scanner</div>
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

  <ShortcutOverlay open={shortcutsOpen} onClose={() => (shortcutsOpen = false)} />
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
  .hint {
    background: transparent;
    border: none;
    color: var(--text-muted);
    font-size: 12px;
    padding: 0;
  }
  .exit-hint {
    text-align: center;
    color: var(--text-muted);
    font-size: 12px;
  }
  .open-discogs {
    display: inline-block;
    margin-top: 8px;
    padding: 4px 0;
    font-size: 12px;
    color: var(--text-muted);
    text-decoration: none;
  }
  .open-discogs:hover {
    color: var(--accent);
    text-decoration: underline;
  }
  .setup {
    margin-top: 24px;
    background: var(--bg-raised);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    padding: 20px;
  }
  .setup h2 {
    font-size: 16px;
    margin: 0 0 8px;
  }
  .setup p {
    color: var(--text-muted);
    margin: 0 0 12px;
  }
  .setup code {
    background: var(--bg);
    padding: 1px 5px;
    border-radius: 3px;
    font-family: var(--font-mono);
    font-size: 12px;
  }
  .setup ol {
    margin: 0;
    padding-left: 20px;
    color: var(--text-muted);
    font-size: 13px;
  }
  .setup li {
    margin-bottom: 4px;
  }
</style>
