<script lang="ts">
  import { untrack } from 'svelte';
  import SourceGrid from './SourceGrid.svelte';
  import StarButton from './StarButton.svelte';
  import TrackNote from './TrackNote.svelte';
  import { annotations } from '$lib/stores/annotations.svelte';
  import { player } from '$lib/stores/player.svelte';
  import { translucentDragImage } from '$lib/dnd';
  import { trackPlayState, transportGlyph, transportLabel } from '$lib/playback';
  import type { PlaybackContext } from '$lib/queue';

  interface SourceLink { source: string; external_id: string; external_url: string | null; match_method: string; }
  interface Track {
    id: string;
    title: string;
    position: string | null;
    starred_at?: string | null;
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
    vetted_at?: string | null;
  }
  interface Identifier { type: string; value: string; description: string | null; }

  let {
    release,
    sources,
    tracks,
    notes = null,
    identifiers = [],
    addCta = null,
    onTrackSelect,
    onArtistSelect,
    onRecord,
    onVet,
    recordDisabled = false,
  }: {
    release: Release;
    sources: SourceLink[];
    tracks: Track[];
    notes?: string | null;
    identifiers?: Identifier[];
    addCta?: {
      label: string;
      onClick: () => void;
      kbdHint?: string;
      variant?: 'primary' | 'quiet';
    } | null;
    onTrackSelect?: (trackId: string) => void;
    onArtistSelect?: (artistId: string) => void;
    onRecord?: () => void;
    onVet?: (releaseId: string, next: boolean) => void;
    recordDisabled?: boolean;
  } = $props();

  // Playing from a tracklist queues the rest of the release. Filtered to
  // playable tracks so `next` can never land on something with no audio.
  const playableTracks = $derived(tracks.filter((t) => t.canPlay));
  const isVetted = $derived(annotations.isVetted(release.id));

  /** The one track whose note editor is open, if any. */
  let editingTrackId = $state<string | null>(null);

  // Detail can be reached by deep link with no list page behind it, so the
  // tracklist payload is its own hydration source for the star state.
  //
  // Depend on the payload and nothing else. `seed()` reads the annotation Sets
  // to diff against, so without `untrack` this effect lists its own output as
  // a dependency: an optimistic star retriggers it, the stale payload (whose
  // starred_at is still null) is re-applied, and the toggle silently reverts —
  // the star only appears after a reload. The list path has never had this bug
  // because the controller hydrates from `loadList`, outside any effect.
  $effect(() => {
    const payloadTracks = tracks;
    const payloadRelease = release;
    untrack(() => {
      annotations.hydrateTracks(payloadTracks);
      annotations.hydrateNotes(payloadTracks);
      annotations.hydrateReleases([payloadRelease]);
    });
  });
  const releaseCtx = $derived({
    kind: 'release',
    releaseId: release.id,
    ids: playableTracks.map((t) => t.id),
  } as PlaybackContext);
  const releaseSeed = $derived(
    playableTracks.map((t) => ({
      trackId: t.id,
      title: t.title,
      artist: release.artist,
      thumbUrl: release.thumb_url,
      releaseId: release.id,
    })),
  );

  const hasDiscogs = $derived(sources.some((s) => s.source === 'discogs'));
  const hasIdentifyingInfo = $derived(!!notes || identifiers.length > 0);
  const discogsUrl = $derived(
    sources.find((s) => s.source === 'discogs')?.external_url ?? null,
  );

  function durationLabel(ms: number | null): string {
    if (!ms) return '—';
    const s = Math.round(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  const sourcesById = $derived(new Map(sources.map((s) => [s.source, s])));

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
    <div class="title-row">
      <div class="title">{release.title}</div>
      <!-- Inline with the title rather than stacked under the header: which
           sources contribute is an attribute of the release, and it reads as
           one fact alongside the name instead of a separate block. -->
      <SourceGrid present={sources.map((src) => src.source)} />
    </div>
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
    {#if discogsUrl}
      <a class="discogs-link" href={discogsUrl} target="_blank" rel="noreferrer">View on Discogs ↗</a>
    {/if}
  </div>

  {#if tracks.length > 0}
    <div class="tracklist">
      <div class="tracklist-header">Tracks ({tracks.length})</div>
      {#each tracks as t}
        {@const playState = trackPlayState(t.id, player.nowPlaying?.trackId, player.isPlaying)}
        {@const isLoaded = playState !== 'idle'}
        <div class="track">
        <button
          class="track-row"
          class:playing={isLoaded}
          type="button"
          draggable="true"
          ondragstart={(e) => { e.dataTransfer?.setData('application/x-booth-track', t.id); if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy'; if (e.currentTarget instanceof HTMLElement) translucentDragImage(e, e.currentTarget); }}
          onclick={(e) => {
            if (e.detail === 0) { onTrackSelect?.(t.id); return; }
            // Real click opens the note editor. Double-click-to-play is gone —
            // the transport in the index cell covers playback, which frees this
            // gesture without the click/dblclick race a delayed handler needs.
            e.stopPropagation();
            editingTrackId = t.id;
          }}
        >
          <StarButton trackId={t.id} />
          <!-- Index and transport share one cell. The number is the resting
               state; the transport takes over on hover and stays put while the
               track is playing or paused, so a loaded track is identifiable
               without hovering. Both sit in the same grid cell, so the swap
               costs no layout shift. -->
          <span class="index" class:loaded={isLoaded}>
            <span class="idx-num">{t.position ?? ''}</span>
          {#if t.canPlay}
            <span
              class="idx-transport"
              role="button"
              tabindex="-1"
              aria-label={transportLabel(playState, t.title)}
              onclick={(e) => {
                e.stopPropagation();
                if (playState === 'playing') player.pause();
                else if (playState === 'paused') player.resume();
                else player.playFrom(releaseCtx, t.id, { trackId: t.id, title: t.title, artist: release.artist, thumbUrl: release.thumb_url, releaseId: release.id }, releaseSeed);
              }}
              onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.currentTarget.click(); } }}
              ondblclick={(e) => e.stopPropagation()}
            >{transportGlyph(playState)}</span>
          {/if}
          </span>
          <span class="track-title" title={t.title}>{t.title}</span>
          <span class="track-dur">{durationLabel(t.duration_ms)}</span>
        </button>
        <TrackNote
          trackId={t.id}
          editing={editingTrackId === t.id}
          onRequestEdit={() => (editingTrackId = t.id)}
          onDone={() => (editingTrackId = null)}
        />
        </div>
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

  {#if onVet}
    <div class="cta-row vet-row">
      {#if isVetted}
        <button class="cta-btn vet-btn done" onclick={() => onVet?.(release.id, false)}>
          Vetted ✓<span class="kbd-hint quiet">undo</span>
        </button>
      {:else}
        <button class="cta-btn vet-btn" onclick={() => onVet?.(release.id, true)}>
          Mark vetted<span class="kbd-hint">v</span>
        </button>
      {/if}
    </div>
  {/if}

  {#if hasIdentifyingInfo}
    <div class="identify">
      {#if identifiers.length > 0}
        <div class="identify-header">Barcode & identifiers</div>
        <dl class="identifiers">
          {#each identifiers as id}
            <div class="identifier">
              <dt>{id.type}</dt>
              <dd>
                <span class="id-value">{id.value}</span>
                {#if id.description}<span class="id-desc">{id.description}</span>{/if}
              </dd>
            </div>
          {/each}
        </dl>
      {/if}
      {#if notes}
        <div class="identify-header notes-header">Notes</div>
        <div class="notes">{notes}</div>
      {/if}
    </div>
  {/if}

  {#if hasDiscogs && onRecord}
    <div class="cta-row">
      <button
        class="record-cta"
        onclick={onRecord}
        disabled={recordDisabled}
        title={recordDisabled ? 'Finish the current recording first' : undefined}
      >⏺ Record from vinyl</button>
    </div>
  {/if}

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
  .title-row {
    display: flex;
    align-items: baseline;
    gap: 10px;
    min-width: 0;
  }
  /* Title takes the slack so the source dots sit on the trailing edge rather
     than trailing the title. min-width:0 lets a long title ellipsize instead
     of pushing the dots out of the pane. */
  .title-row .title { flex: 1 1 auto; min-width: 0; }
  .title-row > :global(:not(.title)) { flex: 0 0 auto; }

  .vet-row { margin-top: 6px; }
  .vet-btn {
    background: transparent;
    border: 1px solid var(--border-strong);
    color: var(--text-muted);
  }
  .vet-btn:hover { color: var(--text); border-color: var(--text-subtle); }
  /* Toggling back is deliberate: mis-vetting must be undoable without a
     database edit. */
  .vet-btn.done { color: var(--text-muted); border-color: var(--border); }

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
  .discogs-link {
    display: inline-block;
    margin-top: 6px;
    font-size: 12px;
    color: var(--accent);
    text-decoration: none;
  }
  .discogs-link:hover { text-decoration: underline; }

  .cta-row { margin-bottom: 16px; }
  .record-cta {
    width: 100%;
    padding: 7px 12px;
    border-radius: 4px;
    font-size: 13px;
    font-family: inherit;
    font-weight: 500;
    cursor: pointer;
    background: none;
    border: 1px solid #c0392b;
    color: #c0392b;
  }
  .record-cta:hover:not(:disabled) { background: #c0392b22; }
  .record-cta:disabled {
    opacity: 0.4;
    cursor: not-allowed;
    border-color: var(--border-strong);
    color: var(--text-muted);
  }
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
    grid-template-columns: 14px 22px minmax(0, 1fr) 44px;
    gap: 8px;
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
  .track { padding: 1px 0; }
  .track:has(:global(.note-input)) { padding-bottom: 4px; }
  .track-row:hover { background: var(--bg-row-hover); }

  /* Index and transport occupy the same grid cell so swapping them shifts
     nothing. The number rests; the transport takes over on hover, and holds
     its place while loaded so a playing or paused track stays identifiable
     with the pointer elsewhere. */
  /* The star's own horizontal padding was landing on the left of the index and
     nowhere on its right, so the number sat 4px off-centre between the two.
     Zero side padding here makes the button box equal its glyph, which leaves
     the index's own centring symmetric. */
  .track-row :global(button.star) { padding: 2px 0; }

  .index {
    display: grid;
    place-items: center;
    font-size: 11px;
  }
  .idx-num, .idx-transport {
    grid-area: 1 / 1;
    user-select: none;
    transition: opacity 0.1s;
  }
  .idx-num {
    color: var(--text-subtle);
    font-family: var(--font-mono);
  }
  .idx-transport {
    color: var(--text-muted);
    font-size: 12px;
    cursor: pointer;
    opacity: 0;
  }
  .track-row:hover .idx-transport,
  .idx-transport:focus-visible,
  .index.loaded .idx-transport { opacity: 1; }
  .track-row:hover .idx-num,
  .index.loaded .idx-num { opacity: 0; }
  .index.loaded .idx-transport { color: var(--accent); }
  .idx-transport:hover { color: var(--accent-strong); }

  .track-title {
    color: var(--text);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    min-width: 0;
  }
  .track-dur {
    color: var(--text-subtle);
    font-family: var(--font-mono);
    font-size: 11px;
    text-align: right;
  }
  .track-row.playing .track-title { color: var(--accent); }

  .identify {
    margin-top: 18px;
    margin-bottom: 18px;
    border-top: 1px solid var(--border);
    padding-top: 12px;
  }
  .identify-header {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-subtle);
    font-weight: 600;
    margin-bottom: 8px;
  }
  .identify-header.notes-header { margin-top: 14px; }
  .identifiers { margin: 0; }
  .identifier {
    display: grid;
    grid-template-columns: 120px 1fr;
    gap: 10px;
    padding: 3px 0;
    align-items: baseline;
  }
  .identifier dt {
    font-size: 11px;
    color: var(--text-subtle);
    line-height: 1.4;
  }
  .identifier dd {
    margin: 0;
    font-size: 12px;
    line-height: 1.4;
  }
  .id-value {
    font-family: var(--font-mono);
    color: var(--text);
    word-break: break-word;
  }
  .id-desc {
    color: var(--text-subtle);
    margin-left: 6px;
  }
  .notes {
    font-size: 12px;
    line-height: 1.5;
    color: var(--text-muted);
    white-space: pre-wrap;
    word-break: break-word;
  }

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
