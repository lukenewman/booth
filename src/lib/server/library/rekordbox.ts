import type { Database } from 'bun:sqlite';
import { readFileSync, statSync } from 'node:fs';
import type { RekordboxTrack } from '../cdj/rekordbox-xml';

/**
 * rekordbox as a catalog source: its collection export describes files by
 * location, and what it knows about each (tempo, key, beat grid, cues, rating,
 * plays, date added) is attached to the Booth track whose file sits there.
 * It never creates a track; entries with no Booth track are reported instead.
 *
 * Facts are stored as track facets under source 'rekordbox', which the BPM
 * resolver already ranks first. Paths are compared Unicode-normalised:
 * Music.app names some files decomposed and rekordbox writes them composed,
 * and the file system treats both spellings as one file.
 */

export interface RekordboxImportSummary {
  path: string;
  /** Distinct files the export lists. */
  entries: number;
  matched: number;
  withGrid: number;
  withCues: number;
  unmatchedCount: number;
  /** The first entries with no Booth track (capped, for the panel). */
  unmatched: { path: string; title: string | null; artist: string | null }[];
}

const SOURCE = 'rekordbox';
const UNMATCHED_SHOWN = 100;

function factsOf(t: RekordboxTrack): Record<string, unknown> {
  const facts: Record<string, unknown> = {};
  if (t.bpm != null) facts.bpm = t.bpm;
  if (t.key) facts.key = t.key;
  if (t.grid.length) facts.grid = t.grid;
  if (t.cues.length) facts.cues = t.cues;
  if (t.rating != null) facts.rating = t.rating;
  if (t.playCount != null) facts.playCount = t.playCount;
  if (t.dateAdded) facts.dateAdded = t.dateAdded;
  return facts;
}

export function importRekordbox(db: Database, xmlPath: string, tracks: RekordboxTrack[]): RekordboxImportSummary {
  const trackByPath = new Map<string, string>();
  for (const r of db
    .prepare(
      `SELECT f.path, sl.entity_id FROM audio_file f
         JOIN source_link sl ON sl.source = 'local' AND sl.entity_kind = 'track' AND sl.external_id = f.id
        WHERE f.excluded = 0`,
    )
    .all() as { path: string; entity_id: string }[]) {
    trackByPath.set(r.path.normalize('NFC'), r.entity_id);
  }

  const summary: RekordboxImportSummary = {
    path: xmlPath, entries: 0, matched: 0, withGrid: 0, withCues: 0, unmatchedCount: 0, unmatched: [],
  };
  // rekordbox can list one file twice; the last entry wins, and each file is
  // counted once.
  const byFile = new Map<string, RekordboxTrack>();
  for (const t of tracks) byFile.set(t.path.normalize('NFC'), t);
  summary.entries = byFile.size;
  const factsByTrack = new Map<string, Record<string, unknown>>();
  for (const [path, t] of byFile) {
    const trackId = trackByPath.get(path);
    if (!trackId) {
      summary.unmatchedCount++;
      if (summary.unmatched.length < UNMATCHED_SHOWN) summary.unmatched.push({ path: t.path, title: t.title, artist: t.artist });
      continue;
    }
    if (factsByTrack.has(trackId)) continue;
    summary.matched++;
    if (t.grid.length) summary.withGrid++;
    if (t.cues.length) summary.withCues++;
    factsByTrack.set(trackId, factsOf(t));
  }

  const existing = db.prepare(`SELECT entity_id, key FROM source_facets WHERE entity_kind = 'track' AND source = ?`).all(SOURCE) as { entity_id: string; key: string }[];
  // Unchanged values aren't rewritten, so a re-import of the same export is a no-op.
  const upsert = db.prepare(
    `INSERT INTO source_facets (entity_kind, entity_id, source, key, value) VALUES ('track', ?, ?, ?, ?)
     ON CONFLICT (entity_kind, entity_id, source, key) DO UPDATE
       SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE source_facets.value <> excluded.value`,
  );
  const drop = db.prepare(`DELETE FROM source_facets WHERE entity_kind = 'track' AND entity_id = ? AND source = ? AND key = ?`);
  db.transaction(() => {
    for (const [trackId, facts] of factsByTrack) {
      for (const [key, value] of Object.entries(facts)) upsert.run(trackId, SOURCE, key, JSON.stringify(value));
    }
    for (const e of existing) {
      if (!(e.key in (factsByTrack.get(e.entity_id) ?? {}))) drop.run(e.entity_id, SOURCE, e.key);
    }
  })();
  return summary;
}

export type RekordboxXmlCheck =
  | { ok: true; path: string; trackCount: number; modifiedAt: string }
  | { ok: false; path: string; problem: 'missing' | 'no_permission' | 'not_an_export' };

/** Where rekordbox's File → Export Collection in xml format suggests saving. */
export function defaultRekordboxXmlPath(home: string): string {
  return `${home}/Documents/rekordbox.xml`;
}

/** Confirm a file is a rekordbox collection export. A text check: the sync parses it properly. */
export function checkRekordboxXml(path: string): RekordboxXmlCheck {
  let text: string;
  let modifiedAt: string;
  try {
    modifiedAt = statSync(path).mtime.toISOString();
    text = readFileSync(path, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, path, problem: 'missing' };
    if (code === 'EPERM' || code === 'EACCES') return { ok: false, path, problem: 'no_permission' };
    return { ok: false, path, problem: 'not_an_export' };
  }
  if (!text.includes('<DJ_PLAYLISTS') || !text.includes('<COLLECTION')) return { ok: false, path, problem: 'not_an_export' };
  const trackCount = (text.match(/<TRACK\s[^>]*TrackID=/g) ?? []).length;
  return { ok: true, path, trackCount, modifiedAt };
}

/** The rekordbox part of the most recent local sync that read it. */
export function lastRekordboxImport(db: Database): (RekordboxImportSummary | { path: string; error: string }) & { at: string } | null {
  const rows = db
    .prepare(`SELECT finished_at, summary FROM sync_run WHERE source = 'local' AND summary LIKE '%"rekordbox"%' ORDER BY started_at DESC LIMIT 1`)
    .all() as { finished_at: string; summary: string }[];
  if (!rows.length) return null;
  try {
    const s = JSON.parse(rows[0].summary) as { rekordbox?: RekordboxImportSummary | { path: string; error: string } };
    return s.rekordbox ? { ...s.rekordbox, at: rows[0].finished_at } : null;
  } catch {
    return null;
  }
}

/** Disconnected: rekordbox's facts leave every track, so nothing it said still decides a BPM. */
export function clearRekordboxFacts(db: Database): number {
  return db.prepare(`DELETE FROM source_facets WHERE source = ?`).run(SOURCE).changes;
}
