/**
 * Fixed beat grids: one tempo and a phase, the only kind of grid in the
 * library's rekordbox analysis and all a CDJ uses. Built by fitting the beats a
 * tracker reports, so a missed or doubled beat doesn't bend the grid.
 */

export interface Grid {
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
	// Start from the most common beat interval, not the median: a tracker that
	// counts half the track at double time (it happens) drags the median off
	// both real intervals, and the search below would never reach the right one.
	const bins = new Map<number, number>();
	for (let i = 1; i < beats.length; i++) {
		const bin = Math.round((beats[i] - beats[i - 1]) / 10);
		for (const b of [bin - 1, bin, bin + 1]) bins.set(b, (bins.get(b) ?? 0) + (b === bin ? 2 : 1));
	}
	const mode = [...bins].reduce((a, b) => (b[1] > a[1] ? b : a))[0] * 10;
	let best = { r: -1, period: mode, phase: 0 };
	for (let period = mode * 0.94; period <= mode * 1.06; period += 0.02) {
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

/**
 * Which beat of four the bar starts on: the grid position (mod 4) that most of
 * the tracker's downbeats land on. 0 when there are no downbeats to go on.
 */
export function barPhase(grid: Grid, downbeatsMs: number[]): number {
	const votes = [0, 0, 0, 0];
	for (const d of downbeatsMs) {
		const k = Math.round((d - grid.offsetMs) / grid.periodMs);
		votes[((k % 4) + 4) % 4]++;
	}
	return votes.indexOf(Math.max(...votes));
}

/** rekordbox's tempo range, as the library's grids show it: 70 to just under 180 BPM. */
const MIN_BPM = 70;
const MAX_BPM = 180;

/**
 * Brings a grid into rekordbox's tempo range by doubling or halving it. When
 * halving, the tracker's downbeats choose which of each pair of beats stays.
 */
export function foldGrid(grid: Grid, downbeatsMs: number[]): Grid {
	let g = grid;
	while (60000 / g.periodMs < MIN_BPM) g = { ...g, periodMs: g.periodMs / 2 };
	while (60000 / g.periodMs >= MAX_BPM) {
		const period = g.periodMs * 2;
		const on = (offset: number) => downbeatsMs.filter((d) => Math.abs(d - offset - Math.round((d - offset) / period) * period) < period / 8).length;
		g = { ...g, periodMs: period, offsetMs: on(g.offsetMs + g.periodMs) > on(g.offsetMs) ? g.offsetMs + g.periodMs : g.offsetMs };
	}
	return g;
}

export interface GridBeat {
	/** 1–4, 1 being the downbeat. */
	beatInBar: number;
	tempoCenti: number;
	timeMs: number;
}

/**
 * The grid as rekordbox writes it: every beat from the first at or after zero
 * to the end of the track, tempo in hundredths of a BPM, times in whole ms.
 * `shiftMs` moves the grid onto rekordbox's time base (see rekordboxShiftMs).
 */
export function gridBeats(fitted: Grid, downbeatsMs: number[], durationMs: number, shiftMs = 0): GridBeat[] {
	const grid = foldGrid(fitted, downbeatsMs);
	const tempoCenti = Math.round(6_000_000 / grid.periodMs);
	const period = 6_000_000 / tempoCenti;
	const phase = barPhase(grid, downbeatsMs);
	// Pin the rounded tempo at mid-track, so rounding to 0.01 BPM drifts half as far at either end.
	const mid = Math.round((durationMs / 2 - grid.offsetMs) / grid.periodMs);
	const anchor = grid.offsetMs + mid * grid.periodMs + shiftMs;
	const out: GridBeat[] = [];
	for (let k = Math.ceil(-anchor / period); anchor + k * period < durationMs; k++) {
		const n = k + mid;
		out.push({ beatInBar: ((((n - phase) % 4) + 4) % 4) + 1, tempoCenti, timeMs: Math.round(anchor + k * period) });
	}
	return out;
}

/**
 * rekordbox's beat times run later than times in audio decoded by ffmpeg,
 * because ffmpeg drops the encoder delay a file declares (its start time:
 * 25 ms for a LAME MP3, 48 ms for AAC) and rekordbox evidently doesn't. The
 * rest is what was left over against rekordbox's grids on 300 tracks: about
 * 20 ms more for MP3, about none for AAC. Unmeasured formats get the start time alone.
 */
export function rekordboxShiftMs(path: string): number {
	const probe = Bun.spawnSync(['ffprobe', '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=start_time', '-of', 'csv=p=0', path]);
	const start = (Number(probe.stdout.toString().trim().replace(/,$/, '')) || 0) * 1000;
	const ext = path.split('.').at(-1)!.toLowerCase();
	return start + (ext === 'mp3' ? 19.6 : ext === 'm4a' || ext === 'aac' ? -1 : 0);
}
