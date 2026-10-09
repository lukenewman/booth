/**
 * Read-only: how many Bandcamp purchases would match a release. Run against a
 * copy of the database (sqlite3 ~/.booth/booth.db ".backup /tmp/booth-dry.db").
 */
import { Database } from 'bun:sqlite';
import { fetchFanCollection } from '../src/lib/server/genres/bandcamp';
import { buildMatcher, loadMatchInputs } from '../src/lib/server/genres/bandcampMatch';

const [dbPath, username] = process.argv.slice(2);
if (!dbPath || !username) { console.error('usage: bun scripts/dry-run-bandcamp.ts <db copy> <bandcamp username>'); process.exit(1); }
const db = new Database(dbPath) // a copy; readonly can't open a WAL database without its -shm;
const { releases, tracks } = loadMatchInputs(db);
const match = buildMatcher(releases, tracks);
const purchases = await fetchFanCollection(username);
const counts = { matched: 0, ambiguous: 0, unmatched: 0 };
const misses: string[] = [];
for (const p of purchases) {
  const r = match(p);
  counts[r.state]++;
  if (r.state !== 'matched') misses.push(`${r.state.padEnd(9)} ${p.itemType[0]} ${p.artist} — ${p.albumTitle ?? p.title}  ${p.url}`);
}
console.log(JSON.stringify({ purchases: purchases.length, localReleases: releases.length, withHost: releases.filter((r) => r.hosts.size).length, ...counts }));
console.log(misses.join('\n'));
