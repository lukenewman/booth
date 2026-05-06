<script lang="ts">
  import SourcePanel from './SourcePanel.svelte';

  interface SourceLink { source: string; external_id: string; external_url: string | null; match_method: string; }
  interface Facet { source: string; key: string; value: string; }
  interface ParentRelease { id: string; title: string; artist: string; year: number | null; }
  interface Track { id: string; title: string; artist: string; duration_ms: number | null; }
  interface SourceMeta { id: string; name: string; isStub: boolean; }

  let {
    track,
    sources,
    facets,
    release,
    sourceMeta,
    onReleaseSelect,
  }: {
    track: Track;
    sources: SourceLink[];
    facets: Facet[];
    release: ParentRelease | null;
    sourceMeta: SourceMeta[];
    onReleaseSelect?: (releaseId: string) => void;
  } = $props();

  function facetRowsFor(sourceId: string) {
    const monoKeys = new Set(['file', 'file path', 'external id', 'bitrate', 'samplerate', 'date added', 'added']);
    return facets
      .filter((f) => f.source === sourceId)
      .map((f) => ({
        key: f.key.toLowerCase(),
        value: f.value,
        mono: monoKeys.has(f.key.toLowerCase()),
      }));
  }

  function durationLabel(ms: number | null): string {
    if (!ms) return '—';
    const s = Math.round(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  const ALL_SOURCE_IDS = ['discogs', 'itunes', 'rekordbox', 'plex'];

  const sourcesById = $derived(new Map(sources.map((s) => [s.source, s])));
  const metaById = $derived(new Map(sourceMeta.map((m) => [m.id, m])));
</script>

<div class="detail">
  {#if release}
    <button class="breadcrumb" onclick={() => onReleaseSelect?.(release.id)}>
      ← {release.title}
    </button>
  {/if}

  <div class="title">{track.title}</div>
  <div class="artist">{track.artist} · {durationLabel(track.duration_ms)}</div>

  {#if release}
    <button class="parent-card" onclick={() => onReleaseSelect?.(release.id)}>
      <div class="parent-cover">cov</div>
      <div class="parent-meta">
        <div class="parent-title">{release.title}</div>
        <div class="parent-artist">{release.artist}{release.year ? ` · ${release.year}` : ''}</div>
      </div>
    </button>
  {/if}

  {#each ALL_SOURCE_IDS as sid}
    {@const link = sourcesById.get(sid)}
    {@const meta = metaById.get(sid)}
    {#if meta}
      {#if link || meta.isStub}
        <SourcePanel
          sourceId={sid}
          sourceName={meta.name}
          isStub={meta.isStub && !link}
          externalUrl={link?.external_url ?? null}
          facets={link ? facetRowsFor(sid) : []}
        />
      {/if}
    {/if}
  {/each}
</div>

<style>
  .detail { padding: 18px 20px 24px; overflow-y: auto; height: 100%; }
  .breadcrumb {
    background: transparent; border: 0; color: var(--text-muted);
    padding: 0 0 8px;
    font-family: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .breadcrumb:hover { color: var(--text); }
  .title {
    font-size: 15px; font-weight: 600;
    color: var(--text);
    margin-bottom: 2px;
    line-height: 1.3;
  }
  .artist { color: var(--text-muted); font-size: 13px; margin-bottom: 14px; }
  .parent-card {
    display: flex;
    gap: 10px;
    width: 100%;
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 8px;
    cursor: pointer;
    margin-bottom: 12px;
    align-items: center;
    text-align: left;
    color: inherit;
    font-family: inherit;
  }
  .parent-card:hover { border-color: var(--text-muted); }
  .parent-cover {
    width: 48px; height: 48px;
    background: var(--bg);
    border-radius: 3px;
    display: flex; align-items: center; justify-content: center;
    color: var(--text-subtle);
    font-size: 9px;
    flex-shrink: 0;
  }
  .parent-meta { min-width: 0; }
  .parent-title {
    color: var(--text);
    font-size: 12px;
    font-weight: 500;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .parent-artist {
    color: var(--text-muted);
    font-size: 11px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
</style>
