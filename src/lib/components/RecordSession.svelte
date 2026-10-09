<script lang="ts">
  import { recorder } from '$lib/stores/recorder.svelte';
  import ReviewSplits from './ReviewSplits.svelte';
  import {
    toDbfs,
    meterFraction,
    GOOD_LO_DBFS,
    GOOD_HI_DBFS,
    type LevelStatus,
  } from '$lib/loudness';

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
  let micBlocked = $state(false);
  let confirmingClose = $state(false);
  // Derived from the store (not local) so the overlay restores correctly after
  // being minimized + remounted mid-capture instead of resetting to the picker.
  const started = $derived(recorder.phase !== 'idle');

  const STATUS_LABEL: Record<LevelStatus, string> = {
    'too-low': 'TOO LOW',
    low: 'LOW',
    good: 'GOOD ✓',
    hot: 'HOT',
    clip: 'CLIP',
  };

  let pendingLowConfirm = $state(false);

  function tryRecord() {
    const s = recorder.levelStatus;
    if (s === 'too-low' || s === 'low' || s === 'clip') {
      pendingLowConfirm = true;
    } else {
      void recorder.recordTake();
    }
  }
  function recordAnyway() {
    pendingLowConfirm = false;
    void recorder.recordTake();
  }

  async function loadDevices() {
    // Labels are only visible after permission is granted; grab a throwaway
    // stream first so the device dropdown is meaningful.
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      micBlocked = false;
    } catch (err) {
      // A denied permission yields only an unnamed placeholder device here and
      // a hard failure later on start(); flag it so the picker explains the fix
      // rather than silently showing a single meaningless "Audio input".
      const name = (err as DOMException)?.name;
      micBlocked = name === 'NotAllowedError' || name === 'SecurityError';
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
          <div class="device-section">
            <span class="label" id="dev-label">Input device</span>
            {#if micBlocked}
              <p class="mic-blocked">
                Microphone access is blocked. Enable it for this site in your browser settings
                (the icon at the left of the address bar → Microphone → Allow), then try again.
              </p>
              <button type="button" class="retry" onclick={() => loadDevices()}>Try again</button>
            {:else if devices.length === 0}
              <p class="no-devices">No audio inputs found — the system default will be used.</p>
            {:else}
              <ul class="device-list" role="radiogroup" aria-labelledby="dev-label">
                {#each devices as d (d.deviceId)}
                  <li>
                    <button
                      type="button"
                      class="device"
                      class:selected={deviceId === d.deviceId}
                      role="radio"
                      aria-checked={deviceId === d.deviceId}
                      onclick={() => (deviceId = d.deviceId)}
                    >
                      <span class="radio" aria-hidden="true"></span>
                      <span class="device-label">{d.label || 'Audio input'}</span>
                    </button>
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
          {#if !micBlocked}
            <button class="primary" onclick={begin}>Open input</button>
          {/if}
        {:else}
          <div class="meters">
            <div class="meter">
              <span>L</span>
              <div class="bar">
                <div
                  class="zone"
                  style:left="{meterFraction(GOOD_LO_DBFS) * 100}%"
                  style:width="{(meterFraction(GOOD_HI_DBFS) - meterFraction(GOOD_LO_DBFS)) * 100}%"
                ></div>
                <div class="fill" style:width="{meterFraction(toDbfs(recorder.levelL)) * 100}%"></div>
                <div class="hold" style:left="{meterFraction(toDbfs(recorder.heldPeakL)) * 100}%"></div>
              </div>
              <span class="db">{db(recorder.heldPeakL)}</span>
            </div>
            <div class="meter">
              <span>R</span>
              <div class="bar">
                <div
                  class="zone"
                  style:left="{meterFraction(GOOD_LO_DBFS) * 100}%"
                  style:width="{(meterFraction(GOOD_HI_DBFS) - meterFraction(GOOD_LO_DBFS)) * 100}%"
                ></div>
                <div class="fill" style:width="{meterFraction(toDbfs(recorder.levelR)) * 100}%"></div>
                <div class="hold" style:left="{meterFraction(toDbfs(recorder.heldPeakR)) * 100}%"></div>
              </div>
              <span class="db">{db(recorder.heldPeakR)}</span>
            </div>
            <div class="status-row">
              <div class="status" data-status={recorder.levelStatus}>{STATUS_LABEL[recorder.levelStatus]}</div>
              <button class="reset-peak" type="button" onclick={() => recorder.resetPeakHold()}>Reset peak</button>
              <span class="rate">{recorder.sampleRate} Hz · 24-bit</span>
            </div>
          </div>

          {#if phase === 'preview'}
            {#if pendingLowConfirm}
              <div class="low-confirm" role="alertdialog" aria-label="Input level looks low">
                <span>
                  Input peaked at {db(Math.max(recorder.heldPeakL, recorder.heldPeakR))}
                  ({STATUS_LABEL[recorder.levelStatus]}). Turn up your interface gain, or record anyway?
                </span>
                <button class="rec" onclick={recordAnyway}>Record anyway</button>
                <button class="ghost" onclick={() => (pendingLowConfirm = false)}>Keep adjusting</button>
              </div>
            {:else}
              <div class="actions">
                <button class="rec" onclick={tryRecord}>⏺ Record side {recorder.takes.length + 1}</button>
                {#if recorder.takes.length > 0}
                  <button class="primary" onclick={() => recorder.review()}>
                    No more sides → review {recorder.takes.length} take{recorder.takes.length === 1 ? '' : 's'}
                  </button>
                {/if}
              </div>
            {/if}
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
    inset: var(--titlebar-h) 0 0 0;
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
    position: relative;
    flex: 1;
    height: 14px;
    background: #222;
    border-radius: 3px;
    overflow: hidden;
  }
  .zone {
    position: absolute;
    top: 0;
    bottom: 0;
    background: rgba(46, 125, 50, 0.32);
    border-left: 1px solid rgba(46, 125, 50, 0.9);
    border-right: 1px solid rgba(46, 125, 50, 0.9);
  }
  .fill {
    position: absolute;
    left: 0;
    top: 0;
    height: 100%;
    background: #3a86ff;
  }
  .hold {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 2px;
    margin-left: -1px;
    background: #fff;
  }
  .db {
    width: 52px;
    font-size: 11px;
    opacity: 0.7;
    text-align: right;
  }
  .status-row {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .status {
    font-size: 11px;
    font-weight: 700;
    padding: 2px 8px;
    border-radius: 4px;
    letter-spacing: 0.03em;
  }
  .status[data-status='good'] {
    color: #fff;
    background: #2e7d32;
  }
  .status[data-status='low'],
  .status[data-status='hot'] {
    color: #1a1206;
    background: #e0a23c;
  }
  .status[data-status='too-low'],
  .status[data-status='clip'] {
    color: #fff;
    background: #c0392b;
  }
  .reset-peak {
    background: transparent;
    color: var(--text);
    border: 1px solid var(--border-strong);
    padding: 3px 8px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 11px;
  }
  .low-confirm {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    padding: 10px 12px;
    border: 1px solid #5a4a1a;
    background: #241f12;
    border-radius: 6px;
    font-size: 13px;
    max-width: 560px;
  }
  .low-confirm .ghost {
    background: transparent;
    color: var(--text);
    border: 1px solid var(--border-strong);
    padding: 6px 12px;
    border-radius: 5px;
    cursor: pointer;
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
  .device-section {
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 100%;
    max-width: 480px;
  }
  .device-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .device {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    text-align: left;
    padding: 9px 12px;
    font-family: inherit;
    font-size: 13px;
    color: var(--text);
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    cursor: pointer;
  }
  .device:hover {
    border-color: var(--border-strong);
    background: var(--bg-row-hover);
  }
  .device.selected {
    border-color: var(--accent-border);
    background: var(--accent-bg);
  }
  .device:focus-visible {
    outline: none;
    border-color: var(--accent);
  }
  .radio {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 1px solid var(--text-muted);
    flex: none;
    position: relative;
  }
  .device.selected .radio {
    border-color: var(--accent);
  }
  .device.selected .radio::after {
    content: '';
    position: absolute;
    inset: 3px;
    border-radius: 50%;
    background: var(--accent);
  }
  .device-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .no-devices {
    margin: 0;
    font-size: 12px;
    color: var(--text-muted);
  }
  .mic-blocked {
    margin: 0;
    font-size: 12px;
    line-height: 1.5;
    color: var(--text);
    border-left: 2px solid var(--danger);
    padding-left: 10px;
  }
  .retry {
    align-self: flex-start;
    background: transparent;
    color: var(--text);
    border: 1px solid var(--border-strong);
    padding: 6px 12px;
    border-radius: 5px;
    cursor: pointer;
  }
</style>
