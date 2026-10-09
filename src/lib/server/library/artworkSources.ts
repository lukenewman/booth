import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseFile } from 'music-metadata';
import type { ArtworkDeps } from './artworkBackfill';

const UA = 'Mozilla/5.0 (booth; personal library)';

async function get(url: string): Promise<Response | null> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15_000) });
    return res.ok ? res : null;
  } catch {
    return null;
  }
}

/** The real network + file access behind backfillArtwork. */
export function artworkDeps(): ArtworkDeps {
  return {
    // Same directory the local sync caches embedded art in.
    artworkDir: join(homedir(), '.booth', 'artwork'),
    appleAlbumId: async (filePath) => {
      try {
        const m = await parseFile(filePath, { duration: false, skipCovers: true });
        const plID = (m.native['iTunes'] ?? []).find((t) => t.id === 'plID')?.value;
        return plID != null ? String(plID) : null;
      } catch {
        return null;
      }
    },
    fetchJson: async (url) => {
      const res = await get(url);
      return res ? res.json().catch(() => null) : null;
    },
    fetchBytes: async (url) => {
      const res = await get(url);
      const type = res?.headers.get('content-type') ?? '';
      if (!res || !type.startsWith('image/')) return null;
      return { bytes: new Uint8Array(await res.arrayBuffer()), type };
    },
    delayMs: 500,
  };
}
