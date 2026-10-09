import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { pinStyleColor } from '$lib/server/genres/colors';
import { recordStyleColor } from '$lib/server/backup';

/** PUT { slot } → pin a style to a palette slot. 400 for a slot outside the palette. */
export const PUT: RequestHandler = async ({ params, request }) => {
  const body = (await request.json().catch(() => ({}))) as { slot?: unknown };
  const slot = typeof body.slot === 'number' ? body.slot : NaN;
  const style = params.style.trim();
  if (!style) return json({ error: 'bad style' }, { status: 400 });
  try {
    pinStyleColor(getDb(), style, slot);
  } catch (e) {
    if (e instanceof RangeError) return json({ error: e.message }, { status: 400 });
    throw e;
  }
  recordStyleColor(style, slot);
  return json({ ok: true });
};
