<script lang="ts">
  import { session } from '$lib/stores/session.svelte';

  let {
    onUndo,
  }: {
    onUndo: () => void;
  } = $props();
</script>

{#if session.count > 0}
  <div class="log">
    <span>Added this session: {session.count}</span>
    <button type="button" class="undo" onclick={onUndo}>
      undo last
    </button>
  </div>
{/if}

<style>
  .log {
    height: 32px;
    border-top: 1px solid var(--border);
    padding: 0 14px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    color: var(--text-muted);
    font-size: 12px;
    flex-shrink: 0;
  }
  .undo {
    background: transparent;
    border: 0;
    color: var(--accent);
    padding: 0;
    cursor: pointer;
    font-family: inherit;
    font-size: 12px;
  }
  .undo:hover { text-decoration: underline; }
</style>
