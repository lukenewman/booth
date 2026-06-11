<script lang="ts">
  import { recorder, type RegionClient, type TakeClient } from '$lib/stores/recorder.svelte';

  let { onClose }: { onClose: () => void } = $props();

  let replacePrompt = $state(false);
  let version = $state(0); // bumped on nested region mutation → triggers canvas redraw
  let canvases = $state<HTMLCanvasElement[]>([]);
  let audio: HTMLAudioElement | null = null;

  type Sel = { take: TakeClient; region: RegionClient; edge: 'in' | 'out' };
  let drag = $state<Sel | null>(null);
  let selected = $state<Sel | null>(null);

  const W = 1200;
  const H = 96;

  function drawWave(canvas: HTMLCanvasElement, take: TakeClient) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#161616';
    ctx.fillRect(0, 0, W, H);
    // peaks
    ctx.fillStyle = '#3a86ff';
    const n = take.peaks.length;
    for (let i = 0; i < n; i++) {
      const x = (i / n) * W;
      const h = take.peaks[i] * (H - 8);
      ctx.fillRect(x, (H - h) / 2, Math.max(1, W / n - 0.5), h);
    }
    // regions
    for (const r of take.regions) {
      const x1 = (r.startMs / take.durationMs) * W;
      const x2 = (r.endMs / take.durationMs) * W;
      ctx.fillStyle = r.trackId ? 'rgba(58,134,255,0.12)' : 'rgba(255,255,255,0.04)';
      ctx.fillRect(x1, 0, x2 - x1, H);
      ctx.fillStyle = r.confidence < 0.6 ? '#e0a23c' : '#2e7d32';
      ctx.fillRect(x1, 0, 2, H); // in-point
      ctx.fillStyle = r.confidence < 0.6 ? '#e0a23c' : '#c0392b';
      ctx.fillRect(x2 - 2, 0, 2, H); // out-point
    }
  }

  $effect(() => {
    version; // dependency
    recorder.takes.forEach((take, i) => {
      const c = canvases[i];
      if (c) {
        c.width = W;
        c.height = H;
        drawWave(c, take);
      }
    });
  });

  function bump() {
    version++;
  }

  function hitTest(take: TakeClient, e: PointerEvent, canvas: HTMLCanvasElement): Sel | null {
    const rect = canvas.getBoundingClientRect();
    const ms = ((e.clientX - rect.left) / rect.width) * take.durationMs;
    const tol = take.durationMs * 0.01;
    for (const region of take.regions) {
      if (Math.abs(region.startMs - ms) < tol) return { take, region, edge: 'in' };
      if (Math.abs(region.endMs - ms) < tol) return { take, region, edge: 'out' };
    }
    return null;
  }
  function onDown(take: TakeClient, e: PointerEvent) {
    const canvas = e.currentTarget as HTMLCanvasElement;
    const hit = hitTest(take, e, canvas);
    if (hit) {
      drag = hit;
      selected = hit;
      canvas.setPointerCapture(e.pointerId);
    }
  }
  function onMove(take: TakeClient, e: PointerEvent) {
    if (!drag || drag.take !== take) return;
    const canvas = e.currentTarget as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    const ms = Math.max(
      0,
      Math.min(take.durationMs, ((e.clientX - rect.left) / rect.width) * take.durationMs),
    );
    setEdge(drag.region, drag.edge, ms);
    bump();
  }
  function onUp() {
    drag = null;
  }

  function setEdge(r: RegionClient, edge: 'in' | 'out', ms: number) {
    if (edge === 'in') r.startMs = Math.min(ms, r.endMs - 1000);
    else r.endMs = Math.max(ms, r.startMs + 1000);
  }
  function nudge(deltaMs: number) {
    if (!selected) return;
    const base = selected.edge === 'in' ? selected.region.startMs : selected.region.endMs;
    setEdge(selected.region, selected.edge, base + deltaMs);
    bump();
  }

  function addSplit(take: TakeClient, region: RegionClient) {
    const mid = (region.startMs + region.endMs) / 2;
    const idx = take.regions.indexOf(region);
    const right: RegionClient = { startMs: mid, endMs: region.endMs, trackId: null, confidence: 0.2, title: '' };
    region.endMs = mid;
    take.regions.splice(idx + 1, 0, right);
    bump();
  }
  function mergeWithNext(take: TakeClient, region: RegionClient) {
    const idx = take.regions.indexOf(region);
    const next = take.regions[idx + 1];
    if (!next) return;
    region.endMs = next.endMs;
    take.regions.splice(idx + 1, 1);
    bump();
  }
  function assign(region: RegionClient, trackId: string) {
    region.trackId = trackId || null;
    const t = recorder.expected.find((x) => x.trackId === trackId);
    if (t) region.title = t.title;
    region.confidence = 1; // user-confirmed
    bump();
  }

  function play(takeId: string, startMs: number, endMs: number) {
    audio?.pause();
    audio = new Audio(recorder.previewUrl(takeId, startMs, endMs));
    void audio.play();
  }
  function seam(take: TakeClient, region: RegionClient) {
    const idx = take.regions.indexOf(region);
    const next = take.regions[idx + 1];
    if (!next) return;
    play(take.takeId, Math.max(region.startMs, region.endMs - 1500), region.endMs);
    setTimeout(() => play(take.takeId, next.startMs, Math.min(next.endMs, next.startMs + 1500)), 1600);
  }

  async function save(replace = false) {
    const ok = await recorder.commit(replace);
    if (!ok) {
      replacePrompt = true;
      return;
    }
    if (recorder.phase === 'done') onClose();
  }

  function fmt(ms: number): string {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
  function expDuration(trackId: string | null): number | null {
    if (!trackId) return null;
    return recorder.expected.find((t) => t.trackId === trackId)?.durationMs ?? null;
  }
  const assignedCount = $derived.by(() => {
    version;
    return recorder.takes.reduce((n, t) => n + t.regions.filter((r) => r.trackId).length, 0);
  });
</script>

<div class="review">
  {#each recorder.takes as take, ti}
    <section>
      <h3>Take {ti + 1} · {fmt(take.durationMs)}{take.sideGuess ? ` · side ${take.sideGuess}?` : ''}</h3>
      <canvas
        bind:this={canvases[ti]}
        onpointerdown={(e) => onDown(take, e)}
        onpointermove={(e) => onMove(take, e)}
        onpointerup={onUp}
      ></canvas>
      <div class="rows">
        {#each take.regions as region}
          <div class="row" class:warn={region.confidence < 0.6}>
            <button class="play" onclick={() => play(take.takeId, region.startMs, region.endMs)}>▶</button>
            <select value={region.trackId ?? ''} onchange={(e) => assign(region, e.currentTarget.value)}>
              <option value="">(unassigned)</option>
              {#each recorder.expected as t}
                <option value={t.trackId}>{t.discogsPosition ?? t.position} · {t.title}</option>
              {/each}
            </select>
            <input class="title" bind:value={region.title} placeholder="title" />
            <span class="dur">
              {fmt(region.endMs - region.startMs)}
              {#if expDuration(region.trackId) != null}
                <span class="exp">/ {fmt(expDuration(region.trackId) as number)}</span>
              {/if}
            </span>
            <span class="dot" class:ok={region.confidence >= 0.6}></span>
            <button class="mini" title="add split at midpoint" onclick={() => addSplit(take, region)}>＋</button>
            <button class="mini" title="merge with next" onclick={() => mergeWithNext(take, region)}>✕</button>
            <button class="mini" title="preview seam into next" onclick={() => seam(take, region)}>⎌</button>
          </div>
        {/each}
      </div>
    </section>
  {/each}

  <footer>
    {#if selected}
      <span class="nudge">
        Selected: {selected.edge}-point ·
        <button class="mini" onclick={() => nudge(-10)}>−10ms</button>
        <button class="mini" onclick={() => nudge(10)}>+10ms</button>
        <button class="mini" onclick={() => nudge(-1000)}>−1s</button>
        <button class="mini" onclick={() => nudge(1000)}>+1s</button>
      </span>
    {/if}
    {#if replacePrompt}
      <span class="conflict">Some tracks already have a local recording.</span>
      <button class="danger" onclick={() => save(true)}>Replace</button>
      <button onclick={() => (replacePrompt = false)}>Cancel</button>
    {:else}
      <button
        class="confirm"
        disabled={assignedCount === 0 || recorder.phase === 'committing'}
        onclick={() => save(false)}
      >
        ✓ Save {assignedCount} track{assignedCount === 1 ? '' : 's'} to local library
      </button>
    {/if}
  </footer>
</div>

<style>
  .review {
    padding: 16px 20px;
    overflow: auto;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 20px;
  }
  section h3 {
    font-size: 13px;
    opacity: 0.8;
    margin: 0 0 8px;
  }
  canvas {
    width: 100%;
    height: 96px;
    border-radius: 5px;
    cursor: col-resize;
    touch-action: none;
  }
  .rows {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 8px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    background: #1c1c1c;
    border-radius: 5px;
    border: 1px solid transparent;
  }
  .row.warn {
    border-color: #5a4a1a;
    background: #241f12;
  }
  .title {
    flex: 1;
    background: #111;
    border: 1px solid #2a2a2a;
    color: inherit;
    padding: 4px 8px;
    border-radius: 4px;
  }
  select {
    background: #111;
    color: inherit;
    border: 1px solid #2a2a2a;
    border-radius: 4px;
    padding: 4px;
    max-width: 280px;
  }
  .dur {
    font-size: 12px;
    opacity: 0.8;
    font-variant-numeric: tabular-nums;
  }
  .exp {
    opacity: 0.5;
  }
  .dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: #e0a23c;
  }
  .dot.ok {
    background: #2e7d32;
  }
  .play,
  .mini {
    background: #222;
    border: 1px solid #333;
    color: inherit;
    border-radius: 4px;
    cursor: pointer;
    padding: 2px 8px;
  }
  footer {
    display: flex;
    align-items: center;
    gap: 12px;
    border-top: 1px solid #2a2a2a;
    padding-top: 12px;
  }
  .confirm {
    background: #2e7d32;
    color: #fff;
    border: none;
    padding: 10px 18px;
    border-radius: 5px;
    cursor: pointer;
  }
  .confirm:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .danger {
    background: #c0392b;
    color: #fff;
    border: none;
    padding: 8px 14px;
    border-radius: 5px;
    cursor: pointer;
  }
  .conflict {
    color: #e0a23c;
    font-size: 13px;
  }
  .nudge {
    font-size: 12px;
    opacity: 0.8;
    display: flex;
    gap: 6px;
    align-items: center;
  }
</style>
