<script lang="ts">
  import { emptyTapState, estimate, tap, MIN_TAPS } from '$lib/tapTempo';

  let { trackId, onSaved }: { trackId: string; onSaved?: (bpm: number) => void } = $props();

  let run = $state(emptyTapState);
  let saving = $state(false);
  let failed = $state(false);

  const reading = $derived(estimate(run));
  const taps = $derived(run.taps.length);

  function doTap() {
    failed = false;
    // performance.now() rather than Date.now(): a clock adjustment mid-tap
    // would otherwise land as a wildly wrong interval.
    run = tap(run, performance.now());
  }

  function reset() {
    run = emptyTapState;
    failed = false;
  }

  /**
   * The pad handles its own keys. Space and Enter are what a focused button
   * responds to by default, and space is bound globally to play/pause — so both
   * are swallowed here rather than allowed to reach the rest of the app while
   * you are in the middle of counting a bar.
   */
  function onKey(e: KeyboardEvent) {
    if (e.key !== ' ' && e.key !== 'Enter' && e.key !== 't' && e.key !== 'T') return;
    e.preventDefault();
    e.stopPropagation();
    // Holding a key auto-repeats at the OS rate, which is not a tempo.
    if (e.repeat) return;
    doTap();
  }

  async function save() {
    if (!reading || saving) return;
    saving = true;
    failed = false;
    try {
      const res = await fetch(`/api/library/tracks/${trackId}/bpm`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bpm: reading.bpm }),
      });
      if (!res.ok) throw new Error(String(res.status));
      onSaved?.(reading.bpm);
      run = emptyTapState;
    } catch {
      failed = true;
    } finally {
      saving = false;
    }
  }
</script>

<div class="tap">
  <div class="tap-head">
    <span class="tap-label">No BPM for this track</span>
    {#if taps > 0}
      <button class="tap-reset" onclick={reset}>reset</button>
    {/if}
  </div>

  <button
    class="pad"
    class:armed={taps > 0}
    onpointerdown={doTap}
    onkeydown={onKey}
    aria-label="Tap in time with the record to measure its tempo"
  >
    {#if reading}
      <span class="pad-bpm">{reading.bpm}</span>
      <span class="pad-unit">BPM</span>
    {:else if taps > 0}
      <span class="pad-count">{taps}</span>
      <span class="pad-unit">keep tapping</span>
    {:else}
      <span class="pad-hint">Tap along</span>
    {/if}
  </button>

  <div class="tap-foot">
    {#if reading}
      <span class="tap-taps">{taps} taps</span>
      <button class="tap-save" onclick={save} disabled={saving}>
        {saving ? 'saving…' : 'Save'}
      </button>
    {:else}
      <span class="tap-taps">{MIN_TAPS - taps} more to read a tempo</span>
    {/if}
  </div>

  {#if failed}
    <div class="tap-error">Couldn't save that — try again.</div>
  {/if}
</div>

<style>
  .tap {
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 8px 10px;
    margin-bottom: 12px;
  }
  .tap-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 8px; }
  .tap-label { font-size: 11px; color: var(--text-muted); }
  .tap-reset {
    margin-left: auto;
    font-size: 10px;
    color: var(--text-subtle);
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
  }
  .tap-reset:hover { color: var(--text-muted); }

  /* Big enough to hit with a thumb at the decks without looking at it. */
  .pad {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    width: 100%;
    min-height: 76px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    cursor: pointer;
    user-select: none;
    -webkit-user-select: none;
    /* A tap must register as a tap, not as the start of a double-tap-to-zoom. */
    touch-action: manipulation;
  }
  .pad.armed { border-color: var(--accent-border); }
  .pad:active { background: var(--accent-bg); }
  .pad:focus-visible { outline: 1px solid var(--accent); outline-offset: 1px; }
  .pad-bpm {
    font-size: 26px;
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
    color: var(--text);
    line-height: 1;
  }
  .pad-count {
    font-size: 20px;
    font-family: var(--font-mono);
    color: var(--text-muted);
    line-height: 1;
  }
  .pad-unit { font-size: 10px; color: var(--text-muted); letter-spacing: 0.05em; }
  .pad-hint { font-size: 12px; color: var(--text-subtle); }

  .tap-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 8px;
  }
  .tap-taps { font-size: 10px; color: var(--text-subtle); }
  .tap-save {
    font-size: 11px;
    color: var(--text);
    background: var(--accent-bg);
    border: 1px solid var(--accent-border);
    border-radius: 3px;
    padding: 3px 10px;
    cursor: pointer;
  }
  .tap-save:disabled { opacity: 0.6; cursor: default; }
  .tap-error { margin-top: 6px; font-size: 10px; color: var(--text-muted); }
</style>
