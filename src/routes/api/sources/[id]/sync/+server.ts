import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSource } from '$lib/server/sources/registry';
import { runSync } from '$lib/server/library/sync_run';
import { getDb } from '$lib/server/db';
import { NotImplementedError } from '$lib/server/sources/types';
import { DiscogsError } from '$lib/server/sources/discogs/api';

export const POST: RequestHandler = async ({ params }) => {
  const source = getSource(params.id);
  if (!source) throw error(404, `unknown source: ${params.id}`);
  try {
    const run = await runSync(getDb(), source.id);
    return json({ source: source.id, ...(run.summary ?? {}) });
  } catch (e) {
    if (e instanceof NotImplementedError) {
      throw error(501, e.message);
    }
    if (e instanceof DiscogsError) {
      return json(e.payload, { status: e.status });
    }
    throw e;
  }
};
