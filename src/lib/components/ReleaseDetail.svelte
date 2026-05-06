<script lang="ts">
  import SourcePanel from './SourcePanel.svelte';
  import SourceGrid from './SourceGrid.svelte';

  interface SourceLink { source: string; external_id: string; external_url: string | null; match_method: string; }
  interface Facet { source: string; key: string; value: string; }
  interface Track {
    id: string;
    title: string;
    position: string | null;
    duration_ms: number | null;
    sources: string[];
  }
  interface Release {
    id: string;
    title: string;
    artist: string;
    year: number | null;
  }
  interface SourceMeta { id: string; name: string; isStub: boolean; }

  let {
    release,
    sources,
    facets,
    tracks,
    sourceMeta,
    addCta = null,
    onTrackSelect,
  }: {
    release: Release;
    sources: SourceLink[];
    facets: Facet[];
    tracks: Track[];
    sourceMeta: SourceMeta[];
    addCta?: { label: string; onClick: () => void; kbdHint?: string } | null;
    onTrackSelect?: (trackId: string) => void;
  } = $props();

  /** Group facets by source id, deciding which keys to show as mono. */
  function facetRowsFor(sourceId: string) {
    const monoKeys = new Set(['catno', 'release id', 'external id', 'file', 'file path']);
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

  // Sources we want to *always* render a panel for (in registry order),
  // regardless of whether the release has a link. Lets stub sources show
  // their "not implemented" placeholder.
  const ALL_SOURCE_IDS = ['discogs', 'itunes', 'rekordbox', 'plex'];

  const sourcesById = $derived(new Map(sources.map((s) => [s.source, s])));
  const metaById = $derived(new Map(sourceMeta.map((m) => [m.id, m])));
</script>

<div class="detail">
  <div class="cover">600 × 600 cover</div>
  <div class="title">{release.title}</div>
  <div class="artist">{release.artist}{release.year ? ` · ${release.year}` : ''}</div>

  {#if addCta}
    <div class="cta-row">
      <button class="add-btn" onclick={addCta.onClick}>
        {addCta.label}
        {#if addCta.kbdHint}<span class="kbd-hint">{addCta.kbdHint}</span>{/if}
      </button>
    </div>
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

  {#if tracks.length > 0}
    <div class="tracklist">
      <div class="tracklist-header">Tracks ({tracks.length})</div>
      {#each tracks as t}
        <button class="track-row" type="button" onclick={() => onTrackSelect?.(t.id)}>
          <span class="position">{t.position ?? ''}</span>
          <span class="track-title">{t.title}</span>
          <span class="track-dur">{durationLabel(t.duration_ms)}</span>
          <SourceGrid present={t.sources} />
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .detail { padding: 18px 20px 24px; overflow-y: auto; height: 100%; }
  .cover {
    width: 100%;
    aspect-ratio: 1;
    background: var(--bg-raised);
    border-radius: 4px;
    margin-bottom: 14px;
    display: flex; align-items: center; justify-content: center;
    color: var(--text-subtle); font-size: 11px;
    border: 1px solid var(--border);
  }
  .title {
    font-size: 15px;
    font-weight: 600;
    color: var(--text);
    margin-bottom: 2px;
    line-height: 1.3;
  }
  .artist {
    color: var(--text-muted);
    font-size: 13px;
    margin-bottom: 14px;
  }

  .cta-row { margin-bottom: 16px; }
  .add-btn {
    width: 100%;
    background: var(--accent);
    border: 1px solid var(--accent);
    color: #fff;
    padding: 7px 12px;
    border-radius: 4px;
    font-size: 13px;
    font-family: inherit;
    font-weight: 500;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
  }
  .add-btn:hover { background: var(--accent-strong); }
  .kbd-hint {
    font-size: 11px;
    color: rgba(255, 255, 255, 0.7);
    font-family: var(--font-mono);
    border: 1px solid rgba(255, 255, 255, 0.3);
    border-radius: 2px;
    padding: 0 4px;
    margin-left: 4px;
  }

  .tracklist {
    margin-top: 18px;
    border-top: 1px solid var(--border);
    padding-top: 12px;
  }
  .tracklist-header {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-subtle);
    font-weight: 600;
    margin-bottom: 6px;
  }
  .track-row {
    display: grid;
    grid-template-columns: 28px 1fr 48px 56px;
    gap: 10px;
    padding: 4px 0;
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
  .track-row:hover { background: var(--bg-row-hover); }
  .position {
    color: var(--text-subtle);
    font-family: var(--font-mono);
    font-size: 11px;
  }
  .track-title {
    color: var(--text);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .track-dur {
    color: var(--text-subtle);
    font-family: var(--font-mono);
    font-size: 11px;
    text-align: right;
  }
</style>
