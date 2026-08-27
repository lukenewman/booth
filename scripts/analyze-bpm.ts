/**
 * Batch tempo analysis: decode each local-backed track and write the estimate
 * as a `bpmAnalyzed` facet.
 *
 * Additive and resumable. It writes two facet keys and touches nothing else —
 * no entity is created, pruned or deleted, and the Music.app `bpm` tag it
 * outranks is left in place underneath so the two can always be compared.
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
import { existsSync } from 'node:fs';
import { decodeForAnalysis, hasFfmpeg } from '../src/lib/server/analysis/decode';
import { estimateTempo } from '../src/lib/server/analysis/tempo';
import { BPM_KEY_ANALYZED } from '../src/lib/server/library/bpm';

/** Facet holding how much the estimator trusted its own answer. */
const CONFIDENCE_KEY = 'bpmAnalyzedConfidence';

/**
 * Below this the estimate is not worth storing. Spot-checking the low end
 * showed exactly the tracks you would expect — ambient pieces and interludes
 * with no steady pulse — reporting values with no support in the audio. A
 * missing BPM is honest; a confident-looking wrong one is not.
 */
const MIN_CONFIDENCE = 0.25;

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
const concurrency = Math.max(1, arg('concurrency', 4));

if (!(await hasFfmpeg())) {
  console.error('ffmpeg not on PATH — install it first (brew install ffmpeg)');
  process.exit(1);
}

const dbPath = process.env.BOOTH_DB_PATH ?? join(homedir(), '.booth', 'booth.db');
const db = dryRun ? new Database(dbPath, { readonly: true }) : new Database(dbPath, { readwrite: true });

const alreadyClause = force
  ? ''
  : `AND NOT EXISTS (SELECT 1 FROM source_facets f
                      WHERE f.entity_kind='track' AND f.entity_id = t.id
                        AND f.source='local' AND f.key = '${BPM_KEY_ANALYZED}')`;

const rows = db
  .prepare(
    `SELECT t.id, t.title, mk.key_value AS path
       FROM track t
       JOIN match_key mk
         ON mk.entity_kind='track' AND mk.entity_id = t.id AND mk.key_type='file_path'
      WHERE 1=1 ${alreadyClause}
      ORDER BY t.id`,
  )
  .all() as { id: string; title: string; path: string }[];

const todo = rows.slice(0, Number.isFinite(limit) ? limit : rows.length);
console.log(
  `${rows.length} track(s) with a file and no analysis yet; processing ${todo.length} at concurrency ${concurrency}${dryRun ? ' (dry run)' : ''}`,
);

const writeFacet = db.prepare(
  `INSERT INTO source_facets (entity_kind, entity_id, source, key, value)
   VALUES ('track', ?, 'local', ?, ?)
   ON CONFLICT (entity_kind, entity_id, source, key)
   DO UPDATE SET value = excluded.value,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
);

let analysed = 0;
let lowConfidence = 0;
let missingFile = 0;
let failed = 0;
let done = 0;
const started = Date.now();

/** Results are buffered and written in batches: one transaction per track is pure overhead. */
let pending: { id: string; bpm: number; confidence: number }[] = [];

function flush() {
  if (dryRun || pending.length === 0) {
    pending = [];
    return;
  }
  const batch = pending;
  pending = [];
  db.transaction(() => {
    for (const r of batch) {
      writeFacet.run(r.id, BPM_KEY_ANALYZED, String(r.bpm));
      writeFacet.run(r.id, CONFIDENCE_KEY, String(r.confidence));
    }
  })();
}

async function analyseOne(row: { id: string; title: string; path: string }) {
  if (!existsSync(row.path)) {
    missingFile++;
    return;
  }
  try {
    const est = estimateTempo(await decodeForAnalysis(row.path));
    if (!est) {
      failed++;
      return;
    }
    if (est.confidence < MIN_CONFIDENCE) {
      lowConfidence++;
      return;
    }
    pending.push({ id: row.id, bpm: est.bpm, confidence: est.confidence });
    analysed++;
  } catch {
    // A missing codec or a truncated file is an expected outcome across a real
    // library, not a reason to abandon the run.
    failed++;
  }
}

for (let i = 0; i < todo.length; i += concurrency) {
  await Promise.all(todo.slice(i, i + concurrency).map(analyseOne));
  done += Math.min(concurrency, todo.length - i);
  if (pending.length >= 50) flush();
  if (done % 200 < concurrency) {
    const rate = done / ((Date.now() - started) / 1000);
    const left = ((todo.length - done) / rate / 60).toFixed(1);
    process.stdout.write(
      `\r  ${done}/${todo.length}  ${rate.toFixed(1)}/s  ~${left}m left  (${analysed} written, ${lowConfidence} low-confidence)   `,
    );
  }
}
flush();

const elapsed = (Date.now() - started) / 1000;
console.log(`
${dryRun ? 'would write' : 'wrote'}   ${analysed}
low confidence  ${lowConfidence}  (below ${MIN_CONFIDENCE}, left without a value)
missing file    ${missingFile}
failed          ${failed}
${elapsed.toFixed(0)}s total (${(elapsed / Math.max(1, todo.length)).toFixed(2)}s per track)`);

const total = db
  .prepare(`SELECT COUNT(*) n FROM source_facets WHERE source='local' AND key = ?`)
  .get(BPM_KEY_ANALYZED) as { n: number };
console.log(`source_facets now holds ${total.n} analysed bpm rows`);
