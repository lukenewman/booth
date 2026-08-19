<script lang="ts">
  import { player } from '$lib/stores/player.svelte';

  let { onOpenRelease }: { onOpenRelease?: (releaseId: string) => void } = $props();

  function formatTime(s: number): string {
    if (!isFinite(s) || s < 0) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${String(sec).padStart(2, '0')}`;
  }

  let scrubbing = $state(false);
  let scrubValue = $state(0);

  function onScrubStart() {
    scrubbing = true;
    scrubValue = player.currentTime;
  }
  function onScrubMove(e: Event) {
    scrubValue = Number((e.target as HTMLInputElement).value);
  }
  function onScrubEnd(e: Event) {
    player.seekTo(Number((e.target as HTMLInputElement).value));
    scrubbing = false;
  }

  // Artwork is only a control when there's somewhere to go: a track with no
  // parent release (or no handler wired) keeps the plain, non-interactive image.
  const releaseId = $derived(player.nowPlaying?.releaseId ?? null);
  const artIsLink = $derived(!!releaseId && !!onOpenRelease);
</script>

{#if player.nowPlaying}
  <div class="bar">
    {#if artIsLink}
      <button
        class="art art-btn"
        type="button"
        onclick={() => releaseId && onOpenRelease?.(releaseId)}
        title="Open release"
        aria-label="Open release detail"
      >
        {#if player.nowPlaying.thumbUrl}
          <img src={player.nowPlaying.thumbUrl} alt="" aria-hidden="true" />
        {:else}
          <span class="art-placeholder"></span>
        {/if}
      </button>
    {:else if player.nowPlaying.thumbUrl}
      <img class="art" src={player.nowPlaying.thumbUrl} alt="" aria-hidden="true" />
    {:else}
      <div class="art art-placeholder"></div>
    {/if}

    <div class="info">
      <span class="title">{player.nowPlaying.title}</span>
      <span class="artist">{player.nowPlaying.artist}</span>
    </div>

    <div class="transport">
      <button
        class="play-pause"
        onclick={() => (player.isPlaying ? player.pause() : player.resume())}
        aria-label={player.isPlaying ? 'Pause' : 'Play'}
      >
        {player.isPlaying ? '⏸' : '▶'}
      </button>

      <div class="seek-row">
        <span class="time">{formatTime(player.currentTime)}</span>
        <input
          class="scrubber"
          type="range"
          min="0"
          max={player.duration || 1}
          step="0.5"
          value={scrubbing ? scrubValue : player.currentTime}
          onmousedown={onScrubStart}
          oninput={onScrubMove}
          onchange={onScrubEnd}
          aria-label="Seek"
        />
        <span class="time">{formatTime(player.duration)}</span>
      </div>
    </div>

    <div class="right-spacer"></div>
  </div>
{/if}

<style>
  .bar {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 0 16px;
    height: var(--player-bar-h);
    background: var(--bg-raised);
    border-top: 1px solid var(--border-strong);
    flex-shrink: 0;
  }

  .art {
    width: var(--player-art);
    height: var(--player-art);
    border-radius: 3px;
    object-fit: cover;
    flex-shrink: 0;
  }
  .art-placeholder {
    background: var(--bg-raised);
    border: 1px solid var(--border);
    display: block;
  }

  /* Artwork-as-button: no chrome, just the image plus an affordance on hover. */
  .art-btn {
    padding: 0;
    border: 0;
    background: transparent;
    cursor: pointer;
    overflow: hidden;
    display: block;
  }
  .art-btn img,
  .art-btn .art-placeholder {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
    border-radius: 3px;
  }
  .art-btn:hover { outline: 1px solid var(--accent); outline-offset: 1px; }
  .art-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

  .info {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1;
  }
  .title {
    font-size: 13px;
    font-weight: 500;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .artist {
    font-size: 11px;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Play/pause sits above the seek row, centred over it. */
  .transport {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
  }

  .seek-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .play-pause {
    background: transparent;
    border: 0;
    color: var(--accent);
    font-size: 18px;
    padding: 0;
    width: 28px;
    height: 20px;
    text-align: center;
    line-height: 1;
    cursor: pointer;
  }
  .play-pause:hover { color: var(--accent-strong); }

  .time {
    font-size: 11px;
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
    color: var(--text-muted);
    min-width: 32px;
    text-align: right;
  }
  .time:last-of-type { text-align: left; }

  .scrubber {
    width: 260px;
    height: 3px;
    cursor: pointer;
    accent-color: var(--accent);
  }

  .right-spacer { flex: 1; }
</style>
