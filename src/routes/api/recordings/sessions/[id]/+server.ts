import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSession, destroySession } from '$lib/server/recording/session';

export const DELETE: RequestHandler = async ({ params }) => {
  if (!getSession(params.id)) throw error(404, 'session not found');
  destroySession(params.id);
  return json({ ok: true });
};
