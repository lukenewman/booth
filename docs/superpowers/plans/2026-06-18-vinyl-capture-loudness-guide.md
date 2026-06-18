# Vinyl Capture Loudness Guide Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the vinyl-capture preview a dB-scaled meter with a green target zone, peak-hold, a status light, and a non-blocking "level looks low" nudge before recording — so the user can't unknowingly capture a 40-minute side 15 dB too quiet.

**Architecture:** A pure `src/lib/loudness.ts` module (dBFS conversion + zone classification + meter scaling) is the single source of truth, importable by both the browser store and a bun verify script. The `recorder` store gains peak-hold state and a derived `levelStatus`. `RecordSession.svelte` swaps its linear meter for a dB-scaled one with a green band + peak-hold marker + status chip, and gates the record action behind a soft confirm when the held peak is low/clipping.

**Tech Stack:** SvelteKit 2 + Svelte 5 runes, TypeScript, Bun. No UI test runner — pure logic is covered by a `bun verify` script; store/UI changes are covered by `bun check` (types) + a manual browser checklist. Work directly on `main`, commit per task.

**Spec:** `docs/superpowers/specs/2026-06-18-vinyl-capture-loudness-guide-design.md`

---

### Task 1: Pure loudness module (`src/lib/loudness.ts`)

**Files:**
- Create: `src/lib/loudness.ts`
- Test: `scripts/verify-loudness.ts`

This module is pure (no DOM/`$env`/`$app`) so it runs both in the browser store and directly under bun. It lives in `src/lib/` (not `src/lib/server/`) because the meter math runs client-side — server modules must never be imported into client code.

- [ ] **Step 1: Write the failing verify script**

Create `scripts/verify-loudness.ts`:

```ts
// Verifies the pure dBFS metering helpers: linear→dBFS conversion, Safe-profile
// zone classification (incl. the clip-flag override), and meter scaling.
import {
  toDbfs,
  classifyPeak,
  meterFraction,
  METER_FLOOR_DBFS,
} from '../src/lib/loudness';

let failures = 0;
const assert = (c: boolean, m: string) => {
  if (!c) {
    console.error('FAIL:', m);
    failures++;
  } else console.log('ok:', m);
};
const near = (a: number, b: number, eps = 0.05) => Math.abs(a - b) <= eps;

// --- toDbfs ---
assert(toDbfs(1) === 0, 'toDbfs(1) = 0 dBFS');
assert(near(toDbfs(0.5), -6.02), 'toDbfs(0.5) ≈ -6.02 dBFS');
assert(toDbfs(0) === -Infinity, 'toDbfs(0) = -Infinity');
assert(near(toDbfs(0.0959), -20.4, 0.1), 'toDbfs(0.0959) ≈ -20.4 (the captured take-1 peak)');

// --- classifyPeak zone boundaries ---
assert(classifyPeak(-30) === 'too-low', '-30 → too-low');
assert(classifyPeak(-19) === 'too-low', '-19 → too-low');
assert(classifyPeak(-18) === 'low', '-18 → low (boundary)');
assert(classifyPeak(-13) === 'low', '-13 → low');
assert(classifyPeak(-12) === 'good', '-12 → good (boundary)');
assert(classifyPeak(-9) === 'good', '-9 → good');
assert(classifyPeak(-6) === 'good', '-6 → good (boundary)');
assert(classifyPeak(-5) === 'hot', '-5 → hot');
assert(classifyPeak(-2) === 'hot', '-2 → hot');
assert(classifyPeak(-1) === 'clip', '-1 → clip (boundary)');
assert(classifyPeak(0) === 'clip', '0 → clip');
assert(classifyPeak(-9, true) === 'clip', 'clipped flag overrides good → clip');

// --- meterFraction ---
assert(meterFraction(0) === 1, 'meterFraction(0) = 1');
assert(meterFraction(METER_FLOOR_DBFS) === 0, 'meterFraction(floor) = 0');
assert(meterFraction(-120) === 0, 'meterFraction below floor clamps to 0');
assert(near(meterFraction(-30), 0.5, 0.001), 'meterFraction(-30) = 0.5 over a -60 floor');
assert(meterFraction(-6) > meterFraction(-12), 'meterFraction is monotonic');

if (failures > 0) process.exit(1);
console.log('verify-loudness: all passed');
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `bun verify scripts/verify-loudness.ts`
Expected: FAIL — `Cannot find module '../src/lib/loudness'` (module not created yet).

- [ ] **Step 3: Implement the module**

Create `src/lib/loudness.ts`:

```ts
/**
 * Pure dBFS metering helpers for the vinyl-capture preview meter. No DOM,
 * $env, or $app deps — so this is importable from the browser recorder store
 * AND runnable directly by a bun verify script. Lives in $lib (not
 * $lib/server) because the meter runs client-side.
 */

export type LevelStatus = 'too-low' | 'low' | 'good' | 'hot' | 'clip';

/** Bottom of the meter scale; values at/below this map to position 0. */
export const METER_FLOOR_DBFS = -60;

// Safe-profile zone boundaries (dBFS), classified on the held peak.
export const LOW_DBFS = -18; // below this → too-low
export const GOOD_LO_DBFS = -12; // green band start
export const GOOD_HI_DBFS = -6; // green band end
export const HOT_DBFS = -1; // at/above this → clip

/** Linear amplitude (0..1) → dBFS. 0 maps to -Infinity. */
export function toDbfs(linear: number): number {
  if (linear <= 0) return -Infinity;
  return 20 * Math.log10(linear);
}

/** Classify a held-peak dBFS value into a meter status (Safe profile). */
export function classifyPeak(dbfs: number, clipped = false): LevelStatus {
  if (clipped || dbfs >= HOT_DBFS) return 'clip';
  if (dbfs < LOW_DBFS) return 'too-low';
  if (dbfs < GOOD_LO_DBFS) return 'low';
  if (dbfs <= GOOD_HI_DBFS) return 'good';
  return 'hot';
}

/** dBFS → 0..1 position along the meter (METER_FLOOR_DBFS..0 dBFS), clamped. */
export function meterFraction(dbfs: number): number {
  if (dbfs <= METER_FLOOR_DBFS) return 0;
  if (dbfs >= 0) return 1;
  return (dbfs - METER_FLOOR_DBFS) / -METER_FLOOR_DBFS;
}
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `bun verify scripts/verify-loudness.ts`
Expected: PASS — ends with `verify-loudness: all passed`.

- [ ] **Step 5: Type-check**

Run: `bun check`
Expected: `0 errors`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/loudness.ts scripts/verify-loudness.ts
git commit -m "feat(recording): pure dBFS loudness helpers + verify script

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Recorder store — peak-hold + levelStatus

**Files:**
- Modify: `src/lib/stores/recorder.svelte.ts`

Adds non-decaying peak-hold (reset on entering preview, on each take start, and on demand) and a derived `levelStatus` for the UI. No unit test (the store is bound to live `AudioContext`/`AnalyserNode`); verified by `bun check` + the manual checklist in Task 5.

- [ ] **Step 1: Import the loudness helpers**

At the top of `src/lib/stores/recorder.svelte.ts`, add after the file's opening doc comment (before `export type RecorderPhase`):

```ts
import { toDbfs, classifyPeak, type LevelStatus } from '$lib/loudness';
```

- [ ] **Step 2: Add peak-hold state**

Find (around line 45-49):

```ts
let levelL = $state(0);
let levelR = $state(0);
let clipped = $state(false);
```

Add immediately below the `levelR` line:

```ts
let heldPeakL = $state(0);
let heldPeakR = $state(0);
```

- [ ] **Step 3: Add a module-level reset helper**

Directly below the `meterLoop` function's closing brace (after the line `meterRaf = requestAnimationFrame(meterLoop);` and its closing `}`, around line 120), add:

```ts
function resetHold() {
  heldPeakL = 0;
  heldPeakR = 0;
}
```

- [ ] **Step 4: Accumulate the held peak in the meter loop**

In `meterLoop`, find:

```ts
    levelL = pl;
    levelR = pr;
    if (pl >= 0.999 || pr >= 0.999) clipped = true;
```

Replace with:

```ts
    levelL = pl;
    levelR = pr;
    if (pl > heldPeakL) heldPeakL = pl;
    if (pr > heldPeakR) heldPeakR = pr;
    if (pl >= 0.999 || pr >= 0.999) clipped = true;
```

- [ ] **Step 5: Reset the hold when preview starts**

In `start()`, find:

```ts
      clipped = false;
      phase = 'preview';
      meterLoop();
```

Replace with:

```ts
      clipped = false;
      resetHold();
      phase = 'preview';
      meterLoop();
```

- [ ] **Step 6: Reset the hold when a take starts**

In `recordTake()`, find:

```ts
    clipped = false;
    err = null;
```

Replace with:

```ts
    clipped = false;
    resetHold();
    err = null;
```

- [ ] **Step 7: Expose getters + resetPeakHold()**

In the `recorder` object, find the `clipped` getter:

```ts
  get clipped() {
    return clipped;
  },
```

Insert immediately after it:

```ts
  get heldPeakL() {
    return heldPeakL;
  },
  get heldPeakR() {
    return heldPeakR;
  },
  get levelStatus(): LevelStatus {
    return classifyPeak(toDbfs(Math.max(heldPeakL, heldPeakR)), clipped);
  },
  resetPeakHold() {
    resetHold();
  },
```

- [ ] **Step 8: Type-check**

Run: `bun check`
Expected: `0 errors`. (The new getters/method are referenced by the UI in Task 3; on their own they type-check cleanly.)

- [ ] **Step 9: Commit**

```bash
git add src/lib/stores/recorder.svelte.ts
git commit -m "feat(recording): peak-hold + levelStatus on the recorder store

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: dB-scaled preview meter UI

**Files:**
- Modify: `src/lib/components/RecordSession.svelte`

Replaces the linear meter fill with a dB-scaled one, overlays the green target band, draws a peak-hold marker per channel, swaps the bare clip light for a status chip, and adds a Reset-peak button. The per-channel numeric readout now shows the **held** peak (the number you set gain against).

- [ ] **Step 1: Import loudness helpers + add the status-label map**

In the `<script>` block of `RecordSession.svelte`, add to the imports (below `import ReviewSplits from './ReviewSplits.svelte';`):

```ts
import {
  toDbfs,
  meterFraction,
  GOOD_LO_DBFS,
  GOOD_HI_DBFS,
  type LevelStatus,
} from '$lib/loudness';
```

Then, after the `let started = $derived(...)` line, add:

```ts
const STATUS_LABEL: Record<LevelStatus, string> = {
  'too-low': 'TOO LOW',
  low: 'LOW',
  good: 'GOOD ✓',
  hot: 'HOT',
  clip: 'CLIP',
};
```

- [ ] **Step 2: Replace the meter markup**

Find the `<div class="meters">…</div>` block (currently lines ~232-245):

```svelte
          <div class="meters">
            <div class="meter">
              <span>L</span>
              <div class="bar"><div class="fill" style:width="{Math.min(100, recorder.levelL * 100)}%"></div></div>
              <span class="db">{db(recorder.levelL)}</span>
            </div>
            <div class="meter">
              <span>R</span>
              <div class="bar"><div class="fill" style:width="{Math.min(100, recorder.levelR * 100)}%"></div></div>
              <span class="db">{db(recorder.levelR)}</span>
            </div>
            <div class="cliplight" class:clipped={recorder.clipped}>{recorder.clipped ? 'CLIP' : 'no clip'}</div>
            <div class="rate">{recorder.sampleRate} Hz · 24-bit</div>
          </div>
```

Replace it with:

```svelte
          <div class="meters">
            <div class="meter">
              <span>L</span>
              <div class="bar">
                <div
                  class="zone"
                  style:left="{meterFraction(GOOD_LO_DBFS) * 100}%"
                  style:width="{(meterFraction(GOOD_HI_DBFS) - meterFraction(GOOD_LO_DBFS)) * 100}%"
                ></div>
                <div class="fill" style:width="{meterFraction(toDbfs(recorder.levelL)) * 100}%"></div>
                <div class="hold" style:left="{meterFraction(toDbfs(recorder.heldPeakL)) * 100}%"></div>
              </div>
              <span class="db">{db(recorder.heldPeakL)}</span>
            </div>
            <div class="meter">
              <span>R</span>
              <div class="bar">
                <div
                  class="zone"
                  style:left="{meterFraction(GOOD_LO_DBFS) * 100}%"
                  style:width="{(meterFraction(GOOD_HI_DBFS) - meterFraction(GOOD_LO_DBFS)) * 100}%"
                ></div>
                <div class="fill" style:width="{meterFraction(toDbfs(recorder.levelR)) * 100}%"></div>
                <div class="hold" style:left="{meterFraction(toDbfs(recorder.heldPeakR)) * 100}%"></div>
              </div>
              <span class="db">{db(recorder.heldPeakR)}</span>
            </div>
            <div class="status-row">
              <div class="status" data-status={recorder.levelStatus}>{STATUS_LABEL[recorder.levelStatus]}</div>
              <button class="reset-peak" type="button" onclick={() => recorder.resetPeakHold()}>Reset peak</button>
              <span class="rate">{recorder.sampleRate} Hz · 24-bit</span>
            </div>
          </div>
```

- [ ] **Step 3: Update the meter CSS**

Find the `.bar` and `.fill` rules (currently lines ~363-373):

```css
  .bar {
    flex: 1;
    height: 14px;
    background: #222;
    border-radius: 3px;
    overflow: hidden;
  }
  .fill {
    height: 100%;
    background: #2e7d32;
  }
```

Replace with:

```css
  .bar {
    position: relative;
    flex: 1;
    height: 14px;
    background: #222;
    border-radius: 3px;
    overflow: hidden;
  }
  .zone {
    position: absolute;
    top: 0;
    bottom: 0;
    background: rgba(46, 125, 50, 0.32);
    border-left: 1px solid rgba(46, 125, 50, 0.9);
    border-right: 1px solid rgba(46, 125, 50, 0.9);
  }
  .fill {
    position: absolute;
    left: 0;
    top: 0;
    height: 100%;
    background: #3a86ff;
  }
  .hold {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 2px;
    margin-left: -1px;
    background: #fff;
  }
```

Then find the `.cliplight` and `.cliplight.clipped` rules (currently lines ~380-388):

```css
  .cliplight {
    font-size: 11px;
    opacity: 0.6;
  }
  .cliplight.clipped {
    color: #e53935;
    opacity: 1;
    font-weight: 700;
  }
```

Replace them with:

```css
  .status-row {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .status {
    font-size: 11px;
    font-weight: 700;
    padding: 2px 8px;
    border-radius: 4px;
    letter-spacing: 0.03em;
  }
  .status[data-status='good'] {
    color: #fff;
    background: #2e7d32;
  }
  .status[data-status='low'],
  .status[data-status='hot'] {
    color: #1a1206;
    background: #e0a23c;
  }
  .status[data-status='too-low'],
  .status[data-status='clip'] {
    color: #fff;
    background: #c0392b;
  }
  .reset-peak {
    background: transparent;
    color: var(--text);
    border: 1px solid var(--border-strong);
    padding: 3px 8px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 11px;
  }
```

- [ ] **Step 4: Type-check**

Run: `bun check`
Expected: `0 errors`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/components/RecordSession.svelte
git commit -m "feat(recording): dB-scaled preview meter w/ green zone, peak-hold, status light

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Non-blocking pre-record nudge

**Files:**
- Modify: `src/lib/components/RecordSession.svelte`

When the held peak is low/too-low/clipping, clicking "⏺ Record side N" first shows a soft inline confirm instead of starting straight away. Green/hot starts immediately.

- [ ] **Step 1: Add the confirm state + handlers**

In the `<script>` block, after the `STATUS_LABEL` constant from Task 3, add:

```ts
let pendingLowConfirm = $state(false);

function tryRecord() {
  const s = recorder.levelStatus;
  if (s === 'too-low' || s === 'low' || s === 'clip') {
    pendingLowConfirm = true;
  } else {
    void recorder.recordTake();
  }
}
function recordAnyway() {
  pendingLowConfirm = false;
  void recorder.recordTake();
}
```

- [ ] **Step 2: Gate the record action behind the confirm**

Find the preview actions block (currently lines ~247-255):

```svelte
          {#if phase === 'preview'}
            <div class="actions">
              <button class="rec" onclick={() => recorder.recordTake()}>⏺ Record side {recorder.takes.length + 1}</button>
              {#if recorder.takes.length > 0}
                <button class="primary" onclick={() => recorder.review()}>
                  No more sides → review {recorder.takes.length} take{recorder.takes.length === 1 ? '' : 's'}
                </button>
              {/if}
            </div>
```

Replace with:

```svelte
          {#if phase === 'preview'}
            {#if pendingLowConfirm}
              <div class="low-confirm" role="alertdialog" aria-label="Input level looks low">
                <span>
                  Input peaked at {db(Math.max(recorder.heldPeakL, recorder.heldPeakR))}
                  ({STATUS_LABEL[recorder.levelStatus]}). Turn up your interface gain, or record anyway?
                </span>
                <button class="rec" onclick={recordAnyway}>Record anyway</button>
                <button class="ghost" onclick={() => (pendingLowConfirm = false)}>Keep adjusting</button>
              </div>
            {:else}
              <div class="actions">
                <button class="rec" onclick={tryRecord}>⏺ Record side {recorder.takes.length + 1}</button>
                {#if recorder.takes.length > 0}
                  <button class="primary" onclick={() => recorder.review()}>
                    No more sides → review {recorder.takes.length} take{recorder.takes.length === 1 ? '' : 's'}
                  </button>
                {/if}
              </div>
            {/if}
```

(The `{:else if phase === 'recording'}` branch immediately below this stays unchanged.)

- [ ] **Step 3: Add confirm styling**

In the `<style>` block, add after the `.reset-peak` rule from Task 3:

```css
  .low-confirm {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    padding: 10px 12px;
    border: 1px solid #5a4a1a;
    background: #241f12;
    border-radius: 6px;
    font-size: 13px;
    max-width: 560px;
  }
  .low-confirm .ghost {
    background: transparent;
    color: var(--text);
    border: 1px solid var(--border-strong);
    padding: 6px 12px;
    border-radius: 5px;
    cursor: pointer;
  }
```

- [ ] **Step 4: Type-check**

Run: `bun check`
Expected: `0 errors`.

- [ ] **Step 5: Manual browser verification**

Run `bun dev`, open a Discogs-linked release, click "⏺ Record from vinyl", and confirm:

1. With no input (silence), the meter sits near the floor and the status reads **TOO LOW** (red). Clicking "⏺ Record side 1" shows the soft confirm with both buttons; "Keep adjusting" dismisses it; "Record anyway" starts the take.
2. Feeding a healthy signal (or replaying the backed-up quiet take `~/.booth/recordings/_backup-box-aus-holz-007-*/take-1.wav` through the interface) moves the fill up the dB scale; the white peak-hold marker sticks at the loudest point; **Reset peak** clears it.
3. A signal whose held peak lands between the green band edges shows **GOOD ✓** (green) and "⏺ Record side N" starts immediately with no confirm.
4. Driving the input to clipping shows **CLIP** (red).

- [ ] **Step 6: Commit**

```bash
git add src/lib/components/RecordSession.svelte
git commit -m "feat(recording): non-blocking 'level looks low' pre-record nudge

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Update CONTEXT.md

**Files:**
- Modify: `docs/CONTEXT.md`

- [ ] **Step 1: Update the Capture bullet**

In `docs/CONTEXT.md`, under **### Vinyl recording**, find this text in the **Capture** bullet:

```
**Setup state** shows a live input preview (L/R meters, clip light, sample-rate readout) with no disk writes.
```

Replace with:

```
**Setup state** shows a live input preview with no disk writes: dB-scaled L/R meters over a −60→0 dBFS scale, a green target band (peak −12…−6 dBFS, the "Safe" profile in `src/lib/loudness.ts`), a non-decaying peak-hold marker + readout per channel (Reset-peak button), and a status light (TOO LOW / LOW / GOOD ✓ / HOT / CLIP) classified on the held peak. Clicking "⏺ Record side N" while the held peak is low/too-low/clipping shows a soft, non-blocking "level looks low — record anyway?" confirm so a too-quiet input is caught before a long side is captured. Gain itself is physical (interface/preamp); `autoGainControl` stays false and no software make-up gain is applied.
```

- [ ] **Step 2: Commit**

```bash
git add docs/CONTEXT.md
git commit -m "docs(recording): document the capture loudness guide in CONTEXT

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- dB-scaled meter → Task 3 (Steps 2-3, `meterFraction(toDbfs(...))` fill + CSS). ✓
- Green target band → Task 3 (`.zone` overlay at `GOOD_LO_DBFS…GOOD_HI_DBFS`). ✓
- Peak-hold (non-decaying, reset on preview/take-start/manual) → Task 2 (Steps 2-7) + Task 3 marker/readout. ✓
- Status light (TOO LOW/LOW/GOOD/HOT/CLIP) → Task 2 `levelStatus` + Task 3 `.status` chip. ✓
- Reset-peak button → Task 3 (Step 2 markup + `resetPeakHold`). ✓
- Pre-record non-blocking nudge → Task 4. ✓
- Pure module in `src/lib/loudness.ts` with `toDbfs`/`classifyPeak`/`meterFraction` + zone constants → Task 1. ✓
- Safe zones (−18/−12/−6/−1) → Task 1 constants, asserted in verify. ✓
- `verify-loudness.ts` (toDbfs known values incl. 0.0959≈−20.4, classify boundaries incl. clip override, meterFraction monotonic/clamped) → Task 1. ✓
- Non-goals (no AGC/software gain/presets/LUFS) → nothing in the plan adds them. ✓
- Context-doc impact → Task 5. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"; every code step shows full code; the only non-code verification is the manual browser checklist (Task 4 Step 5), which is concrete and matches the project's no-UI-test-runner norm. ✓

**Type consistency:** `LevelStatus`, `toDbfs`, `classifyPeak`, `meterFraction`, `METER_FLOOR_DBFS`, `GOOD_LO_DBFS`, `GOOD_HI_DBFS`, `HOT_DBFS` defined in Task 1 and used with identical names/signatures in Tasks 2-3. Store members `heldPeakL`/`heldPeakR`/`levelStatus`/`resetPeakHold` defined in Task 2 and consumed in Tasks 3-4. `STATUS_LABEL`/`pendingLowConfirm`/`tryRecord`/`recordAnyway` defined and used within Tasks 3-4. ✓
