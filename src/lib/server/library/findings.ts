import type { Database } from 'bun:sqlite';
import { ulid } from 'ulid';

/**
 * The "needs attention" list: problems in the local library that need a
 * person. Raised by every local sync, about the files that sync asked about.
 *
 * Booth only ever changes a finding on its own when the problem itself went
 * away (the file came back, the duplicate is gone): that's "cleared", and the
 * same problem returning reopens the same row. What the user settled stays
 * settled for that exact subject. A duplicate's subject includes every file
 * in it, so a third copy is a new finding rather than a reopened one.
 */

export type FindingKind = 'missing' | 'duplicate' | 'unsupported';
export type FindingState = 'open' | 'settled' | 'cleared';

export interface FindingsSummary {
  /** Findings opened (or reopened) by this run. */
  new: number;
  /** Open findings whose problem went away. */
  cleared: number;
  /** Open findings after this run. */
  open: number;
}

interface Problem { kind: FindingKind; key: string; fileIds: string[] }

const now = () => new Date().toISOString();

function currentProblems(db: Database, fileIds: string[]): Problem[] {
  if (fileIds.length === 0) return [];
  db.exec(`CREATE TEMP TABLE IF NOT EXISTS finding_scope (id TEXT PRIMARY KEY)`);
  db.exec(`DELETE FROM finding_scope`);
  const ins = db.prepare(`INSERT OR IGNORE INTO finding_scope (id) VALUES (?)`);
  db.transaction(() => { for (const id of fileIds) ins.run(id); })();

  const rows = db
    .prepare(
      `SELECT f.id, f.present, f.tags IS NULL AS untagged, f.fingerprint
         FROM audio_file f JOIN finding_scope s ON s.id = f.id
        WHERE f.excluded = 0`,
    )
    .all() as { id: string; present: number; untagged: number; fingerprint: string | null }[];

  const problems: Problem[] = [];
  const byPrint = new Map<string, string[]>();
  for (const r of rows) {
    if (r.present === 0) { problems.push({ kind: 'missing', key: r.id, fileIds: [r.id] }); continue; }
    if (r.untagged === 1) problems.push({ kind: 'unsupported', key: r.id, fileIds: [r.id] });
    if (r.fingerprint) byPrint.set(r.fingerprint, [...(byPrint.get(r.fingerprint) ?? []), r.id]);
  }
  for (const [print, ids] of byPrint) {
    if (ids.length < 2) continue;
    const sorted = [...ids].sort();
    problems.push({ kind: 'duplicate', key: `${print}:${sorted.join(',')}`, fileIds: sorted });
  }
  return problems;
}

export function refreshFindings(db: Database, runId: string | null, fileIds: string[]): FindingsSummary {
  const summary: FindingsSummary = { new: 0, cleared: 0, open: 0 };
  const problems = currentProblems(db, fileIds);
  const current = new Set(problems.map((p) => `${p.kind}\u0000${p.key}`));

  const existing = db.prepare(`SELECT id, state FROM finding WHERE kind = ? AND subject_key = ?`);
  const insert = db.prepare(`INSERT INTO finding (id, kind, subject_key, file_ids, raised_run_id) VALUES (?, ?, ?, ?, ?)`);
  const reopen = db.prepare(
    `UPDATE finding SET state = 'open', file_ids = ?, raised_run_id = ?, raised_at = ?, cleared_at = NULL WHERE id = ?`,
  );
  const clear = db.prepare(`UPDATE finding SET state = 'cleared', cleared_at = ? WHERE id = ?`);

  db.transaction(() => {
    for (const p of problems) {
      const row = existing.get(p.kind, p.key) as { id: string; state: FindingState } | null;
      if (!row) {
        insert.run(ulid(), p.kind, p.key, JSON.stringify(p.fileIds), runId);
        summary.new++;
      } else if (row.state === 'cleared') {
        reopen.run(JSON.stringify(p.fileIds), runId, now(), row.id);
        summary.new++;
      }
    }
    const open = db.prepare(`SELECT id, kind, subject_key FROM finding WHERE state = 'open'`).all() as { id: string; kind: string; subject_key: string }[];
    for (const f of open) {
      if (!current.has(`${f.kind}\u0000${f.subject_key}`)) { clear.run(now(), f.id); summary.cleared++; }
    }
  })();

  summary.open = (db.prepare(`SELECT COUNT(*) AS n FROM finding WHERE state = 'open'`).get() as { n: number }).n;
  return summary;
}

export class FindingError extends Error {}

export type SettleAction =
  | { type: 'keep_both' }
  | { type: 'keep_one'; fileId: string }
  | { type: 'leave' }
  | { type: 'forget' }
  | { type: 'acknowledge' };

const ACTIONS: Record<FindingKind, SettleAction['type'][]> = {
  duplicate: ['keep_both', 'keep_one'],
  missing: ['leave', 'forget'],
  unsupported: ['acknowledge'],
};
/** What "settle all like this" does per kind: never anything that removes a track. */
const BULK: Record<FindingKind, SettleAction['type']> = { duplicate: 'keep_both', missing: 'leave', unsupported: 'acknowledge' };

export interface FindingFile {
  fileId: string;
  path: string;
  present: boolean;
  track: { id: string; title: string; artist: string; album: string | null } | null;
  starred: boolean;
  note: string | null;
  playlists: string[];
}
export interface FindingView { id: string; kind: FindingKind; raisedAt: string; files: FindingFile[] }

function trackIdOf(db: Database, fileId: string): string | null {
  const r = db.prepare(`SELECT entity_id FROM source_link WHERE source = 'local' AND entity_kind = 'track' AND external_id = ?`).get(fileId) as { entity_id: string } | null;
  return r?.entity_id ?? null;
}

function fileView(db: Database, fileId: string): FindingFile | null {
  const f = db.prepare(`SELECT id, path, present FROM audio_file WHERE id = ?`).get(fileId) as { id: string; path: string; present: number } | null;
  if (!f) return null;
  const tid = trackIdOf(db, fileId);
  const t = tid
    ? (db.prepare(
        `SELECT track.id, track.title, artist.name AS artist, track.album, track.starred_at, track.note
           FROM track JOIN artist ON artist.id = track.artist_id WHERE track.id = ?`,
      ).get(tid) as { id: string; title: string; artist: string; album: string | null; starred_at: string | null; note: string | null } | null)
    : null;
  const playlists = t
    ? (db.prepare(
        `SELECT DISTINCT pl.name FROM playlist_track pt JOIN playlist pl ON pl.id = pt.playlist_id WHERE pt.track_id = ? ORDER BY pl.name`,
      ).all(t.id) as { name: string }[]).map((r) => r.name)
    : [];
  return {
    fileId: f.id,
    path: f.path,
    present: f.present === 1,
    track: t ? { id: t.id, title: t.title, artist: t.artist, album: t.album } : null,
    starred: !!t?.starred_at,
    note: t?.note ?? null,
    playlists,
  };
}

export function listOpenFindings(db: Database): FindingView[] {
  const rows = db
    .prepare(`SELECT id, kind, raised_at, file_ids FROM finding WHERE state = 'open' ORDER BY kind, raised_at`)
    .all() as { id: string; kind: FindingKind; raised_at: string; file_ids: string }[];
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    raisedAt: r.raised_at,
    files: (JSON.parse(r.file_ids) as string[]).map((id) => fileView(db, id)).filter((f): f is FindingFile => !!f),
  }));
}

export function openFindingCount(db: Database): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM finding WHERE state = 'open'`).get() as { n: number }).n;
}

/** Move what the user put on `from` onto `to`: starred anywhere counts, notes are kept side by side, playlist entries follow. */
function moveAnnotations(db: Database, from: string, to: string): void {
  const a = db.prepare(`SELECT starred_at, note FROM track WHERE id = ?`).get(from) as { starred_at: string | null; note: string | null } | null;
  const b = db.prepare(`SELECT starred_at, note FROM track WHERE id = ?`).get(to) as { starred_at: string | null; note: string | null } | null;
  if (!a || !b) return;
  const note = !a.note ? b.note : !b.note || b.note === a.note ? a.note : `${b.note}\n\n${a.note}`;
  db.prepare(`UPDATE track SET starred_at = COALESCE(starred_at, ?), note = ? WHERE id = ?`).run(a.starred_at, note, to);
  // One entry per track per playlist: where the kept track is already there, the moved entry goes.
  db.prepare(
    `DELETE FROM playlist_track WHERE track_id = ? AND playlist_id IN (SELECT playlist_id FROM playlist_track WHERE track_id = ?)`,
  ).run(from, to);
  db.prepare(`UPDATE playlist_track SET track_id = ? WHERE track_id = ?`).run(to, from);
}

function settle(db: Database, id: string, resolution: string): void {
  db.prepare(`UPDATE finding SET state = 'settled', resolution = ?, settled_at = ? WHERE id = ?`).run(resolution, now(), id);
}

export function settleFinding(db: Database, id: string, action: SettleAction): { needsSync: boolean } {
  const f = db.prepare(`SELECT kind, state, file_ids FROM finding WHERE id = ?`).get(id) as { kind: FindingKind; state: FindingState; file_ids: string } | null;
  if (!f) throw new FindingError(`no such finding: ${id}`);
  if (f.state !== 'open') throw new FindingError('this finding is no longer open');
  if (!ACTIONS[f.kind].includes(action.type)) throw new FindingError(`${action.type} doesn't apply to a ${f.kind} finding`);
  const fileIds = JSON.parse(f.file_ids) as string[];
  const exclude = db.prepare(`UPDATE audio_file SET excluded = 1 WHERE id = ?`);

  let needsSync = false;
  db.transaction(() => {
    if (action.type === 'keep_one') {
      if (!fileIds.includes(action.fileId)) throw new FindingError('that file is not part of this finding');
      const keptTrack = trackIdOf(db, action.fileId);
      for (const other of fileIds) {
        if (other === action.fileId) continue;
        const from = trackIdOf(db, other);
        if (from && keptTrack && from !== keptTrack) moveAnnotations(db, from, keptTrack);
        exclude.run(other);
      }
      settle(db, id, `keep_one:${action.fileId}`);
      needsSync = true;
    } else if (action.type === 'forget') {
      const tid = trackIdOf(db, fileIds[0]);
      // The user saw these entries before confirming; left in place, the
      // relinker would re-attach them by name to some other track.
      if (tid) db.prepare(`DELETE FROM playlist_track WHERE track_id = ?`).run(tid);
      exclude.run(fileIds[0]);
      settle(db, id, 'forget');
      needsSync = true;
    } else {
      settle(db, id, action.type);
    }
  })();
  return { needsSync };
}

/** "Settle all like this": the kind's non-destructive action on every open finding of that kind. Returns how many. */
export function settleAllOfKind(db: Database, kind: FindingKind): number {
  const res = db
    .prepare(`UPDATE finding SET state = 'settled', resolution = ?, settled_at = ? WHERE kind = ? AND state = 'open'`)
    .run(BULK[kind], now(), kind);
  return res.changes;
}
