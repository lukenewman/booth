/**
 * probe-fingerprint-stability.ts — does the audio fingerprint hold across a tag
 * write on REAL library files?
 *
 * verify-fingerprint proves it on synthetic tones from one encoder. This library
 * has 4,355 files from many encoders, with VBR headers and embedded art — the
 * cases where a coded-stream copy can quietly differ. If a meaningful share of
 * real files move their fingerprint when tagged, content-addressed identity is
 * not viable and the design changes before anything is written.
 *
 * READ-ONLY against the library: every file is copied to a temp directory and
 * only the copy is ever tagged. Originals are opened for reading and nothing else.
 *
 * Run: bun verify scripts/probe-fingerprint-stability.ts [--limit 200] [--seed 1]
 */
import { Database } from 'bun:sqlite';
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { audioFingerprint } from '../src/lib/server/library/fingerprint';
import { hasFfmpeg } from '../src/lib/server/analysis/decode';

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback;
}
const limit = arg('limit', 200);
const seed = arg('seed', 1);

if (!(await hasFfmpeg())) {
  console.error('ffmpeg not on PATH — install it (brew install ffmpeg)');
  process.exit(1);
}

const dbPath = process.env.BOOTH_DB_PATH ?? join(homedir(), '.booth', 'booth.db');
const db = new Database(dbPath, { readonly: true });
const all = db
  .prepare(`SELECT key_value AS path FROM match_key WHERE entity_kind='track' AND key_type='file_path'`)
  .all() as { path: string }[];

// Deterministic spread across the library rather than the first N, which would
// be one artist's folder and one encoder.
const step = Math.max(1, Math.floor(all.length / limit));
const sample = all.filter((_, i) => i % step === seed % step).slice(0, limit);

const tmp = mkdtempSync(join(tmpdir(), 'booth-stability-'));

async function ffmpeg(args: string[]): Promise<boolean> {
  const proc = Bun.spawn(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', ...args], {
    stdout: 'ignore',
    stderr: 'ignore',
  });
  return (await proc.exited) === 0;
}

interface Moved { path: string; before: string; after: string }
const moved: Moved[] = [];
let stable = 0;
let missing = 0;
let unreadable = 0;

for (const [i, row] of sample.entries()) {
  if (!existsSync(row.path)) {
    missing++;
    continue;
  }
  const ext = extname(row.path) || '.bin';
  const copy = join(tmp, `c${i}${ext}`);
  const out = join(tmp, `t${i}${ext}`);
  try {
    copyFileSync(row.path, copy);
    const before = await audioFingerprint(copy);
    const ok = await ffmpeg(['-i', copy, '-map', '0', '-c', 'copy', '-metadata', 'comment=booth-probe', out]);
    if (!ok) {
      unreadable++;
      continue;
    }
    const after = await audioFingerprint(out);
    if (before === after) stable++;
    else moved.push({ path: row.path, before, after });
  } catch {
    unreadable++;
  } finally {
    rmSync(copy, { force: true });
    rmSync(out, { force: true });
  }
  if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${sample.length}…`);
}

const scratch = process.env.SCRATCH ?? tmpdir();
const report = { sampled: sample.length, stable, moved, missing, unreadable, libraryTotal: all.length };
writeFileSync(join(scratch, 'fingerprint-stability.json'), JSON.stringify(report, null, 2));

console.log(`\nsampled     ${sample.length} of ${all.length} library files`);
console.log(`stable      ${stable}`);
console.log(`MOVED       ${moved.length}${moved.length ? '  ← content-addressed identity is not safe for these' : ''}`);
console.log(`missing     ${missing}  (row points at a file that is not there)`);
console.log(`unreadable  ${unreadable}`);
for (const m of moved.slice(0, 20)) console.log(`  moved: ${m.path}`);
console.log(`\nreport: ${join(scratch, 'fingerprint-stability.json')}`);

rmSync(tmp, { recursive: true, force: true });
// A probe reports; it does not gate. The verdict is the operator's.
