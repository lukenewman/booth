/**
 * migrate-library.ts — the one verified pass (file-owned library, slice 3).
 *
 * Copies every local file into Booth's tree with its facts written into the
 * tags, fingerprints both ends, and refuses to publish a copy whose audio
 * stream differs from the original.
 *
 * **Originals are never modified and never deleted.** This script only ever
 * writes new files. Removing the originals is a separate, later decision.
 *
 * Dry run unless --apply. Resumable: completed track ids are appended to a
 * ledger, so an interrupted pass picks up where it stopped.
 *
 *   bun verify scripts/migrate-library.ts                 # plan only, writes nothing
 *   bun verify scripts/migrate-library.ts --sample 20     # time the real work into a temp dir
 *   bun verify scripts/migrate-library.ts --apply         # the pass
 */
import { Database } from 'bun:sqlite';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { collectMigrationPlan, type PlanEntry } from '../src/lib/server/library/migration';
import { writeTags } from '../src/lib/server/library/tag_writer';
import { audioFingerprint } from '../src/lib/server/library/fingerprint';

const APPLY = process.argv.includes('--apply');
const sampleIdx = process.argv.indexOf('--sample');
const SAMPLE = sampleIdx >= 0 ? Number(process.argv[sampleIdx + 1] ?? 20) : 0;
const limitIdx = process.argv.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? Number(process.argv[limitIdx + 1]) : undefined;

const DB_PATH = process.env.BOOTH_DB_PATH ?? join(homedir(), '.booth', 'booth.db');
const LIBRARY_ROOT = process.env.BOOTH_LIBRARY_PATH ?? join(homedir(), '.booth', 'library');
const LEDGER = join(homedir(), '.booth', 'migration-ledger.txt');

function human(bytes: number): string {
  if (bytes > 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes > 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${bytes} B`;
}

const db = new Database(DB_PATH, { readonly: !APPLY });
const plan = collectMigrationPlan(db, { libraryRoot: LIBRARY_ROOT, limit: LIMIT });

console.log(`database     ${DB_PATH}`);
console.log(`tree         ${LIBRARY_ROOT}`);
console.log(`\n${plan.entries.length} tracks considered`);
console.log(`  ready        ${plan.byStatus.ready}`);
console.log(`  missing      ${plan.byStatus.missing}   (database points at a file that is gone)`);
console.log(`  unsupported  ${plan.byStatus.unsupported}   (copied verbatim, tags skipped)`);
console.log(`  collision    ${plan.byStatus.collision}   (duplicate path, given a suffix — still copied)`);
console.log(`\nwould copy   ${human(plan.totalBytes)}`);
console.log(`empty writes ${plan.emptyWrites}   (nothing Booth knows that the file doesn't)`);

console.log('\nTag fields the pass would write:');
for (const [k, n] of Object.entries(plan.fieldCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(28)} ${n}`);
}

for (const status of ['missing', 'collision', 'unsupported'] as const) {
  const sample = plan.entries.filter((e) => e.status === status).slice(0, 5);
  if (sample.length === 0) continue;
  console.log(`\n${status}:`);
  for (const e of sample) console.log(`  ${e.source}`);
  const more = plan.byStatus[status] - sample.length;
  if (more > 0) console.log(`  … and ${more} more`);
}

console.log('\nWhere files would land (first 3):');
for (const e of plan.entries.filter((e) => e.status === 'ready').slice(0, 3)) {
  console.log(`  ${e.target}`);
}

/** Copy one entry, tag it, and prove the audio survived. Returns the fingerprint. */
async function migrateOne(entry: PlanEntry, destOverride?: string): Promise<string> {
  const dest = destOverride ?? entry.target;
  mkdirSync(dirname(dest), { recursive: true });
  // writeTags reads the source, writes a tagged copy to dest, and throws if the
  // audio fingerprint of the result differs from the source's.
  return writeTags(entry.source, entry.facts, dest);
}

// --- Timing sample: real work, into a temp directory ------------------
if (SAMPLE > 0 && !APPLY) {
  const tmp = mkdtempSync(join(tmpdir(), 'booth-migrate-sample-'));
  const picks = plan.entries.filter((e) => e.status === 'ready').slice(0, SAMPLE);
  console.log(`\nTiming ${picks.length} files into ${tmp} (originals untouched)…`);
  const started = Date.now();
  let bytes = 0;
  let failed = 0;
  for (const e of picks) {
    try {
      await migrateOne(e, join(tmp, `${e.trackId}${e.source.slice(e.source.lastIndexOf('.'))}`));
      bytes += e.sizeBytes;
    } catch (err) {
      failed++;
      console.log(`  FAILED ${e.source}: ${err instanceof Error ? err.message : err}`);
    }
  }
  const secs = (Date.now() - started) / 1000;
  rmSync(tmp, { recursive: true, force: true });
  console.log(`  ${picks.length - failed} ok, ${failed} failed in ${secs.toFixed(1)}s`);
  if (bytes > 0) {
    const rate = bytes / secs;
    console.log(`  ${human(rate)}/s → full pass ≈ ${(plan.totalBytes / rate / 60).toFixed(0)} min`);
  }
}

if (!APPLY) {
  console.log('\ndry run — nothing was written. Pass --apply to run the pass.');
  process.exit(0);
}

// --- The pass ---------------------------------------------------------
const done = new Set(
  existsSync(LEDGER) ? readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean) : [],
);
if (done.size > 0) console.log(`\nresuming — ${done.size} already done`);

let ok = 0;
let skipped = 0;
const failures: { source: string; error: string }[] = [];
const started = Date.now();

for (const entry of plan.entries) {
  // A missing file is the only thing the pass skips. Collisions took a suffixed
  // path at plan time and are copied like anything else.
  if (entry.status === 'missing') continue;
  if (done.has(entry.trackId)) {
    skipped++;
    continue;
  }
  try {
    const fp = await migrateOne(entry);
    // The ledger is the resume point, so it is written only after the copy has
    // been verified and renamed into place.
    appendFileSync(LEDGER, `${entry.trackId}\n`);
    if (!existsSync(entry.target) || statSync(entry.target).size === 0) {
      throw new Error('target missing or empty after write');
    }
    void fp;
    ok++;
  } catch (err) {
    failures.push({ source: entry.source, error: err instanceof Error ? err.message : String(err) });
  }
  if ((ok + failures.length) % 100 === 0) {
    const secs = (Date.now() - started) / 1000;
    console.log(`  ${ok} done, ${failures.length} failed, ${secs.toFixed(0)}s elapsed`);
  }
}

console.log(`\nmigrated ${ok}, skipped ${skipped} (already done), failed ${failures.length}`);
for (const f of failures.slice(0, 20)) console.log(`  ${f.source}: ${f.error}`);
if (failures.length > 20) console.log(`  … and ${failures.length - 20} more`);
console.log(`\nOriginals were not touched. Review the tree before deciding anything about them.`);
console.log(`ledger: ${LEDGER}`);
