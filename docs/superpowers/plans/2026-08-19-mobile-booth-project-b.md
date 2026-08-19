# Mobile Booth (Project B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Booth usable on a phone — a bottom-tab mobile shell over the same controller the desktop three-pane grid uses, with playback, PWA install, and a reorder gesture that works on touch.

**Architecture:** `Explorer.svelte` (1011 lines, 686 script) currently owns navigation, fetching, URL sync, and every handler. Lift that into a shared controller module so `DesktopShell` and `MobileShell` become thin views over one source of truth, and every leaf component (`ReleaseList`, `TrackList`, `ArtistList`, the three detail panes, `PlaylistView`) is reused unchanged by both.

**Tech Stack:** SvelteKit 2, Svelte 5 runes, TypeScript, Bun.

**Spec:** `docs/superpowers/specs/2026-08-18-remote-access-and-mobile-design.md`

**Linear:** Task 1 = BOO-55, Task 2 = BOO-54, Task 3 = BOO-52, Task 4 = BOO-53.

## Sequencing decision: 55 and 54 run first

The spec's Delivery table marks issues 6–8 as blocked by issue 5 (the controller extraction). Re-reading it, that dependency is **conflict-avoidance, not technical** — the spec's stated reason is keeping a second nav mode out of a 1011-line component, and neither the pointer-events reorder (`PlaylistView.svelte`) nor the PWA work (new `static/` files, one CSS unit, `Player.svelte`) is a nav mode.

So this plan runs the two self-contained issues first and the large refactor last. Rationale: BOO-52 is a ~700-line move through code that carries documented Svelte 5 reactivity landmines (see Global Constraints), and its only verification is manual. Doing it last means a failure costs least — everything else is already committed, and each task is an independently revertable commit.

BOO-53 (MobileShell) has a genuine technical dependency on BOO-52 and stays last.

## Global Constraints

- **Bun only**, `bun check` must pass before every commit, no test runner may be added. Verification idiom is `bun verify scripts/<name>.ts`. (Full rationale in the Project A plan.)
- **Svelte 5 runes.** Runes outside a component require a `.svelte.ts` file — the project already does this in `explorerState.svelte.ts`, `player.svelte.ts`, `playlists.svelte.ts`. Follow that.
- **`Explorer.svelte` carries two documented reactivity landmines. Preserve both verbatim when moving code:**
  1. `listLoading` is a plain `let`, **not** `$state`, because `loadList` reads and writes it from inside the load-list `$effect` and making it reactive trips `effect_update_depth_exceeded`.
  2. The URL-sync `$effect` reads each `explorerState` field into a local before use. The existing comment says calling `serialize()` or going through an intermediate `$derived` both have tracking gaps in Svelte 5 with class-state singletons. Do not "tidy" this into a method call.
  Also preserve the `loadGen` generation counter that lets an in-flight fetch discard itself when a newer reset load has started.
- **Leaf components are reused unchanged.** If a task needs to edit `ReleaseList`, `TrackList`, `ArtistList`, `ReleaseDetail`, `TrackDetail`, or `ArtistDetail`, that is a signal the extraction is leaking.
- **No server work.** Every endpoint mobile needs already exists.
- Work directly on `main`. Commit per task.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/lib/dnd.ts` | modify — add a pointer-drag helper beside the DnD one | 1 |
| `src/lib/components/PlaylistView.svelte` | modify — reorder via pointer events, explicit grab handle | 1 |
| `static/manifest.webmanifest` | create — PWA manifest | 2 |
| `static/icon-192.png`, `static/icon-512.png` | create — install icons | 2 |
| `src/app.html` | modify — manifest + theme-color links | 2 |
| `src/lib/components/Player.svelte` | modify — MediaSession wiring (it owns the `<audio>` element) | 2 |
| `src/lib/components/Explorer.svelte` | modify — `100vh` → `100dvh`, 44px touch targets | 2 |
| `src/lib/stores/explorerController.svelte.ts` | create — the shared controller | 3 |
| `src/lib/components/DesktopShell.svelte` | create — today's three-pane grid, as a view | 3 |
| `src/routes/+page.svelte` | modify — mount shell by viewport | 3, 4 |
| `src/routes/+page.ts` | create — `export const ssr = false` | 4 |
| `src/lib/components/MobileShell.svelte` | create — bottom tabs, push nav | 4 |
| `src/lib/components/mobile/*.svelte` | create — tab bar, header, search tab | 4 |

---

### Task 1: Playlist reorder on pointer events (BOO-55)

**Files:**
- Modify: `src/lib/dnd.ts`
- Modify: `src/lib/components/PlaylistView.svelte`

**Interfaces:**
- Produces: `startPointerDrag(opts): void` from `$lib/dnd`.

**The problem:** `PlaylistView.svelte` reorders with HTML5 drag-and-drop (`draggable="true"`, `ondragstart`/`ondragover`/`ondrop`). **DnD does not fire on touch** — reorder is not degraded on mobile, it is dead.

Pointer events cover mouse *and* touch, so desktop reorder keeps working through the same path rather than needing two implementations.

- [ ] **Step 1: Add the pointer-drag helper**

Append to `src/lib/dnd.ts`:

```ts
export interface PointerDragOptions {
  /** The pointerdown event that started the drag. */
  event: PointerEvent;
  /** The row being dragged. */
  row: HTMLElement;
  /** Scroll container holding the rows; rows are matched by `[data-id]`. */
  list: HTMLElement;
  /** Called as the pointer moves over a different row. */
  onOver: (id: string | null) => void;
  /** Called on release with the row the pointer ended over (null = cancelled). */
  onDrop: (id: string | null) => void;
}

/**
 * Drag a list row with pointer events, which — unlike HTML5 drag-and-drop —
 * fire for touch as well as mouse. Uses setPointerCapture so the gesture keeps
 * tracking even when the finger leaves the row.
 */
export function startPointerDrag(opts: PointerDragOptions): void {
  const { event, row, list, onOver, onDrop } = opts;
  event.preventDefault();
  row.setPointerCapture(event.pointerId);

  const startOpacity = row.style.opacity;
  row.style.opacity = '0.5';

  function rowIdAt(clientX: number, clientY: number): string | null {
    for (const el of list.querySelectorAll<HTMLElement>('[data-id]')) {
      const r = el.getBoundingClientRect();
      if (clientY >= r.top && clientY <= r.bottom && clientX >= r.left && clientX <= r.right) {
        return el.dataset.id ?? null;
      }
    }
    return null;
  }

  let lastId: string | null = null;

  function move(e: PointerEvent) {
    const id = rowIdAt(e.clientX, e.clientY);
    if (id !== lastId) {
      lastId = id;
      onOver(id);
    }
  }

  function finish(e: PointerEvent, cancelled: boolean) {
    row.style.opacity = startOpacity;
    row.releasePointerCapture?.(e.pointerId);
    row.removeEventListener('pointermove', move);
    row.removeEventListener('pointerup', up);
    row.removeEventListener('pointercancel', cancel);
    onOver(null);
    onDrop(cancelled ? null : rowIdAt(e.clientX, e.clientY));
  }

  function up(e: PointerEvent) { finish(e, false); }
  function cancel(e: PointerEvent) { finish(e, true); }

  row.addEventListener('pointermove', move);
  row.addEventListener('pointerup', up);
  row.addEventListener('pointercancel', cancel);
}
```

- [ ] **Step 2: Switch PlaylistView's rows to it**

In `PlaylistView.svelte`, remove `draggable="true"`, `ondragstart`, `ondragover`, `ondragleave`, and `ondrop` from the track row button, and drop the `translucentDragImage` import if nothing else uses it.

Add a grab handle inside the row (touch needs an explicit affordance — a long-press-anywhere drag would fight scrolling):

```svelte
<span
  class="grip"
  aria-label="Reorder"
  onpointerdown={(e) => {
    const rowEl = (e.currentTarget as HTMLElement).closest('[data-id]');
    if (!(rowEl instanceof HTMLElement) || !listEl) return;
    dragId = rowEl.dataset.id ?? null;
    startPointerDrag({
      event: e,
      row: rowEl,
      list: listEl,
      onOver: (id) => (overId = id),
      onDrop: (id) => { if (id) applyReorder(id); dragId = null; },
    });
  }}
>⠿</span>
```

Bind the scroll container with `bind:this={listEl}` and declare `let listEl = $state<HTMLElement | null>(null);`.

- [ ] **Step 3: Reuse the existing reorder maths**

The current `onDrop` already computes the new order. Extract it so both the old and new paths agree:

```ts
function applyReorder(targetId: string) {
  const moved = dragId;
  if (!moved || moved === targetId) return;
  const open = playlists.openPlaylist;
  if (!open) return;
  const ids = open.tracks.map((t) => t.id);
  if (!ids.includes(moved)) return; // dragged in from elsewhere — add happens via the rail
  const without = ids.filter((id) => id !== moved);
  without.splice(without.indexOf(targetId), 0, moved);
  playlists.reorder(open.id, without);
}
```

- [ ] **Step 4: Style the handle to a touch-sized target**

```css
.grip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 44px;
  min-height: 44px;
  cursor: grab;
  color: var(--text-dim);
  touch-action: none; /* stop the browser scrolling instead of dragging */
  user-select: none;
}
.grip:active { cursor: grabbing; }
```

`touch-action: none` is load-bearing — without it the browser claims the gesture for scrolling and no pointermove reaches the handler.

- [ ] **Step 5: Verify**

```bash
bun check
```

Then in the browser, on a playlist with 3+ tracks:
- [ ] Drag a row by the handle with a mouse; order changes and persists across reload
- [ ] Row click still selects, double-click still plays (the handle must not swallow them)
- [ ] Dragging with DevTools device emulation (touch) reorders

- [ ] **Step 6: Commit**

```bash
git add src/lib/dnd.ts src/lib/components/PlaylistView.svelte
git commit -m "feat(playlists): reorder on pointer events so touch works

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: PWA manifest, dvh, MediaSession, touch targets (BOO-54)

**Files:**
- Create: `static/manifest.webmanifest`, `static/icon-192.png`, `static/icon-512.png`
- Modify: `src/app.html`, `src/lib/components/Player.svelte`, `src/lib/components/Explorer.svelte`

- [ ] **Step 1: Manifest**

`static/manifest.webmanifest`:

```json
{
  "name": "Booth",
  "short_name": "Booth",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#0a0a0a",
  "theme_color": "#0a0a0a",
  "icons": [
    { "src": "/icon-192.png", "type": "image/png", "sizes": "192x192" },
    { "src": "/icon-512.png", "type": "image/png", "sizes": "512x512" },
    { "src": "/icon-512.png", "type": "image/png", "sizes": "512x512", "purpose": "maskable" }
  ]
}
```

`#0a0a0a` matches `--bg`.

- [ ] **Step 2: Icons**

Generate two solid-background PNGs with a centred glyph, using Bun (no new dependency, no binary committed blind):

```bash
bun -e '
const sizes = [192, 512];
for (const s of sizes) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}"><rect width="${s}" height="${s}" fill="#0a0a0a"/><circle cx="${s/2}" cy="${s/2}" r="${s*0.3}" fill="none" stroke="#e8e8e8" stroke-width="${s*0.05}"/><circle cx="${s/2}" cy="${s/2}" r="${s*0.06}" fill="#e8e8e8"/></svg>`;
  await Bun.write(`static/icon-${s}.svg`, svg);
}
console.log("wrote svg sources");
'
```

Then convert with macOS's built-in `sips` (no dependency):

```bash
for s in 192 512; do
  qlmanage -t -s $s -o static static/icon-$s.svg >/dev/null 2>&1 || true
done
```

If `qlmanage` does not produce usable PNGs, reference the SVGs directly in the manifest instead (`"type": "image/svg+xml"`) — iOS ignores SVG icons for home-screen install, so in that case note it as a follow-up rather than blocking the task.

- [ ] **Step 3: Link it from app.html**

In `src/app.html`, inside `<head>`:

```html
	<link rel="manifest" href="%sveltekit.assets%/manifest.webmanifest" />
	<meta name="theme-color" content="#0a0a0a" />
	<meta name="apple-mobile-web-app-capable" content="yes" />
	<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
	<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
```

If a `viewport` meta already exists, replace it rather than adding a second.

- [ ] **Step 4: dvh**

In `Explorer.svelte`, change the shell height from `100vh` to `100dvh`. iOS Safari's dynamic URL bar otherwise pushes the PlayerBar under browser chrome.

- [ ] **Step 5: MediaSession**

In `Player.svelte` — it owns the `<audio>` element — add an effect that mirrors now-playing into the OS and wires the lock-screen transport to the existing store methods:

```ts
  $effect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    const np = player.nowPlaying;
    if (!np) {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = 'none';
      return;
    }
    navigator.mediaSession.metadata = new MediaMetadata({
      title: np.title,
      artist: np.artist,
      artwork: np.thumbUrl ? [{ src: np.thumbUrl, sizes: '512x512', type: 'image/jpeg' }] : [],
    });
    navigator.mediaSession.playbackState = player.isPlaying ? 'playing' : 'paused';
  });

  $effect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    ms.setActionHandler('play', () => player.resume());
    ms.setActionHandler('pause', () => player.pause());
    ms.setActionHandler('nexttrack', () => void player.next());
    ms.setActionHandler('previoustrack', () => void player.prev());
    return () => {
      for (const a of ['play', 'pause', 'nexttrack', 'previoustrack'] as const) {
        ms.setActionHandler(a, null);
      }
    };
  });
```

- [ ] **Step 6: Touch targets**

Raise list rows to a 44px minimum. In `Explorer.svelte`'s styles add, scoped to the breakpoint so desktop density is untouched:

```css
  @media (max-width: 768px) {
    :global(.row-btn),
    :global(.row) {
      min-height: 44px;
    }
  }
```

- [ ] **Step 7: Verify and commit**

```bash
bun check
bun run build && bun start
```

- [ ] Load `/manifest.webmanifest` — returns JSON, not 404
- [ ] DevTools → Application → Manifest shows name/icons with no errors
- [ ] Play a track; OS media controls show title/artist and the transport buttons work

```bash
git add static src/app.html src/lib/components/Player.svelte src/lib/components/Explorer.svelte
git commit -m "feat(mobile): PWA manifest, dvh sizing, MediaSession, touch targets

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Extract the explorer controller (BOO-52)

**Files:**
- Create: `src/lib/stores/explorerController.svelte.ts`
- Create: `src/lib/components/DesktopShell.svelte`
- Modify: `src/routes/+page.svelte`
- Delete: `src/lib/components/Explorer.svelte` (its markup becomes `DesktopShell`)

**This is a pure refactor. Desktop behaviour must be observably identical.**

- [ ] **Step 1: Create the controller**

`src/lib/stores/explorerController.svelte.ts` — a factory returning getters, called once from a component script so its `$effect`s attach to that component's scope.

Move, unchanged in behaviour:

* state: `sources`, `counts`, `syncing`, `listItems`, `listTotal`, `listHasMore`, `searchHits`, `drillMasterId`, `detailKind`, `detailData`, `plDetail`, `recordingRelease`, `recordingMinimized`, `addSubmitting`, `syncRunsReloadKey`, `scannerOpen`, `releaseView`
* non-reactive: `listLoading`, `loadGen` — **must stay plain `let`** (see Global Constraints)
* functions: `loadSourcesAndCounts`, `loadList`, `loadDetail`, `orderedDetailEndpoints`, `openPlaylistEntity`, `openReleaseFromPlayer`, `mapVersion`, `onAddRowSelect`, `popDrill`, `handleAdd`, `handleUndo`, `handleRemove`, `removeFromDiscogs`, `handleSync`
* derived: `selectedSource`, `currentEntity`, `isAddView`, `isSourcesView`, `isPlaylistView`, `libraryQuery`, `masterGroups`, `drilledMaster`, `addItems`, `showEntityToggle`, `showReleaseOnlySourceEmpty`, `toolbarPlaceholder`, `discogsSearchUrl`, `toolbarMeta`, `sourceMetaForDetail`, `releaseDetailCta`
* the five `$effect` blocks and the `onMount` body

Expose everything the markup reads as a getter. Writable UI state (`scannerOpen`, `releaseView`) needs a setter or a `set*` method — a getter alone cannot be assigned from markup.

- [ ] **Step 2: Create DesktopShell**

`DesktopShell.svelte` is `Explorer.svelte`'s markup and `<style>` verbatim, with its script reduced to:

```svelte
<script lang="ts">
  import { createExplorerController } from '$lib/stores/explorerController.svelte';
  const c = createExplorerController();
</script>
```

and every bare identifier in the markup re-pointed at `c.` — `sources` → `c.sources`, `handleSync` → `c.handleSync`, and so on.

- [ ] **Step 3: Point the route at it**

In `src/routes/+page.svelte`, import `DesktopShell` instead of `Explorer`, then delete `Explorer.svelte`.

- [ ] **Step 4: Verify — the whole point of the task**

```bash
bun check
```

Then, manually, against `bun dev`. Every one of these must behave exactly as before:

- [ ] Rail navigation across library / sources / add / playlists
- [ ] Entity lens: `Tab` cycles releases → tracks → artists, and the URL `?entity=` follows
- [ ] Search in library mode **and** in Add → Discogs mode (they use different endpoints)
- [ ] Add a release, then undo it
- [ ] Remove a release already in the collection
- [ ] Playlists: open, select a row, click through to artist/release detail
- [ ] Playback: double-click a track, then next/prev
- [ ] Sync chip on a source, and the run history below it
- [ ] Reload a deep-linked URL with `?nav=`, `?id=`, `?q=`, `?entity=` — state restores
- [ ] Master drill-down in Add → Discogs, and the back button out of it

**If any diverge, revert the commit rather than patching forward** — a half-extracted controller is worse than none.

- [ ] **Step 5: Fold in the CONTEXT.md correction**

The spec's follow-up: `docs/CONTEXT.md`'s file map omits `ReleaseGrid.svelte` (168 lines). This task rewrites that part of the tree, so correct it here, and replace the `Explorer.svelte` entry with `DesktopShell.svelte` + `explorerController.svelte.ts`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(explorer): extract controller; Explorer becomes DesktopShell

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: MobileShell (BOO-53)

**Depends on Task 3.** Do not start until the desktop verification checklist above passes.

**Files:**
- Create: `src/routes/+page.ts`, `src/lib/components/MobileShell.svelte`, `src/lib/components/mobile/TabBar.svelte`, `src/lib/components/mobile/MobileHeader.svelte`, `src/lib/components/mobile/SearchTab.svelte`
- Modify: `src/routes/+page.svelte`

- [ ] **Step 1: Disable SSR**

`src/routes/+page.ts`:

```ts
// Shell choice depends on viewport, which the server cannot know — with SSR on,
// the server renders one shell and hydrates into the other. Verified 2026-08-18:
// src/routes/ has no load functions and all data arrives via client-side /api
// fetches, so SSR already renders data-less markup. Cost is one blank frame on
// cold load. Does not affect the boot sync hook, which fires on API requests too.
export const ssr = false;
```

- [ ] **Step 2: Choose the shell by viewport**

In `+page.svelte`:

```svelte
<script lang="ts">
  import { onMount } from 'svelte';
  import DesktopShell from '$lib/components/DesktopShell.svelte';
  import MobileShell from '$lib/components/MobileShell.svelte';

  let isMobile = $state(false);
  onMount(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    isMobile = mq.matches;
    const onChange = (e: MediaQueryListEvent) => (isMobile = e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  });
</script>

{#if isMobile}<MobileShell />{:else}<DesktopShell />{/if}
```

- [ ] **Step 3: Tab bar**

Four tabs — **Library · Playlists · Add · Search** — as a fixed bottom bar, each 44px minimum, with the active tab marked `aria-current="page"`. Respect the home-indicator inset with `padding-bottom: env(safe-area-inset-bottom)`.

Tabs map onto the existing nav model: Library → `{section:'library', item:'all'}`, Playlists → the playlist list, Add → `{section:'add', item:'discogs'}`. Search is shell-local state, not a rail section.

- [ ] **Step 4: Push navigation**

Within a tab, selecting a row pushes the detail over the list with a back chevron. Model as a per-tab boolean derived from `explorerState.id` being set — do not add a second source of truth for selection.

- [ ] **Step 5: Header**

`MobileHeader` shows the tab title, and in Library a **Sources** button opening a sheet with the sync chip and `SyncRunHistory` — so a ⚠ stale warning stays visible away from the desk.

- [ ] **Step 6: Entity lens control**

A visible segmented control (Releases / Tracks / Artists) in the mobile toolbar writing the same `?entity=` param via `explorerState.setEntityKind`. `Tab` is keyboard-only and unreachable on a phone.

- [ ] **Step 7: Search tab**

Global search over the existing `/api/library/{releases,tracks,artists}?q=` — no server work. The Library tab drops its own search input.

- [ ] **Step 8: Hide vinyl recording**

"⏺ Record from vinyl" does not render below the breakpoint — it needs the physically-attached audio interface. **The scanner stays**: on a phone the ergonomics invert from bad to good.

- [ ] **Step 9: Confirm the keyboard wiring no-ops**

`installKeyboard` stays desktop-only. It is DOM-driven and its probe elements will not exist in the mobile shell, so it should no-op safely — **confirm rather than assume**, by loading the mobile shell and checking the console for errors.

- [ ] **Step 10: Verify and commit**

- [ ] At ≤768px the mobile shell mounts; above it the desktop grid is unchanged
- [ ] All four tabs navigate, and back returns from detail
- [ ] Entity control switches lens and updates the URL
- [ ] Playback works, with the mini-player above the tab bar
- [ ] No console errors from keyboard wiring

```bash
git add -A
git commit -m "feat(mobile): bottom-tab MobileShell with push nav and Search tab

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Done when

- Playlist reorder works by touch and by mouse through one code path.
- Booth installs to a phone home screen and shows OS media controls during playback.
- `DesktopShell` and `MobileShell` are thin views over one controller, with desktop behaviour unchanged.
- `bun check` clean throughout.
