<script lang="ts">
  import { player } from '$lib/stores/player.svelte';
  import StarButton from './StarButton.svelte';
  import { PREV_RESTART_THRESHOLD_S } from '$lib/queue';
  import { formatPitch } from '$lib/pitch';
  import { formatBpm, formatBpmRange, pitchedBpm } from '$lib/bpm';

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

  const pitchLabel = $derived(formatPitch(player.pitchPercent));

  // Resting tempo. Absent for most tracks until more BPM sources land, so every
  // readout below is gated on it rather than rendering a dash.
  const baseBpm = $derived(player.nowPlaying?.bpm?.value ?? null);
  const liveBpm = $derived(baseBpm === null ? null : pitchedBpm(baseBpm, player.pitchPercent));
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

    <!-- Always visible, unlike the row stars: this is the affordance for when
         playback has advanced past whatever row is selected, so hover-gating
         it would defeat the purpose. -->
    <div class="now-star">
      <StarButton trackId={player.nowPlaying.trackId} size={16} />
    </div>

    <div class="transport">
      <div class="buttons">
        <button
          class="skip"
          onclick={() => player.prev()}
          disabled={!player.hasPrev && player.currentTime <= PREV_RESTART_THRESHOLD_S}
          aria-label="Previous track"
        >⏮</button>

        <button
          class="play-pause"
          onclick={() => (player.isPlaying ? player.pause() : player.resume())}
          aria-label={player.isPlaying ? 'Pause' : 'Play'}
        >
          {player.isPlaying ? '⏸' : '▶'}
        </button>

        <button
          class="skip"
          onclick={() => player.next()}
          disabled={!player.hasNext}
          aria-label="Next track"
        >⏭</button>
      </div>

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

    <div class="right-spacer">
      {#if baseBpm !== null && liveBpm !== null}
        <!-- Live tempo on top, because that is the number being mixed against;
             the resting value and the range the fader can reach sit under it. -->
        <div class="bpm" title="{formatBpm(baseBpm)} BPM {player.nowPlaying?.bpm?.provider === 'tag' ? 'from file tag' : player.nowPlaying?.bpm?.provider === 'rekordbox' ? 'from rekordbox' : 'analysed'}">
          <span class="bpm-live" class:pitched={player.pitchPercent !== 0}>{formatBpm(Math.round(liveBpm * 10) / 10)}</span>
          <span class="bpm-sub">
            {formatBpm(baseBpm)} · {formatBpmRange(baseBpm, player.pitchRange)}
          </span>
        </div>
      {/if}
      <div class="pitch">
        <span class="pitch-value" class:active={player.pitchPercent !== 0}>{pitchLabel}</span>
        <input
          class="fader"
          type="range"
          min={-player.pitchRange}
          max={player.pitchRange}
          step="0.1"
          value={player.pitchPercent}
          oninput={(e) => player.setPitch(Number((e.target as HTMLInputElement).value))}
          ondblclick={() => player.resetPitch()}
          aria-label="Pitch adjustment"
          title="Pitch — double-click to reset"
        />
        <button
          class="pitch-range"
          type="button"
          onclick={() => player.cyclePitchRange()}
          title="Toggle fader range"
          aria-label={`Fader range plus or minus ${player.pitchRange} percent`}
        >±{player.pitchRange}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .now-star { display: flex; align-items: center; flex: 0 0 auto; }
  .now-star :global(.star) { opacity: 1; }

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

  .buttons {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .skip {
    background: transparent;
    border: 0;
    color: var(--text-muted);
    font-size: 13px;
    padding: 0;
    width: 20px;
    height: 20px;
    line-height: 1;
    cursor: pointer;
  }
  .skip:hover:not(:disabled) { color: var(--text); }
  .skip:disabled { opacity: 0.3; cursor: default; }

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

  /* Balances the info column on the left so the transport stays centred, and
     hosts the pitch fader at its right edge. */
  .right-spacer {
    flex: 1;
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 14px;
  }

  .bpm {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 1px;
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
    line-height: 1.1;
  }
  .bpm-live {
    font-size: 15px;
    color: var(--text);
  }
  /* Off-centre, the big number is no longer the track's own tempo. */
  .bpm-live.pitched { color: var(--accent); }
  .bpm-sub {
    font-size: 9.5px;
    color: var(--text-subtle);
  }

  .pitch {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
  }

  .pitch-value {
    font-size: 10px;
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
    color: var(--text-subtle);
    min-width: 44px;
    text-align: center;
    line-height: 1;
  }
  /* Off-centre is a state worth noticing -- it survives track changes. */
  .pitch-value.active { color: var(--accent); }

  /* Vertical fader: a pitch control reads as a fader, not a scrubber.
     + is at the BOTTOM, matching a Technics 1200 — push the fader away from
     you to speed up. `direction: rtl` would put + at the top, which is the
     generic-slider convention and what this shipped as first. */
  .fader {
    writing-mode: vertical-lr;
    width: 3px;
    height: 44px;
    cursor: pointer;
    accent-color: var(--accent);
  }

  .pitch-range {
    background: transparent;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    color: var(--text-subtle);
    font-size: 9px;
    font-family: var(--font-mono);
    line-height: 1;
    padding: 2px 4px;
    cursor: pointer;
  }
  .pitch-range:hover { color: var(--text); border-color: var(--text-subtle); }

  /* The bar already runs out of room on a phone — the title and the end of the
     scrubber are cut off before any of this is added. Rather than push more
     content off the right edge, drop the tempo readout and the fader there and
     keep the spacer, so the transport stays where it was. A phone-sized player
     bar needs its own layout; this is not that. */
  @media (max-width: 768px) {
    .bpm, .pitch { display: none; }
  }
</style>
