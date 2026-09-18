/**
 * One-off repair for releases that exist twice — once from the local library,
 * once from Discogs — because the two were never matched.
 *
 * Four defects produced these, all fixed in the sync/add paths:
 *   1. the release match key carried the year, and the sources disagree about
 *      what "year" means (tagged original vs. the pressing in the collection);
 *   2. the Discogs add path minted an entity without consulting the match keys;
 *   3. Discogs' numeric disambiguation ("Picture (6)") was kept in the artist
 *      name, so the artist half of the key never agreed with the file's tags;
 *   4. a local title's edition tag ("Jubiiilæum (Reissue)", "… (Full Album)")
 *      was kept in the album half, and Discogs titles never carry one.
 *
 * None of those fixes heals the duplicates already on disk: the duplicate owns the
 * Discogs source_link, so a re-sync resolves the right entity, hits the
 * source_link conflict path, and leaves everything as it was.
 *
 * This script merges each pair onto the local (file-backed) entity: it moves the
 * Discogs release link and facets across, backfills empty columns, and removes
 * the duplicate. Discogs-only track rows on the duplicate are removed with it —
 * they are pure API metadata and `hydrateDiscogsTracks` re-creates them, this
 * time matching onto the local tracks by position. A playlist entry on one of
 * those rows is carried across to the local track at the same position — the
 * playlist was built against the Discogs copy only because the two never
 * paired. Anything else carrying user data (a star, a note, a local file link),
 * or a playlist entry with no positional counterpart, blocks the merge instead.
 *
 * A second phase re-points Discogs-only track rows at their release's current
 * artist. Hydration mints them with the release artist of the moment and never
 * revisits them, so they still say "Central (7)" — or the search-result string
 * the add path started from — after a sync has renamed the release.
 *
 * Dry run by default. Pass --apply to write, which backs the DB up first.
 */
import { Database } from 'bun:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { normalizeArtistAlbum } from '../src/lib/server/library/normalize';
import { stripDisambiguation } from '../src/lib/server/sources/discogs/format';

const APPLY = process.argv.includes('--apply');
const DB_PATH = process.env.BOOTH_DB_PATH ?? join(homedir(), '.booth', 'booth.db');

// The app's own loose key, computed from the stored names — so the pairing
// here agrees exactly with what the next sync would resolve. Stored Discogs
// artist names may still carry the "(N)" suffix from before it was stripped.
const looseKey = (r: { artist: string; title: string }): string | null =>
  normalizeArtistAlbum({ artist: stripDisambiguation(r.artist), album: r.title });

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
  const key = looseKey(r);
  if (!key) continue;
  const bucket = byArtistAlbum.get(key);
  if (bucket) bucket.push(r);
  else byArtistAlbum.set(key, [r]);
}

interface PlaylistMove {
  playlistId: string;
  playlistName: string;
  fromTrackId: string;
  toTrackId: string;
  title: string;
}

interface Plan {
  keep: Rel;
  drop: Rel;
  dropTrackIds: string[];
  rehomeTrackIds: string[];
  playlistMoves: PlaylistMove[];
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

  const onDrop = db
    .prepare(
      `SELECT t.id, t.title, t.position,
              t.starred_at IS NOT NULL AS starred,
              t.note IS NOT NULL AS noted,
              EXISTS (SELECT 1 FROM source_link sl
                       WHERE sl.entity_kind='track' AND sl.entity_id=t.id AND sl.source<>'discogs') AS other_source
         FROM track t WHERE t.release_id=?`,
    )
    .all(drop.id) as Array<{
    id: string;
    title: string;
    position: string | null;
    starred: number;
    noted: number;
    other_source: number;
  }>;

  // A file-backed row under the duplicate is one of the local release's own
  // tracks: once the keys agreed, a sync resolved the local release to the
  // duplicate and re-parented its tracks there, but could not move the release
  // link past the conflict rule. Those go home untouched. Only the Discogs-only
  // rows are candidates for deletion.
  const rehome = onDrop.filter((t) => t.other_source);
  const guarded = onDrop.filter((t) => !t.other_source);

  const held = guarded.filter((t) => t.starred || t.noted);
  if (held.length > 0) {
    skipped.push(
      `${drop.artist} — ${drop.title}: ${held.length} track(s) on the duplicate carry user data (${held
        .map((t) => t.title)
        .join(', ')})`,
    );
    continue;
  }

  // Playlist entries move to the local track at the same position. Only a
  // one-to-one positional match qualifies; anything else keeps the guard.
  const playlistMoves: PlaylistMove[] = [];
  const stranded: string[] = [];
  for (const t of guarded) {
    const entries = db
      .prepare(
        `SELECT pt.playlist_id, p.name FROM playlist_track pt
           JOIN playlist p ON p.id=pt.playlist_id
          WHERE pt.track_id=?`,
      )
      .all(t.id) as Array<{ playlist_id: string; name: string }>;
    if (entries.length === 0) continue;
    // The local track at that position — under the local release, or among
    // the rows going home.
    const counterparts =
      t.position == null
        ? []
        : (db
            .prepare(
              `SELECT t.id FROM track t
                WHERE CAST(t.position AS INTEGER)=?
                  AND (t.release_id=? OR t.release_id=?)
                  AND EXISTS (SELECT 1 FROM source_link sl
                               WHERE sl.entity_kind='track' AND sl.entity_id=t.id AND sl.source='local')`,
            )
            .all(Number(t.position), keep.id, drop.id) as Array<{ id: string }>);
    if (counterparts.length !== 1) {
      stranded.push(t.title);
      continue;
    }
    for (const e of entries) {
      const already = db
        .prepare(`SELECT 1 FROM playlist_track WHERE playlist_id=? AND track_id=?`)
        .get(e.playlist_id, counterparts[0].id);
      if (already) {
        stranded.push(`${t.title} (local track already in "${e.name}")`);
        continue;
      }
      playlistMoves.push({
        playlistId: e.playlist_id,
        playlistName: e.name,
        fromTrackId: t.id,
        toTrackId: counterparts[0].id,
        title: t.title,
      });
    }
  }
  if (stranded.length > 0) {
    skipped.push(
      `${drop.artist} — ${drop.title}: playlist entry with no positional counterpart (${stranded.join(', ')})`,
    );
    continue;
  }

  plans.push({
    keep,
    drop,
    dropTrackIds: guarded.map((t) => t.id),
    rehomeTrackIds: rehome.map((t) => t.id),
    playlistMoves,
  });
}

// Discogs-only tracks whose artist no longer matches their release's.
const DRIFTED_TRACKS_WHERE = `
  t.release_id IS NOT NULL
  AND t.artist_id != (SELECT r.artist_id FROM release r WHERE r.id = t.release_id)
  AND EXISTS (SELECT 1 FROM source_link sl
               WHERE sl.entity_kind='track' AND sl.entity_id=t.id AND sl.source='discogs')
  AND NOT EXISTS (SELECT 1 FROM source_link sl
                   WHERE sl.entity_kind='track' AND sl.entity_id=t.id AND sl.source<>'discogs')`;
const drifted = db
  .prepare(
    `SELECT ta.name AS track_artist, ra.name AS release_artist, COUNT(*) AS n
       FROM track t
       JOIN release r ON r.id = t.release_id
       JOIN artist ta ON ta.id = t.artist_id
       JOIN artist ra ON ra.id = r.artist_id
      WHERE ${DRIFTED_TRACKS_WHERE}
      GROUP BY ta.name, ra.name
      ORDER BY n DESC`,
  )
  .all() as Array<{ track_artist: string; release_artist: string; n: number }>;
const driftedTotal = drifted.reduce((sum, d) => sum + d.n, 0);

console.log(`db: ${DB_PATH}`);
console.log(`${plans.length} pair(s) to merge, ${skipped.length} skipped\n`);
for (const p of plans) {
  console.log(
    `merge  ${p.keep.artist} — ${p.keep.title}\n` +
      `       keep ${p.keep.id} (local, year ${p.keep.year})\n` +
      `       drop ${p.drop.id} (discogs, year ${p.drop.year}), ${p.dropTrackIds.length} discogs-only track row(s)`,
  );
  if (p.rehomeTrackIds.length) {
    console.log(`       send ${p.rehomeTrackIds.length} local track(s) a sync parented under the duplicate back home`);
  }
  for (const m of p.playlistMoves) {
    console.log(`       move "${m.title}" in playlist "${m.playlistName}" onto the local track`);
  }
}
if (skipped.length) {
  console.log('\nskipped:');
  for (const s of skipped) console.log(`  ${s}`);
}
if (driftedTotal) {
  console.log(`\n${driftedTotal} discogs-only track(s) to re-point at their release artist:`);
  for (const d of drifted) console.log(`  ${d.n.toString().padStart(4)}  ${d.track_artist} → ${d.release_artist}`);
}

if (!APPLY) {
  console.log('\ndry run — pass --apply to write');
  process.exit(0);
}

// VACUUM INTO, not a file copy: the DB is in WAL mode, so a plain copy leaves
// the committed pages behind in the -wal sidecar and yields a corrupt backup.
const backup = `${DB_PATH}.pre-repair-${new Date().toISOString().replace(/[:.]/g, '-')}`;
db.run(`VACUUM INTO ?`, [backup]);
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
              cover_url = COALESCE(cover_url, (SELECT cover_url FROM release WHERE id=?)),
              vetted_at = COALESCE(vetted_at, (SELECT vetted_at FROM release WHERE id=?))
        WHERE id=?`,
    ).run(p.drop.id, p.drop.id, p.drop.id, p.drop.id, p.drop.id, p.drop.id, p.keep.id);

    // Local tracks go home. Their release_position keys follow where the slot
    // is free; a stale one left behind names a release about to be deleted
    // and nothing looks it up. The next local sync rewrites them regardless.
    for (const trackId of p.rehomeTrackIds) {
      db.prepare(`UPDATE track SET release_id=? WHERE id=?`).run(p.keep.id, trackId);
      db.prepare(
        `UPDATE OR IGNORE match_key
            SET key_value = replace(key_value, ?, ?)
          WHERE entity_kind='track' AND entity_id=? AND key_type='release_position'`,
      ).run(`${p.drop.id}:`, `${p.keep.id}:`, trackId);
    }

    // Playlist membership crosses to the local counterpart before the Discogs
    // row goes, or the cascade on track deletion would take it.
    for (const m of p.playlistMoves) {
      db.prepare(`UPDATE playlist_track SET track_id=? WHERE playlist_id=? AND track_id=?`).run(
        m.toTrackId,
        m.playlistId,
        m.fromTrackId,
      );
    }

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

    // The surviving entity now answers to the loose key. Its old value goes
    // first — an entity holds one key per type — and the new one is claimed
    // first-come, as a sync would. The next sync rewrites the exact key.
    const loose = looseKey(p.keep)!;
    db.prepare(
      `DELETE FROM match_key
        WHERE entity_kind='release' AND entity_id=? AND key_type='artist_album' AND key_value!=?`,
    ).run(p.keep.id, loose);
    db.prepare(
      `INSERT INTO match_key (entity_kind, entity_id, key_type, key_value)
       VALUES ('release', ?, 'artist_album', ?)
       ON CONFLICT(entity_kind, key_type, key_value) DO NOTHING`,
    ).run(p.keep.id, loose);
  }
});

merge(plans);

const repointed = db.run(
  `UPDATE track SET artist_id = (SELECT r.artist_id FROM release r WHERE r.id = track.release_id)
    WHERE id IN (SELECT t.id FROM track t WHERE ${DRIFTED_TRACKS_WHERE})`,
).changes;

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
console.log(`re-pointed ${repointed} discogs-only track(s) at their release artist`);
console.log('the next sync re-hydrates the merged tracklists, matching by position');
