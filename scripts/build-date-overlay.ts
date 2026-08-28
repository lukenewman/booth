/**
 * build-date-overlay.ts — graft acquisition dates from the old MacBook's
 * Music library onto the current one.
 *
 * The current library was created fresh on the machine move rather than
 * migrated, so Music.app reports the migration day as Date Added for ~91% of
 * tracks. The real 2009-2025 history exists only in a manual export from the
 * old machine. This does the fuzzy matching between the two libraries once and
 * freezes the result into date_added_overlay, keyed on the current library's
 * paths; the sync then does one exact lookup per track and never reads the old
 * export again.
 *
 * Idempotent — rebuilds the table from scratch each run.
 *
 * Run: bun verify scripts/build-date-overlay.ts [--old <path>] [--dry]
 */
import { Database } from 'bun:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../src/lib/server/db/migrate';
import { mediaPathKey } from '../src/lib/server/sources/local/date_overlay';
import { parseITunesLibrary, type ITunesTrack } from '../src/lib/server/sources/local/parse';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const dryRun = process.argv.includes('--dry');

const oldXml = arg('old', join(homedir(), '.booth', 'Old_MacBook_Library.xml'));
const currentXml = arg('current', process.env.ITUNES_XML_PATH ?? join(homedir(), 'Music', 'Library.xml'));
const dbPath = arg('db', process.env.BOOTH_DB_PATH ?? join(homedir(), '.booth', 'booth.db'));

/** Artist/album/title, punctuation and diacritics squashed — the fallback key. */
function metaKey(t: ITunesTrack): string {
  const norm = (s?: string) =>
    (s ?? '').normalize('NFD').replace(/\p{Diacritic}+/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  return `${norm(t.artist)}|${norm(t.album)}|${norm(t.name)}`;
}

const oldLib = parseITunesLibrary(oldXml);
const currentLib = parseITunesLibrary(currentXml);
console.log(`old     ${oldXml}\n        ${oldLib.tracks.length} tracks, exported ${oldLib.generatedAt?.slice(0, 10)}`);
console.log(`current ${currentXml}\n        ${currentLib.tracks.length} tracks, exported ${currentLib.generatedAt?.slice(0, 10)}`);

// First-wins on both indexes: duplicate paths cannot occur, and for duplicate
// metadata the earliest-added copy is the one whose date we want anyway.
const byPath = new Map<string, ITunesTrack>();
const byMeta = new Map<string, ITunesTrack>();
for (const t of oldLib.tracks) {
  const p = mediaPathKey(t.location);
  if (!byPath.has(p)) byPath.set(p, t);
  const m = metaKey(t);
  const seen = byMeta.get(m);
  if (!seen || (t.dateAdded ?? '') < (seen.dateAdded ?? '')) byMeta.set(m, t);
}

interface Row { mediaPath: string; dateAdded: string; matchMethod: string }
// Keyed rather than appended: a handful of current-library entries point at
// the same file (duplicate adds), and the overlay is one row per path.
const rowByPath = new Map<string, Row>();
const unmatched: ITunesTrack[] = [];
let notEarlier = 0;
let collisions = 0;

for (const t of currentLib.tracks) {
  const key = mediaPathKey(t.location);
  let old = byPath.get(key);
  let method = 'path';
  if (!old) {
    old = byMeta.get(metaKey(t));
    method = 'meta';
  }
  if (!old?.dateAdded) {
    unmatched.push(t);
    continue;
  }
  // Only graft a date that is actually older. A track bought after the move
  // has no old counterpart worth preferring, and a stray metadata collision
  // must never push a genuinely recent addition backwards.
  if (t.dateAdded && old.dateAdded >= t.dateAdded) {
    notEarlier++;
    continue;
  }
  const existing = rowByPath.get(key);
  if (existing) {
    collisions++;
    if (existing.dateAdded <= old.dateAdded) continue;
  }
  rowByPath.set(key, { mediaPath: key, dateAdded: old.dateAdded, matchMethod: method });
}

const rows = [...rowByPath.values()];
const byMethod = rows.reduce<Record<string, number>>((a, r) => {
  a[r.matchMethod] = (a[r.matchMethod] ?? 0) + 1;
  return a;
}, {});
console.log(`\nmatched     ${rows.length}  (${byMethod.path ?? 0} by path, ${byMethod.meta ?? 0} by artist/album/title)`);
console.log(`no earlier  ${notEarlier}  (old date not older — left as Music.app reports)`);
if (collisions) console.log(`duplicates  ${collisions}  (same file added twice — earliest date wins)`);
console.log(`unmatched   ${unmatched.length}`);

// The only unmatched tracks that represent lost history are the ones the
// current library still dates to the migration day; anything later is music
// genuinely acquired since the move and is correctly dated already.
const migrationDay = [...currentLib.tracks].sort((a, b) => (a.dateAdded ?? '').localeCompare(b.dateAdded ?? ''))[0]?.dateAdded?.slice(0, 10);
const stranded = unmatched.filter((t) => t.dateAdded?.slice(0, 10) === migrationDay);
console.log(`\n${stranded.length} pre-existing tracks keep the migration date (${migrationDay}) — no match in the old library:`);
for (const t of stranded) console.log(`  ${t.artist} — ${t.album ?? '?'} — ${t.name}`);

if (dryRun) {
  console.log('\n--dry: nothing written');
  process.exit(0);
}

const db = new Database(dbPath);
runMigrations(db);
db.transaction(() => {
  db.exec('DELETE FROM date_added_overlay');
  const stmt = db.prepare(
    'INSERT INTO date_added_overlay (media_path, date_added, match_method) VALUES (?, ?, ?)',
  );
  for (const r of rows) stmt.run(r.mediaPath, r.dateAdded, r.matchMethod);
})();
console.log(`\nwrote ${rows.length} rows to date_added_overlay in ${dbPath}`);
console.log('run a sync to apply them (restart the dev server, or POST /api/sources/local/sync)');
