import { discogsFetch } from './api';
import { parseYouTubeId } from './youtube';

export interface ReleaseVideo {
  url: string;
  title: string;
  youtubeId: string | null;
}

interface DiscogsReleaseResponse {
  videos?: Array<{ uri?: string; title?: string }>;
}

/** Fetch the `videos` list for a Discogs release (the full /releases/{id} endpoint). */
export async function fetchReleaseVideos(externalId: string): Promise<ReleaseVideo[]> {
  const data = (await discogsFetch(
    `/releases/${encodeURIComponent(externalId)}`,
  )) as DiscogsReleaseResponse;

  const seen = new Set<string>();
  const out: ReleaseVideo[] = [];
  for (const v of data.videos ?? []) {
    if (typeof v.uri !== 'string' || v.uri.length === 0) continue;
    if (seen.has(v.uri)) continue; // Discogs sometimes lists the same uri twice.
    seen.add(v.uri);
    out.push({ url: v.uri, title: v.title?.trim() || v.uri, youtubeId: parseYouTubeId(v.uri) });
  }
  return out;
}
