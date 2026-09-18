/**
 * End-to-end drop folder: a file lands in the inbox, settles, is moved into the
 * library tree, and comes back out of the scan as a track the DB can collate.
 *
 * Runs against temp directories only — it never touches the real inbox, the
 * real library tree, or the real database.
 */
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../src/lib/server/db/migrate';
import { collate } from '../src/lib/server/library/collate';
import { listAudioFiles, runInboxIngest, scanIngestedLibrary } from '../src/lib/server/sources/local/ingest';
import { releaseIdForTags } from '../src/lib/server/sources/local/sync';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) fail(msg);
}

const root = mkdtempSync(join(tmpdir(), 'booth-ingest-'));
const inbox = join(root, 'inbox');
const library = join(root, 'library');

/** A valid, tagless WAV of `ms` silence — enough for the parser, no tags. */
function writeWav(path: string, ms = 200): void {
  const rate = 44100;
  const samples = Math.round((rate * ms) / 1000);
  const dataBytes = samples * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, buf);
}

// --- Nothing in the inbox is not an error --------------------------
const empty = await runInboxIngest(inbox, library);
assert(empty.ingested === 0 && empty.waiting === 0, 'an empty inbox does nothing');
assert(existsSync(inbox), 'the inbox is created so there is somewhere to drop files');

// --- A new file waits one pass before being taken ------------------
const dropped = join(inbox, 'Some Download.wav');
writeWav(dropped);
const firstPass = await runInboxIngest(inbox, library);
assert(firstPass.ingested === 0, 'a file is not taken the moment it appears');
assert(firstPass.waiting === 1, `it is reported as waiting, got ${firstPass.waiting}`);
assert(existsSync(dropped), 'and it is still sitting in the inbox');

const secondPass = await runInboxIngest(inbox, library);
assert(secondPass.ingested === 1, `settled file is ingested, got ${secondPass.ingested}`);
assert(secondPass.failed.length === 0, `no failures: ${JSON.stringify(secondPass.failed)}`);
assert(!existsSync(dropped), 'the inbox is emptied, not copied from');

// Tagless file falls back to the filename, under Unknown Artist/Unknown Album.
const landed = listAudioFiles(library);
assert(landed.length === 1, `one file in the library, got ${landed.length}`);
assert(
  landed[0] === join(library, 'Unknown Artist', 'Unknown Album', 'Some Download.wav'),
  `fallback naming, got ${landed[0]}`,
);

// --- A file still growing is left alone ----------------------------
const growing = join(inbox, 'Growing.wav');
writeWav(growing, 200);
await runInboxIngest(inbox, library); // first sighting
writeWav(growing, 400); // still being written
const midCopy = await runInboxIngest(inbox, library);
assert(midCopy.ingested === 0, 'a file that changed size is not ingested');
assert(existsSync(growing), 'it stays in the inbox');
const settled = await runInboxIngest(inbox, library);
assert(settled.ingested === 1, 'once it stops growing it goes in');

// --- Two files that would land on the same name both survive -------
writeWav(join(inbox, 'Some Download.wav'));
await runInboxIngest(inbox, library);
await runInboxIngest(inbox, library);
const afterCollision = listAudioFiles(library).filter((p) => p.includes('Some Download'));
assert(afterCollision.length === 2, `both copies kept, got ${afterCollision.length}`);
assert(
  afterCollision.some((p) => p.endsWith('Some Download (2).wav')),
  `the second is renamed, got ${JSON.stringify(afterCollision)}`,
);

// --- Non-audio is ignored entirely ---------------------------------
writeFileSync(join(inbox, 'cover.jpg'), 'not audio');
writeFileSync(join(inbox, 'notes.txt'), 'not audio');
writeFileSync(join(inbox, 'half.wav.part'), 'still downloading');
const withJunk = await runInboxIngest(inbox, library);
await runInboxIngest(inbox, library);
assert(withJunk.ingested === 0 && withJunk.waiting === 0, 'sidecar files are not seen at all');
assert(existsSync(join(inbox, 'cover.jpg')), 'and are left where they are');

// --- The tree reads back as collatable tracks ----------------------
const scanned = await scanIngestedLibrary(library, releaseIdForTags);
assert(scanned.tracks.length === 3, `three ingested tracks, got ${scanned.tracks.length}`);
assert(
  scanned.tracks.every((t) => t.filePath && t.externalId === t.filePath),
  'the absolute path identifies an ingested track, as it does for vinyl rips',
);
assert(
  scanned.tracks.every((t) => (t.facets as any)?.origin === 'download'),
  'every ingested track is marked as a download, distinct from a vinyl rip',
);

const db = new Database(':memory:');
runMigrations(db);
const first = collate(db, 'local', { tracks: scanned.tracks, releases: scanned.releases });
assert(first.tracksUpserted === 3, `collate takes them, got ${first.tracksUpserted}`);
const playable = db
  .prepare(`SELECT COUNT(*) AS n FROM match_key WHERE entity_kind='track' AND key_type='file_path'`)
  .get() as { n: number };
assert(playable.n === 3, `each gets a file_path key so it can play, got ${playable.n}`);

// --- Re-running changes nothing ------------------------------------
const again = collate(db, 'local', { tracks: scanned.tracks, releases: scanned.releases });
assert(again.tracksDeleted === 0, 'a second pass deletes nothing');
const total = db.prepare('SELECT COUNT(*) AS n FROM track').get() as { n: number };
assert(total.n === 3, `no duplicates on re-sync, got ${total.n}`);

// --- Deleting the file removes the track ---------------------------
// The whole reason ingested files ride in the sync result: the prune is the
// mechanism, so removal needs no special case.
rmSync(scanned.tracks[0].filePath!);
const afterDelete = await scanIngestedLibrary(library, releaseIdForTags);
const pruned = collate(db, 'local', {
  tracks: afterDelete.tracks,
  releases: afterDelete.releases,
});
assert(pruned.tracksDeleted === 1, `deleted file prunes its track, got ${pruned.tracksDeleted}`);

rmSync(root, { recursive: true, force: true });
console.log('OK: ingest run');
