import { env } from '$lib/server/env';
import { defaultInboxRoot, defaultLibraryRoot } from './ingest_paths';

/**
 * The only ingest module allowed to import `$env`. Callers resolve the roots
 * here and pass them into the pure modules, matching how the recording feature
 * keeps its path helpers runnable under plain bun.
 */
export function resolvedInboxRoot(): string {
  return env.BOOTH_INBOX_PATH || defaultInboxRoot();
}

export function resolvedLibraryRoot(): string {
  return env.BOOTH_LIBRARY_PATH || defaultLibraryRoot();
}
