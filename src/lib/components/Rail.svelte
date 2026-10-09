<script lang="ts">
  import type { NavValue } from '$lib/stores/explorerState.svelte';
  import PlaylistCover from './PlaylistCover.svelte';
  import { parseLength } from '$lib/gig';

  interface SourceWithState {
    id: string;
    name: string;
    contributes: ('track' | 'release' | 'artist')[];
    isStub: boolean;
    count: number;
    lastSyncedAt: string | null;
  }

  interface Counts {
    allReleases: number;
    allTracks: number;
    allArtists: number;
    starredTracks: number;
    unvettedReleases: number;
  }

  let {
    nav,
    entity,
    sources,
    counts,
    playlists = [],
    onSelect,
    onCreatePlaylist,
    onAddTrackToPlaylist,
    onCreateGig,
    onAddReleaseToPlaylist,
  }: {
    nav: NavValue;
    entity: 'releases' | 'tracks' | 'artists';
    sources: SourceWithState[];
    counts: Counts;
    playlists?: { id: string; name: string; trackCount: number; coverUrl: string | null; mosaic: string[]; isGig?: boolean }[];
    onSelect?: (nav: NavValue) => void;
    onCreatePlaylist?: (name: string) => void;
    onAddTrackToPlaylist?: (playlistId: string, trackId: string) => void;
    onCreateGig?: (name: string, targetMinutes: number) => void;
    onAddReleaseToPlaylist?: (playlistId: string, releaseId: string) => void;
  } = $props();

  const allCount = $derived(
    entity === 'tracks' ? counts.allTracks
    : entity === 'artists' ? counts.allArtists
    : counts.allReleases,
  );

  function isActive(section: string, item: string): boolean {
    return nav.section === section && nav.item === item;
  }

  function relativeTime(iso: string | null): string {
    if (!iso) return '';
    const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  const writableSources = $derived(sources.filter((s) => s.id === 'discogs')); // TODO: derive via CollectionWritable when more writable adapters land

  let creating = $state(false);
  let newName = $state('');
  let dropTargetId = $state<string | null>(null);

  function submitNewPlaylist() {
    const name = newName.trim();
    if (name) onCreatePlaylist?.(name);
    newName = '';
    creating = false;
  }

  function onPlaylistDrop(e: DragEvent, playlistId: string) {
    e.preventDefault();
    dropTargetId = null;
    const trackId = e.dataTransfer?.getData('application/x-booth-track');
    if (trackId) { onAddTrackToPlaylist?.(playlistId, trackId); return; }
    const releaseId = e.dataTransfer?.getData('application/x-booth-release');
    if (releaseId) onAddReleaseToPlaylist?.(playlistId, releaseId);
  }

  // New gig: a name and a set length. An empty length means the default three
  // hours; a length that doesn't parse keeps the form open rather than guess.
  const plainPlaylists = $derived(playlists.filter((p) => !p.isGig));
  const gigs = $derived(playlists.filter((p) => p.isGig));

  const DEFAULT_GIG_MINUTES = 180;
  let creatingGig = $state(false);
  let gigName = $state('');
  let gigLength = $state('');
  let gigLengthInvalid = $state(false);

  function submitGig() {
    const name = gigName.trim();
    if (!name) { cancelGig(); return; }
    const minutes = gigLength.trim() ? parseLength(gigLength) : DEFAULT_GIG_MINUTES;
    if (minutes == null) { gigLengthInvalid = true; return; }
    onCreateGig?.(name, minutes);
    cancelGig();
  }
  function cancelGig() {
    creatingGig = false;
    gigName = '';
    gigLength = '';
    gigLengthInvalid = false;
  }
  function gigKey(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); submitGig(); }
    else if (e.key === 'Escape') cancelGig();
  }
</script>

{#snippet playlistItem(p: (typeof playlists)[number])}
  <button
    class="item"
    class:active={isActive('playlist', p.id)}
    class:drop-target={dropTargetId === p.id}
    onclick={() => onSelect?.({ section: 'playlist', item: p.id })}
    ondragover={(e) => { e.preventDefault(); dropTargetId = p.id; }}
    ondragleave={() => { if (dropTargetId === p.id) dropTargetId = null; }}
    ondrop={(e) => onPlaylistDrop(e, p.id)}
  >
    <PlaylistCover coverUrl={p.coverUrl} mosaic={p.mosaic} size={22} />
    <span class="pname">{p.name}</span>
    <span class="count">{p.trackCount.toLocaleString()}</span>
  </button>
{/snippet}

<aside class="rail">
  <div class="section">
    <div class="label">Library</div>
    <button
      class="item"
      class:active={isActive('library', 'all')}
      onclick={() => onSelect?.({ section: 'library', item: 'all' })}
    >
      <span>All</span>
      <span class="count">{allCount.toLocaleString()}</span>
    </button>
    <button
      class="item"
      class:active={isActive('library', 'starred')}
      onclick={() => onSelect?.({ section: 'library', item: 'starred' })}
    >
      <span>Starred</span>
      <span class="count">{counts.starredTracks.toLocaleString()}</span>
    </button>
    <!-- The Unvetted count is the progress meter for working through the
         collection — it is the number that says how much is left. -->
    <button
      class="item"
      class:active={isActive('library', 'unvetted')}
      onclick={() => onSelect?.({ section: 'library', item: 'unvetted' })}
    >
      <span>Unvetted</span>
      <span class="count">{counts.unvettedReleases.toLocaleString()}</span>
    </button>
  </div>

  <div class="section">
    <div class="label">Playlists</div>
    {#each plainPlaylists as p (p.id)}
      {@render playlistItem(p)}
    {/each}
    {#if creating}
      <!-- svelte-ignore a11y_autofocus -->
      <input
        class="new-playlist"
        bind:value={newName}
        placeholder="Playlist name…"
        autofocus
        onkeydown={(e) => {
          if (e.key === 'Enter') submitNewPlaylist();
          else if (e.key === 'Escape') { e.stopPropagation(); newName = ''; creating = false; }
        }}
        onblur={submitNewPlaylist}
      />
    {:else}
      <button class="new-btn" onclick={() => (creating = true)}>＋ New playlist</button>
    {/if}
  </div>

  <!-- Gigs get their own section. Gig-ness is derived (a crate, a second
       section or a set length), so a playlist that gains one moves here. -->
  <div class="section">
    <div class="label">Gigs</div>
    {#each gigs as p (p.id)}
      {@render playlistItem(p)}
    {/each}
    {#if creatingGig}
      <!-- Blur only submits when focus leaves the whole form, so tabbing from
           name to length doesn't create a half-filled gig. -->
      <div
        class="new-gig"
        role="group"
        onfocusout={(e) => { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) submitGig(); }}
      >
        <!-- svelte-ignore a11y_autofocus -->
        <input class="new-playlist" bind:value={gigName} placeholder="Gig name…" autofocus onkeydown={gigKey} />
        <input
          class="new-playlist"
          bind:value={gigLength}
          placeholder="Length — 3:00"
          aria-invalid={gigLengthInvalid}
          oninput={() => (gigLengthInvalid = false)}
          onkeydown={gigKey}
        />
      </div>
    {:else}
      <button class="new-btn new-gig-btn" onclick={() => (creatingGig = true)}>＋ New gig</button>
    {/if}
  </div>

  <div class="section">
    <div class="label">Sources</div>
    {#each sources as src}
      <button
        class="item"
        class:active={isActive('sources', src.id)}
        title={src.lastSyncedAt ? relativeTime(src.lastSyncedAt) : ''}
        onclick={() => onSelect?.({ section: 'sources', item: src.id })}
      >
        <span class="dot {src.id}" class:dim={src.isStub}></span>
        <span>{src.name}</span>
        <span class="count">{src.isStub ? '—' : src.count.toLocaleString()}</span>
      </button>
    {/each}
  </div>

  <div class="section">
    <div class="label">Add</div>
    {#each writableSources as src}
      <button
        class="item"
        class:active={isActive('add', src.id)}
        onclick={() => onSelect?.({ section: 'add', item: src.id })}
      >
        <span class="dot {src.id}"></span>
        <span>{src.name}</span>
      </button>
    {/each}
  </div>
</aside>

<style>
  .rail {
    border-right: 1px solid var(--border);
    padding: 14px 0;
    overflow-y: auto;
    background: var(--bg);
    height: 100%;
  }
  .section { margin-bottom: 18px; }
  .label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-subtle);
    padding: 0 16px 6px;
    font-weight: 600;
  }
  .item {
    background: transparent;
    border: 0;
    padding: 5px 16px;
    color: var(--text);
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 9px;
    font-family: inherit;
    font-size: 13px;
    width: 100%;
    text-align: left;
    border-left: 2px solid transparent;
  }
  .item:hover { background: var(--bg-row-hover); }
  .item.active {
    background: var(--accent-bg);
    border-left-color: var(--accent);
  }
  .item .count {
    color: var(--text-subtle);
    font-size: 11px;
    margin-left: auto;
    font-variant-numeric: tabular-nums;
  }
  .dot {
    width: 6px; height: 6px; border-radius: 50%;
    flex-shrink: 0;
  }
  .dot.discogs   { background: var(--src-discogs); }
  .dot.local    { background: var(--src-local); }
  .dot.dim { opacity: 0.35; }

  .item.drop-target {
    background: var(--accent-bg);
    border-left-color: var(--accent);
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .item.drop-target .pname { color: var(--accent); }
  .pname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .new-playlist[aria-invalid='true'] { border-color: var(--danger); }
  .new-btn {
    background: transparent;
    border: 0;
    padding: 5px 16px;
    color: var(--text-subtle);
    cursor: pointer;
    font-family: inherit;
    font-size: 12px;
    width: 100%;
    text-align: left;
  }
  .new-btn:hover { color: var(--text); background: var(--bg-row-hover); }
  .new-playlist {
    margin: 2px 12px;
    width: calc(100% - 24px);
    background: var(--bg-raised);
    border: 1px solid var(--border-strong);
    border-radius: 3px;
    padding: 4px 6px;
    color: var(--text);
    font-family: inherit;
    font-size: 12px;
  }
</style>
