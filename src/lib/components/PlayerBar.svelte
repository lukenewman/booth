<script lang="ts">
  import { player } from '$lib/stores/player.svelte';

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
</script>

{#if player.nowPlaying}
  <div class="bar">
    {#if player.nowPlaying.thumbUrl}
      <img class="thumb" src={player.nowPlaying.thumbUrl} alt="" aria-hidden="true" />
    {:else}
      <div class="thumb thumb-placeholder"></div>
    {/if}
    <div class="info">
      <span class="title">{player.nowPlaying.title}</span>
      <span class="artist">{player.nowPlaying.artist}</span>
    </div>

    <div class="controls">
      <button
        class="play-pause"
        onclick={() => player.isPlaying ? player.pause() : player.resume()}
        aria-label={player.isPlaying ? 'Pause' : 'Play'}
      >
        {player.isPlaying ? '⏸' : '▶'}
      </button>

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

    <div class="right-spacer"></div>
  </div>
{/if}

<style>
  .bar {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 0 16px;
    height: 48px;
    background: var(--bg-raised);
    border-top: 1px solid var(--border-strong);
    flex-shrink: 0;
  }

  .thumb {
    width: 36px;
    height: 36px;
    border-radius: 2px;
    object-fit: cover;
    flex-shrink: 0;
  }
  .thumb-placeholder {
    background: var(--bg-raised);
    border: 1px solid var(--border);
  }

  .info {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1;
  }
  .title {
    font-size: 12px;
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

  .controls {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }

  .play-pause {
    background: transparent;
    border: 0;
    color: var(--accent);
    font-size: 16px;
    padding: 0;
    width: 24px;
    text-align: center;
    line-height: 1;
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
    width: 200px;
    height: 3px;
    cursor: pointer;
    accent-color: var(--accent);
  }

  .right-spacer { flex: 1; }
</style>
