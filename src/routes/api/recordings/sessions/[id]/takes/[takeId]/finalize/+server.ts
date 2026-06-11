import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { getSession, loadExpectedTracks } from '$lib/server/recording/session';
import { finalizeWav, readWavMeta, scanWav } from '$lib/server/recording/wav';
import { proposeRegions } from '$lib/server/recording/matcher';

const HOP_MS = 50;
const PEAK_BUCKETS = 2000; // downsampled waveform for the review UI

export const POST: RequestHandler = async ({ params }) => {
  const session = getSession(params.id);
  const take = session?.takes.find((t) => t.id === params.takeId);
  if (!session || !take) throw error(404, 'not found');

  finalizeWav(take.path);
  take.finalized = true;
  const meta = readWavMeta(take.path);
  const scan = scanWav(take.path, HOP_MS);

  const { blocks } = loadExpectedTracks(getDb(), session.releaseId);
  const proposal = proposeRegions(scan.rms, HOP_MS, blocks);

  // Downsample peaks to a fixed bucket count for rendering.
  const peaks: number[] = [];
  const per = Math.max(1, Math.floor(scan.peaks.length / PEAK_BUCKETS));
  for (let i = 0; i < scan.peaks.length; i += per) {
    let m = 0;
    for (let j = i; j < Math.min(i + per, scan.peaks.length); j++) m = Math.max(m, scan.peaks[j]);
    peaks.push(Number(m.toFixed(3)));
  }

  return json({
    durationMs: Math.round(meta.durationMs),
    sampleRate: meta.sampleRate,
    peaks,
    regions: proposal.regions,
    sideGuess: proposal.sideGuess,
  });
};
