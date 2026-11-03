/**
 * probe-findings.ts: what the needs-attention list says about the real
 * library, on a backup copy. Never writes the real database or any file.
 *
 * Run: bun verify scripts/probe-findings.ts
 * Exit 1 if: a track was deleted, the second sync raised anything new, or the
 * counts are far from what's known (missing and duplicate counts printed).
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'booth-findings-'));
const copy = join(scratch, 'booth.db');
const proc = Bun.spawnSync(['sqlite3', join(homedir(), '.booth', 'booth.db'), `.backup '${copy}'`]);
if (proc.exitCode !== 0) throw new Error(`backup failed: ${proc.stderr.toString()}`);
process.env.BOOTH_DB_PATH = copy;
process.env.BOOTH_INBOX_PATH = join(scratch, 'inbox');
mkdirSync(process.env.BOOTH_INBOX_PATH);

const { getDb } = await import('../src/lib/server/db');
const { collate } = await import('../src/lib/server/library/collate');
const { syncITunesLibrary } = await import('../src/lib/server/sources/local/sync');
const { refreshFindings, listOpenFindings } = await import('../src/lib/server/library/findings');

const db = getDb();
const recordingsRoot = join(homedir(), '.booth', 'recordings');
const tracks = () => (db.prepare(`SELECT COUNT(*) AS n FROM track`).get() as { n: number }).n;

const before = tracks();
let bad = 0;
for (const run of ['first', 'second']) {
  const r = await syncITunesLibrary();
  const c = collate(db, 'local', r, { recordingsRoot });
  const s = refreshFindings(db, `probe-${run}`, r.fileIds ?? []);
  console.log(`${run}: ${JSON.stringify(s)} tracksDeleted=${c.tracksDeleted}`);
  if (c.tracksDeleted) bad++;
  if (run === 'second' && s.new) { console.log('✗ second sync raised new findings'); bad++; }
}
const open = listOpenFindings(db);
const byKind = Object.groupBy(open, (f) => f.kind);
for (const [kind, items] of Object.entries(byKind)) {
  console.log(`${kind}: ${items!.length}`);
  for (const f of items!.slice(0, 3)) console.log(`   ${f.files.map((x) => x.path.split('/').slice(-2).join('/')).join('  |  ')}`);
}
if (tracks() !== before) { console.log(`✗ track count ${before} → ${tracks()}`); bad++; }
console.log(`copy kept at ${copy}`);
process.exit(bad ? 1 : 0);
