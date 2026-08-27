/**
 * Measures the tempo estimator against the Music.app BPM tags already in the
 * library — the only ground truth available, given there is no test framework
 * and no labelled corpus.
 *
 * The tags are not perfect (some are hand-entered, some are whatever a store
 * stamped on a purchase), so this is an agreement rate rather than an accuracy
 * figure. It is still the number that tells you whether the estimator is
 * working at all, and it separates near-misses from octave errors, which are
 * the failure that actually matters.
 *
 * Usage: bun run scripts/measure-tempo-accuracy.ts [--limit N] [--tolerance 2]
 */
import { Database } from 'bun:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { decodeForAnalysis, hasFfmpeg } from '../src/lib/server/analysis/decode';
import { estimateTempo } from '../src/lib/server/analysis/tempo';

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : fallback;
}

const limit = arg('limit', 60);
const tolerance = arg('tolerance', 2);

if (!(await hasFfmpeg())) {
  console.error('ffmpeg not on PATH — install it first (brew install ffmpeg)');
  process.exit(1);
}

const db = new Database(process.env.BOOTH_DB_PATH ?? join(homedir(), '.booth', 'booth.db'), {
  readonly: true,
});

const rows = db
  .prepare(
    `SELECT t.id, t.title, a.name AS artist, sf.value AS tagged, mk.key_value AS path
       FROM source_facets sf
       JOIN track t   ON t.id = sf.entity_id
       JOIN artist a  ON a.id = t.artist_id
       JOIN match_key mk ON mk.entity_kind='track' AND mk.entity_id = t.id AND mk.key_type='file_path'
      WHERE sf.entity_kind='track' AND sf.source='local' AND sf.key='bpm'
      ORDER BY t.id
      LIMIT ?`,
  )
  .all(limit) as { id: string; title: string; artist: string; tagged: string; path: string }[];

console.log(`comparing ${rows.length} tracks against their Music.app tags (±${tolerance} BPM)\n`);

let agree = 0;
let halfTime = 0;
let doubleTime = 0;
let other = 0;
let skipped = 0;
const disagreements: string[] = [];
const started = Date.now();

for (const r of rows) {
  if (!existsSync(r.path)) {
    skipped++;
    continue;
  }
  let est;
  try {
    const samples = await decodeForAnalysis(r.path);
    est = estimateTempo(samples);
  } catch (e) {
    skipped++;
    continue;
  }
  if (!est) {
    skipped++;
    continue;
  }

  const tagged = Number(r.tagged);
  const d = Math.abs(est.bpm - tagged);
  const label = `${r.artist} — ${r.title}`;

  if (d <= tolerance) {
    agree++;
  } else if (Math.abs(est.bpm * 2 - tagged) <= tolerance * 2) {
    halfTime++;
    disagreements.push(`  half-time  tag ${tagged} → ${est.bpm} (conf ${est.confidence})  ${label}`);
  } else if (Math.abs(est.bpm / 2 - tagged) <= tolerance) {
    doubleTime++;
    disagreements.push(`  double     tag ${tagged} → ${est.bpm} (conf ${est.confidence})  ${label}`);
  } else {
    other++;
    disagreements.push(`  differs    tag ${tagged} → ${est.bpm} (conf ${est.confidence})  ${label}`);
  }
}

const compared = agree + halfTime + doubleTime + other;
const elapsed = (Date.now() - started) / 1000;

console.log(disagreements.slice(0, 25).join('\n'));
if (disagreements.length > 25) console.log(`  … and ${disagreements.length - 25} more`);

const pct = (n: number) => (compared ? ((n / compared) * 100).toFixed(1) : '0.0');
console.log(`
compared     ${compared}   (skipped ${skipped}: missing file or undecodable)
agree        ${agree}  (${pct(agree)}%)
half-time    ${halfTime}  (${pct(halfTime)}%)
double-time  ${doubleTime}  (${pct(doubleTime)}%)
other        ${other}  (${pct(other)}%)

within an octave: ${pct(agree + halfTime + doubleTime)}%
${elapsed.toFixed(1)}s for ${compared} tracks (${(elapsed / Math.max(1, compared)).toFixed(2)}s each)`);
