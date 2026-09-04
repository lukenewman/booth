/**
 * probe-tag-plan.ts — what a full tagging pass would write, without writing it.
 *
 * The artefact reviewed before slice 3 touches a real file. It reads every
 * Booth fact currently in the database, maps it through the tag schema, and
 * reports the shape of the write: how many files get each field, and how many
 * get nothing at all.
 *
 * READ-ONLY: opens the database read-only and touches no audio file.
 *
 * Run: bun verify scripts/probe-tag-plan.ts [--limit N]
 */
import { Database } from 'bun:sqlite';
import { writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { toTagWrite, type BoothTrackFacts } from '../src/lib/server/library/tag_schema';

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback;
}
const limit = arg('limit', Infinity);

const dbPath = process.env.BOOTH_DB_PATH ?? join(homedir(), '.booth', 'booth.db');
const db = new Database(dbPath, { readonly: true });

interface Row {
  trackId: string;
  path: string;
  releaseId: string | null;
  starred: string | null;
  note: string | null;
  vetted: string | null;
}

const rows = (
  db
    .prepare(
      `SELECT t.id AS trackId, mk.key_value AS path, t.release_id AS releaseId,
              t.starred_at AS starred, t.note AS note, r.vetted_at AS vetted
         FROM match_key mk
         JOIN track t        ON t.id = mk.entity_id
         LEFT JOIN release r ON r.id = t.release_id
        WHERE mk.entity_kind='track' AND mk.key_type='file_path'`,
    )
    .all() as Row[]
).slice(0, limit === Infinity ? undefined : limit);

const facetRows = db
  .prepare(`SELECT entity_id, key, value FROM source_facets WHERE source='local' AND entity_kind='track'`)
  .all() as { entity_id: string; key: string; value: string }[];
const facets = new Map<string, Record<string, unknown>>();
for (const f of facetRows) {
  const rec = facets.get(f.entity_id) ?? {};
  rec[f.key] = JSON.parse(f.value);
  facets.set(f.entity_id, rec);
}

const discogs = new Map<string, string>();
for (const d of db
  .prepare(`SELECT entity_id, external_id FROM source_link WHERE source='discogs' AND entity_kind='release'`)
  .all() as { entity_id: string; external_id: string }[]) {
  discogs.set(d.entity_id, d.external_id);
}

const fieldCounts: Record<string, number> = {};
const plan: { path: string; fields: string[] }[] = [];
let empty = 0;

for (const row of rows) {
  const f = facets.get(row.trackId) ?? {};
  const facts: BoothTrackFacts = {
    dateAdded: typeof f.dateAdded === 'string' ? f.dateAdded : undefined,
    dateAddedReported: typeof f.dateAddedReported === 'string' ? f.dateAddedReported : undefined,
    dateAddedOrigin: typeof f.dateAddedOrigin === 'string' ? f.dateAddedOrigin : undefined,
    starred: row.starred != null,
    note: row.note ?? undefined,
    vetted: row.vetted != null,
    bpm: typeof f.bpmAnalyzed === 'number' ? f.bpmAnalyzed : undefined,
    origin: typeof f.origin === 'string' ? f.origin : undefined,
    discogsReleaseId: row.releaseId ? discogs.get(row.releaseId) : undefined,
  };
  const write = toTagWrite(facts);
  const fields = [
    ...Object.keys(write.custom),
    ...(write.comment !== undefined ? ['comment'] : []),
    ...(write.bpm !== undefined ? ['bpm'] : []),
    ...(write.ratingStars !== undefined ? ['rating'] : []),
  ];
  for (const field of fields) fieldCounts[field] = (fieldCounts[field] ?? 0) + 1;
  if (fields.length === 0) empty++;
  plan.push({ path: row.path, fields });
}

const scratch = process.env.SCRATCH ?? tmpdir();
writeFileSync(join(scratch, 'tag-plan.json'), JSON.stringify({ fieldCounts, empty, plan }, null, 2));

console.log(`\ntracks considered  ${rows.length}`);
console.log(`nothing to write   ${empty}\n`);
console.log('Fields a full pass would write:');
for (const [k, n] of Object.entries(fieldCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(28)} ${n}`);
}
console.log(`\nreport: ${join(scratch, 'tag-plan.json')}`);
