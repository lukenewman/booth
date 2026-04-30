# Discogs Collection Adder — Design

**Date:** 2026-04-29
**Status:** Approved (pending implementation plan)
**Owner:** luke@hopehydration.com

## Context & Vision

Long-term, this codebase will become a cross-platform music library management app that combines a user's music across Spotify, Apple Music, Bandcamp, YouTube, Discogs, and local libraries. Before committing to any of those large architectural decisions, we are building a small, focused first project: a personal web app that makes it easy to add records to the user's Discogs collection.

This is a personal, single-user tool. The user is the only person who will run it. The MVP should optimize for that reality, not for hypothetical multi-user scale. Anything that *can* be deferred until the cross-platform app is brainstormed in detail *should* be deferred — preemptive abstraction now risks constraining the larger design later.

## Goals

- Provide a fast workflow for adding records to the user's Discogs collection.
- Support both **text search** (artist / title / catalog number) and **webcam barcode scanning**.
- Show pressing-level detail (year, country, label, format) so the right pressing can be selected — not auto-added — when a barcode returns multiple matches.
- Be **keyboard-shortcut-friendly** throughout: every primary action has a key, and the visual UI advertises the shortcut next to its affordance.
- Use the Discogs API as the source of truth for the collection. The app holds no persistent state of its own.

## Non-goals (MVP)

- **No multi-user support.** Single user, token in `.env`.
- **No Discogs OAuth.** Personal access token only.
- **No folder picker.** Always adds to "Uncategorized" (folder ID 1). One env-var override available; no UI surface.
- **No persistent activity log.** Only an in-memory session log that resets on refresh.
- **No deployment.** Runs locally only via `pnpm dev`.
- **No mobile / phone scanning in MVP.** Future expansion (see below) will make the same SvelteKit app reachable from a phone over LAN with HTTPS.
- **No automated tests.** The interesting surfaces (camera, real Discogs API responses) are exactly the ones that are painful to test for a one-person tool. Manual verification is the MVP test plan. Tests can be added later if specific behaviors prove flaky.
- **No light mode / theme toggle.** Dark theme only.
- **No faceted search filters.** A single text query is enough; if "I can't find it" becomes a real pain point, filters can be added then.
- **No multi-source adapters yet.** That's the next project.

## Future Expansion (out of MVP, but informs design)

- **LAN access for phone scanning.** Bind SvelteKit to LAN, add HTTPS via mkcert or Tailscale, and the existing scanner UI runs on the user's phone — which is the realistic device for "stack of records" workflows. The MVP architecture is built so this is a config change, not a code change. **Critically: the Discogs token never leaves the server, so even on the phone the browser only ever sees public data.**
- **Cross-platform music library app.** The session log structure, the source-adapter interface, and the persistent activity model will be designed *with* the cross-platform app, not preemptively. This MVP intentionally avoids those abstractions.

## Stack

- **SvelteKit** (server endpoints needed to proxy Discogs and keep the token off the browser)
- **Svelte 5 with runes** (`$state`, `$derived`)
- **TypeScript** throughout
- **pnpm** as the package manager
- **`@zxing/browser`** for barcode scanning (UPC/EAN, the formats records use)
- **Plain CSS**, scoped per component, dark theme baked in. No Tailwind, no UI kit.

## Architecture

```
┌──────────────────────────────────────────────────┐
│  Browser (Svelte 5 + runes)                      │
│  ──────────────────────────────────              │
│  • Search bar (default view)                     │
│  • Scanner toggle → camera viewfinder (ZXing)    │
│  • Results list                                   │
│  • Confirm modal                                  │
│  • Session log + undo                             │
└─────────────────────┬────────────────────────────┘
                      │ fetch (same origin, no token)
                      ▼
┌──────────────────────────────────────────────────┐
│  SvelteKit server endpoints (/api/discogs/*)     │
│  ──────────────────────────────────              │
│  • GET    /api/discogs/search?q=…                │
│  • GET    /api/discogs/barcode/:code             │
│  • POST   /api/discogs/collection/add            │
│  • DELETE /api/discogs/collection/remove         │
│  Adds Discogs token, forwards to Discogs API     │
└─────────────────────┬────────────────────────────┘
                      │ HTTPS + Authorization header
                      ▼
                Discogs API
```

### Boundary decisions

- **The Discogs token never reaches the browser.** It is read from `DISCOGS_TOKEN` in `.env` by server endpoints only. This is what makes the future "expand to LAN access" path safe — the phone's browser still never sees the token.
- **Server endpoints are thin pass-throughs.** They add the token, validate inputs, and return a lightly trimmed Discogs response. No product logic on the server.
- **All product logic** (search-vs-scanner mode, session log, undo, keyboard shortcuts) lives in the browser. Future native or alternate clients can hit the same endpoints.
- **Folder is hardcoded to "Uncategorized"** (folder ID `1`) in the add endpoint. An env override (`DISCOGS_FOLDER_ID`) is supported but no UI exposes it.
- **Username is fetched lazily** on the first server request via Discogs's `/oauth/identity` and cached in memory for the process lifetime. This avoids hardcoding `USERNAME` alongside the token. Subsequent requests reuse the cached username; only the first one pays the extra round-trip.

## Screens

There is one route. It is composed of three visual states:

### 1. Search (default)

- Top: small "booth" wordmark, `?` shortcut hint.
- Search input is focused on load. A small inline `Scan [s]` button on the right of the search bar toggles scanner mode.
- Below: results list. Each row shows cover thumbnail, "Artist — Title", and a metadata sub-line of `format · year · country · label`. The first row is highlighted by default; `↑`/`↓` move the highlight; `Enter` opens the confirm modal for the highlighted row.
- Bottom (always visible): session log. Shows count added this session and an "undo last" affordance with the `u` shortcut.

### 2. Scanner mode

- Camera viewfinder occupies most of the body. A centered translucent frame indicates where to place the barcode.
- Below: short hint text — "Auto-detects · plays a beep on match · then jumps to results."
- `Esc` exits scanner mode back to search. On a successful decode, the app plays a beep and transitions to the results list (which renders identically to the search-results state).
- If 0 results → message: "No match for `<barcode>`. Try search instead." with the barcode pre-filled in the search bar.

### 3. Confirm add (modal)

- Triggered by `Enter` on a highlighted result.
- Small centered modal with cover art, title, artist, year, format, country, label.
- Primary "Add" button (also `Enter`); secondary "Cancel" (also `Esc`).
- On success: modal closes, session log prepends the new entry, toast: "Added".
- On failure: modal stays open with inline error.

## Keyboard Model

A single keyboard handler at the app root dispatches based on current mode (search / scanner / modal-open). Components do not register their own keyboard listeners.

| Key | Action |
|---|---|
| `/` | Focus search bar |
| `s` | Toggle scanner mode |
| `↑` / `↓` | Move selection in results list |
| `Enter` | Open confirm modal for highlighted result; or confirm add when modal is open |
| `Esc` | Close modal; or exit scanner |
| `u` or `Cmd/Ctrl+Z` | Undo last add |
| `?` | Toggle keyboard shortcut overlay |

A `?` overlay lists the shortcuts so they don't have to be memorized. Affordances in the UI display their relevant key inline (e.g., `Add ↵`, `Cancel esc`).

## Data Flow

### Search flow (text)
1. User types → debounce 250ms.
2. Browser → `GET /api/discogs/search?q=<query>&type=release`.
3. Server adds token, calls Discogs `/database/search`, trims response per result to `{id, title, artist, year, country, label, format, thumb}`, returns top 25.
4. Browser renders results list, highlights first row.

### Scanner flow (barcode)
1. User presses `s` → `Scanner.svelte` mounts → `navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'}})`. Falls back to default camera if `environment` is unavailable (laptop case).
2. ZXing `BrowserMultiFormatReader` continuously decodes from the video stream.
3. On first decode → audible beep, reader stops, browser → `GET /api/discogs/barcode/:code`.
4. Server calls Discogs `/database/search?barcode=<code>&type=release`, returns the same trimmed shape as search.
5. Same results list as search. Zero-result fallback as described above.

### Add flow (search and scanner converge)
1. `Enter` on highlighted result → confirm modal opens.
2. `Enter` again → `POST /api/discogs/collection/add` with `{releaseId}`.
3. Server calls Discogs `POST /users/:username/collection/folders/1/releases/:releaseId`.
4. Discogs returns an `instance_id` (required for later removal).
5. On success: modal closes, session log prepends `{releaseId, instanceId, title, artist, addedAt}`. Toast: "Added".
6. On failure: modal stays open, inline error.

### Undo flow
1. `u` or click "undo last" → `DELETE /api/discogs/collection/remove` with `{releaseId, instanceId}`.
2. Server calls Discogs `DELETE /users/:username/collection/folders/1/releases/:releaseId/instances/:instanceId`.
3. On success: entry removed from session log. Toast: "Undone".
4. On failure: session log is left intact, toast shows error with retry. The session entry stays so a second undo attempt can act on it.

## Error Handling

- **Discogs rate limit (60/min authenticated):** Server endpoint catches 429 and returns `{error: 'rate_limited', retryAfter}`. Browser shows a non-blocking banner; the UI is not disabled.
- **Network failure:** Toast with "retry" action. No silent failures.
- **Token missing or invalid:** On the very first server request, the username fetch will fail. Server endpoints detect a missing `DISCOGS_TOKEN` env var (returns `{error: 'no_token'}`) or an authentication failure from Discogs (returns `{error: 'invalid_token'}`). Browser shows a setup screen explaining how to add or correct `DISCOGS_TOKEN` in `.env`. This is much better than a cryptic 401 surfacing mid-workflow.
- **Camera permission denied:** Scanner shows "Camera blocked — enable in browser settings, or use search instead." `Esc` returns to search.
- **Zero search results:** Friendly empty state, not an error.

## File & Component Layout

```
booth/
├── .env                          # DISCOGS_TOKEN=...
├── .env.example                  # committed template
├── .gitignore                    # node_modules, .env, .superpowers/
├── package.json
├── svelte.config.js
├── vite.config.ts
├── tsconfig.json
├── docs/superpowers/specs/...    # this design doc
└── src/
    ├── app.html                  # dark theme baseline (bg, font)
    ├── app.css                   # global tokens (colors, spacing)
    ├── lib/
    │   ├── server/
    │   │   ├── discogs.ts        # fetch wrapper: addToken, parseErrors
    │   │   └── username.ts       # fetches+caches username on first call
    │   ├── stores/
    │   │   ├── session.svelte.ts # $state session log + undo
    │   │   └── mode.svelte.ts    # $state 'search' | 'scanner'
    │   ├── types.ts              # DiscogsRelease, SessionEntry, etc.
    │   ├── components/
    │   │   ├── SearchBar.svelte
    │   │   ├── ResultsList.svelte
    │   │   ├── ResultRow.svelte
    │   │   ├── Scanner.svelte    # ZXing wrapper, viewfinder, beep
    │   │   ├── ConfirmModal.svelte
    │   │   ├── SessionLog.svelte
    │   │   ├── ShortcutOverlay.svelte
    │   │   └── Toast.svelte
    │   └── keyboard.svelte.ts    # global handler, mode-aware dispatch
    └── routes/
        ├── +layout.svelte        # mounts keyboard handler, toast container
        ├── +page.svelte          # the one screen — composes everything
        └── api/discogs/
            ├── search/+server.ts
            ├── barcode/[code]/+server.ts
            └── collection/
                ├── add/+server.ts
                └── remove/+server.ts
```

### Notes on structure

- **Single page route.** Search, scanner, and modal are all states within `+page.svelte`. No client-side routing.
- **Stores use Svelte 5 runes.** `.svelte.ts` modules with `$state`. The session log and current mode are the only cross-component state.
- **`lib/server/discogs.ts`** is the only place the token is read. All four endpoints route through it. Token boundary is obvious.
- **`lib/keyboard.svelte.ts`** owns all shortcuts in one place. Components react to mode/state from stores rather than registering their own listeners. Avoids listener-spaghetti.
- **`Scanner.svelte` owns the camera lifecycle.** `getUserMedia` on mount, `stop()` on unmount or successful decode. The ZXing reader is created and destroyed with the component.
- **`lib/types.ts`** holds shared TypeScript types — `DiscogsRelease` (the trimmed shape), `SessionEntry`, error response types — referenced by both server and client.

## Implementation Phasing (high-level)

This is for the planning step, not the spec — listed here so the writing-plans skill has a starting outline.

1. Project scaffolding (SvelteKit + TS + pnpm), `.env` setup, dark-theme baseline, `.gitignore`.
2. Server-side Discogs wrapper + `/api/discogs/search` endpoint + username fetch & cache.
3. Search UI: input, results list, result row component, basic dark-theme styles.
4. Confirm modal + `/api/discogs/collection/add` endpoint + toast.
5. Session log store + UI + undo + `/api/discogs/collection/remove` endpoint.
6. Keyboard handler + shortcut overlay.
7. Scanner mode: ZXing integration, viewfinder, beep, `/api/discogs/barcode/:code` endpoint, zero-result fallback.
8. Error states polish: rate limit banner, no-token setup screen, camera-permission denied, network-failure retry.

## Open Questions

None at design time. All scope, UX, and stack decisions resolved in brainstorming.
