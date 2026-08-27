import { Database } from 'bun:sqlite';
import { ulid } from 'ulid';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runMigrations } from '../src/lib/server/db/migrate';
import {
  replayEvents,
  appendEvent,
  readEvents,
  type AnnotationEvent,
} from '../src/lib/server/backup/journal';
import { snapshotsToPrune, shouldSnapshot, snapshotDb } from '../src/lib/server/backup/snapshot';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) fail(msg);
}

const root = mkdtempSync(join(tmpdir(), 'booth-backup-'));

// --- replayEvents: the whole point is surviving deletion ---------------------
const ev = (
  at: string,
  action: AnnotationEvent['action'],
  id: string,
  extra: Partial<AnnotationEvent> = {},
): AnnotationEvent => ({
  at,
  kind: action === 'star' || action === 'unstar' ? 'track' : 'release',
  id,
  action,
  value: action === 'star' || action === 'vet' ? at : null,
  artist: 'A',
  title: 'T-' + id,
  album: null,
  ...extra,
});

const t1 = ulid();
const t2 = ulid();
const r1 = ulid();

const history: AnnotationEvent[] = [
  ev('2026-08-26T10:00:00.000Z', 'star', t1),
  ev('2026-08-26T11:00:00.000Z', 'star', t2),
  ev('2026-08-26T12:00:00.000Z', 'vet', r1),
  // the accident: everything unstarred in a burst
  ev('2026-08-26T21:18:00.000Z', 'unstar', t1),
  ev('2026-08-26T21:18:01.000Z', 'unstar', t2),
];

const now = replayEvents(history);
assert(now.stars.size === 0, `after the burst, current state has no stars (got ${now.stars.size})`);
assert(now.vetted.size === 1, 'vetting was untouched by the burst');

// Rewinding is the recovery path: state as of just before the burst.
const before = replayEvents(history, '2026-08-26T21:00:00.000Z');
assert(before.stars.size === 2, `as-of rewind should see 2 stars, got ${before.stars.size}`);
assert(before.stars.get(t1) === '2026-08-26T10:00:00.000Z', 't1 keeps its original timestamp');
assert(before.vetted.get(r1) === '2026-08-26T12:00:00.000Z', 'r1 vetted timestamp preserved');

// A later star event wins — the journal is a log of what happened, not a merge.
const restar = replayEvents([
  ev('2026-08-26T10:00:00.000Z', 'star', t1),
  ev('2026-08-26T20:00:00.000Z', 'star', t1),
]);
assert(restar.stars.get(t1) === '2026-08-26T20:00:00.000Z', 'latest star event wins');

// Name keys ride along so a rebuilt DB can be matched by name.
assert(before.byName.size === 2, `expected 2 name-keyed stars, got ${before.byName.size}`);
assert(before.byName.has('A T-' + t1), 'name key present for t1');

// --- notes rewind like everything else --------------------------------------
const noteHistory: AnnotationEvent[] = [
  { ...ev('2026-08-26T10:00:00.000Z', 'star', t1), action: 'note', value: 'peak time roller' },
  { ...ev('2026-08-26T21:18:00.000Z', 'star', t1), action: 'note', value: null },
];
assert(replayEvents(noteHistory).notes.size === 0, 'a cleared note leaves no note in current state');
const notesBefore = replayEvents(noteHistory, '2026-08-26T21:00:00.000Z');
assert(notesBefore.notes.get(t1) === 'peak time roller', 'as-of rewind restores the note text');

// --- append + read round-trip ----------------------------------------------
const logPath = join(root, 'annotations.log');
for (const e of history) appendEvent(logPath, e);
const readBack = readEvents(logPath);
assert(
  readBack.length === history.length,
  `journal round-trip: ${readBack.length} vs ${history.length}`,
);
assert(readBack[0].id === history[0].id, 'journal preserves order');

// A corrupt line must not take the whole journal down — it is the recovery
// artifact, so partial readability beats strictness.
const good = readEvents(logPath).map((e) => JSON.stringify(e)).join('\n');
writeFileSync(logPath, good + '\n{ not json\n');
assert(
  readEvents(logPath).length === history.length,
  'corrupt trailing line is skipped, the rest survives',
);

// --- snapshot retention -----------------------------------------------------
const files = [
  { name: 'booth-20260820-000000.db', mtimeMs: 1 },
  { name: 'booth-20260821-000000.db', mtimeMs: 2 },
  { name: 'booth-20260822-000000.db', mtimeMs: 3 },
  { name: 'booth-20260823-000000.db', mtimeMs: 4 },
];
assert(snapshotsToPrune(files, 10).length === 0, 'under the cap prunes nothing');
const pruned = snapshotsToPrune(files, 2);
assert(pruned.length === 2, `keep=2 of 4 should prune 2, got ${pruned.length}`);
assert(
  pruned.map((f) => f.name).join() === 'booth-20260820-000000.db,booth-20260821-000000.db',
  'prunes oldest first',
);

// --- snapshot min-interval --------------------------------------------------
// `bun dev` restarts constantly; without this guard boot snapshots would
// rotate every real backup out within a minute of development.
const HOUR = 3_600_000;
assert(shouldSnapshot(null, 0, HOUR), 'no previous snapshot means always take one');
assert(!shouldSnapshot(1000, 1000 + HOUR - 1, HOUR), 'inside the interval means skip');
assert(shouldSnapshot(1000, 1000 + HOUR, HOUR), 'at the interval means take');

// --- snapshotDb actually produces a readable database -----------------------
const db = new Database(':memory:');
runMigrations(db);
const artistId = ulid();
db.prepare(`INSERT INTO artist (id, name) VALUES (?, ?)`).run(artistId, 'Snapshot Artist');
const relId = ulid();
db.prepare(`INSERT INTO release (id, title, artist_id, year) VALUES (?, ?, ?, 2020)`).run(
  relId,
  'Snapshot Release',
  artistId,
);
db.prepare(`UPDATE release SET vetted_at = '2026-08-26T00:00:00.000Z' WHERE id = ?`).run(relId);

const snapDir = join(root, 'snapshots');
const written = snapshotDb(db, { dir: snapDir, keep: 3, now: new Date('2026-08-26T21:00:00Z') });
assert(written !== null, 'snapshotDb should report the file it wrote');
assert(existsSync(written!), `snapshot file should exist at ${written}`);

const restored = new Database(written!, { readonly: true });
const row = restored.prepare(`SELECT title, vetted_at FROM release WHERE id = ?`).get(relId) as
  | { title: string; vetted_at: string | null }
  | undefined;
assert(row?.title === 'Snapshot Release', 'snapshot contains the release');
assert(row?.vetted_at === '2026-08-26T00:00:00.000Z', 'snapshot preserves annotations');
restored.close();

// Retention applies on write.
for (let i = 0; i < 5; i++) {
  snapshotDb(db, { dir: snapDir, keep: 3, now: new Date(Date.UTC(2026, 7, 20 + i, 12)) });
}
const kept = readdirSync(snapDir).filter((f) => f.endsWith('.db'));
assert(kept.length === 3, `retention should cap at 3, found ${kept.length}`);

rmSync(root, { recursive: true, force: true });
console.log('OK: verify-backup');
