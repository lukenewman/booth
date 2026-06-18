# Vinyl recording — smarter detection — design

> **Date:** 2026-06-18
> **Status:** Approved (brainstorm) — pending implementation plan
> **Scope:** Workstream **C** of the post-first-use vinyl-recording feedback. Two coupled fixes: an adaptive, music-relative silence threshold in the splitter, and joint side assignment across takes. Workstreams A (capture loudness guide, shipped), B (faster review editor), D (save & resume) are separate.

## Motivation

First real use auto-split a 5-track, 2-side EP badly: "90% of side A became track 1," and *both* takes were labelled "side A." Probing the two real takes (`~/.booth/recordings/_backup-box-aus-holz-007-*`) with Booth's own scanner pinned the root causes:

- **Absolute noise floor.** `splitter.noiseThreshold` bottomed out at its `0.0005` (−66 dBFS) floor. On a quiet transfer (peaks −20 dBFS, median RMS −43 dBFS) the *only* place RMS dropped below −66 dBFS was the run-out groove. Real inter-track gaps sit around −57 dBFS (surface noise only, but well above the dead-wax floor), so they never registered, and track 1 swallowed the side.
- **Independent per-take side choice.** `proposeRegions` picks the best-fitting side block per take with no cross-take constraint, so two takes both matched the 3-track "side A" block.

### Goal (decided)

**Good-enough auto-split + fast manual cleanup.** On a transfer this quiet the separation between an inter-track gap (~−57 dBFS) and a quiet musical passage (~−52 dBFS) is only ~5 dB, so perfect auto-split is unrealistic. Detection should reliably surface the *true* boundaries as strong candidates and place regions close; the manual review tools (Workstream B) cover the last mile.

## Empirical validation

A prototype of the recipe below (run offline against the two real takes; throwaway script, not committed) recovered the true structure:

| Take | Auto cuts | Tracks |
|------|-----------|--------|
| take-1 → side A | 5:57, 11:12 | 5:46 / 5:15 / 3:18 |
| take-2 → side B | 6:00 | 5:58 / 6:04 |

Lead-in dips and the (4-minute, take-1) run-out were correctly rejected. This is the design, validated on the exact record that failed.

## Part 1 — Adaptive splitter (`src/lib/server/recording/splitter.ts`)

Replace the absolute-floor logic with a music-relative pipeline. All thresholds are named, tunable constants.

1. **Smooth** the RMS envelope with an ~800 ms moving average (`SMOOTH_MS`) before any gap logic — stops brief intra-track dips from fragmenting a gap.
2. **Music level** = median of the (unsmoothed) RMS envelope — robust to the quiet tail.
3. **Gap threshold** = `THR_FRAC × median` (`THR_FRAC = 0.22`), floored at a tiny absolute safety minimum (`0.0005`) so a near-silent take can't divide-by-near-zero.
4. **Extent** = first/last hop of the *smoothed* envelope above the gap threshold. Everything below threshold at the edges is lead-in / run-out and is excluded. **This is the key fix** — it removes the long trailing/leading silence that previously dominated as a giant "gap."
5. **Candidate gaps**: maximal runs of the smoothed envelope below threshold, *strictly inside* the extent; **merge** runs separated by < `MERGE_MS` (1500 ms) of signal; keep merged gaps ≥ `MIN_GAP_MS` (700 ms).
6. **Score** each gap = `min(durationMs, DUR_CAP_MS) × depth × edgePenalty`, where:
   - `depth = median / avg-RMS-in-gap` (favours true dropouts over shallow quiet music),
   - `DUR_CAP_MS = 3000` caps duration credit so a long quiet passage can't dominate,
   - `edgePenalty = EDGE_PENALTY (0.3)` when the gap centre is within `EDGE_MS (30 s)` of an extent edge (demotes intro/outro quiet), else 1.
7. **Guards (kept):**
   - **No clear silence** (beat-mixed side / median too low) → return no gaps; the matcher yields one region spanning the extent.
   - **Durations present** → the existing snap-to-nearest-gap path still applies (predicted boundaries snap to the nearest strong candidate within `SNAP_WINDOW_MS`).

**Confidence** for the review warn-dots derives from a gap's score/depth (normalised against the take's strongest gap), so weak auto-cuts flag themselves.

### Tunable constants (starting values, validated)

`SMOOTH_MS = 800`, `THR_FRAC = 0.22`, `MIN_GAP_MS = 700`, `MERGE_MS = 1500`, `DUR_CAP_MS = 3000`, `EDGE_MS = 30000`, `EDGE_PENALTY = 0.3`. (`PAD_MS`, `SNAP_WINDOW_MS` unchanged.)

## Part 2 — Joint side assignment (`matcher.ts` + `session.ts` + API)

A vinyl side plays in order and each take is a distinct side, so takes should map to **distinct** sides jointly rather than each grabbing its best block.

- **Assignment:** minimum total alignment cost over assignments of takes → *distinct* side blocks, by brute force over permutations (sides ≤ ~6; trivial). Per-(take, block) cost reuses the existing `alignBlock` cost (duration-fit when durations exist, gap-count fit otherwise).
- **Tiebreaker:** recording order — take *i* leans toward side *i* when costs are close (you record A then B).
- **`#takes ≠ #sides`:**
  - fewer takes than sides → assign to the best-fitting distinct subset;
  - more takes than sides (a re-recorded side) → assign the strongest distinct set; each extra take falls back to its best independent block flagged low-confidence, for the user to reassign or delete in review.
- **Region building** per take uses its *assigned* block's track count: snap when durations exist, else pick the `N−1` strongest scored gaps (existing count-constrained branch).

### Where joint assignment runs (architecture)

Takes are recorded sequentially, so joint assignment can't happen at per-take finalize (later takes don't exist yet). Therefore:

- **`finalize` (per take)** scans the WAV and stores the take's **scored candidate gaps + extent + durationMs + peaks** on the in-memory `TakeState`. It returns `durationMs` + `peaks` for the live waveform, plus a *provisional* best-independent-fit `sideGuess`/region count for the "another side?" summary (non-binding).
- **A joint propose step at review time** (`recorder.review()` → `POST /api/recordings/sessions/[id]/propose`) reads every take's stored gaps/extent, runs joint distinct assignment against the release's side blocks, builds regions per take from the assigned block, and returns `[{ takeId, sideGuess, regions }]`. The client populates `takes[].sideGuess` / `takes[].regions` from this before showing `ReviewSplits`.

`session.loadExpectedTracks` already groups tracks into side blocks; the joint step consumes those blocks. `TakeState` gains `gaps`, `extent`, `durationMs` fields (populated at finalize).

## Components & boundaries

- `splitter.ts` — pure. New/changed: `noiseThreshold` → music-relative; `findGaps` → smoothed + merged + scored + extent-bounded; export a `detectGaps(rms, hopMs) → { extent, gaps }` so the matcher consumes one structured result. `audioExtent` folds into `detectGaps`.
- `matcher.ts` — pure. `proposeRegions(extent, gaps, block)` becomes the region-builder for a *chosen* block; new `assignSidesJointly(takes, blocks) → PerTakeProposal[]` does the distinct min-cost matching and calls the region-builder.
- `session.ts` — `TakeState` stores `gaps/extent/durationMs`; no behaviour change to sweeping.
- API — `finalize` stores gap state + returns provisional proposal; new `propose` endpoint returns the joint result.
- Client `recorder.svelte.ts` — `stopTake`/`finalize` store peaks+duration+provisional; `review()` awaits the joint propose and fills `takes[]`.

## Verification

The real takes are ~500 MB and machine-local, so they can't be the committed test. Extend `scripts/verify-splitter.ts` with **synthetic "quiet-transfer" envelopes** (built via its existing `env()` helper) that encode the learned structure, asserting:

- **Adaptive threshold / extent:** an envelope of `lead-in noise → 3 tracks at −43 dB separated by ~1.5 s −57 dB gaps → long −60 dB run-out` yields exactly 2 interior cuts at the gap centres; the run-out and lead-in are excluded from the extent.
- **Edge penalty / duration cap:** a long quiet intro does not outscore a short true inter-track gap.
- **No-silence guard:** a flat beat-mixed envelope yields one region.
- **Joint assignment:** two takes (a 3-track and a 2-track envelope) against blocks `[A(3), B(2)]` assign take→A and take→B (never both A); the `#takes > #sides` fallback flags the extra take low-confidence.
- **Durations present:** existing snap cases still pass (regression).

The throwaway real-take probe (`scripts/probe-detection.ts`) is a local dev aid only and is removed before this workstream is committed.

## Non-goals (YAGNI)

- No multi-feature / spectral dropout classifier (the median-relative threshold + depth scoring is enough for "good-enough").
- No per-genre threshold profiles.
- No change to the commit path, WAV format, or review UI (that's Workstream B).
- No persistence of takes across reloads (that's Workstream D).

## Context-doc impact

Update `docs/CONTEXT.md` **Vinyl recording → Splitting** to describe: the adaptive music-relative threshold (median-based, not absolute floor), smoothing + extent-trim that excludes lead-in/run-out, capped-duration + depth + edge-penalty scoring, and joint distinct side assignment at review time. Add a divergence note under "Notable divergences" referencing this spec.
