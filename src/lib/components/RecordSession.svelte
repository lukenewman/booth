<script lang="ts">
  import { recorder } from '$lib/stores/recorder.svelte';
  import ReviewSplits from './ReviewSplits.svelte';

  let {
    releaseId,
    releaseTitle,
    releaseArtist,
    onClose,
    onMinimize,
  }: {
    releaseId: string;
    releaseTitle: string;
    releaseArtist: string;
    onClose: () => void;
    onMinimize: () => void;
  } = $props();

  let devices = $state<MediaDeviceInfo[]>([]);
  let deviceId = $state<string>('');
  let confirmingClose = $state(false);
  // Derived from the store (not local) so the overlay restores correctly after
  // being minimized + remounted mid-capture instead of resetting to the picker.
  const started = $derived(recorder.phase !== 'idle');

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
    // Only enumerate inputs for the setup screen; skip on a mid-capture remount.
    if (recorder.phase === 'idle') void loadDevices();
  });

  async function begin() {
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

  // Closing mid-session throws away captured audio, so confirm first — but only
  // when there's something to lose (a side mid-record or already-recorded takes;
  // never after a successful commit).
  const hasUnsavedCapture = $derived(
    recorder.phase !== 'done' &&
      (recorder.takes.length > 0 || recorder.phase === 'recording'),
  );
  const lostPhrase = $derived.by(() => {
    const n = recorder.takes.length;
    const parts: string[] = [];
    if (recorder.phase === 'recording') parts.push('the current side');
    if (n > 0) parts.push(`${n} recorded side${n === 1 ? '' : 's'}`);
    return parts.join(' + ');
  });
  function requestClose() {
    if (hasUnsavedCapture) confirmingClose = true;
    else void close();
  }

  const phase = $derived(recorder.phase);
  // Minimize is offered only during the capture phases (the long-running part);
  // split review/commit stays full-screen and focused.
  const canMinimize = $derived(
    phase === 'preview' || phase === 'recording' || phase === 'analyzing',
  );

  // Live waveform: a constant-zoom scrolling window — the most recent
  // WINDOW_MS of audio at a fixed hops-per-pixel, newest anchored at the right.
  // Fills from the left until the window is full, then scrolls.
  let liveCanvas = $state<HTMLCanvasElement>();
  const LW = 1000;
  const LH = 72;
  const HOP_MS = 50; // matches the store's ~50ms live hop

  // Waveform zoom: 'full' compresses the whole take to width; the numbers are a
  // constant-zoom scrolling window of that many seconds.
  type WaveZoom = 'full' | '30' | '60' | '120';
  const ZOOMS: { id: WaveZoom; label: string }[] = [
    { id: 'full', label: 'Full' },
    { id: '30', label: '30s' },
    { id: '60', label: '60s' },
    { id: '120', label: '120s' },
  ];
  let waveZoom = $state<WaveZoom>('60');

  function drawLive(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, LW, LH);
    ctx.fillStyle = '#161616';
    ctx.fillRect(0, 0, LW, LH);
    const peaks = recorder.livePeaks;
    const n = peaks.length;
    if (n === 0) return;
    ctx.fillStyle = '#3a86ff';

    if (waveZoom === 'full') {
      // Compress the whole take-so-far across the full width.
      for (let px = 0; px < LW; px++) {
        const from = Math.floor((px / LW) * n);
        const to = Math.floor(((px + 1) / LW) * n);
        let m = 0;
        for (let i = from; i <= to && i < n; i++) if (peaks[i] > m) m = peaks[i];
        const h = m * (LH - 6);
        ctx.fillRect(px, (LH - h) / 2, 1, h);
      }
      return;
    }

    // Constant-zoom scrolling window: the most recent N seconds, newest at the
    // right. Fills from the left until the window is full, then scrolls.
    const windowHops = (Number(waveZoom) * 1000) / HOP_MS;
    const hopsPerPixel = windowHops / LW;
    const visibleStart = Math.max(0, n - windowHops);
    const visibleCount = n - visibleStart;
    const usedW = Math.min(LW, (visibleCount / windowHops) * LW);
    for (let px = 0; px < usedW; px++) {
      const from = visibleStart + Math.floor(px * hopsPerPixel);
      const to = visibleStart + Math.floor((px + 1) * hopsPerPixel);
      let m = 0;
      for (let i = from; i <= to && i < n; i++) if (peaks[i] > m) m = peaks[i];
      const h = m * (LH - 6);
      ctx.fillRect(px, (LH - h) / 2, 1, h);
    }
  }
  $effect(() => {
    if (phase !== 'recording' || !liveCanvas) return;
    const canvas = liveCanvas;
    canvas.width = LW;
    canvas.height = LH;
    let raf = 0;
    const loop = () => {
      drawLive(canvas);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  });
</script>

<div class="record-overlay">
  <header>
    <span class="title">⏺ Recording · {releaseArtist} — {releaseTitle}</span>
    <div class="header-actions">
      {#if canMinimize}
        <button class="icon-btn" title="Minimize — keep recording while you browse" onclick={onMinimize}>–</button>
      {/if}
      <button class="close" onclick={requestClose}>✕</button>
    </div>
  </header>

  {#if confirmingClose}
    <div class="confirm-close" role="alertdialog" aria-label="Discard recording?">
      <span class="confirm-msg">Discard recording? {lostPhrase} will be lost.</span>
      <div class="confirm-actions">
        <button class="confirm-keep" onclick={() => (confirmingClose = false)}>Keep recording</button>
        <button class="confirm-discard" onclick={close}>Discard</button>
      </div>
    </div>
  {/if}

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
            <div class="zoom-toggle">
              {#each ZOOMS as z}
                <button class:active={waveZoom === z.id} onclick={() => (waveZoom = z.id)}>{z.label}</button>
              {/each}
            </div>
            <canvas class="live-wave" bind:this={liveCanvas}></canvas>
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
  .zoom-toggle {
    display: flex;
    gap: 4px;
  }
  .zoom-toggle button {
    background: #1c1c1c;
    border: 1px solid #2a2a2a;
    color: inherit;
    font-size: 11px;
    padding: 3px 10px;
    border-radius: 4px;
    cursor: pointer;
    opacity: 0.7;
  }
  .zoom-toggle button.active {
    background: #2962ff;
    border-color: #2962ff;
    color: #fff;
    opacity: 1;
  }
  .live-wave {
    width: 100%;
    max-width: 1000px;
    height: 72px;
    border-radius: 5px;
    background: #161616;
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
  .header-actions {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .icon-btn {
    background: none;
    border: 1px solid #2a2a2a;
    color: inherit;
    cursor: pointer;
    font-size: 16px;
    line-height: 1;
    width: 28px;
    height: 28px;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .icon-btn:hover {
    background: #1c1c1c;
  }
  .confirm-close {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 10px 16px;
    background: #2a1414;
    border-bottom: 1px solid #4a1f1f;
  }
  .confirm-msg {
    font-size: 13px;
    color: #ffcaca;
  }
  .confirm-actions {
    display: flex;
    gap: 8px;
    flex: none;
  }
  .confirm-keep,
  .confirm-discard {
    font-family: inherit;
    font-size: 13px;
    padding: 6px 14px;
    border-radius: 4px;
    cursor: pointer;
  }
  .confirm-keep {
    background: none;
    border: 1px solid var(--border-strong);
    color: var(--text);
  }
  .confirm-keep:hover {
    background: #1c1c1c;
  }
  .confirm-discard {
    background: #c0392b;
    border: 1px solid #c0392b;
    color: #fff;
  }
  .confirm-discard:hover {
    background: #d4453a;
  }
  .label {
    font-size: 12px;
    color: var(--text-muted);
  }
  select {
    appearance: none;
    -webkit-appearance: none;
    width: 100%;
    max-width: 480px;
    padding: 8px 34px 8px 12px;
    font-family: inherit;
    font-size: 13px;
    color: var(--text);
    background-color: var(--bg-input);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    cursor: pointer;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%23888' stroke-width='1.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 12px center;
  }
  select:hover {
    border-color: var(--accent-border);
  }
  select:focus {
    outline: none;
    border-color: var(--accent);
  }
  select option {
    background: var(--bg-raised);
    color: var(--text);
  }
</style>
