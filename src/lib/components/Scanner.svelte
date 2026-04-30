<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { BrowserMultiFormatReader, type IScannerControls } from '@zxing/browser';

  let {
    onDecode,
    onError,
  }: {
    onDecode: (text: string) => void;
    onError?: (err: unknown) => void;
  } = $props();

  let videoEl: HTMLVideoElement | undefined = $state();
  let controls: IScannerControls | undefined;
  let cameraError = $state<string | null>(null);
  let decoded = false;

  function beep() {
    try {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = 880;
      gain.gain.value = 0.1;
      osc.start();
      setTimeout(() => {
        osc.stop();
        ctx.close();
      }, 120);
    } catch {
      // beep is best-effort
    }
  }

  onMount(async () => {
    if (!videoEl) return;
    const reader = new BrowserMultiFormatReader();
    try {
      controls = await reader.decodeFromConstraints(
        { video: { facingMode: 'environment' } },
        videoEl,
        (result) => {
          if (decoded || !result) return;
          decoded = true;
          beep();
          controls?.stop();
          onDecode(result.getText());
        },
      );
    } catch (e) {
      const err = e as { name?: string };
      if (err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError') {
        cameraError = 'Camera blocked — enable in browser settings, or use search instead.';
      } else if (err?.name === 'NotFoundError') {
        cameraError = 'No camera found.';
      } else {
        cameraError = 'Could not start camera.';
      }
      onError?.(e);
    }
  });

  onDestroy(() => {
    controls?.stop();
  });
</script>

<div class="wrap">
  {#if cameraError}
    <div class="error">{cameraError}</div>
  {:else}
    <div class="viewfinder">
      <video bind:this={videoEl} autoplay muted playsinline></video>
      <div class="frame"></div>
      <div class="hint">Center barcode in frame</div>
    </div>
    <div class="caption">Auto-detects · plays a beep on match</div>
  {/if}
</div>

<style>
  .wrap {
    margin-bottom: 12px;
  }
  .viewfinder {
    background: #000;
    border-radius: var(--radius);
    aspect-ratio: 4 / 3;
    position: relative;
    overflow: hidden;
  }
  video {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .frame {
    position: absolute;
    inset: 18%;
    border: 2px solid var(--accent);
    border-radius: var(--radius-sm);
    box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.45);
    pointer-events: none;
  }
  .hint {
    position: absolute;
    bottom: 10px;
    left: 0;
    right: 0;
    text-align: center;
    color: #ddd;
    font-size: 12px;
    z-index: 1;
  }
  .caption {
    margin-top: 8px;
    text-align: center;
    color: var(--text-muted);
    font-size: 12px;
  }
  .error {
    padding: 16px;
    background: rgba(219, 90, 90, 0.12);
    border: 1px solid rgba(219, 90, 90, 0.3);
    border-radius: var(--radius);
    color: var(--danger);
    font-size: 13px;
    text-align: center;
  }
</style>
