import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { existsSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { homedir } from 'node:os';

const artworkDir = join(homedir(), '.booth', 'artwork');

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

export const GET: RequestHandler = ({ params }) => {
  const { filename } = params;
  // Prevent path traversal — filename must be a bare name with no slashes or dots-leading.
  if (!filename || filename.includes('/') || filename.includes('\\') || filename.startsWith('.')) {
    throw error(400, 'Invalid filename');
  }

  const filePath = join(artworkDir, filename);
  if (!existsSync(filePath)) throw error(404, 'Not found');

  const ext = extname(filename).toLowerCase();
  const contentType = MIME[ext] ?? 'application/octet-stream';

  return new Response(readFileSync(filePath), {
    headers: {
      'content-type': contentType,
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });
};
