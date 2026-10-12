/**
 * Ground truth for booth's beat-grid work (BOO-88): every library file that
 * rekordbox has analysed, with rekordbox's beat grid, written as JSON lines.
 * Candidate beat trackers are scored against this by beatgrid-score.ts.
 *
 *   bun scripts/beatgrid-truth.ts --out FILE [--limit N] [--seed S]
 *
 * Matching is the same as the stick export: same file name, and a grid whose
 * last beat falls in the track's final 20 seconds.
 */
import { Database } from 'bun:sqlite';
import { existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { indexLocalAnalysis } from '../src/lib/server/cdj/anlz';

const arg = (name: string) => {
	const i = process.argv.indexOf(`--${name}`);
	return i > 0 ? process.argv[i + 1] : undefined;
};
const out = arg('out');
if (!out) throw new Error('usage: --out FILE [--limit N] [--seed S]');
const limit = Number(arg('limit') ?? Infinity);
const seed = Number(arg('seed') ?? 1);

const db = new Database(process.env.BOOTH_DB_PATH ?? join(homedir(), '.booth/booth.db'), { readonly: true });
const rows = db
	.query(
		`SELECT t.id, t.title, a.name AS artist, t.duration_ms, mk.key_value AS path,
		        (SELECT value FROM source_facets f WHERE f.entity_kind = 'track' AND f.entity_id = t.id AND f.key = 'bpmAnalyzed') AS booth_bpm
		   FROM track t
		   JOIN artist a ON a.id = t.artist_id
		   JOIN match_key mk ON mk.entity_kind = 'track' AND mk.entity_id = t.id AND mk.key_type = 'file_path'`
	)
	.all() as { id: string; title: string; artist: string; duration_ms: number | null; path: string; booth_bpm: string | null }[];

const analysis = indexLocalAnalysis();
const truth = [];
for (const r of rows) {
	if (!existsSync(r.path)) continue;
	const fits = (analysis.get(basename(r.path).normalize('NFC')) ?? []).filter((c) => {
		const last = c.grid?.beats.at(-1)?.timeMs;
		return last !== undefined && (r.duration_ms == null || (last <= r.duration_ms && last > r.duration_ms - 20_000));
	});
	if (fits.length !== 1) continue;
	const beats = fits[0].grid!.beats;
	if (beats.length < 16) continue;
	const tempos = new Set(beats.map((b) => b.tempoCenti));
	truth.push({
		id: r.id,
		label: `${r.artist} — ${r.title}`,
		path: r.path,
		durationMs: r.duration_ms,
		boothBpm: r.booth_bpm == null ? null : Number(JSON.parse(r.booth_bpm)),
		bpm: beats[0].tempoCenti / 100,
		/** rekordbox writes one tempo for a fixed grid; several mean a dynamic grid. */
		tempoChanges: tempos.size - 1,
		beatsMs: beats.map((b) => b.timeMs),
		downbeatsMs: beats.filter((b) => b.beatInBar === 1).map((b) => b.timeMs)
	});
}

// Deterministic shuffle so a --limit sample is spread across the library.
let s = seed;
const rand = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 2 ** 32);
for (let i = truth.length - 1; i > 0; i--) {
	const j = Math.floor(rand() * (i + 1));
	[truth[i], truth[j]] = [truth[j], truth[i]];
}
const picked = truth.slice(0, limit);
writeFileSync(out, picked.map((t) => JSON.stringify(t)).join('\n') + '\n');
const dynamic = truth.filter((t) => t.tempoChanges > 0).length;
console.log(`${truth.length} tracks with a rekordbox grid (${dynamic} dynamic); wrote ${picked.length} to ${out}`);
