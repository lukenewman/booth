/**
 * One-off backfill of Music.app BPM tags into `source_facets`.
 *
 * The local sync writes these itself now, so this exists only to get the data in
 * without waiting for the next full sync. It is deliberately additive: it matches
 * on the persistent id already in `source_link` and writes one facet key. It
 * never inserts, prunes or deletes an entity, and it never touches any other
 * facet key — a full `collate()` would have been the obvious route, but collate
 * prunes, and pruning has no business running unattended against a real library.
 *
 * Idempotent: re-running rewrites the same values.
 *
 * Usage: bun run scripts/backfill-bpm-tags.ts [--dry-run]
 */
import { Database } from 'bun:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseITunesLibrary } from '../src/lib/server/sources/local/parse';
import { BPM_KEY_TAG } from '../src/lib/server/library/bpm';

const dryRun = process.argv.includes('--dry-run');

const xmlPath = process.env.ITUNES_XML_PATH ?? join(homedir(), 'Music', 'Library.xml');
const dbPath = process.env.BOOTH_DB_PATH ?? join(homedir(), '.booth', 'booth.db');

const lib = parseITunesLibrary(xmlPath);
const tagged = lib.tracks.filter((t) => t.persistentId && typeof t.bpm === 'number' && t.bpm > 0);
console.log(`parsed ${lib.tracks.length} tracks, ${tagged.length} carry a BPM tag`);

const db = dryRun
  ? new Database(dbPath, { readonly: true })
  : new Database(dbPath, { readwrite: true });

const findEntity = db.prepare(
  `SELECT entity_id FROM source_link
    WHERE entity_kind='track' AND source='local' AND external_id = ?`,
);
const writeFacet = db.prepare(
  `INSERT INTO source_facets (entity_kind, entity_id, source, key, value)
   VALUES ('track', ?, 'local', '${BPM_KEY_TAG}', ?)
   ON CONFLICT (entity_kind, entity_id, source, key)
   DO UPDATE SET value = excluded.value,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
);

let written = 0;
let unmatched = 0;

const apply = db.transaction(() => {
  for (const t of tagged) {
    const row = findEntity.get(t.persistentId!) as { entity_id: string } | undefined;
    if (!row) {
      unmatched++;
      continue;
    }
    if (!dryRun) writeFacet.run(row.entity_id, String(t.bpm));
    written++;
  }
});
apply();

console.log(
  `${dryRun ? '[dry-run] would write' : 'wrote'} ${written} bpm facets; ${unmatched} tagged tracks had no local source_link`,
);

const total = db
  .prepare(`SELECT COUNT(*) n FROM source_facets WHERE key = ? AND source='local'`)
  .get(BPM_KEY_TAG) as { n: number };
console.log(`source_facets now holds ${total.n} local bpm rows`);
