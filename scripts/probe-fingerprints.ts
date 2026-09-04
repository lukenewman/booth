/**
 * probe-fingerprints.ts — fingerprint the whole local library.
 *
 * Answers two questions the design left open: what it costs to hash 50GB (which
 * decides whether the migration is one pass or batched), and whether fingerprints
 * discriminate across a real collection. Collisions are reported rather than
 * assumed away — two files sharing a fingerprint are either genuine duplicates
 * (useful) or a hashing flaw (fatal), and only the paths tell you which.
 *
 * READ-ONLY: opens files for reading, writes only a report.
 *
 * Run: bun verify scripts/probe-fingerprints.ts [--limit N] [--concurrency 4]
 */
import { Database } from 'bun:sqlite';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { audioFingerprint } from '../src/lib/server/library/fingerprint';
import { hasFfmpeg } from '../src/lib/server/analysis/decode';

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback;
}
const limit = arg('limit', Infinity);
const concurrency = Math.max(1, arg('concurrency', 4));

if (!(await hasFfmpeg())) {
  console.error('ffmpeg not on PATH — install it (brew install ffmpeg)');
  process.exit(1);
}

const dbPath = process.env.BOOTH_DB_PATH ?? join(homedir(), '.booth', 'booth.db');
const db = new Database(dbPath, { readonly: true });
const rows = (
  db
    .prepare(`SELECT key_value AS path FROM match_key WHERE entity_kind='track' AND key_type='file_path'`)
    .all() as { path: string }[]
).slice(0, limit === Infinity ? undefined : limit);

const byFingerprint = new Map<string, string[]>();
let bytes = 0;
let missing = 0;
let failed = 0;
const started = Date.now();

async function one(path: string): Promise<void> {
  if (!existsSync(path)) {
    missing++;
    return;
  }
  try {
    bytes += statSync(path).size;
    const fp = await audioFingerprint(path);
    const list = byFingerprint.get(fp);
    if (list) list.push(path);
    else byFingerprint.set(fp, [path]);
  } catch {
    failed++;
  }
}

for (let i = 0; i < rows.length; i += concurrency) {
  await Promise.all(rows.slice(i, i + concurrency).map((r) => one(r.path)));
  if ((i + concurrency) % 400 < concurrency) {
    const done = Math.min(i + concurrency, rows.length);
    const rate = done / ((Date.now() - started) / 1000);
    console.log(`  ${done}/${rows.length}  ${rate.toFixed(1)} files/s`);
  }
}

const elapsedS = (Date.now() - started) / 1000;
const gb = bytes / 1e9;
const collisions = [...byFingerprint.entries()].filter(([, paths]) => paths.length > 1);

const scratch = process.env.SCRATCH ?? tmpdir();
writeFileSync(
  join(scratch, 'fingerprints.json'),
  JSON.stringify(Object.fromEntries(byFingerprint), null, 2),
);

console.log(`\nfingerprinted  ${byFingerprint.size} distinct across ${rows.length - missing - failed} files`);
console.log(`elapsed        ${elapsedS.toFixed(1)}s for ${gb.toFixed(1)}GB  (${((gb / elapsedS) * 60).toFixed(1)} GB/min)`);
console.log(`missing        ${missing}`);
console.log(`failed         ${failed}`);
console.log(`collisions     ${collisions.length}  (same audio, more than one file)`);
for (const [fp, paths] of collisions.slice(0, 15)) {
  console.log(`  ${fp}`);
  for (const p of paths) console.log(`    ${p}`);
}
console.log(`\nreport: ${join(scratch, 'fingerprints.json')}`);
