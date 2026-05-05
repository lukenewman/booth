# booth — project context

> **Purpose:** Source-of-truth for what's currently shipped. Update at the end of each plan implementation; treat plans/specs in `docs/superpowers/` as historical blueprints, not current state.

## What it is

Single-user, local-only SvelteKit app for adding records to a personal Discogs collection. Two ways in: text search and webcam barcode scan. Keyboard-first, dark theme, no auth UI (token lives in `.env`).

## Tech

- **Runtime:** Node + pnpm. SvelteKit 2 + Svelte 5 (runes), TypeScript, Vite.
- **Camera:** `@zxing/browser` (`BrowserMultiFormatReader`).
- **No tests, no UI framework, no DB.** Session log is in-memory; collection-membership cache is in-memory on the server.
- **Dev:** `pnpm dev` (binds 5173, falls back upward).

## Environment

`.env` (gitignored; example in `.env.example`):

```
DISCOGS_TOKEN=<personal access token from discogs.com/settings/developers>
DISCOGS_FOLDER_ID=1   # optional; defaults to "Uncategorized"
```

Server reads via `$env/dynamic/private` (NOT `process.env` — Vite doesn't auto-populate that).

## File map

```
src/
  app.css                                 dark-theme tokens + globals
  app.html                                <title>booth</title>
  lib/
    types.ts                              DiscogsRelease, SessionEntry, ApiError, AddResponse
    keyboard.svelte.ts                    installKeyboard(actions, state) — global keydown handler
    components/
      SearchBar.svelte                    input + scan button; exports focus()
      ResultsList.svelte                  renders ResultRow per result
      ResultRow.svelte                    row UI; reads collection store for "in collection" badge
      ConfirmModal.svelte                 add confirmation; supports submitting + error states
      Scanner.svelte                      ZXing camera viewfinder; retries NotReadableError up to 3×
      Toast.svelte                        bottom-center toast container
      SessionLog.svelte                   "Added this session: N — undo last"
      ShortcutOverlay.svelte              ? overlay listing shortcuts
    server/
      discogs.ts                          discogsFetch + DiscogsError; reads token via $env/dynamic/private
      username.ts                         lazy /oauth/identity username cache
      collection-cache.ts                 in-memory release-id cache (Map<releaseId, count>); load-once + markAdded/markRemoved
    stores/
      mode.svelte.ts                      'search' | 'scanner'
      session.svelte.ts                   in-memory session log (entries, count, last)
      toast.svelte.ts                     toast queue with auto-dismiss + retry actions
      collection.svelte.ts                client mirror of server collection cache (Set<releaseId>)
  routes/
    +layout.svelte                        imports app.css; mounts <Toast />
    +page.svelte                          the entire app (search/scanner/setup screens)
    api/discogs/
      search/+server.ts                   GET ?q= — text search, returns trimmed releases sorted by year asc
      collection/add/+server.ts           POST {releaseId} — adds to collection; calls markAdded
      collection/remove/+server.ts        DELETE {releaseId, instanceId} — removes; calls markRemoved
      collection/ids/+server.ts           GET — returns full collection release-id list (paginated under the hood)
docs/
  CONTEXT.md                              ← this file
  superpowers/
    specs/2026-04-29-discogs-collection-adder-design.md   original product spec
    plans/2026-04-29-discogs-collection-adder.md          original implementation plan (all checked off)
```

## Feature inventory

### Search
- Live-debounced (250ms) text search via `/api/discogs/search?q=`.
- Results sorted ascending by year, nulls last (sorted in the SvelteKit endpoint, not at Discogs).
- Each row: 80×80 cover, artist — title, sub-line `format · year · country · label · catno`.
- "✓ in collection" green badge + dimmed title + green outline on cover for releases the user already owns.
- Single "Open this search in Discogs ↗" link below the list (opens `discogs.com/search/?q=…&type=all`).
- Click row OR press Enter on highlighted row → opens confirm modal.

### Scanner
- `s` enters scanner mode; `s` or `Esc` exits.
- Camera viewfinder with centered crosshair frame.
- On decode: beep, dispatches the decoded code into the search bar, mode flips to `search`. Search runs against `/api/discogs/search?q=<code>` (Discogs's text search indexes barcodes).
- On `NotReadableError` (camera still releasing from a previous mount), retries up to 3× with 250ms backoff.
- Camera errors include the underlying error name in the on-page message and `console.warn` the full error.

### Add / undo
- Confirm modal: cover, artist · year, format/country/label rows, Add (Enter) / Cancel (Esc).
- On add: `POST /api/discogs/collection/add` → session log gets the new entry; collection cache marks added; toast appears.
- Session log shows count + "undo last (u)" button when count > 0.
- `u` or Cmd/Ctrl+Z → `DELETE /api/discogs/collection/remove` for the most-recent entry; collection cache marks removed; toast appears.
- Add/undo errors surface inline (modal) or via toast (with retry action for undo).

### URL state
- `?q=<query>` is the single source of truth for the search bar. Typing updates URL (via `history.replaceState`); reload restores the same query (read at component init via `$app/state`'s `page.url.searchParams`).
- Scanner-decoded codes flow through the same `?q=` path.

### Setup screen
- On mount, the page probes `/api/discogs/search?q=test`. If the response says `no_token` or `invalid_token`, shows a setup screen with instructions instead of the app shell.

### Rate-limit handling
- Discogs 429 → toast "Rate limited. Try again in Xs." (uses `Retry-After`). Surfaces for both search and add/remove paths.

### Keyboard shortcuts (`?` to view)
- `/` focus search · `s` toggle scanner · `↑/↓` move highlight · `Enter` open confirm or confirm add
- `Esc` close modal / exit scanner / blur search input
- `u` or `Cmd/Ctrl+Z` undo last add · `?` toggle overlay
- Auto-focus on search bar on initial page load.

## Notable divergences from the original plan

- **Token loading.** Plan used `process.env.DISCOGS_TOKEN`; switched to `$env/dynamic/private` so `.env` actually loads in dev.
- **Barcode lookup endpoint.** Plan added `/api/discogs/barcode/[code]` (Task 23). Built, tested, then **deleted** when scanner flow was unified onto `/api/discogs/search?q=`. The Discogs text search already indexes barcodes well enough.
- **No "in collection" feature in the plan.** Built post-MVP: `collection-cache.ts` server module + `collection.svelte.ts` store + `/api/discogs/collection/ids` endpoint + ResultRow badge. Cache loads on first request, stays fresh via add/remove side effects.
- **No URL persistence in the plan.** Added `?q=` round-trip post-MVP.
- **No master/release deep-links in the plan.** Added a single "Open this search in Discogs" link below results (replaced an earlier per-row link).
- **Cover thumbnails 80×80.** Plan said 40×40.
- **Catalog number** added to row metadata (plan didn't include `catno`).
- **Result sort by year ascending.** Plan returned Discogs's default ordering.
- **Scanner robustness.** Plan didn't anticipate `NotReadableError` from rapid camera re-acquire; retry-with-backoff was added.
- **Auto-focus search on load + Esc-to-blur** added (plan only had `/` to focus).

## Known gaps / future work

- **Search-bar refocus when exiting scanner mode** isn't wired — pressing `s`/`Esc` from scanner returns to search but doesn't put focus in the input. Initial-mount autofocus and `/` shortcut work.
- **Collection cache invalidation** is correct for adds/removes via the app, but stale if you add/remove on discogs.com directly. No refresh button yet — restart `pnpm dev` to repopulate.
- **`Cmd+Z` is intercepted by the browser** when the search input is focused (it'll undo typed text first). The on-screen button and `u` key still work.
- **Multi-instance handling.** If a release exists multiple times in the collection and you remove one via undo, the cache uses a per-release count to stay accurate. But the badge is binary ("in collection" yes/no) — it doesn't show duplicate count.
- **No automated tests.** Verification is manual (curl, browser).
- **No phone/LAN access.** Currently dev-only on localhost. Plan notes this is a future config change, not code change.

## Local development

```bash
cp .env.example .env
# paste DISCOGS_TOKEN
pnpm install
pnpm dev
# open http://localhost:5173
```

Type-check (no test runner): `pnpm exec svelte-kit sync && pnpm exec tsc --noEmit`.
