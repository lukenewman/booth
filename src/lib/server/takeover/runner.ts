import type { Database } from 'bun:sqlite';
import { existsSync, statfsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { env, setEnv } from '$lib/server/env';
import { writeSetting } from '$lib/server/settings';
import { audioFingerprint } from '../library/fingerprint';
import { listFolderSources } from '../library/folders';
import { readTags } from '../library/tags';
import { writeTags } from '../library/tag_writer';
import { BoothFolderError, checkBoothFolder } from '../library/boothFolder';
import { listDestinations } from '../backup/library';
import { listAudioFiles } from '../sources/local/ingest';
import { resolvedInboxRoot, resolvedLibraryRoot } from '../sources/local/ingest_env';
import { createTakeoverRun, runTakeover, type TakeoverDeps, type TakeoverRunResult } from './engine';
import { musicAppMediaFolder } from './status';

/**
 * The server's takeovers: one run at a time, in the background, with the real
 * tag writer and fingerprints. A run the server was in the middle of when it
 * stopped carries on when it starts again. State lives on globalThis so a dev
 * reload still sees (and can stop) the run in flight.
 */
type RunnerState = { running: Promise<TakeoverRunResult> | null; stopRequested: boolean; resumed: boolean };
const g = globalThis as typeof globalThis & { __boothTakeover?: RunnerState };
const state: RunnerState = (g.__boothTakeover ??= { running: null, stopRequested: false, resumed: false });

export const DEFAULT_BOOTH_FOLDER = join(homedir(), 'Music', 'Booth');

export function realTakeoverDeps(): TakeoverDeps {
  return {
    writeTags, readTags, fingerprint: audioFingerprint,
    freeBytes: (dir) => { const s = statfsSync(dir); return Number(s.bavail) * Number(s.bsize); },
  };
}

/** Booth's folder: where it is, whether the user chose it, whether it holds files yet. */
export function boothFolder(): { path: string; chosen: boolean; hasFiles: boolean } {
  const path = resolvedLibraryRoot();
  return { path, chosen: !!env.BOOTH_LIBRARY_PATH, hasFiles: existsSync(path) && listAudioFiles(path).length > 0 };
}

/** Choose Booth's folder (asked at the first takeover). Saved as a setting; created if needed by the first run. */
export function chooseBoothFolder(db: Database, path: string): string {
  if (state.running) throw new BoothFolderError('A takeover is running. Stop it before changing Booth’s folder.');
  const home = homedir();
  if (path === home || home.startsWith(path.replace(/\/+$/, '') + '/')) throw new BoothFolderError('That’s your whole home folder. Pick a folder of its own.');
  const media = musicAppMediaFolder(db);
  const chosen = checkBoothFolder(path, {
    current: boothFolder(),
    forbidden: [
      ...(media ? [{ path: media, why: 'Music.app’s media folder' }] : []),
      ...listFolderSources(db).map((f) => ({ path: f.path, why: 'a folder Booth reads music from' })),
      ...listDestinations(db).map((d) => ({ path: d.path, why: 'a backup folder' })),
      { path: resolvedInboxRoot(), why: 'Booth’s drop folder' },
    ],
  });
  writeSetting('BOOTH_LIBRARY_PATH', chosen);
  setEnv('BOOTH_LIBRARY_PATH', chosen);
  return chosen;
}

export function isTakeoverRunning(): boolean {
  return state.running !== null;
}

function launch(db: Database, runId: string): void {
  state.stopRequested = false;
  state.running = runTakeover(db, realTakeoverDeps(), runId, { root: resolvedLibraryRoot(), shouldStop: () => state.stopRequested })
    .then((r) => { console.log(`[takeover] ${r.state}: ${r.done} taken over, ${r.failed} couldn’t be${r.error ? ` — ${r.error}` : ''}`); return r; })
    .catch((e) => { console.warn('[takeover] run failed:', e); throw e; })
    .finally(() => { state.running = null; });
  state.running.catch(() => {});
}

/** Start taking over `releaseIds`. Returns null when a run is already going. */
export function startTakeover(db: Database, releaseIds: string[], opts: { sample?: boolean } = {}): string | null {
  resumeOnce(db);
  if (state.running) return null;
  const runId = createTakeoverRun(db, releaseIds, opts);
  const ph = releaseIds.map(() => '?').join(',');
  const bytes = (db
    .prepare(
      `SELECT COALESCE(SUM(f.size), 0) AS n FROM track t
         JOIN source_link sl ON sl.source = 'local' AND sl.entity_kind = 'track' AND sl.entity_id = t.id
         JOIN audio_file f ON f.id = sl.external_id
        WHERE t.release_id IN (${ph}) AND f.copy_of IS NULL AND f.ownership = 'in_place'`,
    )
    .get(...releaseIds) as { n: number }).n;
  db.prepare(`UPDATE takeover_run SET bytes_total = ? WHERE id = ?`).run(bytes, runId);
  launch(db, runId);
  return runId;
}

/** Once per server: a run left running by the last process carries on. */
export function resumeOnce(db: Database): void {
  if (state.resumed) return;
  state.resumed = true;
  if (state.running) return;
  const left = db.prepare(`SELECT id FROM takeover_run WHERE state = 'running' ORDER BY started_at DESC LIMIT 1`).get() as { id: string } | null;
  if (left) launch(db, left.id);
}

export function stopTakeover(): void {
  state.stopRequested = true;
}
