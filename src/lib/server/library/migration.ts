import type { Database } from 'bun:sqlite';
import { existsSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { dedupePath, ingestTargetPath } from '../sources/local/ingest_paths';
import { toTagWrite, type BoothTrackFacts } from './tag_schema';

/**
 * Planning the one verified pass that moves the library into Booth's tree.
 *
 * Read-only and pure of side effects: it decides what *would* happen so the
 * plan can be reviewed before 51GB is touched. The script that executes it
 * consumes this, so the dry run and the real pass cannot disagree about what
 * the pass intends — the failure mode that makes a dry run worthless.
 */

/** Containers the tag writer can actually write. Anything else is reported, not guessed at. */
export const WRITABLE = new Set(['.mp3', '.m4a', '.flac', '.aiff', '.aif']);

export type EntryStatus =
  /** Ready to copy, tag and verify. */
  | 'ready'
  /** The database points at a file that is no longer on disk. */
  | 'missing'
  /** A container the writer cannot tag; copied verbatim, tags skipped. */
  | 'unsupported'
  /**
   * Two tracks resolved to the same target, so this one took a suffixed path.
   * Still migrated — these are the library's existing " 1.mp3" re-downloads,
   * and dropping one silently would lose a file to tidiness. Deduping them by
   * fingerprint is a separate job; the pass's responsibility is to lose nothing.
   */
  | 'collision';

export interface PlanEntry {
  trackId: string;
  source: string;
  target: string;
  status: EntryStatus;
  sizeBytes: number;
  facts: BoothTrackFacts;
  /** Which tag fields this file would receive. Empty is legal but notable. */
  fields: string[];
}

export interface MigrationPlan {
  entries: PlanEntry[];
  byStatus: Record<EntryStatus, number>;
  fieldCounts: Record<string, number>;
  totalBytes: number;
  /** Tracks whose write would be empty — nothing Booth knows that the file doesn't. */
  emptyWrites: number;
}

interface TrackRow {
  trackId: string;
  path: string;
  title: string;
  trackArtist: string;
  albumArtist: string | null;
  album: string | null;
  position: string | null;
  releaseId: string | null;
  starred: string | null;
  note: string | null;
  vetted: string | null;
}

/**
 * Every local file the database knows about, with the facts that would be
 * written into it and where it would land.
 */
export function collectMigrationPlan(
  db: Database,
  opts: { libraryRoot: string; limit?: number },
): MigrationPlan {
  const rows = db
    .prepare(
      `SELECT t.id AS trackId, mk.key_value AS path, t.title AS title,
              ta.name AS trackArtist, ra.name AS albumArtist,
              t.album AS album, t.position AS position,
              t.release_id AS releaseId, t.starred_at AS starred, t.note AS note,
              r.vetted_at AS vetted
         FROM match_key mk
         JOIN track t         ON t.id = mk.entity_id
         JOIN artist ta       ON ta.id = t.artist_id
         LEFT JOIN release r  ON r.id = t.release_id
         LEFT JOIN artist ra  ON ra.id = r.artist_id
        WHERE mk.entity_kind='track' AND mk.key_type='file_path'
        ORDER BY mk.key_value`,
    )
    .all() as TrackRow[];

  const limited = opts.limit != null ? rows.slice(0, opts.limit) : rows;

  const facets = loadFacets(db);
  const discogs = loadDiscogsIds(db);

  const entries: PlanEntry[] = [];
  const byStatus: Record<EntryStatus, number> = {
    ready: 0,
    missing: 0,
    unsupported: 0,
    collision: 0,
  };
  const fieldCounts: Record<string, number> = {};
  const claimed = new Set<string>();
  let totalBytes = 0;
  let emptyWrites = 0;

  for (const row of limited) {
    const f = facets.get(row.trackId) ?? {};
    const facts: BoothTrackFacts = {
      dateAdded: str(f.dateAdded),
      dateAddedReported: str(f.dateAddedReported),
      dateAddedOrigin: str(f.dateAddedOrigin),
      starred: row.starred != null,
      note: row.note ?? undefined,
      vetted: row.vetted != null,
      bpm: typeof f.bpmAnalyzed === 'number' ? f.bpmAnalyzed : undefined,
      origin: str(f.origin),
      discogsReleaseId: row.releaseId ? discogs.get(row.releaseId) : undefined,
    };

    // The tree is derived from the metadata Booth holds, which is what the
    // files' own tags said when they were imported — and then frozen. Paths are
    // never recomputed afterwards: retagging an artist must not move the file,
    // or every external index that stores absolute paths breaks.
    let target = ingestTargetPath(
      opts.libraryRoot,
      {
        albumArtist: row.albumArtist ?? undefined,
        artist: row.trackArtist,
        album: row.album ?? undefined,
        title: row.title,
        trackNumber: row.position != null ? Number(row.position) || undefined : undefined,
      },
      row.path,
    );

    let status: EntryStatus;
    let sizeBytes = 0;
    if (!existsSync(row.path)) {
      status = 'missing';
    } else {
      sizeBytes = statSync(row.path).size;
      if (claimed.has(target)) status = 'collision';
      else if (!WRITABLE.has(extname(row.path).toLowerCase())) status = 'unsupported';
      else status = 'ready';
    }
    if (status === 'collision') target = dedupePath(target, (p) => claimed.has(p));
    if (status !== 'missing') claimed.add(target);

    const fields = fieldsFor(facts);
    // Everything that exists gets copied, including the suffixed duplicates and
    // the containers we cannot tag — only a file that is gone is skipped.
    if (status !== 'missing') {
      totalBytes += sizeBytes;
      if (status !== 'unsupported') {
        for (const field of fields) fieldCounts[field] = (fieldCounts[field] ?? 0) + 1;
        if (fields.length === 0) emptyWrites++;
      }
    }
    byStatus[status]++;

    entries.push({ trackId: row.trackId, source: row.path, target, status, sizeBytes, facts, fields });
  }

  return { entries, byStatus, fieldCounts, totalBytes, emptyWrites };
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function loadFacets(db: Database): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const f of db
    .prepare(
      `SELECT entity_id, key, value FROM source_facets
        WHERE source='local' AND entity_kind='track'`,
    )
    .all() as { entity_id: string; key: string; value: string }[]) {
    const rec = out.get(f.entity_id) ?? {};
    try {
      rec[f.key] = JSON.parse(f.value);
    } catch {
      rec[f.key] = f.value;
    }
    out.set(f.entity_id, rec);
  }
  return out;
}

function loadDiscogsIds(db: Database): Map<string, string> {
  const out = new Map<string, string>();
  for (const d of db
    .prepare(
      `SELECT entity_id, external_id FROM source_link
        WHERE source='discogs' AND entity_kind='release'`,
    )
    .all() as { entity_id: string; external_id: string }[]) {
    out.set(d.entity_id, d.external_id);
  }
  return out;
}

/** Which tag fields a set of facts produces. Derived from `toTagWrite`, never a second list. */
export function fieldsFor(facts: BoothTrackFacts): string[] {
  const w = toTagWrite(facts);
  return [
    ...(w.names ? ['names'] : []),
    ...Object.keys(w.custom),
    ...(w.comment !== undefined ? ['comment'] : []),
    ...(w.bpm !== undefined ? ['bpm'] : []),
    ...(w.ratingStars !== undefined ? ['rating'] : []),
  ];
}
