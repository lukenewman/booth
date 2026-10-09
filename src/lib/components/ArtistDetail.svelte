<script lang="ts">
  import SourcePanel from './SourcePanel.svelte';
  import SourceGrid from './SourceGrid.svelte';

  interface SourceLink { source: string; external_id: string; external_url: string | null; match_method: string; }
  interface Facet { source: string; key: string; value: string; }
  interface ReleaseRow {
    id: string;
    title: string;
    year: number | null;
    sources: string[];
    thumb_url: string | null;
  }
  interface Artist { id: string; name: string; }
  interface SourceMeta { id: string; name: string; isStub: boolean; }

  let {
    artist,
    sources,
    facets,
    releases,
    trackCount,
    sourceMeta,
    onReleaseSelect,
  }: {
    artist: Artist;
    sources: SourceLink[];
    facets: Facet[];
    releases: ReleaseRow[];
    trackCount: number;
    sourceMeta: SourceMeta[];
    onReleaseSelect?: (releaseId: string) => void;
  } = $props();

  function facetRowsFor(sourceId: string) {
    return facets
      .filter((f) => f.source === sourceId)
      .map((f) => ({ key: f.key.toLowerCase(), value: f.value, mono: false }));
  }

  const ALL_SOURCE_IDS = ['discogs', 'local', 'rekordbox', 'plex'];
  const sourcesById = $derived(new Map(sources.map((s) => [s.source, s])));
  const metaById = $derived(new Map(sourceMeta.map((m) => [m.id, m])));
</script>

<div class="detail">
  <div class="title">{artist.name}</div>
  <div class="meta">
    {releases.length.toLocaleString()} release{releases.length === 1 ? '' : 's'}
    · {trackCount.toLocaleString()} track{trackCount === 1 ? '' : 's'}
  </div>

  {#each ALL_SOURCE_IDS as sid}
    {@const link = sourcesById.get(sid)}
    {@const meta = metaById.get(sid)}
    {#if meta && link}
      <SourcePanel
        sourceId={sid}
        sourceName={meta.name}
        isStub={false}
        externalUrl={link.external_url}
        facets={facetRowsFor(sid)}
      />
    {/if}
  {/each}

  {#if releases.length > 0}
    <div class="releases">
      <div class="releases-header">Releases</div>
      {#each releases as r}
        <button class="release-row" type="button" onclick={() => onReleaseSelect?.(r.id)}>
          {#if r.thumb_url}
            <img src={r.thumb_url} alt={r.title} class="rel-thumb" />
          {:else}
            <div class="rel-thumb placeholder"></div>
          {/if}
          <span class="rel-title">{r.title}</span>
          <span class="rel-year">{r.year ?? '—'}</span>
          <SourceGrid present={r.sources} />
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .detail { padding: 18px 20px 24px; overflow-y: auto; height: 100%; }
  .title {
    font-size: 16px;
    font-weight: 600;
    color: var(--text);
    margin-bottom: 4px;
    line-height: 1.3;
  }
  .meta {
    color: var(--text-muted);
    font-size: 12px;
    margin-bottom: 18px;
  }

  .releases {
    margin-top: 8px;
    border-top: 1px solid var(--border);
    padding-top: 12px;
  }
  .releases-header {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-subtle);
    font-weight: 600;
    margin-bottom: 6px;
  }
  .release-row {
    display: grid;
    grid-template-columns: 40px 1fr 44px 56px;
    gap: 10px;
    padding: 6px 0;
    align-items: center;
    background: transparent;
    border: 0;
    width: 100%;
    text-align: left;
    cursor: pointer;
    color: inherit;
    font-family: inherit;
    font-size: 12px;
  }
  .rel-thumb {
    width: 40px;
    height: 40px;
    border-radius: 3px;
    object-fit: cover;
    display: block;
    flex-shrink: 0;
  }
  .placeholder { background: var(--bg-input); }
  .release-row:hover { background: var(--bg-row-hover); }
  .rel-title {
    color: var(--text);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .rel-year {
    color: var(--text-subtle);
    font-variant-numeric: tabular-nums;
    font-size: 11px;
    text-align: right;
  }
</style>
