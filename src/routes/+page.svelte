<script lang="ts">
  import { onMount } from 'svelte';
  import DesktopShell from '$lib/components/DesktopShell.svelte';
  import MobileShell from '$lib/components/MobileShell.svelte';
  import ShortcutOverlay from '$lib/components/ShortcutOverlay.svelte';
  import { installKeyboard } from '$lib/keyboard.svelte';
  import { session } from '$lib/stores/session.svelte';
  import { collection } from '$lib/stores/collection.svelte';
  import { toast } from '$lib/stores/toast.svelte';
  import { explorerState } from '$lib/stores/explorerState.svelte';
  import { player } from '$lib/stores/player.svelte';
  import { playlists } from '$lib/stores/playlists.svelte';
  import PlaylistPicker from '$lib/components/PlaylistPicker.svelte';
  import DiscogsOnboarding from '$lib/components/DiscogsOnboarding.svelte';

  // Which shell to mount. Decided from the viewport, which is why SSR is off
  // for this route (see +page.ts) — the server cannot know it, and rendering
  // one shell then hydrating into the other would flash and double-fetch.
  let isMobile = $state(false);

  let setupNeeded = $state<null | 'no_token' | 'invalid_token'>(null);
  let probed = $state(false);
  let shortcutOpen = $state(false);
  let pickerTarget = $state<{ kind: 'track' | 'release'; id: string } | null>(null);

  onMount(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    isMobile = mq.matches;
    const onShellChange = (e: MediaQueryListEvent) => (isMobile = e.matches);
    mq.addEventListener('change', onShellChange);

    // Fire-and-forget setup probe — kept out of onMount's return path so the
    // teardown below resolves synchronously (Svelte's onMount can't accept
    // an async function that also returns a cleanup).
    void (async () => {
      try {
        const res = await fetch('/api/setup/discogs');
        const data = await res.json().catch(() => ({}));
        if (data?.status === 'no_token' || data?.status === 'invalid_token') {
          setupNeeded = data.status;
        }
      } catch {
        // Treat as no setup error — endpoint failures surface via toast on use.
      } finally {
        probed = true;
      }
    })();

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
          // From search (or the runout filter) → focus the first row.
          if (active === search || (active instanceof HTMLInputElement && active.classList.contains('runout-input'))) {
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
            return;
          }
          // 2b. Same for the runout filter in a master's version list: clear,
          //     then blur, and only then does Esc leave the list.
          const runout = document.querySelector<HTMLInputElement>('input.runout-input');
          if (runout && document.activeElement === runout) {
            if (runout.value) {
              const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
              setter?.call(runout, '');
              runout.dispatchEvent(new Event('input', { bubbles: true }));
              return;
            }
            runout.blur();
            return;
          }
          // 3. If drilled into a master's versions (Add → Discogs), go back.
          const back = document.querySelector<HTMLButtonElement>('button.drill-back');
          if (back) { back.click(); return; }
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
        toggleEntity: () => {
          const buttons = Array.from(
            document.querySelectorAll<HTMLButtonElement>('.bar .toggle button'),
          );
          if (buttons.length === 0) return;
          const activeIdx = buttons.findIndex((b) => b.classList.contains('active'));
          buttons[(activeIdx + 1) % buttons.length]?.click();
        },
        toggleShortcuts: () => { shortcutOpen = !shortcutOpen; },
        // DOM-driven like the actions around it: clicking the row's own star
        // reuses the exact path a mouse click takes, so there is no second
        // copy of the toggle logic to drift. Covers both row shapes — listview
        // rows (.row-btn) and the release tracklist (.track-row).
        toggleStar: () => {
          const el = document.activeElement as HTMLElement | null;
          const row = el?.closest<HTMLElement>('.row-btn, .track-row');
          row?.querySelector<HTMLButtonElement>('button.star')?.click();
        },
        markVetted: () => {
          document.querySelector<HTMLButtonElement>('.vet-btn')?.click();
        },
        navRailNext: () => {
          const items = Array.from(document.querySelectorAll<HTMLButtonElement>('.rail button.item'));
          if (items.length === 0) return;
          const idx = items.findIndex((el) => el.classList.contains('active'));
          const next = idx < items.length - 1 ? items[idx + 1] : null;
          next?.click();
        },
        navRailPrev: () => {
          const items = Array.from(document.querySelectorAll<HTMLButtonElement>('.rail button.item'));
          if (items.length === 0) return;
          const idx = items.findIndex((el) => el.classList.contains('active'));
          const prev = idx > 0 ? items[idx - 1] : null;
          prev?.click();
        },
        togglePlay: () => {
          if (!player.nowPlaying) return;
          player.isPlaying ? player.pause() : player.resume();
        },
        addToPlaylist: () => {
          const active = document.activeElement;
          if (!(active instanceof HTMLElement) || !active.classList.contains('row-btn')) return;
          const trackId = active.dataset.id;
          if (!trackId) return;
          // Only meaningful for track rows: the tracks lens, or inside a playlist.
          // Add → Discogs rows are search hits whatever the stored lens says.
          if (explorerState.nav.section === 'add') return;
          if (explorerState.entity !== 'tracks' && explorerState.nav.section !== 'playlist') return;
          pickerTarget = { kind: 'track', id: trackId };
        },
        addToCrate: () => {
          const active = document.activeElement;
          // List rows and grid cards both carry the release id.
          if (!(active instanceof HTMLElement) || !active.matches('.row-btn, .card-btn')) return;
          const releaseId = active.dataset.id;
          // Library release rows only: in the tracks lens or a playlist data-id
          // is a track, and in Add → Discogs it is a Discogs search hit.
          if (!releaseId || explorerState.entity !== 'releases' || explorerState.nav.section !== 'library') return;
          pickerTarget = { kind: 'release', id: releaseId };
        },
        removeFromPlaylist: () => {
          if (explorerState.nav.section !== 'playlist') return;
          const active = document.activeElement;
          if (!(active instanceof HTMLElement) || !active.classList.contains('row-btn')) return;
          const trackId = active.dataset.id;
          const open = playlists.openPlaylist;
          if (!trackId || !open) return;
          const title = open.tracks.find((t) => t.id === trackId)?.title ?? 'this track';
          playlists.requestRemove(open.id, trackId, title);
        },
      },
      {
        isScannerOpen: () => !!document.querySelector('.scanner-overlay'),
        // The scan button only renders in Add → Discogs, so its presence is
        // what tells `s` which of its two meanings applies.
        isScannerAvailable: () => !!document.querySelector('button[title^="Scan barcode"]'),
        // The toolbar omits the toggle for rail items that have no
        // tracks-side concept (Add → Discogs today). The toolbar's `.toggle`
        // element going missing is the DOM-driven signal — Tab becomes a
        // no-op so users don't get a confused-feeling URL toggle.
        isEntityToggleSuppressed: () => !document.querySelector('.bar .toggle'),
      },
    );

    return () => {
      mq.removeEventListener('change', onShellChange);
      teardown();
    };
  });
</script>

{#if !probed}
  <!-- Initial blank to avoid setup-flash. -->
{:else if setupNeeded}
  <DiscogsOnboarding reason={setupNeeded} onDone={() => (setupNeeded = null)} />
{:else}
  {#if isMobile}
    <MobileShell />
  {:else}
    <DesktopShell />
  {/if}
  <ShortcutOverlay open={shortcutOpen} onClose={() => (shortcutOpen = false)} />
  {#if pickerTarget}
    <PlaylistPicker target={pickerTarget} onClose={() => (pickerTarget = null)} />
  {/if}
{/if}

