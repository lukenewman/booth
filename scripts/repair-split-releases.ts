/**
 * One-off repair for releases that exist twice — once from the local library,
 * once from Discogs — because the two were never matched.
 *
 * Two defects produced these, both fixed in the sync/add paths:
 *   1. the release match key carried the year, and the sources disagree about
 *      what "year" means (tagged original vs. the pressing in the collection);
 *   2. the Discogs add path minted an entity without consulting the match keys.
 *
 * Neither fix heals the duplicates already on disk: the duplicate owns the
 * Discogs source_link, so a re-sync resolves the right entity, hits the
 * source_link conflict path, and leaves everything as it was.
 *
 * This script merges each pair onto the local (file-backed) entity: it moves the
 * Discogs release link and facets across, backfills empty columns, and removes
 * the duplicate. Discogs-only track rows on the duplicate are removed with it —
 * they are pure API metadata and `hydrateDiscogsTracks` re-creates them, this
 * time matching onto the local tracks by position. Anything carrying user data
 * (a star, a note, a playlist entry, a local file link) blocks the merge instead.
 *
 * Dry run by default. Pass --apply to write, which backs the DB up first.
 */
import { Database } from 'bun:sqlite';
import { copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const APPLY = process.argv.includes('--apply');
const DB_PATH = process.env.BOOTH_DB_PATH ?? join(homedir(), '.booth', 'booth.db');

const squash = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

interface Rel {
  id: string;
  title: string;
  year: number | null;
  artist: string;
  sources: string | null;
}

const db = new Database(DB_PATH);

const rels = db
  .prepare(
    `SELECT r.id, r.title, r.year, COALESCE(a.name,'') AS artist,
            (SELECT group_concat(DISTINCT sl.source)
               FROM source_link sl
              WHERE sl.entity_kind='release' AND sl.entity_id=r.id) AS sources
       FROM release r LEFT JOIN artist a ON a.id=r.artist_id`,
  )
  .all() as Rel[];

const byArtistAlbum = new Map<string, Rel[]>();
for (const r of rels) {
  const key = `${squash(r.artist)}|${squash(r.title)}`;
  if (!squash(r.artist) || !squash(r.title)) continue;
  const bucket = byArtistAlbum.get(key);
  if (bucket) bucket.push(r);
  else byArtistAlbum.set(key, [r]);
}

interface Plan {
  keep: Rel;
  drop: Rel;
  dropTrackIds: string[];
}

const plans: Plan[] = [];
const skipped: string[] = [];

for (const [, group] of byArtistAlbum) {
  const discogsOnly = group.filter((r) => r.sources === 'discogs');
  const localOnly = group.filter((r) => r.sources === 'local');
  if (discogsOnly.length !== 1 || localOnly.length !== 1) {
    if (discogsOnly.length && localOnly.length) {
      skipped.push(
        `${group[0].artist} — ${group[0].title}: ambiguous (${discogsOnly.length} discogs / ${localOnly.length} local)`,
      );
    }
    continue;
  }
  const drop = discogsOnly[0];
  const keep = localOnly[0];

  const guarded = db
    .prepare(
      `SELECT t.id, t.title,
              t.starred_at IS NOT NULL AS starred,
              t.note IS NOT NULL AS noted,
              EXISTS (SELECT 1 FROM playlist_track pt WHERE pt.track_id=t.id) AS in_playlist,
              EXISTS (SELECT 1 FROM source_link sl
                       WHERE sl.entity_kind='track' AND sl.entity_id=t.id AND sl.source<>'discogs') AS other_source
         FROM track t WHERE t.release_id=?`,
    )
    .all(drop.id) as Array<{
    id: string;
    title: string;
    starred: number;
    noted: number;
    in_playlist: number;
    other_source: number;
  }>;

  const held = guarded.filter((t) => t.starred || t.noted || t.in_playlist || t.other_source);
  if (held.length > 0) {
    skipped.push(
      `${drop.artist} — ${drop.title}: ${held.length} track(s) on the duplicate carry user data (${held
        .map((t) => t.title)
        .join(', ')})`,
    );
    continue;
  }
  plans.push({ keep, drop, dropTrackIds: guarded.map((t) => t.id) });
}

console.log(`db: ${DB_PATH}`);
console.log(`${plans.length} pair(s) to merge, ${skipped.length} skipped\n`);
for (const p of plans) {
  console.log(
    `merge  ${p.keep.artist} — ${p.keep.title}\n` +
      `       keep ${p.keep.id} (local, year ${p.keep.year})\n` +
      `       drop ${p.drop.id} (discogs, year ${p.drop.year}), ${p.dropTrackIds.length} discogs-only track row(s)`,
  );
}
if (skipped.length) {
  console.log('\nskipped:');
  for (const s of skipped) console.log(`  ${s}`);
}

if (!APPLY) {
  console.log('\ndry run — pass --apply to write');
  process.exit(0);
}

const backup = `${DB_PATH}.pre-repair-${new Date().toISOString().replace(/[:.]/g, '-')}`;
copyFileSync(DB_PATH, backup);
console.log(`\nbackup: ${backup}`);

const merge = db.transaction((plans: Plan[]) => {
  for (const p of plans) {
    // Discogs release link moves to the surviving entity. Its match_method
    // records how the two were finally joined.
    db.prepare(
      `UPDATE source_link SET entity_id=?, match_method='artist_album'
        WHERE entity_kind='release' AND entity_id=? AND source='discogs'`,
    ).run(p.keep.id, p.drop.id);

    // Release-level Discogs facets (cover art, instance ids) move too, without
    // clobbering anything the surviving entity already holds for that key.
    db.prepare(
      `INSERT INTO source_facets (entity_kind, entity_id, source, key, value)
       SELECT 'release', ?, source, key, value FROM source_facets
        WHERE entity_kind='release' AND entity_id=?
       ON CONFLICT(entity_kind, entity_id, source, key) DO NOTHING`,
    ).run(p.keep.id, p.drop.id);
    db.prepare(`DELETE FROM source_facets WHERE entity_kind='release' AND entity_id=?`).run(
      p.drop.id,
    );

    db.prepare(
      `UPDATE release
          SET country   = COALESCE(country,   (SELECT country   FROM release WHERE id=?)),
              label     = COALESCE(label,     (SELECT label     FROM release WHERE id=?)),
              catno     = COALESCE(catno,     (SELECT catno     FROM release WHERE id=?)),
              thumb_url = COALESCE(thumb_url, (SELECT thumb_url FROM release WHERE id=?)),
              cover_url = COALESCE(cover_url, (SELECT cover_url FROM release WHERE id=?))
        WHERE id=?`,
    ).run(p.drop.id, p.drop.id, p.drop.id, p.drop.id, p.drop.id, p.keep.id);

    // Discogs-only track rows, deleted by explicit id — never "everything on
    // the release" — after the guard above proved none carry user data.
    for (const trackId of p.dropTrackIds) {
      db.prepare(`DELETE FROM source_link WHERE entity_kind='track' AND entity_id=?`).run(trackId);
      db.prepare(`DELETE FROM source_facets WHERE entity_kind='track' AND entity_id=?`).run(
        trackId,
      );
      db.prepare(`DELETE FROM match_key WHERE entity_kind='track' AND entity_id=?`).run(trackId);
      db.prepare(`DELETE FROM track WHERE id=?`).run(trackId);
    }

    db.prepare(`DELETE FROM match_key WHERE entity_kind='release' AND entity_id=?`).run(p.drop.id);
    db.prepare(`DELETE FROM release WHERE id=?`).run(p.drop.id);

    // The surviving entity now answers to both keys.
    const loose = `${squash(p.keep.artist)}|${squash(p.keep.title)}`;
    db.prepare(
      `INSERT INTO match_key (entity_kind, entity_id, key_type, key_value)
       VALUES ('release', ?, 'artist_album', ?)
       ON CONFLICT(entity_kind, key_type, key_value) DO NOTHING`,
    ).run(p.keep.id, loose);
  }
});

merge(plans);

const remaining = db
  .prepare(
    `SELECT COUNT(*) AS n FROM source_link
      WHERE entity_kind='release' AND source='discogs'`,
  )
  .get() as { n: number };
const paired = db
  .prepare(
    `SELECT COUNT(*) AS n FROM (
       SELECT entity_id FROM source_link WHERE entity_kind='release'
        GROUP BY entity_id HAVING COUNT(DISTINCT source) > 1)`,
  )
  .get() as { n: number };
console.log(`\nmerged ${plans.length} pair(s)`);
console.log(`discogs releases: ${remaining.n}, now paired with local: ${paired.n}`);
console.log('the next sync re-hydrates the merged tracklists, matching by position');
