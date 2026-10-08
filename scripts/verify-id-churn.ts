// Verifies that a source renumbering an external_id does not destroy the entity.
//
// Regression cover for 2026-08-14: Music.app renumbers its XML "Track ID" on
// purge/re-export. collate matched the track by file_path, found the entity
// already held the OLD id, counted a conflict and skipped the update — then the
// prune deleted the stale link and the entity behind it. 924 tracks vanished
// while still present in the library. The local adapter now keys on the stable
// Persistent ID, and an authoritative file_path match rewrites a moved id.
import { Database } from 'bun:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { collate } from '../src/lib/server/library/collate';
import type { SyncResult } from '../src/lib/server/sources/types';

const MIG = 'src/lib/server/db/migrations';

function freshDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const f of readdirSync(MIG).sort()) db.exec(readFileSync(join(MIG, f), 'utf8'));
  return db;
}

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg);
    failures++;
  } else console.log('ok:', msg);
}

const FILE = 'file:///Users/luke/Music/Music/Media.localized/Music/A/B/01%20Dust%20to%20Dust.m4a';

function syncWith(externalId: string): SyncResult {
  return {
    releases: [{ externalId: 'itunes-album:abc', title: 'B', artist: 'A', year: 2020 }],
    tracks: [
      {
        externalId,
        title: 'Dust to Dust',
        artist: 'A',
        album: 'B',
        position: '1',
        filePath: FILE,
        releaseExternalId: 'itunes-album:abc',
      },
    ],
  };
}

// --- 1. a renumbered external_id must relink, not delete ---
{
  const db = freshDb();
  collate(db, 'local', syncWith('2375'));

  const before = db
    .prepare(`SELECT id FROM track`)
    .all() as { id: string }[];
  assert(before.length === 1, 'first sync creates the track');
  const entityId = before[0].id;

  // Same file, new Track ID — exactly what a Music.app re-export produces.
  const summary = collate(db, 'local', syncWith('99999'));

  const after = db.prepare(`SELECT id FROM track`).all() as { id: string }[];
  assert(after.length === 1, 'track survives the renumber');
  assert(after[0]?.id === entityId, 'entity id is preserved (playlists keep pointing at it)');
  assert(summary.tracksDeleted === 0, `no deletions (got ${summary.tracksDeleted})`);
  assert(summary.relinked === 1, `relinked counted (got ${summary.relinked})`);
  assert(summary.conflicts === 0, `no conflict counted (got ${summary.conflicts})`);

  const link = db
    .prepare(`SELECT external_id FROM source_link WHERE entity_kind='track' AND source='local'`)
    .get() as { external_id: string } | undefined;
  assert(link?.external_id === '99999', `link points at the new id (got ${link?.external_id})`);

  const links = db
    .prepare(`SELECT COUNT(*) c FROM source_link WHERE entity_kind='track' AND source='local'`)
    .get() as { c: number };
  assert(links.c === 1, `exactly one link remains (got ${links.c})`);
}

// --- 2. playlist membership survives a renumber ---
{
  const db = freshDb();
  collate(db, 'local', syncWith('2375'));
  const trackId = (db.prepare(`SELECT id FROM track`).get() as { id: string }).id;
  db.prepare(`INSERT INTO playlist (id, name) VALUES ('p1','Crate')`).run();
  db.prepare(
    `INSERT INTO playlist_section (id, playlist_id, name, position, is_unsorted) VALUES ('s1','p1','Unsorted',0,1)`,
  ).run();
  db.prepare(
    `INSERT INTO playlist_track (id, playlist_id, section_id, track_id, position) VALUES ('e1','p1','s1',?,0)`,
  ).run(trackId);

  collate(db, 'local', syncWith('88888'));

  // Membership rows no longer cascade away (track_id goes NULL instead), so
  // check the row still points at the same track, not just that it exists.
  const n = db
    .prepare(`SELECT COUNT(*) c FROM playlist_track WHERE track_id = ?`)
    .get(trackId) as { c: number };
  assert(n.c === 1, `playlist membership survives (got ${n.c})`);
}

// --- 3. a genuinely removed track is still pruned ---
{
  const db = freshDb();
  collate(db, 'local', syncWith('2375'));
  const gone: SyncResult = {
    releases: [{ externalId: 'itunes-album:abc', title: 'B', artist: 'A', year: 2020 }],
    tracks: [
      {
        externalId: 'other',
        title: 'Something Else',
        artist: 'A',
        album: 'B',
        position: '2',
        filePath: 'file:///Users/luke/Music/other.m4a',
        releaseExternalId: 'itunes-album:abc',
      },
    ],
  };
  const summary = collate(db, 'local', gone);
  assert(summary.tracksDeleted === 1, `real deletions still prune (got ${summary.tracksDeleted})`);
  const titles = (db.prepare(`SELECT title FROM track`).all() as { title: string }[]).map(
    (r) => r.title,
  );
  assert(
    titles.length === 1 && titles[0] === 'Something Else',
    `only the surviving track remains (got ${JSON.stringify(titles)})`,
  );
}

// --- 4. weaker matches still count a conflict rather than clobbering ---
{
  const db = freshDb();
  // Two distinct files claiming the same release position: ambiguous, must not relink.
  collate(db, 'local', syncWith('2375'));
  const ambiguous: SyncResult = {
    releases: [{ externalId: 'itunes-album:abc', title: 'B', artist: 'A', year: 2020 }],
    tracks: [
      {
        externalId: '2375',
        title: 'Dust to Dust',
        artist: 'A',
        album: 'B',
        position: '1',
        filePath: FILE,
        releaseExternalId: 'itunes-album:abc',
      },
      {
        externalId: 'dupe',
        title: 'Dust to Dust (copy)',
        artist: 'A',
        album: 'B',
        position: '1',
        filePath: 'file:///Users/luke/Music/copy.m4a',
        releaseExternalId: 'itunes-album:abc',
      },
    ],
  };
  const summary = collate(db, 'local', ambiguous);
  assert(summary.conflicts === 1, `ambiguous position match still conflicts (got ${summary.conflicts})`);
  assert(summary.relinked === 0, `and does not relink (got ${summary.relinked})`);
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
