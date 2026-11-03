import type { Database } from 'bun:sqlite';
import type { FileRow } from './fileList';

/**
 * What catalogs (Music.app now, rekordbox later) say about where files are.
 *
 * A catalog never creates a track. It lists files by location under its own
 * id, and that id is the cheapest way to recognise a file the catalog moved:
 * Music.app renames folders when tags change, and its Persistent ID stays put.
 * Fingerprints (fileList.ts) cover the same case when a catalog's id churns
 * too.
 */

export interface CatalogRef {
  catalogId: string;
  path: string;
}

/**
 * Before scanning: where a catalog lists a known id at a new location, carry
 * the file row to that location. Refused when another file already holds the
 * new path, or when the row has already moved away from where this catalog
 * last saw it. Returns how many rows moved.
 */
export function applyCatalogMoves(db: Database, catalog: string, refs: CatalogRef[]): number {
  const prevOf = db.prepare(
    `SELECT ce.location, f.id AS fileId, f.path
       FROM catalog_entry ce JOIN audio_file f ON f.id = ce.file_id
      WHERE ce.catalog = ? AND ce.catalog_id = ?`,
  );
  const taken = db.prepare(`SELECT 1 FROM audio_file WHERE path = ?`);
  const move = db.prepare(`UPDATE audio_file SET path = ? WHERE id = ?`);

  let moved = 0;
  db.transaction(() => {
    for (const r of refs) {
      const prev = prevOf.get(catalog, r.catalogId) as { location: string; fileId: string; path: string } | null;
      if (!prev || prev.location === r.path) continue;
      if (prev.path !== prev.location) continue;
      if (taken.get(r.path)) continue;
      move.run(r.path, prev.fileId);
      moved++;
    }
  })();
  return moved;
}

/**
 * After scanning: record which file each listing points at, and forget
 * listings this catalog no longer has. The file rows themselves stay.
 */
export function recordCatalogEntries(
  db: Database,
  catalog: string,
  refs: CatalogRef[],
  files: Map<string, FileRow>,
): void {
  const stamp = new Date().toISOString();
  const upsert = db.prepare(
    `INSERT INTO catalog_entry (catalog, catalog_id, file_id, location, seen_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(catalog, catalog_id) DO UPDATE SET file_id = excluded.file_id, location = excluded.location, seen_at = excluded.seen_at`,
  );
  // Swept by id, not by timestamp: two runs inside one millisecond would
  // share a stamp and the sweep would keep listings that are gone.
  const listed = new Set(refs.map((r) => r.catalogId));
  const drop = db.prepare(`DELETE FROM catalog_entry WHERE catalog = ? AND catalog_id = ?`);
  db.transaction(() => {
    for (const r of refs) {
      const file = files.get(r.path);
      if (file) upsert.run(catalog, r.catalogId, file.id, r.path, stamp);
    }
    for (const { catalog_id } of db.prepare(`SELECT catalog_id FROM catalog_entry WHERE catalog = ?`).all(catalog) as { catalog_id: string }[]) {
      if (!listed.has(catalog_id)) drop.run(catalog, catalog_id);
    }
  })();
}
