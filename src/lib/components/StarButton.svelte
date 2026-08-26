<script lang="ts">
  import { annotations } from '$lib/stores/annotations.svelte';

  let { trackId, size = 14 }: { trackId: string; size?: number } = $props();

  const starred = $derived(annotations.isStarred(trackId));

  function toggle(e: MouseEvent) {
    // Rows are buttons that select/play; the star must not trigger that.
    e.stopPropagation();
    e.preventDefault();
    annotations.toggleStar(trackId, !starred);
  }
</script>

<button
  class="star"
  class:on={starred}
  onclick={toggle}
  ondblclick={(e) => e.stopPropagation()}
  aria-pressed={starred}
  aria-label={starred ? 'Remove star' : 'Star track'}
  title={starred ? 'Remove star (s)' : 'Star track (s)'}
>
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <path
      d="M12 2.5l2.9 6.1 6.6.9-4.8 4.6 1.2 6.6L12 17.6 6.1 20.7l1.2-6.6L2.5 9.5l6.6-.9z"
      fill={starred ? 'currentColor' : 'none'}
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linejoin="round"
    />
  </svg>
</button>

<style>
  .star {
    background: none;
    border: 0;
    padding: 2px;
    cursor: pointer;
    color: var(--text-muted);
    opacity: 0;
    display: flex;
    align-items: center;
    flex: 0 0 auto;
    transition: opacity 0.12s, color 0.12s;
  }
  /* Hidden until hover keeps thousands of hollow stars from becoming visual
     noise — but a set star must always be visible, hover or not. */
  :global(.row-btn:hover) .star,
  :global(.row-btn:focus-visible) .star,
  :global(.track-row:hover) .star,
  :global(.track-row:focus-visible) .star,
  .star.on,
  .star:focus-visible {
    opacity: 1;
  }
  .star.on { color: var(--star); }
  .star:hover { color: var(--text); }
</style>
