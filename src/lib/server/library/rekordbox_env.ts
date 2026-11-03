import { env } from '$lib/server/env';

/** The connected rekordbox collection export, or null. The only rekordbox module that reads `$env`. */
export function rekordboxXmlPath(): string | null {
  return env.REKORDBOX_XML_PATH?.trim() || null;
}
