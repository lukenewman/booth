<script lang="ts">
  import { playlists } from '$lib/stores/playlists.svelte';

  /**
   * Remove-track confirmation, shared by the plain playlist view and the gig
   * view. Both the row × and the global Delete key set `pendingRemove`.
   */
  let confirmPanel = $state<HTMLDivElement>();

  // Focus the confirm modal when it opens so Enter/Esc work immediately.
  $effect(() => {
    if (playlists.pendingRemove) confirmPanel?.focus();
  });
</script>

{#if playlists.pendingRemove}
  {@const pr = playlists.pendingRemove}
  <div class="backdrop" onclick={() => playlists.cancelRemove()} role="presentation">
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="confirm-modal"
      bind:this={confirmPanel}
      tabindex={-1}
      role="dialog"
      aria-modal="true"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') { e.preventDefault(); playlists.cancelRemove(); }
        else if (e.key === 'Enter') { e.preventDefault(); playlists.confirmRemove(); }
      }}
    >
      <div class="modal-title">Remove from playlist?</div>
      <div class="modal-body">
        <span class="track-name">{pr.trackTitle}</span>
        <span class="from">from {playlists.openPlaylist?.name ?? 'playlist'}</span>
      </div>
      <div class="modal-actions">
        <button class="ghost" onclick={() => playlists.cancelRemove()}>Cancel</button>
        <button class="danger" onclick={() => playlists.confirmRemove()}>Remove</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed; inset: 0; background: rgba(0, 0, 0, 0.6);
    display: flex; align-items: center; justify-content: center; padding: 24px; z-index: 160;
  }
  .confirm-modal {
    background: var(--bg-raised); border: 1px solid var(--border-strong);
    border-radius: var(--radius); padding: 18px 20px; min-width: 300px; max-width: 380px;
    outline: none;
  }
  .modal-title { font-size: 14px; font-weight: 600; color: var(--text); margin-bottom: 10px; }
  .modal-body { font-size: 13px; color: var(--text-muted); margin-bottom: 18px; line-height: 1.5; }
  .modal-body .track-name { color: var(--text); font-weight: 500; }
  .modal-body .from { color: var(--text-subtle); }
  .modal-actions { display: flex; justify-content: flex-end; gap: 8px; }
  .modal-actions button {
    border-radius: 4px; padding: 6px 14px; font-family: inherit; font-size: 12px; cursor: pointer;
  }
  .modal-actions .ghost {
    background: transparent; border: 1px solid var(--border-strong); color: var(--text-muted);
  }
  .modal-actions .ghost:hover { border-color: var(--text-muted); color: var(--text); }
  .modal-actions .danger { background: var(--danger); border: 1px solid var(--danger); color: #fff; }
  .modal-actions .danger:hover { filter: brightness(1.1); }
</style>
