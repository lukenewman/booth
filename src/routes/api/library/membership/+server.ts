import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { getMembershipExternalIds } from '$lib/server/library/queries';

export const GET: RequestHandler = async ({ url }) => {
  const source = url.searchParams.get('source');
  if (!source) throw error(400, 'source query param required');
  const kind = url.searchParams.get('entityKind') ?? 'release';
  if (kind !== 'release' && kind !== 'track') throw error(400, 'invalid entityKind');
  const externalIds = getMembershipExternalIds(getDb(), source, kind);
  return json({ externalIds });
};
