import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { AddResponse } from '$lib/types';
import { DiscogsError } from '$lib/server/sources/discogs/api';
import { discogsSource, ensureDiscogsReleaseEntity } from '$lib/server/sources/discogs';

interface AddRequestBody {
  releaseId: number;
  title: string;
  artist: string;
  year: number | null;
  country: string | null;
  label: string | null;
  catno: string | null;
  thumb: string | null;
  coverImage: string | null;
}

export const POST: RequestHandler = async ({ request }) => {
  let body: Partial<AddRequestBody>;
  try {
    body = await request.json();
  } catch {
    throw error(400, 'Invalid JSON body');
  }
  const releaseId = body.releaseId;
  if (typeof releaseId !== 'number') throw error(400, 'releaseId (number) required');
  if (typeof body.title !== 'string' || typeof body.artist !== 'string') {
    throw error(400, 'title and artist (strings) required');
  }

  const entityId = ensureDiscogsReleaseEntity({
    releaseId,
    title: body.title,
    artist: body.artist,
    year: body.year ?? null,
    country: body.country ?? null,
    label: body.label ?? null,
    catno: body.catno ?? null,
    thumb: body.thumb ?? null,
    coverImage: body.coverImage ?? null,
  });

  try {
    const { externalId, instanceId } = await discogsSource.addToCollection({ entityId });
    const response: AddResponse = {
      releaseId: Number(externalId),
      instanceId: Number(instanceId!),
    };
    return json(response);
  } catch (e) {
    if (e instanceof DiscogsError) {
      return json(e.payload, { status: e.status });
    }
    throw error(500, { message: 'Unexpected error' });
  }
};
