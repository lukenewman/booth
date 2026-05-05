import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSource } from '$lib/server/sources/registry';
import { collate } from '$lib/server/library/collate';
import { getDb } from '$lib/server/db';
import { NotImplementedError } from '$lib/server/sources/types';
import { DiscogsError } from '$lib/server/sources/discogs/api';

export const POST: RequestHandler = async ({ params }) => {
  const source = getSource(params.id);
  if (!source) throw error(404, `unknown source: ${params.id}`);
  try {
    const result = await source.sync();
    const summary = collate(getDb(), source.id, result);
    return json({ source: source.id, ...summary });
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
