import type { Database } from 'bun:sqlite';
import { applyCatalogMoves, recordCatalogEntries, type CatalogRef } from '../../library/catalogs';
import { copiesByOriginal, trackedFilesUnder, knownPathsByNfc, scanFiles, type FileListDeps, type FileRow, type FileScanSummary } from '../../library/fileList';
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

/** A folder source as the sync found it. An offline folder (unplugged drive) has no files listed. */
export interface FolderInput {
  root: string;
  files: string[];
  online: boolean;
}

export interface LocalResult {
  tracks: SourceTrack[];
  releases: SourceRelease[];
  files: FileScanSummary;
  /** Tracks built from Booth's folder rather than a catalog. */
  boothTracked: number;
  /** Every file this sync asked about, excluded ones included (findings filter them). */
  fileIds: string[];
  /** Each folder source: how many files, and whether it could be read. */
  folders: { root: string; files: number; online: boolean }[];
  /** Files under offline folders: kept as they were, and findings about them are left alone. */
  offlineFileIds: string[];
}

export async function buildLocalResult(
  db: Database,
  input: { catalogs: Catalog[]; boothFiles: string[]; folders?: FolderInput[]; groupIdFor: (t: FileTags) => string | undefined },
  deps: FileListDeps,
): Promise<LocalResult> {
  // One file, one row, however each place spells its name: Music.app writes
  // some names decomposed, a folder walk returns them as stored on disk, and
  // the file system treats both as the same file. The file list's existing
  // spelling wins, then the first place to name it.
  const known = knownPathsByNfc(db);
  const chosen = new Map<string, string>();
  const canon = (path: string) => {
    const k = path.normalize('NFC');
    let s = chosen.get(k);
    if (!s) { s = known.get(k) ?? path; chosen.set(k, s); }
    return s;
  };
  const catalogs = input.catalogs.map((c) => ({ ...c, tracks: c.tracks.map((t) => ({ ...t, path: canon(t.path) })) }));
  const boothFiles = input.boothFiles.map(canon);
  // A folder that can't be read is offline. So is one that reads as empty
  // while tracks still come from it: an empty mount point (drive not
  // attached, share not mounted) looks exactly like that, and pruning on it
  // would take every star on the drive. Removing the folder is how its
  // tracks really go.
  const folders = (input.folders ?? []).map((f) => {
    const kept = f.online && f.files.length > 0 ? [] : trackedFilesUnder(db, f.root);
    const online = f.online && (f.files.length > 0 || kept.length === 0);
    return { ...f, online, files: online ? f.files.map(canon) : [], kept: online ? [] : kept };
  });
  const offlineRows = folders.flatMap((f) => f.kept);

  const refsOf = (c: Catalog): CatalogRef[] => c.tracks.map((t) => ({ catalogId: t.catalogId, path: t.path }));

  let catalogMoves = 0;
  for (const c of catalogs) catalogMoves += applyCatalogMoves(db, c.id, refsOf(c));

  // Booth's copies are always asked about, so a copy that went missing is
  // seen as missing rather than quietly not listed by the folder walk.
  const copies = copiesByOriginal(db);
  const wanted = [
    ...catalogs.flatMap((c) => c.tracks.map((t) => ({ path: t.path, ownership: 'in_place' as const }))),
    ...boothFiles.map((path) => ({ path, ownership: 'booth' as const })),
    ...[...copies.values()].map((c) => ({ path: c.path, ownership: 'booth' as const })),
    ...folders.filter((f) => f.online).flatMap((f) => f.files.map((path) => ({ path, ownership: 'in_place' as const }))),
  ];
  const { files, summary } = await scanFiles(db, wanted, deps);
  summary.moved += catalogMoves;
  for (const c of catalogs) recordCatalogEntries(db, c.id, refsOf(c), files);
  restoreOrphanedCopies(db, files, offlineRows);

  const tracks: SourceTrack[] = [];
  const releases = new Map<string, SourceRelease>();
  const emitted = new Set<string>();
  /** The file a track should point at: the original, or Booth's copy once it was taken over. */
  const standIn = (f: FileRow | undefined): FileRow | undefined => {
    const c = f && copies.get(f.id);
    return (c && files.get(c.path)) || f;
  };

  for (const c of catalogs) {
    for (const r of c.releases) if (!releases.has(r.externalId)) releases.set(r.externalId, r);
    for (const ct of c.tracks) {
      const file = standIn(files.get(ct.path));
      if (!file || file.excluded || emitted.has(file.id)) continue;
      emitted.add(file.id);
      tracks.push({ ...ct.track, externalId: file.id, durableId: true, filePath: file.path });
    }
  }

  const unlisted = (rows: (FileRow | undefined)[]) => {
    const out: FileRow[] = [];
    for (const row of rows) {
      const f = standIn(row);
      if (!f || f.excluded || emitted.has(f.id)) continue;
      emitted.add(f.id);
      out.push(f);
    }
    return out;
  };
  const ingested = ingestedFromFiles(unlisted(boothFiles.map((path) => files.get(path))), input.groupIdFor);
  // A folder that can't be read right now (an unplugged drive) keeps its
  // tracks as they were: emitted from the file list without a scan, and left
  // out of findings, so a drive coming and going never prunes or floods.
  const folderFiles = folders.flatMap((f) => (f.online ? f.files.map((path) => files.get(path)) : f.kept));
  const fromFolders = ingestedFromFiles(unlisted(folderFiles), input.groupIdFor, 'folder');
  for (const built of [ingested, fromFolders]) {
    tracks.push(...built.tracks);
    for (const r of built.releases) if (!releases.has(r.externalId)) releases.set(r.externalId, r);
  }

  return {
    tracks,
    releases: [...releases.values()],
    files: summary,
    boothTracked: ingested.tracks.length,
    fileIds: [...new Set([...files.values()].map((f) => f.id))],
    folders: folders.map((f) => ({ root: f.root, files: f.online ? f.files.length : f.kept.length, online: f.online })),
    offlineFileIds: offlineRows.map((f) => f.id),
  };
}
