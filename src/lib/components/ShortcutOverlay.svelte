<script lang="ts">
  let {
    open,
    onClose,
  }: {
    open: boolean;
    onClose: () => void;
  } = $props();

  const shortcuts: { key: string; label: string }[] = [
    { key: '[  ]', label: 'Previous / next rail item' },
    { key: '/', label: 'Focus search' },
    { key: 's', label: 'Toggle scanner mode' },
    { key: 'tab', label: 'Toggle tracks / releases' },
    { key: '↑ ↓', label: 'Move selection in results' },
    { key: '↵', label: 'Open confirm / confirm add' },
    { key: 'esc', label: 'Close modal / exit scanner' },
    { key: 'u  •  ⌘Z', label: 'Undo last add' },
    { key: 'a', label: 'Add focused track to a playlist' },
    { key: 'del', label: 'Remove focused track (in a playlist)' },
    { key: '?', label: 'Toggle this overlay' },
  ];
</script>

{#if open}
  <div class="backdrop" onclick={onClose} role="presentation">
    <div
      class="panel"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}
      role="dialog"
      aria-modal="true"
      tabindex={-1}
    >
      <div class="title">Keyboard shortcuts</div>
      <table>
        <tbody>
          {#each shortcuts as s}
            <tr>
              <td><span class="kbd">{s.key}</span></td>
              <td>{s.label}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    z-index: 150;
  }
  .panel {
    background: var(--bg-raised);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    padding: 18px 22px;
    min-width: 280px;
  }
  .title {
    font-size: 13px;
    color: var(--text);
    margin-bottom: 12px;
    font-weight: 600;
  }
  table {
    border-collapse: collapse;
    width: 100%;
  }
  td {
    padding: 5px 8px;
    font-size: 12px;
    color: var(--text-muted);
  }
  td:first-child {
    text-align: right;
    width: 1%;
    white-space: nowrap;
  }
</style>
