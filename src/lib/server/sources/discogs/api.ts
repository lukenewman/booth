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

// Requests left in Discogs's moving one-minute window, as of the last response.
// Lets bulk background work (the runout filter's identifier prefetch) back off
// before it starves a user action like an add into a 429.
let rateRemaining: number | null = null;
export function discogsRateRemaining(): number | null {
  return rateRemaining;
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

  const remaining = Number(res.headers.get('X-Discogs-Ratelimit-Remaining'));
  if (Number.isFinite(remaining) && res.headers.has('X-Discogs-Ratelimit-Remaining')) {
    rateRemaining = remaining;
  }

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
