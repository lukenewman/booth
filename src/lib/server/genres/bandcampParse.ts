/** Bandcamp's primary genre ids, as the site's own genre list gives them (verified 2026-10-09). */
export const BANDCAMP_GENRE_IDS = new Map<number, string>([
  [1, 'acoustic'], [2, 'alternative'], [3, 'ambient'], [4, 'blues'], [5, 'classical'], [6, 'comedy'],
  [7, 'country'], [9, 'devotional'], [10, 'electronic'], [11, 'experimental'], [12, 'folk'], [13, 'funk'],
  [14, 'hip-hop-rap'], [15, 'jazz'], [17, 'latin'], [18, 'metal'], [19, 'pop'], [20, 'punk'],
  [21, 'r-b-soul'], [22, 'reggae'], [23, 'rock'], [24, 'soundtrack'], [25, 'spoken-word'], [26, 'world'],
  [27, 'podcasts'], [28, 'audiobooks'],
]);

export interface BandcampPurchase {
  itemId: string;
  url: string;
  itemType: 'album' | 'track';
  artist: string;
  title: string;
  albumTitle: string | null;
  primaryGenre: string | null;
  purchasedAt: string | null;
  /** Bandcamp's image id for the cover. */
  artId?: string | null;
}

export function parseCollectionItem(raw: Record<string, unknown>, genreNames = BANDCAMP_GENRE_IDS): BandcampPurchase {
  const type = raw.tralbum_type === 't' ? 'track' : 'album';
  const purchased = typeof raw.purchased === 'string' ? new Date(raw.purchased) : null;
  const albumTitle =
    typeof raw.album_title === 'string' && raw.album_title
      ? raw.album_title
      : type === 'album' ? String(raw.item_title ?? '') : null;
  return {
    itemId: `${raw.tralbum_type}${raw.tralbum_id}`,
    url: String(raw.item_url),
    itemType: type,
    artist: String(raw.band_name ?? ''),
    title: String(raw.item_title ?? ''),
    albumTitle,
    primaryGenre: typeof raw.genre_id === 'number' ? genreNames.get(raw.genre_id) ?? null : null,
    purchasedAt: purchased && !isNaN(purchased.getTime()) ? purchased.toISOString() : null,
    artId: typeof raw.item_art_id === 'number' || typeof raw.item_art_id === 'string' ? String(raw.item_art_id) : null,
  };
}

const decode = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/**
 * An album or track page's primary genre and tags. Tags come from the
 * `<a class="tag">` links; the JSON-LD `keywords` list is the fallback (same
 * content, but it would survive a markup change to the links).
 */
export function parseItemPage(html: string): { primaryGenre: string | null; tags: string[] } {
  const genre = html.match(/"genre":"https:\/\/bandcamp\.com\/discover\/([a-z0-9-]+)/)?.[1] ?? null;
  let tags = [...html.matchAll(/<a class="tag"[^>]*>\s*([^<]+?)\s*<\/a>/g)].map((m) => decode(m[1]));
  if (!tags.length) {
    const kw = html.match(/"keywords":(\[[^\]]*\])/)?.[1];
    try { tags = kw ? (JSON.parse(kw) as string[]) : []; } catch { tags = []; }
  }
  return { primaryGenre: genre, tags: [...new Set(tags)] };
}
