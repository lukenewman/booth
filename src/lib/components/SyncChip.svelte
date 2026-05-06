<script lang="ts">
  /**
   * Sync chip surfaced in the listview toolbar when a Sources rail item is
   * selected. Three states:
   *   - real source, has been synced: "Synced 12m ago · ⟳" (clickable)
   *   - real source, never synced:    "Sync"               (clickable)
   *   - stub source:                  "Not implemented"     (disabled)
   * Shows "Syncing…" with spinner while a sync is in flight.
   */
  let {
    isStub = false,
    lastSyncedAt = null,
    syncing = false,
    onSync,
  }: {
    isStub?: boolean;
    lastSyncedAt?: string | null;
    syncing?: boolean;
    onSync?: () => void;
  } = $props();

  function relativeTime(iso: string): string {
    const then = new Date(iso).getTime();
    const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  const label = $derived(
    isStub
      ? 'Not implemented'
      : syncing
        ? 'Syncing…'
        : lastSyncedAt
          ? `Synced ${relativeTime(lastSyncedAt)} · ⟳`
          : 'Sync',
  );

  const disabled = $derived(isStub || syncing);
</script>

<button class="chip" class:stub={isStub} class:syncing {disabled} onclick={() => onSync?.()}>
  {#if syncing}
    <span class="spinner" aria-hidden="true"></span>
  {/if}
  <span class="label">{label}</span>
</button>

<style>
  .chip {
    background: transparent;
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    color: var(--text-muted);
    padding: 4px 9px;
    font-size: 11px;
    font-family: inherit;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .chip:hover:not(:disabled) {
    color: var(--text);
    border-color: var(--text-muted);
  }
  .chip:disabled {
    cursor: default;
    color: var(--text-subtle);
  }
  .chip.stub { color: var(--text-subtle); }

  .spinner {
    display: inline-block;
    width: 9px;
    height: 9px;
    border: 1.5px solid currentColor;
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 0.75s linear infinite;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
</style>
