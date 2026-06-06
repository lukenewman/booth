import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { existsSync } from 'node:fs';
import { getDb } from '$lib/server/db';
import { listSources } from '$lib/server/sources/registry';
import { isPlayable } from '$lib/server/sources/types';

export const GET: RequestHandler = async ({ params, request }) => {
  const db = getDb();

  // Verify track exists.
  const track = db
    .prepare(`SELECT id FROM track WHERE id = ?`)
    .get(params.trackId) as { id: string } | undefined;
  if (!track) throw error(404, 'Track not found');

  // Find source links for this track.
  const links = db
    .prepare(
      `SELECT source FROM source_link WHERE entity_kind='track' AND entity_id=?`,
    )
    .all(params.trackId) as { source: string }[];

  const sourceIds = new Set(links.map((l) => l.source));
  const playableSources = listSources().filter(
    (s) => sourceIds.has(s.id) && isPlayable(s),
  );

  // Try each playable source until one resolves a stream.
  let stream = null;
  for (const source of playableSources) {
    if (isPlayable(source)) {
      stream = await source.resolveTrackStream(params.trackId, db);
      if (stream) break;
    }
  }

  if (!stream) throw error(404, 'No audio available for this track');

  if (stream.kind === 'redirect') {
    return new Response(null, {
      status: 302,
      headers: { Location: stream.url },
    });
  }

  // kind === 'file'
  const { path, mimeType } = stream;
  if (!existsSync(path)) throw error(404, 'Audio file not found on disk');

  const file = Bun.file(path);
  const fileSize = file.size;
  const rangeHeader = request.headers.get('range');

  if (rangeHeader) {
    const match = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
    if (match) {
      const start = parseInt(match[1], 10);
      const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;
      const safeEnd = Math.min(end, fileSize - 1);
      if (start >= fileSize) {
        return new Response(null, {
          status: 416,
          headers: {
            'Content-Range': `bytes */${fileSize}`,
          },
        });
      }
      const chunk = file.slice(start, safeEnd + 1);
      return new Response(chunk, {
        status: 206,
        headers: {
          'Content-Type': mimeType,
          'Content-Range': `bytes ${start}-${safeEnd}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(safeEnd - start + 1),
        },
      });
    }
  }

  return new Response(file, {
    headers: {
      'Content-Type': mimeType,
      'Accept-Ranges': 'bytes',
      'Content-Length': String(fileSize),
    },
  });
};
