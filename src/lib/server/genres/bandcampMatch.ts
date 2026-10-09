import type { Database } from 'bun:sqlite';
import { matchKey } from '../library/relink';
import { stripEditionTags } from '../library/normalize';
import type { BandcampPurchase } from './bandcampParse';

export interface MatchRelease { id: string; artist: string; title: string; hosts: Set<string> }
export interface MatchTrack { releaseId: string; artist: string; title: string }
export type MatchResult = { state: 'matched'; releaseId: string } | { state: 'ambiguous' | 'unmatched' };

const albumKey = (s: string) => matchKey(stripEditionTags(s));

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}

/**
 * Purchase → release. Conservative like relink: a wrong match files a record
 * under the wrong genre silently; an unmatched one shows up in Untagged.
 *  1. artist + album title; ties broken by the file comment's host.
 *  2. (track purchases) artist + track title → that track's release.
 *  3. album title alone, only when exactly one candidate carries the
 *     purchase's host — covers "Various Artists" and label band names.
 */
export function buildMatcher(releases: MatchRelease[], tracks: MatchTrack[]): (p: BandcampPurchase) => MatchResult {
  const byArtistTitle = new Map<string, MatchRelease[]>();
  const byTitle = new Map<string, MatchRelease[]>();
  const byId = new Map(releases.map((r) => [r.id, r]));
  for (const r of releases) {
    push(byArtistTitle, `${matchKey(r.artist)}|${albumKey(r.title)}`, r);
    push(byTitle, albumKey(r.title), r);
  }
  const byTrack = new Map<string, MatchRelease[]>();
  for (const t of tracks) {
    const r = byId.get(t.releaseId);
    if (r) push(byTrack, `${matchKey(t.artist)}|${matchKey(t.title)}`, r);
  }

  return (p) => {
    let host = '';
    try { host = new URL(p.url).hostname.toLowerCase(); } catch { /* no host to compare */ }

    const decide = (cands: MatchRelease[] | undefined, requireHost: boolean): MatchResult | null => {
      const uniq = [...new Map((cands ?? []).map((c) => [c.id, c])).values()];
      if (!uniq.length) return null;
      const withHost = uniq.filter((c) => c.hosts.has(host));
      if (requireHost) {
        if (withHost.length === 1) return { state: 'matched', releaseId: withHost[0].id };
        return withHost.length ? { state: 'ambiguous' } : null;
      }
      if (uniq.length === 1) return { state: 'matched', releaseId: uniq[0].id };
      return withHost.length === 1 ? { state: 'matched', releaseId: withHost[0].id } : { state: 'ambiguous' };
    };

    const album = p.albumTitle ? albumKey(p.albumTitle) : '';
    const artist = matchKey(p.artist);
    return (
      (album ? decide(byArtistTitle.get(`${artist}|${album}`), false) : null) ??
      (p.itemType === 'track' ? decide(byTrack.get(`${artist}|${matchKey(p.title)}`), false) : null) ??
      (album ? decide(byTitle.get(album), true) : null) ??
      { state: 'unmatched' }
    );
  };
}

/** Local releases (file-backed) with the Bandcamp hosts their tracks' comments name. */
export function loadMatchInputs(db: Database): { releases: MatchRelease[]; tracks: MatchTrack[] } {
  const rows = db.prepare(
    `SELECT r.id, a.name AS artist, r.title FROM release r JOIN artist a ON a.id = r.artist_id
      WHERE r.id IN (SELECT entity_id FROM source_link WHERE entity_kind='release' AND source='local')`,
  ).all() as { id: string; artist: string; title: string }[];
  const hosts = new Map<string, Set<string>>();
  for (const h of db.prepare(
    `SELECT t.release_id, f.value FROM track t
       JOIN source_facets f ON f.entity_kind='track' AND f.entity_id=t.id AND f.source='local' AND f.key='bandcampHost'
      WHERE t.release_id IS NOT NULL`,
  ).all() as { release_id: string; value: string }[]) {
    const s = hosts.get(h.release_id) ?? new Set<string>();
    s.add(JSON.parse(h.value) as string);
    hosts.set(h.release_id, s);
  }
  const tracks = db.prepare(
    `SELECT t.release_id AS releaseId, a.name AS artist, t.title
       FROM track t JOIN artist a ON a.id = t.artist_id WHERE t.release_id IS NOT NULL`,
  ).all() as MatchTrack[];
  return { releases: rows.map((r) => ({ ...r, hosts: hosts.get(r.id) ?? new Set() })), tracks };
}
