// Verifies the itunes→local merge:
//   1. Migration 006 rewrites source='itunes' rows to 'local' in all four tables.
//   2. Origin-scoped prune: a local-source collate (Apple XML re-sync) must not
//      delete vinyl-rip rows (external_id under the recordings root), but must
//      still prune Apple-origin rows absent from the sync.
import { Database } from 'bun:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { collate } from '../src/lib/server/library/collate';

const MIG = 'src/lib/server/db/migrations';

function freshDb(throughMigration: string): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const f of readdirSync(MIG).sort()) {
    if (f > throughMigration) break;
    db.exec(readFileSync(join(MIG, f), 'utf8'));
  }
  return db;
}

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg);
    failures++;
  } else console.log('ok:', msg);
}

// --- 1. migration rename ---
{
  const db = freshDb('005_cover_art.sql');
  db.prepare(`INSERT INTO artist (id, name) VALUES ('a1','X')`).run();
  db.prepare(`INSERT INTO track (id, title, artist_id) VALUES ('t1','T','a1')`).run();
  db.prepare(
    `INSERT INTO source_link (entity_kind, entity_id, source, external_id, match_method)
     VALUES ('track','t1','itunes','123','file_path')`,
  ).run();
  db.prepare(
    `INSERT INTO source_facets (entity_kind, entity_id, source, key, value)
     VALUES ('track','t1','itunes','rating','"5"')`,
  ).run();
  db.prepare(`INSERT INTO source_state (source, last_synced_at) VALUES ('itunes','now')`).run();
  db.prepare(`INSERT INTO sync_run (id, source) VALUES ('r1','itunes')`).run();

  db.exec(readFileSync(join(MIG, '006_local_source.sql'), 'utf8'));

  for (const t of ['source_link', 'source_facets', 'source_state', 'sync_run']) {
    const n = (db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE source='itunes'`).get() as { n: number }).n;
    assert(n === 0, `${t}: no itunes rows after 006`);
    const m = (db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE source='local'`).get() as { n: number }).n;
    assert(m >= 1, `${t}: local rows present after 006`);
  }
  db.close();
}

// --- 2. origin-scoped prune through the real collate() ---
{
  const ROOT = '/fake/recordings';
  const db = freshDb('006_local_source.sql');

  // Seed: one Apple-origin track + one vinyl-rip track, both source='local'.
  const seed = {
    tracks: [
      {
        externalId: '101',
        title: 'Apple Song',
        artist: 'A',
        filePath: '/Users/x/Music/Music/Media/song.m4a',
      },
      // Vinyl rip seeded directly (the commit endpoint writes these in prod).
    ],
    releases: [],
  };
  collate(db, 'local', seed, { recordingsRoot: ROOT });

  db.prepare(`INSERT INTO track (id, title, artist_id) VALUES ('rip1','Rip','` +
    (db.prepare(`SELECT id FROM artist LIMIT 1`).get() as { id: string }).id + `')`).run();
  db.prepare(
    `INSERT INTO source_link (entity_kind, entity_id, source, external_id, match_method)
     VALUES ('track','rip1','local','${ROOT}/A — B/01 t.wav','file_path')`,
  ).run();

  // Re-sync with a DIFFERENT Apple track only — old Apple track should prune,
  // the vinyl rip must survive.
  const resync = {
    tracks: [
      {
        externalId: '202',
        title: 'New Apple Song',
        artist: 'A',
        filePath: '/Users/x/Music/Music/Media/other.m4a',
      },
    ],
    releases: [],
  };
  const summary = collate(db, 'local', resync, { recordingsRoot: ROOT });

  const ripLink = db
    .prepare(`SELECT 1 FROM source_link WHERE entity_id='rip1' AND source='local'`)
    .get();
  assert(!!ripLink, 'vinyl-rip source_link survives Apple re-sync');
  const ripTrack = db.prepare(`SELECT 1 FROM track WHERE id='rip1'`).get();
  assert(!!ripTrack, 'vinyl-rip track entity survives Apple re-sync');
  const oldApple = db
    .prepare(`SELECT 1 FROM source_link WHERE source='local' AND external_id='101'`)
    .get();
  assert(!oldApple, 'stale Apple-origin link pruned as before');
  assert(summary.tracksDeleted === 1, `exactly one track pruned (got ${summary.tracksDeleted})`);
  db.close();
}

if (failures > 0) process.exit(1);
console.log('verify-local-merge: all passed');
