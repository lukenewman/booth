import { findGaps, audioExtent, PAD_MS, SNAP_WINDOW_MS, type Gap } from './splitter';

/**
 * Aligns detected audio regions to a release's expected tracks. Pure
 * functions — no fs/DB/$env. A vinyl side plays its tracks in order, so this
 * is contiguous in-order alignment, not free assignment.
 */

export interface ExpectedTrack {
  trackId: string;
  title: string;
  durationMs: number | null;
  position: string; // sequential "1","2",…
  discogsPosition: string | null; // "A1","B2",… (facet)
  side: string | null; // "A","B",… parsed from discogsPosition
}

export interface Region {
  startMs: number;
  endMs: number;
  trackId: string | null; // null = leftover / unassigned
  confidence: number; // 0..1
}

export interface TakeProposal {
  regions: Region[];
  sideGuess: string | null;
}

interface Boundary {
  /** Gap edges. For a duration-predicted boundary with no gap, start === end. */
  gapStart: number;
  gapEnd: number;
  confidence: number;
}

/**
 * Propose regions for a take against candidate track blocks (one block per
 * side; a single block when positions carry no side letters). Picks the
 * best-fitting block by alignment cost.
 */
export function proposeRegions(
  rms: Float32Array,
  hopMs: number,
  candidateBlocks: ExpectedTrack[][],
): TakeProposal {
  const gaps = findGaps(rms, hopMs);
  const extent = audioExtent(rms, hopMs);
  let best: { cost: number; proposal: TakeProposal } | null = null;
  for (const block of candidateBlocks) {
    if (block.length === 0) continue;
    const { cost, regions } = alignBlock(extent, gaps, block);
    if (!best || cost < best.cost) {
      best = { cost, proposal: { regions, sideGuess: block[0].side } };
    }
  }
  return (
    best?.proposal ?? {
      regions: [{ startMs: extent.startMs, endMs: extent.endMs, trackId: null, confidence: 0 }],
      sideGuess: null,
    }
  );
}

function alignBlock(
  extent: { startMs: number; endMs: number },
  gaps: Gap[],
  tracks: ExpectedTrack[],
): { cost: number; regions: Region[] } {
  const N = tracks.length;
  const takeMs = extent.endMs - extent.startMs;
  const interior = gaps.filter((g) => g.startMs > extent.startMs && g.endMs < extent.endMs);
  const haveDurations = tracks.every((t) => t.durationMs != null);

  if (N === 1) {
    const conf = tracks[0].durationMs != null ? snapConf(takeMs, tracks[0].durationMs) : 0.5;
    return {
      cost: durCost(takeMs, tracks[0].durationMs),
      regions: [spanRegion(extent, tracks[0].trackId, conf)],
    };
  }

  let boundaries: Boundary[];
  if (haveDurations) {
    boundaries = snapBoundaries(extent, interior, tracks);
  } else if (interior.length >= N - 1) {
    // Count-constrained: the N−1 strongest gaps, in time order. Lower confidence.
    const chosen = [...interior]
      .sort((a, b) => b.score - a.score)
      .slice(0, N - 1)
      .sort((a, b) => a.startMs - b.startMs);
    const maxScore = Math.max(...chosen.map((g) => g.score));
    boundaries = chosen.map((g) => ({
      gapStart: g.startMs,
      gapEnd: g.endMs,
      confidence: Math.min(0.7, 0.4 + 0.3 * (g.score / maxScore)),
    }));
  } else if (interior.length > 0) {
    // Fewer gaps than needed — use them all; the user adds the rest.
    boundaries = interior.map((g) => ({ gapStart: g.startMs, gapEnd: g.endMs, confidence: 0.3 }));
  } else {
    // Beat-mixed, nothing inferable → one region spanning the side.
    return {
      cost: Number.MAX_SAFE_INTEGER / 2,
      regions: [spanRegion(extent, tracks[0].trackId, 0.1)],
    };
  }

  const M = boundaries.length + 1;
  const regions: Region[] = [];
  let cost = 0;
  for (let i = 0; i < M; i++) {
    const leftB = i === 0 ? null : boundaries[i - 1];
    const rightB = i === M - 1 ? null : boundaries[i];
    const startMs = leftB ? padInto(leftB, 'after') : Math.max(0, extent.startMs - PAD_MS);
    const endMs = rightB ? padInto(rightB, 'before') : extent.endMs + PAD_MS;
    const leftConf = leftB ? leftB.confidence : 1;
    const rightConf = rightB ? rightB.confidence : 1;
    const track = tracks[i] ?? null;
    regions.push({
      startMs,
      endMs,
      trackId: track?.trackId ?? null,
      confidence: track ? Math.min(leftConf, rightConf) : 0,
    });
    if (track?.durationMs != null) cost += Math.abs(endMs - startMs - track.durationMs);
  }
  // Prefer blocks whose structure matches: penalize region/track count mismatch.
  cost += Math.abs(M - N) * 60000;
  if (haveDurations) {
    const expectedTotal = tracks.reduce((s, t) => s + (t.durationMs ?? 0), 0);
    cost += Math.abs(takeMs - expectedTotal);
  }
  return { cost, regions };
}

/** Duration-predicted boundaries, each snapped to the nearest gap in range. */
function snapBoundaries(
  extent: { startMs: number; endMs: number },
  gaps: Gap[],
  tracks: ExpectedTrack[],
): Boundary[] {
  const predicted: number[] = [];
  let acc = extent.startMs;
  for (let i = 0; i < tracks.length - 1; i++) {
    acc += tracks[i].durationMs ?? 0;
    predicted.push(acc);
  }
  return predicted.map((p) => {
    let bestGap: Gap | null = null;
    let bestDist = Infinity;
    for (const g of gaps) {
      const center = (g.startMs + g.endMs) / 2;
      const d = Math.abs(center - p);
      if (d < bestDist && d <= SNAP_WINDOW_MS) {
        bestDist = d;
        bestGap = g;
      }
    }
    if (bestGap) {
      return {
        gapStart: bestGap.startMs,
        gapEnd: bestGap.endMs,
        confidence: Math.max(0.75, 1 - bestDist / SNAP_WINDOW_MS),
      };
    }
    return { gapStart: p, gapEnd: p, confidence: 0.3 };
  });
}

/**
 * Region edge padded INTO the boundary's silence:
 *   'before' → a region ending at this boundary keeps PAD_MS of lead-out.
 *   'after'  → a region starting at this boundary keeps PAD_MS of lead-in.
 * For a no-gap predicted boundary (start === end) no padding is applied, so
 * adjacent regions meet exactly (gapless material).
 */
function padInto(b: Boundary, edge: 'before' | 'after'): number {
  const hasGap = b.gapEnd > b.gapStart;
  if (edge === 'before') return hasGap ? b.gapStart + PAD_MS : b.gapStart;
  return hasGap ? b.gapEnd - PAD_MS : b.gapEnd;
}

function spanRegion(extent: { startMs: number; endMs: number }, trackId: string, confidence: number): Region {
  return {
    startMs: Math.max(0, extent.startMs - PAD_MS),
    endMs: extent.endMs + PAD_MS,
    trackId,
    confidence,
  };
}

function durCost(actual: number, expected: number | null): number {
  return expected == null ? 0 : Math.abs(actual - expected);
}
function snapConf(actual: number, expected: number): number {
  return Math.max(0.3, Math.min(1, 1 - Math.abs(actual - expected) / Math.max(expected, 1)));
}
