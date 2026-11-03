import type { Database } from 'bun:sqlite';
import { existsSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FileTags } from '../library/tags';
import { factsForTrack, TakeoverError } from './engine';
import { tagDifferences, type TagDifference } from './rebuild';

/**
 * Handing a release back, and checking a taken-over release against its tags.
 *
 * Undo points the release's tracks back at the originals and deletes Booth's
 * copies. It needs every original still there with the audio Booth recorded
 * for it, and refuses otherwise, deleting nothing: a copy is the only file
 * left when its original is gone. Stars, notes and playlists are Booth's own
 * facts on the track and are untouched.
 */

interface CopyRow { trackId: string; copyId: string; copyPath: string; originalId: string; originalPath: string; originalFingerprint: string | null }

function copiesOf(db: Database, releaseId: string): CopyRow[] {
  return db
    .prepare(
      `SELECT t.id AS trackId, c.id AS copyId, c.path AS copyPath, o.id AS originalId, o.path AS originalPath, o.fingerprint AS originalFingerprint
         FROM track t
         JOIN source_link sl ON sl.source = 'local' AND sl.entity_kind = 'track' AND sl.entity_id = t.id
         JOIN audio_file c ON c.id = sl.external_id AND c.copy_of IS NOT NULL AND c.ownership = 'booth'
         JOIN audio_file o ON o.id = c.copy_of
        WHERE t.release_id = ?`,
    )
    .all(releaseId) as CopyRow[];
}

export interface UndoPreview {
  files: { copy: string; original: string }[];
  /** What exists only in the copies and goes with them. Empty until Booth writes edits into owned files (6b). */
  lost: string[];
}

export function undoPreview(db: Database, releaseId: string): UndoPreview {
  return { files: copiesOf(db, releaseId).map((r) => ({ copy: r.copyPath, original: r.originalPath })), lost: [] };
}

export async function undoRelease(db: Database, deps: { fingerprint(path: string): Promise<string> }, releaseId: string): Promise<void> {
  const rows = copiesOf(db, releaseId);
  if (!rows.length) throw new TakeoverError('This release isn’t taken over.');
  for (const r of rows) {
    if (!existsSync(r.originalPath)) throw new TakeoverError(`The original isn’t there any more, so the copy is all that’s left: ${r.originalPath}`);
    if (r.originalFingerprint) {
      let now: string | null = null;
      try { now = await deps.fingerprint(r.originalPath); } catch { now = null; }
      if (now !== r.originalFingerprint) throw new TakeoverError(`The original’s audio isn’t what Booth copied: ${r.originalPath}`);
    }
  }
  const repoint = db.prepare(`UPDATE source_link SET external_id = ? WHERE source = 'local' AND entity_kind = 'track' AND external_id = ?`);
  db.transaction(() => {
    for (const r of rows) {
      repoint.run(r.originalId, r.copyId);
      db.prepare(`DELETE FROM audio_file WHERE id = ? AND ownership = 'booth' AND copy_of IS NOT NULL`).run(r.copyId);
    }
    db.prepare(
      `UPDATE takeover_release SET state = 'undone', finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE release_id = ? AND state = 'done'`,
    ).run(releaseId);
  })();
  for (const r of rows) {
    try { unlinkSync(r.copyPath); } catch { /* already gone */ }
    // Folders the copies leave empty go too; stop at the first that isn't.
    for (let d = dirname(r.copyPath); ; d = dirname(d)) {
      try {
        const left = readdirSync(d).filter((n) => n !== '.DS_Store');
        if (left.length) break;
        if (existsSync(`${d}/.DS_Store`)) unlinkSync(`${d}/.DS_Store`);
        rmdirSync(d);
      } catch { break; }
      if (d === dirname(d)) break;
    }
  }
}

export interface RebuildCheck { matches: boolean; files: number; differences: (TagDifference & { trackId: string; path: string })[] }

/** Read each copy's tags and compare them with what Booth knows: the restore test, per release. */
export async function rebuildCheck(db: Database, releaseId: string, deps: { readTags(path: string): Promise<FileTags> }): Promise<RebuildCheck> {
  const out: RebuildCheck = { matches: true, files: 0, differences: [] };
  for (const r of copiesOf(db, releaseId)) {
    out.files++;
    let tags: FileTags;
    try { tags = await deps.readTags(r.copyPath); } catch (e) {
      out.differences.push({ trackId: r.trackId, path: r.copyPath, field: 'file', expected: 'readable', got: e instanceof Error ? e.message : String(e) });
      continue;
    }
    // A verbatim copy (WAV) carries no Booth tags; its facts live in the database.
    if (!Object.keys(tags.booth).length && !/\.(mp3|m4a|flac|aiff?)$/i.test(r.copyPath)) continue;
    for (const d of tagDifferences(factsForTrack(db, r.trackId), tags)) out.differences.push({ ...d, trackId: r.trackId, path: r.copyPath });
  }
  out.matches = out.differences.length === 0;
  return out;
}
