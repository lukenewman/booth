import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getDb } from '$lib/server/db';
import { getPlaylist, setPlaylistCover, clearPlaylistCover } from '$lib/server/library/playlists';

const artworkDir = join(homedir(), '.booth', 'artwork');
const EXT_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
const MAX_BYTES = 10 * 1024 * 1024;

/** ULIDs are [0-9A-Za-z]; reject anything else so the filename can't traverse. */
function safeId(id: string): boolean {
  return /^[0-9A-Za-z]+$/.test(id);
}

/** Remove any existing cover file for this playlist (any known extension). */
function removeCoverFiles(id: string): void {
  for (const ext of new Set(Object.values(EXT_BY_TYPE))) {
    const p = join(artworkDir, `playlist-${id}.${ext}`);
    if (existsSync(p)) unlinkSync(p);
  }
}

export const POST: RequestHandler = async ({ params, request }) => {
  if (!safeId(params.id)) throw error(400, 'bad playlist id');
  const db = getDb();
  if (!getPlaylist(db, params.id)) throw error(404, `playlist not found: ${params.id}`);

  const form = await request.formData();
  const file = form.get('file');
  if (!(file instanceof File)) throw error(400, 'file required');
  const ext = EXT_BY_TYPE[file.type];
  if (!ext) throw error(400, `unsupported image type: ${file.type}`);
  if (file.size > MAX_BYTES) throw error(413, 'image too large (max 10MB)');

  mkdirSync(artworkDir, { recursive: true });
  removeCoverFiles(params.id); // drop a prior cover of a different extension
  writeFileSync(join(artworkDir, `playlist-${params.id}.${ext}`), Buffer.from(await file.arrayBuffer()));

  // ?v= busts the immutable cache on /api/artwork when the cover is replaced.
  const coverUrl = `/api/artwork/playlist-${params.id}.${ext}?v=${Date.now()}`;
  setPlaylistCover(db, params.id, coverUrl);
  return json({ coverUrl });
};

export const DELETE: RequestHandler = async ({ params }) => {
  if (!safeId(params.id)) throw error(400, 'bad playlist id');
  removeCoverFiles(params.id);
  clearPlaylistCover(getDb(), params.id);
  return new Response(null, { status: 204 });
};
