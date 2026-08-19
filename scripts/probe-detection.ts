// TEMP diagnostic (not a verify script): instrument detection candidates on the
// real backed-up takes to design the adaptive splitter. Read-only; does not
// touch the real splitter/matcher. Removed before workstream C finishes.
import { scanWav } from '../src/lib/server/recording/wav';

const dir = `${process.env.HOME}/.booth/recordings/_backup-box-aus-holz-007-01KVE7RFRQHMTPN84Y7RQ18V5E`;
const HOP = 100;
const SMOOTH_MS = 800;
const THR_FRAC = 0.22; // gap threshold = THR_FRAC * median RMS
const EXTENT_FRAC = 0.22; // extent via the GAP threshold: trims lead-in AND run-out
const MIN_GAP_MS = 700;
const MERGE_MS = 1500; // merge dips separated by < this much signal
const DUR_CAP_MS = 3000;
const EDGE_MS = 30000; // dips within this of extent edges are penalised
const EDGE_PENALTY = 0.3;

const fmt = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;
const db = (x: number) => (x <= 1e-9 ? '-inf' : (20 * Math.log10(x)).toFixed(1));
const pct = (s: number[], p: number) => s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0;

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

const expectCuts: Record<string, number> = { 'take-1.wav': 2, 'take-2.wav': 1 };

for (const name of ['take-1.wav', 'take-2.wav']) {
  const scan = scanWav(`${dir}/${name}`, HOP);
  const rms = scan.rms;
  const sm = smooth(rms, HOP, SMOOTH_MS);
  const sorted = Array.from(rms).sort((a, b) => a - b);
  const median = pct(sorted, 0.5);
  const thr = median * THR_FRAC;
  const extentThr = median * EXTENT_FRAC;

  let first = 0;
  let last = sm.length - 1;
  while (first < sm.length && sm[first] < extentThr) first++;
  while (last > first && sm[last] < extentThr) last--;
  const extentStart = first * HOP;
  const extentEnd = (last + 1) * HOP;

  // Raw sustained dips inside the extent.
  type Gap = { startMs: number; endMs: number; sum: number; n: number };
  const raw: Gap[] = [];
  let start = -1;
  let sum = 0;
  let n = 0;
  for (let i = first; i <= last; i++) {
    if (sm[i] < thr) {
      if (start < 0) { start = i; sum = 0; n = 0; }
      sum += sm[i]; n++;
    } else if (start >= 0) {
      raw.push({ startMs: start * HOP, endMs: i * HOP, sum, n });
      start = -1;
    }
  }
  if (start >= 0) raw.push({ startMs: start * HOP, endMs: (last + 1) * HOP, sum, n });

  // Merge dips separated by < MERGE_MS.
  const merged: Gap[] = [];
  for (const g of raw) {
    const prev = merged[merged.length - 1];
    if (prev && g.startMs - prev.endMs < MERGE_MS) {
      prev.endMs = g.endMs; prev.sum += g.sum; prev.n += g.n;
    } else merged.push({ ...g });
  }

  // Score the merged dips that clear MIN_GAP_MS.
  const cands = merged
    .filter((g) => g.endMs - g.startMs >= MIN_GAP_MS)
    .map((g) => {
      const durMs = g.endMs - g.startMs;
      const avg = g.sum / Math.max(g.n, 1);
      const depth = median / Math.max(avg, 1e-6);
      const center = (g.startMs + g.endMs) / 2;
      const nearEdge = center - extentStart < EDGE_MS || extentEnd - center < EDGE_MS;
      const score = Math.min(durMs, DUR_CAP_MS) * depth * (nearEdge ? EDGE_PENALTY : 1);
      return { center, durMs, depthDb: 20 * Math.log10(depth), nearEdge, score };
    });

  const want = expectCuts[name];
  const chosen = [...cands].sort((a, b) => b.score - a.score).slice(0, want).sort((a, b) => a.center - b.center);

  console.log(`\n===== ${name}  ${fmt(scan.durationMs)} =====`);
  console.log(`median=${db(median)}dB thr=${db(thr)}dB extentThr=${db(extentThr)}dB extent=${fmt(extentStart)}..${fmt(extentEnd)}`);
  console.log('candidates (by score):');
  for (const c of [...cands].sort((a, b) => b.score - a.score)) {
    console.log(`   ${fmt(c.center)}  dur=${(c.durMs / 1000).toFixed(1)}s  depth=${c.depthDb.toFixed(1)}dB${c.nearEdge ? '  [edge]' : ''}  score=${c.score.toFixed(0)}`);
  }
  console.log(`CHOSEN ${want}: ${chosen.map((g) => fmt(g.center)).join('  ,  ')}`);
}
