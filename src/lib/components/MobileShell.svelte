<script lang="ts">
  import ReleaseGrid from './ReleaseGrid.svelte';
  import TrackList from './TrackList.svelte';
  import ArtistList from './ArtistList.svelte';
  import ReleaseDetail from './ReleaseDetail.svelte';
  import TrackDetail from './TrackDetail.svelte';
  import ArtistDetail from './ArtistDetail.svelte';
  import PlaylistView from './PlaylistView.svelte';
  import GigView from './GigView.svelte';
  import CratePanel from './CratePanel.svelte';
  import PlaylistCover from './PlaylistCover.svelte';
  import EmptyState from './EmptyState.svelte';
  import RunoutFilter from './RunoutFilter.svelte';
  import Scanner from './Scanner.svelte';
  import SyncRunHistory from './SyncRunHistory.svelte';
  import Player from './Player.svelte';
  import PlayerBar from './PlayerBar.svelte';
  import TabBar from './mobile/TabBar.svelte';
  import type { MobileTab } from './mobile/tabs';
  import { explorerState } from '$lib/stores/explorerState.svelte';
  import { playlists } from '$lib/stores/playlists.svelte';
  import { createExplorerController } from '$lib/stores/explorerController.svelte';

  const c = createExplorerController();

  // Read-through aliases: the controller exposes getters, so $derived (not a
  // plain const, which would snapshot once).
  const listItems = $derived(c.listItems);
  const listTotal = $derived(c.listTotal);
  const listHasMore = $derived(c.listHasMore);
  const addItems = $derived(c.addItems);
  const drilledMaster = $derived(c.drilledMaster);
  const runoutStatus = $derived(c.runoutStatus);
  const currentEntity = $derived(c.currentEntity);
  const detailKind = $derived(c.detailKind);
  const detailData = $derived(c.detailData);
  const isAddView = $derived(c.isAddView);
  const libraryQuery = $derived(c.libraryQuery);
  const sources = $derived(c.sources);
  const sourceMetaForDetail = $derived(c.sourceMetaForDetail);
  const releaseDetailCta = $derived(c.releaseDetailCta);
  const toolbarMeta = $derived(c.toolbarMeta);
  const syncing = $derived(c.syncing);
  const syncRunsReloadKey = $derived(c.syncRunsReloadKey);
  const loadList = c.loadList;
  const onAddRowSelect = c.onAddRowSelect;

  let tab = $state<MobileTab>('library');
  let scannerOpen = $state(false);

  const LIBRARY_FILTERS = [
    { item: 'all', label: 'All' },
    { item: 'starred', label: 'Starred' },
    { item: 'unvetted', label: 'Unvetted' },
  ] as const;
  let sourcesOpen = $state(false);

  // Detail is a pushed view, not a pane: derived from the same ?id= the desktop
  // shell uses, so deep links and back/forward keep working identically.
  const detailOpen = $derived(!!explorerState.id && tab !== 'playlists');
  const playlistOpen = $derived(tab === 'playlists' && explorerState.nav.section === 'playlist');
  // A gig on a phone is two panes in one column: the sketch, or the crate.
  let gigPane = $state<'sketch' | 'crate'>('sketch');

  const title = $derived(
    tab === 'library' ? 'Library'
    : tab === 'playlists' ? (playlistOpen ? (playlists.openPlaylist?.name ?? 'Playlist') : 'Playlists')
    : tab === 'add' ? 'Add'
    : 'Search',
  );

  function selectTab(t: MobileTab) {
    tab = t;
    explorerState.setEntity(null);
    sourcesOpen = false;
    if (t === 'add') {
      explorerState.setNav({ section: 'add', item: 'discogs' });
      return;
    }
    if (t === 'playlists') {
      explorerState.setQuery('');
      return;
    }
    // Library and Search are the same dataset; the tab decides whether a query
    // input is offered, not which endpoint is hit.
    explorerState.setNav({ section: 'library', item: 'all' });
    if (t === 'library') explorerState.setQuery('');
  }

  function back() {
    if (detailOpen) { explorerState.setEntity(null); return; }
    if (playlistOpen) { explorerState.setNav({ section: 'library', item: 'all' }); return; }
  }

  const showBack = $derived(detailOpen || playlistOpen);
  const entities: Array<'releases' | 'tracks' | 'artists'> = ['releases', 'tracks', 'artists'];
</script>

<Player />

<div class="mshell">
  <header class="mhead">
    {#if showBack}
      <button class="chev" onclick={back} aria-label="Back">‹</button>
    {/if}
    <h1>{title}</h1>
    {#if tab === 'library' && !detailOpen}
      <button class="hbtn" onclick={() => (sourcesOpen = !sourcesOpen)}>Sources</button>
    {/if}
    {#if tab === 'add' && !detailOpen}
      <button class="hbtn" onclick={() => (scannerOpen = true)} title="Scan barcode">Scan</button>
    {/if}
  </header>

  {#if (tab === 'library' || tab === 'search') && !detailOpen}
    <div class="mtoolbar">
      {#if tab === 'search'}
        <input
          class="search"
          type="search"
          placeholder="Search library…"
          bind:value={explorerState.q}
          oninput={() => { if (sources.length) loadList(true); }}
        />
      {/if}
      <div class="seg" role="group" aria-label="Entity">
        {#each entities as e (e)}
          <button
            class:active={currentEntity === e}
            onclick={() => explorerState.setEntityKind(e)}
          >{e}</button>
        {/each}
      </div>
      <span class="meta">{toolbarMeta}</span>
    </div>
    {#if tab === 'library'}
      <!-- The rail's Starred/Unvetted items have no home in a four-tab shell,
           so they become a filter strip under the Library toolbar. These write
           the same ?nav values the desktop rail does, and navEntityHint puts
           each on its correct lens. -->
      <div class="mtoolbar sub">
        <div class="seg" role="group" aria-label="Library filter">
          {#each LIBRARY_FILTERS as f (f.item)}
            <button
              class:active={explorerState.nav.section === 'library' && explorerState.nav.item === f.item}
              onclick={() => explorerState.setNav({ section: 'library', item: f.item })}
            >{f.label}</button>
          {/each}
        </div>
      </div>
    {/if}
  {/if}

  {#if tab === 'add' && !detailOpen}
    <div class="mtoolbar">
      <input
        class="search"
        type="search"
        placeholder="Search Discogs…"
        bind:value={explorerState.q}
        oninput={() => { if (sources.length) loadList(true); }}
      />
      <span class="meta">{toolbarMeta}</span>
    </div>
  {/if}

  {#if sourcesOpen}
    <div class="sheet">
      {#each sources.filter((s) => !s.isStub) as s (s.id)}
        <SyncRunHistory
          sourceId={s.id}
          sourceName={s.name}
          isStub={s.isStub}
          syncing={syncing === s.id}
          reloadKey={syncRunsReloadKey}
        />
      {/each}
    </div>
  {/if}

  {#if scannerOpen}
    <div class="scanner-overlay">
      <Scanner onDecode={(code) => { explorerState.setQuery(code); scannerOpen = false; loadList(true); }} />
      <button class="scanner-close" onclick={() => (scannerOpen = false)}>Close (Esc)</button>
    </div>
  {/if}

  <main class="mbody">
    {#if detailOpen}
      {#if detailKind === 'release' && detailData}
        <ReleaseDetail
          release={detailData.release}
          sources={detailData.sources}
          tracks={detailData.tracks ?? []}
          notes={detailData.notes ?? null}
          identifiers={detailData.identifiers ?? []}
          addCta={releaseDetailCta}
          onTrackSelect={(id) => explorerState.setEntity(id)}
          onArtistSelect={(id) => explorerState.setEntity(id)}
          recordDisabled={true}
        />
      {:else if detailKind === 'track' && detailData}
        <TrackDetail
          track={detailData.track}
          sources={detailData.sources}
          facets={detailData.facets}
          release={detailData.release}
          bpm={detailData.bpm}
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
    {:else if tab === 'playlists'}
      {#if playlistOpen && playlists.openPlaylist?.isGig}
        <div class="seg gig-seg" role="group" aria-label="Gig pane">
          <button class:active={gigPane === 'sketch'} onclick={() => (gigPane = 'sketch')}>Sketch</button>
          <button class:active={gigPane === 'crate'} onclick={() => (gigPane = 'crate')}>Crate</button>
        </div>
        {#if gigPane === 'sketch'}
          <GigView
            compact
            selectedId={explorerState.id}
            onTrackSelect={(id) => explorerState.setEntity(id)}
            onDeleted={() => explorerState.setNav({ section: 'library', item: 'all' })}
          />
        {:else}
          <!-- Crate rows don't open a tracklist on a phone yet; that's the
               booth view (milestone 2). -->
          <CratePanel onOpenRelease={() => {}} />
        {/if}
      {:else if playlistOpen}
        <PlaylistView
          selectedId={explorerState.id}
          onTrackSelect={(id) => explorerState.setEntity(id)}
          onArtistSelect={() => {}}
          onReleaseSelect={() => {}}
          onDeleted={() => explorerState.setNav({ section: 'library', item: 'all' })}
        />
      {:else if playlists.items.length === 0}
        <EmptyState title="No playlists" detail="Create one from the desktop app." />
      {:else}
        <div class="pl-list">
          {#each playlists.items as p (p.id)}
            <button class="pl-row" onclick={() => explorerState.setNav({ section: 'playlist', item: p.id })}>
              <PlaylistCover coverUrl={p.coverUrl} mosaic={p.mosaic} size={44} />
              <span class="pl-name">{p.name}</span>
              <span class="pl-count">{p.trackCount}</span>
            </button>
          {/each}
        </div>
      {/if}
    {:else if currentEntity === 'releases' || isAddView}
      {#if isAddView && drilledMaster}
        <button class="drill-back" onclick={c.popDrill}>
          ← {drilledMaster.versionCount} versions of “{drilledMaster.title}”
        </button>
        <RunoutFilter bind:value={c.runoutQuery} status={runoutStatus} />
      {/if}
      <ReleaseGrid
        items={isAddView ? addItems : listItems}
        total={isAddView ? addItems.length : listTotal}
        hasMore={isAddView ? false : listHasMore}
        selectedId={explorerState.id}
        onSelect={isAddView ? onAddRowSelect : (id) => explorerState.setEntity(id)}
        loadMore={() => loadList(false)}
        emptyTitle={isAddView && !explorerState.q ? 'Search Discogs to add records' : 'No releases'}
      />
    {:else if currentEntity === 'tracks'}
      <TrackList
        items={listItems}
        total={listTotal}
        hasMore={listHasMore}
        selectedId={explorerState.id}
        onSelect={(id) => explorerState.setEntity(id)}
        loadMore={() => loadList(false)}
        query={libraryQuery}
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
  </main>

  <PlayerBar onOpenRelease={(id) => { tab = 'library'; explorerState.setEntity(id); }} />
  <TabBar {tab} onSelect={selectTab} />
</div>

<style>
  .drill-back {
    display: block;
    width: 100%;
    text-align: left;
    background: transparent;
    border: 0;
    border-bottom: 1px solid var(--border);
    color: var(--text-muted);
    font-family: inherit;
    font-size: 13px;
    padding: 10px 14px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mtoolbar.sub { padding-top: 0; }

  .mshell {
    display: flex;
    flex-direction: column;
    /* dvh, not vh: iOS Safari's URL bar shrinks the visual viewport and 100vh
       keeps reporting the largest height, hiding the tab bar under chrome. */
    height: calc(100dvh - var(--titlebar-h));
    margin-top: var(--titlebar-h);
    overflow: hidden;
  }
  .mhead {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    padding-top: max(10px, env(safe-area-inset-top));
    border-bottom: 1px solid var(--border);
    flex: none;
  }
  .mhead h1 { font-size: 15px; font-weight: 600; margin: 0; flex: 1; }
  .chev {
    background: none; border: none; color: var(--accent);
    font-size: 24px; line-height: 1; cursor: pointer;
    min-width: 44px; min-height: 44px; margin-left: -10px;
  }
  .hbtn {
    background: none; border: 1px solid var(--border); border-radius: 4px;
    color: var(--text-dim); font-size: 12px; padding: 6px 10px;
    min-height: 36px; cursor: pointer;
  }
  .mtoolbar {
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    padding: 8px 12px; border-bottom: 1px solid var(--border); flex: none;
  }
  .mtoolbar .search {
    flex: 1 1 100%; min-height: 40px; padding: 0 10px;
    background: var(--bg-raised); border: 1px solid var(--border);
    border-radius: 6px; color: var(--text); font-size: 15px; /* 16px avoids iOS zoom-on-focus */
  }
  .gig-seg { margin: 8px 12px; }
  .seg { display: flex; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
  .seg button {
    background: none; border: none; color: var(--text-dim);
    font-size: 12px; padding: 0 12px; min-height: 36px;
    text-transform: capitalize; cursor: pointer;
  }
  .seg button.active { background: var(--bg-raised); color: var(--text); }
  .meta { margin-left: auto; color: var(--text-subtle); font-size: 12px; }
  .mbody { flex: 1; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch; }
  .sheet { max-height: 45vh; overflow-y: auto; border-bottom: 1px solid var(--border); flex: none; }
  .pl-list { display: flex; flex-direction: column; }
  .pl-row {
    display: flex; align-items: center; gap: 12px;
    padding: 8px 12px; min-height: 60px;
    background: none; border: none; border-bottom: 1px solid var(--border);
    color: var(--text); text-align: left; cursor: pointer;
  }
  .pl-name { flex: 1; font-size: 14px; }
  .pl-count { color: var(--text-subtle); font-size: 12px; }
  .scanner-overlay {
    position: fixed; inset: 0; z-index: 50;
    background: var(--bg); display: flex;
    flex-direction: column; align-items: center; justify-content: center; gap: 12px;
  }
  .scanner-close {
    background: var(--bg-raised); border: 1px solid var(--border);
    color: var(--text); padding: 10px 16px; border-radius: 6px;
    min-height: 44px; cursor: pointer;
  }
</style>
