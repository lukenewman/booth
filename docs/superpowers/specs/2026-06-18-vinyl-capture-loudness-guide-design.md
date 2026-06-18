# Vinyl capture loudness guide — design

> **Date:** 2026-06-18
> **Status:** Approved (brainstorm) — pending implementation plan
> **Scope:** Workstream **A** of the post-first-use vinyl-recording feedback. Workstreams B (faster review editor), C (smarter detection), D (save & resume) are separate specs.

## Motivation

First real use of vinyl recording produced a transfer that was ~15 dB too quiet, and the user had no way to tell until after spending ~40 minutes recording two sides. Inspecting the raw takes with Booth's own scanner confirmed it:

| Take | Duration | Peak | RMS |
|------|----------|------|-----|
| 1 | 18:33 | **−20.4 dBFS** | −38.7 dBFS |
| 2 | 14:14 | **−18.8 dBFS** | −38.1 dBFS |

A healthy vinyl transfer peaks around −6 to −3 dBFS. These never crossed −18.

**Root cause of the blind spot:** the preview meters are **linear-scaled** (`width: level*100%`). A −20 dBFS peak (linear ≈ 0.096) fills the bar to ~10% — it *looks* like signal is present, but it's actually very low. There is no notion of a target range, so "looks like something" reads as "fine."

This was also the upstream cause of the bad auto-split (a separate workstream): the quiet transfer pinned the silence threshold to its absolute floor, so only the run-out groove registered as silence. Getting capture level right is the highest-leverage fix.

## Goals

- Replace the linear meter with a **dB-scaled** meter so low levels are visually obvious.
- Show a **green "go" zone** so the user knows what "right" looks like.
- Add **peak-hold** so the user can provoke the loudest passage and read its maximum without staring.
- Add a **pre-record nudge** so a too-quiet (or clipping) input is flagged *before* committing to a long side.

## Non-goals (YAGNI)

- **No software gain / AGC.** Gain is a physical knob on the user's interface/preamp, in the analog domain before the ADC. `autoGainControl` stays `false`. Digital make-up gain is explicitly rejected: multiplying a −20 dBFS signal up also raises its noise floor and quantization noise — it cannot recover what the ADC didn't capture. The meter's job is to prompt the *physical* adjustment.
- **No per-record loudness presets** (e.g. separate targets for loud-cut 45s vs. home-listening LPs). The correct workflow is a single fixed digital target that the user hits by adjusting gain per record. The one real nuance — more headroom for highly dynamic material — is left to the user reading peak-hold, and can become an optional "extra headroom" toggle later if it proves necessary.
- **No LUFS / loudness-unit metering.** Peak dBFS is sufficient and intuitive for "loud enough but not clipping."
- **No meter ballistics tuning** beyond a simple non-decaying hold.

## Target zones (Safe profile)

Classification is on the **held peak** (worst-of-L/R), in dBFS:

| Range | Status | Colour | Meaning |
|-------|--------|--------|---------|
| `< −18` | `too-low` | red | Buried; turn gain up |
| `−18 … −12` | `low` | amber | Usable but quiet |
| `−12 … −6` | `good` | **green** | Aim here |
| `−6 … −1` | `hot` | amber | Lots of level, low headroom |
| `≥ −1` or clip flag | `clip` | red | Reduce gain |

(`clip` also latches off the existing `clipped` flag, which trips at linear ≥ 0.999.)

## Design

### 1. Pure loudness module — `src/lib/loudness.ts` (new)

Pure, dependency-free functions. **Located under `src/lib/` (not `src/lib/server/recording/`)** because the meter math runs in the browser (recorder store + RecordSession); server modules must never be imported into client code. Being pure, it is also directly runnable by a bun verify script.

```ts
export function toDbfs(linear: number): number;            // 0..1 → dBFS (−Infinity at 0)
export type LevelStatus = 'too-low' | 'low' | 'good' | 'hot' | 'clip';
export function classifyPeak(dbfs: number, clipped?: boolean): LevelStatus;
// Zone boundary constants exported for the meter to draw the green band.
export const GOOD_LO_DBFS = -12, GOOD_HI_DBFS = -6, LOW_DBFS = -18, HOT_DBFS = -1;
// Map a dBFS value to 0..1 meter position over a fixed floor (e.g. METER_FLOOR_DBFS = -60).
export function meterFraction(dbfs: number): number;
```

### 2. Recorder store — `src/lib/stores/recorder.svelte.ts`

- Add reactive **peak-hold** state `heldPeakL` / `heldPeakR` (linear). In `meterLoop`, update each as `max(held, level)`.
- **Reset** the held peaks: on entering `preview`, at the start of a take (`recordTake`), and via a new `resetPeakHold()` method exposed on the store.
- Non-decaying: the hold persists until reset, so a single loud transient is remembered.
- Expose getters `heldPeakL`, `heldPeakR`, and a derived `levelStatus` = `classifyPeak(toDbfs(max(heldPeakL, heldPeakR)), clipped)`.

### 3. Preview meter UI — `src/lib/components/RecordSession.svelte`

- Replace the linear fill with a **dB-scaled** fill: bar width = `meterFraction(toDbfs(level)) * 100%`.
- Render the **green target band** as a static overlay on the meter track spanning `meterFraction(GOOD_LO_DBFS)…meterFraction(GOOD_HI_DBFS)`.
- Render a **peak-hold marker** (thin line) per channel at `meterFraction(toDbfs(heldPeak))`, with a numeric dBFS readout.
- Replace the bare clip light with a single **status chip** driven by `levelStatus`: `TOO LOW` / `LOW` / `GOOD ✓` / `HOT` / `CLIP`, coloured per the table. This is the green light.
- Add a **Reset peak** button calling `recorder.resetPeakHold()`.
- Keep the existing sample-rate / bit-depth readout.

### 4. Pre-record nudge — `RecordSession.svelte`

- Intercept the "⏺ Record side N" action. If `levelStatus ∈ {too-low, low, clip}`, show a **soft, non-blocking** inline confirm in the preview area:
  > Input peaked at **−20 dBFS** (low). Turn up your interface gain, or record anyway?
  > **[Record anyway]** · **[Keep adjusting]**
- "Record anyway" proceeds to `recorder.recordTake()`; "Keep adjusting" dismisses and stays in preview. If `levelStatus ∈ {good, hot}`, recording starts immediately with no interstitial.
- The readout uses the held peak (the same number shown on the meter), so the warning and the meter never disagree.

## Real-world workflow this supports

1. Open the release's record-from-vinyl preview (live meters, no disk writes).
2. Start the turntable; drop the needle on actual program.
3. Play the loudest material; peak-hold captures the maximum.
4. Read the status light — too low → raise interface gain; clip → lower it. **Reset peak**, re-check until the loudest passages sit green.
5. Record the side from the top.

## Verification

- `scripts/verify-loudness.ts` (run `bun verify scripts/verify-loudness.ts`): asserts `toDbfs` at known values (1.0→0, 0.5→≈−6.02, 0.0→−Infinity, 0.096→≈−20.4 matching the captured take), `classifyPeak` at every zone boundary (including the `clipped` override), and `meterFraction` monotonicity/clamping.
- Meter rendering, peak-hold reset, status colours, and the nudge are verified manually in-browser (project has no UI test runner), ideally against the live input and/or by replaying the backed-up `_backup-box-aus-holz-007-*` takes through the interface.

## Affected files

- `src/lib/loudness.ts` — **new**, pure.
- `src/lib/stores/recorder.svelte.ts` — peak-hold state + reset + `levelStatus`.
- `src/lib/components/RecordSession.svelte` — dB meter, green band, peak-hold marker, status chip, reset button, pre-record nudge.
- `scripts/verify-loudness.ts` — **new**.

## Context-doc impact

`docs/CONTEXT.md` "Vinyl recording → Capture" currently says the preview shows "live input preview (L/R meters, clip light, sample-rate readout)". On implementation, update it to describe the dB-scaled meter, green target zone, peak-hold, status light, and pre-record level nudge.
