import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSession } from '$lib/server/recording/session';
import { appendFloat32 } from '$lib/server/recording/wav';

export const POST: RequestHandler = async ({ params, request }) => {
  const session = getSession(params.id);
  const take = session?.takes.find((t) => t.id === params.takeId);
  if (!session || !take) throw error(404, 'not found');
  if (take.finalized) throw error(409, 'take already finalized');
  const buf = await request.arrayBuffer();
  if (buf.byteLength % 4 !== 0) throw error(400, 'body must be a float32 array');
  appendFloat32(take.path, new Float32Array(buf));
  return json({ ok: true });
};
