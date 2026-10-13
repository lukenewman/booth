/**
 * Beat and downbeat tracking with Beat This! (Foscarin, Schlüter & Widmer,
 * ISMIR 2024; github.com/CPJKU/beat_this, MIT), a small transformer exported to
 * ONNX and run natively by onnxruntime. Measured against rekordbox's grids it
 * was the clear winner of the trackers tried (docs/CONTEXT.md, "Beat grids").
 *
 * This is a port of its inference path, so the numbers match the Python
 * reference: a 128-band log-mel spectrogram at 50 frames a second, 30-second
 * chunks overlapping by 6 frames, then local-maximum peak picking on the
 * model's beat and downbeat logits.
 */
import { Fft } from './fft';

export const BEAT_RATE = 22050;
const N_FFT = 1024;
const HOP = 441;
const N_MELS = 128;
const F_MIN = 30;
const F_MAX = 11000;
export const BEAT_FPS = BEAT_RATE / HOP;
const CHUNK = 1500;
const BORDER = 6;

// torchaudio's slaney mel scale.
const F_SP = 200 / 3;
const MIN_LOG_HZ = 1000;
const MIN_LOG_MEL = MIN_LOG_HZ / F_SP;
const LOGSTEP = Math.log(6.4) / 27;
const hzToMel = (f: number) => (f >= MIN_LOG_HZ ? MIN_LOG_MEL + Math.log(f / MIN_LOG_HZ) / LOGSTEP : f / F_SP);
const melToHz = (m: number) => (m >= MIN_LOG_MEL ? MIN_LOG_HZ * Math.exp(LOGSTEP * (m - MIN_LOG_MEL)) : m * F_SP);

/** Triangular filters, `[mel][bin]`, as torchaudio's melscale_fbanks builds them (no area normalisation). */
function melFilters(): Float32Array[] {
	const nBins = N_FFT / 2 + 1;
	const nyquist = Math.floor(BEAT_RATE / 2);
	const freqs = Array.from({ length: nBins }, (_, i) => (nyquist * i) / (nBins - 1));
	const mMin = hzToMel(F_MIN);
	const mMax = hzToMel(F_MAX);
	const pts = Array.from({ length: N_MELS + 2 }, (_, i) => melToHz(mMin + ((mMax - mMin) * i) / (N_MELS + 1)));
	return Array.from({ length: N_MELS }, (_, m) => {
		const row = new Float32Array(nBins);
		for (let k = 0; k < nBins; k++) {
			const down = (freqs[k] - pts[m]) / (pts[m + 1] - pts[m]);
			const up = (pts[m + 2] - freqs[k]) / (pts[m + 2] - pts[m + 1]);
			row[k] = Math.max(0, Math.min(down, up));
		}
		return row;
	});
}

/**
 * log(1 + 1000·mel) of the magnitude spectrum, `frames × 128`, row-major. Hann
 * window, frames centred with reflect padding, magnitudes divided by √n_fft
 * (torchaudio's `normalized="frame_length"`, which is torch.stft's frame-length
 * normalisation, not the window's norm), all as beat_this's front end does.
 */
export function logMelSpectrogram(samples: Float32Array): { data: Float32Array; frames: number } {
	const half = N_FFT / 2;
	const n = samples.length;
	const frames = 1 + Math.floor(n / HOP);
	const window = new Float64Array(N_FFT);
	for (let i = 0; i < N_FFT; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT);
	const norm = Math.sqrt(N_FFT);
	const at = (i: number) => {
		// Reflect padding (no edge repeat), as torch.stft's center=True uses.
		if (i < 0) i = -i;
		if (i >= n) i = 2 * (n - 1) - i;
		return samples[Math.min(Math.max(i, 0), n - 1)];
	};
	const filters = melFilters();
	const fft = new Fft(N_FFT);
	const re = new Float64Array(N_FFT);
	const im = new Float64Array(N_FFT);
	const mag = new Float64Array(half + 1);
	const out = new Float32Array(frames * N_MELS);
	for (let f = 0; f < frames; f++) {
		const start = f * HOP - half;
		for (let i = 0; i < N_FFT; i++) {
			re[i] = at(start + i) * window[i];
			im[i] = 0;
		}
		fft.transform(re, im);
		for (let k = 0; k <= half; k++) mag[k] = Math.hypot(re[k], im[k]) / norm;
		for (let m = 0; m < N_MELS; m++) {
			const w = filters[m];
			let s = 0;
			for (let k = 0; k <= half; k++) if (w[k]) s += w[k] * mag[k];
			out[f * N_MELS + m] = Math.log1p(1000 * s);
		}
	}
	return { data: out, frames };
}

/** Anything that runs the network on one `1 × T × 128` chunk and returns `T` beat and downbeat logits. */
export type BeatModel = (spect: Float32Array, frames: number) => Promise<{ beat: Float32Array; downbeat: Float32Array }>;

/**
 * Model logits for a whole track. Chunks of 1500 frames overlap by the 6-frame
 * border the model was not trained to predict; the first chunk to cover a frame wins.
 */
export async function trackLogits(spect: { data: Float32Array; frames: number }, model: BeatModel) {
	const T = spect.frames;
	const starts: number[] = [];
	for (let s = -BORDER; s < T - BORDER; s += CHUNK - 2 * BORDER) starts.push(s);
	if (T > CHUNK - 2 * BORDER) starts[starts.length - 1] = T - (CHUNK - BORDER);
	const beat = new Float32Array(T).fill(-1000);
	const downbeat = new Float32Array(T).fill(-1000);
	const written = new Uint8Array(T);
	for (const start of starts) {
		const from = Math.max(start, 0);
		const to = Math.min(start + CHUNK, T);
		const left = Math.max(0, -start);
		const right = Math.max(0, Math.min(BORDER, start + CHUNK - T));
		const len = left + (to - from) + right;
		const chunk = new Float32Array(len * N_MELS);
		chunk.set(spect.data.subarray(from * N_MELS, to * N_MELS), left * N_MELS);
		const p = await model(chunk, len);
		for (let i = BORDER; i < len - BORDER; i++) {
			const t = start + i;
			if (t < 0 || t >= T || written[t]) continue;
			beat[t] = p.beat[i];
			downbeat[t] = p.downbeat[i];
			written[t] = 1;
		}
	}
	return { beat, downbeat };
}

/** Frames that are the maximum within ±3 frames (±60 ms) and above even odds; adjacent ones merged to their mean. */
function peaks(logits: Float32Array): number[] {
	const out: number[] = [];
	for (let t = 0; t < logits.length; t++) {
		if (logits[t] <= 0) continue;
		let max = -Infinity;
		for (let j = Math.max(0, t - 3); j <= Math.min(logits.length - 1, t + 3); j++) max = Math.max(max, logits[j]);
		if (logits[t] === max) out.push(t);
	}
	const merged: number[] = [];
	let p = out[0];
	let c = 1;
	for (let i = 1; i < out.length; i++) {
		if (out[i] - p <= 1) {
			c++;
			p += (out[i] - p) / c;
		} else {
			merged.push(p);
			p = out[i];
			c = 1;
		}
	}
	if (out.length) merged.push(p);
	return merged;
}

/** Beat and downbeat times in seconds; each downbeat moved onto its nearest beat. */
export function pickBeats(logits: { beat: Float32Array; downbeat: Float32Array }): { beats: number[]; downbeats: number[] } {
	const beats = peaks(logits.beat).map((f) => f / BEAT_FPS);
	const downs = peaks(logits.downbeat).map((f) => f / BEAT_FPS);
	if (!beats.length) return { beats, downbeats: [] };
	const snapped = downs.map((d) => beats.reduce((best, b) => (Math.abs(b - d) < Math.abs(best - d) ? b : best)));
	return { beats, downbeats: [...new Set(snapped)].sort((a, b) => a - b) };
}

/**
 * An onnxruntime session for the exported model, one thread: tracks are
 * analysed in parallel instead, and one thread does the most work per joule.
 *
 * A session holds about 1.6 GB once it has run a 30-second chunk (attention
 * over 1,500 frames) and onnxruntime doesn't hand it back, so analysis belongs
 * in a process that exits when the batch is done. Bun also crashes tearing
 * onnxruntime down at exit, so that process should end with process.exit().
 */
export async function onnxBeatModel(modelPath: string): Promise<BeatModel> {
	const ort = await import('onnxruntime-node');
	const session = await ort.InferenceSession.create(modelPath, {
		intraOpNumThreads: 1,
		interOpNumThreads: 1,
		// Chunk lengths vary, so a reused arena only grows; without it peak memory is lowest.
		enableCpuMemArena: false,
		enableMemPattern: false
	});
	return async (spect, frames) => {
		const out = await session.run({ spect: new ort.Tensor('float32', spect, [1, frames, N_MELS]) });
		return { beat: out.beat.data as Float32Array, downbeat: out.downbeat.data as Float32Array };
	};
}
