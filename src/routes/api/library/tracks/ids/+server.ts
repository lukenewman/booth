import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { listTrackIds, parseSort } from '$lib/server/library/queries';

/**
 * Tri-state: absent means "no filter", so it must not collapse to a boolean —
 * `=== '1'` would turn every unfiltered list request into "starred: false".
 */
function triState(raw: string | null): boolean | undefined {
  return raw === null ? undefined : raw === '1';
}

export const GET: RequestHandler = async ({ url }) => {
  const source = url.searchParams.get('source') ?? undefined;
  const q = url.searchParams.get('q') ?? undefined;
  const multiSource = url.searchParams.get('multi_source') === 'true';
  const sort = parseSort(url.searchParams.get('sort'));
  const starred = triState(url.searchParams.get('starred'));

  return json({ ids: listTrackIds(getDb(), { source, q, multiSource, sort, starred }) });
};
