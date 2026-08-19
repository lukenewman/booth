# Vinyl Smarter Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the absolute noise-floor splitter with an adaptive, music-relative detector and add joint distinct side-assignment across takes, so a quiet vinyl transfer auto-splits close to the true track boundaries and two takes never both land on "side A."

**Architecture:** `splitter.ts` gains a single `detectGaps(rms, hopMs) → { extent, gaps }` that smooths the RMS envelope, derives a median-relative threshold, trims lead-in/run-out via that threshold, and scores merged candidate dips (capped duration × depth × edge-penalty). `matcher.ts` consumes a `DetectResult` instead of raw RMS, and gains `assignSidesJointly(takes, blocks)` doing min-cost injective take→side matching. Because takes record sequentially, the binding joint assignment runs at review time: `finalize` stores each take's `{ gaps, extent, durationMs }` on the in-memory `TakeState` (and still returns a provisional per-take fit), and a new `POST …/propose` endpoint runs the joint match once all takes exist; `recorder.review()` awaits it and fills `takes[]`.

**Tech Stack:** SvelteKit 2 + Svelte 5 runes, TypeScript, Bun. Pure detection/matching logic lives under `src/lib/server/recording/` (no fs/DB/$env) and is verified with `scripts/verify-splitter.ts` run via `bun verify scripts/verify-splitter.ts`. Type-check with `bun check`.

## Global Constraints

- Work directly on `main`. No worktrees, no PRs. Commit each task when its verification passes.
- `splitter.ts` and `matcher.ts` stay **pure** — no `node:fs`, no DB, no `$env` imports — so verify scripts run under plain `bun`.
- All tunables are **named exported constants**, values copied verbatim from the spec: `SMOOTH_MS = 800`, `THR_FRAC = 0.22`, `MIN_GAP_MS = 700`, `MERGE_MS = 1500`, `DUR_CAP_MS = 3000`, `EDGE_MS = 30000`, `EDGE_PENALTY = 0.3`, `ABS_FLOOR = 0.0005`. `PAD_MS`, `SNAP_WINDOW_MS` unchanged.
- Verify-script idiom: `assert(cond, msg)` increments a `failures` counter and `process.exit(1)` at the end if any failed. Pure logic is verified by these scripts; endpoint/store wiring is verified by `bun check` plus the manual browser pass (no endpoint test harness exists in this repo — do not invent one).
- Spec of record: `docs/superpowers/specs/2026-06-18-vinyl-detection-design.md`.
- The throwaway probe `scripts/probe-detection.ts` MUST be deleted before this workstream's final commit (Task 5).

---

### Task 1: Adaptive `detectGaps` in `splitter.ts`

Add the music-relative detector alongside the existing functions (which stay until Task 2 rewires their only consumer). Test it directly against synthetic quiet-transfer envelopes.

**Files:**
- Modify: `src/lib/server/recording/splitter.ts`
- Test: `scripts/verify-splitter.ts`

**Interfaces:**
- Consumes: `Gap { startMs, endMs, score }` (existing, unchanged).
- Produces: `DetectResult { extent: { startMs, endMs }, gaps: Gap[] }`; `detectGaps(rms: Float32Array, hopMs: number): DetectResult`; new exported constants `SMOOTH_MS, THR_FRAC, MERGE_MS, DUR_CAP_MS, EDGE_MS, EDGE_PENALTY, ABS_FLOOR`; `MIN_GAP_MS` changed `500 → 700`.

- [ ] **Step 1: Write the failing tests**

Edit the import line at the top of `scripts/verify-splitter.ts` to also import `detectGaps`:

```ts
import { findGaps, detectGaps, PAD_MS } from '../src/lib/server/recording/splitter';
```

Then append these three cases to the **end** of `scripts/verify-splitter.ts`, immediately before the final two lines (`if (failures > 0) process.exit(1);` / `console.log('verify-splitter: all passed');`):

```ts
// --- Case D1: adaptive threshold + extent on a quiet transfer ---
// lead-in noise → 3 tracks @ -43dB separated by ~2.5s -57dB gaps → long run-out.
{
  const MUSIC = 0.0071; // ~-43 dBFS
  const GAP = 0.0011; //   ~-59 dBFS  (below 0.22*median)
  const OUT = 0.0008; //   ~-62 dBFS  (lead-in / run-out)
  const e = env([
    [20000, OUT], // lead-in
    [120000, MUSIC], // track 1
    [2500, GAP],
    [120000, MUSIC], // track 2
    [2500, GAP],
    [120000, MUSIC], // track 3
    [40000, OUT], // run-out
  ]);
  const { extent, gaps } = detectGaps(e, HOP);
  assert(gaps.length === 2, `D1: exactly 2 interior cuts (got ${gaps.length})`);
  const centers = gaps.map((g) => (g.startMs + g.endMs) / 2).sort((a, b) => a - b);
  assert(Math.abs(centers[0] - 141250) < 4000, `D1: cut 1 near 141.2s (got ${centers[0]})`);
  assert(Math.abs(centers[1] - 263750) < 4000, `D1: cut 2 near 263.7s (got ${centers[1]})`);
  assert(extent.startMs >= 18000 && extent.startMs <= 22000, `D1: lead-in trimmed (start ${extent.startMs})`);
  assert(extent.endMs >= 382000 && extent.endMs <= 386000, `D1: run-out trimmed (end ${extent.endMs})`);
}

// --- Case D2: edge penalty + duration cap — a long near-edge quiet patch does
// not outscore a shorter true interior gap ---
{
  const MUSIC = 0.0071;
  const GAP = 0.0011;
  const e = env([
    [8000, GAP], // quiet patch right after extent start (near-edge), long
    [4000, GAP], // total near-edge dip = 12s, but penalised + duration-capped
    [80000, MUSIC],
    [2500, GAP], // true interior gap, far from both edges
    [80000, MUSIC],
  ]);
  const { gaps } = detectGaps(e, HOP);
  const top = [...gaps].sort((a, b) => b.score - a.score)[0];
  const topCenter = (top.startMs + top.endMs) / 2;
  assert(topCenter > 80000, `D2: interior gap outscores near-edge quiet (top center ${topCenter})`);
}

// --- Case D3: no clear silence (beat-mixed) → no gaps ---
{
  const e = env([[600000, 0.3]]);
  const { gaps } = detectGaps(e, HOP);
  assert(gaps.length === 0, `D3: beat-mixed side yields no gaps (got ${gaps.length})`);
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun verify scripts/verify-splitter.ts`
Expected: FAIL — `detectGaps` is not exported yet (TypeError / import error), or the new asserts fail.

- [ ] **Step 3: Implement `detectGaps`**

In `src/lib/server/recording/splitter.ts`, change the `MIN_GAP_MS` constant and add the new constants. Replace:

```ts
/** A gap must persist at least this long to count as an inter-track gap. */
export const MIN_GAP_MS = 500;
```

with:

```ts
/** A merged gap must persist at least this long to count as an inter-track gap. */
export const MIN_GAP_MS = 700;
/** Moving-average window applied to the RMS envelope before gap logic. */
export const SMOOTH_MS = 800;
/** Gap threshold = THR_FRAC × median RMS (music-relative). */
export const THR_FRAC = 0.22;
/** Merge dips separated by less than this much above-threshold signal. */
export const MERGE_MS = 1500;
/** Cap on a gap's duration credit so a long quiet passage can't dominate. */
export const DUR_CAP_MS = 3000;
/** Gaps centred within this of an extent edge are demoted (intro/outro quiet). */
export const EDGE_MS = 30000;
/** Score multiplier for a near-edge gap. */
export const EDGE_PENALTY = 0.3;
/** Absolute safety floor for the threshold so a near-silent take can't divide by ~0. */
export const ABS_FLOOR = 0.0005;
```

Then add, **after** the `Gap` interface (after its closing `}` near the top), the result type, the smoothing helper, and `detectGaps`:

```ts
export interface DetectResult {
  extent: { startMs: number; endMs: number };
  gaps: Gap[];
}

/** Trailing moving average over the RMS envelope (window in ms). */
function smooth(rms: Float32Array, hopMs: number, windowMs: number): Float32Array {
  const w = Math.max(1, Math.round(windowMs / hopMs));
  const out = new Float32Array(rms.length);
  let sum = 0;
  for (let i = 0; i < rms.length; i++) {
    sum += rms[i];
    if (i >= w) sum -= rms[i - w];
    out[i] = sum / Math.min(i + 1, w);
  }
  return out;
}

/**
 * Adaptive, music-relative gap detection. Returns the audio extent (lead-in and
 * run-out trimmed at the gap threshold) plus scored candidate gaps strictly
 * inside it. A beat-mixed take (nothing dips below threshold) yields no gaps, so
 * the matcher reads it as one region.
 */
export function detectGaps(rms: Float32Array, hopMs: number): DetectResult {
  const fullEnd = rms.length * hopMs;
  if (rms.length === 0) return { extent: { startMs: 0, endMs: 0 }, gaps: [] };

  const sorted = Array.from(rms).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length * 0.5)] ?? 0;
  const thr = Math.max(median * THR_FRAC, ABS_FLOOR);

  const sm = smooth(rms, hopMs, SMOOTH_MS);
  let first = 0;
  let last = sm.length - 1;
  while (first < sm.length && sm[first] < thr) first++;
  while (last > first && sm[last] < thr) last--;
  if (first > last || first >= sm.length) {
    // No sustained signal above threshold → whole take is one region, no gaps.
    return { extent: { startMs: 0, endMs: fullEnd }, gaps: [] };
  }
  const extent = { startMs: first * hopMs, endMs: (last + 1) * hopMs };

  // Raw sustained dips of the SMOOTHED envelope, strictly inside the extent.
  type Raw = { startMs: number; endMs: number; sum: number; n: number };
  const raw: Raw[] = [];
  let runStart = -1;
  let sum = 0;
  let n = 0;
  for (let i = first; i <= last; i++) {
    if (sm[i] < thr) {
      if (runStart < 0) {
        runStart = i;
        sum = 0;
        n = 0;
      }
      sum += sm[i];
      n++;
    } else if (runStart >= 0) {
      raw.push({ startMs: runStart * hopMs, endMs: i * hopMs, sum, n });
      runStart = -1;
    }
  }
  if (runStart >= 0) raw.push({ startMs: runStart * hopMs, endMs: (last + 1) * hopMs, sum, n });

  // Merge dips separated by < MERGE_MS of signal.
  const merged: Raw[] = [];
  for (const g of raw) {
    const prev = merged[merged.length - 1];
    if (prev && g.startMs - prev.endMs < MERGE_MS) {
      prev.endMs = g.endMs;
      prev.sum += g.sum;
      prev.n += g.n;
    } else merged.push({ ...g });
  }

  // Score the merged dips that clear MIN_GAP_MS.
  const gaps: Gap[] = merged
    .filter((g) => g.endMs - g.startMs >= MIN_GAP_MS)
    .map((g) => {
      const durMs = g.endMs - g.startMs;
      const avg = g.sum / Math.max(g.n, 1);
      const depth = median / Math.max(avg, 1e-6);
      const center = (g.startMs + g.endMs) / 2;
      const nearEdge = center - extent.startMs < EDGE_MS || extent.endMs - center < EDGE_MS;
      const score = Math.min(durMs, DUR_CAP_MS) * depth * (nearEdge ? EDGE_PENALTY : 1);
      return { startMs: g.startMs, endMs: g.endMs, score };
    });

  return { extent, gaps };
}
```

Leave `noiseThreshold`, `findGaps`, and `audioExtent` in place for now (Task 2 removes them once the matcher stops using them).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun verify scripts/verify-splitter.ts`
Expected: PASS — all existing cases plus `D1`, `D2`, `D3`; final line `verify-splitter: all passed`.

- [ ] **Step 5: Type-check**

Run: `bun check`
Expected: 0 errors, 0 warnings.

- [ ] **Step 6: Commit**

```bash
git add src/lib/server/recording/splitter.ts scripts/verify-splitter.ts
git commit -m "feat(recording): adaptive music-relative gap detection (detectGaps)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `DetectResult`-based matcher + joint side assignment

Switch `proposeRegions` to consume a `DetectResult`, add `assignSidesJointly`, remove the now-dead splitter exports, and migrate `verify-splitter.ts`.

**Files:**
- Modify: `src/lib/server/recording/matcher.ts`
- Modify: `src/lib/server/recording/splitter.ts` (remove `noiseThreshold`/`findGaps`/`audioExtent`)
- Test: `scripts/verify-splitter.ts`

**Interfaces:**
- Consumes: `detectGaps`, `DetectResult`, `Gap`, `PAD_MS`, `SNAP_WINDOW_MS` from `./splitter`.
- Produces (matcher):
  - `proposeRegions(detect: DetectResult, candidateBlocks: ExpectedTrack[][]): TakeProposal` (signature change — no longer takes `rms, hopMs`).
  - `interface TakeDetect { takeId: string; detect: DetectResult }`
  - `interface PerTakeProposal { takeId: string; sideGuess: string | null; regions: Region[]; lowConfidence: boolean }`
  - `assignSidesJointly(takes: TakeDetect[], blocks: ExpectedTrack[][]): PerTakeProposal[]`

- [ ] **Step 1: Write the failing tests**

In `scripts/verify-splitter.ts`, change the imports to:

```ts
import { detectGaps, PAD_MS } from '../src/lib/server/recording/splitter';
import {
  proposeRegions,
  assignSidesJointly,
  type ExpectedTrack,
} from '../src/lib/server/recording/matcher';
```

Add this helper immediately after the `t(...)` helper definition (it adapts the existing envelope-based cases to the new `DetectResult` signature):

```ts
/** Run the per-take proposer on an envelope (durations/side via the blocks). */
const propose = (e: Float32Array, blocks: ExpectedTrack[][]) =>
  proposeRegions(detectGaps(e, HOP), blocks);
```

Now migrate the six existing `proposeRegions(e, HOP, [...])` call sites and the one `findGaps` call:

- In Case 1, replace `const gaps = findGaps(e, HOP);` with `const gaps = detectGaps(e, HOP).gaps;`.
- Replace every `proposeRegions(e, HOP, [expected])` with `propose(e, [expected])`.
- Replace `proposeRegions(e, HOP, [sideA, sideB])` with `propose(e, [sideA, sideB])`.

Then append these joint-assignment cases at the **end**, before the final `if (failures > 0)` line:

```ts
// --- Case J1: two takes, distinct sides — never both A ---
{
  const sideA: ExpectedTrack[] = [
    t('a1', 'A1', null, '1', 'A1'),
    t('a2', 'A2', null, '2', 'A2'),
    t('a3', 'A3', null, '3', 'A3'),
  ];
  const sideB: ExpectedTrack[] = [t('b1', 'B1', null, '4', 'B1'), t('b2', 'B2', null, '5', 'B2')];
  // take 0 has 2 interior gaps (3 tracks); take 1 has 1 interior gap (2 tracks).
  const e0 = env([
    [120000, 0.3],
    [2000, 0.004],
    [120000, 0.3],
    [2000, 0.004],
    [120000, 0.3],
  ]);
  const e1 = env([
    [180000, 0.3],
    [2000, 0.004],
    [200000, 0.3],
  ]);
  const out = assignSidesJointly(
    [
      { takeId: 'take-1', detect: detectGaps(e0, HOP) },
      { takeId: 'take-2', detect: detectGaps(e1, HOP) },
    ],
    [sideA, sideB],
  );
  assert(out[0].sideGuess === 'A', `J1: take-1 → A (got ${out[0].sideGuess})`);
  assert(out[1].sideGuess === 'B', `J1: take-2 → B (got ${out[1].sideGuess})`);
  assert(out[0].sideGuess !== out[1].sideGuess, 'J1: sides are distinct');
  assert(out.every((p) => !p.lowConfidence), 'J1: both confident (#takes == #sides)');
}

// --- Case J2: more takes than sides — extra take flagged low-confidence ---
{
  const sideA: ExpectedTrack[] = [t('a1', 'A1', null, '1', 'A1'), t('a2', 'A2', null, '2', 'A2')];
  const sideB: ExpectedTrack[] = [t('b1', 'B1', null, '3', 'B1'), t('b2', 'B2', null, '4', 'B2')];
  const e = env([
    [180000, 0.3],
    [2000, 0.004],
    [200000, 0.3],
  ]);
  const d = detectGaps(e, HOP);
  const out = assignSidesJointly(
    [
      { takeId: 'take-1', detect: d },
      { takeId: 'take-2', detect: d },
      { takeId: 'take-3', detect: d },
    ],
    [sideA, sideB],
  );
  assert(out.filter((p) => !p.lowConfidence).length === 2, 'J2: two takes assigned to the two sides');
  assert(out.filter((p) => p.lowConfidence).length === 1, 'J2: one extra take flagged low-confidence');
  const assigned = out.filter((p) => !p.lowConfidence).map((p) => p.sideGuess).sort();
  assert(assigned[0] === 'A' && assigned[1] === 'B', `J2: the two assigned sides are A and B (got ${assigned})`);
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun verify scripts/verify-splitter.ts`
Expected: FAIL — `assignSidesJointly` not exported and `proposeRegions` signature mismatch.

- [ ] **Step 3: Update `proposeRegions` and add joint assignment in `matcher.ts`**

Change the import line at the top of `src/lib/server/recording/matcher.ts`:

```ts
import { detectGaps, PAD_MS, SNAP_WINDOW_MS, type Gap, type DetectResult } from './splitter';
```

(`detectGaps` is imported for re-export convenience to callers; it is also used by the endpoint. `findGaps`/`audioExtent` are no longer imported.)

Replace the whole `proposeRegions` function (the `export function proposeRegions(...) { ... }` block) with:

```ts
/**
 * Propose regions for a single take against candidate side blocks, picking the
 * best-fitting block independently. Used at finalize for the provisional,
 * non-binding "another side?" summary; the binding choice is made jointly
 * across takes by assignSidesJointly.
 */
export function proposeRegions(
  detect: DetectResult,
  candidateBlocks: ExpectedTrack[][],
): TakeProposal {
  let best: { cost: number; proposal: TakeProposal } | null = null;
  for (const block of candidateBlocks) {
    if (block.length === 0) continue;
    const { cost, regions } = alignBlock(detect.extent, detect.gaps, block);
    if (!best || cost < best.cost) {
      best = { cost, proposal: { regions, sideGuess: block[0].side } };
    }
  }
  return (
    best?.proposal ?? {
      regions: [
        { startMs: detect.extent.startMs, endMs: detect.extent.endMs, trackId: null, confidence: 0 },
      ],
      sideGuess: null,
    }
  );
}

export interface TakeDetect {
  takeId: string;
  detect: DetectResult;
}

export interface PerTakeProposal {
  takeId: string;
  sideGuess: string | null;
  regions: Region[];
  /** True when this take could not be jointly assigned a distinct side. */
  lowConfidence: boolean;
}

/** ms; total costs within this of each other are treated as ties. */
const ORDER_EPS = 1;

/**
 * Assign takes to DISTINCT side blocks at minimum total alignment cost. A vinyl
 * side plays in order and each take is a distinct side, so two takes can't both
 * be side A. Recording order breaks near-ties (take i leans toward side i). When
 * there are more takes than sides, the strongest distinct set is assigned and
 * each extra take falls back to its best independent block, flagged low-confidence.
 */
export function assignSidesJointly(
  takes: TakeDetect[],
  blocks: ExpectedTrack[][],
): PerTakeProposal[] {
  const T = takes.length;
  const B = blocks.length;
  if (T === 0) return [];
  if (B === 0) {
    return takes.map((tk) => ({
      takeId: tk.takeId,
      sideGuess: null,
      regions: [
        { startMs: tk.detect.extent.startMs, endMs: tk.detect.extent.endMs, trackId: null, confidence: 0 },
      ],
      lowConfidence: true,
    }));
  }

  // Per (take, block): alignment cost + the regions that block would yield.
  const cost: number[][] = [];
  const regionsMat: Region[][][] = [];
  for (let i = 0; i < T; i++) {
    cost[i] = [];
    regionsMat[i] = [];
    for (let j = 0; j < B; j++) {
      const r = alignBlock(takes[i].detect.extent, takes[i].detect.gaps, blocks[j]);
      cost[i][j] = r.cost;
      regionsMat[i][j] = r.regions;
    }
  }

  const assign = bestAssignment(cost, T, B);

  return takes.map((tk, i) => {
    const j = assign[i];
    if (j >= 0) {
      return {
        takeId: tk.takeId,
        sideGuess: blocks[j][0].side,
        regions: regionsMat[i][j],
        lowConfidence: false,
      };
    }
    // Unassigned (more takes than sides) → best independent block, flagged.
    let bj = 0;
    for (let k = 1; k < B; k++) if (cost[i][k] < cost[i][bj]) bj = k;
    return {
      takeId: tk.takeId,
      sideGuess: blocks[bj][0].side,
      regions: regionsMat[i][bj],
      lowConfidence: true,
    };
  });
}

/**
 * Min-cost injective assignment of takes → distinct blocks. Returns assign[i] =
 * block index, or -1 when take i is left unassigned (only when #takes > #blocks).
 * Brute force over a tiny search (sides ≤ ~6). Lexicographic key: total cost,
 * then recording-order distance (sum |i − j|) as the tiebreak.
 */
function bestAssignment(cost: number[][], T: number, B: number): number[] {
  const need = Math.min(T, B);
  const cur = new Array<number>(T).fill(-1);
  const used = new Array<boolean>(B).fill(false);
  let best: { total: number; order: number; assign: number[] } | null = null;

  const consider = (total: number, order: number) => {
    if (
      !best ||
      total < best.total - ORDER_EPS ||
      (Math.abs(total - best.total) <= ORDER_EPS && order < best.order)
    ) {
      best = { total, order, assign: [...cur] };
    }
  };

  const rec = (i: number, assigned: number, total: number, order: number) => {
    if (i === T) {
      if (assigned === need) consider(total, order);
      return;
    }
    for (let j = 0; j < B; j++) {
      if (used[j]) continue;
      used[j] = true;
      cur[i] = j;
      rec(i + 1, assigned + 1, total + cost[i][j], order + Math.abs(i - j));
      used[j] = false;
      cur[i] = -1;
    }
    if (T > B) {
      cur[i] = -1;
      rec(i + 1, assigned, total, order);
    }
  };

  rec(0, 0, 0, 0);
  return best ? best.assign : new Array<number>(T).fill(-1);
}
```

(`alignBlock`, `snapBoundaries`, `padInto`, `spanRegion`, `durCost`, `snapConf` below are unchanged — `alignBlock` already takes `(extent, gaps, tracks)`.)

- [ ] **Step 4: Remove the dead splitter exports**

In `src/lib/server/recording/splitter.ts`, delete the three now-unused functions: `noiseThreshold` (the `export function noiseThreshold(...) { ... }` block and its preceding doc comment), `findGaps` (its block and doc comment), and `audioExtent` (its block and doc comment). Also remove the two constants that only those functions used — `NOISE_LOWEST_FRACTION` and `GAP_THRESHOLD_RATIO` (and their doc comments). Keep `Gap`, `DetectResult`, `detectGaps`, `smooth`, `MIN_GAP_MS`, `SMOOTH_MS`, `THR_FRAC`, `MERGE_MS`, `DUR_CAP_MS`, `EDGE_MS`, `EDGE_PENALTY`, `ABS_FLOOR`, `PAD_MS`, `SNAP_WINDOW_MS`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun verify scripts/verify-splitter.ts`
Expected: PASS — all migrated cases plus `J1`, `J2`; final line `verify-splitter: all passed`.

- [ ] **Step 6: Type-check**

Run: `bun check`
Expected: errors **only** in `finalize/+server.ts` (it still calls `proposeRegions(scan.rms, HOP_MS, blocks)` against the new signature). That file is fixed in Task 3 — do not fix it here. If `bun check` reports errors anywhere else, fix them now.

- [ ] **Step 7: Commit**

```bash
git add src/lib/server/recording/matcher.ts src/lib/server/recording/splitter.ts scripts/verify-splitter.ts
git commit -m "feat(recording): joint distinct side assignment; DetectResult-based matcher

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Store detect state on `TakeState`; finalize stores it + returns provisional

`finalize` runs per take (later takes don't exist yet), so it can only store this take's detect state and return a non-binding provisional fit.

**Files:**
- Modify: `src/lib/server/recording/session.ts` (TakeState fields)
- Modify: `src/routes/api/recordings/sessions/[id]/takes/[takeId]/finalize/+server.ts`

**Interfaces:**
- Consumes: `detectGaps`, `DetectResult` (splitter); `proposeRegions` (matcher); `TakeState` (session).
- Produces: `TakeState` gains `gaps?: Gap[]`, `extent?: { startMs: number; endMs: number }`, `durationMs?: number`. Finalize response shape is unchanged (`{ durationMs, sampleRate, peaks, regions, sideGuess }`).

- [ ] **Step 1: Add fields to `TakeState`**

In `src/lib/server/recording/session.ts`, change the imports at the top to also pull the gap types:

```ts
import type { ExpectedTrack } from './matcher';
import type { Gap } from './splitter';
```

Add the three optional fields to the `TakeState` interface (after `finalized: boolean;`):

```ts
export interface TakeState {
  id: string; // 'take-1', 'take-2', …
  path: string;
  sampleRate: number;
  channels: number;
  finalized: boolean;
  // Detection state stored at finalize, consumed by the joint /propose step.
  gaps?: Gap[];
  extent?: { startMs: number; endMs: number };
  durationMs?: number;
}
```

- [ ] **Step 2: Store detect state in finalize and use the new proposeRegions signature**

Replace the body of `src/routes/api/recordings/sessions/[id]/takes/[takeId]/finalize/+server.ts` between `const scan = scanWav(take.path, HOP_MS);` and the `// Downsample peaks` comment with:

```ts
  const scan = scanWav(take.path, HOP_MS);

  // Store this take's detect state for the joint /propose step at review time.
  const detect = detectGaps(scan.rms, HOP_MS);
  take.gaps = detect.gaps;
  take.extent = detect.extent;
  take.durationMs = Math.round(meta.durationMs);

  // Provisional, non-binding per-take fit for the "another side?" summary.
  const { blocks } = loadExpectedTracks(getDb(), session.releaseId);
  const proposal = proposeRegions(detect, blocks);
```

Update the imports at the top of that file: add `detectGaps` from the splitter, keep `proposeRegions`:

```ts
import { finalizeWav, readWavMeta, scanWav } from '$lib/server/recording/wav';
import { detectGaps } from '$lib/server/recording/matcher';
import { proposeRegions } from '$lib/server/recording/matcher';
```

Collapse those two matcher imports into one line:

```ts
import { proposeRegions } from '$lib/server/recording/matcher';
import { detectGaps } from '$lib/server/recording/splitter';
```

The `// Downsample peaks` block and the `return json({...})` below stay exactly as they are.

- [ ] **Step 3: Type-check**

Run: `bun check`
Expected: 0 errors. (The Task 2 finalize error is now resolved; the `propose` endpoint doesn't exist yet but nothing references it.)

- [ ] **Step 4: Commit**

```bash
git add src/lib/server/recording/session.ts "src/routes/api/recordings/sessions/[id]/takes/[takeId]/finalize/+server.ts"
git commit -m "feat(recording): store per-take detect state at finalize

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: `/propose` endpoint + `recorder.review()` runs joint assignment

The binding joint assignment runs once, at review time, over every stored take.

**Files:**
- Create: `src/routes/api/recordings/sessions/[id]/propose/+server.ts`
- Modify: `src/lib/stores/recorder.svelte.ts`
- Modify: `src/lib/components/RecordSession.svelte` (await review; minimal low-confidence note)

**Interfaces:**
- Consumes: `getSession`, `loadExpectedTracks` (session); `assignSidesJointly`, `TakeDetect`, `PerTakeProposal` (matcher).
- Produces: `POST /api/recordings/sessions/[id]/propose` → `{ takes: { takeId, sideGuess, regions, lowConfidence }[] }`. `TakeClient` gains `lowConfidence: boolean`. `recorder.review()` becomes `async`.

- [ ] **Step 1: Create the propose endpoint**

Create `src/routes/api/recordings/sessions/[id]/propose/+server.ts`:

```ts
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { getSession, loadExpectedTracks } from '$lib/server/recording/session';
import { assignSidesJointly, type TakeDetect } from '$lib/server/recording/matcher';

/**
 * Joint distinct side assignment across all of a session's takes. Run once at
 * review time (every take has been finalized, so its detect state is stored).
 */
export const POST: RequestHandler = async ({ params }) => {
  const session = getSession(params.id);
  if (!session) throw error(404, 'session not found');

  const takes: TakeDetect[] = session.takes
    .filter((t) => t.finalized && t.extent && t.gaps)
    .map((t) => ({ takeId: t.id, detect: { extent: t.extent!, gaps: t.gaps! } }));

  const { blocks } = loadExpectedTracks(getDb(), session.releaseId);
  const proposals = assignSidesJointly(takes, blocks);

  return json({ takes: proposals });
};
```

- [ ] **Step 2: Add `lowConfidence` to `TakeClient` and run propose in `review()`**

In `src/lib/stores/recorder.svelte.ts`, add the field to `TakeClient` (after `sideGuess`):

```ts
export interface TakeClient {
  takeId: string;
  durationMs: number;
  peaks: number[];
  regions: RegionClient[];
  sideGuess: string | null;
  lowConfidence: boolean;
}
```

In `stopTake`, where the new take object is pushed, add `lowConfidence: false,` (the provisional take is not yet jointly assessed) — insert it next to `sideGuess: data.sideGuess,`:

```ts
        sideGuess: data.sideGuess,
        lowConfidence: false,
```

Replace the `review()` method:

```ts
  review() {
    phase = 'reviewing';
    this.teardownAudio();
  },
```

with:

```ts
  async review() {
    if (!sessionId) return;
    phase = 'analyzing';
    const res = await fetch(`/api/recordings/sessions/${sessionId}/propose`, { method: 'POST' });
    if (res.ok) {
      const data = (await res.json()) as {
        takes: {
          takeId: string;
          sideGuess: string | null;
          lowConfidence: boolean;
          regions: { startMs: number; endMs: number; trackId: string | null; confidence: number }[];
        }[];
      };
      const byId = new Map(expected.map((t) => [t.trackId, t]));
      const proposalByTake = new Map(data.takes.map((p) => [p.takeId, p]));
      takes = takes.map((tk) => {
        const p = proposalByTake.get(tk.takeId);
        if (!p) return tk;
        return {
          ...tk,
          sideGuess: p.sideGuess,
          lowConfidence: p.lowConfidence,
          regions: p.regions.map((r) => ({
            ...r,
            title: r.trackId ? (byId.get(r.trackId)?.title ?? '') : '',
          })),
        };
      });
    } else {
      err = `propose failed (${res.status})`;
    }
    phase = 'reviewing';
    this.teardownAudio();
  },
```

- [ ] **Step 3: Make the review button await the async method + surface low-confidence**

In `src/lib/components/RecordSession.svelte`, change the review button handler so the promise isn't dropped:

```svelte
                  <button class="primary" onclick={() => void recorder.review()}>
```

Find where each take's `sideGuess` is rendered in the review/summary view and add a minimal inline flag when low-confidence. Locate the take heading that shows the side (search the file for `sideGuess`), and beside it add:

```svelte
{#if take.lowConfidence}<span class="low-conf" title="Could not confidently assign a distinct side — check this take">⚠ uncertain side</span>{/if}
```

Add a small style for it in the component's `<style>` block:

```css
  .low-conf {
    margin-left: 0.5rem;
    font-size: 0.75rem;
    color: var(--warn, #c47f17);
  }
```

(If `sideGuess` is not currently rendered per take in this component, render the flag next to the existing per-take heading in the reviewing phase. The exact markup depends on the current structure — match the surrounding rows; the requirement is only that a low-confidence take is visibly flagged. The richer reassign/delete affordance is Workstream B.)

- [ ] **Step 4: Type-check**

Run: `bun check`
Expected: 0 errors, 0 warnings.

- [ ] **Step 5: Manual smoke (no automated harness exists)**

This step has no unit test — the capture/review flow needs a browser and audio. Verify the wiring is internally consistent by re-reading the diff: `review()` POSTs `/propose`, maps `data.takes` back onto `takes[]` by `takeId`, and every `TakeClient` is constructed with `lowConfidence`. Confirm `bun check` is clean (Step 4). Note in the commit body that browser verification is pending the user's manual pass.

- [ ] **Step 6: Commit**

```bash
git add "src/routes/api/recordings/sessions/[id]/propose/+server.ts" src/lib/stores/recorder.svelte.ts src/lib/components/RecordSession.svelte
git commit -m "feat(recording): joint side assignment at review time via /propose

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Context doc, remove probe, final verification

**Files:**
- Modify: `docs/CONTEXT.md`
- Delete: `scripts/probe-detection.ts`

**Interfaces:** none (docs + cleanup).

- [ ] **Step 1: Update the Splitting bullet in `docs/CONTEXT.md`**

Replace the `- **Splitting (server-side)**: …` bullet (currently around line 235) with:

```markdown
- **Splitting (server-side)**: on finalize, `scanWav` builds an RMS envelope; `splitter.ts`'s `detectGaps` smooths it (~800 ms), derives a **music-relative** gap threshold (`THR_FRAC × median RMS`, floored at `ABS_FLOOR`) rather than an absolute noise floor, trims lead-in/run-out at that threshold to get the audio **extent**, then merges short dips and scores each candidate gap (`min(dur, DUR_CAP) × depth × edge-penalty`) — so quiet inter-track gaps register and a long run-out or quiet intro can't masquerade as a track boundary. `matcher.ts` aligns regions to the release's expected tracks (read locally from the `track` table + `discogsPosition` facet, grouped into side blocks): durations present → snap predicted boundaries to gaps; durations missing → count-constrained gap pick; beat-mixed/no gaps → single region for manual splitting. Each finalize stores the take's `{ gaps, extent, durationMs }` on its `TakeState` and returns a *provisional* per-take fit for the "another side?" summary. The **binding** side assignment is joint: at review time `POST …/propose` runs `assignSidesJointly`, a min-cost match of takes → **distinct** side blocks (recording-order tiebreak; more takes than sides → extras flagged low-confidence), so two takes never both become "side A." Each track is a region with independent in/out points (PAD_MS into the silence); inter-track silence, lead-in, run-out are trimmed.
```

- [ ] **Step 2: Add a divergence note**

Under the `## Notable divergences from the original plan` section in `docs/CONTEXT.md`, add a bullet:

```markdown
- **Vinyl detection rework (2026-06-22).** The original absolute noise-floor splitter mis-split a quiet 5-track EP (90% of side A became "track 1") and assigned both takes to side A. Replaced with an adaptive median-relative detector (`detectGaps`: smoothing + extent-trim + capped-duration/depth/edge-penalty scoring) and joint distinct side assignment moved to review time (`/propose` + `assignSidesJointly`). Spec: `docs/superpowers/specs/2026-06-18-vinyl-detection-design.md`; plan: `docs/superpowers/plans/2026-06-22-vinyl-detection.md`.
```

- [ ] **Step 3: Remove the throwaway probe**

```bash
git rm scripts/probe-detection.ts
```

- [ ] **Step 4: Full verification**

Run: `bun verify scripts/verify-splitter.ts`
Expected: PASS — `verify-splitter: all passed`.

Run: `bun check`
Expected: 0 errors, 0 warnings.

- [ ] **Step 5: Commit**

```bash
git add docs/CONTEXT.md
git commit -m "docs(recording): document adaptive detection + joint side assignment; drop probe

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review Notes

- **Spec coverage:** Part 1 adaptive splitter → Task 1 (`detectGaps`, all 8 constants, smoothing, extent-trim, merge, capped/depth/edge scoring, no-silence guard). Part 2 joint assignment → Task 2 (`assignSidesJointly`, distinct min-cost, recording-order tiebreak, `#takes > #sides` low-confidence fallback). Architecture (finalize stores state, propose at review) → Tasks 3–4. Verification cases (adaptive/extent, edge/cap, no-silence, joint, fallback, regression) → Tasks 1–2 in `verify-splitter.ts`. Context-doc impact → Task 5. Probe removal → Task 5.
- **Confidence for warn-dots:** derives from `Gap.score` via the matcher's existing `score / maxScore` normalization (count-constrained branch) and snap distance (snap branch) — unchanged, now fed by the new scores. No separate field needed.
- **Durations-present snap regression:** `alignBlock`/`snapBoundaries` are untouched and still consume `gaps`; Cases 1, 5, 6 in `verify-splitter.ts` exercise the snap path against `detectGaps` output (migrated via the `propose` helper).
- **Type consistency:** `DetectResult` defined in `splitter.ts`, imported by `matcher.ts`, `finalize`, and (via `TakeDetect`) the `propose` endpoint. `PerTakeProposal.lowConfidence` ↔ `TakeClient.lowConfidence` ↔ propose JSON ↔ RecordSession `take.lowConfidence` all named identically.
- **Scope guard (Workstream B):** the low-confidence surfacing in Task 4 is intentionally a minimal inline flag, not the reassign/delete editor — that's Workstream B.
