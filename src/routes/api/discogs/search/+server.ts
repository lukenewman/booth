import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { discogsFetch, DiscogsError } from '$lib/server/sources/discogs/api';
import { buildFormatLabel, type DiscogsFormat } from '$lib/server/sources/discogs/format';
import type { SearchHit } from '$lib/discogs/group';

interface DiscogsSearchResult {
  id: number;
  type?: string;
  title: string; // "Artist - Title"
  year?: string;
  country?: string;
  label?: string[];
  catno?: string;
  format?: string[];
  formats?: DiscogsFormat[];
  master_id?: number;
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

function byYearAsc(a: SearchHit, b: SearchHit): number {
  if (a.year === null && b.year === null) return 0;
  if (a.year === null) return 1;
  if (b.year === null) return -1;
  return a.year - b.year;
}

function trim(r: DiscogsSearchResult): SearchHit {
  const { artist, title } = parseTitle(r.title);
  return {
    id: r.id,
    artist,
    title,
    year: r.year ? Number(r.year) || null : null,
    country: r.country ?? null,
    label: r.label?.[0] ?? null,
    catno: r.catno?.trim() || null,
    // Prefer the rich `formats[]` (carries color/weight via `text`); fall back
    // to the flattened `format` array when absent.
    format: buildFormatLabel(r.formats) ?? r.format?.join(', ') ?? null,
    masterId: r.master_id && r.master_id > 0 ? r.master_id : null,
    thumb: r.thumb ?? null,
    coverImage: r.cover_image ?? null,
  };
}

export const GET: RequestHandler = async ({ url }) => {
  const q = url.searchParams.get('q')?.trim();
  if (!q) return json({ results: [] });

  try {
    const params = new URLSearchParams({ q, type: 'release', per_page: '100' });
    const data = (await discogsFetch(
      `/database/search?${params}`,
    )) as DiscogsSearchResponse;
    const results = (data.results ?? [])
      .filter((r) => r.type !== 'master' && r.format?.includes('Vinyl'))
      .map(trim)
      .sort(byYearAsc);
    return json({ results });
  } catch (e) {
    if (e instanceof DiscogsError) {
      return json(e.payload, { status: e.status });
    }
    throw error(500, { message: 'Unexpected error' });
  }
};
