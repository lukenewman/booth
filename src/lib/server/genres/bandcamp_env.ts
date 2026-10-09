import { env } from '$lib/server/env';

/**
 * The only genres module allowed to import `$env` — the rest stay runnable
 * under plain bun for the verify scripts (same split as ingest_env).
 */
export function bandcampUsername(): string | null {
  return env.BANDCAMP_USERNAME?.trim() || null;
}
