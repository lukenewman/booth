/**
 * Rewind stars and vetted flags from the append-only journal.
 *
 * This is the tool that makes the journal worth writing. On 2026-08-26 a
 * cleanup script cleared 29 real stars; recovery relied on SQLite's WAL
 * happening to still hold the pre-delete pages, which is luck, not a plan.
 * With the journal, the same accident is:
 *
 *   bun verify scripts/restore-annotations.ts --as-of 2026-08-26T21:00:00Z
 *
 * Default is a dry run — it prints what it would change and exits. Pass
 * --apply to write.
 *
 *   bun verify scripts/restore-annotations.ts                       # state now
 *   bun verify scripts/restore-annotations.ts --as-of <iso>         # rewind
 *   bun verify scripts/restore-annotations.ts --as-of <iso> --apply
 *   bun verify scripts/restore-annotations.ts --as-of <iso> --prune --apply
 */
import { Database } from 'bun:sqlite';
import { homedir } from 'os';
import { join } from 'path';
import { readEvents, replayEvents, nameKey } from '../src/lib/server/backup/journal';

const dbPath = process.env.BOOTH_DB_PATH ?? join(homedir(), '.booth', 'booth.db');
const backupRoot = process.env.BOOTH_BACKUP_PATH ?? join(homedir(), '.booth', 'backups');
const logPath = join(backupRoot, 'annotations.log');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
/**
 * Removals are opt-in. A journal only knows about entities it has seen: if it
 * was started after some stars already existed, or only ever recorded tracks,
 * then "absent from the journal" means "no information", not "should not
 * exist". Treating absence as authoritative would let a star restore silently
 * wipe every vetted release — which is exactly what the first version of this
 * script planned to do. Restoring is additive unless you say otherwise, and
 * even then only for entities the journal has events for.
 */
const prune = args.includes('--prune');
const asOfIdx = args.indexOf('--as-of');
const asOf = asOfIdx >= 0 ? args[asOfIdx + 1] : undefined;

if (asOfIdx >= 0 && !asOf) {
  console.error('--as-of needs an ISO8601 timestamp');
  process.exit(1);
}

const events = readEvents(logPath);
if (events.length === 0) {
  console.error(`no journal at ${logPath} (nothing recorded yet)`);
  process.exit(1);
}

const target = replayEvents(events, asOf);

/** When each surviving tap was recorded — the journal's own clock. */
const bpmMeasuredAt = new Map<string, string>();
for (const e of events) {
  if (asOf && e.at > asOf) continue;
  if (e.action === 'bpm') bpmMeasuredAt.set(e.id, e.at);
}
console.log(
  `journal: ${events.length} events, ${events[0].at} → ${events[events.length - 1].at}`,
);
console.log(
  `target state${asOf ? ` as of ${asOf}` : ' (now)'}: ` +
    `${target.stars.size} stars, ${target.vetted.size} vetted, ${target.notes.size} notes, ` +
    `${target.bpms.size} tapped BPMs`,
);

const db = new Database(dbPath);

const liveStars = new Set(
  (db.prepare(`SELECT id FROM track WHERE starred_at IS NOT NULL`).all() as { id: string }[]).map(
    (r) => r.id,
  ),
);
const liveVetted = new Set(
  (db.prepare(`SELECT id FROM release WHERE vetted_at IS NOT NULL`).all() as { id: string }[]).map(
    (r) => r.id,
  ),
);

// Match by ULID first; fall back to artist+title for rows whose id has changed
// since the event was written (a moved file re-keys and gets a new track row).
const byNameLookup = db.prepare(
  `SELECT t.id FROM track t JOIN artist a ON a.id = t.artist_id
    WHERE a.name || ' ' || t.title = ?`,
);

// Carry the timestamp with the id: a name-matched row lands on a different
// ULID than the event recorded, and it must still get *its own* original
// starred_at rather than whichever one happened to be first in the map.
const toStar: { id: string; ts: string }[] = [];
const toUnstar: string[] = [];
let unmatched = 0;

for (const [id, ts] of target.stars) {
  if (liveStars.has(id)) continue;
  if (db.prepare(`SELECT 1 FROM track WHERE id = ?`).get(id)) {
    toStar.push({ id, ts });
    continue;
  }
  const ev = events.find((e) => e.id === id);
  const hit = ev
    ? (byNameLookup.get(nameKey(ev.artist, ev.title)) as { id: string } | undefined)
    : undefined;
  if (hit) toStar.push({ id: hit.id, ts });
  else unmatched++;
}
const seenTracks = new Set(events.filter((e) => e.kind === 'track').map((e) => e.id));
const seenReleases = new Set(events.filter((e) => e.kind === 'release').map((e) => e.id));

if (prune) {
  for (const id of liveStars) {
    if (!target.stars.has(id) && seenTracks.has(id)) toUnstar.push(id);
  }
}

const liveNotes = new Map(
  (
    db.prepare(`SELECT id, note FROM track WHERE note IS NOT NULL`).all() as {
      id: string;
      note: string;
    }[]
  ).map((r) => [r.id, r.note]),
);
const toNote = [...target.notes.entries()].filter(([id, text]) => liveNotes.get(id) !== text);
const toClearNote = prune
  ? [...liveNotes.keys()].filter((id) => !target.notes.has(id) && seenTracks.has(id))
  : [];

const liveBpms = new Map(
  (
    db.prepare(`SELECT id, tapped_bpm FROM track WHERE tapped_bpm IS NOT NULL`).all() as {
      id: string;
      tapped_bpm: number;
    }[]
  ).map((r) => [r.id, r.tapped_bpm]),
);
const toBpm = [...target.bpms.entries()].filter(([id, v]) => liveBpms.get(id) !== v);
const toClearBpm = prune
  ? [...liveBpms.keys()].filter((id) => !target.bpms.has(id) && seenTracks.has(id))
  : [];

const toVet = [...target.vetted.keys()].filter((id) => !liveVetted.has(id));
const toUnvet = prune
  ? [...liveVetted].filter((id) => !target.vetted.has(id) && seenReleases.has(id))
  : [];

console.log(
  `live: ${liveStars.size} stars, ${liveVetted.size} vetted\n` +
    `plan: +${toStar.length} stars, -${toUnstar.length} stars, ` +
    `+${toVet.length} vetted, -${toUnvet.length} vetted, ` +
    `~${toNote.length} notes, -${toClearNote.length} notes, ` +
    `~${toBpm.length} tapped BPMs, -${toClearBpm.length} tapped BPMs` +
    (unmatched ? `, ${unmatched} unmatched (row gone, no name match)` : '') +
    (prune ? '' : '\n(additive only — pass --prune to also remove annotations the journal dropped)'),
);

if (!apply) {
  console.log('\ndry run — pass --apply to write');
  process.exit(0);
}

const setStar = db.prepare(`UPDATE track SET starred_at = ? WHERE id = ?`);
const setVet = db.prepare(`UPDATE release SET vetted_at = ? WHERE id = ?`);
const setNote = db.prepare(`UPDATE track SET note = ? WHERE id = ?`);
// Restoring a measurement without when it was measured would be a lie, and the
// journal timestamp is the moment it was recorded, so it doubles as measured-at.
const setBpm = db.prepare(`UPDATE track SET tapped_bpm = ?, tapped_bpm_at = ? WHERE id = ?`);

db.transaction(() => {
  for (const { id, ts } of toStar) setStar.run(ts, id);
  for (const id of toUnstar) setStar.run(null, id);
  for (const id of toVet) setVet.run(target.vetted.get(id)!, id);
  for (const id of toUnvet) setVet.run(null, id);
  for (const [id, text] of toNote) setNote.run(text, id);
  for (const id of toClearNote) setNote.run(null, id);
  for (const [id, value] of toBpm) setBpm.run(value, bpmMeasuredAt.get(id) ?? null, id);
  for (const id of toClearBpm) setBpm.run(null, null, id);
})();

const afterStars = (
  db.prepare(`SELECT COUNT(*) AS n FROM track WHERE starred_at IS NOT NULL`).get() as { n: number }
).n;
const afterVetted = (
  db.prepare(`SELECT COUNT(*) AS n FROM release WHERE vetted_at IS NOT NULL`).get() as {
    n: number;
  }
).n;
const afterBpms = (
  db.prepare(`SELECT COUNT(*) AS n FROM track WHERE tapped_bpm IS NOT NULL`).get() as { n: number }
).n;
console.log(`applied — now ${afterStars} stars, ${afterVetted} vetted, ${afterBpms} tapped BPMs`);
