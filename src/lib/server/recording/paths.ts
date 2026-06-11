import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Pure path helpers — no $env imports so verify scripts can run under plain
 * bun. Routes resolve the recordings root via ./env (resolvedRecordingsRoot)
 * and pass it down.
 */

export function defaultRecordingsRoot(): string {
  return join(homedir(), '.booth', 'recordings');
}

export function sessionTmpDir(root: string, sessionId: string): string {
  return join(root, '.tmp', sessionId);
}

/** Strip characters that are unsafe in filenames; collapse whitespace. */
export function sanitizeName(s: string): string {
  return s.replace(/[/\\:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
}

export function releaseDir(root: string, artist: string, album: string, catno: string | null): string {
  const label = catno ? `${album} [${catno}]` : album;
  return join(root, sanitizeName(`${artist} — ${label}`));
}
