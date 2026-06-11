# Vinyl recording & track splitting — design spec

**Date:** 2026-06-10
**Status:** Approved

## Goal

Record a vinyl release from an audio interface directly into Booth, smartly split the per-side recordings into per-track audio, review and adjust the splits, and save the confirmed tracks as lossless local files that play through Booth's existing `Playable` streaming path.

## Decisions

| # | Decision |
|---|----------|
| 1 | Artifact: full-length lossless tracks — 24-bit stereo WAV, no compression, no encoder dependency |
| 2 | Capture: in-browser AudioWorklet → raw PCM streamed to server in chunks → server writes WAV. Browser DSP (echo cancellation, noise suppression, auto gain) disabled |
| 3 | Session structure: one recording (take) per side, with an "another side?" loop after each take. Scales from 7" singles to 2×LPs |
| 4 | The user never declares which side a take is — the matcher proposes track assignments from durations/count and the user confirms (handles unlabeled dubplates) |
| 5 | Splitter: hybrid — silence candidates + Discogs-duration alignment, count-constrained fallback when durations are missing, duration-predicted/manual fallback when no gaps exist |
| 6 | Each track is a **region** (independent in-point + out-point), not a shared cut — inter-track silence, lead-in, and run-out are trimmed from the saved files |
| 7 | Splitting runs per-take as soon as it finishes (split-as-you-go), not batched at session end |
| 8 | Analysis runs server-side; client receives downsampled peak data for waveform rendering |
| 9 | Storage: merge the `itunes` source into a renamed **`local`** source. Vinyl rips and Apple Music imports are two ingest paths of one source; origin inferred from file path |
| 10 | Ripped files attach to the **existing Discogs track entities** (the rows `hydrateDiscogsTracks` already creates) via `source_link` + `file_path` match_key — no new entities, no new playback code |

## Background facts (verified in code/DB)

- `hydrateDiscogsTracks.ts` already persists a track row per Discogs tracklist entry after every sync (697 Discogs-linked tracks in the live DB). Stored per track: `title`, `duration_ms` (NULL when Discogs omits it — common on white labels/dubplates), sequential `position` ("1", "2", …), and the vinyl position ("A1", "B2") in `source_facets.discogsPosition`. **CONTEXT.md is stale on this** (says Discogs is release-only); fix alongside this work.
- The `Playable` interface (`resolveTrackStream`) resolves streams by reading the `file_path` match_key; `/api/stream/[trackId]` already supports Range requests. Writing a `file_path` match_key is sufficient to make a ripped track playable.
- The matcher therefore needs **no Discogs API call at record time** — tracklist data is local. Exception: if a release has no hydrated tracks yet, trigger `hydrateDiscogsTracks` for it at session start.

## User flow

```
Release detail (Discogs-owned release) ─▶ [⏺ Record from vinyl]
        │
        ▼
  Capture session (full-pane, per release)
  1. Setup: device picker, negotiated sample-rate/bit-depth readout,
     LIVE input preview — L/R level meters with peak-hold + clip
     indicator, scrolling waveform. No disk writes in this state.
  2. ⏺ Record take → play a side → ⏹ Stop
  3. Take is split + matched immediately (split-as-you-go)
  4. "Another side?" → yes: back to 2 · no: proceed
        │
        ▼
  Review screen (hybrid: continuous waveform + synced track list)
  adjust regions · reassign · edit titles · preview audio
        │ Confirm & save
        ▼
  Trimmed 24-bit WAVs written · DB rows committed in one transaction
  Tracks play immediately in Booth (Local dot lit)
```

## Architecture

### Client

| Unit | Responsibility |
|------|----------------|
| `RecordSession.svelte` | Full-pane capture UI: setup/preview state, record/stop, take list, "another side?" loop |
| `ReviewSplits.svelte` | Review UI: waveform with draggable region handles, synced editable track rows, leftovers panel, confirm action |
| `recorder.svelte.ts` (runes store) | Session state machine: `idle → arming → recording → analyzing → reviewing → committing → done`. Holds takes, regions, assignments |
| `pcm-recorder.worklet.ts` (AudioWorklet) | Emits raw PCM frames off the audio thread during recording |

Capture details:

- `getUserMedia` with `echoCancellation: false, noiseSuppression: false, autoGainControl: false`, `deviceId` from an enumerated picker.
- AudioContext requested at the interface's native sample rate; the actual negotiated rate is displayed (if the browser forces a resample it is the only one in the chain, and it is surfaced, not hidden).
- Setup state runs the same stream through an analyser for meters/waveform — pure monitoring, no disk writes. Clip indicator latches red at 0 dBFS.
- During recording, PCM chunks are POSTed to the server as they arrive (a ~20-min side ≈ 350 MB never accumulates in browser memory). Clipping during a take is non-fatal: flagged live and in the post-take summary.

### Server

| Unit | Responsibility |
|------|----------------|
| `src/lib/server/recording/wav.ts` | Append PCM chunks to a growing WAV; finalize header on stop; extract a sample range (region) to a new trimmed WAV. 24-bit stereo |
| `src/lib/server/recording/splitter.ts` | Pure functions: WAV → RMS envelope → candidate gaps → regions. Testable with synthetic envelopes |
| `src/lib/server/recording/matcher.ts` | Pure functions: align regions to expected tracks (contiguous in-order DP). Testable |
| `src/lib/server/recording/session.ts` | Session lifecycle: temp dirs, take registry, commit transaction, cleanup |

API endpoints (shapes final at plan time):

- `POST /api/recordings/sessions` — create session for a release (triggers tracklist hydration if needed)
- `POST /api/recordings/sessions/[id]/takes` + chunk append + finalize — capture path
- take finalize response includes the split/match proposal + downsampled peaks
- `POST /api/recordings/sessions/[id]/commit` — write trimmed WAVs + DB rows
- `DELETE /api/recordings/sessions/[id]` — cancel + cleanup

## Splitter & matcher

**Inputs (all local):** the take WAV on disk; expected tracks for the release from SQLite — `title`, `duration_ms` (nullable), `discogsPosition` facet (side letter groups tracks per side; a take is matched against contiguous side blocks).

**Pipeline:**

1. **Envelope** — short-window RMS (~50 ms hops) over decoded PCM. No FFT.
2. **Candidate gaps** — runs where RMS stays below a noise floor for ≥ a minimum gap length. The floor is computed **relative to the take's own noise level** (vinyl surface noise never reaches digital silence). Min-gap length and floor ratio are named constants.
3. **Alignment** (in order of available signal):
   - **Durations present** → predict boundaries from cumulative durations, snap each to the nearest candidate gap within a search window. Snap distance → confidence score.
   - **Durations missing** → expected track count N constrains the pick: choose the N−1 strongest gaps (depth × length). Weak/ambiguous gaps flagged low-confidence.
   - **No usable gaps** (beat-mixed) → duration-predicted cuts, or a single region spanning the take when durations are also missing. Everything flagged for review. Never errors.
4. **Regions, not cuts** — each matched track gets an in-point and out-point at the envelope's rise/fall edges, padded by a small keep-margin (~150 ms) to protect soft attacks and fades. Inter-track silence, lead-in, and run-out fall outside all regions. On gapless material adjacent regions abut (out-point = next in-point) — the region model is a superset of single-cut.
5. **Matcher** — contiguous in-order alignment (vinyl plays in order), implemented as a small DP that tolerates merge/split disagreements between detected regions and expected tracks, minimizing total duration error. Output: `{ start, end, proposedTrackId, confidence }[]` + leftover (unassigned) regions + downsampled peak array.

## Review UI (hybrid)

- **Continuous waveform** per take with draggable handles: green in-points, red out-points, amber = low-confidence (check me). Grey spans = trimmed silence.
- **Synced track rows** below: vinyl position, editable title (pre-filled from Discogs), region duration vs. expected (`3:52 / 3:54`), confidence dot, ▶ region preview. Dragging a handle updates the row live; reassigning a row relabels the region.
- **Manual toolkit:** move handles; add a split (one region → two); merge (delete a boundary); reassign a region to a different track; trim first/last region ends; ignore-or-assign leftover clips (lead-in crackle, run-out).
- **Precision aids:** click-to-zoom around a boundary; numeric nudge (±10 ms steps, exact timecode shown); **seam preview** — plays the last ~1.5 s of one region into the first ~1.5 s of the next so cuts are checked by ear.
- **Confirm & save** commits every assigned region.

## Persistence

### `itunes` → `local` source merge

- Registry id renamed `itunes` → `local`; the Apple Music XML parser becomes one ingest path, vinyl ripping the second.
- Migration `006_local_source.sql` rewrites `source` columns in `source_link`, `source_facets`, `source_state`, `sync_run` from `itunes` to `local`.
- Origin inferred from the `file_path` match_key: under the Apple Music library → Apple import; under the recordings root → vinyl rip.
- SourceGrid keeps 4 dots; the `i` slot becomes `L` (Local).
- **Safety constraint:** the local source's `sync()` (Apple XML re-parse) must scope its delete-pass to **Apple-origin tracks only** — a re-sync must never delete vinyl rips, which are absent from the XML. The collate delete excludes tracks whose `file_path` is under the recordings root.

### Disk layout

Root: `BOOTH_RECORDINGS_PATH` env var, default `~/.booth/recordings`.

- Session temp: `<root>/.tmp/<sessionId>/take-N.wav` — removed on commit or cancel.
- Final: `<root>/<Artist> — <Album> [<catno>]/<position> <title>.wav`.

### Commit (per confirmed region)

1. Extract region samples from the take WAV → trimmed final WAV (written to temp, then moved into place).
2. Attach to the existing track entity assigned during review:
   - `source_link(source='local', entity_kind='track', external_id=<abs path>)`
   - `match_key(entity_kind='track', key_type='file_path', key_value=<abs path>)` — this alone makes the track streamable via the existing `Playable` path
   - `source_facets(source='local', { origin: 'vinyl', recordedAt, sampleRate, bitDepth, sourceDiscogsReleaseId, takeId })`
   - Backfill `track.duration_ms` when NULL (the rip establishes the real length).
3. All DB writes in one transaction; on failure, roll back and remove moved files. No half-saved releases.

## Error handling

| Case | Behavior |
|------|----------|
| No device / permission denied / device busy | Inline error; reuse the Scanner's retry+message pattern |
| Interface unplugged mid-take | Stop, preserve partial WAV, warn — partial take is still splittable |
| Disk full during capture | Abort take with explicit error; clean temp |
| Clipping | Non-fatal; live meter flag + post-take summary |
| Region count ≠ expected | DP alignment tolerates; surfaces as low-confidence add/merge suggestions |
| Beat-mixed + no durations | Single region spanning the side; user places all cuts manually. Never errors |
| Numeric positions (no side letters) | All tracks form one pool; assignment leans on duration + user confirmation |
| No hydrated tracklist | Trigger `hydrateDiscogsTracks` at session start; if Discogs has none, manual track-count entry |
| Track already ripped (existing local link or file) | Prompt: replace or cancel |
| Session cancel / server restart | Temp dir for the session removed; stale `.tmp` dirs swept on boot |

## Testing (`bun verify` convention)

- `verify-splitter.ts` — synthetic envelopes: clean gaps, count-constrained missing-duration case, gapless → single region, over/under-split tolerance, region in/out padding.
- `verify-wav.ts` — PCM→WAV→PCM round-trip sample-accurate; 24-bit header correct; region extraction returns the exact sample range.
- `verify-local-merge.ts` — migration rewrites itunes→local everywhere; origin classification by path; simulated Apple re-sync leaves vinyl-origin rows untouched.
- Manual: one real record end-to-end; `bun check` for types.

## Out of scope (v1)

- Ripping releases not in the Discogs collection
- FLAC or any transcoding (batch-transcode later if desired)
- Audio restoration: declick/depop, RIAA correction, normalization — capture is raw
- AcoustID/fingerprint identification
- Embedding tags in the WAV files (the DB carries all metadata)
- Editing a rip after commit (re-rip instead)
