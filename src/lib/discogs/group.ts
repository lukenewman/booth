import type { DiscogsRelease } from '$lib/types';

// A Discogs search hit: the trimmed release plus its master id (null when the
// release has no master — a one-off pressing).
export type SearchHit = DiscogsRelease & { masterId: number | null };

// A display group for the add-flow list: either a single release (no master, or
// a master with one surfaced version) or a multi-version master to drill into.
export interface MasterGroup {
  key: string; // 'master:<id>' or 'release:<id>'
  masterId: number | null;
  isMaster: boolean; // true when versions.length > 1
  title: string;
  artist: string;
  thumb: string | null;
  yearLabel: string | null; // "2024", "2024–2025", or null
  versionCount: number;
  versions: SearchHit[]; // year-asc (stable within a year)
}

function byYearAscStable(a: SearchHit, b: SearchHit): number {
  if (a.year === null && b.year === null) return 0;
  if (a.year === null) return 1;
  if (b.year === null) return -1;
  return a.year - b.year;
}

function yearLabelFor(versions: SearchHit[]): string | null {
  const years = versions.map((v) => v.year).filter((y): y is number => y !== null);
  if (!years.length) return null;
  const min = Math.min(...years);
  const max = Math.max(...years);
  return min === max ? String(min) : `${min}–${max}`;
}

/**
 * Collapse Discogs search hits into display groups. Hits sharing a (truthy)
 * masterId become one master group; hits with no master (null or the 0
 * sentinel) and masters that surfaced a single version render as plain release
 * rows. Groups are ordered by their earliest year ascending (nulls last),
 * matching the flat search ordering.
 */
export function groupByMaster(hits: SearchHit[]): MasterGroup[] {
  const byMaster = new Map<number, SearchHit[]>();
  const singles: SearchHit[] = [];

  for (const h of hits) {
    if (h.masterId && h.masterId > 0) {
      const bucket = byMaster.get(h.masterId);
      if (bucket) bucket.push(h);
      else byMaster.set(h.masterId, [h]);
    } else {
      singles.push(h);
    }
  }

  const groups: MasterGroup[] = [];

  for (const [masterId, raw] of byMaster) {
    const versions = [...raw].sort(byYearAscStable);
    if (versions.length === 1) {
      singles.push(versions[0]);
      continue;
    }
    const head = versions[0];
    groups.push({
      key: `master:${masterId}`,
      masterId,
      isMaster: true,
      title: head.title,
      artist: head.artist,
      thumb: versions.find((v) => v.thumb)?.thumb ?? null,
      yearLabel: yearLabelFor(versions),
      versionCount: versions.length,
      versions,
    });
  }

  for (const h of singles) {
    groups.push({
      key: `release:${h.id}`,
      masterId: h.masterId && h.masterId > 0 ? h.masterId : null,
      isMaster: false,
      title: h.title,
      artist: h.artist,
      thumb: h.thumb,
      yearLabel: yearLabelFor([h]),
      versionCount: 1,
      versions: [h],
    });
  }

  return groups.sort((a, b) => {
    const ay = a.versions[0].year;
    const by = b.versions[0].year;
    if (ay === null && by === null) return 0;
    if (ay === null) return 1;
    if (by === null) return -1;
    return ay - by;
  });
}
