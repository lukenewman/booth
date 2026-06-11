/**
 * Extract a YouTube video id from a Discogs video `uri`.
 * Discogs videos are almost always YouTube; returns null for anything we can't
 * map to an embeddable id (caller falls back to a plain link).
 */
export function parseYouTubeId(uri: string): string | null {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./, '');
  if (host === 'youtu.be') {
    const id = u.pathname.slice(1).split('/')[0];
    return id || null;
  }
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
    const v = u.searchParams.get('v');
    if (v) return v;
    const m = u.pathname.match(/\/(?:embed|v)\/([^/?#]+)/);
    if (m) return m[1];
  }
  return null;
}
