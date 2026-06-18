<script lang="ts">
  import { page } from '$app/state';
  import { onMount, untrack } from 'svelte';
  import Rail from './Rail.svelte';
  import ListviewToolbar from './ListviewToolbar.svelte';
  import ReleaseList from './ReleaseList.svelte';
  import ReleaseGrid from './ReleaseGrid.svelte';
  import TrackList from './TrackList.svelte';
  import ArtistList from './ArtistList.svelte';
  import ReleaseDetail from './ReleaseDetail.svelte';
  import TrackDetail from './TrackDetail.svelte';
  import ArtistDetail from './ArtistDetail.svelte';
  import EmptyState from './EmptyState.svelte';
  import Scanner from './Scanner.svelte';
  import SessionLog from './SessionLog.svelte';
  import SyncRunHistory from './SyncRunHistory.svelte';
  import { explorerState } from '$lib/stores/explorerState.svelte';
  import { collection } from '$lib/stores/collection.svelte';
  import { playlists } from '$lib/stores/playlists.svelte';
  import PlaylistView from './PlaylistView.svelte';
  import Player from './Player.svelte';
  import PlayerBar from './PlayerBar.svelte';
  import RecordSession from './RecordSession.svelte';
import RecordingPill from './RecordingPill.svelte';

  // ----- Source meta + counts ------------------------------------------------

  interface SourceWithState {
    id: string;
    name: string;
    contributes: ('track' | 'release' | 'artist')[];
    isStub: boolean;
    count: number;
    lastSyncedAt: string | null;
    lastSummary: unknown;
  }

  let sources = $state<SourceWithState[]>([]);
  let counts = $state({
    allReleases: 0,
    allTracks: 0,
    allArtists: 0,
  });
  let syncing = $state<string | null>(null); // source id being synced

  async function loadSourcesAndCounts() {
    const [srcRes, allRel, allTrk, allArt] = await Promise.all([
      fetch('/api/sources').then((r) => r.json()),
      fetch('/api/library/releases?limit=1').then((r) => r.json()),
      fetch('/api/library/tracks?limit=1').then((r) => r.json()),
      fetch('/api/library/artists?limit=1').then((r) => r.json()),
    ]);
    sources = srcRes;
    counts = {
      allReleases: allRel.total ?? 0,
      allTracks: allTrk.total ?? 0,
      allArtists: allArt.total ?? 0,
    };
  }

  // ----- Listview data -------------------------------------------------------

  let listItems = $state<any[]>([]);
  let listTotal = $state(0);
  let listHasMore = $state(false);
  // Non-reactive: read+written by loadList from inside the load-list $effect,
  // which would trip Svelte's effect_update_depth_exceeded if it were $state.
  let listLoading = false;
  // Incremented on every reset load. Lets an in-flight request detect that a
  // newer one has started and discard its stale result instead of overwriting.
  let loadGen = 0;

  // Add → Discogs uses the Discogs search API; everything else uses library endpoints.
  async function loadList(reset: boolean) {
    // Pagination loads (reset=false) still guard against concurrency.
    // Reset loads always proceed — they capture the current generation so any
    // in-flight load from a previous entity/nav state is silently discarded.
    if (!reset && listLoading) return;
    // Playlist view owns its own data (PlaylistView reads playlists.openPlaylist);
    // never fire library fetches for the playlist section.
    if (explorerState.nav.section === 'playlist') return;
    const gen = reset ? ++loadGen : loadGen;
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
          format: r.format ?? null,
          thumbUrl: r.thumb ?? null,
          coverUrl: r.coverImage ?? null,
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

      const endpoint =
        currentEntity === 'tracks' ? '/api/library/tracks'
        : currentEntity === 'artists' ? '/api/library/artists'
        : '/api/library/releases';

      if (explorerState.nav.section === 'sources') {
        params.set('source', explorerState.nav.item);
      }

      // Release-only sources (e.g. Discogs) in tracks-mode: short-circuit to an
      // empty list — the explicit empty-state below explains "no tracks
      // indexed for this source" rather than pretending we hit the server.
      if (
        currentEntity === 'tracks'
        && explorerState.nav.section === 'sources'
        && selectedSource
        && !selectedSource.contributes.includes('track')
      ) {
        listItems = [];
        listTotal = 0;
        listHasMore = false;
        return;
      }

      const res = await fetch(`${endpoint}?${params.toString()}`).then((r) => r.json());
      // Discard result if a newer reset load has started since we began fetching.
      if (gen !== loadGen) return;
      let items = res.items ?? [];
      if (currentEntity === 'releases') {
        items = items.map((it: any) => ({
          ...it,
          thumbUrl: it.thumb_url ?? null,
          coverUrl: it.cover_url ?? null,
        }));
      }
      listItems = reset ? items : [...listItems, ...items];
      listTotal = res.total ?? listItems.length;
      listHasMore = !!res.hasMore;
    } finally {
      if (gen === loadGen) listLoading = false;
    }
  }

  // ----- Detail data ---------------------------------------------------------

  let detailKind = $state<'release' | 'track' | 'artist' | null>(null);
  let detailData = $state<any>(null);

  // Playlist view has no track-detail pane, but clicking an artist/release link
  // opens a dedicated detail on the right (reusing ReleaseDetail/ArtistDetail).
  let plDetail = $state<{ kind: 'artist' | 'release'; data: any } | null>(null);

  async function openPlaylistEntity(kind: 'artist' | 'release', id: string) {
    const url =
      kind === 'artist'
        ? `/api/library/artists/${encodeURIComponent(id)}`
        : `/api/library/releases/${encodeURIComponent(id)}`;
    const res = await fetch(url);
    if (res.ok) plDetail = { kind, data: await res.json() };
  }
  let recordingRelease = $state<{ id: string; title: string; artist: string } | null>(null);
  // While a session is open it can be minimized to a floating pill so the user
  // can keep browsing; the recorder store keeps capturing regardless.
  let recordingMinimized = $state(false);

  async function loadDetail() {
    if (!explorerState.id) {
      detailKind = null;
      detailData = null;
      return;
    }

    // Playlist view has no detail pane — selecting a row only highlights it,
    // so skip the (now-invisible) detail fetch entirely.
    if (explorerState.nav.section === 'playlist') {
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
          release: {
            id: hit.id, title: hit.title, artist: hit.artist, year: hit.year,
            cover_url: hit.coverUrl ?? null,
            country: hit.country ?? null,
            label: hit.label ?? null,
            catno: hit.catno ?? null,
            format: hit.format ?? null,
          },
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

        // Background fetch: enrich with format text (vinyl color etc.), pressing
        // notes, and the barcode/identifier list from the full release endpoint,
        // none of which the search API includes.
        const selectedId = hit.id;
        fetch(`/api/discogs/releases/${hit.id}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => {
            if (!d) return;
            // Guard: only update if the user hasn't moved to a different result.
            if (explorerState.id !== selectedId || !detailData?.release) return;
            detailData = {
              ...detailData,
              release: {
                ...detailData.release,
                format: d.formatText
                  ? detailData.release.format
                    ? `${detailData.release.format}, ${d.formatText}`
                    : d.formatText
                  : detailData.release.format,
              },
              notes: d.notes ?? null,
              identifiers: d.identifiers ?? [],
            };
          })
          .catch(() => {});
      }
      return;
    }

    // Probe the endpoint matching the active lens first so we don't pay an
    // extra round-trip in the common case; on 404 fall back to the others
    // (handles cases where detail kind doesn't match the lens, e.g. when an
    // ?id= URL is loaded against a later lens flip).
    const endpoints = orderedDetailEndpoints(currentEntity, explorerState.id);
    for (const { kind, url } of endpoints) {
      const res = await fetch(url);
      if (res.ok) {
        detailKind = kind;
        detailData = await res.json();
        return;
      }
    }
    detailKind = null;
    detailData = null;
  }

  function orderedDetailEndpoints(
    lens: 'releases' | 'tracks' | 'artists',
    id: string,
  ): Array<{ kind: 'release' | 'track' | 'artist'; url: string }> {
    const enc = encodeURIComponent(id);
    const all = [
      { kind: 'release' as const, url: `/api/library/releases/${enc}` },
      { kind: 'track'   as const, url: `/api/library/tracks/${enc}` },
      { kind: 'artist'  as const, url: `/api/library/artists/${enc}` },
    ];
    const preferred =
      lens === 'tracks'  ? 'track'   :
      lens === 'artists' ? 'artist'  : 'release';
    return [...all.filter((e) => e.kind === preferred), ...all.filter((e) => e.kind !== preferred)];
  }

  // ----- Computed ------------------------------------------------------------

  const selectedSource = $derived(
    explorerState.nav.section === 'sources'
      ? sources.find((s) => s.id === explorerState.nav.item) ?? null
      : null,
  );

  // The toggle is an app-wide lens, so the URL/store value is authoritative
  // everywhere — the only divergence is in render fallback below, when a
  // release-only source happens to be selected in tracks-mode (we still
  // *show* tracks-mode in the toolbar; the listview reports empty).
  const currentEntity = $derived<'releases' | 'tracks' | 'artists'>(explorerState.entity);

  const isAddView = $derived(explorerState.nav.section === 'add');
  const isSourcesView = $derived(explorerState.nav.section === 'sources');
  const isPlaylistView = $derived(explorerState.nav.section === 'playlist');

  // The toggle is suppressed only for rail items where tracks aren't a
  // meaningful concept at all — currently just Add → Discogs (the Discogs
  // search API returns releases only). Stub sources still show the toggle
  // (greys out the EmptyState below, not the chip).
  const showEntityToggle = $derived(!isAddView);

  /**
   * When a tracks-mode listview lands on a source that doesn't contribute
   * tracks (e.g. a future release-only adapter), render an explicit empty
   * state instead of pretending the list is empty for ordinary reasons.
   */
  const showReleaseOnlySourceEmpty = $derived(
    currentEntity === 'tracks'
      && isSourcesView
      && selectedSource !== null
      && !selectedSource.isStub
      && !selectedSource.contributes.includes('track'),
  );

  const toolbarPlaceholder = $derived(
    isAddView ? 'Search Discogs…' : 'Search library…',
  );

  const discogsSearchUrl = $derived.by(() => {
    if (!isAddView) return null;
    const q = explorerState.q.trim();
    if (!q) return null;
    return `https://www.discogs.com/search?q=${encodeURIComponent(q)}&type=all`;
  });

  const toolbarMeta = $derived.by(() => {
    if (isAddView) {
      const q = explorerState.q.trim();
      if (!q) return '';
      return `${listTotal} result${listTotal === 1 ? '' : 's'}`;
    }
    const noun =
      currentEntity === 'tracks'  ? 'tracks'
      : currentEntity === 'artists' ? 'artists'
      : 'releases';
    return `${listTotal.toLocaleString()} ${noun}`;
  });

  // ----- Reactive triggers ---------------------------------------------------

  // Reload list when nav or entity changes. Query changes are handled by the
  // debounced onQueryChange callback below — reading explorerState.q here would
  // fire a fetch on every keystroke, bypassing the SearchBar debounce entirely.
  $effect(() => {
    explorerState.nav.section;
    explorerState.nav.item;
    currentEntity;
    if (sources.length === 0) return; // wait until source meta is loaded
    untrack(() => loadList(true));
  });

  // Reload detail when id changes.
  $effect(() => {
    explorerState.id;
    loadDetail();
  });

  // Load the open playlist when a playlist rail item is selected (or switched).
  $effect(() => {
    if (explorerState.nav.section !== 'playlist') return;
    const id = explorerState.nav.item;
    untrack(() => playlists.loadPlaylist(id));
  });

  // Close the playlist link-detail when the rail selection changes.
  $effect(() => {
    explorerState.nav.section;
    explorerState.nav.item;
    untrack(() => { plDetail = null; });
  });

  // ----- URL sync ------------------------------------------------------------

  $effect(() => {
    // Read every reactive field into locals so Svelte's tracker captures each
    // signal directly. Calling explorerState.serialize() inside a method call
    // and using an intermediate $derived both have subtle tracking gaps in
    // Svelte 5 with class-state singletons — reading primitives into locals is
    // the most reliable pattern.
    const navSection = explorerState.nav.section;
    const navItem = explorerState.nav.item;
    const id = explorerState.id;
    const q = explorerState.q;
    const entity = explorerState.entity;
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams();
    if (`${navSection}:${navItem}` !== 'library:all') params.set('nav', `${navSection}:${navItem}`);
    if (id) params.set('id', id);
    if (q) params.set('q', q);
    if (entity !== 'releases') params.set('entity', entity);
    const search = params.toString() ? `?${params.toString()}` : '';
    history.replaceState(history.state, '', `${location.pathname}${search}`);
  });

  // ----- Mount ---------------------------------------------------------------

  onMount(async () => {
    explorerState.hydrate(page.url.searchParams);
    await Promise.all([loadSourcesAndCounts(), collection.load(), playlists.loadList()]);
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
          thumbUrl: hit.thumbUrl,
          coverUrl: hit.coverUrl,
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

  // Bumped after each manual sync so SyncRunHistory refetches.
  let syncRunsReloadKey = $state(0);

  async function handleSync() {
    if (!selectedSource || selectedSource.isStub || syncing) return;
    syncing = selectedSource.id;
    try {
      await fetch(`/api/sources/${selectedSource.id}/sync`, { method: 'POST' });
      await loadSourcesAndCounts();
      await loadList(true);
      syncRunsReloadKey++;
    } finally {
      syncing = null;
    }
  }

  // ----- Scanner popover -----------------------------------------------------

  let scannerOpen = $state(false);
  let releaseView = $state<'list' | 'grid'>('list');

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

<Player />

<div class="shell">
  <div class="explorer" class:no-detail={isPlaylistView && !plDetail}>
  <Rail
    nav={explorerState.nav}
    entity={currentEntity}
    {sources}
    {counts}
    playlists={playlists.items}
    onSelect={(nav) => explorerState.setNav(nav)}
    onCreatePlaylist={async (name) => {
      const created = await playlists.create(name);
      if (created) explorerState.setNav({ section: 'playlist', item: created.id });
    }}
    onAddTrackToPlaylist={async (playlistId, trackId) => {
      const { added } = await playlists.addTrack(playlistId, trackId);
      const name = playlists.items.find((p) => p.id === playlistId)?.name ?? 'playlist';
      toast.show(added ? `Added to ${name}` : 'Already in playlist');
    }}
  />

  <section class="middle">
    {#if isPlaylistView}
      <PlaylistView
        selectedId={explorerState.id}
        onTrackSelect={(id) => explorerState.setEntity(id)}
        onArtistSelect={(id) => openPlaylistEntity('artist', id)}
        onReleaseSelect={(id) => openPlaylistEntity('release', id)}
        onDeleted={() => explorerState.setNav({ section: 'library', item: 'all' })}
      />
    {:else}
    <ListviewToolbar
      bind:query={explorerState.q}
      placeholder={toolbarPlaceholder}
      onQueryChange={() => { if (sources.length) loadList(true); }}
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
      externalSearchUrl={discogsSearchUrl}
      showViewToggle={!isAddView && currentEntity === 'releases'}
      view={releaseView}
      onViewChange={(v) => (releaseView = v)}
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
        detail="See the Booth Linear backlog for status. The source registry knows about this adapter; sync support hasn't been built yet."
      />
    {:else if showReleaseOnlySourceEmpty}
      <EmptyState
        title="No tracks indexed for {selectedSource?.name ?? 'this source'}"
        detail="This source only contributes releases. Switch the toolbar toggle back to Releases (or press Tab) to see them."
      />
    {:else if currentEntity === 'releases'}
      {#if releaseView === 'grid'}
        <ReleaseGrid
          items={listItems}
          total={listTotal}
          hasMore={listHasMore}
          selectedId={explorerState.id}
          onSelect={(id) => explorerState.setEntity(id)}
          loadMore={() => loadList(false)}
          emptyTitle={isAddView && !explorerState.q ? 'Search Discogs to add records' : 'No releases'}
        />
      {:else}
        <ReleaseList
          items={listItems}
          total={listTotal}
          hasMore={listHasMore}
          selectedId={explorerState.id}
          onSelect={(id) => explorerState.setEntity(id)}
          loadMore={() => loadList(false)}
          emptyTitle={isAddView && !explorerState.q ? 'Search Discogs to add records' : 'No releases'}
        />
      {/if}
    {:else if currentEntity === 'tracks'}
      <TrackList
        items={listItems}
        total={listTotal}
        hasMore={listHasMore}
        selectedId={explorerState.id}
        onSelect={(id) => explorerState.setEntity(id)}
        loadMore={() => loadList(false)}
      />
    {:else}
      <ArtistList
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
    {/if}
  </section>

  {#if isPlaylistView}
    {#if plDetail}
      <section class="right">
        <button class="pl-detail-close" onclick={() => (plDetail = null)}>← Close detail</button>
        {#if plDetail.kind === 'release'}
          <ReleaseDetail
            release={plDetail.data.release}
            sources={plDetail.data.sources}
            facets={plDetail.data.facets}
            tracks={plDetail.data.tracks ?? []}
            sourceMeta={sourceMetaForDetail}
            onArtistSelect={(id) => openPlaylistEntity('artist', id)}
          />
        {:else}
          <ArtistDetail
            artist={plDetail.data.artist}
            sources={plDetail.data.sources}
            facets={plDetail.data.facets}
            releases={plDetail.data.releases}
            trackCount={plDetail.data.trackCount}
            sourceMeta={sourceMetaForDetail}
            onReleaseSelect={(id) => openPlaylistEntity('release', id)}
          />
        {/if}
      </section>
    {/if}
  {:else}
  <section class="right">
    {#if !explorerState.id && isSourcesView && selectedSource}
      <SyncRunHistory
        sourceId={selectedSource.id}
        sourceName={selectedSource.name}
        isStub={selectedSource.isStub}
        syncing={syncing === selectedSource.id}
        reloadKey={syncRunsReloadKey}
      />
    {:else if !explorerState.id}
      <EmptyState title={
        currentEntity === 'tracks'  ? 'Select a track to see details'
        : currentEntity === 'artists' ? 'Select an artist to see details'
        : 'Select a release to see details'
      } />
    {:else if detailKind === 'release' && detailData}
      <ReleaseDetail
        release={detailData.release}
        sources={detailData.sources}
        facets={detailData.facets}
        tracks={detailData.tracks ?? []}
        sourceMeta={sourceMetaForDetail}
        notes={detailData.notes ?? null}
        identifiers={detailData.identifiers ?? []}
        addCta={releaseDetailCta}
        onTrackSelect={(id) => explorerState.setEntity(id)}
        onArtistSelect={(id) => explorerState.setEntity(id)}
        recordDisabled={recordingRelease !== null}
        onRecord={detailData._isDiscogsSearchHit
          ? undefined
          : () => {
              recordingMinimized = false;
              recordingRelease = {
                id: detailData.release.id,
                title: detailData.release.title,
                artist: detailData.release.artist,
              };
            }}
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
    {:else if detailKind === 'artist' && detailData}
      <ArtistDetail
        artist={detailData.artist}
        sources={detailData.sources}
        facets={detailData.facets}
        releases={detailData.releases}
        trackCount={detailData.trackCount}
        sourceMeta={sourceMetaForDetail}
        onReleaseSelect={(id) => explorerState.setEntity(id)}
      />
    {:else}
      <EmptyState title="Loading…" />
    {/if}
  </section>
  {/if}
  </div>
  <PlayerBar />
</div>

{#if recordingRelease && !recordingMinimized}
  <RecordSession
    releaseId={recordingRelease.id}
    releaseTitle={recordingRelease.title}
    releaseArtist={recordingRelease.artist}
    onClose={() => {
      recordingRelease = null;
      recordingMinimized = false;
    }}
    onMinimize={() => (recordingMinimized = true)}
  />
{:else if recordingRelease && recordingMinimized}
  <RecordingPill
    release={{ title: recordingRelease.title, artist: recordingRelease.artist }}
    onExpand={() => (recordingMinimized = false)}
  />
{/if}

<style>
  .shell {
    display: flex;
    flex-direction: column;
    height: 100vh;
  }
  .explorer {
    display: grid;
    grid-template-columns: 220px 1fr 360px;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
  /* Playlist view has no detail pane — let the track list fill the width. */
  .explorer.no-detail { grid-template-columns: 220px 1fr; }
  .explorer.no-detail .middle { border-right: none; }
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
  .pl-detail-close {
    display: block;
    width: 100%;
    text-align: left;
    background: var(--bg-raised);
    border: 0;
    border-bottom: 1px solid var(--border);
    color: var(--text-muted);
    font-family: inherit;
    font-size: 12px;
    padding: 8px 14px;
    cursor: pointer;
  }
  .pl-detail-close:hover { color: var(--text); }
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
