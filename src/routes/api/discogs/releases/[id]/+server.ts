import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { discogsFetch, DiscogsError } from '$lib/server/sources/discogs/api';

interface Identifier {
  type: string;
  value: string;
  description: string | null;
}

export const GET: RequestHandler = async ({ params }) => {
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
    return json({ formatText, notes, identifiers });
  } catch (e) {
    if (e instanceof DiscogsError) {
      return json(e.payload, { status: e.status });
    }
    throw error(500, { message: 'Unexpected error' });
  }
};
