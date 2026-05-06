<script lang="ts">
  /**
   * Centered empty state — used in stub sources, never-synced sources,
   * empty search results, no-entity-selected detail, etc.
   */
  let {
    title,
    detail = '',
    cta = null,
    onCta,
  }: {
    title: string;
    detail?: string;
    cta?: string | null;
    onCta?: () => void;
  } = $props();
</script>

<div class="empty">
  <div class="title">{title}</div>
  {#if detail}<div class="detail">{detail}</div>{/if}
  {#if cta}
    <button class="cta" onclick={() => onCta?.()}>{cta}</button>
  {/if}
</div>

<style>
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    min-height: 200px;
    padding: 24px;
    color: var(--text-subtle);
    text-align: center;
  }
  .title {
    color: var(--text-muted);
    font-size: 13px;
    margin-bottom: 6px;
  }
  .detail {
    font-size: 12px;
    max-width: 320px;
    line-height: 1.5;
  }
  .cta {
    margin-top: 12px;
    background: transparent;
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    color: var(--text);
    padding: 6px 12px;
    font-size: 12px;
    font-family: inherit;
    cursor: pointer;
  }
  .cta:hover {
    border-color: var(--text-muted);
  }
</style>
