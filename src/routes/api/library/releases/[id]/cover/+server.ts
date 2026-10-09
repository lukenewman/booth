import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getDb } from '$lib/server/db';
import { setReleaseCover } from '$lib/server/library/releaseCover';
import { recordAnnotation } from '$lib/server/backup';

// Same rules as playlist covers (see api/playlists/[id]/cover).
const artworkDir = join(homedir(), '.booth', 'artwork');
const EXT_BY_TYPE: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const MAX_BYTES = 10 * 1024 * 1024;

/** ULIDs are [0-9A-Za-z]; reject anything else so the filename can't traverse. */
function safeId(id: string): boolean {
  return /^[0-9A-Za-z]+$/.test(id);
}

function removeCoverFiles(id: string): void {
  for (const ext of new Set(Object.values(EXT_BY_TYPE))) {
    const p = join(artworkDir, `release-${id}.${ext}`);
    if (existsSync(p)) unlinkSync(p);
  }
}

function requireRelease(id: string) {
  if (!safeId(id)) throw error(400, 'bad release id');
  if (!getDb().prepare(`SELECT 1 FROM release WHERE id = ?`).get(id)) throw error(404, `release not found: ${id}`);
}

/** POST multipart { file } → set a hand-set cover. Returns { coverUrl }. */
export const POST: RequestHandler = async ({ params, request }) => {
  requireRelease(params.id);
  const form = await request.formData();
  const file = form.get('file');
  if (!(file instanceof File)) throw error(400, 'file required');
  const ext = EXT_BY_TYPE[file.type];
  if (!ext) throw error(400, `unsupported image type: ${file.type}`);
  if (file.size > MAX_BYTES) throw error(413, 'image too large (max 10MB)');

  mkdirSync(artworkDir, { recursive: true });
  removeCoverFiles(params.id);
  writeFileSync(join(artworkDir, `release-${params.id}.${ext}`), Buffer.from(await file.arrayBuffer()));
  // ?v= busts the immutable cache on /api/artwork when the cover is replaced.
  const coverUrl = `/api/artwork/release-${params.id}.${ext}?v=${Date.now()}`;
  const db = getDb();
  setReleaseCover(db, params.id, coverUrl);
  recordAnnotation(db, 'release', params.id, 'cover', coverUrl);
  return json({ coverUrl });
};

/** DELETE → drop the hand-set cover; the sources' cover returns on the next sync. */
export const DELETE: RequestHandler = async ({ params }) => {
  requireRelease(params.id);
  removeCoverFiles(params.id);
  const db = getDb();
  setReleaseCover(db, params.id, null);
  recordAnnotation(db, 'release', params.id, 'cover', null);
  return new Response(null, { status: 204 });
};
