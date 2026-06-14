import { env } from '$lib/server/env';
import type { ApiError } from '$lib/types';

const BASE = 'https://api.discogs.com';
const USER_AGENT = 'booth/0.1 +https://github.com/luke';

export class DiscogsError extends Error {
  constructor(public payload: ApiError, public status: number) {
    super(payload.message ?? payload.error);
  }
}

function getToken(): string {
  const token = env.DISCOGS_TOKEN;
  if (!token) {
    throw new DiscogsError({ error: 'no_token', message: 'DISCOGS_TOKEN not set in .env' }, 500);
  }
  return token;
}

export async function discogsFetch(path: string, init: RequestInit = {}): Promise<unknown> {
  const token = getToken();
  const url = path.startsWith('http') ? path : `${BASE}${path}`;

  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Discogs token=${token}`,
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });

  if (res.status === 401) {
    throw new DiscogsError(
      { error: 'invalid_token', message: 'Discogs rejected the token (401)' },
      401,
    );
  }

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('Retry-After') ?? '60');
    throw new DiscogsError({ error: 'rate_limited', retryAfter }, 429);
  }

  if (res.status === 404) {
    throw new DiscogsError({ error: 'not_found' }, 404);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new DiscogsError(
      { error: 'discogs_error', message: `Discogs ${res.status}: ${text.slice(0, 200)}` },
      res.status,
    );
  }

  // 204 No Content for collection delete
  if (res.status === 204) return null;
  return res.json();
}
