<script lang="ts">
  import { onMount } from 'svelte';
  import Explorer from '$lib/components/Explorer.svelte';
  import ShortcutOverlay from '$lib/components/ShortcutOverlay.svelte';

  let setupNeeded = $state<null | 'no_token' | 'invalid_token'>(null);
  let probed = $state(false);
  let shortcutOpen = $state(false);

  onMount(async () => {
    // Probe the Discogs API to gate on setup. Same content as the Slice 1 flow.
    try {
      const res = await fetch('/api/discogs/search?q=test');
      const data = await res.json().catch(() => ({}));
      if (data?.error === 'no_token' || data?.error === 'invalid_token') {
        setupNeeded = data.error;
      }
    } catch {
      // Treat as no setup error — endpoint failures surface via toast on use.
    } finally {
      probed = true;
    }
  });
</script>

{#if !probed}
  <!-- Initial blank to avoid setup-flash. -->
{:else if setupNeeded}
  <main class="setup">
    <h1>Setup booth</h1>
    <p>
      booth needs a Discogs personal access token to talk to the Discogs API.
      Generate one at <a href="https://www.discogs.com/settings/developers">discogs.com/settings/developers</a>,
      then add it to <code>.env</code>:
    </p>
    <pre><code>DISCOGS_TOKEN=your-token-here</code></pre>
    <p>Restart <code>pnpm dev</code> after editing.</p>
    {#if setupNeeded === 'invalid_token'}
      <p class="error">The token in <code>.env</code> was rejected by Discogs (401). Double-check it's correct.</p>
    {/if}
  </main>
{:else}
  <Explorer />
  <ShortcutOverlay open={shortcutOpen} onClose={() => (shortcutOpen = false)} />
{/if}

<style>
  .setup {
    max-width: 540px;
    margin: 80px auto;
    padding: 24px;
    color: var(--text);
  }
  .setup h1 { font-size: 18px; font-weight: 600; margin-bottom: 12px; }
  .setup p { margin-bottom: 12px; line-height: 1.5; }
  .setup code {
    background: var(--bg-raised);
    border: 1px solid var(--border);
    padding: 1px 5px;
    border-radius: 3px;
    font-family: var(--font-mono);
    font-size: 12px;
  }
  .setup pre {
    background: var(--bg-raised);
    border: 1px solid var(--border);
    padding: 12px;
    border-radius: 4px;
    overflow-x: auto;
  }
  .setup .error { color: var(--danger); }
</style>
