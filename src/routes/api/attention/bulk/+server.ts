import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { settleAllOfKind, type FindingKind } from '$lib/server/library/findings';

const KINDS: FindingKind[] = ['missing', 'duplicate', 'unsupported', 'takeover'];

export const POST: RequestHandler = async ({ request }) => {
  const { kind } = (await request.json()) as { kind: FindingKind };
  if (!KINDS.includes(kind)) throw error(400, `unknown kind: ${kind}`);
  return json({ settled: settleAllOfKind(getDb(), kind) });
};
