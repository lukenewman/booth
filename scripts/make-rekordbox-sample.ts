/**
 * make-rekordbox-sample.ts — a tagged file to import into rekordbox by hand.
 *
 * Whether rekordbox shows Booth's tempo, comment and rating cannot be asserted
 * from code — its library is SQLCipher-encrypted and it is a GUI. So this writes
 * a sample with known values and the operator looks.
 *
 * Copies a real library file; the original is never modified.
 *
 * Run: bun verify scripts/make-rekordbox-sample.ts [--out <dir>]
 */
import { Database } from 'bun:sqlite';
import { copyFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTags } from '../src/lib/server/library/tags';
import { writeTags } from '../src/lib/server/library/tag_writer';

function argStr(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const outDir = argStr('out', process.env.SCRATCH ?? tmpdir());

const dbPath = process.env.BOOTH_DB_PATH ?? join(homedir(), '.booth', 'booth.db');
const db = new Database(dbPath, { readonly: true });

for (const ext of ['.mp3', '.m4a']) {
  const row = db
    .prepare(
      `SELECT key_value AS path FROM match_key
        WHERE entity_kind='track' AND key_type='file_path' AND key_value LIKE ?
        LIMIT 1`,
    )
    .get(`%Media.localized%${ext}`) as { path: string } | undefined;
  if (!row) {
    console.log(`no ${ext} file found in the library — skipping`);
    continue;
  }
  const copy = join(outDir, `rekordbox-sample${ext}`);
  copyFileSync(row.path, copy);
  await writeTags(copy, {
    dateAdded: '2020-10-05T18:22:00Z',
    dateAddedOrigin: 'recovered',
    starred: true,
    note: 'BOOTH TEST COMMENT',
    bpm: 123,
  });
  const tags = await readTags(copy);
  console.log(`\n${ext}  →  ${copy}`);
  console.log(`  shows in rekordbox as:  ${tags.artist ?? '?'} — ${tags.title ?? '?'}`);
  console.log(`  copied from:            ${row.path}`);
}

console.log(`
Import the two files above into rekordbox (drag them in, or File → Import →
Import Track) and check, for each:

  1. Comment column shows "BOOTH TEST COMMENT"
  2. BPM shows 123 BEFORE you let rekordbox analyse the track (its own analysis
     overwrites the tag, so check this first)
  3. Rating shows five stars  — expected on the MP3 only
  4. Nothing else looks wrong: title, artist and artwork intact

Point 3 failing on the M4A is the known gap, not a bug. Point 2 failing on BOTH
would mean the tempo field is not a usable channel and the schema needs revisiting.

These are copies in a scratch directory, not your library — remove them from
rekordbox when you are done.
`);
