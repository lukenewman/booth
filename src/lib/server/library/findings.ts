import type { Database } from 'bun:sqlite';
import { ulid } from 'ulid';
import type { FileRow } from './fileList';

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

export type FindingKind = 'missing' | 'duplicate' | 'unsupported' | 'takeover';
/** The kinds a sync raises and clears; a takeover finding is the takeover engine's. */
const SYNC_KINDS = new Set<string>(['missing', 'duplicate', 'unsupported']);
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
        WHERE f.excluded = 0
          -- An original Booth has a copy of is superseded: the copy shares its
          -- audio by design, and the original leaving (cutover) is expected.
          AND NOT EXISTS (SELECT 1 FROM audio_file c WHERE c.copy_of = f.id AND c.excluded = 0)`,
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

/** `leaveAlone`: files this sync couldn't look at (an offline folder); findings about them stay as they are. */
export function refreshFindings(db: Database, runId: string | null, fileIds: string[], opts: { leaveAlone?: string[] } = {}): FindingsSummary {
  const leaveAlone = new Set(opts.leaveAlone ?? []);
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
    const open = db.prepare(`SELECT id, kind, subject_key, file_ids FROM finding WHERE state = 'open'`).all() as { id: string; kind: string; subject_key: string; file_ids: string }[];
    for (const f of open) {
      if (!SYNC_KINDS.has(f.kind) || current.has(`${f.kind}\u0000${f.subject_key}`)) continue;
      if (leaveAlone.size && (JSON.parse(f.file_ids) as string[]).some((id) => leaveAlone.has(id))) continue;
      clear.run(now(), f.id);
      summary.cleared++;
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
  takeover: ['acknowledge'],
};
/** What "settle all like this" does per kind: never anything that removes a track. */
const BULK: Record<FindingKind, SettleAction['type']> = { duplicate: 'keep_both', missing: 'leave', unsupported: 'acknowledge', takeover: 'acknowledge' };

export interface FindingFile {
  fileId: string;
  path: string;
  present: boolean;
  track: { id: string; title: string; artist: string; album: string | null } | null;
  starred: boolean;
  note: string | null;
  playlists: string[];
  /** Other sources the track is in (e.g. discogs): forgetting this file doesn't remove the track. */
  alsoIn: string[];
}
export interface FindingView { id: string; kind: FindingKind; raisedAt: string; files: FindingFile[]; /** Why, for a takeover finding. */ detail: string | null }

function trackIdOf(db: Database, fileId: string): string | null {
  const r = db.prepare(`SELECT entity_id FROM source_link WHERE source = 'local' AND entity_kind = 'track' AND external_id = ?`).get(fileId) as { entity_id: string } | null;
  return r?.entity_id ?? null;
}

/**
 * The track a file belongs to. Usually through its own link; a second copy at
 * the same album position never gets one (collate gives the position to the
 * first copy), but its path is recorded on the track they share, so it is
 * found through that.
 */
function trackForFile(db: Database, fileId: string): { id: string; ownLink: boolean } | null {
  const own = trackIdOf(db, fileId);
  if (own) return { id: own, ownLink: true };
  const r = db
    .prepare(
      `SELECT mk.entity_id FROM match_key mk JOIN audio_file f ON f.path = mk.key_value
        WHERE f.id = ? AND mk.entity_kind = 'track' AND mk.key_type = 'file_path'`,
    )
    .get(fileId) as { entity_id: string } | null;
  return r ? { id: r.entity_id, ownLink: false } : null;
}

function fileView(db: Database, fileId: string): FindingFile | null {
  const f = db.prepare(`SELECT id, path, present FROM audio_file WHERE id = ?`).get(fileId) as { id: string; path: string; present: number } | null;
  if (!f) return null;
  const tid = trackForFile(db, fileId)?.id ?? null;
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
    alsoIn: t
      ? (db.prepare(`SELECT DISTINCT source FROM source_link WHERE entity_kind = 'track' AND entity_id = ? AND source <> 'local' ORDER BY source`)
          .all(t.id) as { source: string }[]).map((r) => r.source)
      : [],
  };
}

export function listOpenFindings(db: Database): FindingView[] {
  const rows = db
    .prepare(`SELECT id, kind, raised_at, file_ids, detail FROM finding WHERE state = 'open' ORDER BY kind, raised_at`)
    .all() as { id: string; kind: FindingKind; raised_at: string; file_ids: string; detail: string | null }[];
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    raisedAt: r.raised_at,
    files: (JSON.parse(r.file_ids) as string[]).map((id) => fileView(db, id)).filter((f): f is FindingFile => !!f),
    detail: r.detail,
  }));
}

export function openFindingCount(db: Database): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM finding WHERE state = 'open'`).get() as { n: number }).n;
}

/** Move what the user put on `from` onto `to`: starred anywhere counts, notes are kept side by side, a tapped BPM and playlist entries follow. */
function moveAnnotations(db: Database, from: string, to: string): void {
  type Marks = { starred_at: string | null; note: string | null; tapped_bpm: number | null; tapped_bpm_at: string | null };
  const read = db.prepare(`SELECT starred_at, note, tapped_bpm, tapped_bpm_at FROM track WHERE id = ?`);
  const a = read.get(from) as Marks | null;
  const b = read.get(to) as Marks | null;
  if (!a || !b) return;
  const note = !a.note ? b.note : !b.note || b.note === a.note ? a.note : `${b.note}\n\n${a.note}`;
  // A tap is a measurement of the same audio: the kept track's own wins.
  const tap = b.tapped_bpm != null ? b : a;
  db.prepare(`UPDATE track SET starred_at = COALESCE(starred_at, ?), note = ?, tapped_bpm = ?, tapped_bpm_at = ? WHERE id = ?`)
    .run(a.starred_at, note, tap.tapped_bpm, tap.tapped_bpm_at, to);
  // One entry per track per playlist: where the kept track is already there, the moved entry goes.
  db.prepare(
    `DELETE FROM playlist_track WHERE track_id = ? AND playlist_id IN (SELECT playlist_id FROM playlist_track WHERE track_id = ?)`,
  ).run(from, to);
  db.prepare(`UPDATE playlist_track SET track_id = ? WHERE track_id = ?`).run(to, from);
}

function settle(db: Database, id: string, resolution: string): void {
  db.prepare(`UPDATE finding SET state = 'settled', resolution = ?, settled_at = ? WHERE id = ?`).run(resolution, now(), id);
}

/**
 * `needsSync`: the change takes effect through the next local sync's prune.
 * `afterSync`: run once that sync has finished.
 */
export interface SettleResult { needsSync: boolean; afterSync?: () => void }

export function settleFinding(db: Database, id: string, action: SettleAction): SettleResult {
  const f = db.prepare(`SELECT kind, state, file_ids FROM finding WHERE id = ?`).get(id) as { kind: FindingKind; state: FindingState; file_ids: string } | null;
  if (!f) throw new FindingError(`no such finding: ${id}`);
  if (f.state !== 'open') throw new FindingError('this finding is no longer open');
  if (!ACTIONS[f.kind].includes(action.type)) throw new FindingError(`${action.type} doesn't apply to a ${f.kind} finding`);
  const fileIds = JSON.parse(f.file_ids) as string[];
  const forgetFile = db.prepare(`UPDATE audio_file SET excluded = ${EXCLUDED_FORGOTTEN} WHERE id = ?`);
  const exclude = db.prepare(`UPDATE audio_file SET excluded = ${EXCLUDED_OTHER_COPY_KEPT} WHERE id = ?`);

  let needsSync = false;
  let afterSync: (() => void) | undefined;
  db.transaction(() => {
    if (action.type === 'keep_one') {
      if (!fileIds.includes(action.fileId)) throw new FindingError('that file is not part of this finding');
      // Without a track to keep, the others' stars and notes would have
      // nowhere to go and leave with their tracks. Refuse rather than lose them.
      const kept = trackForFile(db, action.fileId);
      if (!kept) throw new FindingError('Booth can’t tell which track that copy is. Keep all for now, or keep another copy.');
      for (const other of fileIds) {
        if (other === action.fileId) continue;
        const from = trackIdOf(db, other);
        if (from === kept.id && !kept.ownLink) {
          // The kept copy shares this file's track: hand it the link, so the
          // track stays when this file leaves.
          db.prepare(`UPDATE source_link SET external_id = ? WHERE source = 'local' AND entity_kind = 'track' AND external_id = ?`)
            .run(action.fileId, other);
        } else if (from && from !== kept.id) {
          moveAnnotations(db, from, kept.id);
        }
        exclude.run(other);
      }
      settle(db, id, `keep_one:${action.fileId}`);
      needsSync = true;
    } else if (action.type === 'forget') {
      // The track may outlive this file: it may be in Discogs too, or another
      // copy at the same album position takes it over on the next sync. Its
      // playlist entries go only if the track itself is gone after that sync.
      // They're deleted then even if the relinker re-attached them by name to
      // some other track: the user confirmed they go with this one.
      const tid = trackIdOf(db, fileIds[0]);
      if (tid) {
        const entries = (db.prepare(`SELECT id FROM playlist_track WHERE track_id = ?`).all(tid) as { id: string }[]).map((r) => r.id);
        afterSync = () => {
          if (db.prepare(`SELECT 1 FROM track WHERE id = ?`).get(tid)) return;
          const del = db.prepare(`DELETE FROM playlist_track WHERE id = ?`);
          db.transaction(() => { for (const e of entries) del.run(e); })();
        };
      }
      forgetFile.run(fileIds[0]);
      settle(db, id, 'forget');
      needsSync = true;
    } else {
      settle(db, id, action.type);
    }
  })();
  return { needsSync, afterSync };
}

/** "Settle all like this": the kind's non-destructive action on every open finding of that kind. Returns how many. */
export function settleAllOfKind(db: Database, kind: FindingKind): number {
  const res = db
    .prepare(`UPDATE finding SET state = 'settled', resolution = ?, settled_at = ? WHERE kind = ? AND state = 'open'`)
    .run(BULK[kind], now(), kind);
  return res.changes;
}

/** Why a file is out of the library (audio_file.excluded). 0 = it isn't. */
export const EXCLUDED_FORGOTTEN = 1;
export const EXCLUDED_OTHER_COPY_KEPT = 2;

/**
 * A copy left out because the user kept another one comes back once no kept
 * copy of that audio is left among the files this sync asked about: the
 * reason for leaving it out is gone, and otherwise the song would vanish from
 * Booth with nothing on the list to say so. Updates `files` in place.
 */
export function restoreOrphanedCopies(db: Database, files: Map<string, FileRow>, offline: FileRow[] = []): number {
  const all = [...files.values()];
  // A kept copy on a drive that's offline right now is still kept.
  const keptPrints = new Set([...all, ...offline].filter((f) => f.present && !f.excluded && f.fingerprint).map((f) => f.fingerprint));
  const reasonOf = db.prepare(`SELECT excluded FROM audio_file WHERE id = ?`);
  const restore = db.prepare(`UPDATE audio_file SET excluded = 0 WHERE id = ?`);
  let restored = 0;
  for (const f of all) {
    if (!f.excluded || !f.present || !f.fingerprint || keptPrints.has(f.fingerprint)) continue;
    if ((reasonOf.get(f.id) as { excluded: number }).excluded !== EXCLUDED_OTHER_COPY_KEPT) continue;
    restore.run(f.id);
    f.excluded = false;
    keptPrints.add(f.fingerprint);
    restored++;
  }
  return restored;
}
