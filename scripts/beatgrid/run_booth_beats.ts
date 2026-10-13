/**
 * Runs booth's own beat tracker (the ONNX port of beat_this) over a
 * beatgrid-truth.ts file, writing results in run_trackers.py's format so
 * beatgrid-score.ts can compare it with the Python reference.
 *
 *   bun scripts/beatgrid/run_booth_beats.ts TRUTH.jsonl OUT.jsonl [--model PATH] [--jobs N]
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BEAT_RATE, logMelSpectrogram, onnxBeatModel, pickBeats, trackLogits } from '../../src/lib/server/analysis/beats';
import { decodeWhole } from '../../src/lib/server/analysis/decode';

const [truthPath, outPath] = process.argv.slice(2);
const arg = (n: string) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : undefined);
const modelPath = arg('model') ?? join(homedir(), '.booth/models/beat_this-final0.onnx');
const jobs = Number(arg('jobs') ?? 6);
const truth = readFileSync(truthPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { id: string; path: string });
writeFileSync(outPath, '');
let next = 0;
let cpuMs = 0;
const t0 = performance.now();
const c0 = process.cpuUsage();
await Promise.all(
	Array.from({ length: jobs }, async () => {
		const model = await onnxBeatModel(modelPath);
		while (next < truth.length) {
			const t = truth[next++];
			const start = performance.now();
			try {
				const samples = await decodeWhole(t.path, BEAT_RATE);
				const { beats, downbeats } = pickBeats(await trackLogits(logMelSpectrogram(samples), model));
				const r = { id: t.id, beatsMs: beats.map((b) => Math.round(b * 10000) / 10), downbeatsMs: downbeats.map((b) => Math.round(b * 10000) / 10), seconds: Math.round(performance.now() - start) / 1000 };
				appendFileSync(outPath, JSON.stringify(r) + '\n');
			} catch (e) {
				appendFileSync(outPath, JSON.stringify({ id: t.id, error: String(e).slice(0, 200) }) + '\n');
			}
		}
	})
);
const c = process.cpuUsage(c0);
cpuMs = (c.user + c.system) / 1000;
console.log(`${truth.length} tracks in ${((performance.now() - t0) / 1000).toFixed(0)} s; ${(cpuMs / 1000 / truth.length).toFixed(1)} s of CPU per track in this process (ffmpeg not counted)`);
process.exit(0);
