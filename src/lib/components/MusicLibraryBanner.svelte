<script lang="ts">
  /**
   * Above the list: the one-time library nudge for people who set booth up
   * before the Music step existed (dismissible), and the standing offer in
   * Sources → Local (not). Renders nothing once the library is connected,
   * apart from the import result, which stays until the view changes.
   */
  import MusicLibraryConnect from './MusicLibraryConnect.svelte';
  import { musicLibrary } from '$lib/stores/musicLibrary.svelte';

  let {
    dismissible,
    onConnected,
  }: {
    dismissible: boolean;
    onConnected: () => void;
  } = $props();

  // Decided once, when the store first knows: connecting flips the store
  // partway through the import, and the banner must stay up to show it.
  // The shell remounts this per view, which is when it is decided again.
  let open = $state<boolean | null>(null);
  let justConnected = $state(false);
  $effect(() => {
    if (open !== null || musicLibrary.connected === null) return;
    open = musicLibrary.connected === false && !(dismissible && musicLibrary.nudgeDismissed);
  });

  function close() {
    open = false;
    if (!justConnected) void musicLibrary.dismissNudge();
  }
</script>

{#if open}
  <aside class="banner" aria-label="Apple Music library">
    <div class="head">
      <h2>{justConnected ? 'Apple Music library connected' : 'Bring in your Apple Music library'}</h2>
      {#if dismissible || justConnected}
        <button class="close" aria-label="Dismiss" onclick={close}>×</button>
      {/if}
    </div>
    <MusicLibraryConnect onConnected={() => { justConnected = true; onConnected(); }} />
  </aside>
{/if}

<style>
  .banner {
    flex-shrink: 0;
    margin: 10px 12px 4px;
    padding: 12px 14px 14px;
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-left: 3px solid var(--accent);
    border-radius: var(--radius);
    max-width: 720px;
  }
  .head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 6px; }
  h2 { font-size: 14px; font-weight: 600; margin: 0; }
  .close {
    width: 24px;
    height: 24px;
    border: none;
    background: none;
    border-radius: var(--radius-sm);
    color: var(--text-subtle);
    font-size: 16px;
    line-height: 1;
  }
  .close:hover { color: var(--text); background: var(--bg-input); }
</style>
