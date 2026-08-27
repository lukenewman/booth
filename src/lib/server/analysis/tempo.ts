/**
 * Global tempo estimation: onset-strength envelope, then a comb filter over
 * candidate periods.
 *
 * This is the Ellis "Beat Tracking by Dynamic Programming" front end without the
 * beat tracker — we want one number per track, not beat positions, and the
 * envelope-plus-periodicity half is where that number comes from.
 *
 * Deliberately not a full analysis. rekordbox heats a laptop because it renders
 * multi-resolution waveforms, builds a beat grid with downbeats, detects key and
 * runs phrase analysis. Global tempo is a small fraction of that bill, and it is
 * the only part a BPM readout needs.
 */
import { Fft } from './fft';

/** Analysis sample rate. 8 kHz of bandwidth is plenty for onsets and keeps frames cheap. */
export const ANALYSIS_RATE = 16000;

const FRAME = 512;
const HOP = 128;
/** Onset-envelope frame rate: 125 fps, so a 200 BPM period is still 37 frames wide. */
const FPS = ANALYSIS_RATE / HOP;

/**
 * Search range. Below 60 and above 200 the candidates are almost always octave
 * errors on something inside the range rather than genuinely that slow or fast.
 */
const MIN_BPM = 60;
const MAX_BPM = 200;

/**
 * Log-normal prior over tempo, centred where dance music actually sits. This is
 * what stops the comb filter reporting a confident half- or double-time answer:
 * both score well on a steady beat, and only the prior separates them.
 *
 * The width was swept against 120 tagged tracks. It matters far more than it
 * looks: at 0.6 half-time errors are 0% of the sample, at 1.2 they are 9%, and
 * at 2.5 they are 52% — a nearly flat prior means the estimator picks whichever
 * metrical level happens to autocorrelate marginally better, which for most
 * dance music is half time. Tightening past 0.6 buys nothing and would start
 * dragging genuinely slow and genuinely fast records toward the centre.
 */
const PRIOR_CENTRE_BPM = 124;
const PRIOR_WIDTH_OCTAVES = 0.6;

export interface TempoEstimate {
  /** Best estimate, one decimal. */
  bpm: number;
  /**
   * How well a pulse at `bpm` actually explains the onset envelope: the
   * envelope's normalised autocorrelation at the winning period, 0..1. Low
   * means the track had no steady pulse to find, not that the number is a
   * little off.
   */
  confidence: number;
  /** Runners-up, best first, for diagnosing octave errors. */
  candidates: { bpm: number; score: number }[];
}

/** Hann window, precomputed once per call. */
function hann(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

/**
 * Half-wave-rectified spectral flux: how much energy *appeared* between frames.
 * Rectifying is the point — a note ending is not an onset, and counting decays
 * as events smears the envelope until periodicity stops being visible.
 *
 * Flux is measured on log magnitudes so a quiet passage contributes onsets on
 * the same scale as a loud one; otherwise the loudest 30 seconds decide the
 * tempo of the whole track.
 */
export function onsetEnvelope(samples: Float32Array): Float32Array {
  const fft = new Fft(FRAME);
  const win = hann(FRAME);
  const re = new Float64Array(FRAME);
  const im = new Float64Array(FRAME);
  const bins = FRAME / 2;

  const frames = Math.max(0, Math.floor((samples.length - FRAME) / HOP) + 1);
  if (frames <= 1) return new Float32Array(0);

  const env = new Float32Array(frames);
  let prev = new Float64Array(bins);
  let havePrev = false;

  for (let f = 0; f < frames; f++) {
    const off = f * HOP;
    for (let i = 0; i < FRAME; i++) {
      re[i] = samples[off + i] * win[i];
      im[i] = 0;
    }
    fft.transform(re, im);

    let flux = 0;
    const cur = new Float64Array(bins);
    for (let k = 0; k < bins; k++) {
      const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      const logMag = Math.log1p(1000 * mag);
      cur[k] = logMag;
      if (havePrev) {
        const d = logMag - prev[k];
        if (d > 0) flux += d;
      }
    }
    env[f] = havePrev ? flux : 0;
    prev = cur;
    havePrev = true;
  }

  return normalise(env);
}

/**
 * Subtract a local mean and divide by the global deviation. The local mean
 * removes slow loudness drift (a build, a breakdown) that would otherwise
 * dominate the autocorrelation with a very long spurious period.
 */
function normalise(env: Float32Array): Float32Array {
  const n = env.length;
  if (n === 0) return env;

  // ~0.4s window: long enough to be a baseline, short enough not to eat beats.
  const halfWin = Math.max(1, Math.round(FPS * 0.2));
  const out = new Float32Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += env[i];

  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + env[i];

  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - halfWin);
    const hi = Math.min(n, i + halfWin + 1);
    const local = (prefix[hi] - prefix[lo]) / (hi - lo);
    out[i] = Math.max(0, env[i] - local);
  }

  let mean = 0;
  for (let i = 0; i < n; i++) mean += out[i];
  mean /= n;
  let varSum = 0;
  for (let i = 0; i < n; i++) varSum += (out[i] - mean) * (out[i] - mean);
  const sd = Math.sqrt(varSum / n) || 1;
  for (let i = 0; i < n; i++) out[i] = (out[i] - mean) / sd;

  return out;
}

/** Unnormalised autocorrelation of the envelope at one lag. */
function autocorrAt(env: Float32Array, lag: number): number {
  const n = env.length;
  if (lag >= n) return 0;
  let sum = 0;
  for (let i = 0; i + lag < n; i++) sum += env[i] * env[i + lag];
  return sum / (n - lag);
}

/**
 * Score a candidate period by summing autocorrelation at its first four
 * multiples — a comb filter. A true beat period lines up with every multiple;
 * a half-time candidate only lines up with the even ones, which is what pulls
 * the octave apart before the prior even gets a say.
 */
function combScore(env: Float32Array, lag: number): number {
  let score = 0;
  for (let m = 1; m <= 4; m++) {
    // Later multiples get less weight: they see less overlap and more drift.
    score += autocorrAt(env, Math.round(lag * m)) / m;
  }
  return score;
}

/** Gaussian in log2-tempo space. */
function prior(bpm: number): number {
  const octaves = Math.log2(bpm / PRIOR_CENTRE_BPM);
  return Math.exp(-0.5 * (octaves / PRIOR_WIDTH_OCTAVES) ** 2);
}

export function tempoFromEnvelope(env: Float32Array): TempoEstimate | null {
  if (env.length < FPS * 8) return null; // under ~8s there is nothing to be periodic about

  const scored: { bpm: number; score: number }[] = [];
  // Step in tempo, not in lag: constant lag steps oversample fast tempi and
  // undersample slow ones, which biases the peak search.
  for (let bpm = MIN_BPM; bpm <= MAX_BPM; bpm += 0.25) {
    const lag = (60 * FPS) / bpm;
    if (lag * 4 >= env.length) continue;
    scored.push({ bpm, score: combScore(env, lag) * prior(bpm) });
  }
  if (scored.length === 0) return null;

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!(best.score > 0)) return null;

  /*
   * Confidence is measured on the envelope, not on the score surface. Scoring
   * the surface looked reasonable and was wrong twice over: harmonics of a true
   * tempo also score well, so a correct answer looked unremarkable, and when the
   * comb scores are all near zero the surface is just the prior's shape — which
   * is sharply peaked, so white noise came out maximally confident.
   *
   * The envelope is standardised, so autocorrelation at the winning lag over
   * autocorrelation at zero is a correlation coefficient: how much of the onset
   * pattern a pulse at this period actually accounts for.
   */
  const bestLag = (60 * FPS) / best.bpm;
  const zero = autocorrAt(env, 0);
  const confidence = zero > 0
    ? Math.max(0, Math.min(1, autocorrAt(env, Math.round(bestLag)) / zero))
    : 0;

  // Keep only distinct peaks for the runners-up, or the list is one peak's shoulder.
  const candidates: { bpm: number; score: number }[] = [];
  for (const s of scored) {
    if (candidates.every((c) => Math.abs(c.bpm - s.bpm) > 4)) candidates.push(s);
    if (candidates.length === 4) break;
  }

  return {
    bpm: Math.round(best.bpm * 10) / 10,
    confidence: Math.round(confidence * 100) / 100,
    candidates: candidates.map((c) => ({ bpm: c.bpm, score: c.score })),
  };
}

/** Full pipeline for one decoded excerpt at `ANALYSIS_RATE`. */
export function estimateTempo(samples: Float32Array): TempoEstimate | null {
  return tempoFromEnvelope(onsetEnvelope(samples));
}
