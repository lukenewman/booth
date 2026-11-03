import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { env, setEnv } from '$lib/server/env';
import { defaultSettingsPath, parseSettings, upsertEnvLine } from './settings_file';

export { upsertEnvLine } from './settings_file';

/**
 * The file booth's settings live in: `~/.booth/settings.env` for the desktop
 * app and the Intel zip (their launchers set BOOTH_SETTINGS_PATH), and
 * `.booth-settings.env` in the repo under `bun dev` (not `.env`, whose every
 * change restarts the dev server).
 */
export function settingsPath(): string {
  return defaultSettingsPath(process.cwd(), env.BOOTH_SETTINGS_PATH);
}

/** Apply the settings file on top of the environment (`.env` included): what the app saved wins. */
export function loadSettingsFile(path = settingsPath()): void {
  if (!existsSync(path)) return;
  for (const [key, value] of parseSettings(readFileSync(path, 'utf8'))) setEnv(key, value);
}

export function writeSetting(key: string, value: string): string {
  const path = settingsPath();
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  writeFileSync(path, upsertEnvLine(text, key, value));
  return path;
}
