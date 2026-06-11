<script lang="ts">
  import { recorder } from '$lib/stores/recorder.svelte';
  import ReviewSplits from './ReviewSplits.svelte';

  let {
    releaseId,
    releaseTitle,
    releaseArtist,
    onClose,
  }: { releaseId: string; releaseTitle: string; releaseArtist: string; onClose: () => void } =
    $props();

  let devices = $state<MediaDeviceInfo[]>([]);
  let deviceId = $state<string>('');
  let started = $state(false);

  async function loadDevices() {
    // Labels are only visible after permission is granted; grab a throwaway
    // stream first so the device dropdown is meaningful.
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
    } catch {
      /* error surfaces on start() */
    }
    devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
    deviceId = devices[0]?.deviceId ?? '';
  }
  $effect(() => {
    void loadDevices();
  });

  async function begin() {
    started = true;
    await recorder.start(releaseId, deviceId || undefined);
  }

  function fmt(ms: number): string {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
  function db(level: number): string {
    if (level <= 0.0001) return '−∞';
    return `${Math.round(20 * Math.log10(level))} dB`;
  }

  async function close() {
    await recorder.cancel();
    onClose();
  }

  const phase = $derived(recorder.phase);
</script>

<div class="record-overlay">
  <header>
    <span class="title">⏺ Recording · {releaseArtist} — {releaseTitle}</span>
    <button class="close" onclick={close}>✕</button>
  </header>

  {#if recorder.error}
    <div class="error">{recorder.error}</div>
  {/if}

  {#if phase === 'reviewing' || phase === 'committing' || phase === 'done'}
    <ReviewSplits onClose={close} />
  {:else}
    <div class="body">
      <div class="setup">
        {#if !started}
          <label class="label" for="dev">Input device</label>
          <select id="dev" bind:value={deviceId}>
            {#each devices as d}
              <option value={d.deviceId}>{d.label || 'Audio input'}</option>
            {/each}
          </select>
          <button class="primary" onclick={begin}>Open input</button>
        {:else}
          <div class="meters">
            <div class="meter">
              <span>L</span>
              <div class="bar"><div class="fill" style:width="{Math.min(100, recorder.levelL * 100)}%"></div></div>
              <span class="db">{db(recorder.levelL)}</span>
            </div>
            <div class="meter">
              <span>R</span>
              <div class="bar"><div class="fill" style:width="{Math.min(100, recorder.levelR * 100)}%"></div></div>
              <span class="db">{db(recorder.levelR)}</span>
            </div>
            <div class="cliplight" class:clipped={recorder.clipped}>{recorder.clipped ? 'CLIP' : 'no clip'}</div>
            <div class="rate">{recorder.sampleRate} Hz · 24-bit</div>
          </div>

          {#if phase === 'preview'}
            <div class="actions">
              <button class="rec" onclick={() => recorder.recordTake()}>⏺ Record side {recorder.takes.length + 1}</button>
              {#if recorder.takes.length > 0}
                <button class="primary" onclick={() => recorder.review()}>
                  No more sides → review {recorder.takes.length} take{recorder.takes.length === 1 ? '' : 's'}
                </button>
              {/if}
            </div>
          {:else if phase === 'recording'}
            <div class="actions">
              <span class="elapsed">⏺ {fmt(recorder.elapsedMs)}</span>
              <button class="primary" onclick={() => recorder.stopTake()}>⏹ Stop</button>
            </div>
          {:else if phase === 'analyzing'}
            <div class="actions"><span>Splitting…</span></div>
          {/if}

          {#if recorder.takes.length > 0 && phase === 'preview'}
            <ul class="takes">
              {#each recorder.takes as t, i}
                <li>
                  Take {i + 1} · {fmt(t.durationMs)} · {t.regions.filter((r) => r.trackId).length} tracks proposed{t.sideGuess
                    ? ` · side ${t.sideGuess}?`
                    : ''}
                </li>
              {/each}
            </ul>
          {/if}
        {/if}
      </div>

      <aside class="expected">
        <div class="label">Expected (from Discogs)</div>
        <ul>
          {#each recorder.expected as t}
            <li>
              <span class="pos">{t.discogsPosition ?? t.position}</span>
              {t.title}
              <span class="dur">{t.durationMs ? fmt(t.durationMs) : '(no duration)'}</span>
            </li>
          {/each}
        </ul>
      </aside>
    </div>
  {/if}
</div>

<style>
  .record-overlay {
    position: fixed;
    inset: 0;
    background: var(--bg, #111);
    z-index: 50;
    display: flex;
    flex-direction: column;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid #2a2a2a;
  }
  .body {
    display: flex;
    gap: 24px;
    padding: 20px;
    flex: 1;
    overflow: auto;
  }
  .setup {
    flex: 2;
    display: flex;
    flex-direction: column;
    gap: 16px;
    align-items: flex-start;
  }
  .expected {
    flex: 1;
    border-left: 1px solid #2a2a2a;
    padding-left: 16px;
    font-size: 13px;
  }
  .expected ul {
    list-style: none;
    padding: 0;
    line-height: 2;
  }
  .pos {
    opacity: 0.6;
    display: inline-block;
    width: 28px;
  }
  .dur {
    opacity: 0.5;
    margin-left: 8px;
  }
  .meters {
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 100%;
    max-width: 480px;
  }
  .meter {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .bar {
    flex: 1;
    height: 14px;
    background: #222;
    border-radius: 3px;
    overflow: hidden;
  }
  .fill {
    height: 100%;
    background: #2e7d32;
  }
  .db {
    width: 52px;
    font-size: 11px;
    opacity: 0.7;
    text-align: right;
  }
  .cliplight {
    font-size: 11px;
    opacity: 0.6;
  }
  .cliplight.clipped {
    color: #e53935;
    opacity: 1;
    font-weight: 700;
  }
  .rate {
    font-size: 11px;
    opacity: 0.5;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .rec {
    background: #c0392b;
    color: #fff;
    border: none;
    padding: 8px 16px;
    border-radius: 5px;
    cursor: pointer;
  }
  .primary {
    background: #2962ff;
    color: #fff;
    border: none;
    padding: 8px 16px;
    border-radius: 5px;
    cursor: pointer;
  }
  .elapsed {
    font-variant-numeric: tabular-nums;
    color: #e53935;
  }
  .takes {
    list-style: none;
    padding: 0;
    font-size: 13px;
    opacity: 0.8;
  }
  .error {
    background: #4a1f1f;
    color: #ffb4b4;
    padding: 8px 16px;
    font-size: 13px;
  }
  .close {
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    font-size: 16px;
  }
</style>
