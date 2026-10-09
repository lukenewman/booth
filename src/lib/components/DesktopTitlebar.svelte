<script lang="ts">
  /**
   * The desktop app's title bar (the window's own is hidden). Mostly a drag
   * handle around the traffic lights; when an update has downloaded it carries
   * a quiet "Restart to Update" callout, Zed-style, instead of a dialog.
   */
  import { onMount } from 'svelte';

  const POLL_MS = 60_000;

  let pending = $state<string | null>(null);
  let dismissed = $state<string | null>(null);
  let restarting = $state(false);

  async function poll() {
    try {
      const res = await fetch('/api/desktop/update');
      if (res.ok) pending = (await res.json()).version;
    } catch {
      // Server going away mid-restart, or a blip; the next poll catches up.
    }
  }

  async function restart() {
    restarting = true;
    try {
      const res = await fetch('/api/desktop/update', { method: 'POST' });
      if (!res.ok) restarting = false;
    } catch {
      // The app quitting under the request is the success case.
    }
  }

  /** Native title bars zoom (or minimize) on double-click; the page has to ask. */
  function onDoubleClick(e: MouseEvent) {
    if ((e.target as HTMLElement).closest('.callout')) return;
    void fetch('/api/desktop/titlebar', { method: 'POST' });
  }

  onMount(() => {
    void poll();
    const timer = setInterval(poll, POLL_MS);
    return () => clearInterval(timer);
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="titlebar" ondblclick={onDoubleClick}>
  <span class="title">booth</span>
  {#if pending && dismissed !== pending}
    <div class="callout" title="booth {pending} has downloaded">
      <button class="restart" onclick={restart} disabled={restarting}>
        {restarting ? 'Restarting…' : 'Restart to Update'}
      </button>
      <button class="dismiss" onclick={() => (dismissed = pending)} aria-label="Dismiss until next launch">×</button>
    </div>
  {/if}
</div>

<style>
  .titlebar {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    height: var(--titlebar-h);
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    padding: 0 var(--space-3);
    background: var(--bg);
    border-bottom: 1px solid var(--border);
    /* The whole strip moves the window, like a native title bar. */
    -webkit-app-region: drag;
    user-select: none;
  }
  .title {
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
    font-size: 13px;
    font-weight: 600;
    color: var(--text-muted);
    pointer-events: none;
  }
  .callout {
    display: flex;
    align-items: center;
    height: 24px;
    border: 1px solid var(--accent-border);
    background: var(--accent-bg);
    border-radius: var(--radius-sm);
    -webkit-app-region: no-drag;
  }
  .callout button {
    background: none;
    border: 0;
    font-size: 12px;
    cursor: pointer;
    height: 100%;
    padding: 0 var(--space-2);
  }
  .restart { color: var(--accent-strong); }
  .restart:hover:not(:disabled) { color: var(--text); }
  .restart:disabled { cursor: default; color: var(--text-muted); }
  .callout .dismiss {
    color: var(--text-muted);
    border-left: 1px solid var(--accent-border);
  }
  .dismiss:hover { color: var(--text); }
</style>
