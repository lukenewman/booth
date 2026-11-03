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
