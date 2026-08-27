/**
 * Audio decoding for analysis, via ffmpeg.
 *
 * The server has never decoded audio before — the vinyl recorder only ever
 * handled raw PCM, and playback is the browser's job — so this is the one place
 * that needs a decoder. ffmpeg rather than a library binding: it is one binary
 * with no format ambiguity across the library's mix of MP3 and AAC, and it is
 * what waveform rendering and rip transcoding would want later anyway.
 */
import { ANALYSIS_RATE } from './tempo';

export class FfmpegMissingError extends Error {
  constructor() {
    super('ffmpeg not found on PATH — install it (brew install ffmpeg) to analyse tempo');
    this.name = 'FfmpegMissingError';
  }
}

let ffmpegChecked: boolean | null = null;

export async function hasFfmpeg(): Promise<boolean> {
  if (ffmpegChecked !== null) return ffmpegChecked;
  try {
    const proc = Bun.spawn(['ffmpeg', '-version'], { stdout: 'ignore', stderr: 'ignore' });
    ffmpegChecked = (await proc.exited) === 0;
  } catch {
    ffmpegChecked = false;
  }
  return ffmpegChecked;
}

export interface DecodeOptions {
  /** Seconds to analyse. The default is plenty of periodicity without decoding whole albums. */
  durationS?: number;
  /** Skip this much of the head before taking the excerpt. */
  skipHeadS?: number;
}

/**
 * Decode one file to mono float samples at the analysis rate.
 *
 * Takes an excerpt rather than the whole track: tempo is a global property, and
 * a minute of the middle carries it. Starting a little way in also skips intros,
 * needle-drop noise on rips, and ambient openings, which are the passages most
 * likely to have no pulse at all.
 */
export async function decodeForAnalysis(
  filePath: string,
  opts: DecodeOptions = {},
): Promise<Float32Array> {
  const durationS = opts.durationS ?? 90;
  const skipHeadS = opts.skipHeadS ?? 30;

  // -ss before -i seeks without decoding what it skips, which is the difference
  // between "read 30 seconds and throw them away" and "jump".
  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-ss', String(skipHeadS),
    '-t', String(durationS),
    '-i', filePath,
    '-ac', '1',
    '-ar', String(ANALYSIS_RATE),
    '-f', 'f32le',
    '-',
  ];

  let samples = await run(args);

  // A track shorter than the skip yields nothing. Retry from the top rather
  // than reporting a short interlude as unanalysable.
  if (samples.length === 0 && skipHeadS > 0) {
    samples = await run(args.map((a, i) => (args[i - 1] === '-ss' ? '0' : a)));
  }

  return samples;
}

async function run(args: string[]): Promise<Float32Array> {
  let proc;
  try {
    proc = Bun.spawn(['ffmpeg', ...args], { stdout: 'pipe', stderr: 'pipe' });
  } catch {
    throw new FfmpegMissingError();
  }

  const raw = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    // A missing or unreadable file is an expected outcome across a real library,
    // not a reason to stop a batch — the caller decides.
    throw new Error(`ffmpeg exited ${code}: ${err.trim().split('\n').slice(-2).join(' ')}`);
  }

  // f32le, so the byte length is already a multiple of 4 unless ffmpeg was cut off.
  const usable = raw.byteLength - (raw.byteLength % 4);
  return new Float32Array(raw.buffer, raw.byteOffset, usable / 4);
}
