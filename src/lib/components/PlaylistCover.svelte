<script lang="ts">
  /**
   * A playlist's cover. Priority: custom `coverUrl` → a 2×2 mosaic of ≥4
   * distinct track covers → the first cover full-bleed (1–3 covers) → a
   * placeholder. `size` is the square edge in px.
   */
  let {
    coverUrl = null,
    mosaic = [],
    size = 28,
  }: {
    coverUrl?: string | null;
    mosaic?: string[];
    size?: number;
  } = $props();

  const dim = $derived(`width:${size}px;height:${size}px`);
</script>

{#if coverUrl}
  <div class="cover" style={dim}>
    <img src={coverUrl} alt="" loading="lazy" />
  </div>
{:else if mosaic.length >= 4}
  <div class="cover grid" style={dim}>
    {#each mosaic.slice(0, 4) as m}<img src={m} alt="" loading="lazy" />{/each}
  </div>
{:else if mosaic.length > 0}
  <div class="cover" style={dim}>
    <img src={mosaic[0]} alt="" loading="lazy" />
  </div>
{:else}
  <div class="cover placeholder" style="{dim};font-size:{Math.round(size * 0.42)}px">♪</div>
{/if}

<style>
  .cover {
    border-radius: 3px;
    overflow: hidden;
    background: var(--bg-raised);
    border: 1px solid var(--border);
    flex-shrink: 0;
  }
  .cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .cover.grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    grid-template-rows: 1fr 1fr;
  }
  .placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-subtle);
    line-height: 1;
  }
</style>
