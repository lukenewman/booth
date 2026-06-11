<script lang="ts">
  import SourcePanel from './SourcePanel.svelte';
  import SourceGrid from './SourceGrid.svelte';
  import { player } from '$lib/stores/player.svelte';

  interface SourceLink { source: string; external_id: string; external_url: string | null; match_method: string; }
  interface Facet { source: string; key: string; value: string; }
  interface Track {
    id: string;
    title: string;
    position: string | null;
    duration_ms: number | null;
    sources: string[];
    canPlay: boolean;
  }
  interface Release {
    id: string;
    title: string;
    artist: string;
    artist_id?: string | null;
    year: number | null;
    thumb_url?: string | null;
    cover_url?: string | null;
    country?: string | null;
    label?: string | null;
    catno?: string | null;
    format?: string | null;
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
    onArtistSelect,
  }: {
    release: Release;
    sources: SourceLink[];
    facets: Facet[];
    tracks: Track[];
    sourceMeta: SourceMeta[];
    addCta?: {
      label: string;
      onClick: () => void;
      kbdHint?: string;
      variant?: 'primary' | 'quiet';
    } | null;
    onTrackSelect?: (trackId: string) => void;
    onArtistSelect?: (artistId: string) => void;
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
  const ALL_SOURCE_IDS = ['discogs', 'local', 'rekordbox', 'plex'];

  const sourcesById = $derived(new Map(sources.map((s) => [s.source, s])));
  const metaById = $derived(new Map(sourceMeta.map((m) => [m.id, m])));

  interface ReleaseVideo { url: string; title: string; youtubeId: string | null; }
  let videos = $state<ReleaseVideo[]>([]);
  let videosLoading = $state(false);
  let videosError = $state(false);

  // Lazy-load Discogs videos when a release with a Discogs link is shown.
  $effect(() => {
    const rid = release.id;
    const hasDiscogs = sources.some((s) => s.source === 'discogs');
    videos = [];
    videosError = false;
    videosLoading = false;
    if (!hasDiscogs) return;

    let cancelled = false;
    videosLoading = true;
    fetch(`/api/sources/discogs/releases/${rid}/videos`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => { if (!cancelled) videos = data.videos ?? []; })
      .catch(() => { if (!cancelled) videosError = true; })
      .finally(() => { if (!cancelled) videosLoading = false; });
    return () => { cancelled = true; };
  });
</script>

<div class="detail">
  {#if release.artist_id}
    <button class="breadcrumb" onclick={() => onArtistSelect?.(release.artist_id!)}>
      ← {release.artist}
    </button>
  {/if}
  {#if release.cover_url}
    <img class="cover" src={release.cover_url} alt="{release.title} cover" loading="lazy">
  {:else}
    <div class="cover"></div>
  {/if}
  <div class="release-header">
    <div class="title">{release.title}</div>
    <div class="artist">{release.artist}{release.year ? ` · ${release.year}` : ''}</div>
    {#if release.label || release.catno || release.country || release.format}
      <div class="release-meta">
        {[
          [release.label, release.catno].filter(Boolean).join(' – '),
          release.country,
          release.format,
        ].filter(Boolean).join(' · ')}
      </div>
    {/if}
  </div>

  {#if tracks.length > 0}
    <div class="tracklist">
      <div class="tracklist-header">Tracks ({tracks.length})</div>
      {#each tracks as t}
        {@const isPlaying = player.nowPlaying?.trackId === t.id}
        <button
          class="track-row"
          class:playing={isPlaying}
          type="button"
          onclick={(e) => { if (e.detail > 0) e.stopPropagation(); else onTrackSelect?.(t.id); }}
          ondblclick={() => { if (t.canPlay) player.play({ trackId: t.id, title: t.title, artist: release.artist, thumbUrl: release.thumb_url }); }}
        >
          <span class="position">{t.position ?? ''}</span>
          <span class="track-title">{t.title}</span>
          <span class="track-dur">{durationLabel(t.duration_ms)}</span>
          <SourceGrid present={t.sources} />
          <span
            class="info-icon"
            class:playing={isPlaying}
            role="button"
            tabindex="-1"
            aria-label="View details for {t.title}"
            onclick={(e) => { e.stopPropagation(); onTrackSelect?.(t.id); }}
            onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); onTrackSelect?.(t.id); } }}
            ondblclick={(e) => e.stopPropagation()}
          >{isPlaying ? '▶' : '›'}</span>
        </button>
      {/each}
    </div>
  {/if}

  {#if addCta}
    <div class="cta-row">
      {#if addCta.variant === 'quiet'}
        <button class="cta-btn remove-btn" onclick={addCta.onClick}>
          {addCta.label}
          {#if addCta.kbdHint}<span class="kbd-hint quiet">{addCta.kbdHint}</span>{/if}
        </button>
      {:else}
        <button class="cta-btn add-btn" onclick={addCta.onClick}>
          {addCta.label}
          {#if addCta.kbdHint}<span class="kbd-hint">{addCta.kbdHint}</span>{/if}
        </button>
      {/if}
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

  {#if sourcesById.has('discogs')}
    <div class="videos">
      <div class="videos-header">
        Videos{#if videos.length}<span class="videos-count"> ({videos.length})</span>{/if}
      </div>
      {#if videosLoading}
        <div class="videos-note">Loading…</div>
      {:else if videosError}
        <div class="videos-note">Couldn’t load videos.</div>
      {:else if videos.length === 0}
        <div class="videos-note">No videos on this release.</div>
      {:else}
        {#each videos as v (v.url)}
          <div class="video">
            {#if v.youtubeId}
              <iframe
                class="video-embed"
                src={`https://www.youtube-nocookie.com/embed/${v.youtubeId}`}
                title={v.title}
                loading="lazy"
                referrerpolicy="strict-origin-when-cross-origin"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowfullscreen
              ></iframe>
              <div class="video-title">{v.title}</div>
            {:else}
              <a class="video-link" href={v.url} target="_blank" rel="noopener noreferrer">{v.title} ↗</a>
            {/if}
          </div>
        {/each}
      {/if}
    </div>
  {/if}
</div>

<style>
  .detail { padding: 18px 20px 24px; overflow-y: auto; height: 100%; }
  .breadcrumb {
    background: transparent; border: 0; color: var(--text-muted);
    padding: 0 0 8px;
    font-family: inherit;
    font-size: 12px;
    cursor: pointer;
    display: block;
  }
  .breadcrumb:hover { color: var(--text); }
  .cover {
    width: 100%;
    aspect-ratio: 1;
    border-radius: 4px;
    margin-bottom: 14px;
    background: var(--bg-raised);
    border: 1px solid var(--border);
  }
  img.cover {
    object-fit: cover;
    display: block;
  }
  div.cover {
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-subtle);
    font-size: 11px;
  }
  .title {
    font-size: 15px;
    font-weight: 600;
    color: var(--text);
    margin-bottom: 2px;
    line-height: 1.3;
  }
  .release-header { margin-bottom: 14px; }
  .artist {
    color: var(--text-muted);
    font-size: 13px;
    margin-bottom: 4px;
  }
  .release-meta {
    font-size: 12px;
    color: var(--text-subtle);
    line-height: 1.4;
  }

  .cta-row { margin-bottom: 16px; }
  .cta-btn {
    width: 100%;
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
  .add-btn {
    background: var(--accent);
    border: 1px solid var(--accent);
    color: #fff;
  }
  .add-btn:hover { background: var(--accent-strong); }
  .remove-btn {
    background: transparent;
    border: 1px solid var(--border-strong);
    color: var(--text-muted);
    font-weight: 400;
  }
  .remove-btn:hover {
    border-color: var(--text-muted);
    color: var(--text);
  }
  .kbd-hint {
    font-size: 11px;
    color: rgba(255, 255, 255, 0.7);
    font-family: var(--font-mono);
    border: 1px solid rgba(255, 255, 255, 0.3);
    border-radius: 2px;
    padding: 0 4px;
    margin-left: 4px;
  }
  .kbd-hint.quiet {
    color: var(--text-subtle);
    border-color: var(--border-strong);
  }

  .tracklist {
    margin-top: 18px;
    margin-bottom: 18px;
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
    grid-template-columns: 28px 1fr 48px 56px 20px;
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
  .track-row .info-icon {
    color: transparent;
    font-size: 13px;
    text-align: center;
    cursor: pointer;
    user-select: none;
  }
  .track-row:hover .info-icon { color: var(--text-muted); }
  .track-row .info-icon.playing { color: var(--accent) !important; }
  .track-row.playing .track-title { color: var(--accent); }

  .videos {
    margin-top: 18px;
    border-top: 1px solid var(--border);
    padding-top: 12px;
  }
  .videos-header {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-subtle);
    font-weight: 600;
    margin-bottom: 10px;
  }
  .videos-count { color: var(--text-subtle); }
  .videos-note {
    font-size: 12px;
    color: var(--text-subtle);
    padding: 2px 0 6px;
  }
  .video { margin-bottom: 14px; }
  .video-embed {
    width: 100%;
    aspect-ratio: 16 / 9;
    border: 0;
    border-radius: 4px;
    display: block;
    background: var(--bg-raised);
  }
  .video-title {
    font-size: 11px;
    color: var(--text-muted);
    margin-top: 4px;
    line-height: 1.3;
  }
  .video-link {
    font-size: 12px;
    color: var(--accent);
    text-decoration: none;
  }
  .video-link:hover { text-decoration: underline; }
</style>
