<script lang="ts">
  import type { NavValue } from '$lib/stores/explorerState.svelte';

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
  }

  let {
    nav,
    entity,
    sources,
    counts,
    onSelect,
  }: {
    nav: NavValue;
    entity: 'releases' | 'tracks' | 'artists';
    sources: SourceWithState[];
    counts: Counts;
    onSelect?: (nav: NavValue) => void;
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
</script>

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
  .dot.itunes    { background: var(--src-itunes); }
  .dot.rekordbox { background: var(--src-rekordbox); }
  .dot.plex      { background: var(--src-plex); }
  .dot.dim { opacity: 0.35; }
</style>
