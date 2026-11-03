import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { listOpenFindings, openFindingCount } from '$lib/server/library/findings';

export const GET: RequestHandler = async ({ url }) => {
  const db = getDb();
  if (url.searchParams.get('count') === '1') return json({ open: openFindingCount(db) });
  const findings = listOpenFindings(db);
  return json({ open: findings.length, findings });
};
