import { join } from 'node:path';

/**
 * The settings file's format and default place, free of `$env` so scripts can
 * use it under plain bun.
 *
 * Under `bun dev` settings go to `.booth-settings.env` in the repo rather than
 * `.env`: Vite restarts the dev server whenever `.env` changes, so saving a
 * setting from the app (connecting rekordbox, choosing Booth's folder) would
 * take the server down mid-request. The desktop app passes its own path.
 */
export function defaultSettingsPath(cwd: string, override: string | undefined): string {
  return override || join(cwd, '.booth-settings.env');
}

/** `KEY=value` pairs in file order; blank lines, comments and lines without `=` are skipped, one pair of surrounding quotes dropped. */
export function parseSettings(text: string): [string, string][] {
  const out: [string, string][] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1);
    out.push([line.slice(0, eq).trim(), value]);
  }
  return out;
}

/** Set `KEY=value` in env-file text, replacing the key's line or appending one. */
export function upsertEnvLine(text: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^\\s*${key}\\s*=.*$`, 'm');
  // A function replacement, so a `$&` or `$1` in the value is written literally.
  if (pattern.test(text)) return text.replace(pattern, () => line);
  const sep = text === '' || text.endsWith('\n') ? '' : '\n';
  return `${text}${sep}${line}\n`;
}
