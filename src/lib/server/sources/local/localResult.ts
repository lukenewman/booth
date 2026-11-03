import type { Database } from 'bun:sqlite';
import { applyCatalogMoves, recordCatalogEntries, type CatalogRef } from '../../library/catalogs';
import { scanFiles, type FileListDeps, type FileScanSummary } from '../../library/fileList';
import type { FileTags } from '../../library/tags';
import type { SourceRelease, SourceTrack } from '../types';
import { ingestedFromFiles } from './ingest';
import { restoreOrphanedCopies } from '../../library/findings';

/**
 * The local source's result, built from the file list.
 *
 * Files come from two places: locations a catalog lists (Music.app today) and
 * Booth's own folder. Every file becomes at most one track, keyed by its
 * file-list id. Where a catalog lists the file, the catalog's names and facets
 * are used, exactly as before this existed. Switching names to the file's own
 * tags comes later, with findings for the cases where they disagree. A file in
 * Booth's folder that no catalog lists is built from its tags.
 *
 * Catalog-listed files that are missing on disk are still emitted, as they
 * were before, so their tracks and everything attached to them stay. A file
 * the user excluded from the needs-attention list is never emitted, so the
 * prune removes its track.
 */

export interface CatalogTrack {
  catalogId: string;
  /** Absolute path, already decoded from the catalog's URL form. */
  path: string;
  track: Omit<SourceTrack, 'externalId' | 'filePath' | 'durableId'>;
}

export interface Catalog {
  id: string;
  tracks: CatalogTrack[];
  releases: SourceRelease[];
}

export interface LocalResult {
  tracks: SourceTrack[];
  releases: SourceRelease[];
  files: FileScanSummary;
  /** Tracks built from Booth's folder rather than a catalog. */
  boothTracked: number;
  /** Every file this sync asked about, excluded ones included (findings filter them). */
  fileIds: string[];
}

export async function buildLocalResult(
  db: Database,
  input: { catalogs: Catalog[]; boothFiles: string[]; groupIdFor: (t: FileTags) => string | undefined },
  deps: FileListDeps,
): Promise<LocalResult> {
  const refsOf = (c: Catalog): CatalogRef[] => c.tracks.map((t) => ({ catalogId: t.catalogId, path: t.path }));

  let catalogMoves = 0;
  for (const c of input.catalogs) catalogMoves += applyCatalogMoves(db, c.id, refsOf(c));

  const wanted = [
    ...input.catalogs.flatMap((c) => c.tracks.map((t) => ({ path: t.path, ownership: 'in_place' as const }))),
    ...input.boothFiles.map((path) => ({ path, ownership: 'booth' as const })),
  ];
  const { files, summary } = await scanFiles(db, wanted, deps);
  summary.moved += catalogMoves;
  for (const c of input.catalogs) recordCatalogEntries(db, c.id, refsOf(c), files);
  restoreOrphanedCopies(db, files);

  const tracks: SourceTrack[] = [];
  const releases = new Map<string, SourceRelease>();
  const emitted = new Set<string>();

  for (const c of input.catalogs) {
    for (const r of c.releases) if (!releases.has(r.externalId)) releases.set(r.externalId, r);
    for (const ct of c.tracks) {
      const file = files.get(ct.path);
      if (!file || file.excluded || emitted.has(file.id)) continue;
      emitted.add(file.id);
      tracks.push({ ...ct.track, externalId: file.id, durableId: true, filePath: file.path });
    }
  }

  const unlisted = input.boothFiles
    .map((path) => files.get(path))
    .filter((f): f is NonNullable<typeof f> => !!f && !f.excluded && !emitted.has(f.id));
  const ingested = ingestedFromFiles(unlisted, input.groupIdFor);
  tracks.push(...ingested.tracks);
  for (const r of ingested.releases) if (!releases.has(r.externalId)) releases.set(r.externalId, r);

  return {
    tracks,
    releases: [...releases.values()],
    files: summary,
    boothTracked: ingested.tracks.length,
    fileIds: [...new Set([...files.values()].map((f) => f.id))],
  };
}
