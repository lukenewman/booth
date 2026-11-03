import type { Database } from 'bun:sqlite';

/** What the takeover panel and a release's detail show. */
export interface TakeoverStatus {
  running: { runId: string; sample: boolean; releasesTotal: number; releasesDone: number; bytesTotal: number; bytesDone: number } | null;
  lastRun: { runId: string; state: string; finishedAt: string | null; done: number; failed: { releaseId: string; title: string; error: string }[]; error: string | null } | null;
  /** Releases whose files are Booth's copies now, newest first. */
  owned: { releaseId: string; title: string; artist: string; files: number }[];
}

export function takeoverStatus(db: Database): TakeoverStatus {
  const run = db.prepare(`SELECT * FROM takeover_run ORDER BY started_at DESC, rowid DESC LIMIT 1`).get() as
    | { id: string; state: string; sample: number; releases_total: number; releases_done: number; bytes_total: number; bytes_done: number; finished_at: string | null; error: string | null }
    | null;
  const status: TakeoverStatus = { running: null, lastRun: null, owned: [] };
  if (run?.state === 'running') {
    status.running = { runId: run.id, sample: run.sample === 1, releasesTotal: run.releases_total, releasesDone: run.releases_done, bytesTotal: run.bytes_total, bytesDone: run.bytes_done };
  } else if (run) {
    const failed = db
      .prepare(`SELECT tr.release_id AS releaseId, COALESCE(r.title, tr.release_id) AS title, tr.error FROM takeover_release tr LEFT JOIN release r ON r.id = tr.release_id WHERE tr.run_id = ? AND tr.state = 'failed'`)
      .all(run.id) as { releaseId: string; title: string; error: string }[];
    const done = (db.prepare(`SELECT COUNT(*) AS n FROM takeover_release WHERE run_id = ? AND state = 'done'`).get(run.id) as { n: number }).n;
    status.lastRun = { runId: run.id, state: run.state, finishedAt: run.finished_at, done, failed, error: run.error };
  }
  status.owned = db
    .prepare(
      `SELECT r.id AS releaseId, r.title, a.name AS artist, COUNT(*) AS files, MAX(c.first_seen_at) AS at
         FROM audio_file c
         JOIN source_link sl ON sl.source = 'local' AND sl.entity_kind = 'track' AND sl.external_id = c.id
         JOIN track t ON t.id = sl.entity_id
         JOIN release r ON r.id = t.release_id
         JOIN artist a ON a.id = r.artist_id
        WHERE c.copy_of IS NOT NULL
        GROUP BY r.id ORDER BY at DESC`,
    )
    .all() as TakeoverStatus['owned'];
  return status;
}

/** One release: taken over (and how many of its files), or why it can't be. */
export function releaseTakeoverState(db: Database, releaseId: string): { owned: number; inPlace: number; missing: number } {
  const rows = db
    .prepare(
      `SELECT f.copy_of IS NOT NULL AS owned, f.present
         FROM track t
         JOIN source_link sl ON sl.source = 'local' AND sl.entity_kind = 'track' AND sl.entity_id = t.id
         JOIN audio_file f ON f.id = sl.external_id
        WHERE t.release_id = ?`,
    )
    .all(releaseId) as { owned: number; present: number }[];
  return {
    owned: rows.filter((r) => r.owned).length,
    inPlace: rows.filter((r) => !r.owned).length,
    missing: rows.filter((r) => !r.owned && !r.present).length,
  };
}

/** Music.app's media folder, from where its files are (…/Media(.localized)), or null. */
export function musicAppMediaFolder(db: Database): string | null {
  const row = db.prepare(`SELECT path FROM audio_file WHERE path LIKE '%/Media%/Music/%' LIMIT 1`).get() as { path: string } | null;
  const m = row && /^(.*\/Media(?:\.localized)?)\/Music\//.exec(row.path);
  return m ? m[1] : null;
}
