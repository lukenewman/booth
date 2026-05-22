<script lang="ts">
  import { onMount } from 'svelte';
  import Explorer from '$lib/components/Explorer.svelte';
  import ShortcutOverlay from '$lib/components/ShortcutOverlay.svelte';
  import { installKeyboard } from '$lib/keyboard.svelte';
  import { session } from '$lib/stores/session.svelte';
  import { collection } from '$lib/stores/collection.svelte';
  import { toast } from '$lib/stores/toast.svelte';

  let setupNeeded = $state<null | 'no_token' | 'invalid_token'>(null);
  let probed = $state(false);
  let shortcutOpen = $state(false);

  onMount(async () => {
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

    // Listview row navigation (↑/↓ and ⏎-to-open) lives inside Explorer
    // through DOM focus; deeper integration is in BACKLOG.md.
    const teardown = installKeyboard(
      {
        focusSearch: () => {
          document.querySelector<HTMLInputElement>('input.search')?.focus();
        },
        openScanner: () => {
          document.querySelector<HTMLButtonElement>('button[title^="Scan barcode"]')?.click();
        },
        moveDown: () => {
          const rows = Array.from(
            document.querySelectorAll<HTMLButtonElement>('.body button.row-btn'),
          );
          if (rows.length === 0) return;
          const active = document.activeElement;
          const search = document.querySelector<HTMLInputElement>('input.search');
          // From search input → focus the first row.
          if (active === search) {
            rows[0].focus({ preventScroll: false });
            rows[0].scrollIntoView({ block: 'nearest' });
            return;
          }
          // From a row → focus the next row.
          const idx = active instanceof HTMLButtonElement ? rows.indexOf(active) : -1;
          if (idx >= 0 && idx < rows.length - 1) {
            rows[idx + 1].focus({ preventScroll: false });
            rows[idx + 1].scrollIntoView({ block: 'nearest' });
          }
        },
        moveUp: () => {
          const rows = Array.from(
            document.querySelectorAll<HTMLButtonElement>('.body button.row-btn'),
          );
          if (rows.length === 0) return;
          const active = document.activeElement;
          const idx = active instanceof HTMLButtonElement ? rows.indexOf(active) : -1;
          if (idx === 0) {
            // From the first row → focus the search input.
            document.querySelector<HTMLInputElement>('input.search')?.focus();
            return;
          }
          if (idx > 0) {
            rows[idx - 1].focus({ preventScroll: false });
            rows[idx - 1].scrollIntoView({ block: 'nearest' });
          }
        },
        commit: () => {
          const active = document.activeElement;
          // On a focused row → open its detail (same effect as clicking).
          if (active instanceof HTMLButtonElement && active.classList.contains('row-btn')) {
            active.click();
            return;
          }
          // Otherwise → press the visible primary Add CTA, if any.
          document.querySelector<HTMLButtonElement>('button.add-btn')?.click();
        },
        cancel: () => {
          // 1. If scanner overlay open, close it.
          const closeBtn = document.querySelector<HTMLButtonElement>('button.scanner-close');
          if (closeBtn) { closeBtn.click(); return; }
          // 2. If search input focused with a value, clear it.
          const input = document.querySelector<HTMLInputElement>('input.search');
          if (input && document.activeElement === input) {
            if (input.value) {
              const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
              setter?.call(input, '');
              input.dispatchEvent(new Event('input', { bubbles: true }));
              return;
            }
            input.blur();
          }
        },
        undoLast: async () => {
          // Prefer the visible Remove button in the detail pane — it handles
          // persistent removal via the server-side instance_id facet lookup,
          // not just this-session items.
          const removeBtn = document.querySelector<HTMLButtonElement>('button.remove-btn');
          if (removeBtn) { removeBtn.click(); return; }
          // Otherwise fall back to undoing the most-recent session add.
          const last = session.last;
          if (!last) return;
          try {
            const res = await fetch('/api/discogs/collection/remove', {
              method: 'DELETE',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ releaseId: last.releaseId, instanceId: last.instanceId }),
            });
            if (res.ok) {
              session.removeById(last.releaseId, last.instanceId);
              collection.markRemoved(last.releaseId);
              toast.show('Undone');
            } else {
              toast.show('Could not undo. Try again.');
            }
          } catch {
            toast.show('Could not undo. Network error.');
          }
        },
        toggleShortcuts: () => { shortcutOpen = !shortcutOpen; },
      },
      {
        isScannerOpen: () => !!document.querySelector('.scanner-overlay'),
      },
    );

    return teardown;
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
    <p>Restart <code>bun dev</code> after editing.</p>
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
