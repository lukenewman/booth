/**
 * The migration planner and the pass it feeds, against a scratch library.
 *
 * Never touches the real database or the real music. Builds its own DB and
 * copies a couple of real files into a temp directory to act as originals.
 */
import { Database } from 'bun:sqlite';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { runMigrations } from '../src/lib/server/db/migrate';
import { collate } from '../src/lib/server/library/collate';
import { setTrackStar, setReleaseVetted } from '../src/lib/server/library/annotations';
import { collectMigrationPlan } from '../src/lib/server/library/migration';
import { writeTags } from '../src/lib/server/library/tag_writer';
import { readTags } from '../src/lib/server/library/tags';
import { audioFingerprint } from '../src/lib/server/library/fingerprint';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) fail(msg);
}

// A real MP3 from the library, copied out to act as an untouched original.
const REAL = '/Users/luke/Music/Music/Media.localized/Music/Ottagone/Ottagone.11/01 Ottagone 058.mp3';
if (!existsSync(REAL)) {
  console.log('SKIP: verify-migration (sample file not present)');
  process.exit(0);
}

const root = mkdtempSync(join(tmpdir(), 'booth-mig-'));
const originals = join(root, 'originals');
const tree = join(root, 'tree');
mkdirSync(originals, { recursive: true });

const srcA = join(originals, '01 Ottagone 058.mp3');
const srcB = join(originals, '02 Ottagone 059.mp3');
copyFileSync(REAL, srcA);
copyFileSync(REAL, srcB);

const db = new Database(':memory:');
runMigrations(db);
collate(db, 'local', {
  releases: [{ externalId: 'alb', title: 'Ottagone.11', artist: 'Ottagone', year: 2026 }],
  tracks: [
    { externalId: 'p1', title: 'Ottagone 058', artist: 'Ottagone', album: 'Ottagone.11',
      position: '1', filePath: srcA, releaseExternalId: 'alb', facets: { bpmAnalyzed: 138 } },
    { externalId: 'p2', title: 'Ottagone 059', artist: 'Ottagone', album: 'Ottagone.11',
      position: '2', filePath: srcB, releaseExternalId: 'alb', facets: {} },
  ],
});
const ids = db.prepare(`SELECT id, title FROM track ORDER BY title`).all() as { id: string; title: string }[];
setTrackStar(db, ids[0].id, true);
const releaseId = (db.prepare(`SELECT id FROM release`).get() as { id: string }).id;
setReleaseVetted(db, releaseId, true);

// --- The plan ------------------------------------------------------
const plan = collectMigrationPlan(db, { libraryRoot: tree });
assert(plan.entries.length === 2, `two tracks planned, got ${plan.entries.length}`);
assert(plan.byStatus.ready === 2, `both ready, got ${JSON.stringify(plan.byStatus)}`);
assert(plan.totalBytes === statSync(srcA).size * 2, 'bytes counted from the real files');

const starred = plan.entries.find((e) => e.facts.starred)!;
assert(starred.fields.includes('rating'), `the starred track gets a rating: ${starred.fields}`);
assert(starred.fields.includes('BOOTH_STARRED'), 'and the custom carrier, which survives a rebuild');
assert(
  plan.entries.every((e) => e.fields.includes('BOOTH_VETTED')),
  'vetted is per-release, so it stamps onto every track of the release',
);
assert(
  plan.entries.every((e) => e.target.startsWith(tree + '/Ottagone/Ottagone.11/')),
  `tree layout is artist/album/, got ${plan.entries[0].target}`,
);
assert(
  plan.entries.some((e) => e.target.endsWith('01 Ottagone 058.mp3')),
  `track number prefixes the title, got ${plan.entries.map((e) => basename(e.target))}`,
);

// --- A missing file is reported, not attempted ----------------------
rmSync(srcB);
const afterDelete = collectMigrationPlan(db, { libraryRoot: tree });
assert(afterDelete.byStatus.missing === 1, `missing file detected, got ${afterDelete.byStatus.missing}`);
assert(afterDelete.byStatus.ready === 1, 'the surviving file is still ready');
copyFileSync(REAL, srcB);

// --- The pass itself -------------------------------------------------
const fresh = collectMigrationPlan(db, { libraryRoot: tree });
for (const entry of fresh.entries) {
  const { mkdirSync: mk } = await import('node:fs');
  mk(join(entry.target, '..'), { recursive: true });
  await writeTags(entry.source, entry.facts, entry.target);
}

for (const entry of fresh.entries) {
  assert(existsSync(entry.target), `copy exists: ${entry.target}`);
  // The guarantee the whole pass rests on: the audio is byte-identical.
  const before = await audioFingerprint(entry.source);
  const after = await audioFingerprint(entry.target);
  assert(before === after, `audio unchanged for ${basename(entry.target)}`);
  const tags = await readTags(entry.target);
  assert(tags.booth.VETTED === '1', `vetted written: ${JSON.stringify(tags.booth)}`);
  if (entry.facts.starred) {
    assert(tags.booth.STARRED === '1', 'star written to the custom carrier');
    assert(tags.rating !== undefined, 'and to the standard rating, which rekordbox reads');
  }
  if (entry.facts.bpm) assert(tags.bpm === entry.facts.bpm, `bpm written: ${tags.bpm}`);
}

// --- Originals are untouched ----------------------------------------
const origFp = await audioFingerprint(srcA);
assert(origFp === (await audioFingerprint(fresh.entries[0].target)), 'original still matches its copy');
assert((await readTags(srcA)).booth.STARRED === undefined, 'the original was never tagged');

rmSync(root, { recursive: true, force: true });
console.log('OK: migration plan + pass');
