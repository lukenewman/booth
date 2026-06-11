// Verifies the hybrid splitter + matcher across the spec's cases:
// clean gaps + durations, missing durations (count-constrained), gapless,
// side choice, quiet-passage robustness, and region padding.
import { findGaps, PAD_MS } from '../src/lib/server/recording/splitter';
import { proposeRegions, type ExpectedTrack } from '../src/lib/server/recording/matcher';

let failures = 0;
const assert = (c: boolean, m: string) => {
  if (!c) {
    console.error('FAIL:', m);
    failures++;
  } else console.log('ok:', m);
};

const HOP = 50;
/** Build an envelope from [durationMs, level] segments. */
function env(segments: [number, number][]): Float32Array {
  const out: number[] = [];
  for (const [ms, level] of segments) for (let i = 0; i < ms / HOP; i++) out.push(level);
  return new Float32Array(out);
}
const t = (
  id: string,
  title: string,
  durationMs: number | null,
  pos: string,
  dpos: string | null,
): ExpectedTrack => ({
  trackId: id,
  title,
  durationMs,
  position: pos,
  discogsPosition: dpos,
  side: dpos?.match(/^([A-Za-z]+)/)?.[1]?.toUpperCase() ?? null,
});

// --- Case 1: clean gaps, durations present → snap, all confident ---
{
  const e = env([
    [1000, 0.004],
    [234000, 0.3],
    [2000, 0.004],
    [330000, 0.3],
    [2000, 0.004],
  ]);
  const gaps = findGaps(e, HOP);
  assert(gaps.length >= 1, `interior gap found (got ${gaps.length})`);
  const expected = [t('a1', 'Can You Feel It', 234000, '1', 'A1'), t('a2', 'Washing Machine', 330000, '2', 'A2')];
  const prop = proposeRegions(e, HOP, [expected]);
  const assigned = prop.regions.filter((r) => r.trackId);
  assert(assigned.length === 2, `2 assigned regions (got ${assigned.length})`);
  assert(assigned[0].trackId === 'a1' && assigned[1].trackId === 'a2', 'in-order assignment');
  assert(
    Math.abs(assigned[0].endMs - assigned[0].startMs - 234000) < 3000,
    `A1 duration within 3s (got ${assigned[0].endMs - assigned[0].startMs})`,
  );
  assert(assigned[0].startMs <= 1000, `lead-in trimmed (start ${assigned[0].startMs})`);
  assert(assigned.every((r) => r.confidence > 0.7), 'high confidence with duration snap');
  assert(prop.sideGuess === 'A', `side guess A (got ${prop.sideGuess})`);
}

// --- Case 2: durations missing → count-constrained gap pick ---
{
  const e = env([
    [500, 0.004],
    [180000, 0.3],
    [1500, 0.004],
    [240000, 0.3],
    [1000, 0.004],
    [200000, 0.3],
    [500, 0.004],
  ]);
  const expected = [t('b1', 'B1', null, '1', 'B1'), t('b2', 'B2', null, '2', 'B2'), t('b3', 'B3', null, '3', 'B3')];
  const prop = proposeRegions(e, HOP, [expected]);
  const assigned = prop.regions.filter((r) => r.trackId);
  assert(assigned.length === 3, `3 regions from 2 strongest gaps (got ${assigned.length})`);
  assert(assigned.every((r) => r.confidence <= 0.7), 'durations-missing flagged lower confidence');
}

// --- Case 3: gapless / beat-mixed, no durations → single region, low confidence ---
{
  const e = env([[600000, 0.3]]);
  const expected = [t('c1', 'C1', null, '1', null), t('c2', 'C2', null, '2', null)];
  const prop = proposeRegions(e, HOP, [expected]);
  assert(prop.regions.length === 1, `one region spanning the take (got ${prop.regions.length})`);
  assert(prop.regions[0].confidence < 0.3, 'flagged for manual splitting');
}

// --- Case 4: side choice — take matches side B block better than A ---
{
  const sideA = [t('a1', 'A1', 234000, '1', 'A1'), t('a2', 'A2', 330000, '2', 'A2')];
  const sideB = [t('b1', 'B1', 180000, '3', 'B1'), t('b2', 'B2', 200000, '4', 'B2')];
  const e = env([
    [500, 0.004],
    [180000, 0.3],
    [1500, 0.004],
    [200000, 0.3],
    [500, 0.004],
  ]);
  const prop = proposeRegions(e, HOP, [sideA, sideB]);
  const first = prop.regions.filter((r) => r.trackId)[0];
  assert(first?.trackId === 'b1', `side B chosen (got ${first?.trackId})`);
  assert(prop.sideGuess === 'B', `side guess B (got ${prop.sideGuess})`);
}

// --- Case 5: more gaps than needed (quiet passage) → duration snap survives ---
{
  // A1 = 3:54 total with a 600ms quiet dip 100s in, real 2s gap, A2 = 5:30.
  const e = env([
    [100000, 0.3],
    [600, 0.004],
    [133400, 0.3],
    [2000, 0.004],
    [330000, 0.3],
  ]);
  const expected = [t('a1', 'A1', 234000, '1', 'A1'), t('a2', 'A2', 330000, '2', 'A2')];
  const prop = proposeRegions(e, HOP, [expected]);
  const assigned = prop.regions.filter((r) => r.trackId);
  assert(assigned.length === 2, `quiet dip not chosen as boundary (got ${assigned.length})`);
  assert(
    Math.abs(assigned[0].endMs - 234000) < 4000,
    `boundary at the real gap (A1 ends ${assigned[0].endMs})`,
  );
}

// --- Case 6: padding — region edges extend into the gap by PAD_MS ---
{
  // music 10s, gap exactly 10000..12000, music 10s
  const e = env([
    [10000, 0.3],
    [2000, 0.004],
    [10000, 0.3],
  ]);
  const expected = [t('p1', 'P1', 10000, '1', 'A1'), t('p2', 'P2', 10000, '2', 'A2')];
  const prop = proposeRegions(e, HOP, [expected]);
  const [r1, r2] = prop.regions;
  assert(Math.abs(r1.endMs - (10000 + PAD_MS)) <= HOP, `r1 out-point padded into gap (got ${r1.endMs})`);
  assert(Math.abs(r2.startMs - (12000 - PAD_MS)) <= HOP, `r2 in-point padded into gap (got ${r2.startMs})`);
}

if (failures > 0) process.exit(1);
console.log('verify-splitter: all passed');
