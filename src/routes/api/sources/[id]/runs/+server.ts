import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSource } from '$lib/server/sources/registry';
import { listSyncRuns } from '$lib/server/library/sync_run';
import { getDb } from '$lib/server/db';

export const GET: RequestHandler = async ({ params, url }) => {
  if (!getSource(params.id)) throw error(404, `unknown source: ${params.id}`);
  const limitParam = Number(url.searchParams.get('limit'));
  const limit =
    Number.isFinite(limitParam) && limitParam > 0 && limitParam <= 200
      ? limitParam
      : 20;
  return json({ items: listSyncRuns(getDb(), params.id, limit) });
};
