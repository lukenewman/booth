import { env as dynPrivate } from '$env/dynamic/private';

/**
 * Server-side env access that works under the Bun runtime.
 *
 * Booth's dev server runs `bunx --bun vite dev` — the `--bun` flag is required
 * so the SSR runtime has `bun:sqlite` (the whole DB layer). But when Vite runs
 * on the Bun runtime, SvelteKit's `$env/dynamic/private` comes back EMPTY
 * (`Object.keys(env).length === 0`); its dev-time injection only runs under
 * Node. Bun, however, loads `.env` straight into `process.env`.
 *
 * So we read `$env/dynamic/private` first (keeps prod/Node adapters and any
 * future toolchain fix working) and fall back to `process.env` (the source that
 * actually has values under `--bun`). Drop-in: callers keep using `env.FOO`.
 */
const dyn = dynPrivate as Record<string, string | undefined>;

export const env: Record<string, string | undefined> = new Proxy(
  {} as Record<string, string | undefined>,
  {
    get(_target, key) {
      if (typeof key !== 'string') return undefined;
      return dyn[key] ?? process.env[key];
    },
  },
);
