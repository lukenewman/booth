import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { listReleases, parseSort } from '$lib/server/library/queries';

/**
 * Tri-state: absent means "no filter", so it must not collapse to a boolean —
 * `=== '1'` would turn every unfiltered list request into "vetted: false".
 */
function triState(raw: string | null): boolean | undefined {
  return raw === null ? undefined : raw === '1';
}

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 200;

export const GET: RequestHandler = async ({ url }) => {
  const source = url.searchParams.get('source') ?? undefined;
  const q = url.searchParams.get('q') ?? undefined;
  const multiSource = url.searchParams.get('multi_source') === 'true';
  const hasStarred = url.searchParams.get('has_starred') === '1';

  const rawLimit = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT);
  const limit = Math.max(1, Math.min(MAX_LIMIT, Number.isFinite(rawLimit) ? rawLimit : DEFAULT_LIMIT));
  const rawOffset = Number(url.searchParams.get('offset') ?? 0);
  const offset = Math.max(0, Number.isFinite(rawOffset) ? rawOffset : 0);

  const sort = parseSort(url.searchParams.get('sort'));
  const vetted = triState(url.searchParams.get('vetted'));

  const result = listReleases(getDb(), { source, q, limit, offset, multiSource, sort, vetted, hasStarred });
  return json(result);
};
