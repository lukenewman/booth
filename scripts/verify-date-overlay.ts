/**
 * verify-date-overlay.ts — the recovered acquisition dates must survive syncs.
 *
 * Regression cover for the reason this feature is not a one-off backfill: the
 * Apple Music import re-parses the live export on every server boot and
 * upserts dateAdded from it, so a date written straight into the DB is gone at
 * the next restart. The graft only holds if the import itself applies it, and
 * the check that matters is the SECOND sync.
 *
 * Runs the real sync + collate against a throwaway DB and fixture library — it
 * never touches ~/.booth/booth.db or the real export.
 *
 * Run: bun verify scripts/verify-date-overlay.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'booth-overlay-'));
process.env.BOOTH_DB_PATH = join(tmp, 'test.db');
process.env.ITUNES_XML_PATH = join(process.cwd(), 'scripts', 'fixtures', 'itunes-migrated.xml');

const { getDb } = await import('../src/lib/server/db');
const { collate } = await import('../src/lib/server/library/collate');
const { syncITunesLibrary } = await import('../src/lib/server/sources/local/sync');
const { mediaPathKey } = await import('../src/lib/server/sources/local/date_overlay');

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(
    `${ok ? '✓' : '✗'} ${label}` +
      (ok ? '' : `\n    expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`),
  );
}

// --- the key that joins the two libraries ----------------------------------

const OLD = 'file:///Users/lucas/Music/Music/Media.localized/Daft%20Punk/Homework/07%20Around%20the%20World.m4a';
const NEW = 'file:///Users/luke/Music/Music/Media.localized/Music/Daft%20Punk/Homework/07%20Around%20the%20World.m4a';
check('different home dir and media layout key the same', mediaPathKey(OLD), mediaPathKey(NEW));
check(
  'NFD and NFC spellings of an accent key the same',
  mediaPathKey('file:///x/Media.localized/Kai%20Alce%CC%81/a/1.m4a'),
  mediaPathKey('file:///x/Media.localized/Music/Kai%20Alc%C3%A9/a/1.m4a'),
);

// --- the graft -------------------------------------------------------------

const db = getDb();
const RECOVERED_WORLD = '2020-10-05T18:22:00.000Z';
const RECOVERED_WAVES = '2019-09-19T19:55:28.000Z';
const insert = db.prepare(
  'INSERT INTO date_added_overlay (media_path, date_added, match_method) VALUES (?, ?, ?)',
);
insert.run('Daft Punk/Homework/07 Around the World.m4a', RECOVERED_WORLD, 'path');
insert.run('Kai Alcé/Deep Cut/01 Hear The Waves.m4a', RECOVERED_WAVES, 'meta');

function facets(title: string): Record<string, unknown> {
  const rows = db
    .prepare(
      `SELECT sf.key, sf.value FROM source_facets sf
         JOIN track t ON t.id = sf.entity_id
        WHERE sf.entity_kind = 'track' AND sf.source = 'local' AND t.title = ?`,
    )
    .all(title) as { key: string; value: string }[];
  return Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]));
}

async function sync() {
  collate(db, 'local', await syncITunesLibrary(), { recordingsRoot: join(tmp, 'recordings') });
}

await sync();
check('recovered date replaces the migration date', facets('Around the World').dateAdded, RECOVERED_WORLD);
check('what Music.app reported is kept', facets('Around the World').dateAddedReported, '2025-08-25T13:37:11.000Z');
check('grafted date is marked as such', facets('Around the World').dateAddedOrigin, 'recovered');
check('overlay applies across an accent mismatch', facets('Hear The Waves').dateAdded, RECOVERED_WAVES);
check('track with no overlay entry keeps its own date', facets('Bought Last Week').dateAdded, '2026-08-11T09:00:00.000Z');
check('...and is marked as reported', facets('Bought Last Week').dateAddedOrigin, 'reported');

// The whole point: a second sync re-parses the same export, which is what
// silently reverted a directly-written facet before the overlay existed.
await sync();
check('second sync does not revert the graft', facets('Around the World').dateAdded, RECOVERED_WORLD);
check('second sync leaves the marker intact', facets('Around the World').dateAddedOrigin, 'recovered');

// A release takes the earliest date over its tracks, so the graft has to move
// the release too or the library view still sorts by migration day.
const releaseAdded = db
  .prepare(
    `SELECT MIN(sf.value) AS v FROM source_facets sf
       JOIN track t ON t.id = sf.entity_id
       JOIN release r ON r.id = t.release_id
      WHERE sf.source = 'local' AND sf.key = 'dateAdded' AND r.title = 'Homework'`,
  )
  .get() as { v: string };
check('release inherits the recovered date', JSON.parse(releaseAdded.v), RECOVERED_WORLD);

rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
