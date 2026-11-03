import { discogsFetch } from './api';
import { parseYouTubeId } from './youtube';

export interface ReleaseVideo {
  url: string;
  title: string;
  youtubeId: string | null;
}

export interface ReleaseImage {
  /** Full-size image. */
  url: string;
  /** 150px thumbnail; falls back to the full image when Discogs gives none. */
  thumb: string;
  width: number | null;
  height: number | null;
  primary: boolean;
}

export interface ReleaseMedia {
  images: ReleaseImage[];
  videos: ReleaseVideo[];
}

interface DiscogsReleaseResponse {
  images?: Array<{ type?: string; uri?: string; uri150?: string; width?: number; height?: number }>;
  videos?: Array<{ uri?: string; title?: string }>;
}

/**
 * The photos and videos on a Discogs release. Both come from the one full
 * /releases/{id} response, so they are fetched together: opening a release
 * costs one request against Discogs' 60/min budget, not one per section.
 */
export function parseReleaseMedia(data: DiscogsReleaseResponse): ReleaseMedia {
  const images: ReleaseImage[] = [];
  const seenImages = new Set<string>();
  for (const img of data.images ?? []) {
    if (typeof img.uri !== 'string' || img.uri.length === 0) continue;
    if (seenImages.has(img.uri)) continue;
    seenImages.add(img.uri);
    images.push({
      url: img.uri,
      thumb: typeof img.uri150 === 'string' && img.uri150 ? img.uri150 : img.uri,
      width: typeof img.width === 'number' && img.width > 0 ? img.width : null,
      height: typeof img.height === 'number' && img.height > 0 ? img.height : null,
      primary: img.type === 'primary',
    });
  }
  // Discogs lists the primary image first in practice; make it so regardless.
  images.sort((a, b) => Number(b.primary) - Number(a.primary));

  const videos: ReleaseVideo[] = [];
  const seenVideos = new Set<string>();
  for (const v of data.videos ?? []) {
    if (typeof v.uri !== 'string' || v.uri.length === 0) continue;
    if (seenVideos.has(v.uri)) continue; // Discogs sometimes lists the same uri twice.
    seenVideos.add(v.uri);
    videos.push({ url: v.uri, title: v.title?.trim() || v.uri, youtubeId: parseYouTubeId(v.uri) });
  }
  return { images, videos };
}

/** Fetch a Discogs release's photos and videos (the full /releases/{id} endpoint). */
export async function fetchReleaseMedia(externalId: string): Promise<ReleaseMedia> {
  const data = (await discogsFetch(
    `/releases/${encodeURIComponent(externalId)}`,
  )) as DiscogsReleaseResponse;
  return parseReleaseMedia(data);
}
