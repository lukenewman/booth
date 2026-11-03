import type { Database } from 'bun:sqlite';
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, sep } from 'node:path';
import { isUnder } from './fileList';
import { ulid } from 'ulid';

/**
 * Folder sources: folders the user pointed Booth at. The local sync walks
 * each one and puts every audio file in the file list, read in place. A file
 * a catalog also lists stays one track with the catalog's names; a file only
 * a folder reaches becomes a track from its own tags.
 */

export interface FolderSource { id: string; path: string; addedAt: string }

export class FolderError extends Error {}

export function listFolderSources(db: Database): FolderSource[] {
  return db.prepare(`SELECT id, path, added_at AS addedAt FROM folder_source ORDER BY path`).all() as FolderSource[];
}

/** Can the sync read this folder right now? An unplugged drive can't. */
export function folderIsReadable(path: string): boolean {
  try {
    if (!statSync(path).isDirectory()) return false;
    readdirSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * `forbidden`: Booth's own places (its folder, the drop folder, its data),
 * which are never folder sources. The whole disk and the home folder are
 * refused too: walked on every sync, they'd pick up everything, downloads in
 * progress included.
 */
export function addFolderSource(db: Database, path: string, opts: { forbidden?: string[] } = {}): FolderSource {
  const resolved = resolve(path).replace(/\/+$/, '') || '/';
  if (resolved === '/' || resolved === homedir()) throw new FolderError('That’s too broad. Pick the folder your music is in.');
  for (const f of opts.forbidden ?? []) {
    const r = resolve(f);
    if (resolved === r || resolved.startsWith(r + sep) || r.startsWith(resolved + sep)) throw new FolderError('Booth already looks after that folder.');
  }
  if (!folderIsReadable(resolved)) throw new FolderError('That folder doesn’t exist, or Booth can’t read it.');
  const existing = db.prepare(`SELECT id, path, added_at AS addedAt FROM folder_source WHERE path = ?`).get(resolved) as FolderSource | null;
  if (existing) return existing;
  const id = ulid();
  db.prepare(`INSERT INTO folder_source (id, path) VALUES (?, ?)`).run(id, resolved);
  return db.prepare(`SELECT id, path, added_at AS addedAt FROM folder_source WHERE id = ?`).get(id) as FolderSource;
}

export function removeFolderSource(db: Database, id: string): void {
  db.prepare(`DELETE FROM folder_source WHERE id = ?`).run(id);
}

export interface FolderRemovalImpact { tracks: number; starred: number; withNotes: number; inPlaylists: number }

/**
 * What removing a folder takes out of the library: tracks whose file only
 * this folder reaches (no catalog lists it, it isn't Booth's, and no other
 * folder source covers it), and what the user put on them.
 */
export function folderRemovalImpact(db: Database, id: string): FolderRemovalImpact {
  const folder = db.prepare(`SELECT path FROM folder_source WHERE id = ?`).get(id) as { path: string } | null;
  if (!folder) throw new FolderError('No such folder.');
  const others = listFolderSources(db).filter((f) => f.id !== id && f.path !== folder.path);
  // A track another source also links (Discogs) stays when its file goes.
  const rows = (db
    .prepare(
      `SELECT f.path, t.id, t.starred_at, t.note,
              EXISTS (SELECT 1 FROM playlist_track pt WHERE pt.track_id = t.id) AS listed
         FROM audio_file f
         JOIN source_link sl ON sl.source = 'local' AND sl.entity_kind = 'track' AND sl.external_id = f.id
         JOIN track t ON t.id = sl.entity_id
        WHERE f.ownership = 'in_place'
          AND NOT EXISTS (SELECT 1 FROM catalog_entry ce WHERE ce.file_id = f.id)
          AND NOT EXISTS (SELECT 1 FROM source_link o WHERE o.entity_kind = 'track' AND o.entity_id = t.id AND o.source <> 'local')`,
    )
    .all() as { path: string; id: string; starred_at: string | null; note: string | null; listed: number }[])
    .filter((r) => isUnder(r.path, folder.path) && !others.some((o) => isUnder(r.path, o.path)));
  return {
    tracks: rows.length,
    starred: rows.filter((r) => r.starred_at).length,
    withNotes: rows.filter((r) => r.note).length,
    inPlaylists: rows.filter((r) => r.listed).length,
  };
}

/** Each folder source with its file count and reachability from the most recent local sync that walked it. */
export function folderStatus(db: Database): (FolderSource & { files: number | null; online: boolean | null })[] {
  const row = db
    .prepare(`SELECT summary FROM sync_run WHERE source = 'local' AND summary LIKE '%"folders"%' ORDER BY started_at DESC LIMIT 1`)
    .get() as { summary: string } | null;
  let seen: { root: string; files: number; online: boolean }[] = [];
  try { seen = row ? (JSON.parse(row.summary).folders ?? []) : []; } catch { seen = []; }
  return listFolderSources(db).map((f) => {
    const s = seen.find((x) => x.root === f.path);
    return { ...f, files: s?.files ?? null, online: s?.online ?? null };
  });
}
