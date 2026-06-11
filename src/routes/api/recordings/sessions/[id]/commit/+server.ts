import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { resolvedRecordingsRoot } from '$lib/server/recording/env';
import { getSession, destroySession } from '$lib/server/recording/session';
import { commitRegions, type CommitRegion } from '$lib/server/recording/commit';

export const POST: RequestHandler = async ({ params, request }) => {
  const session = getSession(params.id);
  if (!session) throw error(404, 'session not found');
  const body = (await request.json()) as { regions?: CommitRegion[]; replace?: boolean };
  if (!body.regions?.length) throw error(400, 'regions required');

  const result = commitRegions(
    getDb(),
    resolvedRecordingsRoot(),
    session,
    body.regions,
    body.replace ?? false,
  );
  if (result.conflicts.length > 0 && result.written === 0) {
    return json({ conflicts: result.conflicts }, { status: 409 });
  }
  destroySession(session.id);
  return json({ written: result.written });
};
