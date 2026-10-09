/**
 * Releases group by album artist, falling back to the track artist. A
 * compilation tagged without an album artist therefore split into one release
 * per track artist — the 2MR 2017 Label Sampler showed up as 15 records.
 *
 * Music.app's Compilation flag fixes that, but only where the album really has
 * several artists: a one-artist "compilation" keeps its artist, since labelling
 * it Various Artists would just lose information. Albums are told apart by
 * title + year, the same parts the grouping key uses.
 */
export const VARIOUS_ARTISTS = 'Various Artists';

interface Taggable {
  artist?: string | null;
  album?: string | null;
  albumArtist?: string | null;
  year?: number | null;
  compilation?: boolean;
}

export function withCompilationArtist<T extends Taggable>(tracks: T[]): T[] {
  const key = (t: T) => `${(t.album ?? '').trim().toLowerCase()}|${t.year ?? 0}`;
  const artists = new Map<string, Set<string>>();
  for (const t of tracks) {
    if (!t.compilation || t.albumArtist?.trim() || !t.album?.trim()) continue;
    const set = artists.get(key(t)) ?? new Set<string>();
    set.add((t.artist ?? '').trim().toLowerCase());
    artists.set(key(t), set);
  }
  return tracks.map((t) =>
    t.compilation && !t.albumArtist?.trim() && (artists.get(key(t))?.size ?? 0) > 1
      ? { ...t, albumArtist: VARIOUS_ARTISTS }
      : t,
  );
}
