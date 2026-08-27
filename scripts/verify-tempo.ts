// Verifies the tempo estimator against synthetic signals with a known answer.
//
// Real-library accuracy is a separate question, measured by
// `scripts/measure-tempo-accuracy.ts` against the Music.app tags. This file
// checks the DSP does what it claims on material where the truth is not in doubt.
import { ANALYSIS_RATE, estimateTempo, onsetEnvelope } from '../src/lib/server/analysis/tempo';
import { Fft } from '../src/lib/server/analysis/fft';

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg);
    failures++;
  } else console.log('ok:', msg);
}

// --- FFT sanity ---------------------------------------------------
// A tone at bin k must put its energy in bin k, or everything downstream is noise.
{
  const n = 512;
  const fft = new Fft(n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const k = 20;
  for (let i = 0; i < n; i++) re[i] = Math.cos((2 * Math.PI * k * i) / n);
  fft.transform(re, im);
  const mags = Array.from({ length: n / 2 }, (_, b) => Math.hypot(re[b], im[b]));
  const peak = mags.indexOf(Math.max(...mags));
  assert(peak === k, `FFT puts a bin-${k} tone in bin ${k} (got ${peak})`);
}

/**
 * A click track: short decaying noise bursts at a fixed interval, over a quiet
 * noise floor. Crude, but it is unambiguously periodic at one tempo.
 */
function clickTrack(bpm: number, seconds: number, opts: { offbeat?: boolean } = {}): Float32Array {
  const n = Math.round(ANALYSIS_RATE * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (Math.random() - 0.5) * 0.002;

  const period = (60 / bpm) * ANALYSIS_RATE;
  const burst = Math.round(ANALYSIS_RATE * 0.02);
  for (let beat = 0; ; beat++) {
    const start = Math.round(beat * period);
    if (start + burst >= n) break;
    // Every other beat quieter when `offbeat`, which is what makes a 2:1
    // ambiguity: the envelope now also has a strong period at half the tempo.
    const amp = opts.offbeat && beat % 2 === 1 ? 0.25 : 1;
    for (let j = 0; j < burst; j++) {
      const decay = Math.exp(-j / (burst * 0.25));
      out[start + j] += amp * decay * (Math.random() - 0.5) * 1.5;
    }
  }
  return out;
}

// --- Onset envelope -----------------------------------------------
{
  const env = onsetEnvelope(clickTrack(120, 20));
  assert(env.length > 0, 'envelope is produced for a 20s signal');
  const peaks = Array.from(env).filter((v) => v > 2).length;
  assert(peaks > 20, `envelope has clear onsets (${peaks} frames above 2 sd)`);

  const silent = onsetEnvelope(new Float32Array(ANALYSIS_RATE * 5));
  assert(silent.length > 0, 'silence still produces an envelope');
  assert(
    Array.from(silent).every((v) => Math.abs(v) < 5),
    'silence produces no large onsets',
  );
}

// --- Tempo on unambiguous click tracks -----------------------------
for (const bpm of [90, 120, 128, 140, 174]) {
  const est = estimateTempo(clickTrack(bpm, 30));
  assert(est !== null, `${bpm} BPM click track produces an estimate`);
  if (est) {
    const err = Math.abs(est.bpm - bpm);
    assert(err <= 1, `${bpm} BPM recovered as ${est.bpm} (error ${err.toFixed(1)})`);
    assert(est.confidence > 0.2, `${bpm} BPM click track is confident (${est.confidence})`);
  }
}

// --- Estimates are whole numbers ------------------------------------
// The decimals this used to emit were the 0.25 BPM search grid showing
// through, not resolution the estimator actually has.
{
  for (const bpm of [90, 128, 174]) {
    const est = estimateTempo(clickTrack(bpm, 30));
    assert(est !== null && Number.isInteger(est.bpm), `${bpm} BPM estimate is a whole number`);
  }
}

// --- The octave trap -----------------------------------------------
// A track with alternating strong/weak beats is genuinely periodic at both the
// beat and half of it. The comb filter plus the prior should keep the beat.
{
  const est = estimateTempo(clickTrack(128, 30, { offbeat: true }));
  assert(est !== null, 'alternating-accent track produces an estimate');
  if (est) {
    const err = Math.abs(est.bpm - 128);
    assert(err <= 2, `alternating accents still read 128, not 64 (got ${est.bpm})`);
  }
}

// A genuinely slow track must not be dragged up to the prior's centre.
{
  const est = estimateTempo(clickTrack(70, 30));
  assert(est !== null, '70 BPM track produces an estimate');
  if (est) assert(Math.abs(est.bpm - 70) <= 2, `70 BPM stays 70, not 140 (got ${est.bpm})`);
}

// --- Signals with no pulse ------------------------------------------
{
  const noise = new Float32Array(ANALYSIS_RATE * 20);
  for (let i = 0; i < noise.length; i++) noise[i] = (Math.random() - 0.5) * 0.5;
  const est = estimateTempo(noise);
  // It will always return *something*; the contract is that it says so.
  if (est) {
    assert(est.confidence < 0.35, `white noise reports low confidence (${est.confidence})`);
  }
}

// --- Too short to be periodic ---------------------------------------
{
  assert(estimateTempo(new Float32Array(ANALYSIS_RATE * 2)) === null, '2s of audio returns null');
  assert(estimateTempo(new Float32Array(0)) === null, 'empty input returns null');
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
