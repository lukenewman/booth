/**
 * Batch tempo analysis: decode each local-backed track and write the estimate
 * as a `bpmAnalyzed` facet.
 *
 * The app now runs this pass itself behind every sync and after every vinyl
 * rip, so this script is for backfills, forced re-runs after a change to the
 * estimator, and measuring. It shares the pass with the app rather than
 * reimplementing it — two copies would drift, and a drifting copy means a
 * manual re-run produces a different BPM than the sync did for the same file.
 *
 * Additive and resumable. It writes two facet keys and touches nothing else:
 * no entity is created, pruned or deleted, and the Music.app tag it outranks is
 * left in place underneath so the two can always be compared.
 *
 * Usage:
 *   bun run scripts/analyze-bpm.ts --dry-run          # report, write nothing
 *   bun run scripts/analyze-bpm.ts --limit 200        # first N unanalysed
 *   bun run scripts/analyze-bpm.ts --force            # redo already-analysed
 *   bun run scripts/analyze-bpm.ts --concurrency 4
 */
import { Database } from 'bun:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { hasFfmpeg } from '../src/lib/server/analysis/decode';
import { MIN_CONFIDENCE, analyzeTracks, pendingAnalysis } from '../src/lib/server/analysis/run';
import { BPM_KEY_ANALYZED } from '../src/lib/server/library/bpm';

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : fallback;
}

const dryRun = flag('dry-run');
const force = flag('force');
const limit = arg('limit', Infinity);
// Higher than the app's background default: nobody is using the UI during a
// deliberate batch run, so there is nothing to stay out of the way of.
const concurrency = Math.max(1, arg('concurrency', 4));

if (!(await hasFfmpeg())) {
  console.error('ffmpeg not on PATH — install it first (brew install ffmpeg)');
  process.exit(1);
}

const dbPath = process.env.BOOTH_DB_PATH ?? join(homedir(), '.booth', 'booth.db');
const db = dryRun ? new Database(dbPath, { readonly: true }) : new Database(dbPath, { readwrite: true });

const all = pendingAnalysis(db, { force });
const todo = Number.isFinite(limit) ? all.slice(0, limit) : all;
console.log(
  `${all.length} track(s) with a file and no analysis yet; processing ${todo.length} at concurrency ${concurrency}${dryRun ? ' (dry run)' : ''}`,
);

const started = Date.now();
const counts = await analyzeTracks(db, todo, {
  concurrency,
  dryRun,
  onProgress: (done, total, c) => {
    if (done % 200 >= concurrency) return;
    const rate = done / ((Date.now() - started) / 1000);
    const left = ((total - done) / rate / 60).toFixed(1);
    process.stdout.write(
      `\r  ${done}/${total}  ${rate.toFixed(1)}/s  ~${left}m left  (${c.analysed} written, ${c.lowConfidence} low-confidence)   `,
    );
  },
});

const elapsed = (Date.now() - started) / 1000;
console.log(`
${dryRun ? 'would write' : 'wrote'}   ${counts.analysed}
low confidence  ${counts.lowConfidence}  (below ${MIN_CONFIDENCE}, left without a value)
missing file    ${counts.missingFile}
failed          ${counts.failed}
${elapsed.toFixed(0)}s total (${(elapsed / Math.max(1, todo.length)).toFixed(2)}s per track)`);

const total = db
  .prepare(`SELECT COUNT(*) n FROM source_facets WHERE source='local' AND key = ?`)
  .get(BPM_KEY_ANALYZED) as { n: number };
console.log(`source_facets now holds ${total.n} analysed bpm rows`);
