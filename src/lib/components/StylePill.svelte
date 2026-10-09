<script lang="ts">
  import { PALETTE, display } from '$lib/genres';
  import { genresStore } from '$lib/stores/genres.svelte';

  let {
    style,
    excluded = false,
    onclick,
    title,
  }: {
    style: string;
    /** Rendered as "not deep house" in filter chips. */
    excluded?: boolean;
    onclick?: (style: string, e: MouseEvent) => void;
    title?: string;
  } = $props();
  const c = $derived(PALETTE[genresStore.slotFor(style)]);
</script>

{#if onclick}
  <button
    type="button"
    class="pill"
    class:excluded
    style:background={c.bg}
    style:color={c.fg}
    title={title ?? `Filter by ${display(style)}`}
    onclick={(e) => { e.stopPropagation(); onclick(style, e); }}
    ondblclick={(e) => e.stopPropagation()}
  >{excluded ? 'not ' : ''}{display(style)}</button>
{:else}
  <span class="pill" class:excluded style:background={c.bg} style:color={c.fg} {title}>{excluded ? 'not ' : ''}{display(style)}</span>
{/if}

<style>
  .pill {
    display: inline-block;
    border: 0;
    border-radius: 999px;
    padding: 0 7px;
    font: inherit;
    font-size: 10.5px;
    line-height: 16px;
    white-space: nowrap;
    max-width: 14em;
    overflow: hidden;
    text-overflow: ellipsis;
    vertical-align: middle;
  }
  button.pill { cursor: pointer; }
  button.pill:hover { filter: brightness(1.2); }
  .excluded { opacity: 0.7; text-decoration: line-through; text-decoration-thickness: 1px; }
</style>
