import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSession, addTake } from '$lib/server/recording/session';
import { createWav } from '$lib/server/recording/wav';

export const POST: RequestHandler = async ({ params, request }) => {
  const session = getSession(params.id);
  if (!session) throw error(404, 'session not found');
  const { sampleRate, channels } = (await request.json()) as {
    sampleRate?: number;
    channels?: number;
  };
  if (!sampleRate || sampleRate < 8000 || sampleRate > 384000) throw error(400, 'bad sampleRate');
  const ch = channels === 1 ? 1 : 2;
  const take = addTake(session, sampleRate, ch);
  createWav(take.path, sampleRate, ch);
  return json({ takeId: take.id });
};
