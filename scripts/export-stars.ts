/**
 * Dump and restore stars + vetted flags, keyed on artist/title/album rather
 * than entity ULIDs.
 *
 * Why this exists: collate's prune deletes entities that no longer resolve to
 * any source. Move or rename a local file and it re-keys on its path, so a NEW
 * track row appears and the old one is pruned — taking its star with it,
 * silently. Keying stars on match keys instead of ids would be a large change
 * to serve a rare event; this is the proportionate answer.
 *
 * Every other entity in the database is reconstructible from a source. This
 * data is not: it is tens of hours of listening, entered by hand.
 *
 *   bun verify scripts/export-stars.ts export ~/booth-stars.json
 *   bun verify scripts/export-stars.ts import ~/booth-stars.json
 */
import { Database } from 'bun:sqlite';
import { homedir } from 'os';
import { join } from 'path';

const dbPath = process.env.BOOTH_DB_PATH ?? join(homedir(), '.booth', 'booth.db');
const [, , mode, file] = process.argv;

if (mode !== 'export' && mode !== 'import') {
  console.error('usage: export-stars.ts <export|import> <file.json>');
  process.exit(1);
}
if (!file) {
  console.error('missing file path');
  process.exit(1);
}

const db = new Database(dbPath);

interface Payload {
  exportedAt: string;
  stars: { artist: string; title: string; album: string | null; starredAt: string }[];
  vetted: { artist: string; title: string; year: number | null; vettedAt: string }[];
}

if (mode === 'export') {
  const stars = db
    .prepare(
      `SELECT a.name AS artist, t.title, t.album, t.starred_at AS starredAt
         FROM track t JOIN artist a ON a.id = t.artist_id
        WHERE t.starred_at IS NOT NULL
        ORDER BY a.name, t.album, t.title`,
    )
    .all() as Payload['stars'];

  const vetted = db
    .prepare(
      `SELECT a.name AS artist, r.title, r.year, r.vetted_at AS vettedAt
         FROM release r JOIN artist a ON a.id = r.artist_id
        WHERE r.vetted_at IS NOT NULL
        ORDER BY a.name, r.title`,
    )
    .all() as Payload['vetted'];

  const payload: Payload = { exportedAt: new Date().toISOString(), stars, vetted };
  await Bun.write(file, JSON.stringify(payload, null, 2));
  console.log(`exported ${stars.length} stars, ${vetted.length} vetted releases → ${file}`);
} else {
  const payload = (await Bun.file(file).json()) as Payload;

  // `t.album IS ?` handles the NULL case, which `= ?` never matches.
  const findTrack = db.prepare(
    `SELECT t.id FROM track t JOIN artist a ON a.id = t.artist_id
      WHERE a.name = ? AND t.title = ? AND (t.album IS ? OR t.album = ?)`,
  );
  const findRelease = db.prepare(
    `SELECT r.id FROM release r JOIN artist a ON a.id = r.artist_id
      WHERE a.name = ? AND r.title = ?`,
  );
  const setStar = db.prepare(`UPDATE track SET starred_at = ? WHERE id = ?`);
  const setVet = db.prepare(`UPDATE release SET vetted_at = ? WHERE id = ?`);

  let starred = 0;
  let missedStars = 0;
  let vetted = 0;
  let missedVetted = 0;

  db.transaction(() => {
    for (const s of payload.stars) {
      const row = findTrack.get(s.artist, s.title, s.album, s.album) as { id: string } | undefined;
      if (row) {
        setStar.run(s.starredAt, row.id);
        starred++;
      } else {
        missedStars++;
        console.warn(`no match: ${s.artist} — ${s.title}`);
      }
    }
    for (const v of payload.vetted) {
      const row = findRelease.get(v.artist, v.title) as { id: string } | undefined;
      if (row) {
        setVet.run(v.vettedAt, row.id);
        vetted++;
      } else {
        missedVetted++;
        console.warn(`no match: ${v.artist} — ${v.title}`);
      }
    }
  })();

  console.log(
    `restored ${starred} stars (${missedStars} unmatched), ${vetted} vetted (${missedVetted} unmatched)`,
  );
}
