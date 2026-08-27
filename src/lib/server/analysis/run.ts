/**
 * The tempo-analysis pass, shared by the batch script and the app.
 *
 * This lives here rather than in the script because two copies would drift, and
 * a drifting copy means the BPM a sync produces differs from the BPM a manual
 * re-run produces for the same file — the same reason the track listing and the
 * queue's id query are built from one shared helper.
 */
import type { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { decodeForAnalysis, hasFfmpeg } from './decode';
import { estimateTempo } from './tempo';
import { BPM_KEY_ANALYZED } from '../library/bpm';

/** Facet holding how much the estimator trusted its own answer. */
export const BPM_CONFIDENCE_KEY = 'bpmAnalyzedConfidence';

/**
 * Below this the estimate is not worth storing. Spot-checking the low end found
 * exactly the tracks you would expect — ambient pieces and interludes with no
 * steady pulse — reporting values with no support in the audio. A missing BPM is
 * honest; a confident-looking wrong one is not.
 */
export const MIN_CONFIDENCE = 0.25;

/**
 * Parallel ffmpeg processes when the pass runs behind a sync. Lower than the
 * script's default: this one runs while somebody is using the app, and the point
 * of moving it into the background was to stay out of the way.
 */
export const BACKGROUND_CONCURRENCY = 2;

export interface AnalysisCandidate {
  id: string;
  path: string;
}

export interface AnalysisCounts {
  analysed: number;
  lowConfidence: number;
  missingFile: number;
  failed: number;
}

export interface PendingOptions {
  /** Re-analyse tracks that already have a stored estimate. */
  force?: boolean;
  /** Restrict to these track ids — used by the vinyl-rip path, which knows exactly what it wrote. */
  trackIds?: string[];
  limit?: number;
}

/**
 * Tracks backed by a file that have not been analysed yet.
 *
 * "Not analysed" means no *attempt* on record, not "no BPM stored". A track
 * whose estimate came back below the confidence floor stores its confidence and
 * no BPM, and that marker is what keeps it out of this list. Without it the ~700
 * pulseless tracks in this library would be re-decoded on every single sync,
 * forever, to reach the same conclusion. `--force` still revisits them.
 *
 * Tracks whose file has gone missing are dropped here rather than marked. A
 * marker would be wrong — an unplugged drive is temporary, and the track should
 * be analysed when it comes back — but leaving them in the queue made every
 * sync claim a pass and log "0 analysed" for the same dead paths forever. The
 * stat calls are cheap and only touch the shrinking candidate set.
 */
export function pendingAnalysis(db: Database, opts: PendingOptions = {}): AnalysisCandidate[] {
  const where: string[] = [];
  const params: string[] = [];

  if (!opts.force) {
    where.push(
      `NOT EXISTS (SELECT 1 FROM source_facets f
                    WHERE f.entity_kind='track' AND f.entity_id = t.id
                      AND f.source='local' AND f.key IN (?, ?))`,
    );
    params.push(BPM_KEY_ANALYZED, BPM_CONFIDENCE_KEY);
  }
  if (opts.trackIds?.length) {
    where.push(`t.id IN (${opts.trackIds.map(() => '?').join(',')})`);
    params.push(...opts.trackIds);
  }

  const rows = db
    .prepare(
      `SELECT t.id, mk.key_value AS path
         FROM track t
         JOIN match_key mk
           ON mk.entity_kind='track' AND mk.entity_id = t.id AND mk.key_type='file_path'
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY t.id`,
    )
    .all(...params) as AnalysisCandidate[];

  const present = rows.filter((r) => existsSync(r.path));
  return opts.limit != null ? present.slice(0, opts.limit) : present;
}

export interface AnalyzeOptions {
  concurrency?: number;
  /** Called after each batch, for the script's progress line. */
  onProgress?: (done: number, total: number, counts: AnalysisCounts) => void;
  /** Report but do not write. */
  dryRun?: boolean;
}

/**
 * Analyse a set of tracks and write their estimates.
 *
 * Never throws for a single bad file: a missing codec, a truncated download or a
 * path that no longer exists are all expected outcomes across a real library,
 * and none of them is a reason to abandon the rest of the pass.
 */
export async function analyzeTracks(
  db: Database,
  candidates: AnalysisCandidate[],
  opts: AnalyzeOptions = {},
): Promise<AnalysisCounts> {
  const concurrency = Math.max(1, opts.concurrency ?? BACKGROUND_CONCURRENCY);
  const counts: AnalysisCounts = { analysed: 0, lowConfidence: 0, missingFile: 0, failed: 0 };

  const writeFacet = db.prepare(
    `INSERT INTO source_facets (entity_kind, entity_id, source, key, value)
     VALUES ('track', ?, 'local', ?, ?)
     ON CONFLICT (entity_kind, entity_id, source, key)
     DO UPDATE SET value = excluded.value,
                   updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  );

  // Buffered and written in batches: one transaction per track is pure overhead.
  // `bpm` is null for an attempt that landed below the confidence floor — the
  // confidence alone is still written, as the record that we tried.
  let pending: { id: string; bpm: number | null; confidence: number }[] = [];
  const flush = () => {
    if (opts.dryRun || pending.length === 0) {
      pending = [];
      return;
    }
    const batch = pending;
    pending = [];
    db.transaction(() => {
      for (const r of batch) {
        if (r.bpm !== null) writeFacet.run(r.id, BPM_KEY_ANALYZED, String(r.bpm));
        writeFacet.run(r.id, BPM_CONFIDENCE_KEY, String(r.confidence));
      }
    })();
  };

  const one = async (c: AnalysisCandidate) => {
    // pendingAnalysis already filtered these out; this catches a file that
    // disappears between the query and its turn in the queue.
    if (!existsSync(c.path)) {
      counts.missingFile++;
      return;
    }
    try {
      const est = estimateTempo(await decodeForAnalysis(c.path));
      if (!est) {
        counts.failed++;
        return;
      }
      if (est.confidence < MIN_CONFIDENCE) {
        // Record the attempt so this track is not decoded again every sync.
        pending.push({ id: c.id, bpm: null, confidence: est.confidence });
        counts.lowConfidence++;
        return;
      }
      pending.push({ id: c.id, bpm: est.bpm, confidence: est.confidence });
      counts.analysed++;
    } catch {
      counts.failed++;
    }
  };

  for (let i = 0; i < candidates.length; i += concurrency) {
    await Promise.all(candidates.slice(i, i + concurrency).map(one));
    if (pending.length >= 50) flush();
    opts.onProgress?.(Math.min(i + concurrency, candidates.length), candidates.length, counts);
  }
  flush();

  return counts;
}

// ---- Background pass -------------------------------------------------

let running = false;

export function isAnalysisRunning(): boolean {
  return running;
}

/**
 * Start a pass without blocking the caller.
 *
 * Returns false when one is already in flight — two overlapping passes would
 * spawn twice the ffmpeg processes and race each other to the same facet rows
 * for no benefit, and a sync on a timer makes that easy to trigger.
 */
export function startBackgroundAnalysis(
  db: Database,
  candidates: AnalysisCandidate[],
  onDone?: (counts: AnalysisCounts) => void,
): boolean {
  if (running || candidates.length === 0) return false;
  running = true;

  void (async () => {
    try {
      const counts = await analyzeTracks(db, candidates, { concurrency: BACKGROUND_CONCURRENCY });
      onDone?.(counts);
    } catch {
      // analyzeTracks already absorbs per-track failures; reaching here means
      // something structural went wrong, and a background pass is not worth
      // taking the server down for.
      onDone?.({ analysed: 0, lowConfidence: 0, missingFile: 0, failed: candidates.length });
    } finally {
      running = false;
    }
  })();

  return true;
}

export { hasFfmpeg };
