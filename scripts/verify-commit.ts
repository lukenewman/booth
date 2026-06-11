// Exercises the commit path end-to-end against an in-memory DB + a synthesized
// WAV take: region extraction → final files on disk → source_link / match_key /
// source_facets rows + duration backfill, plus the conflict (409) and replace flows.
import { Database } from 'bun:sqlite';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const readMig = readdirSync;
import { createWav, appendFloat32, finalizeWav } from '../src/lib/server/recording/wav';
import { commitRegions } from '../src/lib/server/recording/commit';
import type { SessionState } from '../src/lib/server/recording/session';

const MIG = 'src/lib/server/db/migrations';
function freshDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const f of readMig(MIG).sort()) db.exec(readFileSync(join(MIG, f), 'utf8'));
  return db;
}

let failures = 0;
const assert = (c: boolean, m: string) => {
  if (!c) {
    console.error('FAIL:', m);
    failures++;
  } else console.log('ok:', m);
};

const root = mkdtempSync(join(tmpdir(), 'booth-commit-'));
const db = freshDb();

// Seed: artist + release (discogs link) + 2 tracks (discogs links, no duration).
db.prepare(`INSERT INTO artist (id, name) VALUES ('art','Mr. Fingers')`).run();
db.prepare(
  `INSERT INTO release (id, title, artist_id, year, catno) VALUES ('rel','Amnesia','art',1989,'TX-123')`,
).run();
db.prepare(
  `INSERT INTO source_link (entity_kind, entity_id, source, external_id, match_method)
   VALUES ('release','rel','discogs','9999','first_seen')`,
).run();
for (const [id, title, pos] of [
  ['trk1', 'Can You Feel It', '1'],
  ['trk2', 'Washing Machine', '2'],
] as const) {
  db.prepare(
    `INSERT INTO track (id, title, artist_id, release_id, position) VALUES (?,?,?,?,?)`,
  ).run(id, title, 'art', 'rel', pos);
  db.prepare(
    `INSERT INTO source_link (entity_kind, entity_id, source, external_id, match_method)
     VALUES ('track', ?, 'discogs', ?, 'release_position')`,
  ).run(id, `9999-t${pos}`);
}

// Synthesize a take: 2s tone, 1s silence, 2s tone @ 48k stereo.
const SR = 48000;
const tmpDir = join(root, '.tmp', 'sess1');
mkdirSync(tmpDir, { recursive: true });
const takePath = join(tmpDir, 'take-1.wav');
createWav(takePath, SR, 2);
function tone(seconds: number, amp: number): Float32Array {
  const f = SR * seconds;
  const a = new Float32Array(f * 2);
  for (let i = 0; i < f; i++) {
    const v = Math.sin((2 * Math.PI * 440 * i) / SR) * amp;
    a[2 * i] = v;
    a[2 * i + 1] = v;
  }
  return a;
}
appendFloat32(takePath, tone(2, 0.5));
appendFloat32(takePath, tone(1, 0.0));
appendFloat32(takePath, tone(2, 0.5));
finalizeWav(takePath);

const session: SessionState = {
  id: 'sess1',
  releaseId: 'rel',
  tmpDir,
  createdAt: Date.now(),
  takes: [{ id: 'take-1', path: takePath, sampleRate: SR, channels: 2, finalized: true }],
};

// Commit: track1 = 0..2000ms, track2 = 3000..5000ms.
const regions = [
  { takeId: 'take-1', startMs: 0, endMs: 2000, trackId: 'trk1', title: 'Can You Feel It' },
  { takeId: 'take-1', startMs: 3000, endMs: 5000, trackId: 'trk2', title: 'Washing Machine' },
];
const r1 = commitRegions(db, root, session, regions, false);
assert(r1.written === 2, `2 tracks written (got ${r1.written})`);

const dir = join(root, 'Mr. Fingers — Amnesia [TX-123]');
assert(existsSync(dir), 'release dir created');
const files = existsSync(dir) ? readdirSync(dir) : [];
assert(files.includes('01 Can You Feel It.wav'), `track 1 file (${files.join(', ')})`);
assert(files.includes('02 Washing Machine.wav'), 'track 2 file');
assert(!files.some((f) => f.endsWith('.part')), 'no leftover .part files');

const link = db
  .prepare(`SELECT external_id FROM source_link WHERE entity_id='trk1' AND source='local'`)
  .get() as { external_id: string } | undefined;
assert(!!link && link.external_id.startsWith(root), 'local source_link points at the file');
const mk = db
  .prepare(`SELECT key_value FROM match_key WHERE entity_id='trk1' AND key_type='file_path'`)
  .get() as { key_value: string } | undefined;
assert(!!mk && mk.key_value === link?.external_id, 'file_path match_key matches link');
const origin = db
  .prepare(`SELECT value FROM source_facets WHERE entity_id='trk1' AND source='local' AND key='origin'`)
  .get() as { value: string } | undefined;
assert(origin?.value === '"vinyl"', `origin facet = vinyl (got ${origin?.value})`);
const dur = db.prepare(`SELECT duration_ms FROM track WHERE id='trk1'`).get() as { duration_ms: number };
assert(Math.abs(dur.duration_ms - 2000) < 5, `duration backfilled ~2000 (got ${dur.duration_ms})`);

// Conflict: committing again without replace → 409 path (written 0, conflicts listed).
const r2 = commitRegions(db, root, session, regions, false);
assert(r2.written === 0 && r2.conflicts.length === 2, `conflict returns 0 written + 2 conflicts (got ${r2.written}/${r2.conflicts.length})`);

// Replace: overwrites cleanly, still 1 link per track.
const r3 = commitRegions(db, root, session, regions, true);
assert(r3.written === 2, `replace writes 2 (got ${r3.written})`);
const linkCount = (db.prepare(`SELECT COUNT(*) n FROM source_link WHERE entity_id='trk1' AND source='local'`).get() as { n: number }).n;
assert(linkCount === 1, `still one local link after replace (got ${linkCount})`);

rmSync(root, { recursive: true, force: true });
if (failures > 0) process.exit(1);
console.log('verify-commit: all passed');
