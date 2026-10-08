import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { addTrack, reorderTracks, listPlaylists, getPlaylist, sectionOf } from '$lib/server/library/playlists';
import { recordPlaylistEvent } from '$lib/server/backup';

function trackCount(id: string): number {
  return listPlaylists(getDb()).find((p) => p.id === id)?.trackCount ?? 0;
}

export const POST: RequestHandler = async ({ params, request }) => {
  const body = await request.json().catch(() => ({}));
  const trackId = typeof body.trackId === 'string' ? body.trackId : '';
  const sectionId = typeof body.sectionId === 'string' ? body.sectionId : undefined;
  if (!trackId) throw error(400, 'trackId required');
  const db = getDb();
  const refs = db
    .prepare(`SELECT (SELECT 1 FROM playlist WHERE id = ?) AS p, (SELECT 1 FROM track WHERE id = ?) AS t`)
    .get(params.id, trackId) as { p: number | null; t: number | null };
  if (!refs.p) throw error(404, `playlist not found: ${params.id}`);
  if (!refs.t) throw error(404, `track not found: ${trackId}`);
  if (sectionId && !sectionOf(db, params.id, sectionId)) throw error(404, `section not found: ${sectionId}`);
  const before = new Set(getPlaylist(db, params.id)!.crate.map((c) => c.entryId));
  const res = addTrack(db, params.id, trackId, sectionId);
  if (res.added) {
    const d = getPlaylist(db, params.id)!;
    const entry = d.sections.flatMap((s) => s.entries).find((e) => e.entryId === res.entryId)!;
    recordPlaylistEvent(db, params.id, {
      action: 'track-add', entryId: res.entryId, sectionId: entry.sectionId, sectionName: res.sectionName,
      trackId, ...entry.snapshot,
    });
    for (const c of d.crate) {
      if (!before.has(c.entryId) && c.releaseId) {
        recordPlaylistEvent(db, params.id, { action: 'crate-add', entryId: c.entryId, releaseId: c.releaseId, artist: c.artist, title: c.title, year: c.year });
      }
    }
  }
  return json({ added: res.added, sectionName: res.sectionName, trackCount: trackCount(params.id) });
};

export const PATCH: RequestHandler = async ({ params, request }) => {
  const body = await request.json().catch(() => ({}));
  const order = Array.isArray(body.order)
    ? (body.order as unknown[]).filter((x): x is string => typeof x === 'string')
    : null;
  if (!order) throw error(400, 'order array required');
  const db = getDb();
  reorderTracks(db, params.id, order);
  const unsorted = getPlaylist(db, params.id)?.sections.find((s) => s.isUnsorted);
  if (unsorted) recordPlaylistEvent(db, params.id, { action: 'track-order', sectionId: unsorted.id, entryIds: unsorted.entries.map((e) => e.entryId) });
  return new Response(null, { status: 204 });
};
