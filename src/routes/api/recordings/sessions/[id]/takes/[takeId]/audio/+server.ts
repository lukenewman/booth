import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSession } from '$lib/server/recording/session';
import { extractRegionToFile } from '$lib/server/recording/wav';

export const GET: RequestHandler = async ({ params, url }) => {
  const session = getSession(params.id);
  const take = session?.takes.find((t) => t.id === params.takeId);
  if (!session || !take) throw error(404, 'not found');
  const startMs = Number(url.searchParams.get('startMs') ?? '0');
  const endMs = Number(url.searchParams.get('endMs') ?? '0');
  if (!(endMs > startMs)) throw error(400, 'bad range');

  const dir = mkdtempSync(join(tmpdir(), 'booth-prev-'));
  const p = join(dir, 'preview.wav');
  extractRegionToFile(take.path, p, startMs, endMs);
  const bytes = await Bun.file(p).arrayBuffer();
  rmSync(dir, { recursive: true, force: true });
  return new Response(bytes, { headers: { 'Content-Type': 'audio/wav' } });
};
