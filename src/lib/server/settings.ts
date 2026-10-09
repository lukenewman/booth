import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { env } from '$lib/server/env';

/**
 * The file booth's settings live in: `~/.booth/settings.env` for the desktop
 * app and the Intel zip (their launchers set BOOTH_SETTINGS_PATH), the repo's
 * `.env` under `bun dev`.
 */
export function settingsPath(): string {
  return env.BOOTH_SETTINGS_PATH || join(process.cwd(), '.env');
}

/** Set `KEY=value` in env-file text, replacing the key's line or appending one. */
export function upsertEnvLine(text: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^\\s*${key}\\s*=.*$`, 'm');
  if (pattern.test(text)) return text.replace(pattern, line);
  const sep = text === '' || text.endsWith('\n') ? '' : '\n';
  return `${text}${sep}${line}\n`;
}

export function writeSetting(key: string, value: string): string {
  const path = settingsPath();
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  writeFileSync(path, upsertEnvLine(text, key, value));
  return path;
}
