import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { suggestSample } from '$lib/server/takeover/sample';

/** GET ?seed= → about ten releases for the sample takeover. A new seed is "draw again". */
export const GET: RequestHandler = ({ url }) => {
  const seed = Number(url.searchParams.get('seed')) || Date.now();
  return json({ seed, releases: suggestSample(getDb(), { seed }) });
};
