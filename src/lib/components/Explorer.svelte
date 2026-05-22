<script lang="ts">
  import { page } from '$app/state';
  import { replaceState } from '$app/navigation';
  import { onMount } from 'svelte';
  import Rail from './Rail.svelte';
  import ListviewToolbar from './ListviewToolbar.svelte';
  import ReleaseList from './ReleaseList.svelte';
  import TrackList from './TrackList.svelte';
  import ReleaseDetail from './ReleaseDetail.svelte';
  import TrackDetail from './TrackDetail.svelte';
  import EmptyState from './EmptyState.svelte';
  import Scanner from './Scanner.svelte';
  import SessionLog from './SessionLog.svelte';
  import { explorerState } from '$lib/stores/explorerState.svelte';
  import { collection } from '$lib/stores/collection.svelte';

  // ----- Source meta + counts ------------------------------------------------

  interface SourceWithState {
    id: string;
    name: string;
    contributes: ('track' | 'release')[];
    isStub: boolean;
    count: number;
    lastSyncedAt: string | null;
    lastSummary: unknown;
  }

  let sources = $state<SourceWithState[]>([]);
  let counts = $state({ allReleases: 0, allTracks: 0, inMultipleSources: 0 });
  let syncing = $state<string | null>(null); // source id being synced

  async function loadSourcesAndCounts() {
    const [srcRes, allRel, allTrk, multi] = await Promise.all([
      fetch('/api/sources').then((r) => r.json()),
      fetch('/api/library/releases?limit=1').then((r) => r.json()),
      fetch('/api/library/tracks?limit=1').then((r) => r.json()),
      fetch('/api/library/releases?multi_source=true&limit=1').then((r) => r.json()),
    ]);
    sources = srcRes;
    counts = {
      allReleases: allRel.total ?? 0,
      allTracks: allTrk.total ?? 0,
      inMultipleSources: multi.total ?? 0,
    };
  }

  // ----- Listview data -------------------------------------------------------

  let listItems = $state<any[]>([]);
  let listTotal = $state(0);
  let listHasMore = $state(false);
  // Non-reactive: read+written by loadList from inside the load-list $effect,
  // which would trip Svelte's effect_update_depth_exceeded if it were $state.
  let listLoading = false;

  // Add → Discogs uses the Discogs search API; everything else uses library endpoints.
  async function loadList(reset: boolean) {
    if (listLoading) return;
    listLoading = true;
    const offset = reset ? 0 : listItems.length;

    try {
      if (explorerState.nav.section === 'add' && explorerState.nav.item === 'discogs') {
        const q = explorerState.q.trim();
        if (!q) {
          listItems = [];
          listTotal = 0;
          listHasMore = false;
          return;
        }
        const res = await fetch(`/api/discogs/search?q=${encodeURIComponent(q)}`).then((r) => r.json());
        if (res?.error) {
          listItems = [];
          listTotal = 0;
          listHasMore = false;
          return;
        }
        // Map Discogs search results into the ReleaseItem shape, with an
        // empty-or-Discogs source-grid based on the in-collection set.
        // /api/discogs/search wraps results as `{results: [...]}` (Slice 1 shape).
        const mapped = (res?.results ?? []).map((r: any) => ({
          id: String(r.id),
          title: r.title,
          artist: r.artist,
          year: r.year ?? null,
          country: r.country ?? null,
          label: r.label ?? null,
          catno: r.catno ?? null,
          coverImage: r.thumb ?? null,
          sources: collection.has(Number(r.id)) ? ['discogs'] : [],
          _isDiscogsSearchHit: true,
        }));
        listItems = mapped;
        listTotal = mapped.length;
        listHasMore = false;
        return;
      }

      const params = new URLSearchParams();
      params.set('limit', '200');
      params.set('offset', String(offset));
      if (explorerState.q) params.set('q', explorerState.q);

      const isTracksView = currentEntity === 'tracks';
      let endpoint = isTracksView ? '/api/library/tracks' : '/api/library/releases';

      if (explorerState.nav.section === 'sources') {
        params.set('source', explorerState.nav.item);
      }
      if (explorerState.nav.section === 'library' && explorerState.nav.item === 'in-multiple-sources') {
        params.set('multi_source', 'true');
      }

      const res = await fetch(`${endpoint}?${params.toString()}`).then((r) => r.json());
      const items = res.items ?? [];
      listItems = reset ? items : [...listItems, ...items];
      listTotal = res.total ?? listItems.length;
      listHasMore = !!res.hasMore;
    } finally {
      listLoading = false;
    }
  }

  // ----- Detail data ---------------------------------------------------------

  let detailKind = $state<'release' | 'track' | null>(null);
  let detailData = $state<any>(null);

  async function loadDetail() {
    if (!explorerState.id) {
      detailKind = null;
      detailData = null;
      return;
    }

    if (explorerState.nav.section === 'add' && explorerState.nav.item === 'discogs') {
      // Detail comes from the in-memory search result, not a library fetch.
      const hit = listItems.find((it) => it.id === explorerState.id);
      if (hit) {
        detailKind = 'release';
        detailData = {
          release: { id: hit.id, title: hit.title, artist: hit.artist, year: hit.year },
          sources: hit.sources.includes('discogs')
            ? [{
                source: 'discogs',
                external_id: hit.id,
                external_url: `https://www.discogs.com/release/${hit.id}`,
                match_method: 'first_seen',
              }]
            : [],
          facets: [
            ...(hit.label ? [{ source: 'discogs', key: 'label', value: hit.label }] : []),
            ...(hit.catno ? [{ source: 'discogs', key: 'catno', value: hit.catno }] : []),
            ...(hit.country ? [{ source: 'discogs', key: 'country', value: hit.country }] : []),
          ],
          tracks: [],
          _isDiscogsSearchHit: true,
        };
      }
      return;
    }

    // Try release first; fall back to track if 404.
    const relRes = await fetch(`/api/library/releases/${encodeURIComponent(explorerState.id)}`);
    if (relRes.ok) {
      detailKind = 'release';
      detailData = await relRes.json();
      return;
    }
    const trkRes = await fetch(`/api/library/tracks/${encodeURIComponent(explorerState.id)}`);
    if (trkRes.ok) {
      detailKind = 'track';
      detailData = await trkRes.json();
      return;
    }
    detailKind = null;
    detailData = null;
  }

  // ----- Computed ------------------------------------------------------------

  const selectedSource = $derived(
    explorerState.nav.section === 'sources'
      ? sources.find((s) => s.id === explorerState.nav.item) ?? null
      : null,
  );

  const currentEntity = $derived.by<'releases' | 'tracks'>(() => {
    if (explorerState.entity) return explorerState.entity;
    if (explorerState.nav.section === 'library' && explorerState.nav.item === 'all-tracks') return 'tracks';
    if (selectedSource) {
      // Default to the source's primary entity type.
      if (selectedSource.contributes.includes('track') && !selectedSource.contributes.includes('release')) return 'tracks';
      if (selectedSource.contributes.includes('release') && !selectedSource.contributes.includes('track')) return 'releases';
      // Both: default to tracks (matches iTunes' primary unit).
      return 'tracks';
    }
    return 'releases';
  });

  const showEntityToggle = $derived(
    selectedSource !== null
      && selectedSource.contributes.includes('track')
      && selectedSource.contributes.includes('release'),
  );

  const isAddView = $derived(explorerState.nav.section === 'add');
  const isSourcesView = $derived(explorerState.nav.section === 'sources');

  const toolbarPlaceholder = $derived(
    isAddView ? 'Search Discogs…' : 'Search library…',
  );

  const toolbarMeta = $derived.by(() => {
    if (isAddView) {
      const q = explorerState.q.trim();
      if (!q) return '';
      return `${listTotal} result${listTotal === 1 ? '' : 's'}`;
    }
    const noun = currentEntity === 'tracks' ? 'tracks' : 'releases';
    return `${listTotal.toLocaleString()} ${noun}`;
  });

  // ----- Reactive triggers ---------------------------------------------------

  // Reload list when the view-defining inputs change.
  $effect(() => {
    explorerState.nav.section;
    explorerState.nav.item;
    explorerState.q;
    currentEntity;
    if (sources.length === 0) return; // wait until source meta is loaded
    loadList(true);
  });

  // Reload detail when id changes.
  $effect(() => {
    explorerState.id;
    loadDetail();
  });

  // ----- URL sync ------------------------------------------------------------

  function syncToUrl() {
    if (typeof window === 'undefined') return;
    const params = explorerState.serialize();
    const search = params.toString() ? `?${params.toString()}` : '';
    replaceState(`${location.pathname}${search}`, page.state);
  }

  $effect(() => {
    explorerState.nav.section;
    explorerState.nav.item;
    explorerState.id;
    explorerState.q;
    explorerState.entity;
    syncToUrl();
  });

  // ----- Mount ---------------------------------------------------------------

  onMount(async () => {
    explorerState.hydrate(page.url.searchParams);
    await Promise.all([loadSourcesAndCounts(), collection.load()]);
  });

  // ----- Add → Discogs CTA ---------------------------------------------------

  import { session } from '$lib/stores/session.svelte';
  import { toast } from '$lib/stores/toast.svelte';

  let addSubmitting = $state(false);
  async function handleAdd() {
    if (!detailData?._isDiscogsSearchHit) return;
    const hit = listItems.find((it) => it.id === explorerState.id);
    if (!hit) return;
    addSubmitting = true;
    try {
      const res = await fetch('/api/discogs/collection/add', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          releaseId: Number(hit.id),
          title: hit.title,
          artist: hit.artist,
          year: hit.year,
          country: hit.country,
          label: hit.label,
          catno: hit.catno,
          coverImage: hit.coverImage,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        session.add({
          releaseId: Number(hit.id),
          instanceId: data.instanceId,
          title: hit.title,
          artist: hit.artist,
          addedAt: Date.now(),
        });
        collection.markAdded(Number(hit.id));
        listItems = listItems.map((it) =>
          it.id === hit.id ? { ...it, sources: ['discogs'] } : it,
        );
        detailData = {
          ...detailData,
          sources: [
            {
              source: 'discogs',
              external_id: hit.id,
              external_url: `https://www.discogs.com/release/${hit.id}`,
              match_method: 'first_seen',
            },
          ],
        };
        toast.show('Added');
      } else {
        toast.show('Could not add. Try again.');
      }
    } finally {
      addSubmitting = false;
    }
  }

  async function handleUndo() {
    const last = session.last;
    if (!last) return;
    await removeFromDiscogs(last.releaseId, last.instanceId, 'Undone');
  }

  /**
   * Remove a release from the user's Discogs collection. Works whether the
   * release was added this session (we pass the known instance_id) or was
   * loaded from a prior sync (server falls back to the stored instanceIds
   * facet).
   */
  async function handleRemove(discogsReleaseId: number) {
    const last = session.last;
    const instanceId = last?.releaseId === discogsReleaseId ? last.instanceId : undefined;
    await removeFromDiscogs(discogsReleaseId, instanceId, 'Removed from Discogs collection');
  }

  async function removeFromDiscogs(
    discogsReleaseId: number,
    instanceIdHint: number | undefined,
    successToast: string,
  ) {
    try {
      const body: { releaseId: number; instanceId?: number } = { releaseId: discogsReleaseId };
      if (instanceIdHint != null) body.instanceId = instanceIdHint;
      const res = await fetch('/api/discogs/collection/remove', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        if (instanceIdHint != null) session.removeById(discogsReleaseId, instanceIdHint);
        collection.markRemoved(discogsReleaseId);
        // The affected row in listItems is whichever has the same id as the
        // currently-selected detail (works for both search-hit rows, where id
        // is the Discogs id, and library rows, where id is the local ULID).
        const selectedId = detailData?.release?.id;
        if (selectedId != null) {
          listItems = listItems.map((it) =>
            it.id === selectedId
              ? { ...it, sources: (it.sources as string[]).filter((s) => s !== 'discogs') }
              : it,
          );
        }
        if (detailData) {
          detailData = {
            ...detailData,
            sources: (detailData.sources as any[]).filter((s: any) => s.source !== 'discogs'),
          };
        }
        toast.show(successToast);
      } else {
        const err = await res.json().catch(() => ({}));
        toast.show((err && err.message) || 'Could not remove. Try again.');
      }
    } catch {
      toast.show('Could not remove. Network error.');
    }
  }

  // ----- Sync chip -----------------------------------------------------------

  async function handleSync() {
    if (!selectedSource || selectedSource.isStub || syncing) return;
    syncing = selectedSource.id;
    try {
      await fetch(`/api/sources/${selectedSource.id}/sync`, { method: 'POST' });
      await loadSourcesAndCounts();
      await loadList(true);
    } finally {
      syncing = null;
    }
  }

  // ----- Scanner popover -----------------------------------------------------

  let scannerOpen = $state(false);

  // ----- Source meta for detail panes ----------------------------------------

  const sourceMetaForDetail = $derived(
    sources.map((s) => ({ id: s.id, name: s.name, isStub: s.isStub })),
  );

  // ----- Detail-pane CTA (Add / Remove) --------------------------------------

  /**
   * Unified CTA payload for ReleaseDetail. Three states:
   *  - Already in Discogs collection → quiet "✓ In your Discogs collection — undo" row.
   *  - Add → Discogs search hit not yet owned → primary "+ Add to Discogs collection".
   *  - Otherwise → null.
   */
  const releaseDetailCta = $derived.by(() => {
    if (!detailData?.release) return null;
    const discogsLink = (detailData.sources ?? []).find((s: any) => s.source === 'discogs');
    if (discogsLink) {
      const discogsReleaseId = detailData._isDiscogsSearchHit
        ? Number(detailData.release.id)
        : Number(discogsLink.external_id);
      if (!Number.isFinite(discogsReleaseId)) return null;
      return {
        variant: 'quiet' as const,
        label: '✓ In your Discogs collection — undo',
        kbdHint: 'u',
        onClick: () => handleRemove(discogsReleaseId),
      };
    }
    if (isAddView && detailData._isDiscogsSearchHit) {
      return {
        variant: 'primary' as const,
        label: '+ Add to Discogs collection',
        kbdHint: '⏎',
        onClick: handleAdd,
      };
    }
    return null;
  });
</script>

<div class="explorer">
  <Rail
    nav={explorerState.nav}
    {sources}
    {counts}
    onSelect={(nav) => explorerState.setNav(nav)}
  />

  <section class="middle">
    <ListviewToolbar
      bind:query={explorerState.q}
      placeholder={toolbarPlaceholder}
      onQueryChange={() => { /* effect above triggers reload */ }}
      showScanner={isAddView}
      onScan={() => (scannerOpen = true)}
      showEntityToggle={showEntityToggle}
      entity={currentEntity}
      onEntityChange={(e) => explorerState.setEntityKind(e)}
      showSyncChip={isSourcesView}
      syncIsStub={selectedSource?.isStub ?? false}
      syncLastAt={selectedSource?.lastSyncedAt ?? null}
      syncing={syncing === selectedSource?.id}
      onSync={handleSync}
      meta={toolbarMeta}
    />

    {#if scannerOpen}
      <div class="scanner-overlay">
        <Scanner
          onDecode={(code) => {
            explorerState.setQuery(code);
            scannerOpen = false;
          }}
        />
        <button class="scanner-close" onclick={() => (scannerOpen = false)}>Close (Esc)</button>
      </div>
    {/if}

    {#if isSourcesView && selectedSource?.isStub}
      <EmptyState
        title="{selectedSource.name} not yet implemented"
        detail="See docs/BACKLOG.md for status. The source registry knows about this adapter; sync support hasn't been built yet."
      />
    {:else if currentEntity === 'releases'}
      <ReleaseList
        items={listItems}
        total={listTotal}
        hasMore={listHasMore}
        selectedId={explorerState.id}
        onSelect={(id) => explorerState.setEntity(id)}
        loadMore={() => loadList(false)}
        emptyTitle={isAddView && !explorerState.q ? 'Search Discogs to add records' : 'No releases'}
      />
    {:else}
      <TrackList
        items={listItems}
        total={listTotal}
        hasMore={listHasMore}
        selectedId={explorerState.id}
        onSelect={(id) => explorerState.setEntity(id)}
        loadMore={() => loadList(false)}
      />
    {/if}

    {#if isAddView}
      <SessionLog onUndo={handleUndo} />
    {/if}
  </section>

  <section class="right">
    {#if !explorerState.id}
      <EmptyState title="Select a release to see details" />
    {:else if detailKind === 'release' && detailData}
      <ReleaseDetail
        release={detailData.release}
        sources={detailData.sources}
        facets={detailData.facets}
        tracks={detailData.tracks ?? []}
        sourceMeta={sourceMetaForDetail}
        addCta={releaseDetailCta}
        onTrackSelect={(id) => explorerState.setEntity(id)}
      />
    {:else if detailKind === 'track' && detailData}
      <TrackDetail
        track={detailData.track}
        sources={detailData.sources}
        facets={detailData.facets}
        release={detailData.release}
        sourceMeta={sourceMetaForDetail}
        onReleaseSelect={(id) => explorerState.setEntity(id)}
      />
    {:else}
      <EmptyState title="Loading…" />
    {/if}
  </section>
</div>

<style>
  .explorer {
    display: grid;
    grid-template-columns: 220px 1fr 360px;
    height: 100vh;
    overflow: hidden;
  }
  .middle {
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border-right: 1px solid var(--border);
    position: relative;
  }
  .right {
    overflow-y: auto;
  }
  .scanner-overlay {
    position: absolute;
    top: 50px;
    left: 14px;
    right: 14px;
    background: var(--bg-raised);
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    padding: 12px;
    z-index: 10;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .scanner-close {
    align-self: flex-end;
    background: transparent;
    border: 1px solid var(--border-strong);
    color: var(--text-muted);
    border-radius: 4px;
    padding: 4px 9px;
    font-family: inherit;
    font-size: 11px;
    cursor: pointer;
  }
</style>
