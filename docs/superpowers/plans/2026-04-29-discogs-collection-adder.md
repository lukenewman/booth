# Discogs Collection Adder Implementation Plan

> **STATUS — Shipped 2026-05-04.** All 28 tasks completed. For the source-of-truth on what's actually in the codebase today (including post-MVP polish that diverges from this plan), see [`docs/CONTEXT.md`](../../CONTEXT.md). This plan is preserved as the original blueprint.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Build a single-user, local SvelteKit web app that makes adding records to a Discogs collection fast — supporting both text search and webcam barcode scanning, with keyboard shortcuts throughout.

**Architecture:** SvelteKit (Svelte 5 + runes + TypeScript) with server endpoints that proxy Discogs API calls so the personal access token never reaches the browser. One page route, three visual states (search / scanner / confirm modal). In-memory session log for undo. Dark theme, plain CSS, no UI framework.

**Tech Stack:** SvelteKit, Svelte 5, TypeScript, pnpm, `@zxing/browser`, plain CSS.

**Spec:** `docs/superpowers/specs/2026-04-29-discogs-collection-adder-design.md`

**No tests in MVP** — every task ends with a manual verification step (run dev server, curl, browser check) instead of test execution.

**Reference docs to keep open while implementing:**
- Discogs API: https://www.discogs.com/developers
- Svelte 5 runes: https://svelte.dev/docs/svelte/what-are-runes
- @zxing/browser: https://github.com/zxing-js/browser

---

## Task 1: Scaffold the SvelteKit project

**Files:**
- Create: `package.json`, `svelte.config.js`, `vite.config.ts`, `tsconfig.json`, `src/app.html`, `src/app.d.ts`, `src/routes/+page.svelte`, `.gitignore`

The current directory `/Users/luke/code/booth` already contains `docs/` and `.superpowers/`. The `sv create` CLI will warn that the directory is non-empty — answer "yes, continue" / use `--force`.

- [x] **Step 1: Scaffold with the `sv` CLI**

Run from `/Users/luke/code/booth`:
```bash
pnpm dlx sv@latest create . --template minimal --types ts --no-add-ons
```

If prompted "Directory not empty. Continue?", answer **yes**. If the flag form differs in the installed `sv` version, run `pnpm dlx sv@latest create .` and answer interactively: template = **minimal**, type checking = **TypeScript**, add-ons = **none**.

- [x] **Step 2: Install dependencies**

```bash
pnpm install
```

- [x] **Step 3: Update `.gitignore`**

Append to existing `.gitignore`:
```
.superpowers/
.env
.env.local
```

- [x] **Step 4: Create `.env.example`**

Create `/Users/luke/code/booth/.env.example`:
```
# Personal access token from https://www.discogs.com/settings/developers
DISCOGS_TOKEN=

# Optional: override default collection folder (1 = "Uncategorized")
# DISCOGS_FOLDER_ID=1
```

- [x] **Step 5: Verify dev server boots**

```bash
pnpm dev
```
Expected: Vite prints `Local: http://localhost:5173/`. Open it in a browser. The default SvelteKit "Welcome" page renders. Stop the server (`Ctrl+C`).

- [x] **Step 6: Initialize git and commit**

```bash
cd /Users/luke/code/booth
git init
git add .
git commit -m "chore: scaffold SvelteKit + TS project"
```

---

## Task 2: Dark theme baseline & global styles

**Files:**
- Modify: `src/app.html`
- Create: `src/app.css`
- Modify: `src/routes/+layout.svelte` (create if not present)

- [x] **Step 1: Create `src/app.css`**

```css
:root {
  --bg: #0a0a0a;
  --bg-raised: #1a1a1a;
  --bg-input: #181818;
  --border: #2a2a2a;
  --border-strong: #333;
  --text: #e8e8e8;
  --text-muted: #888;
  --text-subtle: #555;
  --accent: #5a8edb;
  --accent-bg: #1f2a3a;
  --accent-border: #2c4a7a;
  --danger: #db5a5a;

  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 24px;
  --space-6: 32px;

  --radius: 6px;
  --radius-sm: 4px;

  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --font-mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}

* { box-sizing: border-box; }

html, body {
  margin: 0;
  padding: 0;
  background: var(--bg);
  color: var(--text);
  font-family: var(--font);
  font-size: 14px;
  line-height: 1.4;
  min-height: 100vh;
}

button {
  font-family: inherit;
  font-size: inherit;
  cursor: pointer;
}

input, button {
  color: inherit;
}

input::placeholder {
  color: var(--text-subtle);
}

.kbd {
  display: inline-block;
  background: #222;
  border: 1px solid var(--border-strong);
  border-radius: 3px;
  padding: 1px 5px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-muted);
}
```

- [x] **Step 2: Update `src/app.html`**

Replace the content of `src/app.html` with:
```html
<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<link rel="icon" href="%sveltekit.assets%/favicon.png" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<title>booth</title>
		%sveltekit.head%
	</head>
	<body data-sveltekit-preload-data="hover">
		<div style="display: contents">%sveltekit.body%</div>
	</body>
</html>
```

- [x] **Step 3: Create `src/routes/+layout.svelte`**

```svelte
<script lang="ts">
  import '../app.css';
  let { children } = $props();
</script>

{@render children()}
```

- [x] **Step 4: Verify dark theme renders**

```bash
pnpm dev
```
Open http://localhost:5173. The default Welcome page should now have a near-black background and light text. Stop the server.

- [x] **Step 5: Commit**

```bash
git add .
git commit -m "feat: add dark theme baseline and global tokens"
```

---

## Task 3: Shared types module

**Files:**
- Create: `src/lib/types.ts`

- [x] **Step 1: Create `src/lib/types.ts`**

```ts
// The trimmed Discogs release shape we use throughout the app.
export interface DiscogsRelease {
  id: number;
  title: string;
  artist: string;
  year: number | null;
  country: string | null;
  label: string | null;
  format: string | null;
  thumb: string | null;
  coverImage: string | null;
}

// One entry in the in-memory session log.
export interface SessionEntry {
  releaseId: number;
  instanceId: number;
  title: string;
  artist: string;
  addedAt: number; // Date.now()
}

// The current visual mode of the app.
export type AppMode = 'search' | 'scanner';

// API error response envelope. Server endpoints return this on failure.
export interface ApiError {
  error:
    | 'no_token'
    | 'invalid_token'
    | 'rate_limited'
    | 'not_found'
    | 'discogs_error'
    | 'network_error';
  message?: string;
  retryAfter?: number; // seconds, only present for rate_limited
}

// Successful add response — Discogs returns instance_id we need for undo.
export interface AddResponse {
  releaseId: number;
  instanceId: number;
}
```

- [x] **Step 2: Commit**

```bash
git add src/lib/types.ts
git commit -m "feat: add shared TypeScript types"
```

---

## Task 4: Server-side Discogs fetch wrapper

**Files:**
- Create: `src/lib/server/discogs.ts`

- [x] **Step 1: Create `src/lib/server/discogs.ts`**

```ts
import type { ApiError } from '$lib/types';

const BASE = 'https://api.discogs.com';
const USER_AGENT = 'booth/0.1 +https://github.com/luke';

export class DiscogsError extends Error {
  constructor(public payload: ApiError, public status: number) {
    super(payload.message ?? payload.error);
  }
}

function getToken(): string {
  const token = process.env.DISCOGS_TOKEN;
  if (!token) {
    throw new DiscogsError({ error: 'no_token', message: 'DISCOGS_TOKEN not set in .env' }, 500);
  }
  return token;
}

export async function discogsFetch(path: string, init: RequestInit = {}): Promise<unknown> {
  const token = getToken();
  const url = path.startsWith('http') ? path : `${BASE}${path}`;

  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Discogs token=${token}`,
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });

  if (res.status === 401) {
    throw new DiscogsError(
      { error: 'invalid_token', message: 'Discogs rejected the token (401)' },
      401,
    );
  }

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('Retry-After') ?? '60');
    throw new DiscogsError({ error: 'rate_limited', retryAfter }, 429);
  }

  if (res.status === 404) {
    throw new DiscogsError({ error: 'not_found' }, 404);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new DiscogsError(
      { error: 'discogs_error', message: `Discogs ${res.status}: ${text.slice(0, 200)}` },
      res.status,
    );
  }

  // 204 No Content for collection delete
  if (res.status === 204) return null;
  return res.json();
}
```

- [x] **Step 2: Commit**

```bash
git add src/lib/server/discogs.ts
git commit -m "feat: add server-side Discogs fetch wrapper"
```

---

## Task 5: Username cache module

**Files:**
- Create: `src/lib/server/username.ts`

- [x] **Step 1: Create `src/lib/server/username.ts`**

```ts
import { discogsFetch } from './discogs';

let cached: string | null = null;

interface IdentityResponse {
  username: string;
}

export async function getUsername(): Promise<string> {
  if (cached) return cached;
  const data = (await discogsFetch('/oauth/identity')) as IdentityResponse;
  cached = data.username;
  return cached;
}
```

- [x] **Step 2: Commit**

```bash
git add src/lib/server/username.ts
git commit -m "feat: add lazy username cache for Discogs identity"
```

---

## Task 6: Search endpoint

**Files:**
- Create: `src/routes/api/discogs/search/+server.ts`

- [x] **Step 1: Create the endpoint**

```ts
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { DiscogsRelease } from '$lib/types';
import { discogsFetch, DiscogsError } from '$lib/server/discogs';

interface DiscogsSearchResult {
  id: number;
  title: string; // "Artist - Title"
  year?: string;
  country?: string;
  label?: string[];
  format?: string[];
  thumb?: string;
  cover_image?: string;
}

interface DiscogsSearchResponse {
  results: DiscogsSearchResult[];
}

function parseTitle(combined: string): { artist: string; title: string } {
  const idx = combined.indexOf(' - ');
  if (idx === -1) return { artist: '', title: combined };
  return { artist: combined.slice(0, idx), title: combined.slice(idx + 3) };
}

function trim(r: DiscogsSearchResult): DiscogsRelease {
  const { artist, title } = parseTitle(r.title);
  return {
    id: r.id,
    artist,
    title,
    year: r.year ? Number(r.year) || null : null,
    country: r.country ?? null,
    label: r.label?.[0] ?? null,
    format: r.format?.join(', ') ?? null,
    thumb: r.thumb ?? null,
    coverImage: r.cover_image ?? null,
  };
}

export const GET: RequestHandler = async ({ url }) => {
  const q = url.searchParams.get('q')?.trim();
  if (!q) return json({ results: [] });

  try {
    const params = new URLSearchParams({ q, type: 'release', per_page: '25' });
    const data = (await discogsFetch(
      `/database/search?${params}`,
    )) as DiscogsSearchResponse;
    const results = (data.results ?? []).map(trim);
    return json({ results });
  } catch (e) {
    if (e instanceof DiscogsError) {
      return json(e.payload, { status: e.status });
    }
    throw error(500, { message: 'Unexpected error' });
  }
};
```

- [x] **Step 2: Manually verify with `.env` set**

Create a real `.env`:
```bash
cp .env.example .env
```
Edit `.env` and paste your Discogs personal access token (get one at https://www.discogs.com/settings/developers). Then:
```bash
pnpm dev
```
In another terminal:
```bash
curl 'http://localhost:5173/api/discogs/search?q=spirit%20of%20eden'
```
Expected: JSON like `{"results":[{"id":..., "artist":"Talk Talk", "title":"Spirit Of Eden", ...}, ...]}`. Stop the dev server.

- [x] **Step 3: Commit**

```bash
git add src/routes/api/discogs/search/+server.ts
git commit -m "feat: add /api/discogs/search endpoint"
```

---

## Task 7: Mode store

**Files:**
- Create: `src/lib/stores/mode.svelte.ts`

- [x] **Step 1: Create the store**

```ts
import type { AppMode } from '$lib/types';

class ModeStore {
  current = $state<AppMode>('search');

  setSearch() {
    this.current = 'search';
  }

  setScanner() {
    this.current = 'scanner';
  }

  toggle() {
    this.current = this.current === 'search' ? 'scanner' : 'search';
  }
}

export const mode = new ModeStore();
```

- [x] **Step 2: Commit**

```bash
git add src/lib/stores/mode.svelte.ts
git commit -m "feat: add mode store (search/scanner)"
```

---

## Task 8: ResultRow component

**Files:**
- Create: `src/lib/components/ResultRow.svelte`

- [x] **Step 1: Create the component**

```svelte
<script lang="ts">
  import type { DiscogsRelease } from '$lib/types';

  let {
    release,
    highlighted = false,
    onclick,
  }: {
    release: DiscogsRelease;
    highlighted?: boolean;
    onclick?: () => void;
  } = $props();

  let metaParts = $derived(
    [release.format, release.year, release.country, release.label].filter(Boolean).join(' · '),
  );
</script>

<button class="row" class:highlighted {onclick} type="button">
  <div class="cover">
    {#if release.thumb}
      <img src={release.thumb} alt="" />
    {/if}
  </div>
  <div class="meta">
    <div class="title">
      {#if release.artist}<span class="artist">{release.artist}</span> — {/if}{release.title}
    </div>
    <div class="sub">{metaParts || '—'}</div>
  </div>
  {#if highlighted}
    <span class="kbd">↵</span>
  {/if}
</button>

<style>
  .row {
    display: flex;
    gap: 10px;
    padding: 8px;
    border-radius: var(--radius-sm);
    margin-bottom: 4px;
    align-items: center;
    background: transparent;
    border: 1px solid transparent;
    width: 100%;
    text-align: left;
  }
  .row.highlighted {
    background: var(--accent-bg);
    border-color: var(--accent-border);
  }
  .cover {
    width: 40px;
    height: 40px;
    background: #2a2a2a;
    border-radius: 3px;
    flex-shrink: 0;
    overflow: hidden;
  }
  .cover img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .meta {
    flex: 1;
    min-width: 0;
  }
  .title {
    font-size: 13px;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .artist {
    color: var(--text);
  }
  .sub {
    font-size: 11px;
    color: var(--text-muted);
  }
</style>
```

- [x] **Step 2: Commit**

```bash
git add src/lib/components/ResultRow.svelte
git commit -m "feat: add ResultRow component"
```

---

## Task 9: ResultsList component

**Files:**
- Create: `src/lib/components/ResultsList.svelte`

- [x] **Step 1: Create the component**

```svelte
<script lang="ts">
  import type { DiscogsRelease } from '$lib/types';
  import ResultRow from './ResultRow.svelte';

  let {
    results,
    highlightedIndex,
    onSelect,
  }: {
    results: DiscogsRelease[];
    highlightedIndex: number;
    onSelect: (release: DiscogsRelease) => void;
  } = $props();
</script>

{#if results.length === 0}
  <div class="empty">No results.</div>
{:else}
  <div class="list">
    {#each results as release, i (release.id)}
      <ResultRow
        {release}
        highlighted={i === highlightedIndex}
        onclick={() => onSelect(release)}
      />
    {/each}
  </div>
{/if}

<style>
  .list {
    display: flex;
    flex-direction: column;
  }
  .empty {
    padding: 20px;
    text-align: center;
    color: var(--text-muted);
    font-size: 13px;
  }
</style>
```

- [x] **Step 2: Commit**

```bash
git add src/lib/components/ResultsList.svelte
git commit -m "feat: add ResultsList component"
```

---

## Task 10: SearchBar component

**Files:**
- Create: `src/lib/components/SearchBar.svelte`

- [x] **Step 1: Create the component**

```svelte
<script lang="ts">
  let {
    value = $bindable(''),
    onScan,
  }: {
    value?: string;
    onScan: () => void;
  } = $props();

  let inputEl: HTMLInputElement | undefined = $state();

  export function focus() {
    inputEl?.focus();
    inputEl?.select();
  }
</script>

<div class="bar">
  <span class="icon">⌕</span>
  <input
    bind:this={inputEl}
    bind:value
    type="text"
    placeholder="artist, album, catalog #..."
    autocomplete="off"
    spellcheck="false"
  />
  <button type="button" class="scan" onclick={onScan}>
    <span>⊞ Scan</span>
    <span class="kbd">s</span>
  </button>
</div>

<style>
  .bar {
    display: flex;
    align-items: center;
    gap: 8px;
    background: var(--bg-input);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    padding: 10px 12px;
    margin-bottom: 14px;
  }
  .bar:focus-within {
    border-color: var(--accent);
  }
  .icon {
    color: var(--accent);
    font-size: 16px;
  }
  input {
    flex: 1;
    background: transparent;
    border: none;
    outline: none;
    color: var(--text);
    font-size: 14px;
  }
  .scan {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    font-size: 12px;
    color: var(--text-muted);
    background: var(--bg-raised);
  }
  .scan:hover {
    color: var(--text);
  }
</style>
```

- [x] **Step 2: Commit**

```bash
git add src/lib/components/SearchBar.svelte
git commit -m "feat: add SearchBar component"
```

---

## Task 11: Wire up search on the home page

**Files:**
- Modify: `src/routes/+page.svelte`

- [x] **Step 1: Replace `src/routes/+page.svelte`**

```svelte
<script lang="ts">
  import SearchBar from '$lib/components/SearchBar.svelte';
  import ResultsList from '$lib/components/ResultsList.svelte';
  import { mode } from '$lib/stores/mode.svelte';
  import type { DiscogsRelease } from '$lib/types';

  let query = $state('');
  let results = $state<DiscogsRelease[]>([]);
  let highlightedIndex = $state(0);
  let loading = $state(false);
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  $effect(() => {
    const q = query.trim();
    clearTimeout(debounceTimer);
    if (!q) {
      results = [];
      return;
    }
    debounceTimer = setTimeout(() => runSearch(q), 250);
  });

  async function runSearch(q: string) {
    loading = true;
    try {
      const res = await fetch(`/api/discogs/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      results = data.results ?? [];
      highlightedIndex = 0;
    } finally {
      loading = false;
    }
  }

  function handleSelect(release: DiscogsRelease) {
    console.log('selected', release);
  }
</script>

<div class="app">
  <header>
    <span class="logo">booth</span>
    <span class="hint"><span class="kbd">?</span> shortcuts</span>
  </header>

  {#if mode.current === 'search'}
    <SearchBar bind:value={query} onScan={() => mode.setScanner()} />

    {#if loading}
      <div class="loading">Searching…</div>
    {:else if query.trim()}
      <ResultsList {results} {highlightedIndex} onSelect={handleSelect} />
    {/if}
  {:else}
    <div class="placeholder">Scanner mode (coming soon)</div>
  {/if}
</div>

<style>
  .app {
    max-width: 640px;
    margin: 0 auto;
    padding: 32px 20px;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16px;
    font-size: 12px;
    color: var(--text-muted);
  }
  .logo {
    color: var(--text);
    font-weight: 600;
    font-size: 14px;
  }
  .loading,
  .placeholder {
    padding: 20px;
    text-align: center;
    color: var(--text-muted);
    font-size: 13px;
  }
</style>
```

- [x] **Step 2: Manually verify search end-to-end**

```bash
pnpm dev
```
Open http://localhost:5173. Type `spirit of eden`. After ~250ms, results appear with cover thumbnails, artist/title, and metadata sub-line. The first row is highlighted in blue. Click a row — check the browser console for the `selected ...` log. Stop the server.

- [x] **Step 3: Commit**

```bash
git add src/routes/+page.svelte
git commit -m "feat: wire up search bar with debounced results"
```

---

## Task 12: ConfirmModal component

**Files:**
- Create: `src/lib/components/ConfirmModal.svelte`

- [x] **Step 1: Create the component**

```svelte
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
```

- [x] **Step 2: Commit**

```bash
git add src/lib/components/ConfirmModal.svelte
git commit -m "feat: add ConfirmModal component"
```

---

## Task 13: Add-to-collection endpoint

**Files:**
- Create: `src/routes/api/discogs/collection/add/+server.ts`

- [x] **Step 1: Create the endpoint**

```ts
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { AddResponse } from '$lib/types';
import { discogsFetch, DiscogsError } from '$lib/server/discogs';
import { getUsername } from '$lib/server/username';

interface AddDiscogsResponse {
  instance_id: number;
  resource_url: string;
}

const FOLDER_ID = process.env.DISCOGS_FOLDER_ID ?? '1';

export const POST: RequestHandler = async ({ request }) => {
  let body: { releaseId?: number };
  try {
    body = await request.json();
  } catch {
    throw error(400, 'Invalid JSON body');
  }
  const releaseId = body.releaseId;
  if (typeof releaseId !== 'number') {
    throw error(400, 'releaseId (number) required');
  }

  try {
    const username = await getUsername();
    const data = (await discogsFetch(
      `/users/${encodeURIComponent(username)}/collection/folders/${FOLDER_ID}/releases/${releaseId}`,
      { method: 'POST' },
    )) as AddDiscogsResponse;
    const response: AddResponse = { releaseId, instanceId: data.instance_id };
    return json(response);
  } catch (e) {
    if (e instanceof DiscogsError) {
      return json(e.payload, { status: e.status });
    }
    throw error(500, { message: 'Unexpected error' });
  }
};
```

- [x] **Step 2: Manually verify with curl**

```bash
pnpm dev
```
In another terminal — pick a release ID from a previous search response (e.g., `13455`):
```bash
curl -X POST -H 'Content-Type: application/json' \
  -d '{"releaseId": 13455}' \
  http://localhost:5173/api/discogs/collection/add
```
Expected: `{"releaseId":13455,"instanceId":<number>}`. Verify in your Discogs collection on the website that the release was added to "Uncategorized." Stop the server.

(If you don't want a test release in your collection, use a release you actually want — the next task adds undo, but a manual remove on Discogs is also fine.)

- [x] **Step 3: Commit**

```bash
git add src/routes/api/discogs/collection/add/+server.ts
git commit -m "feat: add /api/discogs/collection/add endpoint"
```

---

## Task 14: Toast component

**Files:**
- Create: `src/lib/components/Toast.svelte`
- Create: `src/lib/stores/toast.svelte.ts`

- [x] **Step 1: Create the toast store `src/lib/stores/toast.svelte.ts`**

```ts
export interface ToastMessage {
  id: number;
  text: string;
  kind: 'info' | 'error';
  action?: { label: string; onClick: () => void };
}

class ToastStore {
  messages = $state<ToastMessage[]>([]);
  private nextId = 1;

  show(text: string, opts: { kind?: ToastMessage['kind']; action?: ToastMessage['action']; duration?: number } = {}) {
    const id = this.nextId++;
    const msg: ToastMessage = { id, text, kind: opts.kind ?? 'info', action: opts.action };
    this.messages = [...this.messages, msg];
    const duration = opts.duration ?? 3000;
    if (duration > 0) {
      setTimeout(() => this.dismiss(id), duration);
    }
  }

  dismiss(id: number) {
    this.messages = this.messages.filter((m) => m.id !== id);
  }
}

export const toast = new ToastStore();
```

- [x] **Step 2: Create `src/lib/components/Toast.svelte`**

```svelte
<script lang="ts">
  import { toast } from '$lib/stores/toast.svelte';
</script>

<div class="container">
  {#each toast.messages as msg (msg.id)}
    <div class="toast" class:error={msg.kind === 'error'}>
      <span>{msg.text}</span>
      {#if msg.action}
        <button
          type="button"
          onclick={() => {
            msg.action?.onClick();
            toast.dismiss(msg.id);
          }}
        >
          {msg.action.label}
        </button>
      {/if}
    </div>
  {/each}
</div>

<style>
  .container {
    position: fixed;
    bottom: 20px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    gap: 8px;
    z-index: 200;
  }
  .toast {
    background: var(--bg-raised);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    padding: 8px 14px;
    color: var(--text);
    font-size: 13px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .toast.error {
    border-color: rgba(219, 90, 90, 0.5);
  }
  button {
    background: transparent;
    border: none;
    color: var(--accent);
    font-size: 13px;
    padding: 0;
  }
</style>
```

- [x] **Step 3: Mount Toast in `src/routes/+layout.svelte`**

Replace the contents:
```svelte
<script lang="ts">
  import '../app.css';
  import Toast from '$lib/components/Toast.svelte';
  let { children } = $props();
</script>

{@render children()}
<Toast />
```

- [x] **Step 4: Commit**

```bash
git add src/lib/stores/toast.svelte.ts src/lib/components/Toast.svelte src/routes/+layout.svelte
git commit -m "feat: add Toast component and store"
```

---

## Task 15: Session log store

**Files:**
- Create: `src/lib/stores/session.svelte.ts`

- [x] **Step 1: Create the store**

```ts
import type { SessionEntry } from '$lib/types';

class SessionStore {
  entries = $state<SessionEntry[]>([]);

  count = $derived(this.entries.length);
  last = $derived(this.entries[0] ?? null);

  add(entry: SessionEntry) {
    this.entries = [entry, ...this.entries];
  }

  removeById(releaseId: number, instanceId: number) {
    this.entries = this.entries.filter(
      (e) => !(e.releaseId === releaseId && e.instanceId === instanceId),
    );
  }
}

export const session = new SessionStore();
```

- [x] **Step 2: Commit**

```bash
git add src/lib/stores/session.svelte.ts
git commit -m "feat: add session log store"
```

---

## Task 16: Wire up the add flow

**Files:**
- Modify: `src/routes/+page.svelte`

- [x] **Step 1: Update `src/routes/+page.svelte`**

Replace the entire file contents with:
```svelte
<script lang="ts">
  import SearchBar from '$lib/components/SearchBar.svelte';
  import ResultsList from '$lib/components/ResultsList.svelte';
  import ConfirmModal from '$lib/components/ConfirmModal.svelte';
  import { mode } from '$lib/stores/mode.svelte';
  import { session } from '$lib/stores/session.svelte';
  import { toast } from '$lib/stores/toast.svelte';
  import type { DiscogsRelease, AddResponse, ApiError } from '$lib/types';

  let query = $state('');
  let results = $state<DiscogsRelease[]>([]);
  let highlightedIndex = $state(0);
  let loading = $state(false);
  let pending = $state<DiscogsRelease | null>(null);
  let submitting = $state(false);
  let modalError = $state<string | null>(null);
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  $effect(() => {
    const q = query.trim();
    clearTimeout(debounceTimer);
    if (!q) {
      results = [];
      return;
    }
    debounceTimer = setTimeout(() => runSearch(q), 250);
  });

  async function runSearch(q: string) {
    loading = true;
    try {
      const res = await fetch(`/api/discogs/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      results = data.results ?? [];
      highlightedIndex = 0;
    } finally {
      loading = false;
    }
  }

  function handleSelect(release: DiscogsRelease) {
    pending = release;
    modalError = null;
  }

  async function confirmAdd() {
    if (!pending) return;
    submitting = true;
    modalError = null;
    try {
      const res = await fetch('/api/discogs/collection/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ releaseId: pending.id }),
      });
      const data: AddResponse | ApiError = await res.json();
      if (!res.ok) {
        modalError = (data as ApiError).message ?? 'Add failed';
        return;
      }
      const ok = data as AddResponse;
      session.add({
        releaseId: ok.releaseId,
        instanceId: ok.instanceId,
        title: pending.title,
        artist: pending.artist,
        addedAt: Date.now(),
      });
      toast.show(`Added: ${pending.artist} — ${pending.title}`);
      pending = null;
    } catch (e) {
      modalError = e instanceof Error ? e.message : 'Network error';
    } finally {
      submitting = false;
    }
  }

  function cancelAdd() {
    if (submitting) return;
    pending = null;
    modalError = null;
  }
</script>

<div class="app">
  <header>
    <span class="logo">booth</span>
    <span class="hint"><span class="kbd">?</span> shortcuts</span>
  </header>

  {#if mode.current === 'search'}
    <SearchBar bind:value={query} onScan={() => mode.setScanner()} />

    {#if loading}
      <div class="loading">Searching…</div>
    {:else if query.trim()}
      <ResultsList {results} {highlightedIndex} onSelect={handleSelect} />
    {/if}
  {:else}
    <div class="placeholder">Scanner mode (coming soon)</div>
  {/if}
</div>

{#if pending}
  <ConfirmModal
    release={pending}
    onConfirm={confirmAdd}
    onCancel={cancelAdd}
    {submitting}
    error={modalError}
  />
{/if}

<style>
  .app {
    max-width: 640px;
    margin: 0 auto;
    padding: 32px 20px;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16px;
    font-size: 12px;
    color: var(--text-muted);
  }
  .logo {
    color: var(--text);
    font-weight: 600;
    font-size: 14px;
  }
  .loading,
  .placeholder {
    padding: 20px;
    text-align: center;
    color: var(--text-muted);
    font-size: 13px;
  }
</style>
```

- [x] **Step 2: Manually verify the full add flow**

```bash
pnpm dev
```
Open http://localhost:5173. Search for a record. Click a result → confirm modal appears. Click "Add" → modal closes, toast appears at the bottom: "Added: ...". Verify in Discogs that the record appears in your collection. Stop the server.

- [x] **Step 3: Commit**

```bash
git add src/routes/+page.svelte
git commit -m "feat: wire up full add flow with confirm modal and toast"
```

---

## Task 17: SessionLog component

**Files:**
- Create: `src/lib/components/SessionLog.svelte`

- [x] **Step 1: Create the component**

```svelte
<script lang="ts">
  import { session } from '$lib/stores/session.svelte';

  let {
    onUndo,
  }: {
    onUndo: () => void;
  } = $props();
</script>

{#if session.count > 0}
  <div class="log">
    <span>Added this session: {session.count}</span>
    <button type="button" class="undo" onclick={onUndo}>
      undo last <span class="kbd">u</span>
    </button>
  </div>
{/if}

<style>
  .log {
    margin-top: 14px;
    padding-top: 12px;
    border-top: 1px dashed var(--border);
    font-size: 12px;
    color: var(--text-muted);
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .undo {
    background: transparent;
    border: none;
    color: var(--accent);
    font-size: 12px;
    padding: 0;
  }
  .undo:hover {
    text-decoration: underline;
  }
</style>
```

- [x] **Step 2: Commit**

```bash
git add src/lib/components/SessionLog.svelte
git commit -m "feat: add SessionLog component"
```

---

## Task 18: Remove-from-collection endpoint

**Files:**
- Create: `src/routes/api/discogs/collection/remove/+server.ts`

- [x] **Step 1: Create the endpoint**

```ts
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { discogsFetch, DiscogsError } from '$lib/server/discogs';
import { getUsername } from '$lib/server/username';

const FOLDER_ID = process.env.DISCOGS_FOLDER_ID ?? '1';

export const DELETE: RequestHandler = async ({ request }) => {
  let body: { releaseId?: number; instanceId?: number };
  try {
    body = await request.json();
  } catch {
    throw error(400, 'Invalid JSON body');
  }
  const { releaseId, instanceId } = body;
  if (typeof releaseId !== 'number' || typeof instanceId !== 'number') {
    throw error(400, 'releaseId and instanceId (numbers) required');
  }

  try {
    const username = await getUsername();
    await discogsFetch(
      `/users/${encodeURIComponent(username)}/collection/folders/${FOLDER_ID}/releases/${releaseId}/instances/${instanceId}`,
      { method: 'DELETE' },
    );
    return json({ ok: true });
  } catch (e) {
    if (e instanceof DiscogsError) {
      return json(e.payload, { status: e.status });
    }
    throw error(500, { message: 'Unexpected error' });
  }
};
```

- [x] **Step 2: Commit**

```bash
git add src/routes/api/discogs/collection/remove/+server.ts
git commit -m "feat: add /api/discogs/collection/remove endpoint"
```

---

## Task 19: Wire up undo in the page

**Files:**
- Modify: `src/routes/+page.svelte`

- [x] **Step 1: Add SessionLog import and undo logic**

In `src/routes/+page.svelte`, add to the imports near the top:
```ts
import SessionLog from '$lib/components/SessionLog.svelte';
```

Add this function below `cancelAdd()`:
```ts
async function undoLast() {
  const last = session.last;
  if (!last) return;
  try {
    const res = await fetch('/api/discogs/collection/remove', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ releaseId: last.releaseId, instanceId: last.instanceId }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      toast.show(data.message ?? 'Undo failed', {
        kind: 'error',
        action: { label: 'retry', onClick: () => undoLast() },
      });
      return;
    }
    session.removeById(last.releaseId, last.instanceId);
    toast.show(`Undone: ${last.artist} — ${last.title}`);
  } catch (e) {
    toast.show(e instanceof Error ? e.message : 'Network error', {
      kind: 'error',
      action: { label: 'retry', onClick: () => undoLast() },
    });
  }
}
```

In the template, add `<SessionLog onUndo={undoLast} />` inside `.app`, just before the closing `</div>`:
```svelte
<div class="app">
  <header>...</header>
  {#if mode.current === 'search'}
    ...
  {/if}
  <SessionLog onUndo={undoLast} />
</div>
```

- [x] **Step 2: Manually verify undo**

```bash
pnpm dev
```
Open http://localhost:5173. Search → add a record → confirm. Session log appears with count = 1 and "undo last" button. Click "undo last" → toast appears, count goes to 0. Verify in Discogs that the record was removed from your collection. Stop the server.

- [x] **Step 3: Commit**

```bash
git add src/routes/+page.svelte
git commit -m "feat: wire up undo for session log"
```

---

## Task 20: Keyboard handler

**Files:**
- Create: `src/lib/keyboard.svelte.ts`

- [x] **Step 1: Create the handler**

```ts
import { mode } from '$lib/stores/mode.svelte';

interface KeyboardActions {
  focusSearch: () => void;
  highlightUp: () => void;
  highlightDown: () => void;
  selectHighlighted: () => void;
  confirmModal: () => void;
  cancelModal: () => void;
  undoLast: () => void;
  toggleShortcuts: () => void;
}

interface KeyboardState {
  modalOpen: () => boolean;
}

export function installKeyboard(actions: KeyboardActions, state: KeyboardState) {
  function handler(e: KeyboardEvent) {
    const target = e.target as HTMLElement | null;
    const inEditable =
      target?.tagName === 'INPUT' ||
      target?.tagName === 'TEXTAREA' ||
      target?.isContentEditable;

    if (state.modalOpen()) {
      if (e.key === 'Enter') {
        e.preventDefault();
        actions.confirmModal();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        actions.cancelModal();
        return;
      }
      return;
    }

    if (mode.current === 'scanner') {
      if (e.key === 'Escape' || e.key === 's' || e.key === 'S') {
        e.preventDefault();
        mode.setSearch();
      }
      return;
    }

    // Search mode
    if (e.key === '/' && !inEditable) {
      e.preventDefault();
      actions.focusSearch();
      return;
    }

    if ((e.key === 's' || e.key === 'S') && !inEditable) {
      e.preventDefault();
      mode.setScanner();
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      actions.highlightDown();
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      actions.highlightUp();
      return;
    }

    if (e.key === 'Enter' && !inEditable) {
      e.preventDefault();
      actions.selectHighlighted();
      return;
    }

    if (e.key === 'Enter' && inEditable && target?.tagName === 'INPUT') {
      e.preventDefault();
      actions.selectHighlighted();
      return;
    }

    if ((e.key === 'u' || e.key === 'U') && !inEditable) {
      e.preventDefault();
      actions.undoLast();
      return;
    }

    if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      actions.undoLast();
      return;
    }

    if (e.key === '?') {
      e.preventDefault();
      actions.toggleShortcuts();
      return;
    }
  }

  window.addEventListener('keydown', handler);
  return () => window.removeEventListener('keydown', handler);
}
```

- [x] **Step 2: Commit**

```bash
git add src/lib/keyboard.svelte.ts
git commit -m "feat: add global keyboard handler"
```

---

## Task 21: ShortcutOverlay component

**Files:**
- Create: `src/lib/components/ShortcutOverlay.svelte`

- [x] **Step 1: Create the component**

```svelte
<script lang="ts">
  let {
    open,
    onClose,
  }: {
    open: boolean;
    onClose: () => void;
  } = $props();

  const shortcuts: { key: string; label: string }[] = [
    { key: '/', label: 'Focus search' },
    { key: 's', label: 'Toggle scanner mode' },
    { key: '↑ ↓', label: 'Move selection in results' },
    { key: '↵', label: 'Open confirm / confirm add' },
    { key: 'esc', label: 'Close modal / exit scanner' },
    { key: 'u  •  ⌘Z', label: 'Undo last add' },
    { key: '?', label: 'Toggle this overlay' },
  ];
</script>

{#if open}
  <div class="backdrop" onclick={onClose} role="presentation">
    <div class="panel" onclick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
      <div class="title">Keyboard shortcuts</div>
      <table>
        <tbody>
          {#each shortcuts as s}
            <tr>
              <td><span class="kbd">{s.key}</span></td>
              <td>{s.label}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    z-index: 150;
  }
  .panel {
    background: var(--bg-raised);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    padding: 18px 22px;
    min-width: 280px;
  }
  .title {
    font-size: 13px;
    color: var(--text);
    margin-bottom: 12px;
    font-weight: 600;
  }
  table {
    border-collapse: collapse;
    width: 100%;
  }
  td {
    padding: 5px 8px;
    font-size: 12px;
    color: var(--text-muted);
  }
  td:first-child {
    text-align: right;
    width: 1%;
    white-space: nowrap;
  }
</style>
```

- [x] **Step 2: Commit**

```bash
git add src/lib/components/ShortcutOverlay.svelte
git commit -m "feat: add ShortcutOverlay component"
```

---

## Task 22: Wire up keyboard handler and shortcut overlay

**Files:**
- Modify: `src/routes/+page.svelte`

- [x] **Step 1: Integrate keyboard + overlay**

In `src/routes/+page.svelte`, add to imports:
```ts
import ShortcutOverlay from '$lib/components/ShortcutOverlay.svelte';
import { installKeyboard } from '$lib/keyboard.svelte';
import { onMount } from 'svelte';
```

Add a state variable below the existing ones:
```ts
let shortcutsOpen = $state(false);
let searchBar: { focus: () => void } | undefined = $state();
```

Replace `<SearchBar bind:value={query} onScan={() => mode.setScanner()} />` with:
```svelte
<SearchBar bind:this={searchBar} bind:value={query} onScan={() => mode.setScanner()} />
```

Add a function to select the currently-highlighted result:
```ts
function selectHighlighted() {
  const r = results[highlightedIndex];
  if (r) handleSelect(r);
}

function highlightUp() {
  if (results.length === 0) return;
  highlightedIndex = (highlightedIndex - 1 + results.length) % results.length;
}

function highlightDown() {
  if (results.length === 0) return;
  highlightedIndex = (highlightedIndex + 1) % results.length;
}
```

Add keyboard install in `onMount`:
```ts
onMount(() => {
  return installKeyboard(
    {
      focusSearch: () => searchBar?.focus(),
      highlightUp,
      highlightDown,
      selectHighlighted,
      confirmModal: () => confirmAdd(),
      cancelModal: () => cancelAdd(),
      undoLast,
      toggleShortcuts: () => (shortcutsOpen = !shortcutsOpen),
    },
    { modalOpen: () => pending !== null },
  );
});
```

Add to template (just before the final `</div>` or after `{#if pending}`):
```svelte
<ShortcutOverlay open={shortcutsOpen} onClose={() => (shortcutsOpen = false)} />
```

Also update the `?` hint in the header to be clickable:
```svelte
<button type="button" class="hint" onclick={() => (shortcutsOpen = true)}>
  <span class="kbd">?</span> shortcuts
</button>
```

And add to the `<style>` block:
```css
.hint {
  background: transparent;
  border: none;
  color: var(--text-muted);
  font-size: 12px;
  padding: 0;
}
```

- [x] **Step 2: Manually verify all shortcuts**

```bash
pnpm dev
```
Open http://localhost:5173. Test each shortcut:
- Press `?` → shortcut overlay appears. Press `?` again → closes.
- Press `/` → search bar focuses.
- Type a query, then press `↓` and `↑` → highlight moves.
- Press `Enter` while in the search input → confirm modal opens for highlighted result.
- Press `Esc` → modal closes.
- Press `Enter` again → modal opens. Press `Enter` → adds, modal closes.
- Press `u` → undo runs, toast appears, record removed from Discogs.
- Press `Cmd+Z` → also triggers undo.
- Press `s` → switches to scanner mode (placeholder). Press `s` or `Esc` → back to search.

Stop the server.

- [x] **Step 3: Commit**

```bash
git add src/routes/+page.svelte
git commit -m "feat: wire up keyboard shortcuts and overlay"
```

---

## Task 23: Barcode lookup endpoint

**Files:**
- Create: `src/routes/api/discogs/barcode/[code]/+server.ts`

- [x] **Step 1: Create the endpoint**

```ts
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { DiscogsRelease } from '$lib/types';
import { discogsFetch, DiscogsError } from '$lib/server/discogs';

interface DiscogsSearchResult {
  id: number;
  title: string;
  year?: string;
  country?: string;
  label?: string[];
  format?: string[];
  thumb?: string;
  cover_image?: string;
}
interface DiscogsSearchResponse {
  results: DiscogsSearchResult[];
}

function parseTitle(combined: string): { artist: string; title: string } {
  const idx = combined.indexOf(' - ');
  if (idx === -1) return { artist: '', title: combined };
  return { artist: combined.slice(0, idx), title: combined.slice(idx + 3) };
}
function trim(r: DiscogsSearchResult): DiscogsRelease {
  const { artist, title } = parseTitle(r.title);
  return {
    id: r.id,
    artist,
    title,
    year: r.year ? Number(r.year) || null : null,
    country: r.country ?? null,
    label: r.label?.[0] ?? null,
    format: r.format?.join(', ') ?? null,
    thumb: r.thumb ?? null,
    coverImage: r.cover_image ?? null,
  };
}

export const GET: RequestHandler = async ({ params }) => {
  const code = params.code?.trim();
  if (!code) throw error(400, 'barcode required');

  try {
    const qs = new URLSearchParams({ barcode: code, type: 'release', per_page: '25' });
    const data = (await discogsFetch(
      `/database/search?${qs}`,
    )) as DiscogsSearchResponse;
    const results = (data.results ?? []).map(trim);
    return json({ results, barcode: code });
  } catch (e) {
    if (e instanceof DiscogsError) {
      return json(e.payload, { status: e.status });
    }
    throw error(500, { message: 'Unexpected error' });
  }
};
```

> **Note on duplication:** the `parseTitle` / `trim` / type definitions are duplicated from `search/+server.ts`. That's intentional for MVP — both endpoints are thin and the logic is small. Extracting a shared helper module is fine if you'd rather DRY it up; create `src/lib/server/release-mapping.ts` and import from both. Either way is reasonable.

- [x] **Step 2: Manually verify with a known barcode**

```bash
pnpm dev
```
Pick a barcode from any record you own (or use `077778591115` as a known sample). Then:
```bash
curl http://localhost:5173/api/discogs/barcode/077778591115
```
Expected: `{"results":[...], "barcode":"077778591115"}` with at least one result. Stop the server.

- [x] **Step 3: Commit**

```bash
git add src/routes/api/discogs/barcode/
git commit -m "feat: add /api/discogs/barcode/:code endpoint"
```

---

## Task 24: Install ZXing and create Scanner component

**Files:**
- Modify: `package.json` (via pnpm add)
- Create: `src/lib/components/Scanner.svelte`

- [x] **Step 1: Install `@zxing/browser`**

```bash
pnpm add @zxing/browser
```

- [x] **Step 2: Create `src/lib/components/Scanner.svelte`**

```svelte
<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { BrowserMultiFormatReader, type IScannerControls } from '@zxing/browser';

  let {
    onDecode,
    onError,
  }: {
    onDecode: (text: string) => void;
    onError?: (err: unknown) => void;
  } = $props();

  let videoEl: HTMLVideoElement | undefined = $state();
  let controls: IScannerControls | undefined;
  let cameraError = $state<string | null>(null);
  let decoded = false;

  function beep() {
    try {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = 880;
      gain.gain.value = 0.1;
      osc.start();
      setTimeout(() => {
        osc.stop();
        ctx.close();
      }, 120);
    } catch {
      // beep is best-effort
    }
  }

  onMount(async () => {
    if (!videoEl) return;
    const reader = new BrowserMultiFormatReader();
    try {
      controls = await reader.decodeFromConstraints(
        { video: { facingMode: 'environment' } },
        videoEl,
        (result) => {
          if (decoded || !result) return;
          decoded = true;
          beep();
          controls?.stop();
          onDecode(result.getText());
        },
      );
    } catch (e) {
      const err = e as { name?: string };
      if (err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError') {
        cameraError = 'Camera blocked — enable in browser settings, or use search instead.';
      } else if (err?.name === 'NotFoundError') {
        cameraError = 'No camera found.';
      } else {
        cameraError = 'Could not start camera.';
      }
      onError?.(e);
    }
  });

  onDestroy(() => {
    controls?.stop();
  });
</script>

<div class="wrap">
  {#if cameraError}
    <div class="error">{cameraError}</div>
  {:else}
    <div class="viewfinder">
      <video bind:this={videoEl} autoplay muted playsinline></video>
      <div class="frame"></div>
      <div class="hint">Center barcode in frame</div>
    </div>
    <div class="caption">Auto-detects · plays a beep on match</div>
  {/if}
</div>

<style>
  .wrap {
    margin-bottom: 12px;
  }
  .viewfinder {
    background: #000;
    border-radius: var(--radius);
    aspect-ratio: 4 / 3;
    position: relative;
    overflow: hidden;
  }
  video {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .frame {
    position: absolute;
    inset: 18%;
    border: 2px solid var(--accent);
    border-radius: var(--radius-sm);
    box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.45);
    pointer-events: none;
  }
  .hint {
    position: absolute;
    bottom: 10px;
    left: 0;
    right: 0;
    text-align: center;
    color: #ddd;
    font-size: 12px;
    z-index: 1;
  }
  .caption {
    margin-top: 8px;
    text-align: center;
    color: var(--text-muted);
    font-size: 12px;
  }
  .error {
    padding: 16px;
    background: rgba(219, 90, 90, 0.12);
    border: 1px solid rgba(219, 90, 90, 0.3);
    border-radius: var(--radius);
    color: var(--danger);
    font-size: 13px;
    text-align: center;
  }
</style>
```

- [x] **Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml src/lib/components/Scanner.svelte
git commit -m "feat: add Scanner component with ZXing barcode reader"
```

---

## Task 25: Wire up scanner mode

**Files:**
- Modify: `src/routes/+page.svelte`

- [x] **Step 1: Replace the scanner placeholder with the real Scanner**

In `src/routes/+page.svelte`, add to imports:
```ts
import Scanner from '$lib/components/Scanner.svelte';
```

Add a state variable:
```ts
let scanError = $state<string | null>(null);
```

Add a function:
```ts
async function handleBarcode(code: string) {
  loading = true;
  try {
    const res = await fetch(`/api/discogs/barcode/${encodeURIComponent(code)}`);
    const data = await res.json();
    results = data.results ?? [];
    highlightedIndex = 0;
    if (results.length === 0) {
      query = code;
      mode.setSearch();
      toast.show(`No match for ${code}. Try search instead.`, { kind: 'error' });
    } else {
      mode.setSearch();
    }
  } catch (e) {
    toast.show(e instanceof Error ? e.message : 'Lookup failed', { kind: 'error' });
    mode.setSearch();
  } finally {
    loading = false;
  }
}
```

Replace `<div class="placeholder">Scanner mode (coming soon)</div>` with:
```svelte
<Scanner onDecode={handleBarcode} onError={() => {}} />
<div class="exit-hint"><span class="kbd">esc</span> to exit scanner</div>
```

Add to `<style>`:
```css
.exit-hint {
  text-align: center;
  color: var(--text-muted);
  font-size: 12px;
}
```

- [x] **Step 2: Manually verify scanner end-to-end**

```bash
pnpm dev
```
Open http://localhost:5173. Press `s` to enter scanner mode. The browser will request camera permission — grant it. The viewfinder shows your webcam feed. Hold any UPC/EAN barcode (a record, a book, a grocery item) up to the camera. On a successful decode you should hear a beep, the app jumps back to search-results state, and results appear (or a "no match" toast). Press `Esc` to exit scanner mode. Stop the server.

- [x] **Step 3: Commit**

```bash
git add src/routes/+page.svelte
git commit -m "feat: wire up scanner mode with barcode lookup"
```

---

## Task 26: No-token setup screen

**Files:**
- Modify: `src/routes/+page.svelte`

- [x] **Step 1: Detect missing/invalid token and show a setup screen**

The simplest approach: on page mount, fire a low-cost search (`?q=test`) and watch for `error: 'no_token'` or `error: 'invalid_token'`. If detected, render a setup screen instead of the normal app.

In `src/routes/+page.svelte`, add to state declarations:
```ts
let tokenStatus = $state<'checking' | 'ok' | 'missing' | 'invalid'>('checking');
```

Add to `onMount` (before the `installKeyboard` call):
```ts
const probe = await fetch('/api/discogs/search?q=test');
const probeData = await probe.json().catch(() => ({}));
if (probeData?.error === 'no_token') tokenStatus = 'missing';
else if (probeData?.error === 'invalid_token') tokenStatus = 'invalid';
else tokenStatus = 'ok';
```

Wrap the existing `<div class="app">` in a top-level conditional:
```svelte
{#if tokenStatus === 'checking'}
  <div class="app"><div class="loading">Loading…</div></div>
{:else if tokenStatus === 'missing' || tokenStatus === 'invalid'}
  <div class="app">
    <header><span class="logo">booth</span></header>
    <div class="setup">
      <h2>{tokenStatus === 'missing' ? 'Setup needed' : 'Token rejected'}</h2>
      <p>
        {#if tokenStatus === 'missing'}
          The <code>DISCOGS_TOKEN</code> environment variable isn't set.
        {:else}
          Your Discogs token was rejected (401). It may be expired or mistyped.
        {/if}
      </p>
      <ol>
        <li>Get a personal access token at <code>discogs.com/settings/developers</code>.</li>
        <li>Add it to <code>.env</code> as <code>DISCOGS_TOKEN=&lt;token&gt;</code>.</li>
        <li>Restart <code>pnpm dev</code>.</li>
      </ol>
    </div>
  </div>
{:else}
  <div class="app">
    <!-- existing app content -->
  </div>
  {#if pending}<ConfirmModal ... />{/if}
  <ShortcutOverlay ... />
{/if}
```

Add to `<style>`:
```css
.setup {
  margin-top: 24px;
  background: var(--bg-raised);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  padding: 20px;
}
.setup h2 {
  font-size: 16px;
  margin: 0 0 8px;
}
.setup p {
  color: var(--text-muted);
  margin: 0 0 12px;
}
.setup code {
  background: var(--bg);
  padding: 1px 5px;
  border-radius: 3px;
  font-family: var(--font-mono);
  font-size: 12px;
}
.setup ol {
  margin: 0;
  padding-left: 20px;
  color: var(--text-muted);
  font-size: 13px;
}
.setup li {
  margin-bottom: 4px;
}
```

- [x] **Step 2: Manually verify the setup screen**

Temporarily blank the token in `.env` (`DISCOGS_TOKEN=`), then:
```bash
pnpm dev
```
Open http://localhost:5173. The setup screen should render with the "Setup needed" heading and instructions. Restore your real token, restart `pnpm dev`, and verify the normal app reappears. Stop the server.

- [x] **Step 3: Commit**

```bash
git add src/routes/+page.svelte
git commit -m "feat: add setup screen for missing or invalid token"
```

---

## Task 27: Rate-limit banner

**Files:**
- Modify: `src/routes/+page.svelte`

- [x] **Step 1: Show a non-blocking banner on 429**

In `src/routes/+page.svelte`, update `runSearch` and `handleBarcode` to check for `error === 'rate_limited'` and show a toast instead of (or in addition to) other handling.

Update `runSearch`:
```ts
async function runSearch(q: string) {
  loading = true;
  try {
    const res = await fetch(`/api/discogs/search?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    if (!res.ok) {
      if (data?.error === 'rate_limited') {
        toast.show(`Rate limited. Try again in ${data.retryAfter ?? 60}s.`, { kind: 'error' });
      } else {
        toast.show(data?.message ?? 'Search failed', { kind: 'error' });
      }
      return;
    }
    results = data.results ?? [];
    highlightedIndex = 0;
  } catch (e) {
    toast.show(e instanceof Error ? e.message : 'Network error', {
      kind: 'error',
      action: { label: 'retry', onClick: () => runSearch(q) },
    });
  } finally {
    loading = false;
  }
}
```

Update `handleBarcode` similarly — check for `rate_limited` and route through toast.

(Add/Remove flows already surface server errors via `modalError` and toast retry — they handle 429 by showing the message text. That's enough.)

- [x] **Step 2: Manually verify error path**

This is hard to test naturally since hitting Discogs's rate limit takes 60+ requests/min. Smoke-test instead by temporarily editing `src/lib/server/discogs.ts` to throw a fake rate-limit error in `discogsFetch`:
```ts
// At the very top of discogsFetch (temporary):
throw new DiscogsError({ error: 'rate_limited', retryAfter: 30 }, 429);
```
Run `pnpm dev`, type a search query, confirm the toast: "Rate limited. Try again in 30s." Then **revert the temporary throw** before committing.

- [x] **Step 3: Commit**

```bash
git add src/routes/+page.svelte
git commit -m "feat: show toast on rate-limit and network errors"
```

---

## Task 28: Final manual smoke test & polish

**Files:**
- (Verification only — adjustments inline as needed)

- [x] **Step 1: Walk through the whole product**

```bash
pnpm dev
```

Verify all of the following work end-to-end:
1. Open http://localhost:5173. Search bar is focused.
2. Type a query → results appear within ~500ms with cover thumbnails.
3. Arrow keys move highlight; `Enter` opens confirm modal; `Esc` closes it.
4. Confirm an add → toast appears, session log shows count = 1.
5. `u` undoes the last add → toast appears, count = 0, removed from Discogs.
6. `s` enters scanner mode. Camera viewfinder shows. Scan a barcode.
7. After a beep, results appear in search-results view. Pick one and add it.
8. `?` shows shortcut overlay. `?` hides it.
9. Blank `DISCOGS_TOKEN`, restart, see setup screen. Restore.

- [x] **Step 2: Fix anything broken**

Fix any issues spotted in step 1 inline. Common things to watch for:
- Search-bar focus not restoring after exiting scanner → in the `mode` change to `'search'`, call `searchBar?.focus()` from the page (an `$effect` watching `mode.current` is the cleanest way).
- Camera not stopping when navigating away → confirmed by `Scanner.svelte`'s `onDestroy`, but verify in DevTools that the camera indicator turns off when leaving scanner mode.
- `Cmd+Z` may be intercepted by the browser if the search input is focused (it'll undo typed text first). Acceptable — the on-screen "undo last" button and the `u` key both work.

- [x] **Step 3: Final commit**

```bash
git add -A
git commit -m "chore: final smoke test and polish" --allow-empty
```

The MVP is complete.

---

## Self-review notes (for the executing engineer)

- **No tests** — per the spec, MVP has no automated tests. If a behavior becomes flaky during use, add a Vitest unit test for the smallest unit that owns the logic.
- **Token never reaches the browser** — verify by opening DevTools → Network and confirming no request to `api.discogs.com` directly and no `Authorization` header in any request to `/api/*`. The token is only ever in `.env` and in the `Authorization` header sent server → Discogs.
- **Future expansion to phone scanning** is enabled by a config change (bind SvelteKit to LAN, add HTTPS via mkcert) — no code changes required. Out of scope for this plan.
