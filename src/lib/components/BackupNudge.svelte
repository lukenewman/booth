<script lang="ts">
  /**
   * The backup nudge above the library: no backup yet, the last one over a
   * week old, or releases that aren't in it. Dismissed for a day at a time.
   */
  import { onMount } from 'svelte';
  import { backup } from '$lib/stores/backup.svelte';
  import { explorerState } from '$lib/stores/explorerState.svelte';

  const STALE_DAYS = 7;
  const KEY = 'booth.backupNudgeDismissedAt';

  let dismissedAt = $state<number | null>(null);
  onMount(() => {
    try { dismissedAt = Number(localStorage.getItem(KEY)) || null; } catch { dismissedAt = null; }
    void backup.load();
  });

  const s = $derived(backup.status);
  const message = $derived.by(() => {
    if (!s || s.running) return null;
    if (!s.destination) return 'Booth isn’t backing up your music yet.';
    if (s.lastBackupAt == null) return `Nothing is backed up yet. ${s.releasesNotBackedUp.toLocaleString()} releases to copy.`;
    const stale = (s.daysSince ?? 0) >= STALE_DAYS;
    if (!stale && !s.releasesNotBackedUp) return null;
    const parts = [];
    if (stale) parts.push(`You haven’t backed up in ${s.daysSince} days.`);
    if (s.releasesNotBackedUp) parts.push(`${s.releasesNotBackedUp.toLocaleString()} release${s.releasesNotBackedUp === 1 ? ' isn’t' : 's aren’t'} in the last backup.`);
    return parts.join(' ');
  });
  // Only nag when it matters: never backed up, a week old, or behind.
  const show = $derived(!!message && !(dismissedAt && Date.now() - dismissedAt < 86_400_000));

  function dismiss() {
    dismissedAt = Date.now();
    try { localStorage.setItem(KEY, String(dismissedAt)); } catch { /* per-viewer convenience only */ }
  }
</script>

{#if show}
  <div class="nudge" role="status">
    <span>{message}</span>
    {#if s?.destination}
      <button class="primary" onclick={() => backup.start()}>Back up now</button>
    {:else}
      <button class="primary" onclick={() => explorerState.setNav({ section: 'sources', item: 'local' })}>Pick a backup drive</button>
    {/if}
    <button class="dismiss" aria-label="Not now" onclick={dismiss}>Not now</button>
  </div>
{/if}

<style>
  .nudge {
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    margin: 8px 12px; padding: 8px 12px; border: 1px solid var(--border-strong); border-radius: var(--radius);
    background: var(--bg-raised); font-size: 12px; color: var(--text);
  }
  .nudge span { flex: 1; min-width: 200px; }
  button { font: inherit; font-size: 12px; cursor: pointer; border-radius: var(--radius); padding: 3px 10px; }
  .primary { background: var(--bg-input); border: 1px solid var(--accent); color: var(--accent); }
  .dismiss { background: none; border: 0; color: var(--text-subtle); text-decoration: underline; padding: 0; }
</style>
