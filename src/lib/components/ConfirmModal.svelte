<script lang="ts">
  import type { DiscogsRelease } from '$lib/types';

  let {
    release,
    onConfirm,
    onCancel,
    submitting = false,
    error: errorMsg = null,
  }: {
    release: DiscogsRelease;
    onConfirm: () => void;
    onCancel: () => void;
    submitting?: boolean;
    error?: string | null;
  } = $props();
</script>

<div class="backdrop" onclick={onCancel} role="presentation">
  <div class="modal" onclick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
    <div class="cover">
      {#if release.coverImage || release.thumb}
        <img src={release.coverImage ?? release.thumb} alt="" />
      {/if}
    </div>
    <div class="title">{release.title}</div>
    <div class="sub">{release.artist}{release.year ? ` · ${release.year}` : ''}</div>

    <div class="rows">
      {#if release.format}<div class="row"><span>Format</span><span>{release.format}</span></div>{/if}
      {#if release.country}<div class="row"><span>Country</span><span>{release.country}</span></div>{/if}
      {#if release.label}<div class="row"><span>Label</span><span>{release.label}</span></div>{/if}
    </div>

    {#if errorMsg}
      <div class="error">{errorMsg}</div>
    {/if}

    <div class="actions">
      <button type="button" class="primary" onclick={onConfirm} disabled={submitting}>
        {submitting ? 'Adding…' : 'Add'} <span class="kbd primary-kbd">↵</span>
      </button>
      <button type="button" class="secondary" onclick={onCancel} disabled={submitting}>
        Cancel <span class="kbd">esc</span>
      </button>
    </div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.65);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    z-index: 100;
  }
  .modal {
    background: var(--bg-raised);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    padding: 16px;
    width: 100%;
    max-width: 280px;
  }
  .cover {
    width: 100%;
    aspect-ratio: 1;
    background: #2a2a2a;
    border-radius: var(--radius-sm);
    margin-bottom: 12px;
    overflow: hidden;
  }
  .cover img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .title {
    font-size: 14px;
    color: var(--text);
    margin-bottom: 2px;
  }
  .sub {
    font-size: 11px;
    color: var(--text-muted);
    margin-bottom: 12px;
  }
  .rows .row {
    font-size: 11px;
    color: var(--text-muted);
    padding: 2px 0;
    display: flex;
    justify-content: space-between;
  }
  .error {
    margin-top: 10px;
    padding: 6px 8px;
    background: rgba(219, 90, 90, 0.12);
    border: 1px solid rgba(219, 90, 90, 0.3);
    border-radius: 3px;
    color: var(--danger);
    font-size: 11px;
  }
  .actions {
    margin-top: 14px;
    display: flex;
    gap: 6px;
  }
  .primary {
    flex: 1;
    background: var(--accent);
    color: #fff;
    border: none;
    padding: 8px;
    border-radius: var(--radius-sm);
    font-size: 13px;
    font-weight: 600;
  }
  .primary:disabled {
    opacity: 0.6;
  }
  .secondary {
    background: transparent;
    color: var(--text-muted);
    border: 1px solid var(--border-strong);
    padding: 8px 12px;
    border-radius: var(--radius-sm);
    font-size: 13px;
  }
  .primary-kbd {
    background: #3a6bb0;
    border-color: #4a7bc0;
    color: #cfe;
  }
</style>
