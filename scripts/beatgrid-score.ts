/**
 * Scores candidate beat trackers against rekordbox's grids (BOO-88).
 *
 *   bun scripts/beatgrid-score.ts TRUTH.jsonl RESULTS.jsonl... [--worst N] [--dump DIR]
 *
 * Every rekordbox grid in the library is one fixed tempo pinned to a first
 * beat, and a fixed grid is all the players use. So each candidate's beat list
 * is first fitted to a fixed grid (tempo and phase, outliers dropped), and that
 * grid is what gets scored:
 *  - tempo: how far the fitted BPM is from rekordbox's, and octave errors
 *  - lock: the share of rekordbox's beats that land within 10 ms / 25 ms of the
 *    candidate grid across the whole track — the "does it stay on" number
 *  - downbeat: whether bar 1 falls on the same beat, when the tracker gives downbeats
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

interface Truth {
	id: string;
	label: string;
	path: string;
	bpm: number;
	boothBpm: number | null;
	beatsMs: number[];
	downbeatsMs: number[];
}
interface Result {
	id: string;
	beatsMs?: number[];
	downbeatsMs?: number[];
	seconds?: number;
	error?: string;
}

const files = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !['--worst', '--dump'].includes(all[i - 1]));
const dumpIdx = process.argv.indexOf('--dump');
/** Folder to write each tracker's calibrated per-track scores to, for digging into disagreements. */
const dumpDir = dumpIdx > 0 ? process.argv[dumpIdx + 1] : undefined;
const worstIdx = process.argv.indexOf('--worst');
const worst = worstIdx > 0 ? Number(process.argv[worstIdx + 1]) : 0;
const [truthPath, ...resultPaths] = files;
const jsonl = <T>(p: string): T[] =>
	readFileSync(p, 'utf8')
		.split('\n')
		.filter(Boolean)
		.map((l) => JSON.parse(l));
const truth = new Map(jsonl<Truth>(truthPath).map((t) => [t.id, t]));

interface Grid {
	periodMs: number;
	/** Time of the beat nearest zero; beat k is at offset + k·period. */
	offsetMs: number;
	inliers: number;
}

/**
 * The fixed grid that best explains a beat list. Searches tempo near the median
 * beat interval for the period whose phases agree most (the length of the mean
 * phase vector), which shrugs off skipped, doubled and stray beats, then refines
 * by least squares over the beats within a quarter beat of that grid.
 */
export function fitGrid(beats: number[]): Grid | null {
	if (beats.length < 8) return null;
	const ibis = beats.slice(1).map((b, i) => b - beats[i]).sort((a, b) => a - b);
	const median = ibis[Math.floor(ibis.length / 2)];
	let best = { r: -1, period: median, phase: 0 };
	for (let period = median * 0.95; period <= median * 1.05; period += 0.02) {
		let c = 0;
		let s = 0;
		for (const b of beats) {
			const th = (2 * Math.PI * b) / period;
			c += Math.cos(th);
			s += Math.sin(th);
		}
		const r = Math.hypot(c, s) / beats.length;
		if (r > best.r) best = { r, period, phase: Math.atan2(s, c) };
	}
	let period = best.period;
	let anchor = ((best.phase / (2 * Math.PI)) * period + period) % period;
	let used: number[] = [];
	for (let pass = 0; pass < 3; pass++) {
		const pts = beats
			.map((b) => ({ k: Math.round((b - anchor) / period), b }))
			.filter(({ k, b }) => Math.abs(b - (anchor + k * period)) < period / 4);
		if (pts.length < 8) return null;
		const n = pts.length;
		const mk = pts.reduce((s, p) => s + p.k, 0) / n;
		const mb = pts.reduce((s, p) => s + p.b, 0) / n;
		const sxy = pts.reduce((s, p) => s + (p.k - mk) * (p.b - mb), 0);
		const sxx = pts.reduce((s, p) => s + (p.k - mk) ** 2, 0);
		period = sxy / sxx;
		anchor = mb - mk * period;
		used = pts.map((p) => p.b);
	}
	const offset = ((anchor % period) + period) % period;
	return { periodMs: period, offsetMs: offset, inliers: used.length / beats.length };
}

const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(0)}%` : '–');
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);
const nearest = (g: Grid, t: number) => g.offsetMs + Math.round((t - g.offsetMs) / g.periodMs) * g.periodMs;

type TempoClass = 'exact' | 'close' | 'near' | 'octave' | 'wrong';
function tempoClass(est: number, ref: number): TempoClass {
	const d = Math.abs(est - ref);
	if (d < 0.02) return 'exact';
	if (d < 0.1) return 'close';
	if (d < 0.5) return 'near';
	if ([0.5, 2, 2 / 3, 1.5, 0.75, 4 / 3].some((m) => Math.abs((est * m) / ref - 1) < 0.01)) return 'octave';
	return 'wrong';
}

/** rekordbox snaps most grids to whole BPM (58% of the library); try the same when the fit is within 0.05 of one. */
const snap = (bpm: number) => (Math.abs(bpm - Math.round(bpm)) < 0.05 ? Math.round(bpm) : bpm);

interface Score {
	id: string;
	label: string;
	refBpm: number;
	estBpm: number | null;
	tempo: TempoClass | 'none';
	lock10: number;
	lock25: number;
	downbeat: boolean | null;
	/** Median signed gap from the candidate grid to rekordbox's beats: positive means rekordbox is later. */
	offsetMs: number;
	seconds: number;
}

const format = (t: Truth) => t.path.split('.').at(-1)!.toLowerCase();

function score(t: Truth, r: Result, snapTempo: boolean, shiftMs = 0): Score {
	const base = { id: t.id, label: t.label, refBpm: t.bpm, seconds: r.seconds ?? 0 };
	const fitted = r.beatsMs ? fitGrid(r.beatsMs) : null;
	if (!fitted) return { ...base, estBpm: null, tempo: 'none', lock10: 0, lock25: 0, downbeat: null, offsetMs: 0 };
	let g = fitted;
	if (snapTempo) {
		// Re-pin the snapped period through the middle of the fitted grid.
		const period = 60000 / snap(60000 / fitted.periodMs);
		const mid = nearest(fitted, t.beatsMs[Math.floor(t.beatsMs.length / 2)]);
		g = { ...fitted, periodMs: period, offsetMs: ((mid % period) + period) % period };
	}
	g = { ...g, offsetMs: g.offsetMs + shiftMs };
	const estBpm = 60000 / g.periodMs;
	const signed = t.beatsMs.map((b) => b - nearest(g, b));
	const err = signed.map(Math.abs);
	const lock = (ms: number) => err.filter((e) => e <= ms).length / err.length;
	let downbeat: boolean | null = null;
	if (r.downbeatsMs?.length && t.downbeatsMs.length && tempoClass(estBpm, t.bpm) !== 'wrong') {
		// Bar phase: which of the four beats the tracker's downbeats mostly sit on, against rekordbox's.
		const ref = t.beatsMs[0];
		const refPeriod = 60000 / t.bpm;
		const barOf = (ms: number) => ((Math.round((ms - ref) / refPeriod) % 4) + 4) % 4;
		const votes = [0, 0, 0, 0];
		for (const d of r.downbeatsMs) votes[barOf(d)]++;
		downbeat = votes.indexOf(Math.max(...votes)) === barOf(t.downbeatsMs[0]);
	}
	const offsetMs = median(signed);
	return { ...base, estBpm, tempo: tempoClass(estBpm, t.bpm), lock10: lock(10), lock25: lock(25), downbeat, offsetMs };
}


function report(name: string, scores: Score[], missing: number) {
	const n = scores.length;
	const c = (k: string) => scores.filter((s) => s.tempo === k).length;
	const locked = scores.filter((s) => s.lock25 >= 0.95).length;
	const tight = scores.filter((s) => s.lock10 >= 0.95).length;
	const db = scores.filter((s) => s.downbeat !== null);
	// Of the tracks with the right tempo, how many sit half a beat away from rekordbox's grid.
	const half = scores.filter((s) => (s.tempo === 'exact' || s.tempo === 'close') && Math.abs(Math.abs(s.offsetMs) - 30000 / s.refBpm) < 7500 / s.refBpm).length;
	console.log(
		[
			name.padEnd(28),
			String(n).padStart(4),
			pct(c('exact'), n).padStart(5),
			pct(c('exact') + c('close'), n).padStart(5),
			pct(c('exact') + c('close') + c('near'), n).padStart(5),
			pct(c('octave'), n).padStart(5),
			pct(c('wrong') + c('none'), n).padStart(5),
			pct(tight, n).padStart(6),
			pct(locked, n).padStart(6),
			pct(half, n).padStart(5),
			(db.length ? pct(db.filter((s) => s.downbeat).length, db.length) : '–').padStart(5),
			`${median(scores.map((s) => s.seconds)).toFixed(1)}s`.padStart(6),
			missing ? `  (${missing} failed)` : ''
		].join(' ')
	);
}

console.log(
	`${'tracker'.padEnd(28)} ${'n'.padStart(4)} ${'<.02'.padStart(5)} ${'<.1'.padStart(5)} ${'<.5'.padStart(5)} ${'oct'.padStart(5)} ${'bad'.padStart(5)} ${'lock10'.padStart(6)} ${'lock25'.padStart(6)} ${'half'.padStart(5)} ${'bar1'.padStart(5)} ${'time'.padStart(6)}`
);
console.log('  tempo columns: share of tracks with BPM within that of rekordbox; lockN: share of tracks where ≥95% of');
console.log("  rekordbox's beats are within N ms of the fitted grid; half: right tempo but half a beat off; bar1: downbeat on the same beat as rekordbox's\n");

// Baseline: booth's current global estimate, tempo only.
const booth = [...truth.values()].filter((t) => t.boothBpm);
report(
	'booth (current)',
	booth.map((t) => ({ id: t.id, label: t.label, refBpm: t.bpm, estBpm: t.boothBpm, tempo: tempoClass(t.boothBpm!, t.bpm), lock10: 0, lock25: 0, downbeat: null, offsetMs: 0, seconds: 0 })),
	truth.size - booth.length
);

for (const p of resultPaths) {
	const results = jsonl<Result>(p).filter((r) => truth.has(r.id));
	const ok = results.filter((r) => !r.error);
	const name = basename(p, '.jsonl');
	report(name, ok.map((r) => score(truth.get(r.id)!, r, false)), results.length - ok.length);
	const snapped = ok.map((r) => score(truth.get(r.id)!, r, true));
	report(`${name} +snap`, snapped, results.length - ok.length);
	// A fixed per-format offset between this decoder and rekordbox's, measured on
	// the tracks whose tempo is right (decoder priming, encoder delay).
	const shift = new Map<string, number>();
	for (const f of new Set(ok.map((r) => format(truth.get(r.id)!)))) {
		const offs = snapped.filter((s) => s.tempo === 'exact' && format(truth.get(s.id)!) === f).map((s) => s.offsetMs);
		shift.set(f, median(offs));
	}
	const cal = (r: Result, snapTempo: boolean) => score(truth.get(r.id)!, r, snapTempo, shift.get(format(truth.get(r.id)!)) ?? 0);
	report(`${name} +cal`, ok.map((r) => cal(r, false)), results.length - ok.length);
	const calibrated = ok.map((r) => cal(r, true));
	report(`${name} +snap+cal`, calibrated, results.length - ok.length);
	if (dumpDir) writeFileSync(join(dumpDir, `${name}.scores.jsonl`), calibrated.map((c) => JSON.stringify(c)).join('\n') + '\n');
	console.log(`    offsets: ${[...shift].map(([f, ms]) => `${f} ${ms.toFixed(1)} ms`).join(', ')}`);
	for (const scores of [calibrated]) {
		if (worst) {
			for (const s of [...scores].sort((a, b) => a.lock25 - b.lock25).slice(0, worst))
				console.log(`    ${(s.lock25 * 100).toFixed(0).padStart(3)}%  off ${s.offsetMs.toFixed(0).padStart(5)}  ref ${s.refBpm.toFixed(2)}  est ${s.estBpm?.toFixed(2) ?? '–'}  ${s.tempo.padEnd(6)} ${s.label}`);
		}
	}
}
