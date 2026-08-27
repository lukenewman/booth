import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { resolvedRecordingsRoot } from '$lib/server/recording/env';
import { getSession, destroySession } from '$lib/server/recording/session';
import { commitRegions, type CommitRegion } from '$lib/server/recording/commit';
import { hasFfmpeg, pendingAnalysis, startBackgroundAnalysis } from '$lib/server/analysis/run';

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

  /*
   * Analyse the rips behind the response. This matters more here than after a
   * sync: a rip never appears in the Music.app export, so local analysis is the
   * only BPM source it will ever have. Scoped to the ids just committed rather
   * than the whole backlog, so finishing a side does not kick off a full pass.
   *
   * No sync_run row exists to report into, so a missing ffmpeg is reported to
   * the client instead of being swallowed.
   */
  const ffmpeg = await hasFfmpeg();
  let analysing = 0;
  if (ffmpeg) {
    const candidates = pendingAnalysis(getDb(), {
      trackIds: body.regions.map((r) => r.trackId),
    });
    if (startBackgroundAnalysis(getDb(), candidates)) analysing = candidates.length;
  }

  return json({ written: result.written, analysing, ffmpeg });
};
