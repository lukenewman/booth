<script lang="ts" module>
  export interface Photo { url: string; thumb: string; width: number | null; height: number | null; }
</script>

<script lang="ts">
  let {
    photos,
    index = $bindable(),
    title,
  }: {
    photos: Photo[];
    /** Open photo, or null when closed. */
    index: number | null;
    title: string;
  } = $props();

  let dialog: HTMLDivElement | undefined = $state();

  const photo = $derived(index != null ? photos[index] : undefined);

  function step(by: number) {
    if (index == null || photos.length === 0) return;
    index = (index + by + photos.length) % photos.length;
  }

  function close() { index = null; }

  // Take focus on open so the keys below land here rather than on the
  // explorer's window-level shortcuts (which would move the list selection).
  $effect(() => { if (photo) dialog?.focus(); });

  function onKey(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
  }
</script>

{#if photo && index != null}
  <div class="backdrop" onclick={close} role="presentation">
    <div
      class="viewer"
      bind:this={dialog}
      onclick={(e) => e.stopPropagation()}
      onkeydown={onKey}
      role="dialog"
      aria-modal="true"
      aria-label="{title} photos"
      tabindex={-1}
    >
      <img class="photo" src={photo.url} alt="{title} photo {index + 1} of {photos.length}">
      <div class="bar">
        {#if photos.length > 1}
          <button class="nav" onclick={() => step(-1)} aria-label="Previous photo">‹</button>
        {/if}
        <span class="count">{index + 1} / {photos.length}</span>
        {#if photos.length > 1}
          <button class="nav" onclick={() => step(1)} aria-label="Next photo">›</button>
        {/if}
        <a class="open" href={photo.url} target="_blank" rel="noopener noreferrer">Open ↗</a>
        <button class="nav close" onclick={close} aria-label="Close">×</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.8);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    z-index: 150;
  }
  .viewer {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    max-width: 100%;
    max-height: 100%;
    outline: none;
  }
  .photo {
    max-width: min(90vw, 1200px);
    max-height: calc(100vh - 100px);
    object-fit: contain;
    border-radius: 4px;
    background: var(--bg-raised);
    display: block;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 12px;
    color: var(--text-muted);
    font-size: 12px;
  }
  .count { font-variant-numeric: tabular-nums; min-width: 44px; text-align: center; }
  .nav {
    background: var(--bg-raised);
    border: 1px solid var(--border-strong);
    color: var(--text);
    border-radius: 999px;
    width: 28px;
    height: 28px;
    font-size: 16px;
    line-height: 1;
    cursor: pointer;
  }
  .nav:hover { border-color: var(--text-subtle); }
  .close { margin-left: 8px; }
  .open { color: var(--accent); text-decoration: none; }
  .open:hover { text-decoration: underline; }
</style>
