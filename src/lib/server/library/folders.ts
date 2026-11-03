import type { Database } from 'bun:sqlite';
import { readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
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

export function addFolderSource(db: Database, path: string): FolderSource {
  const resolved = resolve(path).replace(/\/+$/, '') || '/';
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

const under = (root: string) => `substr(f.path, 1, ${root.length + 1}) = ?`;

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
  const otherClauses = others.map((o) => `AND NOT ${under(o.path)}`).join(' ');
  const rows = db
    .prepare(
      `SELECT t.id, t.starred_at, t.note,
              EXISTS (SELECT 1 FROM playlist_track pt WHERE pt.track_id = t.id) AS listed
         FROM audio_file f
         JOIN source_link sl ON sl.source = 'local' AND sl.entity_kind = 'track' AND sl.external_id = f.id
         JOIN track t ON t.id = sl.entity_id
        WHERE ${under(folder.path)} ${otherClauses}
          AND f.ownership = 'in_place'
          AND NOT EXISTS (SELECT 1 FROM catalog_entry ce WHERE ce.file_id = f.id)`,
    )
    .all(folder.path + '/', ...others.map((o) => o.path + '/')) as { id: string; starred_at: string | null; note: string | null; listed: number }[];
  return {
    tracks: rows.length,
    starred: rows.filter((r) => r.starred_at).length,
    withNotes: rows.filter((r) => r.note).length,
    inPlaylists: rows.filter((r) => r.listed).length,
  };
}
