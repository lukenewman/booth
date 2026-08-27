// Verifies which tracks the analysis pass considers outstanding, and that a
// pass which found nothing usable still records the attempt.
//
// The estimator itself is covered by verify-tempo.ts; this is about the
// bookkeeping around it, which is where a background pass wired into every sync
// can quietly waste a lot of work.
import { Database } from 'bun:sqlite';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { runMigrations } from '../src/lib/server/db/migrate';
import { collate } from '../src/lib/server/library/collate';
import { BPM_KEY_ANALYZED } from '../src/lib/server/library/bpm';
import {
  BPM_CONFIDENCE_KEY,
  analyzeTracks,
  isAnalysisRunning,
  pendingAnalysis,
  startBackgroundAnalysis,
} from '../src/lib/server/analysis/run';

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg);
    failures++;
  } else console.log('ok:', msg);
}

const db = new Database(':memory:');
runMigrations(db);

collate(db, 'local', {
  releases: [{ externalId: 'alb', title: 'Homework', artist: 'Daft Punk', year: 1997 }],
  tracks: ['a', 'b', 'c'].map((k, i) => ({
    externalId: k,
    title: `Track ${k}`,
    artist: 'Daft Punk',
    album: 'Homework',
    position: String(i + 1),
    filePath: `/tmp/booth-verify-analysis/${k}.mp3`,
    releaseExternalId: 'alb',
  })),
  // A track with no file at all: nothing to analyse, so it must never appear.
});
collate(db, 'discogs', {
  releases: [{ externalId: 'd1', title: 'Discovery', artist: 'Daft Punk', year: 2001 }],
  tracks: [
    { externalId: 'd-t1', title: 'Aerodynamic', artist: 'Daft Punk', album: 'Discovery', position: '1', releaseExternalId: 'd1' },
  ],
});

const ids = Object.fromEntries(
  (db.prepare(`SELECT id, title FROM track`).all() as { id: string; title: string }[]).map((r) => [
    r.title,
    r.id,
  ]),
);

// --- What counts as outstanding ------------------------------------

/*
 * These fixture paths do not exist on disk, which is now itself disqualifying:
 * a track whose file has gone missing is dropped from the queue rather than
 * marked, because a marker would be wrong when an unplugged drive comes back —
 * but leaving them in made every sync claim a pass and log "0 analysed" for the
 * same dead paths forever.
 */
assert(pendingAnalysis(db).length === 0, 'tracks whose files are missing are not candidates');
assert(
  pendingAnalysis(db, { force: true }).length === 0,
  'force does not resurrect missing files either',
);

mkdirSync('/tmp/booth-verify-analysis', { recursive: true });
for (const k of ['a', 'b', 'c']) writeFileSync(`/tmp/booth-verify-analysis/${k}.mp3`, 'not audio');

assert(pendingAnalysis(db).length === 3, 'only file-backed tracks are candidates (3 of 4)');
assert(
  !pendingAnalysis(db).some((c) => c.id === ids['Aerodynamic']),
  'a track with no file is never a candidate',
);

const writeFacet = (id: string, key: string, value: string) =>
  db
    .prepare(
      `INSERT INTO source_facets (entity_kind, entity_id, source, key, value)
       VALUES ('track', ?, 'local', ?, ?)`,
    )
    .run(id, key, value);

// A stored estimate takes a track out of the list.
writeFacet(ids['Track a'], BPM_KEY_ANALYZED, '128');
writeFacet(ids['Track a'], BPM_CONFIDENCE_KEY, '0.8');
assert(pendingAnalysis(db).length === 2, 'an analysed track drops out');

/*
 * The regression this file exists for. A track whose estimate came back below
 * the confidence floor stores a confidence and no BPM. If "outstanding" meant
 * "has no BPM", every such track would be decoded again on every single sync,
 * forever, to reach the same conclusion — ~700 tracks and 85 seconds of ffmpeg
 * per sync in this library.
 */
writeFacet(ids['Track b'], BPM_CONFIDENCE_KEY, '0.11');
assert(
  pendingAnalysis(db).length === 1,
  'a low-confidence attempt is remembered and not retried',
);
assert(
  !pendingAnalysis(db).some((c) => c.id === ids['Track b']),
  'the low-confidence track specifically is excluded',
);

// --- force and scoping ---------------------------------------------

assert(pendingAnalysis(db, { force: true }).length === 3, 'force revisits everything');
assert(
  pendingAnalysis(db, { force: true, trackIds: [ids['Track a']] }).length === 1,
  'trackIds scopes the candidate set',
);
assert(
  pendingAnalysis(db, { trackIds: [ids['Track a']] }).length === 0,
  'scoping still respects the already-attempted filter',
);
assert(pendingAnalysis(db, { limit: 1 }).length <= 1, 'limit caps the candidate set');

// --- A file that vanishes mid-pass is counted, not fatal -------------
// pendingAnalysis filters missing files, so this is the race where one goes
// away between the query and its turn in the queue.
{
  const candidates = pendingAnalysis(db, { force: true });
  rmSync('/tmp/booth-verify-analysis', { recursive: true, force: true });
  const counts = await analyzeTracks(db, candidates);
  assert(counts.missingFile === 3, `a file lost mid-pass is counted (got ${counts.missingFile})`);
  assert(counts.analysed === 0 && counts.failed === 0, 'a missing file is not a failure');
}

// --- The in-flight guard --------------------------------------------
// Needs real candidates again after the block above deleted them.
mkdirSync('/tmp/booth-verify-analysis', { recursive: true });
for (const k of ['a', 'b', 'c']) writeFileSync(`/tmp/booth-verify-analysis/${k}.mp3`, 'not audio');

assert(!isAnalysisRunning(), 'no pass running at rest');
assert(
  startBackgroundAnalysis(db, []) === false,
  'an empty candidate list does not start a pass',
);
{
  const started = startBackgroundAnalysis(db, pendingAnalysis(db, { force: true }));
  assert(started, 'a pass with candidates starts');
  // Two overlapping passes would double the ffmpeg processes and race each
  // other to the same rows; a sync on a timer makes that easy to trigger.
  assert(
    startBackgroundAnalysis(db, pendingAnalysis(db, { force: true })) === false,
    'a second pass is refused while one is in flight',
  );
  await new Promise((r) => setTimeout(r, 400));
  assert(!isAnalysisRunning(), 'the guard clears once the pass finishes');
}

rmSync('/tmp/booth-verify-analysis', { recursive: true, force: true });

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
