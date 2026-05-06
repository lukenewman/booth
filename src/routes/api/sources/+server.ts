import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { listSources } from '$lib/server/sources/registry';
import { listSourcesWithState } from '$lib/server/library/queries';

export const GET: RequestHandler = async () => {
  const registry = listSources().map((s) => ({
    id: s.id,
    name: s.name,
    contributes: s.contributes,
    isStub: !!s.isStub,
  }));
  return json(listSourcesWithState(getDb(), registry));
};
