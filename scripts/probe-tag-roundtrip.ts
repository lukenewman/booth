/**
 * probe-tag-roundtrip.ts — does the writer hold up on real files?
 *
 * verify-tag-writer proves the round trip on synthetic tones from one encoder.
 * This library is 4,355 files from many encoders, with VBR headers and embedded
 * artwork — the variety that breaks tagging libraries. Every fact written must
 * come back, and no audio may move.
 *
 * READ-ONLY against the library: each file is copied to a temp directory and
 * only the copy is tagged. Originals are opened for reading and nothing else.
 *
 * Run: bun verify scripts/probe-tag-roundtrip.ts [--limit 200] [--seed 1]
 */
import { Database } from 'bun:sqlite';
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { parseFile } from 'music-metadata';
import { audioFingerprint } from '../src/lib/server/library/fingerprint';
import { readTags } from '../src/lib/server/library/tags';
import { writeTags } from '../src/lib/server/library/tag_writer';
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

const step = Math.max(1, Math.floor(all.length / limit));
const sample = all.filter((_, i) => i % step === seed % step).slice(0, limit);

const tmp = mkdtempSync(join(tmpdir(), 'booth-roundtrip-'));

const FACTS = {
  dateAdded: '2020-10-05T18:22:00Z',
  dateAddedReported: '2025-08-25T13:37:11Z',
  dateAddedOrigin: 'recovered',
  starred: true,
  note: 'booth round-trip probe',
  bpm: 124,
};

/** Artwork is the thing most easily lost by a careless tag rewrite. */
async function hasArtwork(path: string): Promise<boolean> {
  const m = await parseFile(path, { duration: false, skipCovers: false });
  return (m.common.picture?.length ?? 0) > 0;
}

interface Failure { path: string; reason: string }
const failures: Failure[] = [];
let ok = 0;
let missing = 0;
let ratingVisible = 0;
let artworkKept = 0;
let artworkHad = 0;

for (const [i, row] of sample.entries()) {
  if (!existsSync(row.path)) {
    missing++;
    continue;
  }
  const ext = extname(row.path) || '.bin';
  const copy = join(tmp, `c${i}${ext}`);
  const dest = join(tmp, `d${i}${ext}`);
  try {
    copyFileSync(row.path, copy);
    const before = await audioFingerprint(copy);
    const hadArt = await hasArtwork(copy).catch(() => false);
    if (hadArt) artworkHad++;

    await writeTags(copy, FACTS, dest);

    const after = await audioFingerprint(dest);
    if (after !== before) {
      failures.push({ path: row.path, reason: `audio moved ${before} → ${after}` });
      continue;
    }
    const back = await readTags(dest);
    if (back.booth.DATE_ADDED !== FACTS.dateAdded) {
      failures.push({ path: row.path, reason: 'acquisition date did not round-trip' });
      continue;
    }
    if (back.booth.STARRED !== '1') {
      failures.push({ path: row.path, reason: 'star did not round-trip' });
      continue;
    }
    if (back.comment !== FACTS.note) {
      failures.push({ path: row.path, reason: `comment did not round-trip (got ${back.comment})` });
      continue;
    }
    if (back.bpm !== FACTS.bpm) {
      failures.push({ path: row.path, reason: `tempo did not round-trip (got ${back.bpm})` });
      continue;
    }
    if (back.rating === 100) ratingVisible++;
    if (hadArt) {
      // Artwork is worth its own failure rather than a statistic: a migration
      // that silently strips covers from 4,000 files is not a success.
      if (await hasArtwork(dest)) artworkKept++;
      else {
        failures.push({ path: row.path, reason: 'artwork lost' });
        continue;
      }
    }
    ok++;
  } catch (e) {
    failures.push({ path: row.path, reason: e instanceof Error ? e.message : String(e) });
  } finally {
    rmSync(copy, { force: true });
    rmSync(dest, { force: true });
  }
  if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${sample.length}…`);
}

const scratch = process.env.SCRATCH ?? tmpdir();
const report = { sampled: sample.length, ok, failures, missing, ratingVisible, artworkHad, artworkKept };
writeFileSync(join(scratch, 'tag-roundtrip.json'), JSON.stringify(report, null, 2));

console.log(`\nsampled          ${sample.length} of ${all.length}`);
console.log(`round-tripped    ${ok}`);
console.log(`FAILED           ${failures.length}`);
console.log(`missing          ${missing}`);
console.log(`rating visible   ${ratingVisible}  (standard rating survived — MP3 only, expected)`);
console.log(`artwork kept     ${artworkKept} of ${artworkHad} that had any`);
for (const f of failures.slice(0, 20)) console.log(`  ${f.reason}\n    ${f.path}`);
console.log(`\nreport: ${join(scratch, 'tag-roundtrip.json')}`);

rmSync(tmp, { recursive: true, force: true });
