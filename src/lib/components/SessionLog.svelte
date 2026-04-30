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
      undo last <span class="kbd">u</span>
    </button>
  </div>
{/if}

<style>
  .log {
    margin-top: 14px;
    padding-top: 12px;
    border-top: 1px dashed var(--border);
    font-size: 12px;
    color: var(--text-muted);
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .undo {
    background: transparent;
    border: none;
    color: var(--accent);
    font-size: 12px;
    padding: 0;
  }
  .undo:hover {
    text-decoration: underline;
  }
</style>
