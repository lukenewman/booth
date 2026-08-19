# Booth Remote Access (Project A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Booth reachable and secure from a phone — a production build running under Bun, served over HTTPS on a Tailscale tailnet, syncing on a schedule instead of only at boot.

**Architecture:** Three independent moves. (1) Replace `adapter-auto` with `adapter-node` and run the output under Bun, because `bun:sqlite` is the DB layer and no serverless adapter can host it. (2) Put `tailscale serve` in front of it, which supplies TLS, remote reachability, and the authentication boundary in one step — Booth itself gains no auth code and is never publicly exposed. (3) Add an in-process sync scheduler, because the existing boot-triggered sync fires once per process and an always-on server would therefore stop syncing forever.

**Tech Stack:** Bun, SvelteKit 2 / Svelte 5 (runes), TypeScript, `@sveltejs/adapter-node`, `bun:sqlite`, Tailscale.

**Spec:** `docs/superpowers/specs/2026-08-18-remote-access-and-mobile-design.md`

**Linear:** [Remote access + mobile](https://linear.app/boothapp/project/remote-access-mobile-9e2b2489e4d7) — Task 1 = BOO-48, Task 2 = BOO-49, Task 3 = BOO-50, Task 4 = BOO-51.

## Global Constraints

- **Bun only.** `bun:sqlite` is the DB layer, so every command runs under Bun. Never introduce a Node-only code path or a Node-only dependency.
- **The `--bun` flag is mandatory** for Vite: `bunx --bun vite dev` / `bunx --bun vite build`. Without it the SSR runtime has no `bun:sqlite`.
- **There is no test runner and you must not add one.** No vitest, no jest, no `bun:test`. The project's test idiom is a standalone script in `scripts/` run as `bun verify scripts/<name>.ts` (the `verify` package script is literally `bun`, so it executes the file). Scripts print `✓`/`✗` per assertion and `process.exit(1)` when any fail. Match `scripts/verify-stale-input.ts` and `scripts/verify-db.ts`.
- **Scripts cannot import anything that imports `$lib/...`.** They run outside SvelteKit, so the `$lib` alias does not resolve. Anything a verify script needs to import must be a module with no `$lib` imports. This is why testable logic goes in pure modules and env/registry/DB wiring stays in the caller — the same split `recording/env.ts` already uses against the pure `recording/*` modules.
- **Server env is read only through `src/lib/server/env.ts`.** Never import `$env/dynamic/private` anywhere else: it returns empty under the Bun runtime, and `env.ts` is the Proxy that falls back to `process.env`.
- **Type check with `bun check`** (`svelte-kit sync && svelte-check`). It must pass before every commit.
- `BOOTH_SYNC_INTERVAL_MINUTES` — default `360`, `0` disables. Exact values.
- **Tier 2 only.** No transcoding, no media cache, no cellular streaming. `/api/stream/[trackId]` already serves range requests and needs no change.
- **No app-level auth, no login UI, no user accounts.** Tailscale is the authentication boundary.
- Work directly on `main`. Commit at the end of each task. No worktrees, no PRs.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `svelte.config.js` | modify — swap `adapter-auto` → `adapter-node` | 1 |
| `vite.config.ts` | modify (contingency only) — keep `bun:` specifiers external to Rollup | 1 |
| `scripts/verify-prod-server.ts` | create — boots the built server under Bun and asserts it reaches the DB | 1 |
| `package.json` | modify — drop `adapter-auto`, add `start` script | 1, 2 |
| `docs/CONTEXT.md` | modify — production start command, Tailscale serving, scheduler + pragmas | 2, 3, 4 |
| `src/lib/server/db/pragmas.ts` | create — `applyPragmas(db)`; pure, no `$lib` imports so scripts can test it | 4 |
| `src/lib/server/db/index.ts` | modify — call `applyPragmas` instead of inline pragmas | 4 |
| `src/lib/server/library/scheduler.ts` | create — pure scheduling core: interval parsing + non-stacking tick. No `$lib`, no env, no registry | 4 |
| `src/hooks.server.ts` | modify — wire the scheduler to `runSync`/registry/env alongside the existing boot hook | 4 |
| `scripts/verify-scheduler.ts` | create — covers interval parsing, non-stacking, lock release, pragmas | 4 |
| `.env.example` | modify — document `BOOTH_SYNC_INTERVAL_MINUTES` | 4 |

**Task 4 depends on nothing.** If Task 1 stalls, pull Task 4 forward rather than idling — it is a real defect fix on its own terms.

---

### Task 1: Prove the production build boots under Bun (BOO-48)

This is the project's only real technical risk. `adapter-node` emits a *Node* server; that `bun:sqlite` imports cleanly from **built** output — as opposed to dev, where it is known to work — is an assumption, not a verified fact.

**Files:**
- Create: `scripts/verify-prod-server.ts`
- Modify: `svelte.config.js:1`
- Modify: `package.json` (devDependencies)
- Modify (contingency, Step 6 only): `vite.config.ts`

**Interfaces:**
- Produces: a runnable server at `./build/index.js`, started with `bun ./build/index.js`, honouring `PORT` and `HOST`. Task 2 wraps this in a package script; Task 3 puts Tailscale in front of it.

- [ ] **Step 1: Write the failing smoke check**

Create `scripts/verify-prod-server.ts`:

```ts
/**
 * verify-prod-server.ts — the production build boots under Bun and reaches the DB.
 *
 * Booth's DB layer is `bun:sqlite`, so the built server has to run on Bun, not
 * Node. /api/sources calls getDb(), so a 200 from it proves the built bundle
 * resolved bun:sqlite, opened the database, and ran migrations.
 *
 * Run: bun run build && bun verify scripts/verify-prod-server.ts
 */
const BUILD = './build/index.js';
const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : `\n    expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
}

if (!(await Bun.file(BUILD).exists())) {
  console.error(`✗ ${BUILD} not found — run \`bun run build\` first`);
  process.exit(1);
}

const proc = Bun.spawn(['bun', BUILD], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
  stdout: 'pipe',
  stderr: 'pipe',
});

/** Poll until the server answers, it dies, or we give up. */
async function waitForServer(timeoutMs = 20_000): Promise<Response | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) return null; // server exited instead of listening
    try {
      return await fetch(`${BASE}/api/sources`);
    } catch {
      await Bun.sleep(250);
    }
  }
  return null;
}

try {
  const res = await waitForServer();
  check('server answers /api/sources', res?.status ?? 'no response', 200);

  if (res?.status === 200) {
    const body = (await res.json()) as Array<{ id: string }>;
    check('body is an array', Array.isArray(body), true);
    check('discogs source present (registry + DB reached)', Array.isArray(body) && body.some((s) => s.id === 'discogs'), true);
  }
} finally {
  proc.kill();
  if (failures > 0) {
    const stderr = await new Response(proc.stderr).text();
    if (stderr.trim()) console.error(`\n--- server stderr ---\n${stderr}`);
  }
}

console.log(failures === 0 ? '\nOK: production build boots under Bun and reaches the DB' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
bun run build
bun verify scripts/verify-prod-server.ts
```

Expected: FAIL. `adapter-auto` detects no supported deployment platform locally, so no `./build/index.js` is produced and the script exits 1 with `✗ ./build/index.js not found`.

If `./build/index.js` somehow already exists from an earlier experiment, `rm -rf build` first — a stale artifact would make this step lie.

- [ ] **Step 3: Install adapter-node**

```bash
bun add -d @sveltejs/adapter-node
```

- [ ] **Step 4: Point the config at it**

In `svelte.config.js`, change line 1 only:

```js
import adapter from '@sveltejs/adapter-node';
```

Leave the `adapter()` call and `compilerOptions` untouched. Delete the three `adapter-auto` comment lines above `adapter: adapter()` — they now describe a package the project no longer uses.

- [ ] **Step 5: Build and run the check**

```bash
bun run build
bun verify scripts/verify-prod-server.ts
```

Expected: PASS, ending in `OK: production build boots under Bun and reaches the DB`.

**If the build fails with `Could not resolve "bun:sqlite"`, that is the expected failure mode — go to Step 6. It is a bundler-config problem, not a verdict on `adapter-node`.** Do not switch to `svelte-adapter-bun` at this point.

- [ ] **Step 6: Contingency — keep `bun:` specifiers external**

Only if Step 5 failed to build. Rollup does not know `bun:sqlite` and will try to bundle it; it has to stay external so the built server imports it from the Bun runtime at execution time.

```ts
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],
	// bun:sqlite is supplied by the Bun runtime and is not resolvable by
	// Rollup. Keep every bun: specifier external so the built server imports
	// it at runtime instead of trying to inline it at build time.
	build: { rollupOptions: { external: [/^bun:/] } },
	ssr: { external: ['bun:sqlite'] }
});
```

Then re-run Step 5. Expected: PASS.

- [ ] **Step 7: Record the verdict on BOO-48**

Write the outcome into the Linear issue: which of Steps 5 or 6 produced a working server, the exact build and start commands, and — if it failed — the exact error, with confirmation that the Step 6 externalization was tried and did not help. That last part is what distinguishes "adapter-node is unworkable" from "we misconfigured Rollup", and it is the only evidence that justifies the `svelte-adapter-bun` fallback.

- [ ] **Step 8: Type check and commit**

```bash
bun check
git add scripts/verify-prod-server.ts svelte.config.js package.json bun.lockb vite.config.ts
git commit -m "feat(infra): run the production build under Bun via adapter-node

bun:sqlite forces the Bun runtime, so adapter-auto cannot produce a
self-hostable server. verify-prod-server.ts boots ./build/index.js and
asserts /api/sources reaches the DB, which covers migrations too.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Include `vite.config.ts` in the `git add` only if Step 6 was needed.

---

### Task 2: Land the swap — start script and docs (BOO-49)

Task 1 proved it works. This makes it the documented, repeatable way to run Booth.

**Files:**
- Modify: `package.json` (scripts, devDependencies)
- Modify: `docs/CONTEXT.md:16` (Tech → Dev) and the `## Local development` section

**Interfaces:**
- Consumes: `./build/index.js` from Task 1.
- Produces: `bun start` as the documented production command on port 3000. Task 3 points `tailscale serve` at that port.

- [ ] **Step 1: Remove the dead adapter**

```bash
bun remove @sveltejs/adapter-auto
```

- [ ] **Step 2: Add the start script**

In `package.json`, add to `scripts`, after `"preview"`:

```json
		"start": "bun ./build/index.js",
```

- [ ] **Step 3: Verify the whole path from a clean build**

```bash
rm -rf build
bun run build
bun verify scripts/verify-prod-server.ts
```

Expected: PASS. This confirms `adapter-auto`'s removal broke nothing.

- [ ] **Step 4: Confirm `.env` still resolves in the built server**

`docs/CONTEXT.md` documents that `$env/dynamic/private` comes back empty under Bun and `process.env` is what actually carries `.env` values. That was established in dev; confirm it holds for the built output.

```bash
bun start &
sleep 3
curl -s -o /dev/null -w '%{http_code}\n' 'http://127.0.0.1:3000/api/discogs/search?q=aphex+twin'
kill %1
```

Expected: `200`. This route calls `discogsFetch`, which reads `DISCOGS_TOKEN` through `$lib/server/env` — a 200 means the token resolved.

Needs network and a valid token in `.env`. A `401` or `500` means env did **not** resolve in the production build: `env.ts` reads `$env/dynamic/private` first and falls back to `process.env`, so check whether Bun populated `process.env` from `.env` for the built server the way it does for `bunx --bun vite dev`. If it did not, the fix is to load `.env` explicitly at startup, not to bypass `env.ts`.

- [ ] **Step 5: Document it**

In `docs/CONTEXT.md`, change the Dev bullet at line 16 to cover both modes:

```markdown
- **Dev:** `bun dev` (binds 5173, falls back upward). **Production:** `bun run build && bun start` — `adapter-node` output run under Bun (port 3000, override with `PORT`). The Bun runtime is not optional in either mode: the DB layer is `bun:sqlite`.
```

In the `## Local development` section, after the existing `bun dev` block, add:

````markdown
Run the production build (what the phone talks to — see Tailscale below):

```bash
bun run build
bun start          # http://localhost:3000, override with PORT
```

`bun start` is `bun ./build/index.js`. It must be Bun, not Node — `adapter-node` emits a Node-shaped server, but the DB layer imports `bun:sqlite`, which only the Bun runtime provides. Verified end-to-end by `scripts/verify-prod-server.ts`.

Unlike `bun dev`, the production server does not restart on file changes — which is exactly why sync has to be scheduled rather than boot-triggered (see **Scheduled sync**).
````

- [ ] **Step 6: Type check and commit**

```bash
bun check
git add package.json bun.lockb docs/CONTEXT.md
git commit -m "feat(infra): add bun start; drop adapter-auto; document production run

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Serve Booth over Tailscale with HTTPS (BOO-50)

Operational task — no application code changes. The verification is manual and the secure-context checks are the part that actually matters.

**Files:**
- Modify: `docs/CONTEXT.md` (`## Local development`, after the production block from Task 2)

**Interfaces:**
- Consumes: `bun start` on port 3000 from Task 2.
- Produces: Booth at `https://<host>.<tailnet>.ts.net` — a genuine secure context, which Project B's mobile shell assumes.

- [ ] **Step 1: Install Tailscale on the host Mac and the phone**

```bash
brew install --cask tailscale
```

Sign both devices into the same tailnet. Then:

```bash
tailscale status
```

Expected: both machines listed. Note the Mac's tailnet hostname — `<host>.<tailnet>.ts.net`.

- [ ] **Step 2: Enable HTTPS for the tailnet**

In the Tailscale admin console (DNS settings), enable **MagicDNS** and **HTTPS Certificates**. `tailscale serve --https` cannot obtain a Let's Encrypt cert without both, and the failure message does not always say so plainly.

- [ ] **Step 3: Start Booth and put Tailscale in front of it**

```bash
bun run build && bun start &
tailscale serve --bg --https=443 http://127.0.0.1:3000
tailscale serve status
```

Expected: `serve status` shows `https://<host>.<tailnet>.ts.net` proxying to `http://127.0.0.1:3000`.

Keep the origin bound to `127.0.0.1`, not `0.0.0.0`: Tailscale is the only thing that should be able to reach it. Do **not** use `tailscale funnel` — that publishes to the public internet, which is an explicit non-goal, and Booth has no auth of any kind.

- [ ] **Step 4: Verify from the phone**

Open `https://<host>.<tailnet>.ts.net` on the phone, on cellular with wifi off.

Expected: the library loads, with a valid certificate and no browser warning. Browsing is expected to work over cellular; audio playback is Tier 2 (home wifi) and is not being tested here.

- [ ] **Step 5: Verify the secure context — the checks that matter**

`Scanner.svelte` and `recorder.svelte.ts` both call `getUserMedia`, which requires a secure context. Today that is satisfied only by `localhost`; over a plain LAN IP both silently break. Confirm the Tailscale origin restores it, on the desktop browser at the `ts.net` hostname:

- [ ] Barcode scanner opens the camera and reads a barcode
- [ ] Vinyl recorder opens the audio interface and captures a take

If either fails, check the origin is `https://` and not an `http://` fallback before touching application code.

- [ ] **Step 6: Document and commit**

Add to `docs/CONTEXT.md` in `## Local development`, after the production block:

````markdown
### Remote access

Booth is reachable from other devices over Tailscale, never over the public internet:

```bash
bun run build && bun start                              # origin on 127.0.0.1:3000
tailscale serve --bg --https=443 http://127.0.0.1:3000  # https://<host>.<tailnet>.ts.net
```

Requires MagicDNS + HTTPS Certificates enabled for the tailnet.

**Why Tailscale rather than a port-forward or reverse proxy:** Booth has no auth of any kind — no session, no user, no password, and `DISCOGS_TOKEN` in `.env` — so anything internet-facing would need auth built first. Tailscale supplies remote access, TLS, and the authentication boundary at once. Never use `tailscale funnel`, which publishes publicly.

**The TLS is load-bearing, not cosmetic.** `Scanner.svelte` and `recorder.svelte.ts` call `getUserMedia`, which needs a secure context; over a plain LAN IP the scanner and the vinyl recorder both stop working. `tailscale serve` gives a real HTTPS origin, so both keep working away from `localhost`.
````

```bash
git add docs/CONTEXT.md
git commit -m "docs(infra): document Tailscale HTTPS serving

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Scheduled sync and a SQLite busy timeout (BOO-51)

**Depends on nothing.** Can be done before, during, or after Tasks 1–3.

Auto-sync is boot-triggered once per process (`src/hooks.server.ts`, module-level `triggered` Set). That is invisible today only because `bun dev` restarts constantly. On an always-on server the library silently stops syncing forever.

**Files:**
- Create: `src/lib/server/db/pragmas.ts`
- Modify: `src/lib/server/db/index.ts:12-22`
- Create: `src/lib/server/library/scheduler.ts`
- Modify: `src/hooks.server.ts`
- Create: `scripts/verify-scheduler.ts`
- Modify: `.env.example`
- Modify: `docs/CONTEXT.md`

**Interfaces:**
- Produces:
  - `applyPragmas(db: Database): void` — from `src/lib/server/db/pragmas.ts`
  - `DEFAULT_INTERVAL_MINUTES: 360`, `parseIntervalMinutes(raw: string | undefined): number`, `createScheduler(deps: SchedulerDeps): SyncScheduler` — from `src/lib/server/library/scheduler.ts`
  - `SchedulerDeps = { sourceIds: () => string[]; sync: (sourceId: string) => Promise<unknown>; onError?: (sourceId: string, err: unknown) => void }`
  - `SyncScheduler = { tick: () => Promise<void>; inFlight: () => string[] }`

Both new modules are pure — no `$lib` imports, no env, no registry — so `scripts/verify-scheduler.ts` can import them directly. Env, registry, and DB wiring stays in `hooks.server.ts`, mirroring how `recording/env.ts` keeps the pure `recording/*` modules env-free.

- [ ] **Step 1: Write the failing test**

Create `scripts/verify-scheduler.ts`:

```ts
/**
 * verify-scheduler.ts — sync scheduling and connection pragmas.
 *
 * Covers the two defects that only appear on an always-on server: boot-only
 * syncing (the library silently stops updating) and an unset busy_timeout
 * (a second writer fails immediately instead of waiting).
 *
 * Run: bun verify scripts/verify-scheduler.ts
 */
import { Database } from 'bun:sqlite';
import { applyPragmas } from '../src/lib/server/db/pragmas';
import { createScheduler, parseIntervalMinutes } from '../src/lib/server/library/scheduler';

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : `\n    expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

// --- interval parsing ------------------------------------------------------

check('unset → default', parseIntervalMinutes(undefined), 360);
check('blank → default', parseIntervalMinutes('   '), 360);
check('explicit 0 disables', parseIntervalMinutes('0'), 0);
check('explicit 15', parseIntervalMinutes('15'), 15);
// A typo must not silently stop syncing — that is the failure mode this whole
// task exists to fix, so unparseable input falls back to the default.
check('garbage → default', parseIntervalMinutes('later'), 360);
check('negative → default', parseIntervalMinutes('-5'), 360);

// --- a tick fires every eligible source ------------------------------------

const calls: string[] = [];
const s1 = createScheduler({
  sourceIds: () => ['discogs', 'local'],
  sync: async (id) => { calls.push(id); },
});
await s1.tick();
check('tick fires each source once', [...calls].sort(), ['discogs', 'local']);

// --- runs must not stack ---------------------------------------------------

const gate = deferred<void>();
const calls2: string[] = [];
const s2 = createScheduler({
  sourceIds: () => ['discogs'],
  sync: async (id) => { calls2.push(id); await gate.promise; },
});

const first = s2.tick(); // deliberately not awaited — leaves discogs in flight
check('source marked in flight', s2.inFlight(), ['discogs']);
await s2.tick();
check('second tick skips the in-flight source', calls2, ['discogs']);
gate.resolve();
await first;
check('lock released after completion', s2.inFlight(), []);
await s2.tick();
check('a later tick runs it again', calls2, ['discogs', 'discogs']);

// --- a failing sync must not wedge the lock --------------------------------

const errs: string[] = [];
const s3 = createScheduler({
  sourceIds: () => ['discogs'],
  sync: async () => { throw new Error('boom'); },
  onError: (id, err) => errs.push(`${id}:${(err as Error).message}`),
});
await s3.tick();
check('onError receives the failure', errs, ['discogs:boom']);
check('lock released after failure', s3.inFlight(), []);

// --- connection pragmas ----------------------------------------------------

const db = new Database(':memory:');
applyPragmas(db);
check('busy_timeout set', (db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout, 5000);
check('foreign_keys on', (db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1);

console.log(failures === 0 ? '\nOK: scheduling and pragmas behave' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
bun verify scripts/verify-scheduler.ts
```

Expected: FAIL — the module resolution errors out, because neither `src/lib/server/db/pragmas.ts` nor `src/lib/server/library/scheduler.ts` exists yet.

- [ ] **Step 3: Write the pragmas module**

Create `src/lib/server/db/pragmas.ts`:

```ts
import type { Database } from 'bun:sqlite';

/**
 * Connection pragmas every Booth DB handle needs. Kept out of `index.ts` so
 * verification scripts can exercise it without pulling in `$lib/server/env`,
 * which does not resolve outside SvelteKit.
 */
export function applyPragmas(db: Database): void {
  db.exec('PRAGMA journal_mode = WAL');
  // Without a busy timeout SQLite fails a contended write immediately with
  // SQLITE_BUSY rather than waiting for the lock. One process was the norm
  // historically, so this never bit; the sync scheduler in an always-on
  // server plus a `bun dev` session alongside it makes two writers, and WAL
  // still permits only one at a time.
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
}
```

- [ ] **Step 4: Use it from the DB singleton**

In `src/lib/server/db/index.ts`, add the import alongside `runMigrations`:

```ts
import { applyPragmas } from './pragmas';
```

and replace the two inline pragma lines:

```ts
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
```

with:

```ts
  applyPragmas(db);
```

- [ ] **Step 5: Write the scheduler core**

Create `src/lib/server/library/scheduler.ts`:

```ts
/**
 * Sync scheduling, kept pure: no env, no registry, no DB. The caller supplies
 * which sources are eligible and how to sync one, which lets verification
 * scripts drive it without SvelteKit's `$lib` alias.
 */

export const DEFAULT_INTERVAL_MINUTES = 360;

/**
 * Parse BOOTH_SYNC_INTERVAL_MINUTES into minutes. `0` means disabled.
 * Anything unparseable or negative falls back to the default rather than
 * disabling — a typo in `.env` must not silently stop the library syncing,
 * which is the exact failure this scheduler exists to prevent.
 */
export function parseIntervalMinutes(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_INTERVAL_MINUTES;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_INTERVAL_MINUTES;
  return Math.floor(n);
}

export interface SchedulerDeps {
  /** Eligible source ids, re-read each tick so registry/env changes are picked up. */
  sourceIds: () => string[];
  sync: (sourceId: string) => Promise<unknown>;
  onError?: (sourceId: string, err: unknown) => void;
}

export interface SyncScheduler {
  tick: () => Promise<void>;
  inFlight: () => string[];
}

/**
 * One tick syncs every eligible source that is not already syncing. Runs must
 * not stack: a source still in flight is skipped for this tick, never queued,
 * so a sync slower than the interval cannot pile up behind itself.
 */
export function createScheduler(deps: SchedulerDeps): SyncScheduler {
  const running = new Set<string>();

  return {
    inFlight: () => [...running],
    async tick() {
      await Promise.all(
        deps.sourceIds().map(async (id) => {
          if (running.has(id)) return;
          running.add(id);
          try {
            await deps.sync(id);
          } catch (err) {
            deps.onError?.(id, err);
          } finally {
            running.delete(id);
          }
        }),
      );
    },
  };
}
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
bun verify scripts/verify-scheduler.ts
```

Expected: PASS, all checks `✓`, ending in `OK: scheduling and pragmas behave`.

- [ ] **Step 7: Wire it into the server**

In `src/hooks.server.ts`: keep the existing boot hook exactly as it is — the scheduler runs *alongside* it, so a restart still syncs immediately rather than waiting a full interval.

Add the imports:

```ts
import { createScheduler, parseIntervalMinutes } from '$lib/server/library/scheduler';
```

Replace the body of `autoSyncAll()` so the eligibility rule lives in one place, and add the scheduler start below it:

```ts
/**
 * Sources worth syncing: skip stubs, and skip `local` unless ITUNES_XML_PATH
 * is set, since its sync (Apple Music XML parse) would just throw.
 */
function eligibleSourceIds(): string[] {
  return listSources()
    .filter((s) => !s.isStub)
    .filter((s) => !(s.id === 'local' && !env.ITUNES_XML_PATH))
    .map((s) => s.id);
}

/**
 * On the first request after server start, kick off a background sync for
 * every eligible source. Each source fires at most once per process.
 */
function autoSyncAll() {
  for (const id of eligibleSourceIds()) autoSyncOnce(id);
}

/**
 * The boot hook above fires once per process, which is invisible under
 * `bun dev` (constant restarts) but means an always-on production server
 * stops syncing forever. This adds the recurring pass.
 */
let schedulerStarted = false;
function startScheduledSync() {
  if (schedulerStarted) return;
  schedulerStarted = true;

  const minutes = parseIntervalMinutes(env.BOOTH_SYNC_INTERVAL_MINUTES);
  if (minutes === 0) {
    console.log('[sync] scheduler disabled (BOOTH_SYNC_INTERVAL_MINUTES=0)');
    return;
  }

  const scheduler = createScheduler({
    sourceIds: eligibleSourceIds,
    sync: (id) => runSync(getDb(), id),
    onError: (id, err) => console.warn(`[sync] ${id} scheduled sync failed:`, err),
  });

  const timer = setInterval(() => void scheduler.tick(), minutes * 60_000);
  // Cast rather than call directly: `setInterval` resolves to the DOM overload
  // (returning `number`) in some type configurations, and `unref` is Bun/Node
  // only. The timer must not be what keeps the process alive.
  (timer as unknown as { unref?: () => void }).unref?.();
  console.log(`[sync] scheduler running every ${minutes}m`);
}
```

and call it from the handle, next to the existing boot sync:

```ts
export const handle: Handle = async ({ event, resolve }) => {
  autoSyncAll();
  startScheduledSync();
  return resolve(event);
};
```

- [ ] **Step 8: Confirm it actually fires**

```bash
BOOTH_SYNC_INTERVAL_MINUTES=1 bun dev
```

Hit any page to trigger the hook. Expected in the log: `[sync] scheduler running every 1m` immediately, then a `discogs` sync roughly a minute later, and again a minute after that.

Then confirm the off switch:

```bash
BOOTH_SYNC_INTERVAL_MINUTES=0 bun dev
```

Expected: `[sync] scheduler disabled (BOOTH_SYNC_INTERVAL_MINUTES=0)`, and no recurring syncs.

**Expected and correct:** the `local` source reports `stale = true` on scheduled runs. `ITUNES_XML_PATH` points at a *manual* export that Music.app never rewrites, so re-reading it finds an unchanged file — exactly what the stale-input detection shipped 2026-08-13 is for. Scheduled sync benefits `discogs`, the source that actually drifts. Do not "fix" this.

- [ ] **Step 9: Document the new variable**

In `.env.example`, after the `BOOTH_RECORDINGS_PATH` block:

```
# Optional: how often to re-sync sources, in minutes (defaults to 360).
# Set to 0 to disable scheduled syncing. The boot sync still runs either way.
# BOOTH_SYNC_INTERVAL_MINUTES=360
```

In `docs/CONTEXT.md`, add a bullet next to the existing **Auto-sync on boot** entry:

```markdown
- **Scheduled sync:** `src/hooks.server.ts` also starts an interval timer (`BOOTH_SYNC_INTERVAL_MINUTES`, default 360, `0` disables) that re-runs `runSync()` for every eligible source, using the pure scheduler core in `src/lib/server/library/scheduler.ts`. **Why this exists:** the boot hook fires once per process, which is invisible under `bun dev` (it restarts constantly) but means an always-on production server stops syncing forever. Runs never stack — a source still in flight is skipped for that tick, not queued. The scheduler runs alongside the boot hook, not instead of it, so a restart still syncs immediately. In practice this benefits `discogs`; `local` re-reads a manual export and is correctly flagged `stale`. Verified by `scripts/verify-scheduler.ts`.
```

Also note the busy timeout where the DB layer is described:

```markdown
- **Connection pragmas** (`src/lib/server/db/pragmas.ts`, applied by `getDb()`): WAL, `foreign_keys = ON`, and `busy_timeout = 5000`. The timeout matters because scheduled sync in an always-on server plus a `bun dev` session alongside it makes two writers; without it, SQLite fails the contended write immediately with `SQLITE_BUSY` instead of waiting.
```

- [ ] **Step 10: Type check and commit**

```bash
bun check
bun verify scripts/verify-scheduler.ts
git add src/lib/server/db/pragmas.ts src/lib/server/db/index.ts src/lib/server/library/scheduler.ts src/hooks.server.ts scripts/verify-scheduler.ts .env.example docs/CONTEXT.md
git commit -m "feat(sync): schedule recurring syncs; set a SQLite busy timeout

The boot hook fires once per process, so an always-on server stops
syncing forever. Adds an interval pass alongside it, with runs that skip
rather than stack. Sets busy_timeout=5000 now that a scheduled sync and a
dev server can write concurrently.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Done when

- `bun run build && bun start` serves Booth under Bun, verified by `scripts/verify-prod-server.ts`.
- `https://<host>.<tailnet>.ts.net` loads on the phone, with the scanner and recorder confirmed working over that origin.
- `bun verify scripts/verify-scheduler.ts` passes, and a running server logs recurring syncs.
- `bun check` is clean.
- `docs/CONTEXT.md` documents the production command, Tailscale serving, the scheduler, and the pragmas.

Project A leaves the UI untouched. It is useless on its own — Project B (BOO-52…55) is what makes Booth usable on a phone, and BOO-52 depends on nothing, so it can proceed in parallel with all of this.
