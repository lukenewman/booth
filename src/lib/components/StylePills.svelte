<script lang="ts">
  import StylePill from './StylePill.svelte';
  import { explorerState } from '$lib/stores/explorerState.svelte';

  let { styles = [], max = 3 }: { styles?: string[]; max?: number } = $props();
  const shown = $derived(styles.slice(0, max));
  const rest = $derived(styles.length - shown.length);
</script>

{#if styles.length}
  <span class="pills">
    {#each shown as s (s)}
      <StylePill style={s} onclick={(style) => explorerState.toggleStyle(style)} />
    {/each}
    {#if rest > 0}<span class="more" title={styles.slice(max).join(', ').toLowerCase()}>+{rest}</span>{/if}
  </span>
{/if}

<style>
  .pills { display: inline-flex; gap: 4px; align-items: center; flex-wrap: nowrap; min-width: 0; overflow: hidden; }
  .more { font-size: 10.5px; color: var(--text-subtle); }
</style>
