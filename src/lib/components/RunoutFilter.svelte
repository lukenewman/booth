<script lang="ts">
  /**
   * Filters a master's versions by runout etching. Not a SearchBar: it filters
   * in memory, so there is nothing to debounce, and it must not carry the
   * `.search` class the keyboard layer uses to find the toolbar input.
   */
  let {
    value = $bindable(''),
    status,
  }: {
    value?: string;
    status: {
      total: number;
      loaded: number;
      failed: number;
      bare: number;
      waiting: boolean;
      shown: number;
    } | null;
  } = $props();

  const pending = $derived(status ? status.total - status.loaded : 0);

  const note = $derived.by(() => {
    if (!status) return '';
    const parts: string[] = [];
    if (value.trim()) parts.push(`${status.shown} of ${status.total} match`);
    if (pending > 0) {
      parts.push(
        status.waiting
          ? `paused for the Discogs rate limit, ${pending} left`
          : `checking ${status.loaded}/${status.total}…`,
      );
    }
    if (status.bare > 0) parts.push(`${status.bare} with no runouts listed`);
    if (status.failed > 0) parts.push(`${status.failed} couldn't load`);
    return parts.join(' · ');
  });
</script>

<div class="runout-filter">
  <input
    class="runout-input"
    type="text"
    placeholder="Match runout etching…"
    autocomplete="off"
    autocapitalize="characters"
    spellcheck="false"
    bind:value
  />
  {#if note}
    <span class="note">{note}</span>
  {/if}
</div>

<style>
  .runout-filter {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 14px;
    border-bottom: 1px solid var(--border);
  }
  .runout-input {
    flex: 0 1 280px;
    min-width: 0;
    background: var(--bg-input);
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    padding: 4px 8px;
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 12px;
  }
  .runout-input:focus { outline: none; border-color: var(--accent-border); }
  .note {
    color: var(--text-subtle);
    font-size: 11px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  @media (max-width: 768px) {
    .runout-filter { flex-wrap: wrap; gap: 4px 10px; }
    /* 16px keeps iOS from zooming into the field on focus. */
    .runout-input { flex: 1 1 100%; font-size: 16px; padding: 7px 9px; }
  }
</style>
