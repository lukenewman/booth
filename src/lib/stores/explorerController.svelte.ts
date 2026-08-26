/**
 * The explorer's brains, lifted out of what used to be a 1011-line
 * Explorer.svelte so DesktopShell and MobileShell can be thin views over one
 * source of truth rather than two navigation modes tangled in one component.
 *
 * Call this once from a component's script: the $effect and onMount calls
 * inside attach to that component's lifecycle, so state dies with the view.
 *
 * Two reactivity landmines are preserved deliberately — see `listLoading` and
 * the URL-sync effect. Do not "tidy" either.
 */
  import { page } from '$app/state';
  import { onMount, untrack } from 'svelte';
  import { explorerState } from '$lib/stores/explorerState.svelte';
  import { collection } from '$lib/stores/collection.svelte';
  import { groupByMaster, type SearchHit } from '$lib/discogs/group';
  import { playlists } from '$lib/stores/playlists.svelte';
  import { session } from '$lib/stores/session.svelte';
  import { toast } from '$lib/stores/toast.svelte';
  import { annotations } from '$lib/stores/annotations.svelte';

export function createExplorerController() {


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
    starredTracks: 0,
    unvettedReleases: 0,
  });
  let syncing = $state<string | null>(null); // source id being synced

  async function loadSourcesAndCounts() {
    const [srcRes, allRel, allTrk, allArt, starTrk, unvetRel] = await Promise.all([
      fetch('/api/sources').then((r) => r.json()),
      fetch('/api/library/releases?limit=1').then((r) => r.json()),
      fetch('/api/library/tracks?limit=1').then((r) => r.json()),
      fetch('/api/library/artists?limit=1').then((r) => r.json()),
      fetch('/api/library/tracks?starred=1&limit=1').then((r) => r.json()),
      fetch('/api/library/releases?vetted=0&limit=1').then((r) => r.json()),
    ]);
    sources = srcRes;
    counts = {
      allReleases: allRel.total ?? 0,
      allTracks: allTrk.total ?? 0,
      allArtists: allArt.total ?? 0,
      starredTracks: starTrk.total ?? 0,
      unvettedReleases: unvetRel.total ?? 0,
    };
  }

  // ----- Listview data -------------------------------------------------------

  let listItems = $state<any[]>([]);
  let listTotal = $state(0);
  let listHasMore = $state(false);

  // Add → Discogs: raw search hits (with masterId) + which master is drilled
  // into. The displayed list is derived from these via groupByMaster, so it's
  // kept separate from `listItems` (which serves library/sources views).
  let searchHits = $state<SearchHit[]>([]);
  let drillMasterId = $state<number | null>(null);
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
        // A fresh search resets any master drill-down. The displayed list is
        // derived from `searchHits` (see `addItems` below), so we only store
        // the raw hits here. /api/discogs/search wraps results as {results:[…]}.
        drillMasterId = null;
        const q = explorerState.q.trim();
        if (!q) {
          searchHits = [];
          listHasMore = false;
          return;
        }
        const res = await fetch(`/api/discogs/search?q=${encodeURIComponent(q)}`).then((r) => r.json());
        searchHits = res?.error ? [] : ((res?.results ?? []) as SearchHit[]);
        listHasMore = false;
        return;
      }

      const params = new URLSearchParams();
      params.set('limit', '200');
      params.set('offset', String(offset));
      if (explorerState.q) params.set('q', explorerState.q);
      // Always explicit for releases/tracks rather than relying on the server's
      // own default, so the toolbar's selected chip and the rows can't disagree.
      // Artists have no date-added concept; the endpoint ignores it anyway.
      if (currentEntity !== 'artists') params.set('sort', explorerState.sort);

      const endpoint =
        currentEntity === 'tracks' ? '/api/library/tracks'
        : currentEntity === 'artists' ? '/api/library/artists'
        : '/api/library/releases';

      if (explorerState.nav.section === 'sources') {
        params.set('source', explorerState.nav.item);
      }

      if (explorerState.nav.section === 'library') {
        if (explorerState.nav.item === 'starred') params.set('starred', '1');
        else if (explorerState.nav.item === 'unvetted') params.set('vetted', '0');
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
      // Seed the annotation store from every page so stars and vetted checks
      // render on first paint rather than after a second round-trip.
      if (currentEntity === 'tracks') annotations.hydrateTracks(items);
      if (currentEntity === 'releases') annotations.hydrateReleases(items);

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

  /**
   * PlayerBar artwork click. Both surfaces already have a right-hand detail
   * pane, they just reach it differently: the playlist view keeps its own
   * `plDetail` (track rows there deliberately open no detail), everything else
   * goes through the normal `?id` selection. No-op when it is already open, so
   * clicking the art repeatedly does not refetch or steal focus.
   */
  function openReleaseFromPlayer(releaseId: string) {
    if (isPlaylistView) {
      if (plDetail?.kind === 'release' && plDetail.data?.release?.id === releaseId) return;
      openPlaylistEntity('release', releaseId);
      return;
    }
    if (explorerState.id === releaseId) return;
    explorerState.setEntity(releaseId);
  }
  // While a session is open it can be minimized to a floating pill so the user
  // can keep browsing; the recorder store keeps capturing regardless.

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
      const hit = addItems.find((it) => it.id === explorerState.id);
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

        // Background fetch: enrich with pressing notes + the barcode/identifier
        // list from the full release endpoint, which the search API omits.
        // (Format/color already rides on the search hit via formats[].text.)
        const selectedId = hit.id;
        fetch(`/api/discogs/releases/${hit.id}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => {
            if (!d) return;
            // Guard: only update if the user hasn't moved to a different result.
            if (explorerState.id !== selectedId || !detailData?.release) return;
            detailData = {
              ...detailData,
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

  /**
   * The filters the library queue is built from. These MUST mirror exactly what
   * `loadList` sends to /api/library/tracks — if they diverge, the queue's order
   * stops matching the visible list and `next` plays the wrong track.
   * Deliberately omits multi_source: `loadList` never sends it (the rail has no
   * multi-source item), so including it here would be such a divergence.
   */
  const libraryQuery = $derived({
    source: explorerState.nav.section === 'sources' ? explorerState.nav.item : undefined,
    q: explorerState.q || undefined,
    sort: explorerState.sort,
  });

  // ----- Add → Discogs master grouping ---------------------------------------

  // One shape for both row kinds: master rows carry the version-only fields as
  // null (they're never selected as a release — clicking drills instead), so
  // the list and detail lookups stay free of union narrowing.
  interface AddItem {
    id: string;
    title: string;
    artist: string;
    year: number | null;
    country: string | null;
    label: string | null;
    catno: string | null;
    format: string | null;
    thumbUrl: string | null;
    coverUrl: string | null;
    sources: string[];
    _isDiscogsSearchHit: boolean;
    isMaster?: boolean;
    versionCount?: number;
    yearLabel?: string | null;
  }

  /** One Discogs search hit → the ReleaseItem shape the listview renders. */
  function mapVersion(h: SearchHit): AddItem {
    return {
      id: String(h.id),
      title: h.title,
      artist: h.artist,
      year: h.year ?? null,
      country: h.country ?? null,
      label: h.label ?? null,
      catno: h.catno ?? null,
      format: h.format ?? null,
      thumbUrl: h.thumb ?? null,
      coverUrl: h.coverImage ?? null,
      sources: collection.has(h.id) ? ['discogs'] : [],
      _isDiscogsSearchHit: true,
    };
  }

  const masterGroups = $derived(groupByMaster(searchHits));
  const drilledMaster = $derived(
    drillMasterId !== null
      ? masterGroups.find((g) => g.masterId === drillMasterId) ?? null
      : null,
  );

  // The rows shown in Add → Discogs: master rows + singletons at the top level,
  // or a master's versions once drilled in. Owned state reads `collection` so it
  // stays live across add/remove without manual row patching.
  const addItems = $derived.by<AddItem[]>(() => {
    if (drilledMaster) return drilledMaster.versions.map(mapVersion);
    return masterGroups.map((g) =>
      g.isMaster
        ? {
            id: g.key, // 'master:<id>' — onAddRowSelect drills instead of selecting
            title: g.title,
            artist: g.artist,
            year: null,
            country: null,
            label: null,
            catno: null,
            format: null,
            thumbUrl: g.thumb,
            coverUrl: null,
            sources: g.versions.some((v) => collection.has(v.id)) ? ['discogs'] : [],
            _isDiscogsSearchHit: false,
            isMaster: true,
            versionCount: g.versionCount,
            yearLabel: g.yearLabel,
          }
        : mapVersion(g.versions[0]),
    );
  });

  /** Row click in Add → Discogs: drill into a master, else select the release. */
  function onAddRowSelect(id: string) {
    if (id.startsWith('master:')) {
      drillMasterId = Number(id.slice('master:'.length));
      explorerState.setEntity(null);
    } else {
      explorerState.setEntity(id);
    }
  }

  /** Leave a master's version list, back to the master-level results. */
  function popDrill() {
    drillMasterId = null;
    explorerState.setEntity(null);
  }

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
      const n = addItems.length;
      return `${n} result${n === 1 ? '' : 's'}`;
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


  let addSubmitting = $state(false);
  async function handleAdd() {
    if (!detailData?._isDiscogsSearchHit) return;
    const hit = addItems.find((it) => it.id === explorerState.id);
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
        // The list's owned dots are derived from `collection`, so markAdded
        // above refreshes the row — no manual list patch needed.
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

  // Grid is the default for releases — cover art is the fastest way to find a
  // record. Not persisted, so it resets to grid on reload.

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


  /**
   * Mark a release vetted (or un-vetted) and, when working the Unvetted queue,
   * open the next release automatically.
   *
   * The advance is scoped to the queue on purpose: doing it everywhere would
   * hijack navigation mid-browse. Inside the queue it is what makes a
   * ~1,400-release grind survivable — without it you pay an extra navigation
   * gesture a thousand-odd times.
   */
  async function vetAndAdvance(releaseId: string, next = true) {
    const inQueue =
      explorerState.nav.section === 'library' && explorerState.nav.item === 'unvetted';
    const advancing = inQueue && next;

    // Everything that touches reactive state happens synchronously, before the
    // await. State mutated in the async continuation does not reach the
    // URL-sync effect — the list and `?id` update internally but the URL and
    // the rendered rows stay on the previous value. Doing it up front is also
    // the right UX: the store is already optimistic, so the release should
    // leave the queue on click, not one round-trip later.
    let successor: { id: string } | null = null;
    if (advancing) {
      const idx = listItems.findIndex((it) => it.id === releaseId);
      successor = idx >= 0 ? (listItems[idx + 1] ?? listItems[idx - 1] ?? null) : null;

      // Drop it from the queue in place rather than refetching — a refetch
      // would reset scroll position after every single release.
      listItems = listItems.filter((it) => it.id !== releaseId);
      listTotal = Math.max(0, listTotal - 1);
      explorerState.setEntity(successor ? successor.id : null);
    }

    // The progress meter is exact without a round-trip: vetting moves exactly
    // one release out of the unvetted set.
    counts = {
      ...counts,
      unvettedReleases: Math.max(0, counts.unvettedReleases + (next ? -1 : 1)),
    };

    await annotations.toggleVetted(releaseId, next);

    // Top up if removals have drained the buffer below a screenful.
    if (advancing && listItems.length < 20 && listHasMore) void loadList(false);
  }

  return {
    get sources() { return sources; },
    get counts() { return counts; },
    get syncing() { return syncing; },
    get listItems() { return listItems; },
    get listTotal() { return listTotal; },
    get listHasMore() { return listHasMore; },
    get detailKind() { return detailKind; },
    get detailData() { return detailData; },
    get plDetail() { return plDetail; },
    get selectedSource() { return selectedSource; },
    get currentEntity() { return currentEntity; },
    get isAddView() { return isAddView; },
    get isSourcesView() { return isSourcesView; },
    get isPlaylistView() { return isPlaylistView; },
    get libraryQuery() { return libraryQuery; },
    get drilledMaster() { return drilledMaster; },
    get addItems() { return addItems; },
    get showEntityToggle() { return showEntityToggle; },
    get showReleaseOnlySourceEmpty() { return showReleaseOnlySourceEmpty; },
    get toolbarPlaceholder() { return toolbarPlaceholder; },
    get discogsSearchUrl() { return discogsSearchUrl; },
    get toolbarMeta() { return toolbarMeta; },
    get syncRunsReloadKey() { return syncRunsReloadKey; },
    get sourceMetaForDetail() { return sourceMetaForDetail; },
    get releaseDetailCta() { return releaseDetailCta; },

    // Markup closes the playlist link-detail; a getter alone is not assignable.
    closePlDetail() { plDetail = null; },

    loadList,
    openPlaylistEntity,
    openReleaseFromPlayer,
    onAddRowSelect,
    popDrill,
    handleUndo,
    handleSync,
    vetAndAdvance,
  };
}
