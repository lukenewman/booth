/**
 * Bandcamp writes "Visit https://<subdomain>.bandcamp.com" into every
 * download's comment. The host is the artist's or label's page — not the
 * album — and it's what breaks ties when matching purchases to releases.
 */
export function bandcampHostFrom(comment: string | undefined): string | undefined {
  const m = comment?.match(/https?:\/\/([a-z0-9-]+\.bandcamp\.com)/i);
  return m ? m[1].toLowerCase() : undefined;
}
