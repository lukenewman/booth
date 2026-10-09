import { BASE, discogsFetch, USER_AGENT } from './api';

let cached: string | null = null;

interface IdentityResponse {
  username: string;
}

export async function getUsername(): Promise<string> {
  if (cached) return cached;
  const data = (await discogsFetch('/oauth/identity')) as IdentityResponse;
  cached = data.username;
  return cached;
}

/** Forget the cached username, after the token changes. */
export function resetUsername(): void {
  cached = null;
}

/**
 * Ask Discogs who a candidate token belongs to, before it is saved: the
 * username, or null when Discogs rejects it. Throws when Discogs can't be reached.
 */
export async function identifyToken(token: string): Promise<string | null> {
  const res = await fetch(`${BASE}/oauth/identity`, {
    headers: {
      Authorization: `Discogs token=${token}`,
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
    },
  });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`Discogs ${res.status}`);
  return ((await res.json()) as IdentityResponse).username;
}
