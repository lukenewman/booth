<script lang="ts">
  import { recorder } from '$lib/stores/recorder.svelte';
  import { player } from '$lib/stores/player.svelte';

  let {
    release,
    onExpand,
  }: { release: { title: string; artist: string }; onExpand: () => void } = $props();

  const phase = $derived(recorder.phase);

  function fmt(ms: number): string {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  // The pill stands in for the minimized overlay during the capture phases only,
  // so phase is always one of recording / preview / analyzing here.
  const status = $derived(
    phase === 'recording'
      ? fmt(recorder.elapsedMs)
      : phase === 'analyzing'
        ? 'Splitting…'
        : `side ${recorder.takes.length + 1} ready`,
  );
</script>

<button
  class="pill"
  class:with-player={!!player.nowPlaying}
  onclick={onExpand}
  title="Expand recording"
>
  <span class="dot" class:live={phase === 'recording'}></span>
  <span class="status">{status}</span>
  <span class="sep">·</span>
  <span class="release">{release.artist} — {release.title}</span>
  <span class="expand">⤢</span>
</button>

<style>
  .pill {
    position: fixed;
    left: 16px;
    bottom: 16px;
    z-index: 40;
    display: flex;
    align-items: center;
    gap: 8px;
    max-width: 360px;
    padding: 8px 12px;
    border: 1px solid var(--border-strong);
    border-radius: 999px;
    background: var(--bg-raised);
    color: inherit;
    font-family: inherit;
    font-size: 12px;
    cursor: pointer;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  }
  /* Lift above the PlayerBar when a track is loaded. Derived from the bar's
     own height token so growing the bar can't leave the pill overlapping it. */
  .pill.with-player {
    bottom: calc(var(--player-bar-h) + 16px);
  }
  .pill:hover {
    border-color: #c0392b;
  }
  .dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: #e53935;
    flex: none;
    opacity: 0.7;
  }
  .dot.live {
    animation: pulse 1.2s ease-in-out infinite;
  }
  @keyframes pulse {
    0%,
    100% {
      opacity: 0.35;
    }
    50% {
      opacity: 1;
    }
  }
  .status {
    font-variant-numeric: tabular-nums;
    color: #e53935;
    flex: none;
  }
  .sep {
    opacity: 0.4;
    flex: none;
  }
  .release {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    opacity: 0.85;
  }
  .expand {
    opacity: 0.6;
    flex: none;
  }
</style>
