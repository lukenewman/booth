<script lang="ts">
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
  import PlaylistView from './PlaylistView.svelte';
  import Player from './Player.svelte';
  import PlayerBar from './PlayerBar.svelte';
  import RecordSession from './RecordSession.svelte';
import RecordingPill from './RecordingPill.svelte';
  import { explorerState } from '$lib/stores/explorerState.svelte';
  import { playlists } from '$lib/stores/playlists.svelte';
  import { toast } from '$lib/stores/toast.svelte';
  import { createExplorerController } from '$lib/stores/explorerController.svelte';

  const c = createExplorerController();

  // Read-through aliases so the markup below is unchanged from when this
  // was Explorer.svelte. $derived (not destructuring) because the controller
  // exposes getters — a plain const would snapshot the value once.
  const sources = $derived(c.sources);
  const counts = $derived(c.counts);
  const syncing = $derived(c.syncing);
  const listItems = $derived(c.listItems);
  const listTotal = $derived(c.listTotal);
  const listHasMore = $derived(c.listHasMore);
  const detailKind = $derived(c.detailKind);
  const detailData = $derived(c.detailData);
  const plDetail = $derived(c.plDetail);
  const selectedSource = $derived(c.selectedSource);
  const currentEntity = $derived(c.currentEntity);
  const isAddView = $derived(c.isAddView);
  const isSourcesView = $derived(c.isSourcesView);
  const isPlaylistView = $derived(c.isPlaylistView);
  const libraryQuery = $derived(c.libraryQuery);
  const drilledMaster = $derived(c.drilledMaster);
  const addItems = $derived(c.addItems);
  const showEntityToggle = $derived(c.showEntityToggle);
  const showReleaseOnlySourceEmpty = $derived(c.showReleaseOnlySourceEmpty);
  const toolbarPlaceholder = $derived(c.toolbarPlaceholder);
  const discogsSearchUrl = $derived(c.discogsSearchUrl);
  const toolbarMeta = $derived(c.toolbarMeta);
  const syncRunsReloadKey = $derived(c.syncRunsReloadKey);
  const sourceMetaForDetail = $derived(c.sourceMetaForDetail);
  const releaseDetailCta = $derived(c.releaseDetailCta);

  const loadList = c.loadList;
  const openPlaylistEntity = c.openPlaylistEntity;
  const openReleaseFromPlayer = c.openReleaseFromPlayer;
  const onAddRowSelect = c.onAddRowSelect;
  const popDrill = c.popDrill;
  const handleUndo = c.handleUndo;
  const handleSync = c.handleSync;

  // Desktop-only view state: no controller logic reads these, and MobileShell
  // will want its own.
  let scannerOpen = $state(false);
  // Grid is the default for releases — cover art is the fastest way to find a
  // record. Not persisted, so it resets to grid on reload.
  let releaseView = $state<'list' | 'grid'>('grid');
  let recordingRelease = $state<{ id: string; title: string; artist: string } | null>(null);
  // While a session is open it can be minimized to a floating pill so the user
  // can keep browsing; the recorder store keeps capturing regardless.
  let recordingMinimized = $state(false);
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
      showSort={!isAddView && currentEntity !== 'artists'}
      sort={explorerState.sort}
      onSortChange={(s) => { explorerState.setSort(s); loadList(true); }}
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

    {#if isAddView && drilledMaster}
      <button class="drill-back" onclick={popDrill}>
        ← {drilledMaster.versionCount} versions of “{drilledMaster.title}”
      </button>
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
          items={isAddView ? addItems : listItems}
          total={isAddView ? addItems.length : listTotal}
          hasMore={isAddView ? false : listHasMore}
          selectedId={explorerState.id}
          onSelect={isAddView ? onAddRowSelect : (id) => explorerState.setEntity(id)}
          loadMore={() => loadList(false)}
          emptyTitle={isAddView && !explorerState.q ? 'Search Discogs to add records' : 'No releases'}
        />
      {:else}
        <ReleaseList
          items={isAddView ? addItems : listItems}
          total={isAddView ? addItems.length : listTotal}
          hasMore={isAddView ? false : listHasMore}
          selectedId={explorerState.id}
          onSelect={isAddView ? onAddRowSelect : (id) => explorerState.setEntity(id)}
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

    {#if isAddView}
      <SessionLog onUndo={handleUndo} />
    {/if}
    {/if}
  </section>

  {#if isPlaylistView}
    {#if plDetail}
      <section class="right">
        <button class="pl-detail-close" onclick={() => c.closePlDetail()}>← Close detail</button>
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
  <PlayerBar onOpenRelease={openReleaseFromPlayer} />
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
  /* Touch targets: rows are mouse-sized by default. 44px is the platform
     minimum, applied only below the mobile breakpoint. */
  @media (max-width: 768px) {
    :global(.row-btn),
    :global(.rail button),
    :global(.cols) ~ :global(.body) :global(.row) {
      min-height: 44px;
    }
  }

  .shell {
    display: flex;
    flex-direction: column;
    /* dvh, not vh: iOS Safari's URL bar shrinks the visual viewport as you
       scroll, and 100vh keeps reporting the *largest* height — which pushes
       the PlayerBar down under the browser chrome. */
    height: 100dvh;
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
  .drill-back {
    display: block;
    width: 100%;
    text-align: left;
    background: transparent;
    border: 0;
    border-bottom: 1px solid var(--border);
    color: var(--text-muted);
    font-family: inherit;
    font-size: 12px;
    padding: 8px 14px;
    cursor: pointer;
  }
  .drill-back:hover { color: var(--text); }
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
