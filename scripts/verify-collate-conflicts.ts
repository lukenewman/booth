// A conflict must say which records it was about, not just bump a counter —
// "5 conflicts" on every sync is otherwise uninvestigable.
import { Database } from 'bun:sqlite';
import { runMigrations } from '../src/lib/server/db/migrate';
import { collate } from '../src/lib/server/library/collate';

function eq(a: unknown, e: unknown, m: string) {
  if (JSON.stringify(a) !== JSON.stringify(e)) { console.error(`FAIL ${m}: got ${JSON.stringify(a)}, want ${JSON.stringify(e)}`); process.exit(1); }
}
const db = new Database(':memory:');
db.exec('PRAGMA foreign_keys = ON');
runMigrations(db);
// Two local album groups that differ only by year resolve to one release
// (artist + album fallback key): the second can't take the link.
const s = collate(db, 'local', {
  releases: [
    { externalId: 'itunes-album:one', title: 'Discovery', artist: 'Daft Punk', year: 2001 },
    { externalId: 'itunes-album:two', title: 'Discovery', artist: 'Daft Punk', year: 2014 },
  ],
  tracks: [],
});
eq(s.conflicts, 1, 'one conflict');
eq(s.conflictDetails, [{
  kind: 'release', externalId: 'itunes-album:two', name: 'Daft Punk — Discovery (2014)',
  reason: 'entity already linked', entity: 'Daft Punk — Discovery', heldBy: 'itunes-album:one',
}], 'details name both sides');
console.log('ok verify-collate-conflicts');
