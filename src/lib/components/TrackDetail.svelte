<script lang="ts">
  import SourcePanel from './SourcePanel.svelte';
  import TapTempo from './TapTempo.svelte';
  import { PITCH_RANGES } from '$lib/pitch';
  import { bpmProviderLabel, formatBpm, formatBpmRange, type ResolvedBpm } from '$lib/bpm';

  interface SourceLink { source: string; external_id: string; external_url: string | null; match_method: string; }
  interface Facet { source: string; key: string; value: string; }
  // thumb_url was omitted here while the slot rendered a hardcoded "cov"
  // placeholder — getTrackDetail has always returned it on the release row.
  interface ParentRelease {
    id: string;
    title: string;
    artist: string;
    year: number | null;
    thumb_url?: string | null;
    cover_url?: string | null;
  }
  interface Track { id: string; title: string; artist: string; duration_ms: number | null; }
  interface SourceMeta { id: string; name: string; isStub: boolean; }

  let {
    track,
    sources,
    facets,
    release,
    bpm = null,
    sourceMeta,
    onReleaseSelect,
  }: {
    track: Track;
    sources: SourceLink[];
    facets: Facet[];
    release: ParentRelease | null;
    bpm?: ResolvedBpm | null;
    sourceMeta: SourceMeta[];
    onReleaseSelect?: (releaseId: string) => void;
  } = $props();

  /**
   * A tap saved here should show immediately rather than waiting for the pane
   * to be re-fetched. Keyed by track id so the override cannot bleed onto the
   * next track when the same component instance is reused.
   */
  let override = $state<{ id: string; bpm: ResolvedBpm | null } | null>(null);
  const shownBpm = $derived(
    override && override.id === track.id ? override.bpm : bpm,
  );

  async function clearTap() {
    const res = await fetch(`/api/library/tracks/${track.id}/bpm`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bpm: null }),
    });
    if (res.ok) override = { id: track.id, bpm: null };
  }

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

  const ALL_SOURCE_IDS = ['discogs', 'local', 'rekordbox', 'plex'];

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

  {#if shownBpm}
    <!-- The detail pane is the one surface with room to answer "what can I mix
         this with" in full, so both fader ranges are spelled out rather than
         only the one the player happens to be set to. -->
    <div class="tempo">
      <div class="tempo-head">
        <span class="tempo-value">{formatBpm(shownBpm.value)}</span>
        <span class="tempo-unit">BPM</span>
        <span class="tempo-src">{bpmProviderLabel(shownBpm.provider)}</span>
      </div>
      {#each PITCH_RANGES as range}
        <div class="tempo-row">
          <span class="tempo-range">±{range}%</span>
          <span class="tempo-span">{formatBpmRange(shownBpm.value, range)}</span>
        </div>
      {/each}
      {#if shownBpm.provider === 'tapped'}
        <!-- Tapping only fills blanks, so clearing is how you re-measure. -->
        <button class="tempo-clear" onclick={clearTap}>clear and re-tap</button>
      {/if}
    </div>
  {:else}
    <TapTempo
      trackId={track.id}
      onSaved={(value) => (override = { id: track.id, bpm: { value, provider: 'tapped' } })}
    />
  {/if}

  {#if release}
    <button class="parent-card" onclick={() => onReleaseSelect?.(release.id)}>
      <div class="parent-cover">
        {#if release.thumb_url ?? release.cover_url}
          <img src={release.thumb_url ?? release.cover_url} alt="" loading="lazy">
        {/if}
      </div>
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
      <!-- Only sources that actually contribute. Stubs used to render a
           "not implemented" card each, which meant Rekordbox and Plex took up
           half the pane to say nothing. Written as a link check rather than a
           name blocklist, so an implemented source appears on its own. -->
      {#if link}
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
  .tempo {
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 8px 10px;
    margin-bottom: 12px;
  }
  .tempo-head { display: flex; align-items: baseline; gap: 5px; }
  .tempo-value {
    font-size: 18px;
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
    color: var(--text);
    line-height: 1;
  }
  .tempo-unit { font-size: 10px; color: var(--text-muted); letter-spacing: 0.05em; }
  .tempo-src { margin-left: auto; font-size: 10px; color: var(--text-subtle); }
  .tempo-row {
    display: flex;
    justify-content: space-between;
    font-size: 11px;
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
    color: var(--text-subtle);
    margin-top: 3px;
  }
  .tempo-span { color: var(--text-muted); }
  .tempo-clear {
    margin-top: 6px;
    font-size: 10px;
    color: var(--text-subtle);
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
  }
  .tempo-clear:hover { color: var(--text-muted); }

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
  .parent-cover img { width: 100%; height: 100%; object-fit: cover; display: block; border-radius: 3px; }
  .parent-cover {
    width: 48px; height: 48px;
    overflow: hidden;
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
