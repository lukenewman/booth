import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { DiscogsRelease } from '$lib/types';
import { discogsFetch, DiscogsError } from '$lib/server/discogs';

interface DiscogsSearchResult {
  id: number;
  title: string; // "Artist - Title"
  year?: string;
  country?: string;
  label?: string[];
  format?: string[];
  thumb?: string;
  cover_image?: string;
}

interface DiscogsSearchResponse {
  results: DiscogsSearchResult[];
}

function parseTitle(combined: string): { artist: string; title: string } {
  const idx = combined.indexOf(' - ');
  if (idx === -1) return { artist: '', title: combined };
  return { artist: combined.slice(0, idx), title: combined.slice(idx + 3) };
}

function trim(r: DiscogsSearchResult): DiscogsRelease {
  const { artist, title } = parseTitle(r.title);
  return {
    id: r.id,
    artist,
    title,
    year: r.year ? Number(r.year) || null : null,
    country: r.country ?? null,
    label: r.label?.[0] ?? null,
    format: r.format?.join(', ') ?? null,
    thumb: r.thumb ?? null,
    coverImage: r.cover_image ?? null,
  };
}

export const GET: RequestHandler = async ({ url }) => {
  const q = url.searchParams.get('q')?.trim();
  if (!q) return json({ results: [] });

  try {
    const params = new URLSearchParams({ q, type: 'release', per_page: '25' });
    const data = (await discogsFetch(
      `/database/search?${params}`,
    )) as DiscogsSearchResponse;
    const results = (data.results ?? []).map(trim);
    return json({ results });
  } catch (e) {
    if (e instanceof DiscogsError) {
      return json(e.payload, { status: e.status });
    }
    throw error(500, { message: 'Unexpected error' });
  }
};
