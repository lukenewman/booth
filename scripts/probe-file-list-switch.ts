/**
 * probe-file-list-switch.ts: does switching to the file list change anything
 * on the real library?
 *
 * Copies the real database with SQLite's backup (a plain copy of a WAL
 * database is corrupt), runs the new local sync against the copy twice, and
 * compares what a user can see before and after. Never writes to the real
 * database or to any audio file. The drop-folder inbox is pointed at an empty
 * scratch folder, because the sync's ingest step would otherwise move real
 * files out of the inbox.
 *
 * Run: bun verify scripts/probe-file-list-switch.ts
 * (ITUNES_XML_PATH comes from .env.) Exit code 1 on any unexpected difference.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'booth-switch-'));
const copy = join(scratch, 'booth.db');
const real = process.env.BOOTH_REAL_DB ?? join(homedir(), '.booth', 'booth.db');
const proc = Bun.spawnSync(['sqlite3', real, `.backup '${copy}'`]);
if (proc.exitCode !== 0) throw new Error(`backup failed: ${proc.stderr.toString()}`);
process.env.BOOTH_DB_PATH = copy;
process.env.BOOTH_INBOX_PATH = join(scratch, 'inbox');
mkdirSync(process.env.BOOTH_INBOX_PATH);

const { getDb } = await import('../src/lib/server/db');
const { collate } = await import('../src/lib/server/library/collate');
const { syncITunesLibrary } = await import('../src/lib/server/sources/local/sync');

const db = getDb();
const recordingsRoot = join(homedir(), '.booth', 'recordings');

/**
 * What this change must not touch: which tracks exist, what is attached to
 * them, and where they play from. Names, release grouping and release fields
 * are reported but not gated: an ordinary sync legitimately changes them when
 * the export or Discogs moved since the last one, and the old code does the
 * same. To judge those, run this probe at the commit before the switch on a
 * fresh copy and compare (2026-11-02: identical).
 */
function snapshot() {
  const q = <T>(sql: string) => db.prepare(sql).all() as T[];
  return {
    trackIds: q(`SELECT id FROM track ORDER BY id`),
    annotations: q(`SELECT id, starred_at, note FROM track WHERE starred_at IS NOT NULL OR note IS NOT NULL ORDER BY id`),
    tracks: q(`SELECT id, title, album, release_id, position FROM track ORDER BY id`),
    releases: q(`SELECT id, title, artist_id, year FROM release ORDER BY id`),
    playlistTracks: q(`SELECT id, track_id FROM playlist_track ORDER BY id`),
    playlistReleases: q(`SELECT id, release_id FROM playlist_release ORDER BY id`),
    filePaths: q(`SELECT entity_id, key_value FROM match_key WHERE entity_kind='track' AND key_type='file_path' ORDER BY entity_id`),
  };
}

function diff(label: string, a: unknown[], b: unknown[]): number {
  const as = new Set(a.map((x) => JSON.stringify(x)));
  const bs = new Set(b.map((x) => JSON.stringify(x)));
  const gone = [...as].filter((x) => !bs.has(x));
  const added = [...bs].filter((x) => !as.has(x));
  if (gone.length || added.length) {
    console.log(`✗ ${label}: ${gone.length} gone, ${added.length} new`);
    for (const g of gone.slice(0, 5)) console.log(`   - ${g}`);
    for (const n of added.slice(0, 5)) console.log(`   + ${n}`);
  } else console.log(`✓ ${label}: unchanged (${a.length})`);
  return gone.length + added.length;
}

const brief = (s: object) => JSON.stringify({ ...s, conflictDetails: undefined, removed: undefined });

const before = snapshot();
const t0 = Date.now();
const r1 = await syncITunesLibrary();
const first = collate(db, 'local', r1, { recordingsRoot });
console.log(`first sync ${((Date.now() - t0) / 1000).toFixed(0)}s:`, brief(first));
console.log('  files:', JSON.stringify({ ...r1.files, unreadable: r1.files?.unreadable.length }));
const t1 = Date.now();
const r2 = await syncITunesLibrary();
const second = collate(db, 'local', r2, { recordingsRoot });
console.log(`second sync ${((Date.now() - t1) / 1000).toFixed(0)}s:`, brief(second));
console.log('  files:', JSON.stringify({ ...r2.files, unreadable: r2.files?.unreadable.length }));
const after = snapshot();

let bad = 0;
bad += diff('track ids', before.trackIds, after.trackIds);
bad += diff('stars and notes', before.annotations, after.annotations);
console.log('reported, not gated (an ordinary sync changes these too):');
diff('  track names and releases', before.tracks, after.tracks);
diff('  releases', before.releases, after.releases);
bad += diff('playlist tracks', before.playlistTracks, after.playlistTracks);
bad += diff('gig crates', before.playlistReleases, after.playlistReleases);
bad += diff('file paths', before.filePaths, after.filePaths);

const files = db.prepare(`SELECT COUNT(*) AS n, SUM(present) AS present, SUM(fingerprint IS NOT NULL) AS fp FROM audio_file`).get();
console.log('file list:', JSON.stringify(files));
for (const u of r1.files?.unreadable.slice(0, 5) ?? []) console.log(`  unreadable: ${u.path}: ${u.error}`);
if (first.tracksDeleted || first.conflicts) { console.log('✗ first sync deleted or conflicted'); bad++; }
if (second.relinked || second.tracksDeleted || second.conflicts) { console.log('✗ second sync was not quiet'); bad++; }
console.log(`\ncopy kept at ${copy}`);
process.exit(bad ? 1 : 0);
