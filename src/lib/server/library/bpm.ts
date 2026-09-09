import type { Database } from 'bun:sqlite';
import type { BpmProvider, ResolvedBpm } from '$lib/bpm';

export type { BpmProvider, ResolvedBpm };

/**
 * BPM is multi-source: several adapters can each hold an opinion about the same
 * track and they disagree often enough that "last writer wins" is not good
 * enough. Facets store every opinion; this module picks the one to show.
 *
 * Both local-source providers live under source='local' but on different keys.
 * Giving analysis its own pseudo-source would have been the other option, but a
 * source id is user-visible — it shows up in the source grid and the source
 * filter — and "analysis" is not a place a track came from.
 */

/** Facet key holding the BPM a Music.app library export carried. */
export const BPM_KEY_TAG = 'bpm';
/** Facet key holding a BPM this app computed from the audio itself. */
export const BPM_KEY_ANALYZED = 'bpmAnalyzed';

/**
 * Pseudo-source for the user's own tapped reading.
 *
 * A tap lives in a column on `track`, not in source_facets — it is the user's
 * judgment, like a star, and sync must never touch it. It is presented to the
 * resolver as a facet row anyway so the precedence list stays one array over
 * one shape; nothing writes this source id to the database, and unlike a real
 * source it never reaches the source grid or the source filter.
 */
const BOOTH_SOURCE = 'booth';

/**
 * Which opinion wins, best first.
 *
 * Tapping is last, deliberately. It exists to fill blanks — chiefly the vinyl
 * the app can see but not analyse — not to correct a beatgrid. A hurried tap
 * silently displacing a good rekordbox number is a worse failure than a missing
 * one, and clearing the tap is the way to re-measure.
 *
 * rekordbox is first because those numbers have been through a DJ's hands —
 * analysed and then corrected in the places analysis gets it wrong, which is
 * exactly the set of tracks where being wrong matters most.
 *
 * Analysis outranks the Music.app tag because it is at least consistent. Tags
 * are a mix of careful hand-entry and whatever a store stamped on a purchase,
 * and there is no way to tell which is which from the value alone. Reasonable
 * people could flip these two; that is why this is one array and not an `if`.
 */
const PRECEDENCE: { provider: BpmProvider; source: string; key: string }[] = [
  { provider: 'rekordbox', source: 'rekordbox', key: BPM_KEY_TAG },
  { provider: 'analysis', source: 'local', key: BPM_KEY_ANALYZED },
  { provider: 'tag', source: 'local', key: BPM_KEY_TAG },
  { provider: 'tapped', source: BOOTH_SOURCE, key: BPM_KEY_TAG },
];

/**
 * Present a tapped BPM as a facet row, so callers holding a track row can feed
 * it to `resolveBpm` without the resolver learning about columns.
 */
export function tappedBpmFacets(tappedBpm: number | null | undefined): FacetLike[] {
  return tappedBpm == null ? [] : [{ source: BOOTH_SOURCE, key: BPM_KEY_TAG, value: String(tappedBpm) }];
}

interface FacetLike {
  source: string;
  key: string;
  value: string;
}

/** Parse a stored facet value. Rejects junk and implausible tempi rather than rendering them. */
function parseBpm(raw: string): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  // Values outside this range are data errors, not slow or fast songs. Music.app
  // will happily store a 0 for "not set", and 0 renders as a real reading.
  if (n < 20 || n > 400) return null;
  return n;
}

/** Pick the winning BPM from one track's facet rows. */
export function resolveBpm(facets: FacetLike[]): ResolvedBpm | null {
  for (const { provider, source, key } of PRECEDENCE) {
    const hit = facets.find((f) => f.source === source && f.key === key);
    if (!hit) continue;
    const value = parseBpm(hit.value);
    if (value !== null) return { value, provider };
  }
  return null;
}

/**
 * Resolve BPM for many tracks in one query. Callers page through tracks, so this
 * follows the same shape as the source-link batching next to it: one round trip
 * for the whole page rather than a query per row.
 */
export function resolveBpmForTracks(
  db: Database,
  trackIds: string[],
): Map<string, ResolvedBpm> {
  const out = new Map<string, ResolvedBpm>();
  if (trackIds.length === 0) return out;

  const keys = [...new Set(PRECEDENCE.map((p) => p.key))];
  const rows = db
    .prepare(
      `SELECT entity_id, source, key, value
         FROM source_facets
        WHERE entity_kind='track'
          AND key IN (${keys.map(() => '?').join(',')})
          AND entity_id IN (${trackIds.map(() => '?').join(',')})`,
    )
    .all(...keys, ...trackIds) as (FacetLike & { entity_id: string })[];

  const byTrack = new Map<string, FacetLike[]>();
  for (const r of rows) {
    const list = byTrack.get(r.entity_id) ?? [];
    list.push(r);
    byTrack.set(r.entity_id, list);
  }

  // Taps live on the track row rather than in facets, so they need their own
  // pass — still one round trip, matching the batching this function exists for.
  const tapped = db
    .prepare(
      `SELECT id, tapped_bpm FROM track
        WHERE tapped_bpm IS NOT NULL AND id IN (${trackIds.map(() => '?').join(',')})`,
    )
    .all(...trackIds) as { id: string; tapped_bpm: number }[];
  for (const t of tapped) {
    const list = byTrack.get(t.id) ?? [];
    list.push(...tappedBpmFacets(t.tapped_bpm));
    byTrack.set(t.id, list);
  }

  for (const [trackId, facets] of byTrack) {
    const resolved = resolveBpm(facets);
    if (resolved) out.set(trackId, resolved);
  }
  return out;
}
