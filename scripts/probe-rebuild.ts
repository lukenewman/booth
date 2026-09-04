/**
 * probe-rebuild.ts — could the database be rebuilt from the files alone?
 *
 * The file-owned design claims the database is a rebuildable index rather than
 * the original. This reconstructs what a rebuild would produce from tags alone
 * and diffs it against the real database.
 *
 * Today no Booth tags have been written, so the gap this reports IS the
 * specification for the tag schema: every field listed as unrecoverable is one
 * slice 2 must write into files, or one Booth would lose forever.
 *
 * READ-ONLY: reads files and the database, writes only a report.
 *
 * Run: bun verify scripts/probe-rebuild.ts [--limit N]
 */
import { Database } from 'bun:sqlite';
import { existsSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTags } from '../src/lib/server/library/tags';

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
  title: string;
  album: string | null;
  artist: string;
  starred: string | null;
  note: string | null;
}

const rows = (
  db
    .prepare(
      `SELECT t.id AS trackId, mk.key_value AS path, t.title, t.album, a.name AS artist,
              t.starred_at AS starred, t.note AS note
         FROM match_key mk
         JOIN track t   ON t.id = mk.entity_id
         JOIN artist a  ON a.id = t.artist_id
        WHERE mk.entity_kind='track' AND mk.key_type='file_path'`,
    )
    .all() as Row[]
).slice(0, limit === Infinity ? undefined : limit);

/** Per-track local facets, keyed by track id then facet key. Values are whatever
 *  the facet stored — strings for dates, numbers for tempo — so `unknown`, not `string`. */
const facets = new Map<string, Record<string, unknown>>();
for (const f of db
  .prepare(`SELECT entity_id, key, value FROM source_facets WHERE source='local' AND entity_kind='track'`)
  .all() as { entity_id: string; key: string; value: string }[]) {
  const rec = facets.get(f.entity_id) ?? {};
  rec[f.key] = JSON.parse(f.value);
  facets.set(f.entity_id, rec);
}

const norm = (s?: string | null) =>
  (s ?? '').normalize('NFD').replace(/\p{Diacritic}+/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Fields a rebuild would get right today, and fields it would lose. */
const recoverable: Record<string, number> = {};
const lost: Record<string, number> = {};
function tally(bucket: Record<string, number>, key: string) {
  bucket[key] = (bucket[key] ?? 0) + 1;
}

let read = 0;
let missing = 0;
let unreadable = 0;

for (const [i, row] of rows.entries()) {
  if (!existsSync(row.path)) {
    missing++;
    continue;
  }
  let tags;
  try {
    tags = await readTags(row.path);
  } catch {
    unreadable++;
    continue;
  }
  read++;

  // Identity and naming — what the files already carry.
  tally(norm(tags.title) === norm(row.title) ? recoverable : lost, 'title');
  tally(norm(tags.artist) === norm(row.artist) ? recoverable : lost, 'artist');
  tally(norm(tags.album) === norm(row.album) ? recoverable : lost, 'album');

  // Booth-native facts — present in the DB, and only recoverable if a Booth tag carries them.
  const f = facets.get(row.trackId) ?? {};
  if (row.starred) tally(tags.booth.STARRED ? recoverable : lost, 'starred');
  if (row.note) tally(tags.booth.NOTE ? recoverable : lost, 'note');
  if (f.dateAdded) tally(tags.booth.DATE_ADDED ? recoverable : lost, 'dateAdded');
  if (f.dateAddedOrigin) tally(tags.booth.DATE_ADDED_ORIGIN ? recoverable : lost, 'dateAddedOrigin');
  if (f.bpmAnalyzed) tally(tags.bpm != null ? recoverable : lost, 'bpmAnalyzed');
  if (f.genre) tally(tags.genre ? recoverable : lost, 'genre');

  if ((i + 1) % 500 === 0) console.log(`  ${i + 1}/${rows.length}…`);
}

// Release-level facts have no per-file home and must be denormalised onto tracks.
const vetted = db.prepare(`SELECT COUNT(*) AS n FROM release WHERE vetted_at IS NOT NULL`).get() as { n: number };
const playlists = db.prepare(`SELECT COUNT(*) AS n FROM playlist`).get() as { n: number };

const scratch = process.env.SCRATCH ?? tmpdir();
const report = { read, missing, unreadable, recoverable, lost, vettedReleases: vetted.n, playlists: playlists.n };
writeFileSync(join(scratch, 'rebuild-gap.json'), JSON.stringify(report, null, 2));

console.log(`\nread ${read} files (${missing} missing, ${unreadable} unreadable)\n`);
console.log('Recoverable from tags as they stand today:');
for (const [k, n] of Object.entries(recoverable).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(18)} ${n}`);
console.log('\nLOST on a rebuild today — the tag schema slice 2 must carry:');
for (const [k, n] of Object.entries(lost).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(18)} ${n}`);
console.log(`\nNo per-file home, need denormalising or sidecar files:`);
console.log(`  vetted releases    ${vetted.n}  (stamp on every track of the release)`);
console.log(`  playlists          ${playlists.n}  (write as playlist files alongside the tree)`);
console.log(`\nreport: ${join(scratch, 'rebuild-gap.json')}`);
