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

// A sync that drops records must say which ones, not just "−2".
const db2 = new Database(':memory:');
db2.exec('PRAGMA foreign_keys = ON');
runMigrations(db2);
collate(db2, 'local', {
  releases: [
    { externalId: 'alb:a', title: 'Alpha', artist: 'X' },
    { externalId: 'alb:b', title: 'Beta', artist: 'Y' },
  ],
  tracks: [
    { externalId: 't1', title: 'One', artist: 'X', releaseExternalId: 'alb:a' },
    { externalId: 't2', title: 'Two', artist: 'Y', releaseExternalId: 'alb:b' },
  ],
});
const s2 = collate(db2, 'local', {
  releases: [{ externalId: 'alb:a', title: 'Alpha', artist: 'X' }],
  tracks: [{ externalId: 't1', title: 'One', artist: 'X', releaseExternalId: 'alb:a' }],
});
eq([s2.releasesDeleted, s2.tracksDeleted], [1, 1], 'counts');
eq(s2.removed, [{ kind: 'release', name: 'Y — Beta' }, { kind: 'track', name: 'Y — Two' }], 'removed names');
const s3 = collate(db2, 'local', {
  releases: [{ externalId: 'alb:a', title: 'Alpha', artist: 'X' }],
  tracks: [{ externalId: 't1', title: 'One', artist: 'X', releaseExternalId: 'alb:a' }],
});
eq(s3.removed, undefined, 'absent when nothing removed');
console.log('ok removed names');
