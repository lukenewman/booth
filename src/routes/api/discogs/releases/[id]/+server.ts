import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { discogsFetch, discogsRateRemaining, DiscogsError } from '$lib/server/sources/discogs/api';
import type { Identifier } from '$lib/discogs/runout';

interface ReleaseExtras {
  formatText: string | null;
  notes: string | null;
  identifiers: Identifier[];
}

// Pressing data barely changes, and the runout filter asks for every version of
// a master — often again on the next search for the same record. Caching here
// (process lifetime, oldest-out) keeps those repeats off the Discogs rate limit.
const CACHE_MAX = 2000;
const cache = new Map<string, ReleaseExtras>();

function remember(id: string, extras: ReleaseExtras) {
  cache.set(id, extras);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
}

export const GET: RequestHandler = async ({ params }) => {
  const cached = cache.get(params.id);
  // rateRemaining is only reported for calls that actually spent a request.
  if (cached) return json({ ...cached, rateRemaining: null });
  try {
    const data = (await discogsFetch(`/releases/${params.id}`)) as any;
    const formatText =
      (data.formats ?? [])
        .map((f: any) => f.text as string | undefined)
        .filter(Boolean)
        .join(', ') || null;
    const notes = typeof data.notes === 'string' ? data.notes.trim() || null : null;
    // The "Barcode and Other Identifiers" section: keep Discogs's order.
    const identifiers: Identifier[] = (data.identifiers ?? [])
      .map((i: any) => ({
        type: typeof i.type === 'string' ? i.type.trim() : '',
        value: typeof i.value === 'string' ? i.value.trim() : '',
        description:
          typeof i.description === 'string' && i.description.trim() ? i.description.trim() : null,
      }))
      .filter((i: Identifier) => i.value);
    const extras = { formatText, notes, identifiers };
    remember(params.id, extras);
    return json({ ...extras, rateRemaining: discogsRateRemaining() });
  } catch (e) {
    if (e instanceof DiscogsError) {
      return json(e.payload, { status: e.status });
    }
    throw error(500, { message: 'Unexpected error' });
  }
};
